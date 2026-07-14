'use strict';
const C=require('../v1-core.js');
const F=require('../v1_2-forecast-core.js');
let passed=0;
function check(condition,message){if(!condition)throw Error(message);passed++;console.log('PASS '+message);}
function storage(){const values={};return{getItem:key=>values[key]??null,setItem:(key,value)=>{values[key]=String(value)},read:key=>JSON.parse(values[key]||'[]')}}
function finiteRange(range){return range&&Number.isFinite(range.lower)&&Number.isFinite(range.upper)&&range.lower<range.upper;}
function finiteZone(zone){return zone===null||(Array.isArray(zone)&&zone.length===2&&zone.every(Number.isFinite)&&zone[0]<zone[1]);}

(async()=>{
  const marketData=await C.fetchAllTimeframeKlines(global.fetch);
  check(!marketData.partial&&marketData.failed.length===0,'V1.2生产链六路Binance REST数据完整');
  const decision=C.buildDecision(marketData.eth,marketData.btc,null,{},C.COST_DEFAULT);
  const now=Date.now(),forecast=F.buildForecast(marketData,decision,null,now),horizons=[['15m',forecast.m15],['1h',forecast.h1],['4h',forecast.h4]];
  for(const [name,h] of horizons){
    check(h&&h.directionLabel!=='数据不足',`${name}正式预测成功生成`);
    check(Object.values(h.weights).reduce((sum,x)=>sum+x,0)===100,`${name}规则权重严格合计100`);
    check(finiteRange(h.priceRange),`${name}预计区间有限且上下界有序`);
    check(h.scenarioTargets&&finiteZone(h.scenarioTargets.bullishZone)&&finiteZone(h.scenarioTargets.bearishZone)&&finiteZone(h.scenarioTargets.rangingZone),`${name}情景目标无NaN、Infinity或倒置`);
  }
  const store=storage();
  for(const [name,h] of horizons){const e=F.buildForecastLogEntry(forecast,h,name,{now});check(e.calibratedProbability===null,`${name} calibratedProbability恒为null`);check(F.saveForecastLog(e,store).saved,`${name}正式预测日志成功写入`);}
  check(store.read(F.FORECAST_LOG_KEY).length===3,'三个时窗正式预测日志互不覆盖');
  for(const [name,h] of horizons)F.saveForecastLog(F.buildForecastLogEntry(forecast,h,name,{now}),store);
  check(store.read(F.FORECAST_LOG_KEY).length===3,'相同dataAsOf重复刷新不会重复写入');

  const insufficient={...marketData,partial:true,failed:['btc.tf4h']};
  const blockedForecast=F.buildForecast(insufficient,decision,null,now+1);
  const blockedEntry=F.buildForecastLogEntry(blockedForecast,blockedForecast.h4,'4h',{now:now+1});
  const blockedStore=storage();F.saveForecastLog(blockedEntry,blockedStore);
  check(blockedStore.read(F.FORECAST_LOG_KEY).length===1&&blockedEntry.blocked&&blockedEntry.status==='blocked','数据不足路径写入blocked审计日志');
  check(blockedEntry.directionLabel===null&&blockedEntry.directionWeights===null&&blockedEntry.priceRange===null&&blockedEntry.scenarioTargets===null&&blockedEntry.mostLikelyPath===null&&blockedEntry.calibratedProbability===null,'blocked审计不携带旧方向、权重、区间、目标或路径');

  const manualForecast=F.buildForecast(marketData,{...decision,isManual:true,worthBetting:false},null,now+2);
  const before=blockedStore.read(F.FORECAST_LOG_KEY).length;
  for(const [name,h] of [['15m',manualForecast.m15],['1h',manualForecast.h1],['4h',manualForecast.h4]]){const e=F.buildForecastLogEntry(manualForecast,h,name,{now:now+2});if(e)F.saveForecastLog(e,blockedStore);}
  check(blockedStore.read(F.FORECAST_LOG_KEY).length===before,'手动观察模式不写正式预测日志');
  console.log(`RESULT passed=${passed} failed=0`);
})().catch(e=>{console.error(`RESULT passed=${passed} failed=1 ${e.message}`);process.exitCode=1});
