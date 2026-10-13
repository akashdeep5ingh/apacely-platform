import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {build} from 'esbuild';

test('private caller has one fixed constructor-triggering invocation and does not claim birth proof',async()=>{
 assert.ok(existsSync('src/baseline-private-birth-runner.ts'),'fixed private runner is missing');
 const built=await build({entryPoints:['src/baseline-private-birth-runner.ts'],bundle:true,write:false,format:'esm',platform:'browser',plugins:[{name:'host-only-entrypoint',setup(b){b.onResolve({filter:/^cloudflare:workers$/},()=>({path:'entrypoint',namespace:'host'}));b.onLoad({filter:/.*/,namespace:'host'},()=>({contents:'export class WorkerEntrypoint {constructor(ctx,env){this.env=env;}}'}));}}]});
 const mod=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
 let calls=0;const names:string[]=[];
 const env={STAGING_ADMISSION:{idFromName(name:string){names.push(name);return 'fixed-id';},get(id:string){assert.equal(id,'fixed-id');return {async fetch(url:string){calls++;assert.equal(url,'https://admission.internal/private-birth');return new Response(null,{status:503});}};}}};
 const runner=new mod.BaselinePrivateBirthRunner({},env);
 for(let i=0;i<3;i++)assert.deepEqual(await runner.invoke(),{invoked:true,birthVerified:false,status:503});
 assert.equal(calls,3);assert.deepEqual(names,Array(3).fill('distributed-admission-v1'));
 assert.equal(await runner.fetch().then((r:Response)=>r.status),503);assert.equal(calls,3);
 await assert.rejects(()=>runner.invoke({object:'other',reset:true}),/arguments/);assert.equal(calls,3);
 assert.deepEqual(Object.keys(mod).sort(),['BaselinePrivateBirthRunner','default']);
 assert.equal(mod.default.fetch().status,503);
});
