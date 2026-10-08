import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {readFileSync} from 'node:fs';

async function run(code:string){
 const bundle=await build({stdin:{resolveDir:process.cwd(),contents:`
 import {WorkerEntrypoint} from 'cloudflare:workers';
 import {Ingress} from './src/worker-ingress.ts';
 import * as operations from './src/ingress-operations.ts';
 import {D1Repository} from './src/d1-repository.ts';
 import {D1ReplayLedger} from './src/replay-ledger.ts';
 import {D1SourceMappingStore} from './src/source-mappings.ts';
 import {fixture} from './src/fixture.ts';
 export default class extends WorkerEntrypoint {async verify(){
 const check=(x,m)=>{if(!x)throw new Error(m)};
 const wait=async promise=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Operational test barrier exhausted')),5000);})]);}finally{clearTimeout(timer);}};
 const now=new Date().toISOString(),repo=new D1Repository(this.env.DB,()=>now);
 const t1=await repo.createTenant('Synthetic one'),t2=await repo.createTenant('Synthetic two');
 const logs=[];let calls=0;
 const store=new D1SourceMappingStore(this.env.DB,()=>now);
 const initial=await store.create({principal:'actor-one',provider:'synthetic',source:'source-one',tenant_id:t1.id,source_binding:'mock-source-001',environment:'development',operation:'ingest_mock_lead'});
 const dependencies={repo,now:()=>now,log:x=>logs.push(x),
 verifier:{verify:async x=>({principal:'actor-one',provider:x.provider,source:'source-one',signed_at:now,nonce:'nonce-one',body_digest:x.body_digest,method:x.method,path:x.path})},
 mappings:{resolve:async()=>[{...initial}],authorityBinding:()=>this.env.DB},
 replay:new D1ReplayLedger(this.env.DB,()=>now)};
 const ingress=new Ingress(dependencies);
 const request=(body=JSON.stringify(fixture),headers={},method='POST',path='/v1/ingress/synthetic')=>new Request('https://local.invalid'+path,{method,headers:{'content-type':'application/json',...headers},body:method==='GET'?undefined:body});
 const send=async(...args)=>{const response=await new Ingress(dependencies).handle(request(...args));return {status:response.status,body:await response.json()};};
 ${code}
 return true;
 }} `},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:workers'],metafile:true});
 assert.ok(Object.keys(bundle.metafile!.inputs).every(p=>!/(better-sqlite3|src\/repository|node:)/.test(p)));
 const local=new Miniflare({modules:true,script:bundle.outputFiles![0].text,compatibilityDate:'2025-07-18',compatibilityFlags:[],d1Databases:['DB'],host:'127.0.0.1',cf:false,outboundService:()=>{throw new Error('External access forbidden');}});
 try{const db=await local.getD1Database('DB');await db.exec(readFileSync(new URL('../../src/schema.sql',import.meta.url),'utf8').replace(/--[^\n]*/g,'').replaceAll('\n',' '));const worker=await local.getWorker() as unknown as {verify():Promise<boolean>};assert.equal(await worker.verify(),true);assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);}finally{await local.dispose();}
}


test('deadline cancels slow body before authentication without writes',()=>run(`
 let cancelled=false,verified=0,notice;
 const cancellation=new Promise(r=>notice=r);
 dependencies.verifier.verify=async()=>{verified++;return null;};
 const stream=new ReadableStream({cancel(){cancelled=true;notice();}});
 const localIngress=new Ingress(dependencies,{deadlineMs:100});
 const response=await localIngress.handle(new Request('https://local.invalid/v1/ingress/synthetic',{method:'POST',headers:{'content-type':'application/json'},body:stream}));
 check(response.status===504,'deadline response');await wait(cancellation);check(cancelled&&verified===0,'body cancelled');
 check((await this.env.DB.prepare('SELECT count(*) n FROM replay_ledger').first()).n===0,'no claims');
`));

test('authenticated rate quota cannot be selected or burned by unverified source headers',()=>run(`
 let auth=0,pre=0;
 const rates={preauth:()=>{pre++;return {allowed:true};},authenticated:proof=>{auth++;check(proof.source==='source-one'&&proof.principal==='actor-one','trusted quota identity');return {allowed:false,retryAfter:7};}};
 const verify=dependencies.verifier.verify;dependencies.verifier.verify=async()=>null;
 const boundary=new Ingress(dependencies,{rates});
 check((await boundary.handle(request(undefined,{'x-source':'source-one','x-tenant':'privileged'}))).status===401,'unauthorized');check(auth===0,'victim quota');
 dependencies.verifier.verify=verify;const limited=await new Ingress(dependencies,{rates}).handle(request(undefined,{'x-source':'privileged','x-rate-tier':'unlimited'}));
 check(limited.status===429&&limited.headers.get('retry-after')==='7','rate response');check(pre===2&&auth===1,'separate quotas');
 check((await this.env.DB.prepare('SELECT count(*) n FROM replay_ledger').first()).n===0,'limited claim');
`));

test('local rate adapter bounds cardinality and windows with defensible Retry-After',()=>run(`
 check(typeof operations.LocalRatePolicy==='function','local adapter missing');
 let clock=1000;const rates=new operations.LocalRatePolicy({clock:()=>clock,preauthLimit:2,sourceLimit:1,maxSources:1,windowMs:10000});
 check(rates.preauth().allowed&&rates.preauth().allowed,'pre quota');check(rates.preauth().retryAfter===10,'pre retry interval');
 const one={provider:'synthetic',principal:'actor-one',source:'source-one'},two={...one,source:'source-two'};
 check(rates.authenticated(one).allowed,'independent auth quota');check(!rates.authenticated(one).allowed,'source quota');check(!rates.authenticated(two).allowed,'cardinality fail closed');check(rates.snapshot().sources===1,'bounded map');
 clock=11000;check(rates.authenticated(two).allowed&&rates.snapshot().sources===1,'window renewal');
 clock=0;check(!rates.authenticated(one).allowed,'clock rollback');
`));

test('timed out durable claim stops retrying after an uncancellable transient operation settles',()=>run(`
 let entered,release,batches=0;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 const db={prepare:this.env.DB.prepare.bind(this.env.DB),batch:async statements=>{batches++;entered();await gate;throw new Error('D1_ERROR: Network connection lost.');}};
 const ledger=new D1ReplayLedger(db,()=>now),deadline=new operations.Deadline(100);
 const work=ledger.claim({authority:initial,nonce:'nonce-delayed',fingerprint:'a'.repeat(64),signed_at:now},deadline);
 const raced=Promise.race([work,deadline.expired]);await wait(started);
 try{await raced;throw new Error('expected deadline');}catch(error){check(error instanceof operations.DeadlineError,'deadline classification');}
 release();try{await work;}catch{}deadline.close();check(batches===1,'late claim retry');
 check((await this.env.DB.prepare('SELECT count(*) n FROM replay_ledger').first()).n===0,'claim writes');
`));

test('timeout after durable claim permits authenticated identical recovery without a late acceptance',()=>run(`
 let entered,release,settled;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r),done=new Promise(r=>settled=r);
 const ledger=dependencies.replay;let core=0;const accept=repo.accept.bind(repo);repo.accept=(...args)=>{core++;return accept(...args);};
 dependencies.replay={authorityBinding:()=>this.env.DB,claim:async(...args)=>{const claim=await ledger.claim(...args);entered();await gate;settled();return claim;}};
 const boundary=new Ingress(dependencies,{deadlineMs:1000});const pending=boundary.handle(request());await Promise.race([started,pending.then(()=>{throw new Error('deadline before claim barrier');})]);
 check((await pending).status===504,'claim timeout');check(core===0,'acceptance before release');
 check((await this.env.DB.prepare('SELECT count(*) n FROM replay_ledger').first()).n===1,'durable claim retained');
 release();await wait(done);await Promise.resolve();await Promise.resolve();check(core===0,'late claim continued');
 dependencies.replay=ledger;const recovered=await send();check(recovered.status===200,'identical recovery');
 check((await this.env.DB.prepare('SELECT count(*) n FROM action_outbox').first()).n===1,'one recovered outbox');
`));

test('timeout during D1 acceptance snapshot prevents planning and later write batch',()=>run(`
 let entered,release,settled,reads=0;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r),done=new Promise(r=>settled=r);
 const binding=this.env.DB,db={prepare:binding.prepare.bind(binding),batch:async statements=>{const result=await binding.batch(statements);if(statements.length===9){reads++;entered();await gate;settled();}return result;}};
 dependencies.repo=new D1Repository(db,()=>now);dependencies.replay=new D1ReplayLedger(db,()=>now);dependencies.mappings={resolve:async()=>[initial],authorityBinding:()=>db};
 const boundary=new Ingress(dependencies,{deadlineMs:150});const pending=boundary.handle(request());await wait(started);
 check((await pending).status===504,'snapshot timeout');release();await wait(done);await Promise.resolve();await Promise.resolve();
 check((await binding.prepare('SELECT count(*) n FROM events').first()).n===0,'late write batch');check(reads===1,'no retry');
`));

test('response loss after committed acceptance remains ambiguous and idempotently recoverable',()=>run(`
 let entered,release,settled;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r),done=new Promise(r=>settled=r);
 const accept=repo.accept.bind(repo);repo.accept=async(...args)=>{const result=await accept(...args);entered();await gate;settled();return result;};
 const boundary=new Ingress(dependencies,{deadlineMs:150});const pending=boundary.handle(request());await wait(started);
 check((await pending).status===504,'lost response deadline');
 check((await this.env.DB.prepare('SELECT count(*) n FROM action_outbox').first()).n===1,'committed not rolled back');
 release();await wait(done);repo.accept=accept;const recovered=await send();check(recovered.status===200,'explicit recovery');
 check((await this.env.DB.prepare('SELECT count(*) n FROM action_outbox').first()).n===1,'duplicate intent');
 check(logs.filter(x=>x.code==='deadline').length===1&&!JSON.stringify(logs).includes('actor-one'),'closed deadline diagnostics');
`));

test('source admission and cardinality are bounded across trusted concurrent requests',()=>run(`
 const admission=new operations.LocalAdmission(4,1,1);let entered,release,settled;
 const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r),done=new Promise(r=>settled=r);
 const assertScope=repo.assertScope.bind(repo);repo.assertScope=async scope=>{await assertScope(scope);entered();await gate;settled();};
 const boundary=new Ingress(dependencies,{admission,deadlineMs:150});const pending=boundary.handle(request());await wait(started);
 const denied=await boundary.handle(request(undefined,{'x-source':'other'}));check(denied.status===503,'source cap');
 check(admission.snapshot().sources===1&&admission.snapshot().active===1,'bounded counters');
 check((await pending).status===504,'timeout');check(admission.snapshot().active===1,'retain actual work');
 release();await wait(done);await Promise.resolve();await Promise.resolve();
 const unit=new operations.LocalAdmission(3,2,1),a=unit.source('trusted-a');try{unit.source('trusted-b');throw new Error('expected bound');}catch(e){check(e instanceof operations.OverloadError,'cardinality denial');}a();check(unit.snapshot().sources===0,'source cleanup');
`));

test('empty chunk floods have a finite read budget independent of byte limit',()=>run(`
 let chunks=0,cancelled=false;
 const stream=new ReadableStream({pull(c){chunks++;if(chunks<=16385)c.enqueue(new Uint8Array(0));else {c.enqueue(new TextEncoder().encode(JSON.stringify(fixture)));c.close();}},cancel(){cancelled=true;}});
 const response=await new Ingress(dependencies).handle(new Request('https://local.invalid/v1/ingress/synthetic',{method:'POST',headers:{'content-type':'application/json'},body:stream}));
 check(response.status===400,'finite chunk budget');check(cancelled,'flood cancellation');
 check((await this.env.DB.prepare('SELECT count(*) n FROM events').first()).n===0,'flood writes');
`));

test('hung stream cancellation retains the actual work permit after response deadline',()=>run(`
 let release,cancelled;const gate=new Promise(r=>release=r),notice=new Promise(r=>cancelled=r),admission=new operations.LocalAdmission(1,1,1);
 const stream=new ReadableStream({cancel(){cancelled();return gate;}});
 const boundary=new Ingress(dependencies,{admission,deadlineMs:100});const response=await boundary.handle(new Request('https://local.invalid/v1/ingress/synthetic',{method:'POST',headers:{'content-type':'application/json'},body:stream}));
 check(response.status===504,'body deadline');await wait(notice);await this.env.DB.prepare('SELECT 1').all();
 check(admission.snapshot().active===1,'cancel promise released permit');check((await boundary.handle(request())).status===503,'cancel overload');release();
`));

test('invalid operational clock fails closed through the safe response boundary',()=>run(`
 let response;try{response=await new Ingress(dependencies,{clock:()=>NaN}).handle(request());}catch{}
 check(response?.status===500,'unsafe clock exception');check(logs.length===1&&logs[0].code==='internal','closed clock diagnostic');
 check((await this.env.DB.prepare('SELECT count(*) n FROM replay_ledger').first()).n===0,'clock claim');
`));

test('issued D1 batch may commit after response timeout without releasing its work permit early',()=>run(`
 let entered,release,settled;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r),done=new Promise(r=>settled=r),binding=this.env.DB;
 const db={prepare:binding.prepare.bind(binding),batch:async statements=>{if(statements.length>9){entered();await gate;}try{return await binding.batch(statements);}finally{if(statements.length>9)settled();}}};
 const admission=new operations.LocalAdmission(2,2,2);dependencies.repo=new D1Repository(db,()=>now);dependencies.replay=new D1ReplayLedger(db,()=>now);dependencies.mappings={resolve:async()=>[initial],authorityBinding:()=>db};
 const boundary=new Ingress(dependencies,{admission,deadlineMs:1000});const pending=boundary.handle(request());await wait(started);
 check((await pending).status===504,'write deadline');check(admission.snapshot().active===1,'pending write permit');
 check((await binding.prepare('SELECT count(*) n FROM events').first()).n===0,'not yet committed');release();await wait(done);
 check((await binding.prepare('SELECT count(*) n FROM action_outbox').first()).n===1,'late guarded commit');
 const replay=await send();check(replay.status===200,'explicit late commit recovery');check((await binding.prepare('SELECT count(*) n FROM action_outbox').first()).n===1,'no extra intent');
`));

test('revocation during delayed issued D1 write still aborts all business effects after timeout',()=>run(`
 let entered,release,settled;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r),done=new Promise(r=>settled=r),binding=this.env.DB;
 const db={prepare:binding.prepare.bind(binding),batch:async statements=>{if(statements.length>9){entered();await gate;}try{return await binding.batch(statements);}finally{if(statements.length>9)settled();}}};
 dependencies.repo=new D1Repository(db,()=>now);dependencies.replay=new D1ReplayLedger(db,()=>now);dependencies.mappings={resolve:async()=>[initial],authorityBinding:()=>db};
 const pending=new Ingress(dependencies,{deadlineMs:1000}).handle(request());await wait(started);check((await pending).status===504,'delayed write deadline');
 await store.revoke({tenant_id:t1.id,environment:'development'},initial.id,initial.version);release();await wait(done);
 for(const table of ['events','action_outbox','leads'])check((await binding.prepare('SELECT count(*) n FROM '+table).first()).n===0,'revoked atomic '+table);
 check((await send()).status===403,'stale authority retry');
`));

test('mapping interruption and injected deadline clock never start downstream claims',()=>run(`
 let clock=1000;const resolve=dependencies.mappings.resolve;
 dependencies.mappings.resolve=async proof=>{clock=1100;return resolve(proof);};
 const response=await new Ingress(dependencies,{deadlineMs:100,clock:()=>clock}).handle(request());check(response.status===504,'mapping deadline');
 check((await this.env.DB.prepare('SELECT count(*) n FROM replay_ledger').first()).n===0,'late source claim');
`));

test('request AbortSignal cancels a slow stream and cannot claim victim authority',()=>run(`
 let notify;const cancelled=new Promise(r=>notify=r),controller=new AbortController();
 const stream=new ReadableStream({cancel(){notify();}}),incoming=new Request('https://local.invalid/v1/ingress/synthetic',{method:'POST',headers:{'content-type':'application/json','x-source':'source-one'},body:stream,signal:controller.signal});
 const pending=new Ingress(dependencies).handle(incoming);controller.abort();check((await pending).status===504,'interrupted request');await wait(cancelled);
 check((await this.env.DB.prepare('SELECT count(*) n FROM replay_ledger').first()).n===0,'interrupted claim');
`));

test('admitted duplicates retain one atomic event while excess arrivals receive zero-queue overload',()=>run(`
 let ready,release,entries=0;const started=new Promise(r=>ready=r),gate=new Promise(r=>release=r),scope=repo.assertScope.bind(repo);
 repo.assertScope=async s=>{await scope(s);if(++entries===2)ready();await gate;};
 const admission=new operations.LocalAdmission(4,2,2),boundary=new Ingress(dependencies,{admission});
 const first=boundary.handle(request()),second=boundary.handle(request());await wait(started);
 check((await boundary.handle(request())).status===503,'excess source arrival');release();
 const results=await Promise.all([first,second]);check(results.every(r=>r.status===200),'valid admitted duplicates');const bodies=await Promise.all(results.map(r=>r.json()));check(bodies[0].event_id===bodies[1].event_id,'same outcome');
 check((await boundary.handle(request(JSON.stringify({...fixture,text:'changed'})))).status===409,'conflicting replay');
 check((await this.env.DB.prepare('SELECT count(*) n FROM action_outbox').first()).n===1,'duplicate intent');check(admission.snapshot().active===0&&admission.snapshot().sources===0,'settled counters');
`));

test('caller mutation cannot replace captured admission methods during a verifier await',()=>run(`
 let enter,release;const started=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
 dependencies.verifier.verify=async()=>{enter();await gate;return null;};const admission=new operations.LocalAdmission(1,1,1),boundary=new Ingress(dependencies,{admission,deadlineMs:100});
 const first=boundary.handle(request());await wait(started);admission.enter=()=>()=>{};admission.source=()=>()=>{};
 check((await boundary.handle(request())).status===503,'rewired admission');check((await first).status===504,'deadline');release();
`));

test('zero queue admission holds timed out verifier work until settlement',()=>run(`
 let entered,release,settled;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r),done=new Promise(r=>settled=r);
 const verify=dependencies.verifier.verify;
 dependencies.verifier.verify=async x=>{entered();await gate;settled();return verify(x);};
 const boundary=new Ingress(dependencies,{deadlineMs:100,globalLimit:1});
 const first=boundary.handle(request());await wait(started);
 check((await boundary.handle(request())).status===503,'global admission');
 check((await first).status===504,'timeout');
 check((await boundary.handle(request())).status===503,'zombie permit released');
 release();await wait(done);await Promise.resolve();await Promise.resolve();
 check((await this.env.DB.prepare('SELECT count(*) n FROM replay_ledger').first()).n===0,'late verifier reached claim');
 dependencies.verifier.verify=verify;
`));

