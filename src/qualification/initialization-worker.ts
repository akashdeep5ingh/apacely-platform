/// <reference types="@cloudflare/workers-types" />
import {WorkerEntrypoint} from 'cloudflare:workers';
interface InitializableStub {initializeOnce():Promise<void>}
interface InitializerEnvironment {QUALIFICATION_ADMISSION:DurableObjectNamespace}
/** Temporary service-binding capability. No HTTP activation, selectors, reset or status oracle. */
export default class QualificationInitializer extends WorkerEntrypoint<InitializerEnvironment> {
 fetch():Response{return new Response(null,{status:503});}
 async invokeFirstBirth():Promise<void>{
  const namespace=this.env.QUALIFICATION_ADMISSION;
  const stub=namespace.get(namespace.idFromName('distributed-admission-v1')) as DurableObjectStub & InitializableStub;
  await stub.initializeOnce();
 }
}
