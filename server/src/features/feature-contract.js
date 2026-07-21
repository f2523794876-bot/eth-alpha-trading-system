import { sha256 } from '../domain/hash.js';
import { FEATURE_ALGORITHM_VERSION, FEATURE_NAMES, FEATURE_SET_VERSION, SOURCE_DATASET_VERSION } from './feature-version.js';

export const FEATURE_QUALITY_STATES = Object.freeze(['HEALTHY','WARNING','DEGRADED','BLOCKED']);
const finiteTime = value => Number.isSafeInteger(value) && value >= 1_000_000_000_000;

export function buildFeatureId({symbol,targetInterval,targetBarCloseTime,featureSetVersion=FEATURE_SET_VERSION}) {
  if (!symbol || !['15m','1h','4h'].includes(targetInterval) || !finiteTime(targetBarCloseTime) || !featureSetVersion) throw Object.assign(new Error('Invalid feature identity'),{code:'FEATURE_IDENTITY_INVALID'});
  return `feature:${symbol}:${targetInterval}:${targetBarCloseTime}:${featureSetVersion}`;
}

export function validateFeatureRecord(record) {
  const errors=[];
  for(const key of ['featureId','symbol','targetInterval','targetBarOpenTime','targetBarCloseTime','asOfTime','generatedAt','featureSetVersion','algorithmVersion','sourceDatasetVersion','sourceVintageRefs','sourceRevisionRefs','completeness','qualityState','missingFeatures','degradedReasons']) if(record?.[key]===undefined)errors.push(`MISSING_${key}`);
  if(!finiteTime(record?.targetBarOpenTime)||!finiteTime(record?.targetBarCloseTime)||record.targetBarOpenTime>=record.targetBarCloseTime)errors.push('TARGET_TIME_INVALID');
  if(!finiteTime(record?.asOfTime)||record.targetBarCloseTime>record.asOfTime)errors.push('TARGET_NOT_CLOSED');
  if(!finiteTime(record?.generatedAt)||record.asOfTime>record.generatedAt)errors.push('GENERATED_TIME_INVALID');
  if(!record?.featureSetVersion||!record?.algorithmVersion)errors.push('FEATURE_VERSION_INVALID');
  if(!FEATURE_QUALITY_STATES.includes(record?.qualityState))errors.push('QUALITY_STATE_INVALID');
  if(!Number.isFinite(record?.completeness)||record.completeness<0||record.completeness>1)errors.push('COMPLETENESS_INVALID');
  for(const ref of record?.sourceVintageRefs||[])if(ref.availableAt>record.asOfTime||ref.publishedAt>record.asOfTime)errors.push(`FUTURE_SOURCE:${ref.vintageId||ref.sourceRecordId}`);
  for(const name of FEATURE_NAMES)if(!(name in (record?.features||{})))errors.push(`FEATURE_OMITTED:${name}`);
  return Object.freeze({ok:errors.length===0,errors});
}

export function finalizeFeatureRecord(input) {
  const featureId=buildFeatureId(input); const features={}; const availability={};
  for(const name of FEATURE_NAMES){const value=input.features?.[name];features[name]=Number.isNaN(value)||value===undefined?null:value??null;availability[name]=features[name]!==null;}
  const missingFeatures=FEATURE_NAMES.filter(name=>!availability[name]);
  const record={...input,featureId,featureSetVersion:input.featureSetVersion||FEATURE_SET_VERSION,algorithmVersion:input.algorithmVersion||FEATURE_ALGORITHM_VERSION,sourceDatasetVersion:input.sourceDatasetVersion||SOURCE_DATASET_VERSION,features,availability,missingFeatures:[...new Set([...(input.missingFeatures||[]),...missingFeatures])],degradedReasons:[...new Set(input.degradedReasons||[])],sourceVintageRefs:input.sourceVintageRefs||[],sourceRevisionRefs:input.sourceRevisionRefs||[]};
  record.completeness=(FEATURE_NAMES.length-record.missingFeatures.length)/FEATURE_NAMES.length;
  record.contentHash=sha256({featureId:record.featureId,features:record.features,availability:record.availability,sourceVintageRefs:record.sourceVintageRefs,sourceRevisionRefs:record.sourceRevisionRefs,featureSetVersion:record.featureSetVersion,algorithmVersion:record.algorithmVersion,sourceDatasetVersion:record.sourceDatasetVersion});
  const validation=validateFeatureRecord(record);if(!validation.ok)throw Object.assign(new Error('Feature contract rejected'),{code:'FEATURE_CONTRACT_REJECTED',reasons:validation.errors});
  return Object.freeze(record);
}
