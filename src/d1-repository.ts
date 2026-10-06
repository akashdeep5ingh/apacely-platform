import {defaultId,SliceError,utc,uuidV4,type Scope} from './contracts.js';
import {businessTables,type Table,type Row,type AcceptanceStore,type AcceptanceRepository} from './persistence.js';
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
export class D1Repository implements AcceptanceRepository {
 constructor(private db:D1Binding,readonly clock:()=>string,private generator:()=>string=defaultId){}
 id():string {const id=this.generator();if(!uuidV4.test(id)) throw new SliceError('validation','Generator must return UUIDv4');return id;}
 now():string {const now=this.clock();if(!utc(now)) throw new SliceError('validation','Clock must return UTC ISO timestamp');return now;}
 async createTenant(display_name:string) {
  const row={id:this.id(),display_name,lifecycle_status:'active',created_at:this.now()};
  await this.db.prepare('INSERT INTO tenants (id,display_name,lifecycle_status,created_at) VALUES (?,?,?,?)').bind(...Object.values(row)).run();return row;
 }
 private capture(scope:Scope):Scope {
  if(!scope||scope.environment!=='development'||!uuidV4.test(scope.tenant_id)) throw new SliceError('context','Active trusted development tenant scope required');
  return Object.freeze({...scope});
 }
 async assertScope(scope:Scope):Promise<void> {
  const captured=this.capture(scope);
  const {results}=await this.db.prepare("SELECT id FROM tenants WHERE id=? AND lifecycle_status='active'").bind(captured.tenant_id).all();
  if(results.length!==1) throw new SliceError('context','Active trusted development tenant scope required');
 }
 async rows(scope:Scope,table:Table):Promise<Row[]> {
  const captured=this.capture(scope);await this.assertScope(captured);this.table(table);
  return (await this.db.prepare(`SELECT * FROM ${table} WHERE tenant_id=? ORDER BY rowid`).bind(captured.tenant_id).all()).results;
 }
 private table(table:Table) {if(!businessTables.includes(table)) throw new SliceError('context','Invalid scoped table');}
 async accept<T>(scope:Scope,work:(store:AcceptanceStore)=>T):Promise<T> {
  const captured=this.capture(scope);await this.assertScope(captured);
  const snapshots=new Map<Table,Row[]>();
  // One transactional read batch: qualification cannot be from a different lead version.
  const reads=await this.db.batch([
   this.db.prepare("SELECT id FROM tenants WHERE id=? AND lifecycle_status='active'").bind(captured.tenant_id),
   ...businessTables.map(table=>this.db.prepare(`SELECT * FROM ${table} WHERE tenant_id=?`).bind(captured.tenant_id))
  ]) as {results:Row[]}[];
  if(reads[0].results.length!==1) throw new SliceError('context','Tenant inactive at snapshot');
  businessTables.forEach((table,index)=>snapshots.set(table,reads[index+1].results));
  const statements:D1Statement[]=[];
  const validate=(table:Table,row:Row,insert=false)=>{
   this.table(table);
   if(insert&&row.tenant_id!==captured.tenant_id) throw new SliceError('context','Cannot insert foreign tenant');
   if(Object.keys(row).some(k=>!/^[a-z_]+$/.test(k)||(!insert&&(k==='id'||k==='tenant_id')))) throw new SliceError('context','Cannot change ownership or use invalid column');
  };
  const store:AcceptanceStore={
   find:(table,criteria)=>{this.table(table);return snapshots.get(table)!.find(r=>Object.entries(criteria).every(([k,v])=>r[k]===v));},
   insert:(table,row)=>{
    validate(table,row,true);const keys=Object.keys(row);
    statements.push(this.db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).bind(...Object.values(row)));
    snapshots.get(table)!.push({...row});
   },
   update:(table,id,patch)=>{
    validate(table,patch);const row=snapshots.get(table)!.find(r=>r.id===id);if(!row)return 0;
    statements.push(this.db.prepare(`UPDATE ${table} SET ${Object.keys(patch).map(k=>`${k}=?`).join(',')} WHERE tenant_id=? AND id=?`).bind(...Object.values(patch),captured.tenant_id,id));
    Object.assign(row,patch);return 1;
   },
   compareLead:(id,version,sequence,patch)=>{
    validate('leads',patch);
    statements.push(this.db.prepare(`UPDATE leads SET ${Object.keys(patch).map(k=>`${k}=?`).join(',')} WHERE tenant_id=? AND id=? AND version=? AND last_source_sequence=?`).bind(...Object.values(patch),captured.tenant_id,id,version,sequence));
    // changes() is evaluated by the next SQL statement INSIDE the atomic batch.
    // Throwing in JavaScript after a successful batch would be too late to roll back.
    statements.push(this.db.prepare('INSERT INTO acceptance_assertions (cas) VALUES (changes())'));
    statements.push(this.db.prepare('DELETE FROM acceptance_assertions'));
    const row=snapshots.get('leads')!.find(r=>r.id===id);if(row)Object.assign(row,patch);
   }
  };
  const outcome=work(store);
  if(statements.length) {
   statements.unshift(
    this.db.prepare("INSERT INTO acceptance_assertions (active) VALUES (CASE WHEN EXISTS (SELECT 1 FROM tenants WHERE id=? AND lifecycle_status='active') THEN 1 ELSE 0 END)").bind(captured.tenant_id),
    this.db.prepare('DELETE FROM acceptance_assertions')
   );
   try {await this.db.batch(statements);}
   catch(error) {
    if(String(error).includes('apacely_active_scope')) throw new SliceError('context','Tenant inactive at commit');
    const message=String(error);
    const identityRace=/UNIQUE constraint failed: (leads\.tenant_id, leads\.source_binding, leads\.source_lead_id|events\.tenant_id, events\.source_binding, events\.source_event_id|events\.tenant_id, events\.lead_id, events\.source_sequence)(?::|$)/.test(message);
    if(message.includes('apacely_cas_conflict')||identityRace) throw Object.assign(new Error('Optimistic version/sequence or event identity changed'),{code:'LOCAL_VERSION_CONFLICT',cause:error});
    throw error;
   }
  }
  return outcome;
 }
}
