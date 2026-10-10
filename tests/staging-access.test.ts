import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPair, exportJWK, SignJWT, type JWTPayload} from 'jose';
import {createAccessVerifier} from '../src/staging-access.js';

// Deliberately public synthetic configuration. Signing keys exist only in RAM;
// only public JWK material is exported, never private key material.
const issuer = 'https://synthetic-access-test.cloudflareaccess.com';
const audience = '1234567890abcdef'.repeat(4);
const keys = await generateKeyPair('RS256', {modulusLength:2048});
const publicJwk = {...await exportJWK(keys.publicKey), kid:'public-test-key', alg:'RS256', use:'sig'};
const now = () => Math.floor(Date.now()/1000);
async function token(overrides:JWTPayload = {}, header:Record<string,unknown> = {}) {
 return new SignJWT({iss:issuer,aud:[audience],iat:now()-1,exp:now()+120,...overrides})
 .setProtectedHeader({alg:'RS256',kid:'public-test-key',...header}).sign(keys.privateKey);
}
function headers(jwt:string) { return new Headers({'Cf-Access-Jwt-Assertion':jwt}); }
function jwks(value:unknown = {keys:[publicJwk]}) {return Response.json(value);}

for (const badIssuer of ['http://x.cloudflareaccess.com','https://x.cloudflareaccess.com/','https://x.cloudflareaccess.com:443','https://u@x.cloudflareaccess.com','https://x.y.cloudflareaccess.com','https://x.cloudflareaccess.com?x=1','https://x.cloudflareaccess.com#x','https://TEAM.cloudflareaccess.com','https://placeholder.cloudflareaccess.com','https://-x.cloudflareaccess.com','https://x-.cloudflareaccess.com']) {
 test('reject trusted issuer configuration: '+badIssuer,()=>{
  assert.throws(()=>createAccessVerifier({issuer:badIssuer,audience},async()=>jwks()),/Invalid Access configuration/);
 });
}
for(const badAudience of ['', '0'.repeat(64),'f'.repeat(64),audience.toUpperCase(),audience+'0','placeholder']) {
 test('reject invalid audience configuration: '+badAudience.slice(0,12),()=>{
  assert.throws(()=>createAccessVerifier({issuer,audience:badAudience},async()=>jwks()),/Invalid Access configuration/);
 });
}
for(const [name,claims] of Object.entries({
 expired:{exp:now()-1}, future:{iat:now()+60}, fractionalIat:{iat:now()-0.5},fractionalExp:{exp:now()+60.5},
 missingIat:{iat:undefined},missingExp:{exp:undefined},missingIssuer:{iss:undefined},missingAudience:{aud:undefined},
 wrongIssuer:{iss:'https://evil.example'}, wrongAudience:{aud:'wrong'},futureNbf:{nbf:now()+60},fractionalNbf:{nbf:now()-0.5},
 negativeIat:{iat:-1},zeroLifetime:{iat:now(),exp:now()}, excessiveLifetime:{iat:now()-1,exp:now()+86400},
 stale:{iat:now()-86401,exp:now()+1},
})) {
 test('deny claims: '+name,async()=>{
  assert.equal(await createAccessVerifier({issuer,audience},async()=>jwks()).verify(headers(await token(claims))),false);
 });
}
for(const [name,assertion] of Object.entries({empty:'',spaces:'a b.c.d',comma:'a.b.c,a.b.c',large:'a'.repeat(8193),malformed:'not-a-token'})) {
 test('deny assertion before fetch: '+name,async()=>{
  let calls=0;
  assert.equal(await createAccessVerifier({issuer,audience},async()=>{calls++;return jwks();}).verify(headers(assertion)),false);
  assert.equal(calls,0);
 });
}
test('identity headers alone cannot grant Access',async()=>{
 let calls=0;
 assert.equal(await createAccessVerifier({issuer,audience},async()=>{calls++;return jwks();}).verify(new Headers({'Cf-Access-Authenticated-User-Email':'synthetic@example.test'})),false);
 assert.equal(calls,0);
});

test('genuine RS256 Access transport proof uses only the fixed trusted cert endpoint', async () => {
 let calls=0;
 const fetcher:typeof fetch = async (input,init) => {
  calls++;
  assert.equal(String(input),issuer+'/cdn-cgi/access/certs');
  assert.equal(init?.method,'GET');
  assert.equal(init?.redirect,'manual');
  assert.ok(init?.signal instanceof AbortSignal);
  return jwks();
 };
 const verifier=createAccessVerifier({issuer,audience},fetcher);
 assert.equal(await verifier.verify(headers(await token())),true);
 assert.equal(calls,1);
 assert.ok(Object.isFrozen(verifier));
 assert.deepEqual(Object.keys(verifier),['verify']);
});

for(const [name,response] of Object.entries({
 redirect:new Response(null,{status:302,headers:{location:'https://untrusted.example/certs'}}),
 httpError:new Response(null,{status:503}),
 media:new Response(JSON.stringify({keys:[publicJwk]}),{headers:{'content-type':'text/plain'}}),
 encoding:new Response(JSON.stringify({keys:[publicJwk]}),{headers:{'content-type':'application/json','content-encoding':'gzip'}}),
 oversized:new Response(' '.repeat(32769),{headers:{'content-type':'application/json'}}),
 badLength:new Response(JSON.stringify({keys:[publicJwk]}),{headers:{'content-type':'application/json','content-length':'001'}}),
 emptyKeys:jwks({keys:[]}), excessKeys:jwks({keys:Array.from({length:17},(_,i)=>({...publicJwk,kid:'public-'+i}))}),
 duplicateKid:jwks({keys:[publicJwk,publicJwk]}), privateMaterial:jwks({keys:[{...publicJwk,d:'deliberately-inert-not-a-private-key'}]}),
 weakRsa:jwks({keys:[{...publicJwk,n:'AQAB'}]}), malformedJson:new Response('{bad',{headers:{'content-type':'application/json'}}),
 unknownRoot:jwks({keys:[publicJwk],untrusted:1}),
}))test('deny bounded JWKS response: '+name,async()=>{
 assert.equal(await createAccessVerifier({issuer,audience},async()=>response).verify(headers(await token())),false);
});
for (const [name,init] of Object.entries<ResponseInit>({
 status:{status:503,headers:{'content-type':'application/json'}},
 media:{headers:{'content-type':'text/plain'}},
 encoding:{headers:{'content-type':'application/json','content-encoding':'gzip'}},
 badLength:{headers:{'content-type':'application/json','content-length':'001'}},
 oversizedLength:{headers:{'content-type':'application/json','content-length':'32769'}},
})) test('metadata rejection cancels unread JWKS body: '+name,async()=>{
 let cancelled=false;
 const response=new Response(new ReadableStream<Uint8Array>({cancel(){cancelled=true;}}),init);
 assert.equal(await createAccessVerifier({issuer,audience},async()=>response).verify(headers(await token())),false);
 assert.equal(cancelled,true,'denied response must relinquish its unread body');
});
test('untrusted response destination cancels unread JWKS body',async()=>{
 let cancelled=false;
 const response=new Response(new ReadableStream<Uint8Array>({cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}});
 Object.defineProperty(response,'url',{value:'https://untrusted.example/certs'});
 assert.equal(await createAccessVerifier({issuer,audience},async()=>response).verify(headers(await token())),false);
 assert.equal(cancelled,true);
});

test('JWKS chunk flood denies and cancels its reader',async()=>{
 let cancelled=false;
 const response=new Response(new ReadableStream<Uint8Array>({start(c){for(let i=0;i<129;i++)c.enqueue(new Uint8Array());},cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}});
 assert.equal(await createAccessVerifier({issuer,audience},async()=>response).verify(headers(await token())),false);
 assert.equal(cancelled,true);
});
test('pre-aborted request never retrieves keys',async()=>{
 let calls=0;const controller=new AbortController();controller.abort();
 assert.equal(await createAccessVerifier({issuer,audience},async()=>{calls++;return jwks();}).verify(headers(await token()),controller.signal),false);
 assert.equal(calls,0);
});
test('ingress abort cancels hung JWKS body without accepting or retrying',async()=>{
 const controller=new AbortController();let cancelled=false,calls=0;
 const proof=headers(await token());
 const response=new Response(new ReadableStream<Uint8Array>({cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}});
 const timer=setTimeout(()=>controller.abort(),20);
 try{assert.equal(await createAccessVerifier({issuer,audience},async()=>{calls++;return response;}).verify(proof,controller.signal),false);}finally{clearTimeout(timer);}
 assert.equal(cancelled,true);assert.equal(calls,1);
});
test('tampered signature never grants Access',async()=>{
 const parts=(await token()).split('.');
 const bytes=Buffer.from(parts[2]!, 'base64url');bytes[0]=bytes[0]!^1;parts[2]=bytes.toString('base64url');
 assert.equal(await createAccessVerifier({issuer,audience},async()=>jwks()).verify(headers(parts.join('.'))),false);
});
test('signature from an unrelated signer never grants Access',async()=>{
 const other=await generateKeyPair('RS256',{modulusLength:2048});
 const jwt=await new SignJWT({iss:issuer,aud:audience,iat:now()-1,exp:now()+120}).setProtectedHeader({alg:'RS256',kid:publicJwk.kid}).sign(other.privateKey);
 assert.equal(await createAccessVerifier({issuer,audience},async()=>jwks()).verify(headers(jwt)),false);
});
test('unsupported RS512 algorithm cannot select a verification downgrade',async()=>{
 const other=await generateKeyPair('RS512',{modulusLength:2048});
 const jwt=await new SignJWT({iss:issuer,aud:audience,iat:now()-1,exp:now()+120}).setProtectedHeader({alg:'RS512',kid:publicJwk.kid}).sign(other.privateKey);
 let calls=0;assert.equal(await createAccessVerifier({issuer,audience},async()=>{calls++;return jwks();}).verify(headers(jwt)),false);assert.equal(calls,0);
});
test('unknown critical JWT header never grants Access',async()=>{
 const jwt=await new SignJWT({iss:issuer,aud:audience,iat:now()-1,exp:now()+120}).setProtectedHeader({alg:'RS256',kid:publicJwk.kid,crit:['synthetic'],synthetic:true}).sign(keys.privateKey,{crit:{synthetic:true}});
 assert.equal(await createAccessVerifier({issuer,audience},async()=>jwks()).verify(headers(jwt)),false);
});
test('negative not-before claim never grants Access',async()=>{
 assert.equal(await createAccessVerifier({issuer,audience},async()=>jwks()).verify(headers(await token({nbf:-1}))),false);
});
test('subordinate timeout cancels a cooperative hung JWKS body',async()=>{
 let cancelled=false,calls=0;
 const response=new Response(new ReadableStream<Uint8Array>({cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}});
 assert.equal(await createAccessVerifier({issuer,audience},async()=>{calls++;return response;}).verify(headers(await token())),false);
 assert.equal(cancelled,true);assert.equal(calls,1);
});
test('ingress abort cancels pending cooperative JWKS fetch without retry',async()=>{
 const controller=new AbortController();let calls=0,aborted=false;
 const fetcher:typeof fetch=async(_input,init)=>{calls++;return new Promise<Response>((_resolve,reject)=>{
  init!.signal!.addEventListener('abort',()=>{aborted=true;reject(new DOMException('Aborted','AbortError'));},{once:true});queueMicrotask(()=>controller.abort());
 });};
 assert.equal(await createAccessVerifier({issuer,audience},fetcher).verify(headers(await token()),controller.signal),false);
 assert.equal(aborted,true);assert.equal(calls,1);
});

test('unknown kid never probes a token-specified URL or retries key retrieval',async()=>{
 let calls=0;
 assert.equal(await createAccessVerifier({issuer,audience},async(input)=>{calls++;assert.equal(String(input),issuer+'/cdn-cgi/access/certs');return jwks();}).verify(headers(await token({}, {kid:'unknown',jku:'https://untrusted.example/keys'}))),false);
 assert.equal(calls,1);
});
