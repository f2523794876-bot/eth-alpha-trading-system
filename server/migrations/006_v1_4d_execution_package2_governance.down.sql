DROP INDEX IF EXISTS historical_validation.dataset_manifests_logical_window_hash_uidx;
ALTER TABLE historical_validation.dataset_manifests
  DROP CONSTRAINT IF EXISTS dataset_manifests_logical_window_hash_format,
  DROP COLUMN IF EXISTS logical_window_hash,
  DROP COLUMN IF EXISTS fixed_as_of;
ALTER TABLE historical_validation.backfill_batches
  DROP COLUMN IF EXISTS fixed_as_of;
