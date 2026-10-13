import type {HmacKeyRecord} from '../synthetic-hmac.js';
export interface CapturedQualificationKey {readonly record:Readonly<Omit<HmacKeyRecord,'bytes'>>;readonly secret:string}
type Descriptor=Omit<HmacKeyRecord,'bytes'> & {slot:'current'|'next';secret_slot:string};
const fields=['slot','secret_slot','key_id','environment','provider','principal','source','route','not_before','not_after','revoked_at'];
const MAX_SOURCES=129,MAX_RECORDS=MAX_SOURCES*2;
// All legal strings are ASCII. Canonical maximal descriptors include 122-byte
// secret-slot names, three 128-byte identifiers and three 24-byte timestamps.
// 129 current/next pairs plus array brackets/commas bound JSON before parsing.
const maximal={slot:'current',secret_slot:'QUALIFICATION_SIGNING_KEY_'+'X'.repeat(96),key_id:'X'.repeat(128),environment:'staging',provider:'synthetic',principal:'X'.repeat(128),source:'X'.repeat(128),route:'/v1/ingress/synthetic',not_before:'9999-12-31T23:59:58.999Z',not_after:'9999-12-31T23:59:59.999Z',revoked_at:'9999-12-31T23:59:59.999Z'};
const MAX_REGISTRY_BYTES=2+MAX_RECORDS-1+MAX_SOURCES*(JSON.stringify(maximal).length+JSON.stringify({...maximal,slot:'next'}).length);
function own(object:object,key:string):unknown{
 const d=Object.getOwnPropertyDescriptor(object,key);
 if(!d||!d.enumerable||!Object.hasOwn(d,'value'))throw Error('Invalid qualification binding');
 return d.value;
}
function epoch(value:unknown):value is string{
 return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&!value.startsWith('0000')&&Number.isSafeInteger(Date.parse(value))&&new Date(value).toISOString()===value;
}
/** Import-only synthetic registry. Secret strings are captured, never logged or persisted. */
export function captureQualificationKeys(bindings:object):readonly CapturedQualificationKey[]{
 if(!bindings||![Object.prototype,null].includes(Object.getPrototypeOf(bindings)))throw Error('Invalid qualification bindings');
 const value=own(bindings,'QUALIFICATION_HMAC_KEY_REGISTRY');
 if(typeof value!=='string'||value.length>MAX_REGISTRY_BYTES||new TextEncoder().encode(value).byteLength>MAX_REGISTRY_BYTES)throw Error('Invalid qualification registry');
 const parsed:unknown=JSON.parse(value);
 if(!Array.isArray(parsed)||parsed.length<1||parsed.length>MAX_RECORDS)throw Error('Invalid qualification registry');
 const descriptors=validateQualificationDescriptors(value);
 const slots=new Set(descriptors.map(d=>d.secret_slot)),materials=new Set<string>();
 if(Reflect.ownKeys(bindings).some(k=>typeof k==='string'&&k.startsWith('QUALIFICATION_SIGNING_KEY_')&&!slots.has(k)))throw Error('Unregistered qualification slot');
 const keys=descriptors.map(({slot,secret_slot,...record})=>{
  const secret=own(bindings,secret_slot);
  if(typeof secret!=='string'||!/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/.test(secret))throw Error('Invalid qualification material');
  if(materials.has(secret))throw Error('Aliased qualification key');
  materials.add(secret);
  return Object.freeze({record:Object.freeze(record),secret});
 });
 return Object.freeze(keys);
}

/** Shared global nonsecret validation; no key authority is minted here. */
export function validateQualificationDescriptors(value:string):readonly Readonly<Descriptor>[] {
 if(value.length>MAX_REGISTRY_BYTES||new TextEncoder().encode(value).byteLength>MAX_REGISTRY_BYTES)throw Error('Invalid qualification registry');
 const parsed:unknown=JSON.parse(value);if(!Array.isArray(parsed)||parsed.length<1||parsed.length>MAX_RECORDS)throw Error('Invalid qualification registry');
 const ids=new Set<string>(),slots=new Set<string>(),groups=new Map<string,Descriptor[]>(),principals=new Map<string,string>();
 // Validate the entire nonsecret allowlist before capturing any secret material.
 const descriptors=parsed.map((r:Descriptor)=>{
  if(!r||typeof r!=='object'||Array.isArray(r)||Reflect.ownKeys(r).length!==fields.length||Reflect.ownKeys(r).some(k=>typeof k!=='string'||!fields.includes(k)))throw Error('Invalid qualification descriptor');
  const snapshot=Object.fromEntries(fields.map(k=>[k,own(r,k)])) as Descriptor;
  if(!['current','next'].includes(snapshot.slot)||typeof snapshot.secret_slot!=='string'||!/^QUALIFICATION_SIGNING_KEY_[A-Z][A-Z0-9_]{0,95}$/.test(snapshot.secret_slot)||snapshot.environment!=='staging'||snapshot.provider!=='synthetic'||snapshot.route!=='/v1/ingress/synthetic'||![snapshot.key_id,snapshot.principal,snapshot.source].every(v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(v)))throw Error('Invalid qualification scope');
  if(!epoch(snapshot.not_before)||!epoch(snapshot.not_after)||Date.parse(snapshot.not_before)>=Date.parse(snapshot.not_after)||snapshot.revoked_at!==null&&!epoch(snapshot.revoked_at))throw Error('Invalid qualification lifecycle');
  if(ids.has(snapshot.key_id)||slots.has(snapshot.secret_slot))throw Error('Aliased qualification key');
  ids.add(snapshot.key_id);slots.add(snapshot.secret_slot);
  if(principals.has(snapshot.principal)&&principals.get(snapshot.principal)!==snapshot.source)throw Error('Aliased qualification principal');
  principals.set(snapshot.principal,snapshot.source);
  const group=groups.get(snapshot.source)??[];
  if(group.some(k=>k.principal!==snapshot.principal||k.slot===snapshot.slot))throw Error('Invalid qualification rotation');
  group.push(snapshot);groups.set(snapshot.source,group);
  return snapshot;
 });
 if(groups.size>MAX_SOURCES)throw Error('Invalid qualification source capacity');
 for(const group of groups.values()){
  if(!group.some(k=>k.slot==='current')||group.length>2)throw Error('Missing qualification current');
  if(group.length===2&&Math.min(...group.map(k=>Date.parse(k.not_after)))-Math.max(...group.map(k=>Date.parse(k.not_before)))>300000)throw Error('Invalid qualification overlap');
 }
 return Object.freeze(descriptors.map(r=>Object.freeze(r)));
}
