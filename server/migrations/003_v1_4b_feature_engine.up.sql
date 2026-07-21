CREATE TABLE IF NOT EXISTS feature_sets (
  feature_set_version text PRIMARY KEY,
  algorithm_version text NOT NULL,
  schema_version text NOT NULL,
  definition jsonb NOT NULL,
  definition_hash char(64) NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feature_generation_runs (
  generation_run_id uuid PRIMARY KEY,
  feature_set_version text NOT NULL REFERENCES feature_sets(feature_set_version),
  symbol text NOT NULL,
  target_interval text NOT NULL CHECK (target_interval IN ('15m','1h','4h')),
  range_start timestamptz,
  range_end timestamptz,
  status text NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','FAILED','DRY_RUN')),
  dry_run boolean NOT NULL DEFAULT false,
  generated_count integer NOT NULL DEFAULT 0 CHECK (generated_count>=0),
  deduped_count integer NOT NULL DEFAULT 0 CHECK (deduped_count>=0),
  revised_count integer NOT NULL DEFAULT 0 CHECK (revised_count>=0),
  blocked_count integer NOT NULL DEFAULT 0 CHECK (blocked_count>=0),
  cursor_close_time timestamptz,
  error_code text,
  lease_name text,
  fencing_token bigint,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feature_records (
  feature_record_id bigserial PRIMARY KEY,
  feature_id text NOT NULL,
  symbol text NOT NULL,
  target_interval text NOT NULL CHECK (target_interval IN ('15m','1h','4h')),
  target_bar_open_time timestamptz NOT NULL,
  target_bar_close_time timestamptz NOT NULL,
  as_of_time timestamptz NOT NULL,
  generated_at timestamptz NOT NULL,
  feature_set_version text NOT NULL REFERENCES feature_sets(feature_set_version),
  algorithm_version text NOT NULL,
  source_dataset_version text NOT NULL,
  revision_number integer NOT NULL DEFAULT 0 CHECK (revision_number>=0),
  completeness numeric NOT NULL CHECK (completeness>=0 AND completeness<=1),
  quality_state text NOT NULL CHECK (quality_state IN ('HEALTHY','WARNING','DEGRADED','BLOCKED')),
  missing_features jsonb NOT NULL DEFAULT '[]',
  degraded_reasons jsonb NOT NULL DEFAULT '[]',
  source_vintage_refs jsonb NOT NULL DEFAULT '[]',
  source_revision_refs jsonb NOT NULL DEFAULT '[]',
  feature_values jsonb NOT NULL,
  availability jsonb NOT NULL,
  content_hash char(64) NOT NULL,
  generation_run_id uuid REFERENCES feature_generation_runs(generation_run_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (target_bar_open_time < target_bar_close_time),
  CHECK (target_bar_close_time <= as_of_time),
  CHECK (as_of_time <= generated_at),
  UNIQUE(symbol,target_interval,target_bar_close_time,feature_set_version,revision_number),
  UNIQUE(feature_id,revision_number)
);
CREATE INDEX IF NOT EXISTS feature_records_range_idx ON feature_records(symbol,target_interval,target_bar_close_time,feature_set_version,revision_number DESC);

CREATE TABLE IF NOT EXISTS feature_source_refs (
  feature_source_ref_id bigserial PRIMARY KEY,
  feature_record_id bigint NOT NULL REFERENCES feature_records(feature_record_id) ON DELETE RESTRICT,
  dataset text NOT NULL,
  source_name text NOT NULL,
  symbol text NOT NULL,
  interval_name text,
  natural_key jsonb NOT NULL,
  source_revision integer NOT NULL CHECK(source_revision>=0),
  source_time timestamptz NOT NULL,
  published_at timestamptz NOT NULL,
  available_at timestamptz NOT NULL,
  raw_payload_id uuid REFERENCES raw_payloads(raw_payload_id),
  source_record_id text NOT NULL,
  vintage_id text NOT NULL,
  content_hash char(64) NOT NULL,
  CHECK (published_at<=available_at),
  UNIQUE(feature_record_id,dataset,source_record_id,vintage_id)
);
CREATE INDEX IF NOT EXISTS feature_source_refs_record_idx ON feature_source_refs(feature_record_id);

CREATE TABLE IF NOT EXISTS feature_quality_events (
  feature_quality_event_id text PRIMARY KEY,
  feature_record_id bigint REFERENCES feature_records(feature_record_id) ON DELETE RESTRICT,
  feature_id text NOT NULL,
  quality_state text NOT NULL CHECK (quality_state IN ('HEALTHY','WARNING','DEGRADED','BLOCKED')),
  event_type text NOT NULL,
  reasons jsonb NOT NULL DEFAULT '[]',
  occurred_at timestamptz NOT NULL,
  content_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feature_revision_events (
  feature_revision_event_id text PRIMARY KEY,
  feature_id text NOT NULL,
  previous_feature_record_id bigint NOT NULL REFERENCES feature_records(feature_record_id),
  new_feature_record_id bigint NOT NULL REFERENCES feature_records(feature_record_id),
  previous_content_hash char(64) NOT NULL,
  new_content_hash char(64) NOT NULL,
  detected_at timestamptz NOT NULL,
  CHECK(previous_feature_record_id<>new_feature_record_id),
  CHECK(previous_content_hash<>new_content_hash)
);
