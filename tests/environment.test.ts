import {test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {existsSync,readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Repository} from '../src/repository.js';
import {Processor,Registry} from '../src/process-inbound.js';
import {fixture} from '../src/fixture.js';
import {spawnSync} from 'node:child_process';

test('offline schema generator CLI requires one allowlisted environment and emits deterministic SQL only',async()=>{
 const {environmentSchema}=await import('../scripts/environment-schema.js');
 const run=(args:string[])=>spawnSync(process.execPath,['--import','tsx','scripts/environment-schema.ts',...args],{encoding:'utf8'});
 const stage=run(['staging']);assert.equal(stage.status,0);assert.equal(stage.stdout,environmentSchema('staging'));
 for(const args of [[],['production'],['staging','development']]){const denied=run(args);assert.notEqual(denied.status,0);assert.equal(denied.stdout,'');}
});

test('explicit SQLite staging opens only offline-provisioned staging and preserves processor environment',async()=>{
 const {environmentSchema}=await import('../scripts/environment-schema.js');
 const dir=mkdtempSync(join(tmpdir(),'environment-')),path=join(dir,'stage.db');
 const bootstrap=new Database(path);bootstrap.transaction(()=>bootstrap.exec(environmentSchema('staging')))();bootstrap.close();
 let repo:Repository|undefined;
 try{
  repo=new Repository(path,()=>new Date().toISOString(),undefined,'staging');
  const tenant=repo.createTenant('Synthetic stage'),scope={tenant_id:tenant.id,environment:'staging'} as const;
  const processor=new Processor(repo,new Registry([['source',tenant.id]],'staging'));
  const outcome=await processor.process({environment:'staging',source_binding:'source',operation:'ingest_mock_lead'},fixture);
  assert.equal(outcome.event.environment,'staging');assert.equal(outcome.action.environment,'staging');
  assert.equal(repo.scoped(scope).rows('action_outbox').length,1);
  assert.throws(()=>repo!.assertScope({...scope,environment:'development'}));
  assert.throws(()=>new Repository(path,()=>new Date().toISOString()));
  assert.throws(()=>new Repository(join(dir,'empty.db'),()=>new Date().toISOString(),undefined,'staging'));
 }finally{repo?.close();rmSync(dir,{recursive:true,force:true});}
});

test('offline provisioning rejects any nonempty database atomically instead of adopting unrelated tables',async()=>{
 const {environmentSchema}=await import('../scripts/environment-schema.js');const db=new Database(':memory:');
 try{db.exec('CREATE TABLE unrelated (id INTEGER);INSERT INTO unrelated VALUES (7)');const before=db.prepare('SELECT type,name,sql FROM sqlite_schema').all();assert.throws(()=>db.transaction(()=>db.exec(environmentSchema('staging')))(),/apacely_provision_empty/);assert.deepEqual(db.prepare('SELECT type,name,sql FROM sqlite_schema').all(),before);assert.deepEqual(db.prepare('SELECT * FROM unrelated').all(),[{id:7}]);}finally{db.close();}
});

test('trusted registry rejects ambiguous duplicate source bindings rather than choosing a tenant',()=>{
 const t1='f0000000-0000-4000-8000-000000000001',t2='f0000000-0000-4000-8000-000000000002';
 assert.throws(()=>new Registry([['source',t1],['source',t2]],'staging'));
});

test('offline staging generator derives the entire schema deterministically and refuses unsupported environments',async()=>{
 assert.ok(existsSync(new URL('../scripts/environment-schema.ts',import.meta.url)),'explicit offline schema generator required');
 const {environmentSchema}=await import('../scripts/environment-schema.js');
 const stage=environmentSchema('staging');
 assert.equal(environmentSchema('staging'),stage);
 assert.throws(()=>environmentSchema('production'));
 assert.throws(()=>environmentSchema(undefined));
 const dev=new Database(':memory:'),db=new Database(':memory:');
 try{
  dev.exec(readFileSync(new URL('../src/schema.sql',import.meta.url),'utf8'));
  db.transaction(()=>db.exec(stage))();
  assert.deepEqual(db.prepare('SELECT * FROM database_environment').all(),[{singleton:1,environment:'staging'}]);
  const manifest=(d:Database.Database)=>d.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name").all();
  assert.deepEqual(manifest(db),JSON.parse(JSON.stringify(manifest(dev)).replaceAll("'development'","'staging'").replaceAll(' IF NOT EXISTS','')));
  assert.throws(()=>db.transaction(()=>db.exec(stage))());
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{dev.close();db.close();}
});

test('canonical development schema seals the database environment against rewrite and replacement',()=>{
 const db=new Database(':memory:');
 try{
  db.exec(readFileSync(new URL('../src/schema.sql',import.meta.url),'utf8'));
  assert.deepEqual(db.prepare('SELECT * FROM database_environment').all(),[{singleton:1,environment:'development'}]);
  for(const sql of ["UPDATE database_environment SET environment='staging'","DELETE FROM database_environment","INSERT OR REPLACE INTO database_environment VALUES (1,'staging')"]){assert.throws(()=>db.exec(sql),/apacely_environment_immutable/);}
 }finally{db.close();}
});
