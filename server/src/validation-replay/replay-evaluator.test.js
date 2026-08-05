import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateReplayOutcomes } from './replay-evaluator.js';

const FIFTEEN_MIN_MS = 900000;

function auditRow(openTime, closeTime, index = 0) {
  return {
    vintage_id: `vintage-${index}`,
    instrument: 'ETHUSDT',
    interval_name: '15m',
    open_time: openTime,
    close_time: closeTime,
    available_at: closeTime + 1000,
    fetched_at: closeTime + 2000,
    source_id: 'binance',
    revision_number: 0,
    close: '1000.00',
    high: '1001.00',
    low: '999.00'
  };
}

test('P0-2：dry-run显式内存快照通道在到期后执行真实locator/outcome计算，且不发出任何写SQL', async () => {
  const referenceCloseTime = Date.UTC(2026, 0, 1) - 1;
  const referenceOpenTime = referenceCloseTime - FIFTEEN_MIN_MS + 1;
  const expectedBarCount = 96;
  const targetEndTime = referenceCloseTime + expectedBarCount * FIFTEEN_MIN_MS;
  const referenceRow = auditRow(referenceOpenTime, referenceCloseTime, 0);
  const pathRows = Array.from({ length: expectedBarCount }, (_, offset) => {
    const openTime = referenceCloseTime + 1 + offset * FIFTEEN_MIN_MS;
    return auditRow(openTime, openTime + FIFTEEN_MIN_MS - 1, offset + 1);
  });
  const queries = [];
  const pool = {
    async query(sql) {
      queries.push(sql);
      if (sql.includes('SELECT s.* FROM historical_validation.replay_snapshots')) return { rows: [] };
      if (sql.includes('close_time=to_timestamp($2/1000.0)')) return { rows: [referenceRow] };
      if (sql.includes('open_time>=to_timestamp($2/1000.0)')) return { rows: pathRows };
      throw new Error(`unexpected query: ${sql}`);
    }
  };
  const inMemorySnapshot = {
    predictionId: 'GMKG-REPLAY-ETH-24h-test',
    generationRunId: 'generation-run-test',
    instrument: 'ETH',
    horizon: '24h',
    referencePrice: 1000,
    referenceBarRef: {
      symbol: 'ETH', timeframe: '15m', openTime: referenceOpenTime,
      closeTime: referenceCloseTime, timeframeMs: FIFTEEN_MIN_MS,
      sequenceIndex: 0, barKey: `ETH-15m-${referenceCloseTime}`
    },
    targetEndTime,
    expectedDirection: 'RANGE',
    directionThreshold: 0.01,
    expectedBarCount,
    expectedPriceZones: {
      baseline: [990, 1010],
      upside: [1010, 1020],
      downside: [980, 990]
    }
  };

  const result = await evaluateReplayOutcomes({
    pool,
    validationRunId: 'validation-run-test',
    evaluationVersion: 'evaluation-v1',
    historicalAsOfTime: targetEndTime,
    replayNowMs: Date.now(),
    dryRun: true,
    inMemorySnapshots: [inMemorySnapshot]
  });

  assert.equal(result.results.length, 1);
  assert.deepEqual(result.results[0], {
    status: 'PLANNED',
    predictionId: inMemorySnapshot.predictionId,
    source: 'IN_MEMORY_PLANNED',
    generationRunId: inMemorySnapshot.generationRunId
  });
  assert.equal(queries.length, 3, '必须执行pending扫描、reference定位和完整path读取');
  assert.ok(queries.every(sql => /^\s*SELECT\b/.test(sql)), 'dry-run不得发出INSERT/UPDATE/DELETE');
  assert.match(queries[0], /g\.validation_run_id=\$4/, 'persisted pending扫描必须绑定当前validation_run，不能评估其他run的旧Snapshot');
});

test('P0-2：非dry-run拒绝内存快照通道，保持持久化生产语义不变', async () => {
  let queried = false;
  await assert.rejects(
    evaluateReplayOutcomes({
      pool: { query: async () => { queried = true; return { rows: [] }; } },
      validationRunId: 'validation-run-test',
      evaluationVersion: 'evaluation-v1',
      historicalAsOfTime: 1,
      replayNowMs: Date.now(),
      dryRun: false,
      inMemorySnapshots: [{ predictionId: 'not-allowed' }]
    }),
    error => error.code === 'IN_MEMORY_SNAPSHOTS_REQUIRE_DRY_RUN'
  );
  assert.equal(queried, false, '拒绝必须发生在任何数据库访问前');
});

test('P1-1：实际消费的reference bar缺少关键审计字段时fail closed', async () => {
  const referenceCloseTime = Date.UTC(2026, 0, 1) - 1;
  const incompleteReferenceRow = auditRow(referenceCloseTime - FIFTEEN_MIN_MS + 1, referenceCloseTime);
  delete incompleteReferenceRow.vintage_id;
  const pool = {
    async query(sql) {
      if (sql.includes('SELECT s.* FROM historical_validation.replay_snapshots')) return { rows: [] };
      if (sql.includes('close_time=to_timestamp($2/1000.0)')) return { rows: [incompleteReferenceRow] };
      throw new Error(`query should have failed before path lookup: ${sql}`);
    }
  };

  await assert.rejects(
    evaluateReplayOutcomes({
      pool,
      validationRunId: 'validation-run-test',
      evaluationVersion: 'evaluation-v1',
      historicalAsOfTime: referenceCloseTime + FIFTEEN_MIN_MS,
      replayNowMs: Date.now(),
      dryRun: true,
      inMemorySnapshots: [{
        predictionId: 'GMKG-REPLAY-ETH-24h-incomplete-audit',
        instrument: 'ETH',
        referencePrice: 1000,
        referenceBarRef: { symbol: 'ETH', closeTime: referenceCloseTime },
        targetEndTime: referenceCloseTime + FIFTEEN_MIN_MS,
        expectedDirection: 'RANGE',
        directionThreshold: 0.01,
        expectedBarCount: 1,
        expectedPriceZones: { baseline: [990, 1010], upside: [1010, 1020], downside: [980, 990] }
      }]
    }),
    error => error.code === 'INCOMPLETE_REPLAY_AUDIT_RECORD' && error.missing.includes('vintageId')
  );
});
