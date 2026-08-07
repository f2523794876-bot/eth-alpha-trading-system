import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFormalResearchDataset, loadFormalResearchRows } from './formal-research-data-repository.js';
import { canonicalJsonHash } from '../domain/hash.js';
import { computeRowContentHash } from './canonical-manifest-content.js';

const run = '11111111-1111-4111-8111-111111111111';
const hash = 'a'.repeat(64);
const rule = 'v1.4d-research-availability/1';

function authenticity(horizon) {
  const report = { validationRunId: run, datasetVersion: `v1.4d-sha256-${hash}`, horizon, reportScope: 'ALL',
    directionRawSampleCount: 1, directionEffectiveSampleCount: 1, pathRawSampleCount: 1, pathEffectiveSampleCount: 1,
    sampleSufficient: false, purgedStraddlingCount: 0, poStateBreakdown: {}, upDownRangeBreakdown: {},
    formalProxyDisclosure: { rerunAuthenticity: {
    gate_status: 'PASSED', expected_count: 1, attempted_count: 1, inserted_count: 1,
    reused_identical_count: 0, conflict_count: 0, blocked_count: 0, evaluated_count: 1
    } }, calibratedProbabilitiesStatus: 'null (V1.4D not eligible)', errorAttributionSummary: {},
    algorithmVersion: 'v1.4c-server-po-rule-1', ruleVersion: 'rule-v1', researchAvailabilityRuleVersion: rule };
  const { datasetVersion: ignoredDatasetVersion, ...content } = report;
  return { ...report, contentHash: canonicalJsonHash(content) };
}

const barValues = { open: '1000', high: '1010', low: '990', close: '1005', volume: '10', quoteVolume: '10050' };
const member = { symbol: 'ETHUSDT', intervalName: '15m', openTime: Date.parse('2026-01-01T23:45:00Z'),
  closeTime: Date.parse('2026-01-02T00:00:00Z'), revisionNumber: 0, vintageId: 'vintage-1', rowContentHash: computeRowContentHash(barValues) };

function contextRow(overrides = {}) {
  return {
    validationRunId: run, validationRunStatus: 'SUCCEEDED', dryRun: false,
    datasetVersion: `v1.4d-sha256-${hash}`, manifestContentHash: hash, algorithmVersion: 'v1.4c-server-po-rule-1', ruleVersion: 'rule-v1',
    runHorizons: ['24h'], fromUtc: new Date('2026-01-01T00:00:00Z'), toUtc: new Date('2026-01-10T00:00:00Z'),
    trainEndUtc: new Date('2026-01-04T00:00:00Z'), validationEndUtc: new Date('2026-01-07T00:00:00Z'),
    validationStartedAt: new Date('2026-02-01T00:00:00Z'), validationFinishedAt: new Date('2026-02-02T00:00:00Z'),
    manifestDataFrom: new Date('2026-01-01T00:00:00Z'), manifestDataTo: new Date('2026-01-10T00:00:00Z'),
    sourceFormalSemantics: 'market_bars:formal:spot', manifestAvailabilityRuleVersion: rule,
    manifestBackfillBatchIds: [], manifestMembers: [member],
    integrityCheckResult: { ETHUSDT: { gapCount: 0, duplicateCount: 0, outOfOrderCount: 0 } },
    authenticityReports: [authenticity('24h')], ...overrides
  };
}

function vintage(asOfTime) {
  return { researchAvailabilityRuleVersion: rule, asOfTime, consumedBars: [{ vintageId: member.vintageId, symbol: member.symbol,
    interval: member.intervalName, openTime: member.openTime, closeTime: member.closeTime, availableAt: member.closeTime,
    fetchedAt: member.closeTime, sourceId: 'binance-spot', revisionNumber: member.revisionNumber }], backfillBatchIds: [],
    disclosure: 'FROZEN_POLICY: researchAvailability(bar)=bar.close_time' };
}

function databaseRow(overrides = {}) {
  return {
    predictionId: '22222222-2222-4222-8222-222222222222', generationRunId: '33333333-3333-4333-8333-333333333333',
    evaluationRunId: '44444444-4444-4444-8444-444444444444', datasetVersion: `v1.4d-sha256-${hash}`,
    replayAlgorithmVersion: 'v1.4c-server-po-rule-1', replayRuleVersion: 'rule-v1', replayWeightVersion: 'weight-v1',
    featureEngineVersion: 'v1.4b-feature-engine-1',
    horizon: '24h', targetStartTime: new Date('2026-01-02T00:00:00Z'), targetEndTime: new Date('2026-01-03T00:00:00Z'),
    predictedDirection: 'UP', proxyStateAtGeneration: 'PO', trend4hAtGeneration: 'RANGE', featureValuesUsed: { trend4h: 'RANGE' },
    directionThreshold: '0.01', featureRecordIds: [555], featureLineage: [{ featureRecordId: 555,
      sourceDatasetVersion: `v1.4d-sha256-${hash}`, algorithmVersion: 'v1.4b-feature-engine-1',
      sourceVintageRefs: [{ vintageId: member.vintageId, symbol: member.symbol, interval: member.intervalName, revision: member.revisionNumber }] }],
    actualMarketBarLineage: [{ vintageId: member.vintageId, symbol: member.symbol, interval: member.intervalName,
      openTime: member.openTime, closeTime: member.closeTime, revisionNumber: member.revisionNumber, ...barValues }],
    snapshotHistoricalAsOfTime: new Date('2026-01-02T00:00:00Z'),
    snapshotResearchDataVintage: vintage('2026-01-02T00:00:00.000Z'), researchAvailabilityRuleVersion: rule,
    sourceOrigin: 'HISTORICAL_REPLAY', generationStatus: 'SUCCEEDED', generationStartedAt: new Date('2026-02-01T01:00:00Z'),
    generationFinishedAt: new Date('2026-02-01T02:00:00Z'), evaluationStatus: 'SUCCEEDED',
    evaluationHistoricalAsOfTime: new Date('2026-01-03T00:00:00Z'), evaluationStartedAt: new Date('2026-02-01T03:00:00Z'),
    evaluationFinishedAt: new Date('2026-02-01T04:00:00Z'), evaluatedAt: new Date('2026-02-01T03:30:00Z'),
    outcomeAsOfTime: new Date('2026-01-03T00:00:00Z'), outcomeSourceOrigin: 'HISTORICAL_REPLAY', actualDirection: 'UP',
    actualReturn: '0.02', directionCorrect: true, directionEligibleForStatistics: true, pathEligibleForStatistics: true,
    endpointDataComplete: true, pathDataComplete: true, mfe: '0.03', mae: '0.01',
    outcomeResearchDataVintage: vintage('2026-01-03T00:00:00.000Z'), ...overrides
  };
}

function poolFor(row = databaseRow(), context = contextRow()) {
  const calls = [];
  return { calls, query: async (sql, params) => {
    calls.push({ sql, params });
    return calls.length === 1 ? { rowCount: 1, rows: [context] } : { rowCount: 1, rows: [row] };
  } };
}

test('T13精确绑定validation/generation/evaluation身份链，并从数据库映射RANGE和真实性证据', async () => {
  const pool = poolFor();
  const result = await loadFormalResearchDataset(pool, { validationRunId: run, evaluationVersion: 'eval-v1' });
  assert.deepEqual(pool.calls[0].params, [run]);
  assert.deepEqual(pool.calls[1].params, [run, 'eval-v1', null, null, null, 1000]);
  assert.match(pool.calls[1].sql, /s\.generation_run_id=g\.generation_run_id/);
  assert.match(pool.calls[1].sql, /er\.evaluation_run_id=e\.evaluation_run_id AND er\.validation_run_id=vr\.validation_run_id/);
  assert.match(pool.calls[1].sql, /vr\.status='SUCCEEDED'/);
  assert.match(pool.calls[1].sql, /ORDER BY s\.horizon,s\.target_start_time,s\.prediction_id/);
  assert.equal(result.rows[0].trend4hAtGeneration, 'RANGE');
  assert.equal(result.rows[0].actualReturn, 0.02);
  assert.equal(result.auditTrail.validationRunId, run);
  assert.equal(result.auditTrail.authenticityGateStatus, 'PASSED');
});

test('P0 Feature与Replay使用不同版本域，并分别fail-closed校验', async () => {
  const valid = await loadFormalResearchRows(poolFor(), { validationRunId: run, evaluationVersion: 'eval-v1' });
  assert.equal(valid.length, 1);
  for (const [override, code] of [
    [{ featureEngineVersion: null }, 'FORMAL_RESEARCH_DATABASE_ROW_INVALID'],
    [{ featureLineage: [{ ...databaseRow().featureLineage[0], algorithmVersion: 'tampered-feature' }] }, 'FORMAL_RESEARCH_FEATURE_LINEAGE_MISMATCH'],
    [{ replayAlgorithmVersion: 'tampered-replay' }, 'FORMAL_RESEARCH_DATABASE_IDENTITY_CHAIN_INVALID'],
    [{ featureRecordIds: [556] }, 'FORMAL_RESEARCH_FEATURE_LINEAGE_MISMATCH']
  ]) {
    await assert.rejects(loadFormalResearchRows(poolFor(databaseRow(override)),
      { validationRunId: run, evaluationVersion: 'eval-v1' }), error => error.code === code);
  }
});

test('repository边界对NULL、非有限数、非法枚举/JSON、时间倒置和不安全精度逐行fail-closed', async () => {
  const cases = [
    [{ actualReturn: null }, 'FORMAL_RESEARCH_DATABASE_ROW_INVALID'],
    [{ actualReturn: 'NaN' }, 'FORMAL_RESEARCH_DATABASE_ROW_INVALID'],
    [{ actualReturn: 'Infinity' }, 'FORMAL_RESEARCH_DATABASE_ROW_INVALID'],
    [{ mae: '-Infinity' }, 'FORMAL_RESEARCH_DATABASE_ROW_INVALID'],
    [{ horizon: 'BAD' }, 'FORMAL_RESEARCH_DATABASE_ROW_INVALID'],
    [{ actualDirection: 'SIDEWAYS' }, 'FORMAL_RESEARCH_DATABASE_ROW_INVALID'],
    [{ trend4hAtGeneration: 'INVALID' }, 'FORMAL_RESEARCH_DATABASE_ROW_INVALID'],
    [{ featureValuesUsed: 'invalid-json-shape' }, 'FORMAL_RESEARCH_DATABASE_EVIDENCE_INVALID'],
    [{ targetStartTime: new Date('invalid') }, 'FORMAL_RESEARCH_DATABASE_ROW_INVALID'],
    [{ targetEndTime: new Date('2026-01-02T00:00:00Z') }, 'FORMAL_RESEARCH_DATABASE_TIME_BARRIER_FAILED'],
    [{ actualReturn: '9007199254740992' }, 'FORMAL_RESEARCH_DATABASE_ROW_INVALID'],
    [{ actualReturn: '0.1234567890123456' }, 'FORMAL_RESEARCH_DATABASE_NUMERIC_PRECISION_UNSAFE']
  ];
  for (const [override, code] of cases) {
    await assert.rejects(loadFormalResearchRows(poolFor(databaseRow(override)), { validationRunId: run, evaluationVersion: 'eval-v1' }), error => error.code === code);
  }
});

test('repository数据库错误使用稳定脱敏错误，不泄露连接串或密码', async () => {
  const pool = { query: async () => { throw Object.assign(new Error('password=supersecret postgresql://user:secret@prod/db'), { code: 'XX000' }); } };
  await assert.rejects(loadFormalResearchRows(pool, { validationRunId: run, evaluationVersion: 'eval-v1' }), error =>
    error.code === 'FORMAL_RESEARCH_DATABASE_QUERY_FAILED' && error.message === 'formal research database query failed' && !error.message.includes('secret'));
});

test('P0 manifest逐成员身份绑定：rogue、空lineage、缺失feature及不完整coverage全部fail-closed', async () => {
  const rogue = vintage('2026-01-02T00:00:00.000Z');
  rogue.consumedBars[0] = { ...rogue.consumedBars[0], vintageId: 'rogue-vintage' };
  await assert.rejects(loadFormalResearchRows(poolFor(databaseRow({ snapshotResearchDataVintage: rogue })),
    { validationRunId: run, evaluationVersion: 'eval-v1' }), error => error.code === 'FORMAL_RESEARCH_MANIFEST_MEMBER_ROGUE');
  await assert.rejects(loadFormalResearchRows(poolFor(databaseRow({ featureLineage: [] })),
    { validationRunId: run, evaluationVersion: 'eval-v1' }), error => error.code === 'FORMAL_RESEARCH_DATABASE_EVIDENCE_INVALID');
  await assert.rejects(loadFormalResearchRows(poolFor(databaseRow({ featureLineage: [{ ...databaseRow().featureLineage[0], featureRecordId: 999 }] })),
    { validationRunId: run, evaluationVersion: 'eval-v1' }), error => error.code === 'FORMAL_RESEARCH_FEATURE_LINEAGE_MISMATCH');
  const extraMember = { ...member, vintageId: 'vintage-missing', openTime: member.openTime - 900000, closeTime: member.closeTime - 900000 };
  await assert.rejects(loadFormalResearchDataset(poolFor(databaseRow(), contextRow({ manifestMembers: [member, extraMember] })),
    { validationRunId: run, evaluationVersion: 'eval-v1' }), error => error.code === 'FORMAL_RESEARCH_DATABASE_AUTHENTICITY_NOT_PROVEN');
});

test('P1 report完整身份与content hash绑定，篡改dataset/rule/hash均拒绝', async () => {
  for (const mutate of [
    report => ({ ...report, datasetVersion: `v1.4d-sha256-${'f'.repeat(64)}` }),
    report => ({ ...report, ruleVersion: 'other-rule' }),
    report => ({ ...report, contentHash: 'f'.repeat(64) })
  ]) {
    await assert.rejects(loadFormalResearchRows(poolFor(databaseRow(), contextRow({ authenticityReports: [mutate(authenticity('24h'))] })),
      { validationRunId: run, evaluationVersion: 'eval-v1' }), error => error.code === 'FORMAL_RESEARCH_DATABASE_AUTHENTICITY_IDENTITY_MISMATCH');
  }
});

test('P1 outcome在repository边界按唯一threshold classifier重算UP/DOWN/RANGE及完整性语义', async () => {
  for (const [actualReturn, actualDirection, predictedDirection, directionCorrect] of [
    ['0.01', 'UP', 'UP', true], ['-0.01', 'DOWN', 'UP', false], ['0.009', 'RANGE', 'RANGE', true]
  ]) {
    const rows = await loadFormalResearchRows(poolFor(databaseRow({ actualReturn, actualDirection, predictedDirection, directionCorrect })),
      { validationRunId: run, evaluationVersion: 'eval-v1' });
    assert.equal(rows[0].actualDirection, actualDirection);
  }
  for (const override of [
    { actualReturn: '0.02', actualDirection: 'DOWN', directionCorrect: false },
    { actualReturn: '0.02', actualDirection: 'UP', directionCorrect: false },
    { endpointDataComplete: false, directionEligibleForStatistics: true },
    { pathDataComplete: false, pathEligibleForStatistics: true }
  ]) {
    await assert.rejects(loadFormalResearchRows(poolFor(databaseRow(override)), { validationRunId: run, evaluationVersion: 'eval-v1' }),
      error => error.code === 'FORMAL_RESEARCH_DATABASE_DERIVED_SEMANTICS_INVALID');
  }
});
