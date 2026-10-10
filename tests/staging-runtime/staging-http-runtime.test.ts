import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from '../../src/fixture.js';
import {credentials,directory,runtime,provision,rows,evidence,signed,send,type Runtime} from './staging-http-private.js';

// Postimplementation audit: no invented RED history. Must be scheduled by the emulator owner.
test('sealed HTTP Worker qualifies real D1, SQLite DO, Access, HMAC, replay and tenant isolation',async()=>{
 assert.equal(process.versions.node,'22.23.3','use dedicated approved runtime');
 assert.equal(process.env.APACELY_HTTP_EMULATOR_OWNER,'parent-serial-approved','explicit serial ownership handoff required');
 const persist=await directory(),c=await credentials();let h:Runtime|undefined;
 const switchTo=async(mode:'bootstrap'|'sealed'|'inspect',source='a',enabled='true',effects='false')=>{if(h)await h.mf.dispose();h=undefined;h=await runtime(mode,persist,c,source,enabled,effects);return h;};
 const snapshot=async(label:string)=>{const inspector=await switchTo('inspect');const state=await inspector.state();await evidence(persist,label,{d1:await rows(inspector),admission:state});return state;};
 try{
  h=await switchTo('bootstrap');const tenants=await provision(h);await h.birth();
  const born=await snapshot('birth');assert.equal(born.length,2);
  const body=JSON.stringify({...fixture,occurred_at:new Date().toISOString()});
  for(const [enabled,effects,status] of [['false','false',503],['true','true',500]] as const){
   h=await switchTo('sealed','a',enabled,effects);const before=await rows(h);
   await send(h,await signed(c,body,'disabled-'+enabled),status);
   assert.deepEqual(await rows(h),before);assert.equal(h.jwks(),0);assert.deepEqual(h.blocked,[]);
   assert.deepEqual(await snapshot('flags-'+enabled),born);
  }
  h=await switchTo('sealed');const clean=await rows(h);
  assert.deepEqual(clean.database_environment,[{singleton:1,environment:'staging'}]);
  // Privileged local corruption fixture proves binding labels cannot authorize a physical foreign DB.
  const db=await h.db();
  // Immutable staging CHECK prevents updates; replace only this synthetic marker in a private batch.
  await db.batch([db.prepare('DROP TRIGGER environment_no_update'),db.prepare('DROP TRIGGER environment_no_replace'),db.prepare('DROP TRIGGER environment_no_delete'),db.prepare('DROP TABLE database_environment'),db.prepare('CREATE TABLE database_environment (singleton INTEGER PRIMARY KEY CHECK(singleton=1), environment TEXT NOT NULL)'),db.prepare("INSERT INTO database_environment VALUES (1,'development')")]);
  const foreign=await rows(h);await send(h,await signed(c,body,'physical-foreign'),403);assert.equal(h.jwks(),0);assert.deepEqual(await rows(h),foreign);
  // Restore the exact canonical table/triggers using the real generator, never weaken app checks.
  const {stagingMigrationStatements}=await import('../../src/staging-migrations.js');
  const markerSql=stagingMigrationStatements('wrangler-4.149.0-initial').filter(s=>/^(CREATE TABLE database_environment|INSERT INTO database_environment|CREATE TRIGGER environment_no_)/.test(s));
  await db.batch([db.prepare('DROP TABLE database_environment'),...markerSql.map(s=>db.prepare(s))]);
  assert.deepEqual(await rows(h),clean);
  for(const alter of [(headers:Record<string,string>)=>{delete headers['Cf-Access-Jwt-Assertion'];},(headers:Record<string,string>)=>{headers['Cf-Access-Jwt-Assertion']='garbage';},(headers:Record<string,string>)=>{headers['apacely-signature']='A'.repeat(43);},(headers:Record<string,string>)=>{headers['apacely-source']='foreign-source';}]){
   const init=await signed(c,body,'bad-auth');alter(init.headers);await send(h,init,401);assert.deepEqual(await rows(h),clean);
  }
  assert.deepEqual(h.blocked,[]);assert.deepEqual(await snapshot('bad-auth'),born);
  h=await switchTo('sealed');const first=await signed(c,body,'nonce-a');
  await send(h,first,200);assert.equal(h.jwks(),1,'accepted input requires one Access key retrieval');const accepted=await rows(h);
  for(const table of ['leads','conversations','events','messages','qualification_state','action_outbox','replay_ledger'])assert.equal(accepted[table].length,1,table);
  assert.equal(accepted.events[0].tenant_id,tenants.a);assert.equal(accepted.events[0].source_binding,'mock-source-a');
  assert.equal(JSON.parse(accepted.events[0].normalized_payload).environment,'staging');
  assert.equal(accepted.action_outbox[0].environment,'staging');assert.equal(accepted.action_outbox[0].status,'pending');assert.equal(accepted.action_outbox[0].attempts,0);assert.equal(accepted.action_outbox[0].recorded_at,null);
  await send(h,first,200);assert.equal(h.jwks(),2,'exact replay still authenticates');assert.deepEqual(await rows(h),accepted,'exact replay must not mutate D1');
  await send(h,await signed(c,JSON.stringify({...fixture,occurred_at:JSON.parse(body).occurred_at,text:'conflicting signed text'}),'nonce-a'),409);
  assert.equal(h.jwks(),3,'valid signed nonce conflict still authenticates');assert.deepEqual(await rows(h),accepted,'nonce conflict must not mutate D1');
  await send(h,await signed(c,JSON.stringify({...JSON.parse(body),tenant_id:tenants.b}),'forged-tenant'),400);
  assert.deepEqual(await rows(h),accepted,'foreign tenant claim must not mutate D1');assert.equal(h.jwks(),3,'strict body schema rejects tenant forgery before authentication');assert.deepEqual(h.blocked,[]);
  const stateA=await snapshot('tenant-a');const parsedA=JSON.parse(new Map(stateA).get('distributed-admission/state/v1') as string);
  assert.equal(parsedA.aggregateLive,0);assert.equal(parsedA.registry.length,3);for(const record of parsedA.registry){assert.equal(record.state,'RELEASED');assert.equal(record.handle.context.authority.tenant,tenants.a);}
  h=await switchTo('sealed','b');const second=await signed(c,body,'nonce-b','b');await send(h,second,200);
  const two=await rows(h);for(const table of ['leads','conversations','events','messages','qualification_state','action_outbox','replay_ledger']){
   assert.equal(two[table].length,2,table);assert.deepEqual(two[table].filter(row=>row.tenant_id===tenants.a),accepted[table],table+' A immutable');assert.equal(two[table].filter(row=>row.tenant_id===tenants.b).length,1,table+' B isolated');
  }
  assert.deepEqual(new Set(two.events.map(row=>row.source_event_id)),new Set([fixture.source_event_id]));
  for(const row of two.action_outbox){assert.equal(row.environment,'staging');assert.equal(row.status,'pending');assert.equal(row.attempts,0);assert.equal(row.recorded_at,null);}
  assert.deepEqual(h.blocked,[]);const final=await snapshot('two-tenants');const state=JSON.parse(new Map(final).get('distributed-admission/state/v1') as string);
  assert.equal(state.aggregateLive,0);assert.equal(state.registry.length,4);for(const record of state.registry)assert.equal(record.state,'RELEASED');
  assert.deepEqual(new Set(state.registry.map((record:any)=>record.handle.context.authority.tenant)),new Set([tenants.a,tenants.b]));
  assert.equal(new Map(final).get('distributed-admission/birth/v1'),new Map(born).get('distributed-admission/birth/v1'));
  // Restart the exact sealed artifact again; reads are captured before disposal, not inferred from status.
  h=await switchTo('sealed','b');assert.deepEqual(await rows(h),two);await send(h,second,200);assert.deepEqual(await rows(h),two);
  await snapshot('restart-replay');await evidence(persist,'outcome',{status:'PASS',localOnly:true,remoteQualified:false});
 }catch(error){
  if(h){try{await evidence(persist,'failure-d1',{state:await rows(h)});}catch{await evidence(persist,'failure-d1',{state:'UNKNOWN'});}}
  await evidence(persist,'outcome',{status:'FAIL',message:error instanceof Error?error.message:'unknown'});throw error;
 }finally{if(h)await h.mf.dispose();c.erase();}
});
