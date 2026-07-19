export class BackfillWorker {
  constructor({ adapter, repository, collector }) { this.adapter=adapter;this.repository=repository;this.collector=collector; }
  async execute(job, serverTime) {
    if (!job || !job.gap) throw new Error('BACKFILL_JOB_INVALID');
    const { sourceId,instrument,marketType,interval,startOpenTime,endOpenTime }=job.gap;
    const response=marketType==='spot'?await this.adapter.spotKlines(instrument,interval,{startTime:startOpenTime,endTime:endOpenTime,limit:1000}):await this.adapter.futuresKlines(instrument,interval,{startTime:startOpenTime,endTime:endOpenTime,limit:1500});
    const result=await this.collector.collectBarsFromResponse({response,sourceId,instrument,marketType,interval,serverTime});
    if(result.gaps===0)await this.repository.resolveGap?.(job.gap.gapId||job.gap.key);
    return result;
  }
}
