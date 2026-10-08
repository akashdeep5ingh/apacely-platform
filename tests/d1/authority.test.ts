import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {readFileSync} from 'node:fs';
async function run(code:string){
 const bundle=await build({stdin:{resolveDir:process.cwd(),contents:`
 import {WorkerEntrypoint} from 'cloudflare:workers';
 import {D1Repository} from './src/d1-repository.ts';
 import {D1ReplayLedger} from './src/replay-ledger.ts';
 import {D1SourceMappingStore} from './src/source-mappings.ts';
 import {Ingress} from './src/worker-ingress.ts';
 import {Processor,Registry} from './src/process-inbound.ts';
 import {fixture} from './src/fixture.ts';
 export default class extends WorkerEntrypoint {async verify(){
 const check=(x,m)=>{if(!x)throw new Error(m)},now=new Date().toISOString(),db=this.env.DB;
 let hook=async()=>{};
 const binding={prepare:db.prepare.bind(db),batch:async s=>{await hook(s);return db.batch(s);}};
 const repo=new D1Repository(binding,()=>now),store=new D1SourceMappingStore(binding,()=>now);
 const t1=await repo.createTenant('Synthetic one'),t2=await repo.createTenant('Synthetic two');
 const base={provider:'synthetic',source:'source-one',principal:'actor-one',tenant_id:t1.id,source_binding:'mock-source-001',environment:'development',operation:'ingest_mock_lead'};
 const mapping=await store.create(base),logs=[];
 const dependencies={repo,now:()=>now,mappings:store,log:r=>logs.push(r),verifier:{verify:async x=>({...x,principal:base.principal,source:base.source,signed_at:now,nonce:'nonce-one'})},replay:new D1ReplayLedger(binding,()=>now)};
 const request=(input=fixture)=>new Request('https://local.invalid/v1/ingress/synthetic',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
 const send=async(i=new Ingress(dependencies),input=fixture)=>{const r=await i.handle(request(input));return {status:r.status,body:await r.json()};};
 const count=async table=>(await db.prepare('SELECT count(*) n FROM '+table).first()).n;
 const empty=async()=>{for(const table of ['leads','conversations','events','messages','qualification_state','action_outbox'])check(await count(table)===0,'unauthorized '+table);};
 ${code}
 return true;
 }} `},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:workers'],metafile:true});
 assert.ok(Object.keys(bundle.metafile!.inputs).every(p=>!/(better-sqlite3|src\/repository|node:)/.test(p)));
 const local=new Miniflare({modules:true,script:bundle.outputFiles![0].text,compatibilityDate:'2025-07-18',compatibilityFlags:[],d1Databases:['DB'],host:'127.0.0.1',cf:false,outboundService:()=>{throw new Error('External access forbidden');}});
 try{const db=await local.getD1Database('DB');await db.exec(readFileSync(new URL('../../src/schema.sql',import.meta.url),'utf8').replace(/--[^\n]*/g,'').replaceAll('\n',' '));assert.equal(await (await local.getWorker() as unknown as {verify():Promise<boolean>}).verify(),true);assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);}finally{await local.dispose();}
}
test('revocation after planning before D1 acceptance batch aborts every business write',()=>run(`
 let revoked=false;
 hook=async s=>{if(s.length>9&&!revoked){revoked=true;await db.prepare("UPDATE source_mappings SET status='revoked',version=version+1,revoked_version=version+1,revoked_at=?,updated_at=? WHERE tenant_id=? AND id=?").bind(now,now,t1.id,mapping.id).run();}};
 const result=await send();check(result.status===403,'revoked at actual batch must reject');check(revoked,'write checkpoint reached');await empty();
`));
test('persisted versioned source authority accepts through shared core and exact replay',()=>run(`
 check(mapping.version===1&&mapping.status==='active'&&mapping.created_at===now&&mapping.updated_at===now,'versioned mapping');
 const first=await send(),same=await send();check(first.status===200&&same.status===200&&same.body.event_id===first.body.event_id,'authorized replay');
 check(await count('action_outbox')===1,'single outbox');check((await send(new Ingress({...dependencies,log:()=>{throw new Error('private logger failure');}}))).status===200,'logger changed durable replay');
 const found=await store.resolve({provider:base.provider,source:base.source});check(found.length===1&&found[0].id===mapping.id,'persisted lookup');
`));

test('ingress captures collaborators and their methods before verifier await',()=>run(`

 const verify=dependencies.verifier.verify;
 dependencies.verifier.verify=async x=>{
  dependencies.repo={accept:async()=>{throw new Error('replaced repo')},assertScope:async()=>{throw new Error('replaced scope')}};
  repo.accept=async()=>{throw new Error('replaced method')};repo.assertScope=async()=>{throw new Error('replaced scope method')};repo.id=()=>{throw new Error('replaced id')};repo.now=()=>{throw new Error('replaced clock')};
  store.resolve=async()=>{throw new Error('replaced resolver')};store.authorityBinding=()=>({});
  dependencies.mappings={resolve:store.resolve,authorityBinding:()=>({})};dependencies.verifier.verify=async()=>null;
  dependencies.replay.claim=async()=>({outcome:'conflict'});dependencies.replay={claim:async()=>({outcome:'conflict'}),authorityBinding:()=>({})};dependencies.now=()=>'';dependencies.log=()=>{throw new Error('replaced log')};
  binding.prepare=()=>{throw new Error('replaced prepare')};binding.batch=async()=>{throw new Error('replaced batch')};repo.db={};repo.generator=()=>'';repo.clock=()=>'';
  return verify(x);
 };
 const i=new Ingress(dependencies),result=await send(i);check(result.status===200,'captured wiring');check(await count('action_outbox')===1,'captured acceptance');check(logs.length===1,'captured logger');

`));

test('tenant-scoped CAS mutation advances versions and terminal revocation blocks regrant',()=>run(`

 let denied=false;try{await store.update({tenant_id:t2.id,environment:'development'},mapping.id,1,{status:'inactive'});}catch(e){denied=e.name==='MappingStoreError'&&e.code==='denied';}check(denied,'foreign CAS denied');
 const changed=await store.update({tenant_id:t1.id,environment:'development'},mapping.id,1,{status:'inactive'});check(changed.version===2&&changed.status==='inactive','version advances');
 denied=false;try{await store.update({tenant_id:t1.id,environment:'development'},mapping.id,1,{status:'active'});}catch(e){denied=e.code==='denied';}check(denied,'stale CAS denied');
 check((await send()).status===403,'inactive rejects');await empty();
 const granted=await store.update({tenant_id:t1.id,environment:'development'},mapping.id,2,{status:'active'});check(granted.version===3,'explicit versioned regrant');
 const revoked=await store.revoke({tenant_id:t1.id,environment:'development'},mapping.id,3);check(revoked.version===4&&revoked.revoked_version===4&&revoked.revoked_at===now,'terminal tombstone');
 denied=false;try{await store.update({tenant_id:t1.id,environment:'development'},mapping.id,4,{status:'active'});}catch(e){denied=e.code==='denied';}check(denied,'terminal revoke');check((await send()).status===403,'revoked rejects');await empty();

`));

test('persistent tombstones prohibit deletion recreation and unversioned ABA changes',()=>run(`

 let denied=false;try{await db.prepare('DELETE FROM source_mappings WHERE id=?').bind(mapping.id).run();}catch{denied=true;}check(denied,'physical deletion allowed');
 denied=false;try{await db.prepare("UPDATE source_mappings SET principal='other' WHERE id=?").bind(mapping.id).run();}catch{denied=true;}check(denied,'unversioned authorization change');
 await store.update({tenant_id:t1.id,environment:'development'},mapping.id,1,{status:'inactive'});
 denied=false;try{await db.prepare("UPDATE source_mappings SET version=1,status='active' WHERE id=?").bind(mapping.id).run();}catch{denied=true;}check(denied,'version reset');
 await store.revoke({tenant_id:t1.id,environment:'development'},mapping.id,2);
 denied=false;try{await db.prepare("UPDATE source_mappings SET version=4,status='active',revoked_at=NULL,revoked_version=NULL WHERE id=?").bind(mapping.id).run();}catch{denied=true;}check(denied,'terminal revoke bypass');
 denied=false;try{await store.create({...base,tenant_id:t2.id});}catch{denied=true;}check(denied,'routing ambiguity created');await empty();

`));

test('mapping read errors classify transient unavailable and permanent failure without disclosure',()=>run(`

 for(const [detail,status,code] of [['Network connection lost.',503,'unavailable'],['FOREIGN KEY constraint failed private actor tenant SQL',500,'failure'],['Network connection lost. unknown private',500,'failure']]){
  let reads=0;
  const failing={prepare:sql=>{const stmt=db.prepare(sql);if(sql.startsWith('SELECT * FROM source_mappings'))return {bind:()=>({all:async()=>{reads++;throw new Error('D1_ERROR: '+detail);}})};return stmt;},batch:db.batch.bind(db)};
  const failedStore=new D1SourceMappingStore(failing,()=>now),failedRepo=new D1Repository(failing,()=>now);
  let captured;try{await failedStore.resolve(base);}catch(e){captured=e;}check(captured?.name==='MappingStoreError'&&captured.code===code,'typed safe store failure');check(!JSON.stringify(captured).includes('private'),'typed error disclosure');
  const r=await send(new Ingress({...dependencies,repo:failedRepo,mappings:failedStore,replay:new D1ReplayLedger(failing,()=>now)}));check(r.status===status,'safe failure classification '+r.status);check(reads===2,'blind mapping retry');
  check(!JSON.stringify([r,logs]).includes('private'),'public error disclosure');
 }
 for(const record of logs)check(Object.keys(record).sort().join(',')==='code,failure_category,provider_category,replay_outcome,request_id,status','closed logs');await empty();

`));

test('nonce binding pins mapping version across inactive regrant without cached replay bypass',()=>run(`

 const accepted=await send();check(accepted.status===200,'first acceptance');
 await store.update({tenant_id:t1.id,environment:'development'},mapping.id,1,{status:'inactive'});check((await send()).status===403,'inactive cached replay');
 await store.update({tenant_id:t1.id,environment:'development'},mapping.id,2,{status:'active'});
 check((await send()).status===409,'old nonce silently rebound to new grant');
 const verify=dependencies.verifier.verify;dependencies.verifier.verify=async x=>({...await verify(x),nonce:'new-authentication'});
 const replay=await send();check(replay.status===200&&replay.body.event_id===accepted.body.event_id,'fresh authorized immutable replay');check(await count('action_outbox')===1,'regrant duplicate effect');
 await store.revoke({tenant_id:t1.id,environment:'development'},mapping.id,3);check((await send()).status===403,'revoked immutable replay');check(await count('action_outbox')===1,'revoke replay effect');

`));

test('acceptance guard compares complete identity rather than version alone',()=>run(`

 for(const patch of [{id:crypto.randomUUID()},{version:2},{provider:'other'},{source:'other'},{principal:'other'},{tenant_id:t2.id},{source_binding:'other'},{operation:'other'},{environment:'production'}]){
  let denied=false;
  try{await new Processor(repo,new Registry([[base.source_binding,t1.id]])).process({environment:'development',source_binding:base.source_binding,operation:base.operation},fixture,{...mapping,...patch});}catch(e){denied=e.code==='context';}check(denied,'forged authority '+Object.keys(patch)[0]);await empty();
 }
 const wrongBinding=new D1SourceMappingStore({prepare:db.prepare.bind(db),batch:db.batch.bind(db)},()=>now);
 check((await send(new Ingress({...dependencies,mappings:wrongBinding}))).status===403,'different binding accepted');await empty();

`));

test('revocation at coherent duplicate replay read rejects stored outcome without new effects',()=>run(`

 const accepted=await send();check(accepted.status===200,'initial acceptance');
 const before=await db.prepare('SELECT * FROM action_outbox').all();let revoked=false;
 hook=async s=>{if(s.length===9&&!revoked){revoked=true;await store.revoke({tenant_id:t1.id,environment:'development'},mapping.id,1);}};
 check((await send()).status===403,'revoked replay snapshot');check(revoked,'replay checkpoint');
 check(JSON.stringify((await db.prepare('SELECT * FROM action_outbox').all()).results)===JSON.stringify(before.results),'replay changed outbox');check(await count('events')===1,'replay event');

`));

test('mapping changes at write boundary reject stale version and tenant movement',()=>run(`

 for(const mutation of ["principal='actor-other'","tenant_id='"+t2.id+"'","source_binding='other-binding'","status='inactive'"]){
  // Each request captures the current active authority, then a separate writer changes it.
  const current=(await store.resolve(base))[0];let changed=false;
  const frozenStore={authorityBinding:()=>binding,resolve:async()=>[{...current,...base,version:current.version}]};
  // Restore baseline with a fresh version before capture; never reset a version.
  if(current.version!==1){await db.prepare("UPDATE source_mappings SET principal=?,tenant_id=?,source_binding=?,status='active',version=version+1,updated_at=? WHERE id=?").bind(base.principal,t1.id,base.source_binding,now,mapping.id).run();}
  const authority=(await store.resolve(base))[0];frozenStore.resolve=async()=>[authority];
  hook=async s=>{if(s.length>9&&!changed){changed=true;await db.prepare('UPDATE source_mappings SET '+mutation+',version=version+1,updated_at=? WHERE id=?').bind(now,mapping.id).run();}};
  const verify=dependencies.verifier.verify;const isolated={...dependencies,mappings:frozenStore,verifier:{verify:async x=>({...await verify(x),nonce:'version-'+authority.version})}};
  check((await send(new Ingress(isolated))).status===403,'changed mapping committed '+mutation);check(changed,'write race checkpoint');await empty();
 }

`));

test('revocation during retry never refreshes stale captured authorization',()=>run(`

 let writes=0,reads=0;
 hook=async s=>{if(s.length===9)reads++;if(s.length>9&&++writes===1){await store.update({tenant_id:t1.id,environment:'development'},mapping.id,1,{principal:'replacement'});throw new Error('D1_ERROR: Network connection lost.');}};
 const result=await send();check(result.status===403,'retry refreshed authority');check(writes===1&&reads===2,'bounded stale retry');await empty();

`));

test('two independent requests lose to revocation before either durable batch',()=>run(`

 let reached=0,ready,release;const waiting=new Promise(r=>ready=r),gate=new Promise(r=>release=r);
 hook=async s=>{if(s.length>9){if(++reached===2)ready();await gate;}};
 const other=new D1Repository(binding,()=>now),a=send(new Ingress(dependencies)),b=send(new Ingress({...dependencies,repo:other}));
 await waiting;await store.revoke({tenant_id:t1.id,environment:'development'},mapping.id,1);release();
 const results=await Promise.all([a,b]);check(results.every(r=>r.status===403),'concurrent revocation loser accepted');await empty();

`));

test('acceptance linearized before revocation succeeds but later independent request is denied',()=>run(`

 const accepted=await send(new Ingress({...dependencies,repo:new D1Repository(binding,()=>now)}));check(accepted.status===200,'acceptance winner');
 await store.revoke({tenant_id:t1.id,environment:'development'},mapping.id,1);
 const denied=await send(new Ingress({...dependencies,repo:new D1Repository(binding,()=>now)}));check(denied.status===403,'later replay accepted');check(await count('events')===1&&await count('action_outbox')===1,'winner effects');

`));

test('revocation while verifier awaits rejects before resolving source and writing',()=>run(`

 const verify=dependencies.verifier.verify;dependencies.verifier.verify=async x=>{await store.revoke({tenant_id:t1.id,environment:'development'},mapping.id,1);return verify(x);};
 check((await send()).status===403,'revoked before resolution');await empty();

`));

test('local mapping creation rejects unknown fields instead of interpolating caller keys',()=>run(`

 let denied=false;try{await store.create({...base,source:'source-two',created_at:'forged'});}catch(e){denied=e.name==='MappingStoreError'&&e.code==='denied';}check(denied,'unknown create field accepted');
 check(await count('source_mappings')===1,'invalid mapping persisted');

`));

test('collaborator replacement while mapping or replay awaits cannot change captured wiring',()=>run(`

 const originalResolve=store.resolve.bind(store),originalBind=dependencies.replay.claim.bind(dependencies.replay);
 for(const phase of ['mapping','replay']){
  const mutation=()=>{dependencies.repo={};dependencies.mappings={};dependencies.verifier={};dependencies.replay={};dependencies.now=()=>'';dependencies.log=()=>{};repo.accept=async()=>{throw new Error('replaced')};repo.assertScope=async()=>{throw new Error('replaced')};store.resolve=async()=>[];store.authorityBinding=()=>({});};
  const local={repo:new D1Repository(binding,()=>now),now:()=>now,verifier:{verify:async x=>({...x,principal:base.principal,source:base.source,signed_at:now,nonce:'phase-'+phase})},mappings:{authorityBinding:()=>binding,resolve:async p=>{const result=await originalResolve(p);if(phase==='mapping')mutation();return result;}},replay:{authorityBinding:()=>binding,claim:async k=>{const result=await originalBind(k);if(phase==='replay')mutation();return result;}},log:r=>logs.push(r)};
  const i=new Ingress(local);local.repo.accept=async()=>{throw new Error('replaced local method')};
  const result=await send(i);check(result.status===200,'captured '+phase);check(await count('action_outbox')===1,'duplicate '+phase);
 }
 check(logs.length===2,'stable log callback');

`));

test('missing ambiguous malformed or pre-revoked source mappings fail closed with identical public shape',()=>run(`

 for(const found of [[],[mapping,mapping],[{...mapping,status:'revoked'}],[{...mapping,status:'inactive'}],[{...mapping,version:0}],[{...mapping,principal:'other'}],[{...mapping,tenant_id:t2.id}]]){
  const local={...dependencies,mappings:{authorityBinding:()=>binding,resolve:async()=>found}};
  const r=await send(new Ingress(local));check(r.status===403&&r.body.code==='forbidden'&&Object.keys(r.body).sort().join(',')==='code,request_id','mapping existence disclosure');await empty();
 }
 await store.revoke({tenant_id:t1.id,environment:'development'},mapping.id,1);check((await send()).status===403,'pre-revoked mapping');await empty();

`));

test('revocation before update batch leaves existing business and outbox rows unchanged',()=>run(`

 check((await send()).status===200,'initial accepted');
 const tables=['leads','conversations','events','messages','qualification_state','action_outbox'],before=[];
 for(const table of tables)before.push((await db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()).results);
 let revoked=false;hook=async s=>{if(s.length>9&&!revoked){revoked=true;await store.revoke({tenant_id:t1.id,environment:'development'},mapping.id,1);}};
 const verify=dependencies.verifier.verify;dependencies.verifier.verify=async x=>({...await verify(x),nonce:'next-request'});
 const result=await send(new Ingress(dependencies),{...fixture,source_event_id:'next-event',source_sequence:2,qualification:{location:null}});check(result.status===403,'revoked update accepted');check(revoked,'update batch reached');
 for(const [index,table] of tables.entries())check(JSON.stringify((await db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()).results)===JSON.stringify(before[index]),'revoked update changed '+table);
 check(await count('authority_assertions')===0,'assertion rollback');

`));

test('INSERT OR REPLACE cannot recycle a revoked routing tombstone or old version',()=>run(`

 await store.revoke({tenant_id:t1.id,environment:'development'},mapping.id,1);
 const keys=Object.keys(mapping);let denied=false;
 try{await db.prepare('INSERT OR REPLACE INTO source_mappings ('+keys.join(',')+') VALUES ('+keys.map(()=>'?').join(',')+')').bind(...Object.values(mapping)).run();}catch{denied=true;}
 check(denied,'replace recreated old active authority');
 const current=(await store.resolve(base))[0];check(current.status==='revoked'&&current.version===2,'tombstone recycled');check((await send()).status===403,'old authority regained');await empty();

`));

test('mapping maintenance clock failures expose only typed sanitized failures',()=>run(`

 const bad=new D1SourceMappingStore(binding,()=>{throw new Error('private clock credential payload');});
 for(const operation of [()=>bad.create({...base,source:'new-source'}),()=>bad.update({tenant_id:t1.id,environment:'development'},mapping.id,1,{status:'inactive'}),()=>bad.revoke({tenant_id:t1.id,environment:'development'},mapping.id,1)]){
  let failure;try{await operation();}catch(e){failure=e;}check(failure?.name==='MappingStoreError'&&failure.code==='failure','raw maintenance exception');check(!String(failure).includes('private'),'clock disclosure');
 }
 const current=(await store.resolve(base))[0];check(current.status==='active'&&current.version===1&&await count('source_mappings')===1,'failed maintenance changed authority');

`));
