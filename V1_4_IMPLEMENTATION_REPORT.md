# ETH Alpha V1.4 GMKG 最小可验证闭环实施报告

实施分支：`codex/v1.4-gmkg-minimum-validation-loop`  
基线：`main` / `cc6975d4d1c74ef3b8d95c3eab68ef64d78cb7f2`  
实现模式：`PRICE_ONLY_MODE`，仅使用 Binance 现货 ETH/BTC × 15m/1h/4h 已收盘 K 线。

## 交付内容

- `v1_4-gmkg-forecast-core.js`：9 个 PO_* 价格代理状态、服务器时间已确认输入约束、24H/72H 快照、规则型情景权重、4H ATR 平方根时间缩放阈值、六窗口 SHA-256 审计引用。
- `v1_4-gmkg-outcome-core.js`：96/288 根目标路径定位、九项完整性不变量、不可变结果事件、方向/路径统计分母隔离、UP/DOWN/RANGE 指标。
- `v1_4-gmkg-validation-core.js`：按时间切分、标准区间调度有效样本数、冻结的误差归因与中性极端波动标记。
- `v1_4-storage-core.js`：IndexedDB正式审计仓库、旧localStorage幂等迁移、稳定ID冲突保护（同ID内容真正不同时保留为独立`migrationConflicts`审计记录而非中止迁移）、四级容量状态、六级迁移状态（含`VERIFIED_WITH_CONFLICTS`）、完整导入导出和运行缓存分层。
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
- `v1_3-trade-gate-diagnostics.js`：`abc72c4f331fe2d5547b7d7024bc23683551e79ed0b965d4d7ffa90816ebda43`
- `v1_4-storage-core.js`：`cde2f2d3d041b2199501007529582fe862bb5420767bf02a081b162e93edc665`（迁移冲突协议v2：冲突ID按dataset隔离、投影历史冲突保留、全量计数与幂等重试；`v1-core.js`哈希未变）

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

## STORAGE_BLOCKED 根因与修复

### 证据化容量诊断

- 一条真实GMKG `ForecastSnapshot`序列化后约`5,991`字节，其中六个`KlineWindowRef`约`1,945`字节；用户页面显示的52条快照按同结构约`311,731`字节。52条本身不足以耗尽常见约5MB的localStorage配额。
- 一条真实生产链交易门控诊断约`2,897`字节，旧实现允许1000条，单键可达到约`2,897,000`字节。
- 一条包含完整V1.2预测对象的真实建议档案约`18,821`字节，其中预测对象约`15,279`字节；旧上限2000条，理论容量远超localStorage配额。
- GMKG、诊断、建议档案、预测日志、决策日志和模拟交易数据此前共享同一localStorage配额。GMKG的追加操作还会把整个数组重新JSON序列化并整键重写。因此实际阻断来自多个历史数组累计，而不是52条GMKG快照单独造成。
- 同一GMKG `predictionId`已有去重，不存在30秒tick重复追加同一快照；诊断按已收盘K线键更新投影，但旧实现仍把最多1000条完整投影保存在localStorage。JSON本身没有循环异常，膨胀来自完整嵌套预测对象和整数组重复序列化。

页面现在逐项显示所有实际键的记录数和估算字节。代码识别的键包括：`ethAlphaDecisionLogs`、`ethAlphaDecisionLogsV11`、`ethAlphaRiskSettings`、`ethAlphaForecastLogs`、`ethAlphaPaperAccount`、`ethAlphaPaperTrades`、`ethAlphaPaperLog`、`ethAlphaSignalArchive`、`ethAlphaSignalEvents`、`ethAlphaShadowResults`、`ethAlphaTradeGateDiagnostics`、五个GMKG正式数据键、`ethAlphaGmkgStorageMeta`及`ethAlphaStorageMigrationV14`。开发进程没有读取或清理用户Chrome配置文件；用户实际浏览器中的精确逐键数字由新版页面在原环境内审计显示。

### 分层存储

- IndexedDB `ethAlphaAuditStore`分别保存不可变快照、OutcomeEvent、代理状态修订、验证归因、walk-forward配置、完整建议档案、建议事件、影子结果投影和诊断投影。
- localStorage继续保存风险设置、界面/迁移元数据、V1.1/V1.2有界日志、模拟账户、当前持仓及模拟交易同步安全状态。
- 诊断完整历史在IndexedDB最多1000条；localStorage仅保留最近25条运行缓存和累计统计。同一`diagnosticKey`只更新投影。
- 完整建议档案复制并验证到IndexedDB后，localStorage只保留最近100条运行缓存；其中大型完整预测快照由IndexedDB保留，运行缓存只留下方向摘要。模拟账户、持仓、保证金和交易许可读取路径保持同步且未迁移、未清空。
- ForecastSnapshot、ForecastOutcomeEvent、状态修订、验证归因和完整建议快照均不设置静默淘汰。只裁剪明确标记为可重建的诊断投影和运行缓存。

### 迁移、原子性和恢复

- 启动状态依次为`PENDING → MIGRATING → VERIFIED`（或`VERIFIED_WITH_CONFLICTS`，见下）；无旧数据为`NOT_REQUIRED`，任一解析、权限、容量、校验或数据库错误进入`FAILED`。
- 迁移先在内存生成完整迁移前JSON，再逐条按稳定ID写入IndexedDB，逐项核对ID和完整内容。全部数据验证（含下述冲突审计验证）及数据库健康探针成功后，才删除GMKG旧大数组或压缩诊断/建议运行缓存。
- 中断后已写入的稳定ID会幂等去重；迁移后健康检查失败时恢复全部原localStorage值。
- Snapshot与关联状态修订、OutcomeEvent与ErrorAttribution使用同一IndexedDB事务；事务失败不显示为正式存档，也不会留下孤儿结果。`QuotaExceededError`、权限错误、结构错误和一般数据库错误分别报告。
- `HEALTHY/WARNING/CRITICAL/BLOCKED`根据浏览器容量探测和实际写入健康综合判定。WARNING/CRITICAL不影响读取；BLOCKED只禁止依赖新正式持久化的预测，已有结果仍可查看、导出和验证。解除BLOCKED必须通过写入、读取一致性健康探针。
- 完整JSON导出包含`schemaVersion`、`exportedAt`和各数据集记录数与冲突数量；导入校验版本，按稳定ID去重，冲突记录同样保留、不覆盖。

## 原Chrome实机迁移验收失败修复：`signalSnapshots`同ID内容冲突（`VERIFIED_WITH_CONFLICTS`协议）

### 根因

原Chrome实机验收报告迁移状态`FAILED`，精确错误`ID_CONFLICT:signalSnapshots:SIG-1784359800000-range...`。定位到两处独立成因：

1. **旧`canonical()`辅助函数从未被实际使用于冲突比较**：迁移写入路径直接用`JSON.stringify(old)!==JSON.stringify(entry.record)`比较新旧内容，未做任何键序规范化，也未剥离任何非业务字段。字段插入顺序不同（例如同一条建议档案历史上先后被`v1_3-signal-archive-core.js`的`safeLoad()`→`normalizeStoredSignal()`重新构造过一次，键顺序与首次迁移写入IndexedDB时不同）即可触发误判为"内容不同"。
2. **`entryZone`字段存在三种历史合法形状**：旧展示字符串、旧宽松对象、新结构化对象（`{lower,upper,estimatedEntry,valid,source}`），均由`v1-core.js`的`normalizeEntryZone()`统一解析为同一组数值。V1.3的`safeLoad()`会在每次读取建议档案时用`normalizeStoredSignal()`重新规范化`entryZone`形状（这是先前P0修复的既有行为，未做改动），而`v1_4-storage-core.js`的`readLegacy()`此前直接读取原始JSON、不经过该规范化步骤，导致"已写入IndexedDB时的形状"与"本次迁移读到的形状"不一致，被旧的逐字节比较误判为业务内容冲突。

两处均**不是**业务内容（价格、方向、许可、评分、算法版本等）真正不同，而是序列化形态差异；但旧实现一律用`throw`中止整个迁移并回滚，导致`FAILED`永久卡住、用户看到"旧localStorage仍保留、IndexedDB已有部分记录"的僵局。

### 修复：冲突处理协议（不改变正式快照不可变原则）

- 新增正确的递归、键序无关的`canonicalStringify()`，替换从未被引用的旧`canonical()`。
- 新增按数据集的逐字段白名单`VOLATILE_FIELDS`（当前仅`snapshots.generatedAt`/`snapshots.dataCutoffTime`及`klineWindowRefs[].fetchedAt`——生成时刻的运行时元数据），供比较前剥离；价格、方向、许可、评分、失效条件、目标、风险、算法版本、权重版本、数据截止时间等业务字段**不在白名单内**，逐字节比较后任何差异均视为真实冲突。
- `signalArchive`的`entryZone`比较前，通过运行时注入的`entryZoneNormalizer`（即`v1-core.js`的`normalizeEntryZone`，通过依赖注入传入`v1_4-storage-core.js`，不复制解析逻辑）解析为数值三元组再比较；`archiveCategory`/`eligibleForTrigger`/`hardBlockedAtCreation`等字段不在白名单内，差异一律视为真实业务冲突。
- 规范化后确认**真正内容不同**的同ID记录：不覆盖已存在的正式记录，改为写入独立的`migrationConflicts`存储区。第二次原Chrome实机迁移暴露旧ID`${originalId}__conflict__${contentHash}`缺少dataset，会让`signalArchive`和`shadowResults`共用`SIG-*`时发生跨数据集主键碰撞；当前已升级为`CONFLICT_SCHEMA_VERSION + dataset + stableHash(schemaVersion,dataset,originalId,contentHash) + contentHash`。同一dataset、原始ID和规范化内容始终产生同一冲突ID，跨dataset绝不碰撞，重复迁移/重复导入不会重复膨胀。冲突记录携带`originalId`/`contentHash`/`datasetName`/`migrationConflictReason`/`sourceStorage`/完整原始内容；`signalArchive`类型的冲突记录会被强制降级为`archiveCategory:'OBSERVATION'`、`eligibleForTrigger:false`，永远不会获得新的交易许可，也不会出现在`repo.getAll('signalArchive')`等正式读取路径中。
- 迁移校验阶段同步更新：每条源记录必须能在"正式存储"或"冲突审计记录"中找到内容匹配的副本，否则仍判定`MIGRATION_VERIFY_FAILED`（防止真正的数据丢失被误判为"已处理"）。
- 迁移最终状态新增`VERIFIED_WITH_CONFLICTS`（非`FAILED`）：存在真实冲突时，旧localStorage数组仍会在全部校验通过后正常清理，不会因冲突而永久卡在`FAILED`。UI新增"迁移冲突"计数行与"导出迁移冲突报告"按钮。
- `IndexedDB`数据库版本从`1`升至`2`：`onupgradeneeded`会为已经运行过一次旧版本迁移的真实用户数据库补建新增的`migrationConflicts`存储区，不影响已有存储区内容。
- 同样的规范化比较用于`putBundle`（GMKG快照生成的正式写入路径）：两个标签页在同一`referenceBar`周期内几乎同时生成同一`predictionId`时，仅`generatedAt`/`dataCutoffTime`/窗口`fetchedAt`不同将被安全去重（不再误判为冲突或触发虚假`DATA_BLOCKED`）；若业务内容确实不同（异常场景），后到者同样进入冲突保存协议，不覆盖先到者。
- 导入（`importBackup`）复用同一冲突处理协议：不再对冲突记录整体返回失败，而是按数据集分别报告`conflicts`列表，原正式记录始终不被覆盖。

### 为什么不会丢数据

写入阶段"内容匹配→去重跳过""内容不同→双方均保留（一份为正式记录、一份为确定性ID的冲突记录）"；校验阶段要求每条源记录必须能在正式记录或冲突记录中找到匹配；旧localStorage仅在全部校验通过后清理。任一环节失败（含真正的数据库错误、容量耗尽、校验失败）仍会完整回滚至迁移前的原始localStorage状态，不会同时丢失localStorage与IndexedDB两侧数据。

### 为什么不会重复计入交易或统计

`migrationConflicts`是独立存储区，不属于`DATASETS`映射，`repo.getAll('signalArchive')`等正式读取路径不会返回冲突记录；`signalArchive`类型的冲突记录额外被强制降级为`OBSERVATION`/`eligibleForTrigger:false`。V1.1–V1.3.1既有交易生命周期（`recordSignalIfEligible`/`evaluateShadowSignals`/`tickAutoEngine`/`processTradeGate`）从未读取IndexedDB，本次修复未新增任何调用，五个真实交易入口在全部V1.4文件中静态扫描仍为0。

## 第二次原Chrome迁移验收：`shadowResults`校验失败修复

### 对象级证据与准确根因

用户Chrome Profile不由开发测试进程直接读取或修改。为避免以推测替代证据，页面新增“导出指定迁移记录诊断”：输入dataset和originalId后，一次性导出旧localStorage对象、IndexedDB当前对象、该dataset全部匹配冲突对象、双方canonical hash及逐字段差异路径，不要求用户编辑任何存储。专项测试使用实机错误中的精确ID `SIG-1784362500000-ranging-raft4final`构造可复现等价历史：

- localStorage `shadowResults`：`lifecycleStatus='OBSERVING'`、`verified=false`、`entryFillPrice/exitPrice/grossR=null`、`origin='local'`；
- IndexedDB `shadowResults`当前投影：`lifecycleStatus='STOPPED'`、`verified=true`、`entryFillPrice=1843.815`、`exitPrice=1835`、`grossR=-1`、`origin='indexeddb'`；
- `migrationConflicts`：dataset严格为`shadowResults`、originalId为上述精确ID、contentHash等于localStorage对象的同一canonical结果，record完整保留旧投影。

旧协议的冲突ID只有`originalId+contentHash`。`signalArchive`与`shadowResults`合法共用同一个`SIG-*` originalId；当两数据集的canonical内容恰好得到各自冲突时，第二条可能命中第一条已经占用的IndexedDB主键而被当成“已保存”。底层因此只有`signalArchive`冲突，verify却按`datasetName==='shadowResults'`查找，最终抛出`MIGRATION_VERIFY_FAILED:shadowResults:<id>`。这解释了为什么页面能显示冲突已保存而shadowResults仍验证失败。

### 冲突存储、投影与重试修复

- 冲突ID升级为`v1.4-migrationconflict-2__<dataset>__<identityHash>__<contentHash>`；identityHash明确绑定`schemaVersion/dataset/originalId/contentHash`。写入和verify共用同一`conflictIdentity()`，不再各自拼接或重新解释ID。
- 没有发现`migrationConflicts`底层100条保存上限。此前UI只有单一数字，无法区分总量与展示量；现在IndexedDB保存全部冲突，UI分别显示`totalConflictCount`与`displayedConflictCount`（展示上限100），完整导出永不截断。迁移元数据只保存前100条摘要，避免localStorage元数据膨胀，但总数单独持久化。
- `shadowResults`被明确为可更新的正式当前投影：正常运行继续用`putProjection()`更新；迁移旧数据则一律走冲突保留写入，绝不覆盖当前投影。旧投影与当前投影不同是合法历史差异，旧对象进入dataset隔离的冲突审计区；它不属于建议档案、不携带或推导交易许可，也不会进入正式胜负统计分母。
- 每批迁移的`migrationSessionId`由全部源dataset的canonical内容确定。FAILED重试相同源数据得到相同sessionId和相同冲突ID，复用已经安全写入的正式记录与冲突记录，不产生副本。IndexedDB `repositoryMeta.migrationLock`标记`MIGRATING/FAILED/VERIFIED_WITH_CONFLICTS`；迁移校验期间同页面的运行投影归档延后，localStorage原数据继续保留。
- 只有全部dataset逐条通过“正式对象内容匹配，或同dataset冲突对象内容匹配”校验和健康探针后才清理旧GMKG大数组/压缩运行缓存。页面运行期间新写入IndexedDB的记录从不在迁移中删除。成功状态和有限冲突摘要写入localStorage，刷新后直接恢复`VERIFIED_WITH_CONFLICTS`，不会把已压缩运行缓存再次当作完整旧历史重迁。
- `SCHEMA_VERSION`升级为`v1.4-storage-repository-3`，`CONFLICT_SCHEMA_VERSION`升级为`v1.4-migrationconflict-2`。旧FAILED批次留下的v1冲突记录继续作为历史审计保留，但不会冒充v2 dataset隔离冲突满足新校验；重试会生成正确的v2记录。

## 已知限制

- 本地 `localStorage` 是短期验证原型；长期证据存储仍需未来 IndexedDB 或服务器架构，本版不通过删除历史规避容量限制。
- 页面关闭或电脑休眠期间不会持续运行；回填在页面重新打开并成功取得服务器时间与行情后执行。
- 2026-07-18 人工验收已确认 Chrome 直接双击 `file://` 与 localhost 均可运行：六路 REST、24H/72H、`PRICE_ONLY_MODE`、`UNKNOWN`、`DISPLAY_ONLY/WAIT`、数据质量与存储健康均正常。此前 Console 警告未造成功能阻断，因此没有修改正常的 Blob 导出代码。
- 真实 BTCUSDT 15m 保存样本在旧算法下误判27根，改用因果 ATR 后为0根；全部六路公开行情健康门正常，原四个 V1.2/V1.3 实时失败已关闭。

详细测试口径见 `V1_4_TEST_RESULTS.md`。
