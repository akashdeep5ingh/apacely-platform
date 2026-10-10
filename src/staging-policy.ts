import {capturePolicy} from './distributed-admission.js';
/** Finite synthetic qualification policy only; no production quota or recovery authority. */
export const STAGING_POLICY=capturePolicy({version:1,environment:'staging',domain:'distributed-admission-v1',epoch:'10000000-0000-4000-8000-000000000001',aggregateCap:2,tenantCap:2,sourceCap:2,tenantKeyCap:2,sourceKeyCap:2,recordCap:32,aggregateRate:100,tenantRate:100,sourceRate:100,windowMs:10000,reservationTtlMs:30000,diagnosticTtlMs:30000,controlAttempts:2});
