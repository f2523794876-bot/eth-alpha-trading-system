const CRITICAL=['logReturn1','atr14','closeToEma20','trend15m','trend1h','trend4h'];
export function assessFeatureQuality({targetClosed=true,databaseAvailable=true,timeContractValid=true,futureLeak=false,featureSetVersion,features={},missingFeatures=[]}){
  const reasons=[];
  if(!databaseAvailable)reasons.push('DATABASE_UNAVAILABLE');
  if(!targetClosed)reasons.push('TARGET_BAR_NOT_CLOSED');
  if(!timeContractValid)reasons.push('TIME_CONTRACT_FAILED');
  if(futureLeak)reasons.push('FUTURE_DATA_LEAK');
  if(!featureSetVersion)reasons.push('FEATURE_SET_VERSION_INVALID');
  if(CRITICAL.some(name=>features[name]===null||features[name]===undefined))reasons.push('CRITICAL_ETH_WINDOW_INSUFFICIENT');
  let qualityState='HEALTHY';
  if(reasons.length)qualityState='BLOCKED';
  else if(missingFeatures.length>12)qualityState='DEGRADED';
  else if(missingFeatures.length)qualityState='WARNING';
  return Object.freeze({qualityState,degradedReasons:reasons,blocked:qualityState==='BLOCKED'});
}
