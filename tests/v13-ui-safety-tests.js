'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),P=require('../v1_3-paper-trading-core.js'),A=require('../v1_3-auto-engine-core.js'),X=require('./v13-fixtures.js');
const html=fs.readFileSync(path.join(__dirname,'../eth-dynamic-trading-dashboard.html'),'utf8');let passed=0,failed=0;function test(name,fn){try{fn();passed++;console.log('PASS '+name)}catch(e){failed++;console.error('FAIL '+name+': '+e.stack)}}
test('开启危险操作必须经过确认回调',()=>assert.match(html,/armAutoEngine\(localStorage,\(\)=>confirm\('确认开启自动模拟交易/));
test('关闭危险操作必须经过独立确认回调',()=>assert.match(html,/disarmAutoEngine\(localStorage,\(\)=>confirm\('确认关闭自动模拟交易/));
test('紧急平仓点击先确认再调用核心',()=>assert.match(html,/if\(!confirm\('确认按当前可验证行情执行紧急模拟平仓？'\)\)return;const r=P\.emergencyClosePosition/));
test('数据缺口结算使用不同确认文案和函数',()=>assert.match(html,/if\(!confirm\('确认执行数据缺口保守结算？该结果为估算且不计入已验证统计。'\)\)return;const r=P\.confirmDataGapConservativeSettlement/));
test('重置账户必须二次确认',()=>assert.match(html,/resetPaperAccount\(localStorage,\(\)=>confirm\('确认重置500 USDT模拟账户/));
test('用户拒绝开启时状态不改变',()=>{const x=X.account(P),r=A.armAutoEngine(x.s,()=>false,'ARM-DECLINE');assert.equal(r.pendingConfirmation,true);assert.equal(P.loadPaperAccount(x.s).engineState,'AUTO_PAPER_OFF')});
test('有未结束仓位时关闭前置拒绝且不弹确认',()=>{const x=X.account(P),d=X.decision();x.a.engineState='AUTO_PAPER_RUNNING';x.s.setItem(P.KEYS.account,JSON.stringify(x.a));P.autoEngineOpenPosition(X.signal(d),d,null,x.a,x.s);let called=0;const r=A.disarmAutoEngine(x.s,()=>{called++;return true},'OFF');assert.equal(r.ok,false);assert.equal(called,0);assert.match(r.reason,/当前存在模拟仓位/)});
test('暂停与禁止新开仓具有不同中文按钮语义',()=>{assert.match(html,/暂停引擎（继续保护已有仓位）/);assert.match(html,/禁止新开仓（引擎继续保护）/)});
test('暂停风险锁和数据阻断状态中文说明保护语义',()=>{assert.match(html,/自动模拟已暂停（继续保护已有仓位）/);assert.match(html,/风险锁定（禁止开仓加仓，继续保护已有仓位）/);assert.match(html,/数据阻断（仅处理可信收盘K线的仓位保护）/)});
test('页面明确不持续运行且不发送真实订单',()=>{assert.match(html,/页面关闭或电脑休眠时不会实时运行，也不会持续运行/);assert.match(html,/不发送真实订单/)});
test('模拟执行日志有中文事件映射',()=>{for(const text of ['UTC自然日已滚动','自动模拟开仓','用户紧急模拟平仓','数据缺口保守结算'])assert.match(html,new RegExp(text))});
console.log(`RESULT passed=${passed} failed=${failed}`);if(failed)process.exitCode=1;
