# V1_4_CODEX_IMPLEMENTATION_TASK.md — V1.4 Codex 实施工单

版本：v1.4-task-draft-2（CEO本轮冻结裁决关闭P0-1/P0-2/P0-3/P0-4/P0-5/P1-1/P1-2/P1-3后的修订版）
基线：`main` @ `a3d7aea`
角色：本文档是**Codex实施阶段**（未来批准后）的唯一权威工单，定义文件范围、模块划分、构建顺序、存储契约、测试方式。本文档**本身不是编码**，本轮不执行任何一步。

---

## 1. 范围红线（对照用户需求，逐条落地）

### 1.1 允许新增的文件

```
v1_4-gmkg-forecast-core.js       — PO_*状态判定、ForecastSnapshot生成、scenarioWeights计算（纯函数）
v1_4-gmkg-outcome-core.js        — ForecastOutcomeEvent回填、路径完整性判定、幂等去重（纯函数）
v1_4-gmkg-validation-core.js     — walk-forward切分、重叠样本处理、误差归因标注（纯函数）
work/v1-gmkg-min-loop.template.html  — 新增UI模板片段（比照既有v1-*.template.html模式）
tests/v1_4-gmkg-*.test.js（或等价目录）— V1.4专属测试文件（未来测试阶段新增，本轮不创建）
```

### 1.2 禁止修改的文件（红线）

```
GMKG_DRAGONFLY_ARCHITECTURE.md   — 本轮及V1.4实施阶段均不得修改
v1-core.js                        — V1.1核心，不得修改一行
v1_2-forecast-core.js             — V1.2预测核心，不得修改一行
v1_3-paper-trading-core.js        — V1.3模拟账户，不得修改
v1_3-signal-archive-core.js       — V1.3建议档案，不得修改
v1_3-auto-engine-core.js          — V1.3自动引擎，不得修改
v1_3-trade-gate-diagnostics.js    — V1.3.1交易门禁诊断，不得修改
eth-dynamic-trading-dashboard.html / index.html / eth-trading-dashboard.html — 不得手工编辑生成产物，只能通过构建脚本产出
其余既有 V1_*.md / STRATEGY_SPEC.md / ACCEPTANCE_TESTS.md / CODEX_IMPLEMENTATION_TASK.md 等既有规范文档 — 不得修改
work/build-v1.js                  — 只允许**新增**占位符替换调用（见§7），不得修改既有替换逻辑
```

### 1.3 本轮（文档阶段）动作

**本轮不新增、不修改上述任何代码文件**，只交付六份V1.4文档本身。

---

## 2. 数据结构唯一来源声明（红线，本工单不重复定义字段，只引用）

| 结构 | 唯一权威来源 |
|---|---|
| `DataVintageRef`/`DataRevisionEvent`/`StateFrame`/`WorldState`/`FrameDataQuality`/`BarRef`/`OperatingMode`/`FormalStateId`/`TargetStateId`/`FusionStateId`/`PriceOnlyStateId`/`TargetState`/`FeatureCompleteness`/`ProxyTransitionRecord`/`FormalTransitionRecord`/`TransitionBundle`/`TrajectoryScenarios`/`ScenarioDetail`/`ForecastResult`/`ForecastSnapshot`/`ForecastOutcomeEvent`/`ActionPermission`/`ErrorAttribution` | `GMKG_DRAGONFLY_ARCHITECTURE.md` |
| PO_\*状态具体判定规则/`directionThreshold`/`scenarioWeights`归一化/`predictionId`生成/存储schemaVersion | `V1_4_FORECAST_DATA_SPEC.md` |
| walk-forward切分/重叠样本处理/误差归因规则冻结 | `V1_4_HISTORICAL_VALIDATION_SPEC.md` |
| 数据源状态 | `V1_4_DATA_SOURCE_MATRIX.md` |

Codex实现任何字段前，必须先在对应文档中定位其权威定义，**不得**在代码中凭记忆或推测重新发明字段形状。

---

## 3. 函数接口分层（红线，P1-1，CEO已冻结裁决：纯计算层 ≠ 存储层）

**背景**：draft-1把`buildForecastSnapshot(instrument, horizon, referenceBarRef, klineHistory, decision, storage)`列为"纯函数"，但签名末尾携带`storage`参数，语义自相矛盾——真正的纯函数不读写外部持久化状态。CEO本轮裁决：**计算层与存储层必须彻底分离**，本节重新组织为三层。

### 3.1 纯计算层（无`storage`参数，不读写`localStorage`，不做持久化去重查询，同输入必同输出）

```ts
// v1_4-gmkg-forecast-core.js
function classifyProxyState(e4, e1, decision): { operatingMode, proxyState, candidateStates, stateConfidence, stateEvidence, opposingEvidence }
  // 见 V1_4_FORECAST_DATA_SPEC.md §4，纯函数，输入为v1-core.js既有analyzeKlines/buildDecision输出，不新增数据采集

function buildForecastSnapshot(instrument, horizon, referenceBarRef, targetBarRef, klineWindowRefs, decision, serverTimeInfo, algorithmVersion): ForecastSnapshot
  // P1-1修订：不再接收storage参数，只接收生成快照所需的全部不可变业务输入（含P1-3新增的klineWindowRefs、
  // 已确认可用的serverTimeInfo，见§3.2 getServerTimeOffset的返回值由外层传入，本函数自身不发起网络请求）。
  // 见 V1_4_FORECAST_DATA_SPEC.md §5-§8；targetBarRef为"预先算好指向哪根未来K线"的引用，
  // 不要求该K线此刻已存在（真正的路径回填在v1_4-gmkg-outcome-core.js的locateTargetPath完成）。
  // 不读取localStorage、不写localStorage、不做"是否已存在同predictionId"的持久化查询——
  // 去重查询是外层持久化函数（见§3.3 findForecastSnapshotByPredictionId）的职责，本函数只管"给定输入算出什么"。

function computeScenarioWeights(proxyState, stateConfidence): { baseline, upside, downside }
  // 见 V1_4_FORECAST_DATA_SPEC.md §7.4，纯函数，输出满足归一化不变量

function generatePredictionId(instrument, horizon, referenceBarRef, algorithmVersion): string
  // 见 V1_4_FORECAST_DATA_SPEC.md §8.1，纯函数（字符串拼接），本身不查询是否已存在

function computeDirectionThreshold(atr14Closed4h, referencePrice, horizon): { rawThreshold, directionThreshold, thresholdFloor, thresholdCeiling, thresholdFormulaVersion } | { ok: false, reason: 'ATR_INVALID' }
  // 见 V1_4_FORECAST_DATA_SPEC.md §7.1（P1-2，4H ATR平方根时间缩放），纯函数，atr14Closed4h无效时返回失败标记，
  // 由调用方决定转入INSUFFICIENT_DATA，本函数不猜测阈值

function computeKlineWindowRef(symbol, timeframe, closedKlines): KlineWindowRef
  // 见 V1_4_FORECAST_DATA_SPEC.md §8.4a（P1-3新增），纯函数，contentHash对按序已收盘K线内容计算，
  // 只接受已收盘K线，不得混入未收盘K线

// v1_4-gmkg-outcome-core.js
function locateTargetPath(referenceBarRef, expectedBarCount, klineSource): { targetBarRef, missingBarRefs, pathDataComplete, endpointDataComplete, observedBarCount }
  // 按sequenceIndex遍历真实K线序列定位，见 GMKG_DRAGONFLY_ARCHITECTURE.md §10.2/§10.5.1九项不变量，
  // 不得只做"referenceBar.closeTime + N×timeframeMs"的算术推算就假设该bar存在
  // 注：klineSource是外部行情数据（Binance K线），不是本项目自己的localStorage持久化状态，
  // 本函数接收该参数不违反"纯计算层不读写storage"的红线，二者是不同范畴（见§3.2说明）

function buildOutcomeEvent(snapshot: ForecastSnapshot, klineSource, evaluationVersion): ForecastOutcomeEvent
  // 见 GMKG_DRAGONFLY_ARCHITECTURE.md §10.1/§10.4/§10.4a + V1_4_FORECAST_DATA_SPEC.md §7.2，纯函数，
  // klineSource同上，非本项目持久化存储

// v1_4-gmkg-validation-core.js
function splitByTime(samples, trainEnd, validationEnd): { training, validation, test }
  // 见 V1_4_HISTORICAL_VALIDATION_SPEC.md §2，严格按时间戳切分，不打乱

function computeEffectiveSampleCount(samples, instrument, horizon, eligibilityField: 'directionEligibleForStatistics' | 'pathEligibleForStatistics'): { rawSampleCount, effectiveSampleCount, selectedSampleIds }
  // 见 V1_4_HISTORICAL_VALIDATION_SPEC.md §3.2标准区间调度算法（P0-3，非draft-1的generatedAt贪心算法）：
  // 按instrument+horizon分组 → 只取eligibilityField=true的样本 → 按targetEndTime升序排序
  // （相同时按targetStartTime、再按predictionId升序）→ 贪心选择candidate.targetStartTime>=lastSelected.targetEndTime。
  // 必须对direction/path两种eligibilityField分别调用一次，不得混用同一次调用结果冒充两个分母。

function attributeError(snapshot, outcomeEvent): ErrorAttribution & { unexplainedExtremeMove: UnexplainedExtremeMoveFlag }
  // 见 V1_4_HISTORICAL_VALIDATION_SPEC.md §5.1/§5.2/§5.2a，含notEvaluableCauses
  // 红线（P0-4）：exogenous_shock恒不出现在primaryCause/secondaryCauses中，必须出现在notEvaluableCauses；
  // unexplainedExtremeMove是独立诊断字段，只描述观测事实，不构成因果声称，不得写入primaryCause/secondaryCauses
```

**红线（P1-1核心）**：3.1节列出的函数**全部为纯函数**——输入决定输出，不读写`localStorage`、不做持久化去重查询、无隐藏状态、同输入必得同输出。`klineSource`/`klineHistory`/`klineWindowRefs`等参数是**外部行情数据**（Binance K线，经由§3.2函数获取后以参数传入），不是本项目自己的持久化存储，接收这类参数不违反"纯计算层不碰storage"的红线；真正的`storage`（`ethAlphaGmkg*`键）只允许出现在§3.3持久化层函数的参数列表中。

### 3.2 I/O 辅助函数（网络请求，非本项目持久化存储，允许有副作用但不涉及`localStorage`）

```ts
function getServerTimeOffset(): { offset: number, fetchedAt: number } | { ok: false, reason: 'SERVER_TIME_UNAVAILABLE' }
  // 调用GET /api/v3/time，成功则返回offset=serverTime-Date.now()；失败/超时则返回失败标记。
  // 见 V1_4_FORECAST_DATA_SPEC.md §3.0（P0-2）：判断K线是否已收盘必须用(Date.now()+offset)与closeTime比较，
  // 不得直接用未经校正的Date.now()，不得用"本地时间减安全边际"替代；offset只在单次刷新周期内缓存，不跨周期沿用。
  // 由外层编排函数（见§3.3）决定：offset获取失败时fail closed，返回DATA_BLOCKED，不调用§3.1的buildForecastSnapshot。

function fetchClosedKlines(symbol, timeframe, sinceBarKey?): KlineBar[]
  // 复用v1-core.js既有Binance现货REST拉取逻辑（不重新实现），只返回已收盘K线，供§3.1纯函数消费
```

### 3.3 持久化层（含`storage`参数，负责去重、幂等、原子写入，本层调用§3.1纯函数完成实际计算）

```ts
function findForecastSnapshotByPredictionId(predictionId, storage): ForecastSnapshot | null
  // 去重查询，见 V1_4_FORECAST_DATA_SPEC.md §8.2

function saveForecastSnapshot(snapshot, storage): { ok, deduped }
  // 单表写入，写入前调用findForecastSnapshotByPredictionId确认不存在同predictionId记录

function persistForecastBundleAtomically(snapshot, proxyTransitionRecords, storage): { ok, reason? }
  // 原子式/事务式写入（P0-5）：snapshot与其关联的ProxyTransitionRecord要么全部成功持久化，要么全部不写，
  // 不产生"只有Snapshot没有对应Transition记录"这类部分完成状态，见 V1_4_FORECAST_DATA_SPEC.md §8.3第3点

function generateForecastSnapshotOrchestrated(instrument, horizon, storage): ForecastSnapshot | { ok: false, reason: 'DATA_BLOCKED' | 'INSUFFICIENT_DATA', detail }
  // 外层编排函数，唯一允许调用getServerTimeOffset+fetchClosedKlines+classifyProxyState+buildForecastSnapshot
  // +findForecastSnapshotByPredictionId+persistForecastBundleAtomically的入口：
  // 1) 调用getServerTimeOffset，失败则直接返回DATA_BLOCKED（P0-2），不进入下一步；
  // 2) 检查storageHealth（见§4.2），为STORAGE_BLOCKED则直接拒绝，不生成新Snapshot（P0-5）；
  // 3) 拉取K线、计算KlineWindowRef/directionThreshold/classifyProxyState等纯函数结果；
  // 4) 调用buildForecastSnapshot（纯函数）产出候选ForecastSnapshot；
  // 5) 调用findForecastSnapshotByPredictionId去重，已存在则直接返回既有记录（不重复生成）；
  // 6) 调用persistForecastBundleAtomically原子写入。

function backfillIdempotent(predictionId, evaluationVersion, storage): { ok, outcomeEventId, replayed }
  // 见 GMKG_DRAGONFLY_ARCHITECTURE.md §10.6，同predictionId+evaluationVersion重复调用返回既有记录；
  // 内部调用buildOutcomeEvent（纯函数）计算结果后再持久化，持久化本身（含幂等判断）是本函数职责，
  // buildOutcomeEvent本身不做任何存储读写（P1-1同一原则的延伸）
```

**红线**：`storage`参数**只允许**出现在本节（§3.3）函数签名中，比照`v1-core.js`既有`saveDecisionLog(entry, storage)`模式，不硬编码`window.localStorage`，便于Node测试传入mock storage。§3.1纯函数与§3.3持久化函数的边界必须在代码目录结构上体现（如`v1_4-gmkg-forecast-core.js`只放§3.1，持久化编排逻辑放在单独文件或明确区分的模块内），供`V1_4_ACCEPTANCE_TESTS.md`对应测试直接静态检查函数签名。

---

## 4. localStorage 键名与 schemaVersion（红线，与V1.1-V1.3.1既有键完全隔离）

| 键名 | 内容 | schemaVersion |
|---|---|---|
| `ethAlphaGmkgForecastSnapshots` | `ForecastSnapshot[]` | `'v1.4-forecastsnapshot-1'` |
| `ethAlphaGmkgOutcomeEvents` | `ForecastOutcomeEvent[]` | `'v1.4-outcomeevent-1'` |
| `ethAlphaGmkgProxyTransitions` | `ProxyTransitionRecord[]`（`PROXY_STATS`，见GMKG总架构§8.4/§9） | `'v1.4-proxytransition-1'` |
| `ethAlphaGmkgErrorAttributions` | `ErrorAttribution[]` | `'v1.4-errorattribution-1'` |
| `ethAlphaGmkgWalkForwardConfig` | 训练/验证/测试切分时间点等配置 | `'v1.4-walkforwardconfig-1'` |

**红线**：`ethAlphaGmkg*`前缀与既有`ethAlphaDecisionLogs`/`ethAlphaForecastLogs`/`ethAlphaPaperAccount`/`ethAlphaSignalArchive`/`ethAlphaTradeGateDiagnostics`等既有键**完全不同**，不共用、不互相覆盖，V1.4读写不影响V1.1-V1.3.1既有存储。`ethAlphaGmkgProxyTransitions`与未来预留的（当前不存在的）`FormalTransitionRecord`存储键**必须分离**（即使当前没有`FormalTransitionRecord`实例，也不得让`ProxyTransitionRecord`和未来的`FormalTransitionRecord`共用同一个键，见GMKG总架构§9红线）。

### 4.1 迁移策略

比照`v1_3-paper-trading-core.js`既有`migratePaperAccount`/`migratePaperTrades`模式：`load*`函数读取时若`schemaVersion`不匹配当前代码版本，执行迁移函数补齐新增字段（缺失字段填入符合类型的默认值，如`null`/`[]`），迁移后写回；若数据结构本身无法识别（非JSON、关键字段类型错误），**默认拒绝**（不静默使用损坏数据，返回空集合并记录警告，不抛出未捕获异常导致页面崩溃）。

### 4.2 容量与超限处理（P0-5，CEO已冻结裁决，取代draft-1"约1500条优先淘汰已完成旧快照"方案）

**红线**：`ethAlphaGmkgForecastSnapshots`/`ethAlphaGmkgOutcomeEvents`/`ethAlphaGmkgProxyTransitions`/`ethAlphaGmkgErrorAttributions`**不采用**既有`saveDecisionLog`一类`.slice(-N)`自动淘汰模式——那类模式适用于"越新越有价值、旧记录可丢弃"的运行日志，不适用于V1.4这类**验证审计证据**（见`V1_4_FORECAST_DATA_SPEC.md`§8.3）。具体实现要求：

1. 写入前检测`localStorage`剩余容量（如尝试写入捕获`QuotaExceededError`，或维护一个近似的已用容量估计值提前预警）；
2. 容量充足时正常写入，**不设人为的"最大保存条数"上限**去主动淘汰历史记录；
3. 检测到`QuotaExceededError`或容量预警阈值时：
   - 保留全部已有数据（不删除任何记录）；
   - 顶层维护一个 `storageHealth: 'NORMAL' | 'STORAGE_BLOCKED'` 状态（新增，非GMKG总架构定义字段，V1.4存储层元数据），置为`'STORAGE_BLOCKED'`；
   - 后续调用`buildForecastSnapshot`生成新预测的**外层持久化函数**（见§3 P1-1纯函数/存储层分离）检测到`storageHealth==='STORAGE_BLOCKED'`时直接拒绝写入并返回明确原因，不尝试生成新`ForecastSnapshot`；
   - UI层轮询/读取`storageHealth`，为`'STORAGE_BLOCKED'`时展示"存储空间已满，请先导出JSON备份"提示；
4. **事务式/原子式写入**：涉及多张表联动的写入（如同一次生成流程需要写`ForecastSnapshot`+对应的`ProxyTransitionRecord`），实现时必须先在内存中构造全部待写入对象、校验全部通过后再依次持久化，或采用等价的"全部成功/全部回滚"策略，**不得**出现"`ForecastSnapshot`写入成功但关联的`ProxyTransitionRecord`写入失败"这类部分完成状态（对应§3 `persistForecastBundleAtomically`函数）；
5. 长期历史存储能力不足是V1.4作为短期本地原型的**已知且接受的限制**，不通过删除数据来规避，未来版本推迟到`IndexedDB`或服务器架构（`V1_4_FORECAST_DATA_SPEC.md`§8.3第6点）。

---

## 5. 构建顺序（严格按此顺序，前一步验证通过再进入下一步）

### 步骤1：PO_\*状态判定纯函数

实现`classifyProxyState`，覆盖§4.2定义的9个状态，单元测试逐状态验证必要/加分/否决条件（离线测试，不需要真实网络请求，使用构造的K线数组）。

### 步骤2：`ForecastSnapshot`生成

实现`buildForecastSnapshot`/`computeScenarioWeights`/`generatePredictionId`，验证`predictionId`去重、`scenarioWeights`归一化不变量、`dataVintageRefs`/`featureValuesUsed`/`contentHash`填充正确。

### 步骤3：路径定位与`ForecastOutcomeEvent`回填

实现`locateTargetPath`/`buildOutcomeEvent`/`backfillIdempotent`，**必须**先用真实Binance REST测试核实§7.2边界规则，再实现离线单元测试（构造缺口/重复/乱序K线数组验证九项不变量逐项触发`pathDataComplete=false`）。

### 步骤4：Walk-forward脚手架与误差归因

实现`splitByTime`/`computeEffectiveSampleCount`/`attributeError`，验证时间切分正确性、重叠子抽样算法正确性、`notEvaluableCauses`完整列出。

### 步骤5：存储接线

实现`save*`/`load*`/迁移函数，接入§4键名与容量规则。

### 步骤6：UI接线（见§6）

### 步骤7：构建脚本接线（见§7）

### 步骤8：自测与回归（见§9-§10）

---

## 6. UI 最低要求

新增独立展示区域"**GMKG 24H/72H 展望（PRICE_ONLY 代理）**"，作为独立卡片，置于既有"走势预测与情景推演"卡片**之后**（不插入、不替换、不修改既有卡片DOM结构）。最低展示内容：`instrument`/`horizon`/`operatingMode`/`proxyState`/`stateConfidence`/`scenarioWeights`（明确标注"规则型权重，非概率"）/`expectedPriceZones`/`invalidationConditions`/`actionPermission`（含`mode='DISPLAY_ONLY'`标注）/`dataQuality`/`featureCompleteness`。**必须**在该卡片内醒目展示固定免责声明："当前仅基于价格结构代理判断（PRICE_ONLY_MODE），不代表GMKG正式八状态识别，不构成交易建议"。

---

## 7. 构建脚本接线（`work/build-v1.js`，只新增不修改既有逻辑）

比照既有`replaceExact`精确计数保护机制，新增：

```js
template = replaceExact(template, '/*__GMKG_MIN_LOOP_UI__*/', gmkgUi, 1, 'V1.4 GMKG最小闭环UI占位符');
template = replaceExact(template, '/*__GMKG_MIN_LOOP__*/', gmkgCore, 1, 'V1.4 GMKG最小闭环核心占位符');
```

新增的两个占位符必须在HTML模板中**新增**对应位置（不占用/替换既有`__CORE__`/`__FORECAST__`/`__PAPER_TRADING__`等既有占位符位置），构建产物仍为单文件HTML（V1.4阶段延续单文件架构，不引入服务器，呼应GMKG总架构§16.4"当前HTML未来定位"）。

---

## 8. JSON/CSV 导出

比照既有`exportPaperLogsJSON`/`exportPaperLogsCSV`模式，新增`exportGmkgSnapshotsJSON`/`exportGmkgOutcomesJSON`/`exportGmkgSnapshotsCSV`。CSV导出**必须**复用V1.1既有的公式注入防护（字段值以`'`/`=`/`+`/`-`/`@`开头时前置单引号转义），不重新发明防护逻辑。

---

## 9. 离线测试与真实REST测试（红线，两类测试均须存在，不得只做一类）

### 9.1 离线测试（不需要网络）

构造K线数组（含正常序列、缺口序列、重复`sequenceIndex`序列、乱序时间序列、未收盘K线、模拟`estimated`标记bar），验证：PO_\*状态判定逐条件命中、`pathDataComplete`九项不变量逐项触发、`scenarioWeights`归一化、`predictionId`去重、幂等回填、存储迁移/损坏拒绝。

### 9.2 真实REST测试（需要网络，一次性运行，记录结果存档）

**在正式实现`locateTargetPath`前**，必须用真实Binance REST核实：
1. 当前`GET .../klines?symbol=ETHUSDT&interval=15m&limit=N`返回的`openTime`/`closeTime`边界关系是否仍与`V1_4_FORECAST_DATA_SPEC.md`§5.3记录的实测结论一致（该结论核实于2026-07-18，实现时若时间已过去较久，建议重新抽样核实一次，防止Binance未公告地调整过响应格式）；
2. 抽取一段真实历史K线（如最近500根15m K线），验证`sequenceIndex`遍历定位算法在真实数据上不出现误判。

测试结果（包括原始响应样本）需记录进未来的"V1.4实施报告"（见§11），不得只在开发者本地运行后不留痕迹。

---

## 10. 测试命令（占位，具体命令由实现阶段的`package.json`/脚本约定）

```
npm run test:v1.4:offline   — 运行§9.1离线测试
npm run test:v1.4:rest      — 运行§9.2真实REST测试（需要网络，CI环境需确认可访问Binance API）
npm run test:v1.4:regression — 运行V1.1/V1.2/V1.3/V1.3.1既有回归测试，确认零回归
```

---

## 11. 实施报告要求

未来Codex完成实施后，必须提交`V1_4_IMPLEMENTATION_REPORT.md`（本轮不创建），至少包含：实际交付文件清单、每个步骤的自测结果、真实REST测试的原始响应存档、与本工单§2-§10的偏差说明（如有）、已知限制。

---

## 12. 禁止事项清单（红线，逐条对应用户需求）

1. **不能接入真实交易**——不连接交易所账户、不读取API密钥、不发送真实订单；
2. **不能削弱V1.3.1**——不修改`v1_3-trade-gate-diagnostics.js`/`v1_3-paper-trading-core.js`/`v1_3-signal-archive-core.js`，不调用`recordSignalIfEligible`/`evaluateShadowSignals`/`tickAutoEngine`/`buildTradeProposal`（见`V1_4_FORECAST_DATA_SPEC.md`§12.2）；
3. **不能自行接入240+48项数据**——只使用`V1_4_DATA_SOURCE_MATRIX.md`§A列出的Binance现货K线，不得因"实现时觉得加个字段很容易"就顺手接入§B/§C层任何数据源；
4. **不能自行建立服务器**——V1.4延续单文件HTML+localStorage架构，不引入常驻服务进程、不新增后端；
5. **不能声称产生校准概率**——`calibratedProbabilities`/`calibratedProbability`任何时候写入非null值都是违反本工单的行为，代码审查必须专项检查这一点；
6. **不能扩大Walk-forward范围**——不得实现`V1_4_HISTORICAL_VALIDATION_SPEC.md`§7.2明确排除的自动调参/自动校准闭环；
7. **不能一次改动过大**——严格按§5步骤顺序逐步实现，每步验证通过再进入下一步，不得合并步骤一次性提交巨量代码。

---

## 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.4-task-draft-1 | 2026-07-18 | 初稿：定义允许/禁止修改文件、纯函数接口、localStorage键名与迁移、8步构建顺序、UI最低要求、构建脚本接线、导出、离线+真实REST两类测试、禁止事项清单 |
| v1.4-task-draft-2 | 2026-07-18 | CEO本轮冻结裁决：①§3重组为纯计算层/I/O辅助函数/持久化层三层，`buildForecastSnapshot`等纯函数不再接收`storage`参数，新增`findForecastSnapshotByPredictionId`/`persistForecastBundleAtomically`/`generateForecastSnapshotOrchestrated`等持久化编排函数（P1-1）；②`getServerTimeOffset`与referenceBar已收盘判定红线重写，撤销"本地时间减安全边际"备选方案，服务器时间不可用fail closed（P0-2）；③`computeEffectiveSampleCount`签名新增`eligibilityField`参数，改用标准区间调度算法（P0-3）；④`attributeError`返回类型新增`unexplainedExtremeMove`，`exogenous_shock`恒不出现在primaryCause（P0-4）；⑤§4.2容量处理重写为不删除历史+`storageHealth`+原子写入（P0-5）；⑥新增`computeDirectionThreshold`（P1-2）与`computeKlineWindowRef`（P1-3）纯函数签名 |
