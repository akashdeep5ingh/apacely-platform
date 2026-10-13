import {createStagingRuntime} from '../staging-runtime.js';
import type {AdmissionPolicy} from '../distributed-admission.js';
import {captureQualificationKeys} from './key-registry.js';
/** Explicit trusted import only; no env/header/body-selected profile or public entrypoint.
 * The captured policy must be supplied by the separate artifact's composition owner. */
export function createQualificationRuntime(policy:AdmissionPolicy){
 return createStagingRuntime(captureQualificationKeys,policy);
}

import {SOURCE129,requireOriginalRing,type FixedKeyring} from './keyrings.js';
import {captureQualifiedAuthority,importQualifiedAuthority} from './hmac-capability.js';
/** Qualification-only original fixed-ring composition; never binding-selected. */
export function createFixedKeyringRuntime(policy:AdmissionPolicy,ring:FixedKeyring=SOURCE129){
 requireOriginalRing(ring);
 return createStagingRuntime(null,policy,(bindings,signal,now)=>{
  const authority=captureQualifiedAuthority(ring,bindings,crypto.subtle,signal);
  return ()=>importQualifiedAuthority(authority,now,signal);
 });
}
