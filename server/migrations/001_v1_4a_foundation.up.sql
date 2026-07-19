CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS source_registry (
  source_id text PRIMARY KEY, display_name text NOT NULL, source_type text NOT NULL,
  official boolean NOT NULL, auth_mode text NOT NULL CHECK (auth_mode IN ('NONE','ENV_ONLY','UNAVAILABLE')),
  status text NOT NULL, base_url text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS source_endpoint_registry (
  endpoint_id text PRIMARY KEY, source_id text NOT NULL REFERENCES source_registry(source_id),
  method text NOT NULL CHECK (method='GET'), path_template text NOT NULL, data_type text NOT NULL,
  expected_frequency_ms bigint, request_weight integer, schema_version text NOT NULL,
  enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO source_registry(source_id,display_name,source_type,official,auth_mode,status,base_url) VALUES
 ('binance-spot-rest','Binance Spot REST','exchange',true,'NONE','AVAILABLE','https://api.binance.com'),
 ('binance-usdt-futures-rest','Binance USDⓈ-M Futures REST','exchange',true,'NONE','AVAILABLE','https://fapi.binance.com'),
 ('macro-adapter-placeholder','Macro adapter placeholder','macro',true,'UNAVAILABLE','UNAVAILABLE',NULL)
ON CONFLICT(source_id) DO NOTHING;
INSERT INTO source_endpoint_registry(endpoint_id,source_id,method,path_template,data_type,expected_frequency_ms,request_weight,schema_version,enabled) VALUES
 ('binance-spot-time','binance-spot-rest','GET','/api/v3/time','server_time',30000,1,'binance-spot-time-v1',true),
 ('binance-spot-klines','binance-spot-rest','GET','/api/v3/klines','market_bar',30000,2,'binance-kline-v1',true),
 ('binance-futures-klines','binance-usdt-futures-rest','GET','/fapi/v1/klines','market_bar',60000,5,'binance-kline-v1',true),
 ('binance-futures-funding-rate','binance-usdt-futures-rest','GET','/fapi/v1/fundingRate','funding_rate',300000,1,'binance-funding-v1',true),
 ('binance-futures-open-interest','binance-usdt-futures-rest','GET','/fapi/v1/openInterest','open_interest',60000,1,'binance-open-interest-v1',true),
 ('binance-futures-global-long-short','binance-usdt-futures-rest','GET','/futures/data/globalLongShortAccountRatio','long_short_ratio',900000,1,'binance-long-short-v1',true),
 ('binance-futures-taker-flow','binance-usdt-futures-rest','GET','/futures/data/takerlongshortRatio','taker_flow',900000,1,'binance-taker-flow-v1',true)
ON CONFLICT(endpoint_id) DO NOTHING;
CREATE TABLE IF NOT EXISTS collection_runs (
  run_id uuid PRIMARY KEY, collector_id text NOT NULL, started_at timestamptz NOT NULL,
  finished_at timestamptz, status text NOT NULL, server_time jsonb, error_code text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS collection_attempts (
  attempt_id bigserial PRIMARY KEY, run_id uuid REFERENCES collection_runs(run_id), request_id uuid NOT NULL,
  source_id text NOT NULL REFERENCES source_registry(source_id), endpoint_id text NOT NULL REFERENCES source_endpoint_registry(endpoint_id),
  instrument text, market_type text, interval_name text, attempt_number integer NOT NULL,
  started_at timestamptz NOT NULL, finished_at timestamptz, http_status integer, round_trip_ms integer,
  rate_limited boolean NOT NULL DEFAULT false, success boolean NOT NULL, error_code text, error_detail text,
  UNIQUE(request_id, attempt_number)
);
CREATE TABLE IF NOT EXISTS raw_payloads (
  raw_payload_id uuid PRIMARY KEY, request_id uuid NOT NULL, source_id text NOT NULL REFERENCES source_registry(source_id),
  endpoint_id text NOT NULL REFERENCES source_endpoint_registry(endpoint_id), fetched_at timestamptz NOT NULL,
  http_status integer NOT NULL, response_headers jsonb NOT NULL DEFAULT '{}', payload jsonb NOT NULL,
  content_hash char(64) NOT NULL, schema_version text NOT NULL, quality_state text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(request_id, content_hash)
);
CREATE TABLE IF NOT EXISTS provisional_market_bars (
  provisional_id bigserial PRIMARY KEY, source_id text NOT NULL, endpoint_id text NOT NULL,
  instrument text NOT NULL, market_type text NOT NULL, interval_name text NOT NULL,
  open_time timestamptz NOT NULL, close_time timestamptz NOT NULL, open numeric NOT NULL, high numeric NOT NULL,
  low numeric NOT NULL, close numeric NOT NULL, volume numeric NOT NULL, quote_volume numeric NOT NULL,
  fetched_at timestamptz NOT NULL, raw_payload_id uuid NOT NULL REFERENCES raw_payloads(raw_payload_id),
  content_hash char(64) NOT NULL, expires_at timestamptz NOT NULL,
  UNIQUE(source_id, market_type, instrument, interval_name, open_time, content_hash)
);
CREATE TABLE IF NOT EXISTS market_bars (
  market_bar_id bigserial PRIMARY KEY, source_id text NOT NULL, endpoint_id text NOT NULL,
  instrument text NOT NULL, market_type text NOT NULL, interval_name text NOT NULL,
  open_time timestamptz NOT NULL, close_time timestamptz NOT NULL,
  open numeric NOT NULL CHECK(open>=0), high numeric NOT NULL CHECK(high>=open AND high>=close AND high>=low),
  low numeric NOT NULL CHECK(low<=open AND low<=close AND low<=high), close numeric NOT NULL CHECK(close>=0),
  volume numeric NOT NULL CHECK(volume>=0), quote_volume numeric NOT NULL CHECK(quote_volume>=0), trade_count bigint,
  taker_buy_base_volume numeric, taker_buy_quote_volume numeric,
  observation_start timestamptz NOT NULL, observation_end timestamptz NOT NULL,
  published_at timestamptz NOT NULL, available_at timestamptz NOT NULL, first_available_at timestamptz NOT NULL,
  fetched_at timestamptz NOT NULL, revision_number integer NOT NULL DEFAULT 0 CHECK(revision_number>=0),
  vintage_id text NOT NULL UNIQUE, raw_payload_id uuid NOT NULL REFERENCES raw_payloads(raw_payload_id), request_id uuid NOT NULL,
  schema_version text NOT NULL, normalizer_version text NOT NULL, quality_state text NOT NULL, missing_reason text,
  content_hash char(64) NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(open_time=observation_start AND close_time=observation_end), CHECK(published_at<=available_at),
  CHECK(available_at<=first_available_at AND first_available_at<=fetched_at),
  UNIQUE(source_id, market_type, instrument, interval_name, open_time, revision_number)
);
CREATE INDEX IF NOT EXISTS market_bars_path_idx ON market_bars(instrument, market_type, interval_name, open_time);
CREATE INDEX IF NOT EXISTS market_bars_asof_idx ON market_bars(available_at, vintage_id);

CREATE TABLE IF NOT EXISTS funding_rates (
  id bigserial PRIMARY KEY, source_id text NOT NULL, endpoint_id text NOT NULL, instrument text NOT NULL,
  market_type text NOT NULL DEFAULT 'usdt_perpetual', observation_time timestamptz NOT NULL, funding_rate numeric NOT NULL,
  mark_price numeric, published_at timestamptz NOT NULL, available_at timestamptz NOT NULL,
  first_available_at timestamptz NOT NULL, fetched_at timestamptz NOT NULL, revision_number integer NOT NULL,
  vintage_id text NOT NULL UNIQUE, raw_payload_id uuid NOT NULL REFERENCES raw_payloads(raw_payload_id), request_id uuid NOT NULL,
  schema_version text NOT NULL, quality_state text NOT NULL, missing_reason text, content_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), CHECK(published_at<=available_at AND available_at<=first_available_at),
  UNIQUE(source_id,instrument,observation_time,revision_number)
);
CREATE TABLE IF NOT EXISTS open_interest (
  id bigserial PRIMARY KEY, source_id text NOT NULL, endpoint_id text NOT NULL, instrument text NOT NULL,
  market_type text NOT NULL DEFAULT 'usdt_perpetual', observation_time timestamptz NOT NULL, open_interest numeric NOT NULL CHECK(open_interest>=0),
  published_at timestamptz NOT NULL, available_at timestamptz NOT NULL, first_available_at timestamptz NOT NULL, fetched_at timestamptz NOT NULL,
  revision_number integer NOT NULL, vintage_id text NOT NULL UNIQUE, raw_payload_id uuid NOT NULL REFERENCES raw_payloads(raw_payload_id),
  request_id uuid NOT NULL, schema_version text NOT NULL, quality_state text NOT NULL, missing_reason text, content_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(source_id,instrument,observation_time,revision_number)
);
CREATE TABLE IF NOT EXISTS long_short_ratios (
  id bigserial PRIMARY KEY, source_id text NOT NULL, endpoint_id text NOT NULL, instrument text NOT NULL, interval_name text NOT NULL,
  observation_time timestamptz NOT NULL, long_short_ratio numeric NOT NULL, long_account numeric NOT NULL, short_account numeric NOT NULL,
  published_at timestamptz NOT NULL, available_at timestamptz NOT NULL, first_available_at timestamptz NOT NULL, fetched_at timestamptz NOT NULL,
  revision_number integer NOT NULL, vintage_id text NOT NULL UNIQUE, raw_payload_id uuid NOT NULL REFERENCES raw_payloads(raw_payload_id),
  request_id uuid NOT NULL, schema_version text NOT NULL, quality_state text NOT NULL, content_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(source_id,instrument,interval_name,observation_time,revision_number)
);
CREATE TABLE IF NOT EXISTS taker_flow (
  id bigserial PRIMARY KEY, source_id text NOT NULL, endpoint_id text NOT NULL, instrument text NOT NULL, interval_name text NOT NULL,
  observation_time timestamptz NOT NULL, buy_sell_ratio numeric NOT NULL, buy_volume numeric NOT NULL CHECK(buy_volume>=0), sell_volume numeric NOT NULL CHECK(sell_volume>=0),
  published_at timestamptz NOT NULL, available_at timestamptz NOT NULL, first_available_at timestamptz NOT NULL, fetched_at timestamptz NOT NULL,
  revision_number integer NOT NULL, vintage_id text NOT NULL UNIQUE, raw_payload_id uuid NOT NULL REFERENCES raw_payloads(raw_payload_id),
  request_id uuid NOT NULL, schema_version text NOT NULL, quality_state text NOT NULL, content_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(source_id,instrument,interval_name,observation_time,revision_number)
);
CREATE TABLE IF NOT EXISTS data_revision_events (
  revision_event_id text PRIMARY KEY, dataset text NOT NULL, natural_key jsonb NOT NULL, previous_vintage_id text NOT NULL,
  new_vintage_id text NOT NULL, detected_at timestamptz NOT NULL, reason text, content_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), CHECK(previous_vintage_id<>new_vintage_id)
);
CREATE TABLE IF NOT EXISTS data_gaps (
  gap_id text PRIMARY KEY, source_id text NOT NULL, instrument text NOT NULL, market_type text NOT NULL, interval_name text NOT NULL,
  start_open_time timestamptz NOT NULL, end_open_time timestamptz NOT NULL, missing_count integer NOT NULL CHECK(missing_count>0),
  status text NOT NULL CHECK(status IN ('OPEN','BACKFILLING','RESOLVED','UNRESOLVED')), missing_reason text,
  detected_at timestamptz NOT NULL, resolved_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_id,instrument,market_type,interval_name,start_open_time,end_open_time)
);
CREATE TABLE IF NOT EXISTS backfill_jobs (
  job_id text PRIMARY KEY, gap_id text NOT NULL REFERENCES data_gaps(gap_id), status text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0, next_attempt_at timestamptz, last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS data_health_snapshots (
  health_snapshot_id bigserial PRIMARY KEY, source_id text NOT NULL, endpoint_id text, dataset_key text NOT NULL,
  health_state text NOT NULL CHECK(health_state IN ('HEALTHY','WARNING','DEGRADED','BLOCKED','RECOVERING')),
  latest_success_at timestamptz, latest_data_at timestamptz, data_age_ms bigint, expected_frequency_ms bigint,
  missing_count integer NOT NULL DEFAULT 0, duplicate_count integer NOT NULL DEFAULT 0, anomaly_count integer NOT NULL DEFAULT 0,
  consecutive_failures integer NOT NULL DEFAULT 0, last_http_status integer, rate_limited boolean NOT NULL DEFAULT false,
  clock_offset_ms bigint, pending_backfill_count integer NOT NULL DEFAULT 0, last_recovered_at timestamptz,
  reasons jsonb NOT NULL DEFAULT '[]', evaluated_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS health_latest_idx ON data_health_snapshots(dataset_key,evaluated_at DESC);
CREATE TABLE IF NOT EXISTS source_audit_events (
  audit_event_id uuid PRIMARY KEY, event_type text NOT NULL, source_id text, endpoint_id text, request_id uuid,
  severity text NOT NULL, detail jsonb NOT NULL, occurred_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS collector_leases (
  lease_name text PRIMARY KEY, holder_id text NOT NULL, acquired_at timestamptz NOT NULL, heartbeat_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL, fencing_token bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS dead_letter_records (
  dead_letter_id bigserial PRIMARY KEY, source_id text, endpoint_id text, request_id uuid, raw_payload_id uuid REFERENCES raw_payloads(raw_payload_id),
  error_code text NOT NULL, error_detail text, retryable boolean NOT NULL, retry_count integer NOT NULL,
  payload_ref jsonb, created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS funding_query_idx ON funding_rates(instrument,observation_time DESC);
CREATE INDEX IF NOT EXISTS oi_query_idx ON open_interest(instrument,observation_time DESC);
CREATE INDEX IF NOT EXISTS gaps_open_idx ON data_gaps(status,instrument,interval_name);
