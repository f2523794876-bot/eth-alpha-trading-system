// P2-7（独立复审）：primaryCause三个实质分支（data_missing_or_delayed/target_state_misread/price_zone_error）
// 及UNDETERMINED兜底、多条件同时满足时的优先级——纯单元测试，不连接数据库。
// V1_4_HISTORICAL_VALIDATION_SPEC.md §5.1归因规则（见report-builder.js attributeError()内联注释）：
// 1.数据缺失优先 2.target_state_misread 3.price_zone_error 4.以上都不成立则不勉强归因(UNDETERMINED)。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildErrorAttributionSummary } from './report-builder.js';

function pair({ directionCorrect, endpointDataComplete = true, pathDataComplete = true, pathEligibleForStatistics = true, expectedDirection = 'UP', actualDirection = 'UP', realizedRangeInsideExpectedEnvelope = true, expectedEnvelopeTouched = true }) {
  return {
    snapshot: { expectedDirection },
    outcome: { directionCorrect, endpointDataComplete, pathDataComplete, pathEligibleForStatistics, actualDirection, realizedRangeInsideExpectedEnvelope, expectedEnvelopeTouched }
  };
}

test('primaryCause：directionCorrect!==false（预测本就没错）时不归因，primaryCause恒为null', () => {
  const summary = buildErrorAttributionSummary([pair({ directionCorrect: true }), pair({ directionCorrect: null })]);
  assert.equal(summary.primaryCauseCounts.data_missing_or_delayed, undefined);
  assert.equal(summary.requiresHumanReviewCount, 0);
});

test('primaryCause分支1：data_missing_or_delayed——endpointDataComplete=false时优先归因为数据缺失', () => {
  const summary = buildErrorAttributionSummary([pair({ directionCorrect: false, endpointDataComplete: false })]);
  assert.equal(summary.primaryCauseCounts.data_missing_or_delayed, 1);
  assert.equal(summary.requiresHumanReviewCount, 0, 'data_missing_or_delayed分支requiresHumanReview固定为false');
});

test('primaryCause分支1：data_missing_or_delayed——pathDataComplete=false同样触发（不要求两者同时false）', () => {
  const summary = buildErrorAttributionSummary([pair({ directionCorrect: false, pathDataComplete: false })]);
  assert.equal(summary.primaryCauseCounts.data_missing_or_delayed, 1);
});

test('primaryCause分支2：target_state_misread——数据完整、pathEligible、actualDirection与expectedDirection不一致', () => {
  const summary = buildErrorAttributionSummary([
    pair({ directionCorrect: false, expectedDirection: 'UP', actualDirection: 'DOWN', pathEligibleForStatistics: true })
  ]);
  assert.equal(summary.primaryCauseCounts.target_state_misread, 1);
  assert.equal(summary.requiresHumanReviewCount, 1, 'target_state_misread分支requiresHumanReview固定为true');
});

test('primaryCause分支2：target_state_misread——pathEligibleForStatistics=false时不触发（即使actualDirection不一致），落到UNDETERMINED', () => {
  const summary = buildErrorAttributionSummary([
    pair({ directionCorrect: false, expectedDirection: 'UP', actualDirection: 'DOWN', pathEligibleForStatistics: false })
  ]);
  assert.equal(summary.primaryCauseCounts.target_state_misread, undefined);
  assert.equal(summary.primaryCauseCounts.UNDETERMINED, 1);
});

test('primaryCause分支3：price_zone_error——actualDirection与expectedDirection一致，但realizedRangeInsideExpectedEnvelope=false', () => {
  const summary = buildErrorAttributionSummary([
    pair({ directionCorrect: false, expectedDirection: 'UP', actualDirection: 'UP', pathEligibleForStatistics: true, realizedRangeInsideExpectedEnvelope: false })
  ]);
  assert.equal(summary.primaryCauseCounts.price_zone_error, 1);
  assert.equal(summary.requiresHumanReviewCount, 0, 'price_zone_error分支requiresHumanReview固定为false');
});

test('primaryCause分支3：price_zone_error——expectedEnvelopeTouched=false同样触发', () => {
  const summary = buildErrorAttributionSummary([
    pair({ directionCorrect: false, expectedDirection: 'UP', actualDirection: 'UP', pathEligibleForStatistics: true, expectedEnvelopeTouched: false })
  ]);
  assert.equal(summary.primaryCauseCounts.price_zone_error, 1);
});

test('primaryCause分支3：price_zone_error——actualDirection为falsy(null/undefined，未产生方向判定)且pathEligible、区域越界时同样触发', () => {
  const summary = buildErrorAttributionSummary([
    pair({ directionCorrect: false, expectedDirection: 'UP', actualDirection: null, pathEligibleForStatistics: true, realizedRangeInsideExpectedEnvelope: false })
  ]);
  assert.equal(summary.primaryCauseCounts.price_zone_error, 1, 'actualDirection为falsy时第2分支(target_state_misread)的actualDirection真值检查天然不成立，应继续下探到price_zone_error');
});

test('primaryCause分支4：UNDETERMINED兜底——数据完整、pathEligible、方向判定一致且未越界区域时，不勉强归因，requiresHumanReview=true', () => {
  const summary = buildErrorAttributionSummary([
    pair({ directionCorrect: false, expectedDirection: 'UP', actualDirection: 'UP', pathEligibleForStatistics: true, realizedRangeInsideExpectedEnvelope: true, expectedEnvelopeTouched: true })
  ]);
  assert.equal(summary.primaryCauseCounts.UNDETERMINED, 1);
  assert.equal(summary.primaryCauseCounts.target_state_misread, undefined);
  assert.equal(summary.primaryCauseCounts.price_zone_error, undefined);
  assert.equal(summary.requiresHumanReviewCount, 1);
});

test('primaryCause优先级：data_missing_or_delayed优先于target_state_misread——两个条件同时满足时，数据缺失分支胜出', () => {
  const summary = buildErrorAttributionSummary([
    pair({ directionCorrect: false, endpointDataComplete: false, expectedDirection: 'UP', actualDirection: 'DOWN', pathEligibleForStatistics: true })
  ]);
  assert.equal(summary.primaryCauseCounts.data_missing_or_delayed, 1);
  assert.equal(summary.primaryCauseCounts.target_state_misread, undefined, '数据缺失分支必须先于target_state_misread判定生效，不得两者都不为空');
});

test('primaryCause优先级：data_missing_or_delayed优先于price_zone_error', () => {
  const summary = buildErrorAttributionSummary([
    pair({ directionCorrect: false, pathDataComplete: false, expectedDirection: 'UP', actualDirection: 'UP', pathEligibleForStatistics: true, realizedRangeInsideExpectedEnvelope: false })
  ]);
  assert.equal(summary.primaryCauseCounts.data_missing_or_delayed, 1);
  assert.equal(summary.primaryCauseCounts.price_zone_error, undefined);
});

test('primaryCause优先级：target_state_misread优先于price_zone_error——方向不一致且区域也越界时，target_state_misread胜出', () => {
  const summary = buildErrorAttributionSummary([
    pair({ directionCorrect: false, expectedDirection: 'UP', actualDirection: 'DOWN', pathEligibleForStatistics: true, realizedRangeInsideExpectedEnvelope: false, expectedEnvelopeTouched: false })
  ]);
  assert.equal(summary.primaryCauseCounts.target_state_misread, 1);
  assert.equal(summary.primaryCauseCounts.price_zone_error, undefined, 'target_state_misread必须先于price_zone_error判定生效');
});

test('buildErrorAttributionSummary：notEvaluableCauses固定披露5项V1.4D结构性无法评估类别', () => {
  const summary = buildErrorAttributionSummary([]);
  assert.deepEqual(summary.notEvaluableCauses, [
    'environment_misread', 'formal_transition_misread', 'fusion_weight_error', 'action_permission_error', 'exogenous_shock'
  ]);
  assert.match(summary.disclosure, /NOT_EVALUABLE/);
});

test('buildErrorAttributionSummary：混合多条pairs时primaryCauseCounts正确累加各分支计数', () => {
  const summary = buildErrorAttributionSummary([
    pair({ directionCorrect: true }), // 不归因
    pair({ directionCorrect: false, endpointDataComplete: false }), // data_missing_or_delayed
    pair({ directionCorrect: false, expectedDirection: 'UP', actualDirection: 'DOWN' }), // target_state_misread
    pair({ directionCorrect: false, expectedDirection: 'UP', actualDirection: 'UP', realizedRangeInsideExpectedEnvelope: false }), // price_zone_error
    pair({ directionCorrect: false, expectedDirection: 'UP', actualDirection: 'UP' }) // UNDETERMINED
  ]);
  assert.equal(summary.primaryCauseCounts.data_missing_or_delayed, 1);
  assert.equal(summary.primaryCauseCounts.target_state_misread, 1);
  assert.equal(summary.primaryCauseCounts.price_zone_error, 1);
  // UNDETERMINED桶=2：第1条(directionCorrect:true，预测本就没错，primaryCause=null)与第5条
  // (预测确实错了但四个分支都不成立，primaryCause=null)在counts对象里共用同一个'UNDETERMINED'键
  // （buildErrorAttributionSummary用`primaryCause ?? 'UNDETERMINED'`归并），二者语义不同但键相同，
  // 这是buildErrorAttributionSummary既有的计数桶设计特征，不是本次P2-7新引入或修复的行为。
  assert.equal(summary.primaryCauseCounts.UNDETERMINED, 2);
  assert.equal(summary.requiresHumanReviewCount, 2, 'target_state_misread(1)+第5条真正UNDETERMINED(1)的requiresHumanReview均为true；第1条(directionCorrect:true)恒为false');
});
