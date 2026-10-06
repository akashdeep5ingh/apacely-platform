import {test} from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import http from 'node:http';
import dgram from 'node:dgram';
test('D1 loopback-only guard rejects external sockets, DNS, TLS, UDP and fetch',async()=>{
 const pattern=/External network forbidden/;
 assert.throws(()=>net.connect({host:'example.com',port:443}),pattern);
 assert.throws(()=>net.connect({host:'192.0.2.1',port:443}),pattern);
 assert.throws(()=>net.connect({host:'127.0.0.2',port:443}),pattern);
 assert.throws(()=>tls.connect({host:'127.0.0.1',port:443}),pattern);
 assert.throws(()=>dns.lookup('example.com',()=>{}),pattern);
 assert.throws(()=>dns.resolve('example.com',()=>{}),pattern);
 assert.throws(()=>dns.promises.resolve('example.com'),pattern);
 const socket=dgram.createSocket('udp4');try{assert.throws(()=>socket.send('no',53,'127.0.0.1'),pattern);}finally{socket.close();}
 assert.throws(()=>http.get('http://192.0.2.1'),pattern);
 await assert.rejects(fetch('https://example.com'),/fetch failed/);
});
test('D1 guard permits numeric loopback transport without DNS resolution',async()=>{
 const server=net.createServer(socket=>socket.end('local'));
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const address=server.address() as net.AddressInfo;
  const text=await new Promise<string>((resolve,reject)=>{let value='';const socket=net.connect({host:'127.0.0.1',port:address.port});socket.on('data',data=>value+=data);socket.on('end',()=>resolve(value));socket.on('error',reject);});
  assert.equal(text,'local');
 }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
