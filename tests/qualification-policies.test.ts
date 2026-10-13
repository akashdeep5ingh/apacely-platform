import test from 'node:test';
import assert from 'node:assert/strict';

import {AdmissionCoordinator,bootstrapAdmission,capturePolicy,createTicket,encodeMessage,decodeMessage,type AdmissionPolicy,type AdmissionStorage,type AdmissionTicket,type AdmissionRequest} from '../src/distributed-admission.js';
import {webcrypto} from 'node:crypto';
if(!globalThis.crypto)Object.defineProperty(globalThis,'crypto',{value:webcrypto});
const modulePath='../src/qualification/policies.js';

class Memory implements AdmissionStorage {
 values=new Map<string,string>();
 async get(key:string){return this.values.get(key);}
 async put(key:string,value:string){this.values.set(key,value);}
 async transaction<T>(callback:(tx:AdmissionStorage)=>Promise<T>):Promise<T>{
  const before=new Map(this.values);try{return await callback(this);}catch(error){this.values=before;throw error;}
 }
}
const authority=(source='one',tenant='20000000-0000-4000-8000-000000000001')=>({environment:'staging' as const,tenant,provider:'synthetic',principal:'phase4',source,mappingId:'30000000-0000-4000-8000-000000000001',mappingVersion:1,sourceBinding:source,operation:'ingest_mock_lead' as const});
async function send(core:AdmissionCoordinator,ticket:AdmissionTicket,operation:AdmissionRequest['operation']='reserve'){
 const payload:AdmissionRequest['payload']=operation==='settle'?{kind:'known-not-issued' as const,barrierId:'50000000-0000-4000-8000-000000000001'}:{};
 const response=await core.fetch(new Request('https://admission.internal/v1/'+operation,{method:'POST',headers:{'content-type':'application/json'},body:encodeMessage({version:1,operation,ticket,payload})}));
 return JSON.parse(JSON.stringify(decodeMessage(await response.text(),'reply').result)) as ReturnType<typeof decodeMessage>['result'];
}

test('only original named profile identity and exact namespace can bootstrap fresh storage',async()=>{
 const m=await import(modulePath);const p=m.QUALIFICATION_PROFILES.contention16;
 assert.equal(typeof m.captureQualificationProfile,'function','identity capture must exist');
 assert.equal(m.captureQualificationProfile(p),p);
 for(const invalid of [{...p},{...p,policy:{...p.policy,sourceCap:17}},'contention16',null,{},m.QUALIFICATION_PROFILES])assert.throws(()=>m.captureQualificationProfile(invalid));
 let reads=0;const accessor={get name(){reads++;return p.name;}};assert.throws(()=>m.captureQualificationProfile(accessor));assert.equal(reads,0);
 const storage=new Memory();
 await assert.rejects(m.bootstrapQualificationNamespace(p,storage,'wrong',1000));assert.equal(storage.values.size,0);
 await m.bootstrapQualificationNamespace(p,storage,p.namespace,1000);
 const original=[...storage.values];
 await assert.rejects(m.bootstrapQualificationNamespace(p,storage,p.namespace,1000));
 const other=m.QUALIFICATION_PROFILES.capacity16Source4;
 await assert.rejects(m.bootstrapQualificationNamespace(other,storage,other.namespace,1000));
 assert.deepEqual([...storage.values],original);
});
test('named synthetic profiles capture immutable separately bounded policies',async()=>{
 const exports=await import(modulePath).catch(()=>null);
 assert.ok(exports,'qualification profiles module must exist');
 const profiles=exports.QUALIFICATION_PROFILES;
 assert.equal(Object.keys(profiles).length,4);
 assert.ok(Object.isFrozen(profiles));
 for(const profile of Object.values(profiles) as any[]){
  assert.equal(profile.syntheticOnly,true);
  assert.equal(profile.policy.environment,'staging');
  assert.ok(Object.isFrozen(profile));assert.ok(Object.isFrozen(profile.policy));assert.ok(Object.isFrozen(profile.scenarios));
  assert.ok(profile.policy.recordCap>=profile.admissionBudget+profile.recordHeadroom);
  assert.match(profile.digest,/^[0-9a-f]{64}$/);
 }
 assert.equal(profiles.contention16.policy.aggregateCap,16);
 assert.equal(profiles.contention16.policy.tenantCap,16);
 assert.equal(profiles.contention16.policy.sourceCap,16);
 assert.equal(profiles.capacity16Source4.policy.aggregateCap,16);
 assert.equal(profiles.capacity16Source4.policy.sourceCap,4);
 assert.equal(profiles.sourceKeys128.policy.sourceKeyCap,128);
 assert.ok(profiles.sourceKeys128.policy.aggregateCap>128);
 assert.ok(profiles.sourceKeys128.policy.tenantCap>128);
 assert.ok(profiles.sourceKeys128.policy.aggregateRate>128);
 assert.equal(profiles.sourceRate100.policy.sourceRate,100);
 assert.ok(profiles.sourceRate100.policy.recordCap>100);
 assert.ok(profiles.sourceRate100.policy.aggregateRate>100);
 assert.ok(profiles.sourceRate100.policy.tenantRate>100);
});

test('stable digests match core tickets; every changed policy field changes identity',async()=>{
 const {QUALIFICATION_PROFILES:profiles}=await import(modulePath);
 assert.equal(new Set(Object.values(profiles).map((p:any)=>p.namespace)).size,4);
 assert.equal(new Set(Object.values(profiles).map((p:any)=>p.policy.epoch)).size,4);
 for(const p of Object.values(profiles) as any[]){
  assert.equal(createTicket(p.policy,authority(),11000).context.policyDigest,p.digest);
  const mutable={...p.policy};const captured=capturePolicy(mutable);mutable.aggregateCap++;
  assert.equal(captured.aggregateCap,p.policy.aggregateCap);
  for(const key of Object.keys(p.policy) as (keyof AdmissionPolicy)[]){
   let value:unknown=p.policy[key];
   if(typeof value==='number')value=value===30000?value-1:value+1;
   if(key==='domain')value='other';
   if(key==='version'||key==='domain'){
    assert.throws(()=>capturePolicy({...p.policy,[key]:value} as AdmissionPolicy));continue;
   }
   if(key==='epoch')value='40000000-0000-4000-8000-000000000099';
   if(key==='environment')value='development';
   const changed=capturePolicy({...p.policy,[key]:value} as AdmissionPolicy);
   const a={...authority(),environment:changed.environment};
   assert.notEqual(createTicket(changed,a,11000).context.policyDigest,p.digest,key);
  }
  assert.throws(()=>capturePolicy({...p.policy,production:true} as AdmissionPolicy));
  let calls=0;assert.throws(()=>capturePolicy({...p.policy,get aggregateCap(){calls++;return 16;}}));assert.equal(calls,0);
 }
});

test('real core rejects foreign profile tickets and changed policy over reused storage',async()=>{
 const m=await import(modulePath),p=m.QUALIFICATION_PROFILES.contention16,other=m.QUALIFICATION_PROFILES.capacity16Source4;
 const storage=new Memory();await m.bootstrapQualificationNamespace(p,storage,p.namespace,1000);
 const mutable={...p.policy};const core=new AdmissionCoordinator(storage,mutable,()=>1000,m.qualificationStorageCapability(p,p.namespace,'sqlite'));mutable.sourceCap=1;
 const first=await send(core,createTicket(p.policy,authority(),11000));assert.equal(first.tag,'record');
 const before=[...storage.values];
 assert.deepEqual(await send(core,createTicket(other.policy,authority(),11000)),{tag:'denied',reason:'policy',retryAfterSeconds:null});
 assert.deepEqual([...storage.values],before);
 const changed=new AdmissionCoordinator(storage,{...p.policy,sourceCap:17},()=>1000);
 assert.deepEqual(await send(changed,createTicket(p.policy,authority(),11000)),{tag:'fault',code:'storage-corrupt'});
 assert.deepEqual([...storage.values],before);
});

test('S14/S15 permits sixteen same-source owners without quota confounding',async()=>{
 const m=await import(modulePath),p=m.QUALIFICATION_PROFILES.contention16,storage=new Memory();
 await m.bootstrapQualificationNamespace(p,storage,p.namespace,1000);const core=new AdmissionCoordinator(storage,p.policy,()=>1000,m.qualificationStorageCapability(p,p.namespace,'sqlite'));
 for(let i=0;i<16;i++)assert.equal((await send(core,createTicket(p.policy,authority(),11000))).tag,'record');
 assert.deepEqual(await send(core,createTicket(p.policy,authority(),11000)),{tag:'denied',reason:'aggregate',retryAfterSeconds:null});
});

test('S16/S29 source four and aggregate sixteen are independent quotas; quarantine remains charged',async()=>{
 const m=await import(modulePath),p=m.QUALIFICATION_PROFILES.capacity16Source4,storage=new Memory();
 await m.bootstrapQualificationNamespace(p,storage,p.namespace,1000);let now=1000;const core=new AdmissionCoordinator(storage,p.policy,()=>now,m.qualificationStorageCapability(p,p.namespace,'sqlite'));
 const held:AdmissionTicket[]=[];
 for(let source=0;source<4;source++){
  for(let i=0;i<4;i++){const result=await send(core,createTicket(p.policy,authority('s'+source),11000));assert.equal(result.tag,'record');if(result.tag==='record'){held.push(result.record.handle);assert.equal((await send(core,result.record.handle,'start')).tag,'record');}}
  if(source===0)assert.deepEqual(await send(core,createTicket(p.policy,authority('s0'),11000)),{tag:'denied',reason:'source',retryAfterSeconds:null});
 }
 assert.deepEqual(await send(core,createTicket(p.policy,authority('s4'),11000)),{tag:'denied',reason:'aggregate',retryAfterSeconds:null});
 now=32000;
 assert.deepEqual(await send(core,createTicket(p.policy,authority('s4'),42000)),{tag:'denied',reason:'aggregate',retryAfterSeconds:null});
 const state=JSON.parse([...storage.values.values()][0]);assert.equal(state.aggregateLive,16);assert.ok(state.registry.every((r:any)=>r.state==='QUARANTINED'));
 assert.equal((await send(core,held[0],'settle')).tag,'record');
 assert.equal((await send(core,createTicket(p.policy,authority('s4'),42000))).tag,'record');
});

test('finite record exhaustion survives settlement and rate-window advance without reclaim',async()=>{
 const m=await import(modulePath),p=m.QUALIFICATION_PROFILES.contention16;
 const policy=capturePolicy({...p.policy,recordCap:2});const storage=new Memory();await bootstrapAdmission(storage,policy,1000);
 let now=1000;const core=new AdmissionCoordinator(storage,policy,()=>now);
 for(let i=0;i<2;i++){const result=await send(core,createTicket(policy,authority(),11000));assert.equal(result.tag,'record');if(result.tag==='record')assert.equal((await send(core,result.record.handle,'settle')).tag,'record');}
 now=11000;
 assert.deepEqual(await send(core,createTicket(policy,authority(),21000)),{tag:'denied',reason:'records',retryAfterSeconds:null});
 const state=JSON.parse([...storage.values.values()][0]);assert.equal(state.registry.length,2);assert.equal(state.aggregateLive,0);assert.equal(state.sources.length,1);
});

async function sequential(profile:any,count:number,distinctSources:boolean){
 const m=await import(modulePath),storage=new Memory();await m.bootstrapQualificationNamespace(profile,storage,profile.namespace,1000);
 const core=new AdmissionCoordinator(storage,profile.policy,()=>1000,m.qualificationStorageCapability(profile,profile.namespace,'sqlite'));let admitted=0;
 for(let i=0;i<count;i++){
  const result=await send(core,createTicket(profile.policy,authority(distinctSources?'s'+i:'one'),11000));
  if(result.tag!=='record')return {admitted,result,state:JSON.parse([...storage.values.values()][0])};
  admitted++;assert.equal((await send(core,result.record.handle,'settle')).tag,'record');
 }
 return {admitted,result:null,state:JSON.parse([...storage.values.values()][0])};
}
test('S30 real-core readiness requires 100 admitted arrivals before the source-rate denial',async()=>{
 const m=await import(modulePath);const observed=await sequential(m.QUALIFICATION_PROFILES.sourceRate100,101,false);
 assert.equal(observed.admitted,100,JSON.stringify({admitted:observed.admitted,result:observed.result}));
 assert.deepEqual(observed.result,{tag:'denied',reason:'rate-source',retryAfterSeconds:10});
});
test('S29 real-core readiness requires 128 retained sources then keys denial on source 129',async()=>{
 const m=await import(modulePath);const observed=await sequential(m.QUALIFICATION_PROFILES.sourceKeys128,129,true);
 assert.equal(observed.admitted,128,JSON.stringify({admitted:observed.admitted,result:observed.result}));
 assert.deepEqual(observed.result,{tag:'denied',reason:'keys',retryAfterSeconds:null});
});
