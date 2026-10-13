import test from 'node:test';
import assert from 'node:assert/strict';

function descriptor(source:string,slot='current'){
 return {slot,secret_slot:`QUALIFICATION_SIGNING_KEY_${source.toUpperCase()}_${slot.toUpperCase()}`,key_id:`key-${source}-${slot}`,environment:'staging',provider:'synthetic',principal:`principal-${source}`,source:`source-${source}`,route:'/v1/ingress/synthetic',not_before:'2026-10-10T00:00:00.000Z',not_after:'2026-10-10T00:04:00.000Z',revoked_at:null as string|null};
}
function bindings(records:ReturnType<typeof descriptor>[]= [descriptor('a'),descriptor('b')]){
 const result:Record<string,unknown>={QUALIFICATION_HMAC_KEY_REGISTRY:JSON.stringify(records)};
 for(const r of records)result[r.secret_slot]=Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
 return result;
}

test('independent source current slots capture a frozen server allowlist and independent material',async()=>{
 const module=await import('../src/qualification/key-registry.js').catch(()=>null);
 assert.ok(module,'qualification registry must exist');
 const input=bindings(),keys=module.captureQualificationKeys(input);
 assert.equal(keys.length,2);assert.equal(keys[0].record.source,'source-a');assert.equal(keys[1].record.source,'source-b');
 input.QUALIFICATION_HMAC_KEY_REGISTRY='[]';input.QUALIFICATION_SIGNING_KEY_A_CURRENT='changed';
 assert.equal(keys[0].record.source,'source-a');assert.equal(typeof keys[0].secret,'string');
 assert.ok(Object.isFrozen(keys));assert.ok(Object.isFrozen(keys[0]));assert.ok(Object.isFrozen(keys[0].record));
});

import {captureQualificationKeys} from '../src/qualification/key-registry.js';

function capacityRecords(rotation=false){
 return Array.from({length:129},(_,i)=>rotation?[descriptor(`s${i+1}`),descriptor(`s${i+1}`,'next')]:[descriptor(`s${i+1}`)]).flat();
}
test('qualification accepts 129 independent sources and all 258 current/next records',()=>{
 for(const rotation of [false,true]){
  const keys=captureQualificationKeys(bindings(capacityRecords(rotation)));
  assert.equal(keys.length,rotation?258:129);
  assert.equal(new Set(keys.map(k=>k.record.source)).size,129);
 }
});
test('fixed source-keys128 artifact includes a trusted 129th authenticated-source descriptor',async()=>{
 const {sourceKeys128}=await import('../src/qualification/artifacts/fixed-bindings.js');
 let touched=0;
 const fixed=sourceKeys128({get QUALIFICATION_HMAC_KEY_REGISTRY(){touched++;throw Error('selector');}}) as Record<string,unknown>;
 const rows=JSON.parse(fixed.QUALIFICATION_HMAC_KEY_REGISTRY as string);
 assert.equal(rows.length,129);assert.equal(touched,0);
 assert.equal(rows[128].secret_slot,'QUALIFICATION_SIGNING_KEY_K128_129_CURRENT');
 assert.equal(rows[128].source,'source-129');assert.equal(rows[128].principal,'principal-129');
 assert.equal(new Set(rows.map((r:{source:string})=>r.source)).size,129);
 assert.equal(captureQualificationKeys(bindings(rows)).length,129);
});

test('130 independent source families reject before reading any secret material',()=>{
 const rows=Array.from({length:130},(_,i)=>descriptor(`s${i+1}`));
 const input=bindings(rows);
 // Invalid material must not mask a descriptor-only capacity failure.
 input[rows[0].secret_slot]='invalid';
 assert.throws(()=>captureQualificationKeys(input),/Invalid qualification source capacity/);
});

test('independent source families cannot alias a principal',()=>{
 const a=descriptor('a'),b={...descriptor('b'),principal:a.principal};
 assert.throws(()=>captureQualificationKeys(bindings([a,b])),/Aliased qualification principal/);
});


// Regression qualification, not new production-code RED history.
test('259 records reject before secret access and cryptographic work',()=>{
 const rows=[...capacityRecords(true),descriptor('overflow')];
 let touched=0;
 const input={QUALIFICATION_HMAC_KEY_REGISTRY:JSON.stringify(rows)};
 Object.defineProperty(input,rows[0].secret_slot,{enumerable:true,get(){touched++;throw Error('must not read');}});
 assert.throws(()=>captureQualificationKeys(input),/Invalid qualification registry/);
 assert.equal(touched,0);
});
test('registry UTF-8 bound is derived from 129 maximal legal current/next pairs',()=>{
 const rows=capacityRecords(true).map((r,i)=>({...r,key_id:`k${i}`.padEnd(128,'x'),principal:r.principal.padEnd(128,'p'),source:r.source.padEnd(128,'s'),secret_slot:`QUALIFICATION_SIGNING_KEY_K${i}`.padEnd(122,'X'),revoked_at:'9999-12-31T23:59:59.999Z'}));
 const input=bindings(rows),json=input.QUALIFICATION_HMAC_KEY_REGISTRY as string;
 assert.equal(captureQualificationKeys(input).length,258);
 // A maximally sized canonical allowlist is the byte budget; not an unexplained 1KiB/record estimate.
 for(const value of [json+' ',json+'é'])assert.throws(()=>captureQualificationKeys({...input,QUALIFICATION_HMAC_KEY_REGISTRY:value}),/Invalid qualification registry/);
 const shorter=bindings(capacityRecords(true)),canonical=shorter.QUALIFICATION_HMAC_KEY_REGISTRY as string;
 const exact=canonical+' '.repeat(Buffer.byteLength(json)-Buffer.byteLength(canonical));
 assert.equal(captureQualificationKeys({...shorter,QUALIFICATION_HMAC_KEY_REGISTRY:exact}).length,258);
 assert.throws(()=>captureQualificationKeys({...shorter,QUALIFICATION_HMAC_KEY_REGISTRY:exact.slice(0,-1)+'é'}),/Invalid qualification registry/);
});
test('source129 subset uses baseline API; complete 129/258 rings require the separate fixed qualifier',async()=>{
 const {SyntheticHmacVerifier}=await import('../src/synthetic-hmac.js');
 const rows=capacityRecords(true),captured=captureQualificationKeys(bindings(rows));
 const chosen=[captured[254],captured[256],captured[257]];
 const records=chosen.map(k=>({...k.record,bytes:new Uint8Array(Buffer.from(k.secret,'base64'))}));
 const signed_at='2026-10-10T00:01:00.000Z';
 const verifier=await SyntheticHmacVerifier.create('staging',records,()=>signed_at);
 const body=new TextEncoder().encode('{}'),body_digest=Buffer.from(await crypto.subtle.digest('SHA-256',body)).toString('hex');
 const identities=[];
 for(const key of chosen){
  const r=key.record,nonce=`nonce-${r.key_id}`;
  const signer=await crypto.subtle.importKey('raw',Buffer.from(key.secret,'base64'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const message=JSON.stringify(['apacely-synthetic-ingress-hmac-v1','staging',r.provider,r.principal,r.source,r.key_id,'POST',r.route,signed_at,nonce,body_digest]);
  const signature=Buffer.from(await crypto.subtle.sign('HMAC',signer,new TextEncoder().encode(message))).toString('base64url');
  const headers=new Headers({'apacely-key-id':r.key_id,'apacely-source':r.source,'apacely-signed-at':signed_at,'apacely-nonce':nonce,'apacely-signature':signature});
  const input={provider:'synthetic',method:'POST',path:r.route,body,body_digest,headers};
  const identity=await verifier.verify(input);assert.ok(identity);identities.push(identity);
  headers.set('apacely-source','source-forged');assert.equal(await verifier.verify(input),null);
 }
 assert.equal(identities[1].source,'source-s129');assert.equal(identities[1].source,identities[2].source);
 assert.equal(identities[1].principal,identities[2].principal);assert.notEqual(identities[0].source,identities[1].source);
 // Explicit blocker: neither complete registry reaches cryptographic import.
 let cryptoWork=0;
 const boundedSubtle={importKey:async()=>{cryptoWork++;throw Error('must not import');},digest:async()=>{cryptoWork++;throw Error('must not digest');},verify:async()=>{cryptoWork++;throw Error('must not verify');}} as unknown as SubtleCrypto;
 for(const all of [captured.filter((_,i)=>i%2===0),captured]){
  const complete=all.map(k=>({...k.record,bytes:new Uint8Array(Buffer.from(k.secret,'base64'))}));
  try{await assert.rejects(()=>SyntheticHmacVerifier.create('staging',complete,()=>signed_at,boundedSubtle),/Invalid synthetic authentication configuration/);}finally{for(const r of complete)r.bytes.fill(0);}
 }
 assert.equal(cryptoWork,0);
 for(const r of records)r.bytes.fill(0);
});

test('rotations remain per-source with global key, slot and material alias rejection',()=>{
 const a=descriptor('a'),b=descriptor('b'),an=descriptor('a','next'),bn=descriptor('b','next');
 assert.equal(captureQualificationKeys(bindings([a,an,b,bn])).length,4);
 const bad=[ [an,b], [a,{...an,principal:'different'},b], [a,{...an,not_after:'2026-10-10T00:10:00.000Z',not_before:'2026-10-09T23:59:00.000Z'}, {...a,slot:'next',key_id:'third',secret_slot:'QUALIFICATION_SIGNING_KEY_THIRD'}], [a,{...b,key_id:a.key_id}], [a,{...b,secret_slot:a.secret_slot}], [a,{...b,source:a.source}] ];
 for(const rows of bad)assert.throws(()=>captureQualificationKeys(bindings(rows)));
 const overlap={...an,not_before:'2026-10-09T23:59:00.000Z',not_after:'2026-10-10T00:10:00.000Z'};
 assert.throws(()=>captureQualificationKeys(bindings([{...a,not_after:'2026-10-10T00:06:00.000Z'},overlap,b])));
 const aliases=bindings();aliases.QUALIFICATION_SIGNING_KEY_B_CURRENT=aliases.QUALIFICATION_SIGNING_KEY_A_CURRENT;assert.throws(()=>captureQualificationKeys(aliases));
 const extra=bindings();extra.QUALIFICATION_SIGNING_KEY_ORPHAN=Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');assert.throws(()=>captureQualificationKeys(extra));
});
test('malformed registry authority rejects exact own data fields without invoking accessors',()=>{
 const a=descriptor('a');
 const malformed:unknown[]=[[],[null],[{...a,tenant_id:'forged'}],[{...a,environment:'production'}],[{...a,slot:'other'}],[{...a,not_after:a.not_before}],[{...a,revoked_at:'yesterday'}],[{...a,source:'bad source'}],[{...a,secret_slot:'STAGING_SIGNING_KEY_CURRENT'}],[{...a,route:'/admin'}]];
 const missing={...a} as Partial<typeof a>;delete missing.revoked_at;malformed.push([missing]);
 for(const records of malformed)assert.throws(()=>captureQualificationKeys({...bindings(),QUALIFICATION_HMAC_KEY_REGISTRY:JSON.stringify(records)}));
 for(const value of [undefined,{},'x',' '.repeat(65537)])assert.throws(()=>captureQualificationKeys({...bindings(),QUALIFICATION_HMAC_KEY_REGISTRY:value}));
 let touched=0;const accessor=bindings();Object.defineProperty(accessor,'QUALIFICATION_SIGNING_KEY_A_CURRENT',{enumerable:true,get(){touched++;return 'invalid';}});
 assert.throws(()=>captureQualificationKeys(accessor));assert.equal(touched,0);
 assert.throws(()=>captureQualificationKeys(Object.create(bindings())));
 const hidden=bindings();Object.defineProperty(hidden,'QUALIFICATION_HMAC_KEY_REGISTRY',{enumerable:false});assert.throws(()=>captureQualificationKeys(hidden));
 for(const secret of ['','B'.repeat(43)+'=','not-base64',undefined])assert.throws(()=>captureQualificationKeys({...bindings(),QUALIFICATION_SIGNING_KEY_A_CURRENT:secret}));
});
