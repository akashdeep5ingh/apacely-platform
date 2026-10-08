import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {readFileSync} from 'node:fs';
const fixture=JSON.parse(readFileSync(new URL('../fixtures/synthetic-hmac-v1.json',import.meta.url),'utf8'));
async function runtime(code:string){
 const bundle=await build({stdin:{resolveDir:process.cwd(),contents:`import {WorkerEntrypoint} from 'cloudflare:workers';import {SyntheticHmacVerifier} from './src/synthetic-hmac.ts';const fixture=${JSON.stringify(fixture)};export default class extends WorkerEntrypoint {async run(){${code}}}`},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:workers'],metafile:true});
 assert.ok(Object.keys(bundle.metafile!.inputs).every(x=>!/(node:|better-sqlite3)/.test(x)));
 const local=new Miniflare({modules:true,script:bundle.outputFiles![0].text,compatibilityDate:'2025-07-18',compatibilityFlags:[],host:'127.0.0.1',cf:false,outboundService:()=>{throw new Error('External network forbidden');}});
 try{const worker=await local.getWorker() as unknown as {run():Promise<unknown>};const result=await worker.run();return JSON.parse(JSON.stringify(result));}finally{await local.dispose();}
}
const setup=`const m=fixture.messages[0];const records=fixture.keys.filter(k=>k.environment==='development').map(k=>({...k,bytes:Uint8Array.from(k.key_hex.match(/../g),x=>parseInt(x,16))}));const verifier=await SyntheticHmacVerifier.create('development',records,()=> '2026-10-08T12:00:00.000Z');const input={provider:'synthetic',method:'POST',path:'/v1/ingress/synthetic',headers:new Headers(m.request.header_lines),body:Uint8Array.from(m.body_hex.match(/../g),x=>parseInt(x,16)),body_digest:m.body_sha256};`;
test('noncanonical signature tail bits reject before native verification',async()=>{
 const result=await runtime(`${setup}input.headers.set('apacely-signature',m.signature_base64url.slice(0,-1)+'x');return await verifier.verify(input);`);assert.equal(result,null);
});
test('claimed source cannot differ from trusted key scope',async()=>{
 assert.equal(await runtime(`${setup}input.headers.set('apacely-source','other-source');return await verifier.verify(input);`),null);
});
test('unknown proof header fails closed',async()=>{
 assert.equal(await runtime(`${setup}input.headers.set('apacely-environment','development');return await verifier.verify(input);`),null);
});
test('supplied digest must equal recomputed raw body digest',async()=>{
 assert.equal(await runtime(`${setup}input.body_digest='0'.repeat(64);return await verifier.verify(input);`),null);
});
test('freshness rechecked at verification completion',async()=>{
 assert.equal(await runtime(`${setup}const stale=await SyntheticHmacVerifier.create('development',records,()=> '2026-10-08T12:05:00.000Z');return await stale.verify(input);`),null);
});
test('revocation denies previously valid signed proof',async()=>{
 assert.equal(await runtime(`${setup}records[0].revoked_at='2026-10-08T12:00:00.000Z';const revoked=await SyntheticHmacVerifier.create('development',records,()=> '2026-10-08T12:00:00.000Z');return await revoked.verify(input);`),null);
});
test('ambiguous trusted registry is rejected before admission',async()=>{
 assert.equal(await runtime(`${setup}try{await SyntheticHmacVerifier.create('development',[...records,...records],()=> '2026-10-08T12:00:00.000Z');return false;}catch(e){return e.message==='Invalid synthetic authentication configuration';}`),true);
});
test('canceled verification cannot emit authority',async()=>{
 assert.equal(await runtime(`${setup}const abort=new AbortController();abort.abort();input.signal=abort.signal;return await verifier.verify(input);`),null);
});
test('untrusted imported key capability fails closed',async()=>{
 assert.equal(await runtime(`${setup}const bad={digest:crypto.subtle.digest.bind(crypto.subtle),verify:crypto.subtle.verify.bind(crypto.subtle),importKey:async(...args)=>crypto.subtle.importKey(args[0],args[1],args[2],true,['verify'])};try{await SyntheticHmacVerifier.create('development',records,()=> '2026-10-08T12:00:00.000Z',bad);return false;}catch{return true;}`),true);
});
test('crypto wiring captured before registry import awaits',async()=>{
 assert.equal(await runtime(`${setup}const adapter={digest:crypto.subtle.digest.bind(crypto.subtle),verify:crypto.subtle.verify.bind(crypto.subtle),importKey:async(...args)=>{adapter.verify=async()=>true;return crypto.subtle.importKey(...args);}};const secure=await SyntheticHmacVerifier.create('development',records,()=> '2026-10-08T12:00:00.000Z',adapter);input.headers.set('apacely-signature','A'.repeat(43));return await secure.verify(input);`),null);
});

for(const [name,change] of [
 ['altered raw body',`input.body[0]^=1;`],
 ['altered method',`input.method='PUT';`],
 ['altered route',`input.path='/v1/ingress/other';`],
 ['wrong provider',`input.provider='other';`],
 ['unknown kid',`input.headers.set('apacely-key-id','unknown');`],
 ['comma joined duplicate',`input.headers.append('Apacely-Nonce',input.headers.get('apacely-nonce'));`],
 ['padded signature',`input.headers.set('apacely-signature',m.signature_base64url+'=');`],
 ['short signature',`input.headers.set('apacely-signature',m.signature_base64url.slice(1));`],
 ['percent encoded proof',`input.headers.set('apacely-source','public%2Dsource-001');`],
 ['missing proof',`input.headers.delete('apacely-nonce');`],
 ['oversized nonce',`input.headers.set('apacely-nonce','n'.repeat(129));`],
 ['whitespace ambiguity',`input.headers.set('apacely-nonce','public nonce');`],
 ['nonascii proof',`input.headers.set('apacely-nonce','café');`],
 ['wrong signature',`input.headers.set('apacely-signature','A'.repeat(43));`]
] as const)test('native verification rejects '+name,async()=>{assert.equal(await runtime(`${setup}${change}return await verifier.verify(input);`),null);});
for(const [name,observation,accepted] of [
 ['exclusive past cutoff','2026-10-08T12:05:00.000Z',false],
 ['last past millisecond','2026-10-08T12:04:59.999Z',true],
 ['inclusive future cutoff','2026-10-08T11:59:30.000Z',true],
 ['future overflow','2026-10-08T11:59:29.999Z',false],
 ['observed key expiry','2026-10-08T13:00:00.000Z',false]
] as const)test('native lifecycle '+name,async()=>{
 assert.equal(await runtime(`${setup}const v=await SyntheticHmacVerifier.create('development',records,()=> '${observation}');return (await v.verify(input))!==null;`),accepted);
});
test('registry copies external records and key buffers',async()=>{
 assert.equal(await runtime(`${setup}records[0].bytes.fill(255);records[0].principal='mutated';records[0].revoked_at='2026-10-08T11:00:00.000Z';records.length=0;return (await verifier.verify(input)).principal;`),'public-principal-001');
});
test('failed trusted clock is sanitized not accepted',async()=>{
 assert.equal(await runtime(`${setup}const v=await SyntheticHmacVerifier.create('development',records,()=> 'invalid private clock');try{await v.verify(input);return false;}catch(e){return e.message==='Synthetic authentication failed';}`),true);
});
test('native verify uses nonextractable verify-only HMAC capability',async()=>{
 assert.equal(await runtime(`${setup}let observed=false;const adapter={importKey:crypto.subtle.importKey.bind(crypto.subtle),digest:crypto.subtle.digest.bind(crypto.subtle),verify:async(algorithm,key,...rest)=>{observed=key.type==='secret'&&!key.extractable&&key.algorithm.name==='HMAC'&&key.algorithm.hash.name==='SHA-256'&&key.usages.join(',')==='verify';try{await crypto.subtle.exportKey('raw',key);return false;}catch{}return crypto.subtle.verify(algorithm,key,...rest);}};const v=await SyntheticHmacVerifier.create('development',records,()=> '2026-10-08T12:00:00.000Z',adapter);return !!await v.verify(input)&&observed;`),true);
});
test('nine public signed vectors bind exact fixture canonical bytes',async()=>{
 const result=await runtime(`const results=[];for(const m of fixture.messages){const tuple=m.canonical_tuple,env=tuple[1];const records=fixture.keys.filter(k=>k.environment===env).map(k=>({...k,bytes:Uint8Array.from(k.key_hex.match(/../g),x=>parseInt(x,16))}));const v=await SyntheticHmacVerifier.create(env,records,()=>tuple[8]);const bytes=Uint8Array.from(m.body_hex.match(/../g),x=>parseInt(x,16));const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');const keyRecord=records.find(k=>k.key_id===tuple[5]);const signingKey=await crypto.subtle.importKey('raw',keyRecord.bytes,{name:'HMAC',hash:'SHA-256'},false,['sign']);const message=new TextEncoder().encode(JSON.stringify(tuple));const signature=new Uint8Array(await crypto.subtle.sign('HMAC',signingKey,message));const signatureHex=Array.from(signature,x=>x.toString(16).padStart(2,'0')).join('');const signatureUrl=btoa(String.fromCharCode(...signature)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');const p=await v.verify({provider:tuple[2],method:'POST',path:tuple[7],headers:new Headers(m.request.header_lines),body:bytes,body_digest:m.body_sha256});results.push(!!p&&digest===m.body_sha256&&signatureHex===m.signature_hex&&signatureUrl===m.signature_base64url&&JSON.stringify(tuple)===m.message_utf8);}return results;`);
 assert.deepEqual(result,Array(9).fill(true));
});

test('timestamp grammar rejected before cryptographic work',async()=>{
 assert.equal(await runtime(`${setup}let calls=0;const adapter={importKey:crypto.subtle.importKey.bind(crypto.subtle),digest:crypto.subtle.digest.bind(crypto.subtle),verify:async(...args)=>{calls++;return crypto.subtle.verify(...args);}};const v=await SyntheticHmacVerifier.create('development',records,()=> '2026-10-08T12:00:00.000Z',adapter);input.headers.set('apacely-signed-at','invalid');await v.verify(input);return calls;`),0);
});

test('completion clock advance rejects valid native delayed verification',async()=>{
 assert.equal(await runtime(`${setup}let time='2026-10-08T12:00:00.000Z';const adapter={importKey:crypto.subtle.importKey.bind(crypto.subtle),digest:crypto.subtle.digest.bind(crypto.subtle),verify:async(...args)=>{const valid=await crypto.subtle.verify(...args);time='2026-10-08T12:05:00.000Z';return valid;}};const v=await SyntheticHmacVerifier.create('development',records,()=>time,adapter);return await v.verify(input);`),null);
});
test('cancellation during native verification suppresses proof',async()=>{
 assert.equal(await runtime(`${setup}const abort=new AbortController();input.signal=abort.signal;const adapter={importKey:crypto.subtle.importKey.bind(crypto.subtle),digest:crypto.subtle.digest.bind(crypto.subtle),verify:async(...args)=>{const valid=await crypto.subtle.verify(...args);abort.abort();return valid;}};const v=await SyntheticHmacVerifier.create('development',records,()=> '2026-10-08T12:00:00.000Z',adapter);return await v.verify(input);`),null);
});
test('unexpected native crypto rejection is sanitized',async()=>{
 assert.equal(await runtime(`${setup}const adapter={importKey:crypto.subtle.importKey.bind(crypto.subtle),digest:crypto.subtle.digest.bind(crypto.subtle),verify:async()=>{throw new Error('private crypto detail');}};const v=await SyntheticHmacVerifier.create('development',records,()=> '2026-10-08T12:00:00.000Z',adapter);try{await v.verify(input);return false;}catch(e){return e.message==='Synthetic authentication failed';}`),true);
});
for(const [label,change] of [
 ['wrong scope',`records[0].environment='staging';`],
 ['short key',`records[0].bytes=new Uint8Array(31);`],
 ['invalid lifecycle',`records[0].not_after=records[0].not_before;`],
 ['malformed revocation',`records[0].revoked_at='private-invalid';`]
] as const)test('registry denies '+label,async()=>{
 assert.equal(await runtime(`${setup}${change}try{await SyntheticHmacVerifier.create('development',records,()=> '2026-10-08T12:00:00.000Z');return false;}catch(e){return e.message==='Invalid synthetic authentication configuration';}`),true);
});
test('registry denies rotation overlap beyond five minutes',async()=>{
 assert.equal(await runtime(`const records=fixture.keys.filter(k=>k.environment==='staging').map(k=>({...k,bytes:Uint8Array.from(k.key_hex.match(/../g),x=>parseInt(x,16))}));records[0].not_after='2026-10-08T12:05:00.001Z';try{await SyntheticHmacVerifier.create('staging',records,()=> '2026-10-08T12:00:00.000Z');return false;}catch{return true;}`),true);
});
test('registry denies reused key material across distinct scopes',async()=>{
 assert.equal(await runtime(`${setup}const copy={...records[0],key_id:'other',source:'other',bytes:records[0].bytes.slice()};try{await SyntheticHmacVerifier.create('development',[...records,copy],()=> '2026-10-08T12:00:00.000Z');return false;}catch{return true;}`),true);
});

test('key material must be actual bytes not a secret-slot accessor',async()=>{
 assert.equal(await runtime(`${setup}records[0].bytes={slice:()=>new Uint8Array(32)};try{await SyntheticHmacVerifier.create('development',records,()=> '2026-10-08T12:00:00.000Z');return false;}catch{return true;}`),true);
});
test('native workerd authenticates public development vector with captured key metadata',async()=>{
 const result=await runtime(`${setup}return await verifier.verify(input);`);
 assert.deepEqual(result,{principal:'public-principal-001',provider:'synthetic',source:'public-source-001',signed_at:'2026-10-08T12:00:00.000Z',nonce:'public-nonce-0000000000000001',body_digest:fixture.messages[0].body_sha256,method:'POST',path:'/v1/ingress/synthetic',protocol:'apacely-synthetic-ingress-hmac-v1',key_id:'public-dev-01',environment:'development'});
});

// Inherited implementation audit coverage: these do not claim historical RED/GREEN.
for(const [label,change,observation,accepted] of [
 ['observed not-before inclusive',`records[0].not_before=m.canonical_tuple[8];`,'2026-10-08T12:00:00.000Z',true],
 ['observed before key interval',`records[0].not_before=m.canonical_tuple[8];`,'2026-10-08T11:59:59.999Z',false],
 ['signed before key interval',`records[0].not_before='2026-10-08T12:00:00.001Z';`,'2026-10-08T12:00:00.001Z',false],
 ['signed at exclusive key expiry',`records[0].not_after=m.canonical_tuple[8];`,'2026-10-08T11:59:59.999Z',false],
 ['observed at exclusive key expiry',`records[0].not_after='2026-10-08T12:00:00.001Z';`,'2026-10-08T12:00:00.001Z',false],
 ['before scheduled revocation',`records[0].revoked_at='2026-10-08T12:00:00.001Z';`,'2026-10-08T12:00:00.000Z',true],
 ['observed scheduled revocation equality',`records[0].revoked_at='2026-10-08T12:00:00.001Z';`,'2026-10-08T12:00:00.001Z',false],
 ['signed scheduled revocation equality',`records[0].revoked_at=m.canonical_tuple[8];`,'2026-10-08T11:59:59.999Z',false]
] as const)test('audited native interval '+label,async()=>{
 assert.equal(await runtime(`${setup}${change}const v=await SyntheticHmacVerifier.create('development',records,()=> '${observation}');return !!await v.verify(input);`),accepted);
});
for(const [label,change] of [
 ['empty registry',`records.length=0;`],
 ['registry cardinality 129',`while(records.length<129)records.push(records[0]);`],
 ['third rotation entry',`for(let i=0;i<2;i++){const bytes=records[0].bytes.slice();bytes[0]^=i+1;records.push({...records[0],key_id:'rotation-'+i,bytes});}`],
 ['invalid provider type',`records[0].provider=null;`],
 ['invalid record',`records.push(null);`],
 ['calendar overflow',`records[0].not_before='2026-02-30T12:00:00.000Z';`]
] as const)test('audited malformed trusted '+label,async()=>{
 assert.equal(await runtime(`${setup}${change}try{await SyntheticHmacVerifier.create('development',records,()=>m.canonical_tuple[8]);return false;}catch(e){return e.message==='Invalid synthetic authentication configuration';}`),true);
});
test('audited registry accepts 128 distinct scoped public key records',async()=>{
 assert.equal(await runtime(`${setup}const many=Array.from({length:128},(_,i)=>{const bytes=records[0].bytes.slice();bytes[0]=i;return {...records[0],key_id:'cardinality-'+i,source:'source-'+i,bytes};});await SyntheticHmacVerifier.create('development',many,()=>m.canonical_tuple[8]);return true;`),true);
});
test('audited registry accepts exact five minute overlap',async()=>{
 assert.equal(await runtime(`const records=fixture.keys.filter(k=>k.environment==='staging').map(k=>({...k,bytes:Uint8Array.from(k.key_hex.match(/../g),x=>parseInt(x,16))}));await SyntheticHmacVerifier.create('staging',records,()=> '2026-10-08T12:00:00.000Z');return true;`),true);
});
