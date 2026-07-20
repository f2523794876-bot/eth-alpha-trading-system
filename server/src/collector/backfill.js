import { retryDelay } from '../http/resilience.js';

export class BackfillWorker{
  constructor({adapter,repository,collector,maxAttempts=5}){this.adapter=adapter;this.repository=repository;this.collector=collector;this.maxAttempts=maxAttempts;}
  async runOne(workerId,lease,signal){
    if(signal?.aborted)throw Object.assign(new Error('Backfill aborted'),{code:'ABORTED'});
    const job=await this.repository.claimBackfill(workerId,lease);if(!job)return null;
    try{
      await this.repository.heartbeatBackfill?.(job.job_id||job.jobId,workerId,lease);
      const time=await this.collector.currentServerTime(signal);if(!time.ok)throw Object.assign(new Error(time.reason),{code:time.reason,retryable:true});
      const gap=job.gap||{gapId:job.gap_id,sourceId:job.source_id,instrument:job.instrument,marketType:job.market_type,interval:job.interval_name,startOpenTime:new Date(job.start_open_time).getTime(),endOpenTime:new Date(job.end_open_time).getTime(),missingCount:job.missing_count};
      const options={startTime:gap.startOpenTime,endTime:gap.endOpenTime,limit:gap.marketType==='spot'?1000:1500,signal};
      const endpointId=gap.marketType==='spot'?'binance-spot-klines':'binance-futures-klines';
      const fetcher=activeSignal=>gap.marketType==='spot'?this.adapter.spotKlines(gap.instrument,gap.interval,{...options,signal:activeSignal}):this.adapter.futuresKlines(gap.instrument,gap.interval,{...options,signal:activeSignal});
      const response=this.collector.trackedFetch?await this.collector.trackedFetch(endpointId,{sourceId:gap.sourceId,instrument:gap.instrument,marketType:gap.marketType,interval:gap.interval},fetcher):await fetcher(signal);
      await this.repository.heartbeatBackfill?.(job.job_id||job.jobId,workerId,lease);
      const result=await this.collector.collectBarsFromResponse({response,sourceId:gap.sourceId,endpointId,instrument:gap.instrument,marketType:gap.marketType,interval:gap.interval,serverTime:time.sourceServerTime,signal});
      const complete=result.gaps===0&&result.formal>=gap.missingCount;
      if(complete){await this.repository.resolveGap(gap.gapId,lease);await this.repository.finishBackfill(job.job_id||job.jobId,{ok:true},lease);return{ok:true,jobId:job.job_id||job.jobId,result};}
      throw Object.assign(new Error('Backfill remains incomplete'),{code:'BACKFILL_INCOMPLETE',retryable:true});
    }catch(error){const attempts=job.attempt_count??job.attemptCount??1,retryable=error.retryable!==false&&attempts<this.maxAttempts;await this.repository.finishBackfill(job.job_id||job.jobId,{ok:false,retryable,errorCode:error.code||'BACKFILL_FAILED',delayMs:retryDelay(attempts,{baseMs:1000,capMs:60000})},lease);return{ok:false,retryable,errorCode:error.code||'BACKFILL_FAILED'};}
  }
}
