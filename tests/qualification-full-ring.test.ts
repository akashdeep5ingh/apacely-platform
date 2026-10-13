import test from 'node:test';
import assert from 'node:assert/strict';
import {SyntheticHmacVerifier} from '../src/synthetic-hmac.js';

test('original compiled source129 ring authenticates source129 after importing all 129 independent keys',async()=>{
 const module=await import('../src/qualification/keyrings.js').catch(()=>null);
 assert.ok(module,'reviewed fixed keyring authority must exist');
 const capability=await import('../src/qualification/hmac-capability.js');
 const ring=module.SOURCE129;
 const bindings:Record<string,string>={},secrets:string[]=[],signers:CryptoKey[]=[];
 try{
  for(const descriptor of ring.descriptors){const bytes=crypto.getRandomValues(new Uint8Array(32));try{secrets.push(Buffer.from(bytes).toString('base64'));signers.push(await crypto.subtle.importKey('raw',bytes,{name:'HMAC',hash:'SHA-256'},false,['sign']));}finally{bytes.fill(0);}}
  for(let i=0;i<4;i++)bindings[module.SHARD_NAMES[i]]=JSON.stringify(secrets.slice(i*65,(i+1)*65));
  let imports=0;const subtle={digest:crypto.subtle.digest.bind(crypto.subtle),verify:crypto.subtle.verify.bind(crypto.subtle),importKey:async(...args:Parameters<SubtleCrypto['importKey']>)=>{imports++;return (crypto.subtle.importKey as Function)(...args);}} as SubtleCrypto;
  const now=()=>new Date().toISOString();
  const verifier=await capability.createQualifiedHmac(ring,bindings,now,subtle,new AbortController().signal);
  assert.equal(imports,129);
  const r=ring.descriptors[128],body=new TextEncoder().encode('{}'),digest=Buffer.from(await crypto.subtle.digest('SHA-256',body)).toString('hex'),signed_at=now(),nonce='full-ring-129';
  const message=new TextEncoder().encode(JSON.stringify(['apacely-synthetic-ingress-hmac-v1','staging',r.provider,r.principal,r.source,r.key_id,'POST',r.route,signed_at,nonce,digest]));
  const signature=Buffer.from(await crypto.subtle.sign('HMAC',signers[128],message)).toString('base64url');
  const principal=await verifier.verify({headers:new Headers({'apacely-key-id':r.key_id,'apacely-source':r.source,'apacely-signed-at':signed_at,'apacely-nonce':nonce,'apacely-signature':signature}),body,body_digest:digest,method:'POST',path:r.route,provider:r.provider});
  assert.equal(principal?.source,'source-129');
  await assert.rejects(()=>capability.createQualifiedHmac({...ring},bindings,now,subtle,new AbortController().signal));
 }finally{secrets.fill('');signers.length=0;for(const name of Object.keys(bindings))delete bindings[name];}
});

test('qualification imported authority rejects structural clones before cryptography',async()=>{
 const {SOURCE129,SHARD_NAMES}=await import('../src/qualification/keyrings.js');
 const {captureQualifiedAuthority,importQualifiedAuthority}=await import('../src/qualification/hmac-capability.js');
 const signal=new AbortController().signal,bindings:Record<string,string>={},secrets:string[]=[];
 try{
  for(let i=0;i<129;i++){const bytes=crypto.getRandomValues(new Uint8Array(32));try{secrets.push(Buffer.from(bytes).toString('base64'));}finally{bytes.fill(0);}}
  SHARD_NAMES.forEach((n,i)=>bindings[n]=JSON.stringify(secrets.slice(i*65,(i+1)*65)));
  const captured=captureQualifiedAuthority(SOURCE129,bindings,crypto.subtle,signal);
  await assert.rejects(()=>importQualifiedAuthority({...captured},()=>new Date().toISOString(),signal));
 }finally{secrets.fill('');for(const n of Object.keys(bindings))delete bindings[n];}
});

test('sourceKeys128 sealed composition uses lazy fixed four-shard authority and config only four required secrets',async()=>{
 const {build}=await import('esbuild');const {readFileSync}=await import('node:fs');const {SHARD_NAMES}=await import('../src/qualification/keyrings.js');
 const config=JSON.parse(readFileSync('wrangler.qualification-source-keys128-sealed.jsonc','utf8'));
 assert.deepEqual(config.secrets.required,SHARD_NAMES);assert.equal(Object.keys(config.vars).length,6);
 const source=await build({entryPoints:[config.main],bundle:true,write:false,metafile:true,format:'esm',platform:'browser',external:['cloudflare:workers']});
 assert.ok(Object.keys(source.metafile!.inputs).includes('src/qualification/hmac-capability.ts'));
 assert.ok(!Object.keys(source.metafile!.inputs).includes('src/qualification/artifacts/fixed-bindings.ts'));
 const normal=await build({entryPoints:['src/staging-worker.ts'],bundle:true,write:false,metafile:true,format:'esm',platform:'browser',external:['cloudflare:workers']});
 assert.ok(!Object.keys(normal.metafile!.inputs).some(p=>p.includes('/qualification/')&&!p.includes('storage-capability-core')));
 for(const forbidden of ['createQualifiedHmac','captureQualifiedAuthority','QUALIFICATION_HMAC_KEYRING_','requireOriginalRing','createWithLimit'])assert.ok(!normal.outputFiles[0].text.includes(forbidden));
});

test('captured qualified receiver mutation rejects before any digest or import',async()=>{
 const {SOURCE129,SHARD_NAMES}=await import('../src/qualification/keyrings.js');
 const {captureQualifiedAuthority,importQualifiedAuthority}=await import('../src/qualification/hmac-capability.js');
 const signal=new AbortController().signal,bindings:Record<string,string>={},secrets:string[]=[];let cryptoCalls=0;
 const subtle={digest:async()=>{cryptoCalls++;throw Error('forbidden');},importKey:async()=>{cryptoCalls++;throw Error('forbidden');},verify:async()=>false} as unknown as SubtleCrypto;
 try{
  for(let i=0;i<129;i++){const bytes=crypto.getRandomValues(new Uint8Array(32));try{secrets.push(Buffer.from(bytes).toString('base64'));}finally{bytes.fill(0);}}
  SHARD_NAMES.forEach((n,i)=>bindings[n]=JSON.stringify(secrets.slice(i*65,(i+1)*65)));
  const captured=captureQualifiedAuthority(SOURCE129,bindings,subtle,signal);bindings[SHARD_NAMES[0]]='[]';
  await assert.rejects(()=>importQualifiedAuthority(captured,()=>new Date().toISOString(),signal));assert.equal(cryptoCalls,0);
 }finally{secrets.fill('');for(const n of Object.keys(bindings))delete bindings[n];}
});

// Regression qualification of the already-green shared engine, not invented RED history.
async function ringFixture(full=false){
 const m=await import('../src/qualification/keyrings.js'),ring=full?m.FULL258:m.SOURCE129,bindings:Record<string,string>={},secrets:string[]=[],signers:CryptoKey[]=[];
 for(const d of ring.descriptors){const bytes=crypto.getRandomValues(new Uint8Array(32));try{secrets.push(Buffer.from(bytes).toString('base64'));signers.push(await crypto.subtle.importKey('raw',bytes,{name:'HMAC',hash:'SHA-256'},false,['sign']));}finally{bytes.fill(0);}}
 m.SHARD_NAMES.forEach((n,i)=>bindings[n]=JSON.stringify(secrets.slice(i*65,(i+1)*65)));
 return {ring,bindings,signers,erase(){secrets.fill('');signers.length=0;for(const n of Object.keys(bindings))delete bindings[n];}};
}
test('full258 cold ring verifies every independent current and next including all shard boundaries',async()=>{
 const {createQualifiedHmac}=await import('../src/qualification/hmac-capability.js'),f=await ringFixture(true),signal=new AbortController().signal,now=()=> '2026-10-13T23:58:00.000Z';
 let imports=0,digests=0;const native=crypto.subtle,subtle={digest:async(...args:Parameters<SubtleCrypto['digest']>)=>{digests++;return native.digest(...args);},importKey:async(...args:Parameters<SubtleCrypto['importKey']>)=>{imports++;return (native.importKey as Function).apply(native,args);},verify:native.verify.bind(native)} as SubtleCrypto;
 try{
  const start=performance.now(),cpu=process.cpuUsage(),before=process.memoryUsage();const v=await createQualifiedHmac(f.ring,f.bindings,now,subtle,signal);
  console.log(JSON.stringify({measurement:'node22-single-cold-full258-import',elapsed_ms:performance.now()-start,cpu_us:process.cpuUsage(cpu),rss_before:before.rss,rss_after:process.memoryUsage().rss,heap_before:before.heapUsed,heap_after:process.memoryUsage().heapUsed,limits:'process snapshots, not workerd CPU/native-key peak memory/startup'}));
  assert.equal(imports,258);assert.equal(digests,258);
  const body=new TextEncoder().encode('{}'),digest=Buffer.from(await native.digest('SHA-256',body)).toString('hex');
  for(let i=0;i<258;i++){
   const r=f.ring.descriptors[i],signed_at=now(),nonce='ring-'+i;
   const message=new TextEncoder().encode(JSON.stringify(['apacely-synthetic-ingress-hmac-v1','staging',r.provider,r.principal,r.source,r.key_id,'POST',r.route,signed_at,nonce,digest]));
   const signature=Buffer.from(await native.sign('HMAC',f.signers[i],message)).toString('base64url'),headers=new Headers({'apacely-key-id':r.key_id,'apacely-source':r.source,'apacely-signed-at':signed_at,'apacely-nonce':nonce,'apacely-signature':signature});
   const input={headers,body,body_digest:digest,method:'POST',path:r.route,provider:r.provider,signal};
   assert.equal((await v.verify(input))?.key_id,r.key_id,'ordinal '+i);
   headers.set('apacely-source',r.source==='source-001'?'source-002':'source-001');assert.equal(await v.verify(input),null);
  }
 }finally{f.erase();}
});
test('baseline exact128 remains bounded and qualifier clones 259 layouts reject before crypto',async()=>{
 const f=await ringFixture(),{createQualifiedHmac}=await import('../src/qualification/hmac-capability.js');let calls=0;
 const subtle={digest:async()=>{calls++;throw Error('forbidden');},importKey:async()=>{calls++;throw Error('forbidden');},verify:async()=>false} as unknown as SubtleCrypto;
 try{
  for(const count of [129,258])await assert.rejects(()=>SyntheticHmacVerifier.create('staging',Array.from({length:count},()=>({...f.ring.descriptors[0],bytes:new Uint8Array(32)})),()=>new Date().toISOString(),subtle));
  for(const forged of [{...f.ring},{...f.ring,counts:[65,65,65,64],descriptors:Array(259).fill(f.ring.descriptors[0])}])await assert.rejects(()=>createQualifiedHmac(forged,f.bindings,()=>new Date().toISOString(),subtle,new AbortController().signal));
  assert.equal(calls,0);
 }finally{f.erase();}
});
test('all four exact canonical shards and global aliases fail closed with zero cryptography',async()=>{
 const f=await ringFixture(),{captureQualifiedAuthority}=await import('../src/qualification/hmac-capability.js'),{SHARD_NAMES}=await import('../src/qualification/keyrings.js');let calls=0,getters=0;
 const subtle={digest:async()=>{calls++;throw Error('forbidden');},importKey:async()=>{calls++;throw Error('forbidden');},verify:async()=>false} as unknown as SubtleCrypto;
 try{
  const baseline={...f.bindings},a=JSON.parse(baseline[SHARD_NAMES[0]]),b=JSON.parse(baseline[SHARD_NAMES[1]]);
  const variants:Record<string,unknown>[]=[];
  const missing={...baseline};delete missing[SHARD_NAMES[3]];variants.push(missing);
  variants.push({...baseline,[SHARD_NAMES[2]]:undefined},{...baseline,[SHARD_NAMES[0]]:JSON.stringify([...a,a[0]])},{...baseline,[SHARD_NAMES[0]]:' '.repeat(3057)},{...baseline,[SHARD_NAMES[0]]:' '+baseline[SHARD_NAMES[0]]},{...baseline,[SHARD_NAMES[0]]:baseline[SHARD_NAMES[0]].replace('"','"\\u0041')},{...baseline,[SHARD_NAMES[1]]:JSON.stringify([a[0],...b.slice(1)])},{...baseline,QUALIFICATION_SIGNING_KEY_UNUSED:'forbidden'},{...baseline,QUALIFICATION_HMAC_KEYRING_5:'[]'});
  for(const length of [31,33]){const bytes=crypto.getRandomValues(new Uint8Array(length));try{variants.push({...baseline,[SHARD_NAMES[0]]:JSON.stringify([Buffer.from(bytes).toString('base64'),...a.slice(1)])});}finally{bytes.fill(0);}}
  for(const hidden of [true,false]){const env={...baseline};Object.defineProperty(env,SHARD_NAMES[0],hidden?{enumerable:false,value:baseline[SHARD_NAMES[0]]}:{enumerable:true,get(){getters++;throw Error('hostile');}});variants.push(env);}
  const reserved={...baseline};Object.defineProperty(reserved,'QUALIFICATION_SIGNING_KEY_HOSTILE',{enumerable:true,get(){getters++;throw Error('hostile');}});variants.push(reserved,Object.create(baseline));
  for(let i=0;i<variants.length;i++)assert.throws(()=>captureQualifiedAuthority(f.ring,variants[i],subtle,new AbortController().signal),'variant '+i);
  assert.equal(calls,0);assert.equal(getters,0);
 }finally{f.erase();}
});
test('mid-ring abort stops the next import and zeroes all observed raw key snapshots',async()=>{
 const f=await ringFixture(true),{createQualifiedHmac}=await import('../src/qualification/hmac-capability.js'),controller=new AbortController(),seen:Uint8Array[]=[];let imports=0;
 const native=crypto.subtle,subtle={digest:native.digest.bind(native),verify:native.verify.bind(native),importKey:async(...args:Parameters<SubtleCrypto['importKey']>)=>{imports++;seen.push(args[1] as Uint8Array);const key=await (native.importKey as Function).apply(native,args);if(imports===65)controller.abort();return key;}} as SubtleCrypto;
 try{await assert.rejects(()=>createQualifiedHmac(f.ring,f.bindings,()=>new Date().toISOString(),subtle,controller.signal));assert.equal(imports,65);assert.ok(seen.every(bytes=>bytes.every(b=>b===0)));}finally{f.erase();}
});

test('source129 fixed build metadata exactly matches original shard descriptor authority',async()=>{
 const {SOURCE129}=await import('../src/qualification/keyrings.js'),{sourceKeys128}=await import('../src/qualification/artifacts/fixed-bindings.js');
 assert.equal((sourceKeys128({}) as Record<string,string>).QUALIFICATION_HMAC_KEY_REGISTRY,SOURCE129.registry);
});
