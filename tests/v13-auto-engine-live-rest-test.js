'use strict';
const C=require('../v1-core.js'),F=require('../v1_2-forecast-core.js'),P=require('../v1_3-paper-trading-core.js'),S=require('../v1_3-signal-archive-core.js'),A=require('../v1_3-auto-engine-core.js'),X=require('./v13-fixtures.js');
let p=0;function ok(x,n){if(!x)throw Error(n);p++;console.log('PASS '+n)}
(async()=>{
  const m=await C.fetchAllTimeframeKlines(global.fetch);ok(!m.partial,'确定性自动引擎真实REST六路完整');
  const raw=C.buildDecision(m.eth,m.btc,null,{},C.COST_DEFAULT),f=F.buildForecast(m,raw,null,Date.now());ok(raw.dataHealth==='normal'&&f.m15&&f.h1&&f.h4,'buildDecision到buildForecast真实输入链完整');
  const price=raw.confirmedPrice,atr=raw.ltf15m.atr14||price*.01,d={...raw,worthBetting:true,biasDirection:'long',dataHealth:'normal',isManual:false,opportunityScores:{...raw.opportunityScores,blocked:false,blockReasons:[]},signalPermission:{...raw.signalPermission,alignment:'full_aligned',level:'trend_entry_allowed',addOnAllowed:true},triggerPlans:{...raw.triggerPlans,long:{estimatedEntry:price,entryZone:[price-atr*.1,price+atr*.1],invalidation:price-atr,targets:[price+atr,price+2*atr,price+3*atr],riskReward:{status:'ok',grossValue:1,netValue:.9}}}},s=new X.Storage(),a=P.createPaperAccount();
  a.settings.leverage=3;s.setItem(P.KEYS.account,JSON.stringify(a));s.setItem(P.KEYS.trades,'[]');s.setItem(P.KEYS.log,'[]');
  const rec=S.recordSignalIfEligible(d,f,m,s);ok(rec.ok&&rec.signal.eligibleForTrigger,'真实行情输入进入确定性许可夹具并写入创建时许可证据');
  const shadow=JSON.parse(s.getItem(S.KEYS.shadow));shadow[0].lifecycleStatus='TRIGGERED';s.setItem(S.KEYS.shadow,JSON.stringify(shadow));A.armAutoEngine(s,()=>true,'LIVE-ARM');let aa=P.loadPaperAccount(s);aa.engineState='AUTO_PAPER_RUNNING';s.setItem(P.KEYS.account,JSON.stringify(aa));
  let sig=S.getSignalCurrentView(rec.signal.signalId,s),checks=A.opportunityChecks(d,sig,aa,[]);ok(A.classifyBlocked(checks).ok&&A.checkReverseSignalCooldown(sig,aa).ok,'确定性十九项门禁与反向冷却全部通过');ok(S.setArchiveCategory(sig.signalId,'EXECUTABLE',s).ok,'最终门控后升级为EXECUTABLE');sig=S.getSignalCurrentView(sig.signalId,s);
  const r=A.tickAutoEngine(d,f,m,aa,[sig],s);ok(r.ok,'真实行情输入进入tickAutoEngine确定性下游夹具');ok(P.loadPaperTrades(s).length===1,'确定性完整门禁夹具满足后自动虚拟开仓');ok(S.getSignalCurrentView(sig.signalId,s).userActionStatus==='AUTO_EXECUTED','建议与模拟仓位关联');
  const before=P.loadPaperTrades(s).length;A.tickAutoEngine(d,f,m,P.loadPaperAccount(s),[S.getSignalCurrentView(sig.signalId,s)],s);ok(P.loadPaperTrades(s).length===before,'重复REST刷新不重复开仓');ok(P.loadPaperAccount(s).lastEngineHeartbeat!==null,'引擎心跳持久化');console.log(`RESULT passed=${p} failed=0`)
})().catch(e=>{console.error(`RESULT passed=${p} failed=1 ${e.message}`);process.exitCode=1});
