import {Ingress,type Dependencies} from './worker-ingress.js';
import type {OperationalOptions} from './ingress-operations.js';
/** Narrow platform capability; the real ExecutionContext is supplied by the local fetch wrapper. */
export interface RequestLifetime {waitUntil(promise:Promise<unknown>):void}
/** Trusted composition only. No default export, environment inference, verifier or public entrypoint. */
export async function handleWorkerRequest(request:Request,dependencies:Dependencies,context:RequestLifetime,options:OperationalOptions={}):Promise<Response>{
 try{
  // Per-call private counters would silently bypass the intended cross-request budget.
  if([options.globalLimit,options.sourceLimit,options.maxSources].some(x=>x!==undefined)&&!options.admission)throw new Error('Unsupported admission composition');
  return await new Ingress(dependencies,options).handle(request,context);
 }catch{
  // Trusted composition can be malformed too; never expose constructor/getter exceptions.
  return Response.json({request_id:crypto.randomUUID(),code:'internal'},{status:500,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
 }
}
