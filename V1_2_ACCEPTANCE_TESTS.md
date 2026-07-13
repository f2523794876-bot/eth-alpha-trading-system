# V1_2_ACCEPTANCE_TESTS.md — V1.2「走势预测层」验收测试规范

版本：v1.2-draft-1
依据：`V1_2_FORECAST_SPEC.md`（每条用例都标注对应章节）。所有测试**必须用构造好的合成K线/合成快照数据跑**，不能只靠人工打开页面观察——沿用 `ACCEPTANCE_TESTS.md` 已确立的"合成数据优先"原则（PROJECT_AUDIT.md 已证明实盘验证会漏掉关键分支）。

**测试实现方式**：新增 `tests/v12-forecast-tests.js`（因子/权重/区间/路径/失效/置信度/日志的纯逻辑测试）与 `tests/v12-ui-tests.js`（读取 `eth-dynamic-trading-dashboard.html` 字符串，断言新DOM结构与中文枚举覆盖），两个文件均沿用现有 `node:assert/strict` + 手写 `test(name,fn)` 跑分器风格（与 `tests/v1-tests.js` 等既有文件一致），互相独立可用 `node tests/v12-forecast-tests.js` / `node tests/v12-ui-tests.js` 单独运行，最终输出 `RESULT passed=N failed=0`。

**运行命令汇总**：
```sh
node tests/v1-tests.js
node tests/v11-tests.js
node tests/audit-fixes-tests.js
node tests/v11-ui-tests.js
node tests/third-review-tests.js
node tests/v12-forecast-tests.js
node tests/v12-ui-tests.js
```
（`live-rest-test.js` 为网络冒烟测试，不计入下方用例数，运行方式不变。）

**用例总数与已有V1.1测试的关系**：本文档定义的用例（T1-T20，明细见下）目标不少于 **60 项**自动化断言，全部落在两个新文件中；`v1-tests.js`/`v11-tests.js`/`audit-fixes-tests.js`/`v11-ui-tests.js`/`third-review-tests.js` 原有 **101 项**用例保持逐字节不变，不新增、不删除、不修改其中任何一条断言（T18 是对这一条本身的元测试）。

---

## T1. 明确多头结构 [对应需求9.1]

**构造**：`ethTf.tf4h`/`tf1h`/`tf15m` 均为 EMA5>EMA10>EMA20 排列，`confirmedPrice>ema20`，`trend='up'`；`decision.state='BULL_CONFIRMATION'`，`decision.mtfState`/`htfState` 均为多头对应态；`decision.btcAlignment='support'`；成交量 `ratio>=1.2`、`sustained=true`；无假突破风险（`falseBreakoutTier='none'`）。

| 用例 | 断言 |
|---|---|
| T1.1 | `h4.directionLabel==='偏多'` 且 `weights.bullish` 为三者最大值 |
| T1.2 | `h1.directionLabel==='偏多'` |
| T1.3 | `m15.directionLabel==='偏多'` |
| T1.4 | 三个horizon的 `supportingEvidence` 均非空，且至少包含1条 `structure*`/`trend4h` 类因子的证据文本 |
| T1.5 | `scenarioTargets.bullishZone` 非null，且 `bullishZone[0] < bullishZone[1]` |

---

## T2. 明确空头结构 [对应需求9.2]

**构造**：与T1对称（EMA空头排列、`trend='down'`、`state='BEAR_CONTINUATION'`、`btcAlignment='support'`（对空头方向支持）、量能确认）。

| 用例 | 断言 |
|---|---|
| T2.1 | 三个horizon `directionLabel==='偏空'` |
| T2.2 | `weights.bearish` 均为三者最大值 |
| T2.3 | `scenarioTargets.bearishZone` 非null 且下界<上界 |
| T2.4 | `mostLikelyPath.id` 不为 `'INSUFFICIENT_DATA'` |

---

## T3. 区间震荡 [对应需求9.3]

**构造**：三周期 `trend='flat'`，`state='RANGE_CHOP'`，价格在 `recentHigh20`/`recentLow20` 中段（区间位置40%-60%），ATR处于收缩区间（`atr14<atrPrev*0.85`）。

| 用例 | 断言 |
|---|---|
| T3.1 | 三个horizon `directionLabel==='震荡'` |
| T3.2 | `mostLikelyPath.id==='RANGE_ROUND_TRIP'` |
| T3.3 | `scenarioTargets.rangingZone` 等于该horizon的 `priceRange.[lower,upper]` |

---

## T4. 多周期方向冲突 [对应需求9.4]

**构造**：`ethTf.tf4h.trend='up'`，`ethTf.tf1h`（`decision.mtfState`）判定偏空态，`ethTf.tf15m`（`decision.state`）判定震荡态——三者互不相同。

| 用例 | 断言 |
|---|---|
| T4.1 | 因子 `mtfConflict` 的 `status==='ok'` 且 `range===1`（三者互不相同时全部导向震荡桶，见spec§4.1第12行） |
| T4.2 | 至少有一个horizon的 `directionLabel` 为 `'不确定'` 或 `'震荡'`（不应出现"三周期冲突却仍给出高置信度单一方向"的情况） |
| T4.3 | 该horizon的 `confidence.score` 明显低于T1.1同条件下（agreementFactor分量拖低总分） |

---

## T5. BTC反向 [对应需求9.5]

**构造**：ETH 4H呈多头结构，但BTC 4H `trend='down'`，`btcAlignment(bias,btc4h)` 返回 `'conflict'`。

| 用例 | 断言 |
|---|---|
| T5.1 | 因子 `btcAlignment3tf` 在4h horizon下 `status==='ok'`，`range>=0.7`（conflict按spec§4.1第9行分配） |
| T5.2 | `h4.weights.bullish` 相比"BTC支持"场景（T1.1）明显更低 |
| T5.3 | `h4.opposingEvidence` 中包含提及BTC冲突的证据文本 |

---

## T6. 假突破确认失败 [对应需求9.6]

**构造**：15m出现突破（`isBreakout=true`），但 `falseBreakoutTier==='confirmation_failed'`。

| 用例 | 断言 |
|---|---|
| T6.1 | 因子 `falseBreakoutRisk` 的 `range===1`（原方向失效，见spec§4.1第10行） |
| T6.2 | `m15.mostLikelyPath.id` 不为 `'BREAKOUT_THEN_PULLBACK'`（因为该路径要求 `falseBreakoutTier!=='confirmation_failed'`） |
| T6.3 | `m15.invalidation` 中包含 `id==='INVALID_VOLUME_FAIL'` 的条目（若mostLikelyPath依赖突破确认） |

---

## T7. 成交量不足 [对应需求9.7]

**构造**：其余条件同T1（多头结构），但 `volumeQuality.ratio<1.2` 或 `sustained=false`。

| 用例 | 断言 |
|---|---|
| T7.1 | 因子 `volumeQuality` 的 `range===1`（未确认量能不给方向加分，见spec§4.1第8行） |
| T7.2 | 该horizon的 `weights.bullish` 相比T1同条件下明显更低（因子8从多头桶移到震荡桶） |

---

## T8. ATR异常扩大 [对应需求9.8]

**构造**：`atr14 > atrPrev*1.15`，且同周期状态机方向为多头。

| 用例 | 断言 |
|---|---|
| T8.1 | 因子 `atrState` 的 `bull===1`（扩张+多头方向，见spec§4.1第6行） |
| T8.2 | `priceRange` 半径（`upper-lower`）相比ATR正常场景明显更宽（因为半径直接用 `atr14×k`，spec§6.1） |
| T8.3 | `priceRange.basis` 中包含具体的 `atr14` 数值字符串 |

---

## T9. 数据陈旧 [对应需求9.9]

**构造**：`AnalyzedSnapshot.dataQuality.isStale===true`（`now - lastCloseTime > staleLimit`）。

| 用例 | 断言 |
|---|---|
| T9.1 | 该horizon `directionLabel==='数据不足'`（spec§5.2第5条硬性门槛） |
| T9.2 | `weights===null`，`priceRange===null`，`invalidation===[]` |
| T9.3 | `suppressedReason` 非null 且提及"陈旧" |

---

## T10. 数据缺失 [对应需求9.10]

**构造**：`fetchMeta.failed` 包含该horizon对应的ETH或BTC周期标识（如 `'btc-tf4h'`）。

| 用例 | 断言 |
|---|---|
| T10.1 | 该horizon `directionLabel==='数据不足'`（spec§10.4强制规则，优先于普通因子级missing处理） |
| T10.2 | `suppressedReason` 中明确写出缺失的周期名 |
| T10.3 | 未受影响的其他horizon（若其依赖的周期数据完整）不应被连带降级 |

---

## T11. 手动观察模式 [对应需求9.11]

**构造**：`decision.isManual===true`。

| 用例 | 断言 |
|---|---|
| T11.1 | `ForecastOutput.m15/h1/h4` 全部为 `null` |
| T11.2 | `suppressedReason` 明确写"手动观察模式" |
| T11.3 | `executability.worthBetting===false` |
| T11.4 | 调用 `buildForecastLogEntry`/`saveForecastLog` 路径不应产生日志写入（对照V1.1 `isManual` 不写决策日志的规则） |

---

## T12. 成功刷新后API失败 [对应需求9.12]

**构造**：先用一次正常的 `ethTf`/`btcTf`/`decision` 调用 `buildForecast` 得到 `prevForecast`（非null的正常预测），再模拟下一次刷新 `fetchMeta.partial===true`（部分周期失败）调用 `buildForecast(..., prevForecast)`。

| 用例 | 断言 |
|---|---|
| T12.1 | 受影响horizon的新结果 `directionLabel==='数据不足'`，**不得**复用 `prevForecast` 对应horizon的 `weights`/`priceRange` 等字段（spec§10.2红线："不能保留旧预测冒充当前预测"） |
| T12.2 | 新结果与 `prevForecast` 做深比较，受影响horizon的 `dataAsOf` 必须不同于 `prevForecast` 对应horizon的 `dataAsOf`（证明不是简单复制引用） |

---

## T13. 未收盘价格剧烈波动但confirmedPrice不变 [对应需求9.13]

**构造**：同一 `ethTf` 快照，仅修改未收盘的最新K线 `close`（模拟盘中价格剧烈跳动），保持 `confirmedPrice`（最后一根已收盘K线收盘价）不变，其余字段不变，调用两次 `buildForecast`。

| 用例 | 断言 |
|---|---|
| T13.1 | 两次调用的 `directionLabel`、`weights`、`priceRange.lower/upper`、`mostLikelyPath` **完全相同**（因为所有正式判定只应使用 `confirmedPrice`） |
| T13.2 | 若UI层展示"当前价"或距离提示，允许该数值不同（未收盘价仅用于展示，spec§0），但本用例聚焦纯逻辑层，UI展示差异不在此文件断言范围（由T19 UI测试单独覆盖） |

---

## T14. 三类权重总和为100% [对应需求9.14]

**构造**：随机/边界组合生成至少20组不同的因子结果集合（部分因子missing、部分因子极端值0/1、全部因子ok等），对每组分别跑三个horizon的 `computeDirectionWeights`。

| 用例 | 断言 |
|---|---|
| T14.1 | 只要 `weights!==null`，`weights.bullish+weights.bearish+weights.ranging===100` 对全部20+组合恒成立（spec§5.3） |
| T14.2 | `FACTOR_WEIGHTS['15m']`/`['1h']`/`['4h']` 三个对象的 `Object.values(...).reduce((a,b)=>a+b,0)===100` |
| T14.3 | 舍入边界用例（构造 `rawBull/rawBear/rawRange` 恰好导致舍入冲突的输入）验证 `ranging` 的强制补齐+溢出扣除逻辑不产生负数 |

---

## T15. 价格区间上下界合法 [对应需求9.15]

**构造**：覆盖正常、结构位收紧、结构位冲突回退（spec§6.2倒挂保护）三种场景，覆盖三个horizon。

| 用例 | 断言 |
|---|---|
| T15.1 | 任意合法输出中 `priceRange.lower < priceRange.upper`（无一例外，包括回退分支） |
| T15.2 | `priceRange.lower < confirmedPrice < priceRange.upper` |
| T15.3 | 结构位冲突场景下，`basis` 数组包含"已回退至ATR区间"字样 |
| T15.4 | `scenarioTargets.bullishZone`/`bearishZone` 若非null，各自的两个数值也满足前者<后者 |

---

## T16. 不输出未经校准的"真实概率"或"胜率" [对应需求9.16]

| 用例 | 断言 |
|---|---|
| T16.1 | 对 `v1_2-forecast-core.js` 源码字符串做正则扫描，不匹配 `/真实概率/、/真实胜率/、/胜率\s*\d/、/概率\s*\d+%/、/必涨/、/必跌/、/稳赚/、/保证盈利/` |
| T16.2 | 对 `eth-dynamic-trading-dashboard.html` 新增DOM部分（第4个`<script>`块及其新增HTML区块）做同样的正则扫描 |
| T16.3 | 任意构造输入下，`ForecastOutput` 及其嵌套对象的**字段名**中不出现 `probability`/`winRate`/`realProbability` 等暗示已校准概率的命名（只允许 `calibratedProbability` 这一个显式标注V2占位、且值恒为 `null` 的字段） |
| T16.4 | 任意构造输入下，`calibratedProbability` 字段值恒为 `null`（V1.2禁止对其赋任何非null值） |
| T16.5 | `HorizonForecast.disclaimer` 恒等于常量字符串 `'规则型权重，尚未经过历史胜率校准'`，且在 `weights!==null` 时该字段不可省略 |

---

## T17. 预测日志字段完整 [对应需求9.17]

| 用例 | 断言 |
|---|---|
| T17.1 | `buildForecastLogEntry(forecast, '1h')` 返回对象包含 spec§12 定义的全部字段（逐字段名断言存在性，包括 `timestamp`/`horizon`/`closedKlineRef`/`tripleTimeframeFeatures`/`directionWeights`/`priceRange`/`scenarioTargets`/`invalidation`/`mostLikelyPath`/`confidence`/`outcomeAfter1Bar`/`outcomeAfter4Bars`/`outcomeAfter16Bars`/`brierScoreComponent`/`directionAccuracy`/`rangeCoverage`/`calibrationBucket`/`calibratedProbability`） |
| T17.2 | `outcomeAfter1Bar`/`outcomeAfter4Bars`/`outcomeAfter16Bars`/`brierScoreComponent`/`directionAccuracy`/`rangeCoverage`/`calibrationBucket`/`calibratedProbability` 在V1.2生成的条目中恒为 `null`（V1.2不做回填） |
| T17.3 | 手动模式下调用 `saveForecastLog` 不写入任何 `localStorage` 记录（与V1.1决策日志规则一致） |
| T17.4 | `saveForecastLog` 使用的 `localStorage` key 为 `ethAlphaForecastLogs`，与V1.1现有的 `ethAlphaDecisionLogs`/`ethAlphaDecisionLogsV11` 均不同（防止存储互相覆盖） |
| T17.5 | `closedKlineRef` 只包含引用信息（`symbol`/`timeframe`/`lastClosedOpenTime`），不包含完整K线数组（防止日志体积失控） |

---

## T18. 不影响现有101项V1.1自动测试 [对应需求9.18]

| 用例 | 断言 |
|---|---|
| T18.1 | 依次运行 `node tests/v1-tests.js`（38项）、`node tests/v11-tests.js`（17项）、`node tests/audit-fixes-tests.js`（15项）、`node tests/v11-ui-tests.js`（12项）、`node tests/third-review-tests.js`（11项），各自 `RESULT` 行的 `passed` 数值与 `TEST_RESULTS.md` 记录的原值逐一相等，`failed=0` |
| T18.2 | 对这5个文件分别做 `git diff` 检查，V1.2实现分支相对 `v1.1.0` 的这5个文件应为空diff（本用例作为CI/人工检查项记录，不一定能在纯Node断言中自动化，需在 `V1_2_ARCHITECTURE_REVIEW.md` 的验收清单中人工核对一次） |
| T18.3 | `v1-core.js` 相对 `v1.1.0` 的 `git diff` 为空 |

---

## T19. UI结构与中文枚举覆盖（`tests/v12-ui-tests.js`）

| 用例 | 断言 |
|---|---|
| T19.1 | `eth-dynamic-trading-dashboard.html` 中存在 `forecast15m`/`forecast1h`/`forecast4h`/`forecastDisclaimer`/`forecastBlocked`/`forecastBetting` 全部DOM id |
| T19.2 | 页面新增的可见静态文本（非`<script>`/`<style>`内）中不出现英文枚举值原文（如 `PULLBACK_THEN_UP`、`INSUFFICIENT_DATA` 等裸露），需有对应中文映射覆盖，比照 `tests/v11-ui-tests.js` 已有断言风格 |
| T19.3 | 页面新增的 `<script>` 块数量为1个（合计变为4个），且不包含 `<script src=...>` 外部引用 |
| T19.4 | `forecastDisclaimer` 对应DOM文本恒含"规则型权重，尚未经过历史胜率校准" |
| T19.5 | 现有V1.1的既有DOM id（`price`/`state`/`worth`/`score`/`htf`/`mtf`/`ltf`/`advice`/`entry`/`addon`/`stop`/`targets`/`rr`/`falseBreakout`/`dragonZone`/`volume`/`supports`/`resistances`/`exits`/`scoreItems`/`warnings`/`health`/`updated` 等）全部依旧存在且未被移动出原有父级结构 |

---

## T20. 模块边界与纯函数性（元测试，防止实现偷懒违反spec§11.1/§15）

| 用例 | 断言 |
|---|---|
| T20.1 | `v1_2-forecast-core.js` 源码字符串不包含 `document.`/`window.` 直接访问（UMD导出行本身允许出现 `root.ETHAlphaForecast=api` 这一行例外，测试需精确排除该行再扫描） |
| T20.2 | `v1_2-forecast-core.js` 不包含对 Binance API URL（`api.binance.com`）的字符串引用（预测层不自己发起网络请求，spec§禁止事项4） |
| T20.3 | `v1_2-forecast-core.js` 不包含任何形如 `fetch(`/`XMLHttpRequest`/`WebSocket` 的调用 |
| T20.4 | `v1_2-forecast-core.js` 不包含任何 API Key/Secret 相关字符串（如 `apiKey`/`secret`/`private_key`，防止未来误引入） |
