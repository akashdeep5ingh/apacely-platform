/// <reference types="@cloudflare/workers-types" />
import {DurableObject} from 'cloudflare:workers';
import {initializeFreshAdmission,validateSealedAdmission} from '../../staging-coordinator.js';
import {sourceRate100 as policy,fixedStorageCapability} from './fixed-policies.js';
const capability=fixedStorageCapability(policy,'sqlite');
/** Private first birth only. Constructor and HTTP cannot initialize. */
export class StagingAdmissionCoordinator extends DurableObject<object> {
 async initializeOnce():Promise<void>{
  await initializeFreshAdmission(this.ctx.storage,Date.now(),policy,capability);
  await validateSealedAdmission(this.ctx.storage,policy,capability);
 }
 fetch():Response{return new Response(null,{status:503});}
}
export default {fetch():Response{return new Response(null,{status:503});}};
