import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from '../../node_modules/wrangler/node_modules/miniflare/dist/src/index.js';
const ROOT='/root/apacely-staging-evidence/phase4/phase4b-closure/birth';
const NAME='distributed-admission-v1',SCRIPT='apacely-ingress-staging';
const STATE='distributed-admission/state/v1',BIRTH='distributed-admission/birth/v1';
async function bundle(entry:string){return (await build({entryPoints:[entry],bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers']})).outputFiles[0].text;}
async function fixture(persist:string,mode:'bootstrap'|'sealed'|'inspect'|'fault'){
 const runner=await bundle('src/baseline-private-birth-runner.ts');
 const fixtureCode=`import {DurableObject} from 'cloudflare:workers';import {initializeFreshAdmission} from './src/staging-coordinator.ts';
 export class StagingAdmissionCoordinator extends DurableObject {
 async fetch(r){const p=await r.json();if(p.op==='read')return Response.json([...await this.ctx.storage.list()]);
 if(p.op==='put')await this.ctx.storage.put(p.key,p.value);
 if(p.op==='birth'){let n=0;const s=this.ctx.storage;try{await initializeFreshAdmission({get:s.get.bind(s),put:s.put.bind(s),list:s.list.bind(s),sql:s.sql,transaction:cb=>s.transaction(tx=>cb({get:tx.get.bind(tx),list:tx.list.bind(tx),put:async(k,v)=>{await tx.put(k,v);if(++n===p.fail)throw Error('interrupted-birth');}}))},Date.now());}catch(e){return new Response(String(e),{status:409});}}
 return new Response(null,{status:204});}}
 export default {fetch(){return new Response(null,{status:503})}};`;
 const target=mode==='bootstrap'||mode==='sealed'?await bundle('src/staging-'+(mode==='bootstrap'?'bootstrap-worker':'worker')+'.ts'):(await build({stdin:{contents:fixtureCode,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers']})).outputFiles[0].text;
 const driver=`export default {async fetch(r,e){if(new URL(r.url).pathname==='/invoke')return Response.json(await e.RUNNER.invoke());return new Response(null,{status:503})}}`;
 const options=convertV4MiniflareOptions({host:'127.0.0.1',cf:false,workers:[
 {name:'local-test-driver',modules:true,script:driver,compatibilityDate:'2025-07-18',serviceBindings:{RUNNER:{name:'private-runner',entrypoint:'BaselinePrivateBirthRunner'}},outboundService:()=>{throw Error('External network forbidden');}},
 {name:'private-runner',modules:true,script:runner,compatibilityDate:'2025-07-18',durableObjects:{STAGING_ADMISSION:{className:'StagingAdmissionCoordinator',scriptName:SCRIPT}},outboundService:()=>{throw Error('External network forbidden');}},
 {name:SCRIPT,modules:true,script:target,compatibilityDate:'2025-07-18',durableObjects:{STAGING_ADMISSION:{className:'StagingAdmissionCoordinator',useSQLite:true}},outboundService:()=>{throw Error('External network forbidden');}}
 ]});
 const mf=new Miniflare({...options,resourcePersistencePath:persist});await mf.ready;return mf;
}
async function invoke(mf:Miniflare){return mf.dispatchFetch('http://localhost/invoke').then(async r=>({status:r.status,text:await r.text()}));}
async function stub(mf:Miniflare){const ns=await mf.getDurableObjectNamespace('STAGING_ADMISSION',SCRIPT);return ns.get(ns.idFromName(NAME));}
async function control(mf:Miniflare,p:object){return (await stub(mf)).fetch('http://localhost/control',{method:'POST',body:JSON.stringify(p)}).then(async r=>({status:r.status,text:await r.text()}));}
async function raw(mf:Miniflare){return JSON.parse((await control(mf,{op:'read'})).text) as [string,unknown][];}

test('actual private RPC triggers unchanged bootstrap; fixed same namespace/object survives sealed transition',async()=>{
 const persist=await mkdtemp(join(tmpdir(),'baseline-private-birth-'));let mf=await fixture(persist,'bootstrap');
 try{
  for(let i=0;i<3;i++){const reply=await invoke(mf);assert.equal(reply.status,200,reply.text);assert.deepEqual(JSON.parse(reply.text),{invoked:true,birthVerified:false,status:503});}
  await mf.dispose();mf=await fixture(persist,'inspect');
  const before=await raw(mf);assert.equal(before.length,2);
  assert.deepEqual(before.map(r=>r[0]).sort(),[BIRTH,STATE].sort());
  const ids=await mf.listDurableObjectIds('STAGING_ADMISSION',SCRIPT);assert.equal(ids.length,1);
  const http=await (await mf.getWorker('private-runner')).fetch('http://localhost/init?object=other&reset=true').then(async r=>({status:r.status,text:await r.text()}));assert.equal(http.status,503);assert.deepEqual(await raw(mf),before);
  await mf.dispose();mf=await fixture(persist,'sealed');
  const sealed=await invoke(mf);assert.equal(sealed.status,200,sealed.text);assert.equal(JSON.parse(sealed.text).birthVerified,false);
  assert.deepEqual(await mf.listDurableObjectIds('STAGING_ADMISSION',SCRIPT),ids);
  await mf.dispose();mf=await fixture(persist,'inspect');const after=await raw(mf);assert.deepEqual(after,before);
  await writeFile(ROOT+'/transition-readback.json',JSON.stringify({persist,ids,before,after}),{mode:0o600});
 }finally{await mf.dispose();}
});

test('absent and corrupt sealed storage deny private invocation without reseeding',async()=>{
 for(const damage of ['absent','corrupt'] as const){const persist=await mkdtemp(join(tmpdir(),'baseline-private-'+damage+'-'));let mf=await fixture(persist,damage==='absent'?'inspect':'bootstrap');
 try{if(damage==='corrupt'){await invoke(mf);await mf.dispose();mf=await fixture(persist,'inspect');await control(mf,{op:'put',key:STATE,value:'corrupt'});}
 const before=JSON.parse((await control(mf,{op:'read'})).text);await mf.dispose();mf=await fixture(persist,'sealed');
 const denial=await invoke(mf);assert.equal(denial.status,500,denial.text);assert.match(denial.text,/Invalid sealed admission storage/);
 await mf.dispose();mf=await fixture(persist,'inspect');assert.deepEqual(JSON.parse((await control(mf,{op:'read'})).text),before);
 }finally{await mf.dispose();}}
});

test('actual birth transaction rollback after either write preserves empty storage',async()=>{
 const persist=await mkdtemp(join(tmpdir(),'baseline-private-interrupted-'));const mf=await fixture(persist,'fault');
 try{for(const fail of [1,2]){const r=await control(mf,{op:'birth',fail});assert.equal(r.status,409,r.text);assert.match(r.text,/interrupted-birth/);assert.deepEqual(JSON.parse((await control(mf,{op:'read'})).text),[]);}
 assert.equal((await control(mf,{op:'birth',fail:0})).status,204);const before=JSON.parse((await control(mf,{op:'read'})).text);assert.equal(before.length,2);
 assert.equal((await control(mf,{op:'birth',fail:0})).status,409);assert.deepEqual(JSON.parse((await control(mf,{op:'read'})).text),before);
 }finally{await mf.dispose();}
});
