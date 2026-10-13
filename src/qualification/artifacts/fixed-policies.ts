import {sha256} from '@noble/hashes/sha256';
import {bytesToHex} from '@noble/hashes/utils';
import {capturePolicy} from '../../distributed-admission.js';
import {registerFixedStorageCapability,type StorageCapability} from '../storage-capability-core.js';
const capabilities=new WeakMap<object,StorageCapability>();
/** Only the four original literal policies can request this fixed SQLite capability. */
export function fixedStorageCapability(input:unknown,backing:unknown='sqlite'):StorageCapability {
 let name:string|undefined;
 for(const [key,original] of Object.entries({contention16,capacity16Source4,sourceKeys128,sourceRate100}))if(input===original)name=key;
 if(!name||backing!=='sqlite')throw Error('Original fixed SQLite policy required');
 const policy=input as typeof contention16;let cap=capabilities.get(policy);
 if(!cap){const canonical='{'+Object.keys(policy).sort().map(key=>JSON.stringify(key)+':'+JSON.stringify(policy[key as keyof typeof policy])).join(',')+'}';
 const digest=bytesToHex(sha256(new TextEncoder().encode(canonical)));
 const label=name==='capacity16Source4'?'capacity16-source4':name==='sourceKeys128'?'source-keys128':name==='sourceRate100'?'source-rate100':name;
 cap=registerFixedStorageCapability(policy,digest,`apacely-phase4-synthetic-${label}-${policy.epoch}-${digest}`);capabilities.set(policy,cap);}
 return cap;
}
/** Reviewed synthetic-only literal build inputs. No selector, fixtures or birth capability.
 * Keep exact parity with OFFLINE policies.ts through qualification-artifacts.test.ts. */
export const contention16=capturePolicy({version:1,environment:'staging',domain:'distributed-admission-v1',epoch:'40000000-0000-4000-8000-000000000001',aggregateCap:16,tenantCap:16,sourceCap:16,tenantKeyCap:16,sourceKeyCap:16,recordCap:32,aggregateRate:1000,tenantRate:1000,sourceRate:1000,windowMs:10000,reservationTtlMs:30000,diagnosticTtlMs:30000,controlAttempts:2});
export const capacity16Source4=capturePolicy({version:1,environment:'staging',domain:'distributed-admission-v1',epoch:'40000000-0000-4000-8000-000000000002',aggregateCap:16,tenantCap:16,sourceCap:4,tenantKeyCap:16,sourceKeyCap:16,recordCap:80,aggregateRate:1000,tenantRate:1000,sourceRate:1000,windowMs:10000,reservationTtlMs:30000,diagnosticTtlMs:30000,controlAttempts:2});
export const sourceKeys128=capturePolicy({version:1,environment:'staging',domain:'distributed-admission-v1',epoch:'40000000-0000-4000-8000-000000000003',aggregateCap:256,tenantCap:256,sourceCap:256,tenantKeyCap:16,sourceKeyCap:128,recordCap:145,aggregateRate:1000,tenantRate:1000,sourceRate:1000,windowMs:10000,reservationTtlMs:30000,diagnosticTtlMs:30000,controlAttempts:2});
export const sourceRate100=capturePolicy({version:1,environment:'staging',domain:'distributed-admission-v1',epoch:'40000000-0000-4000-8000-000000000004',aggregateCap:16,tenantCap:16,sourceCap:4,tenantKeyCap:16,sourceKeyCap:16,recordCap:116,aggregateRate:1000,tenantRate:1000,sourceRate:100,windowMs:10000,reservationTtlMs:30000,diagnosticTtlMs:30000,controlAttempts:2});
