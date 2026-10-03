import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evaluate} from '../src/qualification.js';
import {validateInput} from '../src/contracts.js';
import {fixture} from '../src/fixture.js';
import {fields} from '../src/contracts.js';
test('all declared buyer combinations qualify without geography or free-text inference',()=>{
 for(const timeline of ['0_3_months','3_6_months','over_6_months']) for(const financing_status of ['cash','preapproved']) for(const property_type of ['condo','house','townhouse']) {
 const result=evaluate({...fixture.qualification,timeline,financing_status,property_type,location:'Any synthetic location'},false);
 assert.equal(result.status,'qualified');assert.equal(result.handoff_ready,false);
 }
 for(const f of fields) for(const value of [null,'unknown']) {
 const result=evaluate({...fixture.qualification,[f]:value},true);assert.equal(result.status,'needs_more_information');assert.deepEqual(result.missing_fields,[f]);
 }
});
test('pure policy distinguishes explicit readiness from qualified buyer facts',()=>{
 const facts=validateInput(fixture).qualification;
 assert.deepEqual(evaluate(facts,true),{...facts,handoff_ready:true,status:'handoff_ready',reasons:['qualified_and_handoff_requested'],missing_fields:[]});
 assert.deepEqual(evaluate(facts,false),{...facts,handoff_ready:false,status:'qualified',reasons:['qualified_without_handoff_request'],missing_fields:[]});
 assert.deepEqual(facts,fixture.qualification);
});
test('outside scope takes precedence over incomplete facts and requested handoff',()=>{
 for(const facts of [{intent:'rent'},{intent:'sell'},{property_type:'commercial'}]) {
 const result=evaluate(facts,true);
 assert.equal(result.status,'disqualified');assert.equal(result.handoff_ready,false);
 assert.deepEqual(result.reasons,['outside_mock_scope']);assert.deepEqual(result.missing_fields,[]);
 }
});
test('incomplete policy reports fixed-order missing fields and financing pending',()=>{
 const facts=validateInput(fixture).qualification;
 assert.deepEqual(evaluate({...facts,financing_status:'unknown'},true),{...facts,financing_status:'unknown',handoff_ready:false,status:'needs_more_information',reasons:['missing_information'],missing_fields:['financing_status']});
 assert.deepEqual(evaluate({},true).missing_fields,['intent','timeline','financing_status','location','property_type']);
 assert.deepEqual(evaluate({...facts,location:'',financing_status:'not_started'},true).reasons,['financing_pending']);
 assert.deepEqual(evaluate({...facts,location:'',financing_status:'not_started'},true).missing_fields,['financing_status','location']);
});
