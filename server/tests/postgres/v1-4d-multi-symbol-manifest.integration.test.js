import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { backfillInterval } from '../../src/backfill/binance-kline-backfill.js';
import { buildDatasetManifest, canonicalV2LogicalWindow } from '../../src/validation-replay/dataset-manifest-builder.js';
import { computeRowContentHash } from '../../src/validation-replay/canonical-manifest-content.js';
import { computeV2ManifestContentForRange } from '../../src/validation-replay/dataset-manifest-v2.js';
import { verifyDatasetManifest } from '../../src/validation-replay/dataset-manifest-verifier.js';
import { authoritativeDependencySet } from '../../src/validation-replay/multi-symbol-manifest-contract.js';
import { PostgresRepository } from '../../src/db/postgres.js';
import { runHistoricalFeatureBackfill } from '../../src/features/historical-feature-backfill.js';
import { FEATURE_ALGORITHM_VERSION, FEATURE_SET_VERSION } from '../../src/features/feature-version.js';
import { isPostgresIntegrationTestAuthorized } from './_pg-integration-gate.js';

const url = process.env.TEST_DATABASE_URL;
const authorizedDatabaseName = isPostgresIntegrationTestAuthorized(url)
  ? decodeURIComponent(new URL(url).pathname.slice(1))
  : null;
const skip = authorizedDatabaseName === null;
const migration = name => readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');

async function withTransaction(work) {
  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const identity = (await client.query('SELECT current_database() AS database')).rows[0].database;
    assert.equal(identity, authorizedDatabaseName, '必须连接到公共安全门禁精确授权的测试数据库');
    assert.notEqual(identity, 'eth_alpha');
    await work(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
}

function kline(openTime, step, price) {
  return [openTime, String(price), String(price + 2), String(price - 2), String(price + 1), '10.0000', openTime + step - 1, String((price + 1) * 10), 2, '5.0000', String((price + 1) * 5), '0'];
}

async function seedDependency(client, symbol, interval, step, from, to) {
  const rows = [];
  for (let open = from; open < to; open += step) rows.push(kline(open, step, symbol === 'BTCUSDT' ? 60_000 : 2_000));
  const adapter = {
    serverTime: async () => ({ body: { serverTime: to + 1 }, requestId: randomUUID() }),
    spotKlines: async () => ({ body: rows, requestId: randomUUID(), status: 200, headers: {} })
  };
  await backfillInterval({ pool: client, adapter, symbol, interval, startTime: from, endTime: to - step, now: () => to + 1 });
}

async function seedWindow(client, from, to) {
  await seedDependency(client, 'BTCUSDT', '15m', 900_000, from, to);
  await seedDependency(client, 'ETHUSDT', '15m', 900_000, from, to);
  await seedDependency(client, 'ETHUSDT', '1h', 3_600_000, from, to);
  await seedDependency(client, 'ETHUSDT', '4h', 14_400_000, from, to);
}

test('R28.19/R28.20 migration 007 up/down/up and guarded rollback', { skip }, async () => {
  await withTransaction(async client => {
    const up = await migration('007_v1_4d_multi_symbol_manifest_contract.up.sql');
    const down = await migration('007_v1_4d_multi_symbol_manifest_contract.down.sql');
    await client.query(down);
    assert.equal((await client.query("SELECT 1 FROM information_schema.columns WHERE table_schema='historical_validation' AND table_name='dataset_manifests' AND column_name='manifest_contract_version'")).rowCount, 0);
    await client.query(up);
    assert.equal((await client.query("SELECT 1 FROM information_schema.columns WHERE table_schema='historical_validation' AND table_name='dataset_manifests' AND column_name='dependency_set'")).rowCount, 1);
    await client.query(`INSERT INTO historical_validation.dataset_manifests(
      dataset_version,manifest_schema_version,manifest_hash_algorithm_version,manifest_contract_version,dataset_type,symbol,symbols,dependency_set,intervals,
      data_from,data_to,fixed_as_of,logical_window_hash,backfill_batch_ids,source_formal_semantics,research_availability_rule_version,
      record_count,per_interval_record_count,integrity_check_result,manifest_members)
      VALUES($1,'v1.4d-manifest-schema-2','v1.4d-manifest-hash-1',2,'MARKET_BARS',NULL,'["BTCUSDT","ETHUSDT"]','[{"symbol":"BTCUSDT","interval":"15m","marketType":"spot","source":"binance-spot"}]','["15m"]',clock_timestamp()-interval '1 day',clock_timestamp(),clock_timestamp(),$2,'[]','market_bars:formal:spot','v1.4d-research-availability-1',0,'{}','{}','[]')`, [`v1.4d-sha256-${'1'.repeat(64)}`, '2'.repeat(64)]);
    await assert.rejects(client.query(down), error => /MIGRATION_007_ROLLBACK_BLOCKED/.test(error.message));
  });
});

test('R28.1/R28.10/R28.13/R28.14/R28.16/R28.18/R28.22 contract v2 real PostgreSQL governance', { skip }, async () => {
  await withTransaction(async client => {
    const from = Date.UTC(2025, 0, 1, 0, 0, 0), to = from + 14_400_000, fixedAsOf = to - 1;
    await seedWindow(client, from, to);
    const before = Number((await client.query('SELECT count(*) FROM historical_validation.dataset_manifests')).rows[0].count);
    const dry = await buildDatasetManifest({ pool: client, contractVersion: 2, from, to, fixedAsOf, dryRun: true });
    assert.equal(dry.status, 'DRY_RUN');
    assert.equal(Number((await client.query('SELECT count(*) FROM historical_validation.dataset_manifests')).rows[0].count), before);
    const first = await buildDatasetManifest({ pool: client, contractVersion: 2, from, to, fixedAsOf });
    const second = await buildDatasetManifest({ pool: client, contractVersion: 2, from, to, fixedAsOf });
    assert.equal(first.status, 'SUCCEEDED');
    assert.deepEqual(first.symbols, ['BTCUSDT', 'ETHUSDT']);
    assert.equal(first.dependencySet.length, 4);
    assert.equal(second.inserted, false);
    const verified = await verifyDatasetManifest({ pool: client, datasetVersion: first.datasetVersion, requiredContractVersion: 2 });
    assert.equal(verified.ok, true);
    const repository = new PostgresRepository(client);
    const manifest = await repository.verifyHistoricalFeatureDataset({ datasetVersion: first.datasetVersion });
    const input = await repository.loadHistoricalFeatureInputs({ targetBarCloseTime: fixedAsOf, historicalAsOfTime: fixedAsOf, replayNowMs: to + 10_000, manifest });
    assert.equal(input.btc15.length, 16);
    assert.equal(input.eth15.length, 16);
    assert.equal(input.eth1h.length, 4);
    assert.equal(input.eth4h.length, 1);
    const sqlProbe = await client.query("SELECT count(*)::int count FROM public.market_bars WHERE vintage_id=ANY($1::text[])", [manifest.memberVintageIds]);
    assert.equal(sqlProbe.rows[0].count, manifest.memberVintageIds.length);
  });
});

test('R28 manifest member content binding rejects a same-count cross-symbol identity substitution before Feature queries', { skip }, async () => {
  await withTransaction(async client => {
    const from = Date.UTC(2025, 1, 1, 0, 0, 0), to = from + 14_400_000, fixedAsOf = to - 1;
    await seedWindow(client, from, to);
    const computed = await computeV2ManifestContentForRange({ pool: client, from, to, fixedAsOf });

    const foreignOpen = from - 900_000;
    await seedDependency(client, 'BTCUSDT', '15m', 900_000, foreignOpen, from);
    const foreign = (await client.query(
      `SELECT vintage_id,open::text,high::text,low::text,close::text,volume::text,quote_volume::text
       FROM public.market_bars
       WHERE instrument='BTCUSDT' AND interval_name='15m' AND open_time=to_timestamp($1/1000.0)`,
      [foreignOpen]
    )).rows[0];
    assert.ok(foreign?.vintage_id);

    const maliciousMembers = computed.manifestMembers.map(member => ({ ...member }));
    const target = maliciousMembers.find(member => member.symbol === 'ETHUSDT' && member.intervalName === '15m');
    assert.ok(target);
    target.vintageId = foreign.vintage_id;
    target.rowContentHash = computeRowContentHash({
      open: foreign.open,
      high: foreign.high,
      low: foreign.low,
      close: foreign.close,
      volume: foreign.volume,
      quoteVolume: foreign.quote_volume
    });
    assert.equal(maliciousMembers.length, computed.manifestMembers.length);

    const window = canonicalV2LogicalWindow({ from, to, fixedAsOf });
    await client.query(
      `INSERT INTO historical_validation.dataset_manifests(
        dataset_version,manifest_schema_version,manifest_hash_algorithm_version,manifest_contract_version,dataset_type,
        symbol,symbols,dependency_set,intervals,data_from,data_to,fixed_as_of,logical_window_hash,backfill_batch_ids,
        source_formal_semantics,research_availability_rule_version,record_count,per_interval_record_count,
        integrity_check_result,manifest_members)
       VALUES($1,$2,$3,2,$4,NULL,$5::jsonb,$6::jsonb,$7::jsonb,to_timestamp($8/1000.0),to_timestamp($9/1000.0),
        to_timestamp($10/1000.0),$11,$12::jsonb,$13,$14,$15,$16::jsonb,$17::jsonb,$18::jsonb)`,
      [
        computed.datasetVersion,
        computed.contentObject.manifestSchemaVersion,
        computed.contentObject.manifestHashAlgorithmVersion,
        computed.contentObject.datasetType,
        JSON.stringify(computed.symbols),
        JSON.stringify(computed.dependencySet),
        JSON.stringify([...new Set(computed.dependencySet.map(value => value.interval))].sort()),
        from,
        to,
        fixedAsOf,
        window.logicalWindowHash,
        JSON.stringify(computed.backfillBatchIds),
        computed.contentObject.sourceFormalSemantics,
        computed.contentObject.researchAvailabilityRuleVersion,
        computed.recordCount,
        JSON.stringify(computed.perDependencyRecordCount),
        JSON.stringify(computed.perDependencyIntegrityCheckResult),
        JSON.stringify(maliciousMembers)
      ]
    );

    const repository = new PostgresRepository(client);
    let featureInputQueryCount = 0;
    const realLoadHistoricalFeatureInputs = repository.loadHistoricalFeatureInputs.bind(repository);
    repository.loadHistoricalFeatureInputs = async args => {
      featureInputQueryCount += 1;
      return realLoadHistoricalFeatureInputs(args);
    };
    await assert.rejects(
      runHistoricalFeatureBackfill({
        repository,
        options: {
          symbol: 'ETHUSDT',
          from: new Date(from).toISOString(),
          to: new Date(to).toISOString(),
          interval: '15m',
          featureVersion: FEATURE_SET_VERSION,
          algorithmVersion: FEATURE_ALGORITHM_VERSION,
          datasetVersion: computed.datasetVersion,
          dryRun: true,
          batchSize: 10,
          resumeAfter: null
        },
        executionTime: to + 60_000
      }),
      error => error.code === 'DATASET_MANIFEST_MEMBER_CONTENT_MISMATCH'
    );
    assert.equal(featureInputQueryCount, 0);
  });
});

test('R28.12/R28.23 real advisory-lock concurrency and conflict rollback', { skip }, async () => {
  const source = await readFile(new URL('../../src/validation-replay/dataset-manifest-v2.js', import.meta.url), 'utf8');
  assert.match(source, /pg_advisory_xact_lock/);
  assert.match(source, /BEGIN/);
  assert.match(source, /ROLLBACK/);
  assert.doesNotMatch(source, /Mutex|semaphore/i);
  const pool = new Pool({ connectionString: url, max: 4 });
  try {
    const identity = (await pool.query('SELECT current_database() AS database')).rows[0].database;
    assert.equal(identity, authorizedDatabaseName, '必须连接到公共安全门禁精确授权的测试数据库');
    assert.notEqual(identity, 'eth_alpha');
    const from = Date.UTC(2024, 0, 1) + (process.pid % 1000) * 86_400_000;
    const to = from + 14_400_000, fixedAsOf = to - 1;
    await seedWindow(pool, from, to);
    const before = Number((await pool.query('SELECT count(*) FROM historical_validation.dataset_manifests')).rows[0].count);
    const results = await Promise.all([
      buildDatasetManifest({ pool, contractVersion: 2, from, to, fixedAsOf }),
      buildDatasetManifest({ pool, contractVersion: 2, from, to, fixedAsOf })
    ]);
    assert.equal(results.filter(result => result.inserted).length, 1);
    assert.equal(results.filter(result => !result.inserted).length, 1);
    assert.equal(Number((await pool.query('SELECT count(*) FROM historical_validation.dataset_manifests')).rows[0].count), before + 1);

    const conflictFrom = from + 86_400_000, conflictTo = conflictFrom + 14_400_000, conflictAsOf = conflictTo - 1;
    await seedWindow(pool, conflictFrom, conflictTo);
    const window = canonicalV2LogicalWindow({ fixedAsOf: conflictAsOf, from: conflictFrom, to: conflictTo });
    const conflictDigest = randomUUID().replaceAll('-', '').repeat(2);
    const conflictingVersion = `v1.4d-sha256-${conflictDigest}`;
    await pool.query(`INSERT INTO historical_validation.dataset_manifests(
      dataset_version,manifest_schema_version,manifest_hash_algorithm_version,manifest_contract_version,dataset_type,symbol,symbols,dependency_set,intervals,
      data_from,data_to,fixed_as_of,logical_window_hash,backfill_batch_ids,source_formal_semantics,research_availability_rule_version,
      record_count,per_interval_record_count,integrity_check_result,manifest_members)
      VALUES($1,'v1.4d-manifest-schema-2','v1.4d-manifest-hash-1',2,'MARKET_BARS',NULL,$2::jsonb,$3::jsonb,$4::jsonb,
      to_timestamp($5/1000.0),to_timestamp($6/1000.0),to_timestamp($7/1000.0),$8,'[]','market_bars:formal:spot','v1.4d-research-availability-1',0,'{}','{}','[]')`,
      [conflictingVersion, JSON.stringify(['BTCUSDT', 'ETHUSDT']), JSON.stringify(authoritativeDependencySet()), JSON.stringify(['15m', '1h', '4h']), conflictFrom, conflictTo, conflictAsOf, window.logicalWindowHash]);
    const countBeforeConflict = Number((await pool.query('SELECT count(*) FROM historical_validation.dataset_manifests')).rows[0].count);
    await assert.rejects(
      buildDatasetManifest({ pool, contractVersion: 2, from: conflictFrom, to: conflictTo, fixedAsOf: conflictAsOf }),
      error => error.code === 'DATASET_MANIFEST_LOGICAL_WINDOW_CONFLICT'
    );
    assert.equal(Number((await pool.query('SELECT count(*) FROM historical_validation.dataset_manifests')).rows[0].count), countBeforeConflict);
    assert.equal((await pool.query('SELECT 1 AS ok')).rows[0].ok, 1, 'connection remains usable after rollback');
  } finally {
    await pool.end();
  }
});
