import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare} from 'miniflare';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Processor,Registry} from '../../src/process-inbound.js';
import {fixture} from '../../src/fixture.js';
import {businessTables,type Row} from '../../src/persistence.js';
import {D1Repository,type D1Binding,type D1Statement} from '../../src/d1-repository.js';
import type {Scope} from '../../src/contracts.js';
import {randomUUID} from 'node:crypto';

const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("local test only")}}',d1Databases:['DB'],host:'127.0.0.1',cf:false,outboundService:()=>{throw new Error('External workerd network forbidden');}});
after(()=>mf.dispose());
const time='2026-01-01T12:00:01.000Z';
const ctx={environment:'development',source_binding:'mock-source-001',operation:'ingest_mock_lead'} as const;
test('D1 processor reads a bounded identity snapshot independent of tenant history',async()=>{
 const h=await harness();
 for(let i=0;i<12;i++)await h.processor.process(ctx,{...fixture,source_event_id:`history-${i}`,source_lead_id:`history-${i}`});
 const sizes:number[][]=[];
 h.setHook(async statements=>{
  if(statements.length===7){const results=await h.db.batch(statements as Parameters<typeof h.db.batch>[0]);sizes.push(results.map((r:{results:unknown[]})=>r.results.length));}
 });
 await h.processor.process(ctx,fixture);
 await h.processor.process(ctx,{...fixture,source_event_id:'next',source_sequence:2,qualification:{location:null}});
 await h.processor.process(ctx,fixture);
 assert.equal(sizes.length,3);
 assert.ok(sizes.every(s=>s.every(n=>n<=1)),JSON.stringify(sizes));
 assert.deepEqual(sizes[0],[1,0,0,0,0,0,0]);
 assert.deepEqual(sizes[1],[1,1,1,0,0,1,0]);
 assert.deepEqual(sizes[2],[1,1,1,1,0,1,0]);
});

test('D1 diagnostic rows reject revocation at their coherent read boundary',async()=>{
 const h=await harness();await h.processor.process(ctx,fixture);let revoked=false;
 const revoke=async()=>{if(!revoked){revoked=true;await h.db.prepare("UPDATE tenants SET lifecycle_status='inactive' WHERE id=?").bind(h.t1.id).run();}};
 const binding:D1Binding={
  prepare:sql=>{const wrap=(stmt:D1Statement):D1Statement=>new Proxy(stmt,{get:(target,key)=>key==='bind'?((...values:(string|number|null)[])=>wrap(target.bind(...values))):key==='all'&&sql.startsWith('SELECT *')?async()=>{await revoke();return target.all();}:Reflect.get(target,key,target)});return wrap(h.db.prepare(sql));},
  batch:async statements=>{await revoke();return h.db.batch(statements as Parameters<typeof h.db.batch>[0]);}
 };
 await assert.rejects(new D1Repository(binding,()=>time).rows(h.s1,'events'),{code:'context'});
});

test('D1 retries documented transient snapshot failures as a complete unit',async()=>{
 const h=await harness();let reads=0;
 h.setHook(async statements=>{if(statements.length===7&&++reads===1)throw new Error('D1_ERROR: Network connection lost.');});
 const outcome=await h.processor.process(ctx,fixture);
 assert.equal(outcome.qualification.status,'handoff_ready');assert.equal(reads,2);
 assert.ok((await snapshot(h)).every(rows=>rows.length===1));
});

test('D1 rejects injected sessions rather than assuming their lifecycle reads are current',async()=>{
 const h=await harness();
 for(const bookmark of [null,'stale-bookmark']){
  const session={prepare:h.db.prepare.bind(h.db),batch:h.db.batch.bind(h.db),getBookmark:()=>bookmark};
  assert.throws(()=>new D1Repository(session,()=>time),{code:'context'});
 }
});

test('D1 lifecycle validation is part of the acceptance batch, never a separate stale read',async()=>{
 const h=await harness();let standalone=0;
 const wrap=(stmt:D1Statement):D1Statement=>new Proxy(stmt,{get:(target,key)=>key==='bind'?((...values:(string|number|null)[])=>wrap(target.bind(...values))):key==='all'?async()=>{standalone++;throw new Error('Separate acceptance read forbidden');}:Reflect.get(target,key,target)});
 const binding:D1Binding={prepare:sql=>wrap(h.db.prepare(sql)),batch:s=>h.db.batch(s as Parameters<typeof h.db.batch>[0])};
 const result=await new Processor(new D1Repository(binding,()=>time),h.registry).process(ctx,fixture);
 assert.equal(result.qualification.status,'handoff_ready');assert.equal(standalone,0);
});

const transientFailures=[
 'D1 DB reset because its code was updated.',
 'Internal error while starting up D1 DB storage caused object to be reset.',
 'Network connection lost.','Replica disconnected from primary.',
 'Internal error in D1 DB storage caused object to be reset.',
 'Cannot resolve D1 DB due to transient issue on remote node.',
 "Can't read from request stream because client disconnected."
];
test('D1 documented transient details retry both read and write with legacy cause envelopes',async()=>{
 for(const phase of ['read','write'])for(const [index,message] of transientFailures.entries()){
  const h=await harness();let failed=false,reads=0,writes=0;
  h.setHook(async statements=>{
   const read=statements.length===7;read?reads++:writes++;
   if(!failed&&read===(phase==='read')){failed=true;throw index%2?new Error('D1_ERROR',{cause:new Error(message)}):new Error(`D1_ERROR: ${message}`);}
  });
  await h.processor.process(ctx,fixture);assert.equal(reads,2);assert.equal(writes,phase==='write'?2:1);
  h.setHook(undefined);assert.ok((await snapshot(h)).every(r=>r.length===1));
 }
});
test('D1 transient failures exhaust configured bounded retry budgets without writes',async()=>{
 for(const phase of ['read','write'])for(const maxRetries of [0,1,3]){
  const h=await harness();let failures=0;
  h.setHook(async statements=>{if((statements.length===7)===(phase==='read')){failures++;throw new Error('D1_ERROR: Replica disconnected from primary.');}});
  await assert.rejects(new Processor(h.repo,h.registry,{maxRetries}).process(ctx,fixture),{code:'retry_exhausted'});
  assert.equal(failures,maxRetries+1);h.setHook(undefined);assert.ok((await snapshot(h)).every(r=>r.length===0));
 }
});
test('D1 quota resource syntax type FK and unknown failures never retry',async()=>{
 const permanent=[
  "Your account has exceeded D1's free tier daily row read limit.",
  'Exceeded maximum DB size.',"D1 DB's isolate exceeded its memory limit and was reset.",
  'D1 DB exceeded its CPU time limit and was reset.','near SELECT: syntax error',
  'FOREIGN KEY constraint failed','D1_TYPE_ERROR: unsupported type','unrecognized error',
  'Network connection lost. with unknown extra details'
 ];
 for(const phase of ['read','write'])for(const detail of permanent){
  const h=await harness();let failures=0;const failure=new Error(`D1_ERROR: ${detail}`);
  h.setHook(async statements=>{if((statements.length===7)===(phase==='read')){failures++;throw failure;}});
  await assert.rejects(h.processor.process(ctx,fixture),e=>e===failure);assert.equal(failures,1);
  h.setHook(undefined);assert.ok((await snapshot(h)).every(r=>r.length===0));
 }
});
for(const detail of ['FOREIGN KEY constraint failed','unrecognized error','cycle'])test(`D1 incomplete cause chains fail closed with deep ${detail}`,async()=>{
 for(const phase of ['read','write']){
  const h=await harness();let failures=0;
  const tail=new Error('Network connection lost.');
  const failure=new Error('D1_ERROR',{cause:new Error('Network connection lost.',{cause:new Error('Network connection lost.',{cause:tail})})});
  tail.cause=detail==='cycle'?failure:new Error(detail);
  h.setHook(async statements=>{if((statements.length===7)===(phase==='read')){failures++;throw failure;}});
  await assert.rejects(h.processor.process(ctx,fixture),e=>e===failure);assert.equal(failures,1);
  h.setHook(undefined);assert.ok((await snapshot(h)).every(r=>r.length===0));
 }
});
test('D1 ambiguous successful commit is reconciled by replay, never a second action',async()=>{
 const h=await harness();let writes=0,reads=0;
 h.setHook(async statements=>{
  if(statements.length===7){reads++;return;}
  writes++;await h.db.batch(statements as Parameters<typeof h.db.batch>[0]);
  throw new Error('D1_ERROR: Network connection lost.');
 });
 const first=await h.processor.process(ctx,fixture);assert.equal(writes,1);assert.equal(reads,2);
 h.setHook(undefined);const allocated=h.ids.length;
 assert.deepEqual(await h.processor.process(ctx,fixture),first);assert.equal(h.ids.length,allocated);
 assert.ok((await snapshot(h)).every(r=>r.length===1));
});
test('D1 final-attempt response loss reports exhaustion with a durable outcome for explicit replay',async()=>{
 const h=await harness();let reads=0,writes=0;
 const failure=new Error('D1_ERROR: Network connection lost.');
 h.setHook(async statements=>{
  if(statements.length===7){reads++;return;}
  writes++;await h.db.batch(statements as Parameters<typeof h.db.batch>[0]);throw failure;
 });
 await assert.rejects(new Processor(h.repo,h.registry,{maxRetries:0}).process(ctx,fixture),error=>{
  assert.equal((error as {code?:string}).code,'retry_exhausted');
  const cause=(error as Error).cause as Error&{code:string};
  assert.equal(cause?.code,'D1_TRANSIENT');assert.equal(cause.cause,failure);return true;
 });
 assert.equal(reads,1);assert.equal(writes,1);h.setHook(undefined);
 const before=await snapshot(h),allocated=h.ids.length;
 assert.ok(before.every(rows=>rows.length===1));assert.equal(before[5][0].status,'pending');
 const committed=JSON.parse(String(before[2][0].outcome_snapshot));
 assert.deepEqual(await h.processor.process(ctx,fixture),committed);assert.equal(h.ids.length,allocated);
 assert.deepEqual(await snapshot(h),before);
 assert.deepEqual((await h.db.prepare('PRAGMA foreign_key_check').all()).results,[]);
 assert.equal((await h.db.prepare('SELECT count(*) AS n FROM acceptance_assertions').all()).results[0].n,0);
});
test('D1 acceptance diagnostics and retries stay on the original primary binding',async()=>{
 const h=await harness();let sessions=0,reads=0;
 const primary={prepare:h.db.prepare.bind(h.db),batch:async(s:D1Statement[])=>{if(s.length===7&&++reads===1)throw new Error('D1_ERROR: Network connection lost.');return h.db.batch(s as Parameters<typeof h.db.batch>[0]);},withSession:()=>{sessions++;throw new Error('No session, even first-primary, may be reused for lifecycle reads');}};
 const repo=new D1Repository(primary,()=>time),p=new Processor(repo,h.registry);
 await p.process(ctx,fixture);assert.equal(reads,2);assert.equal((await repo.rows(h.s1,'events')).length,1);assert.equal(sessions,0);
 await h.db.prepare("UPDATE tenants SET lifecycle_status='inactive' WHERE id=?").bind(h.t1.id).run();
 await assert.rejects(p.process(ctx,fixture),{code:'context'});await assert.rejects(repo.rows(h.s1,'events'),{code:'context'});
 assert.equal(sessions,0);
});
test('D1 concurrent changed fingerprints conflict across same and different lead queues',async()=>{
 for(const updating of [false,true])for(const differentLead of [false,true]){
  const h=await harness();if(updating)await h.processor.process(ctx,fixture);
  const input=updating?{...fixture,source_event_id:'second',source_sequence:2}:fixture;
  const winner=new Processor(new D1Repository(h.db,()=>time),h.registry);let calls=0;
  h.setHook(async statements=>{if(statements.length!==7&&++calls===1)await winner.process(ctx,input);});
  const changed=differentLead?{...input,source_lead_id:'different',source_sequence:1}:{...input,text:'changed'};
  await assert.rejects(h.processor.process(ctx,changed),{code:'conflict'});assert.equal(calls,1);
  h.setHook(undefined);const rows=await snapshot(h);
  assert.deepEqual(rows.map(r=>r.length),[1,1,updating?2:1,updating?2:1,1,updating?2:1]);
  assert.equal(rows[0][0].source_lead_id,fixture.source_lead_id);assert.equal(rows[0][0].version,updating?2:1);
  assert.deepEqual(await h.processor.process(ctx,input),await winner.process(ctx,input));
 }
});

test('D1 trusted maintenance callbacks fail closed above their bounded snapshot budget',async()=>{
 const h=await harness();
 await h.db.batch(Array.from({length:101},(_,i)=>h.db.prepare('INSERT INTO leads (id,tenant_id,source_binding,source_lead_id,contact_reference,last_source_sequence,version,created_at,updated_at) VALUES (?,?,?,?,?,0,0,?,?)').bind(randomUUID(),h.t1.id,ctx.source_binding,`history-${i}`,'synthetic',time,time)));
 let planned=false;
 await assert.rejects(h.repo.accept(h.s1,()=>{planned=true;}),{code:'context'});
 assert.equal(planned,false);
 // A large tenant must still work through the exact processor contract, not fallback.
 await h.processor.process(ctx,fixture);
});

test('D1 conflicting permanent and transient cause details fail closed',async()=>{
 const h=await harness();let failures=0;
 const error=new Error('D1_ERROR: FOREIGN KEY constraint failed',{cause:new Error('Network connection lost.')});
 h.setHook(async()=>{failures++;throw error;});
 await assert.rejects(h.processor.process(ctx,fixture),e=>e===error);
 assert.equal(failures,1);
});

test('D1 planning exceptions are not reclassified as database transient failures',async()=>{
 const h=await harness();let calls=0;const error=new Error('D1_ERROR: Network connection lost.');
 const p=new Processor(h.repo,h.registry,{checkpoint:()=>{calls++;throw error;}});
 await assert.rejects(p.process(ctx,fixture),e=>e===error);assert.equal(calls,1);
 assert.ok((await snapshot(h)).every(r=>r.length===0));
});

test('D1 accepts the fixture atomically through the shared processor',async()=>{
 const db=await mf.getD1Database('DB');
 await db.exec(readFileSync(new URL('../../src/schema.sql',import.meta.url),'utf8').replace(/--[^\n]*/g,'').replaceAll('\n',' '));
 const {D1Repository}=await import('../../src/d1-repository.js');
 const repo=new D1Repository(db,()=>time);
 const tenant=await repo.createTenant('Apacely');
 const scope={tenant_id:tenant.id,environment:'development'} as const;
 const processor=new Processor(repo,new Registry([[ctx.source_binding,tenant.id]]));
 const outcome=await processor.process(ctx,fixture);
 assert.equal(outcome.qualification.status,'handoff_ready');
 assert.equal(outcome.action.action_type,'request_handoff');
 for(const table of businessTables) assert.equal((await repo.rows(scope,table)).length,1);
 assert.equal((await repo.rows(scope,'action_outbox'))[0].status,'pending');
});

async function harness() {
 const db=await mf.getD1Database('DB');
 await db.exec(readFileSync(new URL('../../src/schema.sql',import.meta.url),'utf8').replace(/--[^\n]*/g,'').replaceAll('\n',' '));
 let hook:undefined|((statements:D1Statement[])=>Promise<void>),batches=0;
 const binding:D1Binding={prepare:sql=>db.prepare(sql),batch:async statements=>{if(statements.length!==2){batches++;await hook?.(statements);}return db.batch(statements as Parameters<typeof db.batch>[0]);}};
 const ids:string[]=[];
 const repo=new D1Repository(binding,()=>time,()=>{const id=randomUUID();ids.push(id);return id;});
 const t1=await repo.createTenant('Apacely'),t2=await repo.createTenant('Synthetic Tenant');
 const s1={tenant_id:t1.id,environment:'development'} as const,s2={tenant_id:t2.id,environment:'development'} as const;
 const registry=new Registry([[ctx.source_binding,t1.id],['mock-source-002',t2.id]]);
 const processor=new Processor(repo,registry);
 return {db,repo,t1,t2,s1,s2,ids,registry,processor,batches:()=>batches,setHook:(value:typeof hook)=>{hook=value;}};
}
async function snapshot(h:Awaited<ReturnType<typeof harness>>,scope=h.s1) {return Promise.all(businessTables.map(t=>h.repo.rows(scope,t)));}
test('D1 zero-row CAS aborts all earlier writes in the batch',async()=>{
 const h=await harness();const first=await h.processor.process(ctx,fixture);
 const before=await snapshot(h);
 // Simulate a stale caller, with real D1 transaction rollback, not a batch double.
 await assert.rejects(h.repo.accept(h.s1,store=>{
  store.update('leads',first.event.lead_id,{contact_reference:'must-roll-back'});
  store.compareLead(first.event.lead_id,0,0,{version:2,last_source_sequence:2});
 }),{code:'LOCAL_VERSION_CONFLICT'});
 assert.deepEqual(await snapshot(h),before);
});

test('D1 rejects a tenant deactivated after planning at atomic commit time',async()=>{
 const h=await harness();let calls=0;
 h.setHook(async()=>{if(++calls===2) await h.db.prepare("UPDATE tenants SET lifecycle_status='inactive' WHERE id=?").bind(h.t1.id).run();});
 await assert.rejects(h.processor.process(ctx,fixture),{code:'context'});
 for(const table of businessTables) assert.equal((await h.db.prepare(`SELECT * FROM ${table} WHERE tenant_id=?`).bind(h.t1.id).all()).results.length,0);
});

test('D1 independent adapters reread a winning concurrent duplicate on first and later events',async()=>{
 for(const updating of [false,true]) {
  const h=await harness();if(updating)await h.processor.process(ctx,fixture);
  const input=updating?{...fixture,source_event_id:'second',source_sequence:2}:fixture;
  const winner=new Processor(new D1Repository(h.db,()=>time),h.registry);
  let calls=0,winning:unknown;
  h.setHook(async()=>{if(++calls===2)winning=await winner.process(ctx,input);});
  const losing=await h.processor.process(ctx,input);
  assert.deepEqual(losing,winning);
  const rows=await snapshot(h);assert.equal(rows[2].length,updating?2:1);assert.equal(rows[5].length,updating?2:1);
  assert.equal(calls,3); // read, losing write, reread; duplicate has no write batch
 }
});

test('D1 replay is immutable and consumes no IDs after later qualification transitions',async()=>{
 const h=await harness();const first=await h.processor.process(ctx,fixture);
 const second=await h.processor.process(ctx,{...fixture,source_event_id:'second',source_sequence:2,qualification:{location:null},handoff_requested:false});
 assert.equal(second.qualification.location,null);assert.equal(second.qualification.intent,'buy');assert.equal(second.qualification.version,2);
 assert.equal(second.action.action_type,'send_message');assert.deepEqual(second.qualification.missing_fields,['location']);
 const third=await h.processor.process(ctx,{...fixture,source_event_id:'third',source_sequence:3,qualification:{location:'Ottawa'},handoff_requested:false});
 assert.equal(third.qualification.status,'qualified');assert.equal(third.action.payload.due_at,'2026-01-02T12:00:01.000Z');
 const fourth=await h.processor.process(ctx,{...fixture,source_event_id:'fourth',source_sequence:4,qualification:{intent:'rent'},handoff_requested:true});
 assert.equal(fourth.qualification.status,'disqualified');assert.equal(fourth.qualification.handoff_ready,false);
 const before=await snapshot(h),ids=h.ids.length;
 assert.deepEqual(await h.processor.process(ctx,fixture),first);assert.equal(h.ids.length,ids);assert.deepEqual(await snapshot(h),before);
 await assert.rejects(h.processor.process(ctx,{...fixture,text:'changed'}),{code:'conflict'});
 assert.deepEqual(await snapshot(h),before);
 assert.deepEqual(before.map(rows=>rows.length),[1,1,4,4,1,4]);
});
test('D1 rejects sequence gaps, stale arrivals, forged scope and malformed input without writes',async()=>{
 const h=await harness(),empty=await snapshot(h);
 await assert.rejects(h.processor.process(ctx,{...fixture,source_sequence:2}),{code:'conflict'});assert.deepEqual(await snapshot(h),empty);
 await h.processor.process(ctx,fixture);const before=await snapshot(h);
 for(const source_sequence of [1,3,8])await assert.rejects(h.processor.process(ctx,{...fixture,source_event_id:'bad',source_sequence}),{code:'conflict'});
 for(const patch of [{tenant_id:h.t2.id},{environment:'production'},{qualification:{intent:'invalid'}},{source_sequence:0},{occurred_at:'invalid'},{schema_version:2}])await assert.rejects(h.processor.process(ctx,{...fixture,...patch}),{code:'validation'});
 for(const context of [undefined,{}, {...ctx,tenant_id:h.t2.id},{...ctx,environment:'production'},{...ctx,source_binding:'unknown'}])await assert.rejects(h.processor.process(context as never,fixture),{code:'context'});
 assert.deepEqual(await snapshot(h),before);
 await assert.rejects(h.repo.rows(undefined as never,'leads'),{code:'context'});
 await assert.rejects(h.repo.rows({...h.s1,environment:'production'} as never,'leads'),{code:'context'});
 await assert.rejects(h.repo.rows(h.s1,'tenants' as never),{code:'context'});
});
test('D1 captures trusted caller scope across asynchronous reads and planning',async()=>{
 const h=await harness(),context={...ctx,source_binding:String(ctx.source_binding)};
 const pending=h.processor.process(context,fixture);context.source_binding='mock-source-002';
 const outcome=await pending;assert.equal(outcome.event.tenant_id,h.t1.id);assert.equal(outcome.event.source,ctx.source_binding);
 await h.processor.process({...ctx,source_binding:'mock-source-002'},fixture);
 const scope={...h.s1};const rows=h.repo.rows(scope,'events');scope.tenant_id=h.t2.id;
 assert.equal((await rows)[0].tenant_id,h.t1.id);
 assert.ok((await snapshot(h,h.s2)).every(rows=>rows.length===1));
});
test('D1 scoped read/plan mutations cannot access foreign rows or change ownership',async()=>{
 const h=await harness();await h.processor.process(ctx,fixture);
 await h.processor.process({...ctx,source_binding:'mock-source-002'},fixture);
 const foreign=await snapshot(h,h.s2),before=await snapshot(h);
 for(const [i,table] of businessTables.entries()){
  await h.repo.accept(h.s1,store=>{
   assert.equal(store.find(table,{id:foreign[i][0].id}),undefined);
   assert.equal(store.update(table,String(foreign[i][0].id),{updated_at:time}),0);
   assert.throws(()=>store.insert(table,{...foreign[i][0],id:h.repo.id()}),{code:'context'});
   assert.throws(()=>store.update(table,String(before[i][0].id),{tenant_id:h.t2.id}),{code:'context'});
   assert.throws(()=>store.update(table,String(before[i][0].id),{id:h.repo.id()}),{code:'context'});
  });
 }
 assert.deepEqual(await snapshot(h),before);assert.deepEqual(await snapshot(h,h.s2),foreign);
});
test('D1 composite FKs reject cross-tenant and same-tenant wrong-parent relationships',async()=>{
 const h=await harness();await h.processor.process(ctx,fixture);
 const foreign=await h.processor.process({...ctx,source_binding:'mock-source-002'},fixture);
 const other=await h.processor.process(ctx,{...fixture,source_event_id:'other',source_lead_id:'other'});
 const before=await snapshot(h);
 for(const table of ['conversations','events','messages','qualification_state','action_outbox'] as const){
  const row=(await h.repo.rows(h.s1,table))[0];
  const patches:Row[]=[{lead_id:foreign.event.lead_id}];
  if(table!=='conversations')patches.push({conversation_id:foreign.event.conversation_id},{conversation_id:other.event.conversation_id});
  if(table==='messages'||table==='action_outbox')patches.push({event_id:foreign.event.event_id});
  if(table==='qualification_state')patches.push({evaluated_event_id:foreign.event.event_id},{evaluated_event_id:other.event.event_id});
  for(const patch of patches)await assert.rejects(h.repo.accept(h.s1,store=>store.update(table,String(row.id),patch)),/FOREIGN KEY constraint failed/);
 }
 assert.deepEqual(await snapshot(h),before);
 assert.deepEqual((await h.db.prepare('PRAGMA foreign_key_check').all()).results,[]);
});
test('D1 every planning checkpoint leaves both new and existing business state unchanged',async()=>{
 const checkpoints=['lead_write','conversation_write','event_write','message_write','evaluated','qualification_write','lead_result_write','conversation_result_write','outbox_write','snapshot_write','before_commit'];
 for(const updating of [false,true]){
  const h=await harness();if(updating)await h.processor.process(ctx,fixture);const before=await snapshot(h);
  for(const checkpoint of checkpoints){
   const p=new Processor(h.repo,h.registry,{checkpoint:step=>{if(step===checkpoint)throw new Error(`injected:${checkpoint}`);}});
   await assert.rejects(p.process(ctx,updating?{...fixture,source_event_id:'second',source_sequence:2}:fixture),new RegExp(`injected:${checkpoint}`));
   assert.deepEqual(await snapshot(h),before);assert.ok((await snapshot(h,h.s2)).every(rows=>rows.length===0));
  }
 }
});
test('D1 actual mid-batch failures after every SQL statement roll back new and updated state',async()=>{
 for(const updating of [false,true]){
  const h=await harness();if(updating)await h.processor.process(ctx,fixture);const before=await snapshot(h);
  let length=0;
  // Capture the real write plan, then stop it at the transport boundary without committing.
  h.setHook(async statements=>{if(statements.length!==businessTables.length+1){length=statements.length;throw new Error('capture');}});
  await assert.rejects(h.processor.process(ctx,updating?{...fixture,source_event_id:'second',source_sequence:2}:fixture),/capture/);
  assert.ok(length>6);
  for(let index=0;index<length;index++){
   h.setHook(async statements=>{if(statements.length!==businessTables.length+1)statements.splice(index+1,0,h.db.prepare("SELECT json('injected-failure')"));});
   await assert.rejects(h.processor.process(ctx,updating?{...fixture,source_event_id:'second',source_sequence:2}:fixture),/malformed JSON/);
   assert.deepEqual(await snapshot(h),before);
   assert.equal((await h.db.prepare('SELECT count(*) AS n FROM acceptance_assertions').all()).results[0].n,0);
  }
 }
});
test('D1 independent adapter contenders for the same sequence produce one winner and a typed conflict',async()=>{
 for(const updating of [false,true]){
  const h=await harness();if(updating)await h.processor.process(ctx,fixture);
  const winner=new Processor(new D1Repository(h.db,()=>time),h.registry);let calls=0;
  h.setHook(async()=>{if(++calls===2)await winner.process(ctx,{...fixture,source_event_id:'winner',source_sequence:updating?2:1});});
  await assert.rejects(h.processor.process(ctx,{...fixture,source_event_id:'loser',source_sequence:updating?2:1}),{code:'conflict'});
  const rows=await snapshot(h);assert.equal(rows[2].length,updating?2:1);assert.equal(rows[5].length,updating?2:1);assert.equal(rows[0][0].version,updating?2:1);
 }
});
test('D1 stale CAS retries are bounded and reread without leaking partial qualification or outbox',async()=>{
 for(const maxRetries of [0,3]){
  const h=await harness();const first=await h.processor.process(ctx,fixture);let writes=0,calls=0;
  h.setHook(async()=>{if(++calls%2===0){writes++;await h.db.prepare('UPDATE leads SET version=version+1 WHERE tenant_id=? AND id=?').bind(h.t1.id,first.event.lead_id).run();}});
  const p=new Processor(h.repo,h.registry,{maxRetries});
  await assert.rejects(p.process(ctx,{...fixture,source_event_id:'second',source_sequence:2,qualification:{intent:'rent'}}),{code:'retry_exhausted'});
  assert.equal(writes,maxRetries+1);
  const rows=await snapshot(h);assert.ok(rows.every(rows=>rows.length===1));assert.equal(rows[0][0].last_source_sequence,1);assert.equal(rows[4][0].status,'handoff_ready');
 }
});
test('D1 validates injected UUIDv4 generators and UTC clocks before writes',async()=>{
 const h=await harness(),before=await snapshot(h);
 await assert.rejects(new D1Repository(h.db,()=>time,()=> 'tenant-001').createTenant('Bad'),{code:'validation'});
 await assert.rejects(new D1Repository(h.db,()=> 'invalid').createTenant('Bad'),{code:'validation'});
 const bad=new Processor(new D1Repository(h.db,()=>time,()=> 'not-uuid'),h.registry);
 await assert.rejects(bad.process(ctx,fixture),{code:'validation'});
 assert.deepEqual(await snapshot(h),before);
});

test('D1 duplicate replay rejects scope revoked immediately before its read batch',async()=>{
 const h=await harness();await h.processor.process(ctx,fixture);let calls=0;
 h.setHook(async()=>{if(++calls===1)await h.db.prepare("UPDATE tenants SET lifecycle_status='inactive' WHERE id=?").bind(h.t1.id).run();});
 await assert.rejects(h.processor.process(ctx,fixture),{code:'context'});
});

test('D1 simultaneous independent processors deduplicate without a shared application queue',async()=>{
 const h=await harness();
 const processors=Array.from({length:8},()=>new Processor(new D1Repository(h.db,()=>time),h.registry));
 const outcomes=await Promise.all(processors.map(p=>p.process(ctx,fixture)));
 for(const outcome of outcomes)assert.deepEqual(outcome,outcomes[0]);
 assert.ok((await snapshot(h)).every(rows=>rows.length===1));
});

test('D1 local persistent binding survives emulator restart with immutable replay',async()=>{
 const path=mkdtempSync(join(tmpdir(),'apacely-d1-'));
 const options={modules:true,script:'export default {fetch(){return new Response("local test only")}}',d1Databases:['DB'],d1Persist:path,host:'127.0.0.1',cf:false as const,outboundService:()=>{throw new Error('External workerd network forbidden');}};
 let local=new Miniflare(options);
 try{
  const db=await local.getD1Database('DB');
  await db.exec(readFileSync(new URL('../../src/schema.sql',import.meta.url),'utf8').replace(/--[^\n]*/g,'').replaceAll('\n',' '));
  const repo=new D1Repository(db,()=>time),tenant=await repo.createTenant('Apacely'),scope={tenant_id:tenant.id,environment:'development'} as const;
  const registry=new Registry([[ctx.source_binding,tenant.id]]),first=await new Processor(repo,registry).process(ctx,fixture);
  const before=await Promise.all(businessTables.map(t=>repo.rows(scope,t)));
  await local.dispose();local=new Miniflare(options);
  const reopened=new D1Repository(await local.getD1Database('DB'),()=> '2026-01-03T00:00:00.000Z');
  assert.deepEqual(await Promise.all(businessTables.map(t=>reopened.rows(scope,t))),before);
  assert.deepEqual(await new Processor(reopened,registry).process(ctx,fixture),first);
 }finally{await local.dispose();rmSync(path,{recursive:true,force:true});}
});
