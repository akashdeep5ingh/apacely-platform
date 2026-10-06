import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import dgram from 'node:dgram';
import {syncBuiltinESMExports} from 'node:module';
const blocked=()=>{throw new Error('External network forbidden in local D1 tests');};
const allowed=host=>host==='127.0.0.1'||host==='::1';
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){
 const value=Array.isArray(args[0])?args[0][0]:args[0];
 const host=typeof value==='object'?value.host:(typeof args[1]==='string'?args[1]:undefined);
 if(!allowed(host)) return blocked();
 return connect.apply(this,args);
};
tls.connect=blocked;
dgram.Socket.prototype.send=blocked;
for(const target of [dns,dns.promises,dns.Resolver.prototype,dns.promises.Resolver.prototype]) {
 for(const name of ['lookup','lookupService','resolve','resolve4','resolve6','resolveAny','resolveCaa','resolveCname','resolveMx','resolveNaptr','resolveNs','resolveSoa','resolveSrv','resolveTxt','reverse']) if(typeof target[name]==='function') target[name]=blocked;
}
// Node's listener calls lookup even for a numeric loopback address.
dns.lookup=(host,options,callback)=>{
 if(!allowed(host)) return blocked();
 if(typeof options==='function'){callback=options;options={};}
 const address={address:host,family:host==='::1'?6:4};
 queueMicrotask(()=>options?.all?callback(null,[address]):callback(null,address.address,address.family));
};
syncBuiltinESMExports();
