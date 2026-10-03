import type {Scope} from './contracts.js';
import type {Action} from './process-inbound.js';
import {Repository} from './repository.js';
export interface Receipt {action_id:string;action:Action}
/** No I/O: receipts live only for this local mock consumer's lifetime. */
export class MockSink {
 private entries=new Map<string,Receipt>();
 get receipts():Receipt[] {return structuredClone([...this.entries.values()]);}
 record(action:Action):Receipt {
  const existing=this.entries.get(action.id);if(existing) return structuredClone(existing);
  const receipt={action_id:action.id,action:structuredClone(action)};
  this.entries.set(action.id,receipt);return structuredClone(receipt);
 }
}
/** Synchronous single-consumer drain, strictly after the inbound unit commits. */
export function drain(repo:Repository,scope:Scope,sink:MockSink,options:{afterRecord?:()=>void}={}):Receipt[] {
 repo.requireCommitted();
 const store=repo.scoped(scope),receipts:Receipt[]=[];
 for(const row of store.rows('action_outbox').filter(r=>r.status==='pending')) {
  store.update('action_outbox',String(row.id),{attempts:Number(row.attempts)+1});
  const action:Action={id:String(row.id),tenant_id:store.scope.tenant_id,environment:'development',lead_id:String(row.lead_id),conversation_id:String(row.conversation_id),event_id:String(row.event_id),causation_id:String(row.event_id),correlation_id:String(row.correlation_id),policy_version:String(row.policy_version),action_slot:'qualification_result',action_type:String(row.action_type),payload:JSON.parse(String(row.payload))};
  receipts.push(sink.record(action));
  options.afterRecord?.();
  store.update('action_outbox',action.id,{status:'recorded',recorded_at:repo.now()});
 }
 return receipts;
}
