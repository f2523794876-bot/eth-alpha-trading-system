-- Execution package 2 governance additions. Migration 005 remains immutable.
-- Legacy rows are retained; all manifests/backfill batches created by the new
-- application path populate these fields.

ALTER TABLE historical_validation.backfill_batches
  ADD COLUMN IF NOT EXISTS fixed_as_of timestamptz;

ALTER TABLE historical_validation.dataset_manifests
  ADD COLUMN IF NOT EXISTS fixed_as_of timestamptz,
  ADD COLUMN IF NOT EXISTS logical_window_hash char(64);

CREATE UNIQUE INDEX IF NOT EXISTS dataset_manifests_logical_window_hash_uidx
  ON historical_validation.dataset_manifests(logical_window_hash)
  WHERE logical_window_hash IS NOT NULL;

ALTER TABLE historical_validation.dataset_manifests
  DROP CONSTRAINT IF EXISTS dataset_manifests_logical_window_hash_format;
ALTER TABLE historical_validation.dataset_manifests
  ADD CONSTRAINT dataset_manifests_logical_window_hash_format
  CHECK (logical_window_hash IS NULL OR logical_window_hash ~ '^[0-9a-f]{64}$');
