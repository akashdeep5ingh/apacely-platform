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
export interface AcceptanceRepository {
 id():string;
 now():string;
 assertScope(scope:Scope):void|Promise<void>;
 accept<T>(scope:Scope,work:(store:AcceptanceStore)=>T):T|Promise<T>;
}
