import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {observationPlan, prepareObservationPacket} from '../src/remote-d1-observation.js';
import {validateOperatorPacket, verifyArtifactBytes, scenarioCatalogue} from '../scripts/qualification-operator-plan.js';
const read = (p: string) => readFileSync(new URL('../'+p, import.meta.url), 'utf8');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const rows = (s: string) => s.split('\n').filter(l => /^\| S\d{2} \|/.test(l)).map(l => l.split('|').slice(1,-1).map(c => c.trim()));
test('acceptance register preserves every normative input and oracle, including all subcases', () => {
 const normative = rows(read('docs/implementation/staging-readiness.md'));
 const matrix = read('docs/implementation/qualification-acceptance-matrix.md');
 const [axes, register] = matrix.split('## Complete normative subcase register');
 assert.equal(normative.length,37);
 assert.deepEqual(normative.map(r=>r[0]),Array.from({length:37},(_,i)=>`S${String(i+1).padStart(2,'0')}`));
 assert.deepEqual(rows(axes!).map(r=>r[0]),normative.map(r=>r[0]));
 assert.ok(register,'missing complete normative subcase register');
 assert.deepEqual(rows(register),normative);
 assert.ok(rows(axes!).every(r=>r[3]?.startsWith('NOT RUN')));
 for(const id of Object.keys(scenarioCatalogue)) assert.ok(normative.some(r=>r[0]===id));
});
test('pre-ledger catalogue is exact and target remains uncreated and unapproved', () => {
 const p = observationPlan(['plan','--offline']);
 assert.deepEqual(p.queries.map(q=>[q.id,q.sql]),[
  ['inventory','SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name'],
  ['table-list','PRAGMA table_list'], ['metadata-columns',"PRAGMA table_xinfo('_cf_METADATA')"],
  ['metadata-indexes',"PRAGMA index_list('_cf_METADATA')"],
  ['metadata-bookmark','SELECT key,value,typeof(key) AS key_type,typeof(value) AS value_type FROM _cf_METADATA ORDER BY key'],
  ['fk-check','PRAGMA foreign_key_check'], ['quick-check','PRAGMA quick_check']]);
 assert.equal(p.catalogueHash,sha(JSON.stringify(p.queries)));
 assert.equal(p.target.databaseId,null); assert.equal(p.approval,null);
 assert.equal(p.remoteExecution,'unavailable'); assert.equal(p.status,'STOP');
 for(const extra of ['--remote','--file','--config',';','--env']) assert.throws(()=>observationPlan(['plan','--offline',extra]));
});
test('strict observation packet accepts actual supplied bytes, not authority or target selectors', () => {
 const bytes={config:read('wrangler.staging.jsonc'),migration:read('migrations/staging/0001_staging.sql'),source:read('src/remote-d1-observation.ts'),wrangler:read('node_modules/wrangler/wrangler-dist/cli.js')};
 const p=prepareObservationPacket(bytes);
 for(const k of Object.keys(bytes) as (keyof typeof bytes)[]) assert.equal(p.artifacts[k],sha(bytes[k]));
 for(const key of ['databaseId','approval','executor']) assert.throws(()=>prepareObservationPacket({...bytes,[key]:'claimed'}));
 let called=0; assert.throws(()=>prepareObservationPacket({...bytes,get source(){called++;return bytes.source;}}));
 assert.equal(called,0); assert.equal(p.target.databaseId,null); assert.equal(p.remoteReady,false);
});
test('synthetic formatted operator target and approval references never certify config binding', () => {
 const bytes={config:'synthetic config not a physical target',migration:'synthetic',bootstrap:'synthetic',sealed:'synthetic',source:'synthetic'};
 const input={environment:'staging',accountId:'1'.repeat(32),namespaceId:'2'.repeat(32),databaseId:'11111111-1111-4111-8111-111111111111',databaseName:'apacely-staging',workerName:'apacely-ingress-staging',coordinatorName:'distributed-admission-v1',configPath:'wrangler.staging.jsonc',artifacts:Object.fromEntries(Object.entries(bytes).map(([k,v])=>[k,sha(v)])),approvals:{'resource-closed-deployment':'approval-synthetic-resource','access-routing':'approval-synthetic-access','fault-restore':'approval-synthetic-fault'}};
 const p=validateOperatorPacket(input); const result=verifyArtifactBytes(p,bytes);
 assert.equal(result.comparison,'MATCH'); assert.equal(result.status,'STOP');
 assert.equal(result.configTargetReadback,'NOT VERIFIED'); assert.equal(p.approvalAuthenticity,'NOT VERIFIED');
 assert.throws(()=>verifyArtifactBytes({...p},bytes));
 assert.throws(()=>validateOperatorPacket({...input,databaseId:'00000000-0000-4000-8000-000000000000'}));
 assert.throws(()=>verifyArtifactBytes(p,{...bytes,config:'different'}));
});
