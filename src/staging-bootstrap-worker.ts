/// <reference types="@cloudflare/workers-types" />
import {DurableObject} from 'cloudflare:workers';
import {initializeFreshAdmission,validateSealedAdmission} from './staging-coordinator.js';
/** Trusted operator-only first-birth artifact. Deploy ONLY to an independently proven new namespace.
 * Empty storage is merely an additional guard, never the source of freshness authority.
 * Remove this artifact before ingress; it has no HTTP bootstrap/reset or admission handler. */
export class StagingAdmissionCoordinator extends DurableObject<object> {
 constructor(ctx:DurableObjectState,env:object){
  super(ctx,env);
  ctx.blockConcurrencyWhile(async()=>{await initializeFreshAdmission(ctx.storage,Date.now());await validateSealedAdmission(ctx.storage);});
 }
 fetch(_request:Request):Response{return new Response(null,{status:503});}
}
export default {fetch():Response{return new Response(null,{status:503});}};
