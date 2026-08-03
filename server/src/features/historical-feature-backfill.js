import { randomUUID } from 'node:crypto';
import { enumerateRhythmPoints } from '../validation-replay/cli-entry.js';
import { FEATURE_ALGORITHM_VERSION, FEATURE_SET_VERSION } from './feature-version.js';
import { FEATURE_BAR_DEPENDENCIES, generateFeatureRecord } from './feature-engine.js';

export const RESEARCH_AVAILABILITY_RULE_VERSION='v1.4d-research-availability-1';
export const HISTORICAL_DATASET_VERSION_PATTERN=/^v1\.4d-sha256-[a-f0-9]{64}$/;
export const HISTORICAL_BACKFILL_EXIT=Object.freeze({PASS:0,INVALID_INPUT:2,BLOCKED:3,CONFLICT:4,DATABASE_FAILURE:5});
const INTERVAL_MS=Object.freeze({'15m':900_000,'1h':3_600_000,'4h':14_400_000});

const fail=(code,message,detail={})=>Object.assign(new Error(message),{code,...detail});
const finiteTime=value=>Number.isSafeInteger(value)&&value>=1_000_000_000_000;
export const redactHistoricalBackfillText=value=>String(value).replace(/postgres(?:ql)?:\/\/[^\s]+/gi,'[REDACTED_DATABASE_URL]').replace(/password=[^\s]+/gi,'password=[REDACTED]').replace(/token=[^\s]+/gi,'token=[REDACTED]');

export function validateHistoricalBackfillOptions(options){
  const from=Date.parse(options.from),to=Date.parse(options.to);
  if(options.symbol!=='ETHUSDT')throw fail('INVALID_SYMBOL','Historical feature backfill currently supports ETHUSDT only');
  if(options.interval!=='15m')throw fail('INVALID_INTERVAL','Reference interval must be 15m');
  if(!finiteTime(from)||!finiteTime(to)||from>=to)throw fail('INVALID_TIME_RANGE','--from/--to must be a non-empty UTC range');
  if(!String(options.from).endsWith('Z')||!String(options.to).endsWith('Z')||from%INTERVAL_MS['15m']||to%INTERVAL_MS['15m'])throw fail('UNALIGNED_UTC_RANGE','Range boundaries must be UTC 15m boundaries');
  if(options.featureVersion!==FEATURE_SET_VERSION)throw fail('FEATURE_VERSION_MISMATCH',`Expected feature version ${FEATURE_SET_VERSION}`);
  if(options.algorithmVersion!==FEATURE_ALGORITHM_VERSION)throw fail('ALGORITHM_VERSION_MISMATCH',`Expected algorithm version ${FEATURE_ALGORITHM_VERSION}`);
  if(!HISTORICAL_DATASET_VERSION_PATTERN.test(options.datasetVersion||''))throw fail('DATASET_VERSION_INVALID','Dataset version must contain the complete V1.4D SHA-256 manifest hash');
  if(!Number.isInteger(options.batchSize)||options.batchSize<1||options.batchSize>1000)throw fail('INVALID_BATCH_SIZE','--batch-size must be an integer from 1 to 1000');
  const resumeAfter=options.resumeAfter==null?null:Date.parse(options.resumeAfter);
  if(resumeAfter!=null&&(!finiteTime(resumeAfter)||resumeAfter<from||resumeAfter>=to||(resumeAfter+1)%INTERVAL_MS['15m']))throw fail('INVALID_RESUME_CURSOR','--resume-after must be an aligned closed-bar reference point inside the requested range');
  return Object.freeze({...options,fromMs:from,toMs:to,resumeAfterMs:resumeAfter});
}

export function enumerateHistoricalFeaturePoints({fromMs,toMs,resumeAfterMs=null}){
  const points=enumerateRhythmPoints({from:fromMs,to:toMs,horizon:'24h'});
  return resumeAfterMs==null?points:points.filter(point=>point>resumeAfterMs);
}

function checkWindow(rows,dependency,referenceTime){
  if(!Array.isArray(rows)||rows.length<dependency.minimumBars)throw fail('INPUT_WINDOW_INCOMPLETE',`${dependency.symbol} ${dependency.interval} has ${rows?.length||0}/${dependency.minimumBars} required bars`,{symbol:dependency.symbol,interval:dependency.interval,referenceTime,actualBars:rows?.length||0,requiredBars:dependency.minimumBars});
  for(let i=1;i<rows.length;i++)if(rows[i].closeTime<=rows[i-1].closeTime)throw fail('INPUT_BAR_ORDER_INVALID',`${dependency.symbol} ${dependency.interval} contains duplicate or out-of-order closes`,{symbol:dependency.symbol,interval:dependency.interval,referenceTime,previousCloseTime:rows[i-1].closeTime,currentCloseTime:rows[i].closeTime});
  const step=INTERVAL_MS[dependency.interval],tail=rows.slice(-dependency.minimumBars);
  if(tail.at(-1).closeTime!==referenceTime)throw fail('TARGET_BAR_MISSING',`${dependency.symbol} ${dependency.interval} does not end at reference point`,{symbol:dependency.symbol,interval:dependency.interval,referenceTime,latestCloseTime:tail.at(-1).closeTime});
  for(let i=1;i<tail.length;i++)if(tail[i].closeTime-tail[i-1].closeTime!==step)throw fail('INPUT_BAR_GAP',`${dependency.symbol} ${dependency.interval} contains a missing, duplicate, or out-of-order bar`,{symbol:dependency.symbol,interval:dependency.interval,referenceTime,previousCloseTime:tail[i-1].closeTime,currentCloseTime:tail[i].closeTime});
  for(const row of tail){
    if(row.closeTime>referenceTime||row.researchAvailabilityAt>referenceTime)throw fail('FUTURE_LEAK_DETECTED',`${dependency.symbol} ${dependency.interval} contains future data`,{symbol:dependency.symbol,interval:dependency.interval,referenceTime,sourceTime:row.closeTime});
    if(!row.vintageId||!row.contentHash||!Number.isFinite(row.operationalFetchedAt)||!Number.isFinite(row.operationalAvailableAt))throw fail('SOURCE_IDENTITY_INCOMPLETE',`${dependency.symbol} ${dependency.interval} source identity is incomplete`,{symbol:dependency.symbol,interval:dependency.interval,referenceTime});
  }
}

function updateSourceRange(summary,input){for(const dependency of FEATURE_BAR_DEPENDENCIES){const rows=input[dependency.key]||[];if(!rows.length)continue;const key=`${dependency.symbol}:${dependency.interval}`,first=rows[0].closeTime,last=rows.at(-1).closeTime,current=summary.sourceRange[key];summary.sourceRange[key]={earliest:new Date(current?Math.min(Date.parse(current.earliest),first):first).toISOString(),latest:new Date(current?Math.max(Date.parse(current.latest),last):last).toISOString(),bars:Math.max(current?.bars||0,rows.length)};}}

export function requiredHistoricalFeatureDependencies(){return FEATURE_BAR_DEPENDENCIES.map(({symbol,marketType,interval,minimumBars})=>Object.freeze({symbol,marketType,interval,minimumBars}));}

function validateVerifiedManifest(manifest,effective){
  const required=requiredHistoricalFeatureDependencies(),covered=new Set((manifest.dependencies||[]).map(x=>`${x.symbol}:${x.marketType||'spot'}:${x.interval}`));
  if(manifest.manifestContractVersion!==2)throw fail('DATASET_MANIFEST_CONTRACT_VERSION_UNSUPPORTED','Historical feature backfill requires a contract version 2 multi-symbol manifest',{manifestContractVersion:manifest.manifestContractVersion});
  if(manifest.datasetVersion!==effective.datasetVersion||!manifest.symbols?.includes(effective.symbol))throw fail('DATASET_MANIFEST_SCOPE_MISMATCH','Dataset manifest symbols/version do not match the request');
  const missing=required.filter(x=>!covered.has(`${x.symbol}:${x.marketType}:${x.interval}`));
  const extra=(manifest.dependencies||[]).filter(x=>!required.some(r=>r.symbol===x.symbol&&r.marketType===x.marketType&&r.interval===x.interval));
  if(missing.length||extra.length)throw fail('DATASET_MANIFEST_DEPENDENCY_UNGOVERNED','Dataset manifest dependency set must exactly match every feature input dependency',{requiredDependencies:required,missingDependencies:missing,unexpectedDependencies:extra,manifestDependencies:manifest.dependencies||[]});
  if(manifest.dataTo<effective.toMs||manifest.fixedAsOf<effective.toMs-1)throw fail('DATASET_MANIFEST_RANGE_INSUFFICIENT','Dataset manifest does not cover the requested range and fixed as-of',{manifestDataTo:manifest.dataTo,manifestFixedAsOf:manifest.fixedAsOf,requestedTo:effective.toMs});
  if(!Array.isArray(manifest.memberVintageIds)||!manifest.memberVintageIds.length)throw fail('DATASET_MANIFEST_MEMBERS_MISSING','Verified manifest did not expose governed member identities');
  for(const dependency of required){const key=`${dependency.symbol}:${dependency.interval}`,expected=Number(manifest.perDependencyRecordCount?.[key]),actual=(manifest.manifestMembers||[]).filter(member=>member.symbol===dependency.symbol&&member.intervalName===dependency.interval).length,integrity=manifest.perDependencyIntegrityCheckResult?.[key];if(!Number.isSafeInteger(expected)||expected<=0||actual!==expected)throw fail('DATASET_MANIFEST_MEMBER_IDENTITY_MISSING','Manifest member identities do not match per-dependency count',{dependency,key,expected,actual});if(!integrity||Number(integrity.gapCount)||Number(integrity.duplicateCount)||Number(integrity.outOfOrderCount))throw fail('DATASET_MANIFEST_DEPENDENCY_INCOMPLETE','Manifest dependency integrity is incomplete',{dependency,key,integrity});}
  if(manifest.researchAvailabilityRuleVersion!==RESEARCH_AVAILABILITY_RULE_VERSION)throw fail('DATASET_RESEARCH_AVAILABILITY_VERSION_MISMATCH','Dataset manifest research-availability version does not match current code');
}

function validateInputsWithinManifest(input,manifest,referenceTime){const members=new Set(manifest.memberVintageIds);for(const dependency of FEATURE_BAR_DEPENDENCIES){for(const row of input[dependency.key]||[]){if(row.openTime<manifest.dataFrom||row.closeTime>manifest.dataTo||row.closeTime>manifest.fixedAsOf)throw fail('SOURCE_OUTSIDE_DATASET_MANIFEST',`${dependency.symbol} ${dependency.interval} source falls outside the verified manifest range`,{symbol:dependency.symbol,interval:dependency.interval,referenceTime,sourceOpenTime:row.openTime,sourceCloseTime:row.closeTime,manifestDataFrom:manifest.dataFrom,manifestDataTo:manifest.dataTo});if(!members.has(row.vintageId))throw fail('SOURCE_NOT_IN_DATASET_MANIFEST',`${dependency.symbol} ${dependency.interval} source vintage is not a manifest member`,{symbol:dependency.symbol,interval:dependency.interval,referenceTime,vintageId:row.vintageId});}}}

export function validateHistoricalFeatureInputs(input,referenceTime){
  for(const dependency of FEATURE_BAR_DEPENDENCIES)checkWindow(input[dependency.key],dependency,referenceTime);
  for(const group of ['funding','openInterest','longShort','takerFlow'])for(const row of input[group]||[])if(row.observedAt>referenceTime||row.publishedAt>referenceTime||row.availableAt>referenceTime||row.fetchedAt>referenceTime)throw fail('FUTURE_LEAK_DETECTED',`${group} contains a future point fact`,{group,referenceTime,sourceTime:row.observedAt});
  return true;
}

export async function runHistoricalFeatureBackfill({repository,options,executionTime=Date.now()}){
  const effective=validateHistoricalBackfillOptions(options),allPoints=enumerateHistoricalFeaturePoints(effective),runId=randomUUID();
  if(allPoints.some(point=>point>executionTime))throw fail('EXECUTION_PRECEDES_REFERENCE','Backfill execution time cannot precede a historical reference point');
  const manifest=await repository.verifyHistoricalFeatureDataset({datasetVersion:effective.datasetVersion,symbol:effective.symbol,from:effective.fromMs,to:effective.toMs});validateVerifiedManifest(manifest,effective);
  const summary={runId,status:effective.dryRun?'DRY_RUN':'SUCCEEDED',dryRun:!!effective.dryRun,symbol:effective.symbol,interval:effective.interval,from:new Date(effective.fromMs).toISOString(),to:new Date(effective.toMs).toISOString(),featureVersion:effective.featureVersion,algorithmVersion:effective.algorithmVersion,datasetVersion:effective.datasetVersion,manifestContractVersion:manifest.manifestContractVersion,manifestContentHash:manifest.contentHash,manifestLogicalWindowHash:manifest.logicalWindowHash,manifestSymbols:manifest.symbols,manifestDependencySet:manifest.dependencies,manifestMemberVintageIds:manifest.memberVintageIds,fixedAsOf:new Date(manifest.fixedAsOf).toISOString(),sourceFormalSemantics:manifest.sourceFormalSemantics,researchAvailabilityRuleVersion:RESEARCH_AVAILABILITY_RULE_VERSION,requiredDependencies:requiredHistoricalFeatureDependencies(),manifestFixedAsOf:new Date(manifest.fixedAsOf).toISOString(),requestedPoints:allPoints.length,generatedPoints:0,alreadyPresent:0,blockedPoints:0,conflictPoints:0,failedPoints:0,earliestReferencePoint:allPoints.length?new Date(allPoints[0]).toISOString():null,latestReferencePoint:allPoints.length?new Date(allPoints.at(-1)).toISOString():null,sourceRange:{},asOfCheck:'PASS',results:[]};
  if(!effective.dryRun)await repository.startHistoricalFeatureRun({runId,...effective,startedAt:executionTime});
  try{
    for(let offset=0;offset<allPoints.length;offset+=effective.batchSize){
      for(const referenceTime of allPoints.slice(offset,offset+effective.batchSize)){
        try{
          const input=await repository.loadHistoricalFeatureInputs({symbol:effective.symbol,targetBarCloseTime:referenceTime,historicalAsOfTime:referenceTime,replayNowMs:executionTime,manifest});
          validateHistoricalFeatureInputs(input,referenceTime);
          validateInputsWithinManifest(input,manifest,referenceTime);
          updateSourceRange(summary,input);
          const record=generateFeatureRecord({...input,symbol:effective.symbol,targetInterval:effective.interval,targetBarCloseTime:referenceTime,asOfTime:referenceTime,generatedAt:executionTime,featureSetVersion:effective.featureVersion,algorithmVersion:effective.algorithmVersion,sourceDatasetVersion:effective.datasetVersion});
          if(record.qualityState==='BLOCKED')throw fail('FEATURE_QUALITY_BLOCKED','Feature quality gate blocked the point',{referenceTime,reasons:record.degradedReasons});
          const result=effective.dryRun?{status:'WOULD_GENERATE',record}:await repository.saveHistoricalFeatureRecord(record,{runId});
          if(result.status==='ALREADY_PRESENT')summary.alreadyPresent++;else summary.generatedPoints++;
          const pointResult={referenceTime,status:result.status,featureId:record.featureId,contentHash:record.contentHash};Object.defineProperty(pointResult,'record',{value:record,enumerable:false});summary.results.push(pointResult);
        }catch(error){
          const conflict=error.code==='HISTORICAL_FEATURE_CONFLICT';if(conflict)summary.conflictPoints++;else summary.blockedPoints++;summary.results.push({referenceTime,status:conflict?'CONFLICT':'BLOCKED',errorCode:error.code||'FEATURE_BACKFILL_FAILED',message:redactHistoricalBackfillText(error.message)});throw error;
        }
      }
    }
    if(!effective.dryRun)await repository.finishHistoricalFeatureRun(runId,{status:'SUCCEEDED',summary,cursorCloseTime:allPoints.at(-1)??null});
    return summary;
  }catch(error){
    summary.status=error.code==='HISTORICAL_FEATURE_CONFLICT'?'CONFLICT':'BLOCKED';summary.failedPoints=1;
    if(!effective.dryRun)await repository.finishHistoricalFeatureRun(runId,{status:'FAILED',summary,errorCode:error.code||'FEATURE_BACKFILL_FAILED'});
    error.summary=summary;throw error;
  }
}

export function exitCodeForHistoricalBackfill(error){if(!error)return HISTORICAL_BACKFILL_EXIT.PASS;if(error.code==='HISTORICAL_FEATURE_CONFLICT')return HISTORICAL_BACKFILL_EXIT.CONFLICT;if(['DATABASE_URL_REQUIRED','DATABASE_URL_INVALID','DATABASE_TARGET_REJECTED','ECONNREFUSED','ENOTFOUND','3D000','28000','28P01'].includes(error.code)||String(error.code).startsWith('08'))return HISTORICAL_BACKFILL_EXIT.DATABASE_FAILURE;if(String(error.code||'').startsWith('INVALID_')||['UNALIGNED_UTC_RANGE','FEATURE_VERSION_MISMATCH','ALGORITHM_VERSION_MISMATCH','DATASET_VERSION_INVALID'].includes(error.code))return HISTORICAL_BACKFILL_EXIT.INVALID_INPUT;return HISTORICAL_BACKFILL_EXIT.BLOCKED;}
