import Database from 'better-sqlite3';
import {readFileSync} from 'node:fs';
import {defaultId,SliceError,utc,uuidV4,type Scope} from './contracts.js';
import {businessTables,type Table,type Row,type AcceptanceStore} from './persistence.js';
export {businessTables,type Table,type Row} from './persistence.js';
export interface UnitOfWork {transaction<T>(work:()=>T):T}
/** Local interactive SQLite adapter only; a future D1 adapter must supply its own atomic unit. */
export class Repository implements UnitOfWork {
 private db:Database.Database;
 constructor(path:string,readonly clock:()=>string,private generator:()=>string=defaultId) {
  this.db=new Database(path,{timeout:0});
  this.db.pragma('foreign_keys = ON');
  this.db.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));
 }
 id():string {const id=this.generator();if(!uuidV4.test(id)) throw new SliceError('validation','Generator must return UUIDv4');return id;}
 now():string {const now=this.clock();if(!utc(now)) throw new SliceError('validation','Clock must return UTC ISO timestamp');return now;}
 createTenant(display_name:string) {const row={id:this.id(),display_name,lifecycle_status:'active',created_at:this.now()};this.db.prepare('INSERT INTO tenants VALUES (@id,@display_name,@lifecycle_status,@created_at)').run(row);return row;}
 assertScope(scope:Scope):void {
  if(!scope||scope.environment!=='development'||!uuidV4.test(scope.tenant_id)||!this.db.prepare("SELECT id FROM tenants WHERE id=? AND lifecycle_status='active'").get(scope.tenant_id)) throw new SliceError('context','Active trusted development tenant scope required');
 }
 scoped(scope:Scope):ScopedRepository {this.assertScope(scope);const captured=Object.freeze({...scope});return new ScopedRepository(this.db,captured,()=>this.assertScope(captured));}
 accept<T>(scope:Scope,work:(store:AcceptanceStore)=>T):T {return this.transaction(()=>work(this.scoped(scope)));}
 transaction<T>(work:()=>T):T {return this.db.transaction(work).immediate();}
 requireCommitted():void {if(this.db.inTransaction) throw new SliceError('conflict','Outbox consumer requires committed state');}
 close():void {this.db.close();}
}
export class ScopedRepository {
 constructor(private db:Database.Database,readonly scope:Scope,private check:()=>void){}
 private table(table:Table) {this.check();if(!businessTables.includes(table)) throw new SliceError('context','Invalid scoped table');return table;}
 rows(table:Table):Row[] {return this.db.prepare(`SELECT * FROM ${this.table(table)} WHERE tenant_id=? ORDER BY rowid`).all(this.scope.tenant_id) as Row[];}
 get(table:Table,id:string):Row|undefined {return this.db.prepare(`SELECT * FROM ${this.table(table)} WHERE tenant_id=? AND id=?`).get(this.scope.tenant_id,id) as Row|undefined;}
 find(table:Table,criteria:Row):Row|undefined {
  const rows=this.rows(table);return rows.find(r=>Object.entries(criteria).every(([k,v])=>r[k]===v));
 }
 insert(table:Table,row:Row):void {
  this.table(table);if(row.tenant_id!==this.scope.tenant_id) throw new SliceError('context','Cannot insert foreign tenant');
  const keys=Object.keys(row);if(keys.some(k=>!/^[a-z_]+$/.test(k))) throw new SliceError('validation','Invalid column');
  this.db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(k=>'@'+k).join(',')})`).run(row);
 }
 update(table:Table,id:string,patch:Row):number {
  this.table(table);const keys=Object.keys(patch);
  if(keys.some(k=>!/^[a-z_]+$/.test(k)||k==='tenant_id'||k==='id')) throw new SliceError('context','Cannot change ownership');
  return this.db.prepare(`UPDATE ${table} SET ${keys.map(k=>`${k}=@${k}`).join(',')} WHERE tenant_id=@_tenant AND id=@_id`).run({...patch,_tenant:this.scope.tenant_id,_id:id}).changes;
 }
 history(lead_id:string):Row[] {
  this.check();return this.db.prepare(`SELECT e.id AS event_id, m.id AS message_id, c.id AS conversation_id, m.text, e.source_sequence FROM leads l JOIN conversations c ON c.tenant_id=l.tenant_id AND c.lead_id=l.id JOIN events e ON e.tenant_id=c.tenant_id AND e.conversation_id=c.id AND e.lead_id=l.id JOIN messages m ON m.tenant_id=e.tenant_id AND m.event_id=e.id AND m.conversation_id=c.id AND m.lead_id=l.id WHERE l.tenant_id=? AND l.id=? ORDER BY e.source_sequence`).all(this.scope.tenant_id,lead_id) as Row[];
 }
 compareLead(id:string,version:number,sequence:number,patch:Row):void {
  this.table('leads');const keys=Object.keys(patch);
  if(keys.some(k=>!/^[a-z_]+$/.test(k)||k==='tenant_id'||k==='id')) throw new SliceError('context','Cannot change ownership');
  const changed=this.db.prepare(`UPDATE leads SET ${keys.map(k=>`${k}=@${k}`).join(',')} WHERE tenant_id=@_tenant AND id=@_id AND version=@_version AND last_source_sequence=@_sequence`).run({...patch,_tenant:this.scope.tenant_id,_id:id,_version:version,_sequence:sequence}).changes;
  if(changed!==1) throw Object.assign(new Error('Local optimistic version/sequence changed'),{code:'LOCAL_VERSION_CONFLICT'});
 }
}
