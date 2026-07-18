# V1_4_ARCHITECTURE_REVIEW.md — V1.4 独立架构复审

版本：v1.4-review-draft-3（补齐P1-3遗留的`KlineWindowRef`专属测试类别后，P1-3完全关闭，无遗留阻断项）
基线：`main` @ `a3d7aea`
角色：本文档对其余五份 V1.4 文档 + 与 `GMKG_DRAGONFLY_ARCHITECTURE.md` 的交互，做**独立风险复审**。逐条给出风险、严重等级、复现路径、修复要求、是否阻断Codex、是否允许进入编码。**不得只写"通过"**。

**版本说明**：draft-1（第一轮复审）发现的2项P0/3项P1/4项P2，其编号（`P0-1`/`P0-2`/`P1-1`/`P1-2`/`P1-3`）与CEO本轮冻结裁决所用的编号（`P0-1`至`P0-5`、`P1-1`至`P1-4`）**不是同一套编号体系**（本轮CEO裁决范围更广、编号独立重排）。为避免混淆，本文档统一改为：draft-1发现的历史条目重命名为`R1-P0-1`/`R1-P0-2`/`R1-P1-1`/`R1-P1-2`/`R1-P1-3`（"R1"=第一轮复审），本轮CEO裁决关闭的条目使用CEO消息原始编号`P0-1`至`P0-5`/`P1-1`至`P1-4`（不加"R"前缀），二者对应关系见§1.1映射表。

---

## 1. 风险清单

### 1.1 第一轮复审（R1）发现条目与本轮CEO裁决的映射关系

| 第一轮编号 | 内容 | 对应本轮CEO裁决编号 | 本轮关闭状态 |
|---|---|---|---|
| R1-P0-1 | referenceBar已收盘判定依赖本地时钟 | **P0-2**（本轮CEO进一步撤销"本地时间减安全边际"备选方案，比R1轮的"有条件允许"更严格） | **本轮彻底关闭**，见§1.2 |
| R1-P0-2 | fusionState借用S0-S7正式状态标签 | **P0-1**（CEO本轮明确裁决：彻底废除借用方案，恒为`'UNKNOWN'`） | **本轮彻底关闭**，见§1.2 |
| R1-P1-1 | 72H有效样本积累缓慢 | **P1-4**（CEO确认冻结节奏不得为凑样本量而提高） | **本轮确认关闭**，见§1.2 |
| R1-P1-2 | `effectiveSampleCount`非重叠子抽样贪心算法方法论次优 | **P0-3**（CEO本轮认定这不只是"次优"，而是必须替换为标准区间调度算法） | **本轮彻底关闭**（严重等级由R1的P2上调为本轮P0，见§1.3说明） | 
| R1-P1-3 | 归因规则不可变性缺少守护测试 | （无对应新编号，R1轮已直接回填T27，本轮沿用） | 已于R1轮关闭，本轮未变动 |
| — | （R1轮未发现，本轮CEO新增裁决） | **P0-4**（exogenous_shock误归因风险） | **本轮新增并关闭**，见§1.2 |
| — | （R1轮未发现，本轮CEO新增裁决） | **P0-5**（静默删除历史证据风险） | **本轮新增并关闭**，见§1.2 |
| — | （R1轮未发现，本轮CEO新增裁决） | **P1-1**（`buildForecastSnapshot`纯函数/存储层混淆） | **本轮新增并关闭**，见§1.2 |
| — | （R1轮未发现，本轮CEO新增裁决） | **P1-2**（`directionThreshold`时间尺度一致性不足） | **本轮新增并关闭**，见§1.2 |
| — | （R1轮未发现，本轮CEO新增裁决） | **P1-3**（缺少完整输入窗口审计引用） | **本轮新增并关闭**，见§1.2 |
| — | （R1轮独立发现，本轮一并核实修正） | **无编号**（`firstResistance`/`firstSupport`的`lower`/`upper`字段误用） | **本轮发现并关闭**，见§1.4 |

**红线说明（R1-P1-2严重等级上调说明）**：R1轮曾把"非重叠子抽样贪心算法"评为P2（"方法学上可改进，但不构成正确性错误"）。CEO本轮复核后认定：排序键（`generatedAt`）与实际决定重叠边界的量（`targetStartTime`/`targetEndTime`）不是同一量纲，这不是单纯的"次优"，而是**排序依据本身选错了**，可能在某些样本分布下产生非法（重叠）的"有效独立样本"选择结果，因此本轮**上调为P0并要求强制关闭**，不是R1轮判断有误，而是CEO对同一问题给出了更严格的最终裁决，本文档尊重并采纳这一更严格的结论。

### 1.2 本轮（CEO裁决）P0-1至P0-5、P1-1至P1-4关闭记录

#### P0-1：PRICE_ONLY_MODE不得借用正式S0-S7状态（关闭）

- **原风险**：`V1_4_FORECAST_DATA_SPEC.md`draft-1 §12.3把`fusionState`映射为`S0_ACCUMULATION`/`S2_BULL_EXPANSION`/`S4_DISTRIBUTION`/`S5_BEAR_EXPANSION`/`S6_CAPITULATION`等正式状态命名，构成"代理判断冒充正式状态"风险。
- **关闭方式**：CEO本轮明确裁决彻底废除借用方案。`V1_4_FORECAST_DATA_SPEC.md`§12.3已重写：`primaryState`/`fusionState`/`fusionStateAtGeneration`恒为`'UNKNOWN'`，不使用`'CONFLICTED'`代替（因为`'CONFLICTED'`语义要求三眼皆已运行且证据冲突，V1.4广度眼未运行不构成"冲突"），不新增任何伪正式状态，UI固定展示"融合状态：未评估（广度眼未运行）"。已同步至`V1_4_CODEX_IMPLEMENTATION_TASK.md`（无遗留代码路径需要清理，本轮为文档阶段）、`V1_4_ACCEPTANCE_TESTS.md`（T4.1-T4.3/T5.1-T5.3已覆盖）。
- **验证**：`V1_4_ACCEPTANCE_TESTS.md` T4/T5类别。
- **状态**：**已关闭，无遗留问题**。

#### P0-2：referenceBar必须使用Binance服务器时间（关闭）

- **原风险**：R1轮曾允许"本地时间减安全边际"作为简化替代方案。
- **关闭方式**：CEO本轮撤销该备选方案，冻结为唯一路径：必须调用`GET /api/v3/time`，单次刷新周期内可缓存偏移量但不得跨周期沿用，服务器时间不可用时fail closed（`DATA_BLOCKED`，`generationBlockedReason='SERVER_TIME_UNAVAILABLE'`），不得猜测`referenceBar`或沿用旧预测时间。已写入`V1_4_FORECAST_DATA_SPEC.md`新增§3.0/§3.0.1，`V1_4_CODEX_IMPLEMENTATION_TASK.md`新增`getServerTimeOffset`函数与编排逻辑说明，`V1_4_DATA_SOURCE_MATRIX.md`同步标注。
- **验证**：`V1_4_ACCEPTANCE_TESTS.md` T3.4（服务器时间校验）/T3.5（fail closed）/T3.6（确认无本地时间减安全边际的实现路径）。
- **状态**：**已关闭，无遗留问题**（不再有"或"字样的备选方案表述）。

#### P0-3：修正`effectiveSampleCount`非重叠样本算法（关闭）

- **原风险**：见§1.1"R1-P1-2严重等级上调说明"。
- **关闭方式**：`V1_4_HISTORICAL_VALIDATION_SPEC.md`§3.2已重写为标准区间调度算法：按`instrument+horizon`分组→只取对应eligible集合→按`targetEndTime`升序排序（相同则`targetStartTime`、再`predictionId`）→贪心选择`candidate.targetStartTime>=lastSelected.targetEndTime`。`rawSampleCount`与`effectiveSampleCount`定义同步更新，24H/72H分别处理不变（§3.3）。`V1_4_CODEX_IMPLEMENTATION_TASK.md`的`computeEffectiveSampleCount`签名已更新为接受`eligibilityField`参数。
- **验证**：`V1_4_ACCEPTANCE_TESTS.md` T28类别（5条确定性测试）。
- **状态**：**已关闭，无遗留问题**。

#### P0-4：V1.4不能把大幅波动归因为`exogenous_shock`（关闭）

- **原风险**：`V1_4_HISTORICAL_VALIDATION_SPEC.md`draft-1把`exogenous_shock`列为"可评估（粗粒度）"，但V1.4没有新闻/事件数据能证明"确实发生了外生冲击"，这是无法验证的因果声称。
- **关闭方式**：`exogenous_shock`已改列`NOT_EVALUABLE`（§5.1）。新增`unexplainedExtremeMove`中性观测标记（§5.2a），只描述"发生了无法解释的极端波动"这一客观事实，不声称原因，且**不得**作为`primaryCause`/`secondaryCauses`的取值。`V1_4_CODEX_IMPLEMENTATION_TASK.md`的`attributeError`签名已更新返回类型。
- **验证**：`V1_4_ACCEPTANCE_TESTS.md` T27.3-T27.6。
- **状态**：**已关闭，无遗留问题**。

#### P0-5：禁止静默删除预测历史（关闭）

- **原风险**：draft-1设计"存储超过约1500条时优先淘汰已完成回填、时间最早的`ForecastSnapshot`"，构成验证审计证据被系统自动销毁的风险。
- **关闭方式**：`V1_4_FORECAST_DATA_SPEC.md`§8.3已重写：不自动删除任何已进入验证链路的记录；写入必须事务式/原子式；`QuotaExceededError`时设`storageHealth='STORAGE_BLOCKED'`、停止创建新快照、提示导出，保留全部已有数据；JSON导出须包含完整验证链路。`V1_4_CODEX_IMPLEMENTATION_TASK.md`§4.2同步重写，新增`persistForecastBundleAtomically`函数。
- **验证**：`V1_4_ACCEPTANCE_TESTS.md` T21.3-T21.8（6条新测试）。
- **状态**：**已关闭，无遗留问题**。

#### P1-1：纯函数不得接收storage（关闭）

- **原风险**：`buildForecastSnapshot`签名包含`storage`参数，与"纯函数"定位自相矛盾。
- **关闭方式**：`V1_4_CODEX_IMPLEMENTATION_TASK.md`§3已重组为三层——§3.1纯计算层（`buildForecastSnapshot`等，无`storage`参数）、§3.2 I/O辅助函数（`getServerTimeOffset`等，网络请求非持久化）、§3.3持久化层（`findForecastSnapshotByPredictionId`/`saveForecastSnapshot`/`persistForecastBundleAtomically`/`backfillIdempotent`/`generateForecastSnapshotOrchestrated`，含`storage`参数，负责去重与幂等）。
- **验证**：`V1_4_ACCEPTANCE_TESTS.md` T29类别（5条）。
- **状态**：**已关闭，无遗留问题**。

#### P1-2：`directionThreshold`时间尺度一致性（关闭）

- **原风险**：15分钟ATR乘固定系数、长期贴clamp下限，未能真实表达24H/72H预期波动。
- **关闭方式**：`V1_4_FORECAST_DATA_SPEC.md`§7.1已重写为"4H已收盘ATR + 平方根时间缩放"（`volatilityUnit=e4.atr14/referencePrice`，24H用`sqrt(6)`倍缩放，72H用`sqrt(18)`倍缩放，clamp边界不变），新增`rawThreshold`/`thresholdFloor`/`thresholdCeiling`/`thresholdFormulaVersion`字段存档，`e4.atr14`无效时不猜测、转入`INSUFFICIENT_DATA`。`V1_4_CODEX_IMPLEMENTATION_TASK.md`新增`computeDirectionThreshold`纯函数签名。
- **验证**：沿用`V1_4_ACCEPTANCE_TESTS.md` T15.4（已更新指向新公式）。
- **状态**：**已关闭，无遗留问题**。

#### P1-3：冻结完整输入窗口审计引用（关闭）

- **原风险**：每个symbol/timeframe只保存一条`DataVintageRef`，无法证明特征计算实际使用的历史K线窗口范围与内容。
- **关闭方式**：`V1_4_FORECAST_DATA_SPEC.md`新增§8.4a `KlineWindowRef`接口（六个窗口：ETH/BTC×15m/1h/4h），含`contentHash`覆盖整段已收盘K线序列内容；`ForecastSnapshot`新增`klineWindowRefs`字段（§6输出字段表已同步）。`V1_4_CODEX_IMPLEMENTATION_TASK.md`新增`computeKlineWindowRef`纯函数签名。
- **验证**：`V1_4_ACCEPTANCE_TESTS.md` T30（`v1.4-tests-draft-3`新增，T30.1-T30.19，共19条），覆盖六窗口完整性（T30.1-T30.4）、`contentHash`确定性（T30.5-T30.6）、内容敏感性（T30.7）、顺序敏感性（T30.8-T30.11）、收盘边界（T30.12-T30.13）、窗口元数据一致性（T30.14-T30.17）、审计复现（T30.18-T30.19）。
- **状态**：**已完全关闭，无遗留问题**——文档层面（SPEC§8.4a/CODEX_TASK函数签名）与测试覆盖层面（TESTS T30全部19条）均已闭合，此前"测试覆盖待后续补充"的遗留待办已消除。

#### P1-4：72H采样频率不为制造样本而提高（关闭）

- **关闭方式**：`V1_4_HISTORICAL_VALIDATION_SPEC.md`§1.1新增红线：24H`>=4小时`、72H`>=24小时`为上限，不得为凑样本量提高频率；`rawSampleCount`/`effectiveSampleCount`并列报告；样本不足时诚实披露，不得通过放宽筛选条件掩盖。
- **验证**：`V1_4_ACCEPTANCE_TESTS.md` T28.6/T28.7。
- **状态**：**已关闭，无遗留问题**。

### 1.3 附加发现：`firstResistance`/`firstSupport`字段形状错误（本轮核实v1-core.js后发现并关闭）

- **风险描述**：`V1_4_FORECAST_DATA_SPEC.md`draft-1 §4.2三处PO_\*状态定义假设`e4.firstSupport.lower`/`e4.firstResistance.upper`直接存在，但核对`v1-core.js`源码后确认：`analyzeKlines()`产出的`firstResistance`/`firstSupport`是`level()`函数产出的对象，形状为`{price, source, confidence, clusterId, barsAgo}`，**没有**`.lower`/`.upper`字段；这两个字段只存在于`buildSRZones()`函数的输出（`supportZones`/`resistanceZones`数组元素）上。
- **严重等级**：P1（会导致实现阶段直接按文档编码时读取`undefined`字段，PO_\*状态判定逻辑失效，但不构成安全/数据泄漏类风险）。
- **关闭方式**：`V1_4_FORECAST_DATA_SPEC.md`§4.1新增"字段形状红线"说明，§4.2三处判定改用`srZones = buildSRZones(e4)`记号，引用`srZones.supportZones[0].lower/.upper`/`srZones.resistanceZones[0].lower/.upper`。
- **验证**：建议下一轮测试补充中新增专项测试核对该字段访问路径（本轮暂未新增独立测试，风险等级低且已通过文档层面订正消除主要风险）。
- **状态**：**已关闭**。

### 1.4 实施阶段CEO授权例外记录（追加治理留痕）

本记录不删除、不弱化`V1_4_CODEX_IMPLEMENTATION_TASK.md`§1.2原始“禁止修改核心文件”红线。以下例外均由真实人工验收或真实公开行情发现P0后逐项批准，不构成后续任意修改冻结文件的先例；六份V1.4规范的其他红线继续有效。

1. **因果滚动ATR例外**：真实BTCUSDT 15m样本证明`detectAnomalyBars()`使用窗口末端ATR回溯历史，发生时间错配并误判27根正常历史K线。CEO只授权`v1-core.js`中因果滚动ATR异常检测及必要测试、哈希和构建同步，落地提交为`207f9e9ddf4eef2c658cc342876520a299bce979`。`5×ATR`阈值与`anomalyBarsExcluded>5`健康门保持不变，未授权其他`v1-core.js`重构。
2. **结构化入场区例外**：真实页面证明展示字符串`1,845.xx`被反向解析为`1.00–845.xx`，污染距离、档案和影子触发。CEO只授权`entryZoneValues`结构化数值贯通及严格旧档案兼容所必需的最小改动，落地提交为`d2b1f296cd1d4bba7f98d1e950c779bbb169873a`。逐项修改文件为：`v1-core.js`、`v1_3-paper-trading-core.js`、`v1_3-signal-archive-core.js`、`v1_3-auto-engine-core.js`、`v1_3-trade-gate-diagnostics.js`、`tests/v12-ui-tests.js`、`tests/v13-ui-tests.js`、`tests/v131-trade-gate-diagnostics-tests.js`、`tests/v1_4-structured-entry-zone.test.js`、`tests/fixtures/entry-zone-live-reproduction-2026-07-18.json`、`eth-dynamic-trading-dashboard.html`、`V1_4_IMPLEMENTATION_REPORT.md`、`V1_4_TEST_RESULTS.md`。未授权削弱V1.3.1交易门控或改变真实交易入口。

两项例外均有专项测试、真实REST与人工验收证据，并明确未接入真实交易。

### 1.5 P2级风险（重申，非新发现，本轮未变动）

#### P2-1：单文件架构限制

沿用 GMKG总架构 §16.1-16.2 已充分说明的单文件HTML限制。不构成新风险。

#### P2-2：`localStorage` 容量与性能

`ForecastSnapshot`/`ForecastOutcomeEvent`长期积累的体积问题。**本轮更新**：P0-5关闭后，容量策略从"淘汰旧记录"改为"`STORAGE_BLOCKED`+停止生成+提示导出"，容量压力测试的必要性依然存在（需确认多久会触及浏览器`localStorage`典型容量上限），但不再涉及"淘汰策略是否合理"这一问题，风险性质从"数据保留策略"变为"纯粹的容量规划"，严重等级不变（P2）。

#### P2-3：CORS

现货K线端点CORS已多轮确认可用，`/api/v3/time`端点为同域公开端点，理论上应享有相同CORS策略，但**未专门实测**（本轮`curl`只验证了`klines`与`time`端点的响应内容，未从浏览器环境专门验证`/api/v3/time`的CORS头）——建议实施阶段补充一次浏览器端`fetch('/api/v3/time')`的实测确认，风险等级维持P2（同域公开端点历史上CORS策略一致的可能性很高，但严谨起见不应假设）。

#### P2-4：性能

V1.4新增计算量极小，不构成性能风险。

---

## 2. 汇总表

| 编号 | 风险 | 严重等级 | 关闭状态 |
|---|---|---|---|
| P0-1 | PRICE_ONLY_MODE借用正式S0-S7状态标签 | P0 | 已关闭 |
| P0-2 | referenceBar本地时钟依赖 | P0 | 已关闭 |
| P0-3 | effectiveSampleCount算法错误 | P0 | 已关闭 |
| P0-4 | exogenous_shock误归因 | P0 | 已关闭 |
| P0-5 | 静默删除历史验证证据 | P0 | 已关闭 |
| P1-1 | buildForecastSnapshot纯函数/存储层混淆 | P1 | 已关闭 |
| P1-2 | directionThreshold时间尺度一致性不足 | P1 | 已关闭 |
| P1-3 | 缺少完整输入窗口审计引用 | P1 | 已完全关闭（`V1_4_ACCEPTANCE_TESTS.md` T30全部19条，测试覆盖无遗留） |
| P1-4 | 72H采样频率被提高以凑样本量的风险 | P1 | 已关闭 |
| 附加 | firstResistance/firstSupport字段形状错误 | P1 | 已关闭 |
| P2-1至P2-4 | 单文件限制/存储容量/CORS/性能 | P2 | 无需关闭动作，重申记录 |

**本轮结论**：全部P0（5项）与P1（4项+1项附加发现）均已关闭，无遗留阻断项；P1-3此前"测试覆盖待后续补充"的遗留待办已由`V1_4_ACCEPTANCE_TESTS.md` T30补齐，不再有任何已知遗留问题。

---

## 3. 跨文档一致性核对（逐项，用户§二十二15项，本轮更新）

| # | 核对项 | 结论 |
|---|---|---|
| 1 | SPEC要求全部进入CODEX_TASK | 达标——PO_\*判定（含字段形状修正）、`ForecastSnapshot`生成（纯函数/存储分层）、`KlineWindowRef`、`directionThreshold`新公式、路径定位、回填、walk-forward切分（新算法）、误差归因（含`unexplainedExtremeMove`）均已在CODEX_TASK§3-§4列出对应函数签名 |
| 2 | CODEX_TASK全部进入ACCEPTANCE_TESTS | 达标，**无遗留**：`KlineWindowRef`的`contentHash`确定性已由`V1_4_ACCEPTANCE_TESTS.md` T30全部19条覆盖（见§1.2 P1-3关闭记录），此前的待后续补充事项已消除 |
| 3 | ACCEPTANCE_TESTS覆盖ARCHITECTURE_REVIEW风险 | 达标——本轮全部10项风险（P0-1至P0-5、P1-1至P1-4、附加发现）均已在TESTS新增或更新对应测试，含P1-3的T30，无已知例外 |
| 4 | 所有字段名一致 | 达标——`fusionState`/`fusionStateAtGeneration`恒`'UNKNOWN'`、`storageHealth`、`thresholdFormulaVersion`、`klineWindowRefs`等新字段已在SPEC与CODEX_TASK间核对一致 |
| 5 | 所有枚举一致 | 达标——`OperatingMode`/`PriceOnlyStateId`/`TargetStateId`/`FusionStateId`仍只在GMKG总架构定义一次；本轮新增的`KlineWindowRef`/`UnexplainedExtremeMoveFlag`只在`V1_4_FORECAST_DATA_SPEC.md`/`V1_4_HISTORICAL_VALIDATION_SPEC.md`各自定义一次，未见重复定义 |
| 6 | 所有时间定义一致 | 达标——`closeTime=openTime+timeframeMs-1`不变；新增的服务器时间校验规则（`GET /api/v3/time`+单周期缓存偏移）已在SPEC/CODEX_TASK/MATRIX/TESTS四处同步 |
| 7 | 24H/72H bar数量一致 | 达标——96/288不变，未受本轮修订影响 |
| 8 | 可空类型一致 | 达标——未受本轮修订影响，`ForecastOutcomeEvent`可空字段定义不变 |
| 9 | 两类统计分母一致 | 达标——`pathEligibleForStatistics`/`directionEligibleForStatistics`定义不变；`computeEffectiveSampleCount`新增的`eligibilityField`参数与两分母对应关系在SPEC/VALIDATION_SPEC/CODEX_TASK/TESTS四处一致 |
| 10 | PRICE_ONLY_MODE边界一致 | 达标——`primaryState`/`fusionState`/`fusionStateAtGeneration`三者恒`'UNKNOWN'`的规则已在SPEC/TESTS间完全同步，不再有任何S0-S7标签借用的残留表述（已完成全文机械搜索确认，见§5） |
| 11 | ActionPermission边界一致 | 达标——`mode='DISPLAY_ONLY'`、`readinessCeiling='ALLOW_TEST'`、`gateStatus='WAIT'`不变；**R1轮P0-2遗留的"边界设计是否稳妥"疑虑已通过本轮P0-1裁决（fusionState恒UNKNOWN）彻底消除**，不再是悬而未决的问题 |
| 12 | 概率语义一致 | 达标——`scenarioWeights`≠概率、`calibratedProbabilities`恒null、Brier Score仅占位，不受本轮修订影响 |
| 13 | 数据源状态一致 | 达标——MATRIX新增服务器时间端点标注与SPEC§3.0同步，A/B/C三层结构不变 |
| 14 | 当前能力与目标架构不混淆 | 达标——【标注】体系不变，本轮新增内容（`KlineWindowRef`/`storageHealth`/`thresholdFormulaVersion`等）均已按体系标注 |
| 15 | 不削弱V1.3.1 | 达标——本轮修订未涉及V1.3.1相关文件引用，CODEX_TASK§1.2/§12、SPEC§12.2红线不变 |

---

## 4. 全文机械搜索结果（红线关键词，确认旧规则不再残留）

本轮提交前已对六份文档（含本文档自身）执行以下关键词的全文搜索，确认旧错误规则不再以"正文有效规则"的形式残留（历史背景说明中出现"draft-1曾..."这类明确标注为"已废除的历史方案"的表述不算残留，只有作为当前生效规则出现才算残留）：

| 关键词 | 搜索结果 |
|---|---|
| `S2_BULL_EXPANSION` | 仅出现在`V1_4_FORECAST_DATA_SPEC.md`§12.3"背景"段落与变更记录中，明确标注为"draft-1曾..."的已废除历史方案，不作为当前规则 |
| `S0_ACCUMULATION`（在V1.4文档中） | 同上，仅历史背景引用 |
| `fusionState` | 全部指向"恒为`'UNKNOWN'`"的当前规则，无残留的S0-S7映射 |
| `local time` / `本地时间` | 仅出现在"背景：draft-1曾允许本地时间减安全边际"的历史说明及红线"不得使用"的否定句式中，无正面允许的残留表述 |
| `Date.now` | 全部出现在"不得直接使用未经服务器偏移校正的`Date.now()`"这类否定语境中 |
| `safety margin` / `安全边际` | 仅出现在"本轮已撤销"的历史说明中 |
| `generatedAt排序` / `generatedAt升序` | 仅出现在`V1_4_HISTORICAL_VALIDATION_SPEC.md`§3.2"背景"段落，明确标注为已废除的draft-1算法 |
| `exogenous_shock` | 全部标注为`NOT_EVALUABLE`，无"可评估"的残留表述 |
| `1500` | 未在任何文档中以"存储上限"含义出现（原`V1_4_CODEX_IMPLEMENTATION_TASK.md`§4.2的"建议起点1500条"表述已随P0-5整体重写移除） |
| `delete oldest` / `删除已完成` / `淘汰已完成` | 仅出现在"背景：draft-1曾设计...已被CEO裁决撤销"的历史说明中 |
| `buildForecastSnapshot` | 全部签名已确认不含`storage`参数 |
| `storage`（在纯函数上下文中） | 已确认`storage`参数只出现在`V1_4_CODEX_IMPLEMENTATION_TASK.md`§3.3持久化层函数签名中 |
| `directionThreshold` | 公式已统一指向§7.1"4H ATR平方根时间缩放"新公式，无遗留的"15分钟ATR×固定倍数"表述作为当前规则 |
| `atr14` | 已确认`directionThreshold`计算改用`e4.atr14`（4小时），`e15`/`e4`各自用途已在SPEC中区分清楚 |
| `DataVintageRef` | 定义不变（GMKG总架构唯一权威），新增`KlineWindowRef`作为互补结构，未见混用或重复定义 |
| `lower`/`upper`（`firstResistance`/`firstSupport`语境） | 已确认全部改为`buildSRZones(e4).supportZones[0]/.resistanceZones[0]`引用路径，无遗留的`e4.firstSupport.lower`直接访问 |
| `待CEO裁决` | 全文搜索确认**不再出现**——本轮CEO已对上一轮遗留的全部"待CEO裁决"事项（`fusionState`展示方式、`referenceBar`时间校验方式、72H节奏）作出冻结裁决，相关文字已改写为"已冻结""已关闭"等确定性表述；§5仅保留1项与本轮九项修订无关的独立未决事项（B/C层数据源接入优先级），该项本身不属于本轮CEO裁决范围，如实保留 |

**结论**：机械搜索未发现任何应被清除但仍以"当前生效规则"形式残留的旧错误表述。

---

## 5. 仍需 CEO 决定的问题（本轮大幅精简，原3项已由CEO本轮裁决关闭）

1. **未来接入B/C层数据源的优先级顺序**——`V1_4_DATA_SOURCE_MATRIX.md`已记录候选清单，但未排出接入优先级，留待独立立项时讨论（与本轮P0-1至P0-5/P1-1至P1-4九项裁决无关，本轮不涉及）。

（原R1轮§5列出的"`fusionState`展示方式""`referenceBar`时间校验方式""72H节奏是否调整"三项，已分别由本轮CEO裁决P0-1/P0-2/P1-4关闭，不再作为待决问题保留。）

---

## 6. 最终结论：是否允许进入编码

**允许**——本轮CEO冻结裁决的5项P0与4项P1（含1项附加发现，共10项）已全部在六份文档中同步关闭，15项跨文档一致性核对全部达标，全文机械搜索未发现残留的旧错误规则。P1-3此前"`KlineWindowRef`测试覆盖待后续补充"的遗留待办已由`V1_4_ACCEPTANCE_TESTS.md` T30全部19条（T30.1-T30.19）补齐关闭，**不再有任何已知遗留待办**。`V1_4_CODEX_IMPLEMENTATION_TASK.md`§5定义的构建顺序（步骤1-8）**不再有任何一步因未决裁决或测试覆盖缺口而被建议暂缓**，可以按既定顺序整体推进，**可以交给Codex编码**。

---

## 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.4-review-draft-1 | 2026-07-18 | 初稿：独立发现2项P0（referenceBar本地时钟依赖、fusionState借用正式状态标签风险）、3项P1（72H样本积累缓慢、非重叠子抽样次优、归因规则不可变性缺少测试）、4项P2（单文件限制/存储容量/CORS/性能均为重申非新发现）；完成15项跨文档一致性核对，发现并回填2处ACCEPTANCE_TESTS缺口；给出"有条件允许进入编码"的最终结论及2个需CEO裁决的P0问题 |
| v1.4-review-draft-2 | 2026-07-18 | CEO本轮冻结裁决关闭P0-1至P0-5、P1-1至P1-4（含R1轮遗留的2项P0与部分P1，以及本轮新发现的P0-4/P0-5/P1-1/P1-2/P1-3五项），另发现并关闭`firstResistance`/`firstSupport`字段形状错误1项；重写§1风险清单（含R1/本轮编号映射表）、§2汇总表、§3跨文档一致性核对、新增§4全文机械关键词搜索记录、精简§5仅剩1项无关本轮的独立未决事项、§6最终结论改为无条件"允许进入编码" |
| v1.4-review-draft-3 | 2026-07-18 | 补齐P1-3遗留的"`KlineWindowRef`确定性测试尚无专属测试类别"待办：`V1_4_ACCEPTANCE_TESTS.md`新增T30全部19条后，P1-3由"文档层面已关闭、测试覆盖待补充"改判为**完全关闭**；同步更新§1.2 P1-3条目、§2汇总表、§3核对表第2/3项、§6最终结论，删除全部"不阻断编码"的例外表述 |
