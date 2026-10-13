import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
export const applicationTables = Object.freeze(['database_environment','tenants','source_mappings','replay_ledger','acceptance_assertions','authority_assertions','replay_assertions','leads','conversations','events','messages','qualification_state','action_outbox']);
export const applicationIndexes = Object.freeze(['replay_expiry',...Object.entries({tenants:1,source_mappings:2,replay_ledger:1,leads:3,conversations:4,events:5,messages:3,qualification_state:3,action_outbox:3}).flatMap(([table,n])=>Array.from({length:n},(_,i)=>`sqlite_autoindex_${table}_${i+1}`))]);
const queries = Object.freeze([
 {id:'inventory',sql:'SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name'},
 {id:'table-list',sql:'PRAGMA table_list'},
 {id:'fk-check',sql:'PRAGMA foreign_key_check'},
 {id:'quick-check',sql:'PRAGMA quick_check'},
 {id:'environment',sql:'SELECT singleton,environment FROM database_environment ORDER BY singleton'},
 {id:'history',sql:'SELECT id,name,applied_at FROM d1_migrations ORDER BY id'},
 {id:'history-sequence',sql:'SELECT name,seq FROM sqlite_sequence ORDER BY name'},
 ...[...applicationTables,'d1_migrations'].flatMap(table=>[
  {id:`columns:${table}`,sql:`PRAGMA table_xinfo('${table}')`},
  {id:`fk:${table}`,sql:`PRAGMA foreign_key_list('${table}')`},
  {id:`indexes:${table}`,sql:`PRAGMA index_list('${table}')`},
  {id:`count:${table}`,sql:`SELECT count(*) AS n FROM ${table}`}
 ]),
 ...[...applicationIndexes,'sqlite_autoindex_d1_migrations_1'].map(index=>({id:`index:${index}`,sql:`PRAGMA index_xinfo('${index}')`})),
 ...['replay_ledger','leads','conversations','events','messages','qualification_state','action_outbox'].map(table=>({id:`tenant-count:${table}`,sql:`SELECT tenant_id,count(*) AS n FROM ${table} GROUP BY tenant_id ORDER BY tenant_id`}))
].map(query=>Object.freeze(query)));
/** Catalogue only: never opens a database, reads files or invokes remote APIs/CLI. */
export function d1Manifest(args: readonly string[]) {
 if(args.length!==2 || args[0]!=='manifest' || args[1]!=='--offline') throw Error('Fixed offline catalogue required');
 return Object.freeze({version:1,remoteReady:false,remoteExecution:'unavailable',status:'STOP',metadata:'REMOTE UNKNOWN; pinned local _cf_METADATA is not a remote exemption',catalogueHash:createHash('sha256').update(JSON.stringify(queries)).digest('hex'),queries});
}
function dataRecord(value: unknown): Record<string, unknown> {
 if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) throw Error('Plain readback data required');
 const descriptors=Object.getOwnPropertyDescriptors(value);
 if(Object.values(descriptors).some(d=>!Object.hasOwn(d,'value'))) throw Error('Accessor readback forbidden');
 return Object.fromEntries(Object.entries(descriptors).map(([k,d])=>[k,d.value]));
}
function snapshot(value: unknown) {
 const input=dataRecord(value);
 if(Object.keys(input).length!==queries.length || queries.some(q=>!Object.hasOwn(input,q.id))) throw Error('Complete exact query evidence required');
 const columns=new Set(['type','name','tbl_name','sql','schema','ncol','wr','strict','table','rowid','parent','fkid','quick_check','singleton','environment','id','applied_at','seq','cid','notnull','dflt_value','pk','hidden','unique','origin','partial','seqno','desc','coll','key','from','to','on_update','on_delete','match','n','tenant_id']);
 return Object.fromEntries(queries.map(q=>{
  const rows=input[q.id];
  if(!Array.isArray(rows) || Object.getPrototypeOf(rows)!==Array.prototype || rows.length>10000 || Reflect.ownKeys(rows).length!==rows.length+1 || Object.values(Object.getOwnPropertyDescriptors(rows)).some(d=>!Object.hasOwn(d,'value'))) throw Error('Bounded complete own-data rows required');
  return [q.id,rows.map(row=>{
   const r=dataRecord(row);
   if(!Object.keys(r).length || Object.keys(r).some(k=>!columns.has(k)) || Object.values(r).some(v=>v!==null && (typeof v==='string' ? v.length>32768 : typeof v!=='number' || !Number.isFinite(v)))) throw Error('Invalid query row or unknown evidence');
   return Object.fromEntries(Object.entries(r).sort(([a],[b])=>a.localeCompare(b)));
  })];
 }));
}
/** Exact offline comparison only; expectations are not remote provenance/authority. */
export function verifyD1Readback(value: unknown) {
 const p=dataRecord(value);
 if(Object.keys(p).sort().join(',')!=='catalogueHash,expected,expectedHash,observed' || p.catalogueHash!==d1Manifest(['manifest','--offline']).catalogueHash) throw Error('Pinned catalogue required');
 // Hash the original explicit query order; canonical comparison below sorts row columns only.
 const expected=snapshot(p.expected), observed=snapshot(p.observed);
 if(typeof p.expectedHash!=='string' || !/^[a-f0-9]{64}$/.test(p.expectedHash) || createHash('sha256').update(JSON.stringify(p.expected)).digest('hex')!==p.expectedHash) throw Error('Expected evidence hash mismatch');
 const mismatches=Object.freeze(queries.filter(q=>JSON.stringify(expected[q.id])!==JSON.stringify(observed[q.id])).map(q=>q.id));
 return Object.freeze({comparison:mismatches.length?'MISMATCH':'MATCH',mismatches,comparedQueries:queries.length,remoteReady:false,remoteEquivalence:'UNPROVEN',status:'STOP',reason:'Remote metadata/atomicity/provenance remain unqualified; comparison is not certification'});
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
 try {process.stdout.write(JSON.stringify(d1Manifest(process.argv.slice(2)),null,2)+'\n');}
 catch {process.stderr.write('Offline D1 manifest refused.\n');process.exitCode=1;}
}
