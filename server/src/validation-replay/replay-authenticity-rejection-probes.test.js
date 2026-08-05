import test from 'node:test';
import assert from 'node:assert/strict';
import { buildValidationReports } from './report-builder.js';
import {
  assertReplayAuthenticity, assertScorecardRunAuthenticity,
  createReplayAuthenticitySummary, recordGenerationAuthenticity
} from './replay-authenticity.js';

function passedAuthenticity() {
  const summary = createReplayAuthenticitySummary({ mode: 'fresh', expectedCount: 1 });
  recordGenerationAuthenticity(summary, 'INSERTED');
  assertReplayAuthenticity(summary);
  return summary;
}

for (const status of ['FAILED', 'BLOCKED']) {
  test(`Report rejects ${status} validation run`, async () => {
    const pool = { query: async () => ({ rowCount: 1, rows: [{ status }] }) };
    await assert.rejects(buildValidationReports({
      pool, validationRunId: `probe-${status}`, datasetVersion: 'probe-dataset',
      algorithmVersion: 'probe-algorithm', ruleVersion: 'probe-rule',
      researchAvailabilityRuleVersion: 'probe-availability', evaluationVersion: 'probe-evaluation',
      authenticitySummary: passedAuthenticity()
    }), error => error.code === 'REPORT_VALIDATION_RUN_NOT_ELIGIBLE' && error.status === status);
  });

  test(`Scorecard rejects ${status} validation run`, () => {
    assert.throws(
      () => assertScorecardRunAuthenticity({ runStatus: status, horizons: ['24h'], reportRows: [] }),
      error => error.code === 'SCORECARD_VALIDATION_RUN_NOT_ELIGIBLE'
    );
  });
}

test('Scorecard rejects inconsistent authenticity evidence', () => {
  const passed = passedAuthenticity();
  const inconsistent = structuredClone(passed);
  inconsistent.mode = 'resume';
  const report = (horizon, authenticity) => ({
    horizon, reportScope: 'ALL', formalProxyDisclosure: { rerunAuthenticity: authenticity }
  });
  assert.throws(
    () => assertScorecardRunAuthenticity({
      runStatus: 'SUCCEEDED', horizons: ['24h', '72h'],
      reportRows: [report('24h', passed), report('72h', inconsistent)]
    }),
    error => error.code === 'SCORECARD_RERUN_AUTHENTICITY_INCONSISTENT'
  );
});
