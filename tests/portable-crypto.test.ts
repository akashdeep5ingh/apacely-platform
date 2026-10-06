import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fields,fingerprint,validateInput} from '../src/contracts.js';
import {fixture} from '../src/fixture.js';

test('portable synchronous fingerprints preserve Node SHA-256 for UTF-8 and block-boundary vectors',()=>{
 for(const text of ['', 'é漢字🙂\ud800', 'x'.repeat(55),'x'.repeat(56),'x'.repeat(63),'x'.repeat(64),'x'.repeat(65),'x'.repeat(10000)]){
  for(const qualification of [{},{location:null},{location:'Montréal',intent:'buy'}]){
   const input=validateInput({...fixture,text,qualification});
   const canonical=JSON.stringify([input.schema_version,input.source_lead_id,input.source_sequence,input.occurred_at,input.channel,input.contact_reference,input.text,fields.filter(f=>Object.hasOwn(input.qualification,f)).map(f=>[f,input.qualification[f]]),input.handoff_requested]);
   assert.equal(fingerprint(input),createHash('sha256').update(canonical,'utf8').digest('hex'));
  }
 }
});
