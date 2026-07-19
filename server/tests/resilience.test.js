import test from 'node:test';import assert from 'node:assert/strict';
import { CircuitBreaker, RateLimiter, retryAfterMs, retryDelay } from '../src/http/resilience.js';
import { PublicHttpClient } from '../src/http/client.js';
import { measureServerTime } from '../src/collector/time-guard.js';

test('指数退避按2次幂增长且有上限',()=>{const opt={baseMs:100,capMs:250,jitter:()=>1};assert.deepEqual([0,1,2,3].map(i=>retryDelay(i,opt)),[100,200,250,250]);});
test('Retry-After秒数优先于本地退避',()=>assert.equal(retryAfterMs(new Headers({'retry-after':'3'}),10),3000));
test('令牌桶阻止超额请求',()=>{const r=new RateLimiter({capacity:1,refillPerSecond:0,now:()=>0});assert.equal(r.take(),true);assert.equal(r.take(),false);});
test('熔断器连续失败后打开',()=>{const b=new CircuitBreaker({threshold:2,now:()=>0});b.failure();b.failure();assert.equal(b.allow(),false);assert.equal(b.state,'OPEN');});
test('熔断器冷却后半开并在成功后恢复',()=>{let now=0;const b=new CircuitBreaker({threshold:1,coolDownMs:10,now:()=>now});b.failure();now=11;assert.equal(b.allow(),true);assert.equal(b.state,'HALF_OPEN');b.success();assert.equal(b.state,'CLOSED');});
test('429尊重Retry-After并重试',async()=>{let calls=0;const waits=[];const fetch=async()=>{calls++;return calls===1?new Response('x',{status:429,headers:{'retry-after':'2'}}):new Response('{"ok":true}',{status:200});};const c=new PublicHttpClient({maxRetries:1},{fetch,sleep:async ms=>waits.push(ms)});assert.equal((await c.getJson('https://x')).body.ok,true);assert.deepEqual(waits,[2000]);});
test('超时被分类并按策略重试',async()=>{let calls=0;const fetch=async(_u,{signal})=>{calls++;return new Promise((_r,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(new Error(),{name:'AbortError'}))));};const c=new PublicHttpClient({timeoutMs:2,maxRetries:1,backoffBaseMs:1},{fetch,sleep:async()=>{}});await assert.rejects(c.getJson('https://x'),e=>e.code==='TIMEOUT');assert.equal(calls,2);});
test('永久4xx不重试',async()=>{let calls=0;const c=new PublicHttpClient({maxRetries:3},{fetch:async()=>{calls++;return new Response('bad',{status:400})},sleep:async()=>{}});await assert.rejects(c.getJson('https://x'),e=>e.status===400);assert.equal(calls,1);});
test('服务器时间记录四时间量和偏差',async()=>{const values=[1000,1020];const x=await measureServerTime({serverTime:async()=>({body:{serverTime:1012},requestId:'r'})},{now:()=>values.shift(),maxClockOffsetMs:5});assert.equal(x.estimatedNetworkMidpoint,1010);assert.equal(x.clockOffsetMs,2);assert.equal(x.roundTripMs,20);});
test('服务器时间异常响应fail closed',async()=>{const x=await measureServerTime({serverTime:async()=>({body:{}})},{now:()=>100,maxClockOffsetMs:5});assert.equal(x.ok,false);assert.equal(x.reason,'SERVER_TIME_INVALID');});
test('服务器时间请求失败fail closed',async()=>{const x=await measureServerTime({serverTime:async()=>{throw Object.assign(new Error(),{code:'TIMEOUT'})}},{now:()=>100,maxClockOffsetMs:5});assert.equal(x.reason,'SERVER_TIME_UNAVAILABLE');});
test('时钟回拨导致偏差超限被阻断',async()=>{const times=[2000,1900];const x=await measureServerTime({serverTime:async()=>({body:{serverTime:3000}})},{now:()=>times.shift(),maxClockOffsetMs:100});assert.equal(x.ok,false);assert.equal(x.reason,'CLOCK_OFFSET_EXCEEDED');});
