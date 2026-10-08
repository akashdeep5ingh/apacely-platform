import {Deadline,DeadlineError,OverloadError,RateError,enforceRate,LocalAdmission,localAdmission,localRates,type OperationalOptions} from './ingress-operations.js';
import {ReplayStoreError,type ReplayLedger,type ReplayOutcome} from './replay-ledger.js';
import {sha256} from '@noble/hashes/sha256';
import {bytesToHex} from '@noble/hashes/utils';
import {validateInput,SliceError,utc,trustedEnvironment,type Environment} from './contracts.js';
import {Processor,Registry} from './process-inbound.js';
import type {AcceptanceRepository} from './persistence.js';
import {MappingStoreError,type SourceMappingStore,type SourceMapping} from './source-mappings.js';
export interface VerificationInput {provider:string;method:string;path:string;headers:Headers;body:Uint8Array;body_digest:string;signal?:AbortSignal}
export interface Principal {principal:string;provider:string;source:string;signed_at:string;nonce:string;body_digest:string;method:string;path:string;protocol?:'apacely-synthetic-ingress-hmac-v1';key_id?:string;environment?:Environment}
export type Mapping=SourceMapping;
export type SafeCode='accepted'|'invalid_input'|'unauthenticated'|'forbidden'|'route'|'method'|'conflict'|'too_large'|'media_type'|'unavailable'|'internal'|'deadline'|'overloaded'|'rate_limited';
export interface IngressLog {request_id:string;status:number;code:SafeCode;provider_category:'synthetic'|'other'|'unknown';replay_outcome:ReplayOutcome|'not_claimed';failure_category:Exclude<SafeCode,'accepted'>|'none'}
export interface Dependencies {repo:AcceptanceRepository;now:()=>string;verifier:{readonly protocol?:'apacely-synthetic-ingress-hmac-v1';verify(input:VerificationInput):Promise<Principal|null>};mappings:SourceMappingStore;replay:ReplayLedger;log:(record:IngressLog)=>void}
type DependenciesRate=OperationalOptions['rates'];
/** Reusable local contract only: no Worker entrypoint or public fetch export. */
export class Ingress {
 #dependencies:Dependencies;
 readonly #verifierMode:'legacy'|'hmac'|'invalid';
 #options:Readonly<OperationalOptions>;
 #admission:Readonly<Pick<LocalAdmission,'enter'|'source'>>;
 #rates:DependenciesRate;
 #environment:Environment;#checkDatabase?:()=>Promise<void>;
 constructor(dependencies:Dependencies,options:OperationalOptions={},environment:Environment='development',checkDatabase?:()=>Promise<void>){
  const verifier=dependencies.verifier;
  // Only trusted construction-time configuration selects the protocol, never request/proof data.
  try{this.#verifierMode=!('protocol' in verifier)?'legacy':verifier.protocol==='apacely-synthetic-ingress-hmac-v1'?'hmac':'invalid';}catch{this.#verifierMode='invalid';}
  this.#environment=trustedEnvironment(environment);this.#checkDatabase=checkDatabase;
  this.#options=Object.freeze({...options});
  const rates=options.rates??localRates;this.#rates=Object.freeze({preauth:rates.preauth.bind(rates),authenticated:rates.authenticated.bind(rates)});
  const admission=options.admission??([options.globalLimit,options.sourceLimit,options.maxSources].some(x=>x!==undefined)?new LocalAdmission(options.globalLimit,options.sourceLimit,options.maxSources):localAdmission);
  this.#admission=Object.freeze({enter:admission.enter.bind(admission),source:admission.source.bind(admission)});
  const {repo,mappings,replay,now,log}=dependencies;
  this.#dependencies=Object.freeze({
   repo:Object.freeze({id:repo.id.bind(repo),now:repo.now.bind(repo),assertScope:repo.assertScope.bind(repo),accept:repo.accept.bind(repo),...(repo.replayBinding?{replayBinding:repo.replayBinding.bind(repo)}:{}),...(repo.authorityBinding?{authorityBinding:repo.authorityBinding.bind(repo)}:{})}),
   verifier:Object.freeze({verify:verifier.verify.bind(verifier)}),
   mappings:Object.freeze({resolve:mappings.resolve.bind(mappings),authorityBinding:mappings.authorityBinding.bind(mappings)}),
   replay:Object.freeze({claim:replay.claim.bind(replay),authorityBinding:replay.authorityBinding.bind(replay)}),now,log
  });
 }
 async handle(request:Request,context?:{waitUntil(promise:Promise<unknown>):void}):Promise<Response>{
 const request_id=crypto.randomUUID();let provider_category:IngressLog['provider_category']='unknown',replay_outcome:IngressLog['replay_outcome']='not_claimed';
 const reply=(status:number,code:SafeCode,event_id?:string,retryAfter?:number)=>{
 try{this.#dependencies.log({request_id,status,code,provider_category,replay_outcome,failure_category:code==='accepted'?'none':code});}catch{/* Diagnostics must not change durable acceptance or expose logger failures. */}
 return Response.json(event_id?{request_id,event_id}:{request_id,code},{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff',...(retryAfter?{'retry-after':String(retryAfter)}:{})}});
 };
 let operation:Deadline;try{operation=new Deadline(this.#options.deadlineMs??10000,this.#options.clock);}catch{return reply(500,'internal');}
 // Observe expiry before any synchronous request cancellation or context registration failure.
 void operation.expired.catch(()=>undefined);
 const abort=()=>operation.cancel();request.signal.addEventListener('abort',abort,{once:true});if(request.signal.aborted)abort();
 let releaseGlobal:(()=>void)|undefined,releaseSource:(()=>void)|undefined;
 const work=(async()=>{
 operation.check();if(this.#verifierMode==='invalid')throw new BoundaryError(401,'unauthenticated');releaseGlobal=this.#admission.enter();if(this.#rates)enforceRate(this.#rates.preauth());
 if(this.#checkDatabase){await this.#checkDatabase();operation.check();}
 const d=this.#dependencies,url=new URL(request.url),path=url.pathname;
 if(request.method!=='POST')throw new BoundaryError(405,'method');
 if(/[?#%\\]/.test(request.url)||url.username||url.password||url.search||!/^\/v1\/ingress\/[a-z][a-z0-9_-]{0,31}$/.test(path))throw new BoundaryError(404,'route');
 const provider=path.split('/')[3];provider_category=provider==='synthetic'?'synthetic':'other';
 if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers.get('content-type')??'')||request.headers.has('content-encoding'))throw new BoundaryError(415,'media_type');
 operation.check();const body=await boundedBody(request,operation);operation.check();
 let raw:unknown;
 try{const text=new TextDecoder('utf-8',{fatal:true}).decode(body);rejectDuplicateKeys(text);raw=JSON.parse(text);}catch{throw new BoundaryError(400,'invalid_input');}
 const input=validateInput(raw);
 for(const key of ['source_event_id','source_lead_id','contact_reference'] as const)if(!/^[A-Za-z0-9_.:-]{1,128}$/.test(input[key]))throw new BoundaryError(400,'invalid_input');
 if(input.text.length>4096||input.occurred_at.length>24)throw new BoundaryError(400,'invalid_input');
 const body_digest=bytesToHex(sha256(body));
 operation.check();const verified=await d.verifier.verify({provider,method:request.method,path,headers:request.headers,body:body.slice(),body_digest,signal:operation.signal});operation.check();
 // Capture original own-property presence before snapshotting; never consult inherited proof metadata.
 const hasProtocol=verified!==null&&Object.hasOwn(verified,'protocol'),hasKeyId=verified!==null&&Object.hasOwn(verified,'key_id');
 // Read each own field once (including non-enumerable undefined metadata); getter failures close as internal errors.
 const proof=verified?Object.freeze(Object.fromEntries((['principal','provider','source','signed_at','nonce','body_digest','method','path','protocol','key_id','environment'] as const).map(key=>[key,Object.hasOwn(verified,key)?verified[key]:undefined]))) as unknown as Readonly<Principal>:null;
 if(!proof||proof.provider!==provider||proof.method!==request.method||proof.path!==path||proof.body_digest!==body_digest||!utc(proof.signed_at)||proof.signed_at.length>24||![proof.principal,proof.source,proof.nonce].every(x=>typeof x==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(x)))throw new BoundaryError(401,'unauthenticated');
 if((this.#verifierMode==='hmac'||hasProtocol||hasKeyId)&&proof.protocol===undefined)throw new BoundaryError(401,'unauthenticated');
 if(proof.protocol!==undefined&&(proof.protocol!=='apacely-synthetic-ingress-hmac-v1'||proof.environment!==this.#environment||typeof proof.key_id!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(proof.key_id)))throw new BoundaryError(401,'unauthenticated');
 const age=Date.parse(d.now())-Date.parse(proof.signed_at);
 if(!Number.isFinite(age)||age>=300000||age< -30000)throw new BoundaryError(401,'unauthenticated');
 if(!d.repo.replayBinding||!d.repo.authorityBinding||d.repo.replayBinding()!==d.replay.authorityBinding()||(d.repo.authorityBinding()!==d.mappings.authorityBinding()||d.repo.authorityBinding()!==d.replay.authorityBinding()))throw new BoundaryError(403,'forbidden');
 operation.check();const mappings=await d.mappings.resolve(proof);operation.check();
 if(mappings.length!==1)throw new BoundaryError(403,'forbidden');
 const mapping=Object.freeze({...mappings[0]});
 if(mapping.status!=='active'||!Number.isSafeInteger(mapping.version)||mapping.version<1||mapping.principal!==proof.principal||mapping.provider!==provider||mapping.provider!==proof.provider||mapping.source!==proof.source||mapping.environment!==this.#environment||mapping.operation!=='ingest_mock_lead')throw new BoundaryError(403,'forbidden');
 releaseSource=this.#admission.source(bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([proof.provider,proof.principal,proof.source])))));
 await d.repo.assertScope({tenant_id:mapping.tenant_id,environment:this.#environment});operation.check();
 if(this.#rates)enforceRate(this.#rates.authenticated(Object.freeze({provider:proof.provider,principal:proof.principal,source:proof.source})));operation.check();
 const requestDigest=bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(proof.protocol==='apacely-synthetic-ingress-hmac-v1'?['apacely-synthetic-nonce-binding-v1',this.#environment,proof.provider,proof.principal,proof.source,proof.key_id,proof.method,proof.path,proof.signed_at,proof.nonce,proof.body_digest,mapping.id,mapping.version,mapping.tenant_id,mapping.source_binding,mapping.operation]:[request.method,path,proof.signed_at,body_digest,mapping.id,mapping.version,mapping.tenant_id,mapping.source_binding]))));
 operation.check();const claim=await d.replay.claim({authority:mapping,nonce:proof.nonce,fingerprint:requestDigest,signed_at:proof.signed_at},operation);operation.check();replay_outcome=claim.outcome;
 if(claim.outcome==='conflict')throw new BoundaryError(409,'conflict');
 if(claim.outcome==='expired')throw new BoundaryError(401,'unauthenticated');
 if(!claim.admission)throw new BoundaryError(500,'internal');
 const guardedRepo:AcceptanceRepository={...d.repo,accept:(scope,plan,...rest)=>{operation.check();return d.repo.accept(scope,store=>{operation.check();const result=plan(store);operation.check();return result;},...rest);}};
 const processor=new Processor(guardedRepo,new Registry([[mapping.source_binding,mapping.tenant_id] as const],this.#environment));
 const outcome=await processor.process({environment:this.#environment,source_binding:mapping.source_binding,operation:'ingest_mock_lead'},input,mapping,claim.admission);
 operation.check();return outcome.event.event_id;
 })().finally(()=>{releaseSource?.();releaseGlobal?.();});
 // Observe late rejection and retain the actual pipeline (including permit release), not only its response race.
 const settled=work.then(()=>undefined,()=>undefined);
 try {
 // Registration failures are internal composition errors, not deadline responses.
 try{context?.waitUntil(settled);}catch{operation.cancel();return reply(500,'internal');}
 const event=await Promise.race([work,operation.expired]);operation.check();return reply(200,'accepted',event);}
 catch(error){
 if(error instanceof DeadlineError)return reply(504,'deadline');
 if(error instanceof OverloadError)return reply(503,'overloaded');
 if(error instanceof RateError)return reply(429,'rate_limited',undefined,error.retryAfter);
 const status=error instanceof MappingStoreError||error instanceof ReplayStoreError?(error.code==='unavailable'?503:error.code==='denied'?403:500):error instanceof BoundaryError?error.status:error instanceof SliceError&&error.code==='expired'?401:error instanceof SliceError&&error.code==='context'?403:error instanceof SliceError&&error.code==='validation'?400:error instanceof SliceError&&error.code==='conflict'?409:error instanceof SliceError&&error.code==='retry_exhausted'?503:500;
 const code=({400:'invalid_input',401:'unauthenticated',403:'forbidden',404:'route',405:'method',409:'conflict',413:'too_large',415:'media_type',503:'unavailable'} as Record<number,SafeCode>)[status]??'internal';
 return reply(status,code);
 }finally{operation.close();request.signal.removeEventListener('abort',abort);}
 }
}
class BoundaryError extends Error {constructor(public status:number,public code:string){super(code);}}
async function boundedBody(request:Request,operation:Deadline):Promise<Uint8Array>{
 const chunks:Uint8Array[]=[];let size=0,reads=0;
 const reader=request.body?.getReader();if(!reader)throw new BoundaryError(400,'invalid_input');
 let cancellation:Promise<void>|undefined;
 const cancel=()=>{cancellation??=reader.cancel().catch(()=>undefined);};operation.signal.addEventListener('abort',cancel,{once:true});
 try{for(;;){operation.check();const {done,value}=await reader.read().catch(()=>{throw new BoundaryError(400,'invalid_input');});operation.check();if(done)break;if(++reads>16384){cancel();throw new BoundaryError(400,'invalid_input');}size+=value.byteLength;if(size>16384){cancel();throw new BoundaryError(413,'too_large');}chunks.push(value.slice());}}finally{operation.signal.removeEventListener('abort',cancel);try{await cancellation;}finally{reader.releaseLock();}}
 const body=new Uint8Array(size);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength;}return body;
}
/** Inspect decoded property names before JSON.parse's last-key-wins behavior. */
function rejectDuplicateKeys(text:string):void{
 const stack:Array<Set<string>|null>=[];
 const tokens=text.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g)??[];
 for(let i=0;i<tokens.length;i++){
 const token=tokens[i];if(token==='{')stack.push(new Set());else if(token==='[')stack.push(null);else if(token==='}'||token===']')stack.pop();
 else if(token.startsWith('"')&&tokens[i+1]===':'){const keys=stack.at(-1),key=JSON.parse(token) as string;if(keys?.has(key))throw new BoundaryError(400,'invalid_input');keys?.add(key);}
 if(stack.length>4)throw new BoundaryError(400,'invalid_input');
 }
}
