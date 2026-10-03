import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {businessTables} from '../src/repository.js';
import {uuidV4} from '../src/contracts.js';
test('compiled build includes local schema and its CLI runs offline',()=>{
 const dir=mkdtempSync(join(tmpdir(),'apacely-built-test-'));try {
 const build=spawnSync(process.platform==='win32'?'npm.cmd':'npm',['run','build'],{encoding:'utf8'});assert.equal(build.status,0,build.stdout+build.stderr);
 const child=spawnSync(process.execPath,['--import','./tests/network-guard.mjs','dist/src/cli.js','--db',join(dir,'demo.sqlite')],{encoding:'utf8'});
 assert.equal(child.status,0,child.stderr);assert.equal(JSON.parse(child.stdout).durable_verified,true);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('CLI succeeds offline with generated fixture tenants, a durable accepted event and one receipt',()=>{
 const dir=mkdtempSync(join(tmpdir(),'apacely-cli-test-')),path=join(dir,'demo.sqlite');
 try {
 const child=spawnSync(process.execPath,['--import','tsx','--import','./tests/network-guard.mjs','src/cli.ts','--db',path],{encoding:'utf8',env:{PATH:process.env.PATH,NODE_ENV:'test'}});
 assert.equal(child.status,0,child.stderr);assert.equal(child.stderr,'');
 const result=JSON.parse(child.stdout);
 assert.equal(result.mock_only,true);assert.equal(result.database,path);assert.equal(result.durable_verified,true);assert.equal(result.receipts.length,1);assert.equal(result.outcome.qualification.status,'handoff_ready');assert.equal(result.outcome.action.action_type,'request_handoff');
 assert.ok(uuidV4.test(result.tenants[0].id));assert.ok(uuidV4.test(result.tenants[1].id));assert.notEqual(result.tenants[0].id,result.tenants[1].id);
 const db=new Database(path);try {
 assert.equal((db.prepare('SELECT count(*) AS n FROM tenants').get() as {n:number}).n,2);
 for(const table of businessTables) {
 assert.equal((db.prepare(`SELECT count(*) AS n FROM ${table} WHERE tenant_id=?`).get(result.tenants[0].id) as {n:number}).n,1);
 assert.equal((db.prepare(`SELECT count(*) AS n FROM ${table} WHERE tenant_id=?`).get(result.tenants[1].id) as {n:number}).n,0);
 }
 assert.deepEqual(db.prepare('SELECT status,attempts FROM action_outbox').get(),{status:'recorded',attempts:1});
 assert.deepEqual(db.pragma('foreign_key_check'),[]);
 }finally{db.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});
