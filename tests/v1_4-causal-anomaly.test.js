'use strict';
const assert=require('node:assert/strict');
const C=require('../v1-core.js');
const F=require('../v1_4-gmkg-forecast-core.js');
let passed=0,failed=0;
function test(name,fn){try{fn();passed++;console.log('PASS '+name)}catch(e){failed++;console.error('FAIL '+name+': '+e.message)}}
const MS=900000,BASE=1700000000000;
function bar(i,range=10,closed=true){const center=60000;return{openTime:BASE+i*MS,closeTime:BASE+(i+1)*MS-1,open:center,high:center+range/2,low:center-range/2,close:center,volume:100,takerBuyVolume:55,isClosed:closed}}
function bars(ranges){return ranges.map((range,i)=>bar(i,range))}

test('因果性：未来K线变化不改变既有bar判定',()=>{const a=bars(Array(40).fill(10)),before=C.detectAnomalyBars(a).has(20);a[30]={...a[30],high:65000,low:55000};const after=C.detectAnomalyBars(a).has(20);assert.equal(after,before)});
test('波动率制度切换不会用末端低ATR重判历史',()=>{const a=bars([...Array(20).fill(100),...Array(30).fill(10)]),causal=C.detectAnomalyBars(a),terminalAtr=C.calcATR(a),legacy=a.filter(x=>x.high-x.low>5*terminalAtr);assert.equal(causal.size,0);assert.ok(legacy.length>5)});
test('真实单根异常超过前序ATR五倍会被标记',()=>{const a=bars([...Array(20).fill(10),60]);assert.equal(C.detectAnomalyBars(a).has(20),true)});
test('极端bar不参与自己的ATR以防自我稀释',()=>{const a=bars([...Array(20).fill(10),70]),prior=C.calcATR(a.slice(0,20)),diluted=C.calcATR(a);assert.ok(70>5*prior);assert.ok(70<=5*diluted);assert.equal(C.detectAnomalyBars(a).has(20),true)});
test('ATR预热不足不读取未来或末端ATR',()=>{const a=bars([...Array(5).fill(10),1000,...Array(30).fill(10)]);assert.equal(C.detectAnomalyBars(a).has(5),false)});
test('六根真实异常仍触发既有健康门',()=>{const ranges=Array(20).fill(10);for(let n=0;n<6;n++){ranges.push(80,...Array(15).fill(10))}const a=bars(ranges),count=C.detectAnomalyBars(a).size,asset={tf15m:a,tf1h:a,tf4h:a};assert.ok(count>5);assert.equal(C.assessOverallHealth(asset,asset),'invalid')});
test('未收盘bar不进入正式异常计数',()=>{const a=bars(Array(20).fill(10));a.push(bar(20,1000,false));assert.equal(C.detectAnomalyBars(a).has(20),false);assert.equal(C.assessDataQuality(a,'15m',a.at(-1).closeTime).anomalyBarsExcluded,0)});
test('结构异常检查未被削弱',()=>{const invalid=bars(Array(20).fill(10));invalid[10].high=invalid[10].low-1;assert.equal(C.detectAnomalyBars(invalid).has(10),true);const gap=bars(Array(20).fill(10));gap[10].openTime+=MS;gap[10].closeTime+=MS;assert.equal(C.assessDataQuality(gap,'15m',gap.at(-1).closeTime).gapDetected,true);const duplicate=bars(Array(20).fill(10));duplicate[10].openTime=duplicate[9].openTime;duplicate[10].closeTime=duplicate[9].closeTime;assert.throws(()=>F.computeKlineWindowRef('BTCUSDT','15m',duplicate),/ORDERED/)});

console.log(`RESULT passed=${passed} failed=${failed}`);if(failed)process.exitCode=1;
