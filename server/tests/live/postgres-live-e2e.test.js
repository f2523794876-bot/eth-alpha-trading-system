import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createPgPool, PostgresRepository } from '../../src/db/postgres.js';
import { runMigrations } from '../../src/db/migrate.js';
import { CollectorService } from '../../src/collector/service.js';
import { PublicHttpClient } from '../../src/http/client.js';
import { BinancePublicAdapter } from '../../src/sources/binance.js';
import { normalizeFunding, normalizeLongShort, normalizeOpenInterest, normalizeTakerFlow } from '../../src/domain/normalize.js';

const url=process.env.TEST_DATABASE_URL;
const enabled=Boolean(url)&&process.env.RUN_LIVE_REST==='1';
const live=enabled?test:test.skip;
let pool,repo,collector,adapter,lease;

if(enabled){before(async()=>{const parsed=new URL(url);if(!/test|ci|v14a/i.test(parsed.pathname))throw new Error('TEST_DATABASE_URL must be isolated');pool=await createPgPool({databaseUrl:url,dbSsl:false});await runMigrations(pool,'up');repo=new PostgresRepository(pool);lease=await repo.acquireLease('live-e2e',`live-${process.pid}`,120_000);adapter=new BinancePublicAdapter({client:new PublicHttpClient({timeoutMs:15_000,maxRetries:2})});collector=new CollectorService({adapter,repository:repo,config:{collectorId:`live-${process.pid}`,leaseTtlMs:120_000,maxClockOffsetMs:10_000},logger:{error(){}}});collector.lease=lease;collector.running=true;});after(async()=>pool?.end());}

live('真实Binance REST经生产链写入现货/永续六路K线',async()=>{const time=await collector.currentServerTime();assert.equal(time.ok,true);for(const marketType of ['spot','usdt_perpetual'])for(const symbol of ['ETHUSDT','BTCUSDT'])for(const interval of ['15m','1h','4h']){const result=await collector.collectBars(marketType,symbol,interval,time.sourceServerTime);assert.equal(result.ok,true);assert.ok(result.formal>0);}});

live('真实衍生品数组/对象经生产链写入全部事实表',async()=>{const jobs=[['funding_rates','binance-futures-funding-rate',s=>adapter.fundingRates(s,{limit:2}),normalizeFunding,null],['open_interest','binance-futures-open-interest',s=>adapter.openInterest(s),normalizeOpenInterest,null],['long_short_ratios','binance-futures-global-long-short',s=>adapter.longShortRatio(s,'15m',2),normalizeLongShort,'15m'],['taker_flow','binance-futures-taker-flow',s=>adapter.takerFlow(s,'15m',2),normalizeTakerFlow,'15m']];for(const symbol of ['ETHUSDT','BTCUSDT'])for(const [table,endpointId,fetcher,normalizer,interval] of jobs){const result=await collector.collectPoint(table,symbol,endpointId,()=>fetcher(symbol),normalizer,interval);assert.ok(result.inserted+result.deduped+result.revised>0);}});

live('相同真实响应重复写入保持幂等且readiness执行实时数据库检查',async()=>{const time=await collector.currentServerTime();const response=await adapter.spotKlines('ETHUSDT','15m',{limit:10});const args={response,sourceId:'binance-spot-rest',endpointId:'binance-spot-klines',instrument:'ETHUSDT',marketType:'spot',interval:'15m',serverTime:time.sourceServerTime};await collector.collectBarsFromResponse(args);const repeat=await collector.collectBarsFromResponse(args);assert.ok(repeat.deduped>0);collector.databaseAvailable=true;collector.databaseWriteHealthy=true;collector.lastServerTime=time;const ready=await collector.readiness();assert.equal(ready.checks.database,true);assert.equal(ready.checks.migrations,true);});
