import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {environmentSchema} from '../scripts/environment-schema.js';
import {D1Repository,type D1Binding,type D1Statement} from '../src/d1-repository.js';
import {D1SourceMappingStore} from '../src/source-mappings.js';
import {AdmissionCoordinator,bootstrapAdmission,type AdmissionStorage} from '../src/distributed-admission.js';
import {STAGING_POLICY} from '../src/staging-policy.js';
import {SignJWT,generateKeyPair,exportJWK} from 'jose';
import {fixture} from '../src/fixture.js';

const lifetime={waitUntil(_promise:Promise<unknown>){}};
async function setup(environment:'staging'|'development'='staging'){
 const sqlite=new Database(':memory:');sqlite.exec(environmentSchema(environment));
 let reads=0,writes=0,namespaceCalls=0;
 class Statement implements D1Statement{
  values:(string|number|null)[]=[];constructor(readonly sql:string){}
  bind(...values:(string|number|null)[]){this.values=values;return this;}
  async all<T>(){reads++;return {results:sqlite.prepare(this.sql).all(...this.values) as T[],success:true};}
  async run(){writes++;return sqlite.prepare(this.sql).run(...this.values);}
 }
 const DB:D1Binding={prepare(sql){return new Statement(sql);},async batch(statements){return sqlite.transaction(()=>statements.map(s=>{const st=s as Statement;const query=sqlite.prepare(st.sql);if(query.reader){reads++;return {results:query.all(...st.values),success:true};}writes++;return {results:[],success:true,meta:query.run(...st.values)};}))();}};
 const now=()=>new Date().toISOString(),repo=new D1Repository(DB,now,undefined,environment),mappings=new D1SourceMappingStore(DB,now,environment);
 const tenants=[],mappingRows=[];
 for(const source of ['a','b']){
  const tenant=await repo.createTenant('Synthetic '+source);tenants.push(tenant);
  mappingRows.push(await mappings.create({provider:'synthetic',source:'source-'+source,principal:'principal-'+source,tenant_id:tenant.id,source_binding:'mock-source-'+source,environment,operation:'ingest_mock_lead'}));
 }
 const values=new Map<string,unknown>();
 const storage:AdmissionStorage={async get(k){return values.get(k);},async put(k,v){values.set(k,v);},async transaction(callback){const before=new Map(values);try{return await callback(storage);}catch(e){values.clear();for(const [k,v] of before)values.set(k,v);throw e;}}};
 await bootstrapAdmission(storage,STAGING_POLICY,Date.now());const coordinator=new AdmissionCoordinator(storage,STAGING_POLICY);
 const namespace={idFromName(name:string){assert.equal(name,'distributed-admission-v1');return name;},get(id:unknown){assert.equal(id,'distributed-admission-v1');return {async fetch(request:Request){namespaceCalls++;return coordinator.fetch(request);}};}};
 const {publicKey,privateKey}=await generateKeyPair('RS256');const jwk={...await exportJWK(publicKey),kid:'access-a',alg:'RS256',use:'sig'};
 const issuer='https://offline-synthetic.cloudflareaccess.com',audience='a'.repeat(64);
 const assertion=await new SignJWT({}).setProtectedHeader({alg:'RS256',kid:'access-a'}).setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime('1m').sign(privateKey);
 const keys=new Map<string,CryptoKey>(),records=[];
 const bindings:Record<string,unknown>={APACELY_ENVIRONMENT:'staging',APACELY_OPERATION:'ingest_mock_lead',APACELY_INGRESS_ENABLED:'true',APACELY_EFFECTS_ENABLED:'false',DB,STAGING_ADMISSION:namespace,STAGING_ACCESS_ISSUER:issuer,STAGING_ACCESS_AUDIENCE:audience};
 for(const source of ['a','b'])for(const slot of ['current','next']){
  const bytes=crypto.getRandomValues(new Uint8Array(32)),id=`key-${source}-${slot}`,secret_slot=`QUALIFICATION_SIGNING_KEY_${source.toUpperCase()}_${slot.toUpperCase()}`;
  keys.set(id,await crypto.subtle.importKey('raw',bytes,{name:'HMAC',hash:'SHA-256'},false,['sign']));bindings[secret_slot]=Buffer.from(bytes).toString('base64');bytes.fill(0);
  records.push({slot,secret_slot,key_id:id,environment:'staging',provider:'synthetic',principal:'principal-'+source,source:'source-'+source,route:'/v1/ingress/synthetic',not_before:new Date(Date.now()-60000).toISOString(),not_after:new Date(Date.now()+60000).toISOString(),revoked_at:null as string|null});
 }
 bindings.QUALIFICATION_HMAC_KEY_REGISTRY=JSON.stringify(records);
 const body=JSON.stringify({...fixture,occurred_at:now()});
 async function request(source='a',slot='current',nonce=`nonce-${source}-${slot}`,payload=body):Promise<Request>{
  const id=`key-${source}-${slot}`,signed_at=now(),digest=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(payload))).toString('hex');
  const message=JSON.stringify(['apacely-synthetic-ingress-hmac-v1','staging','synthetic','principal-'+source,'source-'+source,id,'POST','/v1/ingress/synthetic',signed_at,nonce,digest]);
  const signature=Buffer.from(await crypto.subtle.sign('HMAC',keys.get(id)!,new TextEncoder().encode(message))).toString('base64url');
  return new Request('https://staging.invalid/v1/ingress/synthetic',{method:'POST',headers:{'content-type':'application/json','Cf-Access-Jwt-Assertion':assertion,'apacely-key-id':id,'apacely-source':'source-'+source,'apacely-signed-at':signed_at,'apacely-nonce':nonce,'apacely-signature':signature},body:payload});
 }
 return {sqlite,DB,bindings,request,jwk,tenants,repo,mappings,mappingRows,storage,namespace,records,body,counters:()=>({reads,writes,namespaceCalls}),reset(){reads=writes=namespaceCalls=0;}};
}

test('one qualification composition accepts independent sources into isolated tenants with overlapping external identifiers',async()=>{
 const runtime=await import('../src/qualification/runtime.js').catch(()=>null);assert.ok(runtime,'qualification composition must exist');
 const f=await setup(),originalFetch=globalThis.fetch;
 globalThis.fetch=async()=>Response.json({keys:[f.jwk]});
 try{
  const handle=runtime.createQualificationRuntime(STAGING_POLICY);
  const retained:Promise<unknown>[]=[];
  for(const source of ['a','b']){const response=await handle(await f.request(source),f.bindings,{waitUntil(p){retained.push(p);}});assert.equal(response.status,200,await response.text());}
  await Promise.all(retained);assert.equal(retained.length,2);
  const events=f.sqlite.prepare('SELECT tenant_id,normalized_payload FROM events ORDER BY tenant_id').all() as {tenant_id:string;normalized_payload:string}[];
  assert.equal(events.length,2);assert.deepEqual(new Set(events.map(e=>e.tenant_id)),new Set(f.tenants.map(t=>t.id)));
  for(const t of f.tenants)assert.equal(f.sqlite.prepare<unknown[],{n:number}>('SELECT count(*) n FROM action_outbox WHERE tenant_id=? AND environment=? AND status=?').get(t.id,'staging','pending')!.n,1);
  assert.equal(f.sqlite.prepare<unknown[],{n:number}>('SELECT count(*) n FROM replay_ledger').get()!.n,2);
 }finally{globalThis.fetch=originalFetch;f.sqlite.close();}
});

import {createQualificationRuntime} from '../src/qualification/runtime.js';
import {handleStagingRequest} from '../src/staging-runtime.js';
import {localAdmission} from '../src/ingress-operations.js';
import {SyntheticHmacVerifier} from '../src/synthetic-hmac.js';
const handle=createQualificationRuntime(STAGING_POLICY);
// These are adversarial qualification of reused core contracts, not invented core RED history.
test('Access, signed byte integrity, source and key scope remain mandatory for every source',async()=>{
 const f=await setup(),originalFetch=globalThis.fetch;globalThis.fetch=async()=>Response.json({keys:[f.jwk]});
 try{
  for(const source of ['a','b'])for(const alter of [
   (r:Request)=>r.headers.delete('Cf-Access-Jwt-Assertion'),
   (r:Request)=>r.headers.set('Cf-Access-Jwt-Assertion','invalid'),
   (r:Request)=>r.headers.set('apacely-source','source-'+(source==='a'?'b':'a')),
   (r:Request)=>r.headers.set('apacely-key-id',`key-${source==='a'?'b':'a'}-current`),
   (r:Request)=>r.headers.set('apacely-signature','A'.repeat(43)),
   (r:Request)=>r.headers.set('apacely-environment','staging'),
   (r:Request)=>r.headers.set('apacely-tier','privileged')
  ]){
   f.reset();const request=await f.request(source);alter(request);const response=await handle(request,f.bindings,lifetime);assert.equal(response.status,401,await response.text());assert.equal(f.counters().writes,0);assert.equal(f.counters().namespaceCalls,0);
  }
  const original=await f.request(),tampered=new Request(original.url,{method:'POST',headers:original.headers,body:JSON.stringify({...JSON.parse(f.body),text:'tampered bytes'})});
  const response=await handle(tampered,f.bindings,lifetime);assert.equal(response.status,401,await response.text());
  for(const table of ['events','action_outbox','replay_ledger'])assert.equal(f.sqlite.prepare<unknown[],{n:number}>(`SELECT count(*) n FROM ${table}`).get()!.n,0);
 }finally{globalThis.fetch=originalFetch;f.sqlite.close();}
});

test('independent current/next verification and revocation never revoke the other source',async()=>{
 const f=await setup(),originalFetch=globalThis.fetch;globalThis.fetch=async()=>Response.json({keys:[f.jwk]});
 try{
  for(const source of ['a','b'])for(const slot of ['current','next']){const r=await handle(await f.request(source,slot),f.bindings,lifetime);assert.equal(r.status,200,await r.text());}
  assert.equal(f.sqlite.prepare<unknown[],{n:number}>('SELECT count(*) n FROM events').get()!.n,2);
  assert.equal(f.sqlite.prepare<unknown[],{n:number}>('SELECT count(*) n FROM replay_ledger').get()!.n,4);
  f.records[0].revoked_at=new Date(Date.now()-1000).toISOString();f.bindings.QUALIFICATION_HMAC_KEY_REGISTRY=JSON.stringify(f.records);
  for(const [source,slot,status] of [['a','current',401],['a','next',200],['b','current',200],['b','next',200]] as const){const r=await handle(await f.request(source,slot,'after-revoke-'+source+'-'+slot),f.bindings,lifetime);assert.equal(r.status,status,await r.text());}
  await f.mappings.revoke({tenant_id:f.tenants[0].id,environment:'staging'},f.mappingRows[0].id,1);
  const denied=await handle(await f.request('a','next','mapping-revoked'),f.bindings,lifetime);assert.equal(denied.status,403,await denied.text());
  const accepted=await handle(await f.request('b','next','mapping-b-active'),f.bindings,lifetime);assert.equal(accepted.status,200,await accepted.text());
  assert.equal(f.sqlite.prepare<unknown[],{n:number}>('SELECT count(*) n FROM events').get()!.n,2);
 }finally{globalThis.fetch=originalFetch;f.sqlite.close();}
});

test('source lifecycle expiry and future activation do not change another source authority',async()=>{
 const f=await setup(),originalFetch=globalThis.fetch;globalThis.fetch=async()=>Response.json({keys:[f.jwk]});
 try{
  f.records[0].not_before=new Date(Date.now()-120000).toISOString();f.records[0].not_after=new Date(Date.now()-1000).toISOString();
  f.records[1].not_before=new Date(Date.now()+30000).toISOString();
  f.bindings.QUALIFICATION_HMAC_KEY_REGISTRY=JSON.stringify(f.records);
  for(const [source,slot,status] of [['a','current',401],['a','next',401],['b','current',200],['b','next',200]] as const){const r=await handle(await f.request(source,slot,'lifecycle-'+source+'-'+slot),f.bindings,lifetime);assert.equal(r.status,status,await r.text());}
  assert.equal(f.sqlite.prepare<unknown[],{n:number}>('SELECT count(*) n FROM events').get()!.n,1);
  assert.equal(f.sqlite.prepare<unknown[],{tenant_id:string}>('SELECT tenant_id FROM events').get()!.tenant_id,f.tenants[1].id);
 }finally{globalThis.fetch=originalFetch;f.sqlite.close();}
});

test('fully signed tenant/environment/protocol/tier claims cannot select authority',async()=>{
 const f=await setup(),originalFetch=globalThis.fetch;globalThis.fetch=async()=>Response.json({keys:[f.jwk]});
 try{
  for(const field of ['tenant_id','environment','protocol','tier']){const r=await handle(await f.request('a','current','forged-'+field,JSON.stringify({...JSON.parse(f.body),[field]:field==='tenant_id'?f.tenants[1].id:'forged'})),f.bindings,lifetime);assert.equal(r.status,400,await r.text());}
  assert.equal(f.sqlite.prepare<unknown[],{n:number}>('SELECT count(*) n FROM events').get()!.n,0);
 }finally{globalThis.fetch=originalFetch;f.sqlite.close();}
});

test('captured keys, principal identity, policy, original DB and namespace survive caller mutation during Access',async()=>{
 const f=await setup(),originalFetch=globalThis.fetch,policy={...STAGING_POLICY},captured=createQualificationRuntime(policy),oldId=f.namespace.idFromName,oldGet=f.namespace.get;
 globalThis.fetch=async()=>{
  policy.environment='development';policy.aggregateCap=0;
  f.bindings.DB={};f.bindings.STAGING_ADMISSION={};f.bindings.APACELY_ENVIRONMENT='production';
  f.bindings.QUALIFICATION_SIGNING_KEY_A_CURRENT='mutated';f.records[0].principal='forged';f.bindings.QUALIFICATION_HMAC_KEY_REGISTRY='[]';
  f.namespace.idFromName=()=>{throw Error('replaced');};f.namespace.get=()=>{throw Error('replaced');};
  return Response.json({keys:[f.jwk]});
 };
 try{const r=await captured(await f.request(),f.bindings,lifetime);assert.equal(r.status,200,await r.text());assert.equal(f.sqlite.prepare<unknown[],{tenant_id:string}>('SELECT tenant_id FROM events').get()!.tenant_id,f.tenants[0].id);}
 finally{f.namespace.idFromName=oldId;f.namespace.get=oldGet;globalThis.fetch=originalFetch;f.sqlite.close();}
});

test('malformed qualification slots reject before body, Access, storage or distributed requests',async()=>{
 const f=await setup(),originalFetch=globalThis.fetch;let fetched=0;globalThis.fetch=async()=>{fetched++;throw Error('forbidden');};
 try{
  const aliases={...f.bindings,QUALIFICATION_SIGNING_KEY_B_CURRENT:f.bindings.QUALIFICATION_SIGNING_KEY_A_CURRENT};
  const bad=[aliases,{...f.bindings,QUALIFICATION_SIGNING_KEY_A_CURRENT:undefined},{...f.bindings,QUALIFICATION_HMAC_KEY_REGISTRY:'[]'},{...f.bindings,STAGING_ADMISSION:undefined}];
  for(const b of bad){let body=0;const req=await f.request();Object.defineProperty(req,'body',{get(){body++;throw Error('forbidden');}});f.reset();const r=await handle(req,b,lifetime);assert.equal(r.status,500);await r.text();assert.equal(body,0);assert.deepEqual(f.counters(),{reads:0,writes:0,namespaceCalls:0});}
  assert.equal(fetched,0);
 }finally{globalThis.fetch=originalFetch;f.sqlite.close();}
});

test('original primary and physical staging database and fixed policy scope cannot be substituted',async()=>{
 const f=await setup('development'),originalFetch=globalThis.fetch;let fetched=0;globalThis.fetch=async()=>{fetched++;throw Error('forbidden');};
 try{
  const response=await handle(await f.request(),f.bindings,lifetime);assert.equal(response.status,403,await response.text());assert.equal(fetched,0);assert.equal(f.counters().namespaceCalls,0);
  const session=await handle(await f.request(),{...f.bindings,DB:{...f.DB,getBookmark(){return 'session';}}},lifetime);assert.equal(session.status,500,await session.text());
  assert.throws(()=>createQualificationRuntime({...STAGING_POLICY,environment:'development'}));
 }finally{globalThis.fetch=originalFetch;f.sqlite.close();}
 const other=await setup();globalThis.fetch=async()=>Response.json({keys:[other.jwk]});
 try{
  const mismatch=createQualificationRuntime({...STAGING_POLICY,epoch:crypto.randomUUID()});other.reset();const denied=await mismatch(await other.request(),other.bindings,lifetime);assert.equal(denied.status,500,await denied.text());assert.equal(other.counters().writes,0);
 }finally{globalThis.fetch=originalFetch;other.sqlite.close();}
});

async function retainedDeadline(stage:'access'|'hmac'){
 const f=await setup(),request=await f.request(),originalFetch=globalThis.fetch,originalTimer=globalThis.setTimeout,originalCreate=SyntheticHmacVerifier.create;
 let expire:(()=>void)|undefined,resolve!:()=>void,entered!:()=>void;
 const gate=new Promise<void>(r=>resolve=r),started=new Promise<void>(r=>entered=r),retained:Promise<unknown>[]=[];let settled=false,imports=0;
 globalThis.setTimeout=((callback:any,ms?:number,...args:any[])=>{if(ms===10000)expire=()=>callback(...args);return originalTimer(callback,ms,...args);}) as typeof setTimeout;
 globalThis.fetch=async()=>{if(stage==='access'){entered();await gate;}return Response.json({keys:[f.jwk]});};
 SyntheticHmacVerifier.create=async(...args:Parameters<typeof originalCreate>)=>{imports++;if(stage==='hmac'){entered();await gate;}return originalCreate(...args);};
 try{
  f.reset();const pending=handle(request,f.bindings,{waitUntil(p){retained.push(p);void p.then(()=>settled=true);}});
  await started;assert.ok(expire);assert.equal(localAdmission.snapshot().active,1);assert.equal(retained.length,1);expire();
  const response=await pending;assert.equal(response.status,504,await response.text());assert.equal(settled,false);assert.equal(localAdmission.snapshot().active,1);
  resolve();await Promise.all(retained);assert.equal(localAdmission.snapshot().active,0);assert.equal(f.counters().writes,0);assert.equal(f.counters().namespaceCalls,0);assert.equal(imports,stage==='access'?0:1);
 }finally{resolve();await Promise.all(retained);globalThis.fetch=originalFetch;globalThis.setTimeout=originalTimer;SyntheticHmacVerifier.create=originalCreate;f.sqlite.close();}
}
test('multi-source Access retains the original deadline and permit until settlement',()=>retainedDeadline('access'));
test('multi-source HMAC import retains the original deadline without late writes',()=>retainedDeadline('hmac'));

test('qualification remains closed without touching body, keys, platform or crypto',async()=>{
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'crypto')!;let touched=0;
 Object.defineProperty(globalThis,'crypto',{configurable:true,get(){touched++;throw Error('forbidden');}});
 try{
  const req=new Request('https://staging.invalid/');Object.defineProperty(req,'body',{get(){touched++;throw Error('forbidden');}});
  const b={APACELY_ENVIRONMENT:'staging',APACELY_OPERATION:'ingest_mock_lead',APACELY_INGRESS_ENABLED:'false',APACELY_EFFECTS_ENABLED:'false',get QUALIFICATION_HMAC_KEY_REGISTRY(){touched++;throw Error('forbidden');},get DB(){touched++;throw Error('forbidden');}};
  const r=await handle(req,b,lifetime);assert.equal(r.status,503,await r.text());assert.equal(touched,0);
 }finally{Object.defineProperty(globalThis,'crypto',descriptor);}
});

test('baseline current/next cannot become independent sources or select qualification through bindings',async()=>{
 const f=await setup();
 try{
  const convert=(r:typeof f.records[number])=>{const {secret_slot,...record}=r;return record;};
  const a=convert(f.records[0]),an=convert(f.records[1]),b={...convert(f.records[2]),slot:'next'};
  const base={...f.bindings,STAGING_HMAC_KEY_REGISTRY:JSON.stringify([a,b]),STAGING_SIGNING_KEY_CURRENT:f.bindings.QUALIFICATION_SIGNING_KEY_A_CURRENT,STAGING_SIGNING_KEY_NEXT:f.bindings.QUALIFICATION_SIGNING_KEY_B_CURRENT};
  const denied=await handleStagingRequest(await f.request(),base,lifetime);assert.equal(denied.status,500,await denied.text());assert.equal(f.counters().namespaceCalls,0);
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>Response.json({keys:[f.jwk]});
  try{
   base.STAGING_HMAC_KEY_REGISTRY=JSON.stringify([a,an]);base.STAGING_SIGNING_KEY_NEXT=f.bindings.QUALIFICATION_SIGNING_KEY_A_NEXT;
   for(const slot of ['current','next']){const r=await handleStagingRequest(await f.request('a',slot),base,lifetime);assert.equal(r.status,200,await r.text());}
   const foreign=await handleStagingRequest(await f.request('b'),base,lifetime);assert.equal(foreign.status,401,await foreign.text());
  }finally{globalThis.fetch=originalFetch;}
 }finally{f.sqlite.close();}
});

test('trusted lazy verifier authority capture runs after retained deadline starts and before asynchronous Access',async()=>{
 const {createStagingRuntime}=await import('../src/staging-runtime.js');
 const f=await setup(),originalTimer=globalThis.setTimeout,originalFetch=globalThis.fetch;
 let deadline=false,captured=false,accessCalls=0;const retained:Promise<unknown>[]=[];
 globalThis.setTimeout=((callback:any,ms?:number,...args:any[])=>{if(ms===10000)deadline=true;return originalTimer(callback,ms,...args);}) as typeof setTimeout;
 globalThis.fetch=async()=>{assert.equal(captured,true);accessCalls++;return Response.json({keys:[f.jwk]});};
 try{
  const lazy=createStagingRuntime(null,STAGING_POLICY,(receiver,signal,now)=>{
   assert.equal(deadline,true);assert.equal(receiver,f.bindings);assert.equal(signal.aborted,false);captured=true;
   return async()=>({protocol:'apacely-synthetic-ingress-hmac-v1',async verify(){return null;}});
  });
  f.reset();const response=await lazy(await f.request(),f.bindings,{waitUntil(p){retained.push(p);}});assert.equal(response.status,401,await response.text());
  await Promise.all(retained);assert.equal(captured,true);assert.equal(accessCalls,1);assert.equal(f.counters().writes,0);
 }finally{globalThis.setTimeout=originalTimer;globalThis.fetch=originalFetch;f.sqlite.close();}
});

for(const stage of ['access','digest','import'] as const)test('fixed129 retained deadline suppresses late '+stage+' continuation and downstream authority',async()=>{
 const {createFixedKeyringRuntime}=await import('../src/qualification/runtime.js'),{SOURCE129,SHARD_NAMES}=await import('../src/qualification/keyrings.js'),f=await setup(),request=await f.request(),secrets:string[]=[];
 for(const d of SOURCE129.descriptors){const bytes=crypto.getRandomValues(new Uint8Array(32));try{secrets.push(Buffer.from(bytes).toString('base64'));}finally{bytes.fill(0);}}
 for(const name of Object.keys(f.bindings))if(name.startsWith('QUALIFICATION_SIGNING_KEY_')||name==='QUALIFICATION_HMAC_KEY_REGISTRY')delete f.bindings[name];SHARD_NAMES.forEach((name,i)=>f.bindings[name]=JSON.stringify(secrets.slice(i*65,(i+1)*65)));secrets.fill('');
 const originalFetch=globalThis.fetch,originalTimer=globalThis.setTimeout,subtleDescriptor=Object.getOwnPropertyDescriptor(crypto,'subtle'),native=crypto.subtle;
 let expire:(()=>void)|undefined,release!:()=>void,entered!:()=>void,digests=0,imports=0,settled=false;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r),retained:Promise<unknown>[]=[];
 const adapter={digest:async(...args:Parameters<SubtleCrypto['digest']>)=>{if(args[0]==='SHA-256'&&args[1].byteLength===32){digests++;if(stage==='digest'&&digests===1){entered();await gate;}}return native.digest(...args);},importKey:async(...args:Parameters<SubtleCrypto['importKey']>)=>{if(args[0]==='raw'&&typeof args[2]==='object'&&args[2].name==='HMAC'){imports++;if(stage==='import'&&imports===1){entered();await gate;}}return (native.importKey as Function).apply(native,args);},verify:native.verify.bind(native)};
 Object.defineProperty(crypto,'subtle',{configurable:true,value:adapter});
 globalThis.setTimeout=((callback:any,ms?:number,...args:any[])=>{if(ms===10000)expire=()=>callback(...args);return originalTimer(callback,ms,...args);}) as typeof setTimeout;
 globalThis.fetch=async()=>{if(stage==='access'){entered();await gate;}return Response.json({keys:[f.jwk]});};
 try{
  f.reset();const handle=createFixedKeyringRuntime(STAGING_POLICY),pending=handle(request,f.bindings,{waitUntil(p){retained.push(p);void p.then(()=>settled=true);}});await started;assert.ok(expire);assert.equal(retained.length,1);assert.equal(localAdmission.snapshot().active,1);expire();
  const response=await pending;assert.equal(response.status,504,await response.text());assert.equal(settled,false);assert.equal(localAdmission.snapshot().active,1);release();await Promise.all(retained);assert.equal(localAdmission.snapshot().active,0);assert.equal(f.counters().writes,0);assert.equal(f.counters().namespaceCalls,0);assert.equal(imports,stage==='import'?1:0);assert.equal(digests,stage==='access'?0:stage==='digest'?1:129);
 }finally{release();await Promise.all(retained);globalThis.setTimeout=originalTimer;globalThis.fetch=originalFetch;if(subtleDescriptor)Object.defineProperty(crypto,'subtle',subtleDescriptor);else delete (crypto as {subtle?:unknown}).subtle;for(const name of SHARD_NAMES)delete f.bindings[name];f.sqlite.close();}
});
