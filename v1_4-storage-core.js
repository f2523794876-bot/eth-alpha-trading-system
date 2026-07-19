(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;root.ETHAlphaStorageV14=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const DB_NAME='ethAlphaAuditStore',DB_VERSION=2,MIGRATION_KEY='ethAlphaStorageMigrationV14',SCHEMA_VERSION='v1.4-storage-repository-3',CONFLICT_SCHEMA_VERSION='v1.4-migrationconflict-2',CONFLICT_DISPLAY_LIMIT=100,DIAGNOSTIC_LOCAL_CACHE_LIMIT=25,SIGNAL_LOCAL_CACHE_LIMIT=100;
const MIGRATION_STATES=['NOT_REQUIRED','PENDING','MIGRATING','VERIFIED','VERIFIED_WITH_CONFLICTS','FAILED'],HEALTH_STATES=['HEALTHY','WARNING','CRITICAL','BLOCKED'];
const DATASETS={
  snapshots:{store:'forecastSnapshots',id:'predictionId',formal:true,legacyKey:'ethAlphaGmkgForecastSnapshots'},
  outcomes:{store:'forecastOutcomeEvents',id:'outcomeEventId',formal:true,legacyKey:'ethAlphaGmkgOutcomeEvents'},
  transitions:{store:'dataRevisionEvents',id:'transitionId',formal:true,legacyKey:'ethAlphaGmkgProxyTransitions'},
  attributions:{store:'gmkgValidationRecords',id:'attributionId',formal:true,legacyKey:'ethAlphaGmkgErrorAttributions'},
  walkForward:{store:'walkForwardConfig',id:'configId',formal:true,legacyKey:'ethAlphaGmkgWalkForwardConfig'},
  signalArchive:{store:'signalSnapshots',id:'signalId',formal:true,legacyKey:'ethAlphaSignalArchive',retainLegacy:true,operationalCache:true},
  signalEvents:{store:'signalEvents',id:'eventId',formal:true,legacyKey:'ethAlphaSignalEvents',retainLegacy:true,operationalCache:true},
  shadowResults:{store:'shadowResults',id:'signalId',formal:false,legacyKey:'ethAlphaShadowResults',retainLegacy:true,operationalCache:true,projection:true},
  diagnostics:{store:'tradeGateDiagnostics',id:'diagnosticKey',formal:false,legacyKey:'ethAlphaTradeGateDiagnostics',maxRecords:1000,projection:true}
};
const CONFLICT_STORE='migrationConflicts';
const STORE_NAMES=[...new Set([...Object.values(DATASETS).map(x=>x.store),'repositoryMeta',CONFLICT_STORE])];
// 逐字段白名单：仅这些字段被认定为"非业务事实"（生成时刻的运行时元数据），可在冲突比较前剥离。
// 价格、方向、许可、评分、失效条件、目标、风险、算法版本、权重版本等业务字段均不在此列，任何差异都会被视为真实冲突并保留双方记录。
const VOLATILE_FIELDS={snapshots:['generatedAt','dataCutoffTime']};
const clone=x=>JSON.parse(JSON.stringify(x)),bytes=x=>new TextEncoder().encode(typeof x==='string'?x:JSON.stringify(x)).length;
// 正确的递归、键序无关的规范化序列化：替代此前未被实际使用、且对嵌套对象不正确的 canonical() 实现。
function canonicalStringify(value){
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return'['+value.map(canonicalStringify).join(',')+']';
  const keys=Object.keys(value).sort();
  return'{'+keys.map(k=>JSON.stringify(k)+':'+canonicalStringify(value[k])).join(',')+'}';
}
// 确定性、无外部依赖的稳定哈希（非加密用途，仅用于生成确定性去重/冲突ID），双滚动散列降低碰撞概率。
function stableHash(text){
  const s=String(text);let h1=0x811c9dc5,h2=0x1000193;
  for(let i=0;i<s.length;i++){
    const c=s.charCodeAt(i);
    h1=(h1^c)>>>0;h1=Math.imul(h1,0x01000193)>>>0;
    h2=(h2+c)>>>0;h2=Math.imul(h2^(h2>>>15),0x2c1b3c6d)>>>0;h2=Math.imul(h2^(h2>>>12),0x297a2d39)>>>0;h2^=h2>>>15;h2=h2>>>0;
  }
  return(h1>>>0).toString(16).padStart(8,'0')+(h2>>>0).toString(16).padStart(8,'0');
}
// 冲突身份必须同时绑定数据集、原始ID、规范化内容和冲突schema。signalArchive与shadowResults
// 合法共用SIG-*业务ID，但绝不能在migrationConflicts对象仓库里共用主键。
function conflictIdentity(datasetName,originalId,canonicalContent){
  const contentHash=stableHash(canonicalContent),identity=canonicalStringify({schemaVersion:CONFLICT_SCHEMA_VERSION,datasetName:String(datasetName),originalId:String(originalId),contentHash});
  return{contentHash,conflictId:`${CONFLICT_SCHEMA_VERSION}__${datasetName}__${stableHash(identity)}__${contentHash}`};
}
function stripVolatile(name,record){
  const out=clone(record),fields=VOLATILE_FIELDS[name]||[];
  for(const f of fields)delete out[f];
  if(name==='snapshots'&&Array.isArray(out.klineWindowRefs))out.klineWindowRefs=out.klineWindowRefs.map(w=>{if(!w||typeof w!=='object')return w;const c={...w};delete c.fetchedAt;return c});
  return out;
}
// signalArchive专属：entryZone可能以旧展示字符串、旧宽松对象或新结构化对象三种形状出现（均由v1-core.js normalizeEntryZone统一解析）。
// 只要注入的entryZoneNormalizer解析出的数值三元组相同，即视为同一业务事实的不同序列化形式；解析失败或数值不同则原样保留，交由后续比较判定为真实冲突。
// archiveCategory/eligibleForTrigger/hardBlockedAtCreation等字段不在白名单内，任何差异都被视为真实业务内容差异。
function canonicalizeForCompare(name,record,options){
  let out=stripVolatile(name,record);
  if(name==='signalArchive'&&options&&typeof options.entryZoneNormalizer==='function'){
    const rawEstimate=out.entryZone&&typeof out.entryZone==='object'&&!Array.isArray(out.entryZone)?out.entryZone.estimatedEntry:undefined;
    let z=null;try{z=options.entryZoneNormalizer(out.entryZone,rawEstimate)}catch(_){z=null}
    if(z&&z.valid)out={...out,entryZone:{lower:z.lower,upper:z.upper,estimatedEntry:z.estimatedEntry,valid:true}};
  }
  return out;
}
function demoteForConflictStorage(name,record){
  const safe=clone(record);
  if(name==='signalArchive')return{...safe,archiveCategory:'OBSERVATION',eligibleForTrigger:false,migrationDemoted:true,migrationDemotedReason:'迁移冲突记录默认降级为历史观察，不获得新的交易许可'};
  return safe;
}
function buildConflictRecord(entry,id,conflictId,contentHash){
  return{_storageId:conflictId,schemaVersion:CONFLICT_SCHEMA_VERSION,conflictId,datasetName:entry.name,store:entry.store,originalId:id,contentHash,detectedAt:Date.now(),migrationSessionId:entry.migrationSessionId||null,migrationConflictReason:entry.conflictReason||'ID_CONFLICT_CONTENT_MISMATCH',sourceStorage:entry.sourceStorage||'localStorage',record:entry.demote?demoteForConflictStorage(entry.name,entry.record):clone(entry.record)};
}
function classifyError(e){const name=e?.name||'Error',message=e?.message||String(e||'未知错误');if(name==='QuotaExceededError')return{code:'QUOTA_EXCEEDED',message};if(['SecurityError','NotAllowedError'].includes(name))return{code:'PERMISSION_DENIED',message};if(name==='DataError')return{code:'DATA_ERROR',message};if(String(message).includes('ID_CONFLICT'))return{code:'ID_CONFLICT',message};return{code:'DATABASE_ERROR',message}}
function recordId(name,record){const cfg=DATASETS[name],candidate=record?.[cfg.id]??(name==='walkForward'?'default':null);return candidate===null||candidate===undefined||candidate===''?null:String(candidate)}
function stripInternal(record){if(!record||typeof record!=='object')return record;const out=clone(record);delete out._storageId;return out}
function differencePaths(a,b,path='',out=[]){
  if(Object.is(a,b))return out;
  if(a===null||b===null||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b)){out.push(path||'$');return out}
  const keys=new Set([...Object.keys(a),...Object.keys(b)]);
  for(const key of keys)differencePaths(a[key],b[key],path?`${path}.${key}`:key,out);
  return out;
}
function requestPromise(req){return new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error||Error('IndexedDB请求失败'))})}
function transactionDone(tx){return new Promise((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error||Error('IndexedDB事务中止'));tx.onerror=()=>reject(tx.error||Error('IndexedDB事务失败'))})}
class BrowserIndexedDbAdapter{
  constructor(indexedDB){this.indexedDB=indexedDB;this.db=null}
  async open(){
    if(!this.indexedDB)throw Object.assign(Error('当前本地文件环境不支持IndexedDB；请先导出备份，并使用Chrome普通窗口重新打开同一HTML文件'),{name:'NotAllowedError'});
    this.db=await new Promise((resolve,reject)=>{
      const req=this.indexedDB.open(DB_NAME,DB_VERSION);
      req.onupgradeneeded=()=>{const db=req.result;for(const name of STORE_NAMES)if(!db.objectStoreNames.contains(name))db.createObjectStore(name,{keyPath:'_storageId'})};
      req.onsuccess=()=>resolve(req.result);
      req.onerror=()=>reject(req.error||Error('IndexedDB打开失败'));
      req.onblocked=()=>reject(Error('IndexedDB升级被其他页面阻塞，请关闭其他同页面标签后重试'));
    });
    return this;
  }
  async getAll(store){const tx=this.db.transaction(store,'readonly'),rows=await requestPromise(tx.objectStore(store).getAll());await transactionDone(tx);return rows.map(stripInternal)}
  async get(store,id){const tx=this.db.transaction(store,'readonly'),row=await requestPromise(tx.objectStore(store).get(String(id)));await transactionDone(tx);return row?stripInternal(row):null}
  async putMany(entries,{projection=false}={}){
    const stores=[...new Set([...entries.map(x=>x.store),CONFLICT_STORE])],tx=this.db.transaction(stores,'readwrite'),done=transactionDone(tx),results=[];
    try{
      for(const entry of entries){
        const objectStore=tx.objectStore(entry.store),id=String(entry.id),prior=await requestPromise(objectStore.get(id)),canon=entry.canonicalize||(v=>v);
        if(prior&&!projection){
          const old=stripInternal(prior);
          if(canonicalStringify(canon(old))===canonicalStringify(canon(entry.record))){results.push({id,deduped:true,conflict:false});continue}
          const{contentHash,conflictId}=conflictIdentity(entry.name,id,canonicalStringify(canon(entry.record))),conflictStore=tx.objectStore(CONFLICT_STORE),existingConflict=await requestPromise(conflictStore.get(conflictId));
          if(!existingConflict)conflictStore.put(buildConflictRecord(entry,id,conflictId,contentHash));
          results.push({id,deduped:false,conflict:true,conflictId});
          continue;
        }
        objectStore.put({...clone(entry.record),_storageId:id});
        results.push({id,deduped:false,conflict:false});
      }
      await done;
      return results;
    }catch(e){
      try{tx.abort()}catch(_){}
      await done.catch(()=>{});
      throw e;
    }
  }
  async deleteMany(store,ids){if(!ids.length)return;const tx=this.db.transaction(store,'readwrite'),os=tx.objectStore(store);for(const id of ids)os.delete(String(id));await transactionDone(tx)}
}
class MemoryAdapter{
  constructor(options={}){this.tables=new Map(STORE_NAMES.map(x=>[x,new Map()]));this.failOpen=options.failOpen||null;this.failWrite=options.failWrite||null;this.interruptAfter=options.interruptAfter??null;this.writes=0}
  async open(){if(this.failOpen)throw this.failOpen;return this}
  async getAll(store){return[...(this.tables.get(store)||new Map()).values()].map(clone)}
  async get(store,id){const x=this.tables.get(store)?.get(String(id));return x?clone(x):null}
  async putMany(entries,{projection=false}={}){
    if(this.failWrite)throw this.failWrite;
    const backup=new Map(),written=[],
      stage=(store,id,value)=>{const key=store+'::'+id;if(!backup.has(key))backup.set(key,this.tables.get(store).get(id));this.tables.get(store).set(id,value);written.push({store,id,key})};
    const out=[];
    try{
      for(const x of entries){
        if(this.interruptAfter!==null&&this.writes++>=this.interruptAfter)throw Error('MIGRATION_INTERRUPTED');
        const table=this.tables.get(x.store),id=String(x.id),old=table.get(id),canon=x.canonicalize||(v=>v);
        if(old&&!projection){
          if(canonicalStringify(canon(old))===canonicalStringify(canon(x.record))){out.push({id,deduped:true,conflict:false});continue}
          const{contentHash,conflictId}=conflictIdentity(x.name,id,canonicalStringify(canon(x.record))),conflictTable=this.tables.get(CONFLICT_STORE);
          if(!conflictTable.has(conflictId))stage(CONFLICT_STORE,conflictId,clone(buildConflictRecord(x,id,conflictId,contentHash)));
          out.push({id,deduped:false,conflict:true,conflictId});
          continue;
        }
        stage(x.store,id,clone(x.record));
        out.push({id,deduped:false,conflict:false});
      }
      return out;
    }catch(e){
      for(let i=written.length-1;i>=0;i--){
        const{store,id,key}=written[i],before=backup.get(key),table=this.tables.get(store);
        if(before===undefined)table.delete(id);else table.set(id,before);
      }
      throw e;
    }
  }
  async deleteMany(store,ids){for(const id of ids)this.tables.get(store).delete(String(id))}
}
function readLegacy(name,storage){const cfg=DATASETS[name],raw=storage?.getItem(cfg.legacyKey);if(!raw)return{ok:true,records:[],rawBytes:0,stats:null};try{const value=JSON.parse(raw);if(name==='diagnostics'){if(!value||!Array.isArray(value.records))throw Error('诊断结构无效');return{ok:true,records:value.records,rawBytes:bytes(raw),stats:value.stats||{}}}if(!Array.isArray(value))throw Error('数据集不是数组');return{ok:true,records:value,rawBytes:bytes(raw),stats:null}}catch(e){return{ok:false,records:[],rawBytes:bytes(raw),error:e.message,stats:null}}
}
function auditLocalStorage(storage){const rows=[];if(!storage)return{totalBytes:0,rows,largest:null};for(let i=0;i<storage.length;i++){const key=storage.key(i),raw=storage.getItem(key)||'',parsed=(()=>{try{return JSON.parse(raw)}catch(_){return null}})(),count=Array.isArray(parsed)?parsed.length:Array.isArray(parsed?.records)?parsed.records.length:parsed===null?0:1;rows.push({key,count,estimatedBytes:bytes(key)+bytes(raw)})}rows.sort((a,b)=>b.estimatedBytes-a.estimatedBytes);return{totalBytes:rows.reduce((s,x)=>s+x.estimatedBytes,0),rows,largest:rows[0]||null}}
function migrationMeta(storage,state,detail={}){const value={schemaVersion:SCHEMA_VERSION,state:MIGRATION_STATES.includes(state)?state:'FAILED',updatedAt:Date.now(),...detail};try{storage?.setItem(MIGRATION_KEY,JSON.stringify(value))}catch(_){}return value}
function writeLocalAtomically(storage,changes){const old=new Map(changes.map(([key])=>[key,storage.getItem(key)])),written=[];try{for(const[key,value]of changes){storage.setItem(key,value);written.push(key)}return{ok:true}}catch(e){for(const key of written.reverse()){try{const before=old.get(key);if(before===null)storage.removeItem(key);else storage.setItem(key,before)}catch(_){}}return{ok:false,reason:e.message,error:classifyError(e)}}}
function compactOperationalSignalCache(storage){try{const archive=JSON.parse(storage.getItem(DATASETS.signalArchive.legacyKey)||'[]');if(!Array.isArray(archive))return{ok:false,reason:'建议档案结构无效'};const kept=archive.sort((a,b)=>(a.generatedAt||0)-(b.generatedAt||0)).slice(-SIGNAL_LOCAL_CACHE_LIMIT),ids=new Set(kept.map(x=>x.signalId)),events=JSON.parse(storage.getItem(DATASETS.signalEvents.legacyKey)||'[]'),shadow=JSON.parse(storage.getItem(DATASETS.shadowResults.legacyKey)||'[]'),changes=[[DATASETS.signalArchive.legacyKey,JSON.stringify(kept.map(x=>({...x,forecastSnapshot:x.forecastSnapshot?.m15?{m15:{directionLabel:x.forecastSnapshot.m15.directionLabel}}:null,forecastSnapshotStoredExternally:!!x.forecastSnapshot})))],[DATASETS.signalEvents.legacyKey,JSON.stringify((Array.isArray(events)?events:[]).filter(x=>ids.has(x.signalId)))],[DATASETS.shadowResults.legacyKey,JSON.stringify((Array.isArray(shadow)?shadow:[]).filter(x=>ids.has(x.signalId)))]];const written=writeLocalAtomically(storage,changes);return written.ok?{ok:true,retained:kept.length}:written}catch(e){return{ok:false,reason:e.message,error:classifyError(e)}}}
function createRepository(options={}){
  const storage=options.localStorage||null,navigatorStorage=options.navigatorStorage||null,adapter=options.adapter||new BrowserIndexedDbAdapter(options.indexedDB),
    repo={adapter,storage,navigatorStorage,ready:false,lastError:null,lastLegacyBackup:null,migration:migrationMeta(null,'NOT_REQUIRED')};
  const buildEntry=(name,record,extra={})=>({
    store:DATASETS[name].store,id:recordId(name,record),name,record:stripInternal(record),
    canonicalize:r=>canonicalizeForCompare(name,r,options),
    demote:name==='signalArchive',
    conflictReason:'ID_CONFLICT_CONTENT_MISMATCH',sourceStorage:'localStorage',...extra
  });
  repo.open=async()=>{try{await adapter.open();repo.ready=true;return{ok:true}}catch(e){repo.lastError=classifyError(e);return{ok:false,error:repo.lastError}}};
  repo.getAll=async name=>{if(!repo.ready)throw Error('REPOSITORY_NOT_READY');return adapter.getAll(DATASETS[name].store)};
  repo.get=async(name,id)=>{if(!repo.ready)throw Error('REPOSITORY_NOT_READY');return adapter.get(DATASETS[name].store,id)};
  repo.getConflicts=async name=>{if(!repo.ready)return[];const all=await adapter.getAll(CONFLICT_STORE);return name?all.filter(c=>c.datasetName===name):all};
  repo.inspectMigrationRecord=async(name,id)=>{
    if(!DATASETS[name])throw Error(`未知数据集：${name}`);
    const source=readLegacy(name,storage),localRecord=source.records.find(x=>recordId(name,x)===String(id))||null,formalRecord=await repo.get(name,id),conflicts=(await repo.getConflicts(name)).filter(x=>x.originalId===String(id)),canon=x=>x===null?null:canonicalizeForCompare(name,x,options),localCanonical=canon(localRecord),formalCanonical=canon(formalRecord);
    return{schemaVersion:SCHEMA_VERSION,exportedAt:Date.now(),dataset:name,originalId:String(id),localStorageRecord:localRecord,indexedDbRecord:formalRecord,migrationConflicts:conflicts,canonical:{local:localCanonical,formal:formalCanonical,localHash:localCanonical===null?null:stableHash(canonicalStringify(localCanonical)),formalHash:formalCanonical===null?null:stableHash(canonicalStringify(formalCanonical)),differencePaths:localCanonical===null||formalCanonical===null?[]:differencePaths(localCanonical,formalCanonical)}};
  };
  repo.putImmutable=async(name,record)=>{
    const id=recordId(name,record);
    if(!id)return{ok:false,error:{code:'DATA_ERROR',message:`${name}缺少稳定ID`}};
    try{const result=await adapter.putMany([buildEntry(name,record)]);return{ok:true,deduped:result[0].deduped,conflict:result[0].conflict,conflictId:result[0].conflictId,id}}
    catch(e){repo.lastError=classifyError(e);return{ok:false,error:repo.lastError}}
  };
  repo.putProjection=async(name,record)=>{const id=recordId(name,record);if(!id)return{ok:false,error:{code:'DATA_ERROR',message:`${name}缺少投影ID`}};try{await adapter.putMany([{store:DATASETS[name].store,id,record:stripInternal(record)}],{projection:true});const cfg=DATASETS[name],all=await repo.getAll(name);if(cfg.maxRecords&&all.length>cfg.maxRecords){const remove=all.sort((a,b)=>(a.evaluatedAt||a.createdAt||0)-(b.evaluatedAt||b.createdAt||0)).slice(0,all.length-cfg.maxRecords).map(x=>recordId(name,x));await adapter.deleteMany(cfg.store,remove)}return{ok:true,id}}catch(e){repo.lastError=classifyError(e);return{ok:false,error:repo.lastError}}};
  repo.putBundle=async entries=>{
    const prepared=[];
    for(const{name,record}of entries){const id=recordId(name,record);if(!id)return{ok:false,error:{code:'DATA_ERROR',message:`${name}缺少稳定ID`}};prepared.push(buildEntry(name,record))}
    try{
      const result=await adapter.putMany(prepared);
      return{ok:true,deduped:result.every(x=>x.deduped),conflicts:result.filter(x=>x.conflict).map(x=>({id:x.id,conflictId:x.conflictId}))};
    }catch(e){repo.lastError=classifyError(e);return{ok:false,error:repo.lastError}}
  };
  repo.audit=async()=>{const local=auditLocalStorage(storage),datasets=[];let totalConflictCount=0;if(repo.ready){for(const name of Object.keys(DATASETS)){const records=await repo.getAll(name);datasets.push({name,store:DATASETS[name].store,count:records.length,estimatedBytes:records.reduce((s,x)=>s+bytes(x),0),formal:DATASETS[name].formal})}totalConflictCount=(await repo.getConflicts()).length}let estimate=null;try{estimate=await navigatorStorage?.estimate?.()||null}catch(_){}const used=estimate?.usage??local.totalBytes,quota=estimate?.quota??null,ratio=quota?used/quota:null;let status='HEALTHY';if(repo.lastError||!repo.ready)status='BLOCKED';else if(ratio!==null&&ratio>=.92)status='BLOCKED';else if(ratio!==null&&ratio>=.8)status='CRITICAL';else if(ratio!==null&&ratio>=.6)status='WARNING';const all=[...datasets,...local.rows.map(x=>({name:x.key,store:'localStorage',count:x.count,estimatedBytes:x.estimatedBytes,formal:false}))].sort((a,b)=>b.estimatedBytes-a.estimatedBytes);return{schemaVersion:SCHEMA_VERSION,status,estimatedUsage:used,quota,usageRatio:ratio,localStorage:local,datasets,conflictCount:totalConflictCount,totalConflictCount,displayedConflictCount:Math.min(totalConflictCount,CONFLICT_DISPLAY_LIMIT),largest:all[0]||null,lastError:repo.lastError}};
  repo.healthCheck=async()=>{if(!repo.ready)return{ok:false,status:'BLOCKED',error:repo.lastError};const probe={schemaVersion:SCHEMA_VERSION,probeId:'health',checkedAt:Date.now()};try{await adapter.putMany([{store:'repositoryMeta',id:'health',record:probe}],{projection:true});const got=await adapter.get('repositoryMeta','health');if(!got||got.checkedAt!==probe.checkedAt)throw Error('HEALTH_PROBE_MISMATCH');repo.lastError=null;return{ok:true,status:(await repo.audit()).status}}catch(e){repo.lastError=classifyError(e);return{ok:false,status:'BLOCKED',error:repo.lastError}}};
  repo.exportLegacyBackup=()=>{const audit=auditLocalStorage(storage),datasets={};for(const name of Object.keys(DATASETS)){const loaded=readLegacy(name,storage);datasets[name]={ok:loaded.ok,records:loaded.records,stats:loaded.stats,error:loaded.error||null}}return JSON.stringify({schemaVersion:SCHEMA_VERSION,exportedAt:Date.now(),summary:{localStorageBytes:audit.totalBytes,keys:audit.rows.length,records:Object.fromEntries(Object.entries(datasets).map(([k,v])=>[k,v.records.length]))},datasets},null,2)};
  repo.exportAll=async()=>{const datasets={};for(const name of Object.keys(DATASETS))datasets[name]=await repo.getAll(name);const conflicts=await repo.getConflicts(),diagnosticStats=readLegacy('diagnostics',storage).stats||{};return JSON.stringify({schemaVersion:SCHEMA_VERSION,exportedAt:Date.now(),summary:{records:Object.fromEntries(Object.entries(datasets).map(([k,v])=>[k,v.length])),conflictCount:conflicts.length},metadata:{diagnosticStats},datasets,migrationConflicts:conflicts},null,2)};
  repo.exportConflicts=async()=>{const conflicts=await repo.getConflicts();return JSON.stringify({schemaVersion:SCHEMA_VERSION,exportedAt:Date.now(),totalConflictCount:conflicts.length,displayedConflictCount:conflicts.length,conflictCount:conflicts.length,conflicts},null,2)};
  repo.exportMigrationConflictDiagnostic=async(name,id)=>JSON.stringify(await repo.inspectMigrationRecord(name,id),null,2);
  repo.importBackup=async text=>{
    let parsed;try{parsed=typeof text==='string'?JSON.parse(text):clone(text)}catch(e){return{ok:false,error:{code:'DATA_ERROR',message:'导入JSON无法解析'}}}
    if(parsed?.schemaVersion!==SCHEMA_VERSION||!parsed.datasets)return{ok:false,error:{code:'DATA_ERROR',message:'导入格式版本不受支持'}};
    const imported={},conflicts=[];
    for(const[name,raw]of Object.entries(parsed.datasets)){
      if(!DATASETS[name])continue;
      const records=Array.isArray(raw)?raw:Array.isArray(raw?.records)?raw.records:[];
      imported[name]=0;
      for(const record of records){
        const r=await repo.putImmutable(name,record);
        if(!r.ok)return{ok:false,error:r.error,imported,conflicts};
        if(r.conflict)conflicts.push({name,id:r.id,conflictId:r.conflictId});
        else if(!r.deduped)imported[name]++;
      }
    }
    const importedStats=parsed.metadata?.diagnosticStats||parsed.datasets?.diagnostics?.stats;
    if(importedStats&&storage){const current=readLegacy('diagnostics',storage),stats={...(current.stats||{})};for(const[k,v]of Object.entries(importedStats))if(Number.isFinite(+v))stats[k]=Math.max(+stats[k]||0,+v);storage.setItem(DATASETS.diagnostics.legacyKey,JSON.stringify({schemaVersion:'v1.3.1-trade-gate-1',stats,records:(current.records||[]).slice(-DIAGNOSTIC_LOCAL_CACHE_LIMIT)}))}
    return{ok:true,imported,conflicts,error:null};
  };
  repo.archiveOperationalDatasets=async()=>{if(!repo.ready)return{ok:false,error:repo.lastError};const lock=await adapter.get('repositoryMeta','migrationLock');if(lock?.state==='MIGRATING')return{ok:true,deferred:true,reason:'迁移校验期间暂停投影归档，正式运行数据仍保留在localStorage'};const names=['signalArchive','signalEvents','shadowResults','diagnostics'];try{for(const name of names){const source=readLegacy(name,storage);if(!source.ok)throw Error(`${name}:${source.error}`);for(const record of source.records){const id=recordId(name,record);if(!DATASETS[name].projection&&await repo.get(name,id))continue;const saved=DATASETS[name].projection?await repo.putProjection(name,record):await repo.putImmutable(name,record);if(!saved.ok)throw Object.assign(Error(saved.error.message),{storageError:saved.error})}}const compacted=compactOperationalSignalCache(storage);if(!compacted.ok)throw Error(compacted.reason);const diagnostic=readLegacy('diagnostics',storage);if(diagnostic.ok&&diagnostic.records.length>DIAGNOSTIC_LOCAL_CACHE_LIMIT)storage.setItem(DATASETS.diagnostics.legacyKey,JSON.stringify({schemaVersion:'v1.3.1-trade-gate-1',stats:diagnostic.stats||{},records:diagnostic.records.slice(-DIAGNOSTIC_LOCAL_CACHE_LIMIT)}));if(repo.lastError){const health=await repo.healthCheck();if(!health.ok)return{ok:false,error:health.error}}return{ok:true,signalCacheCount:compacted.retained}}catch(e){repo.lastError=e.storageError||classifyError(e);return{ok:false,error:repo.lastError}}};
  repo.migrateLegacy=async()=>{
    let priorMeta=null;try{priorMeta=JSON.parse(storage?.getItem(MIGRATION_KEY)||'null')}catch(_){}
    if(priorMeta?.schemaVersion===SCHEMA_VERSION&&['VERIFIED','VERIFIED_WITH_CONFLICTS'].includes(priorMeta.state)){
      const health=await repo.healthCheck();
      if(health.ok){repo.migration=priorMeta;return{ok:true,state:priorMeta.state,counts:priorMeta.counts||{},retainedOperational:priorMeta.retainedOperational||[],totalConflictCount:priorMeta.totalConflictCount??priorMeta.conflictCount??0,displayedConflictCount:priorMeta.displayedConflictCount??Math.min(priorMeta.conflictCount||0,CONFLICT_DISPLAY_LIMIT),conflictCount:priorMeta.conflictCount||0,conflicts:priorMeta.conflicts||[],resumedVerified:true}}
    }
    const sources={},has=[],conflicts=[],legacyOriginals=new Map(Object.values(DATASETS).map(cfg=>[cfg.legacyKey,storage?.getItem(cfg.legacyKey)??null]));
    let localMutated=false;
    repo.lastLegacyBackup=repo.exportLegacyBackup();
    for(const name of Object.keys(DATASETS)){
      sources[name]=readLegacy(name,storage);
      if(!sources[name].ok){repo.migration=migrationMeta(storage,'FAILED',{reason:`${name}:${sources[name].error}`});return{ok:false,state:'FAILED',reason:repo.migration.reason}}
      if(sources[name].records.length)has.push(name);
    }
    if(!has.length){repo.migration=migrationMeta(storage,'NOT_REQUIRED');return{ok:true,state:'NOT_REQUIRED',counts:{}}}
    // sessionId取决于迁移源的规范化业务内容；同一批旧数据多次FAILED重试会得到同一ID，
    // 页面运行中新产生的IndexedDB记录不会改变它，也不会被本迁移删除。
    const migrationSessionId=`MIG-${stableHash(canonicalStringify(has.map(name=>({name,records:sources[name].records.map(record=>canonicalizeForCompare(name,record,options))}))))}`;
    repo.migration=migrationMeta(storage,'PENDING',{datasets:has});
    repo.migration=migrationMeta(storage,'MIGRATING',{datasets:has,migrationSessionId});
    try{
      await adapter.putMany([{store:'repositoryMeta',id:'migrationLock',name:'repositoryMeta',record:{schemaVersion:SCHEMA_VERSION,migrationSessionId,state:'MIGRATING',startedAt:Date.now()}}],{projection:true});
      // 写入阶段：内容一致的记录幂等去重；内容真正不同的同ID记录不覆盖已存在记录，转而作为确定性ID的冲突审计记录一并写入（见putImmutable/putMany）。
      // shadowResults/diagnostics在日常运行中是可更新投影，但迁移是历史取证：旧投影不得覆盖当前投影，
      // 内容不同必须进入dataset隔离的冲突审计记录。因此迁移阶段统一走冲突保留写入，不使用putProjection。
      for(const name of has)for(const record of sources[name].records){
        const id=recordId(name,record);
        if(!id)throw Object.assign(Error(`${name}缺少稳定ID`),{storageError:{code:'DATA_ERROR',message:`${name}缺少稳定ID`}});
        const written=await adapter.putMany([buildEntry(name,record,{migrationSessionId})]),result=written[0];
        if(result.conflict)conflicts.push({name,id,conflictId:result.conflictId});
      }
      // 校验阶段：每条源记录必须能在"正式存储"或"冲突审计记录"中找到内容匹配的副本，否则判定迁移失败（防止静默丢数据）。
      for(const name of has){
        const migrated=new Map((await repo.getAll(name)).map(x=>[recordId(name,x),x])),
          conflictRecords=(await adapter.getAll(CONFLICT_STORE)).filter(c=>c.datasetName===name),
          conflictsByOriginal=new Map();
        for(const c of conflictRecords){if(!conflictsByOriginal.has(c.originalId))conflictsByOriginal.set(c.originalId,[]);conflictsByOriginal.get(c.originalId).push(c)}
        for(const record of sources[name].records){
          const id=recordId(name,record),canon=r=>canonicalizeForCompare(name,r,options),wanted=canonicalStringify(canon(record)),stored=migrated.get(id);
          if(stored&&canonicalStringify(canon(stored))===wanted)continue;
          const{contentHash:wantedHash,conflictId:wantedConflictId}=conflictIdentity(name,id,wanted),losers=conflictsByOriginal.get(id)||[];
          if(losers.some(c=>c.schemaVersion===CONFLICT_SCHEMA_VERSION&&c.datasetName===name&&c.originalId===id&&c.contentHash===wantedHash&&c.conflictId===wantedConflictId))continue;
          throw Error(`MIGRATION_VERIFY_FAILED:${name}:${id}`);
        }
      }
      localMutated=true;
      for(const name of has){
        const cfg=DATASETS[name];
        if(cfg.retainLegacy)continue;
        if(name==='diagnostics'){const raw=JSON.parse(storage.getItem(cfg.legacyKey));storage.setItem(cfg.legacyKey,JSON.stringify({schemaVersion:raw.schemaVersion,stats:raw.stats||{},records:raw.records.slice(-DIAGNOSTIC_LOCAL_CACHE_LIMIT)}))}
        else storage.removeItem(cfg.legacyKey);
      }
      if(has.some(name=>DATASETS[name].operationalCache)){const compacted=compactOperationalSignalCache(storage);if(!compacted.ok)throw Error(compacted.reason)}
      const health=await repo.healthCheck();
      if(!health.ok)throw Object.assign(Error(health.error?.message||'迁移后健康检查失败'),{storageError:health.error});
      const relevantConflicts=(await adapter.getAll(CONFLICT_STORE)).filter(c=>has.includes(c.datasetName)),
        state=relevantConflicts.length?'VERIFIED_WITH_CONFLICTS':'VERIFIED';
      await adapter.putMany([{store:'repositoryMeta',id:'migrationLock',name:'repositoryMeta',record:{schemaVersion:SCHEMA_VERSION,migrationSessionId,state,verifiedAt:Date.now(),totalConflictCount:relevantConflicts.length}}],{projection:true});
      repo.migration=migrationMeta(storage,state,{
        migrationSessionId,
        counts:Object.fromEntries(has.map(n=>[n,sources[n].records.length])),
        retainedOperational:has.filter(n=>DATASETS[n].retainLegacy),
        totalConflictCount:relevantConflicts.length,
        displayedConflictCount:Math.min(relevantConflicts.length,CONFLICT_DISPLAY_LIMIT),
        conflictCount:relevantConflicts.length,
        conflicts:relevantConflicts.slice(0,CONFLICT_DISPLAY_LIMIT).map(c=>({name:c.datasetName,originalId:c.originalId,conflictId:c.conflictId}))
      });
      return{ok:true,state,counts:repo.migration.counts,retainedOperational:repo.migration.retainedOperational,totalConflictCount:repo.migration.totalConflictCount,displayedConflictCount:repo.migration.displayedConflictCount,conflictCount:repo.migration.conflictCount,conflicts:repo.migration.conflicts};
    }catch(e){
      if(localMutated)for(const[key,raw]of legacyOriginals){try{if(raw===null)storage.removeItem(key);else storage.setItem(key,raw)}catch(_){}}
      repo.lastError=e.storageError||classifyError(e);
      try{await adapter.putMany([{store:'repositoryMeta',id:'migrationLock',name:'repositoryMeta',record:{schemaVersion:SCHEMA_VERSION,migrationSessionId,state:'FAILED',failedAt:Date.now(),reason:repo.lastError.message}}],{projection:true})}catch(_){}
      repo.migration=migrationMeta(storage,'FAILED',{migrationSessionId,reason:repo.lastError.message});
      return{ok:false,state:'FAILED',reason:repo.lastError.message,error:repo.lastError};
    }
  };
  return repo;
}
return{DB_NAME,DB_VERSION,MIGRATION_KEY,SCHEMA_VERSION,CONFLICT_SCHEMA_VERSION,CONFLICT_STORE,CONFLICT_DISPLAY_LIMIT,DIAGNOSTIC_LOCAL_CACHE_LIMIT,SIGNAL_LOCAL_CACHE_LIMIT,MIGRATION_STATES,HEALTH_STATES,DATASETS,VOLATILE_FIELDS,BrowserIndexedDbAdapter,MemoryAdapter,auditLocalStorage,readLegacy,recordId,classifyError,canonicalStringify,stableHash,conflictIdentity,canonicalizeForCompare,demoteForConflictStorage,differencePaths,writeLocalAtomically,compactOperationalSignalCache,createRepository};
});
