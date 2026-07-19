CREATE OR REPLACE FUNCTION eth_alpha_reject_raw_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'RAW_PAYLOAD_IMMUTABLE' USING ERRCODE='55000'; END $$;
DROP TRIGGER IF EXISTS raw_payloads_no_update ON raw_payloads;
DROP TRIGGER IF EXISTS raw_payloads_no_delete ON raw_payloads;
CREATE TRIGGER raw_payloads_no_update BEFORE UPDATE ON raw_payloads FOR EACH ROW EXECUTE FUNCTION eth_alpha_reject_raw_mutation();
CREATE TRIGGER raw_payloads_no_delete BEFORE DELETE ON raw_payloads FOR EACH ROW EXECUTE FUNCTION eth_alpha_reject_raw_mutation();

ALTER TABLE funding_rates ADD CONSTRAINT funding_time_order CHECK (published_at<=available_at AND available_at<=first_available_at AND first_available_at<=fetched_at);
ALTER TABLE open_interest ADD CONSTRAINT open_interest_time_order CHECK (published_at<=available_at AND available_at<=first_available_at AND first_available_at<=fetched_at);
ALTER TABLE long_short_ratios ADD CONSTRAINT long_short_time_order CHECK (published_at<=available_at AND available_at<=first_available_at AND first_available_at<=fetched_at);
ALTER TABLE taker_flow ADD CONSTRAINT taker_flow_time_order CHECK (published_at<=available_at AND available_at<=first_available_at AND first_available_at<=fetched_at);

ALTER TABLE provisional_market_bars ADD COLUMN IF NOT EXISTS request_id uuid;
ALTER TABLE provisional_market_bars ADD COLUMN IF NOT EXISTS promoted_market_bar_id bigint REFERENCES market_bars(market_bar_id);
ALTER TABLE provisional_market_bars ADD COLUMN IF NOT EXISTS promoted_at timestamptz;

ALTER TABLE backfill_jobs ADD COLUMN IF NOT EXISTS worker_id text;
ALTER TABLE backfill_jobs ADD COLUMN IF NOT EXISTS lease_name text;
ALTER TABLE backfill_jobs ADD COLUMN IF NOT EXISTS fencing_token bigint;
ALTER TABLE backfill_jobs ADD COLUMN IF NOT EXISTS started_at timestamptz;
ALTER TABLE backfill_jobs ADD COLUMN IF NOT EXISTS finished_at timestamptz;
ALTER TABLE backfill_jobs ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz;
ALTER TABLE backfill_jobs ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 5;
ALTER TABLE backfill_jobs ADD CONSTRAINT backfill_status_v14a CHECK (status IN ('PENDING','RUNNING','RETRY_WAIT','SUCCEEDED','FAILED_PERMANENT'));
CREATE INDEX IF NOT EXISTS backfill_claim_idx ON backfill_jobs(status,next_attempt_at,created_at);

ALTER TABLE collection_runs ADD COLUMN IF NOT EXISTS lease_name text;
ALTER TABLE collection_runs ADD COLUMN IF NOT EXISTS fencing_token bigint;
ALTER TABLE collection_attempts ADD COLUMN IF NOT EXISTS fencing_token bigint;
ALTER TABLE data_revision_events ADD COLUMN IF NOT EXISTS available_at timestamptz;
ALTER TABLE data_revision_events ADD COLUMN IF NOT EXISTS fetched_at timestamptz;

ALTER TABLE data_health_snapshots ADD COLUMN IF NOT EXISTS latest_attempt_at timestamptz;
ALTER TABLE data_health_snapshots ADD COLUMN IF NOT EXISTS circuit_state text;
ALTER TABLE data_health_snapshots ADD COLUMN IF NOT EXISTS recovery_started_at timestamptz;
ALTER TABLE data_health_snapshots ADD COLUMN IF NOT EXISTS last_error_code text;
