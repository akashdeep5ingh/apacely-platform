import {createHash} from 'node:crypto';

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
export const metadataBlocker = 'No supported remote path is qualified for exact _cf_METADATA schema, columns, indexes and key-2 integer bookmark contents; local physical preflight has no remote counterpart. Baseline guard unchanged.';
// Pre-migration observations only. The existing post-migration catalogue is not duplicated.
const queries = Object.freeze([
 {id:'inventory', sql:'SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name'},
 {id:'table-list', sql:'PRAGMA table_list'},
 {id:'metadata-columns', sql:"PRAGMA table_xinfo('_cf_METADATA')"},
 {id:'metadata-indexes', sql:"PRAGMA index_list('_cf_METADATA')"},
 {id:'metadata-bookmark', sql:'SELECT key,value,typeof(key) AS key_type,typeof(value) AS value_type FROM _cf_METADATA ORDER BY key'},
 {id:'fk-check', sql:'PRAGMA foreign_key_check'},
 {id:'quick-check', sql:'PRAGMA quick_check'}
].map(q => Object.freeze(q)));
const packets = new WeakSet<object>();
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
 if(!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw Error('Plain own-data record required');
 const descriptors = Object.getOwnPropertyDescriptors(value);
 if(Reflect.ownKeys(value).length !== keys.length || keys.some(k => !descriptors[k] || !Object.hasOwn(descriptors[k]!, 'value'))) throw Error('Exact own-data fields required');
 return Object.fromEntries(keys.map(k => [k,descriptors[k]!.value]));
}
export function prepareObservationPacket(value: unknown) {
 const bytes = record(value,['config','migration','source','wrangler']);
 if(Object.values(bytes).some(v => typeof v !== 'string' || Buffer.byteLength(v) > 32*1024*1024)) throw Error('Bounded supplied UTF-8 artifact bytes required');
 const artifacts = Object.freeze(Object.fromEntries(Object.entries(bytes).map(([k,v]) => [k,digest(v as string)])));
 const plan = observationPlan(['plan','--offline']);
 const data = {...plan, artifacts};
 const packet = Object.freeze({...data, packetHash:digest(JSON.stringify(data))});
 packets.add(packet);
 return packet;
}
const columns: Readonly<Record<string, readonly string[]>> = Object.freeze({
 inventory:['type','name','tbl_name','sql'], 'table-list':['schema','name','type','ncol','wr','strict'],
 'metadata-columns':['cid','name','type','notnull','dflt_value','pk','hidden'],
 'metadata-indexes':['seq','name','unique','origin','partial'], 'metadata-bookmark':['key','value','key_type','value_type'],
 'fk-check':['table','rowid','parent','fkid'], 'quick-check':['quick_check']
});
function snapshot(packet: ReturnType<typeof prepareObservationPacket>, value: unknown) {
 const e = record(value,['packetHash','catalogueHash','sourceHash','origin','requestId','complete','results']);
 if(e.packetHash !== packet.packetHash || e.catalogueHash !== packet.catalogueHash || e.sourceHash !== packet.artifacts.source || e.complete !== true || !['ordinary-local-sqlite','unverified-remote'].includes(e.origin as string) || (e.requestId !== null && (typeof e.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(e.requestId)))) throw Error('Unbound or incomplete provenance claims');
 const input = record(e.results,queries.map(q => q.id));
 return Object.fromEntries(queries.map(q => {
  const rows = input[q.id];
  if(!Array.isArray(rows) || Object.getPrototypeOf(rows) !== Array.prototype) throw Error('Complete bounded own-data rows required');
  const length = Object.getOwnPropertyDescriptor(rows,'length');
  if(!length || !Object.hasOwn(length,'value') || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > 1000) throw Error('Complete bounded own-data rows required');
  const keys = new Set<string>(['length']);
  for(let i=0; i<length.value; i++) keys.add(String(i));
  if(Reflect.ownKeys(rows).some(k => typeof k !== 'string' || !keys.has(k))) throw Error('Complete bounded own-data rows required');
  const dense: Record<string,unknown>[] = [];
  for(let i=0; i<length.value; i++) {
   const descriptor = Object.getOwnPropertyDescriptor(rows,String(i));
   if(!descriptor || !Object.hasOwn(descriptor,'value')) throw Error('Complete bounded own-data rows required');
   const r = record(descriptor.value,columns[q.id]!);
   if(Object.values(r).some(v => v !== null && (typeof v === 'string' ? v.length > 32768 : typeof v !== 'number' || !Number.isSafeInteger(v)))) throw Error('Scalar metadata required');
   dense.push(r);
  }
  return [q.id,dense];
 }));
}
function localShape(s: ReturnType<typeof snapshot>): boolean {
 const inv=s.inventory!, cols=s['metadata-columns']!, bookmark=s['metadata-bookmark']!, tables=s['table-list']!;
 return inv.length === 1 && inv[0]!.type === 'table' && inv[0]!.name === '_cf_METADATA' && inv[0]!.tbl_name === '_cf_METADATA' && typeof inv[0]!.sql === 'string' && inv[0]!.sql.replace(/[\t\r\n ]/g,'') === 'CREATETABLE_cf_METADATA(keyINTEGERPRIMARYKEY,valueBLOB)' &&
  cols.length === 2 && cols.every((r,i) => r.cid === i && r.name === (i===0?'key':'value') && r.type === (i===0?'INTEGER':'BLOB') && r.notnull === 0 && r.dflt_value === null && r.pk === (i===0?1:0) && r.hidden === 0) &&
  s['metadata-indexes']!.length === 0 && bookmark.length === 1 && bookmark[0]!.key === 2 && bookmark[0]!.key_type === 'integer' && bookmark[0]!.value_type === 'integer' && typeof bookmark[0]!.value === 'number' && bookmark[0]!.value >= 0 &&
  tables.length === 3 && tables.every(r => r.type === 'table' && r.wr === 0 && r.strict === 0 && ((r.name === '_cf_METADATA' && r.schema === 'main' && r.ncol === 2) || (r.name === 'sqlite_schema' && r.schema === 'main' && r.ncol === 5) || (r.name === 'sqlite_temp_schema' && r.schema === 'temp' && r.ncol === 5))) && new Set(tables.map(r=>r.name)).size === 3 &&
  s['fk-check']!.length === 0 && s['quick-check']!.length === 1 && s['quick-check']![0]!.quick_check === 'ok';
}
/** Caller-supplied source hashes and request IDs are consistency claims, never attestation. */
export function compareObservation(packet: ReturnType<typeof prepareObservationPacket>, expected: unknown, observed: unknown) {
 if(!packets.has(packet)) throw Error('Original prepared packet required');
 let comparison = 'UNKNOWN', comparedQueries = 0;
 let mismatches: readonly string[] = [];
 try {
  const a=snapshot(packet,expected), b=snapshot(packet,observed);
  comparedQueries=queries.length;
  mismatches=queries.filter(q=>JSON.stringify(a[q.id]) !== JSON.stringify(b[q.id])).map(q=>q.id);
  comparison=mismatches.length ? 'MISMATCH' : localShape(a) && localShape(b) ? 'MATCH' : 'UNKNOWN';
 } catch { /* Missing/error/truncated/accessor evidence cannot become empty success. */ }
 return Object.freeze({comparison, comparedQueries, mismatches:Object.freeze(mismatches), status:'STOP', remoteReady:false, provenance:'UNVERIFIED', remoteEquivalence:'UNPROVEN', blocker:metadataBlocker});
}
export function observationPlan(args: readonly string[]) {
 if(args.length !== 2 || args[0] !== 'plan' || args[1] !== '--offline') throw Error('Exact offline plan required');
 return Object.freeze({version:1, status:'STOP', remoteReady:false, remoteExecution:'unavailable',
  target:Object.freeze({accountId:'dfd3d98054e547f897606de8c8ebac92', databaseName:'apacely-staging', databaseId:null, creation:'NOT CREATED', environment:'staging'}),
  approval:null, artifacts:null, provenance:'UNVERIFIED', queries, catalogueHash:digest(JSON.stringify(queries)), blocker:metadataBlocker,
  approvalRequest:Object.freeze({class:'new-resource-and-bounded-metadata-observation', resource:'One future dedicated synthetic-only apacely-staging D1 in the fixed account; never existing databases',
   actions:'Separately approve creation and at most one execution per fixed query after independent target/permission readback and supported-visibility review; failed or absent query stops without retries or substitutes',
   excluded:'Migrations/list/import, Workers/deployment, DO, Access, routes, secrets, DNS, traffic, upgrades, fault/restore, production',
   required:'Named operator, owner, region, expiry, explicit creation/query cost ceiling and evidence retention; approval authenticates exact packet and query hashes, never a reference alone'})});
}
