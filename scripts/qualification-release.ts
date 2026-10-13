import {readFileSync,lstatSync,readdirSync,mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {spawnSync,type SpawnSyncOptionsWithStringEncoding} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const profiles=['contention16','capacity16-source4','source-keys128','source-rate100'] as const;
const artifacts=['bootstrap','sealed','initializer','runner'] as const;
type Artifact=typeof artifacts[number];
type Target={readonly config:string;readonly profile:string;readonly artifact:Artifact};
export const QUALIFICATION_TARGETS:readonly Target[]=Object.freeze([
 ...profiles.flatMap(profile=>artifacts.map(artifact=>Object.freeze({config:`wrangler.qualification-${profile}-${artifact}.jsonc`,profile,artifact}))),
 ...(['bootstrap','initializer','runner'] as const).map(artifact=>Object.freeze({config:artifact==='initializer'?'wrangler.qualification-initializer.jsonc':`wrangler.qualification-initializer-${artifact}.jsonc`,profile:'initializer',artifact})),
]);
function target(config:string,artifact:string):Target {
 const found=QUALIFICATION_TARGETS.find(t=>t.config===config&&t.artifact===artifact);
 if(!found)throw Error('Exact qualification config/artifact pair required');
 return found;
}
function expected(t:Target):Record<string,unknown> {
 const base:Record<string,unknown>={$schema:'./node_modules/wrangler/config-schema.json',account_id:'0'.repeat(32),compatibility_date:'2025-07-18',compatibility_flags:[],workers_dev:false,preview_urls:false,routes:[],send_metrics:false,observability:{enabled:false},triggers:{crons:[]}};
 const standalone=t.profile==='initializer';
 const stable=standalone?'apacely-qualification-target-disabled':`apacely-qualification-${t.profile}-disabled`;
 const initializer=standalone?'apacely-qualification-initializer-disabled':`apacely-qualification-${t.profile}-initializer-disabled`;
 const birth=[{tag:'qualification-initial-birth-v1',new_sqlite_classes:['StagingAdmissionCoordinator']}];
 if(t.artifact==='runner')return {...base,name:standalone?'apacely-qualification-initializer-runner-disabled':`apacely-qualification-${t.profile}-runner-disabled`,main:'src/qualification/initialization-runner-worker.ts',services:[{binding:'INITIALIZER',service:initializer}]};
 if(t.artifact==='initializer')return {...base,name:initializer,main:'src/qualification/initialization-worker.ts',durable_objects:{bindings:[{name:'QUALIFICATION_ADMISSION',class_name:'StagingAdmissionCoordinator',script_name:stable}]}};
 if(standalone)return {...base,name:stable,main:'src/qualification/initialization-bootstrap-worker.ts',durable_objects:{bindings:[{name:'QUALIFICATION_ADMISSION',class_name:'StagingAdmissionCoordinator'}]},migrations:birth};
 const result={...base,name:stable,main:`src/qualification/artifacts/${t.profile}-${t.artifact}.ts`,vars:{APACELY_ENVIRONMENT:'staging',APACELY_OPERATION:'ingest_mock_lead',APACELY_INGRESS_ENABLED:'false',APACELY_EFFECTS_ENABLED:'false',STAGING_ACCESS_ISSUER:'REPLACE_WITH_APPROVED_ACCESS_ISSUER',STAGING_ACCESS_AUDIENCE:'REPLACE_WITH_APPROVED_ACCESS_AUDIENCE'},d1_databases:[{binding:'DB',database_name:`apacely-qualification-${t.profile}`,database_id:'00000000-0000-4000-8000-000000000000',migrations_dir:'migrations/staging'}],durable_objects:{bindings:[{name:'STAGING_ADMISSION',class_name:'StagingAdmissionCoordinator'}]},migrations:birth};
 if(t.artifact!=='sealed')return result;
 const prefix={'contention16':'C16','capacity16-source4':'C4','source-keys128':'K128','source-rate100':'R100'}[t.profile]!;
 const slots=t.profile==='source-keys128'
  ?['QUALIFICATION_HMAC_KEYRING_1','QUALIFICATION_HMAC_KEYRING_2','QUALIFICATION_HMAC_KEYRING_3','QUALIFICATION_HMAC_KEYRING_4']
  :Array.from({length:16},(_,i)=>['CURRENT','NEXT'].map(slot=>`QUALIFICATION_SIGNING_KEY_${prefix}_${String(i+1).padStart(3,'0')}_${slot}`)).flat();
 return {...result,secrets:{required:slots}};
}
function stat(path:string) {
 try{return lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
}
export function assertQualificationWorkspace(root=ROOT):void {
 const visit=(path:string):void=>{
  const info=stat(path);if(!info)return;
  if(info.isSymbolicLink())throw Error('Workspace symlink forbidden');
  if(info.isDirectory())for(const name of readdirSync(path)){
   if(/^(?:\.env|\.dev\.vars)(?:\.|$)/.test(name))throw Error('Credential file forbidden');
   visit(resolve(path,name));
  }
 };
 // Scan source/output trees; dependencies are pinned but not an arbitrary source tree.
 for(let path=resolve(root);;path=dirname(path)){
  if(stat(path)?.isSymbolicLink())throw Error('Workspace ancestor symlink forbidden');
  if(path===dirname(path))break;
 }
 if(readdirSync(root).some(name=>/^(?:\.env|\.dev\.vars)(?:\.|$)/.test(name)))throw Error('Credential file forbidden');
 for(const path of ['.wrangler/deploy','node_modules/.cache/wrangler/wrangler.json'])if(stat(resolve(root,path)))throw Error('Config redirect forbidden');
 for(const path of ['src','migrations','.wrangler'])visit(resolve(root,path));
 for(const path of ['node_modules','node_modules/.cache','node_modules/.cache/wrangler','node_modules/wrangler','node_modules/wrangler/bin','node_modules/wrangler/bin/wrangler.js','node_modules/wrangler/wrangler-dist','node_modules/wrangler/wrangler-dist/cli.js','node_modules/wrangler/package.json','tests','tests/d1','tests/d1/loopback-guard.mjs',...QUALIFICATION_TARGETS.map(t=>t.config)])if(stat(resolve(root,path))?.isSymbolicLink())throw Error('Config, dependency or guard symlink forbidden');
}
export function validateQualificationConfig(value:unknown,config:string,artifact:string):void {
 if(!isDeepStrictEqual(value,expected(target(config,artifact))))throw Error('Exact inert top-level qualification config required; named environments/inheritance forbidden');
}
export function qualificationPlan(args:readonly string[],ambient:NodeJS.ProcessEnv={},runId='prepared',root=ROOT) {
 if(args.length!==7||!['types','dry-run'].includes(args[0]!)||args[1]!=='--config'||args[3]!=='--artifact'||args[5]!=='--env'||args[6]!=='staging')throw Error('Fixed offline mode and explicit staging required');
 if(Object.keys(ambient).some(key=>/^(?:CF_|CLOUDFLARE_|WRANGLER_|NODE_|DOTENV_|LD_|npm_config_.*(?:proxy|node|wrangler|token|config)|APACELY_|QUALIFICATION_|(?:HTTP|HTTPS|ALL|NO)_PROXY$)/i.test(key)))throw Error('Credentials or environment overrides forbidden');
 if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(runId))throw Error('Invalid isolated output identifier');
 const t=target(args[2]!,args[4]!);
 assertQualificationWorkspace(root);
 validateQualificationConfig(JSON.parse(readFileSync(resolve(root,t.config),'utf8')),t.config,t.artifact);
 const output=`.wrangler/qualification-release/${t.profile}/${t.artifact}/${runId}`;
 const command=args[0]==='types'?['types',`${output}/types.d.ts`,'--config',t.config]:['deploy','--dry-run','--outdir',output,'--config',t.config];
 return {environment:'staging',configEnvironment:'top-level',output,args:[...command,'--experimental-provision=false','--experimental-auto-create=false'],env:{PATH:'/usr/bin:/bin',WRANGLER_SEND_METRICS:'false',CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV:'false',CLOUDFLARE_INCLUDE_PROCESS_ENV:'false'}};
}
const NODE22='/root/apacely-toolchain/node-v22.23.3-linux-x64/bin/node';
type Launcher=(command:string,args:readonly string[],options:SpawnSyncOptionsWithStringEncoding)=>{status:number|null;stdout?:string;error?:Error;signal?:string|null};
// Injection is import-only unit-test wiring, never a CLI option or environment selector.
export function runQualification(args:readonly string[],ambient:NodeJS.ProcessEnv=process.env,launch:Launcher=(command,argv,options)=>spawnSync(command,argv,options)) {
 const plan=qualificationPlan(args,ambient,randomUUID());
 const output=resolve(ROOT,plan.output);
 if(spawnSync('/usr/bin/git',['check-ignore','--quiet','--',plan.output],{cwd:ROOT,env:{PATH:'/usr/bin:/bin'},timeout:10000}).status!==0)throw Error('Output must be Git ignored');
 if(JSON.parse(readFileSync(resolve(ROOT,'node_modules/wrangler/package.json'),'utf8')).version!=='4.149.0')throw Error('Pinned Wrangler 4.149.0 required');
 const home=mkdtempSync(resolve(tmpdir(),'apacely-qualification-cli-'));
 const env:NodeJS.ProcessEnv={...plan.env,HOME:home,XDG_CONFIG_HOME:home};
 try{
  const version=launch(NODE22,['--version'],{env,encoding:'utf8',timeout:10000});
  if(version.status!==0||version.stdout?.trim()!=='v22.23.3')throw Error('Pinned Node 22.23.3 required');
  mkdirSync(dirname(output),{recursive:true,mode:0o700});
  mkdirSync(output,{mode:0o700}); // Exclusive leaf: never reuse or overwrite a previous run.
  const result=launch(NODE22,['--import',resolve(ROOT,'tests/d1/loopback-guard.mjs'),resolve(ROOT,'node_modules/wrangler/bin/wrangler.js'),...plan.args],{cwd:ROOT,env,encoding:'utf8',stdio:'inherit',timeout:120000});
  const files:{path:string;sha256:string}[]=[];
  if(result.status===0){
   assertQualificationWorkspace();
   const names=readdirSync(output).sort();
   if(args[0]==='types'?!names.includes('types.d.ts'):!names.some(name=>name.endsWith('.js')))throw Error('Missing useful generated artifact');
   for(const name of names){
    const path=resolve(output,name);if(!lstatSync(path).isFile())throw Error('Generated artifact must be a regular file');
    const bytes=readFileSync(path);if(bytes.length===0)throw Error('Empty generated artifact');
    files.push({path:`${plan.output}/${name}`,sha256:createHash('sha256').update(bytes).digest('hex')});
   }
  }
  return {status:result.status??1,output:plan.output,files};
 }finally{rmSync(home,{recursive:true,force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const result=runQualification(process.argv.slice(2));console.log(JSON.stringify(result));process.exitCode=result.status;}
 catch{console.error('Offline qualification command refused or failed; no remote mode is available.');process.exitCode=1;}
}
