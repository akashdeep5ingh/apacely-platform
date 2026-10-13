/// <reference types="@cloudflare/workers-types" />
import {DurableObject} from 'cloudflare:workers';
import {initializeFreshAdmission,validateSealedAdmission} from '../staging-coordinator.js';
/** Private first-birth artifact; never deploy over the baseline namespace.
 * No constructor writes. Only the temporary service-bound initializer calls this method.
 * Same exported class identity is retained by the later sealed artifact. */
export class StagingAdmissionCoordinator extends DurableObject<object> {
 async initializeOnce():Promise<void>{
  await initializeFreshAdmission(this.ctx.storage,Date.now());
  await validateSealedAdmission(this.ctx.storage);
 }
 fetch():Response{return new Response(null,{status:503});}
}
export default {fetch():Response{return new Response(null,{status:503});}};
