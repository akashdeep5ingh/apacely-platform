import test from 'node:test';
import assert from 'node:assert/strict';
import {QUALIFICATION_PROFILES} from '../src/qualification/policies.js';
import {createTicket} from '../src/distributed-admission.js';
import {existsSync,readFileSync} from 'node:fs';
import {build} from 'esbuild';
const profiles=['contention16','capacity16-source4','source-keys128','source-rate100'] as const;
const path='../src/qualification/artifacts/fixed-policies.js';
test('three rotating fixed builds retain exact reviewed UTC windows and three-minute overlap without runtime selectors',async()=>{
 const m=await import('../src/qualification/artifacts/fixed-bindings.js');
 const {SOURCE129,FULL258}=await import('../src/qualification/keyrings.js');
 assert.equal(SOURCE129.descriptors.length,129);assert.equal(FULL258.descriptors.length,258);
 assert.deepEqual(FULL258.descriptors.slice(0,129),SOURCE129.descriptors);
 for(const [i,current] of SOURCE129.descriptors.entries()){
  const next=FULL258.descriptors[i+129];
  assert.equal(current.not_before,'2026-10-13T00:00:00.000Z');assert.equal(current.not_after,'2026-10-14T00:00:00.000Z');
  assert.equal(next.not_before,'2026-10-13T23:57:00.000Z');assert.equal(next.not_after,'2026-10-15T00:00:00.000Z');
  assert.deepEqual(next,{...current,slot:'next',secret_slot:current.secret_slot.replace('_CURRENT','_NEXT'),key_id:current.key_id.replace('-current','-next'),not_before:'2026-10-13T23:57:00.000Z',not_after:'2026-10-15T00:00:00.000Z'});
  assert.equal(Date.parse(current.not_after)-Date.parse(next.not_before),180000);
 }
 for(const ring of [SOURCE129,FULL258]){
  assert.equal(new Set(ring.descriptors.map(d=>d.key_id)).size,ring.descriptors.length);
  assert.equal(new Set(ring.descriptors.map(d=>d.secret_slot)).size,ring.descriptors.length);
  assert.equal(new Set(ring.descriptors.map(d=>d.source)).size,129);
 }
 for(const key of ['contention16','capacity16Source4','sourceRate100'] as const){
  const registry=(m[key]({QUALIFICATION_HMAC_KEY_REGISTRY:'[]',CLOCK:'2099-01-01'}) as Record<string,string>).QUALIFICATION_HMAC_KEY_REGISTRY;
  const records=JSON.parse(registry);
  assert.equal(records.length,32);
  for(let i=0;i<16;i++){
   const [current,next]=records.slice(i*2,i*2+2);
   assert.equal(current.not_before,'2026-10-13T00:00:00.000Z');assert.equal(current.not_after,'2026-10-14T00:00:00.000Z');
   assert.equal(next.not_before,'2026-10-13T23:57:00.000Z');assert.equal(next.not_after,'2026-10-15T00:00:00.000Z');
   for(const d of [current,next]){assert.equal(new Date(d.not_before).toISOString(),d.not_before);assert.equal(new Date(d.not_after).toISOString(),d.not_after);assert.equal(d.revoked_at,null);}
   assert.equal(Date.parse(current.not_after)-Date.parse(next.not_before),180000);assert.equal(current.source,next.source);assert.equal(current.principal,next.principal);
  }
 }
 assert.equal((m.sourceKeys128({}) as Record<string,string>).QUALIFICATION_HMAC_KEY_REGISTRY,SOURCE129.registry);
});
test('each fixed pair retains target namespace database class and migration identity; temporary scopes cannot cross profiles',()=>{
 const names=new Set<string>();
 for(const name of profiles){
  const file=(suffix:string)=>`wrangler.qualification-${name}-${suffix}.jsonc`;
  assert.ok(existsSync(file('bootstrap')),'dedicated bootstrap config must exist');
  const [bootstrap,sealed,initializer,runner]=['bootstrap','sealed','initializer','runner'].map(s=>JSON.parse(readFileSync(file(s),'utf8')));
  assert.equal(bootstrap.name,sealed.name);assert.ok(!names.has(sealed.name));names.add(sealed.name);
  assert.deepEqual(bootstrap.durable_objects,sealed.durable_objects);assert.deepEqual(bootstrap.migrations,sealed.migrations);assert.deepEqual(bootstrap.d1_databases,sealed.d1_databases);
  assert.equal(sealed.durable_objects.bindings[0].class_name,'StagingAdmissionCoordinator');
  assert.equal(sealed.vars.APACELY_INGRESS_ENABLED,'false');assert.equal(sealed.vars.APACELY_EFFECTS_ENABLED,'false');
  assert.equal(initializer.durable_objects.bindings[0].script_name,sealed.name);assert.equal(initializer.durable_objects.bindings[0].name,'QUALIFICATION_ADMISSION');
  assert.deepEqual(runner.services,[{binding:'INITIALIZER',service:initializer.name}]);assert.equal(runner.durable_objects,undefined);
  for(const c of [bootstrap,sealed,initializer,runner]){
   assert.equal(c.account_id,'0'.repeat(32));assert.equal(c.workers_dev,false);assert.equal(c.preview_urls,false);assert.deepEqual(c.routes,[]);assert.deepEqual(c.triggers.crons,[]);
   assert.deepEqual(c.compatibility_flags,[]);assert.equal(c.compatibility_date,'2025-07-18');assert.ok(existsSync(c.main));
  }
 }
});
test('all sealed bundles include qualification auth but exclude initialization offline fixtures Node and control routes',async()=>{
 for(const name of profiles){
  const c=JSON.parse(readFileSync(`wrangler.qualification-${name}-sealed.jsonc`,'utf8'));
  assert.ok(existsSync(c.main),'fixed sealed entrypoint must exist');
  const result=await build({entryPoints:[c.main],bundle:true,write:false,metafile:true,format:'esm',platform:'browser',external:['cloudflare:workers']});
  const code=result.outputFiles[0].text;
  for(const forbidden of ['initializeOnce','initializeFreshAdmission','bootstrapAdmission','/test/','node:','MemoryDatabase','signSynthetic','invokeFirstBirth'])assert.ok(!code.includes(forbidden),forbidden);
  assert.ok(code.includes(name==='source-keys128'?'captureQualifiedAuthority':'captureQualificationKeys'));assert.ok(code.includes('validateSealedAdmission'));
  assert.ok(!Object.keys(result.metafile!.inputs).some(p=>p==='src/qualification/policies.ts'||p.startsWith('tests/')));
 }
});
test('fixed descriptor composition ignores registry substitution without reading getters and preserves original platform identities',async()=>{
 const m=await import('../src/qualification/artifacts/fixed-bindings.js').catch(()=>null);
 assert.ok(m,'fixed binding module must exist');
 const DB={},STAGING_ADMISSION={};let reads=0;
 const env={DB,STAGING_ADMISSION,get QUALIFICATION_HMAC_KEY_REGISTRY(){reads++;throw Error('selector');}};
 for(const key of ['contention16','capacity16Source4','sourceKeys128','sourceRate100'] as const){
  const captured=m[key](env) as Record<string,unknown>;assert.equal(captured.DB,DB);assert.equal(captured.STAGING_ADMISSION,STAGING_ADMISSION);assert.equal(reads,0);
  const descriptors=JSON.parse(captured.QUALIFICATION_HMAC_KEY_REGISTRY as string);
  assert.equal(new Set(descriptors.map((d:{key_id:string})=>d.key_id)).size,descriptors.length);
  assert.equal(new Set(descriptors.map((d:{secret_slot:string})=>d.secret_slot)).size,descriptors.length);
  const sources=new Set(descriptors.map((d:{source:string})=>d.source));assert.equal(sources.size,key==='sourceKeys128'?129:16);
  for(const source of sources)assert.equal(descriptors.filter((d:{source:string;slot:string})=>d.source===source&&d.slot==='current').length,1);
  assert.throws(()=>m[key](Object.create({DB})));
 }
});
test('every fixed registry passes the exported key API with independent non-aliased secrets; unregistered slots fail closed',async()=>{
 const m=await import('../src/qualification/artifacts/fixed-bindings.js');
 const {captureQualificationKeys}=await import('../src/qualification/key-registry.js');
 for(const key of ['contention16','capacity16Source4','sourceKeys128','sourceRate100'] as const){
  const fixed=m[key]({}) as Record<string,unknown>;
  const descriptors=JSON.parse(fixed.QUALIFICATION_HMAC_KEY_REGISTRY as string) as {secret_slot:string;source:string;slot:string}[];
  const bindings:Record<string,unknown>={...fixed};
  descriptors.forEach((d,i)=>{const bytes=Buffer.alloc(32);bytes.writeUInt32BE(i+1);bindings[d.secret_slot]=bytes.toString('base64');});
  const captured=captureQualificationKeys(bindings);assert.equal(captured.length,key==='sourceKeys128'?129:32);
  assert.equal(new Set(captured.map(k=>k.record.source)).size,key==='sourceKeys128'?129:16);
  let reads=0;const malformed={...bindings};Object.defineProperty(malformed,descriptors[0].secret_slot,{enumerable:true,get(){reads++;throw Error('secret accessor');}});
  assert.throws(()=>captureQualificationKeys(malformed));assert.equal(reads,0);
  assert.throws(()=>captureQualificationKeys({...bindings,QUALIFICATION_SIGNING_KEY_UNREGISTERED:Buffer.alloc(32,255).toString('base64')}));
 }
});
test('sealed configs declare exact secret slot references only, never secret material',async()=>{
 const m=await import('../src/qualification/artifacts/fixed-bindings.js');
 const keys=['contention16','capacity16Source4','sourceKeys128','sourceRate100'] as const;
 for(let i=0;i<profiles.length;i++){
  const c=JSON.parse(readFileSync(`wrangler.qualification-${profiles[i]}-sealed.jsonc`,'utf8'));
  const env=m[keys[i]]({}) as Record<string,string>;
  const slots=JSON.parse(env.QUALIFICATION_HMAC_KEY_REGISTRY).map((d:{secret_slot:string})=>d.secret_slot);
  assert.deepEqual(c.secrets?.required,keys[i]==='sourceKeys128'?['QUALIFICATION_HMAC_KEYRING_1','QUALIFICATION_HMAC_KEYRING_2','QUALIFICATION_HMAC_KEYRING_3','QUALIFICATION_HMAC_KEYRING_4']:slots,'all fixed transport slots must be explicit references');
  assert.ok(!Object.keys(c.vars).some(k=>k.startsWith('QUALIFICATION_SIGNING_KEY_')));
 }
});
test('deployable literal constants exactly match all reviewed offline policies and core digests',async()=>{
 const module=await import(path).catch(()=>null);
 assert.ok(module,'separate deployable policy module must exist');
 for(const [key,p] of Object.entries(QUALIFICATION_PROFILES)){
  const policy=module[key];assert.deepEqual(policy,p.policy);assert.ok(Object.isFrozen(policy));
  assert.equal(createTicket(policy,{environment:'staging',tenant:'20000000-0000-4000-8000-000000000001',provider:'synthetic',principal:'parity',source:'parity',mappingId:'30000000-0000-4000-8000-000000000001',mappingVersion:1,sourceBinding:'parity',operation:'ingest_mock_lead'},11000).context.policyDigest,p.digest);
 }
});
