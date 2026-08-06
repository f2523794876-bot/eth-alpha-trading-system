// T17 resolveGovernanceAuthorizationRef()/verifyGovernanceAuthorizationRef() 测试——
// FORMAL合法/缺失/坏Schema/错run/错thresholds/scope/decision；DRY_RUN null通过且非null拒绝。
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalSha256 } from '../formal-research/canonical-json.js';
import { resolveGovernanceAuthorizationRef, verifyGovernanceAuthorizationRef } from './governance-authorization.js';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const THRESHOLDS_SHA = 'a'.repeat(64);

function validRecord(overrides = {}) {
  return {
    schemaVersion: 'v1.4d-governance-authorization/1',
    hashAlgorithm: 'SHA-256',
    validationRunId: RUN_ID,
    thresholdsSha256: THRESHOLDS_SHA,
    authorizationScope: 'FORMAL_RESEARCH_EXECUTION',
    decision: 'APPROVE',
    authorizedByRole: 'CHAIRMAN',
    authorizedAt: '2026-01-08T00:05:00.000Z',
    ...overrides
  };
}

test('DRY_RUN + 无record：返回null', () => {
  const ref = resolveGovernanceAuthorizationRef({ artifactMode: 'DRY_RUN', record: null, expectedValidationRunId: RUN_ID, expectedThresholdsSha256: THRESHOLDS_SHA });
  assert.equal(ref, null);
});

test('DRY_RUN + 附带record：拒绝（DRY/FORMAL物理隔离，不得混入真实授权）', () => {
  assert.throws(
    () => resolveGovernanceAuthorizationRef({ artifactMode: 'DRY_RUN', record: validRecord(), expectedValidationRunId: RUN_ID, expectedThresholdsSha256: THRESHOLDS_SHA }),
    error => error.code === 'GOVERNANCE_AUTHORIZATION_MISMATCH'
  );
});

test('FORMAL + 合法record：产出可重算的ref', () => {
  const record = validRecord();
  const ref = resolveGovernanceAuthorizationRef({ artifactMode: 'FORMAL', record, expectedValidationRunId: RUN_ID, expectedThresholdsSha256: THRESHOLDS_SHA });
  assert.equal(ref.authorizationSchemaVersion, 'v1.4d-governance-authorization/1');
  assert.equal(ref.recordSha256, canonicalSha256(record));
  assert.equal(ref.validationRunId, RUN_ID);
  assert.equal(ref.thresholdsSha256, THRESHOLDS_SHA);
  assert.equal(ref.authorizationScope, 'FORMAL_RESEARCH_EXECUTION');
  assert.equal(ref.decision, 'APPROVE');
  assert.equal(verifyGovernanceAuthorizationRef(ref, record), true);
});

test('FORMAL + 缺失record：GOVERNANCE_AUTHORIZATION_MISSING', () => {
  assert.throws(
    () => resolveGovernanceAuthorizationRef({ artifactMode: 'FORMAL', record: null, expectedValidationRunId: RUN_ID, expectedThresholdsSha256: THRESHOLDS_SHA }),
    error => error.code === 'GOVERNANCE_AUTHORIZATION_MISSING'
  );
});

test('FORMAL + Schema不合法（缺字段/坏格式）：GOVERNANCE_AUTHORIZATION_INVALID', () => {
  const { authorizedAt, ...missingField } = validRecord();
  void authorizedAt;
  assert.throws(
    () => resolveGovernanceAuthorizationRef({ artifactMode: 'FORMAL', record: missingField, expectedValidationRunId: RUN_ID, expectedThresholdsSha256: THRESHOLDS_SHA }),
    error => error.code === 'GOVERNANCE_AUTHORIZATION_INVALID'
  );
  assert.throws(
    () => resolveGovernanceAuthorizationRef({ artifactMode: 'FORMAL', record: validRecord({ authorizedAt: '2026-01-08 00:05:00' }), expectedValidationRunId: RUN_ID, expectedThresholdsSha256: THRESHOLDS_SHA }),
    error => error.code === 'GOVERNANCE_AUTHORIZATION_INVALID'
  );
});

test('FORMAL + scope/decision不是授权值：GOVERNANCE_AUTHORIZATION_INVALID（Schema const本身已排除非法枚举，这里覆盖const被绕过的防御层）', () => {
  assert.throws(
    () => resolveGovernanceAuthorizationRef({ artifactMode: 'FORMAL', record: validRecord({ decision: 'REJECT' }), expectedValidationRunId: RUN_ID, expectedThresholdsSha256: THRESHOLDS_SHA }),
    error => error.code === 'GOVERNANCE_AUTHORIZATION_INVALID'
  );
});

test('FORMAL + record.validationRunId与本次run不符：GOVERNANCE_AUTHORIZATION_MISMATCH', () => {
  assert.throws(
    () => resolveGovernanceAuthorizationRef({ artifactMode: 'FORMAL', record: validRecord(), expectedValidationRunId: '22222222-2222-4222-8222-222222222222', expectedThresholdsSha256: THRESHOLDS_SHA }),
    error => error.code === 'GOVERNANCE_AUTHORIZATION_MISMATCH'
  );
});

test('FORMAL + record.thresholdsSha256与本次run冻结的thresholds不符：GOVERNANCE_AUTHORIZATION_MISMATCH', () => {
  assert.throws(
    () => resolveGovernanceAuthorizationRef({ artifactMode: 'FORMAL', record: validRecord(), expectedValidationRunId: RUN_ID, expectedThresholdsSha256: 'b'.repeat(64) }),
    error => error.code === 'GOVERNANCE_AUTHORIZATION_MISMATCH'
  );
});

test('verifyGovernanceAuthorizationRef：record被篡改（record内容变了但ref没变）时重算不一致', () => {
  const record = validRecord();
  const ref = resolveGovernanceAuthorizationRef({ artifactMode: 'FORMAL', record, expectedValidationRunId: RUN_ID, expectedThresholdsSha256: THRESHOLDS_SHA });
  const tampered = validRecord({ authorizedAt: '2026-02-01T00:00:00.000Z' });
  assert.equal(verifyGovernanceAuthorizationRef(ref, tampered), false);
});

test('verifyGovernanceAuthorizationRef：ref为null时只有record也为null/undefined才算一致', () => {
  assert.equal(verifyGovernanceAuthorizationRef(null, null), true);
  assert.equal(verifyGovernanceAuthorizationRef(null, undefined), true);
  assert.equal(verifyGovernanceAuthorizationRef(null, validRecord()), false);
});
