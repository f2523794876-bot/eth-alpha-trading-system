// R27.1/R27.7(部分)：dataset-manifest-builder.js 真实PostgreSQL验证——
// 完整64位content_hash生成列一致性、integrity失败fail closed拒绝生成、ON CONFLICT DO NOTHING幂等去重。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { backfillInterval } from '../../src/backfill/binance-kline-backfill.js';
import { buildDatasetManifest } from '../../src/validation-replay/dataset-manifest-builder.js';

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

    const count = (await client.query(`SELECT count(*)::int AS n FROM historical_validation.dataset_manifests`)).rows[0].n;
    assert.equal(count, 0, 'integrity检查失败时不得写入任何dataset_manifests行');
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
