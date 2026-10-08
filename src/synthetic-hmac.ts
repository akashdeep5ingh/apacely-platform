import type {Principal,VerificationInput} from './worker-ingress.js';
import {trustedEnvironment,type Environment} from './contracts.js';
export interface HmacKeyRecord {key_id:string;environment:Environment;provider:string;principal:string;source:string;route:string;not_before:string;not_after:string;revoked_at?:string|null;bytes:Uint8Array}
function epoch(value:string):number|null {if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)||value.startsWith('0000'))return null;const ms=Date.parse(value);return Number.isSafeInteger(ms)&&new Date(ms).toISOString()===value?ms:null;}
type CapturedKey=Omit<HmacKeyRecord,'bytes'> & {key:CryptoKey};
/** Offline synthetic adapter only. Replacement requires a new trusted composition. */
export class SyntheticHmacVerifier {
 readonly protocol='apacely-synthetic-ingress-hmac-v1' as const;
 #keys:ReadonlyArray<CapturedKey>;#environment:Environment;#now:()=>string;#digest:SubtleCrypto['digest'];#verify:SubtleCrypto['verify'];
 private constructor(environment:Environment,keys:CapturedKey[],now:()=>string,subtle:Pick<SubtleCrypto,'digest'|'verify'>){Object.defineProperty(this,'protocol',{value:'apacely-synthetic-ingress-hmac-v1',writable:false,configurable:false,enumerable:true});this.#environment=environment;this.#keys=Object.freeze(keys);this.#now=now;this.#digest=subtle.digest.bind(subtle);this.#verify=subtle.verify.bind(subtle);}
 static async create(environment:Environment,records:readonly HmacKeyRecord[],now:()=>string,subtle:SubtleCrypto=crypto.subtle):Promise<SyntheticHmacVerifier>{
  try{
   const captured=Object.freeze({importKey:subtle.importKey.bind(subtle),digest:subtle.digest.bind(subtle),verify:subtle.verify.bind(subtle)});
   const env=trustedEnvironment(environment),importKey=captured.importKey,digest=captured.digest;
   if(!Array.isArray(records)||records.length<1||records.length>128||typeof now!=='function')throw new Error('Invalid registry');
   if(records.some(r=>!(r.bytes instanceof Uint8Array)))throw new Error('Invalid material');
   const snapshots=records.map(r=>({key_id:r.key_id,environment:r.environment,provider:r.provider,principal:r.principal,source:r.source,route:r.route,not_before:r.not_before,not_after:r.not_after,revoked_at:r.revoked_at??null,bytes:new Uint8Array(r.bytes)}));const keys:CapturedKey[]=[];
   const ids=new Set<string>(),materials=new Set<string>(),scopes=new Map<string,typeof snapshots>();
   try{for(const r of snapshots){
    if(r.environment!==env||![r.key_id,r.principal,r.source].every(x=>typeof x==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(x))||!/^[a-z][a-z0-9_-]{0,31}$/.test(r.provider)||r.route!=='/v1/ingress/'+r.provider||r.bytes.length!==32||ids.has(r.key_id))throw new Error('Invalid registry');
    const before=epoch(r.not_before),after=epoch(r.not_after);if(before===null||after===null||before>=after||(r.revoked_at!==null&&epoch(r.revoked_at)===null))throw new Error('Invalid lifecycle');
    ids.add(r.key_id);
    const material=Array.from(new Uint8Array(await digest('SHA-256',r.bytes)),b=>b.toString(16).padStart(2,'0')).join('');if(materials.has(material))throw new Error('Reused material');materials.add(material);
    const scope=JSON.stringify([r.environment,r.provider,r.principal,r.source,r.route]),group=scopes.get(scope)??[];group.push(r);scopes.set(scope,group);
    if(group.length>2)throw new Error('Rotation bound');
    if(group.length===2&&Math.min(...group.map(k=>epoch(k.not_after)!))-Math.max(...group.map(k=>epoch(k.not_before)!))>300000)throw new Error('Rotation overlap');
   }}catch(error){for(const r of snapshots)r.bytes.fill(0);throw error;}
   try{for(const r of snapshots){const bytes=r.bytes;try{const key=await importKey('raw',bytes,{name:'HMAC',hash:'SHA-256'},false,['verify']);const algorithm=key.algorithm as HmacKeyAlgorithm;
    if(key.type!=='secret'||key.extractable||algorithm.name!=='HMAC'||algorithm.hash.name!=='SHA-256'||algorithm.length!==256||key.usages.length!==1||key.usages[0]!=='verify')throw new Error('Invalid key capability');
    const {bytes:ignored,...record}=r;keys.push(Object.freeze({...record,key}));}finally{bytes.fill(0);}}}finally{for(const r of snapshots)r.bytes.fill(0);}
   return new SyntheticHmacVerifier(env,keys,now,captured);
  }catch{throw new Error('Invalid synthetic authentication configuration');}
 }
 async verify(input:VerificationInput):Promise<Principal|null>{
  try{
   input=Object.freeze({...input,headers:new Headers(input.headers),body:input.body.slice()});
   if(input.signal?.aborted)return null;
   const key_id=input.headers.get('apacely-key-id'),source=input.headers.get('apacely-source'),signed_at=input.headers.get('apacely-signed-at'),nonce=input.headers.get('apacely-nonce'),signature=input.headers.get('apacely-signature');
   const allowed=['apacely-key-id','apacely-source','apacely-signed-at','apacely-nonce','apacely-signature'];
   for(const [name] of input.headers)if(name.startsWith('apacely-')&&!allowed.includes(name))return null;
   if(![key_id,source,nonce].every(x=>typeof x==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(x)))return null;
   const r=this.#keys.find(k=>k.key_id===key_id);if(!r||!source||!signed_at||!nonce||!signature||epoch(signed_at)===null)return null;
   if(r.environment!==this.#environment||r.provider!==input.provider||r.source!==source||r.route!==input.path||input.method!=='POST')return null;
   if(!(input.body instanceof Uint8Array)||input.body.byteLength<1||input.body.byteLength>16384)return null;
   const body=input.body.slice();const digest=Array.from(new Uint8Array(await this.#digest('SHA-256',body)),b=>b.toString(16).padStart(2,'0')).join('');
   if(!/^[a-f0-9]{64}$/.test(input.body_digest)||digest!==input.body_digest)return null;
   const message=new TextEncoder().encode(JSON.stringify(['apacely-synthetic-ingress-hmac-v1',this.#environment,r.provider,r.principal,r.source,key_id,input.method,input.path,signed_at,nonce,digest]));
   if(!/^[A-Za-z0-9_-]{43}$/.test(signature))return null;
   const decoded=atob(signature.replaceAll('-','+').replaceAll('_','/')+'=');
   if(decoded.length!==32||btoa(decoded).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'')!==signature)return null;
   const sig=Uint8Array.from(decoded,c=>c.charCodeAt(0));
   if(!await this.#verify('HMAC',r.key,sig,message))return null;
   if(input.signal?.aborted)return null;
   const observed=epoch(this.#now()),signed=epoch(signed_at);
   if(observed===null)throw new Error('Invalid clock');
   if(signed===null||observed-signed>=300000||signed-observed>30000)return null;
   const before=epoch(r.not_before),after=epoch(r.not_after),revoked=r.revoked_at?epoch(r.revoked_at):null;
   if(before===null||after===null)throw new Error('Invalid key lifecycle');
   if(observed<before||observed>=after||signed<before||signed>=after||(revoked!==null&&(observed>=revoked||signed>=revoked)))return null;
   return Object.freeze({principal:r.principal,provider:r.provider,source:r.source,signed_at,nonce,body_digest:digest,method:input.method,path:input.path,protocol:'apacely-synthetic-ingress-hmac-v1',key_id:r.key_id,environment:this.#environment});
  }catch{throw new Error('Synthetic authentication failed');}
 }
}
