import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {spawnSync} from 'node:child_process';
const load=()=>import('../scripts/qualification-release.js');
test('executable runner invokes pinned guarded Wrangler with isolated ignored outputs and propagates failure',async()=>{
 const m=await load();assert.equal(typeof m.runQualification,'function');
 const calls:{command:string;args:readonly string[];options:any}[]=[];
 const launch=(command:string,args:readonly string[],options:any)=>{
  calls.push({command,args,options});
  return args[0]==='--version'?{status:0,stdout:'v22.23.3\n'}:{status:7,stdout:''};
 };
 const result=m.runQualification(['types',...sealedArgs.slice(1)],{},launch);
 assert.equal(result.status,7);assert.equal(calls.length,2);
 assert.equal(calls[0].command,'/root/apacely-toolchain/node-v22.23.3-linux-x64/bin/node');
 assert.deepEqual(calls[1].args.slice(0,3),['--import',join(process.cwd(),'tests/d1/loopback-guard.mjs'),join(process.cwd(),'node_modules/wrangler/bin/wrangler.js')]);
 assert.ok(calls[1].args.includes('--experimental-provision=false'));
 assert.equal(calls[1].options.env.HOME,calls[1].options.env.XDG_CONFIG_HOME);
 assert.ok(calls[1].options.env.HOME.startsWith(tmpdir()));
 assert.equal(existsSync(calls[1].options.env.HOME),false,'temporary home removed even on failure');
 assert.deepEqual(Object.keys(calls[1].options.env).sort(),['PATH','HOME','XDG_CONFIG_HOME','WRANGLER_SEND_METRICS','CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV','CLOUDFLARE_INCLUDE_PROCESS_ENV'].sort());
 assert.equal(calls[1].options.env.NODE_OPTIONS,undefined);
 assert.equal(calls[1].options.timeout,120000);
 assert.equal(spawnSync('/usr/bin/git',['check-ignore','--quiet',result.output],{cwd:process.cwd()}).status,0);
 rmSync(result.output,{recursive:true,force:true});
});
test('workspace rejects transitive dependency and guard redirects',async()=>{
 const m=await load();
 for(const name of ['node_modules/wrangler','node_modules/wrangler/bin','node_modules/wrangler/package.json','node_modules/.cache','tests','tests/d1','tests/d1/loopback-guard.mjs']){
  const root=mkdtempSync(join(tmpdir(),'qualification-link-'));
  try{mkdirSync(join(root,name,'..'),{recursive:true});symlinkSync('/missing-qualification-target',join(root,name));assert.throws(()=>m.assertQualificationWorkspace(root),name);}finally{rmSync(root,{recursive:true,force:true});}
 }
});
test('successful exit without useful generated artifact is refused',async()=>{
 const m=await load();let output='';
 const launch=(_command:string,args:readonly string[])=>{
  if(args[0]==='--version')return {status:0,stdout:'v22.23.3'};
  output=join(args[4],'..');return {status:0,stdout:''};
 };
 try{assert.throws(()=>m.runQualification(['types',...sealedArgs.slice(1)],{},launch),/artifact/i);}
 finally{if(output)rmSync(output,{recursive:true,force:true});}
});
test('generated artifact readback yields hashes in unique paths; temporary homes never inherit ambient state',async()=>{
 const m=await load();const outputs:string[]=[];
 const launch=(_command:string,args:readonly string[])=>{
  if(args[0]==='--version')return {status:0,stdout:'v22.23.3'};
  writeFileSync(args[4],'// unit launcher fixture, not Wrangler execution\n');return {status:0,stdout:''};
 };
 try{
  for(let i=0;i<2;i++){
   const result=m.runQualification(['types',...sealedArgs.slice(1)],{HOME:'/untrusted',SECRET:'must-not-propagate'},launch);
   outputs.push(result.output);assert.equal(result.status,0);assert.equal(result.files.length,1);
   assert.equal(result.files[0].path,`${result.output}/types.d.ts`);assert.match(result.files[0].sha256,/^[a-f0-9]{64}$/);
  }
  assert.notEqual(outputs[0],outputs[1]);
 }finally{outputs.forEach(output=>rmSync(output,{recursive:true,force:true}));}
});
test('workspace rejects a symlinked ancestor even when the workspace leaf is regular',async()=>{
 const m=await load();const root=mkdtempSync(join(tmpdir(),'qualification-ancestor-'));
 try{mkdirSync(join(root,'actual','repo'),{recursive:true});symlinkSync(join(root,'actual'),join(root,'alias'));assert.throws(()=>m.assertQualificationWorkspace(join(root,'alias','repo')),/symlink/i);}
 finally{rmSync(root,{recursive:true,force:true});}
});
test('all nineteen configs reject named environments remote identities hooks provisioning and exposure changes',async()=>{
 const m=await load();
 for(const t of m.QUALIFICATION_TARGETS){
  const c=JSON.parse(readFileSync(t.config,'utf8'));
  const mutations=[{...c,env:{staging:{}}},{...c,account_id:'1'.repeat(32)},{...c,build:{command:'touch forbidden'}},{...c,workers_dev:true},{...c,preview_urls:true},{...c,routes:['public.example/*']},{...c,triggers:{crons:['* * * * *']}},{...c,observability:{enabled:true}},{...c,compatibility_date:'2026-01-01'},{...c,compatibility_flags:['nodejs_compat']},{...c,main:'../outside.ts'},{...c,assets:{directory:'public'}},{...c,secrets:{required:[]}}];
  if(c.vars)mutations.push({...c,vars:{...c.vars,APACELY_INGRESS_ENABLED:'true'}},{...c,vars:{...c.vars,APACELY_EFFECTS_ENABLED:'true'}});
  if(c.d1_databases)mutations.push({...c,d1_databases:[{...c.d1_databases[0],database_id:'11111111-1111-4111-8111-111111111111'}]},{...c,d1_databases:[{...c.d1_databases[0],database_id:undefined}]},{...c,d1_databases:[{...c.d1_databases[0],remote:true}]});
  for(const mutation of mutations)assert.throws(()=>m.validateQualificationConfig(mutation,t.config,t.artifact));
 }
});
test('only exact seven-token offline argv and matching config artifact pairs are accepted',async()=>{
 const m=await load();
 for(const args of [[],[...sealedArgs,'--remote'],[...sealedArgs,'--outdir','/tmp/out'],['deploy',...sealedArgs.slice(1)],['dev',...sealedArgs.slice(1)],['migration-apply',...sealedArgs.slice(1)],['dry-run',...sealedArgs.slice(1,6),'production'],['dry-run','--config',sealedArgs[2],'--artifact','bootstrap','--env','staging'],['dry-run','--config','wrangler.staging.jsonc',...sealedArgs.slice(3)],['dry-run','--config',`./${sealedArgs[2]}`,...sealedArgs.slice(3)]])assert.throws(()=>m.qualificationPlan(args,{},'unit-run'));
 const p=m.qualificationPlan(sealedArgs,{},'unit-run');
 assert.deepEqual(p.args,['deploy','--dry-run','--outdir',p.output,'--config',sealedArgs[2],'--experimental-provision=false','--experimental-auto-create=false']);
 assert.ok(!p.args.includes('--env'),'explicit staging selects reviewed top-level configs, never an invented named environment');
});
test('runner refuses wrong pinned Node before launching Wrangler and maps timeout to failure',async()=>{
 const m=await load();let count=0;
 assert.throws(()=>m.runQualification(sealedArgs,{},()=>{count++;return {status:0,stdout:'v22.0.0'};}),/Pinned Node/);assert.equal(count,1);
 const result=m.runQualification(sealedArgs,{},(_command,args)=>args[0]==='--version'?{status:0,stdout:'v22.23.3'}:{status:null,signal:'SIGTERM'});
 assert.equal(result.status,1);assert.deepEqual(result.files,[]);rmSync(result.output,{recursive:true,force:true});
});
const shardNames=['QUALIFICATION_HMAC_KEYRING_1','QUALIFICATION_HMAC_KEYRING_2','QUALIFICATION_HMAC_KEYRING_3','QUALIFICATION_HMAC_KEYRING_4'];
function shardedConfig(){
 const c=JSON.parse(readFileSync('wrangler.qualification-source-keys128-sealed.jsonc','utf8'));
 return {...c,secrets:{required:[...shardNames]}};
}
test('source-key sealed fixed four-shard config validates and plans in a guarded fixture workspace',async()=>{
 const m=await load();const config='wrangler.qualification-source-keys128-sealed.jsonc';
 const c=shardedConfig();
 assert.doesNotThrow(()=>m.validateQualificationConfig(c,config,'sealed'));
 const root=mkdtempSync(join(tmpdir(),'qualification-shards-'));
 try{
  writeFileSync(join(root,config),JSON.stringify(c));
  for(const mode of ['types','dry-run']){
   const p=m.qualificationPlan([mode,'--config',config,'--artifact','sealed','--env','staging'],{},'unit-shards',root);
   assert.equal(p.environment,'staging');assert.equal(p.configEnvironment,'top-level');
   assert.ok(p.args.includes('--experimental-provision=false'));
   assert.ok(p.args.includes('--experimental-auto-create=false'));
  }
  writeFileSync(join(root,'.env'),'');
  assert.throws(()=>m.qualificationPlan(['types','--config',config,'--artifact','sealed','--env','staging'],{},'unit-shards',root),/Credential/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('source-key shards reject legacy mixed missing extra dynamic malformed and metadata authority',async()=>{
 const m=await load();const config='wrangler.qualification-source-keys128-sealed.jsonc';const c=shardedConfig();
 const legacy=(length:number)=>Array.from({length},(_,i)=>`QUALIFICATION_SIGNING_KEY_K128_${String(i+1).padStart(3,'0')}_CURRENT`);
 const required:unknown[]=[legacy(128),legacy(129),[...shardNames,...legacy(1)],shardNames.slice(0,3),[...shardNames,'QUALIFICATION_HMAC_KEYRING_5'],[...shardNames].reverse(),[...shardNames.slice(0,3),shardNames[0]],['QUALIFICATION_HMAC_KEYRING_${index}'],[...shardNames.slice(0,3),'QUALIFICATION_HMAC_KEYRING_04'],shardNames.join(','),null,[...shardNames.slice(0,3),4]];
 for(const list of required)assert.throws(()=>m.validateQualificationConfig({...c,secrets:{required:list}},config,'sealed'));
 for(const mutation of [
  {...c,secrets:{required:shardNames,legacy:legacy(128)}},
  {...c,vars:{...c.vars,QUALIFICATION_HMAC_KEY_REGISTRY:'[]'}},
  {...c,vars:{...c.vars,QUALIFICATION_HMAC_KEYRING_1:'[]'}},
  {...c,vars:{...c.vars,QUALIFICATION_HMAC_LAYOUT:'65,64,0,0'}},
  {...c,env:{staging:{secrets:{required:shardNames}}}},
 ])assert.throws(()=>m.validateQualificationConfig(mutation,config,'sealed'));
 for(const t of m.QUALIFICATION_TARGETS.filter(t=>t.config!==config)){
  const other=JSON.parse(readFileSync(t.config,'utf8'));
  assert.throws(()=>m.validateQualificationConfig({...other,secrets:{required:shardNames}},t.config,t.artifact));
 }
});
const sealedArgs=['dry-run','--config','wrangler.qualification-contention16-sealed.jsonc','--artifact','sealed','--env','staging'];
test('planning performs workspace preflight before reading a selected config',async()=>{
 const m=await load();const root=mkdtempSync(join(tmpdir(),'qualification-plan-'));
 try{
  writeFileSync(join(root,sealedArgs[2]),readFileSync(sealedArgs[2]));
  writeFileSync(join(root,'.env'),'');
  assert.throws(()=>m.qualificationPlan(sealedArgs,{},'unit-run',root),/Credential/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('exact nineteen fixed config/artifact pairs validate without inventing named environments',async()=>{
 const m=await load().catch(()=>null);assert.ok(m,'separate qualification runner must exist');
 assert.equal(m.QUALIFICATION_TARGETS.length,19);
 for(const t of m.QUALIFICATION_TARGETS){
  const c=JSON.parse(readFileSync(t.config,'utf8'));
  assert.doesNotThrow(()=>m.validateQualificationConfig(c,t.config,t.artifact));
  const p:ReturnType<typeof m.qualificationPlan>=m.qualificationPlan(['types','--config',t.config,'--artifact',t.artifact,'--env','staging'],{},'unit-run');
  assert.deepEqual(p.args,['types',`${p.output}/types.d.ts`,'--config',t.config,'--experimental-provision=false','--experimental-auto-create=false']);
  assert.ok(p.output.includes(`${t.profile}/${t.artifact}/unit-run`));
  assert.equal(p.environment,'staging');assert.equal(p.configEnvironment,'top-level');
 }
});

test('plans reject ambient credentials overrides proxies and output traversal',async()=>{
 const m=await load();const args=['dry-run','--config','wrangler.qualification-contention16-sealed.jsonc','--artifact','sealed','--env','staging'];
 for(const key of ['CF_API_TOKEN','CLOUDFLARE_API_TOKEN','WRANGLER_CONFIG','NODE_OPTIONS','NODE_PATH','HTTP_PROXY','https_proxy','ALL_PROXY','NO_PROXY','DOTENV_CONFIG_PATH','npm_config_proxy','npm_config_https_proxy','npm_config_node_options','LD_PRELOAD','LD_LIBRARY_PATH','CLOUDFLARE_ENV','APACELY_ENVIRONMENT','QUALIFICATION_SIGNING_KEY_C16_001_CURRENT'])assert.throws(()=>m.qualificationPlan(args,{[key]:'hostile'},'unit-run'),key);
 for(const id of ['../outside','a/b','','.','x;touch'])assert.throws(()=>m.qualificationPlan(args,{},id));
});

test('workspace rejects credential files redirects and symlinks including dangling ancestors',async()=>{
 const m=await load();assert.equal(typeof m.assertQualificationWorkspace,'function');
 for(const name of ['.env.staging','.dev.vars','.wrangler/deploy/config.json','.wrangler/deploy','src/qualification/.env','node_modules/.cache/wrangler/wrangler.json']){
  const root=mkdtempSync(join(tmpdir(),'qualification-negative-'));
  try{mkdirSync(join(root,name,'..'),{recursive:true});writeFileSync(join(root,name),'{}');assert.throws(()=>m.assertQualificationWorkspace(root),name);}finally{rmSync(root,{recursive:true,force:true});}
 }
 for(const name of ['.wrangler','src','node_modules','wrangler.qualification-contention16-sealed.jsonc']){
  const root=mkdtempSync(join(tmpdir(),'qualification-negative-'));
  try{symlinkSync('/missing-qualification-target',join(root,name));assert.throws(()=>m.assertQualificationWorkspace(root),name);}finally{rmSync(root,{recursive:true,force:true});}
 }
});
