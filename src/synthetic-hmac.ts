import type {Principal,VerificationInput} from './worker-ingress.js';
import {trustedEnvironment,type Environment} from './contracts.js';
import {validateHmacRecords,importHmacRecord,verifyHmac,type CapturedKey} from './internal-hmac-engine.js';
export type {HmacKeyRecord} from './internal-hmac-engine.js';
import type {HmacKeyRecord} from './internal-hmac-engine.js';
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
   const snapshots=await validateHmacRecords(env,records,digest);const keys:CapturedKey[]=[];
   try{for(const r of snapshots)keys.push(await importHmacRecord(r,importKey));}finally{for(const r of snapshots)r.bytes.fill(0);}
   return new SyntheticHmacVerifier(env,keys,now,captured);
  }catch{throw new Error('Invalid synthetic authentication configuration');}
 }
 async verify(input:VerificationInput):Promise<Principal|null>{return verifyHmac(this.#keys,this.#environment,this.#now,this.#digest,this.#verify,input);}
}
