import {fields,type Facts} from './contracts.js';
export type Status='needs_more_information'|'qualified'|'handoff_ready'|'disqualified';
export interface Evaluation extends Facts {handoff_ready:boolean;status:Status;reasons:string[];missing_fields:string[]}
export function evaluate(patch:Partial<Facts>,requested:boolean):Evaluation {
 const facts=Object.fromEntries(fields.map(f=>[f,patch[f]??null])) as Facts;
 if(facts.intent==='rent'||facts.intent==='sell'||facts.property_type==='commercial') return {...facts,handoff_ready:false,status:'disqualified',reasons:['outside_mock_scope'],missing_fields:[]};
 const missing_fields=fields.filter(f=>facts[f]===null||facts[f]==='unknown'||(f==='location'&&!facts[f]?.trim())||(f==='financing_status'&&facts[f]==='not_started'));
 if(missing_fields.length) return {...facts,handoff_ready:false,status:'needs_more_information',reasons:[facts.financing_status==='not_started'?'financing_pending':'missing_information'],missing_fields};
 return {...facts,handoff_ready:requested,status:requested?'handoff_ready':'qualified',reasons:[requested?'qualified_and_handoff_requested':'qualified_without_handoff_request'],missing_fields:[]};
}
