import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir} from 'node:fs/promises';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from '../../node_modules/wrangler/node_modules/miniflare/dist/src/index.js';
const ROOT='/root/apacely-staging-evidence/phase4/initialization';
async function bundle(contents:string){return (await build({stdin:{contents,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers']})).outputFiles[0].text;}
async function harness(mode:'bootstrap'|'sealed'|'inspect',persist:string){
 const target=await bundle(mode==='inspect'?`import {DurableObject} from 'cloudflare:workers';export class StagingAdmissionCoordinator extends DurableObject {async snapshot(){return [...await this.ctx.storage.list()];} async damage(){await this.ctx.storage.put('distributed-admission/state/v1','corrupt');}}export default {fetch(){return new Response(null,{status:503})}};`:`import {StagingAdmissionCoordinator as Base} from './src/${mode==='sealed'?'staging-worker':'qualification/initialization-bootstrap-worker'}.ts';export class StagingAdmissionCoordinator extends Base {async snapshot(){return [...await this.ctx.storage.list()];}}export default {fetch(){return new Response(null,{status:503})}};`);
 const initializer=await bundle(`export {default} from './src/qualification/initialization-worker.ts';`);
 const runner=await bundle(`import {WorkerEntrypoint} from 'cloudflare:workers';export default class extends WorkerEntrypoint {async invoke(){try{await this.env.INIT.invokeFirstBirth();return 204;}catch{return 409;}}async snapshot(){return await this.env.TARGET.get(this.env.TARGET.idFromName('distributed-admission-v1')).snapshot();}async damage(){await this.env.TARGET.get(this.env.TARGET.idFromName('distributed-admission-v1')).damage();}fetch(){return new Response(null,{status:503});}}`);
 const options=convertV4MiniflareOptions({host:'127.0.0.1',cf:false,workers:[
 {name:'target',modules:true,script:target,compatibilityDate:'2025-07-18',durableObjects:{TARGET:{className:'StagingAdmissionCoordinator',useSQLite:true}},outboundService:()=>{throw Error('External forbidden');}},
 {name:'initializer',modules:true,script:initializer,compatibilityDate:'2025-07-18',durableObjects:{QUALIFICATION_ADMISSION:{className:'StagingAdmissionCoordinator',scriptName:'target'}},outboundService:()=>{throw Error('External forbidden');}},
 {name:'runner',modules:true,script:runner,compatibilityDate:'2025-07-18',serviceBindings:{INIT:'initializer'},durableObjects:{TARGET:{className:'StagingAdmissionCoordinator',scriptName:'target'}},outboundService:()=>{throw Error('External forbidden');}}
 ]});
 const mf=new Miniflare({...options,resourcePersistencePath:persist});await mf.ready;return mf;
}
async function getRunner(mf:Miniflare){
 const worker=await mf.getWorker('runner');
 return worker as typeof worker & {invoke():Promise<number>;snapshot():Promise<[string,unknown][]>};
}
test('private service binding actually births fixed object; repeats never reset; same identity seals across constructors',async()=>{
 await mkdir(ROOT,{recursive:true});const persist=await mkdtemp(ROOT+'/rpc-');let mf=await harness('bootstrap',persist);
 try{
 const runner=await getRunner(mf);assert.equal(await runner.invoke(),204);const first=await runner.snapshot();assert.equal(first.length,2);
 assert.equal(await runner.invoke(),409);assert.deepEqual(await runner.snapshot(),first);
 const closed=await mf.dispatchFetch('https://local.invalid/initialize?reset=1',{method:'POST',body:'{}'});assert.equal(closed.status,503);await closed.text();
 await mf.dispose();mf=await harness('bootstrap',persist);assert.equal(await (await getRunner(mf)).invoke(),409);assert.deepEqual(await (await getRunner(mf)).snapshot(),first);
 await mf.dispose();mf=await harness('sealed',persist);assert.deepEqual(await (await getRunner(mf)).snapshot(),first);assert.equal(await (await getRunner(mf)).invoke(),409);
 }finally{await mf.dispose();}
});
