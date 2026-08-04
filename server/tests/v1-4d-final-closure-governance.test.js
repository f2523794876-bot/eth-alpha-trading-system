import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../..', import.meta.url));
const read = path => readFileSync(`${root}/${path}`, 'utf8');

const stableErrors = Object.freeze({
  DATASET_MANIFEST_DEPENDENCY_UNGOVERNED: {
    code: 'server/src/validation-replay/multi-symbol-manifest-contract.js',
    test: 'server/src/validation-replay/multi-symbol-manifest-contract.test.js'
  },
  DATASET_MANIFEST_LOGICAL_WINDOW_CONFLICT: {
    code: 'server/src/validation-replay/dataset-manifest-v2.js',
    test: 'server/tests/postgres/v1-4d-multi-symbol-manifest.integration.test.js'
  },
  DATASET_MANIFEST_CONTRACT_VERSION_UNSUPPORTED: {
    code: 'server/src/validation-replay/dataset-manifest-verifier.js',
    test: 'server/src/validation-replay/dataset-manifest-verifier-v2.test.js'
  },
  DATASET_MANIFEST_MEMBER_IDENTITY_MISSING: {
    code: 'server/src/validation-replay/multi-symbol-manifest-contract.js',
    test: 'server/src/validation-replay/multi-symbol-manifest-contract.test.js'
  },
  DATASET_MANIFEST_DEPENDENCY_INCOMPLETE: {
    code: 'server/src/validation-replay/dataset-manifest-verifier-v2.js',
    test: 'server/src/validation-replay/dataset-manifest-verifier-v2.test.js'
  },
  DATASET_MANIFEST_MEMBER_CONTENT_MISMATCH: {
    code: 'server/src/validation-replay/dataset-manifest-verifier-v2.js',
    test: 'server/src/validation-replay/dataset-manifest-verifier-v2.test.js'
  },
  DATABASE_IDENTITY_REQUIRED: {
    code: 'server/src/db/research-database-guard.js',
    test: 'server/src/db/research-database-guard.test.js'
  },
  DATABASE_IDENTITY_REJECTED: {
    code: 'server/src/db/research-database-guard.js',
    test: 'server/src/db/research-database-guard.test.js'
  },
  DATABASE_IDENTITY_CONFLICT: {
    code: 'server/src/db/research-database-guard.js',
    test: 'server/src/db/research-database-guard.test.js'
  }
});

test('Addendum登记的9个新增稳定错误码与当前代码和测试逐项一致', () => {
  const addendum = read('V1_4D_MULTI_SYMBOL_MANIFEST_ADDENDUM.md');
  const registry = addendum.split('#### 9.2.1 当前实现新增稳定错误码登记（9个）')[1]
    .split('这里的“9个新增稳定错误码”')[0];
  const documented = [...registry.matchAll(/^\| `([A-Z0-9_]+)` \|/gm)].map(match => match[1]);

  assert.deepEqual(documented, Object.keys(stableErrors));
  for (const [errorCode, evidence] of Object.entries(stableErrors)) {
    assert.match(read(evidence.code), new RegExp(`['\"]${errorCode}['\"]`), `${errorCode}缺少生产实现证据`);
    assert.match(read(evidence.test), new RegExp(errorCode), `${errorCode}缺少测试证据`);
  }
});

test('R28 workflow覆盖所有main目标PR且保留现有阻断性保护', () => {
  const workflow = read('.github/workflows/v1-4d-full-verification.yml');

  assert.match(workflow, /^\s*workflow_dispatch:\s*$/m);
  assert.match(workflow, /^\s*pull_request:\s*\n\s+branches:\s*\n\s+- main\s*$/m);
  assert.doesNotMatch(workflow, /^\s*push:\s*$/m);
  assert.doesNotMatch(workflow, /continue-on-error/);
  assert.match(workflow, /^permissions:\s*\n\s+contents: read\s*$/m);
  assert.match(workflow, /node --test/);
  assert.match(workflow, /npm run test:features/);
  assert.match(workflow, /npm run test:forecast/);
  assert.match(workflow, /tests\/postgres\/v1-4d-multi-symbol-manifest\.integration\.test\.js/);
  assert.match(workflow, /tests\/postgres\/v1-4d-manifest-inventory-guard\.integration\.test\.js/);
  assert.match(workflow, /git diff --check "\$patch_baseline\.\.HEAD"/);
  assert.match(workflow, /frozen_baseline=dc6e573cdbc5aece7b932ab1cbbbe3daa3623437/);
  assert.match(workflow, /migration_baseline=9d86a7a9dd480b826d6a8ffd1a68a06fade76e19/);
  assert.match(workflow, /git diff --quiet "\$frozen_baseline\.\.HEAD" -- "\$\{frozen_files\[@\]\}"/);
  assert.match(workflow, /git diff --quiet "\$migration_baseline\.\.HEAD" -- "\$\{protected_migrations\[@\]\}"/);
  for (const file of [
    'V1_4D_DATA_BACKFILL_SPEC.md',
    'V1_4D_HISTORICAL_REPLAY_SPEC.md',
    'V1_4D_CODEX_IMPLEMENTATION_TASK.md',
    'V1_4D_ACCEPTANCE_TESTS.md',
    'V1_4D_ARCHITECTURE_REVIEW.md'
  ]) assert.match(workflow, new RegExp(`^\\s+${file.replaceAll('.', '\\.')}$`, 'm'));
  assert.doesNotMatch(workflow, /V1_4D_MULTI_SYMBOL_MANIFEST_ADDENDUM\.md/);
  assert.match(workflow, /server\/migrations\/00\[1-6\]_\*\.sql/);
});
