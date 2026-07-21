export function sourceRef(dataset,row,overrides={}){
  const sourceTime=Number(row.closeTime??row.observedAt);const publishedAt=Number(row.publishedAt);const availableAt=Number(row.availableAt);
  if(!Number.isFinite(sourceTime)||!Number.isFinite(publishedAt)||!Number.isFinite(availableAt))throw Object.assign(new Error('Invalid source lineage time'),{code:'LINEAGE_TIME_INVALID'});
  return Object.freeze({dataset,sourceName:row.sourceId,symbol:row.instrument,interval:row.interval||null,naturalKey:overrides.naturalKey||{sourceId:row.sourceId,instrument:row.instrument,interval:row.interval||null,sourceTime},revision:Number(row.revisionNumber||0),sourceTime,publishedAt,availableAt,rawPayloadId:row.rawPayloadId,sourceRecordId:String(row.marketBarId??row.id??row.vintageId),vintageId:row.vintageId,contentHash:row.contentHash});
}

export function validateLineage(refs,asOfTime,sourceCutoffTime=asOfTime){const reasons=[];for(const ref of refs){if(ref.availableAt>asOfTime||ref.publishedAt>asOfTime||ref.sourceTime>sourceCutoffTime)reasons.push(`FUTURE_SOURCE:${ref.dataset}:${ref.sourceRecordId}`);if(!ref.vintageId||!ref.contentHash)reasons.push(`SOURCE_IDENTITY_MISSING:${ref.dataset}`);}return Object.freeze({ok:reasons.length===0,reasons});}
