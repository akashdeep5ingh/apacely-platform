import {validateQualificationDescriptors} from './key-registry.js';
export const SHARD_NAMES=Object.freeze(['QUALIFICATION_HMAC_KEYRING_1','QUALIFICATION_HMAC_KEYRING_2','QUALIFICATION_HMAC_KEYRING_3','QUALIFICATION_HMAC_KEYRING_4'] as const);
function build(rotation:boolean){
 const descriptors=Array.from({length:129},(_,i)=>{const n=String(i+1).padStart(3,'0');return {slot:'current',secret_slot:`QUALIFICATION_SIGNING_KEY_K128_${n}_CURRENT`,key_id:`k128-${n}-current`,environment:'staging',provider:'synthetic',principal:`principal-${n}`,source:`source-${n}`,route:'/v1/ingress/synthetic',not_before:'2026-10-13T00:00:00.000Z',not_after:'2026-10-14T00:00:00.000Z',revoked_at:null};});
 if(rotation)descriptors.push(...descriptors.map(r=>({...r,slot:'next',secret_slot:r.secret_slot.replace('_CURRENT','_NEXT'),key_id:r.key_id.replace('-current','-next'),not_before:'2026-10-13T23:57:00.000Z',not_after:'2026-10-15T00:00:00.000Z'})));
 const registry=JSON.stringify(descriptors);
 return Object.freeze({registry,descriptors:validateQualificationDescriptors(registry),counts:Object.freeze(rotation?[65,65,65,63]:[65,64,0,0])});
}
/** Original reviewed build objects only. No env/request/clock-selected rebuild. */
export const SOURCE129=build(false);
export const FULL258=build(true);
export type FixedKeyring=typeof SOURCE129;
export function requireOriginalRing(ring:FixedKeyring):void {if(ring!==SOURCE129&&ring!==FULL258)throw Error('Invalid qualification authority');}
