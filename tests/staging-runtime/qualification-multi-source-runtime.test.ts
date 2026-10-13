import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {Miniflare,convertV4MiniflareOptions} from '../../node_modules/wrangler/node_modules/miniflare/dist/src/index.js';
import {fixture} from '../../src/fixture.js';
import {credentials,provision,rows,ISSUER,AUDIENCE} from './staging-http-private.js';

// Prepared actual-runtime qualification. NOT run by the multi-source implementer.
// Separate artifact, explicit trusted policy import, no public initialization/fault endpoint.
test('one actual qualification runtime isolates independent source keys and rotations on original D1 and SQLite DO',async()=>{
 assert.equal(process.versions.node,'22.23.3','use dedicated approved runtime');
 assert.equal(process.env.APACELY_HTTP_EMULATOR_OWNER,'parent-serial-approved','serial emulator ownership required');
 const root='/root/apacely-staging-evidence/phase4/multi-source';await mkdir(root,{recursive:true,mode:0o700});const persist=await mkdtemp(root+'/runtime-');
 const c=await credentials(),keys=new Map<string,CryptoKey>(),descriptors=[];
 const bindings:Record<string,string>={APACELY_ENVIRONMENT:'staging',APACELY_OPERATION:'ingest_mock_lead',APACELY_INGRESS_ENABLED:'true',APACELY_EFFECTS_ENABLED:'false',STAGING_ACCESS_ISSUER:ISSUER,STAGING_ACCESS_AUDIENCE:AUDIENCE};
 for(const source of ['a','b'])for(const slot of ['current','next']){
  const id=`key-${source}-${slot}`,secret_slot=`QUALIFICATION_SIGNING_KEY_${source.toUpperCase()}_${slot.toUpperCase()}`,bytes=crypto.getRandomValues(new Uint8Array(32));
  keys.set(id,await crypto.subtle.importKey('raw',bytes,{name:'HMAC',hash:'SHA-256'},false,['sign']));bindings[secret_slot]=Buffer.from(bytes).toString('base64');bytes.fill(0);
  descriptors.push({slot,secret_slot,key_id:id,environment:'staging',provider:'synthetic',principal:'principal-'+source,source:'source-'+source,route:'/v1/ingress/synthetic',not_before:new Date(Date.now()-60000).toISOString(),not_after:new Date(Date.now()+180000).toISOString(),revoked_at:null as string|null});
 }
 bindings.QUALIFICATION_HMAC_KEY_REGISTRY=JSON.stringify(descriptors);
 const name='multi-source-qualification';let mf:Miniflare|undefined,jwks=0;const blocked:string[]=[];
 async function start(mode:'bootstrap'|'qualification'){
  if(mf)await mf.dispose();mf=undefined;
  const result=await build({...(mode==='bootstrap'?{entryPoints:['src/staging-bootstrap-worker.ts']}:{stdin:{resolveDir:process.cwd(),contents:`import {createQualificationRuntime} from './src/qualification/runtime.ts';import {STAGING_POLICY} from './src/staging-policy.ts';export {StagingAdmissionCoordinator} from './src/staging-worker.ts';const handle=createQualificationRuntime(STAGING_POLICY);export default {fetch(request,env,ctx){return handle(request,env,ctx);}};`}}),bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers']});
  const script=result.outputFiles[0].text;assert.ok(!script.includes('/test/'));assert.ok(!script.includes('storage.list()'));
  const options=convertV4MiniflareOptions({host:'127.0.0.1',cf:false,workers:[{name,modules:true,script,compatibilityDate:'2025-07-18',compatibilityFlags:[],bindings,d1Databases:{DB:'multi-source-local-db'},durableObjects:{STAGING_ADMISSION:{className:'StagingAdmissionCoordinator',useSQLite:true}},outboundService(request){
   if(request.url!==ISSUER+'/cdn-cgi/access/certs'||request.method!=='GET'){blocked.push(new URL(request.url).origin);throw Error('External network forbidden');}
   jwks++;return Response.json({keys:[c.jwk]});
  }}]});
  mf=new Miniflare({...options,resourcePersistencePath:persist});await mf.ready;
  return {mf,jwks:()=>jwks,blocked,db:()=>mf!.getD1Database('DB',name),async state(){throw Error('No inspection capability');},async birth(){const ns=await mf!.getDurableObjectNamespace('STAGING_ADMISSION',name);const r=await ns.get(ns.idFromName('distributed-admission-v1')).fetch('https://admission.internal/');assert.equal(r.status,503);await r.text();}};
 }
 const body=JSON.stringify({...fixture,occurred_at:new Date().toISOString()});
 async function signed(source:string,slot:string,nonce:string,payload=body){
  const id=`key-${source}-${slot}`,signed_at=new Date().toISOString(),digest=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(payload))).toString('hex');
  const message=JSON.stringify(['apacely-synthetic-ingress-hmac-v1','staging','synthetic','principal-'+source,'source-'+source,id,'POST','/v1/ingress/synthetic',signed_at,nonce,digest]);
  const signature=Buffer.from(await crypto.subtle.sign('HMAC',keys.get(id)!,new TextEncoder().encode(message))).toString('base64url');
  return {method:'POST',body:payload,headers:{'content-type':'application/json','Cf-Access-Jwt-Assertion':c.assertion,'apacely-key-id':id,'apacely-source':'source-'+source,'apacely-signed-at':signed_at,'apacely-nonce':nonce,'apacely-signature':signature}};
 }
 async function send(init:Awaited<ReturnType<typeof signed>>,status:number){const response=await mf!.dispatchFetch('https://staging.invalid/v1/ingress/synthetic',init);const text=await response.text();assert.equal(response.status,status,text);}
 try{
  let h=await start('bootstrap');const tenants=await provision(h);await h.birth();
  h=await start('qualification');
  for(const source of ['a','b'])for(const slot of ['current','next'])await send(await signed(source,slot,`first-${source}-${slot}`),200);
  const accepted=await rows(h);
  for(const table of ['leads','conversations','events','messages','qualification_state','action_outbox']){
   assert.equal(accepted[table].length,2,table);for(const tenant of [tenants.a,tenants.b])assert.equal(accepted[table].filter(r=>r.tenant_id===tenant).length,1);
  }
  assert.equal(accepted.replay_ledger.length,4);assert.deepEqual(new Set(accepted.events.map(e=>e.source_event_id)),new Set([fixture.source_event_id]));
  for(const r of accepted.action_outbox){assert.equal(r.environment,'staging');assert.equal(r.status,'pending');assert.equal(r.attempts,0);assert.equal(r.recorded_at,null);}
  const spoof=await signed('a','current','spoof');spoof.headers['apacely-source']='source-b';await send(spoof,401);assert.deepEqual(await rows(h),accepted);
  const tampered=await signed('b','current','tampered');tampered.body=JSON.stringify({...JSON.parse(body),text:'tampered bytes'});await send(tampered,401);assert.deepEqual(await rows(h),accepted);
  await send(await signed('a','current','forged-tenant',JSON.stringify({...JSON.parse(body),tenant_id:tenants.b})),400);assert.deepEqual(await rows(h),accepted);
  descriptors[0].revoked_at=new Date(Date.now()-1000).toISOString();bindings.QUALIFICATION_HMAC_KEY_REGISTRY=JSON.stringify(descriptors);
  h=await start('qualification');await send(await signed('a','current','revoked-current'),401);assert.deepEqual(await rows(h),accepted);
  await send(await signed('a','next','active-next'),200);await send(await signed('b','current','independent-current'),200);
  const after=await rows(h);assert.deepEqual(after.events,accepted.events);assert.deepEqual(after.action_outbox,accepted.action_outbox);assert.equal(after.replay_ledger.length,6);assert.deepEqual(blocked,[]);
  h=await start('qualification');assert.deepEqual(await rows(h),after);
 }finally{if(mf)await mf.dispose();c.erase();keys.clear();for(const k of Object.keys(bindings))if(k.startsWith('QUALIFICATION_SIGNING_KEY_'))delete bindings[k];}
});
