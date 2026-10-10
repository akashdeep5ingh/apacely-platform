import {handleConfiguredWorkerRequest,type RequestLifetime} from './worker-http.js';
import {D1Repository,type D1Binding} from './d1-repository.js';
import {D1ReplayLedger} from './replay-ledger.js';
import {D1SourceMappingStore} from './source-mappings.js';
import {SyntheticHmacVerifier,type HmacKeyRecord} from './synthetic-hmac.js';
import {createAccessVerifier} from './staging-access.js';
import {STAGING_POLICY} from './staging-policy.js';
import type {AdmissionNamespace} from './distributed-admission.js';
import type {VerificationInput} from './worker-ingress.js';

function reply(status:number,code:string):Response{return Response.json({code},{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});}
function own(bindings:object,key:string):unknown {
 const descriptor=Object.getOwnPropertyDescriptor(bindings,key);
 if(!descriptor||!descriptor.enumerable||!Object.hasOwn(descriptor,'value'))throw Error('Invalid staging binding');
 return descriptor.value;
}
type KeyDescriptor=Omit<HmacKeyRecord,'bytes'> & {slot:'current'|'next'};
/** Nonsecret JSON array binding; each slot has the unchanged explicit HMAC scope/lifecycle fields.
 * CURRENT is mandatory. NEXT is optional only if both its descriptor and secret are absent.
 * Secret bindings are canonical standard base64 of exactly 32 bytes (never public-fixture fallback). */
function registry(value:unknown):readonly KeyDescriptor[]{
 if(typeof value!=='string'||value.length>8192)throw Error('Invalid key registry');
 const parsed:unknown=JSON.parse(value);
 if(!Array.isArray(parsed)||parsed.length<1||parsed.length>2)throw Error('Invalid key registry');
 const fields=['slot','key_id','environment','provider','principal','source','route','not_before','not_after','revoked_at'];
 const slots=new Set<string>();
 const records=parsed.map((r:KeyDescriptor)=>{
  if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).length!==fields.length||Object.keys(r).some(k=>!fields.includes(k))||!['current','next'].includes(r.slot)||slots.has(r.slot)||r.environment!=='staging'||r.provider!=='synthetic'||r.route!=='/v1/ingress/synthetic'||![r.key_id,r.principal,r.source].every(x=>typeof x==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(x)))throw Error('Invalid key scope');
  slots.add(r.slot);
  const epoch=(v:unknown)=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)&&!v.startsWith('0000')&&Number.isSafeInteger(Date.parse(v))&&new Date(v).toISOString()===v;
  if(!epoch(r.not_before)||!epoch(r.not_after)||Date.parse(r.not_before)>=Date.parse(r.not_after)||r.revoked_at!==null&&!epoch(r.revoked_at))throw Error('Invalid lifecycle');
  return Object.freeze({...r});
 });
 if(!slots.has('current'))throw Error('Missing current key');
 if(records.length===2){const [a,b]=records;if(a.key_id===b.key_id||a.principal!==b.principal||a.source!==b.source||Math.min(Date.parse(a.not_after),Date.parse(b.not_after))-Math.max(Date.parse(a.not_before),Date.parse(b.not_before))>300000)throw Error('Invalid rotation');}
 return Object.freeze(records);
}
function material(value:unknown):Uint8Array{
 if(typeof value!=='string'||! /^[A-Za-z0-9+/]{43}=$/.test(value))throw Error('Invalid secret encoding');
 const raw=atob(value);if(raw.length!==32||btoa(raw)!==value)throw Error('Invalid secret encoding');
 return Uint8Array.from(raw,c=>c.charCodeAt(0));
}
/** Closed staging release boundary; no storage, crypto, Access, keys or body work while disabled.
 * Access and HMAC initialization run only inside Ingress.verify's existing retained deadline.
 * Transport claims never become source authority. Original primary D1 identity is preserved. */
export async function handleStagingRequest(request:Request,bindings:object,context:RequestLifetime):Promise<Response>{
 try{
  if(!bindings||![Object.prototype,null].includes(Object.getPrototypeOf(bindings)))throw Error('Invalid staging bindings');
  const environment=own(bindings,'APACELY_ENVIRONMENT'),operation=own(bindings,'APACELY_OPERATION'),enabled=own(bindings,'APACELY_INGRESS_ENABLED'),effects=own(bindings,'APACELY_EFFECTS_ENABLED');
  if(environment!=='staging'||operation!=='ingest_mock_lead'||!['true','false'].includes(enabled as string)||effects!=='false')throw Error('Invalid staging configuration');
  if(enabled==='false')return reply(503,'unavailable');
  const DB=own(bindings,'DB') as D1Binding,namespace=own(bindings,'STAGING_ADMISSION') as AdmissionNamespace;
  if(!DB||typeof DB.prepare!=='function'||typeof DB.batch!=='function'||'getBookmark' in DB||!namespace||typeof namespace.idFromName!=='function'||typeof namespace.get!=='function')throw Error('Invalid platform bindings');
  const issuer=own(bindings,'STAGING_ACCESS_ISSUER'),audience=own(bindings,'STAGING_ACCESS_AUDIENCE');
  const match=typeof issuer==='string'&&/^https:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.cloudflareaccess\.com$/.exec(issuer);
  if(!match||/^(?:team|placeholder|example|changeme|replace-me)$/.test(match[1])||typeof audience!=='string'||!/^[a-f0-9]{64}$/.test(audience)||/^(?:0{64}|f{64})$/.test(audience))throw Error('Invalid Access configuration');
  const keys=registry(own(bindings,'STAGING_HMAC_KEY_REGISTRY'));
  const current=own(bindings,'STAGING_SIGNING_KEY_CURRENT');
  const hasNext=Object.hasOwn(bindings,'STAGING_SIGNING_KEY_NEXT'),expectsNext=keys.some(k=>k.slot==='next');
  if(hasNext!==expectsNext)throw Error('Incomplete rotation');
  const next=hasNext?own(bindings,'STAGING_SIGNING_KEY_NEXT'):undefined;
  // Snapshot string secret slots once; decoding/import belongs to the retained lazy verifier.
  if(typeof current!=='string'||!/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/.test(current)||expectsNext&&(typeof next!=='string'||!/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/.test(next)))throw Error('Invalid secret encoding');
  const now=()=>new Date().toISOString();
  const verifier=Object.freeze({protocol:'apacely-synthetic-ingress-hmac-v1' as const,async verify(input:VerificationInput){
   if(input.signal?.aborted)return null;
   const access=createAccessVerifier({issuer:issuer as string,audience});
   if(!await access.verify(input.headers,input.signal)||input.signal?.aborted)return null;
   const records:HmacKeyRecord[]=[];
   try{
    for(const descriptor of keys){const {slot,...record}=descriptor;records.push({...record,bytes:material(slot==='current'?current:next)});}
    const hmac=await SyntheticHmacVerifier.create('staging',records,now);
    if(input.signal?.aborted)return null;
    return await hmac.verify(input);
   }finally{for(const record of records)record.bytes.fill(0);}
  }});
  return await handleConfiguredWorkerRequest(request,{APACELY_ENVIRONMENT:'staging',APACELY_OPERATION:'ingest_mock_lead',DB},{repo:new D1Repository(DB,now,undefined,'staging'),mappings:new D1SourceMappingStore(DB,now,'staging'),replay:new D1ReplayLedger(DB,now,3,'staging'),verifier,now,log:()=>{}},context,{admissionMode:'distributed',distributed:{policy:STAGING_POLICY,namespace,database:DB}});
 }catch{return reply(500,'internal');}
}
