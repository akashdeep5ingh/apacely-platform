import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {readFileSync} from 'node:fs';

async function run(code:string){
 const bundle=await build({stdin:{resolveDir:process.cwd(),contents:`
 import {WorkerEntrypoint} from 'cloudflare:workers';
 import {Ingress} from './src/worker-ingress.ts';
 import {D1Repository} from './src/d1-repository.ts';
 import {D1SourceMappingStore} from './src/source-mappings.ts';
 import {fixture} from './src/fixture.ts';
 export default class extends WorkerEntrypoint {async verify(){
 const check=(x,m)=>{if(!x)throw new Error(m)};
 const now='2026-01-01T12:00:01.000Z',repo=new D1Repository(this.env.DB,()=>now);
 const t1=await repo.createTenant('Synthetic one'),t2=await repo.createTenant('Synthetic two');
 const logs=[],nonces=new Map();let calls=0;
 const store=new D1SourceMappingStore(this.env.DB,()=>now);
 const initial=await store.create({principal:'actor-one',provider:'synthetic',source:'source-one',tenant_id:t1.id,source_binding:'mock-source-001',environment:'development',operation:'ingest_mock_lead'});
 const dependencies={repo,now:()=>now,log:x=>logs.push(x),
 verifier:{verify:async x=>({principal:'actor-one',provider:x.provider,source:'source-one',signed_at:now,nonce:'nonce-one',body_digest:x.body_digest,method:x.method,path:x.path})},
 mappings:{resolve:async()=>[{...initial}],authorityBinding:()=>this.env.DB},
 replay:{bind:async(key,digest)=>{const old=nonces.get(key);if(old&&old!==digest)return false;nonces.set(key,digest);return true;}}};
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

test('permanent persistence fails safely without retry and identical nonce recovers precommit failure',()=>run(`
 const accept=repo.accept.bind(repo);let attempts=0;
 repo.accept=async()=>{attempts++;throw new Error('D1_ERROR: private SQL FOREIGN KEY constraint failed');};
 const rejected=await send();check(rejected.status===500&&attempts===1,'permanent blind retry');
 check((await this.env.DB.prepare('SELECT count(*) n FROM events').first()).n===0,'precommit rows');
 check(!JSON.stringify([rejected,logs]).includes('private'),'database disclosure');
 repo.accept=accept;check((await send()).status===200,'nonce blocked recovery');
 check((await repo.rows({tenant_id:t1.id,environment:'development'},'action_outbox')).length===1,'recovery action');
`));

test('trusted authority is captured across awaits and overlapping IDs remain isolated',()=>run(`
 const mapping=(await dependencies.mappings.resolve())[0],assertScope=repo.assertScope.bind(repo);
 dependencies.mappings.resolve=async()=>[mapping];
 repo.assertScope=async scope=>{await assertScope(scope);mapping.tenant_id=t2.id;};
 check((await send()).status===200,'accept captured mapping');
 check((await repo.rows({tenant_id:t1.id,environment:'development'},'events')).length===1,'mapping mutation switched tenant');
 check((await repo.rows({tenant_id:t2.id,environment:'development'},'events')).length===0,'foreign write');
 repo.assertScope=assertScope;
 dependencies.verifier.verify=async x=>({principal:'actor-two',provider:x.provider,source:'source-two',signed_at:now,nonce:'nonce-one',body_digest:x.body_digest,method:x.method,path:x.path});
 const second=await store.create({principal:'actor-two',provider:'synthetic',source:'source-two',source_binding:'mock-source-002',tenant_id:t2.id,environment:'development',operation:'ingest_mock_lead'});dependencies.mappings.resolve=async()=>[second];
 check((await send()).status===200,'second authorized tenant');
 const a=await repo.rows({tenant_id:t1.id,environment:'development'},'events'),b=await repo.rows({tenant_id:t2.id,environment:'development'},'events');
 check(a.length===1&&b.length===1&&a[0].id!==b[0].id,'overlapping ids merged');
`));

test('bounded streams cancel oversized UTF-8 bodies and reject broken transport safely',()=>run(`
 let cancelled=false;
 const stream=new ReadableStream({pull(c){c.enqueue(new Uint8Array(16385));},cancel(){cancelled=true;}});
 const large=await ingress.handle(new Request('https://local.invalid/v1/ingress/synthetic',{method:'POST',headers:{'content-type':'application/json','content-length':'1'},body:stream}));
 check(large.status===413&&cancelled,'bounded stream cancellation');
 const broken=new ReadableStream({start(c){c.error(new Error('private stream exception'));}});
 const response=await ingress.handle(new Request('https://local.invalid/v1/ingress/synthetic',{method:'POST',headers:{'content-type':'application/json'},body:broken}));
 check(response.status===400,'broken stream safe invalid request');
 check((await this.env.DB.prepare('SELECT count(*) n FROM events').first()).n===0,'transport reached core');
`));

test('safe failures log closed fields and exact replay recovers ambiguous committed acceptance',()=>run(`
 const accept=repo.accept.bind(repo);
 repo.accept=async(...args)=>{const result=await accept(...args);throw Object.assign(new Error('secret body SQL stack injection'),{code:'D1_TRANSIENT'});};
 const lost=await send();check(lost.status===503,'ambiguous exhaustion');
 check((await repo.rows({tenant_id:t1.id,environment:'development'},'action_outbox')).length===1,'committed once');
 repo.accept=accept;const recovered=await send();check(recovered.status===200,'recovery blocked by nonce');
 const mapping=dependencies.mappings.resolve;
 dependencies.mappings.resolve=async()=>{throw new Error('secret body SQL stack injection');};const failed=await send();check(failed.status===500,'unknown internal');
 dependencies.mappings.resolve=mapping;
 check(logs.length===3,'every response logged');
 for(const log of logs){check(Object.keys(log).sort().join(',')==='code,request_id,status','closed log');check(/^[0-9a-f-]{36}$/.test(log.request_id),'generated trace');}
 check(!JSON.stringify([logs,lost,failed]).includes('secret'),'sensitive error leaked');
`));

test('authenticated replay binds raw bytes and freshness without consuming recovery',()=>run(`
 const verify=dependencies.verifier.verify;
 for(const change of [{body_digest:'bad'},{provider:'other'},{method:'GET'},{path:'/wrong'},{signed_at:'2026-01-01T11:50:00.000Z'},{signed_at:'2026-01-01T12:01:00.000Z'},{nonce:''}]){dependencies.verifier.verify=async x=>({...await verify(x),...change});check((await send()).status===401,'invalid authenticated metadata');}
 dependencies.verifier.verify=verify;
 const first=await send(),same=await send();check(first.status===200&&same.body.event_id===first.body.event_id,'exact replay');
 check((await send(JSON.stringify({...fixture,text:'changed'}))).status===409,'nonce reuse');
 dependencies.verifier.verify=async x=>({...await verify(x),nonce:'nonce-two'});
 check((await send(JSON.stringify({...fixture,text:'changed'}))).status===409,'event conflict');
 check((await repo.rows({tenant_id:t1.id,environment:'development'},'action_outbox')).length===1,'duplicate action');
`));

test('verified authority requires one exact authorized mapping and active tenant',()=>run(`
 const verify=dependencies.verifier.verify,mapping=(await dependencies.mappings.resolve())[0];
 dependencies.verifier.verify=async()=>null;check((await send()).status===401,'unverified');
 dependencies.verifier.verify=async x=>({...await verify(x),source:'source-two'});check((await send()).status===403,'cross source');
 dependencies.verifier.verify=verify;
 dependencies.mappings.resolve=async()=>[];check((await send()).status===403,'missing mapping');
 dependencies.mappings.resolve=async()=>[mapping,mapping];check((await send()).status===403,'ambiguous mapping');
 dependencies.mappings.resolve=async()=>[{...mapping,operation:'read'}];check((await send()).status===403,'action authorization');
 dependencies.mappings.resolve=async()=>[mapping];
 await this.env.DB.prepare('UPDATE tenants SET lifecycle_status=? WHERE id=?').bind('inactive',t1.id).run();check((await send()).status===403,'inactive');
 check((await this.env.DB.prepare('SELECT count(*) n FROM events').first()).n===0,'denied writes');
`));

test('transport and strict schema reject invalid input before acceptance',()=>run(`
 let coreCalls=0;const original=repo.accept.bind(repo);repo.accept=(...args)=>{coreCalls++;return original(...args);};
 const invalid=[['{}',{},'GET',undefined,405],['{}',{},'POST','/v2/ingress/synthetic',404],['{}',{'content-type':'text/plain'},'POST',undefined,415],['{',{},'POST',undefined,400],[JSON.stringify({...fixture,tenant_id:t2.id}),{},'POST',undefined,400],[JSON.stringify({...fixture,text:7}),{},'POST',undefined,400],[JSON.stringify({...fixture,source_event_id:'x'.repeat(129)}),{},'POST',undefined,400],[JSON.stringify({...fixture,text:'x'.repeat(4097)}),{},'POST',undefined,400],[JSON.stringify({...fixture,qualification:{intent:'evil'}}),{},'POST',undefined,400],['x'.repeat(16385),{'content-length':'1'},'POST',undefined,413],['{'+JSON.stringify(fixture).slice(1,-1)+',"schema_version":1}',{},'POST',undefined,400]];
 for(const patch of [{schema_version:2},{source_sequence:0},{source_sequence:1.5},{occurred_at:'2026-02-30T00:00:00Z'},{channel:'sms'},{qualification:{tenant_id:t2.id}},{qualification:{location:'x'.repeat(121)}},{handoff_requested:'true'},{environment:'production'},{source_binding:'foreign'}])invalid.push([JSON.stringify({...fixture,...patch}),{},'POST',undefined,400]);
 const escaped='{'+JSON.stringify(fixture).slice(1,-1)+',"'+String.fromCharCode(92)+'u0073chema_version":1}';invalid.push([escaped,{},'POST',undefined,400]);
 for(const [body,headers,method,path,status] of invalid){const r=await send(body,headers,method,path);check(r.status===status,'invalid status '+status);}
 check(coreCalls===0,'invalid invoked core');
 check((await repo.rows({tenant_id:t1.id,environment:'development'},'events')).length===0,'invalid reached core');
`));

test('ingress accepts authenticated mapped input through real core and atomic D1 outbox',()=>run(`
 const result=await send();check(result.status===200,'expected acceptance');
 check(result.body.event_id,'safe event acknowledgement');
 for(const table of ['leads','conversations','events','messages','qualification_state','action_outbox']){
 check((await repo.rows({tenant_id:t1.id,environment:'development'},table)).length===1,'atomic '+table);
 check((await repo.rows({tenant_id:t2.id,environment:'development'},table)).length===0,'foreign '+table);}
 check(typeof Buffer==='undefined'&&typeof process==='undefined','no Node globals');
`));
