import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PublicHttpClient} from '../../src/http/client.js';
import {BinancePublicAdapter} from '../../src/sources/binance.js';
import {normalizeFunding,normalizeKlines,normalizeLongShort,normalizeOpenInterest,normalizeTakerFlow} from '../../src/domain/normalize.js';
import {generateFeatureRecord} from '../../src/features/feature-engine.js';

const enabled=process.env.RUN_LIVE_TESTS==='1',live=enabled?test:test.skip;
live('真实Binance公开数据经过V1.4B as-of特征生产链',async()=>{
  const adapter=new BinancePublicAdapter({client:new PublicHttpClient({timeoutMs:10000,maxRetries:1})}),time=(await adapter.serverTime()).body.serverTime;
  const requests=await Promise.all([adapter.spotKlines('ETHUSDT','15m',{limit:80}),adapter.spotKlines('ETHUSDT','1h',{limit:80}),adapter.spotKlines('ETHUSDT','4h',{limit:80}),adapter.spotKlines('BTCUSDT','15m',{limit:80}),adapter.spotKlines('BTCUSDT','1h',{limit:80}),adapter.spotKlines('BTCUSDT','4h',{limit:80}),adapter.fundingRates('ETHUSDT',{limit:30}),adapter.openInterest('ETHUSDT'),adapter.longShortRatio('ETHUSDT','15m',30),adapter.takerFlow('ETHUSDT','15m',30)]);
  const bar=(response,instrument,interval)=>normalizeKlines({rows:response.body,sourceId:'binance-spot-rest',endpointId:'binance-spot-klines',instrument,marketType:'spot',interval,serverTime:time,fetchedAt:response.receivedAt,rawPayloadId:randomUUID(),requestId:response.requestId}).formal;
  const [eth15,eth1h,eth4h,btc15,btc1h,btc4h]=[['ETHUSDT','15m'],['ETHUSDT','1h'],['ETHUSDT','4h'],['BTCUSDT','15m'],['BTCUSDT','1h'],['BTCUSDT','4h']].map(([symbol,interval],i)=>bar(requests[i],symbol,interval));
  const targetBarCloseTime=eth15.at(-1).closeTime,asOfTime=Math.max(Date.now(),...requests.map(x=>x.receivedAt));
  const context=(response,endpointId,interval=null)=>({sourceId:'binance-usdt-futures-rest',endpointId,instrument:'ETHUSDT',marketType:'usdt_perpetual',interval,fetchedAt:response.receivedAt,rawPayloadId:randomUUID(),requestId:response.requestId,qualityState:'NORMAL'});
  const funding=requests[6].body.map(x=>normalizeFunding(x,context(requests[6],'binance-futures-funding-rate'))),oi=[normalizeOpenInterest(requests[7].body,context(requests[7],'binance-futures-open-interest'))],ls=requests[8].body.map(x=>normalizeLongShort(x,context(requests[8],'binance-futures-global-long-short','15m'))),tf=requests[9].body.map(x=>normalizeTakerFlow(x,context(requests[9],'binance-futures-taker-flow','15m'))),visible=xs=>xs.filter(x=>x.observedAt<=targetBarCloseTime);
  const record=generateFeatureRecord({eth15,eth1h:eth1h.filter(x=>x.closeTime<=targetBarCloseTime),eth4h:eth4h.filter(x=>x.closeTime<=targetBarCloseTime),btc15:btc15.filter(x=>x.closeTime<=targetBarCloseTime),btc1h:btc1h.filter(x=>x.closeTime<=targetBarCloseTime),btc4h:btc4h.filter(x=>x.closeTime<=targetBarCloseTime),funding:visible(funding),openInterest:visible(oi),longShort:visible(ls),takerFlow:visible(tf),targetBarCloseTime,asOfTime},{now:()=>asOfTime});
  assert.equal(record.targetBarCloseTime,targetBarCloseTime);assert.equal(Object.keys(record.features).length,54);assert.ok(record.sourceVintageRefs.every(x=>x.sourceTime<=targetBarCloseTime&&x.availableAt<=asOfTime));assert.notEqual(record.qualityState,'BLOCKED');assert.equal(typeof record.features.derivativesAvailability,'boolean');
});
