import { randomUUID } from 'node:crypto';
import { INTERVALS, SCHEMA_VERSION, SYMBOLS } from '../domain/constants.js';
import { sha256 } from '../domain/hash.js';
import { detectGaps, normalizeFunding, normalizeKlines, normalizeLongShort, normalizeOpenInterest, normalizeTakerFlow } from '../domain/normalize.js';
import { evaluateHealth } from '../health/evaluator.js';
import { measureServerTime } from './time-guard.js';

const endpoint = {
  spotKlines:'binance-spot-klines', futuresKlines:'binance-futures-klines', funding:'binance-futures-funding-rate',
  openInterest:'binance-futures-open-interest', longShort:'binance-futures-global-long-short', taker:'binance-futures-taker-flow'
};

export class CollectorService {
  constructor({ adapter, repository, config, now=Date.now, logger=console }) {
    this.adapter=adapter;this.repository=repository;this.config=config;this.now=now;this.logger=logger;this.startedAt=null;this.lastRun=null;this.running=false;this.inflight=new Set();this.timers=[];
  }
  async start() {
    const lease=await this.repository.acquireLease('primary-collector',this.config.collectorId,this.config.leaseTtlMs); if(!lease)throw new Error('COLLECTOR_LEASE_HELD');
    this.startedAt=this.now();this.running=true;
    await this.runCycle();
    this.schedule(()=>this.runCycle(),30_000); this.schedule(()=>this.collectDerivatives(),60_000); this.schedule(()=>this.heartbeat(),Math.floor(this.config.leaseTtlMs/3));
  }
  schedule(task,ms){const timer=setInterval(()=>{const p=Promise.resolve().then(task).catch(e=>this.logger.error('scheduled task failed',{code:e.code||e.message})).finally(()=>this.inflight.delete(p));this.inflight.add(p);},ms);this.timers.push(timer);}
  async heartbeat(){if(this.repository.heartbeatLease){const lease=await this.repository.heartbeatLease('primary-collector',this.config.collectorId,this.config.leaseTtlMs);if(!lease){this.running=false;throw new Error('COLLECTOR_LEASE_LOST');}}}
  async runCycle(){
    const time=await measureServerTime(this.adapter,{now:this.now,maxClockOffsetMs:this.config.maxClockOffsetMs});
    if(!time.ok){this.lastRun={at:this.now(),state:'BLOCKED',reason:time.reason,time};await this.repository.saveHealth?.(this.health());return this.lastRun;}
    const results=await Promise.allSettled(SYMBOLS.flatMap(symbol=>INTERVALS.map(interval=>this.collectBars('spot',symbol,interval,time.sourceServerTime))));
    this.lastRun={at:this.now(),state:results.some(x=>x.status==='rejected')?'DEGRADED':'HEALTHY',time,results:results.map(x=>x.status==='fulfilled'?x.value:{ok:false,error:x.reason?.code||x.reason?.message})}; await this.repository.saveHealth?.(this.health()); return this.lastRun;
  }
  async collectBars(marketType,instrument,interval,serverTime){
    const sourceId=marketType==='spot'?'binance-spot-rest':'binance-usdt-futures-rest';const endpointId=marketType==='spot'?endpoint.spotKlines:endpoint.futuresKlines;
    const response=await (marketType==='spot'?this.adapter.spotKlines(instrument,interval,{limit:500}):this.adapter.futuresKlines(instrument,interval,{limit:500}));
    return this.collectBarsFromResponse({response,sourceId,endpointId,instrument,marketType,interval,serverTime});
  }
  async collectBarsFromResponse({response,sourceId,endpointId=sourceId==='binance-spot-rest'?endpoint.spotKlines:endpoint.futuresKlines,instrument,marketType,interval,serverTime}){
    const rawPayloadId=await this.repository.saveRaw(response,{sourceId,endpointId,contentHash:sha256(response.body),schemaVersion:SCHEMA_VERSION,qualityState:'NORMAL'});
    const normalized=normalizeKlines({rows:response.body,sourceId,endpointId,instrument,marketType,interval,serverTime,fetchedAt:response.receivedAt,rawPayloadId,requestId:response.requestId});
    const saved=await this.repository.upsertMarketBars(normalized.formal); const gaps=detectGaps(normalized.formal,interval).map(g=>({...g,gapId:`gap:${sha256({sourceId,instrument,marketType,interval,start:g.startOpenTime,end:g.endOpenTime})}`,sourceId,instrument,marketType,interval}));
    if(this.repository.saveGaps)for(const gap of await this.repository.saveGaps(gaps))await this.repository.createBackfill?.(gap);
    return {ok:true,sourceId,instrument,marketType,interval,formal:normalized.formal.length,provisional:normalized.provisional.length,rejected:normalized.rejected.length,gaps:gaps.length,...saved};
  }
  async collectDerivatives(){
    const time=await measureServerTime(this.adapter,{now:this.now,maxClockOffsetMs:this.config.maxClockOffsetMs});if(!time.ok)return {ok:false,blocked:true,reason:time.reason};
    const jobs=SYMBOLS.flatMap(symbol=>[
      this.collectPoint('funding_rates',symbol,endpoint.funding,()=>this.adapter.fundingRates(symbol,{limit:8}),normalizeFunding),
      this.collectPoint('open_interest',symbol,endpoint.openInterest,()=>this.adapter.openInterest(symbol),normalizeOpenInterest),
      this.collectPoint('long_short_ratios',symbol,endpoint.longShort,()=>this.adapter.longShortRatio(symbol,'15m',30),normalizeLongShort,'15m'),
      this.collectPoint('taker_flow',symbol,endpoint.taker,()=>this.adapter.takerFlow(symbol,'15m',30),normalizeTakerFlow,'15m'),
      ...INTERVALS.map(interval=>this.collectBars('usdt_perpetual',symbol,interval,time.sourceServerTime))
    ]); return Promise.allSettled(jobs);
  }
  async collectPoint(table,instrument,endpointId,fetcher,normalizer,interval=null){
    const response=await fetcher();const sourceId='binance-usdt-futures-rest';const rawPayloadId=await this.repository.saveRaw(response,{sourceId,endpointId,contentHash:sha256(response.body),schemaVersion:SCHEMA_VERSION,qualityState:'NORMAL'});
    const rows=Array.isArray(response.body)?response.body:[response.body];const context={sourceId,endpointId,instrument,marketType:'usdt_perpetual',interval,fetchedAt:response.receivedAt,rawPayloadId,requestId:response.requestId,qualityState:'NORMAL'};
    const facts=rows.map(row=>normalizer(row,context));
    if(this.repository.constructor.name==='PostgresRepository') return this.savePgPoints(table,facts);
    return this.repository.savePointFacts(table,facts);
  }
  savePgPoints(table,facts){
    const base=[['source_id',x=>x.sourceId],['endpoint_id',x=>x.endpointId],['instrument',x=>x.instrument]];
    const common=[['published_at',x=>new Date(x.publishedAt)],['available_at',x=>new Date(x.availableAt)],['first_available_at',x=>new Date(x.firstAvailableAt)],['fetched_at',x=>new Date(x.fetchedAt)],['revision_number',x=>x.revisionNumber],['vintage_id',x=>x.vintageId],['raw_payload_id',x=>x.rawPayloadId],['request_id',x=>x.requestId],['schema_version',x=>x.schemaVersion],['quality_state',x=>x.qualityState],['content_hash',x=>x.contentHash]];
    const special={funding_rates:[['market_type',()=> 'usdt_perpetual'],['observation_time',x=>new Date(x.observedAt)],['funding_rate',x=>x.fundingRate],['mark_price',x=>x.markPrice]],open_interest:[['market_type',()=> 'usdt_perpetual'],['observation_time',x=>new Date(x.observedAt)],['open_interest',x=>x.openInterest]],long_short_ratios:[['interval_name',x=>x.interval],['observation_time',x=>new Date(x.observedAt)],['long_short_ratio',x=>x.longShortRatio],['long_account',x=>x.longAccount],['short_account',x=>x.shortAccount]],taker_flow:[['interval_name',x=>x.interval],['observation_time',x=>new Date(x.observedAt)],['buy_sell_ratio',x=>x.buySellRatio],['buy_volume',x=>x.buyVolume],['sell_volume',x=>x.sellVolume]]};
    return this.repository.savePointFacts(table,facts,[...base,...special[table],...common]);
  }
  health(){return evaluateHealth({serverTimeAvailable:this.lastRun?.time?.ok??false,clockOffsetMs:this.lastRun?.time?.clockOffsetMs,maxClockOffsetMs:this.config.maxClockOffsetMs,consecutiveFailures:this.lastRun?.state==='BLOCKED'?1:0,unresolvedGapCount:0,circuitOpen:this.adapter.client.breaker.state==='OPEN'});}
  status(){return {running:this.running,collectorId:this.config.collectorId,startedAt:this.startedAt,lastRun:this.lastRun,health:this.health()};}
  async stop(){this.running=false;for(const timer of this.timers)clearInterval(timer);await Promise.allSettled([...this.inflight]);await this.repository.close();}
}
