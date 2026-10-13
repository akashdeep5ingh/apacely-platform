import {checkSignal,validateHmacRecords,importHmacRecord,verifyHmac,type HmacKeyRecord,type CapturedKey} from '../internal-hmac-engine.js';
import type {VerificationInput} from '../worker-ingress.js';
import {SHARD_NAMES,requireOriginalRing,type FixedKeyring} from './keyrings.js';
import {validateQualificationDescriptors} from './key-registry.js';
const issued=new WeakMap<object,{signal:AbortSignal;check:()=>void}>();
function method(receiver:object,name:string):Function {for(let object:object|null=receiver;object;object=Object.getPrototypeOf(object)){const d=Object.getOwnPropertyDescriptor(object,name);if(d){if(!Object.hasOwn(d,'value')||typeof d.value!=='function')fail();return d.value;}}return fail();}
function fail():never {throw Error('Invalid synthetic authentication configuration');}
/** Capture belongs inside retained verify, before Access. Never invokes binding getters. */
export function captureQualifiedAuthority(ring:FixedKeyring,bindings:object,subtle:SubtleCrypto,signal:AbortSignal){
 try{
  checkSignal(signal);requireOriginalRing(ring);
  const descriptors=validateQualificationDescriptors(ring.registry);
  if(descriptors.length!==ring.counts.reduce((a,b)=>a+b,0)||descriptors.length>258||!bindings||![Object.prototype,null].includes(Object.getPrototypeOf(bindings)))fail();
  const fields=Object.getOwnPropertyDescriptors(bindings);
  for(const name of Reflect.ownKeys(fields))if(typeof name==='string'&&(name.startsWith('QUALIFICATION_SIGNING_KEY_')||name.startsWith('STAGING_SIGNING_KEY_')||name==='STAGING_HMAC_KEY_REGISTRY'||name==='QUALIFICATION_HMAC_KEY_REGISTRY'||name.startsWith('QUALIFICATION_HMAC_KEYRING_')&&!SHARD_NAMES.includes(name as typeof SHARD_NAMES[number])))fail();
  const materials=new Set<string>(),secrets:string[]=[];
  for(let i=0;i<4;i++){
   const d=fields[SHARD_NAMES[i]];if(!d||!d.enumerable||!Object.hasOwn(d,'value')||typeof d.value!=='string')fail();
   const value=d.value as string;if(value.length>3056||new TextEncoder().encode(value).byteLength>3056)fail();
   const parsed:unknown=JSON.parse(value);if(!Array.isArray(parsed)||parsed.length!==ring.counts[i]||parsed.length>65||JSON.stringify(parsed)!==value)fail();
   for(const secret of parsed){if(typeof secret!=='string'||!/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/.test(secret)||materials.has(secret))fail();materials.add(secret);secrets.push(secret);}
  }
  const prototype=Object.getPrototypeOf(bindings),subtlePrototype=Object.getPrototypeOf(subtle);
  const original=Object.freeze({digest:method(subtle,'digest'),importKey:method(subtle,'importKey'),verify:method(subtle,'verify')});
  const check=()=>{
   checkSignal(signal);if(Object.getPrototypeOf(bindings)!==prototype||Object.getPrototypeOf(subtle)!==subtlePrototype)fail();
   const current=Object.getOwnPropertyDescriptors(bindings);
   for(const name of Reflect.ownKeys(current))if(typeof name==='string'&&(name.startsWith('QUALIFICATION_SIGNING_KEY_')||name.startsWith('STAGING_SIGNING_KEY_')||name==='STAGING_HMAC_KEY_REGISTRY'||name==='QUALIFICATION_HMAC_KEY_REGISTRY'||name.startsWith('QUALIFICATION_HMAC_KEYRING_')&&!SHARD_NAMES.includes(name as typeof SHARD_NAMES[number])))fail();
   for(const name of SHARD_NAMES){const a=fields[name],b=current[name];if(!b||a.value!==b.value||a.enumerable!==b.enumerable||a.configurable!==b.configurable||a.writable!==b.writable||!Object.hasOwn(b,'value'))fail();}
   for(const name of ['digest','importKey','verify'] as const)if(method(subtle,name)!==original[name])fail();
  };
  const cryptoAuthority=Object.freeze({
   digest:(async(...args:Parameters<SubtleCrypto['digest']>)=>{check();const result=await original.digest.apply(subtle,args);check();return result;}) as SubtleCrypto['digest'],
   importKey:(async(...args:Parameters<SubtleCrypto['importKey']>)=>{check();const result=await original.importKey.apply(subtle,args);check();return result;}) as SubtleCrypto['importKey'],
   verify:(async(...args:Parameters<SubtleCrypto['verify']>)=>{check();const result=await original.verify.apply(subtle,args);check();return result;}) as SubtleCrypto['verify']
  });
  checkSignal(signal);
  const captured=Object.freeze({descriptors,secrets:Object.freeze(secrets),cryptoAuthority});issued.set(captured,{signal,check});return captured;
 }catch{return fail();}
}
export async function importQualifiedAuthority(authority:ReturnType<typeof captureQualifiedAuthority>,now:()=>string,signal:AbortSignal){
 const records:HmacKeyRecord[]=[],keys:CapturedKey[]=[];
 try{
  checkSignal(signal);const privateAuthority=issued.get(authority);if(!privateAuthority||privateAuthority.signal!==signal||typeof now!=='function')fail();privateAuthority.check();
  for(let i=0;i<authority.descriptors.length;i++){const {slot,secret_slot,...record}=authority.descriptors[i];const raw=atob(authority.secrets[i]);records.push({...record,bytes:Uint8Array.from(raw,c=>c.charCodeAt(0))});}
  const snapshots=await validateHmacRecords('staging',records,authority.cryptoAuthority.digest,signal);
  try{for(const r of snapshots)keys.push(await importHmacRecord(r,authority.cryptoAuthority.importKey,signal));}finally{for(const r of snapshots)r.bytes.fill(0);}
  checkSignal(signal);const frozen=Object.freeze(keys),{digest,verify}=authority.cryptoAuthority;
  return Object.freeze({protocol:'apacely-synthetic-ingress-hmac-v1' as const,verify:(input:VerificationInput)=>verifyHmac(frozen,'staging',now,digest,verify,input)});
 }catch{return fail();}finally{for(const r of records)r.bytes.fill(0);}
}
export async function createQualifiedHmac(ring:FixedKeyring,bindings:object,now:()=>string,subtle:SubtleCrypto,signal:AbortSignal){return importQualifiedAuthority(captureQualifiedAuthority(ring,bindings,subtle,signal),now,signal);}
