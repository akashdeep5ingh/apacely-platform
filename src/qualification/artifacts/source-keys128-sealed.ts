/// <reference types="@cloudflare/workers-types" />
import {DurableObject} from 'cloudflare:workers';
import {AdmissionCoordinator} from '../../distributed-admission.js';
import {admissionStorage,validateSealedAdmission} from '../../staging-coordinator.js';
import {createFixedKeyringRuntime} from '../runtime.js';
import {sourceKeys128 as policy,fixedStorageCapability} from './fixed-policies.js';
const capability=fixedStorageCapability(policy,'sqlite');
const handle=createFixedKeyringRuntime(policy);
/** Sealed same-namespace composition: read-only constructor, no initializer RPC. */
export class StagingAdmissionCoordinator extends DurableObject<object> {
 readonly #core:AdmissionCoordinator;
 constructor(ctx:DurableObjectState,env:object){
  super(ctx,env);
  this.#core=new AdmissionCoordinator(admissionStorage(ctx.storage),policy,Date.now,capability);
  ctx.blockConcurrencyWhile(()=>validateSealedAdmission(ctx.storage,policy,capability));
 }
 fetch(request:Request):Promise<Response>{return this.#core.fetch(request);}
}
export default {fetch(request:Request,env:object,ctx:ExecutionContext):Promise<Response>{return handle(request,env,ctx);}};
