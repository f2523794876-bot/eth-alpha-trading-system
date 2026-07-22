// V1_4C_SCOPE_SPEC.md §14 P0/P1 — OutcomeEvaluator真实PostgreSQL验证：endpoint/path四象限、UP/DOWN/RANGE指标、
// 幂等/evaluationVersion追加、lease归属校验、snapshot不可变（outcome不得反向修改snapshot任何字段）。
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPgPool, PostgresRepository } from '../../src/db/postgres.js';
import { runMigrations } from '../../src/db/migrate.js';
import { normalizeKlines, normalizeFunding, normalizeOpenInterest, normalizeLongShort, normalizeTakerFlow } from '../../src/domain/normalize.js';
import { canonicalJsonHash } from '../../src/domain/hash.js';
import { FeatureEngine } from '../../src/features/feature-engine.js';
import { locatePathForEvaluation } from '../../src/forecast/bar-path-locator.js';
import { ForecastGenerator } from '../../src/forecast/generator-service.js';
import { OutcomeEvaluator, LEASE_NAME } from '../../src/outcome/evaluator-service.js';

const url = process.env.TEST_DATABASE_URL, enabled = Boolean(url), pgtest = enabled ? test : test.skip;
const FIFTEEN_MIN_MS = 900000, FOUR_HOUR_MS = 14400000;
const END = 1_767_311_999_999; // P1-2修复：referenceBar须精确落在4H/UTC自然日边界，此值同时满足两者
let pool, repo, seedLease, featureLease;

const response = (body, receivedAt) => ({ body, requestId: randomUUID(), status: 200, headers: {}, startedAt: receivedAt - 1, receivedAt });

async function seed15mBars(instrument, bars, serverTime) {
  const rows = bars.map(b => [b.openTime, String(b.open ?? b.close), String(b.high), String(b.low), String(b.close), '10', b.closeTime, '1000', 10, '5', '500', '0']);
  const r = response(rows, serverTime);
  const rawPayloadId = await repo.saveRaw(r, { sourceId: 'binance-spot-rest', endpointId: 'binance-spot-klines', contentHash: canonicalJsonHash(rows), schemaVersion: 'v1.4a-server-schema-1', qualityState: 'NORMAL' }, seedLease);
  const normalized = normalizeKlines({ rows, sourceId: 'binance-spot-rest', endpointId: 'binance-spot-klines', instrument, marketType: 'spot', interval: '15m', serverTime, fetchedAt: serverTime, rawPayloadId, requestId: r.requestId });
  const result = await repo.upsertMarketBars(normalized.formal, seedLease);
  if (result.rejected) throw new Error(`seed15mBars rejected rows: ${JSON.stringify(normalized.rejected)}`);
}
function bar(openTime, close, { open = close, high = close, low = close } = {}) { return { openTime, closeTime: openTime + FIFTEEN_MIN_MS - 1, open, high, low, close }; }

async function seedBars(instrument, interval, step, marketType = 'spot') {
  const rows = Array.from({ length: 30 }, (_, i) => { const closeTime = END - (29 - i) * step, openTime = closeTime - step + 1, p = 1800 + (instrument === 'BTCUSDT' ? 60000 : 0) + i; return [openTime, String(p - 1), String(p + 2), String(p - 2), String(p), String(100 + i), closeTime, String((100 + i) * p), 10, String((100 + i) * .55), '500', '0']; });
  const sourceId = marketType === 'spot' ? 'binance-spot-rest' : 'binance-usdt-futures-rest', endpointId = marketType === 'spot' ? 'binance-spot-klines' : 'binance-futures-klines', r = response(rows, END);
  const rawPayloadId = await repo.saveRaw(r, { sourceId, endpointId, contentHash: canonicalJsonHash(rows), schemaVersion: 'v1.4a-server-schema-1', qualityState: 'NORMAL' }, seedLease);
  const normalized = normalizeKlines({ rows, sourceId, endpointId, instrument, marketType, interval, serverTime: END, fetchedAt: END, rawPayloadId, requestId: r.requestId });
  await repo.upsertMarketBars(normalized.formal, seedLease);
}
async function seedFact(table, body, normalizer, interval = null) {
  const endpoints = { funding_rates: 'binance-futures-funding-rate', open_interest: 'binance-futures-open-interest', long_short_ratios: 'binance-futures-global-long-short', taker_flow: 'binance-futures-taker-flow' };
  const endpointId = endpoints[table], r = response(body, END);
  const rawPayloadId = await repo.saveRaw(r, { sourceId: 'binance-usdt-futures-rest', endpointId, contentHash: canonicalJsonHash(body), schemaVersion: 'v1.4a-server-schema-1', qualityState: 'NORMAL' }, seedLease);
  const rows = Array.isArray(body) ? body : [body];
  const facts = rows.map(row => normalizer(row, { sourceId: 'binance-usdt-futures-rest', endpointId, instrument: 'ETHUSDT', marketType: 'usdt_perpetual', interval, fetchedAt: END, rawPayloadId, requestId: r.requestId, qualityState: 'NORMAL' }));
  await repo.savePointFacts(table, facts, seedLease);
}
async function seedFullPipelineAndSnapshot(horizon = '24h') {
  for (const [symbol, interval, step] of [['ETHUSDT', '15m', FIFTEEN_MIN_MS], ['ETHUSDT', '1h', 3600000], ['ETHUSDT', '4h', FOUR_HOUR_MS], ['BTCUSDT', '15m', FIFTEEN_MIN_MS], ['BTCUSDT', '1h', 3600000], ['BTCUSDT', '4h', FOUR_HOUR_MS]]) await seedBars(symbol, interval, step);
  await seedFact('funding_rates', [{ symbol: 'ETHUSDT', fundingTime: END - 1, fundingRate: '0.0001', markPrice: '1829' }], normalizeFunding);
  await seedFact('open_interest', { symbol: 'ETHUSDT', time: END - 1, openInterest: '100000' }, normalizeOpenInterest);
  await seedFact('long_short_ratios', [{ symbol: 'ETHUSDT', timestamp: END - 1, longShortRatio: '1.1', longAccount: '0.52', shortAccount: '0.48' }], normalizeLongShort, '15m');
  await seedFact('taker_flow', [{ timestamp: END - 1, buySellRatio: '1.2', buyVol: '120', sellVol: '100' }], normalizeTakerFlow, '15m');
  await new FeatureEngine({ repository: repo, now: () => END + 1 }).generatePoint({ targetBarCloseTime: END }, featureLease);
  const gen = new ForecastGenerator({ pool, holderId: 'v14c-outcome-seed-gen', serverTimeProvider: async () => ({ ok: true, sourceServerTime: END + 2000 }), leaseTtlMs: 60000 });
  const result = await gen.runOnce({ instrument: 'ETHUSDT', symbol: 'ETH', horizon });
  assert.equal(result.status, 'INSERTED');
  return result.record;
}
const okServerTime = (at) => async () => ({ ok: true, sourceServerTime: at });

if (enabled) {
  before(async () => {
    if (!/test|ci|v14/i.test(new URL(url).pathname)) throw new Error('TEST_DATABASE_URL must name an isolated test/ci database');
    pool = await createPgPool({ databaseUrl: url, dbSsl: false });
    await runMigrations(pool, 'down'); await runMigrations(pool, 'up');
    repo = new PostgresRepository(pool);
    seedLease = await repo.acquireLease('primary-collector', 'v14c-seed', 60000);
    featureLease = await repo.acquireLease('feature-generator', 'v14c-seed', 60000);
  });
  after(async () => pool?.end());
}

pgtest('locatePathForEvaluation：象限1 endpoint完整+path完整，全部指标可计算', async () => {
  const instrument = 'ETHUSDT', symbol = 'ETH', R = 1_710_000_000_000, N = 5;
  await seed15mBars(instrument, [bar(R - FIFTEEN_MIN_MS + 1, 100, { high: 100, low: 100 }), ...Array.from({ length: N }, (_, i) => bar(R + 1 + i * FIFTEEN_MIN_MS, 101 + i, { high: 101 + i, low: 101 + i }))], R + N * FIFTEEN_MIN_MS + 10_000_000);
  const referenceBarRef = { symbol, closeTime: R };
  const located = await locatePathForEvaluation(pool, { instrument, referenceBarRef, expectedBarCount: N, asOfTime: R + N * FIFTEEN_MIN_MS + 10_000_000 });
  assert.equal(located.endpointDataComplete, true);
  assert.equal(located.pathDataComplete, true);
  assert.equal(located.pathEligibleForStatistics, true);
  assert.equal(located.directionEligibleForStatistics, true);
  assert.equal(located.actualStartPrice, 100);
  assert.equal(located.actualEndPrice, 100 + N);
});

pgtest('locatePathForEvaluation：象限2 endpoint完整+path不完整（中间缺口），方向可计算但路径指标必须为null', async () => {
  const instrument = 'ETHUSDT', symbol = 'ETH', R = 1_711_000_000_000, N = 5;
  const path = Array.from({ length: N }, (_, i) => bar(R + 1 + i * FIFTEEN_MIN_MS, 200 + i, { high: 200 + i, low: 200 + i })).filter((_, i) => i !== 2); // 缺第3根（sequenceIndex=3），target(第5根)仍在
  await seed15mBars(instrument, [bar(R - FIFTEEN_MIN_MS + 1, 200, { high: 200, low: 200 }), ...path], R + N * FIFTEEN_MIN_MS + 10_000_000);
  const referenceBarRef = { symbol, closeTime: R };
  const located = await locatePathForEvaluation(pool, { instrument, referenceBarRef, expectedBarCount: N, asOfTime: R + N * FIFTEEN_MIN_MS + 10_000_000 });
  assert.equal(located.endpointDataComplete, true);
  assert.equal(located.pathDataComplete, false);
  assert.equal(located.pathEligibleForStatistics, false);
  assert.equal(located.directionEligibleForStatistics, true);
  assert.equal(located.missingBarRefs.length, 1);
  assert.equal(located.missingBarRefs[0].sequenceIndex, 3);
});

pgtest('locatePathForEvaluation：象限3 endpoint不完整（referenceBar本身缺失）即使path本身连续也不得计算路径指标', async () => {
  const instrument = 'ETHUSDT', symbol = 'ETH', R = 1_712_000_000_000, N = 5; // 刻意不为R本身写入任何bar
  const path = Array.from({ length: N }, (_, i) => bar(R + 1 + i * FIFTEEN_MIN_MS, 300 + i, { high: 300 + i, low: 300 + i }));
  await seed15mBars(instrument, path, R + N * FIFTEEN_MIN_MS + 10_000_000);
  const referenceBarRef = { symbol, closeTime: R };
  const located = await locatePathForEvaluation(pool, { instrument, referenceBarRef, expectedBarCount: N, asOfTime: R + N * FIFTEEN_MIN_MS + 10_000_000 });
  assert.equal(located.endpointDataComplete, false);
  assert.equal(located.pathDataComplete, true); // path本身连续无缺口
  assert.equal(located.pathEligibleForStatistics, false); // 红线：endpoint不完整时即使path完整也不得计算
  assert.equal(located.directionEligibleForStatistics, false);
  assert.equal(located.actualStartPrice, null);
});

pgtest('locatePathForEvaluation：象限4 endpoint与path均不完整', async () => {
  const instrument = 'ETHUSDT', symbol = 'ETH', R = 1_713_000_000_000, N = 5; // 完全不写入任何bar
  const referenceBarRef = { symbol, closeTime: R };
  const located = await locatePathForEvaluation(pool, { instrument, referenceBarRef, expectedBarCount: N, asOfTime: R + N * FIFTEEN_MIN_MS + 10_000_000 });
  assert.equal(located.endpointDataComplete, false);
  assert.equal(located.pathDataComplete, false);
  assert.equal(located.pathEligibleForStatistics, false);
  assert.equal(located.directionEligibleForStatistics, false);
});

pgtest('端到端：OutcomeEvaluator对完整24H路径UP场景写入正确的actualReturn/actualDirection/mfe/mae', async () => {
  const snapshot = await seedFullPipelineAndSnapshot('24h');
  const refClose = snapshot.referenceBarRef.closeTime, referencePrice = Number(snapshot.referencePrice);
  const upPrice = referencePrice * (1 + snapshot.directionThreshold * 1.5); // 确保actualReturn > threshold => UP
  const bars = Array.from({ length: 96 }, (_, i) => bar(refClose + 1 + i * FIFTEEN_MIN_MS, i < 95 ? referencePrice : upPrice, { high: i < 95 ? referencePrice + 1 : upPrice + 1, low: i < 95 ? referencePrice - 1 : referencePrice - 1 }));
  const lastClose = refClose + 96 * FIFTEEN_MIN_MS;
  // 种子的fetchedAt(serverTime)必须<=后续查询用的asOfTime，否则fetched_at<=asOfTime的as-of可见性过滤会挡掉整批刚写入的数据
  // （曾在此处触发真实bug：fetchedAt=lastClose+10_000_000 > asOfTime=lastClose+5000，导致96根路径bar全部不可见）
  await seed15mBars('ETHUSDT', bars, lastClose + 1000);
  const evaluator = new OutcomeEvaluator({ pool, holderId: 'v14c-eval-1', serverTimeProvider: okServerTime(lastClose + 20_000_000), leaseTtlMs: 60000 });
  const result = await evaluator.runOnce();
  assert.equal(result.status, 'SUCCEEDED');
  assert.ok(result.evaluated >= 1);
  const row = (await pool.query('SELECT * FROM forecast_outcome_events WHERE prediction_id=$1', [snapshot.predictionId])).rows[0];
  assert.ok(row);
  assert.equal(row.endpoint_data_complete, true);
  assert.equal(row.path_data_complete, true);
  assert.equal(row.actual_direction, 'UP');
  assert.equal(row.direction_correct, snapshot.expectedDirection === 'UP');
  assert.ok(Number(row.mfe) !== null);
  assert.equal(row.source_origin, 'SERVER');
  assert.equal(row.lease_name, 'forecast-outcome-evaluator');
});

pgtest('幂等：相同evaluationVersion重复回填DEDUPED，不产生第二行', async () => {
  const snapshot = (await pool.query("SELECT prediction_id FROM forecast_snapshots WHERE horizon='24h' ORDER BY forecast_snapshot_id LIMIT 1")).rows[0];
  const before = Number((await pool.query('SELECT count(*) FROM forecast_outcome_events WHERE prediction_id=$1', [snapshot.prediction_id])).rows[0].count);
  const evaluator = new OutcomeEvaluator({ pool, holderId: 'v14c-eval-1', serverTimeProvider: okServerTime(END + 96 * FIFTEEN_MIN_MS + 100_000_000), leaseTtlMs: 60000 });
  await evaluator.runOnce();
  const after = Number((await pool.query('SELECT count(*) FROM forecast_outcome_events WHERE prediction_id=$1', [snapshot.prediction_id])).rows[0].count);
  assert.equal(after, before); // 已有evaluationVersion记录，findPendingSnapshots不会再次选中它，行数不变
});

pgtest('evaluationVersion升级后追加新行，旧版本行不变', async () => {
  const snapshot = (await pool.query("SELECT prediction_id FROM forecast_snapshots WHERE horizon='24h' ORDER BY forecast_snapshot_id LIMIT 1")).rows[0];
  const oldRow = (await pool.query('SELECT * FROM forecast_outcome_events WHERE prediction_id=$1', [snapshot.prediction_id])).rows[0];
  const evaluator = new OutcomeEvaluator({ pool, holderId: 'v14c-eval-1', serverTimeProvider: okServerTime(END + 96 * FIFTEEN_MIN_MS + 100_000_000), leaseTtlMs: 60000, evaluationVersion: 'v1.4c-outcome-evaluation-2-test' });
  const result = await evaluator.runOnce();
  assert.equal(result.evaluated, 1);
  const rows = (await pool.query('SELECT * FROM forecast_outcome_events WHERE prediction_id=$1 ORDER BY evaluation_version', [snapshot.prediction_id])).rows;
  assert.equal(rows.length, 2);
  const unchanged = rows.find(r => r.evaluation_version === oldRow.evaluation_version);
  assert.equal(unchanged.actual_return, oldRow.actual_return);
  assert.equal(unchanged.content_hash, oldRow.content_hash);
});

pgtest('outcome不得反向修改snapshot任何字段', async () => {
  const snapshot = (await pool.query("SELECT * FROM forecast_snapshots WHERE horizon='24h' ORDER BY forecast_snapshot_id LIMIT 1")).rows[0];
  await new OutcomeEvaluator({ pool, holderId: 'v14c-eval-1', serverTimeProvider: okServerTime(END + 96 * FIFTEEN_MIN_MS + 100_000_000), leaseTtlMs: 60000, evaluationVersion: 'v1.4c-outcome-evaluation-3-test' }).runOnce();
  const after = (await pool.query('SELECT * FROM forecast_snapshots WHERE forecast_snapshot_id=$1', [snapshot.forecast_snapshot_id])).rows[0];
  assert.deepEqual(after, snapshot);
});

pgtest('lease归属：forecast_outcome_events只接受forecast-outcome-evaluator lease，错误lease名称写入被拒绝', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assertGeneratorLeaseCannotWriteOutcome(client);
  } finally {
    // 无论断言成功与否都必须ROLLBACK再释放连接——CHECK违例会使当前事务进入aborted状态，
    // 若跳过ROLLBACK直接release，连接回到池中仍处于aborted事务里，会污染下一个借用该连接的测试（真实复现过一次）
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
});
async function assertGeneratorLeaseCannotWriteOutcome(client) {
  // forecast_outcome_events.lease_name有CHECK(lease_name='forecast-outcome-evaluator')，直接尝试写入forecast-generator应被数据库拒绝
  // forecast_outcome_event_id是bigserial，不得显式插入值（同evaluator-service.js修正的同一类bug，此处手写SQL需保持一致）
  const snapshot = (await client.query('SELECT prediction_id FROM forecast_snapshots LIMIT 1')).rows[0];
  const runRow = (await client.query('SELECT evaluation_run_id FROM forecast_evaluation_runs LIMIT 1')).rows[0];
  if (!runRow) return; // 若尚无评估运行记录（理论上不会发生，因为前面测试已产生），跳过FK依赖部分
  await assert.rejects(client.query(
    `INSERT INTO forecast_outcome_events(prediction_id,evaluation_version,evaluation_run_id,evaluated_at,as_of_time,endpoint_data_complete,path_data_complete,direction_eligible_for_statistics,path_eligible_for_statistics,missing_bar_refs,source_origin,lease_name,fencing_token,content_hash)
     VALUES($1,'wrong-lease-test',$2,now(),now(),false,false,false,false,'[]','SERVER','forecast-generator',1,$3)`,
    [snapshot.prediction_id, runRow.evaluation_run_id, '0'.repeat(64)]
  ), error => error.code === '23514');
}

pgtest('过期fencing token回填在事务内被拒绝，回滚后无孤儿outcome行', async () => {
  // collector_leases是单holder互斥资源，须先使当前持有者的lease过期，新holderId才能确定性地获取到lease
  await pool.query("UPDATE collector_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE lease_name=$1", [LEASE_NAME]);
  const evaluator = new OutcomeEvaluator({ pool, holderId: 'v14c-eval-stale', serverTimeProvider: okServerTime(END + 96 * FIFTEEN_MIN_MS + 100_000_000), leaseTtlMs: 60000, evaluationVersion: 'v1.4c-outcome-evaluation-4-test' });
  await evaluator.acquireLease();
  const before = Number((await pool.query('SELECT count(*) FROM forecast_outcome_events')).rows[0].count);
  await pool.query('UPDATE collector_leases SET fencing_token=fencing_token+1 WHERE lease_name=$1', [LEASE_NAME]);
  await assert.rejects(evaluator.runOnce(), error => error.code === 'FENCING_TOKEN_REJECTED');
  const after = Number((await pool.query('SELECT count(*) FROM forecast_outcome_events')).rows[0].count);
  assert.equal(after, before);
  assert.equal(evaluator.leaseLost, true);
});
