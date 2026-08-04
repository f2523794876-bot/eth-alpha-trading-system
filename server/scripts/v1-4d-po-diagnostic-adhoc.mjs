import { Pool } from 'pg';
import { buildPoDiagnosticReport } from '../src/validation-replay/po-diagnostic.js';
const pool = new Pool({ connectionString: process.env.RESEARCH_DATABASE_URL });
try {
  for (const horizon of ['24h', '72h']) {
    const { rows } = await pool.query(
      `SELECT s.proxy_state_at_generation AS "proxyStateAtGeneration",
              extract(epoch FROM s.target_start_time)*1000 AS "targetStartTime",
              e.direction_eligible_for_statistics AS "directionEligibleForStatistics",
              s.feature_values_used AS "featureValuesUsed"
       FROM historical_validation.replay_snapshots s
       LEFT JOIN historical_validation.replay_outcome_events e ON e.prediction_id=s.prediction_id
       WHERE s.horizon=$1`,
      [horizon]
    );
    const samples = rows.map(r => ({ ...r, directionEligibleForStatistics: r.directionEligibleForStatistics === true }));
    const featureValuesList = rows.map(r => r.featureValuesUsed).filter(Boolean);
    const degradedShare = rows.length ? rows.filter(r => r.featureValuesUsed?.degraded === true).length / rows.length : 0;
    const report = buildPoDiagnosticReport({ samples, featureValuesList, missingFeatureShare: degradedShare });
    console.log(`=== ${horizon} ===`);
    console.log(JSON.stringify(report, null, 2));
  }
} finally {
  await pool.end();
}
