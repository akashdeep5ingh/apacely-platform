import {SliceError,trustedEnvironment,type Environment} from './contracts.js';
import type {D1Binding} from './d1-repository.js';
/** Fixed trusted identifier/literal policy, never request-derived SQL. */
export function environmentPredicate(environment:Environment):string {
 const value=trustedEnvironment(environment);
 return `EXISTS(SELECT 1 FROM database_environment WHERE singleton=1 AND environment='${value}')`;
}
export async function assertDatabaseEnvironment(db:D1Binding,environment:Environment):Promise<void>{
 const result=await db.prepare(`SELECT ${environmentPredicate(environment)} AS valid`).all<{valid:number}>();
 if(result.results.length!==1||result.results[0].valid!==1)throw new SliceError('context','Database environment mismatch');
}
