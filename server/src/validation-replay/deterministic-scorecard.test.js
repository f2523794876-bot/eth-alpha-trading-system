// T14 buildDeterministicScorecard() 测试——直接驱动真实buildResearchScorecard()（Batch1既有代码，
// 未修改），验证wall-clock字段被正确替换为冻结时间，且双构造canonical bytes/hash完全一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDeterministicScorecard, assertDeterministicScorecardsMatch } from './deterministic-scorecard.js';

const OPTIONS = { feeBps: 5, slippageBps: 3 };
const FROZEN_FINISHED_AT = '2026-01-08T00:05:00.000Z';

test('generatedAt被替换为冻结的validationRunFinishedAt，而不是wall-clock', () => {
  const result = buildDeterministicScorecard([], OPTIONS, { validationRunFinishedAt: FROZEN_FINISHED_AT });
  assert.equal(result.scorecard.generatedAt, FROZEN_FINISHED_AT);
});

test('双构造（真实相隔执行）canonical bytes与sha256完全一致', async () => {
  const a = buildDeterministicScorecard([], OPTIONS, { validationRunFinishedAt: FROZEN_FINISHED_AT });
  await new Promise(resolve => setTimeout(resolve, 20)); // 真实制造wall-clock间隔，证明差异不影响输出
  const b = buildDeterministicScorecard([], OPTIONS, { validationRunFinishedAt: FROZEN_FINISHED_AT });
  assert.doesNotThrow(() => assertDeterministicScorecardsMatch(a, b));
  assert.equal(a.sha256, b.sha256);
});

test('validationRunFinishedAt缺失或格式不合法时拒绝（SCORECARD_SCHEMA_INVALID）', () => {
  assert.throws(
    () => buildDeterministicScorecard([], OPTIONS, { validationRunFinishedAt: '2026-01-08 00:05:00' }),
    error => error.code === 'SCORECARD_SCHEMA_INVALID'
  );
  assert.throws(
    () => buildDeterministicScorecard([], OPTIONS, {}),
    error => error.code === 'SCORECARD_SCHEMA_INVALID'
  );
});

test('assertDeterministicScorecardsMatch在不同输入下正确检测出不一致', () => {
  const a = buildDeterministicScorecard([], OPTIONS, { validationRunFinishedAt: FROZEN_FINISHED_AT });
  const b = buildDeterministicScorecard([], { feeBps: 6, slippageBps: 3 }, { validationRunFinishedAt: FROZEN_FINISHED_AT });
  assert.throws(() => assertDeterministicScorecardsMatch(a, b), error => error.code === 'SCORECARD_NONDETERMINISTIC');
});

test('不修改research-scorecard.js其余字段：assumptions/status等原样透传', () => {
  const result = buildDeterministicScorecard([], OPTIONS, { validationRunFinishedAt: FROZEN_FINISHED_AT });
  assert.equal(result.scorecard.assumptions.feeBps, 5);
  assert.equal(result.scorecard.assumptions.slippageBps, 3);
  assert.equal(result.scorecard.status, 'NOT_EVALUABLE');
  assert.equal(result.scorecard.schemaVersion, 'v1.4d-research-scorecard/3');
});
