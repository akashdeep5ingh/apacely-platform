import {assertDatabaseEnvironment,environmentPredicate} from './environment.js';
import type {Operation} from './ingress-operations.js';
import {sha256} from '@noble/hashes/sha256';
import {bytesToHex} from '@noble/hashes/utils';
import type {SourceAuthority} from './source-mappings.js';
import {utc,uuidV4,trustedEnvironment,type Environment,type Scope} from './contracts.js';
import {normalizeFailure,type D1Binding} from './d1-repository.js';
export interface ReplayClaim {authority:SourceAuthority;nonce:string;fingerprint:string;signed_at:string}
export interface ReplayAdmission {environment:Environment;nonce_ref:string;fingerprint:string;authority_ref:string;tenant_id:string;deadline:number}
export type ReplayOutcome='first'|'identical'|'conflict'|'expired';
export interface ReplayResult {outcome:ReplayOutcome;admission?:ReplayAdmission}
/** Trusted verified requests only. An admission never authorizes or caches business success. */
export interface ReplayLedger {authorityBinding():object;claim(input:ReplayClaim,operation?:Operation):Promise<ReplayResult>}
/** Trusted tenant maintenance only; no physical purge or public administrative authorization. */
export interface ReplayMaintenance {expire(scope:Scope,limit:number):Promise<number>}
export function replayHash(value:unknown):string{return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(value))));}
export function authorityHash(a:SourceAuthority):string{return replayHash([a.id,a.version,a.provider,a.source,a.principal,a.tenant_id,a.source_binding,a.environment,a.operation]);}
export class ReplayStoreError extends Error {constructor(readonly code:'denied'|'unavailable'|'failure'){super('Replay store '+code);this.name='ReplayStoreError';}}
export const databaseNow="CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
export class D1ReplayLedger implements ReplayLedger,ReplayMaintenance {
 #db:D1Binding;#identity:object;#clock:()=>string;#maxRetries:number;
 #environment:Environment;
 constructor(db:D1Binding,clock:()=>string,maxRetries=3,environment:Environment='development'){this.#environment=trustedEnvironment(environment);if(!Number.isInteger(maxRetries)||maxRetries<0||maxRetries>3)throw new ReplayStoreError('denied');this.#maxRetries=maxRetries;if('getBookmark' in db)throw new ReplayStoreError('denied');this.#identity=db;this.#db=Object.freeze({prepare:db.prepare.bind(db),batch:db.batch.bind(db)});this.#clock=clock;}
 authorityBinding():object{return this.#identity;}
 #now():number{let value:string;try{value=this.#clock();}catch{throw new ReplayStoreError('failure');}if(!utc(value))throw new ReplayStoreError('denied');return Date.parse(value);}
 async expire(scope:Scope,limit:number):Promise<number>{
  const tenant=scope?.tenant_id;if(scope?.environment!==this.#environment||!uuidV4.test(tenant)||!Number.isInteger(limit)||limit<1||limit>100)throw new ReplayStoreError('denied');
  try{await assertDatabaseEnvironment(this.#db,this.#environment);}catch{throw new ReplayStoreError('denied');}
  const observed=this.#now();
  let result:{results:unknown[]};try{result=await this.#db.prepare(`UPDATE replay_ledger SET expired=1 WHERE nonce_ref IN (SELECT nonce_ref FROM replay_ledger WHERE tenant_id=? AND expired=0 AND deadline<=max(?,${databaseNow}) AND EXISTS(SELECT 1 FROM tenants WHERE id=? AND lifecycle_status='active') ORDER BY deadline,nonce_ref LIMIT ?) RETURNING nonce_ref`).bind(tenant,observed,tenant,limit).all();}catch(error){throw new ReplayStoreError((normalizeFailure(error) as {code?:string})?.code==='D1_TRANSIENT'?'unavailable':'failure');}
  return result.results.length;
 }
 async claim(input:ReplayClaim,operation?:Operation):Promise<ReplayResult>{
  operation?.check();
  if(!input||typeof input!=='object'||!input.authority||typeof input.authority!=='object')throw new ReplayStoreError('denied');
  const a={...input.authority};
  if(!input||Object.keys(input).some(k=>!['authority','nonce','fingerprint','signed_at'].includes(k))||!uuidV4.test(a.id)||!uuidV4.test(a.tenant_id)||!Number.isSafeInteger(a.version)||a.version<1||a.environment!==this.#environment||a.operation!=='ingest_mock_lead'||![a.provider,a.source,a.principal,a.source_binding,input.nonce].every(x=>typeof x==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(x))||typeof input.fingerprint!=='string'||!/^[0-9a-f]{64}$/.test(input.fingerprint))throw new ReplayStoreError('denied');
  const nonce_ref=replayHash([a.environment,a.provider,a.principal,a.source,input.nonce]),authority_ref=authorityHash(a),fingerprint=input.fingerprint;
  const observed=this.#now(),signed_at=Date.parse(input.signed_at),expires_at=signed_at+300000,deadline=Math.min(expires_at,observed+30000);
  if(!Number.isFinite(observed)||!utc(input.signed_at))throw new ReplayStoreError('denied');
  if(observed>=expires_at||signed_at>observed+30000)return {outcome:'expired'};
  let results:{results:Array<{nonce_ref:string;tenant_id:string;authority_ref:string;fingerprint:string;deadline:number;observed:number;expired:number;signed_at:number;database_now:number}>}[];
  for(let attempt=0;;attempt++){
  operation?.check();
  const observed=this.#now(); // Refresh freshness only; the admission deadline above is immutable.
  try{results=await this.#db.batch([
   this.#db.prepare(`INSERT INTO authority_assertions (authorized) SELECT EXISTS(SELECT 1 FROM source_mappings m JOIN tenants t ON t.id=m.tenant_id WHERE m.id=? AND m.version=? AND m.provider=? AND m.source=? AND m.principal=? AND m.tenant_id=? AND m.source_binding=? AND m.environment=? AND m.operation=? AND m.status='active' AND t.lifecycle_status='active') AND ${environmentPredicate(this.#environment)}`).bind(a.id,a.version,a.provider,a.source,a.principal,a.tenant_id,a.source_binding,a.environment,a.operation),
   this.#db.prepare('DELETE FROM authority_assertions'),
   this.#db.prepare(`INSERT INTO replay_ledger (nonce_ref,tenant_id,mapping_id,authority_ref,fingerprint,signed_at,expires_at,deadline) SELECT ?,?,?,?,?,?,?,min(?,${databaseNow}+30000) WHERE NOT EXISTS (SELECT 1 FROM replay_ledger WHERE nonce_ref=?) AND ?>max(?,${databaseNow}) AND ?<=${databaseNow}+30000 RETURNING nonce_ref`).bind(nonce_ref,a.tenant_id,a.id,authority_ref,fingerprint,signed_at,expires_at,deadline,nonce_ref,deadline,observed,signed_at),
   this.#db.prepare(`SELECT *,max(?,${databaseNow}) AS observed FROM replay_ledger WHERE nonce_ref=? AND tenant_id=? LIMIT 1`).bind(observed,nonce_ref,a.tenant_id),
   this.#db.prepare(`SELECT max(?,${databaseNow}) AS observed,${databaseNow} AS database_now`).bind(observed)
  ]) as typeof results;}catch(error){operation?.check();if(error instanceof Error&&error.message.includes('apacely_source_authority'))throw new ReplayStoreError('denied');const transient=(normalizeFailure(error) as {code?:string})?.code==='D1_TRANSIENT';if(transient&&attempt<this.#maxRetries){await new Promise(r=>setTimeout(r,1));continue;}throw new ReplayStoreError(transient?'unavailable':'failure');}
  operation?.check();const row=results[3].results[0];
  if(!row&&(results[4].results[0].observed>=deadline||signed_at>results[4].results[0].database_now+30000))return {outcome:'expired'};
  if(row&&(row.expired===1||row.observed>=row.deadline))return {outcome:'expired'};
  if(!row||row.signed_at!==signed_at||row.fingerprint!==fingerprint||row.authority_ref!==authority_ref)return {outcome:'conflict'};
  return {outcome:results[2].results.length?'first':'identical',admission:{environment:a.environment,nonce_ref:row.nonce_ref,tenant_id:row.tenant_id,authority_ref:row.authority_ref,fingerprint:row.fingerprint,deadline:row.deadline}};
  }
 }
}
