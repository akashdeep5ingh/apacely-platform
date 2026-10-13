import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {environmentStatements} from '../scripts/environment-schema.js';
import * as d1 from '../scripts/qualification-d1-manifest.js';

test('D1 catalogue is fixed, read-only, complete and executable against canonical staging SQLite', () => {
 assert.equal(typeof d1.d1Manifest,'function');
 const manifest=d1.d1Manifest(['manifest','--offline']);
 assert.equal(manifest.remoteReady,false); assert.equal(manifest.remoteExecution,'unavailable');
 assert.equal(Object.isFrozen(manifest.queries),true);
 const db=new Database(':memory:');
 try {
  for(const sql of environmentStatements('staging')) db.exec(sql);
  db.exec('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)');
  const names=db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name!='sqlite_sequence' AND name!='d1_migrations' ORDER BY name").all().map((r:any)=>r.name);
  assert.deepEqual([...d1.applicationTables].sort(),names);
  const indexes=db.prepare("SELECT name FROM sqlite_schema WHERE type='index' ORDER BY name").all().map((r:any)=>r.name);
  assert.deepEqual([...d1.applicationIndexes,'sqlite_autoindex_d1_migrations_1'].sort(),indexes);
  for(const query of manifest.queries) {
   assert.match(query.sql,/^(SELECT |PRAGMA )/);
   assert.doesNotMatch(query.sql,/\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|ATTACH|VACUUM|REPLACE|optimize)\b/i);
   db.prepare(query.sql).all();
   assert.equal(Object.isFrozen(query),true);
  }
  for(const name of names) for(const kind of ['columns','fk','indexes','count']) assert.ok(manifest.queries.some(q=>q.id===`${kind}:${name}`));
  for(const args of [[],['manifest','--remote'],['manifest','--offline','--command','DROP TABLE tenants'],['manifest','--offline','--file','evil.sql']]) assert.throws(()=>d1.d1Manifest(args));
 } finally {db.close();}
});

test('complete exact readback comparison never promotes local expectations or unknown remote metadata to readiness', () => {
 assert.equal(typeof d1.verifyD1Readback,'function');
 const manifest=d1.d1Manifest(['manifest','--offline']);
 const db=new Database(':memory:');
 try {
  for(const sql of environmentStatements('staging')) db.exec(sql);
  db.exec('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)');
  const rows=Object.fromEntries(manifest.queries.map(q=>[q.id,db.prepare(q.sql).all()]));
  const expectedHash=createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  const evidence={catalogueHash:manifest.catalogueHash,expectedHash,expected:rows,observed:structuredClone(rows)};
  const result=d1.verifyD1Readback(evidence);
  assert.equal(result.comparison,'MATCH'); assert.equal(result.status,'STOP'); assert.equal(result.remoteReady,false);
  assert.equal(result.remoteEquivalence,'UNPROVEN'); assert.equal(result.comparedQueries,manifest.queries.length);
  for(const change of [
   {...evidence,observed:{...rows,inventory:[...(rows.inventory as any[]),{type:'table',name:'_cf_UNKNOWN',tbl_name:'_cf_UNKNOWN',sql:'unknown'}]}},
   {...evidence,observed:{...rows,'fk-check':[{table:'events',rowid:1,parent:'leads',fkid:0}]}},
   {...evidence,observed:{...rows,history:[{id:1,name:'other.sql',applied_at:'unknown'}]}},
   {...evidence,observed:{...rows,environment:[{singleton:1,environment:'production'}]}},
  ]) assert.equal(d1.verifyD1Readback(change).comparison,'MISMATCH');
  for(const change of [{...evidence,expectedHash:'b'.repeat(64)}, {...evidence,catalogueHash:'b'.repeat(64)}, {...evidence,observed:{}}, {...evidence,observed:{...rows,extra:[]}}, {...evidence,remoteEquivalent:true}]) assert.throws(()=>d1.verifyD1Readback(change));
  const errorRows={...rows,inventory:[{error:'denied'}]};
  assert.throws(()=>d1.verifyD1Readback({...evidence,observed:errorRows}));
  let reads=0; const tricky:any[]=[];
  Object.defineProperty(tricky,'0',{enumerable:true,get(){reads++;return rows.inventory[0];}});
  assert.throws(()=>d1.verifyD1Readback({...evidence,observed:{...rows,inventory:tricky}}));
  assert.equal(reads,0);
 } finally {db.close();}
});
