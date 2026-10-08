import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

async function run(code:string,afterRestart?:string){
 const bundle=await build({stdin:{resolveDir:process.cwd(),contents:`
 import {WorkerEntrypoint} from 'cloudflare:workers';
 import {D1Repository} from './src/d1-repository.ts';
 import {D1SourceMappingStore} from './src/source-mappings.ts';
 import {Ingress} from './src/worker-ingress.ts';
 import {fixture} from './src/fixture.ts';
 import {Processor,Registry} from './src/process-inbound.ts';
 import {D1ReplayLedger} from './src/replay-ledger.ts';
 export default class extends WorkerEntrypoint {async verify(){
 const check=(x,m)=>{if(!x)throw new Error(m)},db=this.env.DB,now=()=>new Date().toISOString();
 const repo=new D1Repository(db,now),store=new D1SourceMappingStore(db,now),ledger=new D1ReplayLedger(db,now);
 const t1=await repo.createTenant('Synthetic one'),t2=await repo.createTenant('Synthetic two');
 const mapping=await store.create({provider:'synthetic',source:'source-one',principal:'actor-one',tenant_id:t1.id,source_binding:'mock-source-001',environment:'development',operation:'ingest_mock_lead'});
 const claim={authority:mapping,nonce:'nonce-one',fingerprint:'a'.repeat(64),signed_at:now()};
 ${code}
 return true;
 } async recover(){
 const check=(x,m)=>{if(!x)throw new Error(m)},db=this.env.DB,now=()=>new Date().toISOString();
 const repo=new D1Repository(db,now),store=new D1SourceMappingStore(db,now),ledger=new D1ReplayLedger(db,now);
 const mapping=await db.prepare('SELECT * FROM source_mappings LIMIT 1').first();
 const row=await db.prepare('SELECT * FROM replay_ledger LIMIT 1').first();
 const claim={authority:mapping,nonce:'nonce-one',fingerprint:row.fingerprint,signed_at:new Date(row.signed_at).toISOString()};
 ${afterRestart??''}
 return true;
 }} `},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:workers'],metafile:true});
 assert.ok(Object.keys(bundle.metafile!.inputs).every(p=>!/(better-sqlite3|src\/repository|node:)/.test(p)));
 const directory=mkdtempSync(join(tmpdir(),'apacely-replay-'));
 const options={modules:true,script:bundle.outputFiles![0].text,compatibilityDate:'2025-07-18',compatibilityFlags:[],d1Databases:['DB'],d1Persist:directory,host:'127.0.0.1',cf:false,outboundService:()=>{throw new Error('External access forbidden');}};
 let local=new Miniflare(options);
 try{const db=await local.getD1Database('DB');await db.exec(readFileSync(new URL('../../src/schema.sql',import.meta.url),'utf8').replace(/--[^\n]*/g,'').replaceAll('\n',' '));assert.equal(await (await local.getWorker() as unknown as {verify():Promise<boolean>}).verify(),true);assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);if(afterRestart){await local.dispose();local=new Miniflare(options);assert.equal(await (await local.getWorker() as unknown as {recover():Promise<boolean>}).recover(),true);}}finally{await local.dispose();rmSync(directory,{recursive:true,force:true});}
}

test('application clock jump after durable claim rejects acceptance at snapshot',()=>run(`
 let time=now();const clock=()=>time;
 const localLedger=new D1ReplayLedger(db,clock);
 const replay={authorityBinding:()=>db,claim:async input=>{const result=await localLedger.claim(input);time=new Date(Date.parse(time)+400000).toISOString();return result;}};
 const deps={repo:new D1Repository(db,clock),mappings:store,replay,now,log:()=>{},verifier:{verify:async x=>({...x,principal:mapping.principal,source:mapping.source,signed_at:claim.signed_at,nonce:claim.nonce})}};
 const response=await new Ingress(deps).handle(new Request('https://local.invalid/v1/ingress/synthetic',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(fixture)}));
 check(response.status===401,'application clock expiry admitted');
 check((await db.prepare('SELECT count(*) n FROM replay_ledger').first()).n===1,'durable claim lost');
 check((await db.prepare('SELECT count(*) n FROM events').first()).n===0&&(await db.prepare('SELECT count(*) n FROM action_outbox').first()).n===0,'expired effects');
`));

test('application clock jump during planning rejects write without renewing admission',()=>run(`
 const result=await ledger.claim(claim),deadline=result.admission.deadline;let time=now();
 const localRepo=new D1Repository(db,()=>time),scope={tenant_id:t1.id,environment:'development'};
 const processor=new Processor(localRepo,new Registry([[mapping.source_binding,t1.id]]),{checkpoint:step=>{if(step==='before_commit')time=new Date(deadline+1).toISOString();}});
 let error;try{await processor.process({environment:'development',source_binding:mapping.source_binding,operation:'ingest_mock_lead'},fixture,mapping,result.admission);}catch(e){error=e;}
 check(error?.code==='expired','planning jump admitted');
 check((await db.prepare('SELECT deadline FROM replay_ledger').first()).deadline===deadline,'deadline renewed');
 check((await db.prepare('SELECT count(*) n FROM events').first()).n===0&&(await db.prepare('SELECT count(*) n FROM action_outbox').first()).n===0,'planning effects');
`));

test('claim retries refresh the clock but never renew the original deadline',()=>run(`
 let time=now(),attempts=0,original;
 const binding={prepare:db.prepare.bind(db),batch:async statements=>{attempts++;const result=await db.batch(statements);if(attempts===1){original=(await db.prepare('SELECT deadline FROM replay_ledger').first()).deadline;time=new Date(original+1).toISOString();throw new Error('D1_ERROR: Network connection lost.');}return result;}};
 const result=await new D1ReplayLedger(binding,()=>time).claim(claim);
 check(attempts===2&&result.outcome==='expired'&&!result.admission,'stale retry clock admitted');
 check((await db.prepare('SELECT deadline FROM replay_ledger').first()).deadline===original,'retry renewed deadline');
 check((await db.prepare('SELECT count(*) n FROM events').first()).n===0,'claim effects');
`));

test('duplicate replay observes current application clock at its coherent snapshot',()=>run(`
 let time=now(),jump=false,deadline;const clock=()=>time,localLedger=new D1ReplayLedger(db,clock);
 const replay={authorityBinding:()=>db,claim:async input=>{const result=await localLedger.claim(input);deadline??=result.admission.deadline;if(jump)time=new Date(deadline+1).toISOString();return result;}};
 const deps={repo:new D1Repository(db,clock),mappings:store,replay,now,log:()=>{},verifier:{verify:async x=>({...x,principal:mapping.principal,source:mapping.source,signed_at:claim.signed_at,nonce:claim.nonce})}};
 const request=()=>new Request('https://local.invalid/v1/ingress/synthetic',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(fixture)});
 check((await new Ingress(deps).handle(request())).status===200,'initial acceptance');jump=true;
 check((await new Ingress(deps).handle(request())).status===401,'expired duplicate replay');
 check((await db.prepare('SELECT deadline FROM replay_ledger').first()).deadline===deadline,'duplicate renewal');
 check((await db.prepare('SELECT count(*) n FROM events').first()).n===1&&(await db.prepare('SELECT count(*) n FROM action_outbox').first()).n===1,'duplicate effects');
`));

test('acceptance retry observes application clock without extending admission',()=>run(`
 const admitted=await ledger.claim(claim);let time=now(),batches=0;
 const binding={prepare:db.prepare.bind(db),batch:async statements=>{if(++batches===2){time=new Date(admitted.admission.deadline+1).toISOString();throw new Error('D1_ERROR: Network connection lost.');}return db.batch(statements);}};
 const processor=new Processor(new D1Repository(binding,()=>time),new Registry([[mapping.source_binding,t1.id]]));
 let error;try{await processor.process({environment:'development',source_binding:mapping.source_binding,operation:'ingest_mock_lead'},fixture,mapping,admitted.admission);}catch(e){error=e;}
 check(error?.code==='expired'&&batches===3,'stale acceptance retry');
 check((await db.prepare('SELECT deadline FROM replay_ledger').first()).deadline===admitted.admission.deadline,'acceptance renewal');
 check((await db.prepare('SELECT count(*) n FROM events').first()).n===0&&(await db.prepare('SELECT count(*) n FROM action_outbox').first()).n===0,'retry effects');
`));

test('invalid injected acceptance clocks fail safely before business writes',()=>run(`
 const admitted=await ledger.claim(claim);
 for(const value of ['invalid','2026-02-30T00:00:00.000Z','2026-01-01T00:00:00+00:00']){
  const localRepo=new D1Repository(db,()=>value);let planned=false,error;
  try{await localRepo.accept({tenant_id:t1.id,environment:'development'},()=>{planned=true;},{source_binding:mapping.source_binding,source_event_id:fixture.source_event_id,source_lead_id:fixture.source_lead_id},mapping,admitted.admission);}catch(e){error=e;}
  check(error?.code==='validation'&&!planned,'invalid snapshot clock');
  let time=now();const processor=new Processor(new D1Repository(db,()=>time),new Registry([[mapping.source_binding,t1.id]]),{checkpoint:step=>{if(step==='before_commit')time=value;}});
  error=undefined;try{await processor.process({environment:'development',source_binding:mapping.source_binding,operation:'ingest_mock_lead'},fixture,mapping,admitted.admission);}catch(e){error=e;}
  check(error?.code==='validation','invalid write clock');
 }
 check((await db.prepare('SELECT count(*) n FROM events').first()).n===0&&(await db.prepare('SELECT count(*) n FROM action_outbox').first()).n===0,'invalid clock effects');
`));

test('true workerd restart recovers claim-only reservation and accepts exactly once',()=>run(`
 const logs=[],deps={repo,mappings:store,replay:ledger,now,log:x=>logs.push(x),verifier:{verify:async x=>({...x,principal:mapping.principal,source:mapping.source,signed_at:claim.signed_at,nonce:claim.nonce})}};
 const claimOnly={...repo, id:repo.id.bind(repo),now:repo.now.bind(repo),assertScope:repo.assertScope.bind(repo),authorityBinding:()=>db,replayBinding:()=>db,accept:async()=>{throw new Error('synthetic interruption after claim');}};
 const response=await new Ingress({...deps,repo:claimOnly}).handle(new Request('https://local.invalid/v1/ingress/synthetic',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(fixture)}));
 check(response.status===500&&logs[0].replay_outcome==='first','claim interruption');
 check((await db.prepare('SELECT count(*) n FROM replay_ledger').first()).n===1,'claim missing');
 check((await db.prepare('SELECT count(*) n FROM events').first()).n===0&&(await db.prepare('SELECT count(*) n FROM action_outbox').first()).n===0,'claim-only business rows');
`, `
 const deadline=row.deadline,logs=[],deps={repo,mappings:store,replay:ledger,now,log:x=>logs.push(x),verifier:{verify:async x=>({...x,principal:mapping.principal,source:mapping.source,signed_at:claim.signed_at,nonce:claim.nonce})}};
 check(Date.now()<deadline,'restart exceeded original real deadline');
 check((await db.prepare('SELECT count(*) n FROM events').first()).n===0&&(await db.prepare('SELECT count(*) n FROM action_outbox').first()).n===0,'not claim-only restart');
 const request=()=>new Request('https://local.invalid/v1/ingress/synthetic',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(fixture)});
 const first=await new Ingress(deps).handle(request()),second=await new Ingress(deps).handle(request());
 check(first.status===200&&second.status===200&&(await first.json()).event_id===(await second.json()).event_id,'claim-only recovery');
 check(logs.every(x=>x.replay_outcome==='identical'),'claim not recovered identically');
 check((await db.prepare('SELECT deadline FROM replay_ledger').first()).deadline===deadline,'restart renewed deadline');
 check((await db.prepare('SELECT count(*) n FROM events').first()).n===1&&(await db.prepare('SELECT count(*) n FROM action_outbox').first()).n===1,'restart duplicate effects');
`));

test('durable first claim and independent identical retry preserve immutable admission',()=>run(`
 const first=await ledger.claim(claim),same=await new D1ReplayLedger(db,now).claim(claim);
 check(first.outcome==='first'&&same.outcome==='identical','claim outcomes');
 check(JSON.stringify(first.admission)===JSON.stringify(same.admission),'retry refreshed deadline');
 check((await db.prepare('SELECT count(*) n FROM replay_ledger').first()).n===1,'duplicate ledger');
 const row=await db.prepare('SELECT * FROM replay_ledger').first();
 check(!JSON.stringify(row).includes('nonce-one')&&!JSON.stringify(row).includes('actor-one'),'raw identity retained');
`));

test('expired claims reject and bounded tenant cleanup retains terminal reservations',()=>run(`
 const stale={...claim,signed_at:new Date(Date.now()-300001).toISOString()};
 check((await ledger.claim(stale)).outcome==='expired','stale admitted');
 check((await db.prepare('SELECT count(*) n FROM replay_ledger').first()).n===0,'stale stored');
 await ledger.claim(claim);
 const future=new D1ReplayLedger(db,()=>new Date(Date.now()+400000).toISOString());
 check((await future.claim(claim)).outcome==='expired','expired retry admitted');
 await future.expire({tenant_id:t2.id,environment:'development'},10);
 check((await db.prepare('SELECT expired FROM replay_ledger').first()).expired===0,'foreign cleanup');
 check(await future.expire({tenant_id:t1.id,environment:'development'},1)===1,'bounded cleanup');
 const reused=await ledger.claim({...claim,signed_at:now(),fingerprint:'b'.repeat(64)});
 check(reused.outcome==='expired'&&!reused.admission,'tombstone resurrected');
 let denied=false;try{await db.prepare('DELETE FROM replay_ledger').run();}catch{denied=true;}check(denied,'delete reservation');
 const row=await db.prepare('SELECT * FROM replay_ledger').first(),keys=Object.keys(row);
 denied=false;try{await db.prepare('INSERT OR REPLACE INTO replay_ledger ('+keys.join(',')+') VALUES ('+keys.map(()=>'?').join(',')+')').bind(...Object.values(row)).run();}catch{denied=true;}check(denied,'replace reservation');
`));

test('atomic claim denies stale complete authority after revoke and tenant reassignment',()=>run(`
 await store.revoke({tenant_id:t1.id,environment:'development'},mapping.id,1);
 let error;try{await ledger.claim(claim);}catch(e){error=e;}
 check(error?.name==='ReplayStoreError'&&error.code==='denied','revoked claim persisted');
 check((await db.prepare('SELECT count(*) n FROM replay_ledger').first()).n===0,'unauthorized nonce');
`));

test('ingress uses durable ledger and closed provider category replay diagnostics',()=>run(`
 const logs=[],deps={repo,mappings:store,replay:ledger,now,log:x=>logs.push(x),verifier:{verify:async x=>({...x,principal:mapping.principal,source:mapping.source,signed_at:claim.signed_at,nonce:claim.nonce})}};
 const request=()=>new Request('https://local.invalid/v1/ingress/synthetic',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(fixture)});
 const a=await new Ingress(deps).handle(request()),b=await new Ingress(deps).handle(request());
 check(a.status===200&&b.status===200,'durable ingress');
 check((await a.json()).event_id===(await b.json()).event_id,'identical effect');
 check(logs[0].provider_category==='synthetic'&&logs[0].replay_outcome==='first'&&logs[1].replay_outcome==='identical'&&logs[0].failure_category==='none','closed diagnostics');
 const wrong=new D1ReplayLedger({prepare:db.prepare.bind(db),batch:db.batch.bind(db)},now);
 check((await new Ingress({...deps,replay:wrong}).handle(request())).status===403,'ledger binding mismatch');
 check((await db.prepare('SELECT count(*) n FROM action_outbox').first()).n===1,'duplicate intent');
`));

test('atomic acceptance cutoff rejects a claim that expires while batch is in flight',()=>run(`
 const signed=new Date(Date.now()-299000).toISOString();
 let blocked=false;
 const binding={prepare:db.prepare.bind(db),batch:async s=>{if(s.length>9&&!blocked){blocked=true;await new Promise(r=>setTimeout(r,1200));}return db.batch(s);}};
 const localRepo=new D1Repository(binding,now),localStore=new D1SourceMappingStore(binding,now),localLedger=new D1ReplayLedger(binding,now);
 const deps={repo:localRepo,mappings:localStore,replay:localLedger,now,log:()=>{},verifier:{verify:async x=>({...x,principal:mapping.principal,source:mapping.source,signed_at:signed,nonce:claim.nonce})}};
 const response=await new Ingress(deps).handle(new Request('https://local.invalid/v1/ingress/synthetic',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(fixture)}));
 check(blocked&&response.status===401,'expired in-flight acceptance');
 check((await db.prepare('SELECT count(*) n FROM events').first()).n===0,'stale business effect');
`));

test('lost durable claim response recovers as identical within bounded whole claim retry',()=>run(`
 let attempts=0;
 const binding={prepare:db.prepare.bind(db),batch:async s=>{const result=await db.batch(s);if(++attempts===1)throw new Error('D1_ERROR: Network connection lost.');return result;}};
 const recovered=await new D1ReplayLedger(binding,now).claim(claim);
 check(attempts===2&&recovered.outcome==='identical','ambiguous claim retry');
 check((await db.prepare('SELECT count(*) n FROM replay_ledger').first()).n===1,'claim duplicated');
 let exhausted=0;
 const lost={prepare:db.prepare.bind(db),batch:async s=>{await db.batch(s);exhausted++;throw new Error('D1_ERROR: Network connection lost.');}};
 let error;try{await new D1ReplayLedger(lost,now).claim(claim);}catch(e){error=e;}
 check(error?.code==='unavailable'&&exhausted===4,'claim budget');
 check((await ledger.claim(claim)).outcome==='identical','exhaustion erased durable claim');
 check((await db.prepare('SELECT count(*) n FROM events').first()).n===0,'claim alone authorizes business');
`));

test('ledger validates bounded immutable inputs and sanitizes maintenance failures',()=>run(`
 for(const patch of [{nonce:''},{nonce:'x'.repeat(129)},{fingerprint:'invalid'},{signed_at:'invalid'},{authority:{...mapping,version:0}},{authority:{...mapping,tenant_id:t2.id}},{authority:{...mapping,environment:'production'}}]){
  let error;try{await ledger.claim({...claim,...patch});}catch(e){error=e;}check(error?.name==='ReplayStoreError'&&error.code==='denied','invalid ledger input');
 }
 const bad=new D1ReplayLedger(db,()=>{throw new Error('private clock credential');});
 for(const work of [()=>bad.claim(claim),()=>bad.expire({tenant_id:t1.id,environment:'development'},1)]){
  let error;try{await work();}catch(e){error=e;}check(error?.name==='ReplayStoreError'&&error.code==='failure'&&!String(error).includes('private'),'clock leaked');
 }
 check((await db.prepare('SELECT count(*) n FROM replay_ledger').first()).n===0,'invalid ledger rows');
`));

test('signed timestamp is pinned independently of caller request fingerprint',()=>run(`
 await ledger.claim(claim);
 const result=await ledger.claim({...claim,signed_at:new Date(Date.parse(claim.signed_at)+1).toISOString()});
 check(result.outcome==='conflict'&&!result.admission,'signed timestamp rebound');
`));

test('claim SQL denies expiry crossing during transport before any durable reservation',()=>run(`
 const late={...claim,signed_at:new Date(Date.now()-299000).toISOString()};
 const binding={prepare:db.prepare.bind(db),batch:async s=>{await new Promise(r=>setTimeout(r,1200));return db.batch(s);}};
 const result=await new D1ReplayLedger(binding,now).claim(late);
 check(result.outcome==='expired','late claim admitted');
 check((await db.prepare('SELECT count(*) n FROM replay_ledger').first()).n===0,'expired insert committed');
`));

test('database clock rejects a future signed timestamp even when the injected clock is ahead',()=>run(`
 const futureTime=new Date(Date.now()+60000).toISOString();
 const ahead=new D1ReplayLedger(db,()=>futureTime);
 check((await ahead.claim({...claim,signed_at:futureTime})).outcome==='expired','database future skew');
 check((await db.prepare('SELECT count(*) n FROM replay_ledger').first()).n===0,'future reserved');
`));

test('final atomic freshness assertion rolls back business writes if admission expires inside acceptance',()=>run(`
 const queries=new WeakMap();let injected=false;
 const binding={prepare:sql=>{const stmt=db.prepare(sql);if(!sql.includes('?')){queries.set(stmt,sql);return stmt;}return {bind:(...v)=>{const bound=stmt.bind(...v);queries.set(bound,sql);return bound;},all:stmt.all.bind(stmt),run:stmt.run.bind(stmt)};},batch:async s=>{
  if(s.length>9&&!injected){injected=true;const guards=s.map((x,i)=>queries.get(x)?.startsWith('INSERT INTO replay_assertions')?i:-1).filter(i=>i>=0);const at=guards.length>1?guards.at(-1):s.length;
   s.splice(at,0,db.prepare('UPDATE replay_ledger SET expired=1 WHERE tenant_id=? AND expired=0').bind(t1.id));}
  return db.batch(s);
 }};
 const deps={repo:new D1Repository(binding,now),mappings:new D1SourceMappingStore(binding,now),replay:new D1ReplayLedger(binding,now),now,log:()=>{},verifier:{verify:async x=>({...x,principal:mapping.principal,source:mapping.source,signed_at:claim.signed_at,nonce:claim.nonce})}};
 const response=await new Ingress(deps).handle(new Request('https://local.invalid/v1/ingress/synthetic',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(fixture)}));
 check(injected&&response.status===401,'expired before final commit');
 check((await db.prepare('SELECT count(*) n FROM events').first()).n===0&&(await db.prepare('SELECT count(*) n FROM action_outbox').first()).n===0,'partial expired acceptance');
 check((await db.prepare('SELECT expired FROM replay_ledger').first()).expired===0,'batch rollback failed');
`));

test('maximum in-flight admission is anchored to database time not a faster application clock',()=>run(`
 const ahead=new D1ReplayLedger(db,()=>new Date(Date.now()+15000).toISOString());
 const before=Date.now(),result=await ahead.claim(claim);
 check(result.outcome==='first'&&result.admission.deadline<=Date.now()+30000,'in-flight lifetime extended by application clock');
 check(result.admission.deadline>=before+29000,'unexpected admission policy');
`));

test('malformed trusted ledger claim shapes produce only sanitized typed denial',()=>run(`
 for(const input of [null,undefined,{}, {authority:null}]){
  let error;try{await ledger.claim(input);}catch(e){error=e;}check(error?.name==='ReplayStoreError'&&error.code==='denied','malformed raw exception');
 }
`));

test('cleanup limit and terminal immutability preserve every tenant-owned reservation',()=>run(`
 for(let i=0;i<3;i++)await ledger.claim({...claim,nonce:'nonce-'+i});
 const future=new D1ReplayLedger(db,()=>new Date(Date.now()+400000).toISOString());
 check(await future.expire({tenant_id:t1.id,environment:'development'},2)===2,'cleanup exceeded batch limit');
 check((await db.prepare('SELECT count(*) n FROM replay_ledger WHERE expired=1').first()).n===2,'bounded tombstones');
 let denied=false;try{await db.prepare('UPDATE replay_ledger SET expired=0 WHERE expired=1').run();}catch{denied=true;}check(denied,'tombstone revival');
 denied=false;try{await db.prepare("UPDATE replay_ledger SET fingerprint=? WHERE expired=0").bind('b'.repeat(64)).run();}catch{denied=true;}check(denied,'mutable fingerprint');
 for(const limit of [0,101,-1,1.5]){denied=false;try{await future.expire({tenant_id:t1.id,environment:'development'},limit);}catch(e){denied=e.code==='denied';}check(denied,'unbounded cleanup');}
 check((await db.prepare('SELECT count(*) n FROM replay_ledger').first()).n===3,'reservation deletion');
`));

test('arbitrary provider route and private injected errors never enter closed logs',()=>run(`
 const logs=[],deps={repo,mappings:store,replay:ledger,now,log:x=>logs.push(x),verifier:{verify:async()=>{throw new Error('private principal payload SQL nonce');}}};
 const response=await new Ingress(deps).handle(new Request('https://local.invalid/v1/ingress/private_provider_token',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(fixture)}));
 check(response.status===500&&logs[0].provider_category==='other'&&logs[0].failure_category==='internal'&&logs[0].replay_outcome==='not_claimed','safe category');
 check(!JSON.stringify([logs,await response.json()]).includes('private'),'provider or exception logged');
 check((await db.prepare('SELECT count(*) n FROM replay_ledger').first()).n===0,'unverified ledger');
`));

test('zero retry claim response loss preserves reservation for explicit recovery',()=>run(`
 let attempts=0;const binding={prepare:db.prepare.bind(db),batch:async s=>{await db.batch(s);attempts++;throw new Error('D1_ERROR: Network connection lost.');}};
 let error;try{await new D1ReplayLedger(binding,now,0).claim(claim);}catch(e){error=e;}
 check(error?.code==='unavailable'&&attempts===1,'zero budget reconciliation loop');
 check((await ledger.claim(claim)).outcome==='identical','last-attempt durable response loss');
 check((await db.prepare('SELECT count(*) n FROM events').first()).n===0,'claim business writes');
`));

test('same scoped nonce conflicts on changed fingerprint or mapping version without foreign disclosure',()=>run(`
 await ledger.claim(claim);
 check((await ledger.claim({...claim,fingerprint:'b'.repeat(64)})).outcome==='conflict','changed request accepted');
 const changed=await store.update({tenant_id:t1.id,environment:'development'},mapping.id,1,{status:'active'});
 const conflict=await ledger.claim({...claim,authority:changed});
 check(conflict.outcome==='conflict'&&!conflict.admission,'version rebound');
`));


test('many independent identical ingress requests commit one event and outbox',()=>run(`
 const logs=[],deps={repo,mappings:store,replay:ledger,now,log:x=>logs.push(x),verifier:{verify:async x=>({...x,principal:mapping.principal,source:mapping.source,signed_at:claim.signed_at,nonce:claim.nonce})}};
 const responses=await Promise.all(Array.from({length:16},()=>new Ingress({...deps,repo:new D1Repository(db,now),replay:new D1ReplayLedger(db,now)}).handle(new Request('https://local.invalid/v1/ingress/synthetic',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(fixture)}))));
 check(responses.every(r=>r.status===200),'identical concurrent requests');
 const events=await Promise.all(responses.map(r=>r.json()));check(new Set(events.map(x=>x.event_id)).size===1,'different event responses');
 check(logs.filter(x=>x.replay_outcome==='first').length===1&&logs.filter(x=>x.replay_outcome==='identical').length===15,'claim concurrency');
 check((await db.prepare('SELECT count(*) n FROM events').first()).n===1&&(await db.prepare('SELECT count(*) n FROM action_outbox').first()).n===1,'duplicate actions');
`));

test('many conflicting arrivals have one durable identity winner and no losing business effect',()=>run(`
 const deps={repo,mappings:store,replay:ledger,now,log:()=>{},verifier:{verify:async x=>({...x,principal:mapping.principal,source:mapping.source,signed_at:claim.signed_at,nonce:claim.nonce})}};
 const responses=await Promise.all(Array.from({length:16},(_,i)=>new Ingress({...deps,replay:new D1ReplayLedger(db,now)}).handle(new Request('https://local.invalid/v1/ingress/synthetic',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...fixture,text:i%2?'changed':fixture.text})}))));
 check(responses.filter(r=>r.status===200).length===8&&responses.filter(r=>r.status===409).length===8,'conflict concurrency');
 check((await db.prepare('SELECT count(*) n FROM replay_ledger').first()).n===1&&(await db.prepare('SELECT count(*) n FROM events').first()).n===1&&(await db.prepare('SELECT count(*) n FROM action_outbox').first()).n===1,'losing effects');
`));

test('true workerd restart recovers durable nonce and accepted event without a second outbox',()=>run(`
 const deps={repo,mappings:store,replay:ledger,now,log:()=>{},verifier:{verify:async x=>({...x,principal:mapping.principal,source:mapping.source,signed_at:claim.signed_at,nonce:claim.nonce})}};
 const response=await new Ingress(deps).handle(new Request('https://local.invalid/v1/ingress/synthetic',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(fixture)}));check(response.status===200,'before restart');
`, `
 check((await ledger.claim(claim)).outcome==='identical','nonce lost on restart');
 check((await ledger.claim({...claim,fingerprint:'b'.repeat(64)})).outcome==='conflict','conflict lost on restart');
 const deps={repo,mappings:store,replay:ledger,now,log:()=>{},verifier:{verify:async x=>({...x,principal:mapping.principal,source:mapping.source,signed_at:claim.signed_at,nonce:claim.nonce})}};
 const previous=await db.prepare('SELECT id FROM events').first();
 const response=await new Ingress(deps).handle(new Request('https://local.invalid/v1/ingress/synthetic',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(fixture)}));check(response.status===200&&(await response.json()).event_id===previous.id,'accepted recovery');
 check((await db.prepare('SELECT count(*) n FROM action_outbox').first()).n===1,'restart duplicate action');
`));

test('current tenant reassignment cannot resurrect a nonce or disclose the original owner',()=>run(`
 await ledger.claim(claim);
 await db.prepare('UPDATE source_mappings SET tenant_id=?,version=version+1,updated_at=? WHERE id=?').bind(t2.id,now(),mapping.id).run();
 const moved=(await store.resolve(mapping))[0];
 const result=await ledger.claim({...claim,authority:moved});check(result.outcome==='conflict'&&Object.keys(result).join(',')==='outcome','foreign reservation disclosure');
 check((await db.prepare('SELECT count(*) n FROM replay_ledger WHERE tenant_id=?').bind(t2.id).first()).n===0,'foreign ledger effect');
`));

test('unknown permanent deep and cyclic D1 failures never receive blind claim retries',()=>run(`
 const permanent=new Error('D1_ERROR: FOREIGN KEY constraint failed private SQL'),unknown=new Error('D1_ERROR: Network connection lost. private');
 const deep=new Error('D1_ERROR',{cause:new Error('Network connection lost.',{cause:new Error('Network connection lost.',{cause:new Error('Network connection lost.',{cause:permanent})})})});
 const cyclic=new Error('D1_ERROR: Network connection lost.');cyclic.cause=cyclic;
 for(const failure of [permanent,unknown,deep,cyclic]){
  let attempts=0;const binding={prepare:db.prepare.bind(db),batch:async()=>{attempts++;throw failure;}};
  let error;try{await new D1ReplayLedger(binding,now).claim(claim);}catch(e){error=e;}check(attempts===1&&error?.code==='failure'&&!String(error).includes('private'),'unsafe error retries');
 }
 check((await db.prepare('SELECT count(*) n FROM replay_ledger').first()).n===0,'failed claim effect');
`));
