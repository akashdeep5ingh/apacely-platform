import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp,cp,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {Miniflare,Headers as RuntimeHeaders} from 'miniflare';

// The existence assertion makes the absent feature a test failure, not an import error.
test('DA01 real SQLite DO canonical fetch atomic admission persists across reboot',async()=>{
 assert.equal(existsSync(new URL('../../src/distributed-admission.ts',import.meta.url)),true,'Distributed admission implementation is absent');
 const bundle=await build({stdin:{resolveDir:process.cwd(),contents:`
 import {AdmissionCoordinator,bootstrapAdmission,encodeMessage,decodeMessage} from './src/distributed-admission.ts';
 const policy={version:1,environment:'development',domain:'distributed-admission-v1',epoch:'10000000-0000-4000-8000-000000000001',aggregateCap:2,tenantCap:2,sourceCap:2,tenantKeyCap:2,sourceKeyCap:2,recordCap:32,aggregateRate:100,tenantRate:100,sourceRate:100,windowMs:10000,reservationTtlMs:30000,diagnosticTtlMs:30000,controlAttempts:2};
 export class Admission {
  constructor(state){this.now=Date.now();this.core=new AdmissionCoordinator(state.storage,policy,()=>this.now);this.storage=state.storage;}
  async fetch(request){if(new URL(request.url).pathname==='/test-only-clock'){this.now=Number(new URL(request.url).searchParams.get('now'));return new Response(null,{status:204});}if(new URL(request.url).pathname==='/test-only-bootstrap'){await bootstrapAdmission(this.storage,policy,this.now);return new Response(null,{status:204});}return this.core.fetch(request);}
 }
 export default {async fetch(request,env){const stub=env.ADMISSION.get(env.ADMISSION.idFromName('distributed-admission-v1'));return stub.fetch(request);}};
 `},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
 const persistence=await mkdtemp('/tmp/distributed-admission-implementation/da01-');
 const options={modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2025-07-18',compatibilityFlags:[],durableObjects:{ADMISSION:{className:'Admission',useSQLite:true}},durableObjectsPersist:persistence,host:'127.0.0.1',cf:false,outboundService:()=>{throw Error('External access forbidden');}};
 const {createTicket,encodeMessage,decodeMessage}=await import('../../src/distributed-admission.js');
 const policy={version:1 as const,environment:'development' as const,domain:'distributed-admission-v1' as const,epoch:'10000000-0000-4000-8000-000000000001',aggregateCap:2,tenantCap:2,sourceCap:2,tenantKeyCap:2,sourceKeyCap:2,recordCap:32,aggregateRate:100,tenantRate:100,sourceRate:100,windowMs:10000,reservationTtlMs:30000,diagnosticTtlMs:30000,controlAttempts:2};
 const tickets=Array.from({length:3},()=>createTicket(policy,{environment:'development',tenant:'20000000-0000-4000-8000-000000000001',provider:'synthetic',principal:'principal',source:'source',mappingId:'30000000-0000-4000-8000-000000000001',mappingVersion:1,sourceBinding:'mock-source-001',operation:'ingest_mock_lead'},Date.now()+30000));
 let mf=new Miniflare(options);
 const send=async(ticket:typeof tickets[number],operation:'reserve'|'inspect'|'start'|'settle')=>{
  const response=await mf.dispatchFetch('https://admission.internal/v1/'+operation,{method:'POST',headers:{'content-type':'application/json'},body:encodeMessage({version:1,operation,ticket,payload:operation==='settle'?{kind:'known-not-issued',barrierId:crypto.randomUUID()}: {}})});
  const raw=await response.text();return {status:response.status,reply:decodeMessage(raw,'reply')};
 };
 try{
  assert.equal((await mf.dispatchFetch('https://admission.internal/test-only-bootstrap',{method:'POST'})).status,204);
  const results=await Promise.all(tickets.map(ticket=>send(ticket,'reserve')));
  assert.equal(results.filter(r=>r.status===200).length,2);
  assert.equal(results.filter(r=>r.status===409).length,1);
  assert.equal(results.find(r=>r.status===409)!.reply.result.tag,'denied');
  const granted=results.findIndex(r=>r.status===200);
  const original=results[granted].reply;
  assert.equal(original.result.tag,'record');
  await mf.dispose();await cp(persistence,persistence+'-backup',{recursive:true});mf=new Miniflare(options);
  const read=await send(tickets[granted],'inspect');assert.equal(read.status,200);assert.deepEqual(read.reply.result,original.result);
  assert.equal(original.result.tag,'record');
  if(original.result.tag!=='record')throw Error('Missing grant');
  const started=await send(original.result.record.handle,'start');
  assert.equal(started.status,200,'Owned RESERVED work must start through the actual SQLite DO');
  assert.equal(started.reply.result.tag,'record');
  if(started.reply.result.tag==='record')assert.equal(started.reply.result.record.state,'ACTIVE');
  // This retained test execution has issued no downstream work: a synthetic known-not-issued barrier.
  const released=await send(original.result.record.handle,'settle');
  assert.equal(released.status,200,'Exact owner known-not-issued settlement must release');
  if(released.reply.result.tag==='record')assert.equal(released.reply.result.record.state,'RELEASED');
  await mf.dispatchFetch('https://admission.internal/test-only-clock?now=0',{method:'POST'});
  const recovery=await send(original.result.record.handle,'inspect');
  assert.equal(recovery.status,200,'Clock rollback must not block exact-owner inspection');
  assert.equal((await send(original.result.record.handle,'settle')).status,200,'Clock rollback must not block existing terminal settlement');
 }finally{await mf.dispose();}
});

import {createTicket,encodeMessage,decodeMessage,type AdmissionPolicy,type AdmissionTicket,type AdmissionMethod,type AdmissionRecord} from '../../src/distributed-admission.js';
const fixturePolicy:AdmissionPolicy={version:1,environment:'development',domain:'distributed-admission-v1',epoch:'10000000-0000-4000-8000-000000000001',aggregateCap:1024,tenantCap:1024,sourceCap:1024,tenantKeyCap:2,sourceKeyCap:2,recordCap:1024,aggregateRate:10000,tenantRate:10000,sourceRate:10000,windowMs:10000,reservationTtlMs:30000,diagnosticTtlMs:30000,controlAttempts:2};
interface RuntimeFailureEvidence {index:number;path:string;method:string;headers:Record<string,string>;body:string|null;bodySha256:string|null;error:{name:string;message:string};cause:{name?:string;message?:string;code?:string};coordinatorState?:string;stateReadError?:string}
async function runtime(input:Partial<AdmissionPolicy>={},afterResponse?:(response:Awaited<ReturnType<Miniflare['dispatchFetch']>>,path:string)=>Promise<Awaited<ReturnType<Miniflare['dispatchFetch']>>>){
 const policy={...fixturePolicy,...input},initial=Date.now();
 const bundle=await build({stdin:{resolveDir:process.cwd(),contents:`
 import {AdmissionCoordinator,bootstrapAdmission} from './src/distributed-admission.ts';
 const policy=${JSON.stringify(policy)},initial=${initial};
 export class Admission {
 constructor(state){this.now=initial;this.storage=state.storage;this.core=new AdmissionCoordinator(state.storage,policy,()=>this.now);}
 async fetch(request){const url=new URL(request.url);
 if(url.pathname==='/test-only-bootstrap'){await bootstrapAdmission(this.storage,policy,this.now);return new Response(null,{status:204});}
 if(url.pathname==='/test-only-clock'){this.now=Number(url.searchParams.get('now'));return new Response(null,{status:204});}
 if(url.pathname==='/test-only-corrupt'){await this.storage.put('distributed-admission/state/v1',await request.text());return new Response(null,{status:204});}
 if(url.pathname==='/test-only-state')return new Response(await this.storage.get('distributed-admission/state/v1'));
 return this.core.fetch(request);}
 }
 export default {fetch(request,env){return env.ADMISSION.get(env.ADMISSION.idFromName('distributed-admission-v1')).fetch(request);}};
 `},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
 const persistence=await mkdtemp('/tmp/distributed-admission-implementation/runtime-');
 const options={modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2025-07-18',compatibilityFlags:[],durableObjects:{ADMISSION:{className:'Admission',useSQLite:true}},durableObjectsPersist:persistence,host:'127.0.0.1',cf:false,outboundService:()=>{throw Error('External access forbidden');}};
 let mf=new Miniflare(options);
 // Test-only diagnostics: never exported by application code. Preserve the original error;
 // a failed observation cannot establish rollback. Exact synthetic data stays in private evidence.
 let requestIndex=0;const failures:RuntimeFailureEvidence[]=[];
 const fetch=async(path:string,init?:Parameters<Miniflare['dispatchFetch']>[1])=>{
  const index=++requestIndex;
  try{const response=await mf.dispatchFetch('https://admission.internal'+path,init);return afterResponse?await afterResponse(response,path):response;}
  catch(error){
   if(failures.length<4){
    const original=error as Error&{cause?:Error&{code?:string}},cause=original?.cause;
    const raw=typeof init?.body==='string'?init.body:null;
    const evidence:RuntimeFailureEvidence={index,path,method:init?.method??'GET',headers:Object.fromEntries(new RuntimeHeaders(init?.headers).entries()),body:raw!==null&&raw.length<=65536?raw:null,bodySha256:raw===null?null:createHash('sha256').update(raw).digest('hex'),error:{name:original?.name??'unknown',message:String(original?.message??'unknown').slice(0,512)},cause:{name:cause?.name,message:cause?.message?.slice(0,512),code:cause?.code}};
    const abort=new AbortController();const timer=setTimeout(()=>abort.abort(),2000);
    try{
     const response=await mf.dispatchFetch('https://admission.internal/test-only-state',{signal:abort.signal});
     if(response.status!==200||!response.body)throw Error('Coordinator state unavailable');
     const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0,reads=0;
     try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>65536||++reads>65536)throw Error('State observation bound exceeded');chunks.push(part.value);}}
     catch(readError){void reader.cancel().catch(()=>undefined);throw readError;}finally{reader.releaseLock();}
     evidence.coordinatorState=Buffer.concat(chunks).toString('utf8');
    }catch(observationError){evidence.stateReadError=String((observationError as Error)?.message??'unavailable').slice(0,256);}finally{clearTimeout(timer);}
    failures.push(evidence);
    const dir=process.env.APACELY_DA11_EVIDENCE_DIR;
    if(dir){try{await writeFile(dir+'/failure-'+process.pid+'-'+crypto.randomUUID()+'.json',JSON.stringify(evidence),{mode:0o600,flag:'wx'});}catch{console.error('DA11 evidence persistence unavailable');}}
    console.error('DA11 local transport observation',JSON.stringify({index,path,error:evidence.error.name,causeCode:evidence.cause.code,stateObserved:evidence.coordinatorState!==undefined,stateSha256:evidence.coordinatorState===undefined?null:createHash('sha256').update(evidence.coordinatorState).digest('hex')}));
   }
   throw error;
  }
 };
 assert.equal((await fetch('/test-only-bootstrap',{method:'POST'})).status,204);
 return {policy,initial,fetch,failureEvidence:()=>failures.slice(),close:()=>mf.dispose(),restart:async()=>{await mf.dispose();mf=new Miniflare(options);},
 ticket:(source='source',tenant='20000000-0000-4000-8000-000000000001')=>createTicket(policy,{environment:policy.environment,tenant,provider:'synthetic',principal:'principal',source,mappingId:'30000000-0000-4000-8000-000000000001',mappingVersion:1,sourceBinding:'mock-source-001',operation:'ingest_mock_lead'},initial+30000),
 clock:(now:number)=>fetch('/test-only-clock?now='+now,{method:'POST'}),
 state:async()=>{const raw=await (await fetch('/test-only-state')).text();return {raw,state:JSON.parse(raw)};},
 send:async(ticket:AdmissionTicket,operation:AdmissionMethod,payload:{}|{kind:'known-not-issued'|'all-issued-terminal';barrierId:string}={})=>{const response=await fetch('/v1/'+operation,{method:'POST',headers:{'content-type':'application/json'},body:encodeMessage({version:1,operation,ticket,payload})});return {status:response.status,reply:decodeMessage(await response.text(),'reply')};}
 };
}
test('DA08 private original-owner execution releases only tracked terminal batches and rejects duplicate launch',async()=>{
 const module=await import('../../src/distributed-admission.js');
 assert.equal(typeof (module as Record<string,unknown>).captureAdmission,'function','Missing private admission facade');
 const h=await runtime({aggregateCap:1});const db={};
 try{
 const namespace={idFromName:(name:string)=>{assert.equal(name,'distributed-admission-v1');return name;},get:()=>({fetch:async(request:Request)=>new Response(await (await h.fetch(new URL(request.url).pathname,{method:request.method,headers:{'content-type':'application/json'},body:await request.text()})).text(),{status:200,headers:{'content-type':'application/json'}})})};
 const facade=module.captureAdmission({policy:h.policy,namespace,database:db});
 const {Deadline}=await import('../../src/ingress-operations.js');const deadline=new Deadline(30000,()=>h.initial);
 try{const e=facade.execution(h.ticket().context.authority,deadline);await e.start();
 const unit=e.observer.issued(db);assert.equal((await h.state()).state.aggregateLive,1);
 await assert.rejects(e.start());unit.resolved();await e.complete();
 assert.equal((await h.state()).state.aggregateLive,0);assert.equal((await h.state()).state.registry[0].terminalKind,'all-issued-terminal');
 assert.equal('settle' in e,false);assert.equal('reconcile' in facade,false);
 }finally{deadline.close();}
 }finally{await h.close();}
});

import {readFileSync} from 'node:fs';
async function workerCase(code:string,input:Partial<AdmissionPolicy>={},http=false){
 const bundle=await build({stdin:{resolveDir:process.cwd(),contents:`
 import {WorkerEntrypoint} from 'cloudflare:workers';
 import {D1Repository} from './src/d1-repository.ts';
 import {D1ReplayLedger} from './src/replay-ledger.ts';
 import {D1SourceMappingStore} from './src/source-mappings.ts';
 import {Ingress} from './src/worker-ingress.ts';
 import {handleConfiguredWorkerRequest,handleWorkerRequest} from './src/worker-http.ts';
 import {Deadline,LocalAdmission} from './src/ingress-operations.ts';
 import {captureAdmission,AdmissionCoordinator,bootstrapAdmission} from './src/distributed-admission.ts';
 import {fixture} from './src/fixture.ts';
 const policy=${JSON.stringify({...fixturePolicy,aggregateCap:2,...input})};
 export class Admission {constructor(state){this.storage=state.storage;this.core=new AdmissionCoordinator(state.storage,policy);}
 async fetch(request){const path=new URL(request.url).pathname;if(path==='/bootstrap'){await bootstrapAdmission(this.storage,policy,Date.now());return new Response(null,{status:204});}if(path==='/state')return new Response(await this.storage.get('distributed-admission/state/v1'));return this.core.fetch(request);}}
 export default class extends WorkerEntrypoint {async fetch(){try{return new Response(String(await this.verify()));}catch(error){return new Response(error.message,{status:500});}}async verify(){
 const check=(value,message)=>{if(!value)throw Error(message);};
 const now=()=>new Date().toISOString(),db=this.env.DB,repo=new D1Repository(db,now),replay=new D1ReplayLedger(db,now),store=new D1SourceMappingStore(db,now);
 const tenant=await repo.createTenant('Synthetic'),mapping=await store.create({principal:'actor',provider:'synthetic',source:'source',tenant_id:tenant.id,source_binding:'mock-source-001',environment:'development',operation:'ingest_mock_lead'});
 const stub=this.env.ADMISSION.get(this.env.ADMISSION.idFromName('distributed-admission-v1'));await stub.fetch('https://admission.internal/bootstrap',{method:'POST'});
 const state=async()=>await (await stub.fetch('https://admission.internal/state')).json();
 const authority={environment:'development',tenant:tenant.id,provider:'synthetic',principal:'actor',source:'source',mappingId:mapping.id,mappingVersion:mapping.version,sourceBinding:mapping.source_binding,operation:'ingest_mock_lead'};
 const options={admissionMode:'distributed',distributed:{policy,namespace:this.env.ADMISSION,database:db}};
 const deps={repo,replay,mappings:store,now,log:()=>{},verifier:{verify:async x=>({principal:'actor',provider:x.provider,source:'source',signed_at:now(),nonce:'nonce',body_digest:x.body_digest,method:x.method,path:x.path})}};
 const request=()=>new Request('https://local.invalid/v1/ingress/synthetic',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(fixture)});
 ${code}
 return true;}}
 `},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:workers'],metafile:true});
 assert.ok(Object.keys(bundle.metafile!.inputs).every(p=>!/(node:|better-sqlite3|src\/repository)/.test(p)));
 const local=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2025-07-18',compatibilityFlags:[],d1Databases:['DB'],durableObjects:{ADMISSION:{className:'Admission',useSQLite:true}},host:'127.0.0.1',cf:false,outboundService:()=>{throw Error('External access forbidden');}});
 try{const db=await local.getD1Database('DB');await db.exec(readFileSync(new URL('../../src/schema.sql',import.meta.url),'utf8').replace(/--[^\n]*/g,'').replaceAll('\n',' '));if(http){const response=await local.dispatchFetch('http://localhost/test-descriptors');assert.equal(await response.text(),'true');assert.equal(response.status,200);}else{const worker=await local.getWorker() as unknown as {verify():Promise<boolean>};assert.equal(await worker.verify(),true);}}finally{await local.dispose();}
}
test('DA09 original D1 and replay adapters observe issuance before normalized outcomes',()=>workerCase(`
 let issued=0,resolved=0,rejected=0;const observer={issued(identity){check(identity===db,'original DB identity');issued++;return {resolved(){resolved++;},rejected(){rejected++;}};}};
 check(typeof repo.operationObserverBinding==='function'&&repo.operationObserverBinding()===db,'Repository observer capability missing');
 check(typeof replay.operationObserverBinding==='function'&&replay.operationObserverBinding()===db,'Replay observer capability missing');
 const claim=await replay.claim({authority:mapping,nonce:'tracked',fingerprint:'a'.repeat(64),signed_at:now()},undefined,observer);
 check(issued===1&&resolved===1&&rejected===0,'claim actual issuance');
 await repo.accept({environment:'development',tenant_id:tenant.id},()=>42,undefined,undefined,undefined,observer);
 check(issued===2&&resolved===2&&rejected===0,'snapshot actual issuance');
 `));

test('DA15 ingress binds real D1 pipeline to owned admission and complete observer barrier',()=>workerCase(`
 const retained=[];const response=await new Ingress(deps,options).handle(request(),{waitUntil:p=>retained.push(p)});
 check(response.status===200,'acceptance '+response.status+' states '+(await state()).registry.map(r=>r.state).join(','));await Promise.all(retained);
 const s=await state();check(s.registry.length===1,'Distributed ingress must reserve exactly one owner');check(s.aggregateLive===0&&s.registry[0].state==='RELEASED'&&s.registry[0].terminalKind==='all-issued-terminal','actual tracked terminal barrier');
 check((await db.prepare('SELECT count(*) n FROM events').first()).n===1,'one event');check((await db.prepare('SELECT count(*) n FROM action_outbox').first()).n===1,'one outbox');
 `));

test('DA11 accounting uses bounded linear registry scans with exact aggregate tenant source caches',async()=>{
 const source=readFileSync(new URL('../../src/distributed-admission.ts',import.meta.url),'utf8');
 assert.equal(/state\.registry\.filter\(r=>charged\(r\)&&/.test(source)||/state\.registry\.filter\(rec=>charged\(rec\)&&/.test(source),false,'Quadratic per-bucket registry accounting remains');
 const h=await runtime();try{const handles=await Promise.all(Array.from({length:8},()=>h.send(h.ticket(),'reserve')));const state=(await h.state()).state;assert.equal(state.aggregateLive,8);assert.equal(state.tenants[0].live,8);assert.equal(state.sources[0].live,8);for(const r of handles)await h.send(owned(r).handle,'cancelUnstarted');assert.equal((await h.state()).state.aggregateLive,0);}finally{await h.close();}
});

test('DA09 DA16 commit response loss remains sticky quarantine after semantic replay succeeds',()=>workerCase(`
 let batches=0;const faultDb={prepare:db.prepare.bind(db),batch:async statements=>{const result=await db.batch(statements);if(++batches===3)throw Error('D1_ERROR: Network connection lost.');return result;}};
 const dependencies={...deps,repo:new D1Repository(faultDb,now),replay:new D1ReplayLedger(faultDb,now),mappings:new D1SourceMappingStore(faultDb,now)};
 const retained=[];const response=await new Ingress(dependencies,{...options,distributed:{...options.distributed,database:faultDb}}).handle(request(),{waitUntil:p=>retained.push(p)});
 check(response.status===200,'semantic replay after actual commit');await Promise.all(retained);
 const s=await state();check(s.aggregateLive===1&&s.registry[0].state==='QUARANTINED','unknown issuance must never release even after replay');
 check((await db.prepare('SELECT count(*) n FROM events').first()).n===1,'one event');check((await db.prepare('SELECT count(*) n FROM action_outbox').first()).n===1,'one outbox');
 `));
test('DA11 explicit distributed composition requires capability and original observing adapters',()=>workerCase(`
 for(const config of [{admissionMode:'distributed'},{...options,distributed:{...options.distributed,database:{}}},{...options,distributed:{...options.distributed,policy:{...policy,environment:'staging'}}}]){let failed=false;try{new Ingress(deps,config);}catch{failed=true;}check(failed,'fail closed composition');}
 check((await state()).registry.length===0,'zero coordinator changes');check((await db.prepare('SELECT count(*) n FROM replay_ledger').first()).n===0,'zero nonce');
 `));


import {webcrypto} from 'node:crypto';
const hmacVectors=JSON.parse(readFileSync(new URL('../fixtures/synthetic-hmac-v1.json',import.meta.url),'utf8'));
async function httpAdmission(input:Partial<AdmissionPolicy>={},mode='normal'){
 const policy={...fixturePolicy,aggregateCap:1,diagnosticTtlMs:1,...input},time=new Date().toISOString(),record={...hmacVectors.keys.find((k:{environment:string})=>k.environment==='development'),not_before:new Date(Date.parse(time)-60000).toISOString(),not_after:new Date(Date.parse(time)+3600000).toISOString()};
 const rotated={...record,key_id:'fixture-rotated',key_hex:hmacVectors.keys.find((k:{key_hex:string})=>k.key_hex!==record.key_hex).key_hex};record.not_after=new Date(Date.parse(time)+240000).toISOString();
 const bundle=await build({stdin:{resolveDir:process.cwd(),contents:`
 import {SyntheticHmacVerifier} from './src/synthetic-hmac.ts';
 import {handleConfiguredWorkerRequest,handleWorkerRequest} from './src/worker-http.ts';
 import {D1Repository} from './src/d1-repository.ts';import {D1ReplayLedger} from './src/replay-ledger.ts';import {D1SourceMappingStore} from './src/source-mappings.ts';
 import {AdmissionCoordinator,bootstrapAdmission} from './src/distributed-admission.ts';
 const policy=${JSON.stringify(policy)},record=${JSON.stringify(record)},rotated=${JSON.stringify(rotated)},mode=${JSON.stringify(mode)};
 let held=false,aborts=0;const unblock=()=>{};
 export class Admission {constructor(state){this.storage=state.storage;this.core=new AdmissionCoordinator(state.storage,policy);}
 async fetch(request){const path=new URL(request.url).pathname;if(path==='/bootstrap'){await bootstrapAdmission(this.storage,policy,Date.now());return new Response(null,{status:204});}if(path==='/state')return new Response(await this.storage.get('distributed-admission/state/v1'));return this.core.fetch(request);}}
 export default {async fetch(request,env,ctx){const path=new URL(request.url).pathname,stub=env.ADMISSION.get(env.ADMISSION.idFromName('distributed-admission-v1'));
 if(path==='/test/bootstrap')return stub.fetch('https://admission.internal/bootstrap',{method:'POST'});
 if(path==='/test/state')return stub.fetch('https://admission.internal/state');if(path==='/test/unblock'){unblock();return new Response(null,{status:204});}
 if(path==='/test/held')return Response.json({held});if(path==='/test/signal')return Response.json({aborts});request.signal.addEventListener('abort',()=>aborts++,{once:true});
 const now=()=>new Date().toISOString();let count=0;
 // Fault injector is test-only; all work below invokes real original-primary D1.
 const db=mode==='normal'?env.DB:{prepare:env.DB.prepare.bind(env.DB),batch:async statements=>{const result=await env.DB.batch(statements);count++;if(count===(mode==='claim-held'?1:3)&&['held','claim-held'].includes(mode)){held=true;await new Promise(r=>setTimeout(r,mode==='held'?3000:500));}if(count===3&&mode==='lost')throw Error('D1_ERROR: Network connection lost.');return result;}};
 const originalVerifier=await SyntheticHmacVerifier.create('development',[record,rotated].map(k=>({...k,bytes:Uint8Array.from(k.key_hex.match(/../g),x=>parseInt(x,16))})),now);
 const verifier=mode==='crypto-held'?{protocol:originalVerifier.protocol,verify:async input=>{held=true;await new Promise(r=>setTimeout(r,500));return originalVerifier.verify(input);}}:originalVerifier;
 if(mode==='body-held'){const original=request;request=new Request(original,{body:new ReadableStream({async start(controller){held=true;await new Promise(r=>setTimeout(r,500));try{controller.enqueue(new Uint8Array(await original.arrayBuffer()));controller.close();}catch{}}})});}
 return handleConfiguredWorkerRequest(request,{APACELY_ENVIRONMENT:'development',APACELY_OPERATION:'ingest_mock_lead',DB:db},{repo:new D1Repository(db,now),mappings:new D1SourceMappingStore(db,now),replay:new D1ReplayLedger(db,now),verifier,now,log:()=>{}},ctx,{admissionMode:'distributed',distributed:{policy,namespace:env.ADMISSION,database:db},deadlineMs:['held','claim-held','crypto-held','body-held'].includes(mode)?150:10000});
 }};`},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',metafile:true});
 assert.ok(Object.keys(bundle.metafile!.inputs).every(p=>!/(node:|better-sqlite3)/.test(p)));
 const persistence=await mkdtemp('/tmp/distributed-admission-implementation/http-');
 const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2025-07-18',compatibilityFlags:[],d1Databases:['DB'],durableObjects:{ADMISSION:{className:'Admission',useSQLite:true}},durableObjectsPersist:persistence,host:'127.0.0.1',cf:false,outboundService:()=>{throw Error('External access forbidden');}});
 try{const db=await mf.getD1Database('DB');await db.exec(readFileSync(new URL('../../src/schema.sql',import.meta.url),'utf8').replace(/--[^\n]*/g,'').replaceAll('\n',' '));const tenant='f0000000-0000-4000-8000-000000000001',mapping='f0000000-0000-4000-8000-000000000002';
 await db.prepare("INSERT INTO tenants VALUES (?,?,'active',?)").bind(tenant,'Synthetic distributed HTTP',time).run();await db.prepare("INSERT INTO source_mappings VALUES (?,1,'synthetic','public-source-001','public-principal-001',?,'public-binding-001','development','ingest_mock_lead','active',?,?,NULL,NULL)").bind(mapping,tenant,time,time).run();
 const fetch=(path:string,init?:Parameters<Miniflare['dispatchFetch']>[1])=>mf.dispatchFetch('http://localhost'+path,init);
 assert.equal((await fetch('/test/bootstrap',{method:'POST'})).status,204);
 const signed=async(nonce='distributed-http-nonce',kid=record.key_id)=>{const body=hmacVectors.messages[0].body_utf8,digest=Buffer.from(await webcrypto.subtle.digest('SHA-256',Buffer.from(body))).toString('hex');const tuple=['apacely-synthetic-ingress-hmac-v1','development','synthetic','public-principal-001','public-source-001',kid,'POST','/v1/ingress/synthetic',time,nonce,digest];const key=await webcrypto.subtle.importKey('raw',Buffer.from(kid==='fixture-rotated'?rotated.key_hex:record.key_hex,'hex'),{name:'HMAC',hash:'SHA-256'},false,['sign']);const signature=Buffer.from(await webcrypto.subtle.sign('HMAC',key,Buffer.from(JSON.stringify(tuple)))).toString('base64url');return {method:'POST',headers:{'content-type':'application/json','apacely-key-id':kid,'apacely-source':'public-source-001','apacely-signed-at':time,'apacely-nonce':nonce,'apacely-signature':signature},body};};
 return {fetch,signed,db,state:async()=>await (await fetch('/test/state')).json() as any,close:async()=>{await fetch('/test/unblock',{method:'POST'});await mf.dispose();}};
 }catch(e){await mf.dispose();throw e;}
}
// Status-only fixture responses still own a stream. Cancel immediately; do not
// prebuffer, clone, suppress diagnostics or alter any application/state assertion.
async function consumedStatus(response:{status:number;body:{cancel():Promise<void>}|null}) {
 const status=response.status;if(response.body)await response.body.cancel();return status;
}
async function eventually(check:()=>Promise<boolean>){const end=Date.now()+5000;while(!await check()){assert.ok(Date.now()<end,'Bounded state observation expired');await new Promise(r=>setTimeout(r,10));}}
test('DA08 DA12 actual HMAC HTTP timeout retains pending D1 capacity until original completion',async()=>{
 const h=await httpAdmission({},'held');try{
 const response=await h.fetch('/v1/ingress/synthetic',await h.signed());assert.equal(await consumedStatus(response),504);
 assert.equal((await h.state()).aggregateLive,1);assert.equal(await consumedStatus(await h.fetch('/test/held')),200);
 const next=await h.fetch('/v1/ingress/synthetic',await h.signed('second'));assert.equal(next.status,503);assert.equal((await next.json() as {code:string}).code,'overloaded','Definitive capacity denial keeps existing safe overload envelope');assert.equal((await h.state()).aggregateLive,1);assert.equal((await h.state()).registry.length,1,'Definitive denials must not allocate cancellation seals');assert.equal((await h.state()).registry[0].state,'QUARANTINED');
 await h.fetch('/test/unblock',{method:'POST'});await eventually(async()=>(await h.state()).aggregateLive===0);
 assert.deepEqual((await h.db.prepare('SELECT (SELECT count(*) FROM events) events,(SELECT count(*) FROM action_outbox) actions,(SELECT count(*) FROM replay_ledger) nonces').all()).results,[{events:1,actions:1,nonces:1}]);
 }finally{await h.close();}
});
test('DA03 actual distributed HMAC HTTP rejects unauthorized identities without admission or writes',async()=>{
 const h=await httpAdmission();try{const bad=await h.signed();bad.headers['apacely-signature']='invalid';assert.equal(await consumedStatus(await h.fetch('/v1/ingress/synthetic',bad)),401);
 await h.db.prepare("UPDATE source_mappings SET status='revoked',version=version+1,revoked_at=updated_at,revoked_version=version+1").run();assert.equal(await consumedStatus(await h.fetch('/v1/ingress/synthetic',await h.signed())),403);assert.equal((await h.state()).registry.length,0);
 assert.deepEqual((await h.db.prepare('SELECT (SELECT count(*) FROM events) events,(SELECT count(*) FROM action_outbox) actions,(SELECT count(*) FROM replay_ledger) nonces').all()).results,[{events:0,actions:0,nonces:0}]);}finally{await h.close();}
});


function closedEqual(actual:unknown,expected:unknown){assert.equal(canonicalFixture(actual),canonicalFixture(expected));}
function canonicalFixture(value:any):string {if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return '['+value.map(canonicalFixture).join(',')+']';return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonicalFixture(value[k])).join(',')+'}';}
function facadeFor(h:Awaited<ReturnType<typeof runtime>>,database:object,transform?:(response:Response,operation:string)=>Promise<Response>){return {policy:h.policy,database,namespace:{idFromName:(name:string)=>{assert.equal(name,'distributed-admission-v1');return name;},get:()=>({fetch:async(request:Request)=>{const path=new URL(request.url).pathname,r=await h.fetch(path,{method:request.method,headers:{'content-type':'application/json'},body:await request.text()});const response=new Response(await r.text(),{status:r.status,headers:{'content-type':'application/json'}});return transform?transform(response,path.split('/').at(-1)!):response;}})}};}
test('DA02 exact aggregate tenant stable-source denials preserve all counters',async()=>{
 const cases:[Partial<AdmissionPolicy>,string,string,string][]=[
 [{aggregateCap:2,tenantCap:2,sourceCap:2},'aggregate','other','20000000-0000-4000-8000-000000000002'],
 [{aggregateCap:4,tenantCap:1,sourceCap:3},'tenant','other','20000000-0000-4000-8000-000000000001'],
 [{aggregateCap:4,tenantCap:3,sourceCap:1},'source','source','20000000-0000-4000-8000-000000000001']];
 for(const [policy,reason,source,tenant] of cases){const h=await runtime(policy);try{const first=owned(await h.send(h.ticket(),'reserve'));await h.send(first.handle,'start');if(reason==='aggregate'){const second=owned(await h.send(h.ticket(source,tenant),'reserve'));await h.send(second.handle,'start');}
 const before=await h.state(),denial=await h.send(h.ticket(source,tenant),'reserve');closedEqual(denial.reply.result,{tag:'denied',reason,retryAfterSeconds:null});const after=await h.state();assert.equal(after.state.aggregateLive,reason==='aggregate'?2:1);assert.equal(after.raw,before.raw);assert.ok(after.state.tenants.every((b:any)=>b.live<=h.policy.tenantCap));assert.ok(after.state.sources.every((b:any)=>b.live<=h.policy.sourceCap));}finally{await h.close();}}
});
test('DA04 atomic rates replay windows rollback and persisted high-water',async()=>{
 const h=await runtime({aggregateRate:2,tenantRate:2,sourceRate:2});try{const ticket=h.ticket();await h.send(ticket,'reserve');await h.send(ticket,'reserve');assert.equal((await h.state()).state.aggregateArrivals,1);await h.send(h.ticket(),'reserve');const denied=await h.send(h.ticket(),'reserve');closedEqual(denied.reply.result,{tag:'denied',reason:'rate-aggregate',retryAfterSeconds:10});
 await h.clock(h.initial-1);closedEqual((await h.send(h.ticket(),'reserve')).reply.result,{tag:'denied',reason:'clock',retryAfterSeconds:null});await h.clock(h.initial+10000);await h.send(h.ticket(),'reserve');const s=(await h.state()).state;assert.equal(s.aggregateArrivals,1);assert.equal(s.aggregateLive,3);await h.restart();assert.equal((await h.state()).state.aggregateLive,3);closedEqual((await h.send(h.ticket(),'reserve')).reply.result,{tag:'denied',reason:'clock',retryAfterSeconds:null});}finally{await h.close();}
});
test('DA05 finite key and permanent record exhaustion still permits owned terminal recovery',async()=>{
 const h=await runtime({recordCap:2,sourceKeyCap:2});try{const first=owned(await h.send(h.ticket(),'reserve')),second=owned(await h.send(h.ticket('other'),'reserve'));await h.send(first.handle,'start');await h.send(second.handle,'start');closedEqual((await h.send(h.ticket(),'reserve')).reply.result,{tag:'denied',reason:'records',retryAfterSeconds:null});await h.clock(0);assert.equal(owned(await h.send(first.handle,'settle',{kind:'known-not-issued',barrierId:crypto.randomUUID()})).state,'RELEASED');await h.send(first.handle,'settle',{kind:'known-not-issued',barrierId:crypto.randomUUID()});assert.equal((await h.state()).state.aggregateLive,1);assert.equal((await h.state()).state.registry.length,2);}finally{await h.close();}
 const keys=await runtime({sourceKeyCap:1});try{await keys.send(keys.ticket(),'reserve');closedEqual((await keys.send(keys.ticket('second'),'reserve')).reply.result,{tag:'denied',reason:'keys',retryAfterSeconds:null});assert.equal((await keys.state()).state.sources.length,1);}finally{await keys.close();}
});
test('DA07 reserved expiry forbids late start and started diagnostics never free capacity',async()=>{
 const h=await runtime({aggregateCap:1,reservationTtlMs:10,diagnosticTtlMs:1});try{const r=owned(await h.send(h.ticket(),'reserve'));await h.clock(h.initial+10);assert.equal(owned(await h.send(r.handle,'start')).state,'EXPIRED');assert.equal((await h.state()).state.aggregateLive,0);const next=owned(await h.send(h.ticket(),'reserve'));await h.send(next.handle,'start');await h.clock(h.initial+1000);assert.equal(owned(await h.send(next.handle,'inspect')).state,'QUARANTINED');assert.equal((await h.state()).state.aggregateLive,1);await h.restart();assert.equal(owned(await h.send(next.handle,'inspect')).state,'QUARANTINED');assert.equal((await h.state()).state.aggregateLive,1);}finally{await h.close();}
});
test('DA10 every ownership authority fence and immutable ticket mismatch denies without disclosure',async()=>{
 const h=await runtime();try{const handle=owned(await h.send(h.ticket(),'reserve')).handle;await h.send(handle,'start');const mutations=[{owner:'0'.repeat(32)},{fence:'999'},{requestDeadline:handle.requestDeadline+1},{reservationTtlMs:1},{diagnosticTtlMs:1}];
 const fields={tenant:'20000000-0000-4000-8000-000000000002',provider:'other',principal:'other',source:'other',mappingId:'30000000-0000-4000-8000-000000000002',mappingVersion:2,sourceBinding:'other'};
 for(const [key,value] of Object.entries(fields)){const authority={...handle.context.authority,[key]:value},ticket=createTicket(h.policy,authority,handle.requestDeadline);mutations.push({context:ticket.context} as any);}
 for(const mutation of mutations){const before=(await h.state()).raw;const result=await h.send({...handle,...mutation},'settle',{kind:'known-not-issued',barrierId:crypto.randomUUID()});assert.equal(result.status,409);assert.equal(result.reply.result.tag,'denied');assert.equal('record' in result.reply.result,false);assert.equal((await h.state()).raw,before);}
 await h.send(handle,'settle',{kind:'known-not-issued',barrierId:crypto.randomUUID()});assert.equal(owned(await h.send(handle,'start')).state,'RELEASED');assert.equal((await h.state()).state.aggregateLive,0);}finally{await h.close();}
});
test('DA11 closed codec rejects descriptors malformed bytes headers routes and full unions',async()=>{
 const h=await runtime();try{const ticket=h.ticket(),message={version:1 as const,operation:'reserve' as const,ticket,payload:{}},raw=encodeMessage(message);let getters=0;
 for(const malicious of [{...message,extra:true},Object.assign(Object.create({}),message),{...message,[Symbol('hidden')]:1},Object.defineProperty({...message},'hidden',{value:true}),{...message,ticket:{...ticket,requestDeadline:-0}},{...message,ticket:{...ticket,fence:'01'}},{...message,ticket:{...ticket,attempt:ticket.attempt.toUpperCase()}},Object.defineProperty({...message},'ticket',{get(){getters++;return ticket;},enumerable:true}),{...message,payload:[]},{...message,ticket:{...ticket,requestDeadline:NaN}},{...message,ticket:{...ticket,requestDeadline:Infinity}},{...message,ticket:{...ticket,requestDeadline:1.2}}])assert.throws(()=>encodeMessage(malicious as any));assert.equal(getters,0);
 const badBodies=[raw+' ',raw.replace('"version":1','"version":1,"version":1'),raw.replace('"version":1','"version":1.0'),'[]','{"version":1}',raw.slice(0,-1),'x'.repeat(8193)];
 for(const content of badBodies){const response=await h.fetch('/v1/reserve',{method:'POST',headers:{'content-type':'application/json'},body:content});assert.equal(response.status,400);assert.deepEqual(JSON.parse(await response.text()),{version:1,result:{tag:'fault',code:'invalid-message'}});}
 for(const [path,method,headers] of [['/v1/start','POST',{'content-type':'application/json'}],['/v1/reserve','GET',{'content-type':'application/json'}],['/v1/reserve?x=1','POST',{'content-type':'application/json'}],['/v1/reserve','POST',{'content-type':'application/json, application/json'}],['/v1/reserve','POST',{'content-type':'application/json','content-encoding':'gzip'}]] as const){const response=await h.fetch(path,{method,headers,body:method==='GET'?undefined:raw});assert.equal(response.status,400);assert.deepEqual(JSON.parse(await response.text()),{version:1,result:{tag:'fault',code:'invalid-message'}});}
 assert.equal((await h.state()).state.registry.length,0);
 }finally{await h.close();}
});
test('DA11 failed rejection response captures original cause and unchanged same-runtime state',async()=>{
 let injected=false;const cause=Object.assign(Error('Synthetic local response loss'),{code:'DA11_TEST_RESPONSE_LOSS'});
 const h=await runtime({},async(response,path)=>{if(path==='/v1/reserve?x=1'&&!injected){injected=true;await response.text();throw new TypeError('fetch failed',{cause});}return response;});
 try{const before=(await h.state()).raw,raw=encodeMessage({version:1,operation:'reserve',ticket:h.ticket(),payload:{}});
 await assert.rejects(h.fetch('/v1/reserve?x=1',{method:'POST',headers:{'content-type':'application/json'},body:raw}),(error:any)=>error instanceof TypeError&&error.cause===cause);
 const evidence=h.failureEvidence();assert.equal(evidence.length,1);assert.equal(evidence[0].path,'/v1/reserve?x=1');assert.equal(evidence[0].body,raw);assert.equal(evidence[0].cause.code,'DA11_TEST_RESPONSE_LOSS');assert.equal(evidence[0].coordinatorState,before);assert.equal((await h.state()).raw,before);
 assert.equal(owned(await h.send(h.ticket(),'reserve')).state,'RESERVED');assert.equal((await h.state()).state.aggregateLive,1);
 }finally{await h.close();}
});
test('DA11 post-commit response loss captures charged owner without treating failure as rollback',async()=>{
 let injected=false;const cause=Object.assign(Error('Synthetic local response loss'),{code:'DA11_TEST_RESPONSE_LOSS'});
 const h=await runtime({aggregateCap:1},async(response,path)=>{if(path==='/v1/reserve'&&!injected){injected=true;await response.text();throw new TypeError('fetch failed',{cause});}return response;});
 try{const ticket=h.ticket(),raw=encodeMessage({version:1,operation:'reserve',ticket,payload:{}});
 await assert.rejects(h.fetch('/v1/reserve',{method:'POST',headers:{'content-type':'application/json'},body:raw}),(error:any)=>error instanceof TypeError&&error.cause===cause);
 const evidence=h.failureEvidence();assert.equal(evidence.length,1);const state=JSON.parse(evidence[0].coordinatorState!);assert.equal(state.aggregateLive,1);assert.equal(state.aggregateArrivals,1);assert.equal(state.registry[0].handle.attempt,ticket.attempt);assert.equal(state.registry[0].state,'RESERVED');assert.equal(state.nextFence,'2');
 assert.equal((await h.send(h.ticket(),'reserve')).status,409);const ownedReply=owned(await h.send(ticket,'inspect'));assert.equal(ownedReply.handle.fence,'1');assert.equal((await h.state()).state.aggregateLive,1);
 }finally{await h.close();}
});
test('DA11 corrupt startup bytes counters identities policy and registry never reset',async()=>{
 const h=await runtime();try{const handle=owned(await h.send(h.ticket(),'reserve')).handle,original=(await h.state()).state;
 const variants=[()=>'{',()=>canonicalFixture({...original,version:2}),()=>canonicalFixture({...original,aggregateLive:0}),()=>canonicalFixture({...original,nextFence:'1'}),()=>canonicalFixture({...original,registry:[...original.registry,...original.registry]}),()=>canonicalFixture({...original,policyDigest:'0'.repeat(64)}),()=>canonicalFixture({...original,tenants:[]}),()=>canonicalFixture({...original,sources:[{...original.sources[0],live:0}]}),()=>canonicalFixture({...original,extra:1})];
 for(const corrupt of variants){const raw=corrupt();await h.fetch('/test-only-corrupt',{method:'POST',body:raw});const response=await h.send(handle,'inspect');closedEqual(response.reply.result,{tag:'fault',code:'storage-corrupt'});assert.equal(await consumedStatus(await h.fetch('/test-only-state')),200);assert.equal(await (await h.fetch('/test-only-state')).text(),raw);await h.restart();closedEqual((await h.send(handle,'inspect')).reply.result,{tag:'fault',code:'storage-corrupt'});}
 }finally{await h.close();}
});

test('DA06 DA10 lost reserve start and settle acknowledgements retain exact original ownership',async()=>{
 const {captureAdmission}=await import('../../src/distributed-admission.js'),{Deadline}=await import('../../src/ingress-operations.js');
 for(const lost of ['reserve','start','settle']){const h=await runtime(),db={};let thrown=false,settleCalls=0;const deadline=new Deadline(30000,()=>h.initial);
 try{const facade=captureAdmission(facadeFor(h,db,async(response,operation)=>{if(operation==='settle')settleCalls++;if(operation===lost&&!thrown){thrown=true;throw Error('Synthetic response lost after actual coordinator commit');}return response;})),execution=facade.execution(h.ticket().context.authority,deadline);
 if(lost==='settle')await execution.start();else await assert.rejects(execution.start());await execution.complete();const s=(await h.state()).state;assert.equal(s.aggregateLive,0);assert.equal(s.registry.length,1);assert.ok(['CANCELLED','RELEASED'].includes(s.registry[0].state));assert.equal('settle' in execution,false);
 if(lost==='settle'){assert.equal(s.registry[0].state,'RELEASED');const handle=s.registry[0].handle;await h.send(handle,'settle',{kind:'known-not-issued',barrierId:crypto.randomUUID()});assert.equal((await h.state()).state.aggregateLive,0);assert.equal(settleCalls,1);}
 }finally{deadline.close();await h.close();}}
});
test('DA11 client fully validates malformed capability replies and never retries unfamiliar exceptions',async()=>{
 const {captureAdmission}=await import('../../src/distributed-admission.js'),{Deadline}=await import('../../src/ingress-operations.js');
 const transforms=[(r:any)=>({...r,extra:1}),(r:any)=>({...r,result:{...r.result,extra:1}}),(r:any)=>({...r,operation:'inspect'}),(r:any)=>({...r,ticket:{...r.ticket,owner:'0'.repeat(32)}}),(r:any)=>({...r,result:{tag:'absent'}}),(r:any)=>({...r,result:{tag:'record',record:{...r.result.record,state:'RELEASED'}}}),(r:any)=>({...r,result:{tag:'denied',reason:'rate-aggregate',retryAfterSeconds:null}}),(r:any)=>({...r,ticket:{...r.ticket,context:{...r.ticket.context,extra:1}}})];
 const h=await runtime();try{for(const mutate of transforms){let reserves=0;const deadline=new Deadline(30000,()=>h.initial);try{const facade=captureAdmission(facadeFor(h,{},async(response,operation)=>{if(operation!=='reserve')return response;reserves++;const reply=JSON.parse(await response.text());return new Response(canonicalFixture(mutate(reply)),{status:200,headers:{'content-type':'application/json'}});})),execution=facade.execution(h.ticket().context.authority,deadline);await assert.rejects(execution.start(),(error:any)=>error.status===500);await execution.complete();assert.equal(reserves,1);assert.equal((await h.state()).state.aggregateLive,0);}finally{deadline.close();}}
 }finally{await h.close();}
});
test('DA12 late original start acknowledgement cannot launch and retains local permits until control settles',()=>workerCase(`
 const originalNamespace=this.env.ADMISSION,namespace={idFromName:originalNamespace.idFromName.bind(originalNamespace),get(id){const target=originalNamespace.get(id);return {fetch:async request=>{const response=await target.fetch(request);if(new URL(request.url).pathname.endsWith('/start'))await new Promise(r=>setTimeout(r,300));return response;}};}};
 const admission=new LocalAdmission(1,1,2),retained=[];
 const response=await new Ingress(deps,{...options,deadlineMs:100,admission,distributed:{...options.distributed,namespace}}).handle(request(),{waitUntil:p=>retained.push(p)});
 check(response.status===504,'caller deadline');check(admission.snapshot().active===1,'local retained pending original control');check((await state()).aggregateLive===1,'durable started remains charged');check((await db.prepare('SELECT count(*) n FROM replay_ledger').first()).n===0,'no late claim');await Promise.all(retained);check(admission.snapshot().active===0&&(await state()).aggregateLive===0,'known not issued release after actual control');
 `));
test('DA12 registration failure cancels progression before distributed claim and retains actual work',()=>workerCase(`
 const retained=[];const response=await new Ingress(deps,options).handle(request(),{waitUntil:p=>{retained.push(p);throw Error('registration');}});check(response.status===500,'safe registration failure');await Promise.all(retained);check((await state()).registry.length===0,'no late coordinator');check((await db.prepare('SELECT count(*) n FROM replay_ledger').first()).n===0,'no claim');
 `));
test('DA14 wrong coordinator environment and policy deny without resetting original owner',async()=>{
 const h=await runtime();try{const existing=owned(await h.send(h.ticket(),'reserve')),foreign=createTicket({...h.policy,environment:'staging'},{...existing.handle.context.authority,environment:'staging'},h.initial+30000);const s=(await h.state()).raw;closedEqual((await h.send(foreign,'reserve')).reply.result,{tag:'denied',reason:'policy',retryAfterSeconds:null});assert.equal((await h.state()).raw,s);const epoch=createTicket({...h.policy,epoch:'10000000-0000-4000-8000-000000000002'},existing.handle.context.authority,h.initial+30000);closedEqual((await h.send(epoch,'reserve')).reply.result,{tag:'denied',reason:'policy',retryAfterSeconds:null});assert.equal((await h.state()).raw,s);}finally{await h.close();}
});

test('DA11 distributed identity snapshots reject accessor symbol and hidden fields without invoking getters',()=>workerCase(`
 let getters=0;const malicious=Object.defineProperty({...mapping},'tenant_id',{enumerable:true,get(){getters++;return tenant.id;}});
 const bad={...deps,mappings:{authorityBinding:()=>db,resolve:async()=>[malicious]}};
 const retained=[];const response=await new Ingress(bad,options).handle(request(),{waitUntil:p=>retained.push(p)});await Promise.all(retained);
 check(response.status===500,'malformed trusted mapping must fail closed');check(getters===0,'descriptor snapshot must not invoke mapping getter');check((await state()).registry.length===0,'zero mutation');
 `));

test('DA06 classified unavailable control retries exact original ticket within fixed budget',async()=>{
 const {captureAdmission}=await import('../../src/distributed-admission.js'),{Deadline}=await import('../../src/ingress-operations.js');const h=await runtime({controlAttempts:2});let attempts=0;const deadline=new Deadline(30000,()=>h.initial);
 try{const execution=captureAdmission(facadeFor(h,{},async(response,operation)=>{if(operation==='reserve'&&++attempts===1){const reply=JSON.parse(await response.text());reply.result={tag:'fault',code:'unavailable'};return new Response(canonicalFixture(reply),{status:503,headers:{'content-type':'application/json'}});}return response;})).execution(h.ticket().context.authority,deadline);
 await execution.start();assert.equal(attempts,2);assert.equal((await h.state()).state.aggregateLive,1);assert.equal((await h.state()).state.aggregateArrivals,1);await execution.complete();assert.equal((await h.state()).state.aggregateLive,0);
 }finally{deadline.close();await h.close();}
});

test('DA14 configured distributed HTTP preserves strict original three-field binding descriptors',()=>workerCase(`
 const bindings={APACELY_ENVIRONMENT:'development',APACELY_OPERATION:'ingest_mock_lead',DB:db};let getters=0;
 for(const malicious of [{...bindings,[Symbol('extra')]:1},Object.defineProperty({...bindings},'hidden',{value:true}),Object.defineProperty({...bindings},'DB',{enumerable:true,get(){getters++;return db;}})]){
 const response=await handleConfiguredWorkerRequest(request(),malicious,deps,{waitUntil:()=>{}},options);check(response.status===500,'strict distributed bindings');}
 check(getters===0,'binding getter not invoked');check((await state()).registry.length===0,'no admission');
 `));

test('DA16 separate maintenance accepts only original private terminal barrier and rejects positive caller claims',async()=>{
 const module=await import('../../src/distributed-admission.js');assert.equal(typeof (module as Record<string,unknown>).captureMaintenance,'function','Private maintenance binder missing');const {Deadline}=await import('../../src/ingress-operations.js');const h=await runtime();const deadline=new Deadline(30000,()=>h.initial),db={};
 try{const config=facadeFor(h,db),originalGet=config.namespace.get;
 config.namespace.get=()=>{const target=originalGet();return {fetch:async request=>{if(new URL(request.url).pathname.endsWith('/settle')){const message=decodeMessage(await request.text(),'request');return new Response(encodeMessage({...message,result:{tag:'fault',code:'unavailable'}} as any),{status:503,headers:{'content-type':'application/json'}});}return target.fetch(request);}};};
 const execution=module.captureAdmission(config).execution(h.ticket().context.authority,deadline);await execution.start();const unit=execution.observer.issued(db);unit.resolved();await execution.complete();assert.equal((await h.state()).state.aggregateLive,1);
 const maintenance=module.captureMaintenance(config);assert.equal(await maintenance.reconcile({kind:'all-issued-terminal',barrierId:crypto.randomUUID()}),false);assert.equal((await h.state()).state.aggregateLive,1);
 assert.equal(await maintenance.reconcile(execution),true);assert.equal((await h.state()).state.aggregateLive,0);assert.equal(await maintenance.reconcile(execution),true);assert.equal((await h.state()).state.aggregateLive,0);
 const uncertain=module.captureAdmission(config).execution(h.ticket().context.authority,deadline);await uncertain.start();uncertain.observer.issued(db).rejected();await uncertain.complete();assert.equal(await maintenance.reconcile(uncertain),false);assert.equal((await h.state()).state.aggregateLive,1);assert.equal((await h.state()).state.registry.filter((r:any)=>r.state==='QUARANTINED').length,1);
 }finally{deadline.close();await h.close();}
});

test('DA02 concurrent different-tenant original D1 pipelines share one aggregate authority',()=>workerCase(`
 const other=await repo.createTenant('Synthetic other');const otherMapping=await store.create({principal:'actor',provider:'synthetic',source:'other',tenant_id:other.id,source_binding:'mock-source-other',environment:'development',operation:'ingest_mock_lead'});
 const retained=[];let issued=0;const originalBatch=db.batch.bind(db),faultDb={prepare:db.prepare.bind(db),batch:async statements=>{issued++;const result=await originalBatch(statements);await new Promise(r=>setTimeout(r,400));return result;}};
 const observing={...deps,repo:new D1Repository(faultDb,now),replay:new D1ReplayLedger(faultDb,now),mappings:new D1SourceMappingStore(faultDb,now),verifier:{verify:async x=>({...await deps.verifier.verify(x),source:x.headers.get('test-source')??'source',nonce:x.headers.get('test-nonce')??'nonce'})}};
 const ingress=new Ingress(observing,{...options,distributed:{...options.distributed,database:faultDb}}),second=request();second.headers.set('test-source','other');second.headers.set('test-nonce','other');
 const one=ingress.handle(request(),{waitUntil:p=>retained.push(p)}),two=ingress.handle(second,{waitUntil:p=>retained.push(p)});
 while(issued<2)await new Promise(r=>setTimeout(r,5));const s=await state();check(s.aggregateLive===2&&s.tenants.length===2,'both counted globally with distinct tenants');
 const denied=await ingress.handle(request(),{waitUntil:p=>retained.push(p)});check(denied.status===503,'third aggregate denied');check((await db.prepare('SELECT count(*) n FROM replay_ledger').first()).n===2,'denied issued no nonce');check((await state()).aggregateLive===2,'denied no release of others');
 check((await one).status===200&&(await two).status===200,'original pipelines complete');await Promise.all(retained);check((await state()).aggregateLive===0,'both original barriers settle');check((await db.prepare('SELECT count(*) n FROM events').first()).n===2,'one event per tenant');check((await db.prepare('SELECT count(*) n FROM action_outbox').first()).n===2,'one outbox per tenant');
 `));
test('DA13 private maintenance rejects prototype-forged execution brands',async()=>{
 const module=await import('../../src/distributed-admission.js'),{Deadline}=await import('../../src/ingress-operations.js'),h=await runtime(),deadline=new Deadline(30000,()=>h.initial);try{const config=facadeFor(h,{}),e=module.captureAdmission(config).execution(h.ticket().context.authority,deadline);assert.equal(await module.captureMaintenance(config).reconcile(Object.create(Object.getPrototypeOf(e))),false);assert.equal((await h.state()).state.aggregateLive,0);}finally{deadline.close();await h.close();}
});

test('DA04 stable verified principal source budget survives signing-key rotation and mapping versions',async()=>{
 const h=await httpAdmission({aggregateRate:1,tenantRate:1,sourceRate:1});try{assert.equal(await consumedStatus(await h.fetch('/v1/ingress/synthetic',await h.signed())),200);const second=await h.fetch('/v1/ingress/synthetic',await h.signed('rotated','fixture-rotated'));assert.equal(await consumedStatus(second),429);assert.ok(Number(second.headers.get('retry-after'))>=1);const s=await h.state();assert.equal(s.aggregateArrivals,1);assert.equal(s.sources.length,1);assert.equal(s.sources[0].arrivals,1);assert.equal(s.registry.length,1);assert.equal((await h.db.prepare('SELECT count(*) n FROM replay_ledger').all()).results[0].n,1);
 const authority=s.registry[0].handle.context.authority;const one=createTicket(fixturePolicy,authority,Date.now()+30000),two=createTicket(fixturePolicy,{...authority,mappingVersion:authority.mappingVersion+1},one.requestDeadline);assert.equal(one.context.sourceKey,two.context.sourceKey);
 }finally{await h.close();}
});

test('DA11 impossible reserved timestamps and future durable owner observations fail closed',async()=>{
 const h=await runtime();try{const ticket=h.ticket(),record=owned(await h.send(ticket,'reserve'));assert.throws(()=>encodeMessage({version:1,operation:'reserve',ticket,result:{tag:'record',record:{...record,reservedAt:ticket.requestDeadline+1,reservationExpiresAt:ticket.requestDeadline}}}));
 const state=(await h.state()).state;state.clockHighWater=h.initial-1;state.windowStartedAt=h.initial-1;await h.fetch('/test-only-corrupt',{method:'POST',body:canonicalFixture(state)});closedEqual((await h.send(record.handle,'inspect')).reply.result,{tag:'fault',code:'storage-corrupt'});
 }finally{await h.close();}
});

test('DA15 distributed admission never replaces full-authority final D1 atomic rollback guards',()=>workerCase(`
 let batches=0;const faultDb={prepare:db.prepare.bind(db),batch:async statements=>{if(++batches===3)await store.revoke({environment:'development',tenant_id:tenant.id},mapping.id,mapping.version);return db.batch(statements);}};
 const observing={...deps,repo:new D1Repository(faultDb,now),replay:new D1ReplayLedger(faultDb,now),mappings:new D1SourceMappingStore(faultDb,now)};const retained=[];
 const response=await new Ingress(observing,{...options,distributed:{...options.distributed,database:faultDb}}).handle(request(),{waitUntil:p=>retained.push(p)});check(response.status===403,'authority revoked before atomic write');await Promise.all(retained);
 check((await db.prepare('SELECT count(*) n FROM replay_ledger').first()).n===1,'nonce tombstone retained');check((await db.prepare('SELECT count(*) n FROM events').first()).n===0&&(await db.prepare('SELECT count(*) n FROM action_outbox').first()).n===0,'complete business rollback');check((await state()).aggregateLive===1&&(await state()).registry[0].state==='QUARANTINED','all D1 rejections conservatively sticky');
 `));
test('DA15 replay cutoff after admission remains immutable under captured original observer',()=>workerCase(`
 let offset=0;const clock=()=>new Date(Date.now()+offset).toISOString(),originalRepo=new D1Repository(db,clock),observing={...deps,now:clock,repo:{operationObserverBinding:()=>db,authorityBinding:()=>db,replayBinding:()=>db,id:originalRepo.id.bind(originalRepo),now:originalRepo.now.bind(originalRepo),assertScope:originalRepo.assertScope.bind(originalRepo),accept(...args){offset=300001;return originalRepo.accept(...args);}}};const retained=[];
 const response=await new Ingress(observing,options).handle(request(),{waitUntil:p=>retained.push(p)});check(response.status===401,'immutable replay admission expired');await Promise.all(retained);check((await db.prepare('SELECT count(*) n FROM replay_ledger').first()).n===1,'claim retained');check((await db.prepare('SELECT count(*) n FROM events').first()).n===0&&(await db.prepare('SELECT count(*) n FROM action_outbox').first()).n===0,'no expired business writes');check((await state()).aggregateLive===0,'resolved snapshot and claim are known terminal');
 `));
test('DA15 concurrent admitted semantic duplicates keep one event and one outbox',()=>workerCase(`
 const verify=deps.verifier.verify,fixed=now();deps.verifier={verify:async x=>({...await verify(x),signed_at:fixed})};
 const retained=[],ingress=new Ingress(deps,options),responses=await Promise.all([ingress.handle(request(),{waitUntil:p=>retained.push(p)}),ingress.handle(request(),{waitUntil:p=>retained.push(p)})]);check(responses.every(r=>r.status===200),'duplicate success');const a=await responses[0].json(),b=await responses[1].json();check(a.event_id===b.event_id,'immutable event replay');await Promise.all(retained);check((await db.prepare('SELECT count(*) n FROM events').first()).n===1&&(await db.prepare('SELECT count(*) n FROM action_outbox').first()).n===1,'one atomic outcome');const s=await state();check(s.registry.length===2&&s.aggregateLive<=2,'two independent execution owners, no adoption');
 `));

test('DA11 inherited and symbol distributed operational controls cannot select a permissive local mode',()=>workerCase(`
 for(const malformed of [Object.create({admissionMode:'distributed'}),{...options,[Symbol('extra')]:1},Object.defineProperty({...options},'hidden',{value:true})]){let failed=false;try{new Ingress(deps,malformed);}catch{failed=true;}check(failed,'closed operational descriptor snapshot');}
 check((await state()).registry.length===0,'no admission');
 `));

test('DA12 private completion seals progression while original reserve is still pending',async()=>{
 const module=await import('../../src/distributed-admission.js'),{Deadline}=await import('../../src/ingress-operations.js'),h=await runtime(),deadline=new Deadline(30000,()=>h.initial);let starts=0;
 try{const execution=module.captureAdmission(facadeFor(h,{},async(response,operation)=>{if(operation==='reserve')await new Promise(r=>setTimeout(r,100));if(operation==='start')starts++;return response;})).execution(h.ticket().context.authority,deadline);const start=execution.start();void start.catch(()=>undefined);await execution.complete();await Promise.allSettled([start]);assert.equal(starts,0,'Closed original owner cannot launch a later start continuation');assert.equal((await h.state()).state.aggregateLive,0);}finally{deadline.close();await h.close();}
});

test('DA02 isolated tenant and source HTTP pipeline bounds deny before original D1 nonce issuance',async()=>{
 for(const reason of ['tenant','source'])await workerCase(`
 await store.create({principal:'actor',provider:'synthetic',source:'other',tenant_id:tenant.id,source_binding:'mock-source-other',environment:'development',operation:'ingest_mock_lead'});
 let issued=0;const faultDb={prepare:db.prepare.bind(db),batch:async statements=>{issued++;const result=await db.batch(statements);await new Promise(r=>setTimeout(r,300));return result;}};
 const observing={...deps,repo:new D1Repository(faultDb,now),replay:new D1ReplayLedger(faultDb,now),mappings:new D1SourceMappingStore(faultDb,now),verifier:{verify:async x=>({...await deps.verifier.verify(x),source:x.headers.get('test-source')??'source'})}},retained=[];
 const ingress=new Ingress(observing,{...options,distributed:{...options.distributed,database:faultDb}}),first=ingress.handle(request(),{waitUntil:p=>retained.push(p)});while(issued===0)await new Promise(r=>setTimeout(r,5));
 const second=request();${reason==='tenant'?"second.headers.set('test-source','other');":''}second.headers.set('x-rate-tier','unlimited');second.headers.set('x-tenant','foreign');const denied=await ingress.handle(second,{waitUntil:p=>retained.push(p)});check(denied.status===503&&(await denied.json()).code==='overloaded','subordinate overload envelope');check(issued===1,'denial before nonce');const s=await state();check(s.aggregateLive===1&&s.registry.length===1,'no foreign or fresh denial charge');check((await first).status===200,'original complete');await Promise.all(retained);check((await state()).aggregateLive===0,'original release');check((await db.prepare('SELECT count(*) n FROM events').first()).n===1&&(await db.prepare('SELECT count(*) n FROM action_outbox').first()).n===1,'one outcome');
 `,{aggregateCap:4,tenantCap:reason==='tenant'?1:3,sourceCap:reason==='source'?1:3});
});
test('DA12 late reserve retains original deadline and cannot progress to nonce issuance',()=>workerCase(`
 const originalNamespace=this.env.ADMISSION,namespace={idFromName:originalNamespace.idFromName.bind(originalNamespace),get(id){const target=originalNamespace.get(id);return {fetch:async request=>{const response=await target.fetch(request);if(new URL(request.url).pathname.endsWith('/reserve'))await new Promise(r=>setTimeout(r,250));return response;}};}},admission=new LocalAdmission(1,1,2),retained=[];
 const response=await new Ingress(deps,{...options,deadlineMs:100,admission,distributed:{...options.distributed,namespace}}).handle(request(),{waitUntil:p=>retained.push(p)});check(response.status===504,'bounded original deadline');check(admission.snapshot().active===1&&(await state()).aggregateLive===1,'retain pending reservation');await Promise.all(retained);check((await db.prepare('SELECT count(*) n FROM replay_ledger').first()).n===0,'no late nonce');check(admission.snapshot().active===0&&(await state()).aggregateLive===0,'original known-not-issued release');
 `));
test('DA11 complete nested union descriptor and canonical reply transport fault matrix',async()=>{
 const {captureAdmission}=await import('../../src/distributed-admission.js'),{Deadline}=await import('../../src/ingress-operations.js');const h=await runtime();try{
 const ticket=h.ticket(),message={version:1 as const,operation:'reserve' as const,ticket,payload:{}};
 for(const path of [[],['ticket'],['ticket','context'],['ticket','context','authority']]){let object:any=message;for(const key of path)object=object[key];for(const key of Object.keys(object)){const bad=JSON.parse(JSON.stringify(message));let target=bad;for(const p of path)target=target[p];delete target[key];assert.throws(()=>encodeMessage(bad));}const bad=JSON.parse(JSON.stringify(message));let target=bad;for(const p of path)target=target[p];target.unrecognized=true;assert.throws(()=>encodeMessage(bad));}
 const mutations=[(r:any)=>new Response(canonicalFixture(r),{status:302,headers:{'content-type':'application/json'}}),(r:any)=>new Response(canonicalFixture(r),{status:200,headers:{'content-type':'application/json, application/json'}}),(r:any)=>new Response(canonicalFixture(r),{status:200,headers:{'content-type':'application/json','content-length':'1'}}),()=>new Response(Uint8Array.of(255),{status:200,headers:{'content-type':'application/json'}}),()=>new Response('x'.repeat(8193),{status:200,headers:{'content-type':'application/json'}}),(r:any)=>new Response(canonicalFixture(r)+' ',{status:200,headers:{'content-type':'application/json'}}),(r:any)=>new Response(canonicalFixture(r).slice(0,-1),{status:200,headers:{'content-type':'application/json'}}),(r:any)=>new Response(canonicalFixture({...r,result:{tag:'record',record:{...r.result.record,handle:{...r.result.record.handle,fence:'0'}}}}),{status:200,headers:{'content-type':'application/json'}})];
 for(const mutate of mutations){const deadline=new Deadline(30000,()=>h.initial);let reserves=0;try{const execution=captureAdmission(facadeFor(h,{},async(response,operation)=>{if(operation!=='reserve')return response;reserves++;return mutate(JSON.parse(await response.text()));})).execution(h.ticket().context.authority,deadline);await assert.rejects(execution.start(),(e:any)=>e.status===500);await execution.complete();assert.equal(reserves,1);assert.equal((await h.state()).state.aggregateLive,0);}finally{deadline.close();}}
 }finally{await h.close();}
});
test('DA11 fence exhaustion never wraps and existing authenticated settlement survives saturation',async()=>{
 const h=await runtime();try{const handle=owned(await h.send(h.ticket(),'reserve')).handle;await h.send(handle,'start');const state=(await h.state()).state;state.nextFence='18446744073709551615';await h.fetch('/test-only-corrupt',{method:'POST',body:canonicalFixture(state)});closedEqual((await h.send(h.ticket(),'reserve')).reply.result,{tag:'denied',reason:'fence-exhausted',retryAfterSeconds:null});await h.clock(0);assert.equal(owned(await h.send(handle,'settle',{kind:'known-not-issued',barrierId:crypto.randomUUID()})).state,'RELEASED');assert.equal((await h.state()).state.nextFence,'18446744073709551615');assert.equal((await h.state()).state.aggregateLive,0);}finally{await h.close();}
});

test('DA05 exact finite R32 saturation preserves all terminal owners and owned settlement headroom',async()=>{
 const h=await runtime({recordCap:32});try{const handles=[];for(let i=0;i<32;i++)handles.push(owned(await h.send(h.ticket(),'reserve')).handle);closedEqual((await h.send(h.ticket(),'reserve')).reply.result,{tag:'denied',reason:'records',retryAfterSeconds:null});for(const handle of handles){await h.send(handle,'start');await h.send(handle,'settle',{kind:'known-not-issued',barrierId:crypto.randomUUID()});}assert.equal((await h.state()).state.registry.length,32);assert.equal((await h.state()).state.aggregateLive,0);assert.ok((await h.state()).raw.length<=65536);await h.restart();assert.equal((await h.state()).state.registry.length,32);assert.equal(owned(await h.send(handles[0],'inspect')).state,'RELEASED');}finally{await h.close();}
});
test('DA09 actual committed acceptance response-loss exhaustion quarantines every original issued unit',()=>workerCase(`
 let batches=0;const faultDb={prepare:db.prepare.bind(db),batch:async statements=>{const result=await db.batch(statements);if(++batches>=3)throw Error('D1_ERROR: Network connection lost.');return result;}};
 const observing={...deps,repo:new D1Repository(faultDb,now),replay:new D1ReplayLedger(faultDb,now),mappings:new D1SourceMappingStore(faultDb,now)},retained=[];const response=await new Ingress(observing,{...options,distributed:{...options.distributed,database:faultDb}}).handle(request(),{waitUntil:p=>retained.push(p)});
 check(response.status===503,'unchanged finite acceptance retry exhaustion');await Promise.all(retained);check(batches===6,'claim, snapshot, write, three whole-unit retry snapshots');check((await db.prepare('SELECT count(*) n FROM events').first()).n===1&&(await db.prepare('SELECT count(*) n FROM action_outbox').first()).n===1,'actual complete commit, never rollback inference');const s=await state();check(s.aggregateLive===1&&s.registry[0].state==='QUARANTINED','sticky unknown even after resolved event read');await repo.rows({environment:'development',tenant_id:tenant.id},'events');check((await state()).aggregateLive===1,'event read is not original all-work proof');
 `));
test('DA03 inactive verified tenant cannot consume distributed source or tenant quota',()=>workerCase(`
 await db.prepare("UPDATE tenants SET lifecycle_status='inactive' WHERE id=?").bind(tenant.id).run();const retained=[];const response=await new Ingress(deps,options).handle(request(),{waitUntil:p=>retained.push(p)});check(response.status===403,'active tenant required');await Promise.all(retained);check((await state()).registry.length===0,'no distributed charge');check((await db.prepare('SELECT count(*) n FROM replay_ledger').first()).n===0,'no nonce');
 `));

test('DA12 actual distributed HMAC caller transport abort is distinct from incoming signal and all-work proof',async()=>{
 const h=await httpAdmission({},'held');try{const controller=new AbortController(),pending=h.fetch('/v1/ingress/synthetic',{...await h.signed(),signal:controller.signal}),outcome=pending.then(response=>({response,error:null}),error=>({response:null,error}));await eventually(async()=>(await (await h.fetch('/test/held')).json() as {held:boolean}).held);assert.equal((await h.state()).aggregateLive,1);controller.abort();const result=await outcome;assert.ok(result.error instanceof Error);assert.equal(result.error.name,'AbortError');await eventually(async()=>(await h.state()).aggregateLive===0);assert.deepEqual(await (await h.fetch('/test/signal')).json(),{aborts:0},'Pinned transport does not propagate an incoming Request.signal event');assert.equal((await h.db.prepare('SELECT count(*) n FROM events').all()).results[0].n,1);assert.equal((await h.db.prepare('SELECT count(*) n FROM action_outbox').all()).results[0].n,1);}finally{await h.close();}
});

test('DA12 actual distributed HMAC streamed-body timeout cannot reach verification or nonce',async()=>{
 const h=await httpAdmission({},'body-held');try{assert.equal(await consumedStatus(await h.fetch('/v1/ingress/synthetic',await h.signed())),504);await new Promise(r=>setTimeout(r,650));assert.equal((await h.state()).registry.length,0);assert.equal(await h.db.prepare('SELECT count(*) n FROM replay_ledger').first<number>('n'),0);assert.equal(await h.db.prepare('SELECT count(*) n FROM events').first<number>('n'),0);}finally{await h.close();}
});
test('DA12 actual distributed HMAC crypto timeout cannot resolve mapping or renew deadline',async()=>{
 const h=await httpAdmission({},'crypto-held');try{assert.equal(await consumedStatus(await h.fetch('/v1/ingress/synthetic',await h.signed())),504);assert.equal((await h.state()).registry.length,0);await new Promise(r=>setTimeout(r,650));assert.equal((await h.state()).registry.length,0);assert.equal(await h.db.prepare('SELECT count(*) n FROM replay_ledger').first<number>('n'),0);assert.equal(await h.db.prepare('SELECT count(*) n FROM events').first<number>('n'),0);}finally{await h.close();}
});
test('DA12 actual distributed HMAC pending original claim retains quota and never launches acceptance',async()=>{
 const h=await httpAdmission({},'claim-held');try{assert.equal(await consumedStatus(await h.fetch('/v1/ingress/synthetic',await h.signed())),504);assert.equal((await h.state()).aggregateLive,1);assert.equal(await h.db.prepare('SELECT count(*) n FROM replay_ledger').first<number>('n'),1);await eventually(async()=>(await h.state()).aggregateLive===0);assert.equal(await h.db.prepare('SELECT count(*) n FROM events').first<number>('n'),0);assert.equal(await h.db.prepare('SELECT count(*) n FROM action_outbox').first<number>('n'),0);}finally{await h.close();}
});

test('DA13 same SQLite directory and identity reboot retains active quarantine and permanent terminal owners',async()=>{
 const h=await runtime();try{const active=owned(await h.send(h.ticket(),'reserve')).handle;await h.send(active,'start');const terminal=owned(await h.send(h.ticket(),'reserve')).handle;await h.send(terminal,'settle',{kind:'known-not-issued',barrierId:crypto.randomUUID()});await h.restart();assert.equal(owned(await h.send(active,'inspect')).state,'ACTIVE');assert.equal(owned(await h.send(terminal,'inspect')).state,'RELEASED');assert.equal((await h.state()).state.aggregateLive,1);await h.send(active,'quarantine');await h.restart();assert.equal(owned(await h.send(active,'inspect')).state,'QUARANTINED');assert.equal((await h.state()).state.aggregateLive,1);assert.equal((await h.state()).state.registry.length,2);assert.equal(owned(await h.send(terminal,'start')).state,'RELEASED');assert.equal((await h.state()).state.aggregateLive,1);}finally{await h.close();}
});
test('DA14 correct development staging stores isolate identical synthetic authority and object domain',async()=>{
 const dev=await runtime({aggregateCap:1}),stage=await runtime({environment:'staging',aggregateCap:1});try{const first=owned(await dev.send(dev.ticket(),'reserve'));await dev.send(first.handle,'start');assert.equal((await stage.state()).state.registry.length,0);const second=owned(await stage.send(stage.ticket(),'reserve'));await stage.send(second.handle,'start');assert.equal(first.handle.context.authority.tenant,second.handle.context.authority.tenant);assert.equal(first.handle.context.authority.principal,second.handle.context.authority.principal);assert.equal((await dev.state()).state.aggregateLive,1);assert.equal((await stage.state()).state.aggregateLive,1);closedEqual((await stage.send(first.handle,'inspect')).reply.result,{tag:'denied',reason:'policy',retryAfterSeconds:null});assert.equal((await stage.state()).state.aggregateLive,1);await dev.send(first.handle,'settle',{kind:'known-not-issued',barrierId:crypto.randomUUID()});assert.equal((await dev.state()).state.aggregateLive,0);assert.equal((await stage.state()).state.aggregateLive,1);}finally{await dev.close();await stage.close();}
});
test('DA15 concurrent separately admitted conflicting event fingerprints never duplicate state or outbox',()=>workerCase(`
 const retained=[],verify=deps.verifier.verify;deps.verifier={verify:async x=>({...await verify(x),nonce:x.headers.get('test-nonce')})};const ingress=new Ingress(deps,options);
 const one=request();one.headers.set('test-nonce','first');const two=new Request(one,{body:JSON.stringify({...fixture,text:fixture.text+' conflicting'})});two.headers.set('test-nonce','second');const responses=await Promise.all([ingress.handle(one,{waitUntil:p=>retained.push(p)}),ingress.handle(two,{waitUntil:p=>retained.push(p)})]);await Promise.all(retained);check(responses.filter(r=>r.status===200).length===1&&responses.filter(r=>r.status===409).length===1,'one accepted one conflict');check((await db.prepare('SELECT count(*) n FROM events').first()).n===1&&(await db.prepare('SELECT count(*) n FROM action_outbox').first()).n===1,'one atomic event outbox');const final=await state();check(final.registry.length===2,'each admitted owner retained');check(final.aggregateLive===final.registry.filter(r=>r.state==='QUARANTINED').length&&final.aggregateLive<=1,'known conflict releases only if all batches resolved; rejected conflict write stays uncertain');
 `));

function owned(result:Awaited<ReturnType<Awaited<ReturnType<typeof runtime>>['send']>>):AdmissionRecord{assert.equal(result.status,200);assert.equal(result.reply.result.tag,'record');if(result.reply.result.tag!=='record')throw Error('No owned record');return result.reply.result.record;}
test('DA05 representation ceiling denies before allocation and keeps lifecycle settlement headroom',async()=>{
 const h=await runtime(),handles:AdmissionTicket[]=[];
 try{
 let reason='';for(let i=0;i<100;i++){const result=await h.send(h.ticket(),'reserve');if(result.reply.result.tag==='denied'){reason=result.reply.result.reason;break;}handles.push(owned(result).handle);}
 assert.equal(reason,'state-size','Admission must deny before exhausting lifecycle representation');
 const before=await h.state();assert.ok(before.raw.length<=65536);assert.equal(before.state.registry.length,handles.length);
 for(const handle of handles){assert.equal(owned(await h.send(handle,'start')).state,'ACTIVE');assert.equal(owned(await h.send(handle,'settle',{kind:'all-issued-terminal',barrierId:crypto.randomUUID()})).state,'RELEASED');}
 const after=await h.state();assert.ok(after.raw.length<=65536);assert.equal(after.state.aggregateLive,0);assert.equal(after.state.registry.length,handles.length);
 await h.restart();assert.equal(owned(await h.send(handles[0],'inspect')).state,'RELEASED');
 }finally{await h.close();}
});
test('DA06 DA07 DA10 wire-state foundations: absent seal and indefinitely charged quarantine (matrix incomplete)',async()=>{
 const h=await runtime({aggregateCap:1});try{
 const absent=h.ticket();const sealed=owned(await h.send(absent,'cancelUnstarted'));assert.equal(sealed.state,'CANCELLED');assert.equal(owned(await h.send(absent,'reserve')).state,'CANCELLED');
 const ticket=h.ticket(),reserved=owned(await h.send(ticket,'reserve'));assert.equal(owned(await h.send(reserved.handle,'start')).state,'ACTIVE');
 assert.equal(owned(await h.send(reserved.handle,'cancelUnstarted')).state,'ACTIVE');
 await h.clock(h.initial+60000);assert.equal(owned(await h.send(reserved.handle,'inspect')).state,'QUARANTINED');
 const blocked=await h.send(createTicket(h.policy,ticket.context.authority,h.initial+90000),'reserve');assert.equal(blocked.reply.result.tag,'denied');if(blocked.reply.result.tag==='denied')assert.equal(blocked.reply.result.reason,'aggregate');
 assert.equal((await h.state()).state.aggregateLive,1);
 const forged=await h.send({...reserved.handle,owner:'0'.repeat(32)},'settle',{kind:'all-issued-terminal',barrierId:crypto.randomUUID()});assert.equal(forged.status,409);assert.equal((await h.state()).state.aggregateLive,1);
 assert.equal(owned(await h.send(reserved.handle,'settle',{kind:'all-issued-terminal',barrierId:crypto.randomUUID()})).state,'RELEASED');assert.equal((await h.state()).state.aggregateLive,0);
 await h.restart();assert.equal((await h.send(reserved.handle,'start')).status,409,'Restart fixture clock rollback blocks START, including stale attempts');assert.equal(owned(await h.send(reserved.handle,'inspect')).state,'RELEASED');assert.equal((await h.state()).state.aggregateLive,0);
 }finally{await h.close();}
});

// Review regressions run through dispatchFetch and real wrapper/Ingress requests in workerd.
for(const configured of [false,true])test('DASEC01 actual HTTP descriptor-first operational options '+(configured?'configured':'reusable'),()=>workerCase(`
 let getters=0,verified=0;
 const dependencies={...deps,verifier:{verify:async x=>{verified++;return deps.verifier.verify(x);}}};
 const invoke=async controls=>${configured?"handleConfiguredWorkerRequest(request(),{APACELY_ENVIRONMENT:'development',APACELY_OPERATION:'ingest_mock_lead',DB:db},dependencies,{waitUntil(){}},controls)":"handleWorkerRequest(request(),dependencies,{waitUntil(){}},controls)"};
 const zero=async()=>{check((await state()).registry.length===0,'zero coordinator allocation');const rows=await db.prepare('SELECT (SELECT count(*) FROM events) events,(SELECT count(*) FROM action_outbox) actions,(SELECT count(*) FROM replay_ledger) nonces').first();check(rows.events===0&&rows.actions===0&&rows.nonces===0,'zero D1 acceptance/nonce effects');};
 const deny=async controls=>{const response=await invoke(controls);check(response.status===500,'safe rejection');const body=await response.json();check(body.code==='internal'&&Object.keys(body).length===2,'safe envelope');check(response.headers.get('cache-control')==='no-store'&&response.headers.get('x-content-type-options')==='nosniff','safe headers');await zero();check(getters===0,'SECURITY: operational getter executed '+getters+' times');check(verified===0,'no authentication work');};
 for(const key of ['globalLimit','sourceLimit','maxSources','admission','rates','deadlineMs','clock','admissionMode','distributed'])await deny(Object.defineProperty({...options},key,{enumerable:true,get(){getters++;return undefined;}}));
 for(const key of ['sourceLimit','admissionMode','distributed'])await deny(Object.defineProperty({...options},key,{get(){getters++;return undefined;}}));
 for(const key of ['policy','namespace','database'])await deny({...options,distributed:Object.defineProperty({...options.distributed},key,{enumerable:true,get(){getters++;return undefined;}})});
 for(const key of ['environment','sourceCap'])await deny({...options,distributed:{...options.distributed,policy:Object.defineProperty({...policy},key,{enumerable:true,get(){getters++;return undefined;}})}});
 await deny({...options,[Symbol('unknown')]:1});await deny(Object.defineProperty({...options},'unknown',{value:1}));await deny({...options,admissionMode:undefined});await deny({...options,distributed:undefined});
 await deny(Object.assign(Object.create({get admissionMode(){getters++;return 'distributed';}}),{distributed:options.distributed}));
 for(const trap of ['ownKeys','getOwnPropertyDescriptor','getPrototypeOf'])await deny(new Proxy(options,{[trap](){throw Error('untrusted trap');}}));
 // Legacy classes/unknown fields without explicit controls keep their approved semantics.
 class LegacyOptions {deadlineMs=10000;legacyExtra=true;}
 const legacy=await invoke(new LegacyOptions());check(legacy.status===200,'legacy class remains accepted');
 `,{},true));

for(const configured of [false,true])test('DASEC02 actual HTTP descriptor-first mapping collection '+(configured?'configured':'reusable'),()=>workerCase(`
 let getters=0;
 const retained=[],invoke=async collection=>{const dependencies={...deps,mappings:{authorityBinding:()=>db,resolve:async()=>collection}};return ${configured?"handleConfiguredWorkerRequest(request(),{APACELY_ENVIRONMENT:'development',APACELY_OPERATION:'ingest_mock_lead',DB:db},dependencies,{waitUntil:p=>retained.push(p)},options)":"handleWorkerRequest(request(),dependencies,{waitUntil:p=>retained.push(p)},options)"};};
 const deny=async collection=>{const response=await invoke(collection);await Promise.all(retained);check(response.status===500,'safe collection rejection');check((await response.json()).code==='internal','safe code');check((await state()).registry.length===0,'zero allocation');const rows=await db.prepare('SELECT (SELECT count(*) FROM events) events,(SELECT count(*) FROM action_outbox) actions,(SELECT count(*) FROM replay_ledger) nonces').first();check(rows.events===0&&rows.actions===0&&rows.nonces===0,'zero D1 effects');check(getters===0,'SECURITY: mapping length/index getter executed '+getters+' times');};
 await deny(Object.defineProperty({0:mapping},'length',{enumerable:true,get(){getters++;return 1;}}));
 await deny(Object.assign(Object.create({get length(){getters++;return 1;}}),{0:mapping}));
 await deny(Object.defineProperty([mapping],'0',{enumerable:true,get(){getters++;return mapping;}}));
 await deny(Object.defineProperty([mapping],'0',{value:mapping,enumerable:false}));await deny(new Array(1));await deny([undefined]);
 await deny(Object.assign([mapping],{extra:1}));await deny(Object.defineProperty([mapping],'hidden',{value:1}));await deny(Object.assign([mapping],{[Symbol('extra')]:1}));
 class CustomArray extends Array {}await deny(new CustomArray(mapping));
 for(const trap of ['ownKeys','getOwnPropertyDescriptor','getPrototypeOf'])await deny(new Proxy([mapping],{[trap](){throw Error('untrusted trap');}}));
 // Exact zero/multiple dense collections are ordinary authorization denials, not schema errors.
 for(const collection of [[],[mapping,mapping]])check((await invoke(collection)).status===403,'exact cardinality denial');
 const original=[mapping],proxy=new Proxy(original,{get(target,key){if(key==='length'||key==='0'){getters++;throw Error('value read');}return Reflect.get(target,key);}});
 const response=await invoke(proxy);await Promise.all(retained);check(response.status===200,'captured descriptor values only');check(getters===0,'no postvalidation value reads');
 `,{},true));
