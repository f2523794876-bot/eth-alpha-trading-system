// R27.7/R27.11/R27.12对应的静态前提：dataset-manifest-verifier.js §4.1a八步校验流程真实PostgreSQL验证。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { backfillInterval } from '../../src/backfill/binance-kline-backfill.js';
import { buildDatasetManifest, computeManifestContentForRange } from '../../src/validation-replay/dataset-manifest-builder.js';
import { verifyDatasetManifest } from '../../src/validation-replay/dataset-manifest-verifier.js';

import { isPostgresIntegrationTestAuthorized } from './_pg-integration-gate.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = !isPostgresIntegrationTestAuthorized(TEST_DATABASE_URL);

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
  return { bar0Open, bar1Open, bar2Close };
}

test('第1步：不存在的dataset_version返回DATASET_MANIFEST_NOT_FOUND', { skip }, async () => {
  await withTxClient(async (client) => {
    const result = await verifyDatasetManifest({ pool: client, datasetVersion: 'v1.4d-sha256-' + '0'.repeat(64) });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'DATASET_MANIFEST_NOT_FOUND');
  });
});

test('第3/6步：内容未变化时校验通过（ok:true）', { skip }, async () => {
  await withTxClient(async (client) => {
    const base = Date.UTC(2026, 3, 1, 0, 0, 0);
    const { bar0Open, bar2Close } = await seedThreeBars(client, base);
    const built = await buildDatasetManifest({ pool: client, symbol: 'ETHUSDT', intervals: ['15m'], from: bar0Open, to: bar2Close + 1 });
    assert.equal(built.status, 'SUCCEEDED');

    const verified = await verifyDatasetManifest({ pool: client, datasetVersion: built.datasetVersion });
    assert.equal(verified.ok, true);
    assert.equal(verified.manifest.dataset_version, built.datasetVersion);
  });
});

test('第3步：manifest冻结后market_bars内容变化（新增一个revision）导致DATASET_CONTENT_HASH_MISMATCH', { skip }, async () => {
  await withTxClient(async (client) => {
    const base = Date.UTC(2026, 3, 2, 0, 0, 0);
    const { bar0Open, bar1Open, bar2Close } = await seedThreeBars(client, base);
    const built = await buildDatasetManifest({ pool: client, symbol: 'ETHUSDT', intervals: ['15m'], from: bar0Open, to: bar2Close + 1 });
    assert.equal(built.status, 'SUCCEEDED');

    // 冻结后，模拟该范围内market_bars内容发生变化（人为插入一条revision_number=1的行，
    // 代表"manifest冻结后数据被追加修订"这一漂移场景——即使当前回填协议不产生这种情形，仍作为纵深防御测试）。
    await client.query(
      `INSERT INTO market_bars(
         source_id, endpoint_id, instrument, market_type, interval_name, open_time, close_time,
         open, high, low, close, volume, quote_volume, trade_count, taker_buy_base_volume, taker_buy_quote_volume,
         observation_start, observation_end, published_at, available_at, first_available_at, fetched_at,
         revision_number, vintage_id, raw_payload_id, request_id, schema_version, normalizer_version, quality_state, content_hash
       )
       SELECT source_id, endpoint_id, instrument, market_type, interval_name, open_time, close_time,
              '9999.99', '9999.99', '9999.99', '9999.99', volume, quote_volume, trade_count, taker_buy_base_volume, taker_buy_quote_volume,
              observation_start, observation_end, published_at, available_at, first_available_at, fetched_at,
              1, vintage_id || '-rev1', raw_payload_id, request_id, schema_version, normalizer_version, quality_state, 'deadbeef'
       FROM market_bars WHERE instrument='ETHUSDT' AND open_time=to_timestamp($1/1000.0)`,
      [bar1Open]
    );

    const verified = await verifyDatasetManifest({ pool: client, datasetVersion: built.datasetVersion });
    assert.equal(verified.ok, false);
    assert.equal(verified.errorCode, 'DATASET_CONTENT_HASH_MISMATCH');
    assert.notEqual(verified.recomputedDatasetVersion, built.datasetVersion);
  });
});

// P2-1（独立复审第一轮）：审查"manifest冻结后market_bars内容漂移"这一条构造路径下，
// DATASET_RECORD_COUNT_MISMATCH是否可达——结论：在【这一条路径】下不可达，被第3步哈希比对天然先行拦截
// （recomputed的from/to固定复用manifest自身存储区间，recordCount又是§2.9冻结哈希内容对象的一部分，
// 两者必然同步变化）。注意：这不代表DATASET_RECORD_COUNT_MISMATCH整体不可达——见下方R26.6测试，
// 通过另一条独立路径（manifest行自身的record_count列与其content_hash内在不一致）证明该错误码确实
// 可以被独立触发，两个测试互为对照，而非矛盾。
test('P2-1：market_bars记录数在manifest冻结后减少——实际触发的是DATASET_CONTENT_HASH_MISMATCH而非DATASET_RECORD_COUNT_MISMATCH（验证字段级错误码在"内容漂移"这一条路径下不可达，另见下方R26.6）', { skip }, async () => {
  await withTxClient(async (client) => {
    const base = Date.UTC(2026, 3, 6, 0, 0, 0);
    const { bar0Open, bar1Open, bar2Close } = await seedThreeBars(client, base);
    const built = await buildDatasetManifest({ pool: client, symbol: 'ETHUSDT', intervals: ['15m'], from: bar0Open, to: bar2Close + 1 });
    assert.equal(built.status, 'SUCCEEDED');
    assert.equal(built.recordCount, 3);

    // manifest冻结后删除区间内一条bar（recordCount从3变为2）——data_from/data_to（manifest自身存储值）不变。
    await client.query(`DELETE FROM market_bars WHERE instrument='ETHUSDT' AND open_time=to_timestamp($1/1000.0)`, [bar1Open]);

    const verified = await verifyDatasetManifest({ pool: client, datasetVersion: built.datasetVersion });
    assert.equal(verified.ok, false);
    assert.equal(verified.errorCode, 'DATASET_CONTENT_HASH_MISMATCH', 'recordCount变化必然伴随content_hash变化，第3步必然先于第4步的record-count专属分支触发');
    assert.notEqual(verified.errorCode, 'DATASET_RECORD_COUNT_MISMATCH');
  });
});

// R26.6（独立复审第二轮P1-B）：DATASET_RECORD_COUNT_MISMATCH的真实独立可达路径——不是通过"冻结后
// market_bars内容漂移"（那条路径见上方P2-1，被第3步哈希比对先行拦截），而是manifest行自身在写入时
// record_count列与其content_hash（即dataset_version）内在不一致：content_hash对应真实market_bars
// 内容（第3步recompute会得到与dataset_version相同的哈希，不触发DATASET_CONTENT_HASH_MISMATCH），
// 但该行的record_count列被独立写入了一个错误值（模拟数据损坏或manifest-builder实现bug——
// dataset_manifests行不可UPDATE/DELETE，故这里用绕过buildDatasetManifest()的直接INSERT模拟
// "写入时就已内在不一致"这一构造性前提，对应V1_4D_ACCEPTANCE_TESTS.md R26.6原始用例的
// "人为在record_count列写入N+1"）。
test('R26.6：manifest行record_count列与其自身content_hash内在不一致（dataset_version/哈希本身正确）——独立触发DATASET_RECORD_COUNT_MISMATCH，不经过DATASET_CONTENT_HASH_MISMATCH，且不产生任何业务写入', { skip }, async () => {
  await withTxClient(async (client) => {
    const base = Date.UTC(2026, 3, 7, 0, 0, 0);
    const { bar0Open, bar2Close } = await seedThreeBars(client, base);
    const from = bar0Open, to = bar2Close + 1;

    // 独立于buildDatasetManifest()重新计算一次内容——用真实market_bars内容得到"正确"的
    // dataset_version/recordCount，证明这是从真实数据推导出的、哈希自洽的值。
    const computed = await computeManifestContentForRange({ pool: client, symbol: 'ETHUSDT', intervals: ['15m'], from, to });
    assert.equal(computed.recordCount, 3, '前提确认：真实内容确实是3条记录');
    const correctDatasetVersion = computed.datasetVersion;
    const wrongRecordCount = computed.recordCount + 1;

    // 直接INSERT（不经过buildDatasetManifest()），dataset_version/content_hash对应字段全部使用
    // 真实、正确、自洽的计算结果，唯独record_count列故意写入错误值——这正是R26.6要求的构造方式。
    await client.query(
      `INSERT INTO historical_validation.dataset_manifests(
         dataset_version, manifest_schema_version, manifest_hash_algorithm_version, symbol, intervals,
         data_from, data_to, backfill_batch_ids, source_formal_semantics, research_availability_rule_version,
         record_count, per_interval_record_count, integrity_check_result, manifest_members
       ) VALUES ($1,$2,$3,$4,$5::jsonb,to_timestamp($6/1000.0),to_timestamp($7/1000.0),$8::jsonb,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb)`,
      [
        correctDatasetVersion,
        computed.contentObject.manifestSchemaVersion,
        computed.contentObject.manifestHashAlgorithmVersion,
        'ETHUSDT',
        JSON.stringify(computed.intervals),
        from,
        to,
        JSON.stringify(computed.backfillBatchIds),
        computed.contentObject.sourceFormalSemantics,
        computed.contentObject.researchAvailabilityRuleVersion,
        wrongRecordCount,
        JSON.stringify(computed.perIntervalRecordCount),
        JSON.stringify(computed.contentObject.integrityCheckResult),
        JSON.stringify(computed.manifestMembers)
      ]
    );

    const manifestCountBefore = (await client.query('SELECT count(*)::int AS n FROM historical_validation.dataset_manifests')).rows[0].n;

    const verified = await verifyDatasetManifest({ pool: client, datasetVersion: correctDatasetVersion });
    assert.equal(verified.ok, false);
    assert.equal(verified.errorCode, 'DATASET_RECORD_COUNT_MISMATCH', 'record_count列独立于内容哈希被错误写入时，必须能被独立检出，不得被误判为哈希不匹配或被静默放行');
    assert.notEqual(verified.errorCode, 'DATASET_CONTENT_HASH_MISMATCH', '证明这条路径下第3步哈希比对确实通过（recomputed哈希与dataset_version一致），DATASET_RECORD_COUNT_MISMATCH是独立触发的，不是哈希比对的副产品');
    assert.equal(verified.manifestRecordCount, wrongRecordCount);
    assert.equal(verified.recomputedRecordCount, computed.recordCount);

    // verifyDatasetManifest()是纯只读函数——确认没有产生任何新的manifest行或其他副作用。
    const manifestCountAfter = (await client.query('SELECT count(*)::int AS n FROM historical_validation.dataset_manifests')).rows[0].n;
    assert.equal(manifestCountAfter, manifestCountBefore, 'verifyDatasetManifest必须是纯只读查询，不得产生任何业务写入');
  });
});

test('第4步：manifest冻结后新增覆盖同一区间的backfill批次导致DATASET_BATCH_SET_MISMATCH（不依赖哈希是否变化）', { skip }, async () => {
  await withTxClient(async (client) => {
    const base = Date.UTC(2026, 3, 3, 0, 0, 0);
    const { bar0Open, bar2Close } = await seedThreeBars(client, base);
    const built = await buildDatasetManifest({ pool: client, symbol: 'ETHUSDT', intervals: ['15m'], from: bar0Open, to: bar2Close + 1 });
    assert.equal(built.status, 'SUCCEEDED');
    assert.deepEqual(built && (await client.query('SELECT backfill_batch_ids FROM historical_validation.dataset_manifests WHERE dataset_version=$1', [built.datasetVersion])).rows[0].backfill_batch_ids, []);

    // 冻结后新增一条覆盖同一区间的backfill_batches审计行（模拟"事后又执行了一次覆盖同区间的回填"）。
    await client.query(
      `INSERT INTO historical_validation.backfill_batches(backfill_batch_id, symbol, interval_name, requested_start_utc, requested_end_utc, status, started_at, finished_at)
       VALUES ($1,'ETHUSDT','15m',to_timestamp($2/1000.0),to_timestamp($3/1000.0),'SUCCEEDED',now(),now())`,
      [randomUUID(), bar0Open, bar2Close + 1]
    );

    const verified = await verifyDatasetManifest({ pool: client, datasetVersion: built.datasetVersion });
    assert.equal(verified.ok, false);
    assert.equal(verified.errorCode, 'DATASET_BATCH_SET_MISMATCH');
  });
});

test('第5步：researchAvailabilityRuleVersion升级后旧manifest校验失败（DATASET_RESEARCH_AVAILABILITY_VERSION_MISMATCH）', { skip }, async () => {
  await withTxClient(async (client) => {
    const base = Date.UTC(2026, 3, 4, 0, 0, 0);
    const { bar0Open, bar2Close } = await seedThreeBars(client, base);
    const built = await buildDatasetManifest({ pool: client, symbol: 'ETHUSDT', intervals: ['15m'], from: bar0Open, to: bar2Close + 1 });

    const verified = await verifyDatasetManifest({ pool: client, datasetVersion: built.datasetVersion, currentResearchAvailabilityRuleVersion: 'v1.4d-research-availability-2' });
    assert.equal(verified.ok, false);
    assert.equal(verified.errorCode, 'DATASET_RESEARCH_AVAILABILITY_VERSION_MISMATCH');
  });
});

test('resume/dry-run场景：连续两次调用verifyDatasetManifest均完整重新执行且结果一致（第7/8步前提）', { skip }, async () => {
  await withTxClient(async (client) => {
    const base = Date.UTC(2026, 3, 5, 0, 0, 0);
    const { bar0Open, bar2Close } = await seedThreeBars(client, base);
    const built = await buildDatasetManifest({ pool: client, symbol: 'ETHUSDT', intervals: ['15m'], from: bar0Open, to: bar2Close + 1 });

    const first = await verifyDatasetManifest({ pool: client, datasetVersion: built.datasetVersion });
    const second = await verifyDatasetManifest({ pool: client, datasetVersion: built.datasetVersion });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
  });
});
