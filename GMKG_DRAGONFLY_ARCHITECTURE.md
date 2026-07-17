# GMKG_DRAGONFLY_ARCHITECTURE.md — ETH Alpha GMKG「蜻蜓复眼」总架构规范

版本：gmkg-draft-1
基线：`main` @ `6a90a1e`（含 v1.3.1，PR #5 已合并，tag `v1.3.1` 存在）
角色：本文档是 GMKG（下称「蜻蜓复眼架构」）的**顶层目标架构规范**，回答"这套系统未来应该长成什么样"，**不是**"v1.3.1 现在已经做到了什么"的声明。本轮**只交付本文档**，不修改任何 HTML/JS/测试/正式业务代码，不创建 V1.4 六份实施文档，不开始任何编码。

**贯穿全文的强制标注规则**：本文档中出现的每一个能力描述，必须能从上下文明确判断属于以下四类之一，含糊表述视为违反本文档红线：

| 标注 | 含义 |
|---|---|
| 【目标架构】 | GMKG 长期设想，当前完全未实现，可能需要付费数据、服务器、大量工程 |
| 【v1.3.1已实现】 | 当前 `main` 分支代码已经真实具备的能力，可直接引用文件/函数名核实 |
| 【V1.4可实施最小范围】 | 用当前 Binance 免费数据 + 现有单文件/未来最小后端即可落地的第一步 |
| 【需服务器架构后实施】 | 逻辑上属于GMKG范围，但工程上必须等采集/存储/回放服务就绪才能开始 |
| 【仍需研究/授权/付费】 | 数据源本身尚未核实可行性，或明确需要付费/额外授权，本轮不承诺接入 |

---

## 0. 开始前基线核对（只读，本节记录核对结论，不是操作步骤）

1. 仓库：`/home/ubuntu/eth-trading-dashboard`，工作分支 `claude/gmkg-dragonfly-architecture`，由最新 `main`（`6a90a1e`）创建，与 `origin/main` 完全同步。
2. `main` 已包含 `v1.3.1`：`6a90a1e` 是 PR #5（`codex/v1.3.1-trade-gate-diagnostics`）的合并提交，`git tag -l` 确认 `v1.1.0`/`v1.2.0`/`v1.3.0`/`v1.3.1` 四个 tag 均存在。
3. 已阅读 `V1_2_FORECAST_SPEC.md`（十个概念区分、`ForecastLogEntry`/"bar"定义/版本号红线）、`STRATEGY_SPEC.md`（§7 蜻蜓捕猎模型、§14.7 三级数据健康、§18 历史行情实验室）、`V1_3_PAPER_TRADING_SPEC.md`/`V1_3_ARCHITECTURE_REVIEW.md`/`V1_3_ACCEPTANCE_TESTS.md`、`V1_3_1_IMPLEMENTATION_REPORT.md`、`v1-core.js`/`v1_3-trade-gate-diagnostics.js`/`v1_3-paper-trading-core.js`/`v1_3-signal-archive-core.js` 源码。
4. 工作目录中存在此前会话遗留的、与本轮任务无关的未提交文件（`V1_4_FORECAST_DATA_SPEC.md`、`V1_4_DATA_SOURCE_MATRIX.md`、多份 `CLAUDE_CODE_REVIEW*.md`），本轮**不触碰、不提交**这些文件，只新增并提交本文档一个文件，避免覆盖用户其他未完成的工作。
5. 分支 `claude/gmkg-dragonfly-architecture` 此前不存在（本地与 `origin` 均未找到），本轮全新创建，无需处理"来源冲突"问题。

---

## 1. 命名消歧（红线，必须在正文最前面澄清，防止与既有代码同名概念冲突）

`STRATEGY_SPEC.md` §7 已经定义并且 v1.3.1 已经真实实现了一个叫「**蜻蜓捕猎模型**」的概念——单只蜻蜓捕捉单个猎物，程序变量是 `bestInterceptionZone()`/`decision.dragonflyText`，回答"当前该在哪个价位拦截 ETH 这一个猎物"，**这个概念不变、不修改、继续原样运行**。

本文档定义的「**GMKG 蜻蜓复眼架构**」是另一个层级、完全不同的隐喻——取的是蜻蜓**复眼**（数千只小眼组成、接近全景视野）的生物学特征，回答的是"如何同时看清全世界、看清目标本身、推演下一步、并决定能不能出手"这一更高层的感知—决策架构问题，**不涉及"在哪个具体价位拦截"这一战术问题**。

**强制区分规则**：
- 全文提到"蜻蜓捕猎模型"/`bestInterceptionZone`/`dragonflyText` 时，特指 `STRATEGY_SPEC.md` §7 已实现的战术拦截区计算，**不属于** GMKG 范围，GMKG 不修改它。
- 全文提到"GMKG"/"蜻蜓复眼"/"四眼系统"时，特指本文档定义的广度眼/精度眼/单眼/融合中枢四系统架构。
- 未来 V1.4 及后续实施文档中，任何新增变量/文件命名**禁止**使用裸词 `dragonfly`/`蜻蜓` 而不带限定词（必须写成 `gmkgDragonfly*` 或明确的四眼系统专名），避免与既有 `dragonflyText` 混淆。
- 融合中枢最终仍然可以把 GMKG 的行动许可与 `bestInterceptionZone()` 的战术拦截区**并排展示**（一个回答"值不值得出手"，一个回答"在哪出手"），但两者是消费关系，不是同一套计算逻辑，见 §12。

---

## 2. 冻结核心原则

> **广度眼决定环境，精度眼决定目标，单眼决定轨迹，融合中枢决定行动。**

四系统定义（【目标架构】，v1.3.1 完全未实现，见 §16 现实边界）：

| 系统 | 输入 | 输出 | 一句话职责 |
|---|---|---|---|
| 广度眼 Wide Eye | 全球宏观/跨资产/加密广域公开数据 | `WorldState` | 看全世界发生了什么 |
| 精度眼 Precision Eye | BTC/ETH 内部价格、订单流、衍生品、链上数据 | `TargetState` | 看 BTC/ETH 内部正在发生什么 |
| 单眼 Single Eye | 当前联合状态 `JointState` + 历史状态序列 + 历史迁移结果 | `TrajectoryScenarios` | 根据当前与历史推演下一状态 |
| 融合中枢 Fusion Hub | 环境、目标、轨迹、数据质量、历史表现、风险边界 | 情景可信程度 + 行动许可 | 决定这次输出能不能被信、能不能被用来行动 |

推荐主流程（【目标架构】，冻结顺序，不得颠倒或跳步）：

```
WorldState
  +
TargetState
  → JointState
  → Trajectory Prediction（单眼）
  → Risk and Permission Fusion（融合中枢）
  → Forecast and Action（对外输出：预测结果 + 行动许可）
  → Actual Result（未来实际走势/结果回填）
  → Error Attribution（误差归因）
  → Calibration（校准，反哺迁移模型与融合权重，见§14）
```

**红线（必须逐条满足，贯穿全文所有章节）**：

1. **单眼不直接采集外部原始数据**——它只读取 `JointState`（广度眼+精度眼的联合状态）、历史状态序列、历史迁移结果这三类"已经算好的"输入，不持有任何独立的数据采集权限，不得绕过广度眼/精度眼直接接触原始行情或宏观数据。这条边界的意义是防止"单眼自己又发明一套数据源"，导致四系统职责重叠、审计链路断裂。
2. **预测融合与行动许可必须分离**——融合中枢对外必须产出两个独立对象（§11.5 `ForecastResult` 与 `ActionPermission`），不得把"这个情景有多可信"和"现在能不能拿这个情景去下单/试仓"揉进同一个数值里。一个高可信度的情景，行动许可依然可能因为账户风控被压到 `WAIT`；一个低可信度的情景，也可能因为数据本身健康、无持仓冲突而被允许进入观察或试仓许可。
3. **账户余额、保证金、冷却和模拟交易风控不得反向修改原始轨迹预测**——`TrajectoryScenarios`、`baselineScenario`/`upsideScenario`/`downsideScenario`、`transitionWeights`、`calibratedProbability` 一旦由单眼和融合中枢的预测环节生成，就是该次预测的**不可变事实**（呼应 `V1_3_PAPER_TRADING_SPEC.md`"建仓快照冻结不可被后续刷新覆盖"、`V1_2_FORECAST_SPEC.md`§12"日志必须完整到能独立复现"的既有设计哲学）。账户当前净值不够、处于冷却期、回撤锁定中，这些账户侧状态**只能影响 `ActionPermission`**（比如把 `ALLOW_EXECUTION` 压低为 `WAIT`），**绝不能**倒过来改写 `TrajectoryScenarios` 里已经算出的情景权重或价格区域——账户没钱和"ETH接下来会怎么走"是两件完全不相关的事，混在一起会让预测系统的历史校准彻底失去意义（校准要问的是"这套算法预测得准不准"，如果预测结果会被账户状态污染，校准出来的准确率就不再反映算法本身）。

---

## 3. 四系统职责边界与非重叠性核对

| 系统 | 拥有的数据采集权限 | 不拥有的权限 | 与其他系统的唯一合法交互方式 |
|---|---|---|---|
| 广度眼 | 12个数据域的全部原始/半原始外部数据（§5） | 不采集 BTC/ETH 自身的价格、订单簿、衍生品、链上数据（那是精度眼的范围） | 只输出 `WorldState`，供精度眼引用做跨资产联动特征、供单眼构成 `JointState` 的一半、供融合中枢读取环境支持度 |
| 精度眼 | BTC/ETH 价格、订单流、衍生品、期权、资金流、链上供需、相对强弱（§6） | 不采集宏观/跨市场数据（那是广度眼的范围）；不做"下一步会怎样"的推演（那是单眼的范围） | 只输出 `TargetState`（含 §7 八状态判定），供单眼构成 `JointState` 的另一半、供融合中枢读取目标内部状态 |
| 单眼 | 无原始数据采集权限（见§2红线1） | 不采集任何原始数据；不决定"能不能行动"（那是融合中枢的范围） | 只读取 `JointState` + 历史状态序列 + 历史迁移结果，输出 `TrajectoryScenarios`（情景与迁移权重），供融合中枢消费 |
| 融合中枢 | 无原始数据采集权限 | 不重新计算环境状态、目标状态或轨迹情景（那些是前三个系统已经算好的） | 读取 `WorldState`+`TargetState`+`TrajectoryScenarios`+数据质量+历史表现+风险边界，输出 `ForecastResult`与`ActionPermission`两个分离对象 |

**非重叠性自检结论**（对应第十九节自检第1项）：四系统的输入输出严格单向串联（广度眼/精度眼并行产出 → 单眼消费两者的联合 → 融合中枢消费单眼的输出+前两者的状态+账户/风险侧输入），任一系统都不重复实现另一系统已经拥有的采集或计算职责，符合 §2 红线1-2 的要求。

---

## 4. 360度与300帧的工程定义

### 4.1 360度：消除系统性信息盲区，不是物理角度

360度在 GMKG 中**不表示**"扫描一个物理方位角"，而是表示"覆盖率上没有系统性遗漏的信息维度"——具体落地为 §5 的12个数据域、约240项指标，确保广度眼不会因为"只看利率不看流动性""只看美股不看大宗商品"这类结构性盲区，对某一类环境冲击视而不见。360度是**覆盖面的完整性指标**，不是精度指标——覆盖到240项目标指标不代表每项都精确或都已接入（【目标架构】，见§5.0现实标注）。

### 4.2 300帧：24小时推演的统一状态切片，不是高频采样

300帧的工程定义（【目标架构】）：

- 对 24 小时推演窗口，**每 5 分钟形成一个完整状态切片**（`StateFrame`），24 小时 = 288 个常规切片。
- 在常规切片之外，**重大宏观/政策/监管/地缘事件发生时刻额外插入事件快照帧**（不受 5 分钟栅格约束，事件发生即插帧），累积形成约 300 个状态上下文，覆盖常规节奏与突发节奏两类信息。
- **不是**"每秒300次"这种高频轮询定义，**不是**"300根普通K线"这种单一时间粒度K线定义——是"覆盖 24 小时、粒度到 5 分钟、外加事件驱动加密"的复合状态切片序列。
- 订单簿、逐笔成交、爆仓等高频数据（原始频率远高于5分钟）**必须先在帧内聚合**（如："过去5分钟内订单簿失衡的均值/极值""过去5分钟内是否发生强平簇"），不得把原始逐笔数据直接塞进帧对象，帧对象存的是聚合后的特征值，不是原始流水。

### 4.3 `StateFrame` 统一状态帧结构（【目标架构】唯一权威定义）

```ts
interface StateFrame {
  frameId: string;                 // 唯一标识，如 `F-{unixMs}` 或事件帧 `EF-{unixMs}-{eventId}`
  timestamp: number;                // 该帧代表的逻辑时刻（5分钟栅格对齐点，或事件发生时刻），ms epoch
  asOfTime: number;                 // 帧内所有指标"数据本身有效"的截止时间基准（不同指标各自的asOf见sourceVersions，此字段是帧级别的兜底基准）
  receivedAt: number;                // 该帧完成组装、系统实际收到/生成完毕的时间（ms epoch），用于区分"数据代表的时刻"与"数据到手的时刻"
  environmentState: WorldState;      // §5 广度眼输出（压缩后的环境状态，非240项原始值）
  btcTargetState: TargetState;       // §6 精度眼输出（BTC）
  ethTargetState: TargetState;       // §6 精度眼输出（ETH）
  liquidityState: object;            // 订单簿/流动性相关聚合特征（帧内聚合，非逐笔）
  riskState: object;                 // 衍生品/杠杆/挤压相关聚合特征
  positionState: object;             // 账户侧状态快照引用（只读引用，不参与轨迹预测计算，呼应§2红线3）
  derivativesState: object;          // 资金费率/OI/多空比等衍生品状态（帧内聚合）
  eventState: object;                // 本帧覆盖窗口内是否存在已标注宏观/政策/监管/地缘事件及其影响窗口标注
  dataQuality: FrameDataQuality;     // 见下
  sourceVersions: Record<string, { asOf: number; fetchedAt: number; sourceId: string }>;  // 逐指标记录"这个值代表哪个时刻、什么时候拉取的、来自哪个数据源"
  staleFields: string[];             // 本帧中使用了"沿用上一次已知值"（非本帧新鲜值）的字段列表
  missingFields: string[];           // 本帧完全缺失、未填充任何值的字段列表
  revisedFields: { field: string; previousValue: unknown; revisedValue: unknown; revisedAt: number }[]; // 本帧发现的、相对更早某帧的数据修订记录
}

interface FrameDataQuality {
  completenessRatio: number;   // 0-1，本帧非缺失字段占比
  freshnessSummary: 'fresh' | 'delayed' | 'stale';  // 复用 STRATEGY_SPEC.md §14.7 已确立的三级模型语义，不新造枚举
  staleFieldCount: number;
  missingFieldCount: number;
  revisedFieldCount: number;
}
```

### 4.4 更新频率异构性（红线，必须在帧结构与实现文档中反复强调）

GDP/CPI/PMI 是月度或季度频率，ETF净流量是日频（美股收盘后披露），链上数据是分钟到小时级，订单簿是逐笔/秒级。**每个 5 分钟状态帧保存的是"该时刻可以获得的最新状态"，不是"所有指标每 5 分钟都产生新值"**——一个月度 GDP 指标在同一个月内的 8640 个5分钟帧（30天×288帧/天）里，`sourceVersions.gdp.asOf` 会长期指向同一个发布时点，这是**正确行为**，不是系统故障；实现时必须用 `staleFields`/`sourceVersions.asOf` 如实反映这种"沿用"状态，**禁止**因为帧结构要求"每帧都有值"就伪造月度指标每5分钟都变化的假象——这是防止未来数据泄漏与自我欺骗式"数据完整度"的第一道工程防线，直接呼应§14验证闭环对"不可变快照"的要求。

---

## 5. 广度眼目标数据域：12域 / 约240项指标（【目标架构】）

**现实标注（红线，必须在本节最前面重申）**：以下12个数据域、240项指标是 GMKG **目标覆盖范围**，不是当前已接入的数据清单。当前 v1.3.1 只使用 Binance 现货 ETH/USDT、BTC/USDT 六路K线（15m/1h/4h），**不涉及本节任何一项**。逐项数据源的真实可用性、免费/付费、CORS、速率限制等工程细节不在本文档展开（那是未来 V1.4 数据源研究阶段的工作，参照既有 `V1_2_FORECAST_SPEC.md`/`V1_3_PAPER_TRADING_SPEC.md` 先定义"要什么"、再单独立项研究"从哪拿"的既定顺序）。

### 5.1 十二数据域与指标数量

| # | 数据域 | 指标数 | 覆盖示例（代表性，非穷举） |
|---|---|---|---|
| 1 | 全球增长状态 | 22 | 主要经济体GDP增速、PMI制造业/服务业、工业产出、零售销售、耐用品订单、领先指标、贸易帐、库存周期指标 |
| 2 | 通胀状态 | 20 | CPI/核心CPI、PCE/核心PCE、PPI、工资增速、通胀预期（盈亏平衡通胀率）、进口价格、房租分项 |
| 3 | 就业和收入状态 | 18 | 非农就业、失业率、时薪增速、职位空缺、初请/续请失业金、劳动参与率 |
| 4 | 全球央行与政策状态 | 20 | 联邦基金利率与点阵图、欧央行/日央行/英央行政策利率、央行资产负债表规模、前瞻指引措辞变化 |
| 5 | 全球流动性和利率 | 28 | 2年/10年/30年期国债收益率、收益率曲线利差、隔夜逆回购规模、银行准备金水平、信用利差、TED利差、SOFR |
| 6 | 美元与全球货币 | 18 | DXY、主要货币对（EUR/JPY/GBP/CNY等）、贸易加权美元指数、离岸人民币汇率 |
| 7 | 全球股票和风险偏好 | 22 | 标普500/纳指/道指、VIX、全球主要股指（欧股/日股/新兴市场）、股债相关性、避险资产流向 |
| 8 | 信用和杠杆状态 | 16 | 高收益债利差、投资级债利差、企业债发行量、杠杆贷款指数、违约率 |
| 9 | 商品、能源和运输 | 22 | WTI/Brent原油、天然气、黄金、铜、农产品指数、波罗的海干散货指数（运输） |
| 10 | 仓位和资金流 | 18 | 期货投机净持仓（COT报告）、ETF资金流、共同基金资金流、期权Put/Call比 |
| 11 | 地缘政治与政策 | 18 | 地缘冲突事件标注、贸易政策变化、选举周期、制裁事件、能源供应中断事件 |
| 12 | 加密广域状态 | 18 | 加密总市值、BTC/ETH主导率、稳定币总供应、跨链TVL、交易所整体资金净流向 |
| — | **合计** | **240** | — |

### 5.2 压缩原则：240项禁止直接投票或简单计票

**红线**：广度眼**不得**把240项指标做简单多数投票（"120项看多、120项看空"这类计票方式在统计上没有意义，指标之间高度共线，直接计票会系统性放大某一类高度相关指标群的权重）。240项必须先经过**领域内压缩**（每个数据域内部先归纳出该域自己的状态判断），再由**跨域归纳**得到少量、可解释的环境状态（regime），环境状态本身才是广度眼对外的正式输出，240项原始值只作为环境状态的**证据支持**（`supportingEvidence`/`opposingEvidence`），不直接对外暴露成"投票结果"。

### 5.3 `WorldState` 环境状态最小字段集

```ts
interface WorldState {
  growthRegime: 'expansion' | 'slowdown' | 'contraction' | 'recovery' | 'uncertain';
  inflationRegime: 'disinflation' | 'stable' | 'reflation' | 'overheating' | 'uncertain';
  liquidityRegime: 'ample' | 'tightening' | 'tight' | 'easing' | 'uncertain';
  rateRegime: 'rising' | 'peak' | 'falling' | 'trough' | 'uncertain';
  dollarRegime: 'strengthening' | 'stable' | 'weakening' | 'uncertain';
  riskRegime: 'risk_on' | 'risk_off' | 'transitional' | 'uncertain';
  creditRegime: 'benign' | 'widening_stress' | 'acute_stress' | 'uncertain';
  commodityRegime: 'inflationary_pressure' | 'disinflationary' | 'neutral' | 'uncertain';
  policyRegime: 'accommodative' | 'neutral' | 'restrictive' | 'uncertain';
  eventRisk: { level: 'low' | 'elevated' | 'high'; activeEvents: string[] };
  cryptoBroadRegime: 'accumulation' | 'expansion' | 'distribution' | 'stress' | 'uncertain';
  environmentPermission: 'supportive_for_risk_assets' | 'neutral' | 'headwind_for_risk_assets' | 'conflicted';
  regimeConfidence: number;          // 0-100，各domain内部证据一致性代理，非统计概率（呼应V1.2"置信度不是胜率"红线）
  supportingEvidence: string[];
  opposingEvidence: string[];
  dataAsOf: number;
}
```

**红线**：`environmentPermission` 只回答"宏观环境对风险资产整体是否友好"，**不得**直接输出"BTC/ETH 会涨还是会跌"——广度眼的职责边界到"环境是否支持"为止，具体到 BTC/ETH 涨跌是精度眼+单眼+融合中枢往下游才能回答的问题（呼应§2红线1、§3非重叠性表格）。

---

## 6. 精度眼目标指标：BTC/ETH 各48项（【目标架构】）

**现实标注**：当前 v1.3.1 精度眼层面只有 Binance 现货K线衍生的价格/EMA/ATR/Swing/成交量比等基础特征（`v1-core.js` 的 `analyzeKlines`），**不具备**本节 B-G 组任何一项。OKX/CoinGlass/Deribit/Glassnode/Coin Metrics 等数据源【仍需研究/授权/付费】，本文档只定义"精度眼未来需要回答什么问题"，不承诺任何具体数据商已经接入或已经核实可行。

### 6.1 48项指标分组

| 组 | 数据域 | 指标数 | 覆盖示例 | 当前状态 |
|---|---|---|---|---|
| A | 价格与成交结构 | 6 | 现货价格、多周期EMA、ATR、成交量、Swing结构、动态支撑压力 | 【v1.3.1已实现】（`analyzeKlines`/`buildSRZones`） |
| B | 订单簿与主动资金 | 8 | 订单簿失衡、买卖墙、CVD、主动买卖比、大额成交、跨交易所价差 | 【仍需研究/授权/付费】（多数需服务器采集） |
| C | 衍生品杠杆 | 10 | 资金费率、OI、OI变化率、多空账户比、多空持仓比、基差、期限结构、强平数据 | 【仍需研究/授权/付费】（Binance Futures官方API免费，但需服务器采集，见§16） |
| D | 期权状态 | 6 | Put/Call比、隐含波动率曲面、25-delta风险逆转、最大痛点 | 【仍需研究/授权/付费】（Deribit为主要来源，需专门核实） |
| E | 资金进入与退出 | 6 | 交易所净流入/流出、稳定币流入、ETF净流量、质押流入/退出 | 【仍需研究/授权/付费】 |
| F | 链上供需 | 8 | 活跃地址、链上活跃度、Gas、鲸鱼转账、长期持有者行为、供应分布 | 【仍需研究/授权/付费】（Etherscan类官方API，免费层不稳定） |
| G | 相对强弱与跨资产 | 4 | BTC/ETH相对强弱、与美股相关性、与DXY相关性、加密内部轮动 | 【仍需研究/授权/付费】（部分可由广度眼数据派生，非独立采集） |
| — | **合计** | **48** | — | — |

### 6.2 精度眼必须回答的问题（【目标架构】设计意图，非当前实现）

- BTC/ETH 当前是什么状态（对应§7八状态判定）；
- 上涨由现货还是杠杆推动（现货CVD为正+OI下降 vs 现货平淡+OI暴涨+资金费率走高，是两种完全不同性质的上涨）；
- 上涨是否健康（健康=现货主导、杠杆温和、无极端资金费率；不健康=纯杠杆堆积、资金费率极值、强平风险累积）；
- 下跌是否接近失速（下跌动能衰竭的迹象：CVD背离、强平簇后OI快速出清、订单簿失衡反转）；
- 当前关键位置在哪里（复用 v1.3.1 已实现的动态支撑压力，见§1命名消歧，`bestInterceptionZone`战术层不变）；
- 目标相对环境是强势还是弱势（呼应§9冲突裁决场景1"逆环境相对强势"）。

### 6.3 `TargetState` 最小字段集（供 §7 八状态判定消费）

```ts
interface TargetState {
  symbol: 'BTC' | 'ETH';
  primaryState: DragonflyStateId;      // 见§7
  secondaryState: DragonflyStateId | null;
  stateConfidence: number;              // 0-100，规则内部一致性代理，非统计概率
  stateEvidence: string[];
  opposingEvidence: string[];
  spotVsLeverageDriver: 'spot_led' | 'leverage_led' | 'mixed' | 'insufficient_data';
  trendHealth: 'healthy' | 'fragile' | 'exhausted' | 'insufficient_data';
  keyLevels: { support: number[]; resistance: number[] };  // 复用既有支撑压力算法，不重算
  relativeStrengthVsEnvironment: 'stronger_than_environment' | 'aligned_with_environment' | 'weaker_than_environment';
  dataCompleteness: number;             // 0-1，48项中status='ok'占比
  dataAsOf: number;
}
```

---

## 7. 单眼八状态模型（BTC/ETH 统一，【目标架构】）

### 7.0 状态总览

| 状态 | 中文 | 一句话业务定义 |
|---|---|---|
| `S0_ACCUMULATION` | 积累 | 下跌或震荡末期，聪明钱可能正在悄悄建仓，价格尚未确认反转 |
| `S1_BREAKOUT_PREP` | 突破准备 | 积累区收窄、动能与资金费率开始转向，尚未真正突破关键位 |
| `S2_BULL_EXPANSION` | 多头扩张 | 已突破关键位，现货与杠杆同步推动价格上行，趋势确认 |
| `S3_OVERHEATED` | 过热 | 上涨延续但杠杆/资金费率/期权隐含波动率进入极值区，透支迹象显现 |
| `S4_DISTRIBUTION` | 派发 | 高位滞涨、大户可能正在减仓，价格尚未确认反转向下 |
| `S5_BEAR_EXPANSION` | 空头扩张 | 已跌破关键位，现货与杠杆同步推动价格下行 |
| `S6_CAPITULATION` | 投降/出清 | 恐慌性抛售或强平连锁反应，波动率与成交量急剧放大 |
| `S7_REPAIR_RANGE` | 修复震荡 | 出清后进入震荡修复，尚未确认下一轮方向 |

### 7.1 每状态详细定义

以下每个状态按统一模板展开：业务定义 / 必要条件 / 加分条件 / 否决条件 / 建议特征 / 阈值类型 / 最短持续时间 / 状态切换滞后。

**`S0_ACCUMULATION` 积累**
- 业务定义：价格结构上处于下跌尾声或长期震荡区间下沿，暗示性证据（现货CVD转正、交易所净流出、资金费率转平）大于价格本身的方向性证据。
- 必要条件：价格未创近期新低（结构层面）；且 `spotVsLeverageDriver ∈ {spot_led, mixed}`。
- 加分条件：交易所净流出趋势；资金费率长期贴近零或转负后回稳；波动率相对前一阶段显著收窄。
- 否决条件：`trendHealth='exhausted'`同时价格仍在创新低（说明尚未止跌，不能提前判定积累）；数据不足。
- 建议特征：动态支撑区反复触及不破；成交量温和放大但价格滞涨。
- 阈值类型：**相对阈值**（相对自身历史波动率/成交量基线，不用绝对价格），因为"积累"的形态在不同价格量级下表现形式相同但绝对数值不同。
- 最短持续时间：需覆盖至少若干个15分钟结构周期以排除单次噪音（具体根数留待V1.4B用真实数据标定，本文档不写死，呼应V1.2"标定过程本身是V2工作内容"的既有原则）。
- 状态切换滞后：进入/退出均需连续确认，防止单根K线导致状态抖动。

**`S1_BREAKOUT_PREP` 突破准备**
- 业务定义：`S0`基础上，动能指标（成交量比、OI变化率）开始转向，价格贴近关键压力/支撑但未突破。
- 必要条件：前置状态为`S0`或`S7`；价格进入关键位的临近区间（复用既有动态支撑压力"贴近"判定逻辑，不重新发明距离算法）。
- 加分条件：资金费率/OI出现方向一致的温和上升（多头准备）或下降（空头准备）；订单簿失衡出现方向性倾斜。
- 否决条件：`falseBreakoutTier`风格的假突破风险信号出现（复用v1.1既有假突破分级概念，不重新定义）。
- 建议特征：波动率收窄后的"蓄力"形态。
- 阈值类型：相对阈值。
- 最短持续时间：短（是一个过渡态，设计上不应长期停留）。
- 状态切换滞后：向`S2`/`S5`切换需要已收盘K线确认突破/跌破（复用v1.1"禁止用盘中刺穿判定"的红线，见`STRATEGY_SPEC.md`既有触发结构定义）。

**`S2_BULL_EXPANSION` 多头扩张**
- 业务定义：已确认突破，现货与杠杆同步推动，多头趋势确立。
- 必要条件：已收盘确认突破关键位；`spotVsLeverageDriver ∈ {spot_led, mixed}`（纯杠杆推动的突破不满足"健康扩张"，应归入更谨慎的判定或直接标注`trendHealth='fragile'`）。
- 加分条件：广度眼`riskRegime='risk_on'`同向支持；成交量持续超过基线。
- 否决条件：资金费率/OI已进入§7.1 `S3`的极值区（此时应直接判定为`S3`而非`S2`，二者互斥）。
- 建议特征：价格沿动态支撑階梯上行，回踩不破。
- 阈值类型：相对阈值为主，极值判定（区分`S2`/`S3`）需要绝对阈值（资金费率触及交易所费率上限/历史分位数极值），两类阈值需在实现层明确标注各自类型，不得混用。
- 最短持续时间：中等。
- 状态切换滞后：向`S3`切换不需要额外滞后（极值一旦出现应及时预警，不适合"再等等确认"）；向`S4`/回撤方向切换需要已收盘确认。

**`S3_OVERHEATED` 过热**
- 业务定义：`S2`基础上，杠杆或衍生品指标进入历史极值区，价格可能仍在上涨但透支迹象明显。
- 必要条件：资金费率/OI/期权隐含波动率任一项进入历史高分位（具体分位数留待标定）。
- 加分条件：多个衍生品指标同时进入极值（资金费率+OI同时极值比单一指标更强证据）。
- 否决条件：数据不足（缺少衍生品数据时不能判定`S3`，只能退回`S2`并标注`insufficient_data`，见§7.4）。
- 建议特征：价格创新高但成交量或CVD出现背离。
- 阈值类型：绝对阈值（历史分位数）。
- 最短持续时间：短（过热是不稳定态，理论上应较快过渡到`S2`回落或`S4`）。
- 状态切换滞后：向`S4`切换需要已收盘确认滞涨或首次回落。

**`S4_DISTRIBUTION` 派发**
- 业务定义：高位滞涨，暗示性证据（交易所净流入增加、大户持仓量比下降）大于价格本身的方向性证据。
- 必要条件：前置状态为`S3`或`S2`；价格结构上滞涨（不再创新高，或新高动能明显衰竭）。
- 加分条件：交易所净流入趋势；大额转入交易所地址增多。
- 否决条件：价格仍强势创新高且成交量同步放大（应仍归`S2`/`S3`，不满足`S4`）。
- 建议特征：与`S0`对称，但发生在高位。
- 阈值类型：相对阈值。
- 最短持续时间：需覆盖多个结构周期。
- 状态切换滞后：同`S0`。

**`S5_BEAR_EXPANSION` 空头扩张**
- 业务定义：已确认跌破关键位，现货与杠杆同步推动下行。
- 必要条件、加分条件、否决条件、阈值类型、最短持续时间、状态切换滞后：与`S2`对称（方向相反）。

**`S6_CAPITULATION` 投降/出清**
- 业务定义：恐慌性抛售或强平连锁反应，波动率与成交量急剧放大，往往是趋势的极端点而非延续点。
- 必要条件：`S5`基础上，强平簇/波动率出现历史极值级别的放大。
- 加分条件：多空挤压风险指标（衍生品组合指标）同时触发。
- 否决条件：数据不足时不得判定`S6`（`S6`是最容易被误判、也最容易被过度解读的状态，必须有强证据支持，缺数据时宁可退回`S5`）。
- 建议特征：单位时间内价格跌幅、强平金额同时创阶段极值。
- 阈值类型：绝对阈值（历史极值分位数）。
- 最短持续时间：短（出清本身是快速事件）。
- 状态切换滞后：向`S7`切换需要出清动能明确衰竭的已收盘确认（防止"抄底"式提前判定）。

**`S7_REPAIR_RANGE` 修复震荡**
- 业务定义：出清后进入震荡修复，方向尚未确认，是`S0`或反弹后再次转跌的分叉点。
- 必要条件：前置状态为`S6`；波动率相对`S6`阶段显著收窄。
- 加分条件：无明显方向性资金流。
- 否决条件：价格重新创出清阶段新低（应退回`S6`或`S5`，不满足`S7`"修复"定义）。
- 建议特征：区间往复，无持续方向。
- 阈值类型：相对阈值。
- 最短持续时间：中等到长（修复期本身可能持续较久）。
- 状态切换滞后：向`S0`/`S1`切换需要新一轮积累证据的持续确认。

### 7.2 数据不足处理（共享规则，对应8状态"不能所有时刻都有高置信度唯一状态"要求）

```
若精度眼48项指标的dataCompleteness低于最低门槛（具体数值留待V1.4B标定）：
  primaryState 仍可基于A组（价格与成交结构，v1.3.1已具备）给出基础判定
  但 stateConfidence 必须相应下调
  且 secondaryState 必须体现"数据不足，无法排除的替代状态"（如无法区分S2健康扩张与S3过热时，
      primaryState=S2, secondaryState=S3, stateConfidence下调，evidence中注明"衍生品数据缺失，无法排除过热风险"）
```

### 7.3 状态冲突处理（共享规则）

当多组证据同时支持两个非相邻状态（如同时满足`S2`部分证据与`S4`部分证据）时：**不强行归并为单一状态**，输出 `primaryState`（证据权重更高的一侧）+ `secondaryState`（另一侧）+ 在 `opposingEvidence` 中明确列出冲突证据本身，供融合中枢在§9冲突裁决环节进一步处理，而不是让单眼自己"和稀泥"选一个中间态。

### 7.4 主/次状态表达与状态置信度

```ts
type DragonflyStateId = 'S0_ACCUMULATION' | 'S1_BREAKOUT_PREP' | 'S2_BULL_EXPANSION' | 'S3_OVERHEATED'
  | 'S4_DISTRIBUTION' | 'S5_BEAR_EXPANSION' | 'S6_CAPITULATION' | 'S7_REPAIR_RANGE'
  | 'CONFLICTED';  // 仅供融合中枢在§9场景4使用，单眼自身8状态判定不产出此值

interface StateJudgement {
  primaryState: DragonflyStateId;
  secondaryState: DragonflyStateId | null;
  stateConfidence: number;   // 0-100，规则内部一致性代理，不是统计概率
  stateEvidence: string[];
  opposingEvidence: string[];
  insufficientDataFlags: string[];  // 因数据不足而无法排除的候选状态列表
}
```

### 7.5 允许的迁移

| 迁移类型 | 说明 | 示例 |
|---|---|---|
| 主要迁移（顺时针推进） | 状态按积累→准备→扩张→过热→派发→空头扩张→出清→修复的自然生命周期推进 | `S0→S1→S2→S3→S4→S5→S6→S7→S0` |
| 允许的回退迁移 | 未确认充分即回退到更早阶段 | `S1→S0`（突破准备失败回落积累）、`S3→S2`（过热降温但未转跌）、`S6→S5`（出清未完成，二次探底） |
| 禁止或低可能迁移 | 跳过中间必要确认阶段的迁移，必须标记为需要额外证据支持或直接视为异常 | `S0→S3`（积累直接跳到过热，跳过突破和扩张确认）、`S2→S6`（多头扩张直接跳到投降出清，方向都没反转就出清，逻辑矛盾） |

**红线**：低可能迁移不是"绝对不可能"（真实市场偶有极端跳空），但实现时必须要求这类迁移有远高于常规迁移的证据强度阈值，且必须在 `stateEvidence` 中特别注明"检测到非常规迁移路径，建议人工复核"，呼应§15误差归因的 `requiresHumanReview`。

---

## 8. 迁移模型（单眼核心，【目标架构】）

### 8.1 统计表达式

```
P(S[t+1] = j | S[t] = i, X[t])
```

其中 `X[t]` 可综合：当前目标状态（精度眼）、精度眼特征、广度眼环境、事件冲击（§4.3 `eventState`）、数据质量（§4.3 `dataQuality`）、历史基础迁移率（同一 `(i,j)` 状态对在历史样本中的经验频率）、历史相似状态（在历史序列中寻找与当前 `JointState` 相似度最高的若干历史时刻，参考其后续实际迁移路径）。

### 8.2 红线：样本/校准条件不足时不得称为真实概率

**在真实历史样本、walk-forward 验证和校准条件不满足之前，`P(S[t+1]=j|...)` 不得被称为"真实概率"**——这与 `V1_2_FORECAST_SPEC.md` 已确立的"规则型权重 ≠ 统计概率"红线完全一致，GMKG 只是把这条红线从"三档权重"场景扩展到"状态迁移"场景。

### 8.3 第一阶段（【V1.4可实施最小范围】）只能使用

1. 规则型迁移权重（基于§7.5迁移表的定性合理性打分，类似V1.2十二项因子的规则打分风格，不是统计拟合）；
2. 历史相似状态支持度（在已有历史K线上找相似`JointState`片段，报告"历史上类似情形出现过N次，其中M次在Y时间内进入状态Z"这类**描述性统计**，明确标注样本量，不包装成"概率"）；
3. 人工复核（对§7.5标记的低可能迁移，人工介入判断是否为真实转折或数据异常）；
4. `calibratedProbability` 恒为 `null`（与 `V1_2_FORECAST_SPEC.md`§12"日志中`calibratedProbability`永远为null"红线完全同源，GMKG 延续而非重新发明这条规则）。

### 8.4 迁移记录结构

```ts
interface TransitionRecord {
  fromState: DragonflyStateId;
  toState: DragonflyStateId;
  transitionWeight: number;          // 规则型权重，0-100，非概率
  probabilityStatus: 'rule_based' | 'similarity_based' | 'calibrated';  // 见§8.5
  calibratedProbability: number | null;  // 未满足校准条件前恒为null，红线同§8.2
  sampleSize: number | null;         // 历史相似状态支持度的样本数，rule_based模式下为null
  calibrationVersion: string | null; // 对应哪一版校准流程产出，未校准为null
  evidenceRefs: string[];            // 支持该迁移权重判断的证据引用
}
```

### 8.5 `calibratedProbability` 由 `null` 变为数值的门槛（红线）

只有同时满足以下条件，`calibratedProbability` 才允许从 `null` 变为具体数值（【需服务器架构后实施】，第一阶段不涉及）：

1. 预先定义的最低样本量门槛（具体数值留待历史验证阶段用真实数据标定，本文档不预设数字，呼应V1.2既有"不在数据都没有的情况下伪造看似精确的阈值"原则）；
2. 训练/验证/测试严格按时间顺序切分，完成 walk-forward 验证（不得随机打乱时间序列，呼应`STRATEGY_SPEC.md`§18.3既有原则）；
3. 校准误差（如 Brier Score）达到预先定义的可接受范围；
4. 当前 `algorithmVersion`/`calibrationVersion` 已冻结（版本冻结后才能声称"这一版本的校准结果"，防止"边跑边改还声称已校准"）。

---

## 9. 冲突裁决（融合中枢核心场景，【目标架构】）

### 场景1：广度偏空、精度偏多 → 「逆环境相对强势」

```
识别为：relativeStrengthVsEnvironment = 'stronger_than_environment'
且 environmentPermission ∈ {headwind_for_risk_assets, conflicted}
且 target primaryState ∈ {S1_BREAKOUT_PREP, S2_BULL_EXPANSION}

处理规则：
  不得直接看空（宏观逆风不能凭空推翻已经确认的目标内部多头结构）
  可以：降低多头情景的置信等级；降低ALLOW_EXECUTION类行动许可的上限（见§12 permissionCeiling）
  必须：保存对应的失效条件（若目标内部结构一旦转弱，逆环境强势的论据立即失效，需明确写出失效判据）
```

### 场景2：广度偏多、精度偏空 → 「环境支持但目标正在去杠杆」

```
识别为：environmentPermission = 'supportive_for_risk_assets'
且 target primaryState ∈ {S3_OVERHEATED, S4_DISTRIBUTION, S5_BEAR_EXPANSION}

处理规则：
  允许24H情景偏回撤或震荡（尊重目标内部当前正在发生的去杠杆/回调事实）
  同时允许72H维持"清洗后恢复"的候选轨迹（不因为24H偏空就否定环境支持带来的中期恢复可能性）
  两个时间尺度的情景可以方向不同，不强行合并（呼应§10"短期回撤与中期上涨可以同时成立"要求）
```

### 场景3：环境、目标、迁移三者同向

```
允许提高该情景的置信等级（stateConfidence/regimeConfidence/transitionWeight三者一致时，融合中枢可以给出更高的整体可信度）
但必须继续保留opposingEvidence与invalidationConditions——三者同向不代表"确定"，只代表"当前证据一致"，
不允许因为三者同向就省略反对证据或失效条件字段（这两个字段任何情景下都是必填，哪怕为空数组也要显式声明为空，不能省略字段本身）
```

### 场景4：三者冲突（无法用场景1/2/3归纳的情形）

```
输出：
  state = 'CONFLICTED'（见§7.4 DragonflyStateId的CONFLICTED值，仅融合中枢层面使用）
  actionPermission = 'WAIT'
  waitingForSignals：列出"需要哪些信号变化才能解除CONFLICTED"的具体条件
  invalidationConditions：即使在CONFLICTED状态下，仍需说明什么情况发生会让当前的"等待"判断本身过时

红线：不得为了"每天必须给出一个方向"而强行输出场景1/2/3中的任何一个来掩盖真实的三方冲突——
CONFLICTED和WAIT本身就是合法的、且往往是最诚实的输出，不是"系统失败"或"没做完"，
呼应STRATEGY_SPEC.md既有"不值得下注"的诚实披露传统（decision.opportunityScores.message等既有措辞哲学）。
```

---

## 10. 时间尺度

| 时间尺度 | 定位 | 归属层 |
|---|---|---|
| 15分钟 | 现有 ETH Alpha 执行预测层 | 【v1.3.1已实现】（V1.1决策核心+V1.2预测层） |
| 1小时 | 短期结构层 | 【v1.3.1已实现】（V1.1三周期架构已含1小时结构） |
| 4小时 | 趋势约束层 | 【v1.3.1已实现】（V1.1 HTF状态机） |
| 24小时 | GMKG主要轨迹推演 | 【目标架构】 |
| 72小时 | GMKG中期情景推演 | 【目标架构】 |

**红线**：15m/1h/4h 是 V1.1/V1.2 **已经真实运行**的既有层级，GMKG **不重新定义、不修改**这三个既有时间尺度的算法或数据结构（呼应§1命名消歧的既有代码保护原则）。GMKG 新增的是 24H/72H 两个更长的推演尺度，二者**独立生成、独立验证**，且短期回撤与中期上涨可以同时成立、不强行合并为一个方向（呼应§9场景2）。

24H/72H 每次预测必须生成并独立保存以下字段（【目标架构】，结构参考`V1_2_FORECAST_SPEC.md`§12 `ForecastLogEntry`已确立的"完整到能独立复现"原则）：

```ts
interface LongHorizonForecastLog {
  horizon: '24h' | '72h';
  generatedAt: number;
  primaryState: DragonflyStateId;
  candidateTrajectories: TrajectoryScenarios;   // 见§11.2
  scenarioWeightsOrCalibratedProbability: { weights: Record<string, number>; calibratedProbability: number | null };
  priceZone: { lower: number; upper: number; basis: string[] };
  triggerConditions: string[];
  invalidationConditions: string[];
  // 以下字段生成时恒为null，由未来实际走势回填（不可变快照，见§14）：
  actualOutcome: unknown | null;
  directionAccuracy: boolean | null;
  rangeCoverage: boolean | null;
  mfe: number | null;
  mae: number | null;
  calibrationResult: unknown | null;
}
```

---

## 11. 融合中枢

### 11.1 禁止简单平均，融合权重的现状标注

融合中枢**不能简单平均**各系统输出——环境支持度、目标内部状态、状态迁移权重、事件冲击、数据质量、来源可信度、历史表现、时间尺度、风险边界，这些维度性质不同（有的是状态类枚举、有的是连续值评分、有的是二元冲击标记），简单加权平均会掩盖"哪个维度真正在起作用"。

**可以研究乘法融合**（如各维度作为独立的"折扣因子"相乘，一票否决类维度用接近0的因子体现），但初始的示例权重分配（如环境25%、目标40%、迁移25%、其他10%）**只能标记为待验证初始参数**，**不能称为真实有效权重**——这些数字目前没有任何历史校准依据，只是架构设计阶段用来说明"融合逻辑长什么样"的占位说明，实现时必须在代码注释与日志字段中明确标注 `fusionWeightVersion: 'unvalidated-initial-1'` 这类版本号，防止被误当作"已经调好的生产参数"。

### 11.2 `TrajectoryScenarios`（单眼输出，供融合中枢消费）

```ts
interface TrajectoryScenarios {
  jointStateRef: string;             // 对应JointState快照引用
  baselineScenario: ScenarioDetail;
  upsideScenario: ScenarioDetail;
  downsideScenario: ScenarioDetail;
  transitionWeights: TransitionRecord[];  // 见§8.4
  probabilityStatus: 'rule_based' | 'similarity_based' | 'calibrated';
}

interface ScenarioDetail {
  id: string;
  text: string;
  priceZone: { lower: number; upper: number } | null;
  triggerConditions: string[];
  invalidationConditions: string[];
}
```

### 11.3 融合中枢输入维度清单

环境支持度（`WorldState.environmentPermission`+`regimeConfidence`）、目标内部状态（`TargetState`全量）、状态迁移权重（`TransitionRecord[]`）、事件冲击（`StateFrame.eventState`）、数据质量（`StateFrame.dataQuality`）、来源可信度（§16数据源健康状态的延伸）、历史表现（该算法版本过往校准结果，未校准前为空）、时间尺度（15m/1h/4h/24h/72h 分别处理，不混算）、风险边界（账户侧状态，只读引用，见§2红线3）。

### 11.4 预测结果与行动许可分离（红线复述，落实为两个输出接口）

融合中枢**必须分别输出**：

**A. `ForecastResult`（预测结果）**

```ts
interface ForecastResult {
  instrument: 'BTC' | 'ETH';
  horizon: '15m' | '1h' | '4h' | '24h' | '72h';
  dataCutoffTime: number;
  environmentState: WorldState;
  targetState: TargetState;
  jointState: { environmentRef: string; targetRef: string; combinedAt: number };
  baselineScenario: ScenarioDetail;
  upsideScenario: ScenarioDetail;
  downsideScenario: ScenarioDetail;
  transitionWeights: TransitionRecord[];
  probabilityStatus: 'rule_based' | 'similarity_based' | 'calibrated';
  calibratedProbabilities: Record<string, number | null>;  // 未校准时全部为null，红线同§8.2/§8.5
  priceZones: { baseline: [number, number]; upside: [number, number]; downside: [number, number] };
  invalidationConditions: string[];
  supportingEvidence: string[];
  opposingEvidence: string[];
  dataQuality: FrameDataQuality;
  algorithmVersion: string;
  weightVersion: string;
  datasetVersion: string;
}
```

**B. `ActionPermission`（行动许可）**

```ts
interface ActionPermission {
  decisionPermission: 'OBSERVE' | 'PREPARE' | 'ALLOW_TEST' | 'ALLOW_EXECUTION' | 'WAIT' | 'BLOCKED';
  permissionCeiling: ActionPermission['decisionPermission'];  // 本次理论上限（账户/风控可以往下压，不能突破此上限）
  blockingReasons: string[];
  restrictionReasons: string[];
  waitingForSignals: string[];
  riskConditions: string[];
}
```

**红线**：`ForecastResult` 一旦生成即为该次预测的不可变事实（呼应§2红线3），`ActionPermission` 可以在后续 tick 因账户状态变化而重新评估、重新产出新的许可对象，但**不得**回头修改已生成的 `ForecastResult`——这与 `ForecastResult` 需要更新（如数据到期需要重新算一版）是两回事：更新意味着生成一条**新的** `ForecastResult` 记录（新的 `generatedAt`），而不是原地修改旧记录。

---

## 12. 行动许可与 V1.3.1 兼容映射

GMKG 建议的六档 `decisionPermission` 必须严格映射到 v1.3.1 **已实现**的三分类信号体系（`OBSERVATION`/`WATCHLIST`/`EXECUTABLE`，定义见 `v1_3-trade-gate-diagnostics.js`/`V1_3_1_IMPLEMENTATION_REPORT.md`），**不得**新造一套平行的信号分类绕过既有门控：

| GMKG `decisionPermission` | 映射到 v1.3.1 信号分类 | 映射规则 |
|---|---|---|
| `OBSERVE` | `OBSERVATION` | 只做影子观察，不建立模拟仓位、不占用保证金（v1.3.1既有红线，见`V1_3_1_IMPLEMENTATION_REPORT.md`"安全边界"） |
| `WAIT` | `OBSERVATION` | 同上——`WAIT`本身就是"暂不具备进入交易生命周期条件"的一种 |
| `BLOCKED` | `OBSERVATION` | 同上——被硬性规则否决的情形，必须落入不可交易分类 |
| `PREPARE` | 仅在**创建时**已通过真实交易许可（v1.3.1 `permissionAtCreation`/`eligibleForTrigger`全部满足）才能进入 `WATCHLIST` | 否则仍归 `OBSERVATION` |
| `ALLOW_TEST` | 同上，进入 `WATCHLIST` | 与`PREPARE`适用同一条创建时许可校验规则 |
| `ALLOW_EXECUTION` | 仍必须重新通过 v1.3.1 既有的"当前触发、当前许可、账户风控、反向冷却、数据健康"五项在场校验，才能升级为 `EXECUTABLE` | 只有`EXECUTABLE`允许进入模拟开仓（`autoEngineOpenPosition`/`buildTradeProposal`），GMKG不改变这一唯一入口 |

**红线（逐条对应用户第十二节要求，v1.3.1 现状已如实核实，见§0第3点源码阅读）**：

1. **后续 tick 不能替旧信号补发创建时许可**——v1.3.1 `V1_3_1_IMPLEMENTATION_REPORT.md`"最终安全复审修复"已明确：每条不可变信号快照固化 `eligibleForTrigger`/`permissionAtCreation`/`worthBettingAtCreation`/`hardBlockedAtCreation`/`signalPermissionLevelAtCreation`/`opportunityBlockedAtCreation`，GMKG 的 `decisionPermission` 只是这套既有机制之上的**语义别名**，不重新实现、不允许绕过这些创建时快照字段。
2. **`OBSERVATION` 永久不可触发**——GMKG `OBSERVE`/`WAIT`/`BLOCKED` 映射到的 `OBSERVATION` 分类，其 `lifecycleStatus` 只能是 `OBSERVING`/`OBSERVATION_COMPLETED`（v1.3.1既有约束），不得进入`WAITING_TRIGGER`/`TRIGGERED`交易生命周期。
3. **撮合核心与 `buildTradeProposal` 必须继续独立验证**——`v1_3-paper-trading-core.js` 的 `buildTradeProposal` 函数本身校验 `decision.worthBetting===true`、`scores.blocked===false`、`permission.level==='trend_entry_allowed'` 等硬性条件（已读源码确认，见§0第3点），GMKG 的 `ALLOW_EXECUTION` **不能**替代这次独立校验，只能作为"是否值得尝试调用 `buildTradeProposal`"的上游建议信号,`buildTradeProposal` 自身的校验逻辑是最终防线，必须继续独立运行、不因为GMKG已经给出`ALLOW_EXECUTION`就跳过。
4. **GMKG 不得绕过或削弱任何 v1.3.1 门控**——`processTradeGate()`生产调用链（`recordSignalIfEligible`→`evaluateShadowSignals`→触发升级→`tickAutoEngine`）保持不变，GMKG 只在这条链路的输入侧（提供更丰富的环境/目标/轨迹上下文供未来因子使用，参照§16与未来V1.4的因子扩展设计）和展示侧（`decisionPermission`/`ForecastResult`作为新增的、独立于交易门控之外的展示信息）接入，不修改链路本身。

---

## 13. 最终输出快照示例

以下示例为**架构说明用途**，字段值均为占位示意，**不代表真实预测**，`calibratedProbability`/`scenarioWeight` 明确按未校准状态展示（红线：示例中不得把未校准权重伪装成概率）：

```json
{
  "instrument": "ETH",
  "horizon": "24h",
  "environment": {
    "growthRegime": "expansion",
    "liquidityRegime": "tightening",
    "riskRegime": "risk_on",
    "environmentPermission": "supportive_for_risk_assets",
    "regimeConfidence": 62
  },
  "target": {
    "primaryState": "S2_BULL_EXPANSION",
    "secondaryState": "S3_OVERHEATED",
    "stateConfidence": 55,
    "spotVsLeverageDriver": "mixed",
    "trendHealth": "fragile"
  },
  "trajectory": {
    "baselineScenario": { "id": "CONTINUATION_WITH_COOLING", "text": "延续上行但杠杆指标提示需警惕透支，规则型权重支持震荡上探" },
    "upsideScenario": { "id": "BREAKOUT_CONTINUATION", "text": "若现货驱动持续增强，可能延续突破" },
    "downsideScenario": { "id": "LEVERAGE_UNWIND_PULLBACK", "text": "若资金费率/OI回落，可能出现去杠杆回调" }
  },
  "probabilityStatus": "rule_based",
  "scenarioWeight": { "baseline": 45, "upside": 30, "downside": 25, "note": "规则型情景权重，非统计概率，未经历史校准" },
  "calibratedProbability": null,
  "priceZone": { "baseline": [3180, 3320], "upside": [3320, 3480], "downside": [3020, 3180] },
  "invalidConditions": [
    "跌破24H基线区间下沿且已收盘确认，视为baseline情景失效",
    "资金费率/OI在数据可得时若同步转向下降超过设定阈值，视为upside情景证据减弱"
  ],
  "actionPermission": {
    "decisionPermission": "PREPARE",
    "permissionCeiling": "ALLOW_TEST",
    "blockingReasons": [],
    "restrictionReasons": ["24H时间尺度尚未完成历史校准，permissionCeiling不上调至ALLOW_EXECUTION"],
    "waitingForSignals": ["等待15m/1h/4h既有V1.1决策核心给出当前触发确认"],
    "riskConditions": ["账户当前风险档位：正常（本字段只读引用，不反向影响本次trajectory计算）"]
  },
  "nextObservation": "下一个5分钟状态帧 / 下一次15分钟K线收盘",
  "dataQuality": { "completenessRatio": 0.42, "freshnessSummary": "delayed", "staleFieldCount": 138, "missingFieldCount": 96 },
  "sourceTimestamps": { "note": "示例简化，正式实现须逐字段列出sourceVersions（见§4.3 StateFrame.sourceVersions）" },
  "algorithmVersion": "gmkg-draft-1-unimplemented",
  "weightVersion": "gmkg-fusion-weights-unvalidated-initial-1",
  "datasetVersion": "gmkg-dataset-not-yet-collected"
}
```

**红线核对**：本示例 `dataQuality.completenessRatio=0.42` 刻意设置为低值，用以提醒——在广度眼/精度眼240+48项目标指标尚未实际接入前，任何真实运行都会得到类似的低完整度结果，`decisionPermission` 因而只能停留在 `PREPARE` 而非 `ALLOW_EXECUTION`，这正是§16现实边界要诚实反映的当前状态。

---

## 14. 验证和学习闭环

### 14.1 不可变快照（每次正式预测必须保存）

呼应 `V1_2_FORECAST_SPEC.md`§12 已确立的"日志必须完整到能独立复现"原则，GMKG 每次正式预测的快照必须包含：当时广度指标状态（`WorldState`全量）、当时精度指标状态（`TargetState`全量）、原始数据引用（不存原始数据本身，存引用，参照`ForecastLogEntry.closedKlineRef`既有模式）、数据截止时间、当前环境状态、当前目标状态、联合状态、候选迁移（`TransitionRecord[]`）、情景权重、校准状态、预计价格区间、触发条件、失效条件、24H实际结果、72H实际结果、误差归因、算法版本、权重版本、数据集版本。

**红线**：原始预测**不可被后续结果覆盖**——`ForecastResult`生成后是冻结记录，`actualOutcome`/`directionAccuracy`/`rangeCoverage`/`mfe`/`mae`/`calibrationResult`等"事后才能知道"的字段，生成时恒为 `null`，**必须通过独立的追加事件回填**（新增一条关联记录，通过 `predictionId` 外键关联，而不是原地修改原快照的字段值），这是防止"用后来的结果反向篡改历史预测"的结构性保证,与`V1_3_PAPER_TRADING_SPEC.md`"建仓快照冻结"、`V1_2_FORECAST_SPEC.md`§12.2"版本号红线"是同一类工程哲学的延伸。

### 14.2 学习闭环流程

```
预测 → 实际结果 → 误差归因 → 更新迁移模型 → 更新融合权重 → 新版本冻结 → 下一轮Walk-forward验证
```

**红线**：**不得根据单次结果立即修改模型**——闭环中"更新迁移模型"/"更新融合权重"必须积累到预先定义的最低样本量、经过 walk-forward 重新验证后才能冻结为新版本（`algorithmVersion`/`weightVersion`/`calibrationVersion` 递增），单次预测对错不构成修改模型参数的充分理由,这条红线与 §8.5 "`calibratedProbability`何时从null变为数值"的门槛条件是同一套纪律的两个应用场景。

---

## 15. 误差归因

### 15.1 可能来源清单

广度眼环境识别错误、精度眼目标状态错误、单眼迁移预测错误、融合权重错误、行动许可错误、价格区间错误、数据缺失或延迟、数据修订、突发外生事件、执行和风险参数错误。

### 15.2 归因结构

```ts
interface ErrorAttribution {
  predictionId: string;
  primaryCause: 'environment_misread' | 'target_state_misread' | 'transition_misread'
    | 'fusion_weight_error' | 'action_permission_error' | 'price_zone_error'
    | 'data_missing_or_delayed' | 'data_revision' | 'exogenous_shock' | 'execution_or_risk_param_error';
  secondaryCauses: ErrorAttribution['primaryCause'][];
  attributionEvidence: string[];
  attributionConfidence: number;   // 0-100
  requiresHumanReview: boolean;
}
```

### 15.3 红线：归因规则必须结果发生前预先定义

**必须在结果发生前定义归因规则，防止事后解释**——`primaryCause`的判定逻辑（如"若`actualOutcome`落在`downsideScenario.priceZone`内且`environment.environmentPermission`为`supportive_for_risk_assets`，则倾向判定`primaryCause='target_state_misread'`或`'transition_misread'`而非`'environment_misread'`"）必须在 GMKG 迁移模型/融合权重被冻结的同一版本中一并冻结，**不得**在看到实际结果之后才现场决定"这次算谁的锅"。**不得事后凭感觉强迫只选择一只眼作为错误来源**——`secondaryCauses`允许为空但`primaryCause`判定逻辑本身必须是预先规则化的，多因同时成立时如实并列在`secondaryCauses`。

---

## 16. 架构现实和实施边界（红线，防止过度承诺）

### 16.1 当前 v1.3.1 现状

当前 v1.3.1 是**单文件 HTML**（`eth-dynamic-trading-dashboard.html`，由 `work/build-v1.js` 从 `v1-core.js`/`v1_2-forecast-core.js`/`v1_3-*.js` 等纯函数模块构建），主要使用 **Binance 公开现货 REST 六路 K 线**（ETH/BTC × 15m/1h/4h）。运行时依赖用户浏览器保持页面打开进行定时轮询，不存在常驻服务端进程。

### 16.2 当前架构不能完整承担的能力

- 40—60个权威数据源的持续采集与授权管理；
- 逐笔成交与订单簿的历史采集（高频数据无法在浏览器定时轮询模式下完整捕获，且页面关闭即停止）；
- 24小时连续运行（单文件HTML关闭后无法持续采集或推演，这是当前架构最根本的限制）；
- 大规模历史数据库（历史K线本身可反复从Binance拉取，但衍生品/宏观/链上历史数据的持续积累需要持久化存储）；
- 数据修订版本管理（如 FRED/ALFRED 式的"首次发布值 vs 修订值"追踪）；
- §4.3 `StateFrame`/§7 `TargetState`/§11 `TrajectoryScenarios` 等状态仓库的持久化；
- 模型训练（迁移权重/融合权重的历史拟合与校准）；
- 全量 walk-forward 验证（需要长时间批量计算，不适合塞进需要双击打开的单文件页面，呼应`STRATEGY_SPEC.md`§18.5既有"V2历史验证引擎不要求单文件"的既定结论）；
- 多来源授权管理（不同数据商的API条款、速率限制、再分发限制需要集中管理）。

### 16.3 完整 GMKG 需要的后续服务器架构（【需服务器架构后实施】）

数据采集服务、原始数据仓库（不可变存储）、特征与状态存储（对应§4.3 `StateFrame`的持久化）、事件存储（对应§4.3 `eventState`的新闻/事件时间戳库）、预测快照存储（对应§14不可变快照）、历史回放（对应§8.5 walk-forward验证）、验证和校准服务（对应§8.5/§14.2学习闭环）、API（供前端展示层读取）、前端展示层。

### 16.4 当前 HTML 的未来定位

当前 HTML **未来可以作为展示与人工验证终端**（读取后端API展示`ForecastResult`/`ActionPermission`，或在服务器架构就绪前作为本地备用端继续运行现有V1.1-V1.3.1功能），**不应继续承担全部采集、存储和训练职责**——这条边界与用户此前在其他版本规划中反复确认的"静态HTML只作展示端和本地备用端"原则完全一致。

---

## 17. V1.4 最小可验证范围建议

本节只提出建议范围，**不创建六份V1.4实施文档，不开始编码**，具体六份文档的撰写留待 CEO 另行批准后启动。

### 17.1 V1.4 必须实现（【V1.4可实施最小范围】）

1. 四系统接口的**类型定义**（`WorldState`/`TargetState`/`TrajectoryScenarios`/`ForecastResult`/`ActionPermission`的TypeScript接口，作为纯规范，不要求所有字段都有真实数据源支撑）；
2. 统一状态帧格式（§4.3 `StateFrame`结构定义，允许多数字段初期为空/`missing`，只要求结构存在）；
3. 数据时间和质量契约（`asOfTime`/`receivedAt`/`staleFields`/`missingFields`/`revisedFields`的写入规则，即使当前只有Binance K线一个数据源，也要按此契约记录，为未来扩展预留一致的写入习惯）；
4. 八状态可计算定义初稿（§7 状态判定逻辑用**当前已有的Binance K线特征**（A组：价格与成交结构）先实现一个粗糙版本，明确标注"仅用A组特征，B-G组数据缺失，`stateConfidence`应相应保守"）；
5. 迁移记录结构（§8.4 `TransitionRecord`结构落地为可写入的日志格式，初期只产出`probabilityStatus='rule_based'`的记录）；
6. 历史预测不可变快照（§14.1结构落地，`predictionId`+冻结字段+null占位的未来结果字段）；
7. 实际结果回填（独立的回填函数/流程，只追加不覆盖，对应§14.1红线）；
8. 误差归因结构（§15.2结构落地为可写入的日志格式，初期允许`primaryCause`判定规则很粗糙，但规则本身必须先定义、随代码一起冻结）；
9. Walk-forward验证基础（哪怕数据量很小，也要先把"按时间切分、不随机打乱"的验证脚手架搭起来，为未来扩大数据量做准备）；
10. 规则权重与校准概率隔离（贯穿以上所有结构，`calibratedProbability`/`calibrationVersion`等字段全部预先占位为`null`，与`V1_2_FORECAST_SPEC.md`既有红线完全同源）；
11. 使用当前Binance数据运行最小闭环（用A组价格/成交特征跑通"预测→（等待）实际结果→误差归因→（暂不更新模型）"这条链路的**端到端存在性**，不追求准确率，只追求"闭环本身能跑通、数据不泄漏、快照不可变"这几条结构性要求）；
12. 为未来240+48项数据预留接口（`WorldState`/`TargetState`的字段结构提前按§5/§6定义好，即使多数字段初期为`null`/`missing`）。

### 17.2 V1.4 只预留接口（不实现真实数据接入）

§5 12个数据域约240项指标的绝大多数、§6 B-G组48项中除A组以外的全部——这些字段在类型定义中存在，运行时允许长期为`missing`，**不阻塞**当前基于K线的最小闭环运行。

### 17.3 服务器版本实现（本轮及V1.4均不涉及）

§16.3列出的全部服务器架构组件；24H/72H两个新增时间尺度的真正历史校准（需要足够长的历史数据积累周期，不可能在V1.4阶段完成）；乘法融合权重的实际拟合（§11.1"待验证初始参数"转正需要真实历史校准，这本身就是服务器版本的工作）。

### 17.4 仍需研究的数据源

§5的12个数据域绝大多数具体数据源、§6 B-G组的OKX/CoinGlass/Deribit/Glassnode/Coin Metrics等——具体每项的官方API/免费额度/速率限制/CORS/授权条款需要专门的数据源研究阶段核实（参照此前V1.4数据层规划已经建立的研究方法论，本文档不重复展开逐项核实工作，那是独立的数据源矩阵文档的职责）。

---

## 18. 安全边界（重申，贯穿全文，本节做最终汇总）

继续禁止：真实交易；连接交易所账户；读取API密钥或私钥；发送订单；盈利保证；伪造概率（`calibratedProbability`未满足§8.5门槛前恒为null）；使用未来数据（§4.4/§8.2/§14.1数据泄漏防线）；覆盖历史预测（§14.1不可变快照红线）；削弱v1.3.1门控（§12逐条映射红线）；把候选数据源写成已经接入（全文【标注】体系的存在意义）；把目标架构写成当前已实现功能（同上）。

---

## 19. 文档完成后自检

| # | 自检项 | 结论 |
|---|---|---|
| 1 | 四系统职责是否互不重叠 | 通过——见§3非重叠性核对表，输入输出严格单向串联 |
| 2 | 预测融合与行动许可是否分离 | 通过——见§11.4 `ForecastResult`/`ActionPermission`两个独立接口 |
| 3 | 240和48项是否标记为目标架构 | 通过——§5/§6开篇均有【目标架构】/【仍需研究/授权/付费】现实标注 |
| 4 | 300帧是否包含as-of时间和数据质量 | 通过——见§4.3 `StateFrame.asOfTime`/`receivedAt`/`dataQuality`/`sourceVersions` |
| 5 | 八状态是否具备可计算方向 | 通过——见§7.1每状态的必要/加分/否决条件与阈值类型，§7.5迁移表 |
| 6 | 规则权重是否与概率严格分离 | 通过——见§8.2/§8.5/§11.1/§13示例，`calibratedProbability`全文恒为null（未校准场景） |
| 7 | 24H和72H是否独立验证 | 通过——见§10 `LongHorizonForecastLog`独立结构，§9场景2允许方向不同 |
| 8 | 冲突状态是否允许WAIT | 通过——见§9场景4 `CONFLICTED`/`WAIT`/`waitingForSignals` |
| 9 | 误差归因是否防止事后解释 | 通过——见§15.3"归因规则必须结果发生前预先定义" |
| 10 | 是否保留v1.3.1全部安全门控 | 通过——见§12逐条映射红线1-4，源码已核实（`buildTradeProposal`/`processTradeGate`/信号快照字段） |
| 11 | 是否诚实说明单文件HTML限制 | 通过——见§16.1-16.2 |
| 12 | 是否明确V1.4最小范围 | 通过——见§17.1-17.4 |
| 13 | 是否没有修改业务代码 | 通过——本轮只新增本文档一个文件，未修改任何HTML/JS/测试文件 |

---

## 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| gmkg-draft-1 | 2026-07-17 | 初稿：冻结GMKG四系统核心原则、命名消歧（与既有蜻蜓捕猎模型区分）、360度/300帧工程定义、广度眼12域240项、精度眼48项、单眼八状态模型、迁移模型与概率红线、冲突裁决四场景、时间尺度、融合中枢双输出、与v1.3.1行动许可兼容映射、最终输出快照示例、验证学习闭环、误差归因、架构现实边界、V1.4最小范围建议、安全边界与自检 |
