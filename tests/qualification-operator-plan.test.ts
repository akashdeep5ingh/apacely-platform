import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as operator from '../scripts/qualification-operator-plan.js';

test('operator exposes only a fixed offline planner, never a remote executor', () => {
 assert.equal(typeof operator.operatorPlan, 'function');
 const plan = operator.operatorPlan(['plan', '--offline']);
 assert.equal(plan.remoteExecution, 'unavailable');
 assert.equal(plan.remoteReady, false);
 assert.equal(plan.status, 'STOP');
 assert.deepEqual(plan.approvalClasses, ['resource-closed-deployment', 'access-routing', 'fault-restore']);
 for (const args of [[], ['plan'], ['plan','--remote'], ['plan','--offline','--yes'], ['plan','--offline','>','out'], ['deploy','--offline']]) assert.throws(() => operator.operatorPlan(args));
});

const hash = 'a'.repeat(64);
function packet() {
 return {environment:'staging', accountId:'1'.repeat(32), databaseId:'11111111-1111-4111-8111-111111111111', databaseName:'apacely-staging', workerName:'apacely-ingress-staging', namespaceId:'2'.repeat(32), coordinatorName:'distributed-admission-v1', configPath:'wrangler.staging.jsonc', artifacts:{config:hash,migration:hash,bootstrap:hash,sealed:hash,source:hash}, approvals:{'resource-closed-deployment':'approval-resource-001','access-routing':'approval-access-001','fault-restore':'approval-fault-001'}};
}
test('target packet is exact, bounded, nonsecret and binds each distinct approval class to its digest', () => {
 assert.equal(typeof operator.validateOperatorPacket, 'function');
 const validated = operator.validateOperatorPacket(packet());
 assert.equal(validated.remoteReady, false);
 assert.match(validated.packetHash, /^[a-f0-9]{64}$/);
 assert.equal(Object.isFrozen(validated.targets), true);
 assert.notEqual(operator.validateOperatorPacket({...packet(),namespaceId:'3'.repeat(32)}).packetHash, validated.packetHash);
 const bad = [
 {...packet(),environment:'production'}, {...packet(),accountId:'0'.repeat(32)}, {...packet(),namespaceId:'*'},
 {...packet(),databaseId:'00000000-0000-4000-8000-000000000000'}, {...packet(),configPath:'../real.json'},
 {...packet(),workerName:'production'}, {...packet(),secret:'value'}, {...packet(),flags:['--yes']},
 {...packet(),artifacts:{...packet().artifacts,sealed:'ABC'}},
 {...packet(),approvals:{...packet().approvals,'fault-restore':'approval-resource-001'}},
 {...packet(),approvals:{...packet().approvals,'fault-restore':'https://approval.invalid'}},
 ];
 for (const input of bad) assert.throws(() => operator.validateOperatorPacket(input));
 const accessor = packet(); Object.defineProperty(accessor,'accountId',{get:()=> '1'.repeat(32)});
 assert.throws(() => operator.validateOperatorPacket(accessor));
});

test('scenario manifests are immutable build-time descriptions, not runtime executors or request controls', () => {
 assert.equal(typeof operator.scenarioManifest, 'function');
 const p = operator.validateOperatorPacket(packet());
 const input = {scenario:'S24',variant:'four-attempts',packetHash:p.packetHash,buildHash:hash,originalDatabaseId:packet().databaseId,statementCount:0,failureAfterStatement:0};
 const m = operator.scenarioManifest(input, p);
 assert.equal(m.maxAttempts,4); assert.equal(m.executor,'ABSENT'); assert.equal(m.remoteReady,false);
 assert.equal(Object.isFrozen(m),true); assert.equal(Object.isFrozen(m.instrumentation),true);
 assert.equal(operator.scenarioManifest({...input,variant:'zero-retries'},p).maxAttempts,1);
 for (let n=12;n<=35;n++) {
  const id=`S${n}`;
  const variants=operator.scenarioCatalogue[id as keyof typeof operator.scenarioCatalogue];
  assert.ok(variants.length>0);
  for(const variant of variants) assert.equal(operator.scenarioManifest({...input,scenario:id,variant,statementCount:id==='S18'?18:0,failureAfterStatement:id==='S18'?18:0},p).executor,'ABSENT');
 }
 for(const patch of [{scenario:'S36'},{variant:'request-header'},{packetHash:'b'.repeat(64)},{originalDatabaseId:'22222222-2222-4222-8222-222222222222'},{buildHash:'*'},{clock:0},{tier:'privileged'},{maxAttempts:100}]) assert.throws(()=>operator.scenarioManifest({...input,...patch},p));
 for (const index of [0,19,-1,NaN]) assert.throws(()=>operator.scenarioManifest({...input,scenario:'S18',variant:'statement-rollback',statementCount:18,failureAfterStatement:index},p));
 const original={}; operator.assertOriginalDatabaseIdentity(original,[original,original,original]);
 assert.throws(()=>operator.assertOriginalDatabaseIdentity(original,[original,{},original]));
 assert.throws(()=>operator.assertOriginalDatabaseIdentity(original,[original]));
});

test('artifact verification hashes supplied bytes only and cannot read paths, redirect files or authorize a deployment', () => {
 assert.equal(typeof operator.verifyArtifactBytes,'function');
 const bytes={config:'closed-placeholder-config',migration:'canonical-migration',bootstrap:'bootstrap-build',sealed:'sealed-build',source:'frozen-source-manifest'};
 const artifacts=Object.fromEntries(Object.entries(bytes).map(([k,v])=>[k,createHash('sha256').update(v).digest('hex')]));
 const p=operator.validateOperatorPacket({...packet(),artifacts});
 assert.equal(operator.verifyArtifactBytes(p,bytes).comparison,'MATCH');
 assert.equal(operator.verifyArtifactBytes(p,bytes).remoteReady,false);
 assert.throws(()=>operator.verifyArtifactBytes(p,{...bytes,sealed:'changed'}));
 assert.throws(()=>operator.verifyArtifactBytes(p,{...bytes,file:'../artifact'}));
 assert.throws(()=>operator.verifyArtifactBytes({...p},bytes));
 const scenario={scenario:'S24',variant:'four-attempts',packetHash:p.packetHash,buildHash:hash,originalDatabaseId:packet().databaseId,statementCount:0,failureAfterStatement:0};
 assert.throws(()=>operator.scenarioManifest(scenario,{...p}));
 assert.throws(()=>operator.assertOriginalDatabaseIdentity({getBookmark(){}},[]));
});
