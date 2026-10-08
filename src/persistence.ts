import type {ReplayAdmission} from './replay-ledger.js';
import type {SourceAuthority} from './source-mappings.js';
import type {Scope} from './contracts.js';
export const businessTables=['leads','conversations','events','messages','qualification_state','action_outbox'] as const;
export type Table=typeof businessTables[number];
export type Row=Record<string,string|number|null>;
/** Provider-independent synchronous view of one acceptance unit. D1 supplies a read/plan view. */
export interface AcceptanceStore {
 find(table:Table,criteria:Row):Row|undefined;
 insert(table:Table,row:Row):void;
 update(table:Table,id:string,patch:Row):number;
 compareLead(id:string,version:number,sequence:number,patch:Row):void;
}
/** Trusted exact identity supplied by Processor, not a general history query. */
export interface AcceptanceTarget {source_binding:string;source_event_id:string;source_lead_id:string}
export interface AcceptanceRepository {
 authorityBinding?():object;
 replayBinding?():object;
 id():string;
 now():string;
 assertScope(scope:Scope):void|Promise<void>;
 accept<T>(scope:Scope,work:(store:AcceptanceStore)=>T,target?:AcceptanceTarget,authority?:SourceAuthority,replay?:ReplayAdmission):T|Promise<T>;
}
