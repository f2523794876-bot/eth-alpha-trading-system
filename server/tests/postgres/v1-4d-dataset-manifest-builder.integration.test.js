// R27.1/R27.7(部分)：dataset-manifest-builder.js 真实PostgreSQL验证——
// 完整64位content_hash生成列一致性、integrity失败fail closed拒绝生成、ON CONFLICT DO NOTHING幂等去重。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { backfillInterval } from '../../src/backfill/binance-kline-backfill.js';
import { buildDatasetManifest, computeManifestContentForRange } from '../../src/validation-replay/dataset-manifest-builder.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = !TEST_DATABASE_URL;

function makeMockAdapter({ pages, serverTimeMs }) {
  let call = 0;
  return {
    serverTime: async () => ({ body: { serverTime: serverTimeMs }, requestId: randomUUID() }),
    spotKlines: async () => {
      const page = pages[call] || [];
      call += 1;
      return { body: page, requestId: randomUUID(), status: 200, headers: {} };
    }
  };
}

function kline(openTime, closeTime, closeStr = '1000.00') {
  return [openTime, '999.00', '1001.00', '998.00', closeStr, '10.5', closeTime, '10500.00', 5, '5.0', '5000.00'];
}

async function withTxClient(fn) {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
}

async function seedThreeBars(client, base) {
  const bar0Open = base, bar0Close = base + 900000 - 1;
  const bar1Open = base + 900000, bar1Close = bar1Open + 900000 - 1;
  const bar2Open = base + 1800000, bar2Close = bar2Open + 900000 - 1;
  const nowMs = bar2Close + 60000;
  const adapter = makeMockAdapter({
    pages: [[kline(bar0Open, bar0Close), kline(bar1Open, bar1Close), kline(bar2Open, bar2Close)]],
    serverTimeMs: nowMs
  });
  await backfillInterval({ pool: client, adapter, symbol: 'ETHUSDT', interval: '15m', startTime: bar0Open, endTime: bar2Open, now: () => nowMs });
  return { bar0Open, bar2Close };
}

test('R27.1：完整64位content_hash与dataset_version去前缀部分逐字符相等', { skip }, async () => {
  await withTxClient(async (client) => {
    const base = Date.UTC(2026, 2, 1, 0, 0, 0);
    const { bar0Open, bar2Close } = await seedThreeBars(client, base);

    const result = await buildDatasetManifest({ pool: client, symbol: 'ETHUSDT', intervals: ['15m'], from: bar0Open, to: bar2Close + 1 });
    assert.equal(result.status, 'SUCCEEDED');
    assert.match(result.datasetVersion, /^v1\.4d-sha256-[0-9a-f]{64}$/);
    assert.equal(result.recordCount, 3);

    const row = (await client.query(
      `SELECT content_hash, dataset_version, record_count FROM historical_validation.dataset_manifests WHERE dataset_version=$1`,
      [result.datasetVersion]
    )).rows[0];
    assert.ok(row, 'manifest行必须已写入');
    assert.equal(row.content_hash.length, 64);
    assert.equal(row.dataset_version.slice(13), row.content_hash, 'content_hash生成列必须与dataset_version去掉13字符前缀后的部分逐字符相等');
    assert.equal(row.record_count, 3);
  });
});

test('区间内存在缺口时拒绝生成manifest（fail closed），不写入任何行', { skip }, async () => {
  await withTxClient(async (client) => {
    const base = Date.UTC(2026, 2, 2, 0, 0, 0);
    const bar0Open = base, bar0Close = base + 900000 - 1;
    const bar2Open = base + 1800000, bar2Close = bar2Open + 900000 - 1; // 跳过bar1
    const nowMs = bar2Close + 60000;
    const adapter = makeMockAdapter({ pages: [[kline(bar0Open, bar0Close), kline(bar2Open, bar2Close)]], serverTimeMs: nowMs });
    await backfillInterval({ pool: client, adapter, symbol: 'ETHUSDT', interval: '15m', startTime: bar0Open, endTime: bar2Open, now: () => nowMs });

    const result = await buildDatasetManifest({ pool: client, symbol: 'ETHUSDT', intervals: ['15m'], from: bar0Open, to: bar2Close + 1 });
    assert.equal(result.status, 'REJECTED');
    assert.equal(result.errorCode, 'INTEGRITY_CHECK_FAILED');
    assert.equal(result.integrity.gapCount, 1);

    // P2-g（独立复审第二轮）：dataset_manifests是内容寻址且不可UPDATE/DELETE的表，其他测试文件
    // （乃至同一进程内先前运行过的测试）会在其中永久累积真实manifest行——用全表count(*)==0断言
    // 在完整套件连续跑多次/多文件共享同一隔离测试库时必然产生假失败（并非真的检测出了本测试要
    // 验证的目标）。这里改为按本测试自己唯一的symbol+data_from+data_to范围精确scoping，
    // 不依赖也不断言整张表的全局状态。
    const count = (await client.query(
      `SELECT count(*)::int AS n FROM historical_validation.dataset_manifests
       WHERE symbol='ETHUSDT' AND data_from=to_timestamp($1/1000.0) AND data_to=to_timestamp($2/1000.0)`,
      [bar0Open, bar2Close + 1]
    )).rows[0].n;
    assert.equal(count, 0, 'integrity检查失败时不得为本测试的目标区间写入任何dataset_manifests行');
  });
});

test('同一内容范围重复构建幂等：dataset_version相同，不产生重复行', { skip }, async () => {
  await withTxClient(async (client) => {
    const base = Date.UTC(2026, 2, 3, 0, 0, 0);
    const { bar0Open, bar2Close } = await seedThreeBars(client, base);

    const first = await buildDatasetManifest({ pool: client, symbol: 'ETHUSDT', intervals: ['15m'], from: bar0Open, to: bar2Close + 1 });
    const second = await buildDatasetManifest({ pool: client, symbol: 'ETHUSDT', intervals: ['15m'], from: bar0Open, to: bar2Close + 1 });
    assert.equal(first.datasetVersion, second.datasetVersion);
    assert.equal(first.inserted, true);
    assert.equal(second.inserted, false);

    const count = (await client.query(`SELECT count(*)::int AS n FROM historical_validation.dataset_manifests WHERE dataset_version=$1`, [first.datasetVersion])).rows[0].n;
    assert.equal(count, 1);
  });
});

// R26.2：不同系统时钟（不同真实执行时刻）构建同一批market_bars数据的manifest，content_hash/dataset_version
// 必须完全一致——created_at等执行时间不进入哈希内容（§2.9"禁止纳入哈希内容的字段"）。
// buildCanonicalManifestContent()本身不接受任何时钟/now参数，§2.9冻结字段清单里也没有created_at，
// 用真实延迟（跨越可观察的wall-clock时间差）+ 一次真实DB往返构建两次，证明这一点在真实执行路径下成立，
// 而不仅是"函数签名里没有now参数"这一静态观察。
test('R26.2：不同系统时钟（真实延迟后）重新构建同一批数据的manifest，content_hash/dataset_version完全一致', { skip }, async () => {
  await withTxClient(async (client) => {
    const base = Date.UTC(2026, 2, 6, 0, 0, 0);
    const { bar0Open, bar2Close } = await seedThreeBars(client, base);

    const first = await buildDatasetManifest({ pool: client, symbol: 'ETHUSDT', intervals: ['15m'], from: bar0Open, to: bar2Close + 1 });
    assert.equal(first.status, 'SUCCEEDED');

    await new Promise(resolve => setTimeout(resolve, 50)); // 真实跨越一段wall-clock时间差

    const second = await buildDatasetManifest({ pool: client, symbol: 'ETHUSDT', intervals: ['15m'], from: bar0Open, to: bar2Close + 1 });
    assert.equal(second.status, 'SUCCEEDED');
    assert.equal(second.datasetVersion, first.datasetVersion, '不同真实执行时刻构建同一批数据，dataset_version必须完全一致');

    const rows = (await client.query(`SELECT created_at FROM historical_validation.dataset_manifests WHERE dataset_version=$1`, [first.datasetVersion])).rows;
    assert.equal(rows.length, 1, 'ON CONFLICT DO NOTHING天然幂等——不因第二次调用产生第二行');
  });
});

// R26.3：manifest冻结后market_bars某一行的close值发生变化（测试环境构造，模拟内容篡改），
// 用相同(symbol,intervals,from,to)重新构建manifest，content_hash必须不同——rowContentHash覆盖OHLCV六字段。
test('R26.3：market_bars某一行close值变化后重新构建manifest，content_hash必须不同', { skip }, async () => {
  await withTxClient(async (client) => {
    const base = Date.UTC(2026, 2, 7, 0, 0, 0);
    const { bar0Open, bar2Close } = await seedThreeBars(client, base);
    const first = await buildDatasetManifest({ pool: client, symbol: 'ETHUSDT', intervals: ['15m'], from: bar0Open, to: bar2Close + 1 });
    assert.equal(first.status, 'SUCCEEDED');

    // 直接篡改一行的close值（测试环境构造——market_bars本身在生产路径下是只追加的，此处只为验证
    // buildCanonicalManifestContent()对内容变化的敏感性，不代表生产会发生这种写入）。
    // 值必须仍满足market_bars_check（high>=close>=low，kline()固定high='1001.00'/low='998.00'），
    // 否则会被CHECK约束拒绝而非本测试想验证的"内容变化反映到哈希"场景。
    await client.query(`UPDATE market_bars SET close='999.50' WHERE instrument='ETHUSDT' AND open_time=to_timestamp($1/1000.0)`, [bar0Open]);

    const second = await buildDatasetManifest({ pool: client, symbol: 'ETHUSDT', intervals: ['15m'], from: bar0Open, to: bar2Close + 1 });
    assert.equal(second.status, 'SUCCEEDED');
    assert.notEqual(second.datasetVersion, first.datasetVersion, 'close值变化必须反映为不同的dataset_version');
  });
});

// R26.4：同一bar存在revision_number=1的新版本（测试环境构造），重新计算manifest内容，content_hash必须
// 不同——manifest_members包含revisionNumber字段。用computeManifestContentForRange()（构建/校验共用的
// 底层内容计算函数，只读查询+哈希，不做完整性判定）而非buildDatasetManifest()直接验证：因为
// loadIntervalRows()对同一open_time的多个revision【不去重】（与checkIntegrity()为gap/顺序检测而
// dedupe到最高revision是两回事——那是完整性判定口径，不是manifest内容哈希口径），新增一行revision=1后
// 会被同时计入manifest_members(4条而非3条)，hash因此必然不同；而buildDatasetManifest()在此之上还叠加了
// 一层独立的完整性gate（checkIntegrity()发现同一open_time出现两个revision会记为duplicateCount>0并
// REJECTED——这是构建流程本身的既有fail-closed设计，不是本测试要验证的对象，故此处绕开该gate）。
test('R26.4：同一bar存在revision_number=1新版本后，manifest内容(computeManifestContentForRange)的content_hash必须不同', { skip }, async () => {
  await withTxClient(async (client) => {
    const base = Date.UTC(2026, 2, 8, 0, 0, 0);
    const { bar0Open, bar2Close } = await seedThreeBars(client, base);
    const from = bar0Open, to = bar2Close + 1;
    const first = await computeManifestContentForRange({ pool: client, symbol: 'ETHUSDT', intervals: ['15m'], from, to, backfillBatchIds: [] });
    assert.equal(first.recordCount, 3);

    const bar0 = (await client.query(`SELECT * FROM market_bars WHERE instrument='ETHUSDT' AND open_time=to_timestamp($1/1000.0)`, [bar0Open])).rows[0];
    await client.query(
      `INSERT INTO market_bars(
         source_id, endpoint_id, instrument, market_type, interval_name, open_time, close_time,
         open, high, low, close, volume, quote_volume, trade_count, taker_buy_base_volume, taker_buy_quote_volume,
         observation_start, observation_end, published_at, available_at, first_available_at, fetched_at,
         revision_number, vintage_id, raw_payload_id, request_id, schema_version, normalizer_version, quality_state, content_hash
       )
       SELECT source_id, endpoint_id, instrument, market_type, interval_name, open_time, close_time,
              open, high, low, close, volume, quote_volume, trade_count, taker_buy_base_volume, taker_buy_quote_volume,
              observation_start, observation_end, published_at, available_at, first_available_at, fetched_at,
              1, vintage_id || '-rev1', raw_payload_id, request_id, schema_version, normalizer_version, quality_state, content_hash
       FROM market_bars WHERE market_bar_id=$1`,
      [bar0.market_bar_id]
    );

    const second = await computeManifestContentForRange({ pool: client, symbol: 'ETHUSDT', intervals: ['15m'], from, to, backfillBatchIds: [] });
    assert.equal(second.recordCount, 4, '新版本行也会被loadIntervalRows()查询命中（不按revision去重），recordCount必须增加');
    assert.notEqual(second.datasetVersion, first.datasetVersion, '新增revision_number=1版本必须反映为不同的dataset_version（manifest_members包含revisionNumber字段）');
  });
});

// R26.5：追加一次覆盖同一时间范围的新backfill批次（backfill_batch_id=C），即使未引入新K线，
// 重新构建manifest时backfillBatchIds集合本身变化，必须反映为不同的content_hash/dataset_version
// （§2.9绑定字段清单：backfillBatchIds是被哈希字段之一）。
test('R26.5：追加覆盖同一区间的新backfill_batch后重新构建manifest，backfillBatchIds集合变化必须反映为不同的dataset_version', { skip }, async () => {
  await withTxClient(async (client) => {
    const base = Date.UTC(2026, 2, 9, 0, 0, 0);
    const { bar0Open, bar2Close } = await seedThreeBars(client, base);
    const first = await buildDatasetManifest({ pool: client, symbol: 'ETHUSDT', intervals: ['15m'], from: bar0Open, to: bar2Close + 1 });
    assert.equal(first.status, 'SUCCEEDED');
    const firstBatchIds = (await client.query(`SELECT backfill_batch_ids FROM historical_validation.dataset_manifests WHERE dataset_version=$1`, [first.datasetVersion])).rows[0].backfill_batch_ids;

    await client.query(
      `INSERT INTO historical_validation.backfill_batches(backfill_batch_id, symbol, interval_name, requested_start_utc, requested_end_utc, status, started_at, finished_at)
       VALUES ($1,'ETHUSDT','15m',to_timestamp($2/1000.0),to_timestamp($3/1000.0),'SUCCEEDED',now(),now())`,
      [randomUUID(), bar0Open, bar2Close + 1]
    );

    const second = await buildDatasetManifest({ pool: client, symbol: 'ETHUSDT', intervals: ['15m'], from: bar0Open, to: bar2Close + 1 });
    assert.equal(second.status, 'SUCCEEDED');
    const secondBatchIds = (await client.query(`SELECT backfill_batch_ids FROM historical_validation.dataset_manifests WHERE dataset_version=$1`, [second.datasetVersion])).rows[0].backfill_batch_ids;
    assert.notDeepEqual(secondBatchIds.sort(), firstBatchIds.sort(), 'backfillBatchIds集合本身必须确实发生变化（这是本测试成立的前提）');
    assert.notEqual(second.datasetVersion, first.datasetVersion, 'backfillBatchIds集合变化必须反映为不同的dataset_version');
  });
});

// R26.11：旧validation_run绑定的dataset_version=X（对应一段范围的冻结manifest）。之后执行一次新的回填，
// 把market_bars覆盖范围扩展到更大区间（不覆盖已有范围内任何一行，纯增量），重新对dataset_version=X执行
// 校验——必须仍然通过（content_hash不变），因为manifest范围内的数据本身未被触碰，增量数据在manifest
// 覆盖范围之外。用户任务二："后续补数...不得悄悄改变旧validation_run绑定的数据集"。
test('R26.11：manifest冻结范围之外的增量回填（不覆盖已有范围内任何行）不影响旧dataset_version的校验结果', { skip }, async () => {
  await withTxClient(async (client) => {
    const base = Date.UTC(2026, 2, 10, 0, 0, 0);
    const { bar0Open, bar2Close } = await seedThreeBars(client, base);
    const first = await buildDatasetManifest({ pool: client, symbol: 'ETHUSDT', intervals: ['15m'], from: bar0Open, to: bar2Close + 1 });
    assert.equal(first.status, 'SUCCEEDED');

    // 增量回填：紧接manifest范围之后再补3根bar（完全在[bar0Open, bar2Close+1)范围之外）。
    const extraOpen = bar2Close + 1, extraClose = extraOpen + 900000 - 1;
    const nowMs = extraClose + 60000;
    const adapter = makeMockAdapter({ pages: [[kline(extraOpen, extraClose)]], serverTimeMs: nowMs });
    await backfillInterval({ pool: client, adapter, symbol: 'ETHUSDT', interval: '15m', startTime: extraOpen, endTime: extraOpen, now: () => nowMs });

    const recomputed = await buildDatasetManifest({ pool: client, symbol: 'ETHUSDT', intervals: ['15m'], from: bar0Open, to: bar2Close + 1 });
    assert.equal(recomputed.status, 'SUCCEEDED');
    assert.equal(recomputed.datasetVersion, first.datasetVersion, 'manifest范围之外的纯增量回填不得改变原范围内容的dataset_version');
    assert.equal(recomputed.inserted, false, 'ON CONFLICT DO NOTHING——同一dataset_version不产生第二行');
  });
});

test('已冻结manifest不可变：UPDATE/DELETE触发DATASET_MANIFEST_IMMUTABLE', { skip }, async () => {
  await withTxClient(async (client) => {
    const base = Date.UTC(2026, 2, 4, 0, 0, 0);
    const { bar0Open, bar2Close } = await seedThreeBars(client, base);
    const result = await buildDatasetManifest({ pool: client, symbol: 'ETHUSDT', intervals: ['15m'], from: bar0Open, to: bar2Close + 1 });

    // 每次期望失败的语句都包在独立savepoint内——Postgres在一条语句报错后会将整个外层事务标记为aborted，
    // 后续语句必须先ROLLBACK TO SAVEPOINT才能继续在同一事务里执行下一条断言。
    await client.query('SAVEPOINT sp1');
    await assert.rejects(
      client.query(`UPDATE historical_validation.dataset_manifests SET record_count=999 WHERE dataset_version=$1`, [result.datasetVersion]),
      (err) => err.message.includes('DATASET_MANIFEST_IMMUTABLE')
    );
    await client.query('ROLLBACK TO SAVEPOINT sp1');

    await client.query('SAVEPOINT sp2');
    await assert.rejects(
      client.query(`DELETE FROM historical_validation.dataset_manifests WHERE dataset_version=$1`, [result.datasetVersion]),
      (err) => err.message.includes('DATASET_MANIFEST_IMMUTABLE')
    );
    await client.query('ROLLBACK TO SAVEPOINT sp2');
  });
});
