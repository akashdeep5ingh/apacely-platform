import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {environmentStatements} from '../../scripts/environment-schema.js';
import {fixture} from '../../src/fixture.js';

async function http(options:{environment?:'development'|'staging';config?:Record<string,string|readonly string[]>;db?:'DB'|'DEV'|'EMPTY'|'UNMARKED'|'MISSING';identity?:'DB'|'OTHER';proofEnvironment?:string}={}){
 const environment=options.environment??'staging',binding=options.db??'DB',identity=options.identity??binding;
 const bundle=await build({stdin:{resolveDir:process.cwd(),contents:`
 import {handleConfiguredWorkerRequest} from './src/worker-http.ts';
 import {D1Repository} from './src/d1-repository.ts';
 import {D1SourceMappingStore} from './src/source-mappings.ts';
 import {D1ReplayLedger} from './src/replay-ledger.ts';
 export default {fetch(request,env,ctx){
 if(typeof process!=='undefined'||typeof Buffer!=='undefined')throw new Error('Node compatibility forbidden');
 const db=env.${identity},now=()=>env.NOW;
 const dependencies={repo:new D1Repository(db,now,undefined,${JSON.stringify(environment)}),mappings:new D1SourceMappingStore(db,now,${JSON.stringify(environment)}),replay:new D1ReplayLedger(db,now,3,${JSON.stringify(environment)}),now,log:()=>{},
 verifier:{verify:async input=>({...input,principal:'actor-one',source:'source-one',signed_at:env.NOW,nonce:'nonce-one',environment:${JSON.stringify(options.proofEnvironment??'production')}})}};
 return handleConfiguredWorkerRequest(request,{...env.APP,DB:env.${binding}},dependencies,ctx);
 }}
 `},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',metafile:true});
 assert.ok(Object.keys(bundle.metafile!.inputs).every(p=>!/(node:|better-sqlite3|scripts\/)/.test(p)));
 const local=new Miniflare({modules:true,script:bundle.outputFiles![0].text,compatibilityDate:'2025-07-18',compatibilityFlags:[],bindings:{NOW:new Date().toISOString(),APP:JSON.parse(JSON.stringify(options.config??{APACELY_ENVIRONMENT:environment,APACELY_OPERATION:'ingest_mock_lead'}))},d1Databases:['DB','DEV','EMPTY','UNMARKED','OTHER'],host:'127.0.0.1',cf:false,outboundService:()=>{throw new Error('External access forbidden');}});
 try{
  const db=await local.getD1Database('DB'),dev=await local.getD1Database('DEV'),unmarked=await local.getD1Database('UNMARKED'),other=await local.getD1Database('OTHER');
  for(const [target,kind] of [[db,environment],[dev,'development'],[other,environment]] as const)await target.batch(environmentStatements(kind).map(sql=>target.prepare(sql)));
  // Deliberately old schema without marker. Never adopted or initialized by HTTP.
  const unmarkedStatements=environmentStatements(environment).filter(sql=>!/(database_environment|environment_no_)/.test(sql));
  await unmarked.batch(unmarkedStatements.map(sql=>unmarked.prepare(sql)));
  const tenant='f0000000-0000-4000-8000-000000000001',mapping='f0000000-0000-4000-8000-000000000002',now=new Date().toISOString();
  for(const [target,kind] of [[db,environment],[dev,'development'],[other,environment],[unmarked,environment]] as const){
   await target.prepare("INSERT INTO tenants VALUES (?,?,'active',?)").bind(tenant,'Synthetic overlap',now).run();
   await target.prepare("INSERT INTO source_mappings VALUES (?,1,'synthetic','source-one','actor-one',?,'source',?,'ingest_mock_lead','active',?,?,NULL,NULL)").bind(mapping,tenant,kind,now,now).run();
  }
  const request=(input:unknown=fixture,url='http://localhost/v1/ingress/synthetic',headers:Record<string,string>={})=>local.dispatchFetch(url,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(input)});
  const snapshot=async(target=dev)=>(await target.prepare("SELECT (SELECT count(*) FROM events) events,(SELECT count(*) FROM replay_ledger) nonces,(SELECT count(*) FROM action_outbox) actions").all()).results;
  return {local,db,dev,other,unmarked,request,snapshot,dispose:()=>local.dispose()};
 }catch(error){await local.dispose();throw error;}
}

test('actual configured HTTP accepts staging despite forged headers and provider environment claim',async()=>{
 const h=await http();try{
  const response=await h.request(fixture,undefined,{'x-environment':'development','apacely-environment':'production','x-tenant-id':'foreign'});
  assert.equal(response.status,200);assert.deepEqual(Object.keys(await response.json() as object).sort(),['event_id','request_id']);
  assert.deepEqual(await h.snapshot(),[{events:0,nonces:0,actions:0}]);
  assert.deepEqual(await h.snapshot(h.db),[{events:1,nonces:1,actions:1}]);
  const outbox=await h.db.prepare('SELECT environment,status,attempts FROM action_outbox').all();assert.deepEqual(outbox.results,[{environment:'staging',status:'pending',attempts:0}]);
 }finally{await h.dispose();}
});

test('actual configured development HTTP accepts only explicitly selected development',async()=>{
 const h=await http({environment:'development',proofEnvironment:'staging'});try{assert.equal((await h.request()).status,200);assert.equal((await h.db.prepare('SELECT environment FROM action_outbox').all()).results[0].environment,'development');}finally{await h.dispose();}
});

test('actual configured HTTP rejects conflicting unknown application environment setting',async()=>{
 const h=await http({config:{APACELY_ENVIRONMENT:'staging',APACELY_OPERATION:'ingest_mock_lead',environment:'development'}});try{assert.equal((await h.request()).status,500);assert.deepEqual(await h.snapshot(h.db),[{events:0,nonces:0,actions:0}]);}finally{await h.dispose();}
});

for(const [label,config] of [
 ['missing environment',{APACELY_OPERATION:'ingest_mock_lead'}],
 ['unsupported production',{APACELY_ENVIRONMENT:'production',APACELY_OPERATION:'ingest_mock_lead'}],
 ['malformed ambiguous array',{APACELY_ENVIRONMENT:['development','staging'],APACELY_OPERATION:'ingest_mock_lead'}],
 ['missing operation',{APACELY_ENVIRONMENT:'staging'}],
 ['unsupported operation',{APACELY_ENVIRONMENT:'staging',APACELY_OPERATION:'send_message'}]
] as const)test('actual configured HTTP denies '+label,async()=>{
 const h=await http({config});try{const response=await h.request();assert.equal(response.status,500);assert.deepEqual(Object.keys(await response.json() as object).sort(),['code','request_id']);assert.deepEqual(await h.snapshot(h.db),[{events:0,nonces:0,actions:0}]);}finally{await h.dispose();}
});

for(const db of ['DEV','EMPTY','UNMARKED'] as const)test('actual staging HTTP refuses '+db+' physical database without provisioning or foreign writes',async()=>{
 const h=await http({db});try{assert.equal((await h.request()).status,db==='DEV'?403:500);assert.deepEqual(await h.snapshot(),[{events:0,nonces:0,actions:0}]);assert.deepEqual(await h.snapshot(h.unmarked),[{events:0,nonces:0,actions:0}]);const empty=await h.local.getD1Database('EMPTY');assert.deepEqual((await empty.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()).results,[]);}finally{await h.dispose();}
});

test('actual HTTP rejects alternate original D1 identity even with identical staging markers and tenant IDs',async()=>{
 const h=await http({identity:'OTHER'});try{assert.equal((await h.request()).status,500);assert.deepEqual(await h.snapshot(h.other),[{events:0,nonces:0,actions:0}]);assert.deepEqual(await h.snapshot(h.db),[{events:0,nonces:0,actions:0}]);}finally{await h.dispose();}
});

test('actual staging HTTP rejects body and query environment overrides with zero nonce or business writes',async()=>{
 const h=await http();try{assert.equal((await h.request({...fixture,environment:'development'})).status,400);assert.equal((await h.request(fixture,'http://localhost/v1/ingress/synthetic?environment=development')).status,404);assert.deepEqual(await h.snapshot(h.db),[{events:0,nonces:0,actions:0}]);}finally{await h.dispose();}
});

test('actual HTTP rejects missing application D1 binding before verifier and leaves valid database untouched',async()=>{
 const h=await http({db:'MISSING',identity:'DB'});try{const response=await h.request();assert.equal(response.status,500);assert.deepEqual(Object.keys(await response.json() as object).sort(),['code','request_id']);assert.deepEqual(await h.snapshot(h.db),[{events:0,nonces:0,actions:0}]);}finally{await h.dispose();}
});
