# V1_4C_SCOPE_SPEC.md — V1.4C 服务器端预测基础设施 冻结规范

版本：v1.4c-spec-draft-2（Codex 对 `e421f8c870b692ce2fb800d8080c1aeb899bd64f` 的定向复审关闭 P1-1/P1-2/P1-3 后的修订版，见 §4.1/§8.3/§8.4/§7.1/§7.2/§17.4/§17.9/§17.11/§17.12）
基线：`main` @ `96d3651`（含 V1.4A `codex/v1.4a-server-data-foundation`、V1.4B `codex/v1.4b-feature-engine-foundation`，PR #10/#11 已合并，main PostgreSQL CI 触发修复已合并并绿色通过）
角色：本文档是 **V1.4C 阶段——把浏览器端已验证过的 PO_ 状态/`ForecastSnapshot`/`ForecastOutcomeEvent`/可复现验证闭环，迁移为服务器端、PostgreSQL 持久化、可 24 小时运行的正式预测基础设施——的唯一权威冻结规范**。本文档**本身不是编码**，本轮不修改任何生产代码、测试代码、数据库迁移、`package.json`、GitHub Actions 或部署配置，只交付规范文档。

**贯穿全文的强制标注规则**（延续 `GMKG_DRAGONFLY_ARCHITECTURE.md`/`V1_4_FORECAST_DATA_SPEC.md` 已建立的体系）：

| 标注 | 含义 |
|---|---|
| 【已冻结，直接复用】 | 字段/规则已在 GMKG 总架构或既有 V1.4 六份文档中唯一权威定义，本文档只引用章节号，不重新发明 |
| 【V1.4C 新增冻结】 | 既有文档从未定义、本文档首次给出唯一权威裁决的字段/规则/映射 |
| 【V1.4C 不实现】 | 属于更后续阶段（融合中枢/S0-S7/广度眼等）范围，本轮明确不做 |
| 【待 Codex 实施层确认】 | 架构/业务规则已冻结，但具体代码组织（如某个 SQL 索引的命名）留给实施工单 |

---

## 目录

1. 目标与非目标
2. 权威术语
3. 数据流与组件边界
4. `ForecastSnapshot` 完整字段表
5. `ForecastOutcomeEvent` 完整字段表
6. PostgreSQL 表设计（唯一键/外键/CHECK/不可变约束）
7. 幂等、事务、lease 与 fencing 契约
8. PO_ 状态输入特征白名单（含 V1.4B 特征映射）
9. `auxiliaryEvidence` 规则
10. 96/288 路径遍历伪代码
11. endpoint/path/direction 统计资格真值表
12. 浏览器与服务器数据来源隔离规则
13. 版本字段与 `contentHash` 计算口径
14. P0/P1/P2 验收矩阵
15. 建议新增/修改文件清单
16. 后续 Codex 实施的严格构建顺序
17. 规范差异与覆盖关系（文档一致性检查）

---

## 1. 目标与非目标

### 1.1 唯一目标

将现有浏览器端（`v1_4-gmkg-forecast-core.js`/`v1_4-gmkg-outcome-core.js`/`v1_4-gmkg-validation-core.js`，已通过 6 个既有测试文件验证、已构建进正式单文件 HTML）已经验证过的 PO_ 状态判定、`ForecastSnapshot` 生成、`ForecastOutcomeEvent` 回填及可复现验证闭环，**迁移为服务器端、PostgreSQL 持久化、可 24 小时运行的正式预测基础设施**，建立在 V1.4A（server 数据采集基础）与 V1.4B（54 项特征引擎）已经真实、经多轮独立对抗性复审验证的基础设施之上。

### 1.2 非目标（红线，逐条对应 CEO 裁决七）

V1.4C **不包含**：
- `WorldState` 正式实现（广度眼，12 域宏观数据，仍无数据源）；
- 三眼正式聚合（`JointState`，广度眼数据不存在，无法聚合）；
- 融合中枢（消费 `WorldState`+`TargetState`+`TrajectoryScenarios`，三者均未正式产出）；
- `ActionPermission`（`readinessLevel`/`gateStatus`）；
- `ALLOW`/`PREPARE`/`OBSERVE`/`BLOCK`（融合中枢的输出，比本轮范围更下游）；
- S0-S7 `FormalStateId` 正式状态判定（`FULL_STATE_MODE` 所需的 D/E/F 组数据——期权隐含波动率、交易所净流入、强平数据——仍不具备，见 GMKG 总架构 §7.0b）；
- 期权、链上、强平、订单簿或宏观付费数据接入；
- `calibratedProbability` 真实校准（`probabilityStatus` 继续 `'rule_based'`，直到 GMKG §8.5 门槛——样本量——被满足）；
- 自动调参或自动训练；
- `ErrorAttribution` 引擎（本轮只做 `ForecastOutcomeEvent` 幂等回填，误差归因作为独立后续阶段）；
- 浏览器预测代码（`v1_4-gmkg-*.js` 三文件）重构；
- 真实交易、密钥、下单或模拟持仓变更。

### 1.3 命名消歧（延续 GMKG 总架构 §1）

- **GMKG 固定表述**：广度眼＝环境感知；精度眼＝目标状态感知；单眼＝轨迹感知；融合中枢＝冲突裁决与行动许可。**融合中枢不是"第四只眼"**——它是消费前三者输出的独立决策层，不采集/计算环境或目标状态本身（GMKG 总架构 §2 系统定义表已明确，本文档不重新定义）。
- V1.4C 不实现三眼正式聚合，不实现融合中枢——本轮只服务器化"单眼的价格结构侧代理证据（PO_ 状态）+ 预测快照/回填骨架"这一条已经在浏览器验证过的窄路径，不触碰广度眼/精度眼正式状态/单眼正式轨迹推演/融合中枢的任何一层。
- 全文提到"蜻蜓捕猎模型"/`bestInterceptionZone`/`dragonflyText` 时，特指 `STRATEGY_SPEC.md` §7 已实现的战术拦截区计算，**不属于**本文档范围，本文档不修改它。

---

## 2. 权威术语

本节只做**索引**，不重复定义字段形状——字段的唯一权威定义位置见下表，凡本文档与下表冲突之处，以下表指向的原始文档为准（除非在 §17"规范差异与覆盖关系"中明确记录了覆盖裁决）：

| 术语 | 唯一权威定义位置 | 本文档角色 |
|---|---|---|
| 广度眼/精度眼/单眼/融合中枢/四系统定义 | `GMKG_DRAGONFLY_ARCHITECTURE.md` §2 | 直接引用，见 §1.3 |
| `DataVintageRef`/`DataRevisionEvent` | GMKG 总架构 §4.3/§4.3.1 | 直接引用；V1.4A/V1.4B 已真实实现，V1.4C 复用 |
| `OperatingMode`/`TargetStateId`/`FusionStateId`/`PriceOnlyStateId`/`TargetState` | GMKG 总架构 §6.3/§7.0a/§7.0b | 直接引用类型；V1.4C 只产出 `PRICE_ONLY_MODE` 下的字段取值 |
| `BarRef`/`ForecastSnapshot`/`ForecastOutcomeEvent` | GMKG 总架构 §10.1/§10.2 | 直接引用接口形状；本文档 §4/§5 补充服务器化落地的具体字段来源，见 §17 差异记录（存在结构性留白，本文档新增补充字段） |
| `TrajectoryScenarios`/`ScenarioDetail` | GMKG 总架构 §11.2 | 直接引用；V1.4C 沿用 §11.2 的 `TransitionBundle` 判别联合，只产出 `ProxyTransitionRecord`+`{kind:'none'}`，不产出 `FormalTransitionRecord`（同 `V1_4_FORECAST_DATA_SPEC.md` §3 既有约束） |
| PO_ 状态九个具体判定规则（状态存在性/业务语义/必要条件/加分条件/否决条件） | `V1_4_FORECAST_DATA_SPEC.md` §4.2（唯一权威，本文档不得扩展或重定义） | 本文档 §8 引用状态清单本身，新增**服务器特征映射**（既有文档从未定义，见 §17） |
| `directionThreshold`/方向判定规则 | GMKG 总架构 §10.3 | 直接复用 |
| MFE/MAE/RANGE 专属指标口径 | GMKG 总架构 §10.4/§10.4a | 直接复用 |
| 路径完整性九项不变量 | GMKG 总架构 §10.5.1 | 直接复用，见 §10 伪代码 |
| Walk-forward 切分/重叠样本处理 | `V1_4_HISTORICAL_VALIDATION_SPEC.md` §1-§3 | 直接复用区间调度算法 |
| V1.4B `feature_records`/`feature_source_refs`/54 项特征 | `V1_4B_IMPLEMENTATION_REPORT.md`；`server/src/features/feature-version.js` | 直接引用；V1.4C 唯一的特征数据来源 |
| V1.4A `market_bars`/lease/fencing/revision 协议 | `V1_4A_IMPLEMENTATION_REPORT.md`；`server/src/db/postgres.js` | 直接引用；V1.4C 的 `ForecastGenerator` 复用同一 lease/fencing 模式，但使用独立 lease 名 |

---

## 3. 数据流与组件边界

```
V1.4A CollectorService                V1.4B FeatureEngine              V1.4C（本文档，新增，两个独立调度器）
  Binance REST                          loadFeatureInputs()               ForecastGenerator（lease: forecast-generator）
    → market_bars                         → 54项features                    → PO_状态判定（§8）
    → funding_rates/open_interest/         → feature_records                → referenceBar/targetBar定位（§10）
       long_short_ratios/taker_flow        → feature_source_refs             → 4H ATR14/directionThreshold（§4.1）
    （revision-safe, as-of正确）           （revision-safe, as-of正确,       → ForecastSnapshot生成（§4）
                                             同一事务原子写入）                → 事务内写入
                                                                                  forecast_snapshots +
                                                                                  forecast_snapshot_sources +
                                                                                  forecast_quality_events +
                                                                                  forecast_generation_runs（§6/§7）

                                                                              OutcomeEvaluator（lease: forecast-outcome-evaluator，
                                                                                与ForecastGenerator完全独立，见§7.1/§7.2）
                                                                                → 路径完整性判定（§10/§11）
                                                                                → 事务内写入
                                                                                    forecast_outcome_events +
                                                                                    forecast_quality_events +
                                                                                    forecast_evaluation_runs（§6.6/§7）

只读只从上游读取，不反向修改：
  V1.4C 只调用 V1.4A repository 的只读查询（market_bars 按 sequenceIndex 遍历）与 V1.4B repository 的只读查询
  （feature_records/feature_source_refs），不写入 market_bars/feature_records 任何字段，不触发 V1.4A/V1.4B 的
  收集/特征生成循环。
```

**组件边界红线**：
1. `ForecastGenerator`/`OutcomeEvaluator`（V1.4C，P1-3 已关闭）是独立于 V1.4A `CollectorService`、V1.4B `FeatureEngine` 的**第三、第四个调度器**，彼此也完全独立（不是同一调度器内部的两个子任务），见 §7.1/§7.2；四者共享同一 PostgreSQL 实例与同一 `collector_leases` 表结构（表结构复用，lease 名不同，见 §7.2），但代码路径、npm 脚本、CI 步骤各自独立。
2. PO_ 状态判定（§8）**只读消费** V1.4B `feature_records` 的既有字段与 V1.4A `market_bars` 的原始 K 线历史（§8.3 映射一/二新增的、独立于 `feature_records` 的历史遍历计算），**不重新计算**任何一项 54 项特征本身——重新计算会违反"同一份数据只计一次权重"的一般原则（GMKG 总架构 §3 非重叠性红线的同一哲学延伸）。
3. `ForecastSnapshot` 生成**不依赖**浏览器端 `v1_4-gmkg-*.js` 的任何代码或运行时状态——两者是完全独立的两条实现，只共享 GMKG 总架构 §10.1 定义的抽象接口形状，不共享代码、不共享存储、不共享调度。

---

## 4. `ForecastSnapshot` 完整字段表

基础形状【已冻结，直接复用】来自 GMKG 总架构 §10.1；`【V1.4C新增】`标注的字段是本文档为服务器化落地新增的补充字段（原因见 §17.2），**不修改**、**不删除** GMKG §10.1 原有任何字段。

| 字段 | 类型 | 来源/规则 | 标注 |
|---|---|---|---|
| `predictionId` | string | `` `GMKG-SRV-${instrument}-${horizon}-${referenceBarRef.closeTime}-${algorithmVersion}` ``（见 §13.1，`-SRV-` 段防止与浏览器端 `GMKG-${instrument}-...` 格式碰撞） | 【V1.4C新增，见§17.3】 |
| `instrument` | `'BTC'\|'ETH'` | 同 GMKG §10.1 | 已冻结 |
| `horizon` | `'24h'\|'72h'` | 同上 | 已冻结 |
| `generatedAt` | number (ms) | 服务器 `now()`，须经 §3.0 服务器时间前置门禁校验后取值 | 已冻结 |
| `dataCutoffTime` | number (ms) | = 本次生成使用的全部 `feature_records`/`market_bars` 查询的 `asOfTime` 参数 | 已冻结，语义对应 V1.4B `loadFeatureInputs` 的 `asOfTime` |
| `targetStartTime`/`targetEndTime` | number (ms) | 同 GMKG §10.2 | 已冻结 |
| `referencePrice` | number | `referenceBar` 收盘价，来自 V1.4A `market_bars.close`（as-of 正确查询，见 §10） | 已冻结 |
| `referenceBarRef`/`targetBarRef` | `BarRef` | 同 GMKG §10.1，`barKey` 格式复用 §10.1 建议的 `` `${symbol}-15m-${closeTime}` `` | 已冻结 |
| `expectedBarCount` | number | 96（24H）或 288（72H） | 已冻结 |
| `expectedDirection` | `'UP'\|'DOWN'\|'RANGE'` | 见 §10.3 判定规则 | 已冻结 |
| `directionThreshold` | number | 见 §4.1 公式（P1-1 已关闭，唯一权威口径） | 已冻结 |
| `rawThreshold` | number | clamp 前的原始计算值，见 §4.1 | 【V1.4C新增，P1-1 审计字段】 |
| `thresholdFloor`/`thresholdCeiling` | number | 本次 `horizon` 对应的 clamp 下限/上限常量，见 §4.1 | 【V1.4C新增，P1-1 审计字段】 |
| `thresholdFormulaVersion` | string | 阈值公式本身的版本号，独立于 `algorithmVersion`，见 §4.1/§13.3 | 【V1.4C新增，P1-1 审计字段】 |
| `atr14FourHourAtGeneration` | number | 生成时刻使用的已收盘 4H ATR14 **不可变值副本**，来源与计算见 §4.1（不复用 `feature_records.atr14`，该字段是 15m 目标周期的 ATR） | 【V1.4C新增，P1-1 审计字段】 |
| `targetStateAtGeneration` | `TargetStateId` | **恒为 `'UNKNOWN'`**（`PRICE_ONLY_MODE` 下红线，GMKG §7.0a） | 已冻结 |
| `proxyStateAtGeneration` | `PriceOnlyStateId` | 本次生成时刻的 PO_ 状态判定结果（见 §8） | 【V1.4C新增，见§17.2】——GMKG §10.1 原始接口未列出此字段插槽 |
| `fusionStateAtGeneration` | `FusionStateId` | **恒为 `'UNKNOWN'`**（融合中枢未实现，见 §1.2；结构占位，不计算） | 已冻结（取值方式为 V1.4C 新增的占位裁决，见§17.5） |
| `candidateTrajectories` | `TrajectoryScenarios` | 只产出 `ProxyTransitionRecord`+`{kind:'none'}`，不产出 `FormalTransitionRecord`（`V1_4_FORECAST_DATA_SPEC.md` §0.2 既有约束） | 已冻结 |
| `scenarioWeights` | `{baseline,upside,downside}` | 三项之和恒等于 100，见 GMKG §10.1 归一化/舍入不变量 | 已冻结 |
| `probabilityStatus` | `'rule_based'\|'similarity_based'\|'calibrated'` | V1.4C 恒为 `'rule_based'`（§1.2 非目标：不做真实校准） | 已冻结 |
| `calibratedProbabilities` | `Record<string, number\|null>` | 全部 `null`（同上） | 已冻结 |
| `expectedPriceZones` | `{baseline,upside,downside: [number,number]}` | 见 GMKG §10.1 | 已冻结 |
| `triggerConditions`/`invalidationConditions` | `string[]` | 见 GMKG §10.1 | 已冻结 |
| `algorithmVersion` | string | V1.4C 独立版本命名空间，如 `'v1.4c-server-po-rule-1'`，**不得**与浏览器端 `poRuleVersion`/`algorithmVersion` 取值相同（见 §13.1） | 【V1.4C新增裁决】 |
| `weightVersion`/`datasetVersion` | string | 同 GMKG §10.1；`datasetVersion` 建议直接复用 V1.4B `SOURCE_DATASET_VERSION`（`v1.4a-server-schema-1`，已冻结常量） | 已冻结/复用 |
| `dataVintageRefs` | `string[]` | 来自 V1.4B `feature_records.source_vintage_refs[].vintageId` 展开 | 已冻结（引用来源新增，见§17.2） |
| `featureValuesUsed` | `Record<string, number\|string\|boolean>` | **不可变值副本**，直接复制自本次读取的 `feature_records.feature_values`（JSONB），**不是**动态外键引用（见 §7.3 红线 3） | 已冻结（复用 V1.4B 已有字段） |
| `featureRecordIds` | `bigint[]` | 【V1.4C新增】本次快照实际读取的全部 `feature_records.feature_record_id`（可能横跨 15m/1h/4h/derivatives 多条记录），仅作可追溯指针，**不用于**回填时重新读取（红线，见 §7.3） | 【V1.4C新增，见§17.2】 |
| `featureEngineVersion` | string | 直接复用 V1.4B `FEATURE_ALGORITHM_VERSION`（`v1.4b-feature-engine-1`） | 已冻结/复用 |
| `contentHash` | string | 见 §13.2 | 已冻结口径，新增计算范围 |
| `auxiliaryEvidence` | `Record<string, unknown>` | 见 §9，funding/OI/taker-flow 等 V1.4B 已有但不参与 PO_ 判定的证据 | 【V1.4C新增，见§17.6】 |

### 4.1 `directionThreshold` 计算公式（P1-1，已关闭，唯一权威口径，不留待实施层裁决）

**来源数据（`atr14FourHourAtGeneration`）**：V1.4B `feature_records.feature_values.atr14` 是 15m 目标周期的 ATR（`computeFeatureValues()` 恒以 `eth15` 为基础计算全部"结构"类字段，与 `targetInterval` 参数无关），**不是**4H 周期的 ATR，因此本公式**不得**读取 `feature_records.atr14`。4H ATR14 由 V1.4C 独立计算：按 §10 相同的 as-of 正确查询模式，对 V1.4A `market_bars`（`market_type='spot'`, `interval_name='4h'`, `close_time<=asOfTime` 且已收盘）取最近 14 根已收盘 4H K 线，套用与 V1.4B `feature-engine.js` `trueRanges()`/`atr()`**完全相同的真实波幅公式**（逐根 `max(high-low, |high-prevClose|, |low-prevClose|)` 后取 14 周期均值），**不重新发明**波幅计算方式，只是把同一公式应用到 4H 而非 15m 窗口。计算结果在快照生成事务内**一次性复制**为 `atr14FourHourAtGeneration` 不可变值（同 §7.3 `featureValuesUsed` 的"复制而非引用"红线），不随 `market_bars` 后续 revision 变化。

**公式**：

```
periods  = (horizon === '24h') ? 6  : 18
floor    = (horizon === '24h') ? 0.008 : 0.015
ceiling  = (horizon === '24h') ? 0.05  : 0.08

rawThreshold      = atr14FourHourAtGeneration / referencePrice × sqrt(periods)
directionThreshold = clamp(rawThreshold, floor, ceiling)
thresholdFloor      = floor
thresholdCeiling    = ceiling
thresholdFormulaVersion = 'v1.4c-threshold-formula-1'

方向判定（GMKG §10.3 既有抽象规则的具体化，不改变 §10.3 本身）：
  actualReturn >= +directionThreshold → UP
  actualReturn <= -directionThreshold → DOWN
  否则                                 → RANGE
```

**若 4H ATR14 数据不足（不足 14 根已收盘 4H K 线，或 `referencePrice<=0`）**：`rawThreshold` 无法计算，本次生成 `fail closed`——不产出 `directionThreshold`、不产出正式 `ForecastSnapshot`，`forecast_generation_runs` 记录 `error_code='ATR14_4H_INSUFFICIENT'`，与 §7.5 服务器时间不可用时的 fail-closed 处理属于同一类前置门禁，不得用近似值或历史缓存值顶替。

**红线**：`periods`/`floor`/`ceiling` 三组数值随 `thresholdFormulaVersion` 一并冻结，**不得**在同一 `thresholdFormulaVersion` 内调整（同 §13.3 版本号纪律）；未来若认为数值需要调整，必须递增 `thresholdFormulaVersion`，不得复用旧版本号静默改值。

---

## 5. `ForecastOutcomeEvent` 完整字段表

【已冻结，直接复用】GMKG 总架构 §10.1 `ForecastOutcomeEvent` 接口全部字段（`outcomeEventId`/`predictionId`/`evaluatedAt`/`actualStartPrice`/`actualEndPrice`/`actualReturn`/`actualDirection`/`directionCorrect`/`endpointInBaselineZone`/`endpointInAnyScenarioZone`/`realizedRangeInsideExpectedEnvelope`/`expectedEnvelopeTouched`/`actualHigh`/`actualLow`/`mfe`/`mae`/`upperExcursion`/`lowerExcursion`/`maxAbsoluteExcursion`/`rangeBreachExcursion`/`invalidationTriggered`/`expectedBarCount`/`observedBarCount`/`missingBarRefs`/`endpointDataComplete`/`pathDataComplete`/`pathEligibleForStatistics`/`directionEligibleForStatistics`/`exclusionReasons`/`evaluationVersion`），本文档不重新定义任一字段形状，全部取值规则见 §10/§11。**唯一新增**：

| 字段 | 类型 | 来源/规则 | 标注 |
|---|---|---|---|
| `sourceOrigin` | `'SERVER'\|'LEGACY_BROWSER'` | 恒为 `'SERVER'`（本表只服务于服务器生成的 `ForecastSnapshot` 的回填；浏览器记录的回填逻辑不变，继续在浏览器自己的存储里完成，两者不共用同一张表，见 §12） | 【V1.4C新增，见§17.7】 |

---

## 6. PostgreSQL 表设计

比照 V1.4B `feature_records`/`feature_source_refs`/`feature_quality_events`/`feature_revision_events` 的既有模式（同一事务写入、advisory lock、fencing token 事务内校验），新增以下表（迁移文件编号、精确列类型、索引名等属于 §16 Codex 实施层决定，本节冻结**结构性约束**）：

### 6.1 `forecast_snapshots`

- 主键：`forecast_snapshot_id bigserial`；
- 唯一键：`UNIQUE(prediction_id)`——`prediction_id` 本身已包含 `instrument+horizon+referenceBarRef.closeTime+algorithmVersion` 四要素，天然防止同一逻辑预测重复生成（见 §7.4 幂等契约）；
- **不设 `revision_number` 列，不设 `ON CONFLICT ... DO UPDATE`**——`ForecastSnapshot` 生成后不可变，重复生成必须走 §7.4 DEDUPED 分支直接返回既有记录，**不追加 revision、不覆盖**（对应 CEO 裁决四.1/四.6，与 `feature_records`/`market_bars` 的 revision-追加模式**刻意不同**，见 §17.8 红线）；
- CHECK 约束（延续 V1.4A/B 已验证的时间红线模式）：
  - `CHECK (target_start_time < target_end_time)`；
  - `CHECK (target_end_time - target_start_time = expected_bar_count * 900000)`（900000ms = 15分钟，強制 `expectedBarCount` 与起止时间的一致性）；
  - `CHECK (generated_at >= data_cutoff_time)`（防止生成时间早于数据截止时间，逻辑不自洽）；
  - `CHECK (target_state_at_generation = 'UNKNOWN')`（数据库层强制 §1.2/§4"恒为 UNKNOWN"红线，防止应用层 bug 意外写入非法值）；
  - `CHECK (fusion_state_at_generation = 'UNKNOWN')`（同上，对应 §4 fusionState 占位红线）；
  - `CHECK (scenario_weight_baseline + scenario_weight_upside + scenario_weight_downside = 100)`（GMKG §10.1 情景权重不变量的数据库层兜底）；
  - `CHECK (probability_status = 'rule_based')`（V1.4C 范围内的结构性红线，防止应用层意外写入其他值）；
  - `CHECK (direction_threshold >= threshold_floor AND direction_threshold <= threshold_ceiling)`（P1-1 clamp 不变量的数据库层兜底）；
  - `CHECK ((horizon = '24h' AND threshold_floor = 0.008 AND threshold_ceiling = 0.05) OR (horizon = '72h' AND threshold_floor = 0.015 AND threshold_ceiling = 0.08))`（§4.1 逐 horizon 冻结数值的数据库层强制，防止应用层 bug 写入错误组合）；
  - `CHECK (atr14_four_hour_at_generation > 0)`（4H ATR14 审计值必须为正数，防止 fail-closed 分支下的空值被误写为 0）；
- 外键：`raw_payload_id` 类字段不直接存在于本表（`featureValuesUsed` 是值副本，不是外键引用，见 §7.3），但 `forecast_snapshot_sources`（见 6.2）持有指向 `feature_records.feature_record_id` 的外键，`ON DELETE RESTRICT`（禁止级联删除，保持可追溯性，同 V1.4B `feature_source_refs` 模式）；
- 数据库层不可变：比照 V1.4A `raw_payloads_no_update`/`raw_payloads_no_delete` 触发器模式，新增 `forecast_snapshots_no_update`/`forecast_snapshots_no_delete` 触发器，`RAISE EXCEPTION 'FORECAST_SNAPSHOT_IMMUTABLE'`——这是比 `feature_records`（允许追加 revision，但也不允许 UPDATE 已有行）更严格的约束，因为 `forecast_snapshots` 连"新 revision 追加"这条口子都不开（§17.8）。

### 6.2 `forecast_snapshot_sources`（对应 GMKG §10.1 `dataVintageRefs`/`featureRecordIds` 的展开表，比照 `feature_source_refs` 模式）

- 主键：`forecast_snapshot_source_id bigserial`；
- 外键：`forecast_snapshot_id` → `forecast_snapshots(forecast_snapshot_id) ON DELETE RESTRICT`；`feature_record_id` → `feature_records(feature_record_id) ON DELETE RESTRICT`；
- 唯一键：`UNIQUE(forecast_snapshot_id, feature_record_id)`（同一快照引用同一 feature_record 不得重复插入）；
- CHECK：`CHECK (vintage_id IS NOT NULL)`。

### 6.3 `forecast_quality_events`

- 比照 `feature_quality_events` 模式：`forecast_quality_event_id text PRIMARY KEY`，外键 `forecast_snapshot_id`（可为 `NULL`，对应生成被 `fail closed` 阻断、未产生正式快照的情形，见 §7.5）；`lease_name` 列记录写入时使用的 lease（`'forecast-generator'` 或 `'forecast-outcome-evaluator'`，见 §7.2），本表被两个独立调度器共用，但每一行只归属其中一个 lease，**不得**混淆两者的审计归属。

### 6.4 `forecast_outcome_events`

- 主键：`forecast_outcome_event_id bigserial`；
- 外键：`prediction_id` → `forecast_snapshots(prediction_id) ON DELETE RESTRICT`（只读引用，不得反向修改被引用的 Snapshot，GMKG §10.1 红线的数据库层保证）；
- 唯一键：`UNIQUE(prediction_id, evaluation_version)`——幂等回填的数据库层保证：同一 `predictionId`+同一 `evaluationVersion` 重复调用回填函数，`ON CONFLICT(prediction_id, evaluation_version) DO NOTHING`，直接查询已有记录返回（见 §7.4）；`evaluationVersion` 升级后允许追加一条新记录（新 `outcomeEventId`，同一 `predictionId`），与旧版本并存，**不覆盖**（GMKG §10.6 红线的数据库层落地）；
- **本表全部写入方法只接受 `'forecast-outcome-evaluator'` lease**（P1-3 已关闭，见 §7.2），`ForecastGenerator` 无权、也不应调用本表的任何写入方法；
- **本表允许追加（不同 `evaluationVersion`），但同一 `evaluationVersion` 内是不可变+幂等，不是 revision 协议**——不设 `revision_number`；
- CHECK：`CHECK (path_data_complete = false OR (mfe IS NOT NULL OR expected_direction_is_range))`——路径类指标只在 `pathDataComplete=true` 时可能非 null，此类约束具体形式见 §10/§11 真值表，精确 SQL 表达式留待 §16 Codex 层实现，本节只冻结"不完整时必须为 NULL，不得为 0 或近似值"这一结构性要求。

### 6.5 `forecast_generation_runs`（比照 V1.4B `feature_generation_runs`）

- 记录 `ForecastGenerator` 每次调度周期的运行状态，`lease_name`（恒为 `'forecast-generator'`）/`fencing_token` 列，用于 §7 审计。

### 6.6 `forecast_evaluation_runs`（P1-3 新增，`OutcomeEvaluator` 独立审计表，不与 6.5 合并）

- 结构比照 6.5，记录 `OutcomeEvaluator` 每次调度周期的运行状态，`lease_name`（恒为 `'forecast-outcome-evaluator'`）/`fencing_token` 列；
- **独立建表而非复用 `forecast_generation_runs`**——对应 CEO 裁决原文"独立恢复和审计"：两个调度器的运行历史必须能够分别、独立地追溯（如"`OutcomeEvaluator` 最近一次续约失败发生在何时"这类审计问题不应依赖过滤 `forecast_generation_runs` 里混杂的另一调度器记录）。

---

## 7. 幂等、事务、lease 与 fencing 契约

### 7.1 独立调度器（CEO 裁决五.1/五.2，P1-3 已关闭：Generator 与 Outcome 两个调度器彻底分离）

服务器端新增**两个独立的调度器**，均**不复用**浏览器端任何定时器代码，也**不复用** V1.4A `CollectorService`/V1.4B `FeatureEngine` 的调度循环本身（可以复用其**代码模式**——`schedule()`/`clearSchedulers()`/`loseLease()` 这一套已经过独立复审验证的"续约失败即真正停止调度"机制，但必须是独立的类实例、独立的定时器数组，不共享运行时状态）：

1. **`ForecastGenerator`**（`server/src/forecast/generator-service.js`，命名待 §16 确认）——负责 §4/§10 的 `ForecastSnapshot` 生成，节奏见 §7.6。
2. **`OutcomeEvaluator`**（`server/src/outcome/evaluator-service.js`，命名待 §16 确认）——负责 §5/§10/§11 的 `ForecastOutcomeEvent` 回填，**是与 `ForecastGenerator` 完全独立的第二个调度器实例**：独立的定时器数组、独立的运行状态（`running`/`leaseLost`/`abortController`），两者互不感知彼此的调度周期。`OutcomeEvaluator` 的触发节奏本身不属于 CEO 裁决冻结范围，由 §16 Codex 实施层决定（如"每次 `ForecastGenerator` 完成一轮生成后触发一次回填检查"或"独立定时轮询待评估的 `forecast_snapshots`"均可，只要满足本节 7.2 的独立 lease 与 §7.4 的幂等契约）。

### 7.2 独立 lease 与 fencing token（CEO 裁决五.3，P1-3 已关闭：两个调度器持有各自独立的 lease）

新增两个独立 lease 名（均区别于 V1.4A 的 `'primary-collector'`、V1.4B 的 `'feature-generator'`）：

| 调度器 | lease 名 | 覆盖的写入方法 |
|---|---|---|
| `ForecastGenerator` | `'forecast-generator'` | `forecast_snapshots`/`forecast_snapshot_sources`/`forecast_quality_events`（生成路径）/`forecast_generation_runs` |
| `OutcomeEvaluator` | `'forecast-outcome-evaluator'` | `forecast_outcome_events`（回填路径）/`forecast_quality_events`（回填相关的质量事件，如 `ATR14_4H_INSUFFICIENT` 之外的回填期错误） |

两个 lease 复用 `collector_leases` 表结构（同一张表，不同 `lease_name` 行）与 V1.4A 已验证的原子 UPSERT 获取模式；**每个调度器只能用自己的 lease 校验自己负责的表**，`OutcomeEvaluator` 不得持有或校验 `'forecast-generator'` lease 反之亦然——这是"独立调度、独立 fencing token、独立恢复和审计"（CEO 裁决原文）在数据库层的具体落地：两个调度器即使同时运行、同时发生续约失败，也是完全独立的两次故障，一个的 lease 丢失**不影响**另一个继续正常写入。全部写入方法都必须接收对应的 `lease` 参数，并在同一事务内（`BEGIN` 后、`COMMIT` 前）校验 fencing token（复用 V1.4A `assertLease()` 模式，同一份代码可直接复用，不需要重新实现校验逻辑本身）。

**红线（CEO 裁决原文"旧fencing token提交必须在数据库事务内被拒绝且不得留下残行"）**：无论是 `ForecastGenerator` 还是 `OutcomeEvaluator`，旧 fencing token 提交时，`assertLease()` 在事务内抛出 `FENCING_TOKEN_REJECTED`，整个事务（含已缓存但未提交的任何 INSERT）原子回滚，**不产生**任何 `forecast_snapshots`/`forecast_snapshot_sources`/`forecast_quality_events`/`forecast_outcome_events` 残行——这与 V1.4A/B 已验证的"事务内 fencing 校验+失败整体回滚"模式完全一致，只是本节明确扩展到 `OutcomeEvaluator` 自己的独立 lease 场景，不能因为回填路径是"后新增的调度器"就遗漏这一红线。

### 7.3 事务原子性（CEO 裁决五.4）

**快照生成、lineage 保存（`forecast_snapshot_sources`）及相关质量事件（`forecast_quality_events`）必须在单一数据库事务内完成**——比照 V1.4B `saveFeatureRecord()` 的模式（同一 `this.transaction(...)` 调用内完成 `feature_records`+`feature_source_refs`+`feature_quality_events`+可能的 `feature_revision_events` 四类写入），`forecast_snapshots`+`forecast_snapshot_sources`+`forecast_quality_events` 三类写入必须在同一事务内完成，任一步失败整体回滚，不产生孤儿快照或孤儿 lineage 引用。

**红线（对应 CEO 裁决四.3/四.4）**：`featureValuesUsed` 必须在事务内从 `feature_records.feature_values` **一次性复制**为不可变值，写入 `forecast_snapshots.feature_values_used`（JSONB 列），**不得**只保存 `feature_record_id` 外键、留待读取 API 时动态 JOIN `feature_records` 表获取当前值——这样做会导致：若该 `feature_record_id` 对应的自然键之后因源数据修订而追加了新 revision（V1.4B 已验证的正常行为），旧 `ForecastSnapshot` 读出来的 `featureValuesUsed` 会静默变成新数值，违反"生成后不可变"红线。`featureRecordIds` 数组仅用于审计追溯"当时读取的是哪些具体 feature_record 行"，任何读取 API **不得**用它反查当前值再冒充 `featureValuesUsed`。

### 7.4 幂等契约（CEO 裁决五.7，对应 §6.1/§6.4 唯一键设计）

```
生成流程：
  1. 计算本次 referenceBarRef.closeTime + instrument + horizon + algorithmVersion
  2. 组装 predictionId（§13.1公式）
  3. 事务内 INSERT INTO forecast_snapshots(...) ON CONFLICT(prediction_id) DO NOTHING RETURNING forecast_snapshot_id
  4. 若 rowCount=0（已存在）：SELECT 已有记录，返回 {status:'DEDUPED', record}
  5. 若 rowCount=1：继续写入 forecast_snapshot_sources + forecast_quality_events，返回 {status:'INSERTED', record}

回填流程：
  1. 事务内 INSERT INTO forecast_outcome_events(...) ON CONFLICT(prediction_id, evaluation_version) DO NOTHING RETURNING ...
  2. 若 rowCount=0：SELECT 已有记录，返回 {status:'DEDUPED', record}（GMKG §10.6红线的具体落地）
  3. 若 rowCount=1：返回 {status:'INSERTED', record}
```

**红线**：重启、重试、双实例竞争（同一 `referenceBarRef.closeTime` 被两个进程同时尝试生成）依赖 `UNIQUE(prediction_id)` 约束 + `ON CONFLICT DO NOTHING` 的数据库层原子性保证唯一胜出者，**不依赖**应用层"先查询是否存在再插入"这种非原子的检查后写入模式（那样存在竞态窗口）。

### 7.5 服务器时间前置门禁（CEO 裁决五.8，复用 `V1_4_FORECAST_DATA_SPEC.md` §3.0）

生成任何 `ForecastSnapshot` 之前，**必须**先执行 §3.0 已冻结的服务器时间校验（V1.4A `measureServerTime()` 已有实现，直接复用，不重新实现）；若服务器时间不可用或偏差超限，**fail closed**：不创建 `forecast_snapshots` 行，`forecast_generation_runs` 记录 `status='BLOCKED'`/`error_code='SERVER_TIME_UNAVAILABLE'`，不得猜测 `referenceBar`，不得沿用上一次成功生成时的引用伪装为本次时间戳（同 §3.0 原文红线）。

### 7.6 生成节奏上限（CEO 裁决五.5/五.6，复用 `V1_4_HISTORICAL_VALIDATION_SPEC.md` §1.1）

24H 预测每 4 小时最多生成一次（每根已收盘 4 小时 K 线收盘时触发一次）；72H 预测每日最多生成一次；这是**上限**，`ForecastGenerator` 的调度间隔本身可以更密（如每 15 分钟检查一次"是否到了该生成的时间点"），但**生成动作本身**受节奏上限约束，不得为凑样本量而提高频率（§1.1 原文红线，数据库层通过 §6.1 `UNIQUE(prediction_id)` 天然保证同一 `referenceBarRef.closeTime` 不会被重复计为新样本，但仍需应用层在**选择** `referenceBarRef` 时遵守"每 4 小时/每日"这一节奏，而不是每个已收盘 15m bar 都尝试生成一次 24H/72H 预测）。

---

## 8. PO_ 状态输入特征白名单

### 8.1 状态清单（【已冻结，不得扩展或重定义】，`V1_4_FORECAST_DATA_SPEC.md` §4.2 唯一权威）

`PO_RANGE_LOW_STRUCTURE`／`PO_BREAKOUT_UP_STRUCTURE`／`PO_TREND_UP_STRUCTURE`／`PO_STALL_HIGH_STRUCTURE`／`PO_BREAKDOWN_STRUCTURE`／`PO_TREND_DOWN_STRUCTURE`／`PO_SHARP_DROP_STRUCTURE`／`PO_RANGE_RECOVERY_STRUCTURE`／`PO_UNKNOWN`——9 个代理状态，业务定义、必要条件、加分条件、否决条件、状态保持/退出条件、切换滞后、最短持续 bar 数、冲突处理、阈值语义（相对阈值为主，`PO_SHARP_DROP_STRUCTURE` 用绝对阈值）**全部继承** `V1_4_FORECAST_DATA_SPEC.md` §4.2 原文，V1.4C **不改变任何一条业务规则**。

### 8.2 输入特征来源变更（【V1.4C 新增冻结】，见 §17.9 差异记录）

`V1_4_FORECAST_DATA_SPEC.md` §4.1/§4.2 原文使用的输入字段（`e4.*`/`e1.*`，`v1-core.js` `analyzeKlines()`/`buildSRZones()`/`btcAlignment()`/`falseBreakoutTier` 的浏览器端输出）在服务器端**不存在**——V1.4B 独立计算了一套 54 项具名特征（`server/src/features/feature-version.js` `FEATURE_NAMES`），字段名称、计算实现均与 `v1-core.js` 不同源。V1.4C **只能使用 V1.4B `feature_records.feature_values` 中已有的字段**（不得为了凑齐浏览器端字段而新增采集或新增计算——那会违反"同一份数据不得重复实现"的原则，也超出本轮范围），按下表建立映射：

| 浏览器 `e4.*`/`e1.*`（`V1_4_FORECAST_DATA_SPEC.md`原文引用） | V1.4B 对应字段（本文档新增映射） | 映射状态 |
|---|---|---|
| `e4.price` | 本文档 §10 定位到的 `referenceBar.close`（来自 market_bars，非 feature_records） | 直接可用 |
| `e4.ema5/10/20` | `closeToEma5/10/20`（比值形式，非绝对EMA值，但足以支持相对阈值判定） | 可用，语义等价（相对阈值判定不需要绝对EMA值） |
| `e4.atr14` | `atr14` | 字段名直接一致，可用 |
| `e4.trend`（`'up'\|'down'\|'flat'`） | `trend4h`（V1.4B 明确按 15m/1h/4h 三周期分别输出 trend，`trend4h` 即对应字段） | 可用 |
| `e1`（1小时交叉确认） | `trend1h` | 可用 |
| `e4.volumeRatio` | `volumeRatio20`（20 根 bar 滚动窗口，与浏览器端窗口定义是否完全一致需在 Codex 实施层核实） | 可用，窗口口径需核实 |
| `e4.recentHigh20/recentLow20` | `swingHigh`/`swingLow` | 可用，概念等价（均为近窗口高低点），精确窗口根数需 Codex 层核实一致性 |
| `e4.isBreakout/isBreakdown` | `breakoutState`（`'BREAKOUT_UP'\|'BREAKOUT_DOWN'\|'INSIDE'`） | 可用，布尔拆分为三态枚举，需在 Codex 层写清 `isBreakout = (breakoutState==='BREAKOUT_UP')` 这类映射 |
| `e4.breakoutBarsCount/breakdownBarsCount`（突破后持续了几根bar，用于§4.2状态保持/退出判定） | 见 §8.3 映射一（P1-2 已关闭） | 【V1.4C新增冻结，见§8.3】 |
| `srZones.supportZones[0]/resistanceZones[0]`（含`.lower`/`.upper`区间宽度） | 见 §8.3 映射二（P1-2 已关闭） | 【V1.4C新增冻结，见§8.3】 |
| `e4.hasLongUpperWick/hasLongLowerWick`（布尔） | `upperWickRatio`/`lowerWickRatio`（连续比值） | 可用，需 Codex 层定义二值化阈值 |
| `falseBreakoutTier`（三档：`'warning'`/`'confirmation_failed'`等） | 见 §8.3 映射三（P1-2 已关闭） | 【V1.4C新增冻结，见§8.3】 |
| `btcAlignment(direction, b4)`（`'support'\|'oppose'\|...`） | 见 §8.3 映射四（P1-2 已关闭） | 【V1.4C新增冻结，见§8.3】 |
| `decision.dataHealth` | V1.4B `feature_records.quality_state`（`HEALTHY`/`WARNING`/`DEGRADED`/`BLOCKED`）+ `completeness` | 可用，概念等价 |

**红线**：§8.3 冻结的 4 项映射全部**只使用 V1.4B/V1.4A 已真实具备的数据**（54 项特征、`market_bars` 原始 K 线历史），**不新增任何外部数据采集**；4 项映射逐一在 §8.3 给出确定性公式或明确的数据不足处理规则，**不再留待 Codex 实施层裁决**。

### 8.3 四项特征映射的确定性冻结（P1-2，已关闭，唯一权威口径）

**映射一：`breakoutBarsCount`/`breakdownBarsCount`（正式、可回放的连续已收盘 bar 计数特征）**

`feature_records` 从不持久化跨快照的计数状态（`breakoutState` 只是单次快照的瞬时判定），且该字段无论 `targetInterval` 取何值都恒以 `eth15`（15m）窗口计算（同 §4.1 已说明的 `atr14` 同源限制），不存在 4H 专属的 `breakoutState` 历史。V1.4C **独立实现**一个正式的、可回放的计数特征，不依赖 `feature_records`：

```
computeConsecutiveBreakoutBars(instrument, asOfTime, direction):
  # direction ∈ {'up','down'}，对应breakoutBarsCount/breakdownBarsCount
  bars = 按§10相同as-of正确查询，取market_type='spot', interval_name='4h'，
         close_time<=asOfTime的最近N根已收盘4H K线（N见下方数据不足判定）
  若 bars.length < 21（20根用于滚动高低点基准 + 至少1根用于判定，与V1.4B swingHigh/swingLow的20根窗口口径一致）：
    return { count: null, state: 'INSUFFICIENT_DATA' }  # 不得猜测

  对每根bar（从早到晚）逐根判定：
    priorHigh20 = 该bar之前20根bar的最高价
    priorLow20  = 该bar之前20根bar的最低价
    barState = direction==='up'
      ? (bar.close > priorHigh20 ? 'BREAKOUT' : 'NOT_BREAKOUT')
      : (bar.close < priorLow20  ? 'BREAKOUT' : 'NOT_BREAKOUT')
      # 与V1.4B breakoutState的判定概念一致（价格相对前置窗口高低点的突破关系），
      # 只是逐根bar历史重算，而非读取任一次feature_records快照

  count = 从最新一根bar开始向前数，连续为'BREAKOUT'的根数（遇到第一根'NOT_BREAKOUT'即停止）
  return { count, state: count > 0 ? 'BREAKOUT_ACTIVE' : 'NOT_BREAKOUT' }
```

**红线**：数据不足（历史深度不够 21 根 4H K 线）时返回 `state:'INSUFFICIENT_DATA'`，对应 PO_ 状态判定层直接进入 `operatingMode='INSUFFICIENT_DATA'`（同 §4.2 原有的"数据不足处理"规则），**不得**用 `count:0` 或其他猜测值顶替。

**映射二：`srZones.lower`/`upper`（区域边界的服务器计算来源和公式）**

`swingHigh`/`swingLow`（V1.4B 已有字段）**只能作为单一技术失效线（点值）**使用，**不得**被视为、也不构造成一个具备 `.lower`/`.upper` 宽度的"区域"——这是本项裁决的核心红线，直接对应 CEO 裁决原文。凡 §4.2 原文中依赖"价格是否落入支撑/压力**区间**"的判定（如 `PO_RANGE_LOW_STRUCTURE` 必要条件），V1.4C **改用** V1.4B 已有的 ATR 归一化距离字段表达"贴近程度"，不构造区间宽度：

```
isNearSupport(distanceToSupportAtr, toleranceAtrMultiple = 0.3):
  return Number.isFinite(distanceToSupportAtr) && distanceToSupportAtr <= toleranceAtrMultiple

isNearResistance(distanceToResistanceAtr, toleranceAtrMultiple = 0.3):
  return Number.isFinite(distanceToResistanceAtr) && distanceToResistanceAtr <= toleranceAtrMultiple
```

`toleranceAtrMultiple = 0.3` 直接复用 `V1_4_FORECAST_DATA_SPEC.md` §4.2 原文已经在多条 PO_ 规则中使用的同一常量（原文用作"区间边界外的额外容差"，本裁决将其重新用作"到失效线的 ATR 归一化距离容差阈值"，数值延续、语义收窄为单一距离判据，不再依赖任何区间宽度）。`swingLow`/`swingHigh` 本身继续用作 §4.2 中"跌破/突破失效线"类退出条件的点值比较（如"跌破 `swingLow`"直接比较 `close < swingLow`），不参与"贴近"类判定。

**映射三：`falseBreakoutRisk` 只能作为当根拒绝证据**

`falseBreakoutRisk`（`'UPPER_REJECTION'|'LOWER_REJECTION'|'NONE'`）是**单根 K 线**的瞬时判定，V1.4B 未实现跨 bar 的确认逻辑，**不得**映射为浏览器端 `falseBreakoutTier` 的 `'confirmation_failed'`（该值语义上要求多根 bar 的持续确认）。V1.4C 冻结映射：

```
§4.2原文"falseBreakoutTier ∈ {'warning','confirmation_failed'}"作为否决条件的位置，
V1.4C改为：falseBreakoutRisk !== 'NONE'（即UPPER_REJECTION或LOWER_REJECTION）
```

这是**真实但更弱**的否决信号（只反映当根拒绝证据，不反映跨 bar 确认），`evidenceText`/`stateEvidence` 必须明确标注"基于当根拒绝信号，未实现跨 bar 确认"，**不得**使用暗示多根确认的措辞。

**映射四：`btcAlignment(direction, b4)` 显式三态计算**

```
btcAlignmentServer(candidateDirection, btcTrendState, ethBtcRollingCorrelation, correlationFloor = 0.3):
  # candidateDirection ∈ {'up','down'}
  若 btcTrendState 缺失 或 ethBtcRollingCorrelation 缺失或非有限数：
    return 'UNKNOWN'
  若 |ethBtcRollingCorrelation| < correlationFloor（相关性不足以支撑联动判断）：
    return 'UNKNOWN'
  若 btcTrendState === 'flat'（BTC自身无明确趋势）：
    return 'UNKNOWN'
  若 candidateDirection === 'up':
    return btcTrendState === 'up' ? 'SUPPORT' : 'OPPOSE'
  若 candidateDirection === 'down':
    return btcTrendState === 'down' ? 'SUPPORT' : 'OPPOSE'
```

`correlationFloor = 0.3` 是本裁决**新冻结**的常量（既有六份 V1.4 文档与 GMKG 总架构均未定义 ETH-BTC 相关性阈值，此数值不是从既有文档继承而来，是本轮为关闭 P1-2 新增的判定阈值，版本号 `btcAlignmentFormulaVersion = 'v1.4c-btc-alignment-1'`，未来调整须递增此版本号）。**红线**：`btcTrendState` 缺失、`ethBtcRollingCorrelation` 缺失/非有限数、相关性不足、或 `btcTrendState='flat'` 时**必须**返回 `'UNKNOWN'`，**不得**默认返回 `'SUPPORT'`（对应 CEO 裁决原文"不得默认ALIGNED"，`SUPPORT` 是本裁决体系里对应原 `ALIGNED`/`support` 语义的值）。原 §4.2 中 `btcAlignment(...)==='support'` 的加分条件判断，V1.4C 改为 `btcAlignmentServer(...)==='SUPPORT'`；`'UNKNOWN'` 与 `'OPPOSE'` 在加分条件语境下效果相同（均不触发加分，因为加分条件本身是"有支持证据才加分"，不确定和相反证据同样不构成支持）。

### 8.4 四项裁决对 9 种 PO_ 状态进入/保持/退出/否决条件的逐项影响

| PO_ 状态 | 受影响裁决 | 具体影响 |
|---|---|---|
| `PO_RANGE_LOW_STRUCTURE` | 映射二（srZones） | 必要条件"price 落入支撑区间"改为 `isNearSupport(distanceToSupportAtr)`；状态退出"突破 `resistanceZones[0].upper+0.3ATR`"改为 `close > swingHigh` 且不再叠加区间宽度；"跌破 `supportZones[0].lower-0.5ATR`"改为 `close < swingLow`（失效线点值比较，不再有区间宽度可加减容差，容差已内化进 `isNearSupport` 的 `toleranceAtrMultiple`） |
| `PO_BREAKOUT_UP_STRUCTURE` | 映射一（bar计数）、映射三（falseBreakoutRisk）、映射四（btcAlignment） | 必要条件 `breakoutBarsCount∈[1,2]` 改为消费 `computeConsecutiveBreakoutBars(...,'up')` 的 `count`；数据不足时整个状态判定让位于 `operatingMode='INSUFFICIENT_DATA'`；否决条件改为 `falseBreakoutRisk!=='NONE'`（弱化为当根信号）；加分条件改为 `btcAlignmentServer('up',...)==='SUPPORT'` |
| `PO_TREND_UP_STRUCTURE` | 映射一、映射三 | 必要条件 `breakoutBarsCount>2` 改为消费映射一的 `count>2`；否决条件 `falseBreakoutRisk!=='NONE'`（原文仅 `'confirmation_failed'` 触发否决，现扩大为任何当根拒绝信号触发，判定更保守，符合"数据不足/信号更弱时应更保守"的一般原则） |
| `PO_STALL_HIGH_STRUCTURE` | 映射二 | 状态退出"跌破 `supportZones[0].lower`"改为 `close < swingLow` |
| `PO_BREAKDOWN_STRUCTURE` | 映射一、映射三、映射四 | 与 `PO_BREAKOUT_UP_STRUCTURE` 对称：`count`（down方向）、`falseBreakoutRisk!=='NONE'`、`btcAlignmentServer('down',...)==='SUPPORT'` |
| `PO_TREND_DOWN_STRUCTURE` | 映射一、映射三 | 与 `PO_TREND_UP_STRUCTURE` 对称 |
| `PO_SHARP_DROP_STRUCTURE` | 无直接影响 | 必要/加分/否决条件原文只依赖 `atr14`（15m，§4.1已说明的既有字段）与 `volumeRatio20`，不引用本节 4 项映射中的任何一项 |
| `PO_RANGE_RECOVERY_STRUCTURE` | 无直接影响 | 必要/加分/否决条件原文只依赖 `atr14` 相对急跌当根的降幅与价格自身相对区间百分比，不直接引用本节 4 项映射；冲突处理"同 `PO_RANGE_LOW_STRUCTURE` 条目"因此间接继承映射二的影响 |
| `PO_UNKNOWN` | 间接受全部 4 项影响 | 触发条件是"以上 8 项必要条件均不满足"，8 项中任一项的判定手段变化（映射一/二/三/四）都会改变"均不满足"这一汇总结论是否成立，但 `PO_UNKNOWN` 自身不直接引用任何一项映射 |

---

## 9. `auxiliaryEvidence` 规则

**CEO 裁决二.2/二.5 的具体落地**：

1. `auxiliaryEvidence`（§4 字段表新增字段）是一个**独立于** `stateEvidence`/`opposingEvidence` 的字段，存放 V1.4B 已真实具备、但按 §8.1 红线不得影响 PO_ 状态判定本身的数据：`fundingRate`/`fundingRateZScore`/`openInterest`/`openInterestChange`/`openInterestChangeRatio`/`longShortRatio`/`longShortRatioZScore`/`takerBuySellRatio`/`derivativesAvailability`（V1.4B 54 项特征中的"衍生品"9 项与"BTC 联动"部分字段）。
2. `auxiliaryEvidence` **只读展示，不参与** §8.2 任何一条 PO_ 状态必要/加分/否决条件的判定表达式——PO_ 状态判定函数的输入参数**不得**包含 `auxiliaryEvidence` 中的任何字段。
3. **冲突处理（CEO 裁决二.5）**：若 `auxiliaryEvidence` 中的数值与已判定的 PO_ 状态存在方向性矛盾（如 PO_ 状态判定为 `PO_TREND_UP_STRUCTURE`，但 `fundingRateZScore` 显示极端负值、`longShortRatio` 显示空头拥挤），**只在 `opposingEvidence` 或新增的 `auxiliaryConflictNotes: string[]` 字段中记录该冲突事实本身**，**不得**据此改变 `proxyStateAtGeneration` 的取值、不得据此提前触发降级或状态切换——PO_ 状态的唯一输入是 §8.2 白名单，`auxiliaryEvidence` 冲突是"记录", 不是"判定输入"。
4. `evidenceText` 措辞红线（延续 `V1_4_FORECAST_DATA_SPEC.md` §4.5）：`stateEvidence`（PO_ 状态判定证据）继续禁止出现"资金费率""OI"等暗示已采集衍生品数据的措辞；`auxiliaryEvidence` 本身作为独立字段允许直接使用这些真实字段名（因为它就是真实衍生品数据，不是代理），两个字段在展示层/日志层必须清晰区分标签，不得混合拼接成一段文字。

---

## 10. 96/288 路径遍历伪代码

```
function locateReferenceBarAndPath(instrument, horizon, asOfTime):
  expectedBarCount = (horizon === '24h') ? 96 : 288
  timeframeMs = 900000  // 15分钟，GMKG §10.1 BarRef.timeframeMs 固定值

  # 第一步：定位 referenceBar（sequenceIndex=0）—— 复用V1.4A as-of正确查询，
  # 不得使用 Date.now() 未做服务器偏移校正
  referenceBar = query market_bars
    WHERE instrument=instrument AND market_type='spot' AND interval_name='15m'
      AND close_time <= asOfTime AND available_at <= asOfTime AND fetched_at <= asOfTime
    ORDER BY open_time DESC, revision_number DESC
    LIMIT 1
  if referenceBar is null:
    return { endpointDataComplete: false, referenceBarRef: null, exclusionReasons: ['reference_bar_missing'] }

  referenceBarRef = buildBarRef(referenceBar, sequenceIndex=0)

  # 第二步：沿真实K线序列逐根前进，不use毫秒加法直接跳到 targetStartTime + N×15分钟
  observedBars = []
  missingBarRefs = []
  cursor = referenceBar
  for i in 1..expectedBarCount:
    expectedOpenTime = cursor.closeTime + 1   # Binance边界口径需在Codex层用真实API响应核实（GMKG §10.2红线3）
    nextBar = query market_bars
      WHERE instrument=instrument AND market_type='spot' AND interval_name='15m'
        AND open_time = expectedOpenTime
        AND close_time <= asOfTime  # 只承认已收盘K线
      LIMIT 1
    if nextBar exists AND nextBar.closed:
      observedBars.append(buildBarRef(nextBar, sequenceIndex=i))
      cursor = nextBar
    else:
      missingBarRefs.append(buildPlaceholderBarRef(expectedOpenTime, sequenceIndex=i))
      cursor = { closeTime: expectedOpenTime + timeframeMs - 1 }  # 假设式前进，仅用于继续遍历定位后续bar，不代表该bar真实存在

  # 第三步：定位targetBar（路径最后一根，sequenceIndex=expectedBarCount）
  targetBar = observedBars.find(b => b.sequenceIndex === expectedBarCount)
  targetBarRef = targetBar ?? null   # 若该位置在missingBarRefs中，targetBarRef为null，endpointDataComplete相应为false

  endpointDataComplete = (referenceBarRef != null) AND (targetBarRef != null)
  pathDataComplete = evaluateNineInvariants(observedBars, missingBarRefs, expectedBarCount, targetBarRef)
    # 九项不变量见 GMKG §10.5.1，逐项对照：
    #   observedBarCount===expectedBarCount, missingBarRefs.length===0,
    #   sequenceIndex覆盖1..N无缺口无重复, barKey无重复, 时间严格递增,
    #   targetBarRef.sequenceIndex===expectedBarCount, 全部已收盘, 无estimated/synthetic bar

  return {
    referenceBarRef, targetBarRef, observedBars, missingBarRefs,
    endpointDataComplete, pathDataComplete,
    pathEligibleForStatistics: pathDataComplete AND endpointDataComplete,
    directionEligibleForStatistics: endpointDataComplete
  }
```

**红线（对应 CEO 裁决三.6/三.7）**：`expectedOpenTime = cursor.closeTime + 1` 这一步**仅用于构造下一次查询的 WHERE 条件**，不代表"假设该 bar 一定存在"——若查询未命中，立即记入 `missingBarRefs`，遍历继续（用占位时间戳前进），不得因为一根 bar 缺失就提前中止整个遍历（否则后续可能存在的 bar 也会被误判为缺失）。

---

## 11. endpoint/path/direction 统计资格真值表

| `endpointDataComplete` | `pathDataComplete` | `directionEligibleForStatistics` | `pathEligibleForStatistics` | `actualReturn`/`actualDirection`/`directionCorrect` | `actualHigh`/`actualLow`/`mfe`/`mae`/RANGE专属四项/`invalidationTriggered` | `endpointInBaselineZone`等区间覆盖四项 |
|---|---|---|---|---|---|---|
| true | true | true | true | 计算 | 计算 | 计算（终点类用endpoint条件，路径类用path条件，见下方拆分） |
| true | false | true | false | 计算 | **全部 null** | `endpointInBaselineZone`/`endpointInAnyScenarioZone`计算（仅需endpoint）；`realizedRangeInsideExpectedEnvelope`/`expectedEnvelopeTouched`为**null**（需path） |
| false | true | false | false | **全部 null** | **全部 null**（§10.1红线：`referencePrice`来自referenceBar，`endpointDataComplete=false`时referencePrice基准本身不可信，即使path完整也不得计算路径指标） | 全部 null |
| false | false | false | false | 全部 null | 全部 null | 全部 null |

**红线复述（GMKG §10.5.0 第4点）**：`pathDataComplete=true` 单独成立**不足以**计算 MFE/MAE 等路径指标——`pathEligibleForStatistics = pathDataComplete && endpointDataComplete` 两者同时成立才可计算，因为路径指标的计算基准 `referencePrice` 来自 `referenceBarRef`，属于 `endpointDataComplete` 检查范围，不属于 `pathDataComplete` 检查范围（§10.5.0 边界澄清），本表第 3 行precisely体现这一容易出错的边界情形。

---

## 12. 浏览器与服务器数据来源隔离规则

1. **服务器端 `forecast_snapshots`/`forecast_outcome_events` 是 V1.4C 完成后的唯一正式统计源**（CEO 裁决六.1）——任何未来的样本量统计、walk-forward 验证、误差归因，只从这两张表读取，不混入浏览器端 IndexedDB 中的历史记录。
2. **浏览器端既有预测记录暂时保留，本轮不删除、不重写**（CEO 裁决六.2）——`v1_4-gmkg-forecast-core.js`/`outcome-core.js`/`validation-core.js` 及其 IndexedDB 存储继续按现状运行，不受 V1.4C 影响。
3. **浏览器旧记录定义为 `LEGACY_BROWSER` 来源分类**（CEO 裁决六.3）——本文档 §5 新增的 `sourceOrigin` 字段是服务器端表内部标记（恒为 `'SERVER'`）；浏览器端记录本身不需要改造已有存储结构去新增这个字段（那属于修改浏览器代码，超出本轮范围），而是在**未来任何跨源统计脚本/报表**中，浏览器数据源天然被归类为 `LEGACY_BROWSER`（因为它存在于完全不同的存储介质——IndexedDB，与 PostgreSQL 表物理隔离，不存在"混入"的技术可能性，隔离是结构性的，不依赖额外标记字段）。
4. **`LEGACY_BROWSER` 记录不得混入服务器正式统计分母**（CEO 裁决六.4）——因为两者物理存储介质完全独立（IndexedDB vs PostgreSQL），本条红线在 V1.4C 架构下是**自动满足**的结构性保证，不需要额外的运行时校验代码；此条款的意义在于禁止**未来**任何"导入浏览器历史数据到服务器表"的工作，除非该工作本身产出一次独立的数据治理规范并明确讨论这一红线如何在合并后继续保持。
5. **`predictionId` 命名空间隔离**（CEO 裁决六.5，见 §4/§13.1）——服务器端固定使用 `GMKG-SRV-` 前缀，浏览器端沿用既有 `GMKG-${instrument}-...`（无 `SRV` 段）格式，两者 `predictionId` 字符串永不相同，即使 `referenceBarRef.closeTime` 恰好相同（因为两边的 `algorithmVersion` 也必然不同，见 §13.1，双重防碰撞）。
6. **浏览器改为服务器只读展示是后续独立阶段，不纳入 V1.4C**（CEO 裁决六.6）——本文档不规划、不预留任何"浏览器 UI 读取服务器 API"的具体接口设计，那是未来独立的规范工作。

---

## 13. 版本字段与 `contentHash` 计算口径

### 13.1 `predictionId` 生成公式

```
predictionId = `GMKG-SRV-${instrument}-${horizon}-${referenceBarRef.closeTime}-${algorithmVersion}`
```

【V1.4C新增】相对 `V1_4_FORECAST_DATA_SPEC.md` 原公式 `` `GMKG-${instrument}-${horizon}-${referenceBarRef.closeTime}-${algorithmVersion}` `` 新增 `-SRV-` 段。`algorithmVersion` 本身必须是 V1.4C 独立命名空间内的字符串（如 `'v1.4c-server-po-rule-1'`），不得与浏览器端当前使用的 `algorithmVersion`/`poRuleVersion`（`'v1.4-po-rule-1'`）取值相同——双重防碰撞（前缀 + 版本字符串均不同），即使浏览器端未来修改其格式也不影响服务器端已有约束的有效性。

### 13.2 `contentHash` 计算范围

复用 V1.4B `canonicalJsonHash()`（`server/src/domain/hash.js`，已验证的确定性 JSON 序列化+SHA-256，正确处理数组/对象/null/布尔/数字/字符串），计算对象为：

```
contentHash = canonicalJsonHash({
  predictionId, featureValuesUsed, algorithmVersion, weightVersion,
  datasetVersion, featureEngineVersion, scenarioWeights
})
```

与 GMKG §10.1 "对 featureValuesUsed+算法/权重/数据集版本三元组的内容哈希"原文一致，新增 `predictionId`（防止两条不同预测因巧合拥有完全相同的特征值和版本号而产生相同哈希，误判为同一记录）与 `scenarioWeights`（情景权重本身是生成结果的一部分，应纳入内容完整性校验范围）。

### 13.3 版本字段清单与递增纪律

延续 `V1_2_FORECAST_SPEC.md` §12.2 已确立的版本号红线（算法版本与权重版本分离递增，逻辑不变只调阈值数值时只需递增对应的细分版本号）：`algorithmVersion`（PO_ 状态判定逻辑本身）、`weightVersion`（`scenarioWeights` 计算规则）、`datasetVersion`（复用 V1.4B `SOURCE_DATASET_VERSION`）、`featureEngineVersion`（复用 V1.4B `FEATURE_ALGORITHM_VERSION`，独立于 `algorithmVersion`）、`evaluationVersion`（`ForecastOutcomeEvent` 评估逻辑本身，独立于 `algorithmVersion`）——五个版本号语义互不重叠，各自独立递增。

---

## 14. P0/P1/P2 验收矩阵

| 级别 | 测试项 |
|---|---|
| **P0** | `dataCutoffTime` 前的未来数据不得进入 `ForecastSnapshot`；`referenceBar`/`targetBar` 必须是已收盘 K 线；`ForecastOutcomeEvent` 不得覆盖 `ForecastSnapshot` 任何字段（数据库触发器+外键 `ON DELETE RESTRICT` 双重验证）；`scenarioWeights` 三项之和恒为 100 且无 NaN/Infinity/负值；`pathDataComplete` 九项不变量全部验证（含 §11 真值表 4 种组合场景）；`targetStateAtGeneration`/`fusionStateAtGeneration` 恒为 `'UNKNOWN'`（数据库 CHECK + 应用层双重验证）；`proxyStateAtGeneration` 判定不受 `auxiliaryEvidence` 影响（§9.3 冲突不改变状态的专项测试）；`algorithmVersion` 同一版本内 `directionThreshold`/`evaluationVersion` 不得动态调整；服务器时间不可用时 fail closed；幂等生成/回填（`UNIQUE(prediction_id)`/`UNIQUE(prediction_id,evaluation_version)` 数据库约束+并发双实例竞争测试）；同一事务原子写入（snapshot+sources+quality_event），失败整体回滚，不产生孤儿记录；`forecast_snapshots` 数据库层拒绝 UPDATE/DELETE（触发器验证）；旧 fencing token 被数据库拒绝，拒绝后无残留写入。**（P1-1/P1-2/P1-3 关闭新增）**：24H/72H 两组固定输入（已知 4H ATR14+referencePrice）产出的 `rawThreshold`/`directionThreshold` 与 §4.1 公式手算结果逐位一致；`directionThreshold` 上下限 clamp（构造 `rawThreshold` 分别小于 floor、大于 ceiling、落在区间内三种场景，验证 clamp 结果）；`actualReturn` 恰好等于 `+directionThreshold`/`-directionThreshold` 边界值时分别判定为 `UP`/`DOWN`（不落入 `RANGE`，`>=`/`<=` 边界包含性专项测试）；`forecast_snapshots` 落库后 `rawThreshold`/`thresholdFloor`/`thresholdCeiling`/`thresholdFormulaVersion`/`atr14FourHourAtGeneration` 五项审计字段与生成时计算值完全一致且后续不随 `market_bars`/`feature_records` revision 变化（真实 PostgreSQL 验证）；4H ATR14 历史不足 14 根已收盘 4H K 线时 `fail closed`（`error_code='ATR14_4H_INSUFFICIENT'`），不产出正式快照；§8.3 四项映射逐项真实 PostgreSQL 测试：映射一历史 4H bar 不足 21 根时返回 `INSUFFICIENT_DATA` 而非猜测计数，`PO_TREND_UP_STRUCTURE`/`PO_TREND_DOWN_STRUCTURE` 在 `computeConsecutiveBreakoutBars` 计数未超过阈值时不得被误判为已进入延续状态；映射三 `falseBreakoutRisk!=='NONE'` 触发否决但**不得**在 `evidenceText` 中出现暗示跨 bar 确认的措辞（`'confirmation_failed'` 类文案）；映射四 `btcTrendState`/`ethBtcRollingCorrelation` 缺失、相关性低于 `correlationFloor`、或 `btcTrendState='flat'` 三种场景下 `btcAlignmentServer` 必须返回 `'UNKNOWN'`，不得默认 `'SUPPORT'`；`ForecastGenerator`（`'forecast-generator'`）与 `OutcomeEvaluator`（`'forecast-outcome-evaluator'`）两个独立 lease 并发运行且互不干扰（一方续约失败不影响另一方继续正常写入的专项测试）；过期 fencing token 提交（无论来自哪个调度器）在数据库事务内被拒绝，且不留下 `forecast_snapshots`/`forecast_snapshot_sources`/`forecast_quality_events`/`forecast_outcome_events` 任一表的残行（真实并发冲突场景验证）。 |
| **P1** | `predictionId` 命名空间与浏览器端不冲突（`-SRV-`前缀+独立`algorithmVersion`专项测试）；24H 每 4 小时/72H 每日生成节奏上限；walk-forward 三区间严格按时间排列不重叠不打乱；区间调度算法按 `targetEndTime` 排序；`missingBarRefs` 记录具体 bar 而非泛化原因；`endpointDataComplete`/`pathDataComplete` 独立判定（§10.5.0 边界，专项测试referenceBar缺失但path完整的场景）；MFE/MAE 的 UP/DOWN/RANGE 三种口径分别验证；区间覆盖四项计算正确性；`featureValuesUsed`/`contentHash`与 V1.4B `feature_records`一致性（复制值副本不随源数据 revision 变化的专项测试，即 §7.3 红线的直接验证）；PO_ 状态 9 项映射到 V1.4B 特征后的判定结果与原浏览器端判定逻辑的业务意图一致性抽样比对。**（P1-2/P1-3 关闭新增）**：§8.3 映射二 `isNearSupport`/`isNearResistance` 与直接的价格-区间比较（若历史上有可对照样本）业务意图一致性抽样；`swingHigh`/`swingLow` 只作点值失效线使用、代码中不出现任何 `.lower`/`.upper` 派生自这两个字段的场景（静态扫描）；CI 强制门禁组合命令（`test:postgres`）必须包含 V1.4C 新增的真实 PostgreSQL 测试文件（比照 V1.4B `test:postgres:revision` 的接线修复模式，新测试文件必须与 `package.json` 改动、`review-regression.test.js` 结构性断言在同一 commit 内一起接入，不得分两轮，见 §16 第 9 步）。 |
| **P2** | 生成/回填耗时性能；只读 API 新增端点（`/api/v1/forecast/*`）响应格式；`auxiliaryEvidence`/`stateEvidence` 展示层措辞是否清晰区分；日志可读性；`fusionStateAtGeneration`等占位字段的注释/文档标注是否清晰（防止被误当作真实融合结果）；`forecast_generation_runs`/`forecast_evaluation_runs` 两张独立审计表的可读性（能否清晰区分两个调度器各自的运行历史，不需要额外过滤逻辑）。 |

---

## 15. 建议新增/修改文件清单

（设计阶段清单，本轮不创建）

```
新增文件：
server/src/forecast/forecast-contract.js      — ForecastSnapshot/ForecastOutcomeEvent字段契约与校验
server/src/forecast/threshold-formula.js      — directionThreshold/rawThreshold/clamp计算（§4.1，P1-1）
server/src/forecast/po-feature-mapping.js     — §8.3四项映射：连续bar计数、支撑压力距离判定、falseBreakoutRisk、btcAlignmentServer（P1-2）
server/src/forecast/po-state-engine.js        — PO_*状态判定（§8/§9），只读消费feature_records+po-feature-mapping.js
server/src/forecast/bar-path-locator.js       — referenceBar/targetBar/路径遍历、4H ATR14历史计算（§10/§4.1）
server/src/forecast/generator-service.js      — ForecastGenerator独立调度器，lease='forecast-generator'（§7.1/§7.2）
server/src/forecast/forecast-version.js       — algorithmVersion/weightVersion/evaluationVersion/thresholdFormulaVersion/btcAlignmentFormulaVersion冻结常量
server/src/outcome/outcome-engine.js          — ForecastOutcomeEvent幂等回填（§10/§11）
server/src/outcome/evaluator-service.js       — OutcomeEvaluator独立调度器，lease='forecast-outcome-evaluator'（§7.1/§7.2，P1-3）
server/src/validation/walk-forward.js         — 区间调度算法、训练/验证/测试切分
server/migrations/004_v1_4c_forecast_engine.up.sql/.down.sql
server/tests/forecast/*.test.js               — 非网络测试（含§4.1/§8.3公式的纯函数测试）
server/tests/postgres/v1-4c-forecast.integration.test.js — 真实PostgreSQL测试
server/tests/postgres/v1-4c-outcome.integration.test.js
server/tests/postgres/v1-4c-lease-concurrency.integration.test.js — 两个独立lease并发/过期fencing token/残行检查专项（P1-3）
V1_4C_CODEX_IMPLEMENTATION_TASK.md            — 后续独立交付，文件范围/构建顺序/存储契约细化
V1_4C_ACCEPTANCE_TESTS.md                     — 后续独立交付，本文档§14矩阵的逐条测试用例展开
V1_4C_IMPLEMENTATION_REPORT.md/V1_4C_TEST_RESULTS.md — 实施完成后交付

不修改：
v1_4-gmkg-forecast-core.js / v1_4-gmkg-outcome-core.js / v1_4-gmkg-validation-core.js（浏览器端，§12红线）
server/src 现有全部25个文件（V1.4A/B已验证代码，只新增不改动）
GMKG_DRAGONFLY_ARCHITECTURE.md / 既有六份V1.4文档（只引用，不修改）
.github/workflows/v1-4a-postgres-integration.yml（本轮不改，接线属于后续Codex实施阶段任务，且须吸取V1.4B教训——新测试文件必须与package.json/结构性断言在同一commit内一起接入，不得分两轮）
package.json / 任何数据库迁移 / 任何测试代码（本轮红线）
```

---

## 16. 后续 Codex 实施的严格构建顺序

§8.2 原遗留的 4 项特征映射缺口与 §17.4 原 `directionThreshold` 口径待定，均已在 Codex 定向复审后由本次修订关闭（见 §4.1/§8.3，P1-1/P1-2 已关闭），**不再构成编码前置阻断项**。构建顺序如下：

1. `forecast-contract.js` + `threshold-formula.js` + `po-feature-mapping.js` + 迁移 SQL（结构与纯计算先行，同 V1.4B 先有 `feature-contract.js` 再有 `feature-engine.js` 的既有顺序；`threshold-formula.js`/`po-feature-mapping.js` 均为无 `storage` 参数的纯函数，可先于任何数据库代码独立单元测试，直接对照 §4.1/§8.3 冻结公式验证）。
2. `bar-path-locator.js`（§10 路径遍历 + §4.1 的 4H ATR14 历史计算 + §8.3 映射一的连续 bar 计数历史计算，三者共享同一套 as-of 正确查询模式，纯查询函数，无状态判定逻辑，可独立测试）。
3. `po-state-engine.js`（§8/§9，消费 `po-feature-mapping.js` 的输出，9 个 PO_ 状态判定逻辑本身不变，只是输入来源改为 §8.3 冻结的映射）。
4. `generator-service.js` + `forecast-version.js`（§7.1/§7.2，lease=`'forecast-generator'`，复用 V1.4A 已验证模式）。
5. `outcome-engine.js` + `evaluator-service.js`（§7.1/§7.2/§10/§11，lease=`'forecast-outcome-evaluator'`，**与第 4 步完全独立开发和测试**，不得共享调度器实例或运行时状态，P1-3 已关闭）。
6. `walk-forward.js`（独立模块，依赖仅为已生成的 `forecast_snapshots`/`forecast_outcome_events` 表存在）。
7. 独立对抗性复审（沿用本仓库已验证多轮的模式：隔离 worktree + 隔离 PostgreSQL 14 + 真实 Binance 数据 + 对抗性时间推进探针，重点复查：①§7.3 红线——`featureValuesUsed`/`atr14FourHourAtGeneration` 复制值是否真的不随 `feature_records`/`market_bars` 后续 revision 变化；②§7.2 两个独立 lease 的并发/过期 fencing token/残行场景；③§4.1 clamp 边界与 §8.3 四项映射的 `INSUFFICIENT_DATA`/`UNKNOWN` fail-closed 路径）。
8. CI 接线（V1.4C 新增真实 PostgreSQL 测试并入 `test:postgres` 组合命令，**必须**在同一 commit 内完成 `package.json` 修改 + `review-regression.test.js` 结构性断言新增，直接吸取 V1.4B 分两轮修复 CI 接线缺口的教训——本轮 P1-3 验收矩阵已明确要求 CI 组合命令必须包含 V1.4C PostgreSQL 测试，实施时不得重演同一疏漏）。
9. 合并 main 前的最终只读复审。

---

## 17. 规范差异与覆盖关系（文档一致性检查）

本节逐项记录本文档与既有 7 份文档（`GMKG_DRAGONFLY_ARCHITECTURE.md`/`V1_4_FORECAST_DATA_SPEC.md`/`V1_4_HISTORICAL_VALIDATION_SPEC.md`/`V1_4_CODEX_IMPLEMENTATION_TASK.md`/`V1_4_ACCEPTANCE_TESTS.md`/`V1_4B_IMPLEMENTATION_REPORT.md`/`V1_4B_TEST_RESULTS.md`）逐一核对后发现的差异/覆盖/留白，**不隐藏、不擅自二选一**。

### 17.1 与 `V1_4_CODEX_IMPLEMENTATION_TASK.md` §3 的一致性

**核对结论：无冲突，直接复用**。该文档 §3（CEO P1-1 裁决）已确立"计算层与存储层必须彻底分离"（纯函数不携带 `storage` 参数），本文档 §15 文件清单遵循同一分层（`po-state-engine.js`/`bar-path-locator.js`/`walk-forward.js` 为纯计算，`generator-service.js`/迁移 SQL 为存储/调度层），未发现需要覆盖的冲突点。

### 17.2 与 GMKG 总架构 §10.1 `ForecastSnapshot` 接口的差异——结构性留白，非冲突

- **旧口径**：GMKG §10.1 原始 `ForecastSnapshot` 接口只有 `targetStateAtGeneration: TargetStateId` 一个状态快照字段，**未列出**任何用于记录 `PriceOnlyStateId`（PO_ 状态）的专属字段插槽；也未列出 `featureRecordIds` 这一可追溯指针字段。
- **新冻结口径**：本文档 §4 新增 `proxyStateAtGeneration: PriceOnlyStateId` 与 `featureRecordIds: bigint[]` 两个补充字段。
- **覆盖原因**：GMKG §10.1 成文时（draft-4）主要面向 `FULL_STATE_MODE` 场景设计（`targetStateAtGeneration` 直接对应 `TargetState.primaryState`），当时 V1.4 的 `PRICE_ONLY_MODE`/`PriceOnlyStateId` 体系虽已在 §7.0a/§7.0b 定义，但 §10.1 的快照接口未同步补上 `PRICE_ONLY_MODE` 下应该把 `proxyState` 存在哪个字段这一具体问题——这是**留白**，不是两个文档相互矛盾的裁决。`featureRecordIds` 是纯服务器化产物（浏览器端无此概念，因为浏览器端没有独立的 `feature_records` 表）。
- **生效版本**：V1.4C（本文档）。
- **是否影响历史记录**：不影响。GMKG §10.1 原始字段（`targetStateAtGeneration`）保持不变、恒为 `'UNKNOWN'`；新增字段是纯增量补充，不修改、不废弃原接口的任何既有字段。未来若 GMKG 总架构本身修订以正式吸收这两个字段，应由 GMKG 文档的维护流程处理，本文档只在 V1.4C 实现层面新增，不代表修改了 GMKG 总架构文本本身。

### 17.3 `predictionId` 命名空间——新增前缀，非覆盖

- **旧口径**：`V1_4_FORECAST_DATA_SPEC.md` 原公式 `` `GMKG-${instrument}-${horizon}-${referenceBarRef.closeTime}-${algorithmVersion}` `` 未预留来源区分段，隐含假设"只有一个实现在生成这个 ID"（成文时确实只有浏览器一条实现）。
- **新冻结口径**：服务器端固定加 `-SRV-` 段（§13.1），浏览器端沿用原公式不变。
- **覆盖原因**：V1.4C 引入第二条独立实现后，原公式若不加区分，理论上存在同一 `closeTime` 下两条实现生成相同字符串的碰撞风险（即使 `algorithmVersion` 也不同从而实际不会碰撞，但显式前缀是更清晰、不依赖"记住两边版本号一定不同"这一隐性假设的防御）。
- **生效版本**：V1.4C。
- **是否影响历史记录**：不影响，浏览器端历史 `predictionId` 格式不变，仍可正常关联查询。

### 17.4 `directionThreshold` 具体数值——P1-1 已关闭，本轮补齐唯一权威公式

- **旧口径**：`V1_4_FORECAST_DATA_SPEC.md` 全文只提及 `directionThreshold` 须"在算法版本冻结的同一时刻一并选定并写入版本说明"（GMKG §10.3 原文红线的抽象要求），未给出任何具体数值或公式；上一版本文档（v1.4c-spec-draft-1）核对后同样未找到浏览器端可复用的具体数值，因而标注为【待 Codex 实施层确认】，未给出确定性公式。
- **新冻结口径**：本文档 §4.1 给出唯一权威公式——`rawThreshold = atr14FourHourAtGeneration / referencePrice × sqrt(periods)`，`directionThreshold = clamp(rawThreshold, floor, ceiling)`，24H/72H 分别冻结 `periods`/`floor`/`ceiling` 三组具体数值，`thresholdFormulaVersion='v1.4c-threshold-formula-1'`。
- **覆盖原因**：Codex 对提交 `e421f8c870b692ce2fb800d8080c1aeb899bd64f` 的 V1.4C 定向复审关闭 P1-1，要求给出立即可编码的确定性公式，不再允许"留待实施层选定"这一开放式表述——既有文档本身的开放式留白不构成冲突，但对于本文档而言，继续保留这一留白已不满足"规范先行、Codex 不自由发挥"的项目纪律，因此本轮补齐。
- **生效版本**：`thresholdFormulaVersion='v1.4c-threshold-formula-1'`（V1.4C 本轮新增，非既有文档继承）。
- **是否影响历史记录**：不适用——此前无任何服务器端实现产出过 `directionThreshold` 真实值，浏览器端记录使用浏览器自己的口径（若存在），不受本次服务器端公式冻结影响。

### 17.5 `fusionStateAtGeneration` 占位取值方式——新增裁决

- **旧口径**：GMKG §10.1 未明确说明"融合中枢未实现时，`fusionStateAtGeneration` 这个必填字段该填什么"。
- **新冻结口径**：本文档 §4/§6.1 冻结为恒定字符串 `'UNKNOWN'`，并在数据库层加 CHECK 约束强制。
- **覆盖原因**：`FusionStateId = TargetStateId | 'CONFLICTED'`（GMKG §6.3/§9），其值域本身不包含类似 `PriceOnlyStateId` 体系里的"未运行"语义值；选择复用 `TargetStateId` 值域内的 `'UNKNOWN'` 是因为该值本来就用于"无法判定"场景，语义上可以承载"融合中枢未运行，因此无融合状态"这一事实，且与 `targetStateAtGeneration` 的占位方式保持一致（两个字段都是"上游系统未运行"时的结构性占位，而非计算结果）。
- **生效版本**：V1.4C。
- **是否影响历史记录**：不适用（该字段此前无任何实现写入过真实值）。

### 17.6 `auxiliaryEvidence` 字段——纯新增，无覆盖

GMKG §10.1 与 `V1_4_FORECAST_DATA_SPEC.md` 均未定义任何"辅助证据"概念（因为浏览器端从未拥有 funding/OI/taker-flow 数据，§2.2/§4.5 原文明确禁止这些数据以任何形式出现在证据文案中）。本字段是 V1.4C 因为 V1.4B 真实具备这些数据而**新增**的能力，不覆盖、不修改任何既有字段的语义，只是新增一个此前不可能存在的字段。

### 17.7 `sourceOrigin` 字段——纯新增，无覆盖

同上，GMKG §10.1 `ForecastOutcomeEvent` 原接口未定义来源标记（因为成文时只有一条实现）。

### 17.8 `ForecastSnapshot` 不可变协议 与 `feature_records`/`market_bars` revision 协议的刻意差异——需要显式说明，防止实施时错误复用

**这是本轮核对中最重要的一处、必须显式提醒 Codex 实施层的差异**：V1.4A `market_bars` 与 V1.4B `feature_records` 都采用"同一自然键、内容变化时**追加 revision**，DEDUPED/REVISED 两态"的协议（本仓库此前经历过一次因为该协议的时间字段实现错误而触发的真实 P1 缺陷修复，见 `V1_4B_TEST_RESULTS.md` revision 时间推进测试章节）。**`forecast_snapshots` 表故意不采用这一协议**——`ForecastSnapshot` 只有 `INSERTED`/`DEDUPED` 两态，**没有 `REVISED` 态**，数据库层甚至不设 `revision_number` 列，触发器直接拒绝一切 UPDATE（比 `market_bars`/`feature_records`——它们只拒绝对**旧行**的 UPDATE，但允许 INSERT 新 revision 行——更严格）。这不是"忘记加 revision 支持"，而是 GMKG §10.1 红线（"原始预测不可被后续结果覆盖"）与 CEO 裁决四.6（"不给 ForecastSnapshot 设计可变 revision 语义"）的刻意选择：**Codex 实施层不得因为看到 V1.4A/B 的既有 revision 协议代码模式，就想当然地照搬到 `forecast_snapshots` 上**——这是本文档与既有代码模式之间唯一一处"形似神不似"的陷阱点，必须在 `V1_4C_CODEX_IMPLEMENTATION_TASK.md` 中重复强调。

### 17.9 PO_ 状态输入特征映射——P1-2 已关闭，§8.3 给出 4 项确定性冻结

- **旧口径**：`V1_4_FORECAST_DATA_SPEC.md` §4.1/§4.2 定义 PO_ 状态判定规则时，其输入特征（`e4.*`/`e1.*`/`buildSRZones()`/`btcAlignment()`/`falseBreakoutTier`）是**浏览器端 `v1-core.js` 的具体函数输出**，与 V1.4B 服务器端独立实现的 54 项具名特征在字段名、部分语义粒度上**不是同一套**；上一版本文档（v1.4c-spec-draft-1）§8.2 建立了映射表，但对 `breakoutBarsCount`/`srZones.lower/upper`/`falseBreakoutTier`/`btcAlignment` 4 项明确标注"无直接等价物"，不代为裁决，留给 Codex 实施前的独立裁决步骤。
- **新冻结口径**：本文档 §8.3 给出 4 项确定性公式/规则：①`breakoutBarsCount`/`breakdownBarsCount` 改为 V1.4C 独立实现的 `computeConsecutiveBreakoutBars()`，基于真实 4H `market_bars` 历史逐根回放计算，数据不足时返回 `INSUFFICIENT_DATA`，不猜测；②`srZones.lower/upper` 不再构造区间宽度，`swingHigh`/`swingLow` 只作单一失效线使用，"贴近"类判定改用 `distanceToSupportAtr`/`distanceToResistanceAtr` 配合复用自既有文档的 `0.3×ATR` 容差；③`falseBreakoutTier` 的否决条件改为 `falseBreakoutRisk!=='NONE'`（弱化为当根拒绝信号，不冒充跨 bar 确认）；④`btcAlignment` 改为显式三态 `btcAlignmentServer()`，新冻结 `correlationFloor=0.3` 常量，数据不足/相关性不足/趋势缺失时返回 `'UNKNOWN'`，不默认 `'SUPPORT'`。§8.4 进一步逐项列出这 4 项裁决对 9 种 PO_ 状态进入/保持/退出/否决条件的具体影响。
- **覆盖原因**：Codex 对同一提交的定向复审关闭 P1-2，要求这 4 项映射不再留待实施层裁决，而是由规范本身给出确定性公式，同时明确记录这些裁决对 9 个 PO_ 状态判定条件的逐项影响，避免 Codex 在编码阶段对"业务意图是否保持不变"产生分歧解读。
- **生效版本**：§8.3 冻结公式随本文档版本生效；`btcAlignmentFormulaVersion='v1.4c-btc-alignment-1'` 为本轮新增独立版本号。
- **是否影响历史记录**：不适用——此前无任何服务器端 PO_ 状态判定实现产出过基于这 4 项映射的真实结果。
- **未被既有文档定义、本轮新增冻结的具体数值需特别说明**：`correlationFloor=0.3`（映射四）是本轮**新引入**的数值，既有六份 V1.4 文档与 GMKG 总架构均未定义 ETH-BTC 滚动相关性的判定阈值，读者若认为该数值需要调整，应递增 `btcAlignmentFormulaVersion` 而非静默修改；映射二复用的 `0.3×ATR` 容差**不是**新数值，是 `V1_4_FORECAST_DATA_SPEC.md` §4.2 原文已经在多条 PO_ 规则中使用的既有常量，本轮只是将其用途从"区间边界外的额外容差"收窄为"到失效线的距离容差阈值"，数值延续、语义收窄，已在 §8.3 映射二中明确说明。

### 17.10 与 `V1_4_ACCEPTANCE_TESTS.md`/`V1_4B_IMPLEMENTATION_REPORT.md`/`V1_4B_TEST_RESULTS.md` 的一致性

**核对结论：无冲突**。`V1_4_ACCEPTANCE_TESTS.md` 的 P0/P1/P2 分级方法论（本文档 §14 沿用同一分级标准）、`V1_4B_IMPLEMENTATION_REPORT.md`/`V1_4B_TEST_RESULTS.md` 记录的 V1.4A/B 真实实现状态（本文档 §1.1/§3 引用的 `feature_records`/`market_bars`/lease/fencing 机制）均与本文档描述一致，未发现需要覆盖的差异点；`V1_4B_TEST_RESULTS.md` 中记录的 revision 时间推进缺陷修复经验被吸收进 §17.8 的显式警示。

### 17.11 Outcome 回填调度与 lease 所有权——P1-3 已关闭，明确 `OutcomeEvaluator` 为独立第二调度器

- **旧口径**：上一版本文档（v1.4c-spec-draft-1）§7.1/§7.2 只冻结了单一 `ForecastGenerator` 调度器与单一 `'forecast-generator'` lease；§3 数据流图虽然画出了"`ForecastOutcomeEngine`"这一步骤，但表述上容易被理解为 `ForecastGenerator` 内部的一个下游子任务，而非完全独立的调度器/lease/审计实体，未明确其是否需要独立恢复与审计。
- **新冻结口径**：本文档 §7.1/§7.2/§6.4/§6.6 冻结 `OutcomeEvaluator` 为与 `ForecastGenerator` 完全独立的第二调度器，持有独立 lease `'forecast-outcome-evaluator'`，独立的 `forecast_evaluation_runs` 审计表（不与 `forecast_generation_runs` 合并），`forecast_outcome_events` 全部写入方法只接受这一 lease。
- **覆盖原因**：Codex 定向复审关闭 P1-3，要求生成与回填两条链路在调度、fencing、恢复、审计四个维度都彻底解耦——这与 GMKG 总架构本身"生成与评估是两个不同时间点、不同性质的操作"的既有精神一致，此前的表述留下了"是否可以合并为同一调度器的两个任务"这一模糊空间，本轮明确排除这一实现路径。
- **生效版本**：V1.4C 本轮修订。
- **是否影响历史记录**：不适用——此前无任何服务器端调度器实现产出过审计记录。

### 17.12 未解决冲突汇总（本轮更新）

本轮（及上一轮）核对**未发现**真正意义上的"两份既有文档对同一问题给出矛盾答案、必须二选一"的冲突。全部差异属于以下三类，且均已逐项处理：
1. **结构性留白**（GMKG §10.1 缺少 PO_ 状态快照字段插槽、`fusionStateAtGeneration` 占位方式未定义）——本文档以【V1.4C新增】方式补齐，不修改原有字段；
2. **新实现引入的新概念**（`auxiliaryEvidence`/`sourceOrigin`/`predictionId`前缀）——纯新增，不覆盖任何既有定义；
3. **两套独立代码实现之间的接口映射空白**（§8.3 PO_ 状态特征映射、§4.1 directionThreshold 公式、§7.1/§7.2 Outcome 调度与 lease 所有权）——**本轮已全部关闭**，不再有标注"待 Codex 实施层确认"或"口径待定"的未决事项。

**唯一需要读者特别注意、不属于"冲突"但极易在实施时被误解为"和 V1.4A/B 一样处理即可"的一点，仍然是 §17.8 记录的 `ForecastSnapshot` 不可变协议与既有 revision 协议的刻意差异**——本轮的三项 P1 关闭均未改变这一结论。

**本轮新增冻结、但既有六份 V1.4 文档与 GMKG 总架构均未提供依据的数值汇总**（供未来审阅时快速定位"这是哪里来的数字"）：`periods`/`floor`/`ceiling`（§4.1，24H=6/0.008/0.05，72H=18/0.015/0.08）、`correlationFloor=0.3`（§8.3 映射四）——均已各自绑定独立版本号（`thresholdFormulaVersion`/`btcAlignmentFormulaVersion`），需要调整时递增版本号，不得静默改值。

---

**文档结束。本规范由 CEO 冻结裁决一至十逐项落地；Codex 对提交 `e421f8c870b692ce2fb800d8080c1aeb899bd64f` 的定向复审发现的 P1-1（directionThreshold 口径）、P1-2（4 项 PO 特征映射）、P1-3（Outcome 回填调度与 lease 所有权）三项，均已在本轮修订中给出确定性公式/规则并关闭，不再需要 Codex 实施层自行裁决。截至本版本，§17 未发现任何仍需 CEO 进一步裁决的真正冲突或未决事项。**
