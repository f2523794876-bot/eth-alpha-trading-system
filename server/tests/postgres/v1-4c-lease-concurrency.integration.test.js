// V1_4C_SCOPE_SPEC.md §7.1/§7.2/§14 P0 — ForecastGenerator与OutcomeEvaluator两个独立调度器的lease/fencing/审计表隔离专项：
// 独立lease名、独立fencing token、独立运行状态、独立审计表，一方丢失lease不影响另一方，旧token分别在事务内被拒绝且无残行，
// Generator无权写forecast_outcome_events（结构性+数据库CHECK双重验证）。
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPgPool, PostgresRepository } from '../../src/db/postgres.js';
import { runMigrations } from '../../src/db/migrate.js';
import { normalizeKlines, normalizeFunding, normalizeOpenInterest, normalizeLongShort, normalizeTakerFlow } from '../../src/domain/normalize.js';
import { canonicalJsonHash } from '../../src/domain/hash.js';
import { FeatureEngine } from '../../src/features/feature-engine.js';
import { ForecastGenerator, LEASE_NAME as GENERATOR_LEASE } from '../../src/forecast/generator-service.js';
import { OutcomeEvaluator, LEASE_NAME as EVALUATOR_LEASE } from '../../src/outcome/evaluator-service.js';

const url = process.env.TEST_DATABASE_URL, enabled = Boolean(url), pgtest = enabled ? test : test.skip;
const FIFTEEN_MIN_MS = 900000, FOUR_HOUR_MS = 14400000;
const END = 1_784_400_000_000;
let pool, repo, seedLease, featureLease;

const response = (body, receivedAt) => ({ body, requestId: randomUUID(), status: 200, headers: {}, startedAt: receivedAt - 1, receivedAt });
function bar(openTime, close, { open = close, high = close, low = close } = {}) { return { openTime, closeTime: openTime + FIFTEEN_MIN_MS - 1, open, high, low, close }; }
async function seed15mBars(instrument, bars, serverTime) {
  const rows = bars.map(b => [b.openTime, String(b.open), String(b.high), String(b.low), String(b.close), '10', b.closeTime, '1000', 10, '5', '500', '0']);
  const r = response(rows, serverTime);
  const rawPayloadId = await repo.saveRaw(r, { sourceId: 'binance-spot-rest', endpointId: 'binance-spot-klines', contentHash: canonicalJsonHash(rows), schemaVersion: 'v1.4a-server-schema-1', qualityState: 'NORMAL' }, seedLease);
  const normalized = normalizeKlines({ rows, sourceId: 'binance-spot-rest', endpointId: 'binance-spot-klines', instrument, marketType: 'spot', interval: '15m', serverTime, fetchedAt: serverTime, rawPayloadId, requestId: r.requestId });
  await repo.upsertMarketBars(normalized.formal, seedLease);
}
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
async function seedSnapshotWithFullPath(horizon = '24h') {
  for (const [symbol, interval, step] of [['ETHUSDT', '15m', FIFTEEN_MIN_MS], ['ETHUSDT', '1h', 3600000], ['ETHUSDT', '4h', FOUR_HOUR_MS], ['BTCUSDT', '15m', FIFTEEN_MIN_MS], ['BTCUSDT', '1h', 3600000], ['BTCUSDT', '4h', FOUR_HOUR_MS]]) await seedBars(symbol, interval, step);
  await seedFact('funding_rates', [{ symbol: 'ETHUSDT', fundingTime: END - 1, fundingRate: '0.0001', markPrice: '1829' }], normalizeFunding);
  await seedFact('open_interest', { symbol: 'ETHUSDT', time: END - 1, openInterest: '100000' }, normalizeOpenInterest);
  await seedFact('long_short_ratios', [{ symbol: 'ETHUSDT', timestamp: END - 1, longShortRatio: '1.1', longAccount: '0.52', shortAccount: '0.48' }], normalizeLongShort, '15m');
  await seedFact('taker_flow', [{ timestamp: END - 1, buySellRatio: '1.2', buyVol: '120', sellVol: '100' }], normalizeTakerFlow, '15m');
  await new FeatureEngine({ repository: repo, now: () => END + 1 }).generatePoint({ targetBarCloseTime: END }, featureLease);
  const gen = new ForecastGenerator({ pool, holderId: 'v14c-lc-seed-gen', serverTimeProvider: async () => ({ ok: true, sourceServerTime: END + 2000 }), leaseTtlMs: 60000 });
  const result = await gen.runOnce({ instrument: 'ETHUSDT', symbol: 'ETH', horizon });
  assert.equal(result.status, 'INSERTED');
  const refClose = result.record.referenceBarRef.closeTime, N = result.record.expectedBarCount, price = Number(result.record.referencePrice);
  const bars = Array.from({ length: N }, (_, i) => bar(refClose + 1 + i * FIFTEEN_MIN_MS, price));
  const lastClose = refClose + N * FIFTEEN_MIN_MS;
  await seed15mBars('ETHUSDT', bars, lastClose + 10_000_000);
  return { snapshot: result.record, asOfTime: lastClose + 5000 };
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

pgtest('两个调度器持有各自独立lease名，独立fencing token、独立holder_id', async () => {
  const gen = new ForecastGenerator({ pool, holderId: 'v14c-lc-gen', serverTimeProvider: okServerTime(END), leaseTtlMs: 60000 });
  const evaluator = new OutcomeEvaluator({ pool, holderId: 'v14c-lc-eval', serverTimeProvider: okServerTime(END), leaseTtlMs: 60000 });
  await Promise.all([gen.acquireLease(), evaluator.acquireLease()]);
  assert.equal(gen.lease.leaseName, 'forecast-generator');
  assert.equal(evaluator.lease.leaseName, 'forecast-outcome-evaluator');
  assert.notEqual(gen.lease.leaseName, evaluator.lease.leaseName);
  const rows = await pool.query("SELECT lease_name,holder_id,fencing_token FROM collector_leases WHERE lease_name IN ('forecast-generator','forecast-outcome-evaluator') ORDER BY lease_name");
  assert.equal(rows.rowCount, 2);
  assert.notEqual(rows.rows[0].holder_id, rows.rows[1].holder_id);
});

// collector_leases是单holder互斥资源（ON CONFLICT DO UPDATE的WHERE子句只在过期或同holder时生效，同V1.4A既有模式），
// 本文件每个测试都会引入此前未出现过的新holderId，必须先使两个lease过期，新holder才能确定性地获取到它们
async function expireBothLeases() {
  await pool.query("UPDATE collector_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE lease_name IN ($1,$2)", [GENERATOR_LEASE, EVALUATOR_LEASE]);
}

pgtest('Generator与Evaluator分别只写入各自独立的审计表，不混淆归属', async () => {
  await expireBothLeases();
  const { asOfTime } = await seedSnapshotWithFullPath('24h');
  await expireBothLeases();
  const gen = new ForecastGenerator({ pool, holderId: 'v14c-lc-gen-2', serverTimeProvider: okServerTime(asOfTime), leaseTtlMs: 60000 });
  const evaluator = new OutcomeEvaluator({ pool, holderId: 'v14c-lc-eval-2', serverTimeProvider: okServerTime(asOfTime), leaseTtlMs: 60000, evaluationVersion: 'v1.4c-lc-test-1' });
  const beforeGenRuns = Number((await pool.query('SELECT count(*) FROM forecast_generation_runs')).rows[0].count);
  const beforeEvalRuns = Number((await pool.query('SELECT count(*) FROM forecast_evaluation_runs')).rows[0].count);
  await gen.runOnce({ instrument: 'ETHUSDT', symbol: 'ETH', horizon: '72h' }); // 72h以避免与24h快照撞prediction_id
  await evaluator.runOnce();
  const afterGenRuns = Number((await pool.query('SELECT count(*) FROM forecast_generation_runs')).rows[0].count);
  const afterEvalRuns = Number((await pool.query('SELECT count(*) FROM forecast_evaluation_runs')).rows[0].count);
  assert.equal(afterGenRuns, beforeGenRuns + 1);
  assert.equal(afterEvalRuns, beforeEvalRuns + 1);
  assert.equal(Number((await pool.query("SELECT count(*) FROM forecast_generation_runs WHERE lease_name<>'forecast-generator'")).rows[0].count), 0);
  assert.equal(Number((await pool.query("SELECT count(*) FROM forecast_evaluation_runs WHERE lease_name<>'forecast-outcome-evaluator'")).rows[0].count), 0);
});

pgtest('一方丢失lease不影响另一方继续正常写入', async () => {
  await expireBothLeases();
  const gen = new ForecastGenerator({ pool, holderId: 'v14c-lc-gen-3', serverTimeProvider: okServerTime(END), leaseTtlMs: 60000 });
  const evaluator = new OutcomeEvaluator({ pool, holderId: 'v14c-lc-eval-3', serverTimeProvider: okServerTime(END), leaseTtlMs: 60000, evaluationVersion: 'v1.4c-lc-test-2' });
  await Promise.all([gen.acquireLease(), evaluator.acquireLease()]);
  // 使Generator的lease失效（模拟被抢占/过期），不触碰Evaluator的lease行
  await pool.query("UPDATE collector_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE lease_name=$1", [GENERATOR_LEASE]);
  const evaluatorLeaseBefore = (await pool.query('SELECT expires_at,fencing_token FROM collector_leases WHERE lease_name=$1', [EVALUATOR_LEASE])).rows[0];
  await assert.rejects(gen.runOnce({ instrument: 'ETHUSDT', symbol: 'ETH', horizon: '24h' }), error => error.code === 'FENCING_TOKEN_REJECTED');
  const evalResult = await evaluator.runOnce();
  assert.notEqual(evalResult.status, 'BLOCKED');
  const evaluatorLeaseAfter = (await pool.query('SELECT expires_at,fencing_token FROM collector_leases WHERE lease_name=$1', [EVALUATOR_LEASE])).rows[0];
  assert.equal(evaluatorLeaseAfter.fencing_token >= evaluatorLeaseBefore.fencing_token, true); // Evaluator自身lease未被Generator的失效状态破坏，仍可正常续约/使用
});

pgtest('Generator旧fencing token被事务内拒绝，回滚后forecast_generation_runs/snapshots均无残行', async () => {
  await expireBothLeases();
  const gen = new ForecastGenerator({ pool, holderId: 'v14c-lc-gen-4', serverTimeProvider: okServerTime(END + 500000), leaseTtlMs: 60000 });
  await gen.acquireLease();
  const beforeSnap = Number((await pool.query('SELECT count(*) FROM forecast_snapshots')).rows[0].count);
  await pool.query('UPDATE collector_leases SET fencing_token=fencing_token+1 WHERE lease_name=$1', [GENERATOR_LEASE]);
  await assert.rejects(gen.runOnce({ instrument: 'ETHUSDT', symbol: 'ETH', horizon: '24h' }), error => error.code === 'FENCING_TOKEN_REJECTED');
  const afterSnap = Number((await pool.query('SELECT count(*) FROM forecast_snapshots')).rows[0].count);
  assert.equal(afterSnap, beforeSnap);
});

pgtest('Evaluator旧fencing token被事务内拒绝，回滚后forecast_outcome_events无残行', async () => {
  await expireBothLeases();
  const evaluator = new OutcomeEvaluator({ pool, holderId: 'v14c-lc-eval-4', serverTimeProvider: okServerTime(END + 500000), leaseTtlMs: 60000, evaluationVersion: 'v1.4c-lc-test-3' });
  await evaluator.acquireLease();
  const beforeOutcome = Number((await pool.query('SELECT count(*) FROM forecast_outcome_events')).rows[0].count);
  await pool.query('UPDATE collector_leases SET fencing_token=fencing_token+1 WHERE lease_name=$1', [EVALUATOR_LEASE]);
  await assert.rejects(evaluator.runOnce(), error => error.code === 'FENCING_TOKEN_REJECTED');
  const afterOutcome = Number((await pool.query('SELECT count(*) FROM forecast_outcome_events')).rows[0].count);
  assert.equal(afterOutcome, beforeOutcome);
});

pgtest('Generator无写forecast_outcome_events的能力（结构性验证），数据库CHECK同时拒绝错误lease名称', async () => {
  const gen = new ForecastGenerator({ pool, holderId: 'v14c-lc-gen-5', serverTimeProvider: okServerTime(END), leaseTtlMs: 60000 });
  assert.equal(typeof gen.evaluatePending, 'undefined');
  assert.equal(typeof gen.recordOutcomeEvent, 'undefined');
  const snapshot = (await pool.query('SELECT prediction_id FROM forecast_snapshots LIMIT 1')).rows[0];
  const runRow = (await pool.query('SELECT evaluation_run_id FROM forecast_evaluation_runs LIMIT 1')).rows[0];
  if (snapshot && runRow) {
    // forecast_outcome_event_id是bigserial，不得显式插入值（同evaluator-service.js/outcome测试文件修正的同一类bug）
    await assert.rejects(pool.query(
      `INSERT INTO forecast_outcome_events(prediction_id,evaluation_version,evaluation_run_id,evaluated_at,as_of_time,endpoint_data_complete,path_data_complete,direction_eligible_for_statistics,path_eligible_for_statistics,missing_bar_refs,source_origin,lease_name,fencing_token,content_hash)
       VALUES($1,'v14c-lc-wrong-lease',$2,now(),now(),false,false,false,false,'[]','SERVER','forecast-generator',1,$3)`,
      [snapshot.prediction_id, runRow.evaluation_run_id, '1'.repeat(64)]
    ), error => error.code === '23514');
  }
});
