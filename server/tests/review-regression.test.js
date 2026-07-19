import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MemoryRepository } from '../src/db/memory.js';
import { normalizeFunding, normalizeLongShort, normalizeOpenInterest, normalizeTakerFlow } from '../src/domain/normalize.js';
import { EndpointHealthRegistry, evaluateHealth } from '../src/health/evaluator.js';

const NOW=1_784_000_000_000, OBSERVED=NOW-60_000;
const context={sourceId:'binance-usdt-futures-rest',endpointId:'binance-futures-open-interest',instrument:'ETHUSDT',marketType:'usdt_perpetual',interval:'15m',fetchedAt:NOW,rawPayloadId:'raw',requestId:'00000000-0000-0000-0000-000000000001',qualityState:'NORMAL'};

test('旧fencing token过期后全部关键写入默认拒绝',async()=>{let now=NOW;const repo=new MemoryRepository({requireLease:true,now:()=>now});const a=await repo.acquireLease('primary-collector','a',10,now);now+=11;const b=await repo.acquireLease('primary-collector','b',1000,now);assert.ok(b.fencingToken>a.fencingToken);for(const write of [()=>repo.saveHealth({state:'HEALTHY'},a),()=>repo.audit({eventType:'OLD'},a),()=>repo.saveGaps([],a),()=>repo.startRun({runId:'x'},a)])await assert.rejects(write,error=>error.code==='FENCING_TOKEN_REJECTED');await repo.saveHealth({state:'HEALTHY'},b);assert.equal(repo.health.length,1);});

test('四类点状事实完整携带冻结DataVintageRef时间链',()=>{const rows=[normalizeFunding({symbol:'ETHUSDT',fundingTime:OBSERVED,fundingRate:'0.1'},context),normalizeOpenInterest({symbol:'ETHUSDT',time:OBSERVED,openInterest:'1'},context),normalizeLongShort({symbol:'ETHUSDT',timestamp:OBSERVED,longShortRatio:'1',longAccount:'0.5',shortAccount:'0.5'},context),normalizeTakerFlow({timestamp:OBSERVED,buySellRatio:'1',buyVol:'1',sellVol:'1'},context)];for(const row of rows){assert.equal(row.publishedAt,OBSERVED);assert.equal(row.availableAt,OBSERVED);assert.equal(row.firstAvailableAt,NOW);assert.equal(row.fetchedAt,NOW);assert.equal(row.dataVintageRef.vintageId,row.vintageId);}});

test('迁移002包含原始层不可变、四表完整时间红线和回补状态机',async()=>{const sql=await readFile(new URL('../migrations/002_v1_4a_review_fixes.up.sql',import.meta.url),'utf8');assert.match(sql,/raw_payloads_no_update/);assert.match(sql,/raw_payloads_no_delete/);for(const name of ['funding_time_order','open_interest_time_order','long_short_time_order','taker_flow_time_order'])assert.match(sql,new RegExp(name));for(const state of ['PENDING','RUNNING','RETRY_WAIT','SUCCEEDED','FAILED_PERMANENT'])assert.match(sql,new RegExp(state));});

test('迁移器使用PostgreSQL advisory lock且systemd启动前执行迁移',async()=>{const migration=await readFile(new URL('../src/db/migrate.js',import.meta.url),'utf8');const unit=await readFile(new URL('../../deploy/systemd/eth-alpha-collector.service',import.meta.url),'utf8');assert.match(migration,/pg_advisory_lock/);assert.match(migration,/pg_advisory_unlock/);assert.match(unit,/ExecStartPre=.*migrate/);});

test('端点失败跨周期累计并经三次连续成功才从RECOVERING恢复',()=>{let now=NOW;const registry=new EndpointHealthRegistry({spot:30000},()=>now);registry.failure('spot',{httpStatus:500,code:'UPSTREAM'});now+=30000;registry.failure('spot',{httpStatus:500,code:'UPSTREAM'});assert.equal(registry.snapshots().spot,undefined);let row=registry.snapshots()[0];assert.equal(row.consecutiveFailures,2);registry.success('spot',{dataObservationAt:NOW});row=registry.snapshots()[0];assert.equal(row.recovering,true);registry.success('spot');assert.equal(registry.snapshots()[0].recovering,true);registry.success('spot');row=registry.snapshots()[0];assert.equal(row.recovering,false);assert.equal(row.lastRecoveredAt,now);});

test('部分端点缺失或失败时整体不得显示HEALTHY',()=>{const state=evaluateHealth({databaseAvailable:true,databaseWriteHealthy:true,leaseValid:true,serverTimeAvailable:true,clockOffsetMs:0,maxClockOffsetMs:5000,latestSuccessAt:NOW,partialEndpointFailure:true});assert.equal(state.state,'WARNING');assert.ok(state.reasons.includes('PARTIAL_ENDPOINT_FAILURE'));});

test('生产Postgres写入均通过同事务fencing校验',async()=>{const source=await readFile(new URL('../src/db/postgres.js',import.meta.url),'utf8');assert.match(source,/expires_at>clock_timestamp\(\)/);assert.match(source,/FOR SHARE/);for(const method of ['saveRaw','saveProvisionalBars','saveMarketBar','savePointFact','saveGaps','createBackfill','claimBackfill','heartbeatBackfill','finishBackfill','resolveGap','startRun','finishRun','saveAttempt','saveHealth','audit'])assert.match(source,new RegExp(`async ${method}\\b[\\s\\S]{0,1200}this\\.transaction`),`缺少事务fencing: ${method}`);});
