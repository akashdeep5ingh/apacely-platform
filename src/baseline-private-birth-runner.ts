/// <reference types="@cloudflare/workers-types" />
import {WorkerEntrypoint} from 'cloudflare:workers';
interface Env {STAGING_ADMISSION:DurableObjectNamespace;}
/** Service-bound only. A completed fetch is invocation evidence, NOT birth evidence. */
export class BaselinePrivateBirthRunner extends WorkerEntrypoint<Env> {
 async invoke():Promise<{invoked:true;birthVerified:false;status:number}>{
  if(arguments.length!==0)throw new Error('Private invocation accepts no arguments');
  const namespace=this.env.STAGING_ADMISSION;
  const stub=namespace.get(namespace.idFromName('distributed-admission-v1'));
  const response=await stub.fetch('https://admission.internal/private-birth');
  const status=response.status;
  // Status-only protocol; cancel immediately, without trusting a body or retrying.
  await response.body?.cancel();
  return {invoked:true,birthVerified:false,status};
 }
 async fetch():Promise<Response>{return new Response(null,{status:503});}
}
export default {fetch():Response{return new Response(null,{status:503});}};
