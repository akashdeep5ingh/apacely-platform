import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Repository,businessTables} from '../src/repository.js';
import {Processor,Registry} from '../src/process-inbound.js';
import {fixture} from '../src/fixture.js';
import {MockSink,drain} from '../src/mock-outbox.js';
import {POLICY,uuidV4,SliceError} from '../src/contracts.js';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
function temporary() {const dir=mkdtempSync(join(tmpdir(),'apacely-test-'));return {path:join(dir,'local.sqlite'),cleanup:()=>rmSync(dir,{recursive:true,force:true})};}
test('real SQLite lock retries reread a concurrent winning duplicate',async()=>{
 const temp=temporary(),h=harness(temp.path),other=new Repository(temp.path,()=>time);try {
 const lock=new Database(temp.path);lock.exec('BEGIN IMMEDIATE');
 const winner=new Processor(other,new Registry([['mock-source-001',h.t1.id]]));
 const losing=h.processor.process(h.ctx,fixture);
 const winning=new Promise<Awaited<ReturnType<Processor['process']>>>((resolve,reject)=>setTimeout(()=>{lock.exec('ROLLBACK');lock.close();winner.process(h.ctx,fixture).then(resolve,reject);},0));
 const [a,b]=await Promise.all([losing,winning]);assert.deepEqual(a,b);assert.ok(snapshot(h).every(rows=>rows.length===1));
 }finally{other.close();h.repo.close();temp.cleanup();}
});
test('local version conflict retries the whole unit and zero retry budget is honored',async()=>{
 const h=harness();try {let calls=0;
 const p=new Processor(h.repo,new Registry([['mock-source-001',h.t1.id]]),{checkpoint:step=>{if(step==='before_commit'&&++calls===1) throw Object.assign(new Error('version'),{code:'LOCAL_VERSION_CONFLICT'});}});
 await p.process(h.ctx,fixture);assert.equal(calls,2);assert.ok(snapshot(h).every(rows=>rows.length===1));
 const before=snapshot(h),noRetry=new Processor(h.repo,new Registry([['mock-source-001',h.t1.id]]),{maxRetries:0,checkpoint:()=>{throw Object.assign(new Error('locked'),{code:'SQLITE_LOCKED'});}});
 await assert.rejects(noRetry.process(h.ctx,{...fixture,source_event_id:'two',source_sequence:2}),{code:'retry_exhausted'});assert.deepEqual(snapshot(h),before);
 }finally{h.repo.close();}
});
test('sink failure leaves committed business state and a recoverable pending outbox',async()=>{
 const h=harness();try {
 await h.processor.process(h.ctx,fixture);const before=snapshot(h),sink=new MockSink();
 const failing=new MockSink();failing.record=()=>{throw new Error('sink crash');};
 assert.throws(()=>drain(h.repo,h.s1,failing),/sink crash/);assert.equal(failing.receipts.length,0);
 assert.deepEqual(snapshot(h).slice(0,5),before.slice(0,5));assert.equal(snapshot(h)[5][0].status,'pending');assert.equal(snapshot(h)[5][0].attempts,1);
 assert.equal(drain(h.repo,h.s1,sink).length,1);assert.equal(snapshot(h)[5][0].attempts,2);
 }finally{h.repo.close();}
});
test('dedup identity is a relational tuple, not delimiter concatenation',async()=>{
 const h=harness();try {
 const p=new Processor(h.repo,new Registry([['x:y',h.t1.id],['x',h.t1.id]]));
 const a=await p.process({...h.ctx,source_binding:'x:y'},{...fixture,source_event_id:'z'});
 const b=await p.process({...h.ctx,source_binding:'x'},{...fixture,source_event_id:'y:z'});
 assert.notEqual(a.event.event_id,b.event.event_id);assert.notEqual(a.event.lead_id,b.event.lead_id);assert.ok(snapshot(h).every(rows=>rows.length===2));
 }finally{h.repo.close();}
});
test('outbox consumer refuses provisional state before the inbound transaction commits',async()=>{
 const h=harness(),sink=new MockSink();try {
 const p=new Processor(h.repo,new Registry([['mock-source-001',h.t1.id]]),{checkpoint:step=>{if(step==='outbox_write') assert.throws(()=>drain(h.repo,h.s1,sink),{code:'conflict'});}});
 await p.process(h.ctx,fixture);assert.equal(sink.receipts.length,0);assert.equal(snapshot(h)[5][0].status,'pending');assert.equal(drain(h.repo,h.s1,sink).length,1);
 }finally{h.repo.close();}
});
test('malformed caller/trusted contexts cannot write; inactive labels confer no authority',async()=>{
 const temp=temporary(),h=harness(temp.path);try {
 const before=snapshot(h);
 for(const ctx of [undefined,{}, {...h.ctx,source_binding:'unknown'},{...h.ctx,source_binding:undefined},{...h.ctx,environment:'staging'},{...h.ctx,tenant_id:h.t2.id},{...h.ctx,operation:'send_live_message'}]) {
 await assert.rejects(h.processor.process(ctx as never,fixture),{code:'context'});assert.deepEqual(snapshot(h),before);
 }
 for(const patch of [{tenant_id:h.t2.id},{lead_id:h.t2.id},{conversation_id:h.t2.id},{source_binding:'mock-source-002'},{environment:'production'},{qualification:{intent:'invest'}},{occurred_at:'nonsense'},{source_sequence:-1},{schema_version:2}, {handoff_requested:undefined}]) {
 await assert.rejects(h.processor.process(h.ctx,{...fixture,...patch}),{code:'validation'});assert.deepEqual(snapshot(h),before);
 }
 const sql=new Database(temp.path);sql.prepare("UPDATE tenants SET lifecycle_status='inactive' WHERE id=?").run(h.t1.id);sql.close();
 await assert.rejects(h.processor.process(h.ctx,fixture),{code:'context'});
 assert.throws(()=>h.repo.scoped(h.s1),{code:'context'});
 const sql2=new Database(temp.path);for(const table of businessTables) assert.equal((sql2.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {n:number}).n,0);assert.equal((sql2.prepare('SELECT count(*) AS n FROM tenants').get() as {n:number}).n,2);sql2.close();
 }finally{h.repo.close();temp.cleanup();}
});
test('composite FKs reject foreign ownership and same-tenant conversation/lead mismatches',async()=>{
 const h=harness();try {
 const a=await h.processor.process(h.ctx,fixture),b=await h.processor.process({...h.ctx,source_binding:'mock-source-002'},fixture);
 const other=await h.processor.process(h.ctx,{...fixture,source_event_id:'other-event',source_lead_id:'other-lead'});
 const store=h.repo.scoped(h.s1),before=snapshot(h);
 for(const table of ['conversations','events','messages','qualification_state','action_outbox'] as const) {
 const row=store.rows(table)[0];
 assert.throws(()=>store.update(table,String(row.id),{lead_id:b.event.lead_id}),{code:'SQLITE_CONSTRAINT_FOREIGNKEY'});
 if(table!=='conversations') {
 assert.throws(()=>store.update(table,String(row.id),{conversation_id:b.event.conversation_id}),{code:'SQLITE_CONSTRAINT_FOREIGNKEY'});
 assert.throws(()=>store.update(table,String(row.id),{conversation_id:other.event.conversation_id}),{code:'SQLITE_CONSTRAINT_FOREIGNKEY'});
 }
 if(['messages','action_outbox'].includes(table)) assert.throws(()=>store.update(table,String(row.id),{event_id:b.event.event_id}),{code:'SQLITE_CONSTRAINT_FOREIGNKEY'});
 if(table==='qualification_state') assert.throws(()=>store.update(table,String(row.id),{evaluated_event_id:b.event.event_id}),{code:'SQLITE_CONSTRAINT_FOREIGNKEY'});
 assert.deepEqual(snapshot(h),before);
 assert.throws(()=>store.insert(table,{...row,id:h.repo.id(),tenant_id:h.t2.id}),{code:'context'});
 assert.throws(()=>store.update(table,String(row.id),{tenant_id:h.t2.id}),{code:'context'});
 }
 }finally{h.repo.close();}
});
test('concurrent duplicate and different same-sequence arrivals preserve one accepted action',async()=>{
 const h=harness();try {
 const duplicate=await Promise.all(Array.from({length:12},()=>h.processor.process(h.ctx,fixture)));
 duplicate.forEach(o=>assert.deepEqual(o,duplicate[0]));assert.ok(snapshot(h).every(rows=>rows.length===1));
 const candidates=await Promise.allSettled(['two','alternate'].map(source_event_id=>h.processor.process(h.ctx,{...fixture,source_event_id,source_sequence:2})));
 assert.equal(candidates.filter(r=>r.status==='fulfilled').length,1);const loser=candidates.find(r=>r.status==='rejected') as PromiseRejectedResult;assert.equal(loser.reason.code,'conflict');
 assert.equal(h.repo.scoped(h.s1).rows('events').length,2);assert.equal(h.repo.scoped(h.s1).rows('action_outbox').length,2);assert.equal(h.repo.scoped(h.s1).rows('leads')[0].version,2);
 }finally{h.repo.close();}
});
test('reopening real SQLite preserves all committed rows and immutable replay snapshots',async()=>{
 const temp=temporary(),h=harness(temp.path);let closed=false;try {
 const first=await h.processor.process(h.ctx,fixture);await h.processor.process(h.ctx,{...fixture,source_event_id:'two',source_sequence:2,handoff_requested:false});
 const before=snapshot(h);h.repo.close();closed=true;
 const reopened=new Repository(temp.path,()=> '2026-01-03T00:00:00.000Z');try {
 assert.deepEqual(businessTables.map(t=>reopened.scoped(h.s1).rows(t)),before);
 const p=new Processor(reopened,new Registry([['mock-source-001',h.t1.id]]));assert.deepEqual(await p.process(h.ctx,fixture),first);
 const sink=new MockSink();assert.equal(drain(reopened,h.s1,sink).length,2);assert.equal(reopened.scoped(h.s1).rows('action_outbox').filter(r=>r.status==='recorded').length,2);
 }finally{reopened.close();}
 const sql=new Database(temp.path);assert.deepEqual(sql.pragma('foreign_key_check'),[]);for(const table of businessTables) assert.ok((sql.prepare(`SELECT count(*) AS n FROM ${table} WHERE tenant_id=?`).get(h.t1.id) as {n:number}).n>0);sql.close();
 }finally{if(!closed)h.repo.close();temp.cleanup();}
});
test('trusted context and repository scope are captured, not mutable caller references',async()=>{
 const h=harness();try {
 const scope={...h.s1},store=h.repo.scoped(scope),ctx={...h.ctx,source_binding:String(h.ctx.source_binding)};
 const pending=h.processor.process(ctx,fixture);ctx.source_binding='mock-source-002';
 const o=await pending;assert.equal(o.event.source,'mock-source-001');
 await h.processor.process({...h.ctx,source_binding:'mock-source-002'},fixture);
 scope.tenant_id=h.t2.id;assert.equal(store.rows('leads')[0].tenant_id,h.t1.id);
 }finally{h.repo.close();}
});
test('drain keeps both receipts owned by T1 when afterRecord mutates the original scope to T2',async()=>{
 const h=harness();try {
 const first=await h.processor.process(h.ctx,fixture);
 const second=await h.processor.process(h.ctx,{...fixture,source_event_id:'second',source_sequence:2});
 await h.processor.process({...h.ctx,source_binding:'mock-source-002'},fixture);
 const foreign=h.repo.scoped(h.s2),t2Before=businessTables.map(t=>foreign.rows(t));
 const scope={...h.s1},sink=new MockSink();let hooks=0;
 const receipts=drain(h.repo,scope,sink,{afterRecord:()=>{hooks++;scope.tenant_id=h.t2.id;}});
 assert.equal(hooks,2);assert.equal(scope.tenant_id,h.t2.id);
 assert.equal(receipts.length,2);assert.equal(sink.receipts.length,2);
 assert.deepEqual(receipts.map(r=>r.action_id),[first.action.id,second.action.id]);
 assert.deepEqual(receipts.map(r=>r.action.tenant_id),[h.t1.id,h.t1.id]);
 assert.deepEqual(sink.receipts,receipts);
 const outbox=h.repo.scoped(h.s1).rows('action_outbox');
 assert.equal(outbox.length,2);assert.ok(outbox.every(r=>r.tenant_id===h.t1.id&&r.status==='recorded'&&r.attempts===1));
 assert.deepEqual(businessTables.map(t=>foreign.rows(t)),t2Before);
 }finally{h.repo.close();}
});
test('same external identities are isolated across reads, updates, joined history, replay and drain',async()=>{
 const h=harness();try {
 const a=await h.processor.process(h.ctx,fixture),b=await h.processor.process({...h.ctx,source_binding:'mock-source-002'},fixture);
 const own=h.repo.scoped(h.s1),foreign=h.repo.scoped(h.s2);
 for(const t of businessTables) {
 const foreignRow=foreign.rows(t)[0];assert.equal(own.get(t,String(foreignRow.id)),undefined);assert.equal(own.find(t,{id:foreignRow.id}),undefined);assert.equal(own.update(t,String(foreignRow.id),t==='leads'?{contact_reference:'x'}:t==='events'?{source_event_id:'x'}:t==='messages'?{text:'x'}:{status:'recorded'}),0);
 }
 assert.notEqual(a.event.event_id,b.event.event_id);assert.notEqual(a.event.lead_id,b.event.lead_id);
 assert.equal(own.history(a.event.lead_id).length,1);assert.deepEqual(own.history(b.event.lead_id),[]);
 const t2Before=businessTables.map(t=>foreign.rows(t)),sink=new MockSink();
 drain(h.repo,h.s1,sink);assert.deepEqual(businessTables.map(t=>foreign.rows(t)),t2Before);assert.equal(sink.receipts.length,1);assert.equal(sink.receipts[0].action.tenant_id,h.t1.id);
 assert.deepEqual(await h.processor.process({...h.ctx,source_binding:'mock-source-002'},fixture),b);
 drain(h.repo,h.s2,sink);assert.equal(sink.receipts.length,2);
 assert.throws(()=>h.repo.scoped(undefined as never),{code:'context'});
 assert.throws(()=>h.repo.scoped({tenant_id:h.t1.id,environment:'production'} as never),{code:'context'});
 }finally{h.repo.close();}
});
test('optimistic lead sequence/version comparison rejects a stale write without mutation',async()=>{
 const h=harness();try {
 const o=await h.processor.process(h.ctx,fixture),store=h.repo.scoped(h.s1),before=snapshot(h);
 assert.throws(()=>store.compareLead(o.event.lead_id,0,0,{version:2,last_source_sequence:2}),{code:'LOCAL_VERSION_CONFLICT'});
 assert.deepEqual(snapshot(h),before);
 assert.throws(()=>h.repo.scoped(h.s2).compareLead(o.event.lead_id,1,1,{version:2,last_source_sequence:2}),{code:'LOCAL_VERSION_CONFLICT'});assert.deepEqual(snapshot(h),before);
 }finally{h.repo.close();}
});
test('lock failures retry the whole rolled-back unit up to three times only',async()=>{
 for(const failCount of [1,3,4]) {
 const h=harness();let attempts=0;try {
 const p=new Processor(h.repo,new Registry([['mock-source-001',h.t1.id]]),{checkpoint:step=>{if(step==='message_write'&&++attempts<=failCount) throw Object.assign(new Error('locked'),{code:'SQLITE_BUSY'});}});
 if(failCount===4) {await assert.rejects(p.process(h.ctx,fixture),{code:'retry_exhausted'});assert.ok(snapshot(h).every(rows=>rows.length===0));}
 else {await p.process(h.ctx,fixture);assert.ok(snapshot(h).every(rows=>rows.length===1));}
 assert.equal(attempts,Math.min(failCount+1,4));
 }finally{h.repo.close();}
 }
 const h=harness();try {let attempts=0;
 const p=new Processor(h.repo,new Registry([['mock-source-001',h.t1.id]]),{checkpoint:step=>{if(step==='message_write') {attempts++;throw new SliceError('conflict','not retryable');}}});
 await assert.rejects(p.process(h.ctx,fixture),{code:'conflict'});assert.equal(attempts,1);
 await assert.rejects(p.process(h.ctx,{...fixture,handoff_requested:undefined}),{code:'validation'});assert.equal(attempts,1);
 assert.throws(()=>new Processor(h.repo,new Registry([]),{maxRetries:4}),{code:'validation'});
 }finally{h.repo.close();}
});
test('drain failure after record recovers pending intent with original deduplicated receipt',async()=>{
 const h=harness();try {
 const first=await h.processor.process(h.ctx,fixture),before=snapshot(h),sink=new MockSink();
 assert.throws(()=>drain(h.repo,h.s1,sink,{afterRecord:()=>{throw new Error('ack crash');}}),/ack crash/);
 const failed=snapshot(h);assert.deepEqual(failed.slice(0,5),before.slice(0,5));assert.equal(failed[5][0].status,'pending');assert.equal(failed[5][0].attempts,1);assert.equal(sink.receipts.length,1);
 const original=sink.receipts[0];assert.deepEqual(sink.record({...first.action,payload:{changed:true}}),original);
 assert.deepEqual(drain(h.repo,h.s1,sink),[original]);assert.equal(sink.receipts.length,1);assert.equal(snapshot(h)[5][0].status,'recorded');assert.equal(snapshot(h)[5][0].attempts,2);
 }finally{h.repo.close();}
});
test('postcommit mock drain records only one action and redelivery/drain are inert',async()=>{
 const h=harness();try {
 const first=await h.processor.process(h.ctx,fixture),sink=new MockSink();
 const before=snapshot(h);assert.equal(sink.receipts.length,0);
 const receipts=drain(h.repo,h.s1,sink);assert.equal(receipts.length,1);assert.equal(sink.receipts.length,1);
 assert.deepEqual(receipts[0].action,first.action);assert.equal(receipts[0].action_id,first.action.id);
 const after=snapshot(h);assert.deepEqual(after.slice(0,5),before.slice(0,5));
 assert.equal(after[5][0].status,'recorded');assert.equal(after[5][0].attempts,1);assert.equal(after[5][0].recorded_at,time);
 assert.deepEqual(await h.processor.process(h.ctx,fixture),first);assert.deepEqual(drain(h.repo,h.s1,sink),[]);assert.deepEqual(snapshot(h),after);assert.equal(sink.receipts.length,1);
 }finally{h.repo.close();}
});
function snapshot(h:ReturnType<typeof harness>) {return businessTables.map(t=>h.repo.scoped(h.s1).rows(t));}
test('every precommit checkpoint rolls back inserts and existing-state updates',async()=>{
 const checkpoints=['lead_write','conversation_write','event_write','message_write','evaluated','qualification_write','lead_result_write','conversation_result_write','outbox_write','snapshot_write','before_commit'];
 for(const updating of [false,true]) for(const checkpoint of checkpoints) {
 const h=harness();try {
 if(updating) await h.processor.process(h.ctx,fixture);
 const before=snapshot(h),p=new Processor(h.repo,new Registry([['mock-source-001',h.t1.id]]),{checkpoint:step=>{if(step===checkpoint) throw new Error(`injected:${checkpoint}`);}});
 await assert.rejects(p.process(h.ctx,updating?{...fixture,source_event_id:'second',source_sequence:2}:fixture),new RegExp(`injected:${checkpoint}`));
 assert.deepEqual(snapshot(h),before);assert.equal(h.repo.scoped(h.s2).rows('leads').length,0);
 }finally{h.repo.close();}
 }
});
test('sequence starts at one and rejects gaps, stale and same-sequence alternate keys atomically',async()=>{
 const h=harness();try {
 const empty=snapshot(h);
 await assert.rejects(h.processor.process(h.ctx,{...fixture,source_sequence:2}),{code:'conflict'});assert.deepEqual(snapshot(h),empty);
 await h.processor.process(h.ctx,fixture);const before=snapshot(h);
 for(const seq of [1,3,8]) {await assert.rejects(h.processor.process(h.ctx,{...fixture,source_event_id:`bad-${seq}`,source_sequence:seq}),{code:'conflict'});assert.deepEqual(snapshot(h),before);}
 await h.processor.process(h.ctx,{...fixture,source_event_id:'second',source_sequence:2,occurred_at:'2025-01-01T00:00:00.000Z'});
 const newer=snapshot(h);await assert.rejects(h.processor.process(h.ctx,{...fixture,source_event_id:'stale',source_sequence:1}),{code:'conflict'});assert.deepEqual(snapshot(h),newer);
 }finally{h.repo.close();}
});
test('later events patch/clear facts, reevaluate readiness and replay the original immutable outcome',async()=>{
 const h=harness();try {
 const first=await h.processor.process(h.ctx,fixture);
 const secondInput={...fixture,source_event_id:'mock-event-002',source_sequence:2,qualification:{location:null},handoff_requested:false};
 const second=await h.processor.process(h.ctx,secondInput);
 assert.equal(second.event.lead_id,first.event.lead_id);assert.equal(second.event.conversation_id,first.event.conversation_id);
 assert.equal(second.qualification.id,first.qualification.id);assert.equal(second.qualification.version,2);
 assert.deepEqual(second.event.payload.qualification,{location:null});assert.equal(second.qualification.intent,'buy');assert.equal(second.qualification.location,null);assert.equal(second.qualification.handoff_ready,false);
 assert.deepEqual(second.qualification.missing_fields,['location']);assert.equal(second.action.action_type,'send_message');
 const third=await h.processor.process(h.ctx,{...fixture,source_event_id:'e3',source_sequence:3,qualification:{location:'Ottawa'},handoff_requested:false});
 assert.equal(third.qualification.status,'qualified');assert.equal(third.qualification.version,3);
 const fourth=await h.processor.process(h.ctx,{...fixture,source_event_id:'e4',source_sequence:4,qualification:{},handoff_requested:true});
 assert.equal(fourth.qualification.location,'Ottawa');assert.equal(fourth.qualification.status,'handoff_ready');
 const fifth=await h.processor.process(h.ctx,{...fixture,source_event_id:'e5',source_sequence:5,qualification:{},handoff_requested:false});
 assert.equal(fifth.qualification.status,'qualified');assert.equal(fifth.qualification.handoff_ready,false);
 const before=snapshot(h);assert.deepEqual(await h.processor.process(h.ctx,fixture),first);assert.deepEqual(snapshot(h),before);
 for(const t of ['leads','conversations','qualification_state'] as const) assert.equal(h.repo.scoped(h.s1).rows(t).length,1);
 for(const t of ['events','messages','action_outbox'] as const) assert.equal(h.repo.scoped(h.s1).rows(t).length,5);
 assert.equal(h.repo.scoped(h.s1).rows('leads')[0].version,5);assert.equal(h.repo.scoped(h.s1).rows('conversations')[0].version,5);
 }finally{h.repo.close();}
});
test('logical redelivery replays original snapshot without consuming IDs or changing rows',async()=>{
 const h=harness();try {
 const first=await h.processor.process(h.ctx,fixture),before=snapshot(h),ids=h.generated.length;
 const duplicate=await h.processor.process(h.ctx,fixture);
 assert.deepEqual(duplicate,first);assert.deepEqual(snapshot(h),before);assert.equal(h.generated.length,ids);
 await assert.rejects(h.processor.process(h.ctx,{...fixture,text:'changed'}),(e:unknown)=>e instanceof SliceError&&e.code==='conflict');
 assert.deepEqual(snapshot(h),before);
 }finally{h.repo.close();}
});
const time='2026-01-01T12:00:01.000Z';
function harness(path=':memory:') {
 let i=0;const generated:string[]=[];
 const repo=new Repository(path,()=>time,()=>{const id=`00000000-0000-4000-8000-${String(++i).padStart(12,'0')}`;generated.push(id);return id;});
 const t1=repo.createTenant('Apacely'),t2=repo.createTenant('Synthetic Tenant');
 const registry=new Registry([['mock-source-001',t1.id],['mock-source-002',t2.id]]);
 const processor=new Processor(repo,registry);
 const ctx={environment:'development',source_binding:'mock-source-001',operation:'ingest_mock_lead'} as const;
 const s1={tenant_id:t1.id,environment:'development'} as const,s2={tenant_id:t2.id,environment:'development'} as const;
 return {repo,t1,t2,generated,processor,ctx,s1,s2};
}
test('each synthetic outcome emits its distinct provider-independent action',async()=>{
 for(const [patch,status,type,reason] of [
 [{handoff_requested:false},'qualified','schedule_followup','qualified_without_handoff_request'],
 [{qualification:{...fixture.qualification,financing_status:'unknown'}},'needs_more_information','send_message','missing_information'],
 [{qualification:{...fixture.qualification,intent:'rent'}},'disqualified','request_handoff','review_disqualification']
 ] as const) {
  const h=harness();try {
   const o=await h.processor.process(h.ctx,{...fixture,...patch});
   assert.equal(o.qualification.status,status);assert.equal(o.qualification.handoff_ready,false);
   assert.equal(o.action.action_type,type);assert.equal(o.action.payload.reason,reason);
   if(status==='qualified') assert.equal(o.action.payload.due_at,'2026-01-02T12:00:01.000Z');
   if(status==='needs_more_information') {assert.equal(o.action.payload.channel,'mock');assert.equal(o.action.payload.template,'qualification_missing_fields');assert.equal(o.action.payload.recipient_reference,fixture.contact_reference);assert.deepEqual(o.action.payload.missing_fields,['financing_status']);}
   if(status==='disqualified') assert.equal(o.action.payload.destination_reference,'mock-review-inbox');
  }finally{h.repo.close();}
 }
});
test('baseline atomic inbound yields exact normalized snapshot and six owned rows',async()=>{
 const h=harness();try {
 const outcome=await h.processor.process(h.ctx,fixture);
 const {event,qualification,action}=outcome;
 assert.deepEqual(event,{event_id:event.event_id,event_type:'lead.inbound_received',schema_version:1,tenant_id:h.t1.id,environment:'development',source:'mock-source-001',source_event_id:'mock-event-001',source_sequence:1,occurred_at:fixture.occurred_at,received_at:time,lead_id:event.lead_id,conversation_id:event.conversation_id,message_id:event.message_id,correlation_id:event.event_id,policy_version:POLICY,payload:{contact_reference:fixture.contact_reference,channel:'mock',text:fixture.text,qualification:fixture.qualification,handoff_requested:true}});
 assert.deepEqual(qualification,{id:qualification.id,tenant_id:h.t1.id,lead_id:event.lead_id,conversation_id:event.conversation_id,evaluated_event_id:event.event_id,...fixture.qualification,handoff_ready:true,status:'handoff_ready',reasons:['qualified_and_handoff_requested'],missing_fields:[],policy_version:POLICY,version:1,updated_at:time});
 assert.deepEqual(action,{id:action.id,tenant_id:h.t1.id,environment:'development',lead_id:event.lead_id,conversation_id:event.conversation_id,event_id:event.event_id,causation_id:event.event_id,correlation_id:event.event_id,policy_version:POLICY,action_slot:'qualification_result',action_type:'request_handoff',payload:{qualification_status:'handoff_ready',reason:'qualified_and_handoff_requested',qualification:{...fixture.qualification,handoff_ready:true},destination_reference:'mock-handoff-inbox'}});
 for(const table of businessTables) {assert.equal(h.repo.scoped(h.s1).rows(table).length,1);assert.equal(h.repo.scoped(h.s2).rows(table).length,0);}
 assert.equal(h.repo.scoped(h.s1).rows('action_outbox')[0].status,'pending');
 assert.equal(h.repo.scoped(h.s1).rows('leads')[0].qualification_status,'handoff_ready');
 assert.equal(h.repo.scoped(h.s1).rows('conversations')[0].status,'open');
 assert.equal(h.generated.length,8);assert.ok(h.generated.every(id=>uuidV4.test(id)));
 assert.equal(h.t1.id,h.generated[0]);assert.equal(h.t2.id,h.generated[1]);
 }finally{h.repo.close();}
});
