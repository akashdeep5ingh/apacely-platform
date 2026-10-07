import {sha256} from '@noble/hashes/sha256';
import {bytesToHex} from '@noble/hashes/utils';
import {validateInput,SliceError,utc} from './contracts.js';
import {Processor,Registry} from './process-inbound.js';
import type {AcceptanceRepository} from './persistence.js';
import {MappingStoreError,type SourceMappingStore,type SourceMapping} from './source-mappings.js';
export interface VerificationInput {provider:string;method:string;path:string;headers:Headers;body:Uint8Array;body_digest:string}
export interface Principal {principal:string;provider:string;source:string;signed_at:string;nonce:string;body_digest:string;method:string;path:string}
export type Mapping=SourceMapping;
export interface Dependencies {repo:AcceptanceRepository;now:()=>string;verifier:{verify(input:VerificationInput):Promise<Principal|null>};mappings:SourceMappingStore;replay:{bind(key:string,digest:string):Promise<boolean>};log:(record:{request_id:string;status:number;code:string})=>void}
/** Reusable local contract only: no Worker entrypoint or public fetch export. */
export class Ingress {
 #dependencies:Dependencies;
 constructor(dependencies:Dependencies){
  const {repo,verifier,mappings,replay,now,log}=dependencies;
  this.#dependencies=Object.freeze({
   repo:Object.freeze({id:repo.id.bind(repo),now:repo.now.bind(repo),assertScope:repo.assertScope.bind(repo),accept:repo.accept.bind(repo),...(repo.authorityBinding?{authorityBinding:repo.authorityBinding.bind(repo)}:{})}),
   verifier:Object.freeze({verify:verifier.verify.bind(verifier)}),
   mappings:Object.freeze({resolve:mappings.resolve.bind(mappings),authorityBinding:mappings.authorityBinding.bind(mappings)}),
   replay:Object.freeze({bind:replay.bind.bind(replay)}),now,log
  });
 }
 async handle(request:Request):Promise<Response>{
 const request_id=crypto.randomUUID();
 const reply=(status:number,code:string,event_id?:string)=>{
 try{this.#dependencies.log({request_id,status,code});}catch{/* Diagnostics must not change durable acceptance or expose logger failures. */}
 return Response.json(event_id?{request_id,event_id}:{request_id,code},{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
 };
 try {
 const d=this.#dependencies,url=new URL(request.url),path=url.pathname;
 if(request.method!=='POST')throw new BoundaryError(405,'method');
 if(url.search||!/^\/v1\/ingress\/[a-z][a-z0-9_-]{0,31}$/.test(path))throw new BoundaryError(404,'route');
 const provider=path.split('/')[3];
 if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers.get('content-type')??'')||request.headers.has('content-encoding'))throw new BoundaryError(415,'media_type');
 const body=await boundedBody(request);
 let raw:unknown;
 try{const text=new TextDecoder('utf-8',{fatal:true}).decode(body);rejectDuplicateKeys(text);raw=JSON.parse(text);}catch{throw new BoundaryError(400,'invalid_input');}
 const input=validateInput(raw);
 for(const key of ['source_event_id','source_lead_id','contact_reference'] as const)if(!/^[A-Za-z0-9_.:-]{1,128}$/.test(input[key]))throw new BoundaryError(400,'invalid_input');
 if(input.text.length>4096||input.occurred_at.length>24)throw new BoundaryError(400,'invalid_input');
 const body_digest=bytesToHex(sha256(body));
 const verified=await d.verifier.verify({provider,method:request.method,path,headers:request.headers,body:body.slice(),body_digest});
 const proof=verified?Object.freeze({...verified}):null;
 if(!proof||proof.provider!==provider||proof.method!==request.method||proof.path!==path||proof.body_digest!==body_digest||!utc(proof.signed_at)||proof.signed_at.length>24||![proof.principal,proof.source,proof.nonce].every(x=>typeof x==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(x)))throw new BoundaryError(401,'unauthenticated');
 const age=Date.parse(d.now())-Date.parse(proof.signed_at);
 if(!Number.isFinite(age)||age>300000||age< -30000)throw new BoundaryError(401,'unauthenticated');
 if(!d.repo.authorityBinding||d.repo.authorityBinding()!==d.mappings.authorityBinding())throw new BoundaryError(403,'forbidden');
 const mappings=await d.mappings.resolve(proof);
 if(mappings.length!==1)throw new BoundaryError(403,'forbidden');
 const mapping=Object.freeze({...mappings[0]});
 if(mapping.status!=='active'||!Number.isSafeInteger(mapping.version)||mapping.version<1||mapping.principal!==proof.principal||mapping.provider!==provider||mapping.provider!==proof.provider||mapping.source!==proof.source||mapping.environment!=='development'||mapping.operation!=='ingest_mock_lead')throw new BoundaryError(403,'forbidden');
 await d.repo.assertScope({tenant_id:mapping.tenant_id,environment:'development'});
 const replayKey=JSON.stringify(['development',proof.provider,proof.principal,proof.source,proof.nonce]);
 const requestDigest=bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([request.method,path,proof.signed_at,body_digest,mapping.id,mapping.version,mapping.tenant_id,mapping.source_binding]))));
 if(!await d.replay.bind(replayKey,requestDigest))throw new BoundaryError(409,'conflict');
 const processor=new Processor(d.repo,new Registry([[mapping.source_binding,mapping.tenant_id] as const]));
 const outcome=await processor.process({environment:'development',source_binding:mapping.source_binding,operation:'ingest_mock_lead'},input,mapping);
 return reply(200,'accepted',outcome.event.event_id);
 }catch(error){
 const status=error instanceof MappingStoreError?(error.code==='unavailable'?503:error.code==='denied'?403:500):error instanceof BoundaryError?error.status:error instanceof SliceError&&error.code==='context'?403:error instanceof SliceError&&error.code==='validation'?400:error instanceof SliceError&&error.code==='conflict'?409:error instanceof SliceError&&error.code==='retry_exhausted'?503:500;
 const code=({400:'invalid_input',401:'unauthenticated',403:'forbidden',404:'route',405:'method',409:'conflict',413:'too_large',415:'media_type',503:'unavailable'} as Record<number,string>)[status]??'internal';
 return reply(status,code);
 }
 }
}
class BoundaryError extends Error {constructor(public status:number,public code:string){super(code);}}
async function boundedBody(request:Request):Promise<Uint8Array>{
 const chunks:Uint8Array[]=[];let size=0;
 const reader=request.body?.getReader();if(!reader)throw new BoundaryError(400,'invalid_input');
 try{for(;;){const {done,value}=await reader.read().catch(()=>{throw new BoundaryError(400,'invalid_input');});if(done)break;size+=value.byteLength;if(size>16384){await reader.cancel();throw new BoundaryError(413,'too_large');}chunks.push(value);}}finally{reader.releaseLock();}
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
