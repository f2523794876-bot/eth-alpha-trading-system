import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPgPool, PostgresRepository } from '../../src/db/postgres.js';
import { runMigrations } from '../../src/db/migrate.js';
import { normalizeKlines, normalizeFunding, normalizeOpenInterest, normalizeLongShort, normalizeTakerFlow } from '../../src/domain/normalize.js';
import { sha256 } from '../../src/domain/hash.js';

import { isPostgresIntegrationTestAuthorized } from './_pg-integration-gate.js';

const url = process.env.TEST_DATABASE_URL;
const enabled = isPostgresIntegrationTestAuthorized(url);
const pgtest = enabled ? test : test.skip;
const BASE = 1_830_000_000_000;
const ADVANCE_MS = 3 * 3_600_000; // real wall-clock progression between original capture and a later revision

let pool, repo, lease;
const response = (body, endpointId = 'binance-spot-klines', receivedAt = BASE) => ({ body, requestId: randomUUID(), status: 200, headers: { 'content-type': 'application/json' }, startedAt: receivedAt - 2, receivedAt, roundTripMs: 2 });
const bar = (open, close, closeTime, high = '2000', low = '1') => [open, '100', high, low, close, '10', closeTime, '1000', 10, '5', '500', '0'];

if (enabled) {
  before(async () => {
    const parsed = new URL(url);
    if (!/test|ci|v14/i.test(parsed.pathname)) throw new Error('TEST_DATABASE_URL must name an isolated test/ci database');
    pool = await createPgPool({ databaseUrl: url, dbSsl: false });
    await runMigrations(pool, 'down');
    await runMigrations(pool, 'up');
    repo = new PostgresRepository(pool);
    lease = await repo.acquireLease('primary-collector', 'revision-progression-test', 3_600_000);
  });
  after(async () => { await pool?.end(); });
}

async function seedBar(openTime, close, closeTime, receivedAt) {
  const row = bar(openTime, close, closeTime);
  const r = response([row], 'binance-spot-klines', receivedAt);
  const rawPayloadId = await repo.saveRaw(r, { sourceId: 'binance-spot-rest', endpointId: 'binance-spot-klines', schemaVersion: 'v1.4a-server-schema-1', qualityState: 'NORMAL' }, lease);
  const normalized = normalizeKlines({ rows: [row], sourceId: 'binance-spot-rest', endpointId: 'binance-spot-klines', instrument: 'ETHUSDT', marketType: 'spot', interval: '15m', serverTime: receivedAt, fetchedAt: receivedAt, rawPayloadId, requestId: r.requestId });
  return repo.upsertMarketBars(normalized.formal, lease);
}

pgtest('market_bars: CREATED -> DEDUPED -> 真实时间推进后REVISED -> revision0与revision1共存 -> revision事件存在 -> 旧记录未覆盖', async () => {
  const openTime = BASE - 899999, closeTime = BASE;
  const created = await seedBar(openTime, '100', closeTime, BASE);
  assert.equal(created.inserted, 1);

  const deduped = await seedBar(openTime, '100', closeTime, BASE + 1000);
  assert.equal(deduped.deduped, 1);

  const revised = await seedBar(openTime, '105', closeTime, BASE + ADVANCE_MS);
  assert.equal(revised.revised, 1);

  const rows = await pool.query(`SELECT revision_number, close::text, available_at, fetched_at FROM market_bars WHERE instrument='ETHUSDT' AND open_time=to_timestamp($1/1000.0) ORDER BY revision_number`, [openTime]);
  assert.deepEqual(rows.rows.map(x => x.revision_number), [0, 1]);
  assert.equal(rows.rows[0].close, '100', '旧revision内容未被覆盖');
  assert.equal(rows.rows[1].close, '105');
  assert.equal(rows.rows[0].available_at.getTime(), rows.rows[1].available_at.getTime(), 'available_at在revision间保持自然键常量不变');
  assert.ok(rows.rows[1].fetched_at.getTime() - rows.rows[0].fetched_at.getTime() >= ADVANCE_MS - 1000, 'fetched_at真实推进');

  const events = await pool.query(`SELECT previous_vintage_id, new_vintage_id FROM data_revision_events WHERE dataset='market_bars'`);
  assert.equal(events.rowCount, 1);
});

const derivativeCases = [
  { table: 'funding_rates', endpointId: 'binance-futures-funding-rate', build: v => ({ symbol: 'ETHUSDT', fundingTime: BASE - 3_600_000, fundingRate: v, markPrice: '1800' }), normalizer: normalizeFunding, interval: null, field: 'funding_rate' },
  { table: 'open_interest', endpointId: 'binance-futures-open-interest', build: v => ({ symbol: 'ETHUSDT', time: BASE - 3_600_000, openInterest: v }), normalizer: normalizeOpenInterest, interval: null, field: 'open_interest' },
  { table: 'long_short_ratios', endpointId: 'binance-futures-global-long-short', build: v => ({ symbol: 'ETHUSDT', timestamp: BASE - 3_600_000, longShortRatio: v, longAccount: '0.52', shortAccount: '0.48' }), normalizer: normalizeLongShort, interval: '15m', field: 'long_short_ratio' },
  { table: 'taker_flow', endpointId: 'binance-futures-taker-flow', build: v => ({ timestamp: BASE - 3_600_000, buySellRatio: v, buyVol: '120', sellVol: '100' }), normalizer: normalizeTakerFlow, interval: '15m', field: 'buy_sell_ratio' }
];

for (const c of derivativeCases) {
  pgtest(`${c.table}: CREATED -> DEDUPED -> 真实时间推进后REVISED -> 两个revision均保存 -> revision事件正确`, async () => {
    const saveOne = async (value, fetchedAt) => {
      const ctx = { sourceId: 'binance-usdt-futures-rest', endpointId: c.endpointId, instrument: 'ETHUSDT', marketType: 'usdt_perpetual', interval: c.interval, fetchedAt, rawPayloadId: null, requestId: randomUUID(), qualityState: 'NORMAL' };
      const r = response([c.build(value)], c.endpointId, fetchedAt);
      ctx.rawPayloadId = await repo.saveRaw(r, { sourceId: ctx.sourceId, endpointId: c.endpointId, schemaVersion: 'v1.4a-server-schema-1', qualityState: 'NORMAL' }, lease);
      const fact = c.normalizer(c.build(value), ctx);
      return repo.savePointFacts(c.table, [fact], lease);
    };
    const created = await saveOne('1.1000', BASE);
    assert.equal(created.inserted, 1);
    const deduped = await saveOne('1.1000', BASE + 1000);
    assert.equal(deduped.deduped, 1);
    const revised = await saveOne('1.2000', BASE + ADVANCE_MS);
    assert.equal(revised.revised, 1);

    const rows = await pool.query(`SELECT revision_number, ${c.field}::text AS v, available_at, fetched_at FROM ${c.table} WHERE instrument='ETHUSDT' ORDER BY revision_number`);
    assert.deepEqual(rows.rows.map(x => x.revision_number), [0, 1]);
    assert.equal(rows.rows[0].v, '1.1000', '旧revision内容未被覆盖');
    assert.equal(rows.rows[1].v, '1.2000');
    assert.equal(rows.rows[0].available_at.getTime(), rows.rows[1].available_at.getTime(), 'available_at在revision间保持自然键常量不变');
    assert.ok(rows.rows[1].fetched_at.getTime() - rows.rows[0].fetched_at.getTime() >= ADVANCE_MS - 1000);

    const events = await pool.query('SELECT count(*)::int c FROM data_revision_events WHERE dataset=$1', [c.table]);
    assert.equal(events.rows[0].c, 1);
  });
}

pgtest('as-of边界：修订可用（fetched）之前只能读到旧revision，之后才能读到新revision，禁止未来revision提前可见', async () => {
  const openTime = BASE - 899999 - 5_000_000, closeTime = BASE - 5_000_000;
  const t0 = BASE - 5_000_000;
  await seedBar(openTime, '200', closeTime, t0);
  const t1 = t0 + ADVANCE_MS;
  await seedBar(openTime, '210', closeTime, t1);

  const before = await repo.loadFeatureInputs({ targetBarCloseTime: closeTime, asOfTime: t1 - 1000 });
  const beforeBar = before.eth15.find(x => Number(x.closeTime) === closeTime);
  assert.ok(beforeBar, 'asOfTime早于修订fetchedAt时仍应能看到旧revision');
  assert.equal(beforeBar.close, '200', '修订可见之前必须返回旧revision内容，不能提前泄漏新revision');

  const after = await repo.loadFeatureInputs({ targetBarCloseTime: closeTime, asOfTime: t1 });
  const afterBar = after.eth15.find(x => Number(x.closeTime) === closeTime);
  assert.ok(afterBar);
  assert.equal(afterBar.close, '210', '修订fetchedAt之后必须返回新revision内容');
});

pgtest('原子回滚：强制revision事件写入失败时，新事实与新事件全部回滚，原revision保持不变', async () => {
  const openTime = BASE - 899999 - 9_000_000, closeTime = BASE - 9_000_000;
  const t0 = BASE - 9_000_000;
  await seedBar(openTime, '300', closeTime, t0);

  const lockKey = `market_bars:binance-spot-rest:spot:ETHUSDT:15m:${openTime}`;
  const previousVintageId = `ETHUSDT-spot-15m-${closeTime}-rev0`, newVintageId = `ETHUSDT-spot-15m-${closeTime}-rev1`;
  const eventId = `revision:${sha256({ dataset: 'market_bars', naturalKey: lockKey, previousVintageId, newVintageId })}`;
  await pool.query(`INSERT INTO data_revision_events(revision_event_id,dataset,natural_key,previous_vintage_id,new_vintage_id,detected_at,content_hash) VALUES($1,'test','{}','occupied-a','occupied-b',clock_timestamp(),$2)`, [eventId, '0'.repeat(64)]);

  const t1 = t0 + ADVANCE_MS;
  await assert.rejects(seedBar(openTime, '305', closeTime, t1), error => error.code === '23505');

  const rows = await pool.query(`SELECT revision_number, close::text FROM market_bars WHERE instrument='ETHUSDT' AND open_time=to_timestamp($1/1000.0)`, [openTime]);
  assert.deepEqual(rows.rows, [{ revision_number: 0, close: '300' }], '强制revision事件冲突后新事实必须整体回滚，原revision保持不变');
  const events = await pool.query('SELECT count(*)::int c FROM data_revision_events WHERE natural_key=$1::jsonb', ['{}']);
  assert.equal(events.rows[0].c, 1, '不得残留由本次失败尝试产生的多余事件');
  await pool.query('DELETE FROM data_revision_events WHERE revision_event_id=$1', [eventId]);
});

pgtest('时间红线：非法未来时间戳仍被CHECK拒绝，合法的后续观察revision可以正常写入', async () => {
  const openTime = BASE - 899999 - 13_000_000, closeTime = BASE - 13_000_000;
  await seedBar(openTime, '400', closeTime, BASE - 13_000_000);

  await assert.rejects(pool.query(`UPDATE market_bars SET fetched_at=available_at-interval '1 second' WHERE instrument='ETHUSDT' AND open_time=to_timestamp($1/1000.0)`, [openTime]), error => error.code === '23514');

  const legit = await seedBar(openTime, '405', closeTime, BASE - 13_000_000 + ADVANCE_MS);
  assert.equal(legit.revised, 1, '真实推进后的合法revision必须能够写入');
});

pgtest('fencing：合法token可追加revision，旧token仍被数据库拒绝，拒绝后不产生事实或事件残留', async () => {
  const openTime = BASE - 899999 - 17_000_000, closeTime = BASE - 17_000_000;
  const t0 = BASE - 17_000_000;
  await seedBar(openTime, '500', closeTime, t0);

  const valid = await seedBar(openTime, '505', closeTime, t0 + ADVANCE_MS);
  assert.equal(valid.revised, 1);

  await pool.query("UPDATE collector_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE lease_name='primary-collector'");
  const nextLease = await repo.acquireLease('primary-collector', 'revision-progression-test-2', 3_600_000);
  assert.ok(nextLease.fencingToken > lease.fencingToken);

  const row = bar(openTime, '510', closeTime);
  const r = response([row], 'binance-spot-klines', t0 + ADVANCE_MS * 2);
  await assert.rejects(repo.saveRaw(r, { sourceId: 'binance-spot-rest', endpointId: 'binance-spot-klines', schemaVersion: 'v1.4a-server-schema-1', qualityState: 'NORMAL' }, lease), error => error.code === 'FENCING_TOKEN_REJECTED');

  const rows = await pool.query(`SELECT revision_number FROM market_bars WHERE instrument='ETHUSDT' AND open_time=to_timestamp($1/1000.0) ORDER BY revision_number`, [openTime]);
  assert.deepEqual(rows.rows.map(x => x.revision_number), [0, 1], '被拒绝的旧token尝试不得残留任何新事实');
  const events = await pool.query(`SELECT count(*)::int c FROM data_revision_events WHERE dataset='market_bars' AND new_vintage_id LIKE $1`, [`%${closeTime}-rev2`]);
  assert.equal(events.rows[0].c, 0, '被拒绝的旧token尝试不得残留任何revision事件');

  lease = nextLease;
});
