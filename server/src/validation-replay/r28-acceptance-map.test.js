import test from 'node:test';
import assert from 'node:assert/strict';

export const R28_ACCEPTANCE_MAP = Object.freeze({
  'R28.1': ['tests/postgres/v1-4d-multi-symbol-manifest.integration.test.js', 'contract v2 real PostgreSQL governance'],
  'R28.2': ['src/validation-replay/dataset-manifest-verifier-v2.test.js', 'unknown and legacy contracts fail closed'],
  'R28.3': ['src/validation-replay/multi-symbol-manifest-contract.test.js', 'missing and unexpected dependencies fail closed'],
  'R28.4': ['src/validation-replay/multi-symbol-manifest-contract.test.js', 'exact dependency set is four approved pairs'],
  'R28.5': ['src/validation-replay/multi-symbol-manifest-contract.test.js', 'dependency and member input order do not change content hash'],
  'R28.6': ['src/validation-replay/multi-symbol-manifest-contract.test.js', 'dependency and member input order do not change content hash'],
  'R28.7': ['src/validation-replay/multi-symbol-manifest-contract.test.js', 'duplicate dependencies are deterministically removed'],
  'R28.8': ['src/validation-replay/dataset-manifest-verifier-v2.test.js', 'unknown and legacy contracts fail closed'],
  'R28.9': ['tests/features/historical-feature-backfill.test.js', 'ETH-only manifest缺少BTCUSDT 15m治理成员时在计算与输入查询前fail closed'],
  'R28.10': ['tests/postgres/v1-4d-multi-symbol-manifest.integration.test.js', 'contract v2 real PostgreSQL governance'],
  'R28.11': ['tests/postgres/v1-4d-multi-symbol-manifest.integration.test.js', 'logical-window conflict'],
  'R28.12': ['tests/postgres/v1-4d-multi-symbol-manifest.integration.test.js', 'concurrent creation'],
  'R28.13': ['tests/postgres/v1-4d-multi-symbol-manifest.integration.test.js', 'per-dependency counts cannot offset'],
  'R28.14': ['src/validation-replay/multi-symbol-manifest-contract.test.js', 'member close after fixed as-of'],
  'R28.15': ['tests/features/historical-feature-backfill.test.js', 'Manifest未列出的BTC vintage在计算前被拒绝'],
  'R28.16': ['src/validation-replay/member-governed-query.test.js', 'historical bar SQL is parameterized and manifest-governed'],
  'R28.17': ['tests/features/historical-feature-backfill.test.js', '合法ETH/BTC血缘同时出现在输出'],
  'R28.18': ['tests/features/historical-feature-backfill.test.js', 'dry-run逐表零写入'],
  'R28.19': ['tests/postgres/v1-4d-multi-symbol-manifest.integration.test.js', 'migration 007 up/down/up'],
  'R28.20': ['tests/postgres/v1-4d-multi-symbol-manifest.integration.test.js', 'guarded rollback'],
  'R28.21': ['src/validation-replay/hash-contract-verification.test.js', 'contract v2完整golden vector'],
  'R28.22': ['tests/postgres/v1-4d-multi-symbol-manifest.integration.test.js', 'real PostgreSQL governance'],
  'R28.23': ['tests/postgres/v1-4d-multi-symbol-manifest.integration.test.js', 'transaction rollback'],
  'R28.24': ['src/legacy-diagnostics/dataset-manifest-inventory.test.js', 'legacy inventory is SELECT-only']
});

test('R28.1-R28.24 each has an explicit automated evidence mapping', () => {
  assert.deepEqual(Object.keys(R28_ACCEPTANCE_MAP), Array.from({ length: 24 }, (_, index) => `R28.${index + 1}`));
  assert.ok(Object.values(R28_ACCEPTANCE_MAP).every(([file, name]) => file.endsWith('.js') && name.length > 0));
});
