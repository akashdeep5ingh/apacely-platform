import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import dns from 'node:dns';
import {syncBuiltinESMExports} from 'node:module';
const blocked = () => { throw new Error('Network forbidden in mock slice'); };
net.Socket.prototype.connect = blocked;
net.connect = net.createConnection = blocked;
tls.connect = blocked;
http.request = http.get = https.request = https.get = blocked;
dgram.Socket.prototype.send = blocked;
for (const target of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
 for (const name of ['lookup','lookupService','resolve','resolve4','resolve6','resolveAny','resolveCaa','resolveCname','resolveMx','resolveNaptr','resolveNs','resolvePtr','resolveSoa','resolveSrv','resolveTxt','reverse']) {
  if (typeof target[name] === 'function') target[name] = blocked;
 }
}
globalThis.fetch = blocked;
syncBuiltinESMExports();
