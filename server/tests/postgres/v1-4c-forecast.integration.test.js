// V1_4C_SCOPE_SPEC.md §14 P0/P1 — ForecastGenerator真实PostgreSQL验证：4H ATR14取数深度、23根连续计数回放、
// 端到端生成事务、幂等/并发、不可变触发器、ON DELETE RESTRICT、服务器时间fail closed、旧fencing token回滚无残行。
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPgPool, PostgresRepository } from '../../src/db/postgres.js';
import { runMigrations } from '../../src/db/migrate.js';
import { normalizeKlines, normalizeFunding, normalizeOpenInterest, normalizeLongShort, normalizeTakerFlow } from '../../src/domain/normalize.js';
import { canonicalJsonHash } from '../../src/domain/hash.js';
import { FeatureEngine } from '../../src/features/feature-engine.js';
import { computeFourHourAtr14, computeConsecutiveBreakoutBars } from '../../src/forecast/bar-path-locator.js';
import { ForecastGenerator, LEASE_NAME } from '../../src/forecast/generator-service.js';
import { ALGORITHM_VERSION } from '../../src/forecast/forecast-version.js';

import { isPostgresIntegrationTestAuthorized } from './_pg-integration-gate.js';

const url = process.env.TEST_DATABASE_URL, enabled = isPostgresIntegrationTestAuthorized(url), pgtest = enabled ? test : test.skip;
const FOUR_HOUR_MS = 14400000;
const END = 1_767_311_999_999; // P1-2修复后referenceBar须精确落在4H/UTC自然日边界，此锚点=2026-01-01T23:59:59.999Z同时满足两者（(END+1)%FOUR_HOUR_MS===0 且 (END+1)%ONE_DAY_MS===0）
let pool, repo, seedLease, featureLease;

const response = (body, receivedAt = END + 5_000_000) => ({ body, requestId: randomUUID(), status: 200, headers: {}, startedAt: receivedAt - 1, receivedAt });

// 精确4H bar种子：用于ATR14/连续计数手算对照，与全流程种子（ramp形态）使用完全不同的时间窗口，避免互相污染
// serverTime同时充当normalizeKlines的fetchedAt——查询侧asOfTime必须>=fetchedAt才能看到这批数据（as-of可见性红线），
// 调用方传入的asOfTime若仅等于某根bar自身的closeTime（早于fetchedAt），会被查询的fetched_at<=asOfTime条件过滤掉全部bar
async function seed4hBars(instrument, bars, { serverTime = bars[bars.length - 1].closeTime + 1000 } = {}) {
  const rows = bars.map(b => [b.openTime, String(b.open), String(b.high), String(b.low), String(b.close), '10', b.closeTime, '1000', 10, '5', '500', '0']);
  const r = response(rows, serverTime);
  const rawPayloadId = await repo.saveRaw(r, { sourceId: 'binance-spot-rest', endpointId: 'binance-spot-klines', contentHash: canonicalJsonHash(rows), schemaVersion: 'v1.4a-server-schema-1', qualityState: 'NORMAL' }, seedLease);
  const normalized = normalizeKlines({ rows, sourceId: 'binance-spot-rest', endpointId: 'binance-spot-klines', instrument, marketType: 'spot', interval: '4h', serverTime, fetchedAt: serverTime, rawPayloadId, requestId: r.requestId });
  if (normalized.rejected.length) throw new Error(`seed4hBars: normalizeKlines rejected rows (bad OHLC/time relation in test fixture): ${JSON.stringify(normalized.rejected)}`);
  const result = await repo.upsertMarketBars(normalized.formal, seedLease);
  if (result.rejected) throw new Error(`seed4hBars: upsertMarketBars rejected rows: ${JSON.stringify(result)}`);
  return normalized.formal;
}
function flatBar(i, { open = 100, high = 100, low = 100, close = 100, base }) {
  const openTime = base + (i - 1) * FOUR_HOUR_MS, closeTime = openTime + FOUR_HOUR_MS - 1;
  return { openTime, closeTime, open, high, low, close };
}
// 全流程种子：复用V1.4B测试的建立方式（30根/周期，六组symbol×interval），供端到端ForecastGenerator测试使用
async function seedBars(instrument, interval, step, marketType = 'spot') {
  const rows = Array.from({ length: 30 }, (_, i) => { const closeTime = END - (29 - i) * step, openTime = closeTime - step + 1, p = 1800 + (instrument === 'BTCUSDT' ? 60000 : 0) + i; return [openTime, String(p - 1), String(p + 2), String(p - 2), String(p), String(100 + i), closeTime, String((100 + i) * p), 10, String((100 + i) * .55), '500', '0']; });
  const sourceId = marketType === 'spot' ? 'binance-spot-rest' : 'binance-usdt-futures-rest', endpointId = marketType === 'spot' ? 'binance-spot-klines' : 'binance-futures-klines', r = response(rows);
  const rawPayloadId = await repo.saveRaw(r, { sourceId, endpointId, contentHash: canonicalJsonHash(rows), schemaVersion: 'v1.4a-server-schema-1', qualityState: 'NORMAL' }, seedLease);
  const normalized = normalizeKlines({ rows, sourceId, endpointId, instrument, marketType, interval, serverTime: END, fetchedAt: END, rawPayloadId, requestId: r.requestId });
  await repo.upsertMarketBars(normalized.formal, seedLease);
}
async function seedFact(table, body, normalizer, interval = null) {
  const endpoints = { funding_rates: 'binance-futures-funding-rate', open_interest: 'binance-futures-open-interest', long_short_ratios: 'binance-futures-global-long-short', taker_flow: 'binance-futures-taker-flow' };
  const endpointId = endpoints[table], r = response(body);
  const rawPayloadId = await repo.saveRaw(r, { sourceId: 'binance-usdt-futures-rest', endpointId, contentHash: canonicalJsonHash(body), schemaVersion: 'v1.4a-server-schema-1', qualityState: 'NORMAL' }, seedLease);
  const rows = Array.isArray(body) ? body : [body];
  const facts = rows.map(row => normalizer(row, { sourceId: 'binance-usdt-futures-rest', endpointId, instrument: 'ETHUSDT', marketType: 'usdt_perpetual', interval, fetchedAt: END, rawPayloadId, requestId: r.requestId, qualityState: 'NORMAL' }));
  await repo.savePointFacts(table, facts, seedLease);
}
async function seedFullPipeline() {
  for (const [symbol, interval, step] of [['ETHUSDT', '15m', 900000], ['ETHUSDT', '1h', 3600000], ['ETHUSDT', '4h', FOUR_HOUR_MS], ['BTCUSDT', '15m', 900000], ['BTCUSDT', '1h', 3600000], ['BTCUSDT', '4h', FOUR_HOUR_MS]]) await seedBars(symbol, interval, step);
  await seedFact('funding_rates', [{ symbol: 'ETHUSDT', fundingTime: END - 1, fundingRate: '0.0001', markPrice: '1829' }], normalizeFunding);
  await seedFact('open_interest', { symbol: 'ETHUSDT', time: END - 1, openInterest: '100000' }, normalizeOpenInterest);
  await seedFact('long_short_ratios', [{ symbol: 'ETHUSDT', timestamp: END - 1, longShortRatio: '1.1', longAccount: '0.52', shortAccount: '0.48' }], normalizeLongShort, '15m');
  await seedFact('taker_flow', [{ timestamp: END - 1, buySellRatio: '1.2', buyVol: '120', sellVol: '100' }], normalizeTakerFlow, '15m');
  const feature = await new FeatureEngine({ repository: repo, now: () => END + 1 }).generatePoint({ targetBarCloseTime: END }, featureLease);
  // seedFullPipeline()可能在同一文件内被多个测试调用（同一END锚点、同一份市场数据），第二次调用命中相同内容
  // 会合法地DEDUPED（同一自然键内容未变），不代表种子失败——只有真正的写入错误才需要失败，接受两种终态
  assert.ok(['INSERTED', 'DEDUPED'].includes(feature.status), `unexpected feature engine status: ${feature.status}`);
  return feature;
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

pgtest('004迁移真实建立6张V1.4C表', async () => {
  for (const table of ['forecast_snapshots', 'forecast_snapshot_sources', 'forecast_quality_events', 'forecast_outcome_events', 'forecast_generation_runs', 'forecast_evaluation_runs'])
    assert.equal((await pool.query('SELECT to_regclass($1) AS t', [`public.${table}`])).rows[0].t, table);
});

pgtest('4H ATR14：恰好15根连续已收盘bar成功，14个TR样本均值与手算逐位一致', async () => {
  const base = 1_700_000_000_000; // 各独立场景之间至少相隔10_000_000_000ms(100亿)，远大于23*3根bar的oversample回溯窗口(~993_600_000ms)
  const bars = Array.from({ length: 15 }, (_, i) => flatBar(i, { open: 100 + i, high: 100 + i, low: 100 + i, close: 100 + i, base }));
  await seed4hBars('ETHUSDT', bars);
  const asOfTime = bars[14].closeTime + 5000; // >fetchedAt(closeTime+1000)才能看见本批种子数据
  const result = await computeFourHourAtr14(pool, { instrument: 'ETHUSDT', asOfTime });
  assert.equal(result.ok, true);
  assert.equal(result.atr14FourHourAtGeneration, 1); // 每根TR=|close_i-close_(i-1)|=1（high=low=close设计），14个样本均值=1
});

pgtest('4H ATR14：只有14根bar时ATR14_4H_INSUFFICIENT，fail closed', async () => {
  // 与其他场景的base至少相隔100_000_000_000ms（远大于15*3根bar的oversample回溯窗口~993_600_000ms），避免"最近N根"查询跨场景污染
  const base = 1_710_000_000_000;
  const bars = Array.from({ length: 14 }, (_, i) => flatBar(i, { open: 100 + i, high: 100 + i, low: 100 + i, close: 100 + i, base }));
  await seed4hBars('ETHUSDT', bars);
  const result = await computeFourHourAtr14(pool, { instrument: 'ETHUSDT', asOfTime: bars[13].closeTime + 5000 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ATR14_4H_INSUFFICIENT');
});

pgtest('4H ATR14：15根窗口内存在缺口时fail closed，不得用13个TR样本近似', async () => {
  const base = 1_720_000_000_000;
  const bars = Array.from({ length: 15 }, (_, i) => flatBar(i, { open: 100 + i, high: 100 + i, low: 100 + i, close: 100 + i, base }));
  const withGap = bars.filter((_, i) => i !== 7); // 跳过第7根，制造缺口
  await seed4hBars('ETHUSDT', withGap);
  const result = await computeFourHourAtr14(pool, { instrument: 'ETHUSDT', asOfTime: bars[14].closeTime + 5000 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ATR14_4H_INSUFFICIENT');
});

pgtest('连续突破计数：23根窗口，count分别覆盖0/1/2/3（对称覆盖跌破方向）', async () => {
  const base = 1_730_000_000_000;
  // 每根candidate的open取自"前一根"实际close（链式连续），low/high分别不大于/不小于该根open与close的较小/较大值，
  // 否则会被normalizeKlines的OHLC_RELATION_INVALID校验静默拒绝（曾在此处触发真实bug：低点高于开盘价导致行被拒绝、23根不再连续）
  const scenarios = [
    { label: 'count=0', c20: { open: 100, close: 105, high: 106, low: 99 }, c21: { open: 105, close: 108, high: 109, low: 104 }, c22: { open: 108, close: 109, high: 110, low: 107 }, expected: 0 },
    { label: 'count=1', c20: { open: 100, close: 105, high: 106, low: 99 }, c21: { open: 105, close: 108, high: 109, low: 104 }, c22: { open: 108, close: 115, high: 116, low: 107 }, expected: 1 },
    { label: 'count=2', c20: { open: 100, close: 105, high: 106, low: 99 }, c21: { open: 105, close: 120, high: 121, low: 104 }, c22: { open: 120, close: 130, high: 131, low: 119 }, expected: 2 },
    { label: 'count=3(即>2)', c20: { open: 100, close: 120, high: 121, low: 99 }, c21: { open: 120, close: 130, high: 131, low: 119 }, c22: { open: 130, close: 140, high: 141, low: 129 }, expected: 3 }
  ];
  for (const [idx, s] of scenarios.entries()) {
    const instrument = 'ETHUSDT';
    // 每个场景独立相隔10_000_000_000ms（远大于23*3根bar的oversample回溯窗口~993_600_000ms），互不污染
    const localBase = base + idx * 20_000_000_000;
    const localFlat = Array.from({ length: 20 }, (_, i) => flatBar(i, { open: 100, high: 110, low: 90, close: 100, base: localBase }));
    const c20 = { openTime: localBase + 19 * FOUR_HOUR_MS, closeTime: localBase + 19 * FOUR_HOUR_MS + FOUR_HOUR_MS - 1, ...s.c20 };
    const c21 = { openTime: localBase + 20 * FOUR_HOUR_MS, closeTime: localBase + 20 * FOUR_HOUR_MS + FOUR_HOUR_MS - 1, ...s.c21 };
    const c22 = { openTime: localBase + 21 * FOUR_HOUR_MS, closeTime: localBase + 21 * FOUR_HOUR_MS + FOUR_HOUR_MS - 1, ...s.c22 };
    await seed4hBars(instrument, [...localFlat, c20, c21, c22]);
    const result = await computeConsecutiveBreakoutBars(pool, { instrument, asOfTime: c22.closeTime + 5000, direction: 'up' });
    assert.equal(result.count, s.expected, `${s.label}: expected ${s.expected}, got ${result.count}`);
  }
});

pgtest('连续跌破计数：方向down对称覆盖，遇第一根不符方向立即停止', async () => {
  const base = 1_800_000_000_000;
  const flat = Array.from({ length: 20 }, (_, i) => flatBar(i, { open: 100, high: 110, low: 90, close: 100, base }));
  const c20 = { openTime: base + 19 * FOUR_HOUR_MS, closeTime: base + 19 * FOUR_HOUR_MS + FOUR_HOUR_MS - 1, open: 100, close: 80, high: 100, low: 79 }; // 跌破 priorLow20=90
  const c21 = { openTime: base + 20 * FOUR_HOUR_MS, closeTime: base + 20 * FOUR_HOUR_MS + FOUR_HOUR_MS - 1, open: 80, close: 95, high: 96, low: 79 }; // 不跌破（priorLow20此时=79）
  const c22 = { openTime: base + 21 * FOUR_HOUR_MS, closeTime: base + 21 * FOUR_HOUR_MS + FOUR_HOUR_MS - 1, open: 95, close: 70, high: 96, low: 69 }; // 跌破（priorLow20=79）
  await seed4hBars('BTCUSDT', [...flat, c20, c21, c22]);
  const result = await computeConsecutiveBreakoutBars(pool, { instrument: 'BTCUSDT', asOfTime: c22.closeTime + 5000, direction: 'down' });
  assert.equal(result.count, 1); // c22跌破(count=1)，c21不跌破→立即停止，不继续数c20
});

pgtest('连续计数：候选bar数据不足23根时返回INSUFFICIENT_DATA，不得猜测', async () => {
  const base = 1_820_000_000_000;
  const bars = Array.from({ length: 22 }, (_, i) => flatBar(i, { open: 100, high: 110, low: 90, close: 100, base }));
  await seed4hBars('ETHUSDT', bars);
  const result = await computeConsecutiveBreakoutBars(pool, { instrument: 'ETHUSDT', asOfTime: bars[21].closeTime + 5000, direction: 'up' });
  assert.equal(result.count, null);
  assert.equal(result.state, 'INSUFFICIENT_DATA');
});

pgtest('连续计数：候选bar之后的未来数据不改变该候选bar的历史判定（as-of正确性）', async () => {
  const base = 1_840_000_000_000;
  const flat = Array.from({ length: 20 }, (_, i) => flatBar(i, { open: 100, high: 110, low: 90, close: 100, base }));
  const c20 = { openTime: base + 19 * FOUR_HOUR_MS, closeTime: base + 19 * FOUR_HOUR_MS + FOUR_HOUR_MS - 1, open: 100, close: 120, high: 121, low: 99 };
  const c21 = { openTime: base + 20 * FOUR_HOUR_MS, closeTime: base + 20 * FOUR_HOUR_MS + FOUR_HOUR_MS - 1, open: 120, close: 130, high: 131, low: 100 };
  const c22 = { openTime: base + 21 * FOUR_HOUR_MS, closeTime: base + 21 * FOUR_HOUR_MS + FOUR_HOUR_MS - 1, open: 130, close: 140, high: 141, low: 110 };
  await seed4hBars('ETHUSDT', [...flat, c20, c21, c22]);
  const asOfTime = c22.closeTime + 5000;
  const before = await computeConsecutiveBreakoutBars(pool, { instrument: 'ETHUSDT', asOfTime, direction: 'up' });
  // 追加一根未来bar（asOfTime不变，仍应看不到它）
  const future = { openTime: base + 22 * FOUR_HOUR_MS, closeTime: base + 22 * FOUR_HOUR_MS + FOUR_HOUR_MS - 1, open: 140, close: 10, high: 141, low: 9 };
  await seed4hBars('ETHUSDT', [future]);
  const after = await computeConsecutiveBreakoutBars(pool, { instrument: 'ETHUSDT', asOfTime, direction: 'up' });
  assert.deepEqual(after, before);
});

pgtest('端到端：ForecastGenerator.runOnce()生成完整ForecastSnapshot，全部冻结字段正确', async () => {
  await seedFullPipeline();
  const gen = new ForecastGenerator({ pool, holderId: 'v14c-gen-1', serverTimeProvider: okServerTime(END + 2000), leaseTtlMs: 60000 });
  const result = await gen.runOnce({ instrument: 'ETHUSDT', symbol: 'ETH', horizon: '24h' });
  assert.equal(result.status, 'INSERTED');
  const record = result.record;
  assert.match(record.predictionId, /^GMKG-SRV-ETH-24h-\d+-v1\.4c-server-po-rule-1$/);
  assert.equal(record.algorithmVersion, ALGORITHM_VERSION);
  assert.equal(record.targetStateAtGeneration, 'UNKNOWN');
  assert.equal(record.fusionStateAtGeneration, 'UNKNOWN');
  assert.equal(record.probabilityStatus, 'rule_based');
  assert.equal(record.calibratedProbabilities, null);
  assert.equal(record.expectedBarCount, 96);
  assert.equal(record.scenarioWeights.baseline + record.scenarioWeights.upside + record.scenarioWeights.downside, 100);
  assert.ok(record.atr14FourHourAtGeneration > 0);
  assert.equal(record.thresholdFormulaVersion, 'v1.4c-threshold-formula-2');
  const row = (await pool.query('SELECT * FROM forecast_snapshots WHERE prediction_id=$1', [record.predictionId])).rows[0];
  assert.ok(row);
  assert.equal(row.source_origin, 'SERVER');
  assert.equal(row.lease_name, 'forecast-generator');
  const sources = await pool.query('SELECT * FROM forecast_snapshot_sources WHERE forecast_snapshot_id=$1', [row.forecast_snapshot_id]);
  assert.equal(sources.rowCount, 1);
});

pgtest('幂等：相同prediction重复生成返回DEDUPED，不产生第二行', async () => {
  // collector_leases是单holder互斥资源（同V1.4A模式：ON CONFLICT DO UPDATE的WHERE子句只在过期或同holder时生效），
  // 复用与上一测试相同的holderId，才能在lease未过期期间正常续约/复用，而非与"其他holder持有中"的锁发生互斥冲突
  const gen = new ForecastGenerator({ pool, holderId: 'v14c-gen-1', serverTimeProvider: okServerTime(END + 2000), leaseTtlMs: 60000 });
  const first = await gen.runOnce({ instrument: 'ETHUSDT', symbol: 'ETH', horizon: '24h' });
  assert.equal(first.status, 'DEDUPED'); // 复用上一测试已生成的同一预测（同一asOfTime→同一referenceBarRef→同一predictionId）
  const count = await pool.query('SELECT count(*) FROM forecast_snapshots WHERE prediction_id=$1', [first.record.prediction_id]);
  assert.equal(Number(count.rows[0].count), 1);
});

pgtest('并发：同一预测并发生成只产生一条snapshot（数据库UNIQUE(prediction_id)原子保证）', async () => {
  // 真实还原"同一逻辑调度器的两次并发调用竞争同一referenceBarRef.closeTime"场景：复用同一持有中的lease对象，
  // 并发发起两个独立事务，验证数据库UNIQUE(prediction_id)+ON CONFLICT DO NOTHING在真正的写-写竞争下只留一条胜出
  const gen = new ForecastGenerator({ pool, holderId: 'v14c-gen-1', serverTimeProvider: okServerTime(END + 3000), leaseTtlMs: 60000 });
  await gen.acquireLease();
  const [rA, rB] = await Promise.all([
    gen.runOnce({ instrument: 'ETHUSDT', symbol: 'ETH', horizon: '72h' }),
    gen.runOnce({ instrument: 'ETHUSDT', symbol: 'ETH', horizon: '72h' })
  ]);
  const statuses = [rA.status, rB.status].sort();
  assert.deepEqual(statuses, ['DEDUPED', 'INSERTED']); // 两次真正并发写入同一predictionId，必须恰好一胜一让
  const predictionId = rA.record.predictionId || rA.record.prediction_id;
  const count = await pool.query('SELECT count(*) FROM forecast_snapshots WHERE prediction_id=$1', [predictionId]);
  assert.equal(Number(count.rows[0].count), 1);
});

pgtest('未来数据不改变历史快照：追加future market_bars/feature_records revision后，旧snapshot字段与contentHash不变', async () => {
  const before = (await pool.query("SELECT * FROM forecast_snapshots WHERE horizon='24h' ORDER BY forecast_snapshot_id LIMIT 1")).rows[0];
  assert.ok(before);
  // 追加一根远期未来15m bar（不影响历史已生成快照的referenceBar/atr14/featureValuesUsed）
  const futureOpen = END + 10 * 900000, futureClose = futureOpen + 899999;
  const row = [futureOpen, '1900', '1905', '1895', '1902', '50', futureClose, '95000', 10, '25', '47500', '0'];
  const r = response([row], futureClose + 1000);
  const rawPayloadId = await repo.saveRaw(r, { sourceId: 'binance-spot-rest', endpointId: 'binance-spot-klines', contentHash: canonicalJsonHash([row]), schemaVersion: 'v1.4a-server-schema-1', qualityState: 'NORMAL' }, seedLease);
  const normalized = normalizeKlines({ rows: [row], sourceId: 'binance-spot-rest', endpointId: 'binance-spot-klines', instrument: 'ETHUSDT', marketType: 'spot', interval: '15m', serverTime: futureClose + 1000, fetchedAt: futureClose + 1000, rawPayloadId, requestId: r.requestId });
  await repo.upsertMarketBars(normalized.formal, seedLease);
  const after = (await pool.query('SELECT * FROM forecast_snapshots WHERE forecast_snapshot_id=$1', [before.forecast_snapshot_id])).rows[0];
  assert.equal(after.content_hash, before.content_hash);
  assert.equal(after.atr14_four_hour_at_generation, before.atr14_four_hour_at_generation);
  assert.deepEqual(after.feature_values_used, before.feature_values_used);
});

pgtest('数据库层不可变：forecast_snapshots拒绝UPDATE和DELETE', async () => {
  const row = (await pool.query('SELECT forecast_snapshot_id FROM forecast_snapshots LIMIT 1')).rows[0];
  await assert.rejects(pool.query('UPDATE forecast_snapshots SET reference_price=reference_price+1 WHERE forecast_snapshot_id=$1', [row.forecast_snapshot_id]), error => error.message.includes('FORECAST_SNAPSHOT_IMMUTABLE'));
  await assert.rejects(pool.query('DELETE FROM forecast_snapshots WHERE forecast_snapshot_id=$1', [row.forecast_snapshot_id]), error => error.message.includes('FORECAST_SNAPSHOT_IMMUTABLE'));
});

pgtest('ON DELETE RESTRICT：删除被forecast_snapshot_sources引用的feature_records行被拒绝', async () => {
  const ref = (await pool.query('SELECT feature_record_id FROM forecast_snapshot_sources LIMIT 1')).rows[0];
  await assert.rejects(pool.query('DELETE FROM feature_records WHERE feature_record_id=$1', [ref.feature_record_id]), error => error.code === '23503');
});

pgtest('服务器时间不可用时fail closed：不产生snapshot行，运行记录BLOCKED/SERVER_TIME_UNAVAILABLE', async () => {
  // collector_leases是单holder互斥资源，须先使当前持有者的lease过期，新holderId才能确定性地获取到lease
  await pool.query("UPDATE collector_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE lease_name=$1", [LEASE_NAME]);
  const gen = new ForecastGenerator({ pool, holderId: 'v14c-gen-badtime', serverTimeProvider: async () => ({ ok: false, reason: 'SERVER_TIME_INVALID' }), leaseTtlMs: 60000 });
  const before = Number((await pool.query('SELECT count(*) FROM forecast_snapshots')).rows[0].count);
  const result = await gen.runOnce({ instrument: 'ETHUSDT', symbol: 'ETH', horizon: '24h' });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.reason, 'SERVER_TIME_UNAVAILABLE');
  const after = Number((await pool.query('SELECT count(*) FROM forecast_snapshots')).rows[0].count);
  assert.equal(after, before);
  const run = (await pool.query("SELECT * FROM forecast_generation_runs WHERE error_code='SERVER_TIME_UNAVAILABLE' ORDER BY started_at DESC LIMIT 1")).rows[0];
  assert.ok(run);
  assert.equal(run.status, 'BLOCKED');
});

pgtest('旧fencing token提交在事务内被拒绝，回滚后无孤儿snapshot/sources/quality_event残行', async () => {
  await pool.query("UPDATE collector_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE lease_name=$1", [LEASE_NAME]);
  const gen = new ForecastGenerator({ pool, holderId: 'v14c-gen-stale', serverTimeProvider: okServerTime(END + 4000), leaseTtlMs: 60000 });
  await gen.acquireLease();
  const beforeSnap = Number((await pool.query('SELECT count(*) FROM forecast_snapshots')).rows[0].count);
  const beforeSrc = Number((await pool.query('SELECT count(*) FROM forecast_snapshot_sources')).rows[0].count);
  const beforeQe = Number((await pool.query('SELECT count(*) FROM forecast_quality_events')).rows[0].count);
  // 使当前lease的token失效（模拟被另一实例抢占）
  await pool.query("UPDATE collector_leases SET fencing_token=fencing_token+1 WHERE lease_name=$1", [LEASE_NAME]);
  await assert.rejects(gen.runOnce({ instrument: 'ETHUSDT', symbol: 'ETH', horizon: '24h' }), error => error.code === 'FENCING_TOKEN_REJECTED');
  const afterSnap = Number((await pool.query('SELECT count(*) FROM forecast_snapshots')).rows[0].count);
  const afterSrc = Number((await pool.query('SELECT count(*) FROM forecast_snapshot_sources')).rows[0].count);
  const afterQe = Number((await pool.query('SELECT count(*) FROM forecast_quality_events')).rows[0].count);
  assert.equal(afterSnap, beforeSnap);
  assert.equal(afterSrc, beforeSrc);
  assert.equal(afterQe, beforeQe);
  assert.equal(gen.leaseLost, true);
});

// Codex复审P1-2修复专项：UNIQUE(prediction_id)不足以限制生成节奏（不同referenceBar产生不同predictionId），
// 必须由§7.6"24H每4小时/72H每UTC自然日最多一次"应用层节奏门禁本身来保证。本测试用真实PostgreSQL数据模拟连续多次
// 15分钟轮询，直接断言24H/72H实际生成数量与referenceBar时间——而不是像此前V1_4C_TEST_RESULTS.md错误声称的
// "由UNIQUE(prediction_id)天然保证"（该结论已在实施报告/测试结果文档中更正，见文档变更记录）。
//
// 独立种子（不复用seedFullPipeline/END锚点，理由两条）：①seedBars()把整批30根bar的fetchedAt统一设为END本身，
// asOfTime<END的轮询会被as-of可见性过滤掉全部bar（与"节奏未到"混淆，无法单独验证节奏门禁本身）；②END在本文件其他
// 测试中已被用于24H/END这一具体predictionId，复用会产生跨测试的隐性耦合。改用全新锚点RHYTHM_END（=END-10天，同样
// 同时是4H边界与UTC日边界）与显式更早的fetchedAt，让"整批历史数据早已可见"，使轮询过程中唯一的门禁变量是节奏本身。
pgtest('P1-2修复：连续多次15m轮询模拟——24H每4小时/72H每UTC自然日最多生成一条正式快照，referenceBar精确对齐节奏边界', async () => {
  await pool.query("UPDATE collector_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE lease_name=$1", [LEASE_NAME]);

  const RHYTHM_END = END - 10 * 86400000; // 仍同时是4H边界与UTC日边界（减去整数个自然日不改变边界对齐性质）
  const seedFetchedAt = RHYTHM_END - 30 * 900000; // 早于本测试全部轮询时刻，供不参与节奏边界判定的衍生品事实使用
  // 每根bar各自独立成一次"抓取"，fetchedAt=该bar自身closeTime+微小余量——不得用单一批级fetchedAt（validTimeOrder红线
  // 要求fetchedAt>=closeTime，若批内最新一根bar的closeTime晚于共享fetchedAt会导致整批被判定为未收盘/半成品而写入失败，
  // 此前正是因此触发"stored count 0"的真实bug）。这也更贴近真实场景：每根K线在自己收盘后不久才被采集到。
  async function seedBarsBatch(instrument, interval, step, anchorCloseTime, count = 30) {
    for (let i = 0; i < count; i++) {
      const closeTime = anchorCloseTime - (count - 1 - i) * step, openTime = closeTime - step + 1, p = 1800 + (instrument === 'BTCUSDT' ? 60000 : 0) + i;
      const row = [openTime, String(p - 1), String(p + 2), String(p - 2), String(p), String(100 + i), closeTime, String((100 + i) * p), 10, String((100 + i) * .55), '500', '0'];
      const barFetchedAt = closeTime + 1000;
      const sourceId = 'binance-spot-rest', endpointId = 'binance-spot-klines', r = response([row], barFetchedAt);
      const rawPayloadId = await repo.saveRaw(r, { sourceId, endpointId, contentHash: canonicalJsonHash([row]), schemaVersion: 'v1.4a-server-schema-1', qualityState: 'NORMAL' }, seedLease);
      const normalized = normalizeKlines({ rows: [row], sourceId, endpointId, instrument, marketType: 'spot', interval, serverTime: barFetchedAt, fetchedAt: barFetchedAt, rawPayloadId, requestId: r.requestId });
      if (normalized.rejected.length) throw new Error(`seedBarsBatch rejected: ${JSON.stringify(normalized.rejected)}`);
      await repo.upsertMarketBars(normalized.formal, seedLease);
    }
  }
  async function seedFactAt(table, body, normalizer, interval = null) {
    const endpoints = { funding_rates: 'binance-futures-funding-rate', open_interest: 'binance-futures-open-interest', long_short_ratios: 'binance-futures-global-long-short', taker_flow: 'binance-futures-taker-flow' };
    const endpointId = endpoints[table], r = response(body, seedFetchedAt);
    const rawPayloadId = await repo.saveRaw(r, { sourceId: 'binance-usdt-futures-rest', endpointId, contentHash: canonicalJsonHash(body), schemaVersion: 'v1.4a-server-schema-1', qualityState: 'NORMAL' }, seedLease);
    const rows = Array.isArray(body) ? body : [body];
    const facts = rows.map(row => normalizer(row, { sourceId: 'binance-usdt-futures-rest', endpointId, instrument: 'ETHUSDT', marketType: 'usdt_perpetual', interval, fetchedAt: seedFetchedAt, rawPayloadId, requestId: r.requestId, qualityState: 'NORMAL' }));
    await repo.savePointFacts(table, facts, seedLease);
  }
  // 30根/周期，覆盖offset -29..0（即RHYTHM_END-14400000这一4H边界在范围内，但更早一个4H边界RHYTHM_END-28800000在范围外）
  for (const [symbol, interval, step] of [['ETHUSDT', '15m', 900000], ['ETHUSDT', '1h', 3600000], ['ETHUSDT', '4h', FOUR_HOUR_MS], ['BTCUSDT', '15m', 900000], ['BTCUSDT', '1h', 3600000], ['BTCUSDT', '4h', FOUR_HOUR_MS]])
    await seedBarsBatch(symbol, interval, step, RHYTHM_END);
  // FeatureEngine自身要求15m/1h窗口有足够回看深度（"Critical ETH 15m window missing"）；这与"offset -32边界必须不可见"
  // 的节奏测试目标无关，故用完全独立、更早、不重叠的一批15m/1h bar单独满足它，不扩大上面30根节奏测试窗口本身
  const FEATURE_SEED_END = RHYTHM_END - 45 * 900000; // 早于节奏测试窗口(-29..0)与"未到边界"探测点(-32)，互不重叠
  for (const [symbol, interval, step] of [['ETHUSDT', '15m', 900000], ['ETHUSDT', '1h', 3600000], ['BTCUSDT', '15m', 900000], ['BTCUSDT', '1h', 3600000]])
    await seedBarsBatch(symbol, interval, step, FEATURE_SEED_END);
  await seedFactAt('funding_rates', [{ symbol: 'ETHUSDT', fundingTime: seedFetchedAt - 1, fundingRate: '0.0001', markPrice: '1829' }], normalizeFunding);
  await seedFactAt('open_interest', { symbol: 'ETHUSDT', time: seedFetchedAt - 1, openInterest: '100000' }, normalizeOpenInterest);
  await seedFactAt('long_short_ratios', [{ symbol: 'ETHUSDT', timestamp: seedFetchedAt - 1, longShortRatio: '1.1', longAccount: '0.52', shortAccount: '0.48' }], normalizeLongShort, '15m');
  await seedFactAt('taker_flow', [{ timestamp: seedFetchedAt - 1, buySellRatio: '1.2', buyVol: '120', sellVol: '100' }], normalizeTakerFlow, '15m');
  // 生产契约要求预测只能消费与referenceBar相同时间键的特征，不能回退到更早FEATURE_SEED_END的旧特征。
  // 为本节奏测试会实际命中的两个reference边界各生成一条精确特征；FEATURE_SEED_END只负责补足历史窗口。
  for (const targetBarCloseTime of [RHYTHM_END - FOUR_HOUR_MS, RHYTHM_END]) {
    const featureResult = await new FeatureEngine({ repository: repo, now: () => targetBarCloseTime + 5000 })
      .generatePoint({ targetBarCloseTime, asOfTime: targetBarCloseTime + 5000 }, featureLease);
    assert.ok(['INSERTED', 'DEDUPED'].includes(featureResult.status), `exact feature seed failed at ${targetBarCloseTime}: ${featureResult.status}`);
  }

  const referenceBarCloseTimeOf = (result) => result.record?.referenceBarRef?.closeTime ?? result.record?.reference_bar_ref?.closeTime ?? null;
  let currentAsOfTime = null;
  const gen = new ForecastGenerator({ pool, holderId: 'v14c-rhythm-gen', serverTimeProvider: async () => ({ ok: true, sourceServerTime: currentAsOfTime }), leaseTtlMs: 60000 });
  // offset单位=15分钟；-18..-17落在RHYTHM_END-28800000之前的未采集范围（应not due）；-16..-1落在[RHYTHM_END-14400000,RHYTHM_END)
  // （应全部解析到同一个referenceBar=RHYTHM_END-14400000）；0..+2落在[RHYTHM_END,RHYTHM_END+1800000]（应全部解析到RHYTHM_END）
  const offsets = Array.from({ length: 21 }, (_, i) => i - 18);
  const results24 = [], results72 = [];
  for (const offset of offsets) {
    // +5000缓冲：每根bar的fetchedAt=其自身closeTime+1000（模拟收盘后短暂延迟才被采集到），轮询时刻需晚于该延迟
    // 才能看到恰好落在边界上的那根bar；5000远小于15分钟步长，不影响落入哪一个节奏窗口的判定
    currentAsOfTime = RHYTHM_END + offset * 900000 + 5000;
    const r24 = await gen.runOnce({ instrument: 'ETHUSDT', symbol: 'ETH', horizon: '24h' });
    results24.push({ offset, status: r24.status, referenceBarCloseTime: referenceBarCloseTimeOf(r24) });
    const r72 = await gen.runOnce({ instrument: 'ETHUSDT', symbol: 'ETH', horizon: '72h' });
    results72.push({ offset, status: r72.status, referenceBarCloseTime: referenceBarCloseTimeOf(r72) });
  }

  // 24H：恰好2次INSERTED（两个不同的4H边界），其余轮询要么BLOCKED（尚未到边界/数据未采集）要么DEDUPED（已生成过的同一边界）
  const inserted24 = results24.filter(r => r.status === 'INSERTED');
  assert.equal(inserted24.length, 2, `24H应恰好生成2次，实际:${JSON.stringify(results24)}`);
  assert.deepEqual(inserted24.map(r => r.referenceBarCloseTime).sort((a, b) => a - b), [RHYTHM_END - FOUR_HOUR_MS, RHYTHM_END]);
  assert.equal(results24.filter(r => r.status === 'BLOCKED').length, 2); // offset -18,-17
  assert.equal(results24.filter(r => r.status === 'DEDUPED').length, offsets.length - 2 - 2);
  // 高频轮询验证：offset -16..-1（16次轮询）全部解析到同一个referenceBar，只有第一次INSERTED，其余15次DEDUPED
  const sameWindowPolls = results24.filter(r => r.offset >= -16 && r.offset <= -1);
  assert.equal(sameWindowPolls.length, 16);
  assert.ok(sameWindowPolls.every(r => r.referenceBarCloseTime === RHYTHM_END - FOUR_HOUR_MS));
  assert.equal(sameWindowPolls.filter(r => r.status === 'INSERTED').length, 1);
  assert.equal(sameWindowPolls.filter(r => r.status === 'DEDUPED').length, 15);

  // 72H：恰好1次INSERTED（唯一命中的UTC自然日边界=RHYTHM_END），其余轮询要么not due（前一个日边界在采集范围外）要么DEDUPED
  const inserted72 = results72.filter(r => r.status === 'INSERTED');
  assert.equal(inserted72.length, 1, `72H应恰好生成1次，实际:${JSON.stringify(results72)}`);
  assert.equal(inserted72[0].referenceBarCloseTime, RHYTHM_END);
  assert.equal(results72.filter(r => r.status === 'BLOCKED').length, 18); // offset -18..-1均not due（上一个日边界在种子范围之外）
  assert.equal(results72.filter(r => r.status === 'DEDUPED').length, 2); // offset +1,+2复用同一份RHYTHM_END快照

  // 重启/双实例竞争：用全新的第二个Generator实例（不同holderId，模拟进程重启后重新acquire）在"当前窗口"再轮询一次，
  // 必须确定性地解析到与第一个实例完全相同的referenceBar并DEDUPED，而不是产生新的、不同的样本
  await pool.query("UPDATE collector_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE lease_name=$1", [LEASE_NAME]);
  currentAsOfTime = RHYTHM_END + 900000;
  const restarted = new ForecastGenerator({ pool, holderId: 'v14c-rhythm-gen-restarted', serverTimeProvider: async () => ({ ok: true, sourceServerTime: currentAsOfTime }), leaseTtlMs: 60000 });
  const afterRestart24 = await restarted.runOnce({ instrument: 'ETHUSDT', symbol: 'ETH', horizon: '24h' });
  assert.equal(afterRestart24.status, 'DEDUPED');
  assert.equal(referenceBarCloseTimeOf(afterRestart24), RHYTHM_END);
  const afterRestart72 = await restarted.runOnce({ instrument: 'ETHUSDT', symbol: 'ETH', horizon: '72h' });
  assert.equal(afterRestart72.status, 'DEDUPED');
  assert.equal(referenceBarCloseTimeOf(afterRestart72), RHYTHM_END);
});
