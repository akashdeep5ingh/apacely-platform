import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {initializeFreshAdmission,validateSealedAdmission,type CoordinatorStorage} from '../src/staging-coordinator.js';
import {STAGING_POLICY} from '../src/staging-policy.js';
import {readFile} from 'node:fs/promises';

test('trusted scheduled runner makes one fixed service call and its HTTP handler cannot activate',async()=>{
 const {default:runner}=await import('../src/qualification/initialization-runner-worker.js');
 let calls=0;const env={INITIALIZER:{invokeFirstBirth:async()=>{calls++;}}};
 const response=runner.fetch();assert.equal(response.status,503);await response.text();assert.equal(calls,0);
 await runner.scheduled({} as ScheduledController,env);assert.equal(calls,1);
 for(const name of ['wrangler.qualification-initializer.jsonc','wrangler.qualification-initializer-bootstrap.jsonc','wrangler.qualification-initializer-runner.jsonc']){
  const config=JSON.parse(await readFile(name,'utf8'));assert.equal(config.workers_dev,false);assert.equal(config.preview_urls,false);assert.deepEqual(config.routes,[]);assert.deepEqual(config.triggers?.crons??[],[]);
 }
});

function storage():CoordinatorStorage {
 const data=new Map<string,unknown>();
 const base={get:async(key:string)=>data.get(key),put:async(key:string,value:unknown)=>{data.set(key,value);},list:async({limit}:{limit:number})=>new Map([...data].slice(0,limit)),sql:{exec:()=>[]},transaction:async<T>(callback:(tx:any)=>Promise<T>)=>{const before=new Map(data);try{return await callback(base);}catch(error){data.clear();for(const [k,v] of before)data.set(k,v);throw error;}}};
 return base;
}
test('trusted policy composition changes marker and decoder together; default baseline remains distinct',async()=>{
 const isolated={...STAGING_POLICY,epoch:'40000000-0000-4000-8000-000000000099'};
 const store=storage();await initializeFreshAdmission(store,100,isolated);
 const marker=JSON.parse(await store.get('distributed-admission/birth/v1') as string);
 assert.equal(marker.epoch,isolated.epoch);
 await validateSealedAdmission(store,isolated);
 await assert.rejects(()=>validateSealedAdmission(store));
});

test('private initializer and closed bootstrap are distinct from sealed artifact',async()=>{
 const initializer=await build({entryPoints:['src/qualification/initialization-worker.ts'],bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers']});
 assert.match(initializer.outputFiles[0].text,/invokeFirstBirth/);
 const sealed=await build({entryPoints:['src/staging-worker.ts'],bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers'],metafile:true});
 assert.doesNotMatch(sealed.outputFiles[0].text,/initializeFreshAdmission|bootstrapAdmission|invokeFirstBirth|initializeOnce/);
 assert.ok(!Object.keys(sealed.metafile!.inputs).some(x=>x.includes('qualification/initialization')));
});
