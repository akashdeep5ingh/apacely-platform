import {AdmissionCoordinator,bootstrapAdmission,createTicket,encodeMessage,type AdmissionStorage,type AdmissionTransaction} from './distributed-admission.js';
import {STAGING_POLICY} from './staging-policy.js';
/** Pure storage boundary; platform inheritance lives only in the release entrypoints. */
export interface CoordinatorTransaction extends AdmissionTransaction {
 list(options:{limit:number}):Promise<Map<string,unknown>>;
}
export interface CoordinatorStorage extends AdmissionStorage {
 transaction<T>(callback:(tx:CoordinatorTransaction)=>Promise<T>):Promise<T>;
 list(options:{limit:number}):Promise<Map<string,unknown>>;
 sql:{exec(query:string):Iterable<{name:string;type:string;tbl_name:string}>};
}
const STATE='distributed-admission/state/v1',BIRTH='distributed-admission/birth/v1';
const authority={environment:'staging' as const,tenant:'20000000-0000-4000-8000-000000000001',provider:'synthetic',principal:'storage-validation',source:'storage-validation',mappingId:'30000000-0000-4000-8000-000000000001',mappingVersion:1,sourceBinding:'storage-validation',operation:'ingest_mock_lead' as const};
function marker():string {
 const digest=createTicket(STAGING_POLICY,authority,0).context.policyDigest;
 return JSON.stringify({version:1,environment:'staging',domain:STAGING_POLICY.domain,epoch:STAGING_POLICY.epoch,policyDigest:digest});
}
function fail():never{throw new Error('Invalid sealed admission storage');}
function schemaGuard(storage:CoordinatorStorage):void {
 const rows=[...storage.sql.exec("SELECT name,type,tbl_name FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' LIMIT 4")];
 if(rows.length>1||rows.some(row=>row.name!=='_cf_KV'||row.type!=='table'||row.tbl_name!=='_cf_KV'))fail();
}
/** Preserve actual platform receivers and use the transaction's own get/put. */
export function admissionStorage(storage:AdmissionStorage):AdmissionStorage {
 return Object.freeze({get:storage.get.bind(storage),put:storage.put.bind(storage),transaction:<T>(callback:(tx:AdmissionTransaction)=>Promise<T>)=>storage.transaction(tx=>callback(Object.freeze({get:tx.get.bind(tx),put:tx.put.bind(tx)})))});
}
/** No writes, reseeding or clock advancement; reuse the complete canonical core decoder. */
export async function validateSealedAdmission(storage:CoordinatorStorage):Promise<void>{
 schemaGuard(storage);
 const entries=await storage.list({limit:3});
 if(entries.size!==2||!entries.has(BIRTH)||!entries.has(STATE)||entries.get(BIRTH)!==marker())fail();
 const raw=entries.get(STATE);
 const readonly:AdmissionStorage={get:async key=>key===STATE?raw:undefined,put:async()=>{},transaction:async callback=>callback({get:async key=>key===STATE?raw:undefined,put:async()=>{}})};
 const core=new AdmissionCoordinator(readonly,STAGING_POLICY,()=>NaN);
 const ticket=createTicket(STAGING_POLICY,authority,0);
 const response=await core.fetch(new Request('https://admission.internal/v1/inspect',{method:'POST',headers:{'content-type':'application/json'},body:encodeMessage({version:1,operation:'inspect',ticket,payload:{}})}));
 const reply=await response.json() as {result?:{tag?:string}};
 if(response.status!==200||reply.result?.tag!=='absent')fail();
}
/** ONLY the separate trusted first-birth artifact imports this capability.
 * Empty storage is a guard, not proof of never-used storage: operator must prove a fresh namespace. */
export async function initializeFreshAdmission(storage:CoordinatorStorage,now:number):Promise<void>{
 schemaGuard(storage);
 await storage.transaction(async tx=>{
  if((await tx.list({limit:1})).size!==0)fail();
  const facade:AdmissionStorage={get:tx.get.bind(tx),put:tx.put.bind(tx),transaction:async callback=>callback({get:tx.get.bind(tx),put:tx.put.bind(tx)})};
  await tx.put(BIRTH,marker());
  await bootstrapAdmission(facade,STAGING_POLICY,now);
 });
}
