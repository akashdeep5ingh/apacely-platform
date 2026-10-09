import {sha256} from '@noble/hashes/sha256';
import {bytesToHex} from '@noble/hashes/utils';
import type {Environment} from './contracts.js';
import {DeadlineError,type Deadline} from './ingress-operations.js';
const DOMAIN='distributed-admission-v1' as const,KEY='distributed-admission/state/v1',MAX_TIME=8640000000000000,MAX_FENCE=18446744073709551615n;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export interface AdmissionAuthority {environment:Environment;tenant:string;provider:string;principal:string;source:string;mappingId:string;mappingVersion:number;sourceBinding:string;operation:'ingest_mock_lead'}
export interface AdmissionPolicy {version:1;environment:Environment;domain:typeof DOMAIN;epoch:string;aggregateCap:number;tenantCap:number;sourceCap:number;tenantKeyCap:number;sourceKeyCap:number;recordCap:number;aggregateRate:number;tenantRate:number;sourceRate:number;windowMs:number;reservationTtlMs:number;diagnosticTtlMs:number;controlAttempts:number}
export interface AdmissionContext {authority:AdmissionAuthority;domain:typeof DOMAIN;policyEpoch:string;policyDigest:string;sourceKey:string}
export interface AdmissionTicket {context:AdmissionContext;attempt:string;owner:string;requestDeadline:number;reservationTtlMs:number;diagnosticTtlMs:number;fence:string}
type State='RESERVED'|'ACTIVE'|'QUARANTINED'|'CANCELLED'|'EXPIRED'|'RELEASED';
type TerminalKind='cancelled'|'expired'|'known-not-issued'|'all-issued-terminal';
export interface AdmissionRecord {handle:AdmissionTicket;state:State;reservedAt:number;reservationExpiresAt:number;startedAt:number|null;diagnosticExpiresAt:number|null;terminalAt:number|null;terminalKind:TerminalKind|null}
export type AdmissionMethod='reserve'|'start'|'inspect'|'cancelUnstarted'|'settle'|'quarantine'|'reconcile';
export interface AdmissionRequest {version:1;operation:AdmissionMethod;ticket:AdmissionTicket;payload:Record<string,never>|{kind:'known-not-issued'|'all-issued-terminal';barrierId:string}}
type Denial='aggregate'|'tenant'|'source'|'rate-aggregate'|'rate-tenant'|'rate-source'|'keys'|'records'|'deadline'|'clock'|'ownership'|'policy'|'invalid-state'|'not-terminal'|'not-authorized'|'fence-exhausted'|'state-size';
export type AdmissionResult={tag:'record';record:AdmissionRecord}|{tag:'absent'}|{tag:'denied';reason:Denial;retryAfterSeconds:number|null}|{tag:'fault';code:'invalid-message'|'storage-corrupt'|'unavailable'|'internal'};
export interface AdmissionReply {version:1;operation:AdmissionMethod;ticket:AdmissionTicket;result:AdmissionResult}
interface Bucket {tenant:string;live:number;arrivals:number}
interface SourceBucket extends Bucket {sourceKey:string}
interface PersistentState {version:1;policy:AdmissionPolicy;policyDigest:string;nextFence:string;clockHighWater:number;windowStartedAt:number;aggregateLive:number;aggregateArrivals:number;tenants:Bucket[];sources:SourceBucket[];registry:AdmissionRecord[]}
export interface AdmissionTransaction {get(key:string):Promise<unknown>;put(key:string,value:string):Promise<void>}
export interface AdmissionStorage extends AdmissionTransaction {transaction<T>(callback:(transaction:AdmissionTransaction)=>Promise<T>):Promise<T>}
class Invalid extends Error {constructor(){super('Invalid admission data');}}
function valid(condition:unknown):asserts condition {if(!condition)throw new Invalid();}
/** Descriptor-first copy; no accessor is invoked or projected away. */
function snapshot(input:unknown,depth=0,maxDepth=10):unknown {
 valid(depth<=maxDepth);
 if(input===null||typeof input==='boolean')return input;
 if(typeof input==='string'){valid(/^[\x20-\x7e]*$/.test(input)&&input.length<=65536);return input;}
 if(typeof input==='number'){valid(Number.isSafeInteger(input)&&!Object.is(input,-0));return input;}
 valid(typeof input==='object'&&input!==null);
 const proto=Object.getPrototypeOf(input),keys=Reflect.ownKeys(input),descriptors=Object.getOwnPropertyDescriptors(input);valid(keys.every(k=>typeof k==='string'));
 if(Array.isArray(input)){
  valid(proto===Array.prototype&&input.length<=1024&&keys.length===input.length+1);const out:unknown[]=[];
  for(let i=0;i<input.length;i++){const d=descriptors[String(i)];valid(d&&Object.hasOwn(d,'value')&&d.enumerable);out.push(snapshot(d.value,depth+1,maxDepth));}return out;
 }
 valid(proto===Object.prototype||proto===null);const out:Record<string,unknown>=Object.create(null);
 for(const key of keys as string[]){valid(/^[\x20-\x7e]+$/.test(key));const d=descriptors[key];valid(Object.hasOwn(d,'value')&&d.enumerable);out[key]=snapshot(d.value,depth+1,maxDepth);}return out;
}
function freeze<T>(value:T):Readonly<T>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
function canonical(value:unknown):string {
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 const object=value as Record<string,unknown>;return '{'+Object.keys(object).sort().map(key=>JSON.stringify(key)+':'+canonical(object[key])).join(',')+'}';
}
const hash=(value:string)=>bytesToHex(sha256(new TextEncoder().encode(value))),same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
type Validator=(value:unknown)=>void;
const integer=(min:number,max:number):Validator=>value=>valid(typeof value==='number'&&Number.isSafeInteger(value)&&!Object.is(value,-0)&&value>=min&&value<=max);
const literal=(...values:unknown[]):Validator=>value=>valid(values.includes(value));
const pattern=(regex:RegExp):Validator=>value=>valid(typeof value==='string'&&regex.test(value));
function shape(value:unknown,fields:Record<string,Validator>):void{
 valid(value!==null&&typeof value==='object'&&!Array.isArray(value));const object=value as Record<string,unknown>,keys=Object.keys(object);
 valid(keys.length===Object.keys(fields).length&&keys.every(key=>Object.hasOwn(fields,key)));
 for(const [key,validate] of Object.entries(fields)){valid(Object.hasOwn(object,key));validate(object[key]);}
}
const time=integer(0,MAX_TIME),version=integer(1,Number.MAX_SAFE_INTEGER-1),limit=integer(1,1024),count=integer(0,10240000),duration=integer(1,30000),uuid=pattern(UUID),digest=pattern(/^[0-9a-f]{64}$/),name=pattern(/^[A-Za-z0-9_.:-]{1,128}$/),environment=literal('development','staging');
const fence:Validator=value=>{pattern(/^(0|[1-9][0-9]{0,19})$/)(value);valid(BigInt(value as string)<=MAX_FENCE);};
const policyFields={version:literal(1),environment,domain:literal(DOMAIN),epoch:uuid,aggregateCap:limit,tenantCap:limit,sourceCap:limit,tenantKeyCap:limit,sourceKeyCap:limit,recordCap:limit,aggregateRate:integer(1,10000),tenantRate:integer(1,10000),sourceRate:integer(1,10000),windowMs:integer(1000,60000),reservationTtlMs:duration,diagnosticTtlMs:duration,controlAttempts:integer(1,4)};
const authority:Validator=value=>shape(value,{environment,tenant:uuid,provider:name,principal:name,source:name,mappingId:uuid,mappingVersion:version,sourceBinding:name,operation:literal('ingest_mock_lead')});
const sourceKey=(a:AdmissionAuthority)=>hash('apacely-distributed-source-v1:'+canonical([a.environment,a.provider,a.principal,a.source]));
const context:Validator=value=>{shape(value,{authority,domain:literal(DOMAIN),policyEpoch:uuid,policyDigest:digest,sourceKey:digest});const c=value as AdmissionContext;valid(c.sourceKey===sourceKey(c.authority));};
const ticket:Validator=value=>shape(value,{context,attempt:uuid,owner:pattern(/^[0-9a-f]{32}$/),requestDeadline:time,reservationTtlMs:duration,diagnosticTtlMs:duration,fence});
const nullable=(validator:Validator):Validator=>value=>{if(value!==null)validator(value);};
const record:Validator=value=>{
 shape(value,{handle:ticket,state:literal('RESERVED','ACTIVE','QUARANTINED','CANCELLED','EXPIRED','RELEASED'),reservedAt:time,reservationExpiresAt:time,startedAt:nullable(time),diagnosticExpiresAt:nullable(time),terminalAt:nullable(time),terminalKind:nullable(literal('cancelled','expired','known-not-issued','all-issued-terminal'))});
 const r=value as AdmissionRecord,h=r.handle;valid(h.fence!=='0'&&r.reservedAt+h.reservationTtlMs<=MAX_TIME&&r.reservationExpiresAt===Math.min(h.requestDeadline,r.reservedAt+h.reservationTtlMs));
 if(r.startedAt!==null)valid(r.startedAt>=r.reservedAt&&r.startedAt<r.reservationExpiresAt&&r.startedAt<h.requestDeadline&&r.startedAt+h.diagnosticTtlMs<=MAX_TIME&&r.diagnosticExpiresAt===r.startedAt+h.diagnosticTtlMs);else valid(r.diagnosticExpiresAt===null);
 if(r.state==='RESERVED')valid(r.reservedAt<r.reservationExpiresAt&&r.reservedAt<h.requestDeadline&&r.startedAt===null&&r.terminalAt===null&&r.terminalKind===null);
 if(r.state==='ACTIVE'||r.state==='QUARANTINED')valid(r.startedAt!==null&&r.terminalAt===null&&r.terminalKind===null);
 if(['CANCELLED','EXPIRED','RELEASED'].includes(r.state)){
  valid(r.terminalAt!==null&&r.terminalAt>=r.reservedAt&&(r.startedAt===null||r.terminalAt>=r.startedAt));
  if(r.state==='CANCELLED'||r.state==='EXPIRED')valid(r.startedAt===null&&r.terminalKind===(r.state==='CANCELLED'?'cancelled':'expired'));
  if(r.state==='EXPIRED')valid(r.terminalAt!>=r.reservationExpiresAt);
  if(r.state==='RELEASED')valid(r.reservedAt<r.reservationExpiresAt&&r.reservedAt<h.requestDeadline&&(r.terminalKind==='known-not-issued'||r.terminalKind==='all-issued-terminal'&&r.startedAt!==null));
 }
};
const method=literal('reserve','start','inspect','cancelUnstarted','settle','quarantine','reconcile');
function request(value:unknown):void{
 shape(value,{version:literal(1),operation:method,ticket,payload:()=>{}});const r=value as AdmissionRequest;
 if(r.operation==='settle'||r.operation==='reconcile')shape(r.payload,{kind:literal('known-not-issued','all-issued-terminal'),barrierId:uuid});else shape(r.payload,{});
 if(r.operation==='reserve')valid(r.ticket.fence==='0');if(['start','settle','quarantine','reconcile'].includes(r.operation))valid(r.ticket.fence!=='0');
}
const denials:Denial[]=['aggregate','tenant','source','rate-aggregate','rate-tenant','rate-source','keys','records','deadline','clock','ownership','policy','invalid-state','not-terminal','not-authorized','fence-exhausted','state-size'];
function result(value:unknown):void{
 valid(value&&typeof value==='object');const tag=(value as {tag:unknown}).tag;
 if(tag==='record')shape(value,{tag:literal(tag),record});else if(tag==='absent')shape(value,{tag:literal(tag)});
 else if(tag==='fault')shape(value,{tag:literal(tag),code:literal('invalid-message','storage-corrupt','unavailable','internal')});
 else if(tag==='denied'){shape(value,{tag:literal(tag),reason:literal(...denials),retryAfterSeconds:nullable(integer(1,60))});const r=value as Extract<AdmissionResult,{tag:'denied'}>;valid(r.reason.startsWith('rate-')?r.retryAfterSeconds!==null:r.retryAfterSeconds===null);}else throw new Invalid();
}
const matches=(handle:AdmissionTicket,input:AdmissionTicket)=>same(handle,{...input,fence:input.fence==='0'?handle.fence:input.fence});
function reply(value:unknown):void{
 shape(value,{version:literal(1),operation:method,ticket,result});const r=value as AdmissionReply;
 if(r.result.tag==='absent')valid(r.operation==='inspect');
 if(r.result.tag==='record'){
  const rec=r.result.record;valid(matches(rec.handle,r.ticket));
  if(r.operation==='start'||r.operation==='cancelUnstarted')valid(rec.state!=='RESERVED');
  if(r.operation==='quarantine')valid(!['RESERVED','ACTIVE'].includes(rec.state));
  if(r.operation==='settle'||r.operation==='reconcile')valid(['RELEASED','CANCELLED','EXPIRED'].includes(rec.state));
 }
}
export function encodeMessage(value:AdmissionRequest|AdmissionReply):string {const copy=snapshot(value,0,8);if(Object.hasOwn(copy as object,'result'))reply(copy);else request(copy);const raw=canonical(copy);valid(raw.length<=8192);return raw;}
export function decodeMessage(raw:string,kind:'request'):AdmissionRequest;
export function decodeMessage(raw:string,kind:'reply'):AdmissionReply;
export function decodeMessage(raw:string,kind:'request'|'reply'):AdmissionRequest|AdmissionReply {valid(typeof raw==='string'&&raw.length<=8192);const copy=snapshot(JSON.parse(raw),0,8);if(kind==='request')request(copy);else reply(copy);valid(canonical(copy)===raw);return freeze(copy) as AdmissionRequest|AdmissionReply;}
export function capturePolicy(value:AdmissionPolicy):Readonly<AdmissionPolicy>{const copy=snapshot(value);shape(copy,policyFields);return freeze(copy) as Readonly<AdmissionPolicy>;}
export function createTicket(policy:AdmissionPolicy,a:AdmissionAuthority,requestDeadline:number):AdmissionTicket{
 const p=capturePolicy(policy),copy=snapshot(a);authority(copy);time(requestDeadline);const captured=copy as AdmissionAuthority;valid(captured.environment===p.environment);const owner=new Uint8Array(16);crypto.getRandomValues(owner);
 return freeze({context:{authority:captured,domain:p.domain,policyEpoch:p.epoch,policyDigest:hash(canonical(p)),sourceKey:sourceKey(captured)},attempt:crypto.randomUUID(),owner:bytesToHex(owner),requestDeadline,reservationTtlMs:p.reservationTtlMs,diagnosticTtlMs:p.diagnosticTtlMs,fence:'0'}) as AdmissionTicket;
}
const charged=(r:AdmissionRecord)=>['RESERVED','ACTIVE','QUARANTINED'].includes(r.state);
function validateState(input:unknown,policy:AdmissionPolicy):PersistentState{
 const state=snapshot(input) as PersistentState;
 const array=(validate:Validator):Validator=>value=>{valid(Array.isArray(value)&&value.length<=1024);for(const item of value)validate(item);};
 shape(state,{version:literal(1),policy:value=>shape(value,policyFields),policyDigest:digest,nextFence:fence,clockHighWater:time,windowStartedAt:time,aggregateLive:count,aggregateArrivals:count,tenants:array(value=>shape(value,{tenant:uuid,live:count,arrivals:count})),sources:array(value=>shape(value,{sourceKey:digest,tenant:uuid,live:count,arrivals:count})),registry:array(record)});
 valid(same(policy,state.policy)&&state.policyDigest===hash(canonical(policy))&&state.nextFence!=='0'&&state.clockHighWater>=state.windowStartedAt);
 valid(state.tenants.length<=policy.tenantKeyCap&&state.sources.length<=policy.sourceKeyCap&&state.registry.length<=policy.recordCap);
 const sorted=(values:string[])=>values.every((value,index)=>index===0||values[index-1]<value);
 valid(sorted(state.tenants.map(b=>b.tenant))&&sorted(state.sources.map(b=>b.sourceKey))&&sorted(state.registry.map(r=>r.handle.attempt)));
 const fences=new Set<string>(),tenants=new Map(state.tenants.map(b=>[b.tenant,b])),sources=new Map(state.sources.map(b=>[b.sourceKey,b])),tenantLive=new Map<string,number>(),sourceLive=new Map<string,number>(),tenantArrivals=new Map<string,number>();let live=0;
 for(const r of state.registry){const h=r.handle,c=h.context,a=c.authority;
  valid(a.environment===policy.environment&&c.domain===policy.domain&&c.policyEpoch===policy.epoch&&c.policyDigest===state.policyDigest&&h.reservationTtlMs===policy.reservationTtlMs&&h.diagnosticTtlMs===policy.diagnosticTtlMs&&BigInt(h.fence)<BigInt(state.nextFence)&&!fences.has(h.fence));fences.add(h.fence);
  valid(tenants.has(a.tenant)&&sources.get(c.sourceKey)?.tenant===a.tenant&&r.reservedAt<=state.clockHighWater&&(r.startedAt===null||r.startedAt<=state.clockHighWater)&&(r.terminalAt===null||r.terminalAt<=state.clockHighWater));
  if(charged(r)){live++;tenantLive.set(a.tenant,(tenantLive.get(a.tenant)??0)+1);sourceLive.set(c.sourceKey,(sourceLive.get(c.sourceKey)??0)+1);}
 }
 valid(state.aggregateLive===live&&live<=policy.aggregateCap&&state.aggregateArrivals<=policy.aggregateRate);
 for(const b of state.sources){valid(tenants.has(b.tenant)&&b.live===(sourceLive.get(b.sourceKey)??0)&&b.live<=policy.sourceCap&&b.arrivals<=policy.sourceRate);tenantArrivals.set(b.tenant,(tenantArrivals.get(b.tenant)??0)+b.arrivals);}
 for(const b of state.tenants)valid(b.live===(tenantLive.get(b.tenant)??0)&&b.live<=policy.tenantCap&&b.arrivals<=policy.tenantRate&&b.arrivals===(tenantArrivals.get(b.tenant)??0));
 valid(state.aggregateArrivals===state.tenants.reduce((sum,b)=>sum+b.arrivals,0)&&state.aggregateArrivals===state.sources.reduce((sum,b)=>sum+b.arrivals,0));return state;
}
function decodeState(raw:unknown,policy:AdmissionPolicy):PersistentState{valid(typeof raw==='string'&&raw.length<=65536);const state=validateState(JSON.parse(raw),policy);valid(canonical(state)===raw);return state;}
function encodeState(value:PersistentState,policy:AdmissionPolicy):string {const raw=canonical(validateState(value,policy));valid(raw.length<=65536);return raw;}
/** Conservative encoded upper bound, including every existing owner's longest lifecycle and metadata widths. */
function lifecycleSize(state:PersistentState):number {
 const maximum=10240000;
 return canonical({...state,nextFence:MAX_FENCE.toString(),clockHighWater:MAX_TIME,windowStartedAt:MAX_TIME,aggregateLive:maximum,aggregateArrivals:maximum,
 tenants:state.tenants.map(b=>({...b,live:maximum,arrivals:maximum})),sources:state.sources.map(b=>({...b,live:maximum,arrivals:maximum})),
 registry:state.registry.map(r=>({...r,state:'QUARANTINED',reservedAt:MAX_TIME,reservationExpiresAt:MAX_TIME,startedAt:MAX_TIME,diagnosticExpiresAt:MAX_TIME,terminalAt:MAX_TIME,terminalKind:'all-issued-terminal'}))}).length;
}
/** Explicit fresh local harness bootstrap, never invoked by request handling. */
export async function bootstrapAdmission(storage:AdmissionStorage,input:AdmissionPolicy,now:number):Promise<void>{
 const policy=capturePolicy(input);time(now);
 await storage.transaction(async tx=>{valid(await tx.get(KEY)===undefined);const state:PersistentState={version:1,policy,policyDigest:hash(canonical(policy)),nextFence:'1',clockHighWater:now,windowStartedAt:now,aggregateLive:0,aggregateArrivals:0,tenants:[],sources:[],registry:[]};await tx.put(KEY,encodeState(state,policy));});
}
async function body(message:Request|Response):Promise<string>{
 valid(message.headers.get('content-type')==='application/json'&&!message.headers.has('content-encoding'));const declared=message.headers.get('content-length');if(declared!==null)valid(/^(0|[1-9][0-9]*)$/.test(declared)&&Number(declared)<=8192);
 valid(message.body);const reader=message.body.getReader(),chunks:Uint8Array[]=[];let size=0,reads=0;
 try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;valid(++reads<=8192&&size<=8192);chunks.push(next.value);}}catch(error){await reader.cancel().catch(()=>undefined);throw error;}finally{reader.releaseLock();}
 valid(declared===null||Number(declared)===size);const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}
const status=(r:AdmissionResult)=>r.tag==='denied'?409:r.tag==='fault'?(r.code==='invalid-message'?400:r.code==='unavailable'?503:500):200;
const denied=(reason:Denial,retryAfterSeconds:number|null=null):AdmissionResult=>({tag:'denied',reason,retryAfterSeconds});

/** Only trusted original adapters receive this per-execution observer. */
export interface IssuedObserver {issued(database:object):Readonly<{resolved():void;rejected():void}>}
export interface AdmissionNamespace {idFromName(name:string):unknown;get(id:unknown):{fetch(request:Request):Promise<Response>}}
export interface DistributedOptions {policy:AdmissionPolicy;namespace:AdmissionNamespace;database:object}
export class DistributedError extends Error {constructor(readonly status:number,readonly retryAfter?:number,readonly code:'overloaded'|'rate_limited'|'unavailable'|'internal'=status===429?'rate_limited':status===503?'unavailable':'internal'){super('Distributed admission failure');}}
export interface AdmissionExecution {readonly observer:IssuedObserver;start():Promise<void>;complete():Promise<void>}
export interface CapturedAdmission {readonly database:object;readonly environment:Environment;execution(authority:AdmissionAuthority,deadline:Deadline):AdmissionExecution}
const executionBrand=Symbol('private original execution');
/** No global request registry: ownership evidence lives only in this original execution. */
class PrivateExecution implements AdmissionExecution {
 readonly observer:IssuedObserver;readonly start:()=>Promise<void>;readonly complete:()=>Promise<void>;
 readonly #namespace:AdmissionNamespace;readonly #database:object;readonly #digest:string;readonly #recover:()=>Promise<boolean>;
 constructor(brand:symbol,observer:IssuedObserver,start:()=>Promise<void>,complete:()=>Promise<void>,namespace:AdmissionNamespace,database:object,digest:string,recover:()=>Promise<boolean>){valid(brand===executionBrand);this.observer=observer;this.start=start;this.complete=complete;this.#namespace=namespace;this.#database=database;this.#digest=digest;this.#recover=recover;Object.freeze(this);}
 static async recover(value:unknown,namespace:AdmissionNamespace,database:object,digest:string):Promise<boolean>{if(!(value instanceof PrivateExecution)||!(#namespace in value)||value.#namespace!==namespace||value.#database!==database||value.#digest!==digest)return false;return value.#recover();}
}
/** Separate internal capability; never returned by the ingress admission facade. No remote termination oracle. */
export function captureMaintenance(input:DistributedOptions):Readonly<{reconcile(originalExecution:unknown):Promise<boolean>}>{
 const {namespace,database,policy}=captureConfiguration(input),digest=hash(canonical(policy));
 return Object.freeze({reconcile:(execution:unknown)=>PrivateExecution.recover(execution,namespace,database,digest)});
}

/** Configuration descriptors are captured once; platform receivers are bound, never frozen. */
function captureConfiguration(input:DistributedOptions){
 valid(input&&typeof input==='object'&&(Object.getPrototypeOf(input)===Object.prototype||Object.getPrototypeOf(input)===null));
 const keys=Reflect.ownKeys(input),ds=Object.getOwnPropertyDescriptors(input);valid(keys.length===3&&keys.every(k=>typeof k==='string'&&['policy','namespace','database'].includes(k)));
 for(const k of keys as string[])valid(ds[k].enumerable&&Object.hasOwn(ds[k],'value'));
 const policy=capturePolicy(ds.policy.value!),namespace=ds.namespace.value as AdmissionNamespace,database=ds.database.value as object;
 valid(database&&typeof database==='object'&&namespace);
 const idMethod=namespace.idFromName,getMethod=namespace.get;valid(typeof idMethod==='function'&&typeof getMethod==='function');
 const idFromName=idMethod.bind(namespace),get=getMethod.bind(namespace),stub=get(idFromName(DOMAIN)),fetchMethod=stub.fetch;valid(typeof fetchMethod==='function');const send=fetchMethod.bind(stub);
 return Object.freeze({policy,namespace,database,send});
}
export function captureAdmission(input:DistributedOptions):CapturedAdmission {
 const {policy,namespace,database,send}=captureConfiguration(input);
 return Object.freeze({database,environment:policy.environment,execution(a:AdmissionAuthority,deadline:Deadline):AdmissionExecution {
  const provisional=createTicket(policy,a,deadline.end);let handle:AdmissionTicket=provisional,launched=false,startCalled=false,closed=false,noGrant=false,issued=0,pending=0,uncertain=false;
  const controls=new Set<Promise<AdmissionReply>>();
  const observer:IssuedObserver=Object.freeze({issued(db:object){valid(db===database&&!closed&&launched);issued++;pending++;let done=false;return Object.freeze({resolved(){valid(!done);done=true;pending--;},rejected(){valid(!done);done=true;pending--;uncertain=true;}});}});
  const call=async(operation:AdmissionMethod,payload:AdmissionRequest['payload']={},bounded=true):Promise<AdmissionReply>=>{
   const ticket=operation==='reserve'?provisional:handle;
   const request:AdmissionRequest={version:1,operation,ticket,payload};
   const task=(async()=>{const encoded=encodeMessage(request);for(let attempt=1;;attempt++){let response:Response;try{response=await send(new Request('https://admission.internal/v1/'+operation,{method:'POST',headers:{'content-type':'application/json'},body:encoded,redirect:'manual'}));}catch{throw new DistributedError(500);}
    let decoded:AdmissionReply;try{decoded=decodeMessage(await body(response),'reply');valid(decoded.operation===operation&&same(decoded.ticket,ticket)&&response.status===status(decoded.result));}catch{throw new DistributedError(500);}
    if(decoded.result.tag==='fault'&&decoded.result.code==='unavailable'&&bounded&&attempt<policy.controlAttempts){deadline.check();continue;}
    if(decoded.result.tag==='record')handle=decoded.result.record.handle;return decoded;
   }})();controls.add(task);void task.catch(()=>undefined);
   try{return await (bounded?Promise.race([task,deadline.expired]):task);}finally{void task.then(()=>controls.delete(task),()=>controls.delete(task));}
  };
  const requireRecord=(r:AdmissionReply,state:State)=>{
   if(r.result.tag==='denied'){if(r.operation==='reserve')noGrant=true;const reason=r.result.reason;if(reason==='deadline')throw new DeadlineError();const overloaded=['aggregate','tenant','source','keys','records','state-size','fence-exhausted'].includes(reason);throw new DistributedError(reason.startsWith('rate-')?429:overloaded?503:500,r.result.retryAfterSeconds??undefined,overloaded?'overloaded':undefined);}
   if(r.result.tag==='fault')throw new DistributedError(r.result.code==='unavailable'?503:500);
   valid(r.result.tag==='record'&&r.result.record.state===state);return r.result.record;
  };
  const start=async()=>{valid(!startCalled&&!closed);startCalled=true;deadline.check();requireRecord(await call('reserve'),'RESERVED');valid(!closed);deadline.check();requireRecord(await call('start'),'ACTIVE');valid(!closed);deadline.check();valid(!launched);launched=true;};
  const complete=async()=>{
   if(closed)return;closed=true;
   // Losing control promises remain owned; no late acknowledgement can launch work.
   await Promise.allSettled([...controls]);
   if(!startCalled||noGrant)return;
   try{
    if(handle.fence==='0'){await call('cancelUnstarted',{},false);return;}
    if(pending!==0||uncertain){await call('quarantine',{},false);return;}
    await call('settle',{kind:issued===0?'known-not-issued':'all-issued-terminal',barrierId:crypto.randomUUID()},false);
   }catch{/* A failed control settlement never fabricates release or authorizes another pipeline. */}
  };
  const recover=async():Promise<boolean>=>{
   if(!closed||!startCalled||noGrant||handle.fence==='0'||controls.size!==0)return false;
   if(pending!==0||uncertain){try{await call('quarantine',{},false);}catch{}return false;}
   try{const reply=await call('reconcile',{kind:issued===0?'known-not-issued':'all-issued-terminal',barrierId:crypto.randomUUID()},false);return reply.result.tag==='record'&&reply.result.record.state==='RELEASED';}catch{return false;}
  };
  return new PrivateExecution(executionBrand,observer,start,complete,namespace,database,hash(canonical(policy)),recover);
 }});
}

export class AdmissionCoordinator {
 readonly #storage:AdmissionStorage;readonly #policy:Readonly<AdmissionPolicy>;readonly #clock:()=>number;
 constructor(storage:AdmissionStorage,policy:AdmissionPolicy,clock:()=>number=Date.now){this.#storage=Object.freeze({get:storage.get.bind(storage),put:storage.put.bind(storage),transaction:storage.transaction.bind(storage)});this.#policy=capturePolicy(policy);this.#clock=clock;}
 async fetch(message:Request):Promise<Response>{
  let r:AdmissionRequest;
  try{const url=new URL(message.url);valid(message.method==='POST'&&url.origin==='https://admission.internal'&&!url.search&&!url.hash&&!url.username&&!url.password);r=decodeMessage(await body(message),'request');valid(url.pathname==='/v1/'+r.operation);}catch{return new Response('{"result":{"code":"invalid-message","tag":"fault"},"version":1}',{status:400,headers:{'content-type':'application/json'}});}
  let result:AdmissionResult;
  try{result=await this.#storage.transaction(async tx=>{
   let state:PersistentState;try{state=decodeState(await tx.get(KEY),this.#policy);}catch{return {tag:'fault',code:'storage-corrupt'};}
   const original=canonical(state),h=r.ticket,c=h.context,a=c.authority,p=this.#policy;
   if(a.environment!==p.environment||c.domain!==p.domain||c.policyEpoch!==p.epoch||c.policyDigest!==state.policyDigest||h.reservationTtlMs!==p.reservationTtlMs||h.diagnosticTtlMs!==p.diagnosticTtlMs)return denied('policy');
   let existing=state.registry.find(rec=>rec.handle.attempt===h.attempt);if(existing&&!matches(existing.handle,h))return denied('ownership');
   let now=state.clockHighWater,forward=false;try{const observed=this.#clock();time(observed);if(observed>=state.clockHighWater){now=observed;forward=true;}}catch{/* Retain validated durable time for owned recovery only. */}
   if(!forward&&(r.operation==='reserve'||r.operation==='start'))return denied('clock');
   state.clockHighWater=now;
   if(now>=state.windowStartedAt+p.windowMs){state.windowStartedAt+=Math.floor((now-state.windowStartedAt)/p.windowMs)*p.windowMs;state.aggregateArrivals=0;for(const b of [...state.tenants,...state.sources])b.arrivals=0;}
   for(const rec of state.registry){if(rec.state==='RESERVED'&&now>=rec.reservationExpiresAt){rec.state='EXPIRED';rec.terminalAt=now;rec.terminalKind='expired';}else if(rec.state==='ACTIVE'&&now>=rec.diagnosticExpiresAt!){rec.state='QUARANTINED';}}
   const updateCounts=()=>{const tenants=new Map(state.tenants.map(b=>[b.tenant,b])),sources=new Map(state.sources.map(b=>[b.sourceKey,b]));state.aggregateLive=0;for(const b of [...state.tenants,...state.sources])b.live=0;for(const rec of state.registry)if(charged(rec)){state.aggregateLive++;tenants.get(rec.handle.context.authority.tenant)!.live++;sources.get(rec.handle.context.sourceKey)!.live++;}};updateCounts();
   let outcome:AdmissionResult;
   if(r.operation==='inspect')outcome=existing?{tag:'record',record:existing}:{tag:'absent'};
   else if(r.operation==='reserve'){
    if(existing)outcome={tag:'record',record:existing};else if(now>=h.requestDeadline||now+p.reservationTtlMs>MAX_TIME)outcome=denied('deadline');
    else {
     const tenant=state.tenants.find(b=>b.tenant===a.tenant),source=state.sources.find(b=>b.sourceKey===c.sourceKey),retry=Math.max(1,Math.min(60,Math.ceil((state.windowStartedAt+p.windowMs-now)/1000)));
     if(source&&source.tenant!==a.tenant)outcome=denied('ownership');else if(state.registry.length>=p.recordCap)outcome=denied('records');
     else if((!tenant&&state.tenants.length>=p.tenantKeyCap)||(!source&&state.sources.length>=p.sourceKeyCap))outcome=denied('keys');
     else if(state.aggregateLive>=p.aggregateCap)outcome=denied('aggregate');else if((tenant?.live??0)>=p.tenantCap)outcome=denied('tenant');else if((source?.live??0)>=p.sourceCap)outcome=denied('source');
     else if(state.aggregateArrivals>=p.aggregateRate)outcome=denied('rate-aggregate',retry);else if((tenant?.arrivals??0)>=p.tenantRate)outcome=denied('rate-tenant',retry);else if((source?.arrivals??0)>=p.sourceRate)outcome=denied('rate-source',retry);
     else if(BigInt(state.nextFence)>=MAX_FENCE)outcome=denied('fence-exhausted');else {
      const beforeAllocation=canonical(state);
      if(!tenant)state.tenants.push({tenant:a.tenant,live:0,arrivals:0});if(!source)state.sources.push({sourceKey:c.sourceKey,tenant:a.tenant,live:0,arrivals:0});
      existing={handle:{...h,fence:state.nextFence},state:'RESERVED',reservedAt:now,reservationExpiresAt:Math.min(h.requestDeadline,now+p.reservationTtlMs),startedAt:null,diagnosticExpiresAt:null,terminalAt:null,terminalKind:null};state.nextFence=(BigInt(state.nextFence)+1n).toString();state.registry.push(existing);state.aggregateArrivals++;state.tenants.find(b=>b.tenant===a.tenant)!.arrivals++;state.sources.find(b=>b.sourceKey===c.sourceKey)!.arrivals++;updateCounts();if(lifecycleSize(state)>65536){state=decodeState(beforeAllocation,p);existing=undefined;outcome=denied('state-size');}else outcome={tag:'record',record:existing};
     }
    }
   }else if(r.operation==='start'){
    if(!existing)outcome=denied('ownership');
    else if(existing.state!=='RESERVED')outcome={tag:'record',record:existing};
    else if(now>=h.requestDeadline||now>=existing.reservationExpiresAt||now+h.diagnosticTtlMs>MAX_TIME)outcome=denied('deadline');
    else {existing.state='ACTIVE';existing.startedAt=now;existing.diagnosticExpiresAt=now+h.diagnosticTtlMs;outcome={tag:'record',record:existing};}
   }else if(r.operation==='cancelUnstarted'){
    if(existing){if(existing.state==='RESERVED'){existing.state='CANCELLED';existing.terminalAt=now;existing.terminalKind='cancelled';updateCounts();}outcome={tag:'record',record:existing};}
    else {
     const tenant=state.tenants.find(b=>b.tenant===a.tenant),source=state.sources.find(b=>b.sourceKey===c.sourceKey);
     if(source&&source.tenant!==a.tenant)outcome=denied('ownership');
     else if(h.fence!=='0')outcome=denied('ownership');
     else if(state.registry.length>=p.recordCap)outcome=denied('records');
     else if((!tenant&&state.tenants.length>=p.tenantKeyCap)||(!source&&state.sources.length>=p.sourceKeyCap))outcome=denied('keys');
     else if(BigInt(state.nextFence)>=MAX_FENCE)outcome=denied('fence-exhausted');
     else if(now+p.reservationTtlMs>MAX_TIME)outcome=denied('deadline');
     else {const beforeAllocation=canonical(state);
      if(!tenant)state.tenants.push({tenant:a.tenant,live:0,arrivals:0});if(!source)state.sources.push({sourceKey:c.sourceKey,tenant:a.tenant,live:0,arrivals:0});
      existing={handle:{...h,fence:state.nextFence},state:'CANCELLED',reservedAt:now,reservationExpiresAt:Math.min(h.requestDeadline,now+p.reservationTtlMs),startedAt:null,diagnosticExpiresAt:null,terminalAt:now,terminalKind:'cancelled'};
      state.nextFence=(BigInt(state.nextFence)+1n).toString();state.registry.push(existing);
      if(lifecycleSize(state)>65536){state=decodeState(beforeAllocation,p);existing=undefined;outcome=denied('state-size');}else outcome={tag:'record',record:existing};
     }
    }
   }else if(r.operation==='quarantine'){
    if(!existing)outcome=denied('ownership');else if(existing.state==='RESERVED')outcome=denied('invalid-state');else {if(existing.state==='ACTIVE')existing.state='QUARANTINED';outcome={tag:'record',record:existing};}
   }else if(r.operation==='settle'||r.operation==='reconcile'){
    if(!existing)outcome=denied('ownership');
    else if(!charged(existing))outcome={tag:'record',record:existing};
    else {const evidence=r.payload as {kind:'known-not-issued'|'all-issued-terminal';barrierId:string};
     if(evidence.kind==='all-issued-terminal'&&existing.startedAt===null)outcome=denied('not-terminal');
     else {existing.state='RELEASED';existing.terminalAt=now;existing.terminalKind=evidence.kind;updateCounts();outcome={tag:'record',record:existing};}
    }
   }else outcome=denied('not-authorized');
   state.tenants.sort((a,b)=>a.tenant<b.tenant?-1:1);state.sources.sort((a,b)=>a.sourceKey<b.sourceKey?-1:1);state.registry.sort((a,b)=>a.handle.attempt<b.handle.attempt?-1:1);
   let encoded:string;try{encoded=encodeState(state,p);}catch{return {tag:'fault',code:'internal'};}if(encoded!==original)await tx.put(KEY,encoded);return outcome;
  });}catch{result={tag:'fault',code:'unavailable'};}
  const response:AdmissionReply={version:1,operation:r.operation,ticket:r.ticket,result};return new Response(encodeMessage(response),{status:status(result),headers:{'content-type':'application/json'}});
 }
}
