import { existsSync, lstatSync, readFileSync, mkdtempSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

import { assertQualificationWorkspace } from './qualification-release.js';

const PRIVATE_CONFIG = 'wrangler.staging-private-birth-runner.jsonc';
export function validatePrivateBirthConfig(value: unknown): void {
  const expected = {$schema:'./node_modules/wrangler/config-schema.json',name:'apacely-staging-private-birth-runner',account_id:'00000000000000000000000000000000',main:'src/baseline-private-birth-runner.ts',compatibility_date:'2025-07-18',compatibility_flags:[],workers_dev:false,preview_urls:false,routes:[],send_metrics:false,observability:{enabled:false},durable_objects:{bindings:[{name:'STAGING_ADMISSION',class_name:'StagingAdmissionCoordinator',script_name:'apacely-ingress-staging'}]}};
  if (!isDeepStrictEqual(value,expected)) throw new Error('Exact inert private caller config required');
}
const ENV = 'staging';
const CONFIG = 'wrangler.staging.jsonc';
const BOOTSTRAP_CONFIG = 'wrangler.staging-bootstrap.jsonc';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const forbidden = /^(?:CF_|CLOUDFLARE_|WRANGLER_|NODE_OPTIONS$|(?:HTTP|HTTPS|ALL|NO)_PROXY$)/i;
const persistence = ['--persist-to', '.wrangler/staging-local'];
const allowed: Record<string, string[]> = {
  types: ['types', '.wrangler/staging-types.d.ts'],
  'dry-run': ['deploy', '--dry-run', '--outdir', '.wrangler/staging-dist'],
  'migration-apply': ['d1', 'migrations', 'apply', 'DB', '--local', ...persistence],
  'migration-status-local': ['d1', 'migrations', 'list', 'DB', '--local', ...persistence],
  'query-local': ['d1', 'execute', 'DB', '--local', ...persistence, '--command', 'SELECT name, sql FROM sqlite_master ORDER BY name'],
};
// workerd forbids direct reads of _cf_METADATA; validate physical content read-only.
export function validatePhysicalInternalMetadata(value: unknown): void {
  // Key 2 is workerd's monotonically advancing local-development D1 bookmark,
  // not migration history. Permit only a nonnegative safe INTEGER at this key.
  const bookmark=(value as any)?.rows?.[0]?.value;
  if (!Number.isSafeInteger(bookmark) || bookmark < 0) throw new Error('Invalid local D1 bookmark');
  const expected={objects:[{type:'table',name:'_cf_METADATA',tbl_name:'_cf_METADATA',sql:'CREATE TABLE _cf_METADATA (\n        key INTEGER PRIMARY KEY,\n        value BLOB\n      )'}],columns:[{cid:0,name:'key',type:'INTEGER',notnull:0,dflt_value:null,pk:1},{cid:1,name:'value',type:'BLOB',notnull:0,dflt_value:null,pk:0}],rows:[{key:2,value:1,key_type:'integer',value_type:'integer'}],indexes:[]};
  expected.rows[0]!.value=bookmark;
  if (!isDeepStrictEqual(value,expected)) throw new Error('Pinned physical D1 internal metadata mismatch');
}
export function assertOfflineWorkspace(root = ROOT): void {
  if (readdirSync(root).some(name => /^(?:\.env|\.dev\.vars)(?:\.|$)/.test(name))) throw new Error('credential file is forbidden');
  for (const name of ['.wrangler/deploy/config.json', '.wrangler/deploy', '.wrangler/staging-local', '.wrangler/staging-dist', '.wrangler/staging-bootstrap-dist', '.wrangler/staging-types.d.ts', '.wrangler', 'migrations', 'migrations/staging']) {
    const path = resolve(root, name);
    if (existsSync(path) && (lstatSync(path).isSymbolicLink() || name === '.wrangler/deploy/config.json')) throw new Error('config redirect or output symlink is forbidden');
  }
}
export function validateStagingConfig(value: unknown, artifact: 'sealed'|'bootstrap' = 'sealed'): void {
  if (artifact !== 'sealed' && artifact !== 'bootstrap') throw new Error('invalid artifact');
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid config');
  const cfg = value as Record<string, any>;
  const top = new Set(['$schema','name','account_id','main','compatibility_date','compatibility_flags','workers_dev','preview_urls','routes','send_metrics','observability','vars','d1_databases','durable_objects','migrations','env']);
  const nested = new Set(['name','workers_dev','preview_urls','routes','observability','vars','d1_databases','durable_objects','migrations']);
  if (Object.keys(cfg).some(k => !top.has(k)) || Object.keys(cfg.env ?? {}).join(',') !== ENV) throw new Error('config scope is invalid');
  const bootstrap = artifact === 'bootstrap';
  const expectedVars = {APACELY_ENVIRONMENT:'staging',APACELY_OPERATION:'ingest_mock_lead',APACELY_INGRESS_ENABLED:'false',APACELY_EFFECTS_ENABLED:'false'};
  if (cfg.$schema !== './node_modules/wrangler/config-schema.json' || cfg.name !== 'apacely-disabled-sentinel' || cfg.main !== (bootstrap ? 'src/staging-bootstrap-worker.ts' : 'src/staging-worker.ts') || cfg.account_id !== '00000000000000000000000000000000' || cfg.compatibility_date !== '2025-07-18' || !isDeepStrictEqual(cfg.compatibility_flags,[]) || cfg.send_metrics !== false) throw new Error('config identity is invalid');
  for (const [index, c] of [cfg, cfg.env.staging].entries()) {
    if (index && (c.name !== 'apacely-ingress-staging' || Object.keys(c).some(k => !nested.has(k)))) throw new Error('named environment is invalid');
    if (c.workers_dev !== false || c.preview_urls !== false || !isDeepStrictEqual(c.routes,[]) || !isDeepStrictEqual(c.observability,{enabled:false}) || !isDeepStrictEqual(c.vars,expectedVars)) throw new Error('config exposure or effects are forbidden');
    if (!isDeepStrictEqual(c.d1_databases,[{binding:'DB',database_name:'apacely-staging',database_id:'00000000-0000-4000-8000-000000000000',migrations_dir:'migrations/staging'}])) throw new Error('database scope is invalid');
    if (!isDeepStrictEqual(c.durable_objects,{bindings:[{name:'STAGING_ADMISSION',class_name:'StagingAdmissionCoordinator'}]}) || !isDeepStrictEqual(c.migrations,[{tag:'staging-admission-v1',new_sqlite_classes:['StagingAdmissionCoordinator']}])) throw new Error('durable object scope is invalid');
  }
}
export function releasePlan(args: string[], ambient: NodeJS.ProcessEnv = process.env): {args: string[]; env: NodeJS.ProcessEnv} {
  if (args[2] === PRIVATE_CONFIG) {
    if (args.length !== 5 || args[0] !== 'dry-run' || args[1] !== '--config' || args[3] !== '--env' || args[4] !== ENV) throw new Error('Exact offline private caller dry-run required');
    if (Object.keys(ambient).some(key => /^(?:CF_|CLOUDFLARE_|WRANGLER_|NODE_|DOTENV_|LD_|npm_config_.*(?:proxy|node|wrangler|token|config)|APACELY_|QUALIFICATION_|(?:HTTP|HTTPS|ALL|NO)_PROXY$)/i.test(key))) throw new Error('Credential or override environment forbidden');
    assertQualificationWorkspace();
    const file = resolve(ROOT,PRIVATE_CONFIG);
    if (lstatSync(file).isSymbolicLink()) throw new Error('Config symlink forbidden');
    validatePrivateBirthConfig(JSON.parse(readFileSync(file,'utf8')));
    return {args:['deploy','--dry-run','--outdir','.wrangler/staging-private-birth-dist','--config',PRIVATE_CONFIG,'--experimental-provision=false','--experimental-auto-create=false'],env:{PATH:'/usr/bin:/bin',WRANGLER_SEND_METRICS:'false',CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV:'false',CLOUDFLARE_INCLUDE_PROCESS_ENV:'false'}};
  }
  const bootstrap = args[2] === BOOTSTRAP_CONFIG;
  if (args.length !== 5 || args[1] !== '--config' || (!bootstrap && args[2] !== CONFIG) || args[3] !== '--env' || args[4] !== ENV || !Object.hasOwn(allowed,args[0]!) || (bootstrap && args[0] !== 'dry-run')) throw new Error('explicit fixed staging config and offline mode required');
  if (Object.keys(ambient).some(key => forbidden.test(key))) throw new Error('credential or override environment is forbidden');
  assertOfflineWorkspace();
  const config = bootstrap ? BOOTSTRAP_CONFIG : CONFIG;
  const file = resolve(ROOT, config);
  if (lstatSync(file).isSymbolicLink()) throw new Error('config symlink forbidden');
  validateStagingConfig(JSON.parse(readFileSync(file, 'utf8')),bootstrap ? 'bootstrap' : 'sealed');
  const command = bootstrap ? ['deploy','--dry-run','--outdir','.wrangler/staging-bootstrap-dist'] : allowed[args[0]!]!;
  return {args:[...command, '--env', ENV, '--config', config], env:{PATH:'/usr/bin:/bin', WRANGLER_SEND_METRICS:'false', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV:'false', CLOUDFLARE_INCLUDE_PROCESS_ENV:'false'}};
}

type PrivateLauncher = (command:string,args:string[],options:import('node:child_process').SpawnSyncOptionsWithStringEncoding)=>{status:number|null;stdout?:string};
// Import-only test seam; not a CLI, runtime or environment selector.
export function runPrivateBirthPackaging(args:string[],ambient:NodeJS.ProcessEnv=process.env,launch:PrivateLauncher=(command,argv,options)=>spawnSync(command,argv,options)) {
  if (args[2] !== PRIVATE_CONFIG) throw new Error('Private caller config required');
  const plan=releasePlan(args,ambient);
  const output=`.wrangler/staging-private-birth-dist/${randomUUID()}`;
  if (spawnSync('/usr/bin/git',['check-ignore','--quiet','--',output],{cwd:ROOT,env:{PATH:'/usr/bin:/bin'},timeout:10000}).status!==0) throw new Error('Output must be Git ignored');
  if (JSON.parse(readFileSync(resolve(ROOT,'node_modules/wrangler/package.json'),'utf8')).version!=='4.149.0') throw new Error('Pinned Wrangler required');
  const home=mkdtempSync(resolve(tmpdir(),'apacely-private-birth-cli-'));
  const env:NodeJS.ProcessEnv={...plan.env,HOME:home,XDG_CONFIG_HOME:home,MINIFLARE_ASSERT_BODIES_CONSUMED:'true',GOMAXPROCS:'1'};
  try {
    const node22='/root/apacely-toolchain/node-v22.23.3-linux-x64/bin/node';
    const version=launch(node22,['--version'],{env,encoding:'utf8',timeout:10000});
    if(version.status!==0||version.stdout?.trim()!=='v22.23.3') throw new Error('Pinned Node required');
    mkdirSync(dirname(resolve(ROOT,output)),{recursive:true,mode:0o700});
    mkdirSync(resolve(ROOT,output),{mode:0o700});
    const argv=[...plan.args];argv[argv.indexOf('--outdir')+1]=output;
    const result=launch(node22,['--import',resolve(ROOT,'tests/d1/loopback-guard.mjs'),resolve(ROOT,'node_modules/wrangler/bin/wrangler.js'),...argv],{cwd:ROOT,env,encoding:'utf8',stdio:'inherit',timeout:120000});
    const files:{path:string;sha256:string}[]=[];
    if(result.status===0){
      assertQualificationWorkspace();
      const names=readdirSync(resolve(ROOT,output)).sort();
      if(!names.some(name=>name.endsWith('.js'))) throw new Error('Missing useful generated bundle');
      for(const name of names){
        const path=resolve(ROOT,output,name);
        if(!lstatSync(path).isFile()) throw new Error('Generated artifact must be regular');
        const bytes=readFileSync(path);if(!bytes.length) throw new Error('Empty generated artifact');
        files.push({path:`${output}/${name}`,sha256:createHash('sha256').update(bytes).digest('hex')});
      }
    }
    return {status:result.status??1,output,files};
  } finally {rmSync(home,{recursive:true,force:true});}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[4] === PRIVATE_CONFIG) {
      const result=runPrivateBirthPackaging(process.argv.slice(2));
      console.log(JSON.stringify(result));process.exitCode=result.status;
    } else {
    const plan = releasePlan(process.argv.slice(2));
    const home = mkdtempSync(resolve(tmpdir(),'apacely-offline-cli-'));
    plan.env.HOME = home; plan.env.XDG_CONFIG_HOME = home;
    const node22 = '/root/apacely-toolchain/node-v22.23.3-linux-x64/bin/node';
    const version = spawnSync(node22,['--version'],{env:plan.env,encoding:'utf8'});
    if (version.status !== 0 || version.stdout.trim() !== 'v22.23.3') throw new Error('pinned local Node 22 toolchain is unavailable');
    if (JSON.parse(readFileSync(resolve(ROOT,'node_modules/wrangler/package.json'),'utf8')).version !== '4.149.0') throw new Error('pinned Wrangler unavailable');
    const cli=['--import',resolve(ROOT,'tests/d1/loopback-guard.mjs'),resolve(ROOT,'node_modules/wrangler/bin/wrangler.js')];
    if (process.argv[2] === 'migration-apply') {
      const directory=resolve(ROOT,'.wrangler/staging-local/v3/d1/miniflare-D1DatabaseObject');
      const inspect=async()=>{
      if (lstatSync(directory).isSymbolicLink()) throw new Error('Persistence redirect');
      const files=readdirSync(directory).filter(name=>/^[a-f0-9]{64}\.sqlite$/.test(name));
      if (files.length !== 1) throw new Error('Ambiguous physical database');
      const physical=resolve(directory,files[0]!);
      if (lstatSync(physical).isSymbolicLink()) throw new Error('Physical database redirect');
      const sqliteModule:string='node:sqlite'; // Node22-only CLI; preserve root Node20 typings.
      const {DatabaseSync}=await import(sqliteModule);
      const db=new DatabaseSync(physical,{readOnly:true});
      try {
        const plain=(row:Record<string,unknown>)=>({...row});
        const snapshot={objects:db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name='_cf_METADATA' OR tbl_name='_cf_METADATA' ORDER BY name").all().map(plain),columns:db.prepare("PRAGMA table_info('_cf_METADATA')").all().map(plain),rows:db.prepare('SELECT key,value,typeof(key) AS key_type,typeof(value) AS value_type FROM _cf_METADATA ORDER BY key').all().map(plain),indexes:db.prepare("PRAGMA index_list('_cf_METADATA')").all().map(plain)};
        validatePhysicalInternalMetadata(snapshot);
      } finally {db.close();}
      };
      // Reject existing forged internals before even a read CLI can advance bookmarks.
      if (existsSync(directory)) await inspect();
      const listed=spawnSync(node22,[...cli,...releasePlan(['migration-status-local','--config',CONFIG,'--env',ENV],{}).args],{cwd:ROOT,env:plan.env,stdio:'inherit',timeout:120000});
      if (listed.status !== 0) throw new Error('Metadata initialization failed');
      await inspect();
    }
    const result = spawnSync(node22,[...cli,...plan.args],{cwd:ROOT,env:plan.env,stdio:'inherit',timeout:120000});
    process.exitCode = result.status ?? 1;
    }
  } catch { console.error('Offline staging command refused or failed; no remote mode is available.'); process.exitCode = 1; }
}
