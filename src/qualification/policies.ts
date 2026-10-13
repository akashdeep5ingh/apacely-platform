import {sha256} from '@noble/hashes/sha256';
import {bytesToHex} from '@noble/hashes/utils';
import {bootstrapAdmission,capturePolicy,type AdmissionPolicy,type AdmissionStorage} from '../distributed-admission.js';
import * as fixed from './artifacts/fixed-policies.js';
import type {StorageCapability} from './storage-capability-core.js';
export function qualificationStorageCapability(input:unknown,namespace:unknown,backing:unknown):StorageCapability {
 const original=captureQualificationProfile(input);if(namespace!==original.namespace||backing!=='sqlite')throw Error('Dedicated SQLite namespace required');
 for(const key of ['contention16','capacity16Source4','sourceKeys128','sourceRate100'] as const)if(QUALIFICATION_PROFILES[key]===original)return fixed.fixedStorageCapability(fixed[key],backing);
 throw Error('Original profile required');
}

/** Offline synthetic fixtures only. Never import from a deployable composition. */
export interface QualificationProfile {
 readonly name:string;
 readonly syntheticOnly:true;
 readonly scenarios:readonly string[];
 readonly admissionBudget:number;
 readonly recordHeadroom:number;
 readonly policy:Readonly<AdmissionPolicy>;
 readonly digest:string;
 readonly namespace:string;
}
function profile(name:string,ordinal:number,scenarios:string[],admissionBudget:number,overrides:Partial<AdmissionPolicy>):QualificationProfile {
 const recordHeadroom=16;
 const policy=capturePolicy({version:1,environment:'staging',domain:'distributed-admission-v1',
  epoch:`40000000-0000-4000-8000-${String(ordinal).padStart(12,'0')}`,
  aggregateCap:16,tenantCap:16,sourceCap:16,tenantKeyCap:16,sourceKeyCap:16,
  recordCap:admissionBudget+recordHeadroom,aggregateRate:1000,tenantRate:1000,sourceRate:1000,
  windowMs:10000,reservationTtlMs:30000,diagnosticTtlMs:30000,controlAttempts:2,...overrides});
 const canonical='{'+Object.keys(policy).sort().map(key=>JSON.stringify(key)+':'+JSON.stringify(policy[key as keyof AdmissionPolicy])).join(',')+'}';
 const digest=bytesToHex(sha256(new TextEncoder().encode(canonical)));
 return Object.freeze({name,syntheticOnly:true,scenarios:Object.freeze(scenarios),admissionBudget,recordHeadroom,policy,digest,
  namespace:`apacely-phase4-synthetic-${name}-${policy.epoch}-${digest}`});
}
/** Named constants are trusted build inputs, never environment/request-selected tiers. */
export const QUALIFICATION_PROFILES=Object.freeze({
 contention16:profile('contention16',1,['S14','S15'],16,{}),
 capacity16Source4:profile('capacity16-source4',2,['S16','S29-permits'],64,{sourceCap:4}),
 sourceKeys128:profile('source-keys128',3,['S29-source-keys'],129,{aggregateCap:256,tenantCap:256,sourceCap:256,tenantKeyCap:16,sourceKeyCap:128}),
 sourceRate100:profile('source-rate100',4,['S30'],100,{aggregateCap:16,tenantCap:16,sourceCap:4,sourceKeyCap:16,sourceRate:100}),
});

/** Reject clones/strings/accessors without reading untrusted properties. */
export function captureQualificationProfile(input:unknown):QualificationProfile {
 for(const candidate of Object.values(QUALIFICATION_PROFILES))if(input===candidate)return candidate;
 throw new Error('Original synthetic qualification profile required');
}
/** Explicit offline harness operation. Namespace identity is supplied by trusted composition.
 * Empty storage alone is not proof of remote birth; no remote use is authorized here.
 * Core bootstrap atomically rejects all previously initialized storage, even same policy.
 */
export async function bootstrapQualificationNamespace(input:unknown,storage:AdmissionStorage,namespace:string,now:number):Promise<void> {
 const captured=captureQualificationProfile(input);
 if(namespace!==captured.namespace)throw new Error('Dedicated qualification namespace required');
 const capability=qualificationStorageCapability(captured,namespace,'sqlite');
 await bootstrapAdmission(storage,captured.policy,now,capability);
}
