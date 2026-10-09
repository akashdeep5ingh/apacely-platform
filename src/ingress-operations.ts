import type {DistributedOptions} from './distributed-admission.js';
import {sha256} from '@noble/hashes/sha256';
import {bytesToHex} from '@noble/hashes/utils';
/** Local synthetic policy. No platform binding or distributed guarantees. */
export class DeadlineError extends Error {constructor(){super('deadline');}}
export interface Operation {signal:AbortSignal;check():void}
export class Deadline implements Operation {
 readonly signal:AbortSignal;
 #controller=new AbortController();#timer:ReturnType<typeof setTimeout>;#end:number;#clock:()=>number;
 readonly expired:Promise<never>;
 constructor(ms:number,clock:()=>number=Date.now){
  if(!Number.isSafeInteger(ms)||ms<1||ms>30000)throw new Error('Invalid local deadline');
  this.#clock=clock;const start=clock();if(!Number.isFinite(start))throw new Error('Invalid local clock');this.#end=start+ms;
  this.signal=this.#controller.signal;
  this.expired=new Promise((_,reject)=>{this.signal.addEventListener('abort',()=>reject(new DeadlineError()),{once:true});});
  this.#timer=setTimeout(()=>this.cancel(),ms);
 }
 get end():number{return this.#end;}
 cancel():void{this.#controller.abort();}
 check():void{const now=this.#clock();if(!Number.isFinite(now)||now>=this.#end)this.cancel();if(this.signal.aborted)throw new DeadlineError();}
 close():void{clearTimeout(this.#timer);}
}
export class OverloadError extends Error {constructor(){super('overloaded');}}
export class LocalAdmission {
 #active=0;#sources=new Map<string,number>();#global:number;#source:number;#maximum:number;
 constructor(global=16,source=4,maximum=128){
  if(![global,source,maximum].every(n=>Number.isSafeInteger(n)&&n>=1&&n<=1024))throw new Error('Invalid local admission');
  this.#global=global;this.#source=source;this.#maximum=maximum;
 }
 enter():()=>void{if(this.#active>=this.#global)throw new OverloadError();this.#active++;let released=false;return ()=>{if(!released){released=true;this.#active--;}};}
 source(key:string):()=>void{
  const count=this.#sources.get(key)??0;
  if(count>=this.#source||(!count&&this.#sources.size>=this.#maximum))throw new OverloadError();
  this.#sources.set(key,count+1);let released=false;
  return ()=>{if(released)return;released=true;const count=this.#sources.get(key)!;if(count===1)this.#sources.delete(key);else this.#sources.set(key,count-1);};
 }
 snapshot():Readonly<{active:number;sources:number}>{return Object.freeze({active:this.#active,sources:this.#sources.size});}
}
/** Counters only, no request objects, tenant context, body or cross-request I/O. */
export const localAdmission=new LocalAdmission(16,16,128);
export interface RateIdentity {provider:string;principal:string;source:string}
export type RateDecision={allowed:true}|{allowed:false;retryAfter:number};
export interface RatePolicy {preauth():RateDecision;authenticated(identity:Readonly<RateIdentity>):RateDecision}
export interface LocalRateOptions {clock?:()=>number;windowMs?:number;preauthLimit?:number;sourceLimit?:number;maxSources?:number}
/** Fixed-window synthetic counters. No IP/header buckets or privileged tiers. */
export class LocalRatePolicy implements RatePolicy {
 #clock:()=>number;#window:number;#start:number;#last:number;#pre=0;#sources=new Map<string,number>();#preLimit:number;#sourceLimit:number;#maximum:number;
 constructor(options:LocalRateOptions={}){
  this.#clock=options.clock??Date.now;this.#window=options.windowMs??10000;
  this.#preLimit=options.preauthLimit??1000;this.#sourceLimit=options.sourceLimit??100;this.#maximum=options.maxSources??128;
  if(!Number.isSafeInteger(this.#window)||this.#window<1000||this.#window>60000||![this.#preLimit,this.#sourceLimit,this.#maximum].every(x=>Number.isSafeInteger(x)&&x>=1&&x<=10000)||this.#maximum>1024)throw new Error('Invalid local rate policy');
  this.#start=this.#last=this.#clock();if(!Number.isFinite(this.#start))throw new Error('Invalid local rate clock');
 }
 #observe():{now:number;rollback:boolean}{const now=this.#clock();if(!Number.isFinite(now))throw new Error('Invalid local rate clock');const rollback=now<this.#last;this.#last=Math.max(this.#last,now);if(!rollback&&now>=this.#start+this.#window){this.#start=now;this.#pre=0;this.#sources.clear();}return {now,rollback};}
 #denied(now:number):RateDecision{return {allowed:false,retryAfter:Math.max(1,Math.min(60,Math.ceil((this.#start+this.#window-now)/1000)))};}
 preauth():RateDecision{const {now,rollback}=this.#observe();if(rollback||this.#pre>=this.#preLimit)return this.#denied(now);this.#pre++;return {allowed:true};}
 authenticated(identity:Readonly<RateIdentity>):RateDecision{
  if(!identity||![identity.provider,identity.principal,identity.source].every(x=>typeof x==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(x)))throw new Error('Invalid local rate identity');
  const {now,rollback}=this.#observe();if(rollback)return this.#denied(now);
  const key=bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([identity.provider,identity.principal,identity.source])))),count=this.#sources.get(key)??0;
  if(count>=this.#sourceLimit||(!count&&this.#sources.size>=this.#maximum))return this.#denied(now);
  this.#sources.set(key,count+1);return {allowed:true};
 }
 snapshot():Readonly<{sources:number}>{return Object.freeze({sources:this.#sources.size});}
}
export const localRates=new LocalRatePolicy();
export class RateError extends Error {constructor(readonly retryAfter:number){super('rate_limited');}}
export function enforceRate(decision:RateDecision):void {
 if(!decision||typeof decision.allowed!=='boolean')throw new Error('Invalid local rate decision');
 if(!decision.allowed){if(!Number.isSafeInteger(decision.retryAfter)||decision.retryAfter<1||decision.retryAfter>60)throw new Error('Invalid local retry interval');throw new RateError(decision.retryAfter);}
}
export interface OperationalOptions {admissionMode?:'local'|'distributed';distributed?:DistributedOptions;rates?:RatePolicy;deadlineMs?:number;clock?:()=>number;globalLimit?:number;sourceLimit?:number;maxSources?:number;admission?:LocalAdmission}
