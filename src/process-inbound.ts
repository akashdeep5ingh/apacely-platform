import type {SourceAuthority} from './source-mappings.js';
import {fields,fingerprint,validateInput,POLICY,SliceError,type Context,type Scope,type Input} from './contracts.js';
import {evaluate,type Evaluation} from './qualification.js';
import type {AcceptanceRepository,AcceptanceStore,Row} from './persistence.js';
export interface EventEnvelope {event_id:string;event_type:'lead.inbound_received';schema_version:1;tenant_id:string;environment:'development';source:string;source_event_id:string;source_sequence:number;occurred_at:string;received_at:string;lead_id:string;conversation_id:string;message_id:string;correlation_id:string;policy_version:string;payload:{contact_reference:string;channel:'mock';text:string;qualification:Input['qualification'];handoff_requested:boolean}}
export interface Qualification extends Evaluation {id:string;tenant_id:string;lead_id:string;conversation_id:string;evaluated_event_id:string;policy_version:string;version:number;updated_at:string}
export interface Action {id:string;tenant_id:string;environment:'development';lead_id:string;conversation_id:string;event_id:string;causation_id:string;correlation_id:string;policy_version:string;action_slot:'qualification_result';action_type:string;payload:Record<string,unknown>}
export interface Outcome {event:EventEnvelope;qualification:Qualification;action:Action}
/** Harness-owned copy; never read a source/tenant binding from caller payload. */
export class Registry {
 private bindings:Map<string,string>;
 constructor(bindings:Iterable<readonly [string,string]>) {this.bindings=new Map(bindings);}
 resolve(ctx:Context):Scope {
  if(!ctx||Object.keys(ctx).some(k=>!['environment','source_binding','operation'].includes(k))||ctx.environment!=='development'||ctx.operation!=='ingest_mock_lead'||!this.bindings.has(ctx.source_binding)) throw new SliceError('context','Unknown or forged development binding');
  return {tenant_id:this.bindings.get(ctx.source_binding)!,environment:'development'};
 }
}
export interface ProcessOptions {checkpoint?:(step:string)=>void;maxRetries?:number}
export class Processor {
 private queues=new Map<string,Promise<unknown>>();
 private maxRetries:number;
 constructor(private repo:AcceptanceRepository,private registry:Registry,private options:ProcessOptions={}) {
  this.maxRetries=options.maxRetries??3;
  if(!Number.isInteger(this.maxRetries)||this.maxRetries<0||this.maxRetries>3) throw new SliceError('validation','Retry budget must be 0..3');
 }
 async process(ctx:Context,raw:unknown,authority?:SourceAuthority):Promise<Outcome> {
  const capturedAuthority=authority?Object.freeze({...authority}):undefined;
  if(capturedAuthority&&!this.repo.authorityBinding)throw new SliceError('context','Authority-aware repository required');
  const input=validateInput(raw),scope=Object.freeze(this.registry.resolve(ctx)),source=ctx.source_binding;
  const key=JSON.stringify([scope.tenant_id,source,input.source_lead_id]);
  const work=(this.queues.get(key)??Promise.resolve()).catch(()=>undefined).then(async()=>{
   for(let retries=0;;retries++) {
    try {return await this.repo.accept(scope,store=>accept(this.repo,store,scope,source,input,this.options),{source_binding:source,source_event_id:input.source_event_id,source_lead_id:input.source_lead_id},capturedAuthority);}
    catch(error) {
     const code=(error as {code?:string})?.code;
     if(!['SQLITE_BUSY','SQLITE_BUSY_SNAPSHOT','SQLITE_LOCKED','LOCAL_VERSION_CONFLICT','D1_TRANSIENT'].includes(code??'')) throw error;
     if(retries===this.maxRetries) throw Object.assign(new SliceError('retry_exhausted','Acceptance retry budget exhausted'),{cause:error});
     await new Promise(resolve=>setTimeout(resolve,1));
    }
   }
  });
  this.queues.set(key,work);
  try {return await work;} finally {if(this.queues.get(key)===work) this.queues.delete(key);}
 }
}
export function accept(repo:AcceptanceRepository,store:AcceptanceStore,scope:Scope,source:string,input:Input,options:ProcessOptions={}):Outcome {
  const tenant_id=scope.tenant_id;
  const duplicate=store.find('events',{source_binding:source,source_event_id:input.source_event_id});
  if(duplicate) {if(duplicate.input_fingerprint!==fingerprint(input)) throw new SliceError('conflict','Event identity reused with changed semantic input');return JSON.parse(String(duplicate.outcome_snapshot)) as Outcome;}
  const now=repo.now();
  const previousLead=store.find('leads',{source_binding:source,source_lead_id:input.source_lead_id});
  if(input.source_sequence!==Number(previousLead?.last_source_sequence??0)+1) throw new SliceError('conflict','Source sequence must increment exactly by one');
  const lead_id=previousLead?String(previousLead.id):repo.id();
  const previousConversation=store.find('conversations',{lead_id,source_binding:source});
  const conversation_id=previousConversation?String(previousConversation.id):repo.id(),message_id=repo.id(),event_id=repo.id();
  if(!previousLead) store.insert('leads',{id:lead_id,tenant_id,source_binding:source,source_lead_id:input.source_lead_id,contact_reference:input.contact_reference,qualification_status:null,last_source_sequence:0,version:0,created_at:now,updated_at:now});
  options.checkpoint?.('lead_write');
  if(!previousConversation) store.insert('conversations',{id:conversation_id,tenant_id,lead_id,source_binding:source,channel:'mock',status:'open',version:1,created_at:now,updated_at:now});
  options.checkpoint?.('conversation_write');
  const event:EventEnvelope={event_id,event_type:'lead.inbound_received',schema_version:1,tenant_id,environment:'development',source,source_event_id:input.source_event_id,source_sequence:input.source_sequence,occurred_at:input.occurred_at,received_at:now,lead_id,conversation_id,message_id,correlation_id:event_id,policy_version:POLICY,payload:{contact_reference:input.contact_reference,channel:'mock',text:input.text,qualification:input.qualification,handoff_requested:input.handoff_requested}};
  store.insert('events',{id:event_id,tenant_id,lead_id,conversation_id,source_binding:source,source_event_id:input.source_event_id,source_sequence:input.source_sequence,event_type:event.event_type,schema_version:1,occurred_at:input.occurred_at,received_at:now,normalized_payload:JSON.stringify(event),input_fingerprint:fingerprint(input),policy_version:POLICY,correlation_id:event_id,outcome_snapshot:'{}'});
  options.checkpoint?.('event_write');
  store.insert('messages',{id:message_id,tenant_id,lead_id,conversation_id,event_id,direction:'inbound',channel:'mock',text:input.text,created_at:now});
  options.checkpoint?.('message_write');
  const previousQualification=store.find('qualification_state',{lead_id});
  const merged={...Object.fromEntries(fields.map(f=>[f,previousQualification?.[f]??null])),...input.qualification};
  const evaluation=evaluate(merged,input.handoff_requested);
  options.checkpoint?.('evaluated');
  const qualification:Qualification={id:previousQualification?String(previousQualification.id):repo.id(),tenant_id,lead_id,conversation_id,evaluated_event_id:event_id,...evaluation,policy_version:POLICY,version:Number(previousQualification?.version??0)+1,updated_at:now};
  const qRow={...qualification,handoff_ready:Number(qualification.handoff_ready),reasons:JSON.stringify(qualification.reasons),missing_fields:JSON.stringify(qualification.missing_fields)} as unknown as Row;
  if(previousQualification) {const {id,tenant_id,...patch}=qRow;store.update('qualification_state',qualification.id,patch);} else store.insert('qualification_state',qRow);
  options.checkpoint?.('qualification_write');
  store.compareLead(lead_id,Number(previousLead?.version??0),Number(previousLead?.last_source_sequence??0),{contact_reference:input.contact_reference,qualification_status:evaluation.status,last_source_sequence:input.source_sequence,version:Number(previousLead?.version??0)+1,updated_at:now});
  options.checkpoint?.('lead_result_write');
  if(previousConversation) store.update('conversations',conversation_id,{version:Number(previousConversation.version)+1,updated_at:now});
  options.checkpoint?.('conversation_result_write');
  const action:Action={id:repo.id(),tenant_id,environment:'development',lead_id,conversation_id,event_id,causation_id:event_id,correlation_id:event_id,policy_version:POLICY,action_slot:'qualification_result',action_type:'request_handoff',payload:{qualification_status:evaluation.status,reason:'qualified_and_handoff_requested',qualification:{...Object.fromEntries(fields.map(f=>[f,evaluation[f]])),handoff_ready:evaluation.handoff_ready},destination_reference:'mock-handoff-inbox'}};
  if(evaluation.status==='qualified') {action.action_type='schedule_followup';action.payload.reason='qualified_without_handoff_request';delete action.payload.destination_reference;action.payload.due_at=new Date(Date.parse(now)+24*60*60*1000).toISOString();}
  if(evaluation.status==='needs_more_information') {action.action_type='send_message';delete action.payload.destination_reference;Object.assign(action.payload,{reason:evaluation.reasons[0],channel:'mock',template:'qualification_missing_fields',missing_fields:evaluation.missing_fields,recipient_reference:input.contact_reference});}
  if(evaluation.status==='disqualified') {action.payload.reason='review_disqualification';action.payload.destination_reference='mock-review-inbox';}
  const {causation_id,...persisted}=action;
  store.insert('action_outbox',{...persisted,payload:JSON.stringify(action.payload),status:'pending',attempts:0,created_at:now,recorded_at:null});
  options.checkpoint?.('outbox_write');
  const outcome={event,qualification,action};store.update('events',event_id,{outcome_snapshot:JSON.stringify(outcome)});
  options.checkpoint?.('snapshot_write');
  options.checkpoint?.('before_commit');
  return outcome;
 }
