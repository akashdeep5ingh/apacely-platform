import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const sha = /^[a-f0-9]{64}$/;
/** Reject accessors, inherited authority, symbols and unknown fields without invoking getters. */
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
 if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw Error('Plain data required');
 const descriptors = Object.getOwnPropertyDescriptors(value);
 if (Reflect.ownKeys(value).length !== keys.length || keys.some(k => !descriptors[k] || !Object.hasOwn(descriptors[k]!, 'value')) || Object.keys(descriptors).some(k => !keys.includes(k))) throw Error('Exact own data fields required');
 return Object.fromEntries(keys.map(k => [k, descriptors[k]!.value]));
}
export const approvalClasses = Object.freeze(['resource-closed-deployment', 'access-routing', 'fault-restore'] as const);
const packets = new WeakSet<object>();
export function validateOperatorPacket(value: unknown) {
 const p = record(value, ['environment','accountId','databaseId','databaseName','workerName','namespaceId','coordinatorName','configPath','artifacts','approvals']);
 const id = (v:unknown) => typeof v === 'string' && /^[a-f0-9]{32}$/.test(v) && !/^0+$/.test(v);
 if (p.environment !== 'staging' || !id(p.accountId) || !id(p.namespaceId) || typeof p.databaseId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(p.databaseId) || p.databaseId === '00000000-0000-4000-8000-000000000000' || p.databaseName !== 'apacely-staging' || p.workerName !== 'apacely-ingress-staging' || p.coordinatorName !== 'distributed-admission-v1' || p.configPath !== 'wrangler.staging.jsonc') throw Error('Exact nonplaceholder staging targets required');
 const artifacts = record(p.artifacts, ['config','migration','bootstrap','sealed','source']);
 if (Object.values(artifacts).some(v => typeof v !== 'string' || !sha.test(v))) throw Error('Artifact SHA256 required');
 const approvals = record(p.approvals, approvalClasses);
 if (Object.values(approvals).some(v => typeof v !== 'string' || !/^approval-[a-z0-9-]{1,80}$/.test(v)) || new Set(Object.values(approvals)).size !== approvalClasses.length) throw Error('Distinct nonsecret approval references required');
 const targets = Object.freeze(Object.fromEntries(Object.entries(p).filter(([k]) => !['artifacts','approvals'].includes(k))));
 const data = {targets, artifacts:Object.freeze(artifacts), approvals:Object.freeze(approvals)};
 const result = Object.freeze({...data, packetHash:createHash('sha256').update(JSON.stringify(data)).digest('hex'), remoteReady:false, remoteExecution:'unavailable', approvalAuthenticity:'NOT VERIFIED'});
 packets.add(result); return result;
}
/** Compare already supplied UTF-8 artifact text. Binary/paths/readers are not accepted. */
export function verifyArtifactBytes(packet: ReturnType<typeof validateOperatorPacket>, value: unknown) {
 if(!packets.has(packet)) throw Error('Validated packet identity required');
 const bytes=record(value,['config','migration','bootstrap','sealed','source']);
 for(const [key,text] of Object.entries(bytes)) if(typeof text!=='string' || Buffer.byteLength(text)>64*1024*1024 || createHash('sha256').update(text).digest('hex')!==packet.artifacts[key]) throw Error('Artifact bytes mismatch');
 return Object.freeze({comparison:'MATCH',packetHash:packet.packetHash,remoteReady:false,status:'STOP',configTargetReadback:'NOT VERIFIED'});
}
export const scenarioCatalogue: Readonly<Record<string, readonly string[]>> = Object.freeze(Object.fromEntries(Object.entries({
 S12:['revoke-before-claim','revoke-after-claim','version-before-write','tenant-before-write'], S13:['commit-before-revoke'],
 S14:['identical-16'], S15:['mixed-16'], S16:['held-4-of-64'], S17:['sequence-gap-stale-conflict'],
 S18:['statement-rollback'], S19:['clock-after-claim','clock-during-plan','clock-duplicate','clock-response-loss','invalid-clock','db-final-guard-delay'],
 S20:['body-pending','verifier-pending','responsive-cancel','hung-cancel'], S21:['claim-interrupt-restart','restart-expired'],
 S22:['issued-delay'], S23:['issued-delay-revocation'], S24:['four-attempts','zero-retries'], S25:['four-attempts','zero-retries'],
 S26:['expired-tombstone'], S27:['versioned-movement'], S28:['binding-mismatch','session-wrapper','foreign-fk','stale-authority','unscoped-call'],
 S29:['source-cap','aggregate-cap','tracked-source-cap'], S30:['rate-100-plus-1'],
 S31:['coordinator-outage','malformed-rate','unknown-d1','quota-exhaustion'], S32:['outer-access-denial','key-rotation','authority-version'],
 S33:['caller-disconnect','isolate-termination','cpu-limit'], S34:['canaries','logger-failure','inert-ssrf'],
 S35:['anonymous-burst','cross-region','coordinator-restart','window-clock-rollback']
}).map(([id, variants]) => [id,Object.freeze(variants)])));
/** Only a future private build composition may consume this description. No executor exists. */
export function scenarioManifest(value: unknown, packet: ReturnType<typeof validateOperatorPacket>) {
 if (!packets.has(packet)) throw Error('Validated packet identity required');
 const p = record(value,['scenario','variant','packetHash','buildHash','originalDatabaseId','statementCount','failureAfterStatement']);
 if (typeof p.scenario !== 'string' || !Object.hasOwn(scenarioCatalogue,p.scenario) || typeof p.variant !== 'string' || !scenarioCatalogue[p.scenario]!.includes(p.variant) || p.packetHash !== packet.packetHash || p.originalDatabaseId !== packet.targets.databaseId || typeof p.buildHash !== 'string' || !sha.test(p.buildHash)) throw Error('Pinned scenario/build/target required');
 const statements = p.statementCount, after = p.failureAfterStatement;
 if (p.scenario === 'S18' ? !Number.isSafeInteger(statements) || (statements as number)<1 || (statements as number)>64 || !Number.isSafeInteger(after) || (after as number)<1 || (after as number)>(statements as number) : statements !== 0 || after !== 0) throw Error('Exact bounded statement injection required');
 const instrumentation = Object.freeze({selection:'immutable-private-build', requestControls:'forbidden', dbIdentity:'original-binding-only', observerIdentity:'same-original-binding', deadline:'original-never-renewed', uncertainWork:'indefinitely-charged', evidence:'same-database-before-disposal', statementCount:statements, failureAfterStatement:after});
 const data = {...p, maxAttempts:p.variant === 'zero-retries' ? 1 : 4, instrumentation};
 return Object.freeze({...data, manifestHash:createHash('sha256').update(JSON.stringify(data)).digest('hex'), executor:'ABSENT',remoteReady:false,status:'STOP'});
}
export function assertOriginalDatabaseIdentity(original: object, identities: readonly object[]): void {
 if (!original || typeof original !== 'object' || identities.length !== 3 || identities.some(identity => identity !== original) || 'getBookmark' in original) throw Error('Repository/replay/issued observer require identical original primary DB');
}
/** No commands, subprocesses, credentials or network capabilities are returned. */
export function operatorPlan(args: readonly string[]) {
 if (args.length !== 2 || args[0] !== 'plan' || args[1] !== '--offline') throw new Error('Fixed offline plan required');
 return Object.freeze({status:'STOP', remoteExecution:'unavailable', remoteReady:false, approvalClasses});
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
 try {process.stdout.write(JSON.stringify(operatorPlan(process.argv.slice(2)), null, 2)+'\n');}
 catch {process.stderr.write('Offline operator plan refused.\n'); process.exitCode=1;}
}
