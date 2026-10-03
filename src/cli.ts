import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Repository,businessTables} from './repository.js';
import {Processor,Registry} from './process-inbound.js';
import {MockSink,drain} from './mock-outbox.js';
import {fixture} from './fixture.js';
const args=process.argv.slice(2);
if(args.length!==0&&(args.length!==2||args[0]!=='--db'||!args[1])) throw new Error('Usage: npm run demo -- [--db local.sqlite]');
const database=args.length?resolve(args[1]):join(mkdtempSync(join(tmpdir(),'apacely-demo-')),'development.sqlite');
const clock=()=> '2026-01-01T12:00:01.000Z';
const repo=new Repository(database,clock);
const tenants=[repo.createTenant('Apacely'),repo.createTenant('Synthetic Tenant')];
const scope={tenant_id:tenants[0].id,environment:'development'} as const;
let outcome,receipts;
try {
 const processor=new Processor(repo,new Registry([['mock-source-001',tenants[0].id],['mock-source-002',tenants[1].id]]));
 const ctx={environment:'development',source_binding:'mock-source-001',operation:'ingest_mock_lead'} as const;
 outcome=await processor.process(ctx,fixture);
 assert.deepEqual(await processor.process(ctx,fixture),outcome);
 const sink=new MockSink();drain(repo,scope,sink);assert.deepEqual(drain(repo,scope,sink),[]);receipts=sink.receipts;
 assert.equal(receipts.length,1);
} finally {repo.close();}
const reopened=new Repository(database,clock);
try {
 const counts=Object.fromEntries(businessTables.map(table=>[table,reopened.scoped(scope).rows(table).length]));
 const secondTenantCounts=Object.fromEntries(businessTables.map(table=>[table,reopened.scoped({tenant_id:tenants[1].id,environment:'development'}).rows(table).length]));
 assert.ok(Object.values(counts).every(n=>n===1));assert.ok(Object.values(secondTenantCounts).every(n=>n===0));
 assert.equal(reopened.scoped(scope).rows('action_outbox')[0].status,'recorded');
 assert.deepEqual(JSON.parse(String(reopened.scoped(scope).rows('events')[0].outcome_snapshot)),outcome);
 console.log(JSON.stringify({mock_only:true,database,tenants,outcome,receipts,counts,secondTenantCounts,durable_verified:true},null,2));
} finally {reopened.close();}
