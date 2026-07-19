import { stableStringify } from '../domain/hash.js';

export class MemoryRepository {
  constructor() { this.raw=[]; this.bars=[]; this.provisional=[]; this.facts={funding_rates:[],open_interest:[],long_short_ratios:[],taker_flow:[]}; this.gaps=[]; this.backfills=[]; this.health=[]; this.audit=[]; this.leases=new Map(); }
  async saveRaw(response, meta) {
    const key=`${response.requestId}:${meta.contentHash}`; const found=this.raw.find(r=>r.key===key); if(found)return found.rawPayloadId;
    const row=Object.freeze({key,rawPayloadId:meta.rawPayloadId||`raw-${this.raw.length+1}`,payload:structuredClone(response.body),...meta}); this.raw.push(row); return row.rawPayloadId;
  }
  async upsertMarketBars(rows) {
    let inserted=0; for(const row of rows){const key=`${row.sourceId}:${row.marketType}:${row.instrument}:${row.interval}:${row.openTime}:${row.revisionNumber}`; const found=this.bars.find(x=>x.key===key); if(found){if(found.contentHash!==row.contentHash) throw new Error('IMMUTABLE_FACT_CONFLICT'); continue;} this.bars.push(Object.freeze({key,...structuredClone(row)})); inserted++;} return {inserted,deduped:rows.length-inserted};
  }
  async savePointFacts(table, rows) { let inserted=0; for(const row of rows){const found=this.facts[table].find(x=>x.vintageId===row.vintageId); if(found){if(stableStringify(found)!==stableStringify(row)) throw new Error('IMMUTABLE_FACT_CONFLICT');continue;} this.facts[table].push(Object.freeze(structuredClone(row))); inserted++;} return {inserted,deduped:rows.length-inserted}; }
  async saveGaps(rows){for(const row of rows){const key=row.gapId||`${row.sourceId}:${row.instrument}:${row.marketType}:${row.interval}:${row.startOpenTime}:${row.endOpenTime}`; if(!this.gaps.some(x=>x.key===key))this.gaps.push({key,...row});} return this.gaps;}
  async createBackfill(gap){const id=`backfill:${gap.key||gap.gapId}`; if(!this.backfills.some(x=>x.jobId===id))this.backfills.push({jobId:id,gapId:gap.key||gap.gapId,status:'PENDING',attemptCount:0}); return this.backfills.find(x=>x.jobId===id);}
  async resolveGap(id){const gap=this.gaps.find(x=>x.key===id||x.gapId===id);if(gap){gap.status='RESOLVED';gap.resolvedAt=Date.now();}return gap||null;}
  async acquireLease(name,holderId,ttlMs,now=Date.now()){const old=this.leases.get(name); if(old&&old.expiresAt>now&&old.holderId!==holderId)return null; const row={name,holderId,expiresAt:now+ttlMs,fencingToken:(old?.fencingToken||0)+1};this.leases.set(name,row);return row;}
  async listBars(q){return this.bars.filter(x=>x.instrument===q.instrument&&x.marketType===q.marketType&&x.interval===q.interval&&x.openTime>=q.from&&x.openTime<=q.to).slice(0,q.limit);}
  async listSimple(table,q){return this.facts[table].filter(x=>x.instrument===q.instrument&&x.observedAt>=q.from&&x.observedAt<=q.to).slice(0,q.limit);}
  async saveHealth(snapshot){this.health.push(structuredClone(snapshot));} async listGaps(limit=100){return this.gaps.slice(-limit);} async listSources(){return [];} async latestHealth(){return this.health;} async close(){}
}
