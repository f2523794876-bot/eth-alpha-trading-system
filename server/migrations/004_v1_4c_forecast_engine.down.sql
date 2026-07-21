-- 仅移除V1.4C新增对象，不得触及V1.4A/B任何表结构或数据（§12/§16红线）
DROP TABLE IF EXISTS forecast_outcome_events;
DROP TABLE IF EXISTS forecast_quality_events;
DROP TABLE IF EXISTS forecast_snapshot_sources;
DROP TRIGGER IF EXISTS forecast_snapshots_no_delete ON forecast_snapshots;
DROP TRIGGER IF EXISTS forecast_snapshots_no_update ON forecast_snapshots;
DROP TABLE IF EXISTS forecast_snapshots;
DROP FUNCTION IF EXISTS eth_alpha_reject_forecast_snapshot_mutation();
DROP TABLE IF EXISTS forecast_evaluation_runs;
DROP TABLE IF EXISTS forecast_generation_runs;
