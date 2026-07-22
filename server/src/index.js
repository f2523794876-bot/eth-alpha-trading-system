import { loadConfig } from './config.js';
import { PublicHttpClient } from './http/client.js';
import { BinancePublicAdapter } from './sources/binance.js';
import { createPgPool, PostgresRepository } from './db/postgres.js';
import { CollectorService } from './collector/service.js';
import { measureServerTime } from './collector/time-guard.js';
import { createApiServer } from './api/server.js';
import { ForecastGenerator } from './forecast/generator-service.js';
import { OutcomeEvaluator } from './outcome/evaluator-service.js';

export async function bootstrap(config=loadConfig()){
  const pool=await createPgPool(config);const repository=new PostgresRepository(pool);
  const client=new PublicHttpClient(config);const adapter=new BinancePublicAdapter({client,spotBaseUrl:config.spotBaseUrl,futuresBaseUrl:config.futuresBaseUrl});
  const collector=new CollectorService({adapter,repository,config});const api=createApiServer({collector,repository,host:config.host,port:config.port});
  // V1.4C P0-1修复：ForecastGenerator/OutcomeEvaluator是与CollectorService完全独立的第三、第四调度器——各自独立的
  // 类实例、timers、lease、abortController、running状态，互不共享调度状态；只共享同一个Postgres连接池与无状态的
  // measureServerTime()工具函数（不构成"调度状态共享"，同一份服务器时间校验逻辑本就该只有一处实现，见V1_4C_SCOPE_SPEC.md §7.5）。
  const forecastServerTime=()=>measureServerTime(adapter,{maxClockOffsetMs:config.maxClockOffsetMs});
  const forecastGenerator=new ForecastGenerator({pool,holderId:`${config.collectorId}-forecast-generator`,serverTimeProvider:forecastServerTime,leaseTtlMs:config.leaseTtlMs});
  const outcomeEvaluator=new OutcomeEvaluator({pool,holderId:`${config.collectorId}-outcome-evaluator`,serverTimeProvider:forecastServerTime,leaseTtlMs:config.leaseTtlMs});
  await collector.start();await api.start();await forecastGenerator.start();await outcomeEvaluator.start();
  let stopping=false;const stop=async signal=>{if(stopping)return;stopping=true;console.info('graceful shutdown',{signal});await api.stop();await Promise.allSettled([collector.stop(),forecastGenerator.stop(),outcomeEvaluator.stop()]);};
  process.once('SIGTERM',()=>stop('SIGTERM'));process.once('SIGINT',()=>stop('SIGINT'));
  return {collector,repository,api,forecastGenerator,outcomeEvaluator,stop};
}

if(import.meta.url===`file://${process.argv[1]}`){bootstrap().catch(error=>{console.error('collector startup failed',{code:error.code||error.message});process.exitCode=1;});}
