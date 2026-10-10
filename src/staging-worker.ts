/// <reference types="@cloudflare/workers-types" />
import {DurableObject} from 'cloudflare:workers';
import {AdmissionCoordinator} from './distributed-admission.js';
import {admissionStorage,validateSealedAdmission} from './staging-coordinator.js';
import {STAGING_POLICY} from './staging-policy.js';
import {handleStagingRequest} from './staging-runtime.js';
/** Sealed release: constructor integrity check is read-only; absent state never proves birth. */
export class StagingAdmissionCoordinator extends DurableObject<object> {
 readonly #core:AdmissionCoordinator;
 constructor(ctx:DurableObjectState,env:object){
  super(ctx,env);
  this.#core=new AdmissionCoordinator(admissionStorage(ctx.storage),STAGING_POLICY);
  ctx.blockConcurrencyWhile(()=>validateSealedAdmission(ctx.storage));
 }
 fetch(request:Request):Promise<Response>{return this.#core.fetch(request);}
}
export default {fetch(request:Request,env:object,ctx:ExecutionContext):Promise<Response>{return handleStagingRequest(request,env,ctx);}};
