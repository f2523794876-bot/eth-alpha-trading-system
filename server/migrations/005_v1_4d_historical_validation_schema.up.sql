-- V1_4D_HISTORICAL_REPLAY_SPEC.md §二/§2.0-§2.9/§三.0：historical_validation 独立schema，八张表。
-- 建表顺序严格遵循 §三.0 冻结顺序（先被引用者先建）：
--   dataset_manifests -> validation_runs -> backfill_batches -> replay_generation_runs ->
--   replay_evaluation_runs -> replay_snapshots -> replay_outcome_events -> validation_reports
-- 本schema与生产public schema物理隔离：不引用 public.forecast_snapshots/forecast_outcome_events/
-- forecast_generation_runs/forecast_evaluation_runs/collector_leases 任何一张；对 public.market_bars/
-- feature_records 只做只读查询（应用层），不设结构性外键（见 §2.8 "为何不设DB级FK"）。

CREATE SCHEMA IF NOT EXISTS historical_validation;

-- ---------------------------------------------------------------------------
-- 1. dataset_manifests（§2.8/§2.9）——dataset_version 内容寻址主键表，历史回放数据集的唯一权威冻结记录。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS historical_validation.dataset_manifests (
  -- §2.9.0：dataset_version = v1.4d-sha256-{完整64位十六进制sha256}，不截断。前缀 'v1.4d-sha256-' 恰好13字符，
  -- 故完整长度 = 13 + 64 = 77 字符，CHECK 中以此校验格式（防止应用层误写截断值）。
  dataset_version text PRIMARY KEY CHECK (
    dataset_version ~ '^v1\.4d-sha256-[0-9a-f]{64}$'
  ),
  manifest_schema_version text NOT NULL,
  manifest_hash_algorithm_version text NOT NULL,
  -- content_hash 为生成列，机械推导自 dataset_version 去掉13字符前缀后的剩余64位十六进制部分。
  -- 注：'v1.4d-sha256-' 长度为13，故剩余部分从第14个字符开始（substring 起始位置为1-indexed）。
  content_hash char(64) GENERATED ALWAYS AS (substring(dataset_version from 14)) STORED,
  symbol text NOT NULL,
  intervals jsonb NOT NULL,
  data_from timestamptz NOT NULL,
  data_to timestamptz NOT NULL,
  backfill_batch_ids jsonb NOT NULL,
  source_formal_semantics text NOT NULL CHECK (source_formal_semantics = 'market_bars:formal:spot'),
  research_availability_rule_version text NOT NULL,
  record_count integer NOT NULL CHECK (record_count >= 0),
  per_interval_record_count jsonb NOT NULL,
  integrity_check_result jsonb NOT NULL,
  manifest_members jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (data_from < data_to)
);
CREATE INDEX IF NOT EXISTS dataset_manifests_symbol_range_idx ON historical_validation.dataset_manifests(symbol, data_from, data_to);

-- §2.8/§2.0 分类B：严格只增型，内容寻址主键设计从根本上排除"原地修改"的合法性；本轮仍加显式触发器做数据库层硬保证。
CREATE OR REPLACE FUNCTION historical_validation.reject_dataset_manifest_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'DATASET_MANIFEST_IMMUTABLE' USING ERRCODE='55000'; END $$;
DROP TRIGGER IF EXISTS dataset_manifests_no_update ON historical_validation.dataset_manifests;
DROP TRIGGER IF EXISTS dataset_manifests_no_delete ON historical_validation.dataset_manifests;
CREATE TRIGGER dataset_manifests_no_update BEFORE UPDATE ON historical_validation.dataset_manifests FOR EACH ROW EXECUTE FUNCTION historical_validation.reject_dataset_manifest_mutation();
CREATE TRIGGER dataset_manifests_no_delete BEFORE DELETE ON historical_validation.dataset_manifests FOR EACH ROW EXECUTE FUNCTION historical_validation.reject_dataset_manifest_mutation();

-- ---------------------------------------------------------------------------
-- 2. validation_runs（§2.1）——每次回放执行的顶层审计记录。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS historical_validation.validation_runs (
  validation_run_id uuid PRIMARY KEY,
  resumed_from_run_id uuid REFERENCES historical_validation.validation_runs(validation_run_id),
  dataset_version text NOT NULL REFERENCES historical_validation.dataset_manifests(dataset_version),
  symbol text NOT NULL,
  horizons jsonb NOT NULL,
  from_utc timestamptz NOT NULL,
  to_utc timestamptz NOT NULL,
  algorithm_version text NOT NULL,
  rule_version text NOT NULL,
  train_end_utc timestamptz,
  validation_end_utc timestamptz,
  dry_run boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','FAILED','PARTIAL')),
  error_code text,
  blocked_reasons jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  CHECK (from_utc < to_utc),
  CHECK (
    (train_end_utc IS NULL AND validation_end_utc IS NULL)
    OR (train_end_utc IS NOT NULL AND validation_end_utc IS NOT NULL
        AND from_utc < train_end_utc AND train_end_utc < validation_end_utc AND validation_end_utc < to_utc)
  )
);
CREATE INDEX IF NOT EXISTS validation_runs_dataset_version_idx ON historical_validation.validation_runs(dataset_version);

-- ---------------------------------------------------------------------------
-- 3. backfill_batches（§2.2，支持表）——回填批次审计，独立于任何单次validation_run。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS historical_validation.backfill_batches (
  backfill_batch_id uuid PRIMARY KEY,
  symbol text NOT NULL,
  interval_name text NOT NULL CHECK (interval_name IN ('15m','1h','4h')),
  requested_start_utc timestamptz NOT NULL,
  requested_end_utc timestamptz NOT NULL,
  last_completed_open_time timestamptz,
  status text NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','FAILED','ATTENTION_REQUIRED')),
  rows_inserted integer NOT NULL DEFAULT 0 CHECK (rows_inserted >= 0),
  rows_deduped integer NOT NULL DEFAULT 0 CHECK (rows_deduped >= 0),
  error_code text,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (requested_start_utc < requested_end_utc)
);
CREATE INDEX IF NOT EXISTS backfill_batches_symbol_interval_idx ON historical_validation.backfill_batches(symbol, interval_name, requested_start_utc);

-- ---------------------------------------------------------------------------
-- 4. replay_generation_runs（§2.4）——历史ForecastGenerationRun审计对应物，无lease/fencing_token列。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS historical_validation.replay_generation_runs (
  generation_run_id uuid PRIMARY KEY,
  validation_run_id uuid NOT NULL REFERENCES historical_validation.validation_runs(validation_run_id),
  instrument text NOT NULL,
  horizon text NOT NULL CHECK (horizon IN ('24h','72h')),
  historical_as_of_time timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','FAILED','BLOCKED')),
  generated_count integer NOT NULL DEFAULT 0 CHECK (generated_count >= 0),
  deduped_count integer NOT NULL DEFAULT 0 CHECK (deduped_count >= 0),
  blocked_count integer NOT NULL DEFAULT 0 CHECK (blocked_count >= 0),
  error_code text,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS replay_generation_runs_run_idx ON historical_validation.replay_generation_runs(validation_run_id);

-- ---------------------------------------------------------------------------
-- 5. replay_evaluation_runs（§2.6）——结构对齐 replay_generation_runs，语义对应生产 forecast_evaluation_runs。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS historical_validation.replay_evaluation_runs (
  evaluation_run_id uuid PRIMARY KEY,
  validation_run_id uuid NOT NULL REFERENCES historical_validation.validation_runs(validation_run_id),
  historical_as_of_time timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','FAILED','BLOCKED')),
  evaluated_count integer NOT NULL DEFAULT 0 CHECK (evaluated_count >= 0),
  deduped_count integer NOT NULL DEFAULT 0 CHECK (deduped_count >= 0),
  blocked_count integer NOT NULL DEFAULT 0 CHECK (blocked_count >= 0),
  error_code text,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS replay_evaluation_runs_run_idx ON historical_validation.replay_evaluation_runs(validation_run_id);

-- ---------------------------------------------------------------------------
-- 6. replay_snapshots（§2.3）——历史ForecastSnapshot对应物，字段对齐生产forecast_snapshots并增补回放专属溯源列。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS historical_validation.replay_snapshots (
  replay_snapshot_id bigserial PRIMARY KEY,
  prediction_id text NOT NULL,
  generation_run_id uuid NOT NULL REFERENCES historical_validation.replay_generation_runs(generation_run_id),
  backfill_batch_id uuid REFERENCES historical_validation.backfill_batches(backfill_batch_id),
  dataset_version text NOT NULL REFERENCES historical_validation.dataset_manifests(dataset_version),
  instrument text NOT NULL,
  horizon text NOT NULL CHECK (horizon IN ('24h','72h')),
  generated_at timestamptz NOT NULL,
  data_cutoff_time timestamptz NOT NULL,
  target_start_time timestamptz NOT NULL,
  target_end_time timestamptz NOT NULL,
  reference_price numeric NOT NULL CHECK (reference_price > 0),
  reference_bar_ref jsonb NOT NULL,
  target_bar_ref jsonb,
  expected_bar_count integer NOT NULL CHECK (expected_bar_count IN (96,288)),
  expected_direction text CHECK (expected_direction IS NULL OR expected_direction IN ('UP','DOWN','RANGE')),
  direction_threshold numeric NOT NULL,
  raw_threshold numeric NOT NULL,
  threshold_floor numeric NOT NULL,
  threshold_ceiling numeric NOT NULL,
  threshold_formula_version text NOT NULL,
  atr14_four_hour_at_generation numeric NOT NULL CHECK (atr14_four_hour_at_generation > 0),
  -- CEO裁决第7条：primaryState/fusionState恒UNKNOWN，与生产forecast_snapshots同一红线。
  target_state_at_generation text NOT NULL CHECK (target_state_at_generation = 'UNKNOWN'),
  proxy_state_at_generation text NOT NULL,
  fusion_state_at_generation text NOT NULL CHECK (fusion_state_at_generation = 'UNKNOWN'),
  candidate_trajectories jsonb NOT NULL,
  scenario_weight_baseline integer NOT NULL CHECK (scenario_weight_baseline >= 0),
  scenario_weight_upside integer NOT NULL CHECK (scenario_weight_upside >= 0),
  scenario_weight_downside integer NOT NULL CHECK (scenario_weight_downside >= 0),
  -- CEO裁决第6条：calibratedProbabilities恒null。
  probability_status text NOT NULL CHECK (probability_status = 'rule_based'),
  calibrated_probabilities jsonb CHECK (calibrated_probabilities IS NULL),
  brier_score_component numeric CHECK (brier_score_component IS NULL),
  expected_price_zones jsonb NOT NULL,
  trigger_conditions jsonb NOT NULL,
  invalidation_conditions jsonb NOT NULL,
  algorithm_version text NOT NULL,
  weight_version text NOT NULL,
  rule_version text NOT NULL,
  data_vintage_refs jsonb NOT NULL,
  feature_values_used jsonb NOT NULL,
  feature_record_ids jsonb NOT NULL,
  feature_engine_version text NOT NULL,
  content_hash char(64) NOT NULL,
  auxiliary_evidence jsonb NOT NULL,
  -- §2.3 P1-1：ActionPermission结构性排除——本表不设该列（不适用，见规范文档§2.3该行说明）。
  historical_as_of_time timestamptz NOT NULL,
  research_data_vintage jsonb NOT NULL,
  research_availability_rule_version text NOT NULL,
  -- 独立CHECK域，与生产 forecast_snapshots(source_origin='SERVER') 互不相交，CEO裁决第2条的直接落实。
  source_origin text NOT NULL CHECK (source_origin = 'HISTORICAL_REPLAY'),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- §2.3：与生产同款字段级CHECK红线。
  CHECK (target_start_time < target_end_time),
  CHECK (extract(epoch FROM (target_end_time - target_start_time))*1000 = expected_bar_count * 900000),
  CHECK (generated_at >= data_cutoff_time),
  CHECK (scenario_weight_baseline + scenario_weight_upside + scenario_weight_downside = 100),
  CHECK (direction_threshold >= threshold_floor AND direction_threshold <= threshold_ceiling),
  CHECK ((horizon = '24h' AND threshold_floor = 0.008 AND threshold_ceiling = 0.05) OR (horizon = '72h' AND threshold_floor = 0.015 AND threshold_ceiling = 0.08)),
  -- §2.3 P1-2：复合唯一约束，research_availability_rule_version变化时允许并存，不被静默去重。
  UNIQUE (prediction_id, research_availability_rule_version)
);
CREATE INDEX IF NOT EXISTS replay_snapshots_query_idx ON historical_validation.replay_snapshots(instrument, horizon, target_end_time);
CREATE INDEX IF NOT EXISTS replay_snapshots_generated_idx ON historical_validation.replay_snapshots(generated_at DESC);
CREATE INDEX IF NOT EXISTS replay_snapshots_dataset_version_idx ON historical_validation.replay_snapshots(dataset_version);

-- §2.0 分类B：与生产forecast_snapshots同一红线，一旦写入永不修改——但注意分类B的定义原文是
-- "严格只增型（自创建起从不允许任何UPDATE）"，只禁UPDATE，不禁DELETE（这与dataset_manifests不同，
-- 后者的§2.8行内说明明确要求即使清理单个validation_run后manifest本身仍必须保留，因而额外禁DELETE）。
-- §三.1冻结的单run清理顺序（cleanup-single-run.js）明确要求"DELETE FROM replay_snapshots WHERE
-- generation_run_id IN (...)"，若本表也禁DELETE，该清理脚本将永远无法执行——只加no_update触发器，
-- 不加no_delete，删除权限收归cleanup-single-run.js一处、按§三.1顺序执行，不做数据库层UPDATE保护之外的限制。
CREATE OR REPLACE FUNCTION historical_validation.reject_replay_snapshot_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'REPLAY_SNAPSHOT_IMMUTABLE' USING ERRCODE='55000'; END $$;
DROP TRIGGER IF EXISTS replay_snapshots_no_update ON historical_validation.replay_snapshots;
DROP TRIGGER IF EXISTS replay_snapshots_no_delete ON historical_validation.replay_snapshots;
CREATE TRIGGER replay_snapshots_no_update BEFORE UPDATE ON historical_validation.replay_snapshots FOR EACH ROW EXECUTE FUNCTION historical_validation.reject_replay_snapshot_mutation();

-- ---------------------------------------------------------------------------
-- 7. replay_outcome_events（§2.5）——历史ForecastOutcomeEvent对应物，含误差归因结构（V1_4_HISTORICAL_VALIDATION_SPEC.md §5）。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS historical_validation.replay_outcome_events (
  replay_outcome_event_id bigserial PRIMARY KEY,
  prediction_id text NOT NULL,
  evaluation_version text NOT NULL,
  evaluation_run_id uuid NOT NULL REFERENCES historical_validation.replay_evaluation_runs(evaluation_run_id),
  research_availability_rule_version text NOT NULL,
  evaluated_at timestamptz NOT NULL,
  historical_as_of_time timestamptz NOT NULL,
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
  research_data_vintage jsonb NOT NULL,
  -- V1_4_HISTORICAL_VALIDATION_SPEC.md §5 误差归因结构：primaryCause只能取"可评估"/"部分可评估"子集
  -- （target_state_misread/proxy_transition_misread/price_zone_error/data_missing_or_delayed），
  -- exogenous_shock本轮起不是primaryCause/secondaryCauses的合法取值（§5.1/§5.2a）。
  primary_cause text CHECK (primary_cause IS NULL OR primary_cause IN (
    'target_state_misread','proxy_transition_misread','price_zone_error','data_missing_or_delayed'
  )),
  secondary_causes jsonb NOT NULL DEFAULT '[]',
  attribution_evidence jsonb NOT NULL DEFAULT '[]',
  attribution_confidence numeric CHECK (attribution_confidence IS NULL OR (attribution_confidence >= 0 AND attribution_confidence <= 100)),
  -- §5.2红线："部分可评估"（target_state_misread）类置信度必须显式压低（<=50）。
  requires_human_review boolean NOT NULL DEFAULT false,
  not_evaluable_causes jsonb NOT NULL DEFAULT '[]',
  attribution_rule_version text,
  source_origin text NOT NULL CHECK (source_origin = 'HISTORICAL_REPLAY'),
  content_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (prediction_id, research_availability_rule_version)
    REFERENCES historical_validation.replay_snapshots(prediction_id, research_availability_rule_version) ON DELETE RESTRICT,
  UNIQUE (prediction_id, evaluation_version, research_availability_rule_version),
  CHECK (direction_eligible_for_statistics OR (actual_return IS NULL AND actual_direction IS NULL AND direction_correct IS NULL)),
  CHECK (path_eligible_for_statistics OR (actual_high IS NULL AND actual_low IS NULL AND mfe IS NULL AND mae IS NULL AND invalidation_triggered IS NULL AND range_specific_metrics IS NULL)),
  CHECK (direction_eligible_for_statistics OR coverage_metrics IS NULL),
  CHECK (primary_cause IS DISTINCT FROM 'target_state_misread' OR attribution_confidence IS NULL OR attribution_confidence <= 50)
);
CREATE INDEX IF NOT EXISTS replay_outcome_events_prediction_idx ON historical_validation.replay_outcome_events(prediction_id);

-- 同上replay_snapshots的说明：分类B只禁UPDATE，不禁DELETE——§三.1单run清理顺序需要对本表执行DELETE，
-- 只加no_update触发器。
CREATE OR REPLACE FUNCTION historical_validation.reject_replay_outcome_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'REPLAY_OUTCOME_EVENT_IMMUTABLE' USING ERRCODE='55000'; END $$;
DROP TRIGGER IF EXISTS replay_outcome_events_no_update ON historical_validation.replay_outcome_events;
DROP TRIGGER IF EXISTS replay_outcome_events_no_delete ON historical_validation.replay_outcome_events;
CREATE TRIGGER replay_outcome_events_no_update BEFORE UPDATE ON historical_validation.replay_outcome_events FOR EACH ROW EXECUTE FUNCTION historical_validation.reject_replay_outcome_event_mutation();

-- ---------------------------------------------------------------------------
-- 8. validation_reports（§2.7）——统计结果表，唯一允许覆盖写（分类C）的表。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS historical_validation.validation_reports (
  report_id uuid PRIMARY KEY,
  validation_run_id uuid NOT NULL REFERENCES historical_validation.validation_runs(validation_run_id),
  dataset_version text NOT NULL REFERENCES historical_validation.dataset_manifests(dataset_version),
  horizon text NOT NULL CHECK (horizon IN ('24h','72h')),
  report_scope text NOT NULL CHECK (report_scope IN ('ALL','TRAIN','VALIDATION','TEST','ROLLING_WINDOW')),
  direction_raw_sample_count integer NOT NULL DEFAULT 0 CHECK (direction_raw_sample_count >= 0),
  direction_effective_sample_count integer NOT NULL DEFAULT 0 CHECK (direction_effective_sample_count >= 0),
  path_raw_sample_count integer NOT NULL DEFAULT 0 CHECK (path_raw_sample_count >= 0),
  path_effective_sample_count integer NOT NULL DEFAULT 0 CHECK (path_effective_sample_count >= 0),
  sample_sufficient boolean NOT NULL DEFAULT false,
  purged_straddling_count integer NOT NULL DEFAULT 0 CHECK (purged_straddling_count >= 0),
  po_state_breakdown jsonb NOT NULL DEFAULT '{}',
  up_down_range_breakdown jsonb NOT NULL DEFAULT '{}',
  formal_proxy_disclosure jsonb NOT NULL DEFAULT '{}',
  calibrated_probabilities_status text NOT NULL DEFAULT 'null (V1.4D not eligible)',
  brier_score_component numeric CHECK (brier_score_component IS NULL),
  error_attribution_summary jsonb NOT NULL DEFAULT '{}',
  algorithm_version text NOT NULL,
  rule_version text NOT NULL,
  research_availability_rule_version text NOT NULL,
  content_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- §1.1修订：report_scope='ALL'时purge不适用，purged_straddling_count恒为0。
  CHECK (report_scope <> 'ALL' OR purged_straddling_count = 0),
  UNIQUE (validation_run_id, horizon, report_scope)
);
CREATE INDEX IF NOT EXISTS validation_reports_run_idx ON historical_validation.validation_reports(validation_run_id);
