import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import Database from 'better-sqlite3';
import {environmentStatements} from '../scripts/environment-schema.js';
import {validatePhysicalInternalMetadata} from '../scripts/staging-release.js';

const internalMetadata='CREATE TABLE _cf_METADATA (\n        key INTEGER PRIMARY KEY,\n        value BLOB\n      ); INSERT INTO _cf_METADATA VALUES(2,1);';
const ledgerMetadata = `CREATE TABLE IF NOT EXISTS "d1_migrations"(
\t\tid         INTEGER PRIMARY KEY AUTOINCREMENT,
\t\tname       TEXT UNIQUE,
\t\tapplied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`;
const metadata=ledgerMetadata+internalMetadata;
async function migration():Promise<string[]> {
 assert.ok(existsSync(new URL('../src/staging-migrations.ts',import.meta.url)), 'explicit versioned staging generator missing');
 const module = await import('../src/staging-migrations.js');
 return module.stagingMigrationStatements('wrangler-4.149.0-initial');
}
function apply(db:Database.Database, statements:string[]):void {
 if(statements.some(sql=>sql.includes('_cf_METADATA')))validatePhysicalInternalMetadata({objects:db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name='_cf_METADATA' OR tbl_name='_cf_METADATA' ORDER BY name").all(),columns:db.prepare("PRAGMA table_info('_cf_METADATA')").all(),rows:db.prepare('SELECT key,value,typeof(key) AS key_type,typeof(value) AS value_type FROM _cf_METADATA ORDER BY key').all(),indexes:db.prepare("PRAGMA index_list('_cf_METADATA')").all()});
 db.transaction(()=>{for(const sql of statements)db.exec(sql);})();
}
function objects(db:Database.Database):unknown {return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT IN ('d1_migrations','sqlite_sequence','sqlite_autoindex_d1_migrations_1') ORDER BY name").all();}
test('pinned D1 internal metadata accepts only observed physical schema and integer row',async()=>{
 const statements=await migration();
 const observed=internalMetadata;
 const valid=new Database(':memory:');try{valid.exec(ledgerMetadata+observed);apply(valid,statements);}finally{valid.close();}
 for(const internal of [observed.replace('BLOB','TEXT'),observed.replace('(2,1)','(2,-1)'),observed.replace('(2,1)',"(2,'1')"),observed+'INSERT INTO _cf_METADATA VALUES(3,1);',observed+'CREATE INDEX forged_internal ON _cf_METADATA(value);']){
  const db=new Database(':memory:');try{db.exec(ledgerMetadata+internal);const before=db.serialize();assert.throws(()=>apply(db,statements));assert.deepEqual(db.serialize(),before);}finally{db.close();}
 }
});
test('versioned mode rejects absent, forged, nonempty and historically reused metadata without writes',async()=>{
 const statements=await migration();
 const setups=[
  '', ledgerMetadata,
  'CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);',
  metadata+"INSERT INTO d1_migrations(name) VALUES ('0001_staging.sql');",
  metadata+"INSERT INTO d1_migrations(name) VALUES ('foreign.sql'); DELETE FROM d1_migrations;",
  metadata+'CREATE INDEX forged_metadata_index ON d1_migrations(name);',
  metadata+'CREATE TRIGGER forged_metadata_trigger AFTER INSERT ON d1_migrations BEGIN SELECT 1; END;',
  metadata+'CREATE TABLE unrelated(id INTEGER);',
  metadata+'CREATE VIEW foreign_view AS SELECT 1;',
  metadata+"CREATE TABLE _cf_forged(id INTEGER);",
  metadata+'CREATE TABLE sqlite_ignored(id INTEGER);'
 ];
 for(const setup of setups){const db=new Database(':memory:');try{
  // SQLite itself forbids attacker-created sqlite_* names; every other case reaches the guard.
  if(setup.includes('sqlite_ignored')){assert.throws(()=>db.exec(setup));continue;}
  db.exec(setup);const before=db.serialize();assert.throws(()=>apply(db,statements),setup);assert.deepEqual(db.serialize(),before);
 }finally{db.close();}}
 const module=await import('../src/staging-migrations.js');
 for(const mode of [undefined,'staging','initial','wrangler-4.149.1-initial'])assert.throws(()=>module.stagingMigrationStatements(mode));
});
test('every submitted statement fault rolls back all application schema while preserving initial metadata',async()=>{
 const statements=await migration();
 for(let i=0;i<=statements.length;i++){const db=new Database(':memory:');try{db.exec(metadata);const before=db.serialize();const faulted=[...statements.slice(0,i),'SELECT * FROM apacely_missing_fault_table;',...statements.slice(i)];assert.throws(()=>apply(db,faulted),'position '+i);assert.deepEqual(db.serialize(),before,'position '+i);}finally{db.close();}}
});
test('physical staging marker is immutable and every tenant-scoped foreign key is canonical',async()=>{
 const statements=await migration();const db=new Database(':memory:');const reference=new Database(':memory:');try{
 db.exec('PRAGMA foreign_keys=ON;'+metadata);reference.exec('PRAGMA foreign_keys=ON');apply(db,statements);apply(reference,environmentStatements('staging'));reference.exec(internalMetadata);
 for(const sql of ["UPDATE database_environment SET environment='development'","DELETE FROM database_environment","INSERT OR REPLACE INTO database_environment VALUES(1,'staging')"])assert.throws(()=>db.exec(sql));
 for(const {name} of reference.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all() as {name:string}[])assert.deepEqual(db.prepare(`PRAGMA foreign_key_list("${name}")`).all(),reference.prepare(`PRAGMA foreign_key_list("${name}")`).all(),name);
 assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{db.close();reference.close();}
});
test('migration generation CLI uses only explicit fixed config, environment and versioned mode',async()=>{
 assert.ok(existsSync(new URL('../scripts/staging-migration.ts',import.meta.url)),'offline migration CLI missing');
 const module=await import('../scripts/staging-migration.js');
 const args=['generate','--config','wrangler.staging.jsonc','--env','staging','--mode','wrangler-4.149.0-initial'];
 const plan=module.migrationPlan(args,{});assert.equal(plan.sql,(await migration()).join('\n')+'\n');assert.equal(plan.path,'migrations/staging/0001_staging.sql');
 for(const bad of [[],args.slice(0,5),[...args,'--remote'],args.map(x=>x==='staging'?'production':x),args.map(x=>x==='wrangler.staging.jsonc'?'wrangler.jsonc':x)])assert.throws(()=>module.migrationPlan(bad,{}));
 assert.throws(()=>module.migrationPlan(args,{CLOUDFLARE_API_TOKEN:'inert'}));
});

test('explicit pinned metadata mode preserves complete canonical staging schema and empty fixture tables',async()=>{
 const statements=await migration();const versioned=new Database(':memory:');const strict=new Database(':memory:');
 try {
 versioned.exec(metadata); apply(versioned,statements); apply(strict,environmentStatements('staging'));strict.exec(internalMetadata);
 assert.deepEqual(objects(versioned),objects(strict));
 assert.deepEqual(versioned.prepare('SELECT * FROM database_environment').all(),[{singleton:1,environment:'staging'}]);
 for(const {name} of versioned.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT IN ('sqlite_sequence','database_environment','_cf_METADATA')").all() as {name:string}[])assert.equal((versioned.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as {n:number}).n,0,name);
 assert.deepEqual(versioned.prepare('SELECT key,value,typeof(value) AS value_type FROM _cf_METADATA').all(),[{key:2,value:1,value_type:'integer'}]);
 assert.throws(()=>apply(versioned,statements));
 assert.throws(()=>apply(strict,environmentStatements('staging')));
 assert.equal(readFileSync('migrations/staging/0001_staging.sql','utf8'),statements.join('\n')+'\n');
 }finally{versioned.close();strict.close();}
});
