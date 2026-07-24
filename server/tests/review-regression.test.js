import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MemoryRepository } from '../src/db/memory.js';
import { normalizeFunding, normalizeKlines, normalizeLongShort, normalizeOpenInterest, normalizeTakerFlow } from '../src/domain/normalize.js';
import { EndpointHealthRegistry, evaluateHealth } from '../src/health/evaluator.js';
import { PostgresRepository } from '../src/db/postgres.js';

const NOW=1_784_000_000_000, OBSERVED=NOW-60_000;
const context={sourceId:'binance-usdt-futures-rest',endpointId:'binance-futures-open-interest',instrument:'ETHUSDT',marketType:'usdt_perpetual',interval:'15m',fetchedAt:NOW,rawPayloadId:'raw',requestId:'00000000-0000-0000-0000-000000000001',qualityState:'NORMAL'};

test('旧fencing token过期后全部关键写入默认拒绝',async()=>{let now=NOW;const repo=new MemoryRepository({requireLease:true,now:()=>now});const a=await repo.acquireLease('primary-collector','a',10,now);now+=11;const b=await repo.acquireLease('primary-collector','b',1000,now);assert.ok(b.fencingToken>a.fencingToken);for(const write of [()=>repo.saveHealth({state:'HEALTHY'},a),()=>repo.audit({eventType:'OLD'},a),()=>repo.saveGaps([],a),()=>repo.startRun({runId:'x'},a)])await assert.rejects(write,error=>error.code==='FENCING_TOKEN_REJECTED');await repo.saveHealth({state:'HEALTHY'},b);assert.equal(repo.health.length,1);});

test('四类点状事实完整携带冻结DataVintageRef时间链',()=>{const rows=[normalizeFunding({symbol:'ETHUSDT',fundingTime:OBSERVED,fundingRate:'0.1'},context),normalizeOpenInterest({symbol:'ETHUSDT',time:OBSERVED,openInterest:'1'},context),normalizeLongShort({symbol:'ETHUSDT',timestamp:OBSERVED,longShortRatio:'1',longAccount:'0.5',shortAccount:'0.5'},context),normalizeTakerFlow({timestamp:OBSERVED,buySellRatio:'1',buyVol:'1',sellVol:'1'},context)];for(const row of rows){assert.equal(row.publishedAt,OBSERVED);assert.equal(row.availableAt,OBSERVED);assert.equal(row.firstAvailableAt,NOW);assert.equal(row.fetchedAt,NOW);assert.equal(row.dataVintageRef.vintageId,row.vintageId);}});

test('迁移002包含原始层不可变、四表完整时间红线和回补状态机',async()=>{const sql=await readFile(new URL('../migrations/002_v1_4a_review_fixes.up.sql',import.meta.url),'utf8');assert.match(sql,/raw_payloads_no_update/);assert.match(sql,/raw_payloads_no_delete/);for(const name of ['funding_time_order','open_interest_time_order','long_short_time_order','taker_flow_time_order'])assert.match(sql,new RegExp(name));for(const state of ['PENDING','RUNNING','RETRY_WAIT','SUCCEEDED','FAILED_PERMANENT'])assert.match(sql,new RegExp(state));});

test('迁移器使用PostgreSQL advisory lock且systemd启动前执行迁移',async()=>{const migration=await readFile(new URL('../src/db/migrate.js',import.meta.url),'utf8');const unit=await readFile(new URL('../../deploy/systemd/eth-alpha-collector.service',import.meta.url),'utf8');assert.match(migration,/pg_advisory_lock/);assert.match(migration,/pg_advisory_unlock/);assert.match(unit,/ExecStartPre=.*migrate/);});

test('端点失败跨周期累计并经三次连续成功才从RECOVERING恢复',()=>{let now=NOW;const registry=new EndpointHealthRegistry({spot:30000},()=>now);registry.failure('spot',{httpStatus:500,code:'UPSTREAM'});now+=30000;registry.failure('spot',{httpStatus:500,code:'UPSTREAM'});assert.equal(registry.snapshots().spot,undefined);let row=registry.snapshots()[0];assert.equal(row.consecutiveFailures,2);registry.success('spot',{dataObservationAt:NOW});row=registry.snapshots()[0];assert.equal(row.recovering,true);registry.success('spot');assert.equal(registry.snapshots()[0].recovering,true);registry.success('spot');row=registry.snapshots()[0];assert.equal(row.recovering,false);assert.equal(row.lastRecoveredAt,now);});

test('部分端点缺失或失败时整体不得显示HEALTHY',()=>{const state=evaluateHealth({databaseAvailable:true,databaseWriteHealthy:true,leaseValid:true,serverTimeAvailable:true,clockOffsetMs:0,maxClockOffsetMs:5000,latestSuccessAt:NOW,partialEndpointFailure:true});assert.equal(state.state,'WARNING');assert.ok(state.reasons.includes('PARTIAL_ENDPOINT_FAILURE'));});

test('生产Postgres写入均通过同事务fencing校验',async()=>{const source=await readFile(new URL('../src/db/postgres.js',import.meta.url),'utf8');assert.match(source,/expires_at>clock_timestamp\(\)/);assert.match(source,/FOR SHARE/);for(const method of ['saveRaw','saveProvisionalBars','saveMarketBar','savePointFact','saveGaps','createBackfill','claimBackfill','heartbeatBackfill','finishBackfill','resolveGap','startRun','finishRun','saveAttempt','saveHealth','audit'])assert.match(source,new RegExp(`async ${method}\\b[\\s\\S]{0,1200}this\\.transaction`),`缺少事务fencing: ${method}`);});

test('market_bars生产INSERT目标列、值和绑定参数严格一一对应',async()=>{const queries=[];const client={async query(sql,values=[]){queries.push({sql,values});if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK')return{rowCount:0,rows:[]};if(/SELECT fencing_token/.test(sql))return{rowCount:1,rows:[{fencing_token:1}]};if(/SELECT pg_advisory_xact_lock/.test(sql))return{rowCount:1,rows:[{}]};if(/SELECT \* FROM market_bars/.test(sql))return{rowCount:0,rows:[]};if(/INSERT INTO market_bars/.test(sql))return{rowCount:1,rows:[{market_bar_id:7}]};return{rowCount:0,rows:[]};},release(){}};const repo=new PostgresRepository({connect:async()=>client});const normalized=normalizeKlines({rows:[[NOW-900000,'100','102','99','101','10',NOW-1,'1000',12,'5','500','0']],sourceId:'binance-spot-rest',endpointId:'binance-spot-klines',instrument:'ETHUSDT',marketType:'spot',interval:'15m',serverTime:NOW,fetchedAt:NOW,rawPayloadId:'00000000-0000-0000-0000-000000000001',requestId:'00000000-0000-0000-0000-000000000002'}).formal[0];assert.equal(await repo.saveMarketBar(normalized,{leaseName:'primary-collector',holderId:'test',fencingToken:1}),'INSERTED');const insert=queries.find(x=>/INSERT INTO market_bars/.test(x.sql));const columns=insert.sql.match(/market_bars\(([^)]+)\)/)[1].split(',');const placeholders=[...insert.sql.matchAll(/\$(\d+)/g)].map(x=>Number(x[1]));assert.equal(columns.length,30);assert.equal(insert.values.length,30);assert.deepEqual(placeholders,Array.from({length:30},(_,index)=>index+1));assert.equal(insert.values[5].getTime(),normalized.openTime);assert.equal(insert.values[18].getTime(),normalized.closeTime);assert.equal(insert.values[29],normalized.contentHash);});

test('四类点状事实生产INSERT直接调用列映射函数且参数完整',async()=>{const cases=[['funding_rates',normalizeFunding({symbol:'ETHUSDT',fundingTime:OBSERVED,fundingRate:'-0.0001',markPrice:'100'},context)],['open_interest',normalizeOpenInterest({symbol:'ETHUSDT',time:OBSERVED,openInterest:'10'},context)],['long_short_ratios',normalizeLongShort({symbol:'ETHUSDT',timestamp:OBSERVED,longShortRatio:'1',longAccount:'0.5',shortAccount:'0.5'},context)],['taker_flow',normalizeTakerFlow({timestamp:OBSERVED,buySellRatio:'1',buyVol:'1',sellVol:'1'},context)]];for(const [table,fact] of cases){const queries=[];const client={async query(sql,values=[]){queries.push({sql,values});if(/SELECT fencing_token/.test(sql))return{rowCount:1,rows:[{fencing_token:1}]};if(new RegExp(`SELECT \\* FROM ${table}`).test(sql))return{rowCount:0,rows:[]};return{rowCount:1,rows:[]};},release(){}};const repo=new PostgresRepository({connect:async()=>client});assert.equal(await repo.savePointFact(table,fact,{leaseName:'primary-collector',holderId:'test',fencingToken:1}),'INSERTED');const insert=queries.find(x=>x.sql.startsWith(`INSERT INTO ${table}`));const columns=insert.sql.match(new RegExp(`${table}\\(([^)]+)\\)`))[1].split(',');const placeholders=[...insert.sql.matchAll(/\$(\d+)/g)].map(x=>Number(x[1]));assert.equal(columns.length,insert.values.length,table);assert.deepEqual(placeholders,Array.from({length:insert.values.length},(_,index)=>index+1),table);assert.equal(insert.values[columns.indexOf('content_hash')],fact.contentHash,table);assert.equal(insert.values[columns.indexOf('observation_time')].getTime(),fact.observedAt,table);}});

test('CI将PostgreSQL强制门禁与真实REST地区可达性分成独立Job',async()=>{const workflow=await readFile(new URL('../../.github/workflows/v1-4a-postgres-integration.yml',import.meta.url),'utf8');const databaseJob=workflow.slice(workflow.indexOf('  postgres-production-path:'),workflow.indexOf('  rest-postgres-live-path:'));const liveJob=workflow.slice(workflow.indexOf('  rest-postgres-live-path:'));assert.match(databaseJob,/npm run test:postgres/);assert.doesNotMatch(databaseJob,/test:postgres:live/);assert.match(liveJob,/needs: postgres-production-path/);assert.match(liveJob,/RUN_LIVE_REST: "1"/);assert.match(liveJob,/EXTERNAL_REGION_BLOCKED/);assert.doesNotMatch(workflow,/continue-on-error/);});

test('PostgreSQL强制组合命令固定接入13+4+9项revision时间推进门禁',async()=>{const packageJson=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));assert.equal(packageJson.scripts['test:postgres:revision'],'node --test tests/postgres/v1-4b-revision-time-progression.integration.test.js');const workflow=await readFile(new URL('../../.github/workflows/v1-4a-postgres-integration.yml',import.meta.url),'utf8');const databaseJob=workflow.slice(workflow.indexOf('  postgres-production-path:'),workflow.indexOf('  rest-postgres-live-path:'));assert.match(databaseJob,/run: npm run test:postgres/);assert.doesNotMatch(databaseJob,/continue-on-error/);});

test('V1_4C_SCOPE_SPEC.md §16第8步：V1.4C三组真实PostgreSQL测试与package.json在同一提交内接入test:postgres强制门禁',async()=>{
  const packageJson=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
  const scripts=packageJson.scripts;
  assert.equal(scripts['test:postgres:v1.4c-forecast'],'node --test tests/postgres/v1-4c-forecast.integration.test.js');
  assert.equal(scripts['test:postgres:v1.4c-outcome'],'node --test tests/postgres/v1-4c-outcome.integration.test.js');
  assert.equal(scripts['test:postgres:v1.4c-lease'],'node --test tests/postgres/v1-4c-lease-concurrency.integration.test.js');
  for(const step of ['test:postgres:v1.4a','test:postgres:features','test:postgres:revision','test:postgres:v1.4c-forecast','test:postgres:v1.4c-outcome','test:postgres:v1.4c-lease'])
    assert.match(scripts['test:postgres'],new RegExp(`npm run ${step.replace(/\./g,'\\.')}`),`test:postgres组合命令缺少${step}`);
  for(const file of ['v1-4c-forecast.integration.test.js','v1-4c-outcome.integration.test.js','v1-4c-lease-concurrency.integration.test.js']){
    const source=await readFile(new URL(`./postgres/${file}`,import.meta.url),'utf8');
    assert.match(source,/TEST_DATABASE_URL/,`${file}必须使用TEST_DATABASE_URL隔离测试库`);
    assert.match(source,/test\|ci\|v14/,`${file}必须校验isolated test/ci数据库命名`);
    assert.doesNotMatch(source,/\.only\(/,`${file}不得使用.only`);
    assert.doesNotMatch(source,/test\.skip\(/,`${file}不得使用test.skip（除pgtest的enabled=false降级路径外）`);
  }
  const workflow=await readFile(new URL('../../.github/workflows/v1-4a-postgres-integration.yml',import.meta.url),'utf8');
  const databaseJob=workflow.slice(workflow.indexOf('  postgres-production-path:'),workflow.indexOf('  rest-postgres-live-path:'));
  assert.match(databaseJob,/run: npm run test:postgres/,'CI必须继续通过组合命令test:postgres间接执行V1.4C三组测试，不得另起未接线的Job');
});

test('真实链保留生产数据库写入断言且仅精确451调用SKIP',async()=>{const source=await readFile(new URL('./live/postgres-live-e2e.test.js',import.meta.url),'utf8');assert.match(source,/runLiveRestOperation/);assert.match(source,/t\.skip\('EXTERNAL_REGION_BLOCKED/);for(const productionCall of ['collector.collectBars','collector.collectPoint','collector.collectBarsFromResponse','collector.readiness'])assert.ok(source.includes(productionCall),productionCall);assert.doesNotMatch(source,/MemoryRepository/);});

test('Codex复审P0-1修复：ForecastGenerator/OutcomeEvaluator已接入生产启动入口，独立于CollectorService的start/stop',async()=>{
  const indexSource=await readFile(new URL('../src/index.js',import.meta.url),'utf8');
  assert.match(indexSource,/import\s*\{\s*ForecastGenerator\s*\}\s*from\s*'\.\/forecast\/generator-service\.js'/,'index.js必须导入ForecastGenerator');
  assert.match(indexSource,/import\s*\{\s*OutcomeEvaluator\s*\}\s*from\s*'\.\/outcome\/evaluator-service\.js'/,'index.js必须导入OutcomeEvaluator');
  assert.match(indexSource,/new ForecastGenerator\(/,'index.js必须实例化ForecastGenerator');
  assert.match(indexSource,/new OutcomeEvaluator\(/,'index.js必须实例化OutcomeEvaluator');
  assert.match(indexSource,/forecastGenerator\.start\(/,'bootstrap()必须调用forecastGenerator.start()');
  assert.match(indexSource,/outcomeEvaluator\.start\(/,'bootstrap()必须调用outcomeEvaluator.start()');
  assert.match(indexSource,/forecastGenerator\.stop\(\)/,'graceful shutdown必须包含forecastGenerator.stop()');
  assert.match(indexSource,/outcomeEvaluator\.stop\(\)/,'graceful shutdown必须包含outcomeEvaluator.stop()');
  // 两者必须各自持有独立holderId（不得与collector共用同一个collectorId直接作为holderId，避免与primary-collector lease混淆）
  assert.match(indexSource,/forecast-generator/);
  assert.match(indexSource,/outcome-evaluator/);
});

test('V1.4C生产生命周期接入独立FeatureGenerator并以精确时间键保障特征先于预测',async()=>{
  const packageJson=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
  const featureEntry=await readFile(new URL('../src/features/generator-service-entry.js',import.meta.url),'utf8');
  const featureService=await readFile(new URL('../src/features/generator-service.js',import.meta.url),'utf8');
  const forecastService=await readFile(new URL('../src/forecast/generator-service.js',import.meta.url),'utf8');
  const featureUnit=await readFile(new URL('../../deploy/systemd/eth-alpha-feature-generator.service',import.meta.url),'utf8');
  const collectorUnit=await readFile(new URL('../../deploy/systemd/eth-alpha-collector.service',import.meta.url),'utf8');
  assert.equal(packageJson.scripts['features:serve'],'node src/features/generator-service-entry.js');
  assert.match(featureEntry,/new FeatureGeneratorService\(/);
  assert.match(featureEntry,/process\.once\('SIGTERM'/);
  assert.match(featureService,/FEATURE_GENERATOR_LEASE\s*=\s*'feature-generator'/);
  assert.match(featureService,/listPendingFeatureTargets/);
  assert.match(featureService,/scheduleHeartbeat/);
  assert.match(forecastService,/waitForExactFeature/);
  assert.match(forecastService,/target_bar_close_time=to_timestamp\(\$2\/1000\.0\)/);
  assert.doesNotMatch(forecastService,/target_bar_close_time<=to_timestamp\(\$2\/1000\.0\)/);
  assert.match(featureUnit,/ExecStart=.*generator-service-entry\.js/);
  assert.match(collectorUnit,/Wants=.*eth-alpha-feature-generator\.service/);
  assert.doesNotMatch(collectorUnit,/Requires=.*eth-alpha-feature-generator\.service/);
});

test('Codex复审P1-1修复：Generator/Evaluator各自实现独立heartbeat续约与graceful shutdown（复用CollectorService心跳模式）',async()=>{
  const genSource=await readFile(new URL('../src/forecast/generator-service.js',import.meta.url),'utf8');
  const evalSource=await readFile(new URL('../src/outcome/evaluator-service.js',import.meta.url),'utf8');
  for(const [name,source] of [['generator-service.js',genSource],['evaluator-service.js',evalSource]]){
    assert.match(source,/async start\(/,`${name}缺少start()生产启动方法`);
    assert.match(source,/async heartbeat\(\)/,`${name}缺少heartbeat()续约方法`);
    assert.match(source,/scheduleHeartbeat\(/,`${name}缺少独立心跳定时器scheduleHeartbeat()`);
    assert.match(source,/UPDATE collector_leases SET heartbeat_at=clock_timestamp\(\)/,`${name}的heartbeat()必须真正续约expires_at，而非空实现`);
    assert.match(source,/this\.loseLease\('LEASE_LOST'\)/,`${name}续约失败必须调用loseLease()立即停止自身调度`);
    assert.match(source,/this\.abortController\s*=\s*new AbortController\(\)/,`${name}必须持有独立abortController`);
    assert.match(source,/async stop\(\)/,`${name}缺少graceful shutdown的stop()方法`);
  }
});

test('Codex复审P1-2修复：referenceBar选择须精确对齐生成节奏边界，不再是"最近一根已收盘bar"',async()=>{
  const locatorSource=await readFile(new URL('../src/forecast/bar-path-locator.js',import.meta.url),'utf8');
  assert.match(locatorSource,/export function computeAlignedReferenceCloseTime/,'bar-path-locator.js必须导出节奏边界计算函数');
  assert.match(locatorSource,/close_time=to_timestamp\(\$2\/1000\.0\)/,'referenceBar查询必须是精确相等匹配对齐边界，不得用ORDER BY ... LIMIT 1回退到"最近一根"');
  assert.doesNotMatch(locatorSource,/ORDER BY open_time DESC, revision_number DESC LIMIT 1[\s\S]{0,50}\[instrument, asOfTime\]/,'referenceBar查询不得再退化为"最近一根已收盘bar"模式');
  const testResultsSource=await readFile(new URL('../../V1_4C_TEST_RESULTS.md',import.meta.url),'utf8');
  assert.doesNotMatch(testResultsSource,/天然保证/,'V1_4C_TEST_RESULTS.md不得再声称生成节奏由UNIQUE(prediction_id)"天然保证"——该结论已被Codex复审判定为错误并更正');
  assert.match(testResultsSource,/computeAlignedReferenceCloseTime|节奏边界|RHYTHM_END/,'V1_4C_TEST_RESULTS.md必须记录P1-2节奏门禁的真实验证方式（而非UNIQUE约束）');
});
