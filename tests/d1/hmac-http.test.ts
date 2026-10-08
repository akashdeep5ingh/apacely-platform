import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {webcrypto} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {environmentStatements} from '../../scripts/environment-schema.js';
const vectors=JSON.parse(readFileSync(new URL('../fixtures/synthetic-hmac-v1.json',import.meta.url),'utf8'));
async function http(environment:'development'|'staging',lifecycle:'normal'|'revoked'|'expired'='normal'){
 const time=new Date().toISOString();const records=vectors.keys.filter((k:{environment:string})=>k.environment===environment).map((k:Record<string,string>)=>({...k,not_before:new Date(Date.parse(time)-60000).toISOString(),not_after:new Date(Date.parse(time)+(k.key_id.endsWith('old')?240000:3600000)).toISOString()}));
 if(lifecycle==='revoked')records[0].revoked_at=time;if(lifecycle==='expired')records[0].not_after=time;
 const bundle=await build({stdin:{resolveDir:process.cwd(),contents:`
 import {SyntheticHmacVerifier} from './src/synthetic-hmac.ts';
 import {handleConfiguredWorkerRequest} from './src/worker-http.ts';
 import {D1Repository} from './src/d1-repository.ts';
 import {D1ReplayLedger} from './src/replay-ledger.ts';
 import {D1SourceMappingStore} from './src/source-mappings.ts';
 export default {async fetch(request,env,ctx){
 const environment=${JSON.stringify(environment)},now=()=>new Date().toISOString();
 const records=${JSON.stringify(records)}.map(k=>({...k,bytes:Uint8Array.from(k.key_hex.match(/../g),x=>parseInt(x,16))}));
 const verifier=await SyntheticHmacVerifier.create(environment,records,now);
 return handleConfiguredWorkerRequest(request,{APACELY_ENVIRONMENT:environment,APACELY_OPERATION:'ingest_mock_lead',DB:env.DB},{repo:new D1Repository(env.DB,now,undefined,environment),mappings:new D1SourceMappingStore(env.DB,now,environment),replay:new D1ReplayLedger(env.DB,now,3,environment),verifier,now,log:()=>{}},ctx);
 }} `},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',metafile:true});
 assert.ok(Object.keys(bundle.metafile!.inputs).every(p=>!/(node:|better-sqlite3)/.test(p)));
 const local=new Miniflare({modules:true,script:bundle.outputFiles![0].text,compatibilityDate:'2025-07-18',compatibilityFlags:[],d1Databases:['DB'],host:'127.0.0.1',cf:false,outboundService:()=>{throw new Error('External access forbidden');}});
 try{
 const db=await local.getD1Database('DB');await db.batch(environmentStatements(environment).map(sql=>db.prepare(sql)));
 const tenant='f0000000-0000-4000-8000-000000000001',mapping='f0000000-0000-4000-8000-000000000002';
 await db.prepare("INSERT INTO tenants VALUES (?,?,'active',?)").bind(tenant,'Public test',time).run();
 await db.prepare("INSERT INTO source_mappings VALUES (?,1,'synthetic','public-source-001','public-principal-001',?,'public-binding-001',?,'ingest_mock_lead','active',?,?,NULL,NULL)").bind(mapping,tenant,environment,time,time).run();
 const signed=async(nonce='public-http-nonce',signEnvironment=environment,kid=records[0].key_id,signedAt=time)=>{
 const body=vectors.messages[0].body_utf8,k=records.find((k:Record<string,string>)=>k.key_id===kid)!,digest=Buffer.from(await webcrypto.subtle.digest('SHA-256',Buffer.from(body))).toString('hex');
 const tuple=['apacely-synthetic-ingress-hmac-v1',signEnvironment,'synthetic','public-principal-001','public-source-001',k.key_id,'POST','/v1/ingress/synthetic',signedAt,nonce,digest];
 const key=await webcrypto.subtle.importKey('raw',Buffer.from(k.key_hex,'hex'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const sig=Buffer.from(await webcrypto.subtle.sign('HMAC',key,Buffer.from(JSON.stringify(tuple)))).toString('base64url');
 return {method:'POST',headers:new Headers({'content-type':'application/json','apacely-key-id':k.key_id,'apacely-source':'public-source-001','apacely-signed-at':signedAt,'apacely-nonce':nonce,'apacely-signature':sig}),body};
 };
 const counts=async()=> (await db.prepare("SELECT (SELECT count(*) FROM events) events,(SELECT count(*) FROM action_outbox) actions,(SELECT count(*) FROM replay_ledger) nonces").all()).results;
 return {local,db,signed,counts,time,records,dispose:()=>local.dispose()};
 }catch(error){await local.dispose();throw error;}
}
for(const environment of ['development','staging'] as const)test('actual HMAC HTTP '+environment+' commits one pending outbox',async()=>{
 const h=await http(environment);try{const input=await h.signed();input.headers.set('x-environment',environment==='staging'?'development':'staging');const response=await h.local.dispatchFetch('http://localhost/v1/ingress/synthetic',input);assert.equal(response.status,200);const first=await response.json() as {event_id:string};const replay=await h.local.dispatchFetch('http://localhost/v1/ingress/synthetic',input);assert.equal(replay.status,200);assert.equal((await replay.json() as {event_id:string}).event_id,first.event_id);assert.deepEqual(await h.counts(),[{events:1,actions:1,nonces:1}]);assert.deepEqual((await h.db.prepare('SELECT environment,status,attempts FROM action_outbox').all()).results,[{environment,status:'pending',attempts:0}]);}finally{await h.dispose();}
});
for(const [label,mutate,status] of [
 ['altered body',(x:{body:string;headers:Headers})=>{x.body=x.body.replace('Synthetic','Changed');},401],
 ['ambiguous proof',(x:{body:string;headers:Headers})=>{x.headers.append('apacely-nonce','second');},401],
 ['unknown proof',(x:{body:string;headers:Headers})=>{x.headers.set('apacely-key-id','unknown');},401],
 ['tail bits',(x:{body:string;headers:Headers})=>{const s=x.headers.get('apacely-signature')!;const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';x.headers.set('apacely-signature',s.slice(0,-1)+alphabet[alphabet.indexOf(s.at(-1)!)+1]);},401],
 ['content encoding',(x:{body:string;headers:Headers})=>{x.headers.set('content-encoding','gzip');},415]
] as const)test('actual HMAC HTTP denies '+label+' with zero writes',async()=>{
 const h=await http('staging');try{const input=await h.signed();mutate(input);const response=await h.local.dispatchFetch('http://localhost/v1/ingress/synthetic',input);assert.equal(response.status,status);assert.deepEqual(Object.keys(await response.json() as object).sort(),['code','request_id']);assert.deepEqual(await h.counts(),[{events:0,actions:0,nonces:0}]);}finally{await h.dispose();}
});
test('same key ID and material signed in other environment cannot authorize HTTP',async()=>{
 const h=await http('staging');try{const response=await h.local.dispatchFetch('http://localhost/v1/ingress/synthetic',await h.signed('crossenv','development'));assert.equal(response.status,401);assert.deepEqual(await h.counts(),[{events:0,actions:0,nonces:0}]);}finally{await h.dispose();}
});

// Audit of inherited authentication behavior, not invented test-first history.
for(const [label,change,status] of [
 ['method',(x:any)=>{x.method='PUT';},405],
 ['wrong source',(x:any)=>{x.headers.set('apacely-source','other-source');},401],
 ['identical duplicate proof',(x:any)=>{x.headers.append('Apacely-Nonce',x.headers.get('apacely-nonce'));},401],
 ['unknown namespace header',(x:any)=>{x.headers.set('apacely-principal','forged');},401]
] as const)test('audited actual HTTP rejects '+label,async()=>{
 const h=await http('staging');try{const input=await h.signed();change(input);const response=await h.local.dispatchFetch('http://localhost/v1/ingress/synthetic',input);assert.equal(response.status,status);assert.deepEqual(await h.counts(),[{events:0,actions:0,nonces:0}]);}finally{await h.dispose();}
});
for(const path of ['/v1/ingress/other','/v1/ingress/synthetic/'])test('audited actual HTTP rejects path '+path,async()=>{
 const h=await http('staging');try{const response=await h.local.dispatchFetch('http://localhost'+path,await h.signed());assert.equal(response.status,path==='/v1/ingress/other'?401:404);assert.deepEqual(await h.counts(),[{events:0,actions:0,nonces:0}]);}finally{await h.dispose();}
});
for(const lifecycle of ['revoked','expired'] as const)test('audited actual HTTP rejects '+lifecycle+' key',async()=>{
 const h=await http('staging',lifecycle);try{const response=await h.local.dispatchFetch('http://localhost/v1/ingress/synthetic',await h.signed());assert.equal(response.status,401);assert.deepEqual(await h.counts(),[{events:0,actions:0,nonces:0}]);}finally{await h.dispose();}
});
for(const [label,delta] of [['stale',-300000],['future',60000]] as const)test('audited actual HTTP rejects signed '+label,async()=>{
 const h=await http('staging');try{const signedAt=new Date(Date.parse(h.time)+delta).toISOString();const response=await h.local.dispatchFetch('http://localhost/v1/ingress/synthetic',await h.signed('time-nonce','staging',h.records[0].key_id,signedAt));assert.equal(response.status,401);assert.deepEqual(await h.counts(),[{events:0,actions:0,nonces:0}]);}finally{await h.dispose();}
});
test('audited actual HTTP rotation conflicts old nonce and replays event with new nonce',async()=>{
 const h=await http('staging');try{const first=await h.local.dispatchFetch('http://localhost/v1/ingress/synthetic',await h.signed());const oldEvent=await first.json() as {event_id:string};assert.equal(first.status,200);const conflict=await h.local.dispatchFetch('http://localhost/v1/ingress/synthetic',await h.signed('public-http-nonce','staging',h.records[1].key_id));assert.equal(conflict.status,409);const fresh=await h.local.dispatchFetch('http://localhost/v1/ingress/synthetic',await h.signed('fresh-http-nonce','staging',h.records[1].key_id));assert.equal(fresh.status,200);assert.equal((await fresh.json() as {event_id:string}).event_id,oldEvent.event_id);assert.deepEqual(await h.counts(),[{events:1,actions:1,nonces:2}]);}finally{await h.dispose();}
});
test('audited actual HTTP empty query is normalized before observable ingress',async()=>{
 const h=await http('staging');try{const response=await h.local.dispatchFetch('http://localhost/v1/ingress/synthetic?',await h.signed());assert.equal(response.status,200);assert.deepEqual(await h.counts(),[{events:1,actions:1,nonces:1}]);}finally{await h.dispose();}
});
test('audited Fetch strips outer OWS before verification (documented limitation)',async()=>{
 const h=await http('staging');try{const input=await h.signed();input.headers.set('apacely-nonce',' \t'+input.headers.get('apacely-nonce')+'\t ');assert.equal(input.headers.get('apacely-nonce'),'public-http-nonce');const response=await h.local.dispatchFetch('http://localhost/v1/ingress/synthetic',input);assert.equal(response.status,200);assert.deepEqual(await h.counts(),[{events:1,actions:1,nonces:1}]);}finally{await h.dispose();}
});
