import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFormalResearchRows } from './formal-research-data-repository.js';

test('T13 repository binds run/version and maps generation-time trend plus eligibility', async () => {
  let seen;
  const pool = { query: async (sql, params) => {
    seen = { sql, params };
    return { rows: [{
      predictionId: 'p1', horizon: '24h', targetStartTime: new Date('2026-01-01Z'), targetEndTime: new Date('2026-01-02Z'),
      predictedDirection: 'UP', trend4hAtGeneration: 'DOWN', actualDirection: 'UP', actualReturn: '0.02',
      directionCorrect: true, directionEligibleForStatistics: true, pathEligibleForStatistics: false,
      endpointDataComplete: true, pathDataComplete: false, mfe: null, mae: null, proxyStateAtGeneration: 'PO'
    }] };
  } };
  const rows = await loadFormalResearchRows(pool, { validationRunId: 'run', evaluationVersion: 'eval' });
  assert.deepEqual(seen.params, ['run', 'eval']);
  assert.match(seen.sql, /feature_values_used->>'trend4h'/);
  assert.match(seen.sql, /g\.validation_run_id=\$1/);
  assert.equal(rows[0].trend4hAtGeneration, 'DOWN');
  assert.equal(rows[0].trend4hDirection, 'DOWN');
  assert.equal(rows[0].isDirectionSample, true);
  assert.equal(rows[0].actualReturn, 0.02);
});
