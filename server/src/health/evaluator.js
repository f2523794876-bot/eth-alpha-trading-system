export function evaluateHealth(input,now=Date.now()){
  const reasons=[];
  if(input.databaseAvailable===false)reasons.push('DATABASE_UNAVAILABLE');
  if(input.databaseWriteHealthy===false)reasons.push('DATABASE_WRITE_FAILED');
  if(input.leaseValid===false)reasons.push('LEASE_LOST');
  if(input.serverTimeAvailable===false)reasons.push('SERVER_TIME_UNAVAILABLE');
  if(Number.isFinite(input.clockOffsetMs)&&Math.abs(input.clockOffsetMs)>input.maxClockOffsetMs)reasons.push('CLOCK_OFFSET_EXCEEDED');
  if(!input.latestSuccessAt)reasons.push('NO_SUCCESSFUL_DATA');
  if(Number.isFinite(input.dataAgeMs)&&Number.isFinite(input.expectedFrequencyMs)&&input.dataAgeMs>input.expectedFrequencyMs*3)reasons.push('STALE_DATA');
  if((input.unresolvedGapCount||0)>0)reasons.push('UNRESOLVED_GAPS');
  if((input.pendingBackfillCount||0)>0)reasons.push('PENDING_BACKFILL');
  if((input.consecutiveFailures||0)>=5)reasons.push('CONSECUTIVE_FAILURES');
  if(input.circuitOpen)reasons.push('CIRCUIT_OPEN');
  if(input.rateLimited)reasons.push('RATE_LIMITED');
  if(input.partialEndpointFailure)reasons.push('PARTIAL_ENDPOINT_FAILURE');
  let state='HEALTHY';
  if(reasons.some(x=>['DATABASE_UNAVAILABLE','DATABASE_WRITE_FAILED','LEASE_LOST','SERVER_TIME_UNAVAILABLE','CLOCK_OFFSET_EXCEEDED'].includes(x)))state='BLOCKED';
  else if(reasons.some(x=>['NO_SUCCESSFUL_DATA','STALE_DATA','CONSECUTIVE_FAILURES'].includes(x)))state='DEGRADED';
  else if(input.recovering||((input.consecutiveSuccesses||0)>0&&(input.consecutiveSuccesses||0)<3))state='RECOVERING';
  else if(reasons.length)state='WARNING';
  return Object.freeze({...input,state,reasons,evaluatedAt:now});
}

export class EndpointHealthRegistry{
  constructor(definitions={},now=Date.now){this.now=now;this.records=new Map(Object.entries(definitions).map(([id,frequency])=>[id,{endpointId:id,expectedFrequencyMs:frequency,latestAttemptAt:null,latestSuccessAt:null,latestDataObservationAt:null,consecutiveFailures:0,consecutiveSuccesses:0,lastHttpStatus:null,rateLimited:false,recoveryStartedAt:null,lastRecoveredAt:null,lastErrorCode:null}]));}
  ensure(id){if(!this.records.has(id))this.records.set(id,{endpointId:id,expectedFrequencyMs:60000,latestAttemptAt:null,latestSuccessAt:null,latestDataObservationAt:null,consecutiveFailures:0,consecutiveSuccesses:0,lastHttpStatus:null,rateLimited:false,recoveryStartedAt:null,lastRecoveredAt:null,lastErrorCode:null});return this.records.get(id);}
  attempt(id){this.ensure(id).latestAttemptAt=this.now();}
  success(id,{httpStatus=200,dataObservationAt=null}={}){const r=this.ensure(id),wasFailing=r.consecutiveFailures>0;r.latestAttemptAt=this.now();r.latestSuccessAt=this.now();r.latestDataObservationAt=dataObservationAt??r.latestDataObservationAt;r.lastHttpStatus=httpStatus;r.rateLimited=false;r.lastErrorCode=null;r.consecutiveFailures=0;r.consecutiveSuccesses+=1;if(wasFailing&&!r.recoveryStartedAt)r.recoveryStartedAt=this.now();if(r.recoveryStartedAt&&r.consecutiveSuccesses>=3){r.lastRecoveredAt=this.now();r.recoveryStartedAt=null;}return r;}
  failure(id,{httpStatus=null,code='UNKNOWN'}={}){const r=this.ensure(id);r.latestAttemptAt=this.now();r.consecutiveFailures+=1;r.consecutiveSuccesses=0;r.lastHttpStatus=httpStatus;r.rateLimited=httpStatus===429||code==='RATE_LIMITED';r.lastErrorCode=code;return r;}
  observation(id,at){const r=this.ensure(id);if(Number.isFinite(at))r.latestDataObservationAt=Math.max(r.latestDataObservationAt||0,at);return r;}
  snapshots(breakers={}){return[...this.records.values()].map(r=>({...r,dataAgeMs:r.latestDataObservationAt?this.now()-r.latestDataObservationAt:null,circuitState:breakers[r.endpointId]?.state||'CLOSED',recovering:!!r.recoveryStartedAt}));}
}
