// V1_4D_DATA_BACKFILL_SPEC.md §1.1：边界样本purge规则，供report-builder.js调用。
// 冻结管道顺序（红线，不得颠倒）：
//   1. 在整个[from,to)范围内，按instrument+horizon分组，对eligible样本全局运行computeEffectiveSampleCount
//      （贪心区间调度去重叠），得到一个跨越整个范围、内部互不重叠的样本集合；
//   2. 对该全局去重结果，按purge规则剔除跨trainEnd/validationEnd边界的样本；
//   3. 将剩余样本按targetEndTime分配到train/validation/test（splitTimeOrdered）。
// 不得先按边界分桶再各自贪心去重——那样在边界附近会产生"桶内重新起算"的不同结果，破坏可复现性（§1.1红线）。
// 不修改 server/src/validation/walk-forward.js 本身，purge是其产出之上的独立后处理步骤。

import { computeEffectiveSampleCount, splitTimeOrdered } from '../validation/walk-forward.js';

// 样本[targetStartTime, targetEndTime)跨越boundary的判据：targetStartTime < boundary <= targetEndTime。
function straddlesBoundary(sample, boundary) {
  return sample.targetStartTime < boundary && boundary <= sample.targetEndTime;
}

// purgedStraddlingCount：剔除掉的样本数——只从report_scope IN ('TRAIN','VALIDATION','TEST')的统计中剔除，
// 但保留在report_scope='ALL'（不分段）的整体报告中（调用方对'ALL'视图应使用purge前的selected集合，不调用本函数）。
export function purgeStraddlingSamples(samples, { trainEnd, validationEnd }) {
  const purged = samples.filter(s => !straddlesBoundary(s, trainEnd) && !straddlesBoundary(s, validationEnd));
  return { purged, purgedStraddlingCount: samples.length - purged.length };
}

// eligibilityField: 'directionEligibleForStatistics' | 'pathEligibleForStatistics'（§3.2，两者独立计算不得混用）。
// trainEnd/validationEnd 为 undefined 时表示不做三段切分，只产出report_scope='ALL'对应的全局去重结果。
export function computeSplitEffectiveSamples(samples, { eligibilityField, trainEnd, validationEnd }) {
  const { rawSampleCount, effectiveSampleCount, selected } = computeEffectiveSampleCount(samples, eligibilityField);

  if (!(Number.isFinite(trainEnd) && Number.isFinite(validationEnd))) {
    return { rawSampleCount, effectiveSampleCount, all: selected, purgedStraddlingCount: 0, training: null, validation: null, test: null };
  }

  const { purged, purgedStraddlingCount } = purgeStraddlingSamples(selected, { trainEnd, validationEnd });
  const { training, validation, test } = splitTimeOrdered(purged, { trainEnd, validationEnd });
  return { rawSampleCount, effectiveSampleCount, all: selected, purgedStraddlingCount, training, validation, test };
}
