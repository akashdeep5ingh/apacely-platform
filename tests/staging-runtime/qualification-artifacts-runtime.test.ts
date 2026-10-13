import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from '../../node_modules/wrangler/node_modules/miniflare/dist/src/index.js';
import {credentials,provision,rows,ISSUER,AUDIENCE} from './staging-http-private.js';
import {fixture} from '../../src/fixture.js';
import * as fixedBindings from '../../src/qualification/artifacts/fixed-bindings.js';
import * as policies from '../../src/qualification/artifacts/fixed-policies.js';
import {createTicket,encodeMessage,decodeMessage,type AdmissionPolicy,type AdmissionTicket,type AdmissionRequest} from '../../src/distributed-admission.js';
const NOW=1000; // Test-only frozen core clock: no production controls or rate-window timing race.
const ROOT='/root/apacely-staging-evidence/phase4/artifacts';
const cases=[['contention16','contention16'],['capacity16-source4','capacity16Source4'],['source-keys128','sourceKeys128'],['source-rate100','sourceRate100']] as const;
function ownership(){
 assert.equal(process.versions.node,'22.23.3','pinned runtime required');
 assert.equal(process.env.APACELY_HTTP_EMULATOR_OWNER,'parent-serial-approved','parent is sole emulator owner');
 assert.equal(process.env.MINIFLARE_ASSERT_BODIES_CONSUMED,'true');
}
async function bundle(contents:string){return (await build({stdin:{contents,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers']})).outputFiles[0].text;}
async function harness(name:string,mode:'bootstrap'|'sealed',persist:string,http?:{bindings:Record<string,string>;jwk:object;observeDenials?:boolean;full258?:boolean;cryptoDelay?:'digest'|'import';accessDelay?:boolean;gate?:{entered:()=>void;wait:Promise<void>}}){
 const target=await bundle(`${http?'':'Date.now=()=>1000;'}import originalWorker,{StagingAdmissionCoordinator as Base} from './src/qualification/artifacts/${name}-${mode}.ts';export class StagingAdmissionCoordinator extends Base {${http?.observeDenials?`#denials=[];async fetch(request){const response=await super.fetch(request);const text=await response.text();if(response.status===409)this.#denials.push(JSON.parse(text).result);return new Response(text,{status:response.status,headers:response.headers});}async denials(){return this.#denials;}`:''}async snapshot(){return [...await this.ctx.storage.list()];}}${http?.cryptoDelay||http?.accessDelay?`import {WorkerEntrypoint} from 'cloudflare:workers';import {createStagingRuntime} from './src/staging-runtime.ts';import {captureQualifiedAuthority,importQualifiedAuthority} from './src/qualification/hmac-capability.ts';import {SOURCE129} from './src/qualification/keyrings.ts';import {sourceKeys128} from './src/qualification/artifacts/fixed-policies.ts';import {localAdmission} from './src/ingress-operations.ts';const retained=new Set();let imports=0,digests=0,originalSignal;const native=crypto.subtle;const adapter={async digest(...args){digests++;const result=await native.digest(...args);if('${http.cryptoDelay}'==='digest'&&digests===1){const response=await fetch('${ISSUER}/cdn-cgi/access/certs?qualification-crypto-gate=1');await response.text();}return result;},async importKey(...args){imports++;const result=await native.importKey(...args);if('${http.cryptoDelay}'==='import'&&imports===1){const response=await fetch('${ISSUER}/cdn-cgi/access/certs?qualification-crypto-gate=1');await response.text();}return result;},verify:native.verify.bind(native)};const handle=createStagingRuntime(null,sourceKeys128,(env,signal,now)=>{originalSignal=signal;const authority=captureQualifiedAuthority(SOURCE129,env,adapter,signal);return ()=>importQualifiedAuthority(authority,now,signal);});class DeadlineProbe extends WorkerEntrypoint {fetch(request){return handle(request,this.env,{waitUntil:p=>{retained.add(p);this.ctx.waitUntil(p.finally(()=>retained.delete(p)));}});}peek(){return {pending:retained.size,active:localAdmission.snapshot().active,aborted:originalSignal?.aborted??false,imports,digests};}async settled(){await Promise.all([...retained]);return {pending:retained.size,active:localAdmission.snapshot().active,imports,digests};}}const worker=DeadlineProbe;`:http?.full258?`import {createFixedKeyringRuntime} from './src/qualification/runtime.ts';import {FULL258} from './src/qualification/keyrings.ts';import {sourceKeys128} from './src/qualification/artifacts/fixed-policies.ts';const handle=createFixedKeyringRuntime(sourceKeys128,FULL258);const worker={fetch(request,env,ctx){return handle(request,env,ctx);}};`:'const worker=originalWorker;'}export default worker;`);
 const initializer=await bundle(`export {default} from './src/qualification/initialization-worker.ts';`);
 const probe=await bundle(`import {WorkerEntrypoint} from 'cloudflare:workers';export default class extends WorkerEntrypoint {async birth(){try{await this.env.INIT.invokeFirstBirth();return true;}catch{return false;}}async peek(){return this.env.RUNTIME.peek();}async settled(){return this.env.RUNTIME.settled();}async denials(){const result=await this.env.TARGET.get(this.env.TARGET.idFromName('distributed-admission-v1')).denials();try{return JSON.stringify(result);}finally{result[Symbol.dispose]?.();}}async snapshot(){const result=await this.env.TARGET.get(this.env.TARGET.idFromName('distributed-admission-v1')).snapshot();try{return JSON.stringify(result);}finally{result[Symbol.dispose]?.();}}fetch(){return new Response(null,{status:503});}}`);
 const targetName=`apacely-qualification-${name}-disabled`,initName=`apacely-qualification-${name}-initializer-disabled`;
 const blocked:string[]=[];let jwks=0;
 const outboundService=async(request:{url:string;method:string})=>{
  if(http?.cryptoDelay&&http.gate&&request.url===ISSUER+'/cdn-cgi/access/certs?qualification-crypto-gate=1'&&request.method==='GET'){http.gate.entered();await http.gate.wait;return new Response('released');}
  if(!http||request.url!==ISSUER+'/cdn-cgi/access/certs'||request.method!=='GET'){blocked.push(new URL(request.url).origin);throw Error('External network forbidden');}
  jwks++;if(http.accessDelay&&http.gate){http.gate.entered();await http.gate.wait;}return Response.json({keys:[http.jwk]});
 };
 const options=convertV4MiniflareOptions({host:'127.0.0.1',cf:false,workers:[
  {name:targetName,modules:true,script:target,compatibilityDate:'2025-07-18',bindings:{APACELY_ENVIRONMENT:'staging',APACELY_OPERATION:'ingest_mock_lead',APACELY_INGRESS_ENABLED:'false',APACELY_EFFECTS_ENABLED:'false',...http?.bindings},d1Databases:{DB:`apacely-qualification-${name}`},durableObjects:{STAGING_ADMISSION:{className:'StagingAdmissionCoordinator',useSQLite:true}},outboundService},
  {name:initName,modules:true,script:initializer,compatibilityDate:'2025-07-18',durableObjects:{QUALIFICATION_ADMISSION:{className:'StagingAdmissionCoordinator',scriptName:targetName}},outboundService},
  {name:'private-probe',modules:true,script:probe,compatibilityDate:'2025-07-18',serviceBindings:{INIT:initName,...(http?.cryptoDelay||http?.accessDelay)?{RUNTIME:targetName}:{}},durableObjects:{TARGET:{className:'StagingAdmissionCoordinator',scriptName:targetName}},outboundService}
 ]});
 const mf=new Miniflare({...options,resourcePersistencePath:persist});await mf.ready;
 const worker=await mf.getWorker('private-probe');const rawProbe=worker as typeof worker & {birth():Promise<boolean>;peek():Promise<{pending:number;active:number;aborted:boolean;imports:number;digests:number}>;settled():Promise<{pending:number;active:number;imports:number;digests:number}>;snapshot():Promise<string>;denials():Promise<string>};
 // Return primitive RPC strings, then reconstruct plain immutable-oracle snapshots on the host.
 const probeWorker={birth:()=>rawProbe.birth(),peek:()=>rawProbe.peek(),settled:()=>rawProbe.settled(),snapshot:async()=>JSON.parse(await rawProbe.snapshot()) as [string,unknown][],denials:async()=>JSON.parse(await rawProbe.denials()) as {tag:string;reason:string}[]};
 const ns=await mf.getDurableObjectNamespace('STAGING_ADMISSION',targetName);
 return {mf,probe:probeWorker,stub:ns.get(ns.idFromName('distributed-admission-v1')),targetName,jwks:()=>jwks,blocked,db:()=>mf.getD1Database('DB',targetName),state:()=>probeWorker.snapshot(),async birth(){assert.equal(await probeWorker.birth(),true);}};
}
function authority(source='source-001'){
 return {environment:'staging' as const,tenant:'20000000-0000-4000-8000-000000000001',provider:'synthetic',principal:'qualification',source,mappingId:'30000000-0000-4000-8000-000000000001',mappingVersion:1,sourceBinding:source,operation:'ingest_mock_lead' as const};
}
async function send(stub:Awaited<ReturnType<typeof harness>>['stub'],ticket:AdmissionTicket,operation:AdmissionRequest['operation']='reserve',expectedStatus=200){
 const payload:AdmissionRequest['payload']=operation==='settle'?{kind:'known-not-issued' as const,barrierId:'50000000-0000-4000-8000-000000000001'}:{};
 const response=await stub.fetch('https://admission.internal/v1/'+operation,{method:'POST',headers:{'content-type':'application/json'},body:encodeMessage({version:1,operation,ticket,payload})});
 const text=await response.text();assert.equal(response.status,expectedStatus,text);return decodeMessage(text,'reply').result;
}
for(const [name,key] of cases)test(`${name}: actual fixed bootstrap RPC and same-namespace sealed restart preserve birth policy and charged records`,async()=>{
 ownership();await mkdir(ROOT,{recursive:true,mode:0o700});const persist=await mkdtemp(ROOT+`/${name}-`);let h=await harness(name,'bootstrap',persist);
 try{
  assert.equal(await h.probe.birth(),true);const birth=await h.probe.snapshot();assert.equal(birth.length,3);
  assert.deepEqual(birth.map(([key])=>key).sort(),['distributed-admission/birth/v1','distributed-admission/state/v1','distributed-admission/storage-budget/v1'].sort());
  const seal=JSON.parse(String(new Map(birth).get('distributed-admission/storage-budget/v1')));assert.equal(seal.maxStateChars,262144);assert.equal(seal.policyDigest,createTicket(policies[key],authority(),NOW+10000).context.policyDigest);
  const marker=JSON.parse(String(new Map(birth).get('distributed-admission/birth/v1')));
  assert.equal(marker.epoch,policies[key].epoch);assert.equal(marker.policyDigest,createTicket(policies[key],authority(),NOW+10000).context.policyDigest);
  assert.equal(await h.probe.birth(),false);assert.deepEqual(await h.probe.snapshot(),birth);
  await h.mf.dispose();h=await harness(name,'sealed',persist);assert.deepEqual(await h.probe.snapshot(),birth);
  assert.equal(await h.probe.birth(),false);assert.deepEqual(await h.probe.snapshot(),birth);
  const policy=policies[key],ticket=createTicket(policy,authority(),NOW+10000);
  const accepted=await send(h.stub,ticket);assert.equal(accepted.tag,'record');const charged=await h.probe.snapshot();
  const foreign=policies[key==='contention16'?'sourceRate100':'contention16'];
  const denied=await send(h.stub,createTicket(foreign,authority(),NOW+10000),'reserve',409);assert.equal(denied.tag,'denied');if(denied.tag==='denied')assert.equal(denied.reason,'policy');assert.deepEqual(await h.probe.snapshot(),charged);
  const response=await h.mf.dispatchFetch('https://local.invalid/initialize?profile=sourceKeys128&reset=1',{method:'POST',body:'{}'});assert.equal(response.status,503);await response.text();assert.deepEqual(await h.probe.snapshot(),charged);
  await h.mf.dispose();h=await harness(name,'sealed',persist);assert.deepEqual(await h.probe.snapshot(),charged);
 }finally{await h.mf.dispose();}
});
for(const [name,key] of cases)test(`${name}: enabled fixed HTTP artifact authenticates independent sources on retained original D1 and rejects spoofing without row changes`,async()=>{
 ownership();await mkdir(ROOT,{recursive:true,mode:0o700});const persist=await mkdtemp(ROOT+`/http-${name}-`);
 const c=await credentials(),keys=new Map<string,CryptoKey>();
 const fixed=fixedBindings[key]({}) as Record<string,string>;
 const descriptors=JSON.parse(fixed.QUALIFICATION_HMAC_KEY_REGISTRY) as {slot:string;secret_slot:string;key_id:string;principal:string;source:string;not_before:string;not_after:string}[];
 const current=descriptors.filter(d=>d.slot==='current');
 assert.ok(Date.now()>=Date.parse(current[0].not_before)&&Date.now()<Date.parse(current[0].not_after),'compiled synthetic key lifecycle expired/not active: reviewed rebuild required');
 const bindings:Record<string,string>={APACELY_ENVIRONMENT:'staging',APACELY_OPERATION:'ingest_mock_lead',APACELY_INGRESS_ENABLED:'true',APACELY_EFFECTS_ENABLED:'false',STAGING_ACCESS_ISSUER:ISSUER,STAGING_ACCESS_AUDIENCE:AUDIENCE};
 const encoded:string[]=[];for(const d of descriptors){const bytes=crypto.getRandomValues(new Uint8Array(32));try{const secret=Buffer.from(bytes).toString('base64');if(key==='sourceKeys128')encoded.push(secret);else bindings[d.secret_slot]=secret;keys.set(d.key_id,await crypto.subtle.importKey('raw',bytes,{name:'HMAC',hash:'SHA-256'},false,['sign']));}finally{bytes.fill(0);}}if(key==='sourceKeys128')SHARD_NAMES.forEach((name,i)=>bindings[name]=JSON.stringify(encoded.slice(i*65,(i+1)*65)));encoded.fill('');
 const http={bindings,jwk:c.jwk};let h=await harness(name,'bootstrap',persist,http);
 try{
  const tenants=await provision(h),db=await h.db();
  // New fixed-scope mappings, not mutations of immutable source routing tombstones.
  for(const [tenant,n] of [[tenants.a,'001'],[tenants.b,'002']]){
   const now=new Date().toISOString();
   await db.prepare("INSERT INTO source_mappings (id,version,provider,source,principal,tenant_id,source_binding,environment,operation,status,created_at,updated_at,revoked_at,revoked_version) VALUES (?,1,?,?,?,?,?,?,?,'active',?,?,NULL,NULL)").bind(crypto.randomUUID(),'synthetic','source-'+n,'principal-'+n,tenant,'mock-source-'+n,'staging','ingest_mock_lead',now,now).run();
  }
  await h.birth();await h.mf.dispose();h=await harness(name,'sealed',persist,http);
  const body=JSON.stringify({...fixture,occurred_at:new Date().toISOString()});
  async function signed(index:number,nonce:string,payload=body){
   const d=current[index],signedAt=new Date().toISOString();
   const digest=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(payload))).toString('hex');
   const message=JSON.stringify(['apacely-synthetic-ingress-hmac-v1','staging','synthetic',d.principal,d.source,d.key_id,'POST','/v1/ingress/synthetic',signedAt,nonce,digest]);
   const signature=Buffer.from(await crypto.subtle.sign('HMAC',keys.get(d.key_id)!,new TextEncoder().encode(message))).toString('base64url');
   return {method:'POST',body:payload,headers:{'content-type':'application/json','Cf-Access-Jwt-Assertion':c.assertion,'apacely-key-id':d.key_id,'apacely-source':d.source,'apacely-signed-at':signedAt,'apacely-nonce':nonce,'apacely-signature':signature}};
  }
  async function sendHttp(input:Awaited<ReturnType<typeof signed>>,status:number){const response=await h.mf.dispatchFetch('https://staging.invalid/v1/ingress/synthetic',input);const text=await response.text();assert.equal(response.status,status,text);}
  await sendHttp(await signed(0,'accepted-001'),200);await sendHttp(await signed(1,'accepted-002'),200);
  const accepted=await rows(h);
  for(const table of ['leads','conversations','events','messages','qualification_state','action_outbox']){assert.equal(accepted[table].length,2,table);for(const tenant of [tenants.a,tenants.b])assert.equal(accepted[table].filter(r=>r.tenant_id===tenant).length,1);}
  assert.equal(accepted.replay_ledger.length,2);
  for(const row of accepted.action_outbox){assert.equal(row.environment,'staging');assert.equal(row.status,'pending');assert.equal(row.attempts,0);assert.equal(row.recorded_at,null);}
  const spoof=await signed(0,'spoof');spoof.headers['apacely-source']='source-002';await sendHttp(spoof,401);assert.deepEqual(await rows(h),accepted);
  await sendHttp(await signed(0,'forged-tenant',JSON.stringify({...JSON.parse(body),tenant_id:tenants.b})),400);assert.deepEqual(await rows(h),accepted);
  const unsigned=await signed(1,'no-access');unsigned.headers['Cf-Access-Jwt-Assertion']='invalid';await sendHttp(unsigned,401);assert.deepEqual(await rows(h),accepted);
  assert.ok(h.jwks()>0);assert.deepEqual(h.blocked,[]);
  await h.mf.dispose();h=await harness(name,'sealed',persist,http);assert.deepEqual(await rows(h),accepted);
 }finally{await h.mf.dispose();c.erase();keys.clear();for(const d of descriptors)delete bindings[d.secret_slot];for(const name of SHARD_NAMES)delete bindings[name];}
});
// Mandatory exact capacity oracles on the fixed qualification-only storage capability.
for(const [name,key,count,distinct,reason] of [
 ['source-rate100','sourceRate100',100,false,'rate-source'],
 ['source-keys128','sourceKeys128',128,true,'keys']
] as const)test(`${name}: exact ${count} settled owners before required ${reason} denial`,async()=>{
 ownership();await mkdir(ROOT,{recursive:true,mode:0o700});const persist=await mkdtemp(ROOT+`/capacity-${name}-`);let h=await harness(name,'bootstrap',persist);
 try{
  assert.equal(await h.probe.birth(),true);await h.mf.dispose();h=await harness(name,'sealed',persist);
  const policy:AdmissionPolicy=policies[key],window=Math.floor(NOW/policy.windowMs);
  for(let i=0;i<count;i++){
   assert.equal(Math.floor(NOW/policy.windowMs),window,'fixed rate window must not drift during qualification');
   const admitted=await send(h.stub,createTicket(policy,authority(distinct?`source-${String(i+1).padStart(3,'0')}`:'source-001'),NOW+10000));
   assert.equal(admitted.tag,'record',`required admission ${i+1}: ${JSON.stringify(admitted)}`);
   if(admitted.tag==='record')assert.equal((await send(h.stub,admitted.record.handle,'settle')).tag,'record');
  }
  const before=await h.probe.snapshot();const denied=await send(h.stub,createTicket(policy,authority(distinct?'source-129':'source-001'),NOW+10000),'reserve',409);
  assert.equal(denied.tag,'denied');if(denied.tag==='denied')assert.equal(denied.reason,reason);assert.deepEqual(await h.probe.snapshot(),before);
 }finally{await h.mf.dispose();}
});

import {SOURCE129,SHARD_NAMES} from '../../src/qualification/keyrings.js';
test('source129 actual full-ring HTTP authentication reaches keys denial with 128 retained original owners',async()=>{
 ownership();await mkdir(ROOT,{recursive:true,mode:0o700});const persist=await mkdtemp(ROOT+'/fullring129-'),c=await credentials(),signers:CryptoKey[]=[],secrets:string[]=[];
 const bindings:Record<string,string>={APACELY_ENVIRONMENT:'staging',APACELY_OPERATION:'ingest_mock_lead',APACELY_INGRESS_ENABLED:'true',APACELY_EFFECTS_ENABLED:'false',STAGING_ACCESS_ISSUER:ISSUER,STAGING_ACCESS_AUDIENCE:AUDIENCE};
 let h:Awaited<ReturnType<typeof harness>>|undefined;
 try{
  for(const descriptor of SOURCE129.descriptors){const bytes=crypto.getRandomValues(new Uint8Array(32));try{secrets.push(Buffer.from(bytes).toString('base64'));signers.push(await crypto.subtle.importKey('raw',bytes,{name:'HMAC',hash:'SHA-256'},false,['sign']));}finally{bytes.fill(0);}}
  SHARD_NAMES.forEach((name,i)=>bindings[name]=JSON.stringify(secrets.slice(i*65,(i+1)*65)));
  const http={bindings,jwk:c.jwk,observeDenials:true};h=await harness('source-keys128','bootstrap',persist,http);const tenants=await provision(h),db=await h.db(),mappings:Record<string,string>={};
  for(const d of SOURCE129.descriptors){const id=crypto.randomUUID(),now=new Date().toISOString();mappings[d.source]=id;await db.prepare("INSERT INTO source_mappings (id,version,provider,source,principal,tenant_id,source_binding,environment,operation,status,created_at,updated_at,revoked_at,revoked_version) VALUES (?,1,?,?,?,?,?,?,?,'active',?,?,NULL,NULL)").bind(id,d.provider,d.source,d.principal,tenants.a,'mock-'+d.source,'staging','ingest_mock_lead',now,now).run();}
  await h.birth();await h.mf.dispose();h=await harness('source-keys128','sealed',persist,http);
  const signed=async(index:number,nonce:string)=>{const d=SOURCE129.descriptors[index],signed_at=new Date().toISOString(),body=JSON.stringify({...fixture,occurred_at:signed_at}),digest=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(body))).toString('hex');const message=JSON.stringify(['apacely-synthetic-ingress-hmac-v1','staging',d.provider,d.principal,d.source,d.key_id,'POST',d.route,signed_at,nonce,digest]);const signature=Buffer.from(await crypto.subtle.sign('HMAC',signers[index],new TextEncoder().encode(message))).toString('base64url');return {method:'POST',body,headers:{'content-type':'application/json','Cf-Access-Jwt-Assertion':c.assertion,'apacely-key-id':d.key_id,'apacely-source':d.source,'apacely-signed-at':signed_at,'apacely-nonce':nonce,'apacely-signature':signature}};};
  // Align the unchanged real rate window; no runtime clock/lifecycle/deadline override.
  const started=Date.now();let window:number;
  for(let i=0;i<127;i++){
   const d=SOURCE129.descriptors[i],a={...authority(d.source),tenant:tenants.a,principal:d.principal,mappingId:mappings[d.source],sourceBinding:'mock-'+d.source};
   const admitted=await send(h.stub,createTicket(policies.sourceKeys128,a,Date.now()+10000));assert.equal(admitted.tag,'record','owner '+i);if(admitted.tag==='record')assert.equal((await send(h.stub,admitted.record.handle,'settle')).tag,'record');
  }
  // Align only the final HTTP admission/denial pair, keeping all previously settled owners within unchanged retention.
  const wait=policies.sourceKeys128.windowMs-Date.now()%policies.sourceKeys128.windowMs+20;await new Promise(resolve=>setTimeout(resolve,wait));window=Math.floor(Date.now()/policies.sourceKeys128.windowMs);
  const accepted=await h.mf.dispatchFetch('https://staging.invalid/v1/ingress/synthetic',await signed(127,'source128-admitted'));const acceptedText=await accepted.text();assert.equal(accepted.status,200,acceptedText);
  const before=await h.state(),rowsBefore=await rows(h),state=JSON.parse(String(new Map(before).get('distributed-admission/state/v1')));
  assert.equal(state.registry.length,128);assert.equal(state.sources.length,128);assert.equal(rowsBefore.events.length,1);assert.equal(rowsBefore.replay_ledger.length,1);assert.equal(rowsBefore.action_outbox.length,1);
  const jwksBefore=h.jwks(),cold=performance.now();const denied=await h.mf.dispatchFetch('https://staging.invalid/v1/ingress/synthetic',await signed(128,'source129-denied'));const text=await denied.text();assert.equal(denied.status,503,text);assert.equal(JSON.parse(text).code,'overloaded');
  assert.deepEqual(await h.probe.denials(),[{tag:'denied',reason:'keys',retryAfterSeconds:null}]);assert.ok(h.jwks()>jwksBefore);assert.deepEqual(await rows(h),rowsBefore);const after=await h.state(),afterState=JSON.parse(String(new Map(after).get('distributed-admission/state/v1')));assert.ok(afterState.clockHighWater>=state.clockHighWater&&afterState.clockHighWater<=Date.now());const beforeComparable={...state,clockHighWater:0},afterComparable={...afterState,clockHighWater:0};assert.equal(JSON.stringify(afterComparable)===JSON.stringify(beforeComparable),true,'all retained owners, source counts, arrivals, fence and policy remain exact; only monotonic real clock observation advances');for(const key of ['distributed-admission/birth/v1','distributed-admission/storage-budget/v1'])assert.equal(new Map(after).get(key),new Map(before).get(key));assert.equal(Math.floor(Date.now()/policies.sourceKeys128.windowMs),window,'final HTTP source128 and source129 must share the unchanged real rate window');assert.ok(Date.now()-started<policies.sourceKeys128.diagnosticTtlMs,'all direct owners must remain within unchanged retention');assert.deepEqual(h.blocked,[]);
  console.log(JSON.stringify({measurement:'actual-workerd-source129-fullring-http-keys-denial',http_elapsed_ms:performance.now()-cold,owner_sequence_elapsed_ms:Date.now()-started,starting_window:window,ending_window:Math.floor(Date.now()/policies.sourceKeys128.windowMs),owners:128,ring_records:129,http_authenticated_sources:2,limits:'127 trusted direct DO owners plus one source128 HTTP owner; source129 real Access/HMAC/D1/DO; host elapsed only, not workerd CPU or peak memory/startup'}));
 }finally{if(h)await h.mf.dispose();c.erase();signers.length=0;secrets.fill('');for(const name of SHARD_NAMES)delete bindings[name];}
});

for(const stage of ['access','digest','import'] as const)test(stage==='access'?'source129 delayed Access subordinate 2s network-timeout containment forbids late D1 replay or DO effects':'source129 actual retained deadline holds delayed '+stage+' settlement and forbids late D1 replay or DO effects',async()=>{
 ownership();await mkdir(ROOT,{recursive:true,mode:0o700});const persist=await mkdtemp(ROOT+'/late-'+stage+'-'),c=await credentials(),secrets:string[]=[];let signing:CryptoKey|undefined,release!:()=>void,entered!:()=>void;
 const wait=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r),bindings:Record<string,string>={APACELY_ENVIRONMENT:'staging',APACELY_OPERATION:'ingest_mock_lead',APACELY_INGRESS_ENABLED:'true',APACELY_EFFECTS_ENABLED:'false',STAGING_ACCESS_ISSUER:ISSUER,STAGING_ACCESS_AUDIENCE:AUDIENCE};let h:Awaited<ReturnType<typeof harness>>|undefined;
 try{
  for(let i=0;i<129;i++){const bytes=crypto.getRandomValues(new Uint8Array(32));try{secrets.push(Buffer.from(bytes).toString('base64'));if(i===128)signing=await crypto.subtle.importKey('raw',bytes,{name:'HMAC',hash:'SHA-256'},false,['sign']);}finally{bytes.fill(0);}}
  SHARD_NAMES.forEach((name,i)=>bindings[name]=JSON.stringify(secrets.slice(i*65,(i+1)*65)));let gateEntered=false;const http={bindings,jwk:c.jwk,cryptoDelay:stage==='access'?undefined:stage,accessDelay:stage==='access',gate:{entered:()=>{gateEntered=true;entered();},wait}};console.log(JSON.stringify({probe:'late-crypto',stage,phase:'bootstrap-start'}));
  h=await harness('source-keys128','bootstrap',persist,http);console.log(JSON.stringify({probe:'late-crypto',stage,phase:'bootstrap-ready'}));const tenants=await provision(h),db=await h.db(),r=SOURCE129.descriptors[128],now=new Date().toISOString();await db.prepare("INSERT INTO source_mappings (id,version,provider,source,principal,tenant_id,source_binding,environment,operation,status,created_at,updated_at,revoked_at,revoked_version) VALUES (?,1,?,?,?,?,?,?,?,'active',?,?,NULL,NULL)").bind(crypto.randomUUID(),r.provider,r.source,r.principal,tenants.a,'mock-'+r.source,'staging','ingest_mock_lead',now,now).run();await h.birth();console.log(JSON.stringify({probe:'late-crypto',stage,phase:'birth-done'}));await h.mf.dispose();h=await harness('source-keys128','sealed',persist,http);console.log(JSON.stringify({probe:'late-crypto',stage,phase:'sealed-ready'}));
  const before=await rows(h),state=await h.state(),signed_at=new Date().toISOString(),nonce='late-'+stage,body=JSON.stringify({...fixture,occurred_at:signed_at}),digest=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(body))).toString('hex'),message=JSON.stringify(['apacely-synthetic-ingress-hmac-v1','staging',r.provider,r.principal,r.source,r.key_id,'POST',r.route,signed_at,nonce,digest]),signature=Buffer.from(await crypto.subtle.sign('HMAC',signing!,new TextEncoder().encode(message))).toString('base64url');
  const pending=h.mf.dispatchFetch('https://staging.invalid/v1/ingress/synthetic',{method:'POST',body,headers:{'content-type':'application/json','Cf-Access-Jwt-Assertion':c.assertion,'apacely-key-id':r.key_id,'apacely-source':r.source,'apacely-signed-at':signed_at,'apacely-nonce':nonce,'apacely-signature':signature}}).then(async response=>({status:response.status,text:await response.text()}));await Promise.race([started,pending.then(async response=>{if(!gateEntered){throw Error('late-crypto completed before gate: status '+response.status+' code '+String(JSON.parse(response.text).code));}return new Promise<void>(()=>{});})]);console.log(JSON.stringify({probe:'late-crypto',stage,phase:'gate-entered'}));
  // Host bridge may retain dispatch delivery until waitUntil settles: observe the original abort/permit through private RPC while the crypto result remains gated.
  await new Promise(resolve=>setTimeout(resolve,stage==='access'?3000:11000));const observed=JSON.parse(JSON.stringify(await h.probe.peek()));console.log(JSON.stringify({probe:'late-crypto',stage,phase:'expired-observed',...observed}));if(stage==='access'){assert.equal(observed.aborted,false);assert.equal(observed.imports,0);assert.equal(observed.digests,0);}else assert.deepEqual(observed,{pending:1,active:1,aborted:true,imports:stage==='import'?1:0,digests:stage==='digest'?1:129});assert.deepEqual(await rows(h),before);assert.deepEqual(await h.state(),state);console.log(JSON.stringify({probe:'late-crypto',stage,phase:'expired-state-readback'}));// Do not call an awaiting RPC before releasing the host callback: its synchronous client bridge blocks the callback owner. The exact pending=1 observation above proves retained unsettled work.
  release();console.log(JSON.stringify({probe:'late-crypto',stage,phase:'gate-released'}));const response=await pending;console.log(JSON.stringify({probe:'late-crypto',stage,phase:'http-consumed',status:response.status}));assert.equal(response.status,stage==='access'?401:504,response.text);let completed:{pending:number;active:number;aborted:boolean;imports:number;digests:number}|undefined;for(let poll=0;poll<100;poll++){await new Promise(resolve=>setTimeout(resolve,20));completed=JSON.parse(JSON.stringify(await h.probe.peek()));if(completed!.pending===0)break;}assert.deepEqual(completed,{pending:0,active:0,aborted:stage!=='access',imports:stage==='import'?1:0,digests:stage==='access'?0:stage==='digest'?1:129});console.log(JSON.stringify({probe:'late-crypto',stage,phase:'settlement-observed'}));assert.deepEqual(await rows(h),before);assert.deepEqual(await h.state(),state);assert.deepEqual(h.blocked,[]);
 }finally{release();if(h)await h.mf.dispose();c.erase();signing=undefined;secrets.fill('');for(const name of SHARD_NAMES)delete bindings[name];}
});

import {FULL258} from '../../src/qualification/keyrings.js';
test('full258 actual qualifier HTTP imports one ring and authenticates currents across shard boundaries with future rotations denied',async()=>{
 ownership();await mkdir(ROOT,{recursive:true,mode:0o700});const persist=await mkdtemp(ROOT+'/fullring258-'),c=await credentials(),signers:CryptoKey[]=[],secrets:string[]=[];
 const bindings:Record<string,string>={APACELY_ENVIRONMENT:'staging',APACELY_OPERATION:'ingest_mock_lead',APACELY_INGRESS_ENABLED:'true',APACELY_EFFECTS_ENABLED:'false',STAGING_ACCESS_ISSUER:ISSUER,STAGING_ACCESS_AUDIENCE:AUDIENCE};let h:Awaited<ReturnType<typeof harness>>|undefined;
 try{
  for(const d of FULL258.descriptors){const bytes=crypto.getRandomValues(new Uint8Array(32));try{secrets.push(Buffer.from(bytes).toString('base64'));signers.push(await crypto.subtle.importKey('raw',bytes,{name:'HMAC',hash:'SHA-256'},false,['sign']));}finally{bytes.fill(0);}}
  SHARD_NAMES.forEach((name,i)=>bindings[name]=JSON.stringify(secrets.slice(i*65,(i+1)*65)));const http={bindings,jwk:c.jwk,full258:true};const startup=performance.now();h=await harness('source-keys128','bootstrap',persist,http);const readyElapsed=performance.now()-startup,tenants=await provision(h),db=await h.db();
  for(const index of [0,64,65,128]){const d=FULL258.descriptors[index],now=new Date().toISOString();await db.prepare("INSERT INTO source_mappings (id,version,provider,source,principal,tenant_id,source_binding,environment,operation,status,created_at,updated_at,revoked_at,revoked_version) VALUES (?,1,?,?,?,?,?,?,?,'active',?,?,NULL,NULL)").bind(crypto.randomUUID(),d.provider,d.source,d.principal,index===0?tenants.b:tenants.a,'mock-'+d.source,'staging','ingest_mock_lead',now,now).run();}
  await h.birth();await h.mf.dispose();h=await harness('source-keys128','sealed',persist,http);
  async function signed(index:number){const d=FULL258.descriptors[index],signed_at=new Date().toISOString(),body=JSON.stringify({...fixture,source_event_id:'full258-'+index,occurred_at:signed_at}),digest=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(body))).toString('hex'),nonce='full258-'+index;const message=JSON.stringify(['apacely-synthetic-ingress-hmac-v1','staging',d.provider,d.principal,d.source,d.key_id,'POST',d.route,signed_at,nonce,digest]);return {method:'POST',body,headers:{'content-type':'application/json','Cf-Access-Jwt-Assertion':c.assertion,'apacely-key-id':d.key_id,'apacely-source':d.source,'apacely-signed-at':signed_at,'apacely-nonce':nonce,'apacely-signature':Buffer.from(await crypto.subtle.sign('HMAC',signers[index],new TextEncoder().encode(message))).toString('base64url')}};}
  const cold=performance.now();for(const index of [0,64,65,128]){const response=await h.mf.dispatchFetch('https://staging.invalid/v1/ingress/synthetic',await signed(index));const text=await response.text();assert.equal(response.status,200,text);}
  const accepted=await rows(h);assert.equal(accepted.events.length,4);assert.equal(accepted.replay_ledger.length,4);assert.equal(accepted.action_outbox.length,4);assert.equal(accepted.events.filter(r=>r.tenant_id===tenants.b).length,1);assert.equal(accepted.events.filter(r=>r.tenant_id===tenants.a).length,3);
  for(const index of [129,130,194,195,257]){const response=await h.mf.dispatchFetch('https://staging.invalid/v1/ingress/synthetic',await signed(index));const text=await response.text();assert.equal(response.status,401,text);assert.deepEqual(await rows(h),accepted);}
  const spoof=await signed(128);spoof.headers['apacely-source']='source-001';const denied=await h.mf.dispatchFetch('https://staging.invalid/v1/ingress/synthetic',spoof);const text=await denied.text();assert.equal(denied.status,401,text);assert.deepEqual(await rows(h),accepted);assert.deepEqual(h.blocked,[]);
  console.log(JSON.stringify({measurement:'actual-workerd-full258-http',request_batch_elapsed_ms:performance.now()-cold,host_build_and_miniflare_ready_ms:readyElapsed,current_http_acceptances:4,future_next_denials:5,limits:'original fixed lifecycle, no clock override; host elapsed includes signing/readbacks; not workerd CPU/peak memory/official startup'}));
 }finally{if(h)await h.mf.dispose();c.erase();signers.length=0;secrets.fill('');for(const name of SHARD_NAMES)delete bindings[name];}
});
