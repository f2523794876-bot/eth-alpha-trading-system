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

const url = process.env.TEST_DATABASE_URL, enabled = Boolean(url), pgtest = enabled ? test : test.skip;
const FOUR_HOUR_MS = 14400000;
const END = 1_784_400_000_000; // 全流程种子数据锚点（复用V1.4B测试同一锚点，隔离于独立测试库，不与其他文件冲突）
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
  assert.equal(feature.status, 'INSERTED');
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
