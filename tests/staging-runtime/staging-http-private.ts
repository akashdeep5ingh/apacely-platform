import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFile,mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {SignJWT,generateKeyPair,exportJWK} from 'jose';
import {Miniflare,convertV4MiniflareOptions} from '../../node_modules/wrangler/node_modules/miniflare/dist/src/index.js';
import {stagingMigrationStatements} from '../../src/staging-migrations.js';
import {D1Repository,type D1Binding} from '../../src/d1-repository.js';
import {D1SourceMappingStore} from '../../src/source-mappings.js';

export const ROOT='/root/apacely-staging-evidence/staging-http-runtime';
const NAME='staging-http-qualification',CLASS='StagingAdmissionCoordinator';
export const ISSUER='https://offline-synthetic.cloudflareaccess.com',AUDIENCE='a'.repeat(64);
export async function credentials(){
 const {publicKey,privateKey}=await generateKeyPair('RS256');
 const jwk={...await exportJWK(publicKey),kid:'local-access',alg:'RS256',use:'sig'};
 const assertion=await new SignJWT({}).setProtectedHeader({alg:'RS256',kid:jwk.kid}).setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt().setExpirationTime('5m').sign(privateKey);
 const bytes=crypto.getRandomValues(new Uint8Array(32));
 const key=await crypto.subtle.importKey('raw',bytes,{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return {jwk,assertion,key,secret:Buffer.from(bytes).toString('base64'),erase(){bytes.fill(0);}};
}
export type Credentials=Awaited<ReturnType<typeof credentials>>;
export function binding(c:Credentials,source='a',enabled='true',effects='false'){
 return {APACELY_ENVIRONMENT:'staging',APACELY_OPERATION:'ingest_mock_lead',APACELY_INGRESS_ENABLED:enabled,APACELY_EFFECTS_ENABLED:effects,STAGING_ACCESS_ISSUER:ISSUER,STAGING_ACCESS_AUDIENCE:AUDIENCE,STAGING_SIGNING_KEY_CURRENT:c.secret,STAGING_HMAC_KEY_REGISTRY:JSON.stringify([{slot:'current',key_id:'key-'+source,environment:'staging',provider:'synthetic',principal:'principal-'+source,source:'source-'+source,route:'/v1/ingress/synthetic',not_before:new Date(Date.now()-60000).toISOString(),not_after:new Date(Date.now()+300000).toISOString(),revoked_at:null}])};
}
export async function signed(c:Credentials,body:string,nonce:string,source='a'){
 const signedAt=new Date().toISOString(),digest=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(body))).toString('hex');
 const message=JSON.stringify(['apacely-synthetic-ingress-hmac-v1','staging','synthetic','principal-'+source,'source-'+source,'key-'+source,'POST','/v1/ingress/synthetic',signedAt,nonce,digest]);
 const signature=Buffer.from(await crypto.subtle.sign('HMAC',c.key,new TextEncoder().encode(message))).toString('base64url');
 return {method:'POST',body,headers:{'content-type':'application/json','Cf-Access-Jwt-Assertion':c.assertion,'apacely-key-id':'key-'+source,'apacely-source':'source-'+source,'apacely-signed-at':signedAt,'apacely-nonce':nonce,'apacely-signature':signature}};
}
export async function directory(){await mkdir(ROOT,{recursive:true,mode:0o700});return mkdtemp(ROOT+'/run-');}
export async function runtime(mode:'bootstrap'|'sealed'|'inspect',persist:string,c:Credentials,source='a',enabled='true',effects='false'){
 // Release artifacts are bundled verbatim. Private inspection is a distinct, never-published artifact.
 const inspection=`import {DurableObject} from 'cloudflare:workers';
 export class ${CLASS} extends DurableObject {async fetch(){return Response.json([...await this.ctx.storage.list()]);}}
 export default {fetch(){return new Response(null,{status:503});}};`;
 const result=await build({...(mode==='inspect'?{stdin:{contents:inspection,resolveDir:process.cwd()}}:{entryPoints:['src/staging-'+(mode==='bootstrap'?'bootstrap-worker':'worker')+'.ts']}),bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers']});
 const script=result.outputFiles[0].text;
 if(mode!=='inspect'){assert.ok(!script.includes('/test/'));assert.ok(!script.includes('storage.list()'));}
 let jwks=0;const blocked:string[]=[];
 const options=convertV4MiniflareOptions({host:'127.0.0.1',cf:false,workers:[{name:NAME,modules:true,script,compatibilityDate:'2025-07-18',compatibilityFlags:[],bindings:binding(c,source,enabled,effects),d1Databases:{DB:'local-staging-http-db'},durableObjects:{STAGING_ADMISSION:{className:CLASS,useSQLite:true}},outboundService(request){
  if(request.url!==ISSUER+'/cdn-cgi/access/certs'||request.method!=='GET'){blocked.push(new URL(request.url).origin);throw Error('External network forbidden');}
  jwks++;return new Response(JSON.stringify({keys:[c.jwk]}),{headers:{'content-type':'application/json'}});
 }}]});
 const mf=new Miniflare({...options,resourcePersistencePath:persist});await mf.ready;
 return {mf,jwks:()=>jwks,blocked,async db(){return await mf.getD1Database('DB',NAME);},async state(){assert.equal(mode,'inspect');const ns=await mf.getDurableObjectNamespace('STAGING_ADMISSION',NAME);const r=await ns.get(ns.idFromName('distributed-admission-v1')).fetch('https://admission.internal/');assert.equal(r.status,200);return await r.json() as [string,unknown][];},async birth(){assert.equal(mode,'bootstrap');const ns=await mf.getDurableObjectNamespace('STAGING_ADMISSION',NAME);const r=await ns.get(ns.idFromName('distributed-admission-v1')).fetch('https://admission.internal/');assert.equal(r.status,503);await r.text();}};
}
export type Runtime=Awaited<ReturnType<typeof runtime>>;
export async function provision(h:Runtime){
 const db=await h.db();
 await db.prepare('CREATE TABLE "d1_migrations" (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)').run();
 const statements=stagingMigrationStatements('wrangler-4.149.0-initial');
 const sql=(await readFile('migrations/staging/0001_staging.sql','utf8')).trim();
 assert.equal(sql,statements.join('\n'),'checked-in migration must match current deterministic generator');
 await db.batch(statements.map(s=>db.prepare(s)));
 const binding=db as unknown as D1Binding,now=()=>new Date().toISOString();
 const repo=new D1Repository(binding,now,undefined,'staging'),mappings=new D1SourceMappingStore(binding,now,'staging');
 const a=await repo.createTenant('Synthetic HTTP A'),b=await repo.createTenant('Synthetic HTTP B');
 for(const [source,tenant] of [['a',a],['b',b]] as const)await mappings.create({provider:'synthetic',source:'source-'+source,principal:'principal-'+source,tenant_id:tenant.id,source_binding:'mock-source-'+source,environment:'staging',operation:'ingest_mock_lead'});
 return {a:a.id,b:b.id};
}
export async function rows(h:Runtime){
 const db=await h.db(),result:Record<string,any[]>={};
 for(const table of ['database_environment','tenants','source_mappings','leads','conversations','events','messages','qualification_state','action_outbox','replay_ledger'])result[table]=(await db.prepare('SELECT * FROM '+table+' ORDER BY '+(table==='database_environment'?'singleton':table==='replay_ledger'?'nonce_ref':'id')).all()).results;
 return result;
}
export async function evidence(persist:string,name:string,value:unknown){await writeFile(persist+'/'+name+'.json',JSON.stringify(value,null,2)+'\n',{mode:0o600});}
export async function send(h:Runtime,init:Awaited<ReturnType<typeof signed>>,status:number){const r=await h.mf.dispatchFetch('https://staging.invalid/v1/ingress/synthetic',init);const body=await r.text();assert.equal(r.status,status,body);return JSON.parse(body);}
