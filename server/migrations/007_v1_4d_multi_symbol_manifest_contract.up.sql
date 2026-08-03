-- V1_4D_MULTI_SYMBOL_MANIFEST_ADDENDUM.md §11.2.
-- Contract versioning is metadata-only: no application DML and no legacy hash rewrite.

ALTER TABLE historical_validation.dataset_manifests
  ADD COLUMN IF NOT EXISTS manifest_contract_version integer NOT NULL DEFAULT 1;

ALTER TABLE historical_validation.dataset_manifests
  ADD COLUMN IF NOT EXISTS dataset_type text NOT NULL DEFAULT 'MARKET_BARS';

ALTER TABLE historical_validation.dataset_manifests
  ALTER COLUMN symbol DROP NOT NULL;

ALTER TABLE historical_validation.dataset_manifests
  ADD COLUMN IF NOT EXISTS symbols jsonb;

ALTER TABLE historical_validation.dataset_manifests
  ADD COLUMN IF NOT EXISTS dependency_set jsonb;

ALTER TABLE historical_validation.dataset_manifests
  DROP CONSTRAINT IF EXISTS dataset_manifests_contract_version_known;
ALTER TABLE historical_validation.dataset_manifests
  ADD CONSTRAINT dataset_manifests_contract_version_known
  CHECK (manifest_contract_version IN (1, 2));

ALTER TABLE historical_validation.dataset_manifests
  DROP CONSTRAINT IF EXISTS dataset_manifests_dataset_type_known;
ALTER TABLE historical_validation.dataset_manifests
  ADD CONSTRAINT dataset_manifests_dataset_type_known
  CHECK (dataset_type = 'MARKET_BARS');

ALTER TABLE historical_validation.dataset_manifests
  DROP CONSTRAINT IF EXISTS dataset_manifests_contract_v1_shape;
ALTER TABLE historical_validation.dataset_manifests
  ADD CONSTRAINT dataset_manifests_contract_v1_shape
  CHECK (manifest_contract_version <> 1 OR (
    symbol IS NOT NULL AND symbols IS NULL AND dependency_set IS NULL
  ));

ALTER TABLE historical_validation.dataset_manifests
  DROP CONSTRAINT IF EXISTS dataset_manifests_contract_v2_shape;
ALTER TABLE historical_validation.dataset_manifests
  ADD CONSTRAINT dataset_manifests_contract_v2_shape
  CHECK (manifest_contract_version <> 2 OR (
    symbol IS NULL
    AND symbols IS NOT NULL AND jsonb_typeof(symbols) = 'array' AND jsonb_array_length(symbols) > 0
    AND dependency_set IS NOT NULL AND jsonb_typeof(dependency_set) = 'array' AND jsonb_array_length(dependency_set) > 0
    AND fixed_as_of IS NOT NULL
    AND logical_window_hash IS NOT NULL
  ));

ALTER TABLE historical_validation.dataset_manifests
  ALTER COLUMN manifest_contract_version DROP DEFAULT;
ALTER TABLE historical_validation.dataset_manifests
  ALTER COLUMN dataset_type DROP DEFAULT;
