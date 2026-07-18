'use strict';
const assert=require('node:assert/strict'),S=require('../v1_4-storage-core.js'),C=require('../v1-core.js'),F=require('../v1_4-gmkg-forecast-core.js');
let passed=0,failed=0;
function test(name,fn){return Promise.resolve().then(fn).then(()=>{passed++;console.log('PASS '+name)},e=>{failed++;console.error('FAIL '+name+': '+e.stack)})}
class Storage{constructor(seed={},quota=Infinity){this.m=new Map(Object.entries(seed));this.quota=quota}get length(){return this.m.size}key(i){return[...this.m.keys()][i]??null}getItem(k){return this.m.has(k)?this.m.get(k):null}setItem(k,v){v=String(v);const copy=new Map(this.m);copy.set(k,v);const size=[...copy].reduce((n,[a,b])=>n+a.length+b.length,0);if(size>this.quota){const e=Error('quota');e.name='QuotaExceededError';throw e}this.m=copy}removeItem(k){this.m.delete(k)}}
const signal=(id,overrides={})=>({schemaVersion:'v1.3-signal-3',algorithmVersion:'v1.3-draft-4-final',signalId:id,signalFingerprint:id+'-fp',symbol:'ETHUSDT',direction:'long',archiveCategory:'WATCHLIST',archiveReasons:[],eligibleForTrigger:true,permissionAtCreation:true,worthBettingAtCreation:true,hardBlockedAtCreation:false,signalPermissionLevelAtCreation:'trend_entry_allowed',opportunityBlockedAtCreation:false,generatedAt:1784359800000,sourceConfirmedBarTime:1784358900000,dataAsOf:1784359800000,validUntil:1784374200000,lifecycleStatus:'RECORDED',userActionStatus:'UNSEEN',entryZone:{lower:1841,upper:1843,estimatedEntry:1842,valid:true,source:'structured_values'},stopLoss:1835,targets:[1855,1865,1875],grossRiskReward:1.8,netRiskReward:1.5,btcAlignment:'support',scoreSnapshot:{},decisionSnapshot:{},forecastSnapshot:null,feeAssumption:0,slippageAssumption:.0003,marketSnapshot:{},linkedPaperTradeId:null,...overrides});
const snapshot=(id,payload='x'.repeat(6000))=>({schemaVersion:'v1.4-forecastsnapshot-1',predictionId:id,instrument:'ETH',horizon:id.includes('72')?'72h':'24h',generatedAt:Number(id.replace(/\D/g,''))||1,algorithmVersion:'a',weightVersion:'w',datasetVersion:'d',payload});
function repo(storage=new Storage(),adapter=new S.MemoryAdapter(),extra={}){return S.createRepository({localStorage:storage,adapter,navigatorStorage:{estimate:async()=>({usage:0,quota:10_000_000})},entryZoneNormalizer:C.normalizeEntryZone,...extra})}
const REAL_CONFLICT_ID='SIG-1784359800000-ranging-raft4final';

// ---- 最小可用的假IndexedDB：用于直接练习 BrowserIndexedDbAdapter 真实浏览器代码路径（而不是MemoryAdapter模拟） ----
// 真实IndexedDB事务语义：同一事务内的写入对该事务自身的后续读取立即可见（read-your-own-writes），
// 但只有在事务成功提交（oncomplete）时才合并进底层存储；一旦abort，事务内全部写入必须被丢弃、不落地。
const TOMBSTONE=Symbol('deleted');
class FakeRequest{constructor(){this.onsuccess=null;this.onerror=null;this.result=undefined;this.error=undefined}_succeed(result){this.result=result;queueMicrotask(()=>{if(this.onsuccess)this.onsuccess({target:this})})}_fail(error){this.error=error;queueMicrotask(()=>{if(this.onerror)this.onerror({target:this})})}}
class FakeObjectStore{
  constructor(baseMap,tx,storeName){this.baseMap=baseMap;this.tx=tx;this.storeName=storeName}
  _overlay(){if(!this.tx._overlays.has(this.storeName))this.tx._overlays.set(this.storeName,new Map());return this.tx._overlays.get(this.storeName)}
  _op(fn){const req=new FakeRequest();this.tx._track();queueMicrotask(()=>{try{const result=fn();req._succeed(result)}catch(e){req._fail(e)}this.tx._untrack()});return req}
  get(key){return this._op(()=>{const ov=this._overlay(),k=String(key);if(ov.has(k)){const v=ov.get(k);return v===TOMBSTONE?undefined:v}return this.baseMap.get(k)})}
  getAll(){return this._op(()=>{const ov=this._overlay(),merged=new Map(this.baseMap);for(const[k,v]of ov)if(v===TOMBSTONE)merged.delete(k);else merged.set(k,v);return[...merged.values()]})}
  put(value){return this._op(()=>{this._overlay().set(String(value._storageId),value);return value._storageId})}
  delete(key){return this._op(()=>{this._overlay().set(String(key),TOMBSTONE);return undefined})}
}
class FakeTransaction{
  constructor(db,storeNames){this.db=db;this.storeNames=storeNames;this.oncomplete=null;this.onabort=null;this.onerror=null;this._aborted=false;this._pending=0;this._done=false;this._scheduled=false;this._overlays=new Map();this._scheduleCheck()}
  objectStore(name){if(!this.storeNames.includes(name))throw Error('NotFoundError: store not in transaction scope: '+name);if(!this.db.stores.has(name))throw Error('NotFoundError: no such store: '+name);return new FakeObjectStore(this.db.stores.get(name),this,name)}
  abort(){if(this._done||this._aborted)return;this._aborted=true;this._pending=0;this._overlays.clear();queueMicrotask(()=>{if(this.onabort)this.onabort({target:this})})}
  _track(){this._pending++}
  _untrack(){this._pending--;this._scheduleCheck()}
  _scheduleCheck(){if(this._scheduled||this._done||this._aborted)return;this._scheduled=true;
    // 连续多轮微任务排空，给"get后紧接着await再put"这类链式调用足够的时间在事务判定为完成前完整发生。
    Promise.resolve().then(()=>Promise.resolve()).then(()=>Promise.resolve()).then(()=>Promise.resolve()).then(()=>{this._scheduled=false;this._maybeComplete()});
  }
  _maybeComplete(){
    if(this._done||this._aborted)return;
    if(this._pending===0){
      this._done=true;
      for(const[storeName,overlay]of this._overlays){const base=this.db.stores.get(storeName);for(const[k,v]of overlay)if(v===TOMBSTONE)base.delete(k);else base.set(k,v)}
      if(this.oncomplete)this.oncomplete({target:this});
    }else this._scheduleCheck();
  }
}
class FakeIDBDatabase{constructor(name,version){this.name=name;this.version=version;this.stores=new Map();this.objectStoreNames={contains:n=>this.stores.has(n)}}createObjectStore(name){this.stores.set(name,new Map());return{}}transaction(names,mode){const list=Array.isArray(names)?names:[names];return new FakeTransaction(this,list)}}
class FakeIndexedDB{
  constructor(){this.databases=new Map()}
  open(name,version){
    const req=new FakeRequest();
    queueMicrotask(()=>{
      const existing=this.databases.get(name),oldVersion=existing?existing.version:0,db=new FakeIDBDatabase(name,version);
      if(existing)for(const[storeName,recordsMap]of existing.stores)db.stores.set(storeName,new Map(recordsMap));
      req.result=db;
      if(version>oldVersion&&req.onupgradeneeded)req.onupgradeneeded({target:req,oldVersion,newVersion:version});
      this.databases.set(name,{version,stores:db.stores});
      req._succeed(db);
    });
    return req;
  }
}
(async()=>{

// ===== 1. 精确复现真实冲突ID：字段形状差异应canonical等价去重；业务字段差异应保留为冲突记录 =====
await test('T1 精确ID：仅entryZone形状不同（旧展示字符串 vs 新结构化对象）视为等价并安全去重',async()=>{
  const r=repo();await r.open();
  const inIndexedDb=signal(REAL_CONFLICT_ID,{entryZone:{lower:1841,upper:1843,estimatedEntry:1842,valid:true,source:'structured_values'}});
  await r.putImmutable('signalArchive',inIndexedDb);
  const inLocalStorage=signal(REAL_CONFLICT_ID,{entryZone:'1,841.00 – 1,843.00'});
  const x=await r.putImmutable('signalArchive',inLocalStorage);
  assert.equal(x.ok,true);assert.equal(x.conflict,false,'entryZone形状差异应被规范化为等价，不应产生冲突记录');
  assert.equal((await r.getConflicts('signalArchive')).length,0);
  assert.equal((await r.get('signalArchive',REAL_CONFLICT_ID)).archiveCategory,'WATCHLIST');
});
await test('T1b 精确ID：archiveCategory真实不同（业务内容差异）必须保留双方且不覆盖',async()=>{
  const r=repo();await r.open();
  const inIndexedDb=signal(REAL_CONFLICT_ID,{archiveCategory:'WATCHLIST',eligibleForTrigger:true});
  await r.putImmutable('signalArchive',inIndexedDb);
  const inLocalStorage=signal(REAL_CONFLICT_ID,{archiveCategory:'OBSERVATION',eligibleForTrigger:false,hardBlockedAtCreation:true});
  const x=await r.putImmutable('signalArchive',inLocalStorage);
  assert.equal(x.ok,true);assert.equal(x.conflict,true);assert.ok(x.conflictId.startsWith(REAL_CONFLICT_ID+'__conflict__'));
  const formal=await r.get('signalArchive',REAL_CONFLICT_ID);
  assert.equal(formal.archiveCategory,'WATCHLIST','正式存储记录不得被覆盖');
  const conflicts=await r.getConflicts('signalArchive');
  assert.equal(conflicts.length,1);
  assert.equal(conflicts[0].originalId,REAL_CONFLICT_ID);
  assert.equal(conflicts[0].record.archiveCategory,'OBSERVATION','冲突记录保留了完整的落败内容');
});

// ===== 2-10. 逐字段场景 =====
await test('T2 相同ID完全相同内容：幂等去重不产生冲突',async()=>{const r=repo();await r.open();await r.putImmutable('signalArchive',signal('SIG-A'));const x=await r.putImmutable('signalArchive',signal('SIG-A'));assert.equal(x.deduped,true);assert.equal(x.conflict,false);assert.equal((await r.getConflicts()).length,0)});
await test('T3 相同ID仅字段顺序不同：canonical序列化后等价，安全去重',async()=>{
  const r=repo();await r.open();
  const a=signal('SIG-B');const bKeysReversed=Object.fromEntries(Object.entries(a).reverse());
  await r.putImmutable('signalArchive',a);
  const x=await r.putImmutable('signalArchive',bKeysReversed);
  assert.equal(x.conflict,false);assert.equal(x.deduped,true);
});
await test('T4 相同ID仅白名单默认字段不同（快照generatedAt缺省为0→实际值）：canonical等价去重',async()=>{
  const r=repo();await r.open();
  const a={...snapshot('P-DEFAULT'),generatedAt:0};
  await r.putImmutable('snapshots',a);
  const b={...snapshot('P-DEFAULT'),generatedAt:1700000005000};
  const x=await r.putImmutable('snapshots',b);
  assert.equal(x.conflict,false,'generatedAt在白名单内，不构成冲突');
});
await test('T5 相同ID仅generatedAt不同（业务内容一致）：canonical等价去重',async()=>{
  const r=repo();await r.open();
  await r.putImmutable('snapshots',{...snapshot('P-GEN'),generatedAt:1700000000000,dataCutoffTime:1700000000000});
  const x=await r.putImmutable('snapshots',{...snapshot('P-GEN'),generatedAt:1700000009999,dataCutoffTime:1700000009999});
  assert.equal(x.conflict,false);assert.equal(x.deduped,true);
});
await test('T6 相同ID价格不同：真实冲突，双方保留',async()=>{const r=repo();await r.open();await r.putImmutable('signalArchive',signal('SIG-PRICE',{entryZone:{lower:1841,upper:1843,estimatedEntry:1842,valid:true,source:'structured_values'}}));const x=await r.putImmutable('signalArchive',signal('SIG-PRICE',{entryZone:{lower:1901,upper:1903,estimatedEntry:1902,valid:true,source:'structured_values'}}));assert.equal(x.conflict,true);assert.equal((await r.get('signalArchive','SIG-PRICE')).entryZone.lower,1841);assert.equal((await r.getConflicts('signalArchive'))[0].record.entryZone.lower,1901)});
await test('T7 相同ID方向不同：真实冲突，双方保留',async()=>{const r=repo();await r.open();await r.putImmutable('signalArchive',signal('SIG-DIR',{direction:'long'}));const x=await r.putImmutable('signalArchive',signal('SIG-DIR',{direction:'short'}));assert.equal(x.conflict,true);assert.equal((await r.get('signalArchive','SIG-DIR')).direction,'long');assert.equal((await r.getConflicts('signalArchive'))[0].record.direction,'short')});
await test('T8 相同ID许可不同（archiveCategory/eligibleForTrigger）：真实冲突',async()=>{const r=repo();await r.open();await r.putImmutable('signalArchive',signal('SIG-PERM',{archiveCategory:'EXECUTABLE',eligibleForTrigger:true}));const x=await r.putImmutable('signalArchive',signal('SIG-PERM',{archiveCategory:'OBSERVATION',eligibleForTrigger:false}));assert.equal(x.conflict,true);assert.equal((await r.get('signalArchive','SIG-PERM')).archiveCategory,'EXECUTABLE')});
await test('T9 相同ID算法版本不同：真实冲突',async()=>{const r=repo();await r.open();await r.putImmutable('snapshots',{...snapshot('P-ALGO'),algorithmVersion:'v1.4-gmkg-loop-draft-1'});const x=await r.putImmutable('snapshots',{...snapshot('P-ALGO'),algorithmVersion:'v1.4-gmkg-loop-draft-2'});assert.equal(x.conflict,true)});
await test('T10 相同ID权重版本不同：真实冲突',async()=>{const r=repo();await r.open();await r.putImmutable('snapshots',{...snapshot('P-WEIGHT'),weightVersion:'w1'});const x=await r.putImmutable('snapshots',{...snapshot('P-WEIGHT'),weightVersion:'w2'});assert.equal(x.conflict,true)});

// ===== 11. 两份真实业务内容都被保留 =====
await test('T11 两份冲突内容都可分别读取，无数据丢失',async()=>{
  const r=repo();await r.open();
  await r.putImmutable('signalArchive',signal('SIG-BOTH',{direction:'long'}));
  const c=await r.putImmutable('signalArchive',signal('SIG-BOTH',{direction:'short'}));
  const formal=await r.get('signalArchive','SIG-BOTH'),conflicts=await r.getConflicts('signalArchive');
  assert.equal(formal.direction,'long');
  assert.equal(conflicts.length,1);assert.equal(conflicts[0].record.direction,'short');
  assert.equal(conflicts[0].originalId,'SIG-BOTH');
});

// ===== 12-13. 确定性与幂等 =====
await test('T12 冲突迁移ID确定性：相同原始ID+相同内容重复产生同一conflictId',async()=>{
  const r1=repo();await r1.open();await r1.putImmutable('signalArchive',signal('SIG-DET',{direction:'long'}));const c1=await r1.putImmutable('signalArchive',signal('SIG-DET',{direction:'short'}));
  const r2=repo();await r2.open();await r2.putImmutable('signalArchive',signal('SIG-DET',{direction:'long'}));const c2=await r2.putImmutable('signalArchive',signal('SIG-DET',{direction:'short'}));
  assert.equal(c1.conflictId,c2.conflictId);
});
await test('T13 重复迁移不重复增加冲突记录',async()=>{
  const s=new Storage({ethAlphaGmkgForecastSnapshots:JSON.stringify([{...snapshot('P-REPEAT','a')}])}),a=new S.MemoryAdapter(),r1=repo(s,a);
  await r1.open();
  await r1.putImmutable('snapshots',{...snapshot('P-REPEAT','b')});// 预先在"IndexedDB"里放入一个会与迁移内容冲突的记录
  const m1=await r1.migrateLegacy();
  assert.equal(m1.state,'VERIFIED_WITH_CONFLICTS');assert.equal(m1.conflictCount,1);
  s.setItem('ethAlphaGmkgForecastSnapshots',JSON.stringify([{...snapshot('P-REPEAT','a')}]));
  const r2=repo(s,a);await r2.open();
  const m2=await r2.migrateLegacy();
  assert.equal(m2.state,'VERIFIED_WITH_CONFLICTS');
  assert.equal((await r2.getConflicts('snapshots')).length,1,'重复迁移不应产生第二条冲突记录');
});

// ===== 14. 中断后重试仍能正确捕获冲突 =====
await test('T14 迁移中断后重试：冲突记录最终仍被完整捕获',async()=>{
  const s=new Storage({ethAlphaGmkgForecastSnapshots:JSON.stringify([snapshot('P-I1','x'),snapshot('P-I2','x')])}),
    a=new S.MemoryAdapter(),r0=repo(s,a);
  await r0.open();
  await r0.putImmutable('snapshots',snapshot('P-I2','conflicting'));// 预置一条会冲突的正式记录
  a.interruptAfter=1;// 模拟第一次迁移在处理到第二条记录前中断
  const r1=repo(s,a);await r1.open();
  const m1=await r1.migrateLegacy();
  assert.equal(m1.state,'FAILED');
  assert.ok(s.getItem('ethAlphaGmkgForecastSnapshots'));
  a.interruptAfter=null;
  const r2=repo(s,a);await r2.open();
  const m2=await r2.migrateLegacy();
  assert.equal(m2.state,'VERIFIED_WITH_CONFLICTS');
  assert.equal((await r2.getAll('snapshots')).find(x=>x.predictionId==='P-I1').payload,'x');
  assert.equal((await r2.get('snapshots','P-I2')).payload,'conflicting');
  assert.equal((await r2.getConflicts('snapshots')).find(c=>c.originalId==='P-I2').record.payload,'x');
});

// ===== 15. 迁移最终状态 VERIFIED_WITH_CONFLICTS =====
await test('T15 存在真实冲突时迁移最终状态为VERIFIED_WITH_CONFLICTS而非FAILED',async()=>{
  const s=new Storage({ethAlphaGmkgForecastSnapshots:JSON.stringify([snapshot('P-STATE','local')])}),r=repo(s);
  await r.open();
  await r.putImmutable('snapshots',snapshot('P-STATE','existing'));
  const m=await r.migrateLegacy();
  assert.equal(m.state,'VERIFIED_WITH_CONFLICTS');
  assert.equal(m.conflictCount,1);
  assert.equal(s.getItem('ethAlphaGmkgForecastSnapshots'),null,'校验通过（含冲突审计）后旧数组仍应被清理');
});

// ===== 16. UI显示冲突数量（通过audit()暴露的字段，运行时模板的DOM接线由v1_4-gmkg-runtime-ui.test.js静态核对） =====
await test('T16 repo.audit()暴露conflictCount供UI展示',async()=>{
  const r=repo();await r.open();
  await r.putImmutable('signalArchive',signal('SIG-AUDIT',{direction:'long'}));
  await r.putImmutable('signalArchive',signal('SIG-AUDIT',{direction:'short'}));
  const audit=await r.audit();
  assert.equal(audit.conflictCount,1);
});

// ===== 17. 冲突报告可导出 =====
await test('T17 exportConflicts()可导出完整冲突报告',async()=>{
  const r=repo();await r.open();
  await r.putImmutable('signalArchive',signal('SIG-EXPORT',{direction:'long'}));
  await r.putImmutable('signalArchive',signal('SIG-EXPORT',{direction:'short'}));
  const report=JSON.parse(await r.exportConflicts());
  assert.equal(report.conflictCount,1);
  assert.equal(report.conflicts[0].originalId,'SIG-EXPORT');
  assert.equal(report.conflicts[0].record.direction,'short');
  const full=JSON.parse(await r.exportAll());
  assert.equal(full.summary.conflictCount,1);
  assert.equal(full.migrationConflicts.length,1);
});

// ===== 18. 冲突历史不得进入可执行交易 =====
await test('T18 冲突记录被强制降级为OBSERVATION且不出现在正式signalArchive读取结果中',async()=>{
  const r=repo();await r.open();
  await r.putImmutable('signalArchive',signal('SIG-SAFE',{archiveCategory:'WATCHLIST',eligibleForTrigger:true}));
  await r.putImmutable('signalArchive',signal('SIG-SAFE',{archiveCategory:'EXECUTABLE',eligibleForTrigger:true,worthBettingAtCreation:true,signalPermissionLevelAtCreation:'trend_entry_allowed',hardBlockedAtCreation:false,opportunityBlockedAtCreation:false}));
  const formalList=await r.getAll('signalArchive');
  assert.equal(formalList.length,1,'冲突落败记录不得出现在正式signalArchive列表中');
  const conflicts=await r.getConflicts('signalArchive');
  assert.equal(conflicts[0].record.archiveCategory,'OBSERVATION','冲突记录内的档案类别必须被强制降级');
  assert.equal(conflicts[0].record.eligibleForTrigger,false);
  assert.equal(conflicts[0].record.migrationDemoted,true);
});

// ===== 19. 模拟账户和持仓保持不变（含存在冲突场景） =====
await test('T19 存在冲突的迁移过程中模拟账户、持仓、风控状态完全不变',async()=>{
  const s=new Storage({
    ethAlphaGmkgForecastSnapshots:JSON.stringify([snapshot('P-ACC','local')]),
    ethAlphaPaperAccount:JSON.stringify({cash:500,equity:520,marginUsed:30,riskRegime:'NORMAL'}),
    ethAlphaPaperTrades:JSON.stringify([{tradeId:'T1',status:'OPEN'}]),
  }),r=repo(s);
  await r.open();
  await r.putImmutable('snapshots',snapshot('P-ACC','existing'));// 制造一个冲突
  const m=await r.migrateLegacy();
  assert.equal(m.state,'VERIFIED_WITH_CONFLICTS');
  assert.deepEqual(JSON.parse(s.getItem('ethAlphaPaperAccount')),{cash:500,equity:520,marginUsed:30,riskRegime:'NORMAL'});
  assert.deepEqual(JSON.parse(s.getItem('ethAlphaPaperTrades')),[{tradeId:'T1',status:'OPEN'}]);
});

// ===== 20. 旧localStorage只在完整校验后清理 =====
await test('T20 校验阶段真正失败（非冲突，而是无法核实内容）时旧数组不被清理',async()=>{
  class BrokenVerifyAdapter extends S.MemoryAdapter{
    async getAll(store){if(store==='forecastSnapshots')return[];return super.getAll(store)}
  }
  const s=new Storage({ethAlphaGmkgForecastSnapshots:JSON.stringify([snapshot('P-BROKEN')])}),r=repo(s,new BrokenVerifyAdapter());
  await r.open();
  const m=await r.migrateLegacy();
  assert.equal(m.state,'FAILED');
  assert.ok(s.getItem('ethAlphaGmkgForecastSnapshots'),'校验失败时旧数据必须保留');
});

// ===== 21. 近乎零剩余配额下完成迁移（含冲突场景） =====
await test('T21 近乎零剩余localStorage配额下，含冲突的迁移仍能安全完成并显著释放空间',async()=>{
  const rows=Array.from({length:52},(_,i)=>snapshot('Q'+i)),
    conflictingRow=snapshot('Q0','differs-from-local'),
    seed={ethAlphaGmkgForecastSnapshots:JSON.stringify(rows)},
    used=Object.entries(seed).reduce((n,[k,v])=>n+k.length+v.length,0),
    s=new Storage(seed,used+500),// 仅500字节余量
    r=repo(s);
  await r.open();
  await r.putImmutable('snapshots',conflictingRow);// 让第一条与本地存储内容冲突
  const m=await r.migrateLegacy();
  assert.equal(m.state,'VERIFIED_WITH_CONFLICTS');
  assert.equal((await r.getAll('snapshots')).length,52);
  assert.equal(s.getItem('ethAlphaGmkgForecastSnapshots'),null);
  assert.equal((await r.getConflicts('snapshots')).length,1);
});

// ===== 22. BrowserIndexedDbAdapter 真实浏览器代码路径（通过最小假IndexedDB练习真实适配器类，而非MemoryAdapter模拟） =====
await test('T22a BrowserIndexedDbAdapter：数据库版本升级会为已存在的数据库补建新增的迁移冲突存储区',async()=>{
  const idb=new FakeIndexedDB();
  // 第一次以旧版本(模拟历史上线时的DB_VERSION=1)打开，只建立部分旧存储区，模拟用户已有的历史IndexedDB。
  const legacyOpen=idb.open(S.DB_NAME,1);
  await new Promise((resolve,reject)=>{legacyOpen.onupgradeneeded=()=>{const db=legacyOpen.result;db.createObjectStore('forecastSnapshots',{keyPath:'_storageId'});db.createObjectStore('signalSnapshots',{keyPath:'_storageId'});db.createObjectStore('repositoryMeta',{keyPath:'_storageId'})};legacyOpen.onsuccess=()=>resolve();legacyOpen.onerror=reject});
  // 真实用户场景：升级到当前DB_VERSION后，onupgradeneeded必须为已存在的数据库补建migrationConflicts等新增存储区。
  const adapter=new S.BrowserIndexedDbAdapter(idb);
  await adapter.open();
  assert.ok(adapter.db.objectStoreNames.contains(S.CONFLICT_STORE),'升级后必须自动补建迁移冲突存储区');
  assert.ok(adapter.db.objectStoreNames.contains('forecastSnapshots'));
  assert.equal(adapter.db.version,S.DB_VERSION);
});
await test('T22b BrowserIndexedDbAdapter：putMany对真实事务执行去重/冲突/新增三种路径',async()=>{
  const idb=new FakeIndexedDB(),adapter=new S.BrowserIndexedDbAdapter(idb);
  await adapter.open();
  const canon=v=>v;
  await adapter.putMany([{store:'forecastSnapshots',id:'X1',name:'snapshots',record:{predictionId:'X1',v:1},canonicalize:canon,demote:false}]);
  const same=await adapter.putMany([{store:'forecastSnapshots',id:'X1',name:'snapshots',record:{predictionId:'X1',v:1},canonicalize:canon,demote:false}]);
  assert.equal(same[0].deduped,true);assert.equal(same[0].conflict,false);
  const diff=await adapter.putMany([{store:'forecastSnapshots',id:'X1',name:'snapshots',record:{predictionId:'X1',v:2},canonicalize:canon,demote:false}]);
  assert.equal(diff[0].conflict,true);
  const stored=await adapter.get('forecastSnapshots','X1');
  assert.equal(stored.v,1,'真实适配器同样不得覆盖已存在记录');
  const conflicts=await adapter.getAll(S.CONFLICT_STORE);
  assert.equal(conflicts.length,1);assert.equal(conflicts[0].record.v,2);
});
await test('T22c BrowserIndexedDbAdapter：写入失败时事务abort，已在同一批次内的写入不落地',async()=>{
  const idb=new FakeIndexedDB(),adapter=new S.BrowserIndexedDbAdapter(idb);
  await adapter.open();
  let threw=false;
  try{
    await adapter.putMany([
      {store:'forecastSnapshots',id:'Y1',name:'snapshots',record:{predictionId:'Y1'},canonicalize:v=>v,demote:false},
      {store:'doesNotExistStore',id:'Y2',name:'snapshots',record:{predictionId:'Y2'},canonicalize:v=>v,demote:false}
    ]);
  }catch(e){threw=true}
  assert.equal(threw,true);
  assert.equal(await adapter.get('forecastSnapshots','Y1'),null,'事务abort后批次内已写入内容不应落地');
});
await test('T22d BrowserIndexedDbAdapter：onblocked时open()以明确错误拒绝',async()=>{
  const blockedIdb={open(){const req=new FakeRequest();queueMicrotask(()=>{if(req.onblocked)req.onblocked({target:req})});return req}},
    adapter=new S.BrowserIndexedDbAdapter(blockedIdb);
  let error=null;try{await adapter.open()}catch(e){error=e}
  assert.ok(error&&/阻塞/.test(error.message));
});

// ===== 23. 两标签页并发生成同一逻辑快照 =====
await test('T23a 两次并发生成同一预测（generatedAt/dataCutoffTime/窗口fetchedAt不同但业务内容相同）安全去重，不产生冲突',async()=>{
  const decision={htf4h:{confirmedPrice:2000,atr14:20,trend:'up',isBreakout:true,isBreakdown:false,breakoutBarsCount:1,volumeRatio:1.3,recentLow20:1900,falseBreakoutTier:'none'},mtf1h:{trend:'up'},dataHealth:'normal',confirmedPrice:2000};
  const bar=(i)=>({openTime:1700000000000+i*900000,closeTime:1700000000000+(i+1)*900000-1,open:2000,high:2001,low:1999,close:2000,volume:10,isClosed:true});
  const closed=Array.from({length:20},(_,i)=>bar(i));
  const windowsAt=fetchedAt=>['ETHUSDT','BTCUSDT'].flatMap(symbol=>['15m','1h','4h'].map(timeframe=>{const w=closed.map(x=>({...x,fetchedAt}));return F.computeKlineWindowRef(symbol,timeframe,w)}));
  const ref=F.barRef('ETH',closed.at(-1),0),target={symbol:'ETH',timeframe:'15m',openTime:ref.openTime+96*900000,closeTime:ref.closeTime+96*900000,timeframeMs:900000,sequenceIndex:96,barKey:`ETH-15m-${ref.closeTime+96*900000}`};
  // 模拟标签页A：服务器时间戳t1；标签页B：几毫秒后独立请求得到的时间戳t2。业务输入（K线内容）完全相同。
  const snapA=F.buildForecastSnapshot('ETH','24h',ref,target,windowsAt(1000),decision,{ok:true,serverTime:1700018000000},F.ALGORITHM_VERSION);
  const snapB=F.buildForecastSnapshot('ETH','24h',ref,target,windowsAt(2000),decision,{ok:true,serverTime:1700018000037},F.ALGORITHM_VERSION);
  assert.equal(snapA.predictionId,snapB.predictionId,'两个标签页应计算出相同的predictionId');
  assert.notEqual(snapA.generatedAt,snapB.generatedAt,'两次生成的时间戳本身允许不同');
  const r=repo();await r.open();
  await r.putBundle([{name:'snapshots',record:snapA}]);
  const second=await r.putBundle([{name:'snapshots',record:snapB}]);
  assert.equal(second.ok,true);
  assert.equal((second.conflicts||[]).length,0,'仅生成时刻元数据不同不构成真实冲突');
  assert.equal((await r.getAll('snapshots')).length,1);
});
await test('T23b 两次并发生成的业务内容确实不同（例如K线窗口内容不同）时保留为冲突而不覆盖',async()=>{
  const r=repo();await r.open();
  await r.putBundle([{name:'snapshots',record:snapshot('P-CONCURRENT','tabA-content')}]);
  const second=await r.putBundle([{name:'snapshots',record:snapshot('P-CONCURRENT','tabB-content')}]);
  assert.equal(second.ok,true);
  assert.equal(second.conflicts.length,1);
  assert.equal((await r.get('snapshots','P-CONCURRENT')).payload,'tabA-content');
  assert.equal((await r.getConflicts('snapshots'))[0].record.payload,'tabB-content');
});

console.log(`RESULT passed=${passed} failed=${failed}`);if(failed)process.exitCode=1;
})();
