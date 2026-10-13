import {readFileSync} from 'node:fs';
import {initializeFreshAdmission,validateSealedAdmission} from '../src/staging-coordinator.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {AdmissionCoordinator,bootstrapAdmission,createTicket,encodeMessage,decodeMessage,type AdmissionStorage,type AdmissionTicket,type AdmissionRequest} from '../src/distributed-admission.js';
import {qualificationStorageCapability,QUALIFICATION_PROFILES as profiles} from '../src/qualification/policies.js';
if(!globalThis.crypto)Object.defineProperty(globalThis,'crypto',{value:webcrypto});
const STATE='distributed-admission/state/v1',SEAL='distributed-admission/storage-budget/v1';
class Memory implements AdmissionStorage {
 values=new Map<string,string>();writes=0;interrupt=false;
 sql={exec:()=>[]};
 async list(options:{limit:number}){return new Map([...this.values].slice(0,options.limit));}
 async get(k:string){return this.values.get(k);}
 async put(k:string,v:string){this.values.set(k,v);this.writes++;if(this.interrupt&&k===SEAL)throw Error('interrupted');}
 async transaction<T>(fn:(tx:Memory)=>Promise<T>):Promise<T>{const before=new Map(this.values);try{return await fn(this);}catch(e){this.values=before;throw e;}}
}
const authority=(source='one')=>({environment:'staging' as const,tenant:'20000000-0000-4000-8000-000000000001',provider:'p'.repeat(128),principal:'q'.repeat(128),source,sourceBinding:'b'.repeat(128),mappingId:'30000000-0000-4000-8000-000000000001',mappingVersion:Number.MAX_SAFE_INTEGER-1,operation:'ingest_mock_lead' as const});
async function send(core:AdmissionCoordinator,ticket:AdmissionTicket,operation:AdmissionRequest['operation']='reserve'){
 const payload:AdmissionRequest['payload']=operation==='settle'||operation==='reconcile'?{kind:'all-issued-terminal' as const,barrierId:'50000000-0000-4000-8000-000000000001'}:{};
 const response=await core.fetch(new Request('https://admission.internal/v1/'+operation,{method:'POST',headers:{'content-type':'application/json'},body:encodeMessage({version:1,operation,ticket,payload})}));
 return JSON.parse(JSON.stringify(decodeMessage(await response.text(),'reply').result)) as ReturnType<typeof decodeMessage>['result'];
}
test('original fixed capability atomically seals fresh storage; default rejects even small qualified state',async()=>{
 const m=await import('../src/qualification/policies.js');assert.equal(typeof m.qualificationStorageCapability,'function','fixed storage capability must exist');
 const p=profiles.sourceKeys128,cap=m.qualificationStorageCapability(p,p.namespace,'sqlite');const s=new Memory();
 await bootstrapAdmission(s,p.policy,1000,cap);assert.equal(s.values.size,2);const seal=JSON.parse(s.values.get(SEAL)!);assert.equal(seal.maxStateChars,262144);assert.equal(seal.policyDigest,p.digest);assert.equal(seal.namespace,p.namespace);
 const before=[...s.values];assert.deepEqual(await send(new AdmissionCoordinator(s,p.policy,()=>1000),createTicket(p.policy,authority(),11000)),{tag:'fault',code:'storage-corrupt'});assert.deepEqual([...s.values],before);
 await assert.rejects(bootstrapAdmission(s,p.policy,1000,cap));await assert.rejects(bootstrapAdmission(s,p.policy,1000));assert.deepEqual([...s.values],before);
 const interrupted=new Memory();interrupted.interrupt=true;await assert.rejects(bootstrapAdmission(interrupted,p.policy,1000,cap));assert.equal(interrupted.values.size,0);
});
test('qualified absent cancellations cross baseline bound and survive restart',async()=>{
 const p=profiles.sourceKeys128,cap=qualificationStorageCapability(p,p.namespace,'sqlite'),s=new Memory();await bootstrapAdmission(s,p.policy,1000,cap);
 let core=new AdmissionCoordinator(s,p.policy,()=>1000,cap);
 for(let i=0;i<128;i++){const result=await send(core,createTicket(p.policy,authority(String(i).padStart(128,'s')),11000),'cancelUnstarted');assert.equal(result.tag,'record',String(i));}
 assert.ok(s.values.get(STATE)!.length>65536);assert.ok(s.values.get(STATE)!.length<262144);
 core=new AdmissionCoordinator(s,p.policy,()=>1000,cap);
 assert.equal((await send(core,createTicket(p.policy,authority('new'),11000),'inspect')).tag,'absent');
 assert.equal((await send(core,createTicket(p.policy,authority('new'),11000),'cancelUnstarted')).tag,'denied');
});
test('qualified sealed validator requires exactly state birth and matching seal',async()=>{
 for(const p of Object.values(profiles)){
 const cap=qualificationStorageCapability(p,p.namespace,'sqlite'),s=new Memory();
 await initializeFreshAdmission(s,1000,p.policy,cap);assert.equal(s.values.size,3);
 await validateSealedAdmission(s,p.policy,cap);await assert.rejects(validateSealedAdmission(s,p.policy));
 const before=[...s.values];await assert.rejects(initializeFreshAdmission(s,1000,p.policy,cap));assert.deepEqual([...s.values],before);
 for(const mutate of [(m:Map<string,string>)=>m.delete(SEAL),(m:Map<string,string>)=>m.set(SEAL,'{}'),(m:Map<string,string>)=>m.set('extra','1'),(m:Map<string,string>)=>m.delete(STATE)]){
 s.values=new Map(before);mutate(s.values);const corrupt=[...s.values];await assert.rejects(validateSealedAdmission(s,p.policy,cap));assert.deepEqual([...s.values],corrupt);
 } }
});
test('all four fixed artifact pairs explicitly wire the same fixed capability through birth validation and core',()=>{
 for(const name of ['contention16','capacity16-source4','source-keys128','source-rate100']){
 const bootstrap=readFileSync(`src/qualification/artifacts/${name}-bootstrap.ts`,'utf8'),sealed=readFileSync(`src/qualification/artifacts/${name}-sealed.ts`,'utf8');
 for(const code of [bootstrap,sealed])assert.match(code,/const capability=fixedStorageCapability\(policy,'sqlite'\)/);
 assert.match(bootstrap,/initializeFreshAdmission\(this.ctx.storage,Date.now\(\),policy,capability\)/);
 assert.match(bootstrap,/validateSealedAdmission\(this.ctx.storage,policy,capability\)/);
 assert.match(sealed,/new AdmissionCoordinator\(admissionStorage\(ctx.storage\),policy,Date.now,capability\)/);
 assert.match(sealed,/validateSealedAdmission\(ctx.storage,policy,capability\)/);
 }
});
function canonical(value:any):string {if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';}
test('identity inputs reject clones proxies getters wrong namespace backing and foreign policy before storage',async()=>{
 const p=profiles.sourceKeys128,cap=qualificationStorageCapability(p,p.namespace,'sqlite'),s=new Memory();let reads=0;
 const getter={get policy(){reads++;throw Error('accessor');}},proxy=new Proxy(cap,{get(){reads++;throw Error('trap');}});
 for(const input of [{...p},getter,'sourceKeys128',null])assert.throws(()=>qualificationStorageCapability(input,p.namespace,'sqlite'));
 for(const input of [{}, {...cap},proxy,262144,'262144',getter]){assert.throws(()=>new AdmissionCoordinator(s,p.policy,()=>1000,input as any));await assert.rejects(bootstrapAdmission(s,p.policy,1000,input as any));}
 assert.throws(()=>qualificationStorageCapability(p,'other','sqlite'));assert.throws(()=>qualificationStorageCapability(p,p.namespace,'kv'));
 assert.throws(()=>new AdmissionCoordinator(s,profiles.contention16.policy,()=>1000,cap));assert.equal(reads,0);assert.equal(s.writes,0);
});
test('every seal mutation fails closed without repair on every core transaction',async()=>{
 const p=profiles.sourceKeys128,cap=qualificationStorageCapability(p,p.namespace,'sqlite'),s=new Memory();await bootstrapAdmission(s,p.policy,1000,cap);const original=new Map(s.values),seal=JSON.parse(s.values.get(SEAL)!);
 for(const raw of [undefined,'{}',seal+' ',...Object.entries({maxStateChars:65536,namespace:'other',policyDigest:'0'.repeat(64),version:2,representationVersion:2,extra:1}).map(([k,v])=>JSON.stringify({...seal,[k]:v})),JSON.stringify({...seal,maxStateChars:262145})]){
 s.values=new Map(original);if(raw===undefined)s.values.delete(SEAL);else s.values.set(SEAL,raw);const before=[...s.values],writes=s.writes;
 assert.deepEqual(await send(new AdmissionCoordinator(s,p.policy,()=>1000,cap),createTicket(p.policy,authority(),11000)),{tag:'fault',code:'storage-corrupt'});assert.equal(s.writes,writes);assert.deepEqual([...s.values],before);
 await assert.rejects(bootstrapAdmission(s,p.policy,1000,cap));assert.deepEqual([...s.values],before);
 }
 s.values=new Map([[SEAL,original.get(SEAL)!]]);await assert.rejects(bootstrapAdmission(s,p.policy,1000,cap));assert.equal(s.values.size,1);
});
test('oversized and noncanonical raw state rejects without writes in both budgets',async()=>{
 const p=profiles.sourceKeys128,cap=qualificationStorageCapability(p,p.namespace,'sqlite');
 for(const capability of [undefined,cap]){
 const s=new Memory();await bootstrapAdmission(s,p.policy,1000,capability);const initial=s.values.get(STATE)!;
 for(const raw of ['x'.repeat(capability?262145:65537),initial+' ',initial.replace('"version":1','"version":2')]){
 s.values.set(STATE,raw);const writes=s.writes;assert.deepEqual(await send(new AdmissionCoordinator(s,p.policy,()=>1000,capability),createTicket(p.policy,authority(),11000)),{tag:'fault',code:'storage-corrupt'});assert.equal(s.writes,writes);assert.equal(s.values.get(STATE),raw);
 }
 }
});
test('default 65536 denies both allocation paths with maximum authority and retains owned terminal recovery',async()=>{
 const p=profiles.sourceKeys128;
 for(const operation of ['reserve','cancelUnstarted'] as const){
 const s=new Memory();await bootstrapAdmission(s,p.policy,1000);const core=new AdmissionCoordinator(s,p.policy,()=>1000);let owner:AdmissionTicket|undefined,active:AdmissionTicket|undefined,denial:any;
 for(let i=0;i<128;i++){
 const ticket=createTicket(p.policy,authority(String(i).padStart(128,'s')),11000),before=s.values.get(STATE)!;const result=await send(core,ticket,operation);
 if(result.tag==='denied'){denial=result;assert.equal(s.values.get(STATE),before);break;}assert.equal(result.tag,'record');if(result.tag==='record'){owner=result.record.handle;if(operation==='reserve'){assert.equal((await send(core,owner,'start')).tag,'record');if(i===0)active=owner;else assert.equal((await send(core,owner,'settle')).tag,'record');}}
 }
 assert.equal(denial.reason,'state-size');assert.ok(s.values.get(STATE)!.length<=65536);assert.ok(owner);assert.equal((await send(core,owner!,'inspect')).tag,'record');assert.equal((await send(core,owner!,'reconcile')).tag,'record');if(active){const length=JSON.parse(s.values.get(STATE)!).registry.length;assert.equal((await send(core,active,'quarantine')).tag,'record');assert.equal(JSON.parse(s.values.get(STATE)!).aggregateLive,1);assert.equal((await send(core,active,'settle')).tag,'record');assert.equal(JSON.parse(s.values.get(STATE)!).registry.length,length);assert.equal(JSON.parse(s.values.get(STATE)!).aggregateLive,0);}
 }
});
test('bootstrap captures original storage methods policy and capability synchronously before awaiting',async()=>{
 const p=profiles.sourceKeys128,cap=qualificationStorageCapability(p,p.namespace,'sqlite'),s=new Memory(),mutable={...p.policy};let proceed!:()=>void;
 const gate=new Promise<void>(r=>proceed=r),transaction=s.transaction.bind(s);s.transaction=async fn=>{await gate;return transaction(fn);};
 const boot=bootstrapAdmission(s,mutable,1000,cap);mutable.recordCap=1;proceed();await boot;
 assert.equal(JSON.parse(s.values.get(STATE)!).policy.recordCap,p.policy.recordCap);assert.equal(JSON.parse(s.values.get(SEAL)!).maxStateChars,262144);
 const facade={get:s.get.bind(s),put:s.put.bind(s),transaction:s.transaction.bind(s)};
 const core=new AdmissionCoordinator(facade,p.policy,()=>1000,cap);facade.get=async()=>undefined;facade.put=async()=>{throw Error('replacement');};facade.transaction=async()=>{throw Error('replacement');};
 assert.equal((await send(core,createTicket(p.policy,authority(),11000))).tag,'record');
});
for(const p of Object.values(profiles))test(`${p.name}: full record capacity maximum widths preserves all lifecycle states and finite history`,async()=>{
 const cap=qualificationStorageCapability(p,p.namespace,'sqlite'),s=new Memory();let now=8640000000000000-60000;await bootstrapAdmission(s,p.policy,now,cap);
 const seeded=JSON.parse(s.values.get(STATE)!);seeded.nextFence=(18446744073709551615n-1000n).toString();s.values.set(STATE,canonical(seeded));
 const core=new AdmissionCoordinator(s,p.policy,()=>now,cap),held:AdmissionTicket[]=[];
 for(let i=0;i<p.policy.recordCap;i++){
 const a={...authority(String(i%p.policy.sourceKeyCap).padStart(128,'s')),tenant:`20000000-0000-4000-8000-${String(i%Math.min(p.policy.sourceKeyCap,p.policy.tenantKeyCap)+1).padStart(12,'0')}`},result=await send(core,createTicket(p.policy,a,8640000000000000),i<3?'reserve':'cancelUnstarted');
 assert.equal(result.tag,'record',`${i}: ${JSON.stringify(result)}`);if(result.tag==='record'&&i<3)held.push(result.record.handle);
 }
 assert.equal((await send(core,held[0],'start')).tag,'record');assert.equal((await send(core,held[2],'cancelUnstarted')).tag,'record');
 const full=JSON.parse(s.values.get(STATE)!);assert.equal(full.registry.length,p.policy.recordCap);assert.equal(full.nextFence,(18446744073709551615n-1000n+BigInt(p.policy.recordCap)).toString());
 assert.equal((await send(core,createTicket(p.policy,authority(),8640000000000000),'cancelUnstarted')).tag,'denied');
 now+=31000;assert.equal((await send(core,held[0],'inspect')).tag,'record');const aged=JSON.parse(s.values.get(STATE)!);assert.equal(aged.registry.find((r:any)=>r.handle.attempt===held[0].attempt).state,'QUARANTINED');assert.equal(aged.registry.find((r:any)=>r.handle.attempt===held[1].attempt).state,'EXPIRED');assert.equal(aged.aggregateLive,1);
 assert.equal((await send(core,held[0],'reconcile')).tag,'record');
 for(let i=0;i<3;i++)assert.equal((await send(new AdmissionCoordinator(s,p.policy,()=>now,cap),held[0],'inspect')).tag,'record');
 const terminal=JSON.parse(s.values.get(STATE)!);assert.equal(terminal.registry.length,p.policy.recordCap);assert.equal(terminal.aggregateLive,0);assert.equal(terminal.registry.find((r:any)=>r.handle.attempt===held[0].attempt).state,'RELEASED');assert.ok(s.values.get(STATE)!.length<=262144);assert.equal(terminal.sources.length,p.policy.sourceKeyCap);assert.equal(terminal.tenants.length,p.policy.tenantKeyCap);console.info('maximum-width state',p.name,s.values.get(STATE)!.length);
});
// Actual runtime oracle registers only in the explicitly owned loopback run; ordinary offline unit runs never start an emulator.
if(process.env.APACELY_HTTP_EMULATOR_OWNER==='parent-serial-approved')test('actual SQLite: all fixed pairs restart with three keys and corruption and atomic interrupted birth never repair',async()=>{
 assert.equal(process.versions.node,'22.23.3');assert.equal(process.env.MINIFLARE_ASSERT_BODIES_CONSUMED,'true');assert.equal(process.env.APACELY_HTTP_EMULATOR_OWNER,'parent-serial-approved');
 const {build}=await import('esbuild'),{mkdir,mkdtemp}=await import('node:fs/promises');
 const {Miniflare,convertV4MiniflareOptions}=await import('../node_modules/wrangler/node_modules/miniflare/dist/src/index.js');
 const root='/root/apacely-staging-evidence/phase4/capacity/recovery/sqlite';await mkdir(root,{recursive:true,mode:0o700});
 for(const [name,key] of [['contention16','contention16'],['capacity16-source4','capacity16Source4'],['source-keys128','sourceKeys128'],['source-rate100','sourceRate100']] as const){
 const persist=await mkdtemp(root+'/'+name+'-');
 async function harness(mode:'bootstrap'|'sealed'){
 const code=(await build({stdin:{resolveDir:process.cwd(),contents:`Date.now=()=>1000;
 import {WorkerEntrypoint} from 'cloudflare:workers';
 import {StagingAdmissionCoordinator as Base} from './src/qualification/artifacts/${name}-${mode}.ts';
 import {initializeFreshAdmission} from './src/staging-coordinator.ts';
 import {${key} as policy,fixedStorageCapability} from './src/qualification/artifacts/fixed-policies.ts';
 export class StagingAdmissionCoordinator extends Base {
 async snapshot(){return JSON.stringify([...await this.ctx.storage.list()]);}
 async corrupt(){await this.ctx.storage.put('distributed-admission/storage-budget/v1','{}');}
 async interrupted(){const s=this.ctx.storage;try{await s.transaction(async tx=>{const facade={sql:s.sql,list:tx.list.bind(tx),get:tx.get.bind(tx),put:tx.put.bind(tx),transaction:fn=>fn(tx)};await initializeFreshAdmission(facade,1000,policy,fixedStorageCapability(policy,'sqlite'));throw Error('injected after all writes');});return false;}catch{return true;}}
 }
 export default class extends WorkerEntrypoint {
 #target(){return this.env.DO.get(this.env.DO.idFromName('distributed-admission-v1'));}
 async birth(){try{await this.#target().initializeOnce();return true;}catch{return false;}}
 async snapshot(){return this.#target().snapshot();}
 async corrupt(){await this.#target().corrupt();}
 async interrupted(){return this.#target().interrupted();}
 fetch(request){return this.#target().fetch(request);}
 }`},bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers']})).outputFiles[0].text;
 const options=convertV4MiniflareOptions({host:'127.0.0.1',cf:false,workers:[{name:'fixed',modules:true,script:code,compatibilityDate:'2025-07-18',durableObjects:{DO:{className:'StagingAdmissionCoordinator',useSQLite:true}},outboundService:()=>{throw Error('network forbidden');}}]});
 const mf=new Miniflare({...options,resourcePersistencePath:persist});try{await mf.ready;}catch(error){await mf.dispose();throw error;}const worker=await mf.getWorker('fixed');
 const rawRpc=worker as typeof worker & {birth():Promise<boolean>;snapshot():Promise<string>;corrupt():Promise<void>;interrupted():Promise<boolean>};
 const rpc={birth:()=>rawRpc.birth(),snapshot:async()=>JSON.parse(await rawRpc.snapshot()) as [string,string][],corrupt:()=>rawRpc.corrupt(),interrupted:()=>rawRpc.interrupted()};return {mf,rpc};
 }
 let h=await harness('bootstrap');
 try{
 assert.equal(await h.rpc.interrupted(),true);assert.deepEqual(await h.rpc.snapshot(),[]);
 assert.equal(await h.rpc.birth(),true);const born=await h.rpc.snapshot();assert.equal(born.length,3);assert.equal(await h.rpc.birth(),false);assert.deepEqual(await h.rpc.snapshot(),born);
 await h.mf.dispose();h=await harness('sealed');assert.deepEqual(await h.rpc.snapshot(),born);
 const p=profiles[key];let held:AdmissionTicket|undefined;
 async function request(ticket:AdmissionTicket,operation:AdmissionRequest['operation']){
 const response=await h.mf.dispatchFetch('https://admission.internal/v1/'+operation,{method:'POST',headers:{'content-type':'application/json'},body:encodeMessage({version:1,operation,ticket,payload:operation==='reconcile'?{kind:'all-issued-terminal',barrierId:'50000000-0000-4000-8000-000000000001'}:{}})});
 return decodeMessage(await response.text(),'reply').result;
 }
 for(let i=0;i<p.policy.recordCap;i++){
 const ticket=createTicket(p.policy,authority(String(i%p.policy.sourceKeyCap).padStart(128,'s')),11000),result=await request(ticket,i===0?'reserve':'cancelUnstarted');
 assert.equal(result.tag,'record');if(i===0&&result.tag==='record'){held=result.record.handle;assert.equal((await request(held,'start')).tag,'record');}
 }
 const retained=await h.rpc.snapshot(),raw=new Map(retained).get(STATE)!;assert.equal(JSON.parse(raw).registry.length,p.policy.recordCap);if(key==='sourceKeys128'||key==='sourceRate100'||key==='capacity16Source4')assert.ok(raw.length>65536);
 await h.mf.dispose();h=await harness('sealed');assert.deepEqual(await h.rpc.snapshot(),retained);
 assert.ok(held);assert.equal((await request(held!,'quarantine')).tag,'record');assert.equal(JSON.parse(new Map(await h.rpc.snapshot()).get(STATE)!).aggregateLive,1);
 assert.equal((await request(held!,'reconcile')).tag,'record');const terminal=JSON.parse(new Map(await h.rpc.snapshot()).get(STATE)!);assert.equal(terminal.registry.length,p.policy.recordCap);assert.equal(terminal.aggregateLive,0);
 const denied=await request(createTicket(p.policy,authority(),11000),'cancelUnstarted');assert.equal(denied.tag,'denied');if(denied.tag==='denied')assert.equal(denied.reason,'records');
 await h.rpc.corrupt();const corrupt=await h.rpc.snapshot();
 const ticket=createTicket(p.policy,authority(),11000),response=await h.mf.dispatchFetch('https://admission.internal/v1/inspect',{method:'POST',headers:{'content-type':'application/json'},body:encodeMessage({version:1,operation:'inspect',ticket,payload:{}})});
 assert.equal(decodeMessage(await response.text(),'reply').result.tag,'fault');assert.deepEqual(await h.rpc.snapshot(),corrupt);
 await h.mf.dispose();h=await harness('bootstrap');assert.equal(await h.rpc.birth(),false);assert.deepEqual(await h.rpc.snapshot(),corrupt);
 }finally{await h.mf.dispose();}
 }
});
test('internal fixed registration rejects unreviewed digest namespace and changed policy',async()=>{
 const {registerFixedStorageCapability}=await import('../src/qualification/storage-capability-core.js');const p=profiles.sourceKeys128;
 assert.throws(()=>registerFixedStorageCapability(p.policy,'0'.repeat(64),p.namespace));
 assert.throws(()=>registerFixedStorageCapability(p.policy,p.digest,'other'));
 assert.throws(()=>registerFixedStorageCapability({...p.policy,recordCap:146},p.digest,p.namespace));
});
