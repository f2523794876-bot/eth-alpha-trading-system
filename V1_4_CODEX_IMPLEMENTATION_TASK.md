# V1_4_CODEX_IMPLEMENTATION_TASK.md — V1.4 Codex 实施工单

版本：v1.4-task-draft-1
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

## 3. 纯函数接口（签名固定，内部实现细节自行组织，行为必须匹配上述规范文档）

```ts
// v1_4-gmkg-forecast-core.js
function classifyProxyState(e4, e1, decision): { operatingMode, proxyState, candidateStates, stateConfidence, stateEvidence, opposingEvidence }
  // 见 V1_4_FORECAST_DATA_SPEC.md §4，纯函数，输入为v1-core.js既有analyzeKlines/buildDecision输出，不新增数据采集

function buildForecastSnapshot(instrument, horizon, referenceBarRef, klineHistory, decision, storage): ForecastSnapshot
  // 见 V1_4_FORECAST_DATA_SPEC.md §5-§8；klineHistory须包含足够未来占位（生成时仅需referenceBar，
  // targetBarRef为"预先算好指向哪根未来K线"的引用，不要求该K线此刻已存在）

function computeScenarioWeights(proxyState, stateConfidence): { baseline, upside, downside }
  // 见 V1_4_FORECAST_DATA_SPEC.md §7.4，纯函数，输出满足归一化不变量

function generatePredictionId(instrument, horizon, referenceBarRef, algorithmVersion): string
  // 见 V1_4_FORECAST_DATA_SPEC.md §8.1

// v1_4-gmkg-outcome-core.js
function locateTargetPath(referenceBarRef, expectedBarCount, klineSource): { targetBarRef, missingBarRefs, pathDataComplete, endpointDataComplete, observedBarCount }
  // 按sequenceIndex遍历真实K线序列定位，见 GMKG_DRAGONFLY_ARCHITECTURE.md §10.2/§10.5.1九项不变量，
  // 不得只做"referenceBar.closeTime + N×timeframeMs"的算术推算就假设该bar存在

// referenceBar"已收盘"判定红线（回应 V1_4_ARCHITECTURE_REVIEW.md P0-1，本轮已关闭）：
// 判断某根K线是否已收盘时，必须以该K线自身的closeTime与Binance服务器时间（GET /api/v3/time）比较，
// 不得直接使用调用方本地Date.now()——本地系统时钟偏快时，直接信任本地时间可能把实际尚未真正收盘的K线
// （相对Binance服务器视角）误判为已收盘并选为referenceBar，污染referencePrice与整条预测。
// 若工程上认为每次生成都额外请求/api/v3/time代价过高，允许改为"closeTime <= 本地时间 − 安全边际"，
// 但安全边际数值与选择理由必须写入实施报告，不得省略不做任何判断。对应验收见 V1_4_ACCEPTANCE_TESTS.md T3.4。

function buildOutcomeEvent(snapshot: ForecastSnapshot, klineSource, evaluationVersion): ForecastOutcomeEvent
  // 见 GMKG_DRAGONFLY_ARCHITECTURE.md §10.1/§10.4/§10.4a + V1_4_FORECAST_DATA_SPEC.md §7.2

function backfillIdempotent(predictionId, evaluationVersion, storage): { ok, outcomeEventId, replayed }
  // 见 GMKG_DRAGONFLY_ARCHITECTURE.md §10.6，同predictionId+evaluationVersion重复调用返回既有记录

// v1_4-gmkg-validation-core.js
function splitByTime(samples, trainEnd, validationEnd): { training, validation, test }
  // 见 V1_4_HISTORICAL_VALIDATION_SPEC.md §2，严格按时间戳切分，不打乱

function computeEffectiveSampleCount(samples, horizon): { rawSampleCount, effectiveSampleCount, selectedSampleIds }
  // 见 V1_4_HISTORICAL_VALIDATION_SPEC.md §3.2非重叠子抽样算法

function attributeError(snapshot, outcomeEvent): ErrorAttribution
  // 见 V1_4_HISTORICAL_VALIDATION_SPEC.md §5.1/§5.2，含notEvaluableCauses
```

**红线**：以上函数**全部为纯函数**（输入决定输出，不直接读写`storage`/DOM），`storage`只在最外层的"保存"函数（如`saveForecastSnapshot(snapshot, storage)`/`saveOutcomeEvent(event, storage)`）中以参数注入，比照`v1-core.js`既有`saveDecisionLog(entry, storage)`模式，不硬编码`window.localStorage`，便于Node测试传入mock storage。

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

### 4.2 容量与超限处理

比照既有`.slice(-N)`模式（如`saveDecisionLog`的`.slice(-500)`），`ethAlphaGmkgForecastSnapshots`/`ethAlphaGmkgOutcomeEvents`各自设最大保存条数（具体数字由Codex在实现时根据实际存储压力测试确定，建议起点1500条，与`V1_3_PAPER_TRADING_SPEC.md`既有建议量级一致）。超限时**优先淘汰已完成`ForecastOutcomeEvent`回填、时间最早的`ForecastSnapshot`**，**不得**优先淘汰尚未回填的记录（见`V1_4_FORECAST_DATA_SPEC.md`§8.3红线）。

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
