'use strict';
// 专项测试：ethAlphaDecisionLogs（V1）与ethAlphaDecisionLogsV11（V1.1）localStorage容量保护。
// 覆盖：正常追加、数量上限裁剪、字节上限裁剪、QuotaExceededError重试成功/持续失败、单条超大日志、
// 损坏JSON安全降级、两个key均受保护、清理只删两个key、JSON/CSV导出、真实HTML安全保存路径与UI提示。
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const C=require('../v1-core.js');
let passed=0,failed=0;
function test(name,fn){try{fn();passed++;process.stdout.write(`PASS ${name}\n`);}catch(e){failed++;process.stderr.write(`FAIL ${name}: ${e.stack||e.message}\n`);}}

// 可配置的QuotaExceededError注入mock storage：failNextN次setItem调用失败，之后（若alwaysFail为false）恢复正常。
class MockStorage{
  constructor(initial={}){this.m={...initial};this.failNextN=0;this.alwaysFail=false;this.setItemCalls=0;this.writeError=null;this.readErrorKeys=new Set();}
  getItem(k){if(this.readErrorKeys.has(k))throw new Error('模拟localStorage读取失败');return Object.prototype.hasOwnProperty.call(this.m,k)?this.m[k]:null;}
  setItem(k,v){
    this.setItemCalls++;
    if(this.writeError)throw this.writeError;
    if(this.alwaysFail||this.failNextN>0){
      if(this.failNextN>0)this.failNextN--;
      const e=new Error('QuotaExceededError: 模拟存储空间不足');e.name='QuotaExceededError';throw e;
    }
    this.m[k]=String(v);
  }
  removeItem(k){delete this.m[k];}
}
function entry(id,extra=''){return{id:'D-'+id,timestamp:id,price:1000+id,state:'RANGE_CHOP',htfState:'HTF_RANGE',mtfState:'RANGE_CHOP',signalPermission:{},worthBetting:false,supportingEvidence:[],opposingEvidence:[],dataHealth:'normal',pad:extra};}
function bigEntry(id,bytes){return entry(id,'x'.repeat(bytes));}
// V1.1增强日志条目的完整字段形状（logsHtml()真实渲染所需），供预置ethAlphaDecisionLogsV11场景使用，
// 与C.buildEnhancedLogEntry()产出的真实结构对齐，而不是简化后的V1 entry()。
function v11Entry(id){return{id:'D-'+id,timestamp:id,source:'Binance',marketType:'现货',ethPrice:2000+id,btcPrice:60000,htfState:'HTF_RANGE',mtfState:'RANGE_CHOP',ltfState:'RANGE_CHOP',previousState:'RANGE_CHOP',newState:'RANGE_CHOP',changeReason:'测试固定治具',opportunityScores:{long:10,short:5},advice:'观察',supportingEvidence:[],opposingEvidence:[],longMissing:[],shortMissing:[]};}

// ===========================================================================
// 1. 正常追加日志
// ===========================================================================
test('1-正常追加日志：连续保存三条，数量与内容按追加顺序正确',()=>{
  const s=new MockStorage();
  const r1=C.saveDecisionLog(entry(1),s),r2=C.saveDecisionLog(entry(2),s),r3=C.saveDecisionLog(entry(3),s);
  assert.equal(r1.ok&&r2.ok&&r3.ok,true);
  const arr=JSON.parse(s.getItem('ethAlphaDecisionLogs'));
  assert.equal(arr.length,3);
  assert.deepEqual(arr.map(x=>x.id),['D-1','D-2','D-3']);
  assert.equal(r3.count,3);
});

// ===========================================================================
// 2. 超过数量上限后只删除最旧记录
// ===========================================================================
test('2-超过数量上限：只删除最旧记录，字节远未触顶',()=>{
  const s=new MockStorage();
  const seed=Array.from({length:C.DECISION_LOG_MAX_ENTRIES},(_,i)=>entry(i));
  s.setItem('ethAlphaDecisionLogs',JSON.stringify(seed));
  assert.ok(C.computeDecisionLogBytes(seed)<C.DECISION_LOG_MAX_BYTES,'前提确认：本场景字节数必须远低于上限，只测数量裁剪');
  const r=C.saveDecisionLog(entry(9999),s);
  assert.equal(r.ok,true);
  assert.equal(r.truncated,true);
  const arr=JSON.parse(s.getItem('ethAlphaDecisionLogs'));
  assert.equal(arr.length,C.DECISION_LOG_MAX_ENTRIES);
  assert.equal(arr[0].id,'D-1','最旧的D-0必须被删除，新的最旧记录应为D-1');
  assert.equal(arr.at(-1).id,'D-9999','最新记录必须保留');
});

// ===========================================================================
// 3. 超过字节上限后只删除最旧记录
// ===========================================================================
test('3-超过字节上限：只删除最旧记录，数量远未触顶',()=>{
  const s=new MockStorage();
  const chunk=Math.floor(C.DECISION_LOG_MAX_BYTES/3);
  const seed=[bigEntry(1,chunk),bigEntry(2,chunk)];
  assert.ok(seed.length<C.DECISION_LOG_MAX_ENTRIES,'前提确认：条数远低于数量上限，只测字节裁剪');
  s.setItem('ethAlphaDecisionLogs',JSON.stringify(seed));
  const r=C.saveDecisionLog(bigEntry(3,chunk),s);
  assert.equal(r.ok,true);
  assert.equal(r.truncated,true);
  const arr=JSON.parse(s.getItem('ethAlphaDecisionLogs'));
  assert.ok(C.computeDecisionLogBytes(arr)<=C.DECISION_LOG_MAX_BYTES,'裁剪后必须回到字节上限以内');
  assert.ok(!arr.some(x=>x.id==='D-1'),'最旧的D-1必须被删除');
  assert.equal(arr.at(-1).id,'D-3','最新记录必须保留');
});
test('3b-UTF-8多字节容量：按真实字节而非字符串length裁剪',()=>{
  const s=new MockStorage(),multi='龙'.repeat(180000),seed=[entry(1,multi),entry(2,multi)];
  assert.ok(JSON.stringify(seed).length<C.DECISION_LOG_MAX_BYTES,'UTF-16字符串length应仍低于1 MiB，确保能识别错误实现');
  assert.ok(C.computeDecisionLogBytes(seed)>JSON.stringify(seed).length,'中文UTF-8字节数必须大于字符串length');
  s.setItem('ethAlphaDecisionLogs',JSON.stringify(seed));
  const r=C.saveDecisionLog(entry(3,multi),s),arr=JSON.parse(s.getItem('ethAlphaDecisionLogs'));
  assert.equal(r.ok,true);
  assert.equal(r.truncated,true);
  assert.ok(C.computeDecisionLogBytes(arr)<=C.DECISION_LOG_MAX_BYTES);
  assert.equal(arr.at(-1).id,'D-3');
  assert.ok(!arr.some(x=>x.id==='D-1'),'必须从最旧记录开始裁剪');
});

// ===========================================================================
// 4. 模拟QuotaExceededError后裁剪并重试成功
// ===========================================================================
test('4-QuotaExceededError后裁剪重试成功：明确重试次数且最终写入更小的数组',()=>{
  const s=new MockStorage();
  const seed=Array.from({length:10},(_,i)=>entry(i));
  s.setItem('ethAlphaDecisionLogs',JSON.stringify(seed));
  s.setItemCalls=0;
  s.failNextN=3; // 前3次setItem失败，第4次（已裁掉3条最旧记录）成功
  const r=C.saveDecisionLog(entry(999),s);
  assert.equal(r.ok,true);
  assert.equal(r.truncated,true,'Quota重试成功时必须向页面报告发生了裁剪');
  assert.equal(s.setItemCalls,4,'必须恰好重试3次后第4次成功，验证重试确实发生');
  const arr=JSON.parse(s.getItem('ethAlphaDecisionLogs'));
  assert.equal(arr.length,11-3,'重试期间每次裁掉一条最旧记录');
  assert.equal(arr.at(-1).id,'D-999');
});

// ===========================================================================
// 5. 持续QuotaExceededError时安全失败且不抛出
// ===========================================================================
test('5-持续QuotaExceededError：不抛出异常，返回结构化失败，重试有明确上限，原有数据不变',()=>{
  const s=new MockStorage();
  const seed=Array.from({length:5},(_,i)=>entry(i));
  s.setItem('ethAlphaDecisionLogs',JSON.stringify(seed));
  const before=s.getItem('ethAlphaDecisionLogs');
  s.alwaysFail=true;
  s.setItemCalls=0;
  let r;
  assert.doesNotThrow(()=>{r=C.saveDecisionLog(entry(999),s);},'即使持续失败也绝不允许抛出异常');
  assert.equal(r.ok,false);
  assert.equal(r.reason,'QUOTA_EXCEEDED');
  assert.equal(r.count,5,'失败时必须报告仍然安全持久化的原有条数');
  assert.ok(s.setItemCalls<=C.DECISION_LOG_QUOTA_RETRY_LIMIT+1,'重试次数必须存在明确上限，不得无限循环');
  assert.equal(s.getItem('ethAlphaDecisionLogs'),before,'原有可恢复日志必须逐字节保持不变，不能先破坏旧数据');
});
test('5b-调用方请求超过20次重试时仍硬限制为最多20次重试',()=>{
  const s=new MockStorage(),seed=Array.from({length:30},(_,i)=>entry(i));
  s.setItem('ethAlphaDecisionLogs',JSON.stringify(seed));
  s.alwaysFail=true;s.setItemCalls=0;
  const r=C.saveBoundedDecisionLog(s,'ethAlphaDecisionLogs',entry(999),{maxRetries:999});
  assert.equal(r.reason,'QUOTA_EXCEEDED');
  assert.equal(s.setItemCalls,C.DECISION_LOG_QUOTA_RETRY_LIMIT+1,'首次写入加最多20次重试，总setItem调用应为21次');
});

// ===========================================================================
// 6. 单条超大日志无法保存时保留原有日志
// ===========================================================================
test('6-单条新日志自身超出字节上限：拒绝保存且不影响原有日志',()=>{
  const s=new MockStorage();
  const seed=[entry(1),entry(2)];
  s.setItem('ethAlphaDecisionLogs',JSON.stringify(seed));
  const before=s.getItem('ethAlphaDecisionLogs');
  const huge=bigEntry(999,C.DECISION_LOG_MAX_BYTES+1000);
  let r;
  assert.doesNotThrow(()=>{r=C.saveDecisionLog(huge,s);});
  assert.equal(r.ok,false);
  assert.equal(r.reason,'ENTRY_TOO_LARGE');
  assert.equal(r.count,2);
  assert.equal(s.getItem('ethAlphaDecisionLogs'),before,'原有日志必须逐字节保持不变');
});
test('6b-非容量写入异常返回WRITE_FAILED且旧数据与其他key不变',()=>{
  const s=new MockStorage({ethAlphaDecisionLogs:JSON.stringify([entry(1)]),unrelated:'keep'}),before=s.getItem('ethAlphaDecisionLogs');
  s.writeError=Object.assign(new Error('SecurityError: storage denied'),{name:'SecurityError'});
  let r;assert.doesNotThrow(()=>{r=C.saveDecisionLog(entry(2),s);});
  assert.equal(r.reason,'WRITE_FAILED');
  assert.equal(s.getItem('ethAlphaDecisionLogs'),before);
  assert.equal(s.getItem('unrelated'),'keep');
});
test('6c-序列化异常返回WRITE_FAILED而不崩溃或覆盖旧数据',()=>{
  const s=new MockStorage({ethAlphaDecisionLogs:JSON.stringify([entry(1)])}),before=s.getItem('ethAlphaDecisionLogs'),circular=entry(2);
  circular.self=circular;
  let r;assert.doesNotThrow(()=>{r=C.saveDecisionLog(circular,s);});
  assert.equal(r.reason,'WRITE_FAILED');
  assert.equal(s.getItem('ethAlphaDecisionLogs'),before);
});
test('6d-localStorage读取异常返回WRITE_FAILED，禁止把未知旧数据当作损坏JSON覆盖',()=>{
  const s=new MockStorage({ethAlphaDecisionLogs:JSON.stringify([entry(1)])});
  s.readErrorKeys.add('ethAlphaDecisionLogs');
  let r;assert.doesNotThrow(()=>{r=C.saveDecisionLog(entry(2),s);});
  assert.equal(r.reason,'WRITE_FAILED');
  assert.equal(s.setItemCalls,0,'读取失败后不得尝试任何写入');
});

// ===========================================================================
// 7. 损坏JSON输入不会导致崩溃
// ===========================================================================
test('7-损坏JSON安全降级：不抛出、不崩溃、安全重置为仅含新记录的合法数组，不影响其他key',()=>{
  const s=new MockStorage({ethAlphaDecisionLogs:'{this is not valid json[[[',ethAlphaRiskSettings:'{"capital":10000}'});
  let r;
  assert.doesNotThrow(()=>{r=C.saveDecisionLog(entry(1),s);});
  assert.equal(r.ok,true);
  assert.equal(r.corrupted,true);
  const arr=JSON.parse(s.getItem('ethAlphaDecisionLogs'));
  assert.deepEqual(arr.map(x=>x.id),['D-1']);
  assert.equal(s.getItem('ethAlphaRiskSettings'),'{"capital":10000}','损坏恢复不得影响其他key');
});
test('7b-非数组JSON（对象而非数组）同样安全降级',()=>{
  const s=new MockStorage({ethAlphaDecisionLogsV11:'{"not":"an array"}'});
  let r;
  assert.doesNotThrow(()=>{r=C.saveBoundedDecisionLog(s,'ethAlphaDecisionLogsV11',entry(1));});
  assert.equal(r.ok,true);
  assert.equal(r.corrupted,true);
  assert.deepEqual(JSON.parse(s.getItem('ethAlphaDecisionLogsV11')).map(x=>x.id),['D-1']);
});

// ===========================================================================
// 8. ethAlphaDecisionLogs与ethAlphaDecisionLogsV11均受保护
// ===========================================================================
test('8a-ethAlphaDecisionLogs（V1）数量上限保护',()=>{
  const s=new MockStorage();
  s.setItem('ethAlphaDecisionLogs',JSON.stringify(Array.from({length:C.DECISION_LOG_MAX_ENTRIES},(_,i)=>entry(i))));
  const r=C.saveDecisionLog(entry(9999),s);
  assert.equal(r.ok,true);
  assert.equal(JSON.parse(s.getItem('ethAlphaDecisionLogs')).length,C.DECISION_LOG_MAX_ENTRIES);
});
test('8b-ethAlphaDecisionLogsV11（V1.1）同样受数量上限保护，且是独立的key',()=>{
  const s=new MockStorage();
  s.setItem('ethAlphaDecisionLogsV11',JSON.stringify(Array.from({length:C.DECISION_LOG_MAX_ENTRIES},(_,i)=>entry(i))));
  const r=C.saveBoundedDecisionLog(s,'ethAlphaDecisionLogsV11',entry(9999));
  assert.equal(r.ok,true);
  const arr=JSON.parse(s.getItem('ethAlphaDecisionLogsV11'));
  assert.equal(arr.length,C.DECISION_LOG_MAX_ENTRIES);
  assert.equal(arr.at(-1).id,'D-9999');
  assert.equal(s.getItem('ethAlphaDecisionLogs'),null,'两个key必须互不干扰');
});
test('8c-ethAlphaDecisionLogsV11同样受字节上限保护并对QuotaExceededError重试',()=>{
  const s=new MockStorage();
  const chunk=Math.floor(C.DECISION_LOG_MAX_BYTES/3);
  s.setItem('ethAlphaDecisionLogsV11',JSON.stringify([bigEntry(1,chunk),bigEntry(2,chunk)]));
  s.failNextN=1;
  const r=C.saveBoundedDecisionLog(s,'ethAlphaDecisionLogsV11',bigEntry(3,chunk));
  assert.equal(r.ok,true);
  const arr=JSON.parse(s.getItem('ethAlphaDecisionLogsV11'));
  assert.ok(C.computeDecisionLogBytes(arr)<=C.DECISION_LOG_MAX_BYTES);
});

// ===========================================================================
// 9. 清理时只删除两个决策日志key，其他设置逐字节保持不变
// ===========================================================================
test('9-清除日志只删除两个决策日志key，风险设置/模拟账户/持仓/GMKG等其他key逐字节不变',()=>{
  const others={
    ethAlphaRiskSettings:JSON.stringify({capital:10000,maxRiskPct:.01}),
    ethAlphaPaperAccount:JSON.stringify({equity:500,positions:[{symbol:'ETHUSDT',qty:1}]}),
    ethAlphaSignalArchive:JSON.stringify([{id:'SIG-1'}]),
    ethAlphaGmkgSnapshots:JSON.stringify([{predictionId:'GMKG-SRV-1'}]),
    someUnrelatedAppKey:'untouched-value'
  };
  const s=new MockStorage({
    ethAlphaDecisionLogs:JSON.stringify([entry(1)]),
    ethAlphaDecisionLogsV11:JSON.stringify([entry(1)]),
    ...others
  });
  const ok=C.clearDecisionLogs(s,()=>true);
  assert.equal(ok,true);
  assert.equal(s.getItem('ethAlphaDecisionLogs'),null);
  assert.equal(s.getItem('ethAlphaDecisionLogsV11'),null);
  for(const [k,v] of Object.entries(others))assert.equal(s.getItem(k),v,`${k}必须逐字节保持不变`);
});
test('9b-未确认时清除日志不删除任何内容',()=>{
  const s=new MockStorage({ethAlphaDecisionLogs:'[1]',ethAlphaDecisionLogsV11:'[2]'});
  assert.equal(C.clearDecisionLogs(s,()=>false),false);
  assert.equal(s.getItem('ethAlphaDecisionLogs'),'[1]');
  assert.equal(s.getItem('ethAlphaDecisionLogsV11'),'[2]');
});

// ===========================================================================
// 10. JSON与CSV导出仍通过
// ===========================================================================
test('10a-JSON导出保留完整字段且可被重新解析',()=>{
  const logs=[entry(1),entry(2)];
  const json=C.exportLogsJSON(logs);
  const parsed=JSON.parse(json);
  assert.equal(parsed.length,2);
  assert.equal(parsed[0].id,'D-1');
});
test('10b-CSV导出包含表头与数据行',()=>{
  const logs=[{...entry(1),source:'Binance',marketType:'现货',ethPrice:2000,btcPrice:60000,advice:'观察',invalidation:1900,targets:[2100],supportingEvidence:['ok'],opposingEvidence:[]}];
  const csv=C.exportLogsCSV(logs);
  assert.match(csv,/^timestamp,source,marketType/);
  assert.match(csv,/Binance/);
  assert.match(csv,/现货/);
});

// ===========================================================================
// 11. 实际HTML调用安全保存路径，并显示数量/警告
// ===========================================================================
function fakeDomForStorageTests(mockStorage){
  const html=fs.readFileSync(path.join(__dirname,'../eth-dynamic-trading-dashboard.html'),'utf8');
  const ids=[...html.matchAll(/id="([^"]+)"/g)].map(x=>x[1]);
  const listeners={};
  class El{constructor(id){this.id=id;this.textContent='';this.innerHTML='';this.className='';this.value='';this.width=900;this.height=390;this.classList={add:x=>{if(!this.className.includes(x))this.className+=' '+x},remove:x=>{this.className=this.className.split(/\s+/).filter(y=>y&&y!==x).join(' ')},toggle:x=>this.classList.add(x)};}click(){this.onclick?.()}getContext(){return{clearRect(){},fillRect(){},fillText(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},setLineDash(){},set fillStyle(v){},set strokeStyle(v){},set lineWidth(v){}}}}
  const nodes=Object.fromEntries(ids.map(id=>[id,new El(id)]));
  const document={getElementById:id=>nodes[id],querySelectorAll:s=>s==='.invalidated'?Object.values(nodes).filter(n=>n.className.includes('invalidated')):[],addEventListener:(n,f)=>(listeners[n]||(listeners[n]=[])).push(f),dispatchEvent:e=>(listeners[e.type]||[]).forEach(f=>f(e)),createElement:()=>new El('a'),visibilityState:'visible'};
  const window={confirm:()=>true};
  const ctx={window,document,localStorage:mockStorage,console,alert(){},setInterval(){},setTimeout(){},clearTimeout(){},CustomEvent:function(type,o){this.type=type;this.detail=o?.detail},Blob:function(){},URL:{createObjectURL:()=>'',revokeObjectURL(){}},Date,Math,JSON,Number,Object,Array,String,RegExp,Promise};
  window.window=window;window.document=document;window.localStorage=mockStorage;window.ETHAlphaCore=C;window.confirm=()=>true;
  C.fetchAllTimeframeKlines=()=>new Promise(()=>{});
  const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x=>x[1]);
  vm.runInNewContext(scripts[1],ctx);
  vm.runInNewContext(scripts[2],ctx);
  return{nodes,window};
}
test('11a-真实页面调用安全保存路径并显示保存数量',()=>{
  const s=new MockStorage();
  const d=fakeDomForStorageTests(s);
  const success={...C.buildDecision({tf15m:[],tf1h:[],tf4h:[]},{tf15m:[],tf1h:[],tf4h:[]},{ethPrice:3000,btcPrice:60000,recentHigh:3100,recentLow:2900,high20:3200,low20:2800}),isManual:false,dataHealth:'normal',updatedAt:Date.now()};
  d.window.renderDashboard(success);
  assert.match(d.nodes.decisionLogStatus.textContent,/V1：已保存 1 条/);
  assert.match(d.nodes.decisionLogStatus.textContent,/V1\.1：已保存 1 条/);
  assert.equal(JSON.parse(s.getItem('ethAlphaDecisionLogs')).length,1);
  assert.equal(JSON.parse(s.getItem('ethAlphaDecisionLogsV11')).length,1);
});
test('11b-真实页面在持续QuotaExceededError下显示存储空间不足提示且不抛出',()=>{
  const s=new MockStorage();
  s.alwaysFail=true;
  const d=fakeDomForStorageTests(s);
  const success={...C.buildDecision({tf15m:[],tf1h:[],tf4h:[]},{tf15m:[],tf1h:[],tf4h:[]},{ethPrice:3000,btcPrice:60000,recentHigh:3100,recentLow:2900,high20:3200,low20:2800}),isManual:false,dataHealth:'normal',updatedAt:Date.now()};
  assert.doesNotThrow(()=>d.window.renderDashboard(success));
  assert.match(d.nodes.decisionLogStatus.textContent,/存储空间不足，保存失败/);
});
test('11c-清除日志按钮只清两个决策日志key并刷新状态显示',()=>{
  const s=new MockStorage({ethAlphaRiskSettings:'{"capital":10000}'});
  const d=fakeDomForStorageTests(s);
  const success={...C.buildDecision({tf15m:[],tf1h:[],tf4h:[]},{tf15m:[],tf1h:[],tf4h:[]},{ethPrice:3000,btcPrice:60000,recentHigh:3100,recentLow:2900,high20:3200,low20:2800}),isManual:false,dataHealth:'normal',updatedAt:Date.now()};
  d.window.renderDashboard(success);
  d.nodes.clearLogs.click();
  assert.equal(s.getItem('ethAlphaDecisionLogs'),null);
  assert.equal(s.getItem('ethAlphaDecisionLogsV11'),null);
  assert.equal(s.getItem('ethAlphaRiskSettings'),'{"capital":10000}');
  assert.match(d.nodes.decisionLogStatus.textContent,/暂无记录/);
});

// ===========================================================================
// 12. 页面初始化回归：本次会话尚未发生任何保存时，
//    状态栏必须直接读取localStorage中两个key已有的真实合法数组长度，而不是一直显示
//    "暂无记录"直到下一次保存发生。
// ===========================================================================
test('12a-页面初始化前预置两个日志key：未调用renderDashboard，状态栏直接显示真实数量',()=>{
  const s=new MockStorage({
    ethAlphaDecisionLogs:JSON.stringify([entry(1),entry(2),entry(3)]),
    ethAlphaDecisionLogsV11:JSON.stringify([v11Entry(1),v11Entry(2),v11Entry(3),v11Entry(4),v11Entry(5)])
  });
  const before={v1:s.getItem('ethAlphaDecisionLogs'),v11:s.getItem('ethAlphaDecisionLogsV11')};
  const d=fakeDomForStorageTests(s); // 仅初始化，不调用d.window.renderDashboard(...)
  assert.match(d.nodes.decisionLogStatus.textContent,/V1：已保存 3 条/,'必须直接反映localStorage中已有的V1日志真实条数');
  assert.match(d.nodes.decisionLogStatus.textContent,/V1\.1：已保存 5 条/,'必须直接反映localStorage中已有的V1.1日志真实条数');
  assert.equal(s.getItem('ethAlphaDecisionLogs'),before.v1,'初始化过程只读，不得修改任何localStorage内容');
  assert.equal(s.getItem('ethAlphaDecisionLogsV11'),before.v11,'初始化过程只读，不得修改任何localStorage内容');
});
test('12b-没有任何日志时初始化应显示暂无记录而非报错',()=>{
  const s=new MockStorage();
  const d=fakeDomForStorageTests(s);
  assert.match(d.nodes.decisionLogStatus.textContent,/V1：暂无记录/);
  assert.match(d.nodes.decisionLogStatus.textContent,/V1\.1：暂无记录/);
});
test('12c-一个key损坏、另一个正常时初始化不崩溃：正常key显示真实数量，损坏key显示安全状态',()=>{
  const s=new MockStorage({
    ethAlphaDecisionLogs:'{this is not valid json[[[',
    ethAlphaDecisionLogsV11:JSON.stringify([v11Entry(1),v11Entry(2),v11Entry(3),v11Entry(4)])
  });
  let d;
  assert.doesNotThrow(()=>{d=fakeDomForStorageTests(s);},'损坏的日志key不得导致页面初始化崩溃');
  assert.match(d.nodes.decisionLogStatus.textContent,/V1：⚠ 历史记录读取异常/,'损坏的V1必须显示安全状态提示，而不是抛错或显示错误数量');
  assert.match(d.nodes.decisionLogStatus.textContent,/V1\.1：已保存 4 条/,'未损坏的V1.1必须继续显示真实数量');
  assert.equal(s.getItem('ethAlphaDecisionLogs'),'{this is not valid json[[[','只读展示不得改写或清除损坏的原始内容');
  assert.equal(JSON.parse(s.getItem('ethAlphaDecisionLogsV11')).length,4,'正常key的内容不得被初始化过程改变');
});
test('12d-可解析但非数组JSON不会让showLogs/loadLogs崩溃，另一键仍正常显示且原值不变',()=>{
  const originalV1='{"validJson":"not-array"}',originalV11='42';
  const s=new MockStorage({ethAlphaDecisionLogs:originalV1,ethAlphaDecisionLogsV11:originalV11});
  let d;assert.doesNotThrow(()=>{d=fakeDomForStorageTests(s);});
  assert.match(d.nodes.decisionLogStatus.textContent,/V1：⚠ 历史记录读取异常/);
  assert.match(d.nodes.decisionLogStatus.textContent,/V1\.1：⚠ 历史记录读取异常/);
  assert.equal(d.nodes.logs.innerHTML,'暂无记录','展示路径必须安全降级为空列表');
  assert.equal(s.getItem('ethAlphaDecisionLogs'),originalV1);
  assert.equal(s.getItem('ethAlphaDecisionLogsV11'),originalV11);
});
test('12e-初始化后发生一次真实保存，状态栏从"真实历史数量"正确过渡到"本次保存结果"',()=>{
  const s=new MockStorage({
    ethAlphaDecisionLogs:JSON.stringify([entry(1),entry(2)]),
    ethAlphaDecisionLogsV11:JSON.stringify([v11Entry(1),v11Entry(2)])
  });
  const d=fakeDomForStorageTests(s);
  assert.match(d.nodes.decisionLogStatus.textContent,/V1：已保存 2 条/);
  const success={...C.buildDecision({tf15m:[],tf1h:[],tf4h:[]},{tf15m:[],tf1h:[],tf4h:[]},{ethPrice:3000,btcPrice:60000,recentHigh:3100,recentLow:2900,high20:3200,low20:2800}),isManual:false,dataHealth:'normal',updatedAt:Date.now()};
  d.window.renderDashboard(success);
  assert.match(d.nodes.decisionLogStatus.textContent,/V1：已保存 3 条/,'保存后必须反映本次保存后的真实条数');
});
test('12f-真实页面显示数量裁剪、ENTRY_TOO_LARGE与WRITE_FAILED提示',()=>{
  const makeDecision=()=>({...C.buildDecision({tf15m:[],tf1h:[],tf4h:[]},{tf15m:[],tf1h:[],tf4h:[]},{ethPrice:3000,btcPrice:60000,recentHigh:3100,recentLow:2900,high20:3200,low20:2800}),isManual:false,dataHealth:'normal',updatedAt:Date.now()});
  const full=new MockStorage({ethAlphaDecisionLogs:JSON.stringify(Array.from({length:500},(_,i)=>entry(i))),ethAlphaDecisionLogsV11:JSON.stringify(Array.from({length:500},(_,i)=>v11Entry(i)))}),page=fakeDomForStorageTests(full);
  page.window.renderDashboard(makeDecision());
  assert.match(page.nodes.decisionLogStatus.textContent,/已按容量上限裁剪最旧记录/);

  const tooLarge=new MockStorage(),largePage=fakeDomForStorageTests(tooLarge),pageCore=largePage.window.ETHAlphaCore,
        originalBuild=pageCore.buildDecisionLogEntry,originalEnhanced=pageCore.buildEnhancedLogEntry;
  try{
    pageCore.buildDecisionLogEntry=()=>bigEntry(900,C.DECISION_LOG_MAX_BYTES+1000);
    pageCore.buildEnhancedLogEntry=()=>({...v11Entry(900),pad:'龙'.repeat(C.DECISION_LOG_MAX_BYTES)});
    largePage.window.renderDashboard(makeDecision());
    assert.match(largePage.nodes.decisionLogStatus.textContent,/单条记录过大，无法保存/);
  }finally{pageCore.buildDecisionLogEntry=originalBuild;pageCore.buildEnhancedLogEntry=originalEnhanced;}

  const failed=new MockStorage(),failedPage=fakeDomForStorageTests(failed);
  failed.writeError=Object.assign(new Error('denied'),{name:'SecurityError'});
  failedPage.window.renderDashboard(makeDecision());
  assert.match(failedPage.nodes.decisionLogStatus.textContent,/保存失败/);
});

process.on('beforeExit',()=>{process.stdout.write(`\nRESULT passed=${passed} failed=${failed}\n`);if(failed)process.exitCode=1;});
