import {SOURCE129} from '../keyrings.js';
/** Nonsecret fixed build-time synthetic descriptors; no signer or env-selected registry.
 * Current/next rotate independently per source. Rebuild/review expired lifecycle windows.
 * Secrets must be supplied privately under the exact slots; no checked-in material. */
function descriptors(prefix:string,sources:number,rotation:boolean):string{
 return JSON.stringify(Array.from({length:sources},(_,index)=>{
  const n=String(index+1).padStart(3,'0');
  return (rotation?['current','next']:['current']).map(slot=>({slot,
   secret_slot:`QUALIFICATION_SIGNING_KEY_${prefix}_${n}_${slot.toUpperCase()}`,
   key_id:`${prefix.toLowerCase()}-${n}-${slot}`,environment:'staging',provider:'synthetic',
   principal:`principal-${n}`,source:`source-${n}`,route:'/v1/ingress/synthetic',
   not_before:slot==='current'?'2026-10-13T00:00:00.000Z':'2026-10-13T23:57:00.000Z',
   not_after:slot==='current'?'2026-10-14T00:00:00.000Z':'2026-10-15T00:00:00.000Z',revoked_at:null}));
 }).flat());
}
function capture(bindings:object,registry:string):object{
 if(!bindings||![Object.prototype,null].includes(Object.getPrototypeOf(bindings)))throw Error('Invalid qualification bindings');
 const fields=Object.getOwnPropertyDescriptors(bindings);
 // Preserve descriptors, including hostile getters, for the existing own-data guards.
 // Never spread/read bindings: original DB/namespace receivers must survive unchanged.
 fields.QUALIFICATION_HMAC_KEY_REGISTRY={value:registry,enumerable:true,writable:false,configurable:false};
 return Object.freeze(Object.create(Object.getPrototypeOf(bindings),fields)) as object;
}
const c16=descriptors('C16',16,true),c4=descriptors('C4',16,true),k128=SOURCE129.registry,r100=descriptors('R100',16,true);
export const contention16=(bindings:object):object=>capture(bindings,c16);
export const capacity16Source4=(bindings:object):object=>capture(bindings,c4);
export const sourceKeys128=(bindings:object):object=>capture(bindings,k128);
export const sourceRate100=(bindings:object):object=>capture(bindings,r100);
