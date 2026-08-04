import { randomUUID } from 'node:crypto';
import { TREND } from '../domain/trend.js';
import { finalizeFeatureRecord } from './feature-contract.js';
import { assessFeatureQuality } from './feature-quality.js';
import { sourceRef, validateLineage } from './feature-lineage.js';
import { FEATURE_ALGORITHM_VERSION, FEATURE_SET_VERSION, SOURCE_DATASET_VERSION } from './feature-version.js';

const n=value=>value===null||value===undefined?null:Number(value);
const avg=xs=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;
const sd=xs=>{if(xs.length<2)return null;const m=avg(xs);return Math.sqrt(avg(xs.map(x=>(x-m)**2)));};
const ratio=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&b!==0?a/b:null;
const logReturn=(bars,lag)=>bars.length>lag&&n(bars.at(-1).close)>0&&n(bars.at(-1-lag).close)>0?Math.log(n(bars.at(-1).close)/n(bars.at(-1-lag).close)):null;
const ema=(values,period)=>{if(values.length<period)return null;const k=2/(period+1);let out=avg(values.slice(0,period));for(const value of values.slice(period))out=value*k+out*(1-k);return out;};
const trueRanges=bars=>bars.map((bar,i)=>{const h=n(bar.high),l=n(bar.low),pc=i?n(bars[i-1].close):n(bar.open);return Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc));});
const atr=(bars,period=14)=>bars.length>=period+1?avg(trueRanges(bars).slice(-period)):null;
const trend=bars=>{const closes=bars.map(x=>n(x.close));const e5=ema(closes,5),e20=ema(closes,20);return !Number.isFinite(e5)||!Number.isFinite(e20)?null:e5>e20?TREND.UP:e5<e20?TREND.DOWN:TREND.RANGE;};
const pearson=(a,b)=>{const size=Math.min(a.length,b.length);if(size<6)return null;const x=a.slice(-size),y=b.slice(-size),mx=avg(x),my=avg(y),sx=Math.sqrt(x.reduce((s,v)=>s+(v-mx)**2,0)),sy=Math.sqrt(y.reduce((s,v)=>s+(v-my)**2,0));return sx&&sy?x.reduce((s,v,i)=>s+(v-mx)*(y[i]-my),0)/(sx*sy):null;};
const zscore=(value,series)=>{const s=sd(series);return Number.isFinite(value)&&Number.isFinite(s)&&s>0?(value-avg(series))/s:null;};
const sorted=rows=>[...rows].sort((a,b)=>Number(a.closeTime??a.observedAt)-Number(b.closeTime??b.observedAt));

function barFeatures(bars){
  const xs=sorted(bars),last=xs.at(-1);if(!last)return{};const closes=xs.map(x=>n(x.close)),volumes=xs.map(x=>n(x.volume)),quotes=xs.map(x=>n(x.quoteVolume));
  const e5=ema(closes,5),e10=ema(closes,10),e20=ema(closes,20),prev5=ema(closes.slice(0,-1),5),prev10=ema(closes.slice(0,-1),10),prev20=ema(closes.slice(0,-1),20),a14=atr(xs);
  const open=n(last.open),high=n(last.high),low=n(last.low),close=n(last.close),range=high-low,window=xs.slice(-20),high20=Math.max(...window.map(x=>n(x.high))),low20=Math.min(...window.map(x=>n(x.low))),prior=xs.slice(-21,-1),priorHigh=prior.length?Math.max(...prior.map(x=>n(x.high))):null,priorLow=prior.length?Math.min(...prior.map(x=>n(x.low))):null;
  const returns=xs.slice(1).map((x,i)=>Math.log(n(x.close)/n(xs[i].close))).filter(Number.isFinite),ranges=trueRanges(xs);
  return {logReturn1:logReturn(xs,1),logReturn3:logReturn(xs,3),logReturn6:logReturn(xs,6),logReturn12:logReturn(xs,12),closeToEma5:Number.isFinite(e5)?close/e5-1:null,closeToEma10:Number.isFinite(e10)?close/e10-1:null,closeToEma20:Number.isFinite(e20)?close/e20-1:null,ema5Slope:Number.isFinite(prev5)?e5/prev5-1:null,ema10Slope:Number.isFinite(prev10)?e10/prev10-1:null,ema20Slope:Number.isFinite(prev20)?e20/prev20-1:null,highLowRange:ratio(range,close),candleBodyRatio:ratio(Math.abs(close-open),range),upperWickRatio:ratio(high-Math.max(open,close),range),lowerWickRatio:ratio(Math.min(open,close)-low,range),atr14:a14,atrNormalized:ratio(a14,close),realizedVolatility:sd(returns.slice(-20)),volatilityRegime:Number.isFinite(a14)&&ranges.length>=20?(a14>avg(ranges.slice(-20))*1.25?'HIGH':a14<avg(ranges.slice(-20))*.75?'LOW':'NORMAL'):null,rangeExpansionRatio:ratio(range,avg(ranges.slice(-20,-1))),volumeRatio20:ratio(n(last.volume),avg(volumes.slice(-20))),volumeZScore:zscore(n(last.volume),volumes.slice(-20)),quoteVolumeRatio:ratio(n(last.quoteVolume),avg(quotes.slice(-20))),takerBuyRatio:ratio(n(last.takerBuyBaseVolume),n(last.volume)),takerSellRatio:Number.isFinite(ratio(n(last.takerBuyBaseVolume),n(last.volume)))?1-ratio(n(last.takerBuyBaseVolume),n(last.volume)):null,takerImbalance:Number.isFinite(ratio(n(last.takerBuyBaseVolume),n(last.volume)))?2*ratio(n(last.takerBuyBaseVolume),n(last.volume))-1:null,swingHigh:priorHigh,swingLow:priorLow,distanceToSupportAtr:Number.isFinite(a14)?(close-low20)/a14:null,distanceToResistanceAtr:Number.isFinite(a14)?(high20-close)/a14:null,rangePosition:high20>low20?(close-low20)/(high20-low20):null,breakoutState:Number.isFinite(priorHigh)&&close>priorHigh?'BREAKOUT_UP':Number.isFinite(priorLow)&&close<priorLow?'BREAKOUT_DOWN':'INSIDE',falseBreakoutRisk:Number.isFinite(priorHigh)&&high>priorHigh&&close<=priorHigh?'UPPER_REJECTION':Number.isFinite(priorLow)&&low<priorLow&&close>=priorLow?'LOWER_REJECTION':'NONE',structureState:trend(xs),trend:trend(xs),close};
}

function derivativeFeatures(input){
  const funding=sorted(input.funding||[]),oi=sorted(input.openInterest||[]),ls=sorted(input.longShort||[]),tf=sorted(input.takerFlow||[]),f=funding.at(-1),o=oi.at(-1),op=oi.at(-2),l=ls.at(-1),t=tf.at(-1);
  const fundingSeries=funding.slice(-30).map(x=>n(x.fundingRate)),lsSeries=ls.slice(-30).map(x=>n(x.longShortRatio));
  return {fundingRate:n(f?.fundingRate),fundingRateZScore:zscore(n(f?.fundingRate),fundingSeries),openInterest:n(o?.openInterest),openInterestChange:o&&op?n(o.openInterest)-n(op.openInterest):null,openInterestChangeRatio:o&&op?ratio(n(o.openInterest)-n(op.openInterest),n(op.openInterest)):null,longShortRatio:n(l?.longShortRatio),longShortRatioZScore:zscore(n(l?.longShortRatio),lsSeries),takerBuySellRatio:n(t?.buySellRatio),derivativesAvailability:[f,o,l,t].every(Boolean)};
}

export function computeFeatureValues(input){
  const eth15=barFeatures(input.eth15||[]),eth1=barFeatures(input.eth1h||[]),eth4=barFeatures(input.eth4h||[]),btc15=barFeatures(input.btc15||[]),derivatives=derivativeFeatures(input),ethReturns=sorted(input.eth15||[]).slice(-30).map((x,i,a)=>i?Math.log(n(x.close)/n(a[i-1].close)):null).filter(Number.isFinite),btcReturns=sorted(input.btc15||[]).slice(-30).map((x,i,a)=>i?Math.log(n(x.close)/n(a[i-1].close)):null).filter(Number.isFinite);
  const alignment=[eth15.trend,eth1.trend,eth4.trend].filter(Boolean),allSame=alignment.length===3&&new Set(alignment).size===1,conflict=alignment.includes(TREND.UP)&&alignment.includes(TREND.DOWN);
  return {...eth15,...derivatives,btcReturn:btc15.logReturn1,btcTrendState:btc15.trend,btcVolatility:btc15.realizedVolatility,ethBtcReturnSpread:Number.isFinite(eth15.logReturn1)&&Number.isFinite(btc15.logReturn1)?eth15.logReturn1-btc15.logReturn1:null,ethBtcRollingCorrelation:pearson(ethReturns,btcReturns),btcConflictState:eth15.trend&&btc15.trend&&eth15.trend!==btc15.trend?'CONFLICT':'ALIGNED',trend15m:eth15.trend,trend1h:eth1.trend,trend4h:eth4.trend,multiTimeframeAlignment:allSame?alignment[0]:'MIXED',multiTimeframeConflict:conflict,strategicRegime:eth4.trend};
}

// Authoritative market-bar inputs actually consumed by computeFeatureValues.
// Keep historical tooling coupled to this declaration rather than duplicating a
// broader, speculative BTC dependency list.
export const FEATURE_BAR_DEPENDENCIES = Object.freeze([
  Object.freeze({key:'eth15',symbol:'ETHUSDT',marketType:'spot',interval:'15m',minimumBars:30}),
  Object.freeze({key:'eth1h',symbol:'ETHUSDT',marketType:'spot',interval:'1h',minimumBars:21}),
  Object.freeze({key:'eth4h',symbol:'ETHUSDT',marketType:'spot',interval:'4h',minimumBars:21}),
  Object.freeze({key:'btc15',symbol:'BTCUSDT',marketType:'spot',interval:'15m',minimumBars:30})
]);

export function generateFeatureRecord(input,{now=Date.now}={}){
  const targetInterval=input.targetInterval||'15m',targetKey=targetInterval==='15m'?'eth15':targetInterval==='1h'?'eth1h':'eth4h',target=sorted(input[targetKey]||[]).at(-1);const asOfTime=input.asOfTime??target?.closeTime;const allRows=[...(input.eth15||[]),...(input.eth1h||[]),...(input.eth4h||[]),...(input.btc15||[]),...(input.btc1h||[]),...(input.btc4h||[]),...(input.funding||[]),...(input.openInterest||[]),...(input.longShort||[]),...(input.takerFlow||[])];
  if(!target)throw Object.assign(new Error('Critical ETH 15m window missing'),{code:'CRITICAL_ETH_WINDOW_INSUFFICIENT'});
  if(input.targetBarCloseTime!==undefined&&Number(target.closeTime)!==Number(input.targetBarCloseTime))throw Object.assign(new Error('Exact target bar is unavailable'),{code:'TARGET_BAR_MISSING'});
  const future=allRows.some(row=>Number(row.availableAt)>asOfTime||Number(row.fetchedAt)>asOfTime||Number(row.publishedAt)>asOfTime||Number(row.closeTime??row.observedAt)>Number(target.closeTime));const refs=allRows.map(row=>sourceRef(row.closeTime!==undefined?'market_bars':row.fieldId||'point_fact',row));const lineage=validateLineage(refs,asOfTime,Number(target.closeTime)),features=computeFeatureValues(input);
  const preliminaryMissing=Object.entries(features).filter(([,v])=>v===null||v===undefined).map(([k])=>k);const quality=assessFeatureQuality({targetClosed:Number(target.closeTime)<=asOfTime,databaseAvailable:input.databaseAvailable!==false,timeContractValid:lineage.ok,futureLeak:future,featureSetVersion:input.featureSetVersion||FEATURE_SET_VERSION,features,missingFeatures:preliminaryMissing});
  return finalizeFeatureRecord({symbol:input.symbol||'ETHUSDT',targetInterval,targetBarOpenTime:Number(target.openTime),targetBarCloseTime:Number(target.closeTime),asOfTime,generatedAt:input.generatedAt||now(),featureSetVersion:input.featureSetVersion||FEATURE_SET_VERSION,algorithmVersion:input.algorithmVersion||FEATURE_ALGORITHM_VERSION,sourceDatasetVersion:input.sourceDatasetVersion||SOURCE_DATASET_VERSION,sourceVintageRefs:refs,sourceRevisionRefs:input.sourceRevisionRefs||refs.filter(x=>x.revision>0).map(x=>({dataset:x.dataset,vintageId:x.vintageId,revision:x.revision,revisionEventId:null})),features,qualityState:quality.qualityState,missingFeatures:preliminaryMissing,degradedReasons:[...quality.degradedReasons,...(!derivativeFeatures(input).derivativesAvailability?['DERIVATIVES_INCOMPLETE']:[])]});
}

export class FeatureEngine{
  constructor({repository,now=Date.now}){this.repository=repository;this.now=now;}
  async generatePoint({symbol='ETHUSDT',targetInterval='15m',targetBarCloseTime,asOfTime=this.now(),featureSetVersion=FEATURE_SET_VERSION,dryRun=false},lease){
    const input=await this.repository.loadFeatureInputs({symbol,targetInterval,targetBarCloseTime,asOfTime});const record=generateFeatureRecord({...input,symbol,targetInterval,targetBarCloseTime,asOfTime,featureSetVersion},{now:this.now});
    if(record.qualityState==='BLOCKED')return{status:'BLOCKED',record};if(dryRun)return{status:'DRY_RUN',record};return this.repository.saveFeatureRecord(record,lease);
  }
  async generateRange({symbol='ETHUSDT',targetInterval='15m',from,to,featureSetVersion=FEATURE_SET_VERSION,dryRun=false,resumeAfter=null},lease){
    const targets=await this.repository.listFeatureTargets({symbol,targetInterval,from,to,resumeAfter});const runId=randomUUID();if(!dryRun)await this.repository.startFeatureRun?.({runId,symbol,targetInterval,from,to,featureSetVersion,startedAt:this.now()},lease);const results=[];
    try{for(const target of targets){const historicalAsOfTime=Number(target.closeTime);results.push(await this.generatePoint({symbol,targetInterval,targetBarCloseTime:historicalAsOfTime,asOfTime:historicalAsOfTime,featureSetVersion,dryRun},lease));}if(!dryRun)await this.repository.finishFeatureRun?.(runId,{status:'SUCCEEDED',results,cursorCloseTime:targets.at(-1)?.closeTime},lease);return{runId,status:dryRun?'DRY_RUN':'SUCCEEDED',results};}catch(error){if(!dryRun)await this.repository.finishFeatureRun?.(runId,{status:'FAILED',errorCode:error.code||'FEATURE_GENERATION_FAILED',results},lease);throw error;}
  }
}
