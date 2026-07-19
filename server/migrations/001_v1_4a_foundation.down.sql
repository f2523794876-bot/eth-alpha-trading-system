-- Explicitly destructive; run only on an empty disposable V1.4A database.
DROP TABLE IF EXISTS dead_letter_records, collector_leases, source_audit_events, data_health_snapshots,
  backfill_jobs, data_gaps, data_revision_events, taker_flow, long_short_ratios, open_interest,
  funding_rates, market_bars, provisional_market_bars, raw_payloads, collection_attempts,
  collection_runs, source_endpoint_registry, source_registry CASCADE;
DELETE FROM schema_migrations WHERE version='001_v1_4a_foundation';
