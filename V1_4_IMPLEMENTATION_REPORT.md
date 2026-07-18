# ETH Alpha V1.4 GMKG 最小可验证闭环实施报告

实施分支：`codex/v1.4-gmkg-minimum-validation-loop`  
基线：`main` / `cc6975d4d1c74ef3b8d95c3eab68ef64d78cb7f2`  
实现模式：`PRICE_ONLY_MODE`，仅使用 Binance 现货 ETH/BTC × 15m/1h/4h 已收盘 K 线。

## 交付内容

- `v1_4-gmkg-forecast-core.js`：9 个 PO_* 价格代理状态、服务器时间已确认输入约束、24H/72H 快照、规则型情景权重、4H ATR 平方根时间缩放阈值、六窗口 SHA-256 审计引用。
- `v1_4-gmkg-outcome-core.js`：96/288 根目标路径定位、九项完整性不变量、不可变结果事件、方向/路径统计分母隔离、UP/DOWN/RANGE 指标。
- `v1_4-gmkg-validation-core.js`：按时间切分、标准区间调度有效样本数、冻结的误差归因与中性极端波动标记。
- `work/v1-gmkg-min-loop.template.html`：网络 I/O、原子持久化、幂等回填、完整 JSON/CSV 导出和中文展示层。
- `work/build-v1.js` / `work/v1-ui.template.html`：只新增 V1.4 精确占位符接线；既有替换链不变。
- `eth-dynamic-trading-dashboard.html`：由构建脚本生成的单文件正式页面。
- `tests/v1_4-gmkg-*.test.js`：V1.4 行为、结构追踪和真实 REST 测试。
- `tests/v1_4-structured-entry-zone.test.js`：13项结构化入场区、严格旧档案兼容解析、距离、撮合门控、真实复现及导出精度的 P0 回归测试。
- `tests/fixtures/entry-zone-live-reproduction-2026-07-18.json`：修复前后同一轮 Binance 生产链实测值，保留原始展示值、错误解析结果、结构化数值及距离证据。

## 模拟交易价格解析 P0 修复

- 根因位于 `v1_3-signal-archive-core.js` 的旧 `entryNumbers()`：它用通用数字正则反向解析已经格式化的 `entryZone` 展示字符串。真实字符串 `1,845.89 – 1,846.63` 被拆为 `1 / 845.89 / 1 / 846.63`，再经最小值/最大值计算变成 `1.00–846.63`。错误值随后进入交易门控诊断、距离/ATR距离、建议档案与影子触发链。
- 修复后 `buildTriggerPlan()` 保留原中文展示字符串，同时新增不可格式化的 `entryZoneValues = { lower, upper, estimatedEntry }`。诊断、档案、影子触发、自动引擎结构门与模拟交易方案均直接读取结构化数值，不再从中文文案反向提取业务数值。
- 旧档案兼容只接受严格、完整的两个价格范围，支持合法千位逗号及 `–/—/-/至/~/～` 分隔符。逗号分组错误、字段缺失、非正数、`lower > upper` 或预计进场价不在区间内时返回 `null` 数值并 fail closed；不会回退到确认价、0 或近似值。
- 真实复现（2026-07-18，ETH 已收盘确认价 `1845.34`，ATR14 `2.445`）：修复前多头解析为 `1.00–846.63`，距离 `998.71 USDT / 408.47 ATR`；修复后读取原始数值 `1845.89325–1846.62675`，距离 `0.55325 USDT / 0.22628 ATR`。修复后空头读取 `1844.63325–1845.36675`，确认价处于该区间内，距离为 `0 / 0 ATR`。

## 生产闭环

1. 既有六路 REST 刷新完成后，V1.4 单独请求 `GET /api/v3/time`；失败时返回 `DATA_BLOCKED`，不猜测收盘状态。
2. 使用 Binance 服务器时间重新筛选六路已收盘 K 线，并生成六个 `KlineWindowRef`；任何未收盘、乱序、重复或无效输入直接拒绝。
3. 只对 ETH 生成独立 24H（96 根）和 72H（288 根）不可变 `ForecastSnapshot`。`primaryState` 与 `fusionState` 恒为 `UNKNOWN`，行动权限恒为 `DISPLAY_ONLY / WAIT`。
4. 同一 `predictionId` 不重复保存。快照与代理迁移记录采用内存预组装和失败回滚，防止孤儿记录。
5. 目标时间到达后，从 reference bar 起按时间顺序重新获取真实 15m K 线，逐根验证路径并追加 `ForecastOutcomeEvent` 与 `ErrorAttribution`；不覆盖原始快照。
6. `directionEligibleForStatistics` 与 `pathEligibleForStatistics` 独立计算；路径不完整时所有路径指标严格为 `null`。

## 规则与安全边界

- `scenarioWeights` 为规则型权重，整数且严格合计 100；`calibratedProbability` / `calibratedProbabilities` 恒为 `null`。
- 24H 阈值为 `ATR4h / referencePrice × sqrt(6)` 后限制在 0.8%–5%；72H 使用 `sqrt(18)` 后限制在 1.5%–8%。
- 存储键全部使用 `ethAlphaGmkg*` 命名空间，不复用或改写 V1.1–V1.3.1 日志。
- 容量异常保留全部既有证据，进入 `STORAGE_BLOCKED`，停止生成新快照并提示先导出 JSON；没有自动淘汰路径。
- V1.4 未调用 `recordSignalIfEligible`、`evaluateShadowSignals`、`buildTradeProposal`、`tickAutoEngine` 或 `processTradeGate`，不会创建 `WATCHLIST` / `EXECUTABLE`，不会影响交易许可或模拟账户。
- 未接入真实账户、API Key、真实订单、WebSocket、新闻、链上、衍生品、自动校准或服务器常驻功能。

## 兼容性

除下述 P0 修订外，既有核心算法与交易许可阈值保持不变：

- `v1-core.js` 旧 SHA-256：`0a4d9e712859d79ecae592aacffe371abfba29a2c6b7b76119a68c49e0471a97`
- 因果 ATR 修复后 SHA-256：`252aacdf2dd7ac11e181738bc24728aee0b00d94ebb6b410692449cc628da9e0`
- 当前 SHA-256：`edc36248440cd53443b798a9aa5ad769904b986068172ecc4590aafbe486ed00`
- 原冻结哈希因经真实 BTC 15m 数据证明的 P0 因果 ATR 错误而经 CEO 授权更新；本轮又按人工验收发现的 P0 要求，仅为 `TriggerPlan` 增加结构化 `entryZoneValues` 与集中严格解析函数。状态机、评分、交易许可阈值、5×ATR 阈值和异常数量大于5根的健康门均未改变。
- `v1_2-forecast-core.js`：`5cd29546ceae417c816bf7056c9fe4ddfc434548be90d1f2679fdb11f1dc250e`
- `v1_3-paper-trading-core.js`：`67854d59424b3c83bb8b171bf608f9053e066b488eab39d91d8e7e44b890e5a9`
- `v1_3-signal-archive-core.js`：`6279e5cecad5acb0cb5ddaee82200b260eebf17590d1d5e6c561260a52b7e032`
- `v1_3-auto-engine-core.js`：`1114ea3ed86760adb0c95ba53129ba796cfdcaa6d11a769b7928b13c69948b5b`
- `v1_3-trade-gate-diagnostics.js`：`b1f8c51edc1781932cf7ab93c5f0036739b38c11aa6c4c03b09efeb7d6fbd70a`

## 实施阶段CEO授权例外记录

原`V1_4_CODEX_IMPLEMENTATION_TASK.md`§1.2“禁止修改核心文件”红线保持原文，不作全面放开。以下仅为真实人工验收或真实行情发现P0后的特定例外，不构成未来修改冻结文件的先例；六份V1.4规范中的其他红线继续有效。

**例外一：因果滚动ATR异常检测**

- 原因：真实BTCUSDT 15m样本证明`detectAnomalyBars()`使用窗口末端ATR回溯历史，造成时间错配与27根正常历史K线误判。
- 授权范围：仅`v1-core.js`中的因果滚动ATR异常检测及必要测试、冻结哈希、构建同步。
- 提交：`207f9e9ddf4eef2c658cc342876520a299bce979`。
- `5×ATR`阈值与`anomalyBarsExcluded>5`健康门均保留；未授权其他`v1-core.js`重构。

**例外二：结构化入场区数值贯通**

- 原因：真实页面证明格式化展示字符串`1,845.xx`被反向解析为`1.00–845.xx`，污染距离、建议档案与影子触发。
- 授权范围：仅为`entryZoneValues`结构化数值贯通与严格旧档案兼容所必需的最小改动。
- 提交：`d2b1f296cd1d4bba7f98d1e950c779bbb169873a`。
- 修改文件：`v1-core.js`、`v1_3-paper-trading-core.js`、`v1_3-signal-archive-core.js`、`v1_3-auto-engine-core.js`、`v1_3-trade-gate-diagnostics.js`、`tests/v12-ui-tests.js`、`tests/v13-ui-tests.js`、`tests/v131-trade-gate-diagnostics-tests.js`、`tests/v1_4-structured-entry-zone.test.js`、`tests/fixtures/entry-zone-live-reproduction-2026-07-18.json`、`eth-dynamic-trading-dashboard.html`、`V1_4_IMPLEMENTATION_REPORT.md`、`V1_4_TEST_RESULTS.md`。
- 未授权削弱V1.3.1交易门控或改变真实交易入口。

两项例外均有专项自动化测试、真实Binance REST与人工验收证据，且均未接入真实交易。

## 已知非阻断P2（本轮未修复）

- 未为复用`appendImmutable`重构现有存储代码。
- `candidateTrajectories.records`继续保持当前V1.4最小契约，不扩张数据结构。
- 真实REST测试继续按当前生产链冒烟与健康验证定位，不将其改写为历史校准或完整统计验证。
- 未依据不完整摘要调整`ActionPermission`字段；任何后续调整仍须以完整权威规范为输入。

## 独立复审P1修复

- `computeScenarioWeights()`已逐状态对齐`V1_4_FORECAST_DATA_SPEC.md`§7.4冻结表。修正的五项为：`PO_RANGE_LOW_STRUCTURE`由`50/35/15`改为`50/25/25`，`PO_BREAKOUT_UP_STRUCTURE`由`45/45/10`改为`30/50/20`，`PO_TREND_UP_STRUCTURE`由`55/35/10`改为`30/50/20`，`PO_BREAKDOWN_STRUCTURE`由`40/15/45`改为`30/20/50`，`PO_TREND_DOWN_STRUCTURE`由`50/10/40`改为`30/20/50`。其余四项已经与冻结表一致。低置信插值、归一化、舍入和最大项吸收尾差算法未改变；`calibratedProbability`仍为`null`，页面继续标注规则型权重不是概率。
- RANGE结果事件的`rangeBreachExcursion`已按`GMKG_DRAGONFLY_ARCHITECTURE.md`§10.4a改为`max(0, maxAbsoluteExcursion - directionThreshold)`，其中阈值直接来自生成时Snapshot。旧实现错误地以基准情景区边界代替方向阈值。非RANGE方向、路径不完整或阈值无效时继续返回`null`，RANGE的MFE/MAE继续为`null`。
- 三份治理文档均采用“原红线保留、特定例外追加”的方式记录两次CEO授权；本轮没有把例外扩大为对冻结文件的普遍修改许可。

## 已知限制

- 本地 `localStorage` 是短期验证原型；长期证据存储仍需未来 IndexedDB 或服务器架构，本版不通过删除历史规避容量限制。
- 页面关闭或电脑休眠期间不会持续运行；回填在页面重新打开并成功取得服务器时间与行情后执行。
- 2026-07-18 人工验收已确认 Chrome 直接双击 `file://` 与 localhost 均可运行：六路 REST、24H/72H、`PRICE_ONLY_MODE`、`UNKNOWN`、`DISPLAY_ONLY/WAIT`、数据质量与存储健康均正常。此前 Console 警告未造成功能阻断，因此没有修改正常的 Blob 导出代码。
- 真实 BTCUSDT 15m 保存样本在旧算法下误判27根，改用因果 ATR 后为0根；全部六路公开行情健康门正常，原四个 V1.2/V1.3 实时失败已关闭。

详细测试口径见 `V1_4_TEST_RESULTS.md`。
