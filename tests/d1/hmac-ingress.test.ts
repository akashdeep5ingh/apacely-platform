import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {environmentStatements} from '../../scripts/environment-schema.js';
import {readFileSync} from 'node:fs';
const vectors=JSON.parse(readFileSync(new URL('../fixtures/synthetic-hmac-v1.json',import.meta.url),'utf8'));
async function run(code:string,environment='staging'){
 const bundle=await build({stdin:{resolveDir:process.cwd(),contents:`
 import {WorkerEntrypoint} from 'cloudflare:workers';
 import {SyntheticHmacVerifier} from './src/synthetic-hmac.ts';
 import {Ingress} from './src/worker-ingress.ts';
 import {LocalAdmission} from './src/ingress-operations.ts';
 import {D1Repository} from './src/d1-repository.ts';
 import {D1ReplayLedger} from './src/replay-ledger.ts';
 import {D1SourceMappingStore} from './src/source-mappings.ts';
 const vectors=${JSON.stringify(vectors)};
 export default class extends WorkerEntrypoint {async run(){
 const environment=${JSON.stringify(environment)},now=()=>new Date().toISOString(),time=now();
 const repo=new D1Repository(this.env.DB,now,undefined,environment),store=new D1SourceMappingStore(this.env.DB,now,environment),replay=new D1ReplayLedger(this.env.DB,now,3,environment);
 const tenant=await repo.createTenant('Public synthetic'),foreign=await repo.createTenant('Public foreign');
 const source='public-source-001',principal='public-principal-001';
 const mapping=await store.create({principal,provider:'synthetic',source,tenant_id:tenant.id,source_binding:'public-binding-001',environment,operation:'ingest_mock_lead'});
 const records=vectors.keys.filter(k=>k.environment===environment).map(k=>({...k,not_before:new Date(Date.parse(time)-60000).toISOString(),not_after:new Date(Date.parse(time)+(k.key_id.endsWith('old')?240000:3600000)).toISOString(),bytes:Uint8Array.from(k.key_hex.match(/../g),x=>parseInt(x,16))}));
 const verifier=await SyntheticHmacVerifier.create(environment,records,now);
 const logs=[],dependencies={repo,mappings:store,replay,verifier,now,log:x=>logs.push(x)};
 const body=vectors.messages[0].body_utf8;
 const request=async(kid=records[0].key_id,nonce='public-live-nonce',text=body,path='/v1/ingress/synthetic')=>{
 const r=records.find(k=>k.key_id===kid),signed_at=time;
 const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),x=>x.toString(16).padStart(2,'0')).join('');
 const tuple=['apacely-synthetic-ingress-hmac-v1',environment,'synthetic',principal,source,kid,'POST','/v1/ingress/synthetic',signed_at,nonce,digest];
 const key=await crypto.subtle.importKey('raw',r.bytes,{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const sig=new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(JSON.stringify(tuple))));
 const signature=btoa(String.fromCharCode(...sig)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
 return new Request('https://local.invalid'+path,{method:'POST',headers:{'content-type':'application/json','apacely-key-id':kid,'apacely-source':source,'apacely-signed-at':signed_at,'apacely-nonce':nonce,'apacely-signature':signature},body:text});};
 const send=async(...args)=>new Ingress(dependencies,{},environment).handle(await request(...args),this.ctx);
 const counts=async()=>({events:(await this.env.DB.prepare('SELECT count(*) n FROM events').first()).n,actions:(await this.env.DB.prepare('SELECT count(*) n FROM action_outbox').first()).n,nonces:(await this.env.DB.prepare('SELECT count(*) n FROM replay_ledger').first()).n});
 ${code}
 }} `},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:workers'],metafile:true});
 assert.ok(Object.keys(bundle.metafile!.inputs).every(p=>!/(node:|better-sqlite3|scripts\/)/.test(p)));
 const local=new Miniflare({modules:true,script:bundle.outputFiles![0].text,compatibilityDate:'2025-07-18',compatibilityFlags:[],d1Databases:['DB'],host:'127.0.0.1',cf:false,outboundService:()=>{throw new Error('External access forbidden');}});
 try{const db=await local.getD1Database('DB');await db.batch(environmentStatements(environment as 'development'|'staging').map(sql=>db.prepare(sql)));const worker=await local.getWorker() as unknown as {run():Promise<string>};return JSON.parse(await worker.run());}finally{await local.dispose();}
}
test('serialized internal query delimiter rejected before verification',async()=>{
 const result=await run(`const r=await request(records[0].key_id,'query-nonce',body,'/v1/ingress/synthetic?');const response=await new Ingress(dependencies,{},environment).handle(r,this.ctx);return JSON.stringify({status:response.status,url:r.url,counts:await counts()});`);
 assert.deepEqual(result,{status:404,url:'https://local.invalid/v1/ingress/synthetic?',counts:{events:0,actions:0,nonces:0}});
});

for(const removed of [['protocol','key_id','environment'],['protocol','key_id'],['protocol'],['environment'],['key_id']])test('configured HMAC rejects stripped metadata '+removed.join(','),async()=>{
 const result=await run(`const native=verifier.verify.bind(verifier);dependencies.verifier={protocol:'apacely-synthetic-ingress-hmac-v1',verify:async input=>{const proof={...await native(input)};for(const key of ${JSON.stringify(removed)})delete proof[key];return proof;}};const response=await send();return JSON.stringify({status:response.status,counts:await counts()});`);
 assert.deepEqual(result,{status:401,counts:{events:0,actions:0,nonces:0}});
});
for(const mode of [null,false,'','unknown',1,{}])test('malformed configured verifier protocol fails closed '+JSON.stringify(mode),async()=>{
 const result=await run(`let calls=0;dependencies.verifier={protocol:${JSON.stringify(mode)},verify:async input=>{calls++;return {...input,principal,source,signed_at:time,nonce:'mock-nonce',environment};}};const response=await send();return JSON.stringify({status:response.status,calls,counts:await counts(),safe:logs.every(x=>x.code==='unauthenticated')});`);
 assert.deepEqual(result,{status:401,calls:0,counts:{events:0,actions:0,nonces:0},safe:true});
});
test('captured HMAC marker and method survive caller replacement and stripped proof',async()=>{
 const result=await run(`const native=verifier.verify.bind(verifier);const wrapper={protocol:verifier.protocol,verify:async input=>{const proof={...await native(input)};delete proof.protocol;delete proof.key_id;delete proof.environment;return proof;}};dependencies.verifier=wrapper;const ingress=new Ingress(dependencies,{},environment);delete wrapper.protocol;wrapper.verify=async input=>({...input,principal,source,signed_at:time,nonce:'replacement'});dependencies.verifier={verify:wrapper.verify};const response=await ingress.handle(await request(),this.ctx);return JSON.stringify({status:response.status,counts:await counts()});`);
 assert.deepEqual(result,{status:401,counts:{events:0,actions:0,nonces:0}});
});
test('native verifier owns permanent immutable exact protocol marker',async()=>{
 const result=await run(`let changed=false;try{Object.defineProperty(verifier,'protocol',{value:undefined});changed=true;}catch{}return JSON.stringify({protocol:verifier.protocol,changed});`);
 assert.deepEqual(result,{protocol:'apacely-synthetic-ingress-hmac-v1',changed:false});
});
test('captured legacy environment-only mock stays configuration-scoped without headers',async()=>{
 const result=await run(`dependencies.verifier={verify:async input=>({...input,principal,source,signed_at:time,nonce:'legacy-nonce',environment:'development'})};const ingress=new Ingress(dependencies,{},environment);dependencies.verifier={protocol:'unknown',verify:async()=>null};const response=await ingress.handle(new Request('https://local.invalid/v1/ingress/synthetic',{method:'POST',headers:{'content-type':'application/json'},body}),this.ctx);return JSON.stringify({status:response.status,counts:await counts(),environments:(await this.env.DB.prepare('SELECT environment FROM action_outbox').all()).results});`);
 assert.deepEqual(result,{status:200,counts:{events:1,actions:1,nonces:1},environments:[{environment:'staging'}]});
});

for(const metadata of [{key_id:'public-staging-old'},{protocol:'unknown'},{protocol:'apacely-synthetic-ingress-hmac-v1'},{protocol:'apacely-synthetic-ingress-hmac-v1',key_id:'public-staging-old',environment:'development'}])test('legacy proof cannot accidentally claim malformed HMAC '+JSON.stringify(metadata),async()=>{
 const result=await run(`dependencies.verifier={verify:async input=>({...input,principal,source,signed_at:time,nonce:'legacy-meta',...${JSON.stringify(metadata)}})};const response=await send();return JSON.stringify({status:response.status,counts:await counts()});`);
 assert.deepEqual(result,{status:401,counts:{events:0,actions:0,nonces:0}});
});
for(const field of ['protocol','key_id'])test('legacy explicit undefined HMAC field rejects '+field,async()=>{
 const result=await run(`dependencies.verifier={verify:async input=>({...input,principal,source,signed_at:time,nonce:'legacy-meta',environment,[${JSON.stringify(field)}]:undefined})};const response=await send();return JSON.stringify({status:response.status,counts:await counts()});`);
 assert.deepEqual(result,{status:401,counts:{events:0,actions:0,nonces:0}});
});
for(const field of ['protocol','key_id'])test('legacy non-enumerable own undefined HMAC field rejects '+field,async()=>{
 const result=await run(`dependencies.verifier={verify:async input=>{const proof={...input,principal,source,signed_at:time,nonce:'legacy-hidden',environment};Object.defineProperty(proof,${JSON.stringify(field)},{value:undefined,enumerable:false});return proof;}};const response=await send();return JSON.stringify({status:response.status,counts:await counts()});`);
 assert.deepEqual(result,{status:401,counts:{events:0,actions:0,nonces:0}});
});
test('native verifier marker requires full metadata even when verify method is wrapped',async()=>{
 const result=await run(`const native=verifier.verify.bind(verifier);verifier.verify=async input=>{const proof={...await native(input)};delete proof.protocol;delete proof.environment;delete proof.key_id;return proof;};const response=await send();return JSON.stringify({status:response.status,counts:await counts()});`);
 assert.deepEqual(result,{status:401,counts:{events:0,actions:0,nonces:0}});
});
test('captured preserving HMAC wrapper survives protocol and method mutation',async()=>{
 const result=await run(`const wrapper={protocol:verifier.protocol,verify:verifier.verify.bind(verifier)};dependencies.verifier=wrapper;const ingress=new Ingress(dependencies,{},environment);wrapper.protocol='unknown';wrapper.verify=async()=>null;dependencies.verifier={verify:async()=>null};const response=await ingress.handle(await request(),this.ctx);return JSON.stringify({status:response.status,counts:await counts()});`);
 assert.deepEqual(result,{status:200,counts:{events:1,actions:1,nonces:1}});
});
test('throwing trusted marker returns sanitized denial before verifier work',async()=>{
 const result=await run(`let calls=0;dependencies.verifier={get protocol(){throw new Error('private marker');},verify:async()=>{calls++;return null;}};const response=await send();return JSON.stringify({status:response.status,calls,counts:await counts(),safe:!JSON.stringify(logs).includes('private')});`);
 assert.deepEqual(result,{status:401,calls:0,counts:{events:0,actions:0,nonces:0},safe:true});
});
test('explicit undefined marker is malformed rather than absent legacy capability',async()=>{
 const result=await run(`let calls=0;dependencies.verifier={protocol:undefined,verify:async input=>{calls++;return {...input,principal,source,signed_at:time,nonce:'legacy'};}};const response=await send();return JSON.stringify({status:response.status,calls,counts:await counts()});`);
 assert.deepEqual(result,{status:401,calls:0,counts:{events:0,actions:0,nonces:0}});
});
test('request abort during native verification retains then releases permits and recovers',async()=>{
 const result=await run(`let entered,finish;const ready=new Promise(r=>{entered=r;});const admission=new LocalAdmission(1,1,1),tracked=[];const adapter={importKey:crypto.subtle.importKey.bind(crypto.subtle),digest:crypto.subtle.digest.bind(crypto.subtle),verify:async(...args)=>{const valid=await crypto.subtle.verify(...args);entered();return new Promise(r=>{finish=()=>r(valid);});}};dependencies.verifier=await SyntheticHmacVerifier.create(environment,records,now,adapter);const abort=new AbortController();const r=new Request(await request(),{signal:abort.signal});const pending=new Ingress(dependencies,{admission},environment).handle(r,{waitUntil:p=>{tracked.push(p);this.ctx.waitUntil(p);}});await ready;abort.abort();const response=await pending,before=await counts(),held=admission.snapshot();finish();await Promise.all(tracked);dependencies.verifier=verifier;const recovery=await new Ingress(dependencies,{admission},environment).handle(await request(),this.ctx);return JSON.stringify({statuses:[response.status,recovery.status],before,held,settled:admission.snapshot(),counts:await counts()});`);
 assert.deepEqual(result,{statuses:[504,200],before:{events:0,actions:0,nonces:0},held:{active:1,sources:0},settled:{active:0,sources:0},counts:{events:1,actions:1,nonces:1}});
});
test('new rotation nonce preserves semantic event identity',async()=>{
 const result=await run(`const a=await send(),b=await send(records[1].key_id,'fresh-rotated-nonce');const one=await a.json(),two=await b.json();return JSON.stringify({statuses:[a.status,b.status],same:one.event_id===two.event_id,counts:await counts()});`);
 assert.deepEqual(result,{statuses:[200,200],same:true,counts:{events:1,actions:1,nonces:2}});
});
test('changed semantic event with fresh valid nonce conflicts',async()=>{
 const result=await run(`const a=await send(),b=await send(records[1].key_id,'fresh-nonce',body.replace('Synthetic','Changed'));return JSON.stringify({statuses:[a.status,b.status],counts:await counts()});`);
 assert.deepEqual(result,{statuses:[200,409],counts:{events:1,actions:1,nonces:2}});
});
test('current active mapping version bump conflicts with original nonce',async()=>{
 const result=await run(`const a=await send();await store.update({tenant_id:tenant.id,environment},mapping.id,mapping.version,{source_binding:'updated-binding'});const b=await send();return JSON.stringify({statuses:[a.status,b.status],counts:await counts()});`);
 assert.deepEqual(result,{statuses:[200,409],counts:{events:1,actions:1,nonces:1}});
});
test('withdrawn current authority denies cryptographically valid replay',async()=>{
 const result=await run(`const a=await send();await store.revoke({tenant_id:tenant.id,environment},mapping.id,mapping.version);const b=await send();return JSON.stringify({statuses:[a.status,b.status],counts:await counts()});`);
 assert.deepEqual(result,{statuses:[200,403],counts:{events:1,actions:1,nonces:1}});
});
test('mapping withdrawal during delayed native verification denies before claim',async()=>{
 const result=await run(`const native=verifier.verify.bind(verifier);dependencies.verifier={protocol:verifier.protocol,verify:async input=>{const proof=await native(input);await store.revoke({tenant_id:tenant.id,environment},mapping.id,mapping.version);return proof;}};const response=await send();return JSON.stringify({status:response.status,counts:await counts()});`);
 assert.deepEqual(result,{status:403,counts:{events:0,actions:0,nonces:0}});
});
test('captured mapping withdrawal before guarded acceptance rolls back business',async()=>{
 const result=await run(`const claim=replay.claim.bind(replay);dependencies.replay={authorityBinding:()=>this.env.DB,claim:async(...args)=>{const result=await claim(...args);await store.revoke({tenant_id:tenant.id,environment},mapping.id,mapping.version);return result;}};const response=await send();return JSON.stringify({status:response.status,counts:await counts()});`);
 assert.deepEqual(result,{status:403,counts:{events:0,actions:0,nonces:1}});
});
test('concurrent native authenticated duplicates commit only once',async()=>{
 const result=await run(`const requests=await Promise.all(Array.from({length:12},()=>request()));const responses=await Promise.all(requests.map(r=>new Ingress(dependencies,{},environment).handle(r,this.ctx)));return JSON.stringify({statuses:responses.map(x=>x.status),counts:await counts()});`);
 assert.deepEqual(result,{statuses:Array(12).fill(200),counts:{events:1,actions:1,nonces:1}});
});
test('inactive tenant denies valid HMAC without foreign effects',async()=>{
 const result=await run(`await this.env.DB.prepare("UPDATE tenants SET lifecycle_status='inactive' WHERE id=?").bind(tenant.id).run();const response=await send();return JSON.stringify({status:response.status,counts:await counts()});`);
 assert.deepEqual(result,{status:403,counts:{events:0,actions:0,nonces:0}});
});
test('safe HMAC errors retain exact closed PII-free logs',async()=>{
 const result=await run(`const r=await request();r.headers.set('apacely-signature','A'.repeat(43));const response=await new Ingress(dependencies,{},environment).handle(r,this.ctx);return JSON.stringify({status:response.status,keys:Object.keys(logs[0]).sort(),safe:!JSON.stringify(logs).includes('public-'),counts:await counts()});`);
 assert.deepEqual(result,{status:401,keys:['code','failure_category','provider_category','replay_outcome','request_id','status'],safe:true,counts:{events:0,actions:0,nonces:0}});
});

test('partial synthetic metadata cannot fall back to legacy fingerprint',async()=>{
 const result=await run(`const native=verifier.verify.bind(verifier);dependencies.verifier={protocol:verifier.protocol,verify:async input=>{const proof={...await native(input)};delete proof.protocol;return proof;}};const response=await send();return JSON.stringify({status:response.status,counts:await counts()});`);
 assert.deepEqual(result,{status:401,counts:{events:0,actions:0,nonces:0}});
});

test('environment-only native HMAC proof cannot claim using legacy fingerprint',async()=>{
 const result=await run(`const native=verifier.verify.bind(verifier);dependencies.verifier={protocol:verifier.protocol,verify:async input=>{const proof={...await native(input)};delete proof.protocol;delete proof.key_id;return proof;}};const response=await send();return JSON.stringify({status:response.status,counts:await counts()});`);
 assert.deepEqual(result,{status:401,counts:{events:0,actions:0,nonces:0}});
});

test('hung crypto fault retains actual pipeline until canceled verification settles',async()=>{
 const result=await run(`let finish;const tracked=[];const adapter={importKey:crypto.subtle.importKey.bind(crypto.subtle),digest:crypto.subtle.digest.bind(crypto.subtle),verify:async(...args)=>{const native=await crypto.subtle.verify(...args);return new Promise(resolve=>{finish=()=>resolve(native);});}};dependencies.verifier=await SyntheticHmacVerifier.create(environment,records,now,adapter);const requestPromise=request();const response=await new Ingress(dependencies,{deadlineMs:100},environment).handle(await requestPromise,{waitUntil:p=>{this.ctx.waitUntil(p);tracked.push(p);}});const before=await counts();finish();await Promise.all(tracked);return JSON.stringify({status:response.status,before,after:await counts()});`);
 assert.deepEqual(result,{status:504,before:{events:0,actions:0,nonces:0},after:{events:0,actions:0,nonces:0}});
});
test('rotation after original nonce admission expiry remains expired not rebound',async()=>{
 const result=await run(`const first=await send();const later=()=>new Date(Date.parse(time)+31000).toISOString();dependencies.now=later;dependencies.repo=new D1Repository(this.env.DB,later,undefined,environment);dependencies.replay=new D1ReplayLedger(this.env.DB,later,3,environment);const rotated=await send(records[1].key_id);return JSON.stringify({statuses:[first.status,rotated.status],counts:await counts()});`);
 assert.deepEqual(result,{statuses:[200,401],counts:{events:1,actions:1,nonces:1}});
});

test('authenticated rotation kid conflicts with original durable nonce',async()=>{
 const result=await run(`const first=await send(),old=await send(),rotated=await send(records[1].key_id);return JSON.stringify({statuses:[first.status,old.status,rotated.status],counts:await counts()});`);
 assert.deepEqual(result,{statuses:[200,200,409],counts:{events:1,actions:1,nonces:1}});
});

test('audited pending native verification retains permits and request context until settlement',async()=>{
 const result=await run(`let finish;const tracked=[];const admission=new LocalAdmission(1,1,1);const adapter={importKey:crypto.subtle.importKey.bind(crypto.subtle),digest:crypto.subtle.digest.bind(crypto.subtle),verify:async(...args)=>{const valid=await crypto.subtle.verify(...args);return new Promise(resolve=>{finish=()=>resolve(valid);});}};dependencies.verifier=await SyntheticHmacVerifier.create(environment,records,now,adapter);const response=await new Ingress(dependencies,{deadlineMs:100,admission},environment).handle(await request(),{waitUntil:p=>{this.ctx.waitUntil(p);tracked.push(p);}});const pending=admission.snapshot();const overloaded=await new Ingress(dependencies,{admission},environment).handle(await request(records[0].key_id,'second'),this.ctx);finish();await Promise.all(tracked);return JSON.stringify({statuses:[response.status,overloaded.status],pending,settled:admission.snapshot(),counts:await counts()});`);
 assert.deepEqual(result,{statuses:[504,503],pending:{active:1,sources:0},settled:{active:0,sources:0},counts:{events:0,actions:0,nonces:0}});
});
test('audited request context registration failure cancels native proof without claims',async()=>{
 const result=await run(`const response=await new Ingress(dependencies,{},environment).handle(await request(),{waitUntil:()=>{throw new Error('private context failure');}});await new Promise(r=>setTimeout(r,20));return JSON.stringify({status:response.status,counts:await counts(),safe:!JSON.stringify(logs).includes('private')});`);
 assert.deepEqual(result,{status:500,counts:{events:0,actions:0,nonces:0},safe:true});
});
