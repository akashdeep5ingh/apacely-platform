import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateInput, SliceError, fingerprint} from '../src/contracts.js';
import {fixture} from '../src/fixture.js';
import {createHash} from 'node:crypto';
test('UTC ISO timestamps allow fractional seconds but reject impossible calendar dates',()=>{
 for(const occurred_at of ['2026-01-01T12:00:00Z','2026-01-01T12:00:00.1Z','2026-01-01T12:00:00.12Z','2026-01-01T12:00:00.123456Z']) assert.equal(validateInput({...fixture,occurred_at}).occurred_at,occurred_at);
 for(const occurred_at of ['2026-01-01T24:00:00Z','2026-02-29T12:00:00Z','2026-01-01T12:00:60Z','2026-01-01T12:00:00+00:00']) assert.throws(()=>validateInput({...fixture,occurred_at}),{code:'validation'});
});
test('validates declared patch and rejects forged/malformed inputs with typed errors', () => {
 assert.deepEqual(validateInput(fixture),fixture);
 for (const patch of [{tenant_id:'forged'},{environment:'production'},{source_binding:'forged'},{handoff_ready:true},{schema_version:2},{source_sequence:0},{source_sequence:1.1},{source_event_id:''},{occurred_at:'2026-02-30T12:00:00.000Z'},{occurred_at:'2026-01-01T12:00:00+01:00'},{channel:'email'},{text:4},{handoff_requested:undefined},{qualification:{intent:'invest'}},{qualification:{location:'x'.repeat(121)}},{qualification:{handoff_ready:true}}]) assert.throws(()=>validateInput({...fixture,...patch}),SliceError);
 assert.throws(()=>validateInput(null),SliceError);
 assert.deepEqual(validateInput({...fixture,qualification:{location:' Toronto ',intent:null}}).qualification,{location:'Toronto',intent:null});
});
test('canonical UTF-8 fingerprint has declared ordering, preserves null vs omitted', () => {
 // SHA-256 over UTF-8 JSON array: version, lead key, sequence, occurrence,
 // channel, contact, text, supplied [field,value] pairs in policy order, request.
 const canonical=JSON.stringify([1,'mock-lead-001',1,'2026-01-01T12:00:00.000Z','mock','synthetic-contact-001',fixture.text,[['intent','buy'],['timeline','0_3_months'],['financing_status','preapproved'],['location','Toronto'],['property_type','condo']],true]);
 assert.equal(fingerprint(validateInput(fixture)),createHash('sha256').update(canonical,'utf8').digest('hex'));
 const reordered={...fixture,qualification:{property_type:'condo',location:'Toronto',financing_status:'preapproved',timeline:'0_3_months',intent:'buy'}};
 assert.equal(fingerprint(validateInput(fixture)),fingerprint(validateInput(reordered)));
 assert.notEqual(fingerprint(validateInput({...fixture,qualification:{}})),fingerprint(validateInput({...fixture,qualification:{intent:null}})));
});
