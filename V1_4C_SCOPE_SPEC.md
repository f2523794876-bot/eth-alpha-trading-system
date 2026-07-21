# V1_4C_SCOPE_SPEC.md — V1.4C 服务器端预测基础设施 冻结规范

版本：v1.4c-spec-draft-1（本轮CEO冻结裁决首次落地）
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
V1.4A CollectorService                V1.4B FeatureEngine              V1.4C（本文档，新增）
  Binance REST                          loadFeatureInputs()               ForecastGenerator
    → market_bars                         → 54项features                    → PO_状态判定（§8）
    → funding_rates/open_interest/         → feature_records                → referenceBar/targetBar定位（§10）
       long_short_ratios/taker_flow        → feature_source_refs             → ForecastSnapshot生成（§4）
    （revision-safe, as-of正确）           （revision-safe, as-of正确,       → 事务内写入
                                             同一事务原子写入）                  forecast_snapshots +
                                                                                forecast_snapshot_sources +
                                                                                forecast_quality_events（§6/§7）
                                                                              → ForecastOutcomeEngine
                                                                                 → 路径完整性判定（§10/§11）
                                                                                 → forecast_outcome_events
                                                                                    幂等追加（§7）

只读只从上游读取，不反向修改：
  V1.4C 只调用 V1.4A repository 的只读查询（market_bars 按 sequenceIndex 遍历）与 V1.4B repository 的只读查询
  （feature_records/feature_source_refs），不写入 market_bars/feature_records 任何字段，不触发 V1.4A/V1.4B 的
  收集/特征生成循环。
```

**组件边界红线**：
1. `ForecastGenerator`（V1.4C）是独立于 V1.4A `CollectorService`、V1.4B `FeatureEngine` 的**第三个调度器**，见 §7.1；三者共享同一 PostgreSQL 实例与同一 `collector_leases` 表结构（表结构复用，lease 名不同，见 §7.2），但代码路径、npm 脚本、CI 步骤各自独立。
2. PO_ 状态判定（§8）**只读消费** V1.4B `feature_records` 的既有字段，**不重新计算**任何一项 54 项特征本身——重新计算会违反"同一份数据只计一次权重"的一般原则（GMKG 总架构 §3 非重叠性红线的同一哲学延伸）。
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
| `directionThreshold` | number | 见 GMKG §10.3，具体口径待 §17.4 确认 | 已冻结（口径待定，见差异记录） |
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
- 外键：`raw_payload_id` 类字段不直接存在于本表（`featureValuesUsed` 是值副本，不是外键引用，见 §7.3），但 `forecast_snapshot_sources`（见 6.2）持有指向 `feature_records.feature_record_id` 的外键，`ON DELETE RESTRICT`（禁止级联删除，保持可追溯性，同 V1.4B `feature_source_refs` 模式）；
- 数据库层不可变：比照 V1.4A `raw_payloads_no_update`/`raw_payloads_no_delete` 触发器模式，新增 `forecast_snapshots_no_update`/`forecast_snapshots_no_delete` 触发器，`RAISE EXCEPTION 'FORECAST_SNAPSHOT_IMMUTABLE'`——这是比 `feature_records`（允许追加 revision，但也不允许 UPDATE 已有行）更严格的约束，因为 `forecast_snapshots` 连"新 revision 追加"这条口子都不开（§17.8）。

### 6.2 `forecast_snapshot_sources`（对应 GMKG §10.1 `dataVintageRefs`/`featureRecordIds` 的展开表，比照 `feature_source_refs` 模式）

- 主键：`forecast_snapshot_source_id bigserial`；
- 外键：`forecast_snapshot_id` → `forecast_snapshots(forecast_snapshot_id) ON DELETE RESTRICT`；`feature_record_id` → `feature_records(feature_record_id) ON DELETE RESTRICT`；
- 唯一键：`UNIQUE(forecast_snapshot_id, feature_record_id)`（同一快照引用同一 feature_record 不得重复插入）；
- CHECK：`CHECK (vintage_id IS NOT NULL)`。

### 6.3 `forecast_quality_events`

- 比照 `feature_quality_events` 模式：`forecast_quality_event_id text PRIMARY KEY`，外键 `forecast_snapshot_id`（可为 `NULL`，对应生成被 `fail closed` 阻断、未产生正式快照的情形，见 §7.5）。

### 6.4 `forecast_outcome_events`

- 主键：`forecast_outcome_event_id bigserial`；
- 外键：`prediction_id` → `forecast_snapshots(prediction_id) ON DELETE RESTRICT`（只读引用，不得反向修改被引用的 Snapshot，GMKG §10.1 红线的数据库层保证）；
- 唯一键：`UNIQUE(prediction_id, evaluation_version)`——幂等回填的数据库层保证：同一 `predictionId`+同一 `evaluationVersion` 重复调用回填函数，`ON CONFLICT(prediction_id, evaluation_version) DO NOTHING`，直接查询已有记录返回（见 §7.4）；`evaluationVersion` 升级后允许追加一条新记录（新 `outcomeEventId`，同一 `predictionId`），与旧版本并存，**不覆盖**（GMKG §10.6 红线的数据库层落地）；
- **本表允许追加（不同 `evaluationVersion`），但同一 `evaluationVersion` 内是不可变+幂等，不是 revision 协议**——不设 `revision_number`；
- CHECK：`CHECK (path_data_complete = false OR (mfe IS NOT NULL OR expected_direction_is_range))`——路径类指标只在 `pathDataComplete=true` 时可能非 null，此类约束具体形式见 §10/§11 真值表，精确 SQL 表达式留待 §16 Codex 层实现，本节只冻结"不完整时必须为 NULL，不得为 0 或近似值"这一结构性要求。

### 6.5 `forecast_generation_runs`（比照 V1.4B `feature_generation_runs`）

- 记录 `ForecastGenerator` 每次调度周期的运行状态，`lease_name`/`fencing_token` 列，用于 §7 审计。

---

## 7. 幂等、事务、lease 与 fencing 契约

### 7.1 独立调度器（CEO 裁决五.1/五.2）

服务器端新增**独立的 `ForecastGenerator` 调度器**（`server/src/forecast/generator-service.js`，命名待 §16 确认），**不复用**浏览器端任何定时器代码，也**不复用** V1.4A `CollectorService`/V1.4B `FeatureEngine` 的调度循环本身（可以复用其**代码模式**——`schedule()`/`clearSchedulers()`/`loseLease()` 这一套已经过独立复审验证的"续约失败即真正停止调度"机制，但必须是独立的类实例、独立的定时器数组，不共享运行时状态）。

### 7.2 独立 lease 与 fencing token（CEO 裁决五.3）

新增 lease 名 `'forecast-generator'`（区别于 V1.4A 的 `'primary-collector'`、V1.4B 的 `'feature-generator'`），复用 `collector_leases` 表结构（同一张表，不同 `lease_name` 行）与 V1.4A 已验证的原子 UPSERT 获取模式；`forecast_snapshots`/`forecast_quality_events`/`forecast_generation_runs`/`forecast_outcome_events` 的全部写入方法都必须接收 `lease` 参数，并在同一事务内（`BEGIN` 后、`COMMIT` 前）校验 fencing token（复用 V1.4A `assertLease()` 模式，同一份代码可直接复用，不需要重新实现校验逻辑本身）。

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
| `e4.breakoutBarsCount/breakdownBarsCount`（突破后持续了几根bar，用于§4.2状态保持/退出判定） | **V1.4B 无对应字段**（V1.4B 只有单次快照的 `breakoutState`，不持久化"已经突破了几根bar"这一跨快照的计数状态） | **无直接等价物，见§17.9缺口** |
| `srZones.supportZones[0]/resistanceZones[0]`（含`.lower`/`.upper`区间宽度） | `distanceToSupportAtr`/`distanceToResistanceAtr`（到最近支撑/压力的 ATR 归一化距离，**不含**区间自身的上下沿宽度） | **无直接等价物，见§17.9缺口** |
| `e4.hasLongUpperWick/hasLongLowerWick`（布尔） | `upperWickRatio`/`lowerWickRatio`（连续比值） | 可用，需 Codex 层定义二值化阈值 |
| `falseBreakoutTier`（三档：`'warning'`/`'confirmation_failed'`等） | `falseBreakoutRisk`（`'UPPER_REJECTION'\|'LOWER_REJECTION'\|'NONE'`） | **枚举语义不同，非直接等价，见§17.9缺口** |
| `btcAlignment(direction, b4)`（`'support'\|'oppose'\|...`） | `btcConflictState`（`'ALIGNED'\|'CONFLICT'`）/`ethBtcReturnSpread`/`ethBtcRollingCorrelation` | **粒度不同，非直接等价，见§17.9缺口** |
| `decision.dataHealth` | V1.4B `feature_records.quality_state`（`HEALTHY`/`WARNING`/`DEGRADED`/`BLOCKED`）+ `completeness` | 可用，概念等价 |

**红线**：上表中标注"无直接等价物"/"非直接等价"的 4 项，**V1.4C 不得为了强行凑出浏览器端字段而新增服务器端特征计算**——这超出"迁移已验证闭环"的范围，属于新的特征工程工作。Codex 实施层**必须**在这 4 项上二选一：(a) 仅用 V1.4B 现有字段重新表述对应 PO_ 状态子条件的判定逻辑（保持业务意图不变，判定手段调整），并在 `V1_4C_CODEX_IMPLEMENTATION_TASK.md` 中逐条记录调整依据；(b) 若确认无法用现有 54 项特征等价表达，该子条件在 V1.4C 阶段降级为"不判定/不作为否决条件"，并在 `evidenceText` 中明确注明未覆盖，**不得**编造近似值冒充已判定。此二选一决策不在本文档中预先裁定，属于 §16 构建顺序第 1 步的前置任务。

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
| **P0** | `dataCutoffTime` 前的未来数据不得进入 `ForecastSnapshot`；`referenceBar`/`targetBar` 必须是已收盘 K 线；`ForecastOutcomeEvent` 不得覆盖 `ForecastSnapshot` 任何字段（数据库触发器+外键 `ON DELETE RESTRICT` 双重验证）；`scenarioWeights` 三项之和恒为 100 且无 NaN/Infinity/负值；`pathDataComplete` 九项不变量全部验证（含 §11 真值表 4 种组合场景）；`targetStateAtGeneration`/`fusionStateAtGeneration` 恒为 `'UNKNOWN'`（数据库 CHECK + 应用层双重验证）；`proxyStateAtGeneration` 判定不受 `auxiliaryEvidence` 影响（§9.3 冲突不改变状态的专项测试）；`algorithmVersion` 同一版本内 `directionThreshold`/`evaluationVersion` 不得动态调整；服务器时间不可用时 fail closed；幂等生成/回填（`UNIQUE(prediction_id)`/`UNIQUE(prediction_id,evaluation_version)` 数据库约束+并发双实例竞争测试）；同一事务原子写入（snapshot+sources+quality_event），失败整体回滚，不产生孤儿记录；`forecast_snapshots` 数据库层拒绝 UPDATE/DELETE（触发器验证）；旧 fencing token 被数据库拒绝，拒绝后无残留写入。 |
| **P1** | `predictionId` 命名空间与浏览器端不冲突（`-SRV-`前缀+独立`algorithmVersion`专项测试）；24H 每 4 小时/72H 每日生成节奏上限；walk-forward 三区间严格按时间排列不重叠不打乱；区间调度算法按 `targetEndTime` 排序；`missingBarRefs` 记录具体 bar 而非泛化原因；`endpointDataComplete`/`pathDataComplete` 独立判定（§10.5.0 边界，专项测试referenceBar缺失但path完整的场景）；MFE/MAE 的 UP/DOWN/RANGE 三种口径分别验证；区间覆盖四项计算正确性；`featureValuesUsed`/`contentHash`与 V1.4B `feature_records`一致性（复制值副本不随源数据 revision 变化的专项测试，即 §7.3 红线的直接验证）；PO_ 状态 9 项映射到 V1.4B 特征后的判定结果与原浏览器端判定逻辑的业务意图一致性抽样比对。 |
| **P2** | 生成/回填耗时性能；只读 API 新增端点（`/api/v1/forecast/*`）响应格式；`auxiliaryEvidence`/`stateEvidence` 展示层措辞是否清晰区分；日志可读性；`fusionStateAtGeneration`等占位字段的注释/文档标注是否清晰（防止被误当作真实融合结果）。 |

---

## 15. 建议新增/修改文件清单

（设计阶段清单，本轮不创建）

```
新增文件：
server/src/forecast/forecast-contract.js      — ForecastSnapshot/ForecastOutcomeEvent字段契约与校验
server/src/forecast/po-state-engine.js        — PO_*状态判定（§8/§9），只读消费feature_records
server/src/forecast/bar-path-locator.js       — referenceBar/targetBar/路径遍历（§10）
server/src/forecast/generator-service.js      — 独立调度器（§7.1/§7.2）
server/src/forecast/forecast-version.js       — algorithmVersion/weightVersion/evaluationVersion冻结常量
server/src/outcome/outcome-engine.js          — ForecastOutcomeEvent幂等回填（§10/§11）
server/src/validation/walk-forward.js         — 区间调度算法、训练/验证/测试切分
server/migrations/004_v1_4c_forecast_engine.up.sql/.down.sql
server/tests/forecast/*.test.js               — 非网络测试
server/tests/postgres/v1-4c-forecast.integration.test.js — 真实PostgreSQL测试
server/tests/postgres/v1-4c-outcome.integration.test.js
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

1. **裁决 §8.2 遗留的 4 项特征映射缺口**（`breakoutBarsCount`等跨快照计数、`srZones`区间宽度、`falseBreakoutTier`枚举映射、`btcAlignment`粒度）——形成 `V1_4C_CODEX_IMPLEMENTATION_TASK.md` 附录，逐项写明 §8.2 红线要求的二选一裁决结果，这是编码开始前的**唯一前置阻断项**。
2. `forecast-contract.js` + 迁移 SQL（结构先行，同 V1.4B 先有 `feature-contract.js` 再有 `feature-engine.js` 的既有顺序）。
3. `bar-path-locator.js`（§10 路径遍历，纯查询函数，无状态判定逻辑，可独立测试）。
4. `po-state-engine.js`（§8/§9，依赖 §8.2 第 1 步的映射裁决结果）。
5. `generator-service.js` + `forecast-version.js`（§7 调度/lease/fencing，复用 V1.4A 已验证模式）。
6. `outcome-engine.js`（§10/§11，依赖 3/4/5 已完成）。
7. `walk-forward.js`（独立模块，依赖仅为已生成的 `forecast_snapshots`/`forecast_outcome_events` 表存在）。
8. 独立对抗性复审（沿用本仓库已验证多轮的模式：隔离 worktree + 隔离 PostgreSQL 14 + 真实 Binance 数据 + 对抗性时间推进探针，特别注意复查 §7.3 红线——`featureValuesUsed` 复制值是否真的不随 `feature_records` 后续 revision 变化，这是最容易被静默破坏的一条不变量）。
9. CI 接线（`test:postgres:forecast`/`test:postgres:outcome` 并入 `test:postgres` 组合命令，**必须**在同一 commit 内完成 `package.json` 修改 + `review-regression.test.js` 结构性断言新增，直接吸取 V1.4B 分两轮修复 CI 接线缺口的教训）。
10. 合并 main 前的最终只读复审。

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

### 17.4 `directionThreshold` 具体数值——未发现，标注待定

**核对结论**：`V1_4_FORECAST_DATA_SPEC.md` 全文提及 `directionThreshold` 须"在算法版本冻结的同一时刻一并选定并写入版本说明"（GMKG §10.3 原文红线），但本轮核对未在 §4/§10 及其他章节找到浏览器端实际使用的**具体数值**（相对百分比或 ATR 倍数）。**这不构成本文档与既有文档的冲突**，而是既有文档本身对这一具体数值采用了"留待实现时冻结、写入版本说明"的开放式表述。本文档不代为拍板，标注为【待 Codex 实施层确认】——服务器端 `directionThreshold` 数值须在 `algorithmVersion` 首次冻结时一并选定，可参考（但不强制等同于）浏览器端实际运行代码中的取值（若存在），由 §16 第 1 步之后、进入 `po-state-engine.js` 编码前的一次独立数值冻结动作完成，并记录进 `V1_4C_CODEX_IMPLEMENTATION_TASK.md`。

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

### 17.9 PO_ 状态输入特征映射——见 §8.2，4 项缺口未在既有文档中出现过，本文档不代为裁决

**核对结论**：`V1_4_FORECAST_DATA_SPEC.md` §4.1/§4.2 定义 PO_ 状态判定规则时，其输入特征（`e4.*`/`e1.*`/`buildSRZones()`/`btcAlignment()`/`falseBreakoutTier`）是**浏览器端 `v1-core.js` 的具体函数输出**，与 V1.4B 服务器端独立实现的 54 项具名特征在字段名、部分语义粒度上**不是同一套**（详见 §8.2 映射表）。这不是"新旧规范互相冲突"（两份文档从未在同一时间试图定义同一件事的两种矛盾答案），而是**两套完全独立代码实现之间天然存在的接口差异**，此前没有任何文档尝试过这一映射（因为 V1.4B 在 `V1_4_FORECAST_DATA_SPEC.md` 成文时尚不存在）。本文档 §8.2 建立了映射表，但对其中 4 项明确标注"无直接等价物"，**不代为裁决**具体的降级/重述方案——按 CEO 裁决二.3（"不得扩展或重定义 PO_\* 状态"）的字面要求，这 4 项的解决方案必须保持"业务判定意图不变、只调整技术实现手段"，具体怎么调整需要在编码前（§16 第 1 步）由实施工单逐条拍板，本文档不越俎代庖替 Codex 做这个判断，只清晰标出了这 4 个必须先解决、不能带着含糊状态直接开始编码的点。

### 17.10 与 `V1_4_ACCEPTANCE_TESTS.md`/`V1_4B_IMPLEMENTATION_REPORT.md`/`V1_4B_TEST_RESULTS.md` 的一致性

**核对结论：无冲突**。`V1_4_ACCEPTANCE_TESTS.md` 的 P0/P1/P2 分级方法论（本文档 §14 沿用同一分级标准）、`V1_4B_IMPLEMENTATION_REPORT.md`/`V1_4B_TEST_RESULTS.md` 记录的 V1.4A/B 真实实现状态（本文档 §1.1/§3 引用的 `feature_records`/`market_bars`/lease/fencing 机制）均与本文档描述一致，未发现需要覆盖的差异点；`V1_4B_TEST_RESULTS.md` 中记录的 revision 时间推进缺陷修复经验被吸收进 §17.8 的显式警示。

### 17.11 未解决冲突汇总

本轮核对**未发现**真正意义上的"两份既有文档对同一问题给出矛盾答案、必须二选一"的冲突。全部差异属于以下三类，且均已逐项处理：
1. **结构性留白**（GMKG §10.1 缺少 PO_ 状态快照字段插槽、`fusionStateAtGeneration` 占位方式未定义）——本文档以【V1.4C新增】方式补齐，不修改原有字段；
2. **新实现引入的新概念**（`auxiliaryEvidence`/`sourceOrigin`/`predictionId`前缀）——纯新增，不覆盖任何既有定义；
3. **两套独立代码实现之间的接口映射空白**（§8.2/§17.9 PO_ 状态特征映射）——本文档标出缺口但不代为裁决，留给 Codex 实施前的独立裁决步骤（§16 第 1 步）。

**唯一需要读者特别注意、不属于"冲突"但极易在实施时被误解为"和 V1.4A/B 一样处理即可"的一点，是 §17.8 记录的 `ForecastSnapshot` 不可变协议与既有 revision 协议的刻意差异**。

---

**文档结束。本规范由 CEO 冻结裁决一至十逐项落地，未发现需要 CEO 进一步裁决的真正冲突；§17.4（`directionThreshold` 具体数值）与 §17.9（4 项特征映射缺口）是两处需要在编码前完成、但不需要 CEO 层面裁决（属于 Codex 实施层的技术选型确认）的待办事项，已在 §16 构建顺序中列为第 1 步的前置阻断项。**
