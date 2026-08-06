import { loadConfig } from './config.js';
import { PublicHttpClient } from './http/client.js';
import { BinancePublicAdapter } from './sources/binance.js';
import { createPgPool, PostgresRepository } from './db/postgres.js';
import { CollectorService } from './collector/service.js';
import { measureServerTime } from './collector/time-guard.js';
import { createApiServer } from './api/server.js';
import { ForecastGenerator } from './forecast/generator-service.js';
import { OutcomeEvaluator } from './outcome/evaluator-service.js';
import { startStagesWithRollback, stopStagesInOrder, createIdempotentCloser } from './lifecycle.js';

export async function bootstrap(config=loadConfig()){
  const pool=await createPgPool(config);const repository=new PostgresRepository(pool);
  const client=new PublicHttpClient(config);const adapter=new BinancePublicAdapter({client,spotBaseUrl:config.spotBaseUrl,futuresBaseUrl:config.futuresBaseUrl});
  const collector=new CollectorService({adapter,repository,config});const api=createApiServer({collector,repository,host:config.host,port:config.port,d8ArtifactRoot:config.d8ArtifactRoot,d8RunStatusRoot:config.d8RunStatusRoot});
  // V1.4C P0-1修复：ForecastGenerator/OutcomeEvaluator是与CollectorService完全独立的第三、第四调度器——各自独立的
  // 类实例、timers、lease、abortController、running状态，互不共享调度状态；只共享同一个Postgres连接池与无状态的
  // measureServerTime()工具函数（不构成"调度状态共享"，同一份服务器时间校验逻辑本就该只有一处实现，见V1_4C_SCOPE_SPEC.md §7.5）。
  const forecastServerTime=()=>measureServerTime(adapter,{maxClockOffsetMs:config.maxClockOffsetMs});
  const forecastGenerator=new ForecastGenerator({pool,holderId:`${config.collectorId}-forecast-generator`,serverTimeProvider:forecastServerTime,leaseTtlMs:config.leaseTtlMs,featureWaitMs:config.forecastFeatureWaitMs,featureWaitAttempts:config.forecastFeatureWaitAttempts});
  const outcomeEvaluator=new OutcomeEvaluator({pool,holderId:`${config.collectorId}-outcome-evaluator`,serverTimeProvider:forecastServerTime,leaseTtlMs:config.leaseTtlMs});

  // P0-1修复：分阶段启动+失败逆序回滚（src/lifecycle.js）。每个stage.stop()只回收该组件自身持有的资源
  // （定时器/lease/端口监听）——collector的stage.stop()显式传入{closeRepository:false}，不再由CollectorService
  // 自行关闭共享连接池，避免其在forecastGenerator/outcomeEvaluator仍有在途事务时提前关闭数据库（P1-1同源风险）。
  // 共享Postgres连接池由bootstrap统一通过closeDatabase()在全部组件stage结束（无论正常关停还是启动失败回滚）后
  // 关闭且只关闭一次，createIdempotentCloser()防止重复关闭。
  const stages=[
    {name:'collector',start:()=>collector.start(),stop:()=>collector.stop({closeRepository:false})},
    {name:'api',start:()=>api.start(),stop:()=>api.stop()},
    {name:'forecastGenerator',start:()=>forecastGenerator.start({intervalMs:config.forecastPollMs}),stop:()=>forecastGenerator.stop()},
    {name:'outcomeEvaluator',start:()=>outcomeEvaluator.start({intervalMs:config.outcomePollMs}),stop:()=>outcomeEvaluator.stop()}
  ];

  const closeDatabase=createIdempotentCloser(()=>pool.end());

  try{
    await startStagesWithRollback(stages,{onStageStopError:(stage,error)=>console.error('startup rollback stage failed',{stage:stage.name,code:error.code||error.message})});
  }catch(startError){
    // 组件回滚已尽力而为完成；无论回滚过程本身是否有阶段报错，这里都只关闭一次共享数据库连接池，
    // 且最终仍然重新抛出原始启动错误（startError），不得被清理阶段的错误替换或掩盖。
    await closeDatabase().catch(error=>console.error('database close after startup rollback failed',{code:error.code||error.message}));
    throw startError;
  }

  let stopping=null;
  // 正常关停复用与回滚完全相同的逆序生命周期顺序（stopStagesInOrder）：先停止接收新任务的各调度器（含各自等待
  // 在途任务与释放lease），最后才关闭共享数据库——不允许collector或其他组件先行关闭数据库。
  const stop=signal=>{
    if(!stopping)stopping=(async()=>{
      console.info('graceful shutdown',{signal});
      await stopStagesInOrder(stages,{onStageStopError:(stage,error)=>console.error('shutdown stage failed',{stage:stage.name,code:error.code||error.message})});
      await closeDatabase().catch(error=>console.error('database close failed',{code:error.code||error.message}));
    })();
    return stopping;
  };
  process.once('SIGTERM',()=>stop('SIGTERM'));process.once('SIGINT',()=>stop('SIGINT'));
  return {collector,repository,api,forecastGenerator,outcomeEvaluator,stop};
}

if(import.meta.url===`file://${process.argv[1]}`){bootstrap().catch(error=>{console.error('collector startup failed',{code:error.code||error.message});process.exitCode=1;});}
