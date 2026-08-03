-- V1_4D_MULTI_SYMBOL_MANIFEST_ADDENDUM.md §11.2 rollback guard.
DO $$
DECLARE
  v2_count integer;
BEGIN
  SELECT count(*) INTO v2_count
  FROM historical_validation.dataset_manifests
  WHERE manifest_contract_version = 2;

  IF v2_count > 0 THEN
    RAISE EXCEPTION
      'MIGRATION_007_ROLLBACK_BLOCKED: % manifest_contract_version=2 rows exist; rollback would destroy multi-symbol manifest identity data',
      v2_count;
  END IF;
END $$;

ALTER TABLE historical_validation.dataset_manifests
  DROP CONSTRAINT IF EXISTS dataset_manifests_contract_v2_shape,
  DROP CONSTRAINT IF EXISTS dataset_manifests_contract_v1_shape,
  DROP CONSTRAINT IF EXISTS dataset_manifests_dataset_type_known,
  DROP CONSTRAINT IF EXISTS dataset_manifests_contract_version_known,
  DROP COLUMN IF EXISTS dependency_set,
  DROP COLUMN IF EXISTS symbols,
  DROP COLUMN IF EXISTS dataset_type,
  DROP COLUMN IF EXISTS manifest_contract_version;

ALTER TABLE historical_validation.dataset_manifests
  ALTER COLUMN symbol SET NOT NULL;
