import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {environmentStatements} from '../../scripts/environment-schema.js';

test('replay admission explicitly carries exact environment and refuses cross-environment reuse',()=>run(`
 const claim=await replay.claim({authority:mapping,nonce:'admission',fingerprint:'b'.repeat(64),signed_at:mapping.created_at});
 check(claim.admission.environment==='staging','replay environment missing');
 let denied=false;try{await repo.accept({tenant_id:tenant.id,environment:'staging'},()=>true,{source_binding:mapping.source_binding,source_event_id:'x',source_lead_id:'x'},mapping,{...claim.admission,environment:'development'});}catch{denied=true;}
 check(denied,'cross-environment admission accepted');check(await count('events')===0,'unauthorized zero effects');
`));
test('configured HTTP composition requires explicit trusted environment bindings',async()=>{
 const http=await import('../../src/worker-http.js');
 assert.equal(typeof (http as Record<string,unknown>).handleConfiguredWorkerRequest,'function','no implicit development selection in new HTTP composition');
});

test('configured database check belongs to bounded pipeline and retained request lifetime',async()=>{
 const {handleConfiguredWorkerRequest}=await import('../../src/worker-http.js');
 let settle!:()=>void;const gate=new Promise<void>(r=>settle=r);let verified=0;
 const db={prepare:()=>({bind(){return this;},async all(){await gate;return {results:[{valid:1}],success:true};},async run(){}}),async batch(){return [];}};
 const dependencies={repo:{id:()=>crypto.randomUUID(),now:()=>new Date().toISOString(),assertScope:async()=>{},accept:async()=>{},authorityBinding:()=>db,replayBinding:()=>db},mappings:{resolve:async()=>[],authorityBinding:()=>db},replay:{claim:async()=>({outcome:'conflict'}),authorityBinding:()=>db},now:()=>new Date().toISOString(),log:()=>{},verifier:{verify:async()=>{verified++;return null;}}} as unknown as import('../../src/worker-ingress.js').Dependencies;
 const retained:Promise<unknown>[]=[];
 const request=new Request('https://local.invalid/v1/ingress/synthetic',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
 try{
  const work=handleConfiguredWorkerRequest(request,{APACELY_ENVIRONMENT:'staging',APACELY_OPERATION:'ingest_mock_lead',DB:db as unknown as import('../../src/d1-repository.js').D1Binding},dependencies,{waitUntil:p=>retained.push(p)},{deadlineMs:30});
  const result=await Promise.race([work,new Promise<null>(r=>setTimeout(()=>r(null),200))]);
  assert.ok(result,'database check must not escape deadline');assert.equal(result.status,504);assert.equal(retained.length,1);assert.equal(verified,0);
 }finally{settle();await Promise.all(retained);}
});

async function run(code:string){
 const bundle=await build({stdin:{resolveDir:process.cwd(),contents:`
 import {WorkerEntrypoint} from 'cloudflare:workers';
 import {D1Repository} from './src/d1-repository.ts';
 import {D1SourceMappingStore} from './src/source-mappings.ts';
 import {D1ReplayLedger} from './src/replay-ledger.ts';
 import {Ingress} from './src/worker-ingress.ts';
 import {fixture} from './src/fixture.ts';
 export default class extends WorkerEntrypoint {async verify(){
 const check=(x,m)=>{if(!x)throw new Error(m)},now=()=>new Date().toISOString(),db=this.env.DB;
 let hook=async()=>{};const binding={prepare:db.prepare.bind(db),batch:async statements=>{await hook(statements);return db.batch(statements);}};
 const repo=new D1Repository(binding,now,undefined,'staging'),store=new D1SourceMappingStore(binding,now,'staging'),replay=new D1ReplayLedger(binding,now,3,'staging');
 const tenant=await repo.createTenant('Synthetic staging');
 const base={provider:'synthetic',source:'source-one',principal:'actor-one',tenant_id:tenant.id,source_binding:'mock-source-001',environment:'staging',operation:'ingest_mock_lead'};
 const mapping=await store.create(base);
 const dependencies={repo,now,mappings:store,replay,log:()=>{},verifier:{verify:async x=>({...x,principal:base.principal,source:base.source,signed_at:mapping.created_at,nonce:'nonce-one'})}};
 const send=async(input=fixture)=>new Ingress(dependencies,{},'staging').handle(new Request('https://local.invalid/v1/ingress/synthetic',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)}));
 const count=async table=>(await db.prepare('SELECT count(*) n FROM '+table).first()).n;
 ${code}
 return true;}}
 `},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:workers'],metafile:true});
 assert.ok(Object.keys(bundle.metafile!.inputs).every(p=>!/(better-sqlite3|node:|scripts\/)/.test(p)));
 const local=new Miniflare({modules:true,script:bundle.outputFiles![0].text,compatibilityDate:'2025-07-18',compatibilityFlags:[],d1Databases:['DB','EMPTY','DEV'],host:'127.0.0.1',cf:false,outboundService:()=>{throw new Error('External access forbidden');}});
 try{const db=await local.getD1Database('DB');await db.batch(environmentStatements('staging').map(sql=>db.prepare(sql)));const dev=await local.getD1Database('DEV');await dev.batch(environmentStatements('development').map(sql=>dev.prepare(sql)));assert.equal(await (await local.getWorker() as unknown as {verify():Promise<boolean>}).verify(),true);assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);}finally{await local.dispose();}
}
test('physical database marker rejects adapters configured for the other environment before tenant or mapping access',()=>run(`
 const dev=new D1Repository(db,now),foreignStore=new D1SourceMappingStore(db,now),foreignReplay=new D1ReplayLedger(db,now);
 let denied=0;
 for(const work of [()=>dev.createTenant('Wrong environment'),()=>dev.assertScope({tenant_id:tenant.id,environment:'development'}),()=>dev.rows({tenant_id:tenant.id,environment:'development'},'events'),()=>foreignStore.resolve(base),()=>foreignReplay.claim({authority:{...mapping,environment:'development'},nonce:'n',fingerprint:'a'.repeat(64),signed_at:now()})]){try{await work();}catch{denied++;}}
 check(denied===5,'wrong physical environment must deny all adapters');check(await count('tenants')===1&&await count('replay_ledger')===0,'unauthorized zero writes');
`));
test('staging ingress carries exact environment through authority, durable replay, processor and pending outbox',()=>run(`
 const first=await send();check(first.status===200,'staging should accept');const a=await first.json(),same=await send();check(same.status===200&&(await same.json()).event_id===a.event_id,'staging replay');
 const event=await db.prepare('SELECT normalized_payload FROM events').first(),outbox=await db.prepare('SELECT environment,status FROM action_outbox').first();
 check(JSON.parse(event.normalized_payload).environment==='staging'&&outbox.environment==='staging'&&outbox.status==='pending','exact staging metadata');
 check(await count('action_outbox')===1&&await count('replay_ledger')===1,'no duplicate effects');
`));

test('staging identical concurrent independent ingress instances commit one event and intent',()=>run(`
 const responses=await Promise.all(Array.from({length:16},()=>send()));check(responses.every(r=>r.status===200),'sixteen staging accepts');
 const ids=await Promise.all(responses.map(r=>r.json()));check(new Set(ids.map(x=>x.event_id)).size===1,'one immutable outcome');
 check(await count('events')===1&&await count('action_outbox')===1&&await count('replay_ledger')===1,'single durable effect');
`));

test('staging conflicting concurrent independent ingress instances preserve nonce byte identity',()=>run(`
 const responses=await Promise.all(Array.from({length:16},(_,i)=>send(i<8?fixture:{...fixture,text:'changed'})));
 check(responses.filter(r=>r.status===200).length===8&&responses.filter(r=>r.status===409).length===8,'winning bytes only');
 check(await count('events')===1&&await count('action_outbox')===1&&await count('replay_ledger')===1,'one effect');
`));

test('staging authority revocation at actual batch aborts all business writes',()=>run(`
 let revoked=false;hook=async statements=>{if(statements.length>9&&!revoked){revoked=true;await db.prepare("UPDATE source_mappings SET status='revoked',version=version+1,revoked_version=version+1,revoked_at=?,updated_at=? WHERE id=?").bind(now(),now(),mapping.id).run();}};
 check((await send()).status===403&&revoked,'atomic revocation denial');
 for(const table of ['leads','conversations','events','messages','qualification_state','action_outbox'])check(await count(table)===0,'unauthorized '+table);
 check(await count('replay_ledger')===1,'claim retained');
`));

test('staging ambiguous commit response loss exhausts finite budget then reconciles without duplicate effects',()=>run(`
 const accept=repo.accept.bind(repo);let attempts=0;
 repo.accept=async(...args)=>{attempts++;await accept(...args);throw Object.assign(new Error('synthetic response loss'),{code:'D1_TRANSIENT'});};
 check((await send()).status===503&&attempts===4,'four acceptance attempts');
 check(await count('events')===1&&await count('action_outbox')===1,'committed complete unit');
 repo.accept=accept;check((await send()).status===200,'explicit recovery');check(await count('events')===1&&await count('action_outbox')===1,'no duplicate effect');
`));

test('staging mappings and nonce tombstones reject replacement deletion and cross-environment maintenance',()=>run(`
 check((await send()).status===200,'accepted fixture');
 let denied=0;
 for(const sql of ["DELETE FROM source_mappings","INSERT OR REPLACE INTO source_mappings SELECT * FROM source_mappings","DELETE FROM replay_ledger","INSERT OR REPLACE INTO replay_ledger SELECT * FROM replay_ledger","UPDATE replay_ledger SET deadline=deadline+1"]){try{await db.prepare(sql).run();}catch{denied++;}}
 check(denied===5,'permanent guards');
 for(const work of [()=>store.create({...base,source:'dev',environment:'development'}),()=>store.update({tenant_id:tenant.id,environment:'development'},mapping.id,1,{status:'inactive'}),()=>replay.expire({tenant_id:tenant.id,environment:'development'},1)]){let failed=false;try{await work();}catch{failed=true;}check(failed,'foreign environment maintenance');}
 check(await count('source_mappings')===1&&await count('replay_ledger')===1,'unchanged tombstones');
`));

test('staging overlapping tenant external identities remain separate and foreign parent FK writes roll back',()=>run(`
 check((await send()).status===200,'first owner');
 const other=await repo.createTenant('Second synthetic'),m=await store.create({...base,tenant_id:other.id,source:'source-two',source_binding:'source-two'});
 const d={...dependencies,verifier:{verify:async x=>({...x,principal:base.principal,source:'source-two',signed_at:m.created_at,nonce:'nonce-one'})}};
 const r=await new Ingress(d,{},'staging').handle(new Request('https://local.invalid/v1/ingress/synthetic',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(fixture)}));check(r.status===200,'second owner');
 check(await count('events')===2&&await count('action_outbox')===2,'separate identical external IDs');
 const row=await db.prepare('SELECT * FROM action_outbox WHERE tenant_id=?').bind(tenant.id).first();row.id=crypto.randomUUID();row.tenant_id=other.id;
 let denied=false;try{await db.prepare('INSERT INTO action_outbox ('+Object.keys(row).join(',')+') VALUES ('+Object.keys(row).map(()=>'?').join(',')+')').bind(...Object.values(row)).run();}catch{denied=true;}
 check(denied&&await count('action_outbox')===2,'foreign composite parents rejected');
`));

test('all staging adapters deny empty missing-marker databases and misbound development before any writes',()=>run(`
 for(const target of [this.env.EMPTY,this.env.DEV]){
  const r=new D1Repository(target,now,undefined,'staging'),s=new D1SourceMappingStore(target,now,'staging'),l=new D1ReplayLedger(target,now,3,'staging');
  for(const work of [()=>r.createTenant('Forbidden'),()=>r.assertScope({tenant_id:tenant.id,environment:'staging'}),()=>r.rows({tenant_id:tenant.id,environment:'staging'},'events'),()=>r.accept({tenant_id:tenant.id,environment:'staging'},()=>true),()=>s.create(base),()=>s.resolve(base),()=>l.claim({authority:mapping,nonce:'n',fingerprint:'a'.repeat(64),signed_at:now()})]){let denied=false;try{await work();}catch{denied=true;}check(denied,'physical marker must reject');}
 }
 check((await this.env.EMPTY.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()).results.length===0,'no request initialization');
 check((await this.env.DEV.prepare('SELECT count(*) n FROM tenants').first()).n===0,'no dev writes');
`));

test('immutable environment marker rejects SQL update deletion replacement and environment mixing',()=>run(`
 let denied=0;for(const sql of ["UPDATE database_environment SET environment='development'","DELETE FROM database_environment","INSERT OR REPLACE INTO database_environment VALUES (1,'staging')","INSERT INTO database_environment VALUES (2,'staging')","UPDATE source_mappings SET environment='development',version=version+1"]){try{await db.prepare(sql).run();}catch{denied++;}}
 check(denied===5,'immutable marker and staging-only mappings');check((await db.prepare('SELECT environment FROM database_environment').first()).environment==='staging','marker preserved');
`));

test('same overlapping identities in separate development and staging retain independent nonce authority and effects',()=>run(`
 const dev=this.env.DEV;await dev.prepare("INSERT INTO tenants VALUES (?,?,'active',?)").bind(tenant.id,'Synthetic overlapping ID',now()).run();
 const r=new D1Repository(dev,now),s=new D1SourceMappingStore(dev,now),l=new D1ReplayLedger(dev,now);
 const m=await s.create({...base,environment:'development'});
 const d={repo:r,mappings:s,replay:l,now,log:()=>{},verifier:{verify:async x=>({...x,principal:base.principal,source:base.source,signed_at:m.created_at,nonce:'nonce-one'})}};
 const response=await new Ingress(d).handle(new Request('https://local.invalid/v1/ingress/synthetic',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(fixture)}));check(response.status===200&&(await send()).status===200,'both explicit contexts');
 const a=await db.prepare('SELECT nonce_ref FROM replay_ledger').first(),b=await dev.prepare('SELECT nonce_ref FROM replay_ledger').first();check(a.nonce_ref!==b.nonce_ref,'environment-separated nonce key');
 check(await count('action_outbox')===1&&(await dev.prepare('SELECT count(*) n FROM action_outbox').first()).n===1,'independent effects');
 const before=JSON.stringify((await dev.prepare('SELECT * FROM events').all()).results);
 let denied=false;try{await new D1Repository(dev,now,undefined,'staging').rows({tenant_id:tenant.id,environment:'staging'},'events');}catch{denied=true;}
 check(denied&&before===JSON.stringify((await dev.prepare('SELECT * FROM events').all()).results),'no foreign disclosure or mutation');
`));

test('offline D1 bootstrap is atomic at every generated statement and full staging manifest matches canonical development',async()=>{
 const local=new Miniflare({modules:true,script:'export default {fetch(){return new Response("offline test")}}',d1Databases:['DB','DEV'],host:'127.0.0.1',cf:false,outboundService:()=>{throw new Error('External access forbidden');}});
 try{
  const db=await local.getD1Database('DB'),dev=await local.getD1Database('DEV'),statements=environmentStatements('staging');
  for(let i=0;i<=statements.length;i++){
   await assert.rejects(db.batch([...statements.slice(0,i).map(sql=>db.prepare(sql)),db.prepare('INSERT INTO deliberately_absent VALUES (1)'),...statements.slice(i).map(sql=>db.prepare(sql))]));
   assert.deepEqual((await db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all()).results,[],'bootstrap rollback position '+i);
  }
  await db.batch(statements.map(sql=>db.prepare(sql)));await dev.batch(environmentStatements('development').map(sql=>dev.prepare(sql)));
  const manifest=async(target:typeof db)=>(await target.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name").all()).results;
  assert.deepEqual(await manifest(db),JSON.parse(JSON.stringify(await manifest(dev)).replaceAll("'development'","'staging'")));
  for(const table of ['source_mappings','replay_ledger','leads','conversations','events','messages','qualification_state','action_outbox'])assert.deepEqual((await db.prepare('PRAGMA foreign_key_list('+table+')').all()).results,(await dev.prepare('PRAGMA foreign_key_list('+table+')').all()).results);
  const before=await manifest(db);await assert.rejects(db.batch(statements.map(sql=>db.prepare(sql))));assert.deepEqual(await manifest(db),before);
  assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
 }finally{await local.dispose();}
});

test('staging state and outbox roll back after every actual acceptance batch statement',()=>run(`
 let position=0,total=0;
 hook=async statements=>{if(statements.length>9){total=statements.length;await db.batch([...statements.slice(0,position),db.prepare('INSERT INTO deliberately_absent VALUES (1)'),...statements.slice(position)]);}};
 do{
  check((await send()).status===500,'failed actual SQL at '+position);
  for(const table of ['leads','conversations','events','messages','qualification_state','action_outbox','acceptance_assertions','authority_assertions','replay_assertions'])check(await count(table)===0,'rollback '+table+' at '+position);
  position++;
 }while(position<=total);
 hook=async()=>{};check((await send()).status===200,'unchanged durable claim recovery');check(await count('action_outbox')===1,'one pending effect');
`));

test('many staging contenders respect finite admission and never duplicate durable effects',()=>run(`
 const responses=await Promise.all(Array.from({length:64},()=>send()));
 check(responses.filter(r=>r.status===200).length===16&&responses.filter(r=>r.status===503).length===48,'zero queue exact global cap');
 check(await count('events')===1&&await count('action_outbox')===1&&await count('replay_ledger')===1,'single effect under overload');
`));

test('staging expired replay admission is rejected without renewal or business writes',()=>run(`
 let observed=mapping.created_at;const r=new D1Repository(binding,()=>observed,undefined,'staging');
 const claim=await replay.claim({authority:mapping,nonce:'expiry',fingerprint:'c'.repeat(64),signed_at:mapping.created_at});
 observed=new Date(claim.admission.deadline).toISOString();let denied=false;
 try{await r.accept({tenant_id:tenant.id,environment:'staging'},()=>true,{source_binding:mapping.source_binding,source_event_id:'x',source_lead_id:'x'},mapping,claim.admission);}catch(error){denied=error.code==='expired';}
 check(denied&&await count('events')===0,'staging deadline cutoff');
 check((await db.prepare('SELECT deadline FROM replay_ledger').first()).deadline===claim.admission.deadline,'immutable deadline');
`));

test('staging accepted replay still rechecks revoked authority instead of caching success',()=>run(`
 const first=await send();check(first.status===200,'first acceptance');
 await store.revoke({tenant_id:tenant.id,environment:'staging'},mapping.id,mapping.version);
 check((await send()).status===403,'revoked duplicate denied');check(await count('events')===1&&await count('action_outbox')===1&&await count('replay_ledger')===1,'committed outcome retained');
`));

test('misbound staging snapshots cannot retrieve development business rows even inside a failing batch',()=>run(`
 const dev=this.env.DEV;await dev.prepare("INSERT INTO tenants VALUES (?,?,'active',?)").bind(tenant.id,'Synthetic overlapping ID',now()).run();
 const r=new D1Repository(dev,now),s=new D1SourceMappingStore(dev,now),l=new D1ReplayLedger(dev,now),m=await s.create({...base,environment:'development'});
 const d={repo:r,mappings:s,replay:l,now,log:()=>{},verifier:{verify:async x=>({...x,principal:base.principal,source:base.source,signed_at:m.created_at,nonce:'nonce-one'})}};
 check((await new Ingress(d).handle(new Request('https://local.invalid/v1/ingress/synthetic',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(fixture)}))).status===200,'populate development');
 const observed=[];const wrong={prepare:dev.prepare.bind(dev),batch:async statements=>{const results=await dev.batch(statements);observed.push(...results.flatMap(x=>x.results));return results;}};
 const stage=new D1Repository(wrong,now,undefined,'staging');let denied=0;
 for(const work of [()=>stage.rows({tenant_id:tenant.id,environment:'staging'},'events'),()=>stage.accept({tenant_id:tenant.id,environment:'staging'},()=>true,{source_binding:base.source_binding,source_event_id:fixture.source_event_id,source_lead_id:fixture.source_lead_id})]){try{await work();}catch{denied++;}}
 check(denied===2,'wrong marker denial');check(observed.length===0,'foreign business rows must not enter failing snapshots');
`));
