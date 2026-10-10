import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as tooling from '../scripts/staging-release.js';
const releasePlan=tooling.releasePlan;
test('physical internal metadata preflight rejects changes in schema, storage class and content',()=>{
 const validate=(tooling as any).validatePhysicalInternalMetadata;
 assert.equal(typeof validate,'function');
 const observed={objects:[{type:'table',name:'_cf_METADATA',tbl_name:'_cf_METADATA',sql:'CREATE TABLE _cf_METADATA (\n        key INTEGER PRIMARY KEY,\n        value BLOB\n      )'}],columns:[{cid:0,name:'key',type:'INTEGER',notnull:0,dflt_value:null,pk:1},{cid:1,name:'value',type:'BLOB',notnull:0,dflt_value:null,pk:0}],rows:[{key:2,value:1,key_type:'integer',value_type:'integer'}],indexes:[]};
 validate(observed);validate({...observed,rows:[{...observed.rows[0],value:6}]});
 for(const edit of [(x:any)=>x.objects[0].sql+=' WITHOUT ROWID',(x:any)=>x.columns[1].type='TEXT',(x:any)=>x.rows[0].value=-1,(x:any)=>x.rows[0].value=Number.MAX_SAFE_INTEGER+1,(x:any)=>x.rows[0].value=1.5,(x:any)=>x.rows[0].value_type='text',(x:any)=>x.rows[0].key=1,(x:any)=>x.rows.push({...x.rows[0],key:3}),(x:any)=>x.indexes.push({name:'forged'}),(x:any)=>x.objects.push({...x.objects[0],name:'forged'})]){const bad=structuredClone(observed);edit(bad);assert.throws(()=>validate(bad));}
});

test('bootstrap packaging has a separate closed entrypoint and no migration authority',()=>{
 const c=JSON.parse(readFileSync('wrangler.staging-bootstrap.jsonc','utf8'));
 assert.equal(c.main,'src/staging-bootstrap-worker.ts');
 const sealed=JSON.parse(readFileSync('wrangler.staging.jsonc','utf8'));
 assert.equal(c.env.staging.name,sealed.env.staging.name,'bootstrap must retain sealed namespace identity');
 assert.deepEqual(c.env.staging.durable_objects,sealed.env.staging.durable_objects);
 assert.deepEqual(c.env.staging.migrations,sealed.env.staging.migrations);
 tooling.validateStagingConfig(c,'bootstrap');
 const p=releasePlan(['dry-run','--config','wrangler.staging-bootstrap.jsonc','--env','staging'],{});
 assert.deepEqual(p.args,['deploy','--dry-run','--outdir','.wrangler/staging-bootstrap-dist','--env','staging','--config','wrangler.staging-bootstrap.jsonc']);
 assert.throws(()=>releasePlan(['migration-apply','--config','wrangler.staging-bootstrap.jsonc','--env','staging'],{}));
 const bad=structuredClone(c);bad.main='src/staging-worker.ts';assert.throws(()=>tooling.validateStagingConfig(bad,'bootstrap'));
});
test('offline workspace rejects all dotenv variants and nested redirects',()=>{
 const root=mkdtempSync(join(tmpdir(),'apacely-release-'));
 try{for(const name of ['.env.local','.env.staging.local','.env.production','.dev.vars.local','.dev.vars.production']){writeFileSync(join(root,name),'inert');assert.throws(()=>tooling.assertOfflineWorkspace(root),name);rmSync(join(root,name));}}finally{rmSync(root,{recursive:true});}
});
test('migration plans isolate fixed local persistence and refuse proxy aliases',()=>{
 const args=['migration-apply','--config','wrangler.staging.jsonc','--env','staging'];
 const p=releasePlan(args,{});assert.deepEqual(p.args,['d1','migrations','apply','DB','--local','--persist-to','.wrangler/staging-local','--env','staging','--config','wrangler.staging.jsonc']);
 for(const key of ['http_proxy','https_proxy','all_proxy','NO_PROXY'])assert.throws(()=>releasePlan(args,{[key]:'inert'}));
});
const validateStagingConfig=(c:unknown)=>{assert.equal(typeof (tooling as any).validateStagingConfig,'function','configuration validator missing');return (tooling as any).validateStagingConfig(c);};
const assertOfflineWorkspace=(p:string)=>{assert.equal(typeof (tooling as any).assertOfflineWorkspace,'function','workspace validator missing');return (tooling as any).assertOfflineWorkspace(p);};

test('rejects credential env and provides sanitized child environment',()=>{
 const args=['migration-apply','--config','wrangler.staging.jsonc','--env','staging'];
 for(const key of ['CLOUDFLARE_API_TOKEN','CF_API_KEY','NODE_OPTIONS','HTTPS_PROXY','CLOUDFLARE_ENV','WRANGLER_API_BASE_URL'])assert.throws(()=>releasePlan(args,{[key]:'inert-test-value'}));
 const p=releasePlan(args,{PATH:'/attacker',HOME:'/attacker',UNRELATED:'ignored'});
 assert.equal(p.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV,'false');assert.equal(p.env.CLOUDFLARE_INCLUDE_PROCESS_ENV,'false');assert.equal(p.env.WRANGLER_SEND_METRICS,'false');assert.equal(p.env.UNRELATED,undefined);assert.notEqual(p.env.PATH,'/attacker');
 assert.ok(p.args.includes('--local'));assert.ok(!p.args.includes('--remote'));
});
test('exact inert configuration refuses rebinding and extra resources',()=>{
 const c=JSON.parse(readFileSync('wrangler.staging.jsonc','utf8'));validateStagingConfig(c);
 for(const edit of [(x:any)=>x.account_id='a'.repeat(32),(x:any)=>x.env.production={},(x:any)=>x.env.staging.workers_dev=true,(x:any)=>x.env.staging.vars.APACELY_EFFECTS_ENABLED='true',(x:any)=>x.env.staging.d1_databases[0].database_id='11111111-1111-4111-8111-111111111111',(x:any)=>x.build={command:'touch unsafe'},(x:any)=>x.queues={}]){const bad=structuredClone(c);edit(bad);assert.throws(()=>validateStagingConfig(bad));}
});
test('ambient dotenv, devvars and config redirects refuse execution',()=>{
 const root=mkdtempSync(join(tmpdir(),'apacely-release-'));
 try{for(const name of ['.env','.env.staging','.dev.vars','.dev.vars.staging']){writeFileSync(join(root,name),'inert');assert.throws(()=>assertOfflineWorkspace(root));rmSync(join(root,name));}assertOfflineWorkspace(root);}finally{rmSync(root,{recursive:true});}
});

test('release requires explicit config and staging; plans only fixed offline argv', async()=>{
 assert.equal(existsSync(new URL('../scripts/staging-release.ts',import.meta.url)),true,'offline release wrapper is missing');
 const {releasePlan}=await import('../scripts/staging-release.js');
 const plan=releasePlan(['dry-run','--config','wrangler.staging.jsonc','--env','staging'],{});
 assert.deepEqual(plan.args.slice(0,2),['deploy','--dry-run']);
 assert.ok(plan.args.includes('--config'));assert.ok(plan.args.includes('staging'));
 for(const args of [[],['deploy'],['check'],['check','--config','wrangler.staging.jsonc'],['dry-run','--config','wrangler.staging.jsonc','--env','production'],['dry-run','--config','wrangler.staging.jsonc','--env','staging','--remote']])assert.throws(()=>releasePlan(args,{}));
});
