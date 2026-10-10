import test from 'node:test';
import assert from 'node:assert/strict';
import {handleStagingRequest} from '../src/staging-runtime.js';

const closed={APACELY_ENVIRONMENT:'staging',APACELY_OPERATION:'ingest_mock_lead',APACELY_INGRESS_ENABLED:'false',APACELY_EFFECTS_ENABLED:'false'};
const lifetime={waitUntil(_promise:Promise<unknown>){}};
// Node fixture clone has no CF metadata; bridge the merged DOM/Workers generic overload only.
function cloneRequest(request:Request):Request {
 const result=request.clone();assert.ok(result instanceof Request);return result as Request;
}

test('invalid explicit flags and authority descriptors fail closed without side effects',async()=>{
 const cases:object[]=[{}, {...closed,APACELY_ENVIRONMENT:'development'}, {...closed,APACELY_OPERATION:'other'}, {...closed,APACELY_INGRESS_ENABLED:true}, {...closed,APACELY_EFFECTS_ENABLED:'true'}, {...closed,APACELY_EFFECTS_ENABLED:undefined},Object.create(closed),Object.defineProperty({...closed},'APACELY_INGRESS_ENABLED',{get(){throw Error('accessor');}})];
 for(const bindings of cases){
  let touched=0;Object.defineProperty(bindings,'DB',{get(){touched++;throw Error('DB forbidden');}});
  const request=new Request('https://staging.invalid/');Object.defineProperty(request,'body',{get(){touched++;throw Error('body forbidden');}});
  const response=await handleStagingRequest(request,bindings,lifetime);
  assert.equal(response.status,500);assert.equal((await response.json() as {code:unknown}).code,'internal');assert.equal(touched,0);
 }
});

test('disabled staging ingress rejects before touching request body, keys or database',async()=>{
 const runtime=await import('../src/staging-runtime.js').catch(()=>null);
 assert.notEqual(runtime,null,'closed staging runtime must exist');
 let touched=0;
 const request=new Request('https://staging.invalid/v1/ingress/synthetic',{method:'POST',body:'private synthetic payload'});
 Object.defineProperty(request,'body',{get(){touched++;throw new Error('must not read body');}});
 const bindings={APACELY_ENVIRONMENT:'staging',APACELY_OPERATION:'ingest_mock_lead',APACELY_INGRESS_ENABLED:'false',APACELY_EFFECTS_ENABLED:'false',get DB(){touched++;throw new Error('must not read DB');},get STAGING_SIGNING_KEY_CURRENT(){touched++;throw new Error('must not read key');}};
 const response=await runtime!.handleStagingRequest(request,bindings,{waitUntil(){touched++;}});
 assert.equal(response.status,503);
 assert.equal((await response.json() as {code:unknown}).code,'unavailable');
 assert.equal(response.headers.get('cache-control'),'no-store');
 assert.equal(touched,0);
});

test('closed boundary never initializes crypto even to make a request identifier',async()=>{
 const {handleStagingRequest}=await import('../src/staging-runtime.js');
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'crypto')!;
 let touched=0;
 Object.defineProperty(globalThis,'crypto',{configurable:true,get(){touched++;throw Error('crypto forbidden');}});
 try{
  const response=await handleStagingRequest(new Request('https://staging.invalid/'),{APACELY_ENVIRONMENT:'staging',APACELY_OPERATION:'ingest_mock_lead',APACELY_INGRESS_ENABLED:'false',APACELY_EFFECTS_ENABLED:'false'},{waitUntil(){throw Error('no retention');}});
  assert.equal(response.status,503);assert.equal(touched,0);
 }finally{Object.defineProperty(globalThis,'crypto',descriptor);}
});

import Database from 'better-sqlite3';
import {environmentSchema} from '../scripts/environment-schema.js';
import {D1Repository,type D1Binding,type D1Statement} from '../src/d1-repository.js';
import {D1SourceMappingStore} from '../src/source-mappings.js';
import {AdmissionCoordinator,bootstrapAdmission,type AdmissionStorage} from '../src/distributed-admission.js';
import {STAGING_POLICY} from '../src/staging-policy.js';
import {SignJWT,generateKeyPair,exportJWK} from 'jose';
import {fixture} from '../src/fixture.js';

async function setup(environment:'staging'|'development'='staging'){
 const sqlite=new Database(':memory:');sqlite.exec(environmentSchema(environment));
 let reads=0,writes=0,namespaceCalls=0;
 class Statement implements D1Statement{
  values:(string|number|null)[]=[];constructor(readonly sql:string){}
  bind(...values:(string|number|null)[]){this.values=values;return this;}
  async all<T>(){reads++;return {results:sqlite.prepare(this.sql).all(...this.values) as T[],success:true};}
  async run(){writes++;return sqlite.prepare(this.sql).run(...this.values);}
 }
 const DB:D1Binding={prepare(sql){return new Statement(sql);},async batch(statements){return sqlite.transaction(()=>statements.map(s=>{const st=s as Statement;const query=sqlite.prepare(st.sql);if(query.reader){reads++;return {results:query.all(...st.values),success:true};}writes++;return {results:[],success:true,meta:query.run(...st.values)};}))();}};
 const now=()=>new Date().toISOString();const repo=new D1Repository(DB,now,undefined,environment),mappings=new D1SourceMappingStore(DB,now,environment);
 const tenant=await repo.createTenant('Synthetic A');await mappings.create({provider:'synthetic',source:'source-a',principal:'principal-a',tenant_id:tenant.id,source_binding:'mock-source-a',environment,operation:'ingest_mock_lead'});
 const values=new Map<string,unknown>();
 const storage:AdmissionStorage={async get(k){return values.get(k);},async put(k,v){values.set(k,v);},async transaction(callback){const before=new Map(values);try{return await callback(storage);}catch(e){values.clear();for(const [k,v] of before)values.set(k,v);throw e;}}};
 await bootstrapAdmission(storage,STAGING_POLICY,Date.now());const coordinator=new AdmissionCoordinator(storage,STAGING_POLICY);
 const namespace={idFromName(name:string){assert.equal(name,'distributed-admission-v1');return name;},get(id:unknown){assert.equal(id,'distributed-admission-v1');return {async fetch(request:Request){namespaceCalls++;return coordinator.fetch(request);}};}};
 const bytes=crypto.getRandomValues(new Uint8Array(32));const key=await crypto.subtle.importKey('raw',bytes,{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const descriptor={slot:'current',key_id:'key-a',environment:'staging',provider:'synthetic',principal:'principal-a',source:'source-a',route:'/v1/ingress/synthetic',not_before:new Date(Date.now()-60000).toISOString(),not_after:new Date(Date.now()+60000).toISOString(),revoked_at:null};
 const {publicKey,privateKey}=await generateKeyPair('RS256');const jwk={...await exportJWK(publicKey),kid:'access-a',alg:'RS256',use:'sig'};
 const issuer='https://offline-synthetic.cloudflareaccess.com',audience='a'.repeat(64);
 const assertion=await new SignJWT({}).setProtectedHeader({alg:'RS256',kid:'access-a'}).setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime('1m').sign(privateKey);
 const bindings={...closed,APACELY_INGRESS_ENABLED:'true',DB,STAGING_ADMISSION:namespace,STAGING_ACCESS_ISSUER:issuer,STAGING_ACCESS_AUDIENCE:audience,STAGING_HMAC_KEY_REGISTRY:JSON.stringify([descriptor]),STAGING_SIGNING_KEY_CURRENT:Buffer.from(bytes).toString('base64')};
 async function request(nonce='nonce-a',body=JSON.stringify({...fixture,occurred_at:now()})):Promise<Request>{
  const signed_at=now(),digest=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(body))).toString('hex');
  const message=JSON.stringify(['apacely-synthetic-ingress-hmac-v1','staging','synthetic','principal-a','source-a','key-a','POST','/v1/ingress/synthetic',signed_at,nonce,digest]);
  const signature=Buffer.from(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(message))).toString('base64url');
  return new Request('https://staging.invalid/v1/ingress/synthetic',{method:'POST',headers:{'content-type':'application/json','Cf-Access-Jwt-Assertion':assertion,'apacely-key-id':'key-a','apacely-source':'source-a','apacely-signed-at':signed_at,'apacely-nonce':nonce,'apacely-signature':signature},body});
 }
 return {sqlite,DB,bindings,request,jwk,tenant,repo,mappings,storage,namespace,counters:()=>({reads,writes,namespaceCalls}),reset(){reads=writes=namespaceCalls=0;}};
}

test('real Access and HMAC compose through original D1 and distributed admission to pending mock effects',async()=>{
 const f=await setup();const originalFetch=globalThis.fetch;let fetched=0;const retained:Promise<unknown>[]=[];
 globalThis.fetch=async(url,init)=>{fetched++;assert.equal(String(url),f.bindings.STAGING_ACCESS_ISSUER+'/cdn-cgi/access/certs');assert.equal(init?.redirect,'manual');assert.ok(init?.signal);return Response.json({keys:[f.jwk]});};
 try{
  f.reset();const response=await handleStagingRequest(await f.request(),f.bindings,{waitUntil(p){retained.push(p);}});
  assert.equal(response.status,200,await response.text());await Promise.all(retained);
  assert.equal(fetched,1);assert.equal(retained.length,1);assert.ok(f.counters().namespaceCalls>=3);
  const events=f.sqlite.prepare('SELECT * FROM events').all() as any[];assert.equal(events.length,1);assert.equal(JSON.parse(events[0].normalized_payload).environment,'staging');assert.equal(events[0].tenant_id,f.tenant.id);
  const outbox=f.sqlite.prepare('SELECT * FROM action_outbox').all() as any[];assert.equal(outbox.length,1);assert.equal(outbox[0].status,'pending');assert.equal(outbox[0].environment,'staging');
  assert.equal(f.sqlite.prepare<unknown[],{n:number}>('SELECT count(*) AS n FROM replay_ledger').get()!.n,1);
 }finally{globalThis.fetch=originalFetch;f.sqlite.close();}
});

test('malformed secret slots reject before enabling body, storage or Access work',async()=>{
 const f=await setup();
 try{
  for(const value of ['', 'not-base64', 'B'.repeat(43)+'=']){
   let body=0;const request=await f.request();Object.defineProperty(request,'body',{get(){body++;throw Error('body forbidden');}});
   f.reset();const response=await handleStagingRequest(request,{...f.bindings,STAGING_SIGNING_KEY_CURRENT:value},lifetime);
   assert.equal(response.status,500);assert.equal(body,0);assert.deepEqual(f.counters(),{reads:0,writes:0,namespaceCalls:0});
  }
 }finally{f.sqlite.close();}
});

// These adversarial qualification tests exercise reused contracts; no claim of new core TDD history.
test('both cryptographic layers are mandatory and never reach mapped admission on failure',async()=>{
 const f=await setup(),originalFetch=globalThis.fetch;
 globalThis.fetch=async()=>Response.json({keys:[f.jwk]});
 try{
  for(const alter of [(r:Request)=>r.headers.delete('Cf-Access-Jwt-Assertion'),(r:Request)=>r.headers.set('Cf-Access-Jwt-Assertion','garbage'),(r:Request)=>r.headers.delete('apacely-signature'),(r:Request)=>r.headers.set('apacely-signature','A'.repeat(43)),(r:Request)=>r.headers.set('apacely-source','foreign-source')]){
   f.reset();const request=await f.request();alter(request);const retained:Promise<unknown>[]=[];
   const response=await handleStagingRequest(request,f.bindings,{waitUntil(p){retained.push(p);}});assert.equal(response.status,401);await response.text();await Promise.all(retained);
   assert.equal(f.counters().namespaceCalls,0);assert.equal(f.counters().writes,0);
  }
  assert.equal(f.sqlite.prepare<unknown[],{n:number}>('SELECT count(*) AS n FROM events').get()!.n,0);
  assert.equal(f.sqlite.prepare<unknown[],{n:number}>('SELECT count(*) AS n FROM replay_ledger').get()!.n,0);
 }finally{globalThis.fetch=originalFetch;f.sqlite.close();}
});

test('physical development DB denies before Access even with staging binding labels',async()=>{
 const f=await setup('development');let fetched=0;const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{fetched++;throw Error('must not fetch');};
 try{f.reset();const response=await handleStagingRequest(await f.request(),f.bindings,lifetime);assert.equal(response.status,403);await response.text();assert.equal(fetched,0);assert.equal(f.counters().writes,0);assert.equal(f.counters().namespaceCalls,0);}
 finally{globalThis.fetch=originalFetch;f.sqlite.close();}
});

test('trusted binding authority is snapshotted before delayed verification',async()=>{
 const f=await setup();const originalFetch=globalThis.fetch;
 globalThis.fetch=async()=>{f.bindings.APACELY_ENVIRONMENT='production';f.bindings.APACELY_EFFECTS_ENABLED='true';f.bindings.STAGING_SIGNING_KEY_CURRENT='mutated';f.bindings.STAGING_HMAC_KEY_REGISTRY='[]';return Response.json({keys:[f.jwk]});};
 try{const response=await handleStagingRequest(await f.request(),f.bindings,lifetime);assert.equal(response.status,200,await response.text());assert.equal(f.sqlite.prepare<[],{environment:string}>('SELECT environment FROM action_outbox').get()!.environment,'staging');}
 finally{globalThis.fetch=originalFetch;f.sqlite.close();}
});

import {localAdmission} from '../src/ingress-operations.js';
import {SyntheticHmacVerifier} from '../src/synthetic-hmac.js';
async function retainedDeadline(stage:'access'|'hmac'){
 const f=await setup(),request=await f.request(),originalFetch=globalThis.fetch,originalTimer=globalThis.setTimeout,originalCreate=SyntheticHmacVerifier.create;
 let expire:(()=>void)|undefined,resolve!:()=>void,entered!:()=>void;
 const gate=new Promise<void>(r=>resolve=r),started=new Promise<void>(r=>entered=r),retained:Promise<unknown>[]=[];let settled=false,imports=0;
 globalThis.setTimeout=((callback:any,ms?:number,...args:any[])=>{if(ms===10000)expire=()=>callback(...args);return originalTimer(callback,ms,...args);}) as typeof setTimeout;
 globalThis.fetch=async()=>{if(stage==='access'){entered();await gate;}return Response.json({keys:[f.jwk]});};
 SyntheticHmacVerifier.create=async(...args:Parameters<typeof originalCreate>)=>{imports++;if(stage==='hmac'){entered();await gate;}return originalCreate(...args);};
 try{
  f.reset();const responsePromise=handleStagingRequest(request,f.bindings,{waitUntil(p){retained.push(p);void p.then(()=>settled=true);}});
  await started;assert.ok(expire);assert.equal(localAdmission.snapshot().active,1);assert.equal(retained.length,1);expire();
  const response=await responsePromise;assert.equal(response.status,504);await response.text();assert.equal(settled,false);assert.equal(localAdmission.snapshot().active,1);
  resolve();await Promise.all(retained);assert.equal(localAdmission.snapshot().active,0);assert.equal(f.counters().writes,0);assert.equal(f.counters().namespaceCalls,0);assert.equal(imports,stage==='access'?0:1);
 }finally{resolve();await Promise.all(retained);globalThis.fetch=originalFetch;globalThis.setTimeout=originalTimer;SyntheticHmacVerifier.create=originalCreate;f.sqlite.close();}
}
test('Access/JWKS work uses retained ingress deadline without late HMAC or permit release',()=>retainedDeadline('access'));
test('lazy HMAC initialization uses retained ingress deadline without late storage writes',()=>retainedDeadline('hmac'));

test('waitUntil registration failure cancels before body or Access work',async()=>{
 const f=await setup(),originalFetch=globalThis.fetch;let fetched=0;globalThis.fetch=async()=>{fetched++;throw Error('forbidden');};
 try{f.reset();const response=await handleStagingRequest(await f.request(),f.bindings,{waitUntil(){throw Error('registration failure');}});assert.equal(response.status,500);await response.text();await new Promise(r=>setImmediate(r));assert.equal(fetched,0);assert.equal(f.counters().writes,0);assert.equal(localAdmission.snapshot().active,0);}
 finally{globalThis.fetch=originalFetch;f.sqlite.close();}
});

test('separate request compositions share anonymous local admission counters',async()=>{
 const f=await setup(),originalFetch=globalThis.fetch,template=await f.request();let release!:()=>void,ready!:()=>void,calls=0;
 const gate=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>ready=r),retained:Promise<unknown>[]=[];
 globalThis.fetch=async()=>{if(++calls===16)ready();await gate;return Response.json({keys:[f.jwk]});};
 const controllers=Array.from({length:16},()=>new AbortController());
 const pending=controllers.map(c=>handleStagingRequest(new Request(cloneRequest(template),{signal:c.signal}),f.bindings,{waitUntil(p){retained.push(p);}}));
 try{
  await entered;assert.equal(localAdmission.snapshot().active,16);
  const denied=await handleStagingRequest(cloneRequest(template),f.bindings,lifetime);assert.equal(denied.status,503);assert.equal((await denied.json() as {code:unknown}).code,'overloaded');assert.equal(calls,16);
  for(const c of controllers)c.abort();for(const response of await Promise.all(pending)){assert.equal(response.status,504);await response.text();}
  assert.equal(localAdmission.snapshot().active,16);release();await Promise.all(retained);assert.equal(localAdmission.snapshot().active,0);assert.equal(f.counters().namespaceCalls,0);
 }finally{for(const c of controllers)c.abort();release();await Promise.all(pending);await Promise.all(retained);globalThis.fetch=originalFetch;f.sqlite.close();}
});

test('same database and fixed coordinator isolate two tenant sources with overlapping external IDs',async()=>{
 const f=await setup(),originalFetch=globalThis.fetch;globalThis.fetch=async()=>Response.json({keys:[f.jwk]});
 try{
  const tenantB=await f.repo.createTenant('Synthetic B');await f.mappings.create({provider:'synthetic',source:'source-b',principal:'principal-b',tenant_id:tenantB.id,source_binding:'mock-source-b',environment:'staging',operation:'ingest_mock_lead'});
  const first=await f.request();const body=await first.clone().text();const a=await handleStagingRequest(first,f.bindings,lifetime);assert.equal(a.status,200,await a.text());
  const before=JSON.stringify(f.sqlite.prepare('SELECT * FROM events WHERE tenant_id=?').all(f.tenant.id));
  const bytes=crypto.getRandomValues(new Uint8Array(32)),key=await crypto.subtle.importKey('raw',bytes,{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const descriptor={...JSON.parse(f.bindings.STAGING_HMAC_KEY_REGISTRY)[0],key_id:'key-b',source:'source-b',principal:'principal-b'};
  const signed_at=new Date().toISOString(),nonce='nonce-b',digest=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(body))).toString('hex');
  const signature=Buffer.from(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(JSON.stringify(['apacely-synthetic-ingress-hmac-v1','staging','synthetic','principal-b','source-b','key-b','POST','/v1/ingress/synthetic',signed_at,nonce,digest])))).toString('base64url');
  const headers=new Headers(first.headers);headers.set('apacely-key-id','key-b');headers.set('apacely-source','source-b');headers.set('apacely-signed-at',signed_at);headers.set('apacely-nonce',nonce);headers.set('apacely-signature',signature);
  const bindings={...f.bindings,STAGING_HMAC_KEY_REGISTRY:JSON.stringify([descriptor]),STAGING_SIGNING_KEY_CURRENT:Buffer.from(bytes).toString('base64')};
  const b=await handleStagingRequest(new Request(first.url,{method:'POST',headers,body}),bindings,lifetime);assert.equal(b.status,200,await b.text());
  assert.equal(JSON.stringify(f.sqlite.prepare('SELECT * FROM events WHERE tenant_id=?').all(f.tenant.id)),before);
  assert.equal(f.sqlite.prepare<unknown[],{n:number}>('SELECT count(*) AS n FROM events WHERE tenant_id=?').get(tenantB.id)!.n,1);
  assert.equal(f.sqlite.prepare<unknown[],{n:number}>('SELECT count(*) AS n FROM action_outbox WHERE environment=? AND status=?').get('staging','pending')!.n,2);
  const forged=await f.request('nonce-forged',JSON.stringify({...fixture,tenant_id:tenantB.id}));const denied=await handleStagingRequest(forged,f.bindings,lifetime);assert.equal(denied.status,400);await denied.text();
  assert.equal(f.sqlite.prepare<unknown[],{n:number}>('SELECT count(*) AS n FROM events').get()!.n,2);
 }finally{globalThis.fetch=originalFetch;f.sqlite.close();}
});

test('identical replay stays idempotent and conflicting nonce cannot create effects',async()=>{
 const f=await setup(),originalFetch=globalThis.fetch;globalThis.fetch=async()=>Response.json({keys:[f.jwk]});
 try{
  const template=await f.request();
  for(let i=0;i<2;i++){const response=await handleStagingRequest(cloneRequest(template),f.bindings,lifetime);assert.equal(response.status,200,await response.text());}
  const conflicting=await f.request('nonce-a',JSON.stringify({...fixture,text:'different signed text',occurred_at:new Date().toISOString()}));
  const response=await handleStagingRequest(conflicting,f.bindings,lifetime);assert.equal(response.status,409);await response.text();
  for(const table of ['events','action_outbox','replay_ledger'])assert.equal(f.sqlite.prepare<unknown[],{n:number}>(`SELECT count(*) AS n FROM ${table}`).get()!.n,1);
 }finally{globalThis.fetch=originalFetch;f.sqlite.close();}
});

test('explicit enabled configuration rejects missing slots, accessor authority and malformed registry before storage',async()=>{
 const f=await setup();
 try{
  const invalid=[{...f.bindings,STAGING_ACCESS_AUDIENCE:'placeholder'},{...f.bindings,STAGING_ACCESS_ISSUER:'https://evil.invalid'}, {...f.bindings,STAGING_HMAC_KEY_REGISTRY:'[]'},{...f.bindings,STAGING_SIGNING_KEY_NEXT:undefined},{...f.bindings,STAGING_ADMISSION:undefined}];
  const accessor={...f.bindings};Object.defineProperty(accessor,'STAGING_SIGNING_KEY_CURRENT',{get(){throw Error('accessor forbidden');}});invalid.push(accessor);
  for(const bindings of invalid){f.reset();const request=await f.request();const response=await handleStagingRequest(request,bindings,lifetime);assert.equal(response.status,500);await response.text();assert.deepEqual(f.counters(),{reads:0,writes:0,namespaceCalls:0});}
 }finally{f.sqlite.close();}
});
