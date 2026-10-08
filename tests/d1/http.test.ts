import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,Log,LogLevel} from 'miniflare';
import {readFileSync} from 'node:fs';
import {D1Repository} from '../../src/d1-repository.js';
import {D1SourceMappingStore} from '../../src/source-mappings.js';
import {fixture} from '../../src/fixture.js';
import {handleWorkerRequest} from '../../src/worker-http.js';
import type {Dependencies} from '../../src/worker-ingress.js';
import {LocalAdmission,type OperationalOptions} from '../../src/ingress-operations.js';

function adapterProbe(){
 const calls={verify:0,claim:0,business:0};const binding={};
 const dependencies={now:()=>new Date().toISOString(),log:()=>{},
  repo:{id:()=>crypto.randomUUID(),now:()=>new Date().toISOString(),assertScope:async()=>{},accept:async()=>{calls.business++;},replayBinding:()=>binding,authorityBinding:()=>binding},
  verifier:{verify:async()=>{calls.verify++;return null;}},
  mappings:{resolve:async()=>[],authorityBinding:()=>binding},
  replay:{claim:async()=>{calls.claim++;},authorityBinding:()=>binding}
 } as unknown as Dependencies;
 return {calls,dependencies};
}
const adapterRequest=()=>new Request('https://local.invalid/v1/ingress/synthetic',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(fixture)});

test('adapter throwing trusted context closes deadline and listener while retaining pending cancellation permit',async t=>{
 const h=adapterProbe(),admission=new LocalAdmission(1,1,1);let settle!:()=>void;
 const cancellation=new Promise<void>(r=>{settle=r;});let canceled=0;
 const request=new Request('https://local.invalid/v1/ingress/synthetic',{method:'POST',headers:{'content-type':'application/json'},body:new ReadableStream({cancel(){canceled++;return cancellation;}}),duplex:'half'} as RequestInit);
 const add=t.mock.method(request.signal,'addEventListener'),remove=t.mock.method(request.signal,'removeEventListener'),clear=t.mock.method(globalThis,'clearTimeout');
 const unhandled:unknown[]=[];const observe=(error:unknown)=>unhandled.push(error);process.on('unhandledRejection',observe);
 try{
  const result=await handleWorkerRequest(request,h.dependencies,{waitUntil(){throw new Error('private-context-failure');}},{admission,deadlineMs:30}).catch(error=>error);
  // Inspect before draining actual stream cancellation: response failure must not free capacity.
  const held=admission.snapshot().active;await new Promise(r=>setTimeout(r,60));settle();await new Promise(r=>setTimeout(r,10));
  assert.ok(result instanceof Response,'context exception must become safe HTTP response');assert.equal(result.status,500);assert.equal((await json(result)).code,'internal');
  assert.equal(held,1);assert.equal(canceled,1);assert.deepEqual(admission.snapshot(),{active:0,sources:0});
  assert.equal(add.mock.calls.filter(c=>c.arguments[0]==='abort').length,1);assert.equal(remove.mock.calls.filter(c=>c.arguments[0]==='abort').length,1);assert.equal(clear.mock.callCount(),1);
  assert.deepEqual(unhandled,[]);assert.deepEqual(h.calls,{verify:0,claim:0,business:0});
 }finally{settle();process.removeListener('unhandledRejection',observe);}
});

test('adapter rejects numeric-only per-call limits before either concurrent verification',async()=>{
 const h=adapterProbe();
 const responses=await Promise.all([handleWorkerRequest(adapterRequest(),h.dependencies,{waitUntil(){}},{globalLimit:1}),handleWorkerRequest(adapterRequest(),h.dependencies,{waitUntil(){}},{globalLimit:1})]);
 assert.deepEqual(responses.map(r=>r.status),[500,500]);
 for(const r of responses){const body=await json(r);assert.equal(body.code,'internal');assert.deepEqual(Object.keys(body).sort(),['code','request_id']);}
 assert.deepEqual(h.calls,{verify:0,claim:0,business:0});
});

test('adapter malformed trusted options and synchronous aborted context failure expose only internal',async()=>{
 const h=adapterProbe();const controller=new AbortController();controller.abort();
 const aborted=new Request(adapterRequest(),{signal:controller.signal});
 const response=await handleWorkerRequest(aborted,h.dependencies,{waitUntil(){throw new Error('private-context-failure');}});
 assert.equal(response.status,500);assert.equal((await json(response)).code,'internal');
 for(const options of [null,{admission:{}},{get rates(){throw new Error('private-options-failure');}},{get globalLimit(){throw new Error('private-options-failure');}}] as unknown as OperationalOptions[]){
  const r=await handleWorkerRequest(adapterRequest(),h.dependencies,{waitUntil(){}},options);assert.equal(r.status,500);const body=await json(r);assert.equal(body.code,'internal');assert.doesNotMatch(JSON.stringify(body),/private|failure/);assert.deepEqual(Object.keys(body).sort(),['code','request_id']);
 }
 await new Promise(r=>setTimeout(r,10));assert.deepEqual(h.calls,{verify:0,claim:0,business:0});
});

test('adapter explicit shared admission overloads across calls until actual verifier settlement',async()=>{
 const h=adapterProbe(),admission=new LocalAdmission(1,1,1);let settle!:()=>void,entered!:()=>void;
 const gate=new Promise<null>(r=>{settle=()=>r(null);}),started=new Promise<void>(r=>{entered=r;});
 h.dependencies.verifier.verify=async()=>{h.calls.verify++;entered();return gate;};
 const work:Promise<unknown>[]=[];const ctx={waitUntil(p:Promise<unknown>){work.push(p);}};
 try{
  const first=handleWorkerRequest(adapterRequest(),h.dependencies,ctx,{admission,globalLimit:1,deadlineMs:30});await started;
  const second=await handleWorkerRequest(adapterRequest(),h.dependencies,ctx,{admission,globalLimit:1});assert.equal(second.status,503);assert.equal((await json(second)).code,'overloaded');
  assert.equal((await first).status,504);assert.equal(admission.snapshot().active,1);settle();await Promise.all(work);assert.equal(admission.snapshot().active,0);
  assert.equal((await handleWorkerRequest(adapterRequest(),h.dependencies,ctx,{admission,globalLimit:1})).status,401);assert.deepEqual(h.calls,{verify:2,claim:0,business:0});
 }finally{settle();await Promise.all(work);}
});

async function runtime(mode='normal'){
 const bundle=await build({stdin:{resolveDir:process.cwd(),contents:`
 import {handleWorkerRequest} from './src/worker-http.ts';
 import {D1Repository} from './src/d1-repository.ts';
 import {D1ReplayLedger} from './src/replay-ledger.ts';
 import {D1SourceMappingStore} from './src/source-mappings.ts';
 import {LocalAdmission,LocalRatePolicy} from './src/ingress-operations.ts';
 // Only bounded synchronous counters cross request boundaries. No global I/O/promise/context.
 const admission=new LocalAdmission(2,2,2),rates=new LocalRatePolicy({sourceLimit:1});
 export default {async fetch(request,env,ctx){
  if(typeof Buffer!=='undefined'||typeof process!=='undefined')throw new Error('Node globals');
  const now=()=>env.NOW,binding=env.DB;
  request.signal.addEventListener('abort',()=>ctx.waitUntil(binding.prepare("INSERT INTO http_observations (kind) VALUES ('request-aborted')").run()),{once:true});
  const db={prepare:binding.prepare.bind(binding),batch:async statements=>{
   if(statements.length>9&&['late-write','revoke-write'].includes(env.MODE)){
    await binding.prepare("INSERT INTO http_observations (kind) VALUES ('write-issued')").run();await new Promise(r=>setTimeout(r,600));
    try{return await binding.batch(statements);}finally{await binding.prepare("INSERT INTO http_observations (kind) VALUES ('write-settled')").run();}
   }
   return binding.batch(statements);
  }};
  // A per-request wrapper identity is used consistently by all three trusted adapters.
  const repo=new D1Repository(db,now),store=new D1SourceMappingStore(db,now);
  if(env.MODE==='loss'&&request.headers.get('x-synthetic-fault')==='loss'){
   const accept=repo.accept.bind(repo);repo.accept=async(...args)=>{await binding.prepare("INSERT INTO http_observations (kind) VALUES ('loss-attempt')").run();await accept(...args);throw Object.assign(new Error('private SQL payload credential'),{code:'D1_TRANSIENT'});};
  }
  const verifier={verify:async input=>{
   if(env.MODE==='slow-verifier'){
    await new Promise(r=>setTimeout(r,400));await binding.prepare("INSERT INTO http_observations (kind) VALUES ('verifier-settled')").run();
   }
   if(env.MODE==='bad-verifier')throw new Error('private SQL payload credential');
   const token=input.headers.get('authorization');
   if(!['Bearer synthetic-one','Bearer synthetic-two','Bearer synthetic-unknown'].includes(token))return null;
   const identity=token==='Bearer synthetic-two'?['actor-two','source-two']:token==='Bearer synthetic-unknown'?['unknown','unknown']:['actor-one','source-one'];
   const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',input.body))].map(x=>x.toString(16).padStart(2,'0')).join('');
   return {principal:identity[0],source:identity[1],provider:input.provider,method:input.method,path:input.path,body_digest:digest,signed_at:env.NOW,nonce:input.headers.get('x-synthetic-nonce')??'nonce-one'};
  }};
  // Fault injection buffers transport bytes before testing the trusted lifetime capability.
  const ingressRequest=env.MODE==='throw-context'?new Request(request.url,{method:request.method,headers:request.headers,body:await request.arrayBuffer()}):request;
  const response=await handleWorkerRequest(ingressRequest,{repo,now,verifier,mappings:store,replay:new D1ReplayLedger(db,now),log:record=>{ctx.waitUntil(binding.prepare('INSERT INTO http_observations (kind) VALUES (?)').bind(JSON.stringify(record)).run());}},env.MODE==='throw-context'?{waitUntil(p){ctx.waitUntil(p.then(()=>binding.prepare('INSERT INTO http_observations (kind) VALUES (?)').bind('settled:'+JSON.stringify(admission.snapshot())).run()));throw new Error('private-context-failure');}}:ctx,{admission,...(env.MODE==='rate'?{rates}:{}),deadlineMs:['slow-verifier','late-write','revoke-write'].includes(env.MODE)?150:10000});
  ctx.waitUntil(binding.prepare('INSERT INTO http_observations (kind) VALUES (?)').bind('counters:'+JSON.stringify(admission.snapshot())).run());
  return response;
 }};`},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',metafile:true});
 assert.ok(Object.keys(bundle.metafile!.inputs).every(p=>!/(better-sqlite3|src\/repository|node:)/.test(p)));
 const log=new Log(LogLevel.NONE),now=new Date().toISOString();
 const mf=new Miniflare({modules:true,script:bundle.outputFiles![0].text,compatibilityDate:'2025-07-18',compatibilityFlags:[],bindings:{NOW:now,MODE:mode},d1Databases:['DB'],host:'127.0.0.1',cf:false,log,outboundService:()=>{throw new Error('External access forbidden');}});
 try{
  const db=await mf.getD1Database('DB');
  await db.exec(readFileSync(new URL('../../src/schema.sql',import.meta.url),'utf8').replace(/--[^\n]*/g,'').replaceAll('\n',' '));
  await db.exec("CREATE TABLE http_observations (kind TEXT NOT NULL)");
  const repo=new D1Repository(db,()=>now),one=await repo.createTenant('Synthetic one'),two=await repo.createTenant('Synthetic two');
  const store=new D1SourceMappingStore(db,()=>now);
  const mappings=[];
  for(const [principal,source,tenant_id,source_binding] of [['actor-one','source-one',one.id,'mock-source-001'],['actor-two','source-two',two.id,'mock-source-002']])mappings.push(await store.create({principal,source,tenant_id,source_binding,provider:'synthetic',environment:'development',operation:'ingest_mock_lead'}));
  const send=(body=JSON.stringify(fixture),headers:Record<string,string>={},method='POST',path='/v1/ingress/synthetic')=>mf.dispatchFetch('https://local.invalid'+path,{method,headers:{'content-type':'application/json',authorization:'Bearer synthetic-one',...headers},...(method==='GET'?{}:{body})});
  const count=async(table:string,tenant?:string)=>{assert.ok(['leads','conversations','events','messages','qualification_state','action_outbox','replay_ledger'].includes(table));return (await db.prepare('SELECT count(*) n FROM '+table+(tenant?' WHERE tenant_id=?':'')).bind(...(tenant?[tenant]:[])).first<{n:number}>())!.n;};
  return {mf,db,repo,store,one,two,mappings,send,count,log,now};
 }catch(error){await mf.dispose();throw error;}
}

test('HTTP throwing trusted lifetime capability returns closed internal with zero durable effects',async()=>{
 const h=await runtime('throw-context');try{
  const r=await h.send();assert.equal(r.status,500);const body=await json(r);assert.equal(body.code,'internal');assert.deepEqual(Object.keys(body).sort(),['code','request_id']);assert.doesNotMatch(JSON.stringify(body),/private|failure/);
  await observed(h,'settled:{"active":0,"sources":0}');await zeroWrites(h);
 }finally{await h.mf.dispose();}
});

test('HTTP fetch accepts verified mapped input with atomic state/outbox and isolated tenant',async()=>{
 const h=await runtime();try{
  const response=await h.send();assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  const body=await json(response) as {event_id:string;request_id:string};assert.match(body.event_id,/^[0-9a-f-]{36}$/);assert.deepEqual(Object.keys(body).sort(),['event_id','request_id']);
  for(const table of ['leads','conversations','events','messages','qualification_state','action_outbox']){assert.equal(await h.count(table,h.one.id),1);assert.equal(await h.count(table,h.two.id),0);}
  assert.equal(await h.count('replay_ledger'),1);assert.deepEqual((await h.db.prepare('PRAGMA foreign_key_check').all()).results,[]);
 }finally{await h.mf.dispose();}
});

test('HTTP timeout binds late verifier work to real ctx.waitUntil until actual settlement',async()=>{
 const h=await runtime('slow-verifier');try{
  const response=await h.send();assert.equal(response.status,504);await response.text();
  await new Promise(r=>setTimeout(r,650));
  assert.equal((await h.db.prepare("SELECT count(*) n FROM http_observations WHERE kind='verifier-settled'").first<{n:number}>())!.n,1,'pending pipeline was not attached to request lifetime');
  assert.equal(await h.count('replay_ledger'),0);assert.equal(await h.count('events'),0);
 }finally{await h.mf.dispose();}
});

async function observed(h:Awaited<ReturnType<typeof runtime>>,kind:string){
 const end=Date.now()+5000;
 while(Date.now()<end){if((await h.db.prepare('SELECT count(*) n FROM http_observations WHERE kind=?').bind(kind).first<{n:number}>())!.n)return;await new Promise(r=>setTimeout(r,20));}
 assert.fail('HTTP observation barrier exhausted: '+kind);
}
async function zeroWrites(h:Awaited<ReturnType<typeof runtime>>){
 for(const table of ['leads','conversations','events','messages','qualification_state','action_outbox','replay_ledger'])assert.equal(await h.count(table),0,table);
}

test('HTTP strict method route media JSON size and tenant spoof rejection perform zero writes',async()=>{
 const h=await runtime();try{
  const cases:Array<[string,Record<string,string>,string,string,number]>=[
   ['{}',{},'GET','/v1/ingress/synthetic',405],['{}',{},'POST','/wrong',404],['{}',{},'POST','/v1/ingress/synthetic?tenant=foreign',404],
   ['{}',{'content-type':'text/plain'},'POST','/v1/ingress/synthetic',415],['{}',{'content-encoding':'gzip'},'POST','/v1/ingress/synthetic',415],
   ['{',{},'POST','/v1/ingress/synthetic',400],['x'.repeat(16385),{},'POST','/v1/ingress/synthetic',413],
   [JSON.stringify({...fixture,tenant_id:h.two.id}),{},'POST','/v1/ingress/synthetic',400],
   ['{'+JSON.stringify(fixture).slice(1,-1)+',"schema_version":1}',{},'POST','/v1/ingress/synthetic',400]
  ];
  for(const [body,headers,method,path,status] of cases){const response=await h.send(body,headers,method,path);assert.equal(response.status,status);assert.deepEqual(Object.keys(await json(response)).sort(),['code','request_id']);}
  await zeroWrites(h);
 }finally{await h.mf.dispose();}
});

test('HTTP missing invalid unknown and revoked synthetic authority deny with zero writes',async()=>{
 const h=await runtime();try{
  for(const [authorization,status] of [['',401],['Bearer invalid',401],['Bearer synthetic-unknown',403]] as const){const r=await h.send(undefined,{authorization,'x-tenant-id':h.two.id,'x-source':'source-one'});assert.equal(r.status,status);await r.text();}
  await h.store.revoke({tenant_id:h.one.id,environment:'development'},h.mappings[0].id,1);
  const denied=await h.send();assert.equal(denied.status,403);await denied.text();await zeroWrites(h);
 }finally{await h.mf.dispose();}
});

test('HTTP identical and conflicting replay preserve original deadline and single effects',async()=>{
 const h=await runtime();try{
  const first=await h.send();assert.equal(first.status,200);const body=await json(first);
  const before=await h.db.prepare('SELECT * FROM replay_ledger').first();
  const same=await h.send();assert.equal(same.status,200);assert.equal((await json(same)).event_id,body.event_id);
  assert.equal((await h.send(JSON.stringify({...fixture,text:'conflicting'}))).status,409);
  assert.equal((await h.send(JSON.stringify({...fixture,text:'conflicting'}),{'x-synthetic-nonce':'fresh'})).status,409);
  assert.deepEqual(await h.db.prepare('SELECT * FROM replay_ledger ORDER BY rowid LIMIT 1').first(),before);
  assert.equal(await h.count('events'),1);assert.equal(await h.count('action_outbox'),1);
  const other=await h.send(undefined,{authorization:'Bearer synthetic-two'});assert.equal(other.status,200);await other.text();
  assert.equal(await h.count('events',h.one.id),1);assert.equal(await h.count('events',h.two.id),1);
 }finally{await h.mf.dispose();}
});

test('HTTP concurrent independent requests reconcile one atomic outcome',async()=>{
 const h=await runtime();try{
  const responses=await Promise.all([h.send(),h.send()]);assert.deepEqual(responses.map(r=>r.status),[200,200]);
  const bodies=await Promise.all(responses.map(r=>json(r)));assert.equal(bodies[0].event_id,bodies[1].event_id);
  assert.equal(await h.count('events'),1);assert.equal(await h.count('replay_ledger'),1);assert.equal(await h.count('action_outbox'),1);
 }finally{await h.mf.dispose();}
});

test('HTTP authenticated rate denial cannot be selected by spoofed source headers',async()=>{
 const h=await runtime('rate');try{
  assert.equal((await h.send(undefined,{authorization:'invalid','x-source':'source-one'})).status,401);
  assert.equal((await h.send()).status,200);
  const denied=await h.send(undefined,{'x-source':'unlimited','x-tenant-id':h.two.id,'x-synthetic-nonce':'fresh'});assert.equal(denied.status,429);assert.match(denied.headers.get('retry-after')!,/^(?:[1-9]|[1-5][0-9]|60)$/);
  assert.equal(await h.count('events'),1);assert.equal(await h.count('replay_ledger'),1);
 }finally{await h.mf.dispose();}
});

test('HTTP permits survive early timeout and late rejection then release at actual settlement',async()=>{
 const h=await runtime('slow-verifier');try{
  const responses=await Promise.all([h.send(),h.send()]);assert.deepEqual(responses.map(r=>r.status),[504,504]);await Promise.all(responses.map(r=>r.text()));
  const overloaded=await h.send();assert.equal(overloaded.status,503);assert.equal((await json(overloaded)).code,'overloaded');
  await new Promise(r=>setTimeout(r,650));
  const after=await h.send('{}',{},'GET');assert.equal(after.status,405);await after.text();
  assert.equal((await h.db.prepare("SELECT count(*) n FROM http_observations WHERE kind='verifier-settled'").first<{n:number}>())!.n,2);await zeroWrites(h);
 }finally{await h.mf.dispose();}
});

test('HTTP timed out issued D1 work can commit late and explicit replay recovers without renewal',async()=>{
 const h=await runtime('late-write');try{
  const pending=h.send();await observed(h,'write-issued');const response=await pending;assert.equal(response.status,504);await response.text();
  const claim=await h.db.prepare('SELECT * FROM replay_ledger').first();assert.equal(await h.count('events'),0);
  await observed(h,'write-settled');assert.equal(await h.count('action_outbox'),1);
  const recovered=await h.send();assert.equal(recovered.status,200);await recovered.text();
  assert.equal(await h.count('events'),1);assert.equal(await h.count('action_outbox'),1);assert.deepEqual(await h.db.prepare('SELECT * FROM replay_ledger').first(),claim);
 }finally{await h.mf.dispose();}
});

test('HTTP revocation before delayed issued write preserves atomic denial after timeout',async()=>{
 const h=await runtime('revoke-write');try{
  const pending=h.send();await observed(h,'write-issued');
  await h.store.revoke({tenant_id:h.one.id,environment:'development'},h.mappings[0].id,1);
  const response=await pending;assert.equal(response.status,504);await response.text();await observed(h,'write-settled');
  for(const table of ['leads','conversations','events','messages','qualification_state','action_outbox'])assert.equal(await h.count(table),0);
  assert.equal(await h.count('replay_ledger'),1);assert.equal((await h.send()).status,403);
 }finally{await h.mf.dispose();}
});

test('HTTP postcommit response loss exhausts bounded retry and explicit delivery recovers single effect',async()=>{
 const h=await runtime('loss');try{
  const lost=await h.send(undefined,{'x-synthetic-fault':'loss'});assert.equal(lost.status,503);const error=await json(lost);assert.equal(error.code,'unavailable');assert.doesNotMatch(JSON.stringify(error),/private|SQL|payload|credential/);
  assert.equal(await h.count('action_outbox'),1);assert.equal((await h.db.prepare("SELECT count(*) n FROM http_observations WHERE kind='loss-attempt'").first<{n:number}>())!.n,4);
  const recovered=await h.send();assert.equal(recovered.status,200);const body=await json(recovered);
  const event=await h.db.prepare('SELECT id FROM events').first<{id:string}>();assert.equal(body.event_id,event!.id);assert.equal(await h.count('action_outbox'),1);
 }finally{await h.mf.dispose();}
});

test('HTTP unexpected verifier errors expose only closed responses and safe logs',async()=>{
 const h=await runtime('bad-verifier');try{
  const response=await h.send();assert.equal(response.status,500);const body=await json(response);assert.equal(body.code,'internal');
  await observed(h,'counters:{"active":0,"sources":0}');
  const records=(await h.db.prepare('SELECT kind FROM http_observations').all<{kind:string}>()).results.filter((r:{kind:string})=>r.kind.startsWith('{')).map((r:{kind:string})=>JSON.parse(r.kind));
  assert.equal(records.length,1);assert.deepEqual(Object.keys(records[0]).sort(),['code','failure_category','provider_category','replay_outcome','request_id','status']);
  assert.doesNotMatch(JSON.stringify([body,records]),/private|SQL|payload|credential|actor-one|source-one/);await zeroWrites(h);
 }finally{await h.mf.dispose();}
});

test('HTTP caller transport abort is ambiguous and does not assert D1 rollback',async()=>{
 const h=await runtime('late-write');try{
  const controller=new AbortController();
  const pending=h.mf.dispatchFetch('https://local.invalid/v1/ingress/synthetic',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer synthetic-one'},body:JSON.stringify(fixture),signal:controller.signal});
  // Observe rejection immediately: no unhandled transport rejection while inspecting D1.
  const outcome=pending.then(r=>({response:r,error:null}),error=>({response:null,error}));
  await observed(h,'write-issued');controller.abort();const result=await outcome;
  assert.ok(result.error instanceof Error);assert.equal(result.error.name,'AbortError');
  await observed(h,'write-settled');assert.equal(await h.count('events'),1);assert.equal(await h.count('action_outbox'),1);
  const recovered=await h.send();assert.equal(recovered.status,200);await recovered.text();assert.equal(await h.count('action_outbox'),1);
  const interruptions=(await h.db.prepare("SELECT count(*) n FROM http_observations WHERE kind='request-aborted'").first<{n:number}>())!.n;
  // This records the actual emulator boundary, not a synthetic in-worker AbortController test.
  assert.equal(interruptions,0,'requalify documented transport-to-Worker signal behavior');
 }finally{await h.mf.dispose();}
});

async function json(response:{json():Promise<unknown>}):Promise<Record<string,unknown>>{
 const body=await response.json();assert.ok(body&&typeof body==='object'&&!Array.isArray(body));return body as Record<string,unknown>;
}
