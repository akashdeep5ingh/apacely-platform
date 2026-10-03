import {test} from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
test('fail-on-network guard blocks fetch, sockets, TLS, HTTP and DNS',()=>{
 for(const attempt of [()=>fetch('https://invalid.example'),()=>net.connect(443,'invalid.example'),()=>tls.connect(443,'invalid.example'),()=>http.get('http://invalid.example'),()=>https.get('https://invalid.example'),()=>dns.lookup('localhost',()=>{})]) assert.throws(attempt,/Network forbidden/);
});
