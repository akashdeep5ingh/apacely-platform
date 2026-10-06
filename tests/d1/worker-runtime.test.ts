import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {readFileSync} from 'node:fs';
import {fingerprint,validateInput} from '../../src/contracts.js';
import {fixture} from '../../src/fixture.js';

test('shared acceptance and D1 execute in workerd without Node compatibility or HTTP ingress',async()=>{
 const bundle=await build({stdin:{resolveDir:process.cwd(),sourcefile:'test-only-worker.js',contents:`
 import {WorkerEntrypoint} from 'cloudflare:workers';
 import {D1Repository} from './src/d1-repository.ts';
 import {Processor,Registry} from './src/process-inbound.ts';
 import {fixture} from './src/fixture.ts';
 import {fingerprint,uuidV4,fields,validateInput} from './src/contracts.ts';
 export default class extends WorkerEntrypoint {
  async verify(){
   if(typeof Buffer!=='undefined'||typeof process!=='undefined')throw new Error('Node globals present');
   const time='2026-01-01T12:00:01.000Z';let readAttempts=0;
   const binding={prepare:sql=>this.env.DB.prepare(sql),batch:async statements=>{if(statements.length===7&&++readAttempts===1)throw new Error('D1_ERROR: Network connection lost.');return this.env.DB.batch(statements);}};
   const repo=new D1Repository(binding,()=>time);
   const tenant=await repo.createTenant('Runtime fixture'),scope={tenant_id:tenant.id,environment:'development'};
   if(!uuidV4.test(tenant.id))throw new Error('Invalid Web Crypto UUID');
   const ctx={environment:'development',source_binding:'mock-source-001',operation:'ingest_mock_lead'};
   const p=new Processor(repo,new Registry([[ctx.source_binding,tenant.id]]));
   const first=await p.process(ctx,fixture);
   await p.process(ctx,{...fixture,source_event_id:'second',source_sequence:2,qualification:{location:null}});
   const replay=await p.process(ctx,fixture);
   const canonical=JSON.stringify([fixture.schema_version,fixture.source_lead_id,fixture.source_sequence,fixture.occurred_at,fixture.channel,fixture.contact_reference,fixture.text,Object.entries(fixture.qualification),fixture.handoff_requested]);
   const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical)))].map(b=>b.toString(16).padStart(2,'0')).join('');
   if(digest!==fingerprint(fixture))throw new Error('Web Crypto SHA-256 mismatch');
   for(const text of ['', 'é漢字🙂', 'x'.repeat(64), 'x'.repeat(10000)]){
    const x=validateInput({...fixture,text,qualification:{location:null,intent:'buy'}});
    const canonical=JSON.stringify([x.schema_version,x.source_lead_id,x.source_sequence,x.occurred_at,x.channel,x.contact_reference,x.text,fields.filter(f=>Object.hasOwn(x.qualification,f)).map(f=>[f,x.qualification[f]]),x.handoff_requested]);
    const native=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical)))].map(b=>b.toString(16).padStart(2,'0')).join('');
    if(native!==fingerprint(x))throw new Error('Portable UTF-8 hash mismatch');
   }
   if(readAttempts!==4)throw new Error('Worker retry/read attempts mismatch');
   const counts=[];for(const table of ['leads','conversations','events','messages','qualification_state','action_outbox'])counts.push((await repo.rows(scope,table)).length);
   return {first,replay,counts,digest,nodeGlobals:false};
  }
 }`},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:workers'],metafile:true});
 const inputs=Object.keys(bundle.metafile!.inputs);
 assert.ok(inputs.every(p=>!/(?:better-sqlite3|src\/repository|mock-outbox|node:|\/fs)/.test(p)),inputs.join('\n'));
 const script=bundle.outputFiles![0].text;
 assert.doesNotMatch(script,/(?:from|require\()\s*["']node:|better-sqlite3/);
 const local=new Miniflare({modules:true,script,compatibilityDate:'2025-07-18',compatibilityFlags:[],d1Databases:['DB'],host:'127.0.0.1',cf:false,outboundService:()=>{throw new Error('External workerd network forbidden');}});
 try{
  const db=await local.getD1Database('DB');
  await db.exec(readFileSync(new URL('../../src/schema.sql',import.meta.url),'utf8').replace(/--[^\n]*/g,'').replaceAll('\n',' '));
  const worker=await local.getWorker() as unknown as {verify():Promise<{first:unknown;replay:unknown;counts:number[];digest:string;nodeGlobals:boolean}>};
  const result=await worker.verify();
  assert.deepEqual(result.first,result.replay);assert.deepEqual(result.counts,[1,1,2,2,1,2]);
  assert.equal(result.digest,fingerprint(validateInput(fixture)));assert.equal(result.nodeGlobals,false);
  assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
 }finally{await local.dispose();}
});
