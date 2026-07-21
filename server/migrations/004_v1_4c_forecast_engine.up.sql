-- V1_4C_SCOPE_SPEC.md §6：ForecastGenerator / OutcomeEvaluator 六张新表，结构性约束逐条对应规范条文。

CREATE TABLE IF NOT EXISTS forecast_generation_runs (
  generation_run_id uuid PRIMARY KEY,
  lease_name text NOT NULL CHECK (lease_name = 'forecast-generator'),
  status text NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','FAILED','BLOCKED')),
  instrument text,
  horizon text CHECK (horizon IS NULL OR horizon IN ('24h','72h')),
  generated_count integer NOT NULL DEFAULT 0 CHECK (generated_count>=0),
  deduped_count integer NOT NULL DEFAULT 0 CHECK (deduped_count>=0),
  blocked_count integer NOT NULL DEFAULT 0 CHECK (blocked_count>=0),
  error_code text,
  fencing_token bigint,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- §6.6：OutcomeEvaluator 独立审计表，不与上表合并
CREATE TABLE IF NOT EXISTS forecast_evaluation_runs (
  evaluation_run_id uuid PRIMARY KEY,
  lease_name text NOT NULL CHECK (lease_name = 'forecast-outcome-evaluator'),
  status text NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','FAILED','BLOCKED')),
  evaluated_count integer NOT NULL DEFAULT 0 CHECK (evaluated_count>=0),
  deduped_count integer NOT NULL DEFAULT 0 CHECK (deduped_count>=0),
  blocked_count integer NOT NULL DEFAULT 0 CHECK (blocked_count>=0),
  error_code text,
  fencing_token bigint,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- §6.1：ForecastSnapshot——不设revision_number，生成后不可变（见下方触发器），逐条CHECK对应规范原文
CREATE TABLE IF NOT EXISTS forecast_snapshots (
  forecast_snapshot_id bigserial PRIMARY KEY,
  prediction_id text NOT NULL UNIQUE,
  instrument text NOT NULL,
  horizon text NOT NULL CHECK (horizon IN ('24h','72h')),
  generated_at timestamptz NOT NULL,
  data_cutoff_time timestamptz NOT NULL,
  target_start_time timestamptz NOT NULL,
  target_end_time timestamptz NOT NULL,
  reference_price numeric NOT NULL CHECK (reference_price>0),
  reference_bar_ref jsonb NOT NULL,
  target_bar_ref jsonb,
  expected_bar_count integer NOT NULL CHECK (expected_bar_count IN (96,288)),
  expected_direction text CHECK (expected_direction IS NULL OR expected_direction IN ('UP','DOWN','RANGE')),
  direction_threshold numeric NOT NULL,
  raw_threshold numeric NOT NULL,
  threshold_floor numeric NOT NULL,
  threshold_ceiling numeric NOT NULL,
  threshold_formula_version text NOT NULL,
  atr14_four_hour_at_generation numeric NOT NULL CHECK (atr14_four_hour_at_generation>0),
  target_state_at_generation text NOT NULL CHECK (target_state_at_generation = 'UNKNOWN'),
  proxy_state_at_generation text NOT NULL,
  fusion_state_at_generation text NOT NULL CHECK (fusion_state_at_generation = 'UNKNOWN'),
  candidate_trajectories jsonb NOT NULL,
  scenario_weight_baseline integer NOT NULL CHECK (scenario_weight_baseline>=0),
  scenario_weight_upside integer NOT NULL CHECK (scenario_weight_upside>=0),
  scenario_weight_downside integer NOT NULL CHECK (scenario_weight_downside>=0),
  probability_status text NOT NULL CHECK (probability_status = 'rule_based'),
  calibrated_probabilities jsonb CHECK (calibrated_probabilities IS NULL),
  expected_price_zones jsonb NOT NULL,
  trigger_conditions jsonb NOT NULL,
  invalidation_conditions jsonb NOT NULL,
  algorithm_version text NOT NULL,
  weight_version text NOT NULL,
  dataset_version text NOT NULL,
  data_vintage_refs jsonb NOT NULL,
  feature_values_used jsonb NOT NULL,
  feature_record_ids jsonb NOT NULL,
  feature_engine_version text NOT NULL,
  content_hash char(64) NOT NULL,
  auxiliary_evidence jsonb NOT NULL,
  source_origin text NOT NULL CHECK (source_origin = 'SERVER'),
  generation_run_id uuid NOT NULL REFERENCES forecast_generation_runs(generation_run_id),
  lease_name text NOT NULL CHECK (lease_name = 'forecast-generator'),
  fencing_token bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (target_start_time < target_end_time),
  CHECK (extract(epoch FROM (target_end_time - target_start_time))*1000 = expected_bar_count * 900000),
  CHECK (generated_at >= data_cutoff_time),
  CHECK (scenario_weight_baseline + scenario_weight_upside + scenario_weight_downside = 100),
  CHECK (direction_threshold >= threshold_floor AND direction_threshold <= threshold_ceiling),
  CHECK ((horizon = '24h' AND threshold_floor = 0.008 AND threshold_ceiling = 0.05) OR (horizon = '72h' AND threshold_floor = 0.015 AND threshold_ceiling = 0.08))
);
CREATE INDEX IF NOT EXISTS forecast_snapshots_query_idx ON forecast_snapshots(instrument,horizon,target_end_time);
CREATE INDEX IF NOT EXISTS forecast_snapshots_generated_idx ON forecast_snapshots(generated_at DESC);

-- §6.1 末段：数据库层不可变，比照 raw_payloads_no_update/no_delete 模式，比 feature_records 更严格（连追加revision都不允许）
CREATE OR REPLACE FUNCTION eth_alpha_reject_forecast_snapshot_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'FORECAST_SNAPSHOT_IMMUTABLE' USING ERRCODE='55000'; END $$;
DROP TRIGGER IF EXISTS forecast_snapshots_no_update ON forecast_snapshots;
DROP TRIGGER IF EXISTS forecast_snapshots_no_delete ON forecast_snapshots;
CREATE TRIGGER forecast_snapshots_no_update BEFORE UPDATE ON forecast_snapshots FOR EACH ROW EXECUTE FUNCTION eth_alpha_reject_forecast_snapshot_mutation();
CREATE TRIGGER forecast_snapshots_no_delete BEFORE DELETE ON forecast_snapshots FOR EACH ROW EXECUTE FUNCTION eth_alpha_reject_forecast_snapshot_mutation();

-- §6.2：对应 GMKG §10.1 dataVintageRefs/featureRecordIds 的展开表，比照 feature_source_refs 模式
CREATE TABLE IF NOT EXISTS forecast_snapshot_sources (
  forecast_snapshot_source_id bigserial PRIMARY KEY,
  forecast_snapshot_id bigint NOT NULL REFERENCES forecast_snapshots(forecast_snapshot_id) ON DELETE RESTRICT,
  feature_record_id bigint NOT NULL REFERENCES feature_records(feature_record_id) ON DELETE RESTRICT,
  role text NOT NULL,
  vintage_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (vintage_id IS NOT NULL),
  UNIQUE(forecast_snapshot_id, feature_record_id)
);
CREATE INDEX IF NOT EXISTS forecast_snapshot_sources_snapshot_idx ON forecast_snapshot_sources(forecast_snapshot_id);

-- §6.3：两个独立调度器共用，每行只归属其中一个lease，snapshot可为NULL（对应生成被fail closed阻断的情形）
CREATE TABLE IF NOT EXISTS forecast_quality_events (
  forecast_quality_event_id text PRIMARY KEY,
  forecast_snapshot_id bigint REFERENCES forecast_snapshots(forecast_snapshot_id) ON DELETE RESTRICT,
  prediction_id text,
  lease_name text NOT NULL CHECK (lease_name IN ('forecast-generator','forecast-outcome-evaluator')),
  event_type text NOT NULL,
  severity text NOT NULL,
  reasons jsonb NOT NULL DEFAULT '[]',
  occurred_at timestamptz NOT NULL,
  content_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS forecast_quality_events_lease_idx ON forecast_quality_events(lease_name,occurred_at DESC);

-- §6.4：append-only per evaluationVersion，只接受 'forecast-outcome-evaluator' lease 写入；endpoint/path不完整时对应指标必须为NULL（§9/§11真值表的数据库层兜底）
CREATE TABLE IF NOT EXISTS forecast_outcome_events (
  forecast_outcome_event_id bigserial PRIMARY KEY,
  prediction_id text NOT NULL REFERENCES forecast_snapshots(prediction_id) ON DELETE RESTRICT,
  evaluation_version text NOT NULL,
  evaluation_run_id uuid NOT NULL REFERENCES forecast_evaluation_runs(evaluation_run_id),
  evaluated_at timestamptz NOT NULL,
  as_of_time timestamptz NOT NULL,
  endpoint_data_complete boolean NOT NULL,
  path_data_complete boolean NOT NULL,
  direction_eligible_for_statistics boolean NOT NULL,
  path_eligible_for_statistics boolean NOT NULL,
  actual_return numeric,
  actual_direction text CHECK (actual_direction IS NULL OR actual_direction IN ('UP','DOWN','RANGE')),
  direction_correct boolean,
  actual_high numeric,
  actual_low numeric,
  mfe numeric,
  mae numeric,
  range_specific_metrics jsonb,
  invalidation_triggered boolean,
  invalidation_reason text,
  coverage_metrics jsonb,
  missing_bar_refs jsonb NOT NULL DEFAULT '[]',
  source_origin text NOT NULL CHECK (source_origin IN ('SERVER','LEGACY_BROWSER')),
  lease_name text NOT NULL CHECK (lease_name = 'forecast-outcome-evaluator'),
  fencing_token bigint NOT NULL,
  content_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(prediction_id, evaluation_version),
  -- §11真值表：actualReturn/actualDirection/directionCorrect只需endpoint完整（directionEligible）；
  -- actualHigh/actualLow/mfe/mae/invalidationTriggered属于路径类指标，需pathEligible（与endpoint分组不同，本CHECK此前误将actual_high/actual_low与endpoint分组混淆，已修正）
  CHECK (direction_eligible_for_statistics OR (actual_return IS NULL AND actual_direction IS NULL AND direction_correct IS NULL)),
  CHECK (path_eligible_for_statistics OR (actual_high IS NULL AND actual_low IS NULL AND mfe IS NULL AND mae IS NULL AND invalidation_triggered IS NULL AND range_specific_metrics IS NULL)),
  -- coverage_metrics捆绑了endpoint类(endpointInBaselineZone等)与path类(realizedRangeInsideExpectedEnvelope等)两组字段，
  -- 只有在endpoint本身不完整(direction_eligible_for_statistics=false)时才整体为NULL；endpoint完整但path不完整时，
  -- coverage_metrics必须是非NULL对象(内部path类子字段各自为null，由应用层JSON内容保证，CHECK层不下钻JSON字段)
  CHECK (direction_eligible_for_statistics OR coverage_metrics IS NULL)
);
CREATE INDEX IF NOT EXISTS forecast_outcome_events_prediction_idx ON forecast_outcome_events(prediction_id);
