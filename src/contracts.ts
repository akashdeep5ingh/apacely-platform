import {createHash, randomUUID} from 'node:crypto';
export class SliceError extends Error { constructor(public code: 'validation'|'context'|'conflict'|'retry_exhausted', message:string) { super(message); this.name='SliceError'; } }
export const POLICY='mock-qualification-v1';
export const fields=['intent','timeline','financing_status','location','property_type'] as const;
export type Field=typeof fields[number];
export type Facts=Record<Field,string|null>;
export interface Input {schema_version:1;source_event_id:string;source_lead_id:string;source_sequence:number;occurred_at:string;channel:'mock';contact_reference:string;text:string;qualification:Partial<Facts>;handoff_requested:boolean}
export interface Context {environment:'development';source_binding:string;operation:'ingest_mock_lead'}
export interface Scope {tenant_id:string;environment:'development'}
export const uuidV4=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const defaultId=()=>randomUUID();
const enums:Partial<Record<Field,readonly string[]>>={intent:['buy','rent','sell','unknown'],timeline:['0_3_months','3_6_months','over_6_months','unknown'],financing_status:['preapproved','cash','not_started','unknown'],property_type:['condo','house','townhouse','commercial','unknown']};
function fail(message:string):never {throw new SliceError('validation',message);}
function object(value:unknown):Record<string,unknown> {if (!value||typeof value!=='object'||Array.isArray(value)) return fail('Expected object'); return value as Record<string,unknown>;}
export function utc(value:unknown):value is string {
 if(typeof value!=='string') return false;
 const match=/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/.exec(value);
 if(!match) return false;
 const millis=(match[2]??'').padEnd(3,'0').slice(0,3),normalized=`${match[1]}.${millis}Z`;
 return Number.isFinite(Date.parse(normalized))&&new Date(normalized).toISOString()===normalized;
}
export function validateInput(raw:unknown):Input {
 const x=object(raw), allowed=['schema_version','source_event_id','source_lead_id','source_sequence','occurred_at','channel','contact_reference','text','qualification','handoff_requested'];
 if(Object.keys(x).some(k=>!allowed.includes(k))||allowed.some(k=>!Object.hasOwn(x,k))) fail('Undeclared or missing input field');
 if(x.schema_version!==1||x.channel!=='mock'||!Number.isSafeInteger(x.source_sequence)||(x.source_sequence as number)<1||!utc(x.occurred_at)||typeof x.text!=='string'||typeof x.handoff_requested!=='boolean') fail('Malformed input');
 for(const key of ['source_event_id','source_lead_id','contact_reference']) if(typeof x[key]!=='string'||!(x[key] as string).trim()) fail(`Invalid ${key}`);
 const patch=object(x.qualification), qualification:Partial<Facts>={};
 for(const [key,value] of Object.entries(patch)) {
  if(!fields.includes(key as Field)) fail('Undeclared qualification field');
  const f=key as Field;
  if(value===null) qualification[f]=null;
  else if(f==='location') {if(typeof value!=='string'||!value.trim()||value.trim().length>120) fail('Invalid location'); qualification[f]=value.trim();}
  else {if(typeof value!=='string'||!enums[f]!.includes(value)) fail(`Invalid ${f}`); qualification[f]=value;}
 }
 return {...x,qualification} as unknown as Input;
}
/** SHA-256 of UTF-8 JSON array, fixed top-level and qualification field order.
 * Qualification uses [field,value] entries only when supplied (null != omitted). */
export function fingerprint(x:Input):string {return createHash('sha256').update(JSON.stringify([x.schema_version,x.source_lead_id,x.source_sequence,x.occurred_at,x.channel,x.contact_reference,x.text,fields.filter(f=>Object.hasOwn(x.qualification,f)).map(f=>[f,x.qualification[f]]),x.handoff_requested]),'utf8').digest('hex');}
