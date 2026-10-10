import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Miniflare,convertV4MiniflareOptions} from '../../node_modules/wrangler/node_modules/miniflare/dist/src/index.js';
import {stagingMigrationStatements} from '../../src/staging-migrations.js';
import {validatePhysicalInternalMetadata} from '../../scripts/staging-release.js';
const ROOT='/root/apacely-staging-evidence/staging-tooling';
const metadata=`CREATE TABLE IF NOT EXISTS "d1_migrations"(
\t\tid         INTEGER PRIMARY KEY AUTOINCREMENT,
\t\tname       TEXT UNIQUE,
\t\tapplied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`;
const ledger=`INSERT INTO "d1_migrations" (name)\nvalues ('0001_staging.sql');`;
const statements=stagingMigrationStatements('wrangler-4.149.0-initial');
assert.equal(readFileSync('migrations/staging/0001_staging.sql','utf8'),statements.join('\n')+'\n');
async function harness(){
 const persist=mkdtempSync(ROOT+'/atomic-');
 const options=convertV4MiniflareOptions({host:'127.0.0.1',cf:false,workers:[{name:'migration-qualification',modules:true,script:'export default {}',compatibilityDate:'2025-07-18',compatibilityFlags:[],d1Databases:{DB:'00000000-0000-4000-8000-000000000000'},outboundService:()=>{throw Error('External network forbidden');}}]});
 const mf=new Miniflare({...options,resourcePersistencePath:persist});await mf.ready;
 return {mf,persist,db:await mf.getD1Database('DB')};
}
async function snapshot(db:any){
 const objects=(await db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name').all()).results;
 const rows:Record<string,unknown>={};
 for(const {name} of objects.filter((o:any)=>o.type==='table'&&o.name!=='_cf_METADATA'))rows[name]=(await db.prepare('SELECT * FROM "'+name+'"').all()).results;
 return {objects,rows};
}
async function internal(persist:string){
 const module:string='node:sqlite';const {DatabaseSync}=await import(module);
 const directory=persist+'/d1/miniflare-D1DatabaseObject';
 const files=readdirSync(directory).filter(n=>/^[a-f0-9]{64}\.sqlite$/.test(n));assert.equal(files.length,1);
 const db=new DatabaseSync(directory+'/'+files[0],{readOnly:true});const plain=(row:any)=>({...row});
 try{const result={objects:db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name='_cf_METADATA' OR tbl_name='_cf_METADATA' ORDER BY name").all().map(plain),columns:db.prepare("PRAGMA table_info('_cf_METADATA')").all().map(plain),rows:db.prepare('SELECT key,value,typeof(key) key_type,typeof(value) value_type FROM _cf_METADATA ORDER BY key').all().map(plain),indexes:db.prepare("PRAGMA index_list('_cf_METADATA')").all().map(plain)};validatePhysicalInternalMetadata(result);return result;}finally{db.close();}
}
test('actual pinned D1 atomic rollback covers every migration statement and runner ledger append',async()=>{
 const {mf,db,persist}=await harness();const evidence:any[]=[];
 try{
  await db.prepare(metadata).run();const before=await snapshot(db);await internal(persist);
  const submitted=[...statements,ledger];
  // Replace each submitted statement, then additionally fail AFTER ledger append.
  for(let position=0;position<=submitted.length;position++){
   const faulted=[...submitted];if(position===submitted.length)faulted.push('INSERT INTO apacely_missing_fault_table VALUES(1);');else faulted[position]='INSERT INTO apacely_missing_fault_table VALUES(1);';
   await assert.rejects(db.batch(faulted.map(sql=>db.prepare(sql))),/apacely_missing_fault_table/);
   const after=await snapshot(db);assert.deepEqual(after,before,'rollback at submitted statement '+position);
   const metadataSnapshot=await internal(persist);
   evidence.push({position,submitted:submitted.length,mode:position===submitted.length?'after-ledger':'replace-statement',snapshotHash:createHash('sha256').update(JSON.stringify(after)).digest('hex'),internal:metadataSnapshot});
  }
  const results=await db.batch(submitted.map(sql=>db.prepare(sql)));assert.equal(results.length,submitted.length);
  const successful=await snapshot(db);assert.deepEqual((await db.prepare('SELECT singleton,environment FROM database_environment').all()).results,[{singleton:1,environment:'staging'}]);
  assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
  await assert.rejects(db.batch(statements.map(sql=>db.prepare(sql))),/apacely_provision_empty/);
  assert.deepEqual(await snapshot(db),successful,'direct baseline reapply rolls back guard');
  for(const sql of ["UPDATE database_environment SET environment='development'",'DELETE FROM database_environment',"INSERT OR REPLACE INTO database_environment VALUES(1,'staging')"]){await assert.rejects(db.prepare(sql).run());assert.deepEqual(await snapshot(db),successful);}
  writeFileSync(ROOT+'/atomic-runtime-results.json',JSON.stringify({persist,statementCount:statements.length,submittedCount:submitted.length,cases:evidence,successful,directReapply:'denied',markerMutations:'denied'},null,2));
 }finally{await mf.dispose();}
});
test('actual pinned D1 refuses foreign, development and forged runner metadata without application writes',async()=>{
 const {mf,db,persist}=await harness();const results:any[]=[];
 try{
  for(const setup of [metadata+'CREATE TABLE foreign_data(value TEXT);',metadata+"CREATE TABLE database_environment(singleton INTEGER PRIMARY KEY,environment TEXT); INSERT INTO database_environment VALUES(1,'development');",metadata+'CREATE INDEX forged_metadata_index ON d1_migrations(name);',metadata+"INSERT INTO d1_migrations(name) VALUES('foreign.sql');",metadata+"INSERT INTO d1_migrations(name) VALUES('foreign.sql'); DELETE FROM d1_migrations;"]){
   // Reset application and runner metadata between cases in the sole local runtime.
   for(const {name,type} of (await snapshot(db)).objects.filter((o:any)=>!['_cf_METADATA','sqlite_sequence','sqlite_autoindex_d1_migrations_1'].includes(o.name)))if(type==='table')await db.prepare('DROP TABLE "'+name+'"').run();
   await db.prepare('DELETE FROM sqlite_sequence').run().catch(()=>{});
   await db.exec(setup.replaceAll('\n',' '));const before=await snapshot(db);
   await assert.rejects(db.batch(statements.map(sql=>db.prepare(sql))));assert.deepEqual(await snapshot(db),before);await internal(persist);results.push({setup,status:'denied-unchanged'});
  }
  writeFileSync(ROOT+'/negative-runtime-results.json',JSON.stringify({persist,results},null,2));
 }finally{await mf.dispose();}
});
