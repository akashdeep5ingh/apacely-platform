import {sha256} from '@noble/hashes/sha256';
import {bytesToHex} from '@noble/hashes/utils';
import type {AdmissionPolicy} from '../distributed-admission.js';
/** Core transport only: no profile selector or offline catalogue in default bundles. */
export const STORAGE_BUDGET_SEAL_KEY='distributed-admission/storage-budget/v1';
declare const opaque:unique symbol;
export interface StorageCapability {readonly [opaque]:true}
export interface CapturedStorageCapability {readonly maxStateChars:262144;readonly policyDigest:string;readonly namespace:string;readonly seal:string}
const originals=new WeakMap<object,CapturedStorageCapability>();
// Exact reviewed build configurations. Changes require new width/regression review, never dynamic growth.
const fixed=Object.freeze([
 ['contention16','40000000-0000-4000-8000-000000000001','c40e972a19563f4e131d0aec743d8acb6390d69093c5c70ea3d633fa05fb2199'],
 ['capacity16-source4','40000000-0000-4000-8000-000000000002','8fac05ceb484ed9319f4e9a7156ff37f0a6b7ef8ef2953cdf503f9dda608ecb1'],
 ['source-keys128','40000000-0000-4000-8000-000000000003','6c55f35c23287d2accad5ca63e10b909769f28780d06ac5743d40e65b3515c36'],
 ['source-rate100','40000000-0000-4000-8000-000000000004','46e7c0635788d9b06bdfab828673d5d4b18a6168bc60e65f1a5a70d242aa6a96'],
] as const);
/** Internal fixed build registration. Not an integer-budget API. Trusted modules only. */
export function registerFixedStorageCapability(policy:Readonly<AdmissionPolicy>,policyDigest:string,namespace:string):StorageCapability {
 const descriptors=Object.getOwnPropertyDescriptors(policy);
 if(Object.values(descriptors).some(d=>!Object.hasOwn(d,'value')||!d.enumerable))throw Error('Own policy data required');
 const canonical='{'+Object.keys(descriptors).sort().map(key=>JSON.stringify(key)+':'+JSON.stringify(descriptors[key].value)).join(',')+'}';
 if(bytesToHex(sha256(new TextEncoder().encode(canonical)))!==policyDigest||!fixed.some(([name,epoch,digest])=>policyDigest===digest&&namespace===`apacely-phase4-synthetic-${name}-${epoch}-${digest}`))throw Error('Reviewed fixed storage configuration required');
 const token=Object.freeze(Object.create(null)) as StorageCapability;
 const seal=JSON.stringify({maxStateChars:262144,namespace,policyDigest,representationVersion:1,version:1});
 originals.set(token,Object.freeze({maxStateChars:262144,policyDigest,namespace,seal}));return token;
}
/** Weak identity lookup invokes no accessors/proxy traps. Caller verifies captured policy digest. */
export function captureStorageCapability(input:unknown):CapturedStorageCapability {
 const captured=typeof input==='object'&&input!==null?originals.get(input):undefined;
 if(!captured)throw Error('Original fixed storage capability required');return captured;
}
