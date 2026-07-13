'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict'),h=fs.readFileSync(require('node:path').join(__dirname,'../eth-dynamic-trading-dashboard.html'),'utf8');let p=0,f=0;
function test(n,fn){try{fn();p++;console.log('PASS '+n)}catch(e){f++;console.error('FAIL '+n+': '+e.message)}}
test('单文件含三个可编译脚本',()=>{const s=[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x=>x[1]);assert.equal(s.length,3);s.forEach(x=>new Function(x))});
test('全部V1.1界面区域存在',()=>{for(const id of ['longPlan','shortPlan','longProgress','shortProgress','longScore','shortScore','tradeScore','positionMetrics','countdown','structureChart','riskBudget','exportJson','exportCsv','clearLogs'])assert.match(h,new RegExp(`id="${id}"`),id)});
test('预案免责声明可见',()=>assert.match(h,/尚未触发，不构成当前交易建议/));
test('现货REST元数据可见',()=>{for(const t of ['主数据源：Binance','市场类型：现货','ETHUSDT、BTCUSDT','刷新方式：REST','下一次预计刷新'])assert.ok(h.includes(t),t)});
test('新增枚举均有中文显示映射',()=>{for(const t of ["none:'暂未触发'","contracted:'成交量收缩'","neutral:'中性'","high:'高可信度'","low:'低可信度'"])assert.ok(h.includes(t),t)});
test('可见静态文本无新增英文枚举',()=>{const visible=h.replace(/<script>[\s\S]*?<\/script>/g,'').replace(/<style>[\s\S]*?<\/style>/g,'');for(const t of ['none','contracted','neutral','high · swing','low · swing'])assert.ok(!visible.includes(t),t)});
test('V1.1事件将决策传给增强界面',()=>assert.match(h,/CustomEvent\('v11decision'/));
test('原生Canvas且无外部图表依赖',()=>{assert.match(h,/<canvas id="structureChart"/);assert.ok(!/<script[^>]+src=/.test(h));assert.ok(!/WebSocket|new WebSocket/.test(h))});
test('清除日志绑定确认函数',()=>assert.match(h,/clearDecisionLogs\(localStorage,window\.confirm\)/));
console.log(`RESULT passed=${p} failed=${f}`);if(f)process.exitCode=1;
