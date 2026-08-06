// T13 — 生成时市场状态与RANGE归因（V8_FINAL_R3.md §5 T13）。
//
// 纯函数：输入已经从数据库取出的、每条评估样本在"生成时刻"就已冻结的trend4h分组标签
// （不得读取评估之后才知道的任何状态——即"generation-time"，不是"outcome-time"），输出严格
// UP/DOWN/RANGE三态groupMap（与D8输入`marketRegimeAtGeneration[h]`同一形状：
// {UP:{sampleCount,directionCorrectCount}, DOWN:{...}, RANGE:{...}}）及
// directionalCoverage/marketRegimeCoverage两个覆盖率数值。
//
// 红线（§5 T13"算法或行为"原文）：按generatedAt/dataCutoffTime可用的trend4h分组；
// 未知/缺失不归入合法组并使coverage降低；不得修改生产趋势算法（本模块不导入、不调用
// po-state-engine.js的判定逻辑本身，只消费已经算好的trend4h标签，是纯粹的"按标签计数"）。
const CANONICAL_TREND_ENUM = Object.freeze(['UP', 'DOWN', 'RANGE']);

function emptyGroupStat() { return { sampleCount: 0, directionCorrectCount: 0 }; }

// rows: [{ trend4hAtGeneration: 'UP'|'DOWN'|'RANGE'|null|undefined, directionCorrect: boolean|null,
//          isDirectionSample: boolean, isMarketRegimeSample: boolean }]
// isDirectionSample/isMarketRegimeSample：调用方按各自资格判据（direction eligible / market regime
// 要求trend4h非缺失且样本本身direction-eligible）预先标注，本函数不重新判定资格本身（资格判定属于
// T11 purge/T12 baseline-availability既有职责，不在T13重复实现）。
export function computeMarketRegimeStatistics(rows) {
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array');
  const groupMap = { UP: emptyGroupStat(), DOWN: emptyGroupStat(), RANGE: emptyGroupStat() };
  let directionEligibleTotal = 0;
  let directionCoveredCount = 0; // 有明确UP/DOWN预测方向（非RANGE、非未知）的direction-eligible样本数
  let marketRegimeEligibleTotal = 0;
  let marketRegimeCoveredCount = 0; // trend4h落在合法UP/DOWN/RANGE三态之内的样本数

  for (const row of rows) {
    if (row.isDirectionSample) {
      directionEligibleTotal += 1;
      if (row.predictedDirection === 'UP' || row.predictedDirection === 'DOWN') directionCoveredCount += 1;
    }
    if (!row.isMarketRegimeSample) continue;
    marketRegimeEligibleTotal += 1;
    const trend = row.trend4hAtGeneration;
    if (!CANONICAL_TREND_ENUM.includes(trend)) continue; // 未知/缺失：不归入任何合法组，直接降低coverage
    marketRegimeCoveredCount += 1;
    groupMap[trend].sampleCount += 1;
    if (row.directionCorrect === true) groupMap[trend].directionCorrectCount += 1;
  }

  const directionalCoverage = directionEligibleTotal === 0 ? null : directionCoveredCount / directionEligibleTotal;
  const marketRegimeCoverage = marketRegimeEligibleTotal === 0 ? null : marketRegimeCoveredCount / marketRegimeEligibleTotal;
  const rangeTotal = groupMap.RANGE.sampleCount;
  const groupTotal = groupMap.UP.sampleCount + groupMap.DOWN.sampleCount + groupMap.RANGE.sampleCount;

  return Object.freeze({
    marketRegimeAtGeneration: Object.freeze({
      UP: Object.freeze({ ...groupMap.UP }), DOWN: Object.freeze({ ...groupMap.DOWN }), RANGE: Object.freeze({ ...groupMap.RANGE })
    }),
    directionalCoverage, marketRegimeCoverage, rangeTotal, groupTotal,
    // 仅供调用方参考，不是D8官方reasonCodes（D8自己的reason判定仍由go-no-go-evaluator.js权威执行，
    // 本模块不重复定义、不越权产出会被误当作D8正式reasonCodes使用的字符串）。
    diagnostics: Object.freeze({
      directionalCoverageNull: directionalCoverage === null,
      marketRegimeCoverageNull: marketRegimeCoverage === null,
      rangeClassAbsent: rangeTotal === 0
    })
  });
}
