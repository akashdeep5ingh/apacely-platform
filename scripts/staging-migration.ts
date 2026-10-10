import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stagingMigrationStatements } from '../src/staging-migrations.js';
import { releasePlan } from './staging-release.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = 'migrations/staging/0001_staging.sql';
/** Output-only generator/checker: never opens a DB or launches Wrangler. */
export function migrationPlan(args:string[], ambient:NodeJS.ProcessEnv=process.env):{action:'generate'|'check';path:string;sql:string} {
 if(args.length!==7 || (args[0]!=='generate' && args[0]!=='check') || args[5]!=='--mode' || args[6]!=='wrangler-4.149.0-initial')throw new Error('Explicit versioned staging migration arguments required');
 // Reuse the exact config/environment/credential guard, not the subprocess runner.
 releasePlan(['migration-status-local',...args.slice(1,5)],ambient);
 const target=resolve(ROOT,FILE);
 if(existsSync(target)&&lstatSync(target).isSymbolicLink())throw new Error('Migration symlink forbidden');
 const directory=dirname(target);
 if(existsSync(directory)&&readdirSync(directory).some(name=>name!=='0001_staging.sql'))throw new Error('Unexpected staging migration inventory');
 return {action:args[0],path:FILE,sql:stagingMigrationStatements(args[6]).join('\n')+'\n'};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const plan=migrationPlan(process.argv.slice(2));const target=resolve(ROOT,plan.path);
  if(plan.action==='check'){
   if(readFileSync(target,'utf8')!==plan.sql)throw new Error('Generated migration drift');
   process.stdout.write('Deterministic staging migration matches canonical schema. Runtime qualification is separate.\n');
  }else{
   mkdirSync(dirname(target),{recursive:true});writeFileSync(target,plan.sql,{mode:0o644});
   process.stdout.write('Generated initial staging migration; no database or provider was accessed.\n');
  }
 }catch{process.stderr.write('Offline staging migration generation refused or failed.\n');process.exitCode=1;}
}
