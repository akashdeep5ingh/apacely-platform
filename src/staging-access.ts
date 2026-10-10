import {createRemoteJWKSet,customFetch,jwtVerify} from 'jose';

const MAX_ASSERTION=8192,MAX_JWKS=32768,MAX_CHUNKS=128,MAX_KEYS=16,MAX_LIFETIME=86400;
function base64url(value:unknown,max:number):value is string {
 if(typeof value!=='string'||value.length<1||value.length>max||!/^[A-Za-z0-9_-]+$/.test(value)||value.length%4===1)return false;
 try{const decoded=atob(value.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-value.length%4)%4));return btoa(decoded).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'')===value;}catch{return false;}
}
function publicKeys(value:unknown):unknown {
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid public keys');
 const root=value as Record<string,unknown>,keys=root.keys;
 // Access also publishes legacy public certificate metadata. It is bounded but never used as authority.
 if(Object.keys(root).some(k=>!['keys','public_cert','public_certs','cert'].includes(k))||!Array.isArray(keys)||keys.length<1||keys.length>MAX_KEYS)throw Error('Invalid public keys');
 const ids=new Set<string>();
 for(const key of keys){
  if(!key||typeof key!=='object'||Array.isArray(key))throw Error('Invalid public key');
  const k=key as Record<string,unknown>;
  if(Object.keys(k).some(name=>!['kty','kid','use','alg','n','e','x5c','x5t','x5t#S256','key_ops'].includes(name))||k.kty!=='RSA'||typeof k.kid!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(k.kid)||ids.has(k.kid)||k.use!==undefined&&k.use!=='sig'||k.alg!==undefined&&k.alg!=='RS256'||!base64url(k.n,1366)||!base64url(k.e,12))throw Error('Invalid public key');
  const n=atob(k.n.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-k.n.length%4)%4));
  const e=atob(k.e.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-k.e.length%4)%4));
  if(n.length<256||n.length>1024||n.charCodeAt(0)===0||e.length>4||e.length===0||e.charCodeAt(0)===0)throw Error('Invalid RSA key');
  let exponent=0;for(const byte of e)exponent=exponent*256+byte.charCodeAt(0);
  if(exponent<3||exponent%2!==1||n.length===256&&n.charCodeAt(0)<128)throw Error('Invalid RSA key');
  if(k.key_ops!==undefined&&(!Array.isArray(k.key_ops)||k.key_ops.length!==1||k.key_ops[0]!=='verify'))throw Error('Invalid key usage');
  ids.add(k.kid);
 }
 return {keys};
}
function rejectResponse(response:Response):never {
 // Cancelling an unread denied response must not introduce an await outside the retained lifetime.
 try{void response.body?.cancel().catch(()=>undefined);}catch{/* Already locked or disposed. */}
 throw Error('Unavailable public keys');
}
async function boundedKeys(response:Response,signal:AbortSignal):Promise<Response>{
 if(signal.aborted||response.status!==200||response.redirected||!/^application\/json(?:;\s*charset=utf-8)?$/i.test(response.headers.get('content-type')??'')||response.headers.has('content-encoding'))rejectResponse(response);
 const length=response.headers.get('content-length');
 if(length!==null&&(!/^(0|[1-9][0-9]*)$/.test(length)||Number(length)>MAX_JWKS))rejectResponse(response);
 if(!response.body)throw Error('Missing public keys');
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0,count=0;
 const cancel=()=>{void reader.cancel().catch(()=>undefined);};signal.addEventListener('abort',cancel,{once:true});
 try{
  if(signal.aborted)throw Error('Cancelled public keys');
  for(;;){const next=await reader.read();if(signal.aborted)throw Error('Cancelled public keys');if(next.done)break;size+=next.value.byteLength;if(++count>MAX_CHUNKS||size>MAX_JWKS)throw Error('Oversized public keys');chunks.push(next.value);}
  if(size<1||length!==null&&size!==Number(length))throw Error('Invalid public keys length');
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return Response.json(publicKeys(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))));
 }catch(error){cancel();throw error;}finally{signal.removeEventListener('abort',cancel);reader.releaseLock();}
}
/** Standard transport proof only. No claims become tenant/source/Principal authority.
 * A subordinate two-second network abort shares the existing ingress signal; abort is cooperative.
 * Synthetic staging permits at most a 24-hour Access token lifetime; future Access policy needs approval. */
export function createAccessVerifier(config:Readonly<{issuer:string;audience:string}>,fetcher:typeof fetch=globalThis.fetch):Readonly<{verify(headers:Headers,signal?:AbortSignal):Promise<boolean>}>{
 const {issuer,audience}=config;
 const match=/^https:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.cloudflareaccess\.com$/.exec(issuer);
 if(!match||/^(?:team|placeholder|example|changeme|replace-me)$/.test(match[1])||!/^[a-f0-9]{64}$/.test(audience)||/^(?:0{64}|f{64})$/.test(audience)||typeof fetcher!=='function')throw new TypeError('Invalid Access configuration');
 const certs=issuer+'/cdn-cgi/access/certs';
 return Object.freeze({async verify(headers:Headers,signal?:AbortSignal):Promise<boolean>{
  try{
   const assertion=headers.get('Cf-Access-Jwt-Assertion');
   if(!assertion||assertion.length>MAX_ASSERTION||signal?.aborted)return false;
   const pieces=assertion.split('.');if(pieces.length!==3||pieces.some(part=>!base64url(part,MAX_ASSERTION)))return false;
   let calls=0;
   const resolver=createRemoteJWKSet(new URL(certs),{timeoutDuration:2000,cooldownDuration:30000,cacheMaxAge:30000,[customFetch]:async(url,init)=>{
    if(String(url)!==certs||++calls!==1||signal?.aborted)throw Error('Untrusted public-key request');
    const controller=new AbortController(),signals=[signal,init?.signal].filter((s):s is AbortSignal=>Boolean(s));
    const abort=()=>controller.abort();for(const s of signals){s.addEventListener('abort',abort,{once:true});if(s.aborted)abort();}
    const timer=setTimeout(abort,2000);
    try{const response=await fetcher(certs,{...init,method:'GET',redirect:'manual',signal:controller.signal});if(response.url&&response.url!==certs)rejectResponse(response);return await boundedKeys(response,controller.signal);}
    finally{clearTimeout(timer);for(const s of signals)s.removeEventListener('abort',abort);}
   }});
   const {payload}=await jwtVerify(assertion,resolver,{algorithms:['RS256'],issuer,audience,requiredClaims:['iss','aud','exp','iat'],clockTolerance:0});
   const now=Math.floor(Date.now()/1000),{iat,exp,nbf}=payload;
   if(!Number.isSafeInteger(iat)||!Number.isSafeInteger(exp)||iat!<0||iat!>now+30||exp!<=now||exp!<=iat!||exp!-iat!>MAX_LIFETIME||now-iat!>MAX_LIFETIME||nbf!==undefined&&(!Number.isSafeInteger(nbf)||nbf<0))return false;
   return !signal?.aborted;
  }catch{return false;}
 }});
}
