import {assertDatabaseEnvironment,environmentPredicate} from './environment.js';
import {authorityHash,databaseNow,type ReplayAdmission} from './replay-ledger.js';
import type {SourceAuthority} from './source-mappings.js';
import {defaultId,SliceError,utc,uuidV4,trustedEnvironment,type Environment,type Scope} from './contracts.js';
import {businessTables,type Table,type Row,type AcceptanceStore,type AcceptanceRepository,type AcceptanceTarget} from './persistence.js';
/** Structural subset of the D1 binding API; no Cloudflare SDK/runtime dependency. */
export interface D1Statement {
 bind(...values:(string|number|null)[]):D1Statement;
 all<T=Row>():Promise<{results:T[];success:boolean}>;
 run():Promise<unknown>;
}
export interface D1Binding {
 prepare(sql:string):D1Statement;
 batch(statements:D1Statement[]):Promise<unknown[]>;
}
const transientDetails=new Set([
 'D1 DB reset because its code was updated.',
 'Internal error while starting up D1 DB storage caused object to be reset.',
 'Network connection lost.','Replica disconnected from primary.',
 'Internal error in D1 DB storage caused object to be reset.',
 'Cannot resolve D1 DB due to transient issue on remote node.',
 "Can't read from request stream because client disconnected."
]);
function inspectError(error:unknown):{messages:string[];complete:boolean} {
 const messages:string[]=[];const seen=new Set<unknown>();let next=error;
 for(;next!=null&&!seen.has(next)&&messages.length<4;next=(next as {cause?:unknown}).cause){seen.add(next);messages.push(next instanceof Error?next.message:String(next));}
 return {messages,complete:next==null};
}
function errorMessages(error:unknown):string[] {return inspectError(error).messages;}
export function normalizeFailure(error:unknown):unknown {
 if(error instanceof SliceError)return error;
 const {messages,complete}=inspectError(error);
 if(!complete)return error;
 const details=messages.filter(m=>m!=='D1_ERROR').map(m=>m.replace(/^D1_ERROR:\s*/,''));
 if(messages.some(m=>/^D1_ERROR(?::|$)/.test(m))&&details.length&&details.every(m=>transientDetails.has(m)))return Object.assign(new Error('Transient D1 operation failure'),{code:'D1_TRANSIENT',cause:error});
 return error;
}
export class D1Repository implements AcceptanceRepository {
 /** Pass the original D1Database binding: non-session operations always route to primary. */
 #identity:object;
 authorityBinding():object{return this.#identity;}
 replayBinding():object{return this.#identity;}
 #db:D1Binding;#clock:()=>string;#generator:()=>string;
 #environment:Environment;
 constructor(db:D1Binding,clock:()=>string,generator:()=>string=defaultId,environment:Environment='development'){
  this.#environment=trustedEnvironment(environment);
  this.#db=Object.freeze({prepare:db.prepare.bind(db),batch:db.batch.bind(db)});this.#clock=clock;this.#generator=generator;
  this.#identity=db;
  if('getBookmark' in db)throw new SliceError('context','D1Database sessions are not accepted: a primary binding is required');
 }
 id():string {const id=this.#generator();if(!uuidV4.test(id)) throw new SliceError('validation','Generator must return UUIDv4');return id;}
 #now():string {const now=this.#clock();if(!utc(now)) throw new SliceError('validation','Clock must return UTC ISO timestamp');return now;}
 now():string {return this.#now();}
 async createTenant(display_name:string) {
  await assertDatabaseEnvironment(this.#db,this.#environment);
  const row={id:this.id(),display_name,lifecycle_status:'active',created_at:this.now()};
  await this.#db.prepare('INSERT INTO tenants (id,display_name,lifecycle_status,created_at) VALUES (?,?,?,?)').bind(...Object.values(row)).run();return row;
 }
 #capture(scope:Scope):Scope {
  if(!scope||scope.environment!==this.#environment||!uuidV4.test(scope.tenant_id)) throw new SliceError('context','Active trusted development tenant scope required');
  return Object.freeze({...scope});
 }
 async assertScope(scope:Scope):Promise<void> {
  const captured=this.#capture(scope);
  const {results}=await this.#db.prepare(`SELECT id FROM tenants WHERE id=? AND lifecycle_status='active' AND ${environmentPredicate(this.#environment)}`).bind(captured.tenant_id).all();
  if(results.length!==1) throw new SliceError('context','Active trusted development tenant scope required');
 }
 async rows(scope:Scope,table:Table):Promise<Row[]> {
  const captured=this.#capture(scope);this.#table(table);
  const reads=await this.#batch([
   this.#db.prepare(`SELECT id FROM tenants WHERE id=? AND lifecycle_status='active' AND ${environmentPredicate(this.#environment)}`).bind(captured.tenant_id),
   this.#db.prepare(`SELECT * FROM ${table} WHERE tenant_id=? AND ${environmentPredicate(this.#environment)} AND EXISTS (SELECT 1 FROM tenants WHERE id=? AND lifecycle_status='active') ORDER BY rowid`).bind(captured.tenant_id,captured.tenant_id)
  ]) as {results:Row[]}[];
  if(reads[0].results.length!==1)throw new SliceError('context','Tenant inactive at diagnostic snapshot');
  return reads[1].results;
 }
 #table(table:Table) {if(!businessTables.includes(table)) throw new SliceError('context','Invalid scoped table');}
 async #batch(statements:D1Statement[]):Promise<unknown[]> {
  try{return await this.#db.batch(statements);}catch(error){throw normalizeFailure(error);}
 }
 async accept<T>(scope:Scope,work:(store:AcceptanceStore)=>T,target?:AcceptanceTarget,authority?:SourceAuthority,replay?:ReplayAdmission):Promise<T> {
  const captured=this.#capture(scope);
  const expected=authority?Object.freeze({...authority}):undefined;
  if(expected&&(expected.tenant_id!==captured.tenant_id||expected.environment!==captured.environment||expected.operation!=='ingest_mock_lead'||!target||expected.source_binding!==target.source_binding||!uuidV4.test(expected.id)||!Number.isSafeInteger(expected.version)||expected.version<1))throw new SliceError('context','Invalid acceptance authority');
  const admission=replay?Object.freeze({...replay}):undefined;
  if(admission&&(!expected||admission.environment!==captured.environment||admission.tenant_id!==captured.tenant_id||admission.authority_ref!==authorityHash(expected)||!Number.isSafeInteger(admission.deadline)||![admission.nonce_ref,admission.fingerprint].every(x=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x))))throw new SliceError('context','Invalid replay admission');
  const fresh=()=>this.#db.prepare(`SELECT EXISTS(SELECT 1 FROM replay_ledger WHERE nonce_ref=? AND tenant_id=? AND mapping_id=? AND authority_ref=? AND fingerprint=? AND deadline=? AND expired=0 AND deadline>max(?,${databaseNow})) AS fresh`).bind(admission!.nonce_ref,captured.tenant_id,expected!.id,admission!.authority_ref,admission!.fingerprint,admission!.deadline,Date.parse(this.#now()));
  const authorized=()=>this.#db.prepare("SELECT EXISTS(SELECT 1 FROM source_mappings WHERE id=? AND version=? AND provider=? AND source=? AND principal=? AND tenant_id=? AND source_binding=? AND operation=? AND environment=? AND status='active') AS authorized").bind(expected!.id,expected!.version,expected!.provider,expected!.source,expected!.principal,expected!.tenant_id,expected!.source_binding,expected!.operation,expected!.environment);
  const snapshots=new Map<Table,Row[]>();
  // One transactional read batch: qualification cannot be from a different lead version.
  const reads=await this.#batch([
   this.#db.prepare(`SELECT id FROM tenants WHERE id=? AND lifecycle_status='active' AND ${environmentPredicate(this.#environment)}`).bind(captured.tenant_id),
   ...(expected?[authorized()]:[]),
   ...(admission?[fresh()]:[]),
   ...businessTables.map(table=>{
    if(!target)return this.#db.prepare(`SELECT * FROM ${table} WHERE tenant_id=? AND ${environmentPredicate(this.#environment)} LIMIT 101`).bind(captured.tenant_id); // trusted bounded maintenance only
    const {source_binding,source_event_id,source_lead_id}=target;
    if(table==='events')return this.#db.prepare(`SELECT * FROM events WHERE tenant_id=? AND ${environmentPredicate(this.#environment)} AND source_binding=? AND source_event_id=?`).bind(captured.tenant_id,source_binding,source_event_id);
    if(table==='leads')return this.#db.prepare(`SELECT * FROM leads WHERE tenant_id=? AND ${environmentPredicate(this.#environment)} AND source_binding=? AND source_lead_id=?`).bind(captured.tenant_id,source_binding,source_lead_id);
    if(table==='conversations'||table==='qualification_state')return this.#db.prepare(`SELECT * FROM ${table} WHERE tenant_id=? AND ${environmentPredicate(this.#environment)} AND lead_id=(SELECT id FROM leads WHERE tenant_id=? AND source_binding=? AND source_lead_id=?)${table==='conversations'?' AND source_binding=?':''}`).bind(captured.tenant_id,captured.tenant_id,source_binding,source_lead_id,...(table==='conversations'?[source_binding]:[]));
    return this.#db.prepare(`SELECT * FROM ${table} WHERE tenant_id=? AND 0`).bind(captured.tenant_id);
   })
  ]) as {results:Row[]}[];
  if(reads[0].results.length!==1) throw new SliceError('context','Tenant inactive at snapshot');
  if(expected&&reads[1].results[0]?.authorized!==1)throw new SliceError('context','Source authority unavailable at snapshot');
  if(admission&&reads[2].results[0]?.fresh!==1)throw new SliceError('expired','Replay admission expired at snapshot');
  const offset=(expected?2:1)+(admission?1:0);
  if(!target&&reads.slice(offset).some(r=>r.results.length>100))throw new SliceError('context','Maintenance snapshot exceeds 100 rows per table; supply an exact acceptance target');
  businessTables.forEach((table,index)=>snapshots.set(table,reads[index+offset].results));
  const statements:D1Statement[]=[];
  const validate=(table:Table,row:Row,insert=false)=>{
   this.#table(table);
   if(insert&&row.tenant_id!==captured.tenant_id) throw new SliceError('context','Cannot insert foreign tenant');
   if(Object.keys(row).some(k=>!/^[a-z_]+$/.test(k)||(!insert&&(k==='id'||k==='tenant_id')))) throw new SliceError('context','Cannot change ownership or use invalid column');
  };
  const store:AcceptanceStore={
   find:(table,criteria)=>{this.#table(table);return snapshots.get(table)!.find(r=>Object.entries(criteria).every(([k,v])=>r[k]===v));},
   insert:(table,row)=>{
    validate(table,row,true);const keys=Object.keys(row);
    statements.push(this.#db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).bind(...Object.values(row)));
    snapshots.get(table)!.push({...row});
   },
   update:(table,id,patch)=>{
    validate(table,patch);const row=snapshots.get(table)!.find(r=>r.id===id);if(!row)return 0;
    statements.push(this.#db.prepare(`UPDATE ${table} SET ${Object.keys(patch).map(k=>`${k}=?`).join(',')} WHERE tenant_id=? AND id=?`).bind(...Object.values(patch),captured.tenant_id,id));
    Object.assign(row,patch);return 1;
   },
   compareLead:(id,version,sequence,patch)=>{
    validate('leads',patch);
    statements.push(this.#db.prepare(`UPDATE leads SET ${Object.keys(patch).map(k=>`${k}=?`).join(',')} WHERE tenant_id=? AND id=? AND version=? AND last_source_sequence=?`).bind(...Object.values(patch),captured.tenant_id,id,version,sequence));
    // changes() is evaluated by the next SQL statement INSIDE the atomic batch.
    // Throwing in JavaScript after a successful batch would be too late to roll back.
    statements.push(this.#db.prepare('INSERT INTO acceptance_assertions (cas) VALUES (changes())'));
    statements.push(this.#db.prepare('DELETE FROM acceptance_assertions'));
    const row=snapshots.get('leads')!.find(r=>r.id===id);if(row)Object.assign(row,patch);
   }
  };
  const outcome=work(store);
  if(statements.length) {
   if(admission){
    const assertion=()=>this.#db.prepare(`INSERT INTO replay_assertions (fresh) SELECT EXISTS(SELECT 1 FROM replay_ledger WHERE nonce_ref=? AND tenant_id=? AND mapping_id=? AND authority_ref=? AND fingerprint=? AND deadline=? AND expired=0 AND deadline>max(?,${databaseNow}))`).bind(admission.nonce_ref,captured.tenant_id,expected!.id,admission.authority_ref,admission.fingerprint,admission.deadline,Date.parse(this.#now()));
    statements.unshift(assertion(),this.#db.prepare('DELETE FROM replay_assertions'));
    // Check again after all business writes, within the SAME rollback boundary.
    statements.push(assertion(),this.#db.prepare('DELETE FROM replay_assertions'));
   }
   if(expected)statements.unshift(this.#db.prepare("INSERT INTO authority_assertions (authorized) SELECT EXISTS(SELECT 1 FROM source_mappings WHERE id=? AND version=? AND provider=? AND source=? AND principal=? AND tenant_id=? AND source_binding=? AND operation=? AND environment=? AND status='active')").bind(expected.id,expected.version,expected.provider,expected.source,expected.principal,expected.tenant_id,expected.source_binding,expected.operation,expected.environment),this.#db.prepare('DELETE FROM authority_assertions'));
   statements.unshift(
    this.#db.prepare(`INSERT INTO acceptance_assertions (active) VALUES (CASE WHEN EXISTS (SELECT 1 FROM tenants WHERE id=? AND lifecycle_status='active') AND ${environmentPredicate(this.#environment)} THEN 1 ELSE 0 END)`).bind(captured.tenant_id),
    this.#db.prepare('DELETE FROM acceptance_assertions')
   );
   try {await this.#batch(statements);}
   catch(error) {
    if(errorMessages(error).join('\n').includes('apacely_replay_fresh'))throw new SliceError('expired','Replay admission expired at commit');
    if(errorMessages(error).join('\n').includes('apacely_source_authority'))throw new SliceError('context','Source authority unavailable at commit');
    if(errorMessages(error).join('\n').includes('apacely_active_scope')) throw new SliceError('context','Tenant inactive at commit');
    const message=errorMessages(error).join('\n');
    const identityRace=/UNIQUE constraint failed: (leads\.tenant_id, leads\.source_binding, leads\.source_lead_id|events\.tenant_id, events\.source_binding, events\.source_event_id|events\.tenant_id, events\.lead_id, events\.source_sequence)(?::|$)/.test(message);
    if(message.includes('apacely_cas_conflict')||identityRace) throw Object.assign(new Error('Optimistic version/sequence or event identity changed'),{code:'LOCAL_VERSION_CONFLICT',cause:error});
    throw error;
   }
  }
  return outcome;
 }
}
