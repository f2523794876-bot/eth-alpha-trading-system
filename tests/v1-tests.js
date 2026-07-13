'use strict';
const assert=require('node:assert/strict');
const C=require('../v1-core.js');
let passed=0,failed=0;
function test(name,fn){try{fn();passed++;process.stdout.write(`PASS ${name}\n`);}catch(e){failed++;process.stderr.write(`FAIL ${name}: ${e.message}\n`);}}
const MS=C.TF_MS['15m'];
function bar(i,o,h,l,c,v=100,closed=true,base=1700000000000){return{openTime:base+i*MS,open:o,high:h,low:l,close:c,volume:v,takerBuyVolume:v*.55,closeTime:base+(i+1)*MS-1,isClosed:closed};}
function rangeBars(n=40,base=1800,trend=0){const a=[];for(let i=0;i<n;i++){const c=base+i*trend+Math.sin(i)*2;a.push(bar(i,c-1,c+4,c-4,c,100+(i%3)*5));}return a;}
function bullish(n=80,base=1700,step=2){const a=[];for(let i=0;i<n;i++){const c=base+i*step+Math.sin(i)*.5;a.push(bar(i,c-1,c+2,c-3,c,100+i));}return a;}
function bearish(n=80,base=2100,step=2){const a=[];for(let i=0;i<n;i++){const c=base-i*step+Math.sin(i)*.5;a.push(bar(i,c+1,c+3,c-2,c,100+i));}return a;}
function legacyBreakout(k){const price=k.at(-1).close,high20=Math.max(...k.slice(-20).map(x=>x.high));return price>high20;}

test('T2.1-old P0 fixture reproduces self-reference failure',()=>{const k=rangeBars();k[30].high=1810;k.push(bar(40,1802,1818,1800,1815,260));assert.equal(legacyBreakout(k),false);});
test('T2.1 frozen structure excludes confirming bar',()=>{const k=rangeBars();k[30].high=1810;k.push(bar(40,1802,1818,1800,1815,260));const s=C.analyzeKlines(k,'15m');assert.equal(s.priorStructureHigh20,1810);assert.equal(s.isBreakout,true);assert.equal(s.breakoutLevel,1810);});
test('T2.1 repaired P0 scenario can enter BULL_CONFIRMATION',()=>{const make=base=>{const a=[];for(let i=0;i<60;i++){const c=base+i*2;a.push(bar(i,c-1,c+2,c-3,c,100+i));}const c=base+140;a.push(bar(60,c-1,c+3,c-22,c,300));return a};const e=C.analyzeKlines(make(1700),'15m'),b=C.analyzeKlines(make(60000),'15m','BTC');assert.equal(C.classifyState(e,b).state,'BULL_CONFIRMATION');});
test('T15 unclosed spike is intrabar warning only',()=>{const k=rangeBars();k[30].high=1810;k.push(bar(40,1802,1820,1800,1815,260,false));const s=C.analyzeKlines(k,'15m');assert.equal(s.isBreakout,false);assert.match(s.intrabarWarning,/未收盘/);assert.notEqual(C.classifyState(s,C.analyzeKlines(rangeBars(),'15m')).state,'BULL_CONFIRMATION');});
test('T15 closed pullback remains not breakout',()=>{const k=rangeBars();k[30].high=1810;k.push(bar(40,1802,1820,1800,1805,260,true));assert.equal(C.analyzeKlines(k,'15m').isBreakout,false);});
test('T3 frozen low detects breakdown',()=>{const k=rangeBars();k[30].low=1790;k.push(bar(40,1799,1800,1784,1786,260));const s=C.analyzeKlines(k,'15m');assert.equal(s.priorStructureLow20,1790);assert.equal(s.isBreakdown,true);});

test('T9 invalid OHLC is anomalous',()=>{const k=rangeBars();k[10].high=k[10].low-1;assert.ok(C.detectAnomalyBars(k,C.calcATR(k)).has(10));});
test('T9 too few bars disables ATR',()=>assert.equal(C.analyzeKlines(rangeBars(14),'15m').atr14,null));
test('T11 stale data detected',()=>{const k=rangeBars();assert.equal(C.assessDataQuality(k,'15m',k.at(-1).closeTime+31*60000).isStale,true);});
test('T18 zones cluster close swings',()=>{const e=C.analyzeKlines(rangeBars(80),'15m');e.atr14=10;e.swingHighs=[{price:1810,index:1,time:1,barsAgo:10,clusterId:1},{price:1811,index:2,time:2,barsAgo:8,clusterId:1},{price:1809.5,index:3,time:3,barsAgo:5,clusterId:1}];e.firstResistance={price:1810,source:'swing',confidence:'high',clusterId:1};e.secondResistance={price:1830,source:'swing',confidence:'high',clusterId:2};const z=C.buildSRZones(e).resistanceZones[0];assert.equal(z.sourceSwingCount,3);assert.equal(z.zoneHalfWidth,1.5);});
test('support swing source is explicitly Swing Low',()=>{const e=C.analyzeKlines(rangeBars(80),'15m');e.firstSupport={price:1795,source:'swing',confidence:'high',clusterId:9};e.swingLows=[{price:1795,clusterId:9}];assert.equal(C.buildSRZones(e).supportZones[0].sourceLabel,'摆动低点');});
test('resistance swing source is explicitly Swing High',()=>{const e=C.analyzeKlines(rangeBars(80),'15m');e.firstResistance={price:1810,source:'swing',confidence:'high',clusterId:8};e.swingHighs=[{price:1810,clusterId:8}];assert.equal(C.buildSRZones(e).resistanceZones[0].sourceLabel,'摆动高点');});
test('broken resistance reused as support is explained',()=>{const e=C.analyzeKlines(rangeBars(80),'15m');e.isBreakout=true;e.breakoutLevel=1810;e.firstSupport={price:1810,source:'swing',confidence:'high',clusterId:8};e.swingLows=[];assert.equal(C.buildSRZones(e).supportZones[0].sourceLabel,'历史压力转支撑');});

test('T10 invalid risk data',()=>assert.equal(C.calcRiskReward({price:100},null,'long',null,[120]).status,'invalid_data'));
test('no plan has non-error RR wording',()=>{const r=C.calcRiskReward({price:100},null,'neutral',null,[null]);assert.equal(r.status,'missing_level');assert.equal(r.message,'当前无有效交易方案，暂不计算盈亏比');});
test('T10 risk zero',()=>assert.equal(C.calcRiskReward({price:100},null,'long',100,[120]).status,'risk_zero_or_negative'));
test('T10 price past target',()=>assert.equal(C.calcRiskReward({price:120},null,'long',100,[110]).status,'price_past_target'));
test('T19 net RR includes costs',()=>{const e={price:2000};const r=C.calcRiskReward(e,{trend:'up'},'long',1980,[2041],C.COST_DEFAULT);assert.ok(r.netValue<r.grossValue);assert.ok(r.costAmount>0);});
test('T10 BTC conflict flag',()=>{const r=C.calcRiskReward({price:100},{trend:'down'},'long',90,[130]);assert.ok(r.flags.includes('btcConflictDespiteGoodRR'));});

test('T12 full alignment permits trend entry',()=>{const h={state:'HTF_BULL_TREND'},m={state:'BULL_CONFIRMATION'},l={state:'BULL_PULLBACK'},b={trend:'up'};const p=C.computeSignalPermission(h,m,l,b,b,b,'normal');assert.equal(p.alignment,'full_aligned');assert.equal(p.addOnAllowed,true);assert.equal(p.positionSizeCapPct,20);});
test('T13 counter trend caps at five and blocks add-on',()=>{const p=C.computeSignalPermission({state:'HTF_BEAR_TREND'},{state:'BEAR_CONTINUATION'},{state:'BULL_PULLBACK'},{trend:'down'},{trend:'down'},{trend:'up'},'normal');assert.equal(p.level,'counter_trend_only');assert.equal(p.positionSizeCapPct,5);assert.equal(p.addOnAllowed,false);});
test('T14 one BTC timeframe conflict prevents full alignment',()=>{const h={state:'HTF_BULL_TREND'},m={state:'BULL_CONFIRMATION'},l={state:'BULL_CONFIRMATION'};const p=C.computeSignalPermission(h,m,l,{trend:'up'},{trend:'down'},{trend:'up'},'normal');assert.notEqual(p.alignment,'full_aligned');});
test('T17 invalid health blocks signals',()=>assert.equal(C.computeSignalPermission({}, {}, {}, {}, {}, {},'invalid').level,'blocked_by_data'));

test('T8 manual validation rejects inverted range',()=>assert.equal(C.validateManualInput({ethPrice:2000,btcPrice:60000,recentHigh:2100,recentLow:1900,high20:1900,low20:2000}).ok,false));
test('T8 manual validation rejects magnitude error',()=>assert.equal(C.validateManualInput({ethPrice:2000,btcPrice:60000,recentHigh:2100,recentLow:1900,high20:62000,low20:60000}).ok,false));
test('T8 manual snapshot is explicit low confidence',()=>{const s=C.analyzeManual({ethPrice:2000,btcPrice:60000,recentHigh:2100,recentLow:1900,high20:2050,low20:1950});assert.equal(s.isManual,true);assert.equal(s.firstSupport.confidence,'low');});
test('T24 log keeps true HTF and MTF states',()=>{const d={price:1,state:'RANGE_CHOP',htfState:'HTF_RANGE',mtfState:'RANGE_CHOP',signalPermission:{},worthBetting:false,score:{items:[]},dataHealth:'normal'};const x=C.buildDecisionLogEntry(d);assert.equal(x.htfState,'HTF_RANGE');assert.equal(x.mtfState,'RANGE_CHOP');});

test('T20 score items are transparent',()=>{const q={sufficientForEMA20:true},e15={state:'BULL_CONFIRMATION',trend:'up',falseBreakoutTier:'none'},e1={state:'BULL_CONFIRMATION',trend:'up',dataQuality:q},e4={htfState:'HTF_BULL_TREND',dataQuality:q},p={alignment:'full_aligned',level:'trend_entry_allowed',reason:'ok'},s=C.calcScore(e15,e1,e4,{netValue:3,message:'ok'},{sustained:true,ratio:2,evidence:['ok']},'normal',p);assert.ok(s.items.every(x=>'name'in x&&'points'in x&&'maxPoints'in x&&'reason'in x));assert.ok(s.total>=90);});
test('4h transition cannot receive full score',()=>{const q={sufficientForEMA20:true},e15={state:'TRANSITION_WATCH',falseBreakoutTier:'none'},e1={state:'TRANSITION_WATCH',dataQuality:q},e4={htfState:'HTF_TRANSITION',dataQuality:q},p={alignment:'conflict',level:'stand_aside',reason:'冲突'},s=C.calcScore(e15,e1,e4,{netValue:null,message:'无方案'},{sustained:false,ratio:.8,evidence:['收缩']},'normal',p);assert.equal(s.items.find(x=>x.name==='4小时方向').points,6);});
test('1h range cannot receive full score',()=>{const q={sufficientForEMA20:true},e15={state:'RANGE_CHOP',falseBreakoutTier:'none'},e1={state:'RANGE_CHOP',dataQuality:q},e4={htfState:'HTF_RANGE',dataQuality:q},p={alignment:'conflict',level:'stand_aside',reason:'冲突'},s=C.calcScore(e15,e1,e4,{netValue:null,message:'无方案'},{sustained:false,ratio:.8,evidence:['收缩']},'normal',p);assert.equal(s.items.find(x=>x.name==='1小时结构').points,3);});
test('opposite higher timeframes receive zero direction evidence',()=>{const q={sufficientForEMA20:true},e15={state:'BULL_CONFIRMATION',falseBreakoutTier:'none'},e1={state:'BEAR_CONTINUATION',dataQuality:q},e4={htfState:'HTF_BEAR_TREND',dataQuality:q},p={alignment:'conflict',level:'stand_aside',reason:'冲突'},s=C.calcScore(e15,e1,e4,{netValue:2,message:'ok'},{sustained:false,ratio:1,evidence:['正常']},'normal',p);assert.equal(s.items.find(x=>x.name==='4小时方向').points,0);assert.equal(s.items.find(x=>x.name==='1小时结构').points,0);});
test('near resistance interception warns against chasing long',()=>{const z=C.bestInterceptionZone('RANGE_CHOP','none','neutral',{price:109,atr14:4,firstResistance:{price:110},firstSupport:{price:90}});assert.equal(z.zone,'接近上方压力，不宜追多');});
test('near support interception observes support',()=>{const z=C.bestInterceptionZone('RANGE_CHOP','none','neutral',{price:91,atr14:4,firstResistance:{price:110},firstSupport:{price:90}});assert.equal(z.zone,'接近下方支撑，观察承接');});
test('middle interception only when far from both zones',()=>{const z=C.bestInterceptionZone('RANGE_CHOP','none','neutral',{price:100,atr14:4,firstResistance:{price:110},firstSupport:{price:90}});assert.equal(z.zone,'区间中部');});
test('worthBetting hard rule independent from score',()=>assert.doesNotMatch(C.buildDecision.toString(),/score\.total/));
test('professional add-on states risk budget and no averaging down',()=>{const x=C.buildAddOnCondition({},'long',{addOnAllowed:true,reason:'ok'});assert.match(x,/风险预算/);assert.match(x,/不得因浮亏|不得.*摊平/);});
test('exit conditions are independently listed',()=>assert.equal(C.buildExitConditions({},100,[120],'x').length,5));
test('six REST endpoints are configured from two assets and three intervals',()=>{const s=C.fetchAllTimeframeKlines.toString();for(const token of ['ETHUSDT','BTCUSDT','15m','1h','4h'])assert.ok(s.includes(token),token);});

process.on('beforeExit',()=>{process.stdout.write(`\nRESULT passed=${passed} failed=${failed}\n`);if(failed)process.exitCode=1;});
