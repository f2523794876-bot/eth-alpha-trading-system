// V1_4_HISTORICAL_VALIDATION_SPEC.md §2/§3/§4 — Walk-forward骨架：时间顺序切分（不打乱）+ 重叠样本区间调度算法 + 最低样本量披露。
// 唯一权威公式来源；本文件只搭建脚手架（§7.1范围边界），不实现任何自动调参/自动训练闭环。

// §2：训练/验证/测试三区间严格按时间戳切分，不按样本数量均分，不重叠、不打乱
export function splitTimeOrdered(samples, { trainEnd, validationEnd }) {
  if (!(Number.isFinite(trainEnd) && Number.isFinite(validationEnd) && trainEnd < validationEnd)) {
    throw Object.assign(new Error('Invalid time-ordered split boundaries'), { code: 'INVALID_SPLIT_BOUNDARIES' });
  }
  const training = [], validation = [], test = [];
  for (const sample of samples) {
    if (sample.targetEndTime < trainEnd) training.push(sample);
    else if (sample.targetEndTime < validationEnd) validation.push(sample);
    else test.push(sample);
  }
  return { training, validation, test };
}

// §2末段：测试区间内进一步细分多个滚动窗口的脚手架，不实现基于结果自动调整参数的闭环
export function rollingWalkForwardWindows(samples, { windowMs, stepMs, testStart, testEnd }) {
  if (!(Number.isFinite(windowMs) && windowMs > 0 && Number.isFinite(stepMs) && stepMs > 0)) {
    throw Object.assign(new Error('Invalid rolling window parameters'), { code: 'INVALID_WINDOW_PARAMS' });
  }
  const windows = [];
  for (let t0 = testStart; t0 + windowMs <= testEnd; t0 += stepMs) {
    const t1 = t0 + windowMs;
    windows.push({
      windowStart: t0, windowEnd: t1,
      samples: samples.filter(s => s.targetEndTime >= t0 && s.targetEndTime < t1)
    });
  }
  return windows;
}

// §3.2：区间调度贪心算法，唯一正确算法（按targetEndTime排序，非generatedAt）
// eligibilityField: 'directionEligibleForStatistics'（方向类分母）或 'pathEligibleForStatistics'（路径类分母），两者独立计算，不得混用
export function computeEffectiveSampleCount(samples, eligibilityField) {
  const eligible = samples.filter(s => s[eligibilityField] === true);
  const rawSampleCount = eligible.length;
  const sorted = [...eligible].sort((a, b) =>
    a.targetEndTime - b.targetEndTime ||
    a.targetStartTime - b.targetStartTime ||
    (a.predictionId < b.predictionId ? -1 : a.predictionId > b.predictionId ? 1 : 0)
  );
  const selected = [];
  let lastSelected = null;
  for (const candidate of sorted) {
    if (lastSelected === null || candidate.targetStartTime >= lastSelected.targetEndTime) {
      selected.push(candidate);
      lastSelected = candidate;
    }
  }
  return { rawSampleCount, effectiveSampleCount: selected.length, selected };
}

// §3.3：24H/72H分别独立处理，不得混合
export function computeEffectiveSampleCountByHorizon(samples, eligibilityField) {
  const byHorizon = {};
  for (const horizon of ['24h', '72h']) {
    byHorizon[horizon] = computeEffectiveSampleCount(samples.filter(s => s.horizon === horizon), eligibilityField);
  }
  return byHorizon;
}

// §4：最低样本量门槛，effectiveSampleCount为准，不得用rawSampleCount冒充
export const MIN_SAMPLE_THRESHOLDS = Object.freeze({ '24h': 30, '72h': 10 });
export function checkSampleSufficiency(effectiveSampleCount, horizon) {
  const threshold = MIN_SAMPLE_THRESHOLDS[horizon];
  if (!Number.isFinite(threshold)) throw Object.assign(new Error(`Invalid horizon: ${horizon}`), { code: 'INVALID_HORIZON' });
  const sufficient = effectiveSampleCount >= threshold;
  return {
    sufficient, threshold, effectiveSampleCount, isCalibrated: false,
    disclosure: sufficient ? '已达到最低样本量门槛（样本量只是calibratedProbability生效的必要条件之一，非充分条件）' : '样本不足，以下统计仅供描述性参考，不具备统计推断意义'
  };
}
