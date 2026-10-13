import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

async function localFixture() {
 const moduleName = 'node:sqlite';
 const {DatabaseSync} = await import(moduleName);
 const db = new DatabaseSync(':memory:');
 db.exec('CREATE TABLE _cf_METADATA(key INTEGER PRIMARY KEY,value BLOB); INSERT INTO _cf_METADATA VALUES(2,123);');
 const m = await api();
 const artifacts = Object.fromEntries(Object.entries({config:'wrangler.staging.jsonc', migration:'migrations/staging/0001_staging.sql', source:'src/remote-d1-observation.ts', wrangler:'node_modules/wrangler/wrangler-dist/cli.js'}).map(([k,p]) => [k,readFileSync(new URL('../'+p, import.meta.url),'utf8')]));
 const packet = m.prepareObservationPacket(artifacts);
 const results = Object.fromEntries(packet.queries.map((q: any) => [q.id, db.prepare(q.sql).all().map((r: any) => ({...r}))]));
 const evidence = {packetHash:packet.packetHash,catalogueHash:packet.catalogueHash,sourceHash:packet.artifacts.source,origin:'ordinary-local-sqlite',requestId:null,complete:true,results};
 return {m,db,packet,evidence};
}
test('actual ordinary SQLite fixed catalogue comparison matches but never certifies remote provenance', async () => {
 const m = await api();
 assert.equal(typeof m.prepareObservationPacket, 'function', 'packet preparation missing');
 assert.equal(typeof m.compareObservation, 'function', 'comparison missing');
 const {db,packet,evidence} = await localFixture();
 try {
  const result = m.compareObservation(packet,evidence,evidence);
  assert.equal(result.comparison,'MATCH');
  assert.equal(result.comparedQueries,7);
  assert.equal(result.status,'STOP');
  assert.equal(result.remoteReady,false);
  assert.equal(result.provenance,'UNVERIFIED');
  console.log('ACTUAL_LOCAL_SQLITE '+JSON.stringify({queries:packet.queries.length, results:evidence.results}));
 } finally { db.close(); }
});

test('incomplete, unreadable, forged and absent evidence stays UNKNOWN without invoking getters', async () => {
 const {m,db,packet,evidence} = await localFixture();
 try {
  const variants: any[] = [null, {...evidence,complete:false}, {...evidence,sourceHash:'0'.repeat(64)}, {...evidence,packetHash:'0'.repeat(64)}, {...evidence,origin:'authenticated-cloudflare'}, {...evidence,results:{}}];
  variants.push({...evidence,results:{...evidence.results,'metadata-bookmark':[]}});
  variants.push({...evidence,results:{...evidence.results,'metadata-bookmark':{error:'unauthorized'}}});
  variants.push({...evidence,results:{...evidence.results,extra:[]}});
  let invoked = 0;
  variants.push({...evidence, get sourceHash() { invoked++; return packet.artifacts.source; }});
  for(const bad of variants) {
   assert.equal(m.compareObservation(packet,bad,bad).comparison,'UNKNOWN');
   assert.equal(m.compareObservation(packet,evidence,bad).status,'STOP');
  }
  assert.equal(invoked,0);
  assert.throws(() => m.compareObservation({...packet},evidence,evidence));
  assert.throws(() => m.prepareObservationPacket({config:'x',migration:'x',source:'x',wrangler:'x',extra:'x'}));
 } finally {db.close();}
});
test('actual schema drift and bookmark storage mismatch cannot be accepted even as caller expectations', async () => {
 const {m,db,packet,evidence} = await localFixture();
 try {
  db.exec('CREATE TABLE _cf_unrecognized(x TEXT);');
  const results = Object.fromEntries(packet.queries.map((q: any) => [q.id,db.prepare(q.sql).all().map((r: any) => ({...r}))]));
  const changed = {...evidence,results};
  assert.equal(m.compareObservation(packet,evidence,changed).comparison,'MISMATCH');
  assert.equal(m.compareObservation(packet,changed,changed).comparison,'UNKNOWN');
  db.exec('DROP TABLE _cf_unrecognized; UPDATE _cf_METADATA SET value=CAST(123 AS BLOB);');
  const invalid = {...evidence,results:Object.fromEntries(packet.queries.map((q: any) => [q.id,db.prepare(q.sql).all().map((r: any) => ({...r}))]))};
  assert.equal(m.compareObservation(packet,invalid,invalid).comparison,'UNKNOWN');
 } finally {db.close();}
});
for (const [id,index] of [['metadata-columns',1],['table-list',2]] as const) {
 test(`sparse ${id} with compensating own property cannot falsely MATCH`, async () => {
  const {m,db,packet,evidence} = await localFixture();
  try {
   const rows = [...evidence.results[id]];
   delete rows[index];
   Object.defineProperty(rows,'unexpected',{value:'padding',enumerable:true});
   const bad = {...evidence,results:{...evidence.results,[id]:rows}};
   const result = m.compareObservation(packet,bad,bad);
   console.log('IR1_REPRO '+JSON.stringify({id,...result}));
   assert.equal(result.comparison,'UNKNOWN');
   assert.equal(result.comparedQueries,0);
   assert.equal(result.status,'STOP');
   assert.equal(result.remoteReady,false);
  } finally {db.close();}
 });
}
for (const variant of ['extra-symbol','noncanonical-numeric-key','accessor-index'] as const) {
 test(`metadata rows reject ${variant} without invoking getters`, async () => {
  const {m,db,packet,evidence} = await localFixture();
  try {
   const rows = [...evidence.results['metadata-columns']];
   let getterCalls = 0;
   if (variant === 'extra-symbol') Object.defineProperty(rows,Symbol('unexpected'),{value:'padding'});
   if (variant === 'noncanonical-numeric-key') {
    delete rows[1];
    Object.defineProperty(rows,'01',{value:'padding'});
   }
   if (variant === 'accessor-index') Object.defineProperty(rows,'1',{get() {getterCalls++; return evidence.results['metadata-columns'][1];}});
   const bad = {...evidence,results:{...evidence.results,'metadata-columns':rows}};
   for (const [expected,observed] of [[bad,bad],[evidence,bad],[bad,evidence]]) {
    const result = m.compareObservation(packet,expected,observed);
    assert.equal(result.comparison,'UNKNOWN');
    assert.equal(result.comparedQueries,0);
    assert.equal(result.status,'STOP');
    assert.equal(result.remoteReady,false);
   }
   assert.equal(getterCalls,0);
  } finally {db.close();}
 });
}
test('CLI module exposes only the same fixed offline planner', async () => {
 let cli: any;
 try { cli = await import('../scripts/remote-d1-observation.js'); } catch (error: any) { if(error.code !== 'ERR_MODULE_NOT_FOUND') throw error; cli={}; }
 assert.equal(typeof cli.observationPlan,'function','offline CLI missing');
 assert.deepEqual(cli.observationPlan(['plan','--offline']), (await api()).observationPlan(['plan','--offline']));
});
async function api(): Promise<any> {
 try { return await import('../src/remote-d1-observation.js'); } catch (error: any) {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
 }
}
test('fixed future-target plan cannot invent physical identity or grant approval', async () => {
 const m = await api();
 assert.equal(typeof m.observationPlan, 'function', 'observationPlan is missing');
 const p = m.observationPlan(['plan', '--offline']);
 assert.equal(p.target.databaseId, null);
 assert.equal(p.target.accountId, 'dfd3d98054e547f897606de8c8ebac92');
 assert.equal(p.target.databaseName, 'apacely-staging');
 assert.equal(p.remoteReady, false);
 assert.equal(p.status, 'STOP');
 assert.equal(p.approval, null);
 assert.ok(p.queries.every((q: any) => /^(SELECT|PRAGMA)/.test(q.sql)));
 assert.throws(() => m.observationPlan(['plan', '--offline', '--remote']));
});
