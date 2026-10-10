import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {build} from 'esbuild';
// Deliberately use Wrangler's installed modern runtime, not the historical root Miniflare.
import {Miniflare,convertV4MiniflareOptions} from '../../node_modules/wrangler/node_modules/miniflare/dist/src/index.js';
import {createTicket,encodeMessage,decodeMessage,type AdmissionTicket,type AdmissionMethod} from '../../src/distributed-admission.js';
import {STAGING_POLICY} from '../../src/staging-policy.js';
const ROOT='/root/apacely-staging-evidence/staging-runtime';
const STATE='distributed-admission/state/v1',BIRTH='distributed-admission/birth/v1';
const authority={environment:'staging' as const,tenant:'20000000-0000-4000-8000-000000000001',provider:'synthetic',principal:'runtime',source:'runtime',mappingId:'30000000-0000-4000-8000-000000000001',mappingVersion:1,sourceBinding:'runtime',operation:'ingest_mock_lead' as const};
async function harness(mode:'bootstrap'|'sealed'|'inspect'|'foundation',persist:string){
 const imported=mode==='bootstrap'||mode==='sealed'?`import {StagingAdmissionCoordinator as Base,default as release} from './src/staging-${mode==='bootstrap'?'bootstrap-worker':'worker'}.ts';`:`import {DurableObject as Base} from 'cloudflare:workers';`;
 const code=`${imported}
 import {initializeFreshAdmission,validateSealedAdmission,admissionStorage} from './src/staging-coordinator.ts';
 import {AdmissionCoordinator} from './src/distributed-admission.ts';
 import {STAGING_POLICY} from './src/staging-policy.ts';
 export class StagingAdmissionCoordinator extends Base {
 async fetch(request){const path=new URL(request.url).pathname;
 if(path==='/test/state')return Response.json([...await this.ctx.storage.list()]);
 if(path==='/test/schema')return Response.json([...this.ctx.storage.sql.exec('SELECT name,type,tbl_name,sql FROM sqlite_master ORDER BY name')]);
 if(path==='/test/fault-admission'){
 const storage=this.ctx.storage;
 const faulted={get:storage.get.bind(storage),put:storage.put.bind(storage),transaction:callback=>storage.transaction(async tx=>await callback({get:tx.get.bind(tx),put:async(key,value)=>{await tx.put(key,value);throw Error('injected-after-admission-put');}}))};
 return new AdmissionCoordinator(admissionStorage(faulted),STAGING_POLICY).fetch(new Request('https://admission.internal/v1/reserve',request));}
 if(path==='/test/promises'){
 try{const adapter=admissionStorage(this.ctx.storage);
 await adapter.transaction(async tx=>{const raw=await Promise.prototype.then.call(tx.get('${STATE}'),value=>value);await Promise.prototype.then.call(tx.put('${STATE}',raw),()=>undefined);});
 return new Response('ok');}catch(error){return new Response(String(error),{status:409});}}
 if(path==='/test/mutate'){const op=await request.json();if(op.kind==='deleteAll')await this.ctx.storage.deleteAll();else if(op.kind==='sql')this.ctx.storage.sql.exec(op.value);else if(op.kind==='delete')await this.ctx.storage.delete(op.key);else await this.ctx.storage.put(op.key,op.value);return new Response(null,{status:204});}
 if(path==='/test/foundation'){
 let writes=0;const storage=this.ctx.storage;
 const facade={get:async key=>await storage.get(key),put:async(key,value)=>{await storage.put(key,value);},list:async()=>{throw Error('outer-list-forbidden');},sql:storage.sql,
 transaction:async callback=>await storage.transaction(async tx=>await callback({list:async options=>await tx.list(options),get:async key=>await tx.get(key),put:async(key,value)=>{await tx.put(key,value);if(++writes===Number(new URL(request.url).searchParams.get('fail')))throw Error('injected-after-write');}}))};
 try{await initializeFreshAdmission(facade,Date.now());await validateSealedAdmission(storage);return new Response('ok');}catch(error){return new Response(String(error)+' schema='+JSON.stringify([...storage.sql.exec('SELECT name,type,tbl_name FROM sqlite_master')]),{status:409});}}
 if(path==='/test/validate'){try{await validateSealedAdmission(this.ctx.storage);return new Response('ok');}catch{return new Response('rejected',{status:409});}}
 ${mode==='inspect'?'return new Response(null,{status:503});':mode==='foundation'?"return new AdmissionCoordinator(admissionStorage(this.ctx.storage),STAGING_POLICY).fetch(request);":'return super.fetch(request);'}
 }}
 export default {fetch(request,env,ctx){${mode==='bootstrap'||mode==='sealed'?"if(new URL(request.url).pathname==='/test/release')return release.fetch(request,env,ctx);":''}return env.ADMISSION.get(env.ADMISSION.idFromName('distributed-admission-v1')).fetch(request);}};`;
 const result=await build({stdin:{contents:code,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers']});
 const options=convertV4MiniflareOptions({host:'127.0.0.1',cf:false,workers:[{name:'staging-runtime',modules:true,script:result.outputFiles[0].text,compatibilityDate:'2025-07-18',compatibilityFlags:[],bindings:{APACELY_ENVIRONMENT:'staging',APACELY_OPERATION:'ingest_mock_lead',APACELY_INGRESS_ENABLED:'false',APACELY_EFFECTS_ENABLED:'false'},durableObjects:{ADMISSION:{className:'StagingAdmissionCoordinator',useSQLite:true}},outboundService:()=>{throw Error('External network forbidden');}}]});
 const mf=new Miniflare({...options,resourcePersistencePath:persist});
 await mf.ready;
 return mf;
}
async function state(mf:Awaited<ReturnType<typeof harness>>){const response=await mf.dispatchFetch('https://admission.internal/test/state');return await response.json() as [string,unknown][];}
async function schema(mf:Awaited<ReturnType<typeof harness>>){const response=await mf.dispatchFetch('https://admission.internal/test/schema');return await response.json();}
async function mutate(mf:Awaited<ReturnType<typeof harness>>,op:object){const response=await mf.dispatchFetch('https://admission.internal/test/mutate',{method:'POST',body:JSON.stringify(op)});assert.equal(response.status,204);await response.text();}
async function send(mf:Awaited<ReturnType<typeof harness>>,ticket:AdmissionTicket,operation:AdmissionMethod){const response=await mf.dispatchFetch('https://admission.internal/v1/'+operation,{method:'POST',headers:{'content-type':'application/json'},body:encodeMessage({version:1,ticket,operation,payload:operation==='settle'?{kind:'all-issued-terminal',barrierId:crypto.randomUUID()}: {}})});return {status:response.status,reply:decodeMessage(await response.text(),'reply')};}

test('actual SQLite schema guard does not confuse sqliteX user tables with reserved sqlite_ metadata',async()=>{
 const persist=await mkdtemp(ROOT+'/schema-');const mf=await harness('foundation',persist);
 try{let response=await mf.dispatchFetch('https://admission.internal/test/foundation?fail=0');assert.equal(response.status,200);await response.text();
 await mutate(mf,{kind:'sql',value:'CREATE TABLE sqliteXforeign(value TEXT)'});
 response=await mf.dispatchFetch('https://admission.internal/test/validate');assert.equal(response.status,409);await response.text();
 }finally{await mf.dispose();}
});

test('actual SQLite transaction birth rollback after either write leaves no keys; native receiver-safe foundation grants',async()=>{
 const persist=await mkdtemp(ROOT+'/foundation-');const mf=await harness('foundation',persist);
 try{for(const fail of [1,2]){const response=await mf.dispatchFetch('https://admission.internal/test/foundation?fail='+fail);assert.equal(response.status,409);await response.text();assert.deepEqual(await state(mf),[]);}
 const response=await mf.dispatchFetch('https://admission.internal/test/foundation?fail=0');const detail=await response.text();assert.equal(response.status,200,detail);assert.equal((await state(mf)).length,2);
 const ticket=createTicket(STAGING_POLICY,authority,Date.now()+30000);assert.equal((await send(mf,ticket,'reserve')).status,200);
 const promises=await mf.dispatchFetch('https://admission.internal/test/promises');const promiseDetails=await promises.text();assert.equal(promises.status,200,promiseDetails);
 const beforeFailure=await state(mf),failedTicket=createTicket(STAGING_POLICY,authority,Date.now()+30000);
 const failed=await mf.dispatchFetch('https://admission.internal/test/fault-admission',{method:'POST',headers:{'content-type':'application/json'},body:encodeMessage({version:1,ticket:failedTicket,operation:'reserve',payload:{}})});
 assert.equal(failed.status,503);const fault=decodeMessage(await failed.text(),'reply').result;assert.equal(fault.tag,'fault');if(fault.tag==='fault')assert.equal(fault.code,'unavailable');assert.deepEqual(await state(mf),beforeFailure);
 }finally{await mf.dispose();}
});

test('trusted bootstrap and sealed actual platform artifacts preserve charged lifecycle and terminal tombstones on restart',async()=>{
 const persist=await mkdtemp(ROOT+'/lifecycle-');let mf=await harness('bootstrap',persist);
 try{const closed=await mf.dispatchFetch('https://admission.internal/test/release');assert.equal(closed.status,503);await closed.text();assert.equal((await state(mf)).length,2);
 await mf.dispose();mf=await harness('sealed',persist);
 const sealedClosed=await mf.dispatchFetch('https://admission.internal/test/release');assert.equal(sealedClosed.status,503);assert.deepEqual(await sealedClosed.json(),{code:'unavailable'});
 const tickets=[createTicket(STAGING_POLICY,authority,Date.now()+30000),createTicket(STAGING_POLICY,authority,Date.now()+30000),createTicket(STAGING_POLICY,authority,Date.now()+30000)];
 const grants=await Promise.all(tickets.map(ticket=>send(mf,ticket,'reserve')));assert.equal(grants.filter(r=>r.status===200).length,2);assert.equal(grants.filter(r=>r.status===409).length,1);
 const handles=grants.filter(r=>r.reply.result.tag==='record').map(r=>{if(r.reply.result.tag!=='record')throw Error();return r.reply.result.record.handle;});
 for(const h of handles)assert.equal((await send(mf,h,'start')).status,200);
 assert.equal((await send(mf,handles[1],'settle')).status,200);
 const before=await state(mf);await writeFile(persist+'/state-evidence.json',JSON.stringify(before),{mode:0o600});
 await mf.dispose();mf=await harness('sealed',persist);assert.deepEqual(await state(mf),before);
 for(const [i,h] of handles.entries()){const read=await send(mf,h,'inspect');assert.equal(read.status,200);assert.equal(read.reply.result.tag,'record');if(read.reply.result.tag==='record')assert.equal(read.reply.result.record.state,i===0?'ACTIVE':'RELEASED');}
 await new Promise(resolve=>setTimeout(resolve,STAGING_POLICY.diagnosticTtlMs+1000));
 const aged=await send(mf,handles[0],'inspect');assert.equal(aged.reply.result.tag,'record');if(aged.reply.result.tag==='record')assert.equal(aged.reply.result.record.state,'QUARANTINED');
 const agedSnapshot=await state(mf);await mf.dispose();mf=await harness('sealed',persist);assert.deepEqual(await state(mf),agedSnapshot);
 const raw=new Map(await state(mf)).get(STATE) as string;assert.equal(JSON.parse(raw).aggregateLive,1);
 }finally{await mf.dispose();}
});

test('sealed empty storage and SQL/KV extras, partial deletion, total deletion, corrupt state and marker drift reject without reseeding',async()=>{
 for(const damage of ['empty','sql','extra','missing-state','missing-marker','deleteAll','corrupt','marker'] as const){
 const persist=await mkdtemp(ROOT+'/damage-'+damage+'-');let mf=await harness(damage==='empty'?'inspect':'bootstrap',persist);
 try{if(damage!=='empty')await state(mf);
 if(damage==='sql')await mutate(mf,{kind:'sql',value:'CREATE TABLE foreign_data(value TEXT)'});
 if(damage==='extra')await mutate(mf,{kind:'put',key:'foreign',value:'x'});
 if(damage==='missing-state'||damage==='missing-marker')await mutate(mf,{kind:'delete',key:damage==='missing-state'?STATE:BIRTH});
 if(damage==='deleteAll')await mutate(mf,{kind:'deleteAll'});
 if(damage==='corrupt'||damage==='marker')await mutate(mf,{kind:'put',key:damage==='corrupt'?STATE:BIRTH,value:'corrupt'});
 const before=await state(mf),beforeSchema=await schema(mf);await mf.dispose();mf=await harness('sealed',persist);
 // Constructor failure is expected and must stay closed. Miniflare surfaces platform failure as a 500 response.
 const response=await mf.dispatchFetch('https://admission.internal/test/state');const rejected=await response.text();assert.equal(response.status,500,damage);assert.match(rejected,/Invalid sealed admission storage/);
 await mf.dispose();mf=await harness('inspect',persist);assert.deepEqual(await state(mf),before,damage);assert.deepEqual(await schema(mf),beforeSchema,damage);
 }finally{await mf.dispose();}
 }
});
