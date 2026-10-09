import {trustedEnvironment} from './contracts.js';
import {assertDatabaseEnvironment} from './environment.js';
import type {D1Binding} from './d1-repository.js';
import {Ingress,captureOperationalOptions,type Dependencies} from './worker-ingress.js';
import type {OperationalOptions} from './ingress-operations.js';
/** Narrow platform capability; the real ExecutionContext is supplied by the local fetch wrapper. */
export interface RequestLifetime {waitUntil(promise:Promise<unknown>):void}
/** Trusted composition only. No default export, environment inference, verifier or public entrypoint. */
export async function handleWorkerRequest(request:Request,dependencies:Dependencies,context:RequestLifetime,options:OperationalOptions={}):Promise<Response>{
 try{
  options=captureOperationalOptions(options);
  // Per-call private counters would silently bypass the intended cross-request budget.
  if([options.globalLimit,options.sourceLimit,options.maxSources].some(x=>x!==undefined)&&!options.admission)throw new Error('Unsupported admission composition');
  return await new Ingress(dependencies,options).handle(request,context);
 }catch{
  // Trusted composition can be malformed too; never expose constructor/getter exceptions.
  return Response.json({request_id:crypto.randomUUID(),code:'internal'},{status:500,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
 }
}

export interface ApplicationBindings {APACELY_ENVIRONMENT:unknown;APACELY_OPERATION:unknown;DB:D1Binding}
/** New environment selection path: explicit application configuration only, no defaults.
 * A reusable capability, NOT a default fetch or deployable staging entrypoint. */
export async function handleConfiguredWorkerRequest(request:Request,bindings:ApplicationBindings,dependencies:Dependencies,context:RequestLifetime,options:OperationalOptions={}):Promise<Response>{
 try{
  options=captureOperationalOptions(options);
  if(Object.getOwnPropertyDescriptor(options,'admissionMode')?.value==='distributed'){
   if(!bindings||![Object.prototype,null].includes(Object.getPrototypeOf(bindings)))throw new Error('Invalid application binding descriptors');
   const keys=Reflect.ownKeys(bindings),descriptors=Object.getOwnPropertyDescriptors(bindings);
   if(keys.length!==3||keys.some(k=>typeof k!=='string'||!['APACELY_ENVIRONMENT','APACELY_OPERATION','DB'].includes(k)))throw new Error('Invalid application binding descriptors');
   for(const key of keys as string[])if(!descriptors[key].enumerable||!Object.hasOwn(descriptors[key],'value'))throw new Error('Invalid application binding descriptors');
   bindings={APACELY_ENVIRONMENT:descriptors.APACELY_ENVIRONMENT.value,APACELY_OPERATION:descriptors.APACELY_OPERATION.value,DB:descriptors.DB.value!};
  }
  if(!bindings||Object.keys(bindings).length!==3||Object.keys(bindings).some(k=>!['APACELY_ENVIRONMENT','APACELY_OPERATION','DB'].includes(k)))throw new Error('Exact application configuration required');
  const environment=trustedEnvironment(bindings.APACELY_ENVIRONMENT),db=bindings.DB;
  if(bindings.APACELY_OPERATION!=='ingest_mock_lead'||!db||typeof db.prepare!=='function'||typeof db.batch!=='function'||'getBookmark' in db)throw new Error('Unsupported application bindings');
  if(!dependencies.repo.authorityBinding||!dependencies.repo.replayBinding||dependencies.repo.authorityBinding()!==db||dependencies.repo.replayBinding()!==db||dependencies.mappings.authorityBinding()!==db||dependencies.replay.authorityBinding()!==db)throw new Error('Original application binding required');
  if([options.globalLimit,options.sourceLimit,options.maxSources].some(x=>x!==undefined)&&!options.admission)throw new Error('Unsupported admission composition');
  const captured=Object.freeze({prepare:db.prepare.bind(db),batch:db.batch.bind(db)});
  const ingress=new Ingress(dependencies,options,environment,()=>assertDatabaseEnvironment(captured,environment));
  return await ingress.handle(request,context);
 }catch{
  return Response.json({request_id:crypto.randomUUID(),code:'internal'},{status:500,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
 }
}
