import {defaultId,SliceError,utc,uuidV4,type Scope} from './contracts.js';
import {normalizeFailure,type D1Binding} from './d1-repository.js';
export interface SourceAuthority {
 id:string;version:number;provider:string;source:string;principal:string;tenant_id:string;source_binding:string;
 environment:'development';operation:'ingest_mock_lead';
}
export interface SourceMapping extends SourceAuthority {
 status:'active'|'inactive'|'revoked';created_at:string;updated_at:string;revoked_at:string|null;revoked_version:number|null;
}
export interface SourceMappingStore {
 /** Opaque persistence identity; acceptance and resolution must use the same original primary binding. */
 authorityBinding():object;
 resolve(identity:{provider:string;source:string}):Promise<readonly SourceMapping[]>;
}
export class MappingStoreError extends Error {
 constructor(readonly code:'denied'|'unavailable'|'failure'){super('Source authority store '+code);this.name='MappingStoreError';}
}
export class D1SourceMappingStore implements SourceMappingStore {
 #db:D1Binding;#identity:object;#clock:()=>string;
 constructor(db:D1Binding,clock:()=>string){
  if('getBookmark' in db)throw new SliceError('context','Primary mapping binding required');
  this.#identity=db;this.#db=Object.freeze({prepare:db.prepare.bind(db),batch:db.batch.bind(db)});this.#clock=clock;
 }
 authorityBinding():object{return this.#identity;}
 async #call<T>(work:()=>Promise<T>):Promise<T>{
  try{return await work();}catch(error){
   if(error instanceof MappingStoreError)throw error;
   throw new MappingStoreError((normalizeFailure(error) as {code?:string})?.code==='D1_TRANSIENT'?'unavailable':'failure');
  }
 }
 #now():string{let now:string;try{now=this.#clock();}catch{throw new MappingStoreError('failure');}if(!utc(now))throw new MappingStoreError('denied');return now;}
 async create(input:Omit<SourceAuthority,'id'|'version'>):Promise<SourceMapping>{
  const captured={...input};
  const allowed=['provider','source','principal','tenant_id','source_binding','environment','operation'];
  if(Object.keys(captured).length!==allowed.length||Object.keys(captured).some(k=>!allowed.includes(k)))throw new MappingStoreError('denied');
  if(!uuidV4.test(captured.tenant_id)||captured.environment!=='development'||captured.operation!=='ingest_mock_lead'||![captured.provider,captured.source,captured.principal,captured.source_binding].every(x=>typeof x==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(x)))throw new MappingStoreError('denied');
  const now=this.#now(),row:SourceMapping={...captured,id:defaultId(),version:1,status:'active',created_at:now,updated_at:now,revoked_at:null,revoked_version:null};
  const keys=Object.keys(row);
  await this.#call(()=>this.#db.prepare(`INSERT INTO source_mappings (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).bind(...Object.values(row)).run());
  return Object.freeze(row);
 }
 async update(scope:Scope,id:string,version:number,patch:{principal?:string;source_binding?:string;status?:'active'|'inactive'}):Promise<SourceMapping>{
  const captured={...patch};
  if(!captured||!Object.keys(captured).length||Object.keys(captured).some(k=>!['principal','source_binding','status'].includes(k))||Object.entries(captured).some(([k,v])=>k==='status'?!['active','inactive'].includes(v):typeof v!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(v)))throw new MappingStoreError('denied');
  return this.#mutate(scope,id,version,captured);
 }
 async revoke(scope:Scope,id:string,version:number):Promise<SourceMapping>{
  const now=this.#now();return this.#mutate(scope,id,version,{status:'revoked',revoked_at:now,revoked_version:version+1});
 }
 async #mutate(scope:Scope,id:string,version:number,patch:Record<string,string|number>):Promise<SourceMapping>{
  const tenant_id=scope?.tenant_id;
  if(scope?.environment!=='development'||!uuidV4.test(tenant_id)||!uuidV4.test(id)||!Number.isSafeInteger(version)||version<1||version>=Number.MAX_SAFE_INTEGER)throw new MappingStoreError('denied');
  const keys=Object.keys(patch),now=this.#now();
  const result=await this.#call(()=>this.#db.prepare(`UPDATE source_mappings SET ${keys.map(k=>k+'=?').join(',')},version=version+1,updated_at=? WHERE tenant_id=? AND id=? AND version=? AND status!='revoked' RETURNING *`).bind(...Object.values(patch),now,tenant_id,id,version).all<SourceMapping>());
  if(result.results.length!==1)throw new MappingStoreError('denied');return Object.freeze({...result.results[0]});
 }
 async resolve(identity:{provider:string;source:string}):Promise<readonly SourceMapping[]>{
  const {provider,source}=identity;
  const result=await this.#call(()=>this.#db.prepare('SELECT * FROM source_mappings WHERE provider=? AND source=? LIMIT 2').bind(provider,source).all<SourceMapping>());
  return result.results.map(row=>Object.freeze({...row}));
 }
}
