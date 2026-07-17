# GMKG_DRAGONFLY_ARCHITECTURE.md — ETH Alpha GMKG「蜻蜓复眼」总架构规范

版本：gmkg-draft-3（CEO第二轮复审关闭新P0×2/新P1×5后的修订版，见文末变更记录）
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
3. **账户余额、保证金、冷却和模拟交易风控不得反向修改原始轨迹预测**——`TrajectoryScenarios`、`baselineScenario`/`upsideScenario`/`downsideScenario`、`transitionWeights`、`calibratedProbability` 一旦由单眼和融合中枢的预测环节生成，就是该次预测的**不可变事实**（呼应 `V1_3_PAPER_TRADING_SPEC.md`"建仓快照冻结不可被后续刷新覆盖"、`V1_2_FORECAST_SPEC.md`§12"日志必须完整到能独立复现"的既有设计哲学）。账户当前净值不够、处于冷却期、回撤锁定中，这些账户侧状态**只能影响 `ActionPermission`**（比如把 `gateStatus` 压低为 `WAIT`/`BLOCKED`，见§11.4 `readinessLevel`/`gateStatus`正交拆分），**绝不能**倒过来改写 `TrajectoryScenarios` 里已经算出的情景权重或价格区域——账户没钱和"ETH接下来会怎么走"是两件完全不相关的事，混在一起会让预测系统的历史校准彻底失去意义（校准要问的是"这套算法预测得准不准"，如果预测结果会被账户状态污染，校准出来的准确率就不再反映算法本身）。

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

- 对 24 小时推演窗口，**每 5 分钟形成一个完整状态切片**（`StateFrame`），24 小时 = 288 个常规切片，**时间栅格固定不变**（P1-3修订：不因任何事件而拉伸或跳步，详见§4.5）。
- 在常规切片之外，**重大宏观/政策/监管/地缘事件独立保存为 `EventSnapshot`**（拥有自己的时间戳体系，不占用 `StateFrame` 的帧序号，见§4.5），一天内通常有个位数到十几条，与288个常规帧合计构成约300个"状态上下文"体量——**这是两条独立存储、独立计数的平行序列的体量总和，不是把事件插入拼接成单一300步序列**（P1-3修订，纠正draft-1"额外插入事件快照帧"的表述）。
- **不是**"每秒300次"这种高频轮询定义，**不是**"300根普通K线"这种单一时间粒度K线定义——是"覆盖 24 小时、粒度固定到 5 分钟的常规序列 + 独立存储的事件序列"两者体量之和。
- 订单簿、逐笔成交、爆仓等高频数据（原始频率远高于5分钟）**必须先在帧内聚合**（如："过去5分钟内订单簿失衡的均值/极值""过去5分钟内是否发生强平簇"），不得把原始逐笔数据直接塞进帧对象，帧对象存的是聚合后的特征值，不是原始流水。

### 4.3 `DataVintageRef`：逐指标时间与版本契约（P0-1修订，唯一权威定义）

**P0-1 red line 背景**：draft-1 的 `sourceVersions: Record<string, { asOf, fetchedAt, sourceId }>` 只有两个时间戳，无法区分"数据描述的是哪个时期""来源何时正式发布""系统何时正常应该能拿到""系统实际何时抓到""这是第几次修订"——这五件事混在 `asOf`/`fetchedAt` 两个字段里，无法支撑 walk-forward 防泄漏，必须拆开。以下 `DataVintageRef` 取代 draft-1 的 `sourceVersions` 值类型，是本节唯一权威定义：

```ts
interface DataVintageRef {
  fieldId: string;                 // 对应WorldState/TargetState中的具体字段名，如'growthRegime'的某个原始输入'us_gdp_qoq'
  observationPeriod: string;       // 数据描述的经济或市场时期，如'2026-Q2'（季度GDP所属季度）、'2026-06-17T15:00Z/15m'（一根15分钟K线所属区间）；不是发布时间，是"这个数字讲的是哪一段现实"
  publishedAt: number | null;      // 来源正式发布时间（ms epoch）。K线收盘这类"生成即公开"的数据，publishedAt=该K线closeTime；宏观数据的publishedAt=官方发布日历时刻；本身无独立发布仪式的数据（如逐笔成交流）可为null，须在字段说明中注明原因
  availableAt: number;             // 系统在当时正常条件下首次能够使用该值的时间：>= publishedAt，两者之差是"正常已知的分发延迟"（如交易所K线publishedAt到availableAt通常几乎为0；官方宏观数据从publishedAt到"聚合站/API能查到"通常有固定延迟，须按数据源实测记录，不得假设为0）
  firstAvailableAt: number;        // 该observationPeriod对应的值，第一次被本系统采集到的时间；后续无论出现多少次修订，这个时间戳永远不变，是该observationPeriod在本系统历史上的"首次亮相"锚点
  fetchedAt: number;               // 本次实际抓取/写入时间（可能晚于availableAt，如采集器故障延迟补抓）
  revisionNumber: number;          // 从0开始：0=该observationPeriod的首次发布值，1/2/...=第N次修订值
  vintageId: string;               // 唯一标识"某个observationPeriod + 某个revisionNumber"的具体版本，如'US-GDP-2026Q2-rev1'；同一vintageId在系统中永远对应同一个数值，不会被覆盖
  sourceId: string;
  sourceRef: string;               // 权威采集所有者标识，供§6.4数据所有权核对表跨系统去重引用（同一份原始数据无论被WorldState还是TargetState引用，sourceRef必须相同）
}
```

**红线（walk-forward 防泄漏，最高优先级）**：**历史 walk-forward 验证在任意历史时刻 `forecastCreatedAt` 回放时，只能使用满足 `availableAt <= forecastCreatedAt` 的 `DataVintageRef` 版本**——即使某个 `observationPeriod` 后来出现了修订版本（`revisionNumber` 更高），只要该修订版本的 `availableAt` 晚于 `forecastCreatedAt`，回放时就**必须**使用修订之前、`availableAt` 更早的那个 `vintageId`，**不得**用"事后才知道的、更准确的修订值"去解释历史上那一刻本来就不可能知道的信息。**后续修订值不得回填覆盖历史时刻当时可知的初始值**——`firstAvailableAt`/`revisionNumber=0`版本一旦写入即永久保留，新修订只追加新的 `vintageId`（`revisionNumber+1`），不修改旧 `vintageId` 对应的数值。

**事件/新闻同样适用本节时间契约**（对应§4.5 `EventSnapshot`）：`eventOccurredAt`（事件实际发生时刻）对应本节 `observationPeriod` 的角色，`publishedAt`/`availableAt`/`receivedAt` 定义与本节一致，不另立一套时间语义。

### 4.4 `StateFrame` 统一状态帧结构（【目标架构】唯一权威定义）

```ts
interface StateFrame {
  frameId: string;                 // 唯一标识，如 `F-{unixMs}`；事件不再复用本id空间，见§4.5 EventSnapshot独立标识
  timestamp: number;                // 该帧代表的逻辑时刻，固定5分钟栅格对齐点，ms epoch（红线：帧序列本身的时间步长恒定不变，见§4.5）
  asOfTime: number;                 // 帧级兜底基准：本帧组装时使用的"数据截止时间"上限（逐指标精确版本见sourceVersions）
  receivedAt: number;                // 该帧完成组装、系统实际生成完毕的时间（ms epoch），用于区分"数据代表的时刻"与"数据到手的时刻"
  environmentState: WorldState;      // §5 广度眼输出（压缩后的环境状态，非240项原始值）
  btcTargetState: TargetState;       // §6 精度眼输出（BTC）
  ethTargetState: TargetState;       // §6 精度眼输出（ETH）
  liquidityState: object;            // 订单簿/流动性相关聚合特征（帧内聚合，非逐笔）
  riskState: object;                 // 衍生品/杠杆/挤压相关聚合特征
  positionState: object;             // 账户侧状态快照引用（只读引用，不参与轨迹预测计算，呼应§2红线3）
  derivativesState: object;          // 资金费率/OI/多空比等衍生品状态（帧内聚合）
  eventState: { activeEventRefs: string[] };  // 本帧时间窗口内影响仍在生效的EventSnapshot引用列表（只存引用id，不内嵌事件内容，见§4.5）
  dataQuality: FrameDataQuality;     // 见下
  sourceVersions: Record<string, DataVintageRef>;  // 逐指标的完整时间/版本契约，见§4.3
  staleFields: string[];             // 本帧中使用了"沿用上一次已知vintage"（非本帧新产生vintage）的字段列表
  missingFields: string[];           // 本帧完全缺失、未填充任何值的字段列表
  revisedFields: string[];           // 本帧发现的、指向§4.3.1 DataRevisionEvent.revisionEventId的引用列表（只存引用，不在本帧内内嵌旧值/新值，见下方红线）
}

interface FrameDataQuality {
  completenessRatio: number;   // 0-1，本帧非缺失字段占比（粗粒度帧级指标，不得单独驱动行动许可，须结合§6.4a FeatureCompleteness的criticalFeatureCompleteness）
  freshnessSummary: 'fresh' | 'delayed' | 'stale';  // 复用 STRATEGY_SPEC.md §14.7 已确立的三级模型语义，不新造枚举
  staleFieldCount: number;
  missingFieldCount: number;
  revisedFieldCount: number;
}
```

#### 4.3.1 `DataRevisionEvent`：修订必须追加，不得改写旧帧（红线）

```ts
interface DataRevisionEvent {
  revisionEventId: string;
  fieldId: string;
  observationPeriod: string;
  previousVintageId: string;
  newVintageId: string;
  previousValue: unknown;
  newValue: unknown;
  revisionNumber: number;     // = newVintageId对应的revisionNumber
  detectedAt: number;         // 系统发现这次修订的时间（不是数据被修订的时间，是"系统发现"的时间，两者可能有滞后）
}
```

**红线（P0-1核心诉求）**：当采集器发现某个 `observationPeriod` 出现新版本时，**只追加一条 `DataRevisionEvent`，不修改任何历史上已生成的 `StateFrame`**——已生成的 `StateFrame.sourceVersions[fieldId]` 永远指向该帧生成时刻实际使用的 `vintageId`，即使后来出现修订，旧帧记录原样保留（这本身就是历史真相的一部分：那一刻系统看到的就是那个值）。**只有新生成的 `StateFrame`（`timestamp` 晚于修订被发现之后）才会在 `sourceVersions` 中使用新的 `vintageId`**，并在自己的 `revisedFields` 中记录对应 `revisionEventId` 引用，说明"本帧知道这个字段近期发生过修订"。

### 4.4a 更新频率异构性（红线，必须在帧结构与实现文档中反复强调）

GDP/CPI/PMI 是月度或季度频率，ETF净流量是日频（美股收盘后披露），链上数据是分钟到小时级，订单簿是逐笔/秒级。**每个 5 分钟状态帧保存的是"该时刻可以获得的最新状态"，不是"所有指标每 5 分钟都产生新值"**——一个月度 GDP 指标在同一个月内的 8640 个5分钟帧（30天×288帧/天）里，`sourceVersions.gdp.vintageId` 会长期指向同一个版本，这是**正确行为**，不是系统故障；实现时必须用 `staleFields`/`sourceVersions[...].fetchedAt` 如实反映这种"沿用"状态，**禁止**因为帧结构要求"每帧都有值"就伪造月度指标每5分钟都变化的假象——这是防止未来数据泄漏与自我欺骗式"数据完整度"的第一道工程防线，直接呼应§14验证闭环对"不可变快照"的要求。

### 4.5 事件快照与固定时间栅格分离（P1-3修订）

**P1-3 red line 背景**：draft-1 §4.2 曾把"重大事件发生时刻额外插入事件快照帧"表述为拼接进同一个288帧序列、凑成"约300个状态上下文"，这会让5分钟固定栅格与事件触发的不规则时刻被误当成同等的"一步"，污染迁移模型的时间间隔假设。修订为：

```
5分钟 StateFrame 序列（288帧/24H）是唯一的基础时间栅格，步长固定，永不因事件插入而改变或拉伸。
EventSnapshot 独立保存，拥有自己的时间戳体系（eventOccurredAt/publishedAt/availableAt/receivedAt），
  不占用StateFrame.frameId空间，不算作288帧序列中的"第289帧"。
EventSnapshot 通过 StateFrame.eventState.activeEventRefs 这个引用列表附着到其影响窗口覆盖到的常规帧上——
  是"常规帧知道有这件事在影响自己"，不是"事件本身变成了一个特殊的帧"。
如果需要在事件发生的即时时刻做额外的推演（如FOMC决议公布瞬间想立刻重新评估），
  可以生成一次 event-triggered forecast（复用§10 ForecastSnapshot结构，generatedAt=事件触发时刻），
  但这只是"额外多生成了一次预测快照"，不改变、不插入、不拉伸288帧基础序列本身。
"约300个状态上下文"这一说法，准确含义是：24H窗口内约288个常规5分钟帧 + 当日发生的EventSnapshot（通常个位数到十几个），
  两者是分别独立计数、独立存储的两条平行序列，合计的"上下文总量"大致在300量级，不是单一300步序列。
```

```ts
interface EventSnapshot {
  eventId: string;
  eventOccurredAt: number;      // 事件实际发生时刻
  publishedAt: number;          // 该事件被公开报道/官方发布的时刻
  availableAt: number;          // 系统在当时正常条件下首次可获知该事件的时间
  receivedAt: number;           // 系统实际记录/录入该事件的时间
  eventType: string;
  description: string;
  impactWindow: { from: number; to: number } | null;   // 该事件被认为仍在影响市场的时间窗口，供StateFrame.eventState引用匹配
}
```

**状态迁移必须记录真实经过时间（红线）**：`FormalTransitionRecord`/`ProxyTransitionRecord`（§8.4，两者均含此字段）新增 `elapsedTimeMs` 字段，记录 `fromState`/`fromProxyState` 判定时刻到 `toState`/`toProxyState` 判定时刻之间的**真实经过时间**，不得假设固定5分钟步长——一次事件触发的即时重算（`event-triggered forecast`）可能在远小于5分钟的时间内产生新的状态判定，若把它当作与常规5分钟帧等长的"一步"处理，会让迁移模型的时间尺度假设失真。

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

### 6.3 `TargetState` 最小字段集（供 §7 八状态判定消费，P0-3/P1-1/P1-2修订）

**类型拆分（P1-1修订，红线）**：`TargetState.primaryState`/`secondaryState` **只能使用 `TargetStateId`（S0-S7 + `UNKNOWN`）**，**不得**包含 `CONFLICTED`——`CONFLICTED` 是融合中枢层面综合广度眼/精度眼/迁移三方之后才可能出现的判断（见§9场景4），不是精度眼单独判定目标自身状态时会用到的值，两者类型上必须分离：

```ts
type FormalStateId =    // P0-NEW-1修订：拆出纯S0-S7子集，不含UNKNOWN，专供§8.4 FormalTransitionRecord使用
  | 'S0_ACCUMULATION' | 'S1_BREAKOUT_PREP' | 'S2_BULL_EXPANSION' | 'S3_OVERHEATED'
  | 'S4_DISTRIBUTION' | 'S5_BEAR_EXPANSION' | 'S6_CAPITULATION' | 'S7_REPAIR_RANGE';

type TargetStateId = FormalStateId | 'UNKNOWN';   // 数据不足以给出任何S0-S7正式判定时使用（见§7.0a INSUFFICIENT_DATA/PRICE_ONLY_MODE规则），'UNKNOWN'不是"第9个正式状态"

type FusionStateId = TargetStateId | 'CONFLICTED';   // 仅融合中枢（§9/§13）使用，精度眼/单眼输出禁止使用此类型
```

**运行模式类型（P0-3修订，定义见§7.0a）**：

```ts
type OperatingMode = 'FULL_STATE_MODE' | 'PRICE_ONLY_MODE' | 'INSUFFICIENT_DATA';

type PriceOnlyStateId =   // PRICE_ONLY_MODE下的代理标签，与TargetStateId严格分离，禁止混用（见§7.0a）
  | 'PO_RANGE_LOW_STRUCTURE' | 'PO_BREAKOUT_UP_STRUCTURE' | 'PO_TREND_UP_STRUCTURE' | 'PO_STALL_HIGH_STRUCTURE'
  | 'PO_BREAKDOWN_STRUCTURE' | 'PO_TREND_DOWN_STRUCTURE' | 'PO_SHARP_DROP_STRUCTURE' | 'PO_RANGE_RECOVERY_STRUCTURE'
  | 'PO_UNKNOWN';
```

```ts
interface TargetState {
  symbol: 'BTC' | 'ETH';
  operatingMode: OperatingMode;          // 见§7.0a，决定以下字段应读primaryState还是proxyState
  primaryState: TargetStateId;           // 只有operatingMode='FULL_STATE_MODE'时才可能是S0-S7中的具体值；PRICE_ONLY_MODE/INSUFFICIENT_DATA下恒为'UNKNOWN'，不得借本字段偷偷输出未经FULL_STATE_MODE验证的正式状态
  secondaryState: TargetStateId | null;  // 仅FULL_STATE_MODE下可能非null
  candidateStates: TargetStateId[];      // INSUFFICIENT_DATA下列出"数据不足以排除的候选状态"；其余模式下为空数组
  proxyState: PriceOnlyStateId | null;   // 仅PRICE_ONLY_MODE下非null，见§7.0a；FULL_STATE_MODE/INSUFFICIENT_DATA下恒为null
  stateConfidence: number;               // 0-100，规则内部一致性代理，非统计概率；PRICE_ONLY_MODE/INSUFFICIENT_DATA下必须显著低于同等证据强度在FULL_STATE_MODE下的取值
  stateEvidence: string[];
  opposingEvidence: string[];
  spotVsLeverageDriver: 'spot_led' | 'leverage_led' | 'mixed' | 'insufficient_data';
  trendHealth: 'healthy' | 'fragile' | 'exhausted' | 'insufficient_data';
  keyLevels: { support: number[]; resistance: number[] };  // 复用既有支撑压力算法，不重算
  relativeStrengthVsEnvironment: 'stronger_than_environment' | 'aligned_with_environment' | 'weaker_than_environment';
  featureCompleteness: FeatureCompleteness;   // 见下，P1-2修订，取代draft-1单一的dataCompleteness数字
  dataAsOf: number;
}

interface FeatureCompleteness {
  activeProfile: OperatingMode;
  profileCompleteness: number;            // 0-1，相对当前activeProfile实际需要的字段集合的完整度；PRICE_ONLY_MODE下只对A组6项计算，可以合理地很高，不代表"数据齐全"
  fullArchitectureCompleteness: number;    // 0-1，相对全部48项目标指标(A-G组)的完整度；PRICE_ONLY_MODE下必须如实很低，不得因activeProfile切换而显得"正常"
  criticalFeatureCompleteness: number;     // 0-1，相对"当前activeProfile下作出该次判定所必须的关键特征子集"的完整度——行动许可与stateConfidence必须主要参考这个数字，不得直接用fullArchitectureCompleteness长期压低所有结果（见红线）
  missingCriticalFeatures: string[];
}
```

**红线（P1-2）**：`fullArchitectureCompleteness` 长期偏低（因为 B-G 组【仍需研究/授权/付费】，见§6.1）是**当前阶段的正常状态，不是异常**——`ActionPermission`（§11.4/§12）与 `stateConfidence` 的计算**必须**以 `criticalFeatureCompleteness` 为主要依据，**不得**让一个"目前根本不计划接入"的 D/F 组指标缺失，永久性地把 `PRICE_ONLY_MODE` 下本来数据完整的 A 组判定也拖到"数据不足"的许可等级——那样会让系统在可预见的很长时间内对任何请求都只能给出最低许可，丧失实用性，也掩盖了"A组信息其实是完整的"这一事实。

### 6.4 与广度眼数据所有权重叠核对（P1-6修订，红线）

以下8项指标在字面上容易被广度眼（§5）与精度眼（§6）同时采集，必须逐项冻结**唯一权威采集所有者**，其余系统只能引用，不得重复建立采集管线：

| 数据 | 唯一权威采集所有者 | 下游读取方式 | 判定理由 |
|---|---|---|---|
| BTC Dominance | 广度眼（§5第12域"加密广域状态"） | 精度眼G组"加密内部轮动"只读引用广度眼已采集值，不重复采集 | 全市值结构性指标，本质是"广域"范畴 |
| ETH/BTC 比值 | 精度眼（§6 G组"BTC/ETH相对强弱"） | 广度眼`cryptoBroadRegime`如需引用该比值作为轮动佐证，只读引用精度眼已算出的值 | 两个目标资产之间的直接比值，属于"目标内部"范畴，与BTC Dominance相反地划给精度眼 |
| 加密总市值 | 广度眼（§5第12域） | 精度眼不采集，如需引用直接读`WorldState` | 全市场规模性指标 |
| BTC/纳指相对强弱 | 精度眼（§6 G组） | 广度眼`riskRegime`如需引用该相关性作为跨资产联动证据，只读引用精度眼已算值，不独立重算；§5第7域仅采集纳指自身价格，不采集该衍生比值 | 落点是"BTC相对环境是否强势"，属于精度眼职责（呼应§6.2） |
| BTC/DXY相关性 | 精度眼（§6 G组） | 同上；§5第6域仅采集DXY自身，不采集该衍生相关性 | 同上原则：单一资产自身值归广度域，跨资产相关性归精度眼 |
| ETF资金流 | 精度眼（§6 E组"资金进入与退出"） | 广度眼§5第10域"仓位和资金流"采集的是COT报告/共同基金资金流等跨市场仓位数据，定义与BTC/ETH专属ETF净流量不同，两域不构成重叠采集 | 需在实现层核实两域字段定义确实互斥 |
| 稳定币供应和流入 | 精度眼（§6 E组"稳定币流入"），但底层"稳定币总供应"原始数据由§5第12域采集一次 | 精度眼E组"稳定币交易所流入"是该原始数据的细分用途，两者引用同一份"稳定币总供应"原始数据时必须共用同一`sourceRef`（见下） | 本表中最容易"同名不同定义"或"同名同源需去重"的一项，实现时必须逐字段核实 |
| 跨交易所价格 | 精度眼（§6 B组"跨交易所价差"） | 广度眼不采集；若广度眼需要"加密相对传统市场定价"证据，引用精度眼已算好的数据，不重复对接交易所API | BTC/ETH自身在不同场所的报价，属于目标内部数据 |

**规则重申（红线）**：
1. 一个原始数据只能有一个权威采集所有者（上表"唯一权威采集所有者"列即该规则的具体落地）；
2. 其他系统只能通过引用读取或派生，不得独立建立第二条采集管线获取同一份原始数据；
3. **不得重复采集后双重计权**——融合中枢或单眼若同时看到"广度眼环境证据"与"精度眼目标证据"，且两者背后其实源自同一份原始数据，必须通过共享 `sourceRef` 识别为同一手数据的两次引用，只能计一次权重，不得当成两个独立证据源叠加计分；
4. **`WorldState` 和 `TargetState` 使用同一数据时必须记录同一 `sourceRef`**——具体落地为 `StateFrame.sourceVersions`（§4.3 `DataVintageRef.sourceRef`）中，同一份原始数据无论被 `environmentState` 还是 `btcTargetState`/`ethTargetState` 引用，都必须指向同一个 `vintageId`，而不是各自生成一份看似独立的版本记录。

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

### 7.0a 运行模式：`FULL_STATE_MODE` / `PRICE_ONLY_MODE` / `INSUFFICIENT_DATA`（P0-3修订，红线）

**P0-3 red line 背景**：draft-1 §17.1第4条曾写"用A组特征先实现一个粗糙版本的八状态"，这句话本身是错误表述——A组（价格与成交结构，6项，【v1.3.1已实现】）**不足以支撑** S3（需要衍生品/期权极值证据）、S4（需要交易所净流入等资金流证据）、S6（需要强平数据证据）这三个状态的**正式**判定。draft-2 起，单眼/精度眼必须显式声明三种运行模式，禁止在数据不足时伪装成完整八状态：

```
FULL_STATE_MODE：      精度眼48项指标中，§7.0b表格所列"每个状态的最低必要数据组"全部满足时，才允许输出S0-S7中的具体正式状态。
PRICE_ONLY_MODE：      精度眼只有A组（价格与成交结构）数据可用时的运行模式。
  - 不得声称识别Funding、OI、爆仓、订单流、ETF或链上行为——因为根本没有这些数据；
  - 不得正式判定必须依赖这些数据的 S3_OVERHEATED / S4_DISTRIBUTION / S6_CAPITULATION——`primaryState`此时恒为'UNKNOWN'，
    真正可展示的判断只能落在`proxyState`（PriceOnlyStateId）这一独立字段；
  - 所有代理标签必须明确带 PROXY / PRICE_ONLY 语义前缀（`PO_*`），不得复用S0-S7的正式命名；
  - 代理状态不得混入未来FULL_STATE_MODE的正式状态准确率统计分母（见下方统计分组表最后一列）。
INSUFFICIENT_DATA：    连A组自身都不完整（如K线数据健康度非normal）时，`primaryState='UNKNOWN'`，`proxyState=null`，
                       只输出`candidateStates`（列出无法排除的候选S0-S7值），不给出任何单一判定。
```

### 7.0b 逐状态最低数据组要求与降级规则（P0-3修订，红线，逐状态列出）

| 状态 | 最低必要数据组（§6.1 A-G组） | `PRICE_ONLY_MODE`能否正式识别 | 不能时的降级输出 | 统计分组（见§10.x/§14） |
|---|---|---|---|---|
| `S0_ACCUMULATION` | A + C（资金费率反映情绪转平）或 A + F（交易所净流出） | 否（只能代理，无法确认"暗示性证据"部分） | `proxyState='PO_RANGE_LOW_STRUCTURE'` | `PROXY_STATS`分组，不进入`FULL_STATE_STATS`分母 |
| `S1_BREAKOUT_PREP` | A + C（OI变化率/资金费率转向） | 部分可代理（价格结构本身可观察"贴近关键位"，但"动能开始转向"这一必要条件无法验证） | `proxyState='PO_BREAKOUT_UP_STRUCTURE'`或`'PO_BREAKDOWN_STRUCTURE'` | `PROXY_STATS`分组 |
| `S2_BULL_EXPANSION` | A + C（区分现货/杠杆驱动，判断`trendHealth`） | 否（无法确认`spotVsLeverageDriver`，无法排除其实是`S3`） | `proxyState='PO_TREND_UP_STRUCTURE'`，且`stateEvidence`必须注明"无法区分健康扩张与杠杆过热" | `PROXY_STATS`分组 |
| `S3_OVERHEATED` | A + C + D（资金费率/OI/隐含波动率极值） | **否，禁止正式判定**（§7.0a红线） | `proxyState`不单独存在，并入`S2`代理（`PO_TREND_UP_STRUCTURE`）附加高置信度警告文案 | 不产生独立代理标签，计入`S2`代理分组并标注风险 |
| `S4_DISTRIBUTION` | A + E + F（交易所净流入、大户持仓变化） | **否，禁止正式判定** | `proxyState='PO_STALL_HIGH_STRUCTURE'` | `PROXY_STATS`分组 |
| `S5_BEAR_EXPANSION` | A + C（同`S2`对称） | 否 | `proxyState='PO_TREND_DOWN_STRUCTURE'` | `PROXY_STATS`分组 |
| `S6_CAPITULATION` | A + C（强平数据）+ 波动率极值 | **否，禁止正式判定**（§7.0a红线，`S6`本身要求最强证据） | `proxyState='PO_SHARP_DROP_STRUCTURE'`，`stateEvidence`必须注明"仅基于价格结构急跌，未确认强平/杠杆出清" | `PROXY_STATS`分组 |
| `S7_REPAIR_RANGE` | A（价格结构本身即可初步观察，但"无明显方向性资金流"这一加分条件无法验证） | 部分可代理 | `proxyState='PO_RANGE_RECOVERY_STRUCTURE'` | `PROXY_STATS`分组 |

**红线**：只要 `operatingMode≠'FULL_STATE_MODE'`，`TargetState.primaryState` 恒为 `'UNKNOWN'`，**任何实现代码禁止在非 `FULL_STATE_MODE` 下把 `proxyState` 的值直接赋给 `primaryState`**——这是防止"代理判断包装成正式判断"的结构性保证。当前 v1.3.1 基线只有 A 组数据，因此**当前只能运行在 `PRICE_ONLY_MODE`**，本节 §7.1 的详细定义描述的是 `FULL_STATE_MODE` 下的正式判定规则，供未来 B-G 组数据到位后使用，**不代表现在就能产出这些正式状态**（呼应§17.1第4条已修正表述）。

### 7.1 每状态详细定义（`FULL_STATE_MODE` 专用，非当前可产出结果）

以下每个状态按统一模板展开：业务定义 / 必要条件 / 加分条件 / 否决条件 / 建议特征 / 阈值类型 / 最短持续时间 / 状态切换滞后。**本节全部定义只在 `operatingMode='FULL_STATE_MODE'` 时生效**；当前基线（`PRICE_ONLY_MODE`）下的降级规则见§7.0a/§7.0b，不得混用本节判定逻辑直接输出正式S0-S7结果。

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
若 featureCompleteness.criticalFeatureCompleteness（§6.3，非fullArchitectureCompleteness，见P1-2红线）低于当前activeProfile的最低门槛（具体数值留待V1.4B标定）：
  operatingMode 相应降级为 'PRICE_ONLY_MODE' 或 'INSUFFICIENT_DATA'（见§7.0a/§7.0b）
  FULL_STATE_MODE下：primaryState/secondaryState 按本节7.1定义给出，stateConfidence 相应下调
    （如无法区分S2健康扩张与S3过热时，primaryState=S2, secondaryState=S3, stateConfidence下调，
      evidence中注明"衍生品数据缺失，无法排除过热风险"）
  PRICE_ONLY_MODE/INSUFFICIENT_DATA下：primaryState恒为'UNKNOWN'，按§7.0a/§7.0b规则输出proxyState或candidateStates，
    不得沿用本段"primaryState=S2, secondaryState=S3"这类FULL_STATE_MODE专属的降级写法
```

### 7.3 状态冲突处理（共享规则）

当多组证据同时支持两个非相邻状态（如同时满足`S2`部分证据与`S4`部分证据）时：**不强行归并为单一状态**，输出 `primaryState`（证据权重更高的一侧）+ `secondaryState`（另一侧）+ 在 `opposingEvidence` 中明确列出冲突证据本身，供融合中枢在§9冲突裁决环节进一步处理，而不是让单眼自己"和稀泥"选一个中间态。

### 7.4 主/次状态表达与状态置信度

`TargetStateId`/`FusionStateId`/`OperatingMode`/`PriceOnlyStateId` 已在§6.3统一定义（P1-1修订：类型定义唯一入口在§6.3，本节不重复定义，避免同一类型在两处出现不同版本）。`StateJudgement` 是 `TargetState`（§6.3）中 `primaryState`/`secondaryState`/`candidateStates`/`stateConfidence`/`stateEvidence`/`opposingEvidence` 六个字段的合称，本节不再单列一个平行接口，实现时直接读写 `TargetState` 对应字段即可。

```ts
interface StateJudgement {
  primaryState: TargetStateId;              // 见§6.3红线：非FULL_STATE_MODE下恒为'UNKNOWN'
  secondaryState: TargetStateId | null;
  stateConfidence: number;                  // 0-100，规则内部一致性代理，不是统计概率
  stateEvidence: string[];
  opposingEvidence: string[];
  candidateStates: TargetStateId[];         // 因数据不足而无法排除的候选状态列表，即draft-1的insufficientDataFlags，字段名统一为TargetState.candidateStates
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

### 8.4 迁移记录结构（P0-NEW-1修订：正式迁移与代理迁移拆分为两个互不兼容的结构）

**P0-NEW-1 red line 背景**：draft-2 的 `TransitionRecord.fromState/toState` 类型为 `TargetStateId`（含`UNKNOWN`），但§7.0a/§17.1已要求`PRICE_ONLY_MODE`下记录`PriceOnlyStateId`代理迁移——`PriceOnlyStateId`并不是`TargetStateId`的子集，两者类型不兼容，且draft-2曾写"记录UNKNOWN↔自身"这种无验证意义的占位迁移（一个状态到它自身、且是`UNKNOWN`这个非正式值，不携带任何可供未来校准的信息）。draft-3 起拆分为两个互斥结构，**并删除"UNKNOWN↔自身"这一设计**：

```ts
interface FormalTransitionRecord {
  fromState: FormalStateId;           // 只能是S0-S7，不含UNKNOWN/CONFLICTED/PO_*（见§6.3 FormalStateId）
  toState: FormalStateId;
  elapsedTimeMs: number;               // 真实经过时间，见§4.5
  transitionWeight: number;           // 规则型权重，0-100，非概率
  probabilityStatus: 'rule_based' | 'similarity_based' | 'calibrated';  // 见§8.5
  calibratedProbability: number | null;  // 未满足校准条件前恒为null，红线同§8.2
  sampleSize: number | null;
  calibrationVersion: string | null;
  evidenceRefs: string[];
  statsGroup: 'FULL_STATE_STATS';     // 固定值，只能由operatingMode='FULL_STATE_MODE'时的真实状态判定产生（见§7.0a）
}

interface ProxyTransitionRecord {
  fromProxyState: PriceOnlyStateId;   // 只能是PriceOnlyStateId（见§6.3），字段名与FormalTransitionRecord区分（fromProxyState≠fromState），杜绝混淆
  toProxyState: PriceOnlyStateId;
  elapsedTimeMs: number;
  transitionWeight: number;           // 规则型权重，同样非概率
  probabilityStatus: 'rule_based' | 'similarity_based';  // 代理迁移不进入正式校准流程，不使用'calibrated'状态
  calibratedProbability: null;        // 恒为null——代理迁移永远不产出正式校准概率，不是"未满足门槛暂时为null"，是结构性永久null
  sampleSize: number | null;
  evidenceRefs: string[];
  statsGroup: 'PROXY_STATS';          // 固定值，只能由operatingMode='PRICE_ONLY_MODE'时产生
}
```

**红线（P0-NEW-1核心）**：
1. `FormalTransitionRecord` 只能在 `operatingMode='FULL_STATE_MODE'` 时产生，进入 `FULL_STATE_STATS` 统计分组；`ProxyTransitionRecord` 只能在 `operatingMode='PRICE_ONLY_MODE'` 时产生，进入 `PROXY_STATS` 统计分组——**两个分组永不合并**，`ProxyTransitionRecord` 永远不得混入正式八状态迁移率或校准概率的分母（呼应§7.0a"代理状态不得混入未来FULL_STATE_MODE正式状态准确率分母"红线，本节是该红线在迁移记录层面的延伸）。
2. **`operatingMode='INSUFFICIENT_DATA'` 时不生成任何迁移记录**（既不生成`FormalTransitionRecord`也不生成`ProxyTransitionRecord`）——数据不足以判断当前状态时，"状态之间发生了迁移"这一命题本身无法成立，不得记录。
3. **删除"UNKNOWN↔自身"迁移设计**——`UNKNOWN`不是`FormalStateId`的成员，不会出现在`FormalTransitionRecord`中；`PRICE_ONLY_MODE`下也不存在"记录代理层面`UNKNOWN`到`UNKNOWN`的迁移"这种操作，因为`TargetState.primaryState`在该模式下恒为`UNKNOWN`只是"正式判定字段的占位值"，真正携带信息的是`proxyState`，迁移记录只围绕`proxyState`的变化（即`ProxyTransitionRecord`）展开，不围绕恒定不变的`primaryState='UNKNOWN'`展开。

### 8.5 `calibratedProbability` 由 `null` 变为数值的门槛（红线）

只有同时满足以下条件，`calibratedProbability` 才允许从 `null` 变为具体数值（【需服务器架构后实施】，第一阶段不涉及）：

1. 预先定义的最低样本量门槛（具体数值留待历史验证阶段用真实数据标定，本文档不预设数字，呼应V1.2既有"不在数据都没有的情况下伪造看似精确的阈值"原则）；
2. 训练/验证/测试严格按时间顺序切分，完成 walk-forward 验证（不得随机打乱时间序列，呼应`STRATEGY_SPEC.md`§18.3既有原则）；**walk-forward回放在任意历史时刻`forecastCreatedAt`只能使用满足`availableAt<=forecastCreatedAt`的`DataVintageRef`版本**（红线同§4.3，本条是该红线在校准场景的直接应用，不得在校准阶段绕过）；
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
  可以：降低多头情景的置信等级；降低`readinessCeiling`（见§11.4，取代draft-1的permissionCeiling）
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
  fusionState = 'CONFLICTED'（见§6.3 FusionStateId的CONFLICTED值，P1-1修订：与TargetState.primaryState使用的TargetStateId类型严格分离，
                             仅融合中枢层面的ForecastResult携带fusionState字段，精度眼/单眼输出不会出现此值）
  readinessLevel 强制为 'OBSERVE'（§11.4/§12 P1-5修订：就绪度不得在三方冲突时给出更高档位）
  gateStatus = 'WAIT'（P1-5修订：闸门状态独立字段，与readinessLevel分属两个轴，见§11.4）
  waitingForSignals：列出"需要哪些信号变化才能解除CONFLICTED"的具体条件
  invalidationConditions：即使在CONFLICTED状态下，仍需说明什么情况发生会让当前的"等待"判断本身过时

红线：不得为了"每天必须给出一个方向"而强行输出场景1/2/3中的任何一个来掩盖真实的三方冲突——
CONFLICTED和gateStatus='WAIT'本身就是合法的、且往往是最诚实的输出，不是"系统失败"或"没做完"，
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

### 10.1 `ForecastSnapshot` 与 `ForecastOutcomeEvent` 拆分（P0-2/P0-NEW-2/P1-NEW-3/P1-NEW-5修订，唯一权威定义）

**P0-2 red line 背景**：draft-1 的 `LongHorizonForecastLog` 把"生成时就确定的预测内容"和"预测到期后才知道的实际结果"揉在同一个接口里、用一堆 `xxx: T | null` 字段占位，容易在实现时被误写成"原地更新同一条记录"，也没有明确定义方向判定规则、起止K线、MFE/MAE口径、去重幂等规则。draft-2 拆成两个独立对象，`ForecastSnapshot` 生成后**不可变**，`ForecastOutcomeEvent` 预测到期后**只追加、不覆盖**。draft-3 进一步补上路径K线完整性（P0-NEW-2）、RANGE专属指标（P1-NEW-1）、区间覆盖细分（P1-NEW-2）、情景权重不变量（P1-NEW-3）、定盘K线的显式索引契约（P1-NEW-5）：

```ts
interface BarRef {                     // P1-NEW-5新增：统一的K线引用结构，取代draft-2裸露的{symbol,timeframe,closeTime}
  symbol: 'ETH' | 'BTC';
  timeframe: '15m';
  openTime: number;                    // ms epoch
  closeTime: number;                   // ms epoch；与openTime的精确边界关系（是否openTime+timeframeMs-1）须在实现规范中统一，见§10.2红线
  timeframeMs: number;                 // 固定900000（15分钟），显式携带以避免下游硬编码
  sequenceIndex: number;               // 相对该ForecastSnapshot.referenceBarRef的相对序号：referenceBar自身=0，其后第1根=1，……第96/288根=targetBar，见§10.2
  barKey: string;                      // 可复现的唯一标识，如 `${symbol}-15m-${closeTime}`，供缺口检测/去重使用
}

interface ForecastSnapshot {
  predictionId: string;                // 唯一标识，全系统的可复现锚点
  instrument: 'BTC' | 'ETH';
  horizon: '24h' | '72h';
  generatedAt: number;
  dataCutoffTime: number;              // 生成本次预测时，所有输入数据允许使用的最晚availableAt（见§4.3防泄漏红线）
  targetStartTime: number;             // 见§10.2起止时间定义
  targetEndTime: number;
  referencePrice: number;              // 生成时刻使用的已收盘K线收盘价，见§10.2
  referenceBarRef: BarRef;             // 起点定盘K线引用，sequenceIndex恒为0
  targetBarRef: BarRef;                // 终点定盘K线引用，sequenceIndex恒为96（24H）或288（72H），生成时预先算好，供日后回填定位
  expectedBarCount: number;            // = 96（24H）或288（72H），目标路径应含的bar总数，见§10.5
  expectedDirection: 'UP' | 'DOWN' | 'RANGE';
  directionThreshold: number;          // 冻结的RANGE阈值，见§10.3
  targetStateAtGeneration: TargetStateId;      // 生成时刻的TargetState.primaryState快照（P1-1类型），供复现追溯
  fusionStateAtGeneration: FusionStateId;      // 生成时刻的融合状态快照
  candidateTrajectories: TrajectoryScenarios;   // 见§11.2（含P0-NEW-1的TransitionBundle）
  scenarioWeights: { baseline: number; upside: number; downside: number };  // 见下方P1-NEW-3不变量
  probabilityStatus: 'rule_based' | 'similarity_based' | 'calibrated';
  calibratedProbabilities: Record<string, number | null>;   // 未校准时全部为null，红线同§8.2/§8.5；与scenarioWeights是两个不同字段，不得复用同一存储位置（见下方P1-NEW-3红线）
  expectedPriceZones: { baseline: [number, number]; upside: [number, number]; downside: [number, number] };
  triggerConditions: string[];
  invalidationConditions: string[];
  algorithmVersion: string;
  weightVersion: string;
  datasetVersion: string;
  dataVintageRefs: string[];            // 对应§4.3 DataVintageRef.vintageId列表，本次预测实际使用的每个字段版本（P1-4可复现性核心字段之一）
  // ---- 以下为P1-4"增强可复现性"新增字段 ----
  featureValuesUsed: Record<string, number | string | boolean>;  // 实际参与计算的特征值快照（不是引用，是具体数值），即使未来数据源修订或下线也能重建当时输入
  featureEngineVersion: string;        // 特征计算逻辑本身的版本号，独立于algorithmVersion（特征工程与决策规则可能分别迭代）
  contentHash: string;                 // 对featureValuesUsed+算法/权重/数据集版本三元组的内容哈希，供快速校验"两条记录是否用了完全相同的输入与版本组合"
}

interface ForecastOutcomeEvent {
  outcomeEventId: string;
  predictionId: string;                // 外键关联ForecastSnapshot，只读引用，不得反向修改被引用的Snapshot
  evaluatedAt: number;
  actualStartPrice: number;            // = referenceBarRef对应K线收盘价，理论上应等于ForecastSnapshot.referencePrice，评估时重新核对而非直接照抄，用于发现数据不一致
  actualEndPrice: number;              // = targetBarRef对应K线收盘价（仅endpointDataComplete=true时有意义，见下）
  actualReturn: number;                // = (actualEndPrice - referencePrice) / referencePrice，基准固定用ForecastSnapshot.referencePrice（见§10.3）；仅endpointDataComplete=true时有意义
  actualDirection: 'UP' | 'DOWN' | 'RANGE' | null;   // P0-NEW-2修订：endpointDataComplete=true时才可计算，否则null，不得填近似值
  directionCorrect: boolean | null;    // directionEligibleForStatistics=false时恒为null，见下
  // ---- 区间覆盖细分（P1-NEW-2修订，取代draft-2单一的rangeCovered） ----
  endpointInBaselineZone: boolean | null;              // 终点actualEndPrice是否落在baseline情景区间内
  endpointInAnyScenarioZone: boolean | null;           // 终点是否落入baseline/upside/downside任一冻结情景区间
  realizedRangeInsideExpectedEnvelope: boolean | null; // actualLow与actualHigh是否均位于expectedEnvelope（见下）内，仅pathDataComplete=true时可计算
  expectedEnvelopeTouched: boolean | null;             // 实际路径是否至少进入过expectedEnvelope，仅pathDataComplete=true时可计算
  // ---- 路径类指标：仅pathDataComplete=true时非null（P0-NEW-2修订，禁止填0或近似值） ----
  actualHigh: number | null;
  actualLow: number | null;
  mfe: number | null;                  // 见§10.4；expectedDirection='RANGE'时恒为null，见§10.4a
  mae: number | null;
  // ---- RANGE专属路径指标（P1-NEW-1新增，仅expectedDirection='RANGE'且pathDataComplete=true时非null） ----
  upperExcursion: number | null;
  lowerExcursion: number | null;
  maxAbsoluteExcursion: number | null;
  rangeBreachExcursion: number | null;
  invalidationTriggered: boolean;
  // ---- 路径K线完整性（P0-NEW-2新增） ----
  expectedBarCount: number;            // = ForecastSnapshot.expectedBarCount，冗余存一份供独立审计
  observedBarCount: number;            // 评估时刻实际观测到的、目标路径内的bar数
  missingBarRefs: BarRef[];            // 具体缺失的bar列表（sequenceIndex+barKey均需可辨识），不得只记数量
  endpointDataComplete: boolean;       // 仅表示起点(referenceBarRef)与终点(targetBarRef)两根K线存在，不代表路径完整
  pathDataComplete: boolean;           // 目标时间窗内全部expectedBarCount根K线均完整（= missingBarRefs.length===0）
  pathEligibleForStatistics: boolean;  // = pathDataComplete && 无其他排除原因；MFE/MAE/区间覆盖类统计只能用此字段筛选后的样本
  directionEligibleForStatistics: boolean;  // = endpointDataComplete && 无其他排除原因；方向准确率统计用此字段筛选，与pathEligibleForStatistics相互独立，不得混用
  exclusionReasons: string[];          // 必须包含具体缺失bar的barKey/sequenceIndex引用，不得只写泛化原因
  evaluationVersion: string;           // 评估逻辑本身的版本号，独立于algorithmVersion（评估公式迭代不代表预测算法变化）
}
```

**红线（P0-2核心）**：`ForecastOutcomeEvent` **不得覆盖 `ForecastSnapshot`**——两者是两张独立的表/两类独立的不可变记录，只通过 `predictionId` 关联查询，任何实现代码都不允许"回填结果时顺便改写快照里的字段"。

**红线（P0-NEW-2核心，数据不完整时禁止填0或近似值）**：
- `endpointDataComplete` 只表示起点和终点两根K线存在，**不等于**路径完整；`pathDataComplete` 才表示目标时间窗内全部 `expectedBarCount` 根K线完整；
- `actualDirection`/`actualReturn`/`directionCorrect` 可以在 `endpointDataComplete=true` 时计算（只需要起止两个点）；
- `actualHigh`/`actualLow`/`mfe`/`mae`/RANGE专属四项/区间覆盖四项中依赖路径最高最低价的部分，**只有 `pathDataComplete=true` 才能计算**，否则**必须为 `null`**，**不得**填0或用起止两点近似代替真实的路径最高/最低价；
- **不得只检查 `targetBarRef` 就声称"完整"**——`targetBarRef` 存在只保证 `endpointDataComplete` 的终点部分，`pathDataComplete` 必须逐根核对 `expectedBarCount` 根bar是否都在，缺一根都不算完整；
- 正式的综合统计（方向×区间联合评估）分母要求 `pathDataComplete=true`；如果只需要保留"仅验证方向正确性"的样本，必须使用独立的 `directionEligibleForStatistics` 字段筛选，**不得**和 `pathEligibleForStatistics` 混用同一个分母；
- `exclusionReasons` 必须记录具体缺失的bar（通过 `missingBarRefs` 的 `barKey`/`sequenceIndex`），不得只写"数据不完整"这类泛化文案。

**情景权重不变量（P1-NEW-3新增，红线）**：`scenarioWeights.{baseline,upside,downside}` 必须满足：
1. 三项均为有限数（`Number.isFinite`），**不允许** `NaN`、`Infinity`、负值；
2. 每项取值范围 `[0, 100]`；
3. 三项之和必须**恰好等于100**；允许计算过程中出现的极小浮点误差（如`99.9999997`），但必须在写入 `ForecastSnapshot` 前完成**归一化**（按比例缩放三项使之和为100）与**舍入**（四舍五入到整数或约定精度，舍入产生的余差记入权重最大的一项，避免"四舍五入后三项之和变成99或101"这一常见bug），具体归一化/舍入算法由实现规范冻结，本文档只规定"必须存在且必须保证和恒等于100"这一约束；
4. `scenarioWeights` 是**规则型情景权重**，不是概率——`calibratedProbabilities` 是校准概率的**唯一合法载体**（见§8.2/§8.5），两者**不得共用同一字段**、不得互相复制赋值，`scenarioWeights` 未校准前后都不会变成概率，只有 `calibratedProbabilities` 会在满足§8.5门槛后从 `null` 变为数值。

### 10.2 目标起止时间与定盘K线（红线，统一口径，P1-NEW-5修订）

延续 `V1_2_FORECAST_SPEC.md`§12.1 已确立的"1 bar = 固定15分钟"传统，24H/72H 同样以15分钟K线为最小定位单位（24H = 96 bars，72H = 288 bars），不另立新的时间单位体系：

```
referenceBar = 预测生成时最后一根已收盘的15分钟K线，sequenceIndex恒为0
targetStartTime = referenceBar的收盘时间（即targetStartTime与referenceBar的closeTime相同，是路径的起点锚，不是路径的第一个bar）
目标路径 = referenceBar收盘后的下一根bar（sequenceIndex=1）开始，向后连续的bar序列
  24H路径：sequenceIndex 1..96（含96根bar）
  72H路径：sequenceIndex 1..288（含288根bar）
targetBar = 目标路径的最后一根bar：24H时sequenceIndex=96，72H时sequenceIndex=288
targetEndTime = targetBar的收盘时间
referencePrice = referenceBar的收盘价（不用生成时刻的"当前价"，理由与V1.1/V1.2既有的"必须用已收盘K线做正式判断"红线一致，防止用未收盘的盘中价格做基准）
```

**红线（P1-NEW-5核心）**：
1. **不得把 `referenceBar`（`sequenceIndex=0`）重复计入目标路径**——目标路径是 `sequenceIndex 1..96/288`，不包含 `sequenceIndex=0`；`expectedBarCount=96`（或288）指的就是这个不含referenceBar的路径长度；
2. **使用bar序号（`sequenceIndex`）定位优先于单纯毫秒加法**——实现时必须沿着实际的K线序列逐根前进（每一根bar的`openTime`应等于前一根bar的`closeTime`+1ms或按官方约定的边界关系，见下条），而不是仅凭"`targetStartTime + N×15分钟`"这个算术结果去盲目假设那个时间点必然存在一根bar——如果历史上该处发生过数据缺口，纯毫秒加法会静默定位到错误的、并不存在的时间点，而按`sequenceIndex`遍历真实序列能让缺口在遍历过程中被直接发现（对应§10.1 `missingBarRefs`的产生方式）；
3. **UTC、`closeTime`端点及可能的1毫秒边界必须在实现规范中统一**——不同交易所/数据源对"K线收盘时间"的精确定义可能是`openTime+timeframeMs`或`openTime+timeframeMs-1`（Binance实际返回哪一种需要在`V1_4_CODEX_IMPLEMENTATION_TASK.md`或等价实施工单中用真实API响应核实并写死，本文档只标注这是一个必须显式约定、不得含糊假设的边界问题，不在架构层面替实现层做出选择）。

### 10.3 方向判定规则（`UP`/`DOWN`/`RANGE`，红线，必须版本冻结）

```
actualReturn = (actualEndPrice − ForecastSnapshot.referencePrice) / ForecastSnapshot.referencePrice   （仅endpointDataComplete=true时计算）

UP：   actualReturn >= +directionThreshold
DOWN： actualReturn <= −directionThreshold
RANGE：−directionThreshold < actualReturn < +directionThreshold

expectedDirection 使用同一套规则、同一个directionThreshold，在生成ForecastSnapshot时由算法预先给出（不是评估时才决定）
directionCorrect = (directionEligibleForStatistics === true) ? (actualDirection === expectedDirection) : null
```

**`directionThreshold` 如何冻结（红线）**：`directionThreshold` 的口径（相对 `referencePrice` 的固定百分比，或相对生成时刻ATR的倍数）**必须**在 `algorithmVersion` 冻结的同一时刻一并选定并写入版本说明，**不得**在同一算法版本内动态调整阈值口径或数值；未来若认为阈值需要调整，必须递增 `algorithmVersion`（呼应`V1_2_FORECAST_SPEC.md`§12.2版本号红线的同一纪律，不重复发明新规则）。

### 10.4 MFE/MAE 计算口径（红线，相对 `referencePrice` 与 `expectedDirection`，P1-NEW-1修订：RANGE不再借用方向语义的MFE/MAE）

```
若 expectedDirection = 'UP'（仅pathDataComplete=true时计算，否则mfe/mae为null）：
  mfe = (actualHigh − referencePrice) / referencePrice   （最大有利：价格向上偏离基准的最大幅度）
  mae = (referencePrice − actualLow) / referencePrice    （最大不利：价格向下偏离基准的最大幅度）
若 expectedDirection = 'DOWN'（同上前提）：
  mfe = (referencePrice − actualLow) / referencePrice
  mae = (actualHigh − referencePrice) / referencePrice
```

**若 `expectedDirection = 'RANGE'`（P1-NEW-1核心，冻结公式，不再留待evaluationVersion决定）**：

```
mfe = null                                                    （RANGE本身没有方向，不得强行套用带方向语义的"有利/不利"）
mae = null
upperExcursion = (actualHigh − referencePrice) / referencePrice        （仅pathDataComplete=true时计算，否则为null）
lowerExcursion = (referencePrice − actualLow) / referencePrice
maxAbsoluteExcursion = max(upperExcursion, lowerExcursion)
rangeBreachExcursion = max(0, maxAbsoluteExcursion − directionThreshold)   （实际路径偏离基准的最大幅度，相对RANGE判定阈值超出了多少；0表示全程未突破RANGE阈值）
```

**红线**：`expectedDirection='RANGE'` 时 `mfe`/`mae` **恒为 `null`**，不得伪造一个"有利方向"——RANGE情景的成立前提就是"不预期明确方向"，继续输出`mfe`/`mae`会隐含"其实是有方向的"这一矛盾语义，四项RANGE专属指标（`upperExcursion`/`lowerExcursion`/`maxAbsoluteExcursion`/`rangeBreachExcursion`）才是RANGE场景下唯一合法的路径评估指标。

### 10.4a 区间覆盖指标定义（P1-NEW-2新增）

```
expectedEnvelope = { lower: min(baseline.lower, upside.lower, downside.lower), upper: max(baseline.upper, upside.upper, downside.upper) }
  （三类情景冻结区间合并后的总下沿到总上沿，取自ForecastSnapshot.expectedPriceZones）

endpointInBaselineZone            = actualEndPrice ∈ [baseline.lower, baseline.upper]                       （仅检查终点，endpointDataComplete=true时可计算）
endpointInAnyScenarioZone         = actualEndPrice ∈ baseline区间 ∪ upside区间 ∪ downside区间任一          （同上前提）
realizedRangeInsideExpectedEnvelope = (actualLow >= expectedEnvelope.lower) && (actualHigh <= expectedEnvelope.upper)   （要求路径最高最低价均在包络内，仅pathDataComplete=true时可计算）
expectedEnvelopeTouched            = 实际路径([actualLow, actualHigh])与expectedEnvelope存在交集             （表示路径是否至少进入过预测包络，仅pathDataComplete=true时可计算）
```

数据不完整（对应前提条件不满足）时，四个字段均为 `null`，不得填 `false` 冒充"确认未覆盖"。

### 10.5 缺失K线的统计排除规则（红线，呼应V1.3"estimated交易排除于验证统计"同一哲学，P0-NEW-2修订）

若评估时刻目标路径内任意一根bar（`sequenceIndex 1..expectedBarCount`）缺失（数据源缺口未回补，或尚未到达该时间点），该bar被记入 `missingBarRefs`，`pathDataComplete=false`；若仅 `referenceBarRef`/`targetBarRef` 两个端点其中之一缺失，则 `endpointDataComplete=false`（此时 `pathDataComplete` 必然也为false，因为端点本身就是路径的一部分）。`exclusionReasons` 必须记录具体原因（如`'bar_missing:sequenceIndex=47'`/`'target_bar_not_yet_closed'`）。**缺失K线的记录不得进入正式方向准确率/区间覆盖率统计分母**——方向准确率使用 `directionEligibleForStatistics` 筛选，区间覆盖/MFE/MAE类使用 `pathEligibleForStatistics` 筛选，二者独立判定、独立使用，这与 `V1_3_PAPER_TRADING_SPEC.md` 已确立的"estimated交易排除于验证统计"是同一类工程纪律的延伸，不重新发明。

### 10.6 幂等回填（红线）

同一 `predictionId` 的结果回填函数**必须幂等**：重复调用时，若已存在该 `predictionId`（+`evaluationVersion`）对应的 `ForecastOutcomeEvent`，直接返回已有记录，**不得**新建重复事件或修改已有事件的字段值；只有当 `evaluationVersion` 本身升级（评估公式变化）时，才允许追加一条**新的** `ForecastOutcomeEvent`（新 `outcomeEventId`，同一 `predictionId`），与旧版本评估结果并存，不覆盖。

---

## 11. 融合中枢

### 11.1 禁止简单平均，融合权重的现状标注

融合中枢**不能简单平均**各系统输出——环境支持度、目标内部状态、状态迁移权重、事件冲击、数据质量、来源可信度、历史表现、时间尺度、风险边界，这些维度性质不同（有的是状态类枚举、有的是连续值评分、有的是二元冲击标记），简单加权平均会掩盖"哪个维度真正在起作用"。

**可以研究乘法融合**（如各维度作为独立的"折扣因子"相乘，一票否决类维度用接近0的因子体现），但初始的示例权重分配（如环境25%、目标40%、迁移25%、其他10%）**只能标记为待验证初始参数**，**不能称为真实有效权重**——这些数字目前没有任何历史校准依据，只是架构设计阶段用来说明"融合逻辑长什么样"的占位说明，实现时必须在代码注释与日志字段中明确标注 `fusionWeightVersion: 'unvalidated-initial-1'` 这类版本号，防止被误当作"已经调好的生产参数"。

### 11.2 `TrajectoryScenarios`（单眼输出，供融合中枢消费，P0-NEW-1修订）

**P0-NEW-1延伸**：`transitionWeights: TransitionRecord[]` 这一单一字段已随§8.4拆分为不兼容的 `FormalTransitionRecord`/`ProxyTransitionRecord` 两种结构而失效。改用判别联合（discriminated union）明确当前携带哪一种，**不得**同时出现两种、也不得用一个宽松的联合数组掩盖"当前到底是哪个运行模式产出的"这一事实：

```ts
type TransitionBundle =
  | { kind: 'formal'; records: FormalTransitionRecord[] }   // 仅operatingMode='FULL_STATE_MODE'
  | { kind: 'proxy'; records: ProxyTransitionRecord[] }      // 仅operatingMode='PRICE_ONLY_MODE'
  | { kind: 'none' };                                        // operatingMode='INSUFFICIENT_DATA'，见§8.4红线2

interface TrajectoryScenarios {
  jointStateRef: string;             // 对应JointState快照引用
  baselineScenario: ScenarioDetail;
  upsideScenario: ScenarioDetail;
  downsideScenario: ScenarioDetail;
  transitions: TransitionBundle;      // 见上，取代draft-2的transitionWeights: TransitionRecord[]
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

**红线**：读取 `TrajectoryScenarios.transitions` 的任何下游代码，**必须**先判别 `kind` 字段再决定如何处理 `records`，不得假设 `records` 的元素类型固定；`kind='formal'` 的记录才允许流入§8.5校准流程与正式八状态迁移率统计，`kind='proxy'` 的记录只能流入`PROXY_STATS`，`kind='none'` 时不产生任何迁移侧的展示或统计输入。

### 11.3 融合中枢输入维度清单

环境支持度（`WorldState.environmentPermission`+`regimeConfidence`）、目标内部状态（`TargetState`全量）、状态迁移权重（`TransitionBundle`，见§11.2判别联合，`kind='formal'`/`'proxy'`/`'none'`三选一）、事件冲击（`StateFrame.eventState`）、数据质量（`StateFrame.dataQuality`）、来源可信度（§16数据源健康状态的延伸）、历史表现（该算法版本过往校准结果，未校准前为空）、时间尺度（15m/1h/4h/24h/72h 分别处理，不混算）、风险边界（账户侧状态，只读引用，见§2红线3）。

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
  fusionState: FusionStateId;          // P1-1修订：融合层面的综合状态标签（可能是CONFLICTED），与targetState.primaryState使用的TargetStateId类型严格分离
  baselineScenario: ScenarioDetail;
  upsideScenario: ScenarioDetail;
  downsideScenario: ScenarioDetail;
  transitions: TransitionBundle;       // P0-NEW-1修订：取代draft-2的transitionWeights: TransitionRecord[]，见§11.2 TransitionBundle判别联合
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

**B. `ActionPermission`（行动许可，P1-5修订：拆分为两个独立轴，不假设线性顺序）**

**P1-5 red line 背景**：draft-1 把 `decisionPermission` 定义成一个平铺的六值枚举（`OBSERVE`/`PREPARE`/`ALLOW_TEST`/`ALLOW_EXECUTION`/`WAIT`/`BLOCKED`），隐含"这是一条线性递进的单一顺序"的假设，但 `WAIT`/`BLOCKED` 其实是"闸门被按下"这一独立维度，可以发生在任何就绪程度之上（比如情景本身已经就绪到 `ALLOW_EXECUTION` 档位，却因为账户处于冷却期而被 `BLOCKED`——这不是"退回到更低档位"，而是"就绪度不变、闸门单独否决"）。draft-2 起拆成两个正交字段：

```ts
type ReadinessLevel = 'OBSERVE' | 'PREPARE' | 'ALLOW_TEST' | 'ALLOW_EXECUTION';  // 情景本身达到的"就绪程度"，仅这四档构成线性递进
type GateStatus = 'OPEN' | 'WAIT' | 'BLOCKED';                                    // 独立闸门状态，可在任意ReadinessLevel上独立否决/等待

interface ActionPermission {
  readinessLevel: ReadinessLevel;
  readinessCeiling: ReadinessLevel;     // 本次理论上限（原draft-1的permissionCeiling），见下方P1-NEW-4红线：只由预测证据/数据质量/时间尺度/历史校准状态决定
  gateStatus: GateStatus;               // 与readinessLevel独立正交：即使readinessLevel='ALLOW_EXECUTION'，gateStatus仍可能是'BLOCKED'（如账户冷却期），表示"情景已就绪，但当前闸门不开放"
  blockingReasons: string[];            // gateStatus='BLOCKED'时必填
  restrictionReasons: string[];         // readinessLevel被readinessCeiling压低时的原因（只能是预测/数据侧原因，不得是账户侧原因，见下方红线）
  waitingForSignals: string[];          // gateStatus='WAIT'时必填
  riskConditions: string[];             // 账户/风控相关记录，只读展示，不反向影响readinessLevel/readinessCeiling，见下方红线
  mode: 'DISPLAY_ONLY' | 'AUDIT_ONLY';  // 见§12红线6：V1.4阶段（24H/72H专属，见§12开篇范围声明）恒为其一，不接入模拟撮合
}
```

**组合规则（红线，不得假设简单线性顺序）**：
- `readinessCeiling` 只约束 `readinessLevel`（`readinessLevel` 不得超过 `readinessCeiling`），**不约束** `gateStatus`；
- `gateStatus` 可以在任意 `readinessLevel` 取值上独立生效——`gateStatus='BLOCKED'` 或 `'WAIT'` 时，无论 `readinessLevel` 多高，都不构成"可以行动"的结论；只有 `gateStatus='OPEN'` 且 `readinessLevel` 达到相应档位，两个条件同时满足才具备行动意义；
- 因此对外展示/消费 `ActionPermission` 时，**必须同时读取两个字段**，不得只看 `readinessLevel` 就判断"可以做什么"。

**红线（P1-NEW-4修订：账户状态不得改变`readinessLevel`）**：
- `readinessLevel`/`readinessCeiling` **只能**由预测证据（情景权重、支持/反对证据强度）、数据质量（§6.3 `FeatureCompleteness`）、时间尺度（该horizon本身的性质）、历史校准状态（§8.5 `isCalibrated`/校准样本量）四类因素决定；
- 账户余额、保证金占用、冷却期、回撤锁定、反向信号冷却等**只允许影响 `gateStatus`**，**不得**降低或提高 `readinessLevel`/`readinessCeiling`——这与draft-2 `readinessCeiling` 注释中"账户/风控可以把readinessLevel往下压"的表述矛盾，本轮予以撤销更正：账户状态从未被允许触碰 `readinessLevel`/`readinessCeiling`，只能触碰 `gateStatus`；
- `riskConditions` 字段**只用于记录**账户风险状况供审计参考，是**只读展示**，不构成计算 `readinessLevel`/`readinessCeiling` 的输入；
- 当 `gateStatus∈{WAIT,BLOCKED}` 时否决行动，但**原始 `readinessLevel` 必须保持不变**——这使得事后审计可以准确复原"预测本身已经就绪到什么程度，但账户当时不允许行动"这一区分，若账户状态被允许污染`readinessLevel`，这条审计能力会永久丢失。

**红线**：`ForecastResult` 一旦生成即为该次预测的不可变事实（呼应§2红线3），`ActionPermission` 可以在后续 tick 因账户状态变化而重新评估、重新产出新的许可对象，但**不得**回头修改已生成的 `ForecastResult`——这与 `ForecastResult` 需要更新（如数据到期需要重新算一版）是两回事：更新意味着生成一条**新的** `ForecastResult` 记录（新的 `generatedAt`），而不是原地修改旧记录。

---

## 12. 行动许可与 V1.3.1 兼容映射（P0-4修订，红线）

**范围声明（P0-4核心澄清，必须最先读到）**：本节讨论的 GMKG `ActionPermission` **专指 GMKG 新增的 24H/72H 时间尺度产出的行动许可**。15分钟/1小时/4小时三个既有时间尺度**继续完全使用 V1.1/V1.2/V1.3.1 既有的 `signalPermission`/`worthBetting`/`opportunityScores`/`archiveCategory` 体系**，GMKG **不为这三个既有时间尺度重新产出一套平行的 `ActionPermission`**——这是对§10"GMKG不重新定义15m/1h/4h既有层级"红线的直接落实，避免"两套行动许可同时存在、口径互相打架"。draft-1 把六档 `decisionPermission` 直接映射进 `WATCHLIST`/`EXECUTABLE` 创建规则的写法，混淆了"GMKG 24H/72H的判断"与"既有15分钟交易生命周期"这两件事，本节予以重写关闭。

### 12.1 GMKG 24H/72H `ActionPermission` 的唯一合法用途

1. **背景展示信息**——在UI/日志中展示"当前24H/72H层面判断：是否支持/限制近端操作"，供人工参考；
2. **审计信息**——记录在案，供未来误差归因（§15）/校准分析（§8.5）引用；
3. **对既有15分钟许可的只降不升的天花板限制**——若GMKG 24H/72H判断的 `gateStatus∈{WAIT,BLOCKED}` 或 `readinessLevel` 很低，**可以**在展示层提示"尽管15分钟层面`signalPermission`已通过，24H层面因XX原因建议降低仓位/观望"，但**绝不能**因为GMKG 24H/72H判断为 `readinessLevel='ALLOW_EXECUTION'` 且 `gateStatus='OPEN'`，就把15分钟层面原本不满足的 `worthBetting`/`signalPermission.level` 条件"补齐"或"跳过"。

### 12.2 红线（逐条对应CEO意见，v1.3.1现状已如实核实，见§0第3点源码阅读）

1. **GMKG 24H/72H `ActionPermission` 不得单独创建 `WATCHLIST` 类别的信号记录**；
2. **不得单独创建 `EXECUTABLE` 类别的信号记录**；
3. **不得直接调用 `recordSignalIfEligible`/`evaluateShadowSignals`/`tickAutoEngine`/`buildTradeProposal` 中任何一个**——这四个函数只能由既有15分钟 `processTradeGate()` 生产链路调用，GMKG 代码路径中不得出现对它们的直接引用；
4. **只有现有15分钟决策核心创建、并通过 v1.3.1 全部创建时和当前门控的信号，才允许进入 `WATCHLIST`/`EXECUTABLE` 交易生命周期**——这条路径完全在 V1.1/V1.2/V1.3.1 既有代码内运行，GMKG 不参与、不介入，`eligibleForTrigger`/`permissionAtCreation`/`worthBettingAtCreation`/`hardBlockedAtCreation`/`signalPermissionLevelAtCreation`/`opportunityBlockedAtCreation`（v1.3.1既有创建时快照字段，见`V1_3_1_IMPLEMENTATION_REPORT.md`"最终安全复审修复"）继续只由既有15分钟链路写入；
5. **GMKG 只能限制现有15分钟许可，不能凭自身许可提升现有15分钟许可**——把允许压低为不允许是合法的展示层建议，把不允许的操作变为允许是绝对禁止的；
6. **V1.4阶段GMKG `ActionPermission` 必须保持 `mode∈{'DISPLAY_ONLY','AUDIT_ONLY'}`**（见§11.4新增字段）——不接入模拟撮合、不产生任何影响 `v1_3-paper-trading-core.js`/`v1_3-trade-gate-diagnostics.js` 实际执行路径的副作用；
7. **未来如需接入**（即让24H/72H判断真正影响交易生命周期，而不只是展示/限制）**必须单独立项、独立规范、独立对抗测试**——不得在本轮或V1.4阶段直接放开 `mode`。
8. **撮合核心与 `buildTradeProposal` 必须继续独立验证**——`v1_3-paper-trading-core.js` 的 `buildTradeProposal` 函数本身校验 `decision.worthBetting===true`、`scores.blocked===false`、`permission.level==='trend_entry_allowed'` 等硬性条件（已读源码确认，见§0第3点），这条独立验证与GMKG的存在与否无关，必须继续独立运行。
9. **`OBSERVATION` 永久不可触发**——不因GMKG的加入而改变，`lifecycleStatus` 只能是 `OBSERVING`/`OBSERVATION_COMPLETED`（v1.3.1既有约束），不得进入`WAITING_TRIGGER`/`TRIGGERED`交易生命周期。
10. **GMKG 不得绕过或削弱任何 v1.3.1 门控**——`processTradeGate()`生产调用链（`recordSignalIfEligible`→`evaluateShadowSignals`→触发升级→`tickAutoEngine`）保持不变，GMKG 只在这条链路的输入侧（提供更丰富的环境/目标/轨迹上下文供未来因子使用，参照§16与未来V1.4的因子扩展设计）和展示侧（`ForecastResult`/`ActionPermission`作为新增的、独立于交易门控之外的`DISPLAY_ONLY`/`AUDIT_ONLY`信息）接入，不修改链路本身。

---

## 13. 最终输出快照示例（P0-2/P0-3/P0-4/P1-1/P1-2/P1-4/P1-5修订）

以下示例为**架构说明用途**，字段值均为占位示意，**不代表真实预测**，`calibratedProbability`/`scenarioWeight` 明确按未校准状态展示（红线：示例中不得把未校准权重伪装成概率）。**红线（P0-3核心）**：两个示例**对应同一虚构市场时刻**，但分别展示 `FULL_STATE_MODE`（未来B-G组数据齐全后的目标形态，当前不可产出）与 `PRICE_ONLY_MODE`（当前v1.3.1基线唯一可能产出的形态），刻意并排展示以防止 `PRICE_ONLY_MODE` 被误当作已经具备完整八状态判定能力。

### 13.1 `FULL_STATE_MODE` 示例（【目标架构】，未来B-G组数据齐全后的形态，当前不可产出）

```json
{
  "predictionId": "GMKG-ETH-24H-20260717T160000Z",
  "instrument": "ETH",
  "horizon": "24h",
  "generatedAt": 1752768000000,
  "dataCutoffTime": 1752768000000,
  "targetStartTime": 1752768000000,
  "targetEndTime": 1752854400000,
  "referencePrice": 3250.0,
  "referenceBarRef": { "symbol": "ETH", "timeframe": "15m", "openTime": 1752767100000, "closeTime": 1752768000000, "timeframeMs": 900000, "sequenceIndex": 0, "barKey": "ETH-15m-1752768000000" },
  "targetBarRef": { "symbol": "ETH", "timeframe": "15m", "openTime": 1752853500000, "closeTime": 1752854400000, "timeframeMs": 900000, "sequenceIndex": 96, "barKey": "ETH-15m-1752854400000" },
  "expectedBarCount": 96,
  "environment": {
    "growthRegime": "expansion",
    "liquidityRegime": "tightening",
    "riskRegime": "risk_on",
    "environmentPermission": "supportive_for_risk_assets",
    "regimeConfidence": 62
  },
  "target": {
    "operatingMode": "FULL_STATE_MODE",
    "primaryState": "S2_BULL_EXPANSION",
    "secondaryState": "S3_OVERHEATED",
    "candidateStates": [],
    "proxyState": null,
    "stateConfidence": 55,
    "spotVsLeverageDriver": "mixed",
    "trendHealth": "fragile",
    "featureCompleteness": {
      "activeProfile": "FULL_STATE_MODE",
      "profileCompleteness": 0.93,
      "fullArchitectureCompleteness": 0.93,
      "criticalFeatureCompleteness": 0.90,
      "missingCriticalFeatures": []
    }
  },
  "fusionState": "S2_BULL_EXPANSION",
  "trajectory": {
    "baselineScenario": { "id": "CONTINUATION_WITH_COOLING", "text": "延续上行但杠杆指标提示需警惕透支，规则型权重支持震荡上探" },
    "upsideScenario": { "id": "BREAKOUT_CONTINUATION", "text": "若现货驱动持续增强，可能延续突破" },
    "downsideScenario": { "id": "LEVERAGE_UNWIND_PULLBACK", "text": "若资金费率/OI回落，可能出现去杠杆回调" },
    "transitions": {
      "kind": "formal",
      "records": [
        { "fromState": "S2_BULL_EXPANSION", "toState": "S3_OVERHEATED", "elapsedTimeMs": 300000, "transitionWeight": 35, "probabilityStatus": "rule_based", "calibratedProbability": null, "sampleSize": null, "calibrationVersion": null, "evidenceRefs": ["资金费率连续走高"], "statsGroup": "FULL_STATE_STATS" },
        { "fromState": "S2_BULL_EXPANSION", "toState": "S2_BULL_EXPANSION", "elapsedTimeMs": 300000, "transitionWeight": 50, "probabilityStatus": "rule_based", "calibratedProbability": null, "sampleSize": null, "calibrationVersion": null, "evidenceRefs": ["现货驱动仍占主导"], "statsGroup": "FULL_STATE_STATS" }
      ]
    }
  },
  "probabilityStatus": "rule_based",
  "scenarioWeight": { "baseline": 45, "upside": 30, "downside": 25, "note": "规则型情景权重，非统计概率，未经历史校准" },
  "calibratedProbability": null,
  "expectedDirection": "UP",
  "directionThreshold": 0.02,
  "priceZone": { "baseline": [3180, 3320], "upside": [3320, 3480], "downside": [3020, 3180] },
  "invalidConditions": [
    "跌破24H基线区间下沿且已收盘确认，视为baseline情景失效",
    "资金费率/OI在数据可得时若同步转向下降超过设定阈值，视为upside情景证据减弱"
  ],
  "actionPermission": {
    "readinessLevel": "ALLOW_TEST",
    "readinessCeiling": "ALLOW_TEST",
    "gateStatus": "WAIT",
    "blockingReasons": [],
    "restrictionReasons": ["24H时间尺度尚未完成历史校准，readinessCeiling不上调至ALLOW_EXECUTION"],
    "waitingForSignals": ["等待15m/1h/4h既有V1.1决策核心给出当前触发确认（该确认发生在既有链路内，GMKG不介入，见§12）"],
    "riskConditions": ["账户当前风险档位：正常（本字段只读引用，不反向影响本次trajectory计算）"],
    "mode": "DISPLAY_ONLY"
  },
  "nextObservation": "下一个5分钟状态帧 / 下一次15分钟K线收盘",
  "dataQuality": { "completenessRatio": 0.93, "freshnessSummary": "fresh", "staleFieldCount": 6, "missingFieldCount": 3, "revisedFieldCount": 0 },
  "dataVintageRefs": ["ETH-15m-close-1752768000000-rev0", "US-FUNDING-RATE-1752767700000-rev0", "..."],
  "featureEngineVersion": "gmkg-feature-engine-unimplemented",
  "contentHash": "示例简化，正式实现须为featureValuesUsed+版本三元组计算实际哈希",
  "algorithmVersion": "gmkg-draft-3-unimplemented",
  "weightVersion": "gmkg-fusion-weights-unvalidated-initial-1",
  "datasetVersion": "gmkg-dataset-not-yet-collected"
}
```

### 13.2 `PRICE_ONLY_MODE` 示例（当前v1.3.1基线唯一可能产出的形态）

```json
{
  "predictionId": "GMKG-ETH-24H-20260717T160000Z-PO",
  "instrument": "ETH",
  "horizon": "24h",
  "generatedAt": 1752768000000,
  "referencePrice": 3250.0,
  "referenceBarRef": { "symbol": "ETH", "timeframe": "15m", "openTime": 1752767100000, "closeTime": 1752768000000, "timeframeMs": 900000, "sequenceIndex": 0, "barKey": "ETH-15m-1752768000000" },
  "targetBarRef": { "symbol": "ETH", "timeframe": "15m", "openTime": 1752853500000, "closeTime": 1752854400000, "timeframeMs": 900000, "sequenceIndex": 96, "barKey": "ETH-15m-1752854400000" },
  "expectedBarCount": 96,
  "environment": {
    "growthRegime": "uncertain",
    "liquidityRegime": "uncertain",
    "riskRegime": "uncertain",
    "environmentPermission": "neutral",
    "regimeConfidence": 0,
    "note": "广度眼240项指标当前完全未接入（见§5现实标注），environment全字段恒为uncertain/neutral占位"
  },
  "target": {
    "operatingMode": "PRICE_ONLY_MODE",
    "primaryState": "UNKNOWN",
    "secondaryState": null,
    "candidateStates": [],
    "proxyState": "PO_TREND_UP_STRUCTURE",
    "stateConfidence": 28,
    "spotVsLeverageDriver": "insufficient_data",
    "trendHealth": "insufficient_data",
    "featureCompleteness": {
      "activeProfile": "PRICE_ONLY_MODE",
      "profileCompleteness": 1.0,
      "fullArchitectureCompleteness": 0.125,
      "criticalFeatureCompleteness": 1.0,
      "missingCriticalFeatures": []
    },
    "note": "profileCompleteness=1.0是因为A组6项本身齐全（当前唯一数据源），但fullArchitectureCompleteness=0.125（6/48）如实反映B-G组尚未接入，二者不得混为一谈，见P1-2红线"
  },
  "fusionState": "S2_BULL_EXPANSION",
  "trajectory": {
    "transitions": {
      "kind": "proxy",
      "records": [
        { "fromProxyState": "PO_TREND_UP_STRUCTURE", "toProxyState": "PO_TREND_UP_STRUCTURE", "elapsedTimeMs": 300000, "transitionWeight": 60, "probabilityStatus": "rule_based", "calibratedProbability": null, "sampleSize": null, "evidenceRefs": ["价格结构延续上行"], "statsGroup": "PROXY_STATS" }
      ]
    }
  },
  "actionPermission": {
    "readinessLevel": "OBSERVE",
    "readinessCeiling": "PREPARE",
    "gateStatus": "WAIT",
    "blockingReasons": [],
    "restrictionReasons": ["operatingMode=PRICE_ONLY_MODE，criticalFeatureCompleteness虽为1.0但fullArchitectureCompleteness过低，readinessCeiling不上调至ALLOW_TEST以上"],
    "waitingForSignals": ["等待15m/1h/4h既有V1.1决策核心给出当前触发确认"],
    "riskConditions": [],
    "mode": "DISPLAY_ONLY"
  },
  "algorithmVersion": "gmkg-draft-3-unimplemented",
  "weightVersion": "gmkg-fusion-weights-unvalidated-initial-1",
  "datasetVersion": "gmkg-dataset-binance-klines-only"
}
```

**红线核对**：13.1 是**未来目标形态**（`fullArchitectureCompleteness=0.93`），13.2 是**当前唯一可能产出的形态**（`primaryState='UNKNOWN'`、`proxyState`带`PO_`前缀、`fullArchitectureCompleteness=0.125`），两者并排存在正是为了防止实现时把 13.2 的输出误包装成 13.1 的样子。无论哪个示例，`readinessLevel`/`gateStatus` 组合、`mode='DISPLAY_ONLY'` 均确保24H/72H判断当前不产生任何交易生命周期副作用（见§12）。

---

## 14. 验证和学习闭环

### 14.1 不可变快照（每次正式预测必须保存，P0-2/P1-4修订）

呼应 `V1_2_FORECAST_SPEC.md`§12 已确立的"日志必须完整到能独立复现"原则，GMKG 每次正式预测的不可变快照即§10.1 `ForecastSnapshot`（24H/72H）——本节不再重复罗列字段清单，直接以 `ForecastSnapshot` 为唯一权威结构：当时广度指标状态、当时精度指标状态、原始数据引用（`dataVintageRefs`，含 `availableAt`/`vintageId`，见§4.3）、数据截止时间、联合状态快照（`targetStateAtGeneration`/`fusionStateAtGeneration`）、候选迁移（`candidateTrajectories.transitions`，携带§11.2 `TransitionBundle` 判别联合，`kind='formal'`/`'proxy'`/`'none'` 三选一，不混装）、情景权重（含§10.1 P1-NEW-3不变量）、校准状态、预计价格区间、触发条件、失效条件、算法/权重/数据集版本、以及P1-4新增的可复现性字段（`featureValuesUsed`/`featureEngineVersion`/`contentHash`）全部在生成时一次性冻结写入。

**红线**：原始预测**不可被后续结果覆盖**——`ForecastSnapshot`生成后是冻结记录，24H/72H实际结果、方向准确率、区间覆盖率、MFE/MAE等"事后才能知道"的字段，**不属于`ForecastSnapshot`本身**，而是记录在独立的 `ForecastOutcomeEvent`（§10.1）中，通过 `predictionId` 外键关联，**必须通过独立的追加事件回填**，不得原地修改 `ForecastSnapshot` 的任何字段值，这是防止"用后来的结果反向篡改历史预测"的结构性保证，与`V1_3_PAPER_TRADING_SPEC.md`"建仓快照冻结"、`V1_2_FORECAST_SPEC.md`§12.2"版本号红线"是同一类工程哲学的延伸。误差归因（§15 `ErrorAttribution`）同样通过 `predictionId` 关联的独立记录存在，不内嵌进 `ForecastSnapshot`。

**统计分母的独立性（P0-NEW-2/P0-NEW-1跨章节一致性核对项）**：本闭环中"更新迁移模型"必须只使用 `TransitionBundle.kind='formal'` 的 `FormalTransitionRecord`（进入 `FULL_STATE_STATS`），`kind='proxy'` 的记录永远不参与该模型更新（呼应§8.4/§7.0a红线）；"实际结果"统计同样区分 `directionEligibleForStatistics`（方向准确率分母）与 `pathEligibleForStatistics`（区间覆盖/MFE-MAE分母），两个分母独立维护，不得合并成一个笼统的"有效样本数"。

**`availableAt`/`vintage` 贯穿回放与校准（红线，跨章节一致性核对项）**：`ForecastSnapshot.dataVintageRefs` 记录的每个 `vintageId` 都可回溯到§4.3 `DataVintageRef` 的完整时间契约；历史回放/walk-forward（§8.5）验证任一历史 `ForecastSnapshot` 的正确性时，必须能够仅凭 `dataVintageRefs`（而非重新查询"当前最新数据"）重建当时模型实际看到的输入，这是`availableAt<=forecastCreatedAt`红线（§4.3/§8.5）在存储层面的落地保证。

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

### 17.1 V1.4 必须实现（【V1.4可实施最小范围】，P0-3/P0-2/P1-2/P1-5/P0-NEW-1/P0-NEW-2/P1-NEW-1至5修订）

1. 四系统接口的**类型定义**（`WorldState`/`TargetState`/`TrajectoryScenarios`/`ForecastResult`/`ActionPermission`的TypeScript接口，作为纯规范，不要求所有字段都有真实数据源支撑）；
2. 统一状态帧格式（§4.4 `StateFrame`结构定义，允许多数字段初期为空/`missing`，只要求结构存在）；
3. 数据时间和质量契约（§4.3 `DataVintageRef`全字段——`observationPeriod`/`publishedAt`/`availableAt`/`firstAvailableAt`/`fetchedAt`/`revisionNumber`/`vintageId`——的写入规则，即使当前只有Binance K线一个数据源，也要按此契约记录，为未来扩展预留一致的写入习惯；`DataRevisionEvent`追加式修订机制同步落地，即使当前K线数据本身极少触发修订）；
4. **运行模式与代理状态初稿（P0-3修订，取代draft-1错误表述"用A组实现八状态"）**——当前基线**只能**落地 `PRICE_ONLY_MODE`：用A组（价格与成交结构）特征输出 `proxyState`（`PriceOnlyStateId`，带`PO_`前缀），`primaryState`恒为`'UNKNOWN'`，**不得**输出任何S0-S7正式状态判定；§7.1的`FULL_STATE_MODE`正式判定逻辑作为**类型与规则的完整定义**先行落地（供未来B-G组数据到位后直接复用，不需要重新设计），但其判定函数在V1.4阶段不会被真实调用产生结果；
5. **迁移记录结构（P0-NEW-1修订：只落地`ProxyTransitionRecord`，不产出`FormalTransitionRecord`）**——§8.4 `ProxyTransitionRecord`结构落地为可写入的日志格式（`fromProxyState`/`toProxyState`均为`PriceOnlyStateId`），含`elapsedTimeMs`真实经过时间字段，初期只产出`probabilityStatus='rule_based'`的记录，`statsGroup`恒为`'PROXY_STATS'`；`FormalTransitionRecord`的**类型与规则**先行落地供未来复用，但当前基线只运行`PRICE_ONLY_MODE`，不会产生任何真实的`FormalTransitionRecord`实例（`INSUFFICIENT_DATA`下两种记录都不产生，见§8.4红线2）；`TrajectoryScenarios.transitions`（§11.2 `TransitionBundle`）当前恒为`{kind:'proxy',records:[...]}`或`{kind:'none'}`；
6. **历史预测不可变快照（P0-2修订，取代draft-1单一`LongHorizonForecastLog`）**——`ForecastSnapshot`（§10.1）结构落地，含`predictionId`/`dataVintageRefs`/`featureValuesUsed`/`contentHash`等P1-4可复现性字段；
7. **实际结果回填（P0-2修订）**——`ForecastOutcomeEvent`（§10.1）独立结构落地，只追加不覆盖，幂等回填函数（§10.6），缺失K线排除统计分母（§10.5）；
8. 误差归因结构（§15.2结构落地为可写入的日志格式，初期允许`primaryCause`判定规则很粗糙，但规则本身必须先定义、随代码一起冻结）；
9. Walk-forward验证基础（哪怕数据量很小，也要先把"按时间切分、不随机打乱、且只使用`availableAt<=forecastCreatedAt`版本"的验证脚手架搭起来，为未来扩大数据量做准备）；
10. 规则权重与校准概率隔离（贯穿以上所有结构，`calibratedProbability`/`calibrationVersion`等字段全部预先占位为`null`，与`V1_2_FORECAST_SPEC.md`既有红线完全同源）；
11. **就绪度/闸门分离与展示专属模式落地（P1-5/P0-4修订）**——`ActionPermission`的`readinessLevel`/`gateStatus`/`mode`三字段落地，V1.4阶段`mode`恒为`'DISPLAY_ONLY'`或`'AUDIT_ONLY'`，不接入既有15分钟交易生命周期（§12红线6）；
12. **完整度口径拆分落地（P1-2修订）**——`FeatureCompleteness`（`activeProfile`/`profileCompleteness`/`fullArchitectureCompleteness`/`criticalFeatureCompleteness`/`missingCriticalFeatures`）取代单一完整度数字，`PRICE_ONLY_MODE`下`criticalFeatureCompleteness`应可合理达到较高值（因为A组本身完整），不得被`fullArchitectureCompleteness`的低值拖累到无法展示任何有意义信息；
13. 使用当前Binance数据运行最小闭环（用A组价格/成交特征跑通"生成`ForecastSnapshot`→（等待）`ForecastOutcomeEvent`回填→误差归因→（暂不更新模型）"这条链路的**端到端存在性**，不追求准确率，只追求"闭环本身能跑通、数据不泄漏、快照不可变、幂等"这几条结构性要求）；
14. 为未来240+48项数据预留接口（`WorldState`/`TargetState`的字段结构提前按§5/§6定义好，即使多数字段初期为`null`/`missing`）；
15. §6.4 数据所有权表在类型/字段命名层面落地（即使B-G组大部分字段当前为`missing`，`sourceRef`命名约定必须从一开始就统一，避免未来接入时才发现广度眼/精度眼各自建了一套字段名）；
16. **`BarRef`统一引用结构与序号定位（P1-NEW-5修订）**——§10.1 `BarRef`（`openTime`/`closeTime`/`timeframeMs`/`sequenceIndex`/`barKey`）落地，`referenceBarRef`/`targetBarRef`均改用此结构；实现时必须先核实Binance K线`closeTime`的精确边界约定（`openTime+timeframeMs`还是`openTime+timeframeMs-1`），写入实施工单，不得含糊假设；
17. **路径K线完整性字段（P0-NEW-2修订）**——`ForecastOutcomeEvent`的`expectedBarCount`/`observedBarCount`/`missingBarRefs`/`endpointDataComplete`/`pathDataComplete`/`pathEligibleForStatistics`/`directionEligibleForStatistics`全部落地；`actualHigh`/`actualLow`/`mfe`/`mae`类型为`number|null`，数据不完整时严格为`null`，不得填0或近似值；
18. **RANGE专属路径指标与区间覆盖细分（P1-NEW-1/P1-NEW-2修订）**——`upperExcursion`/`lowerExcursion`/`maxAbsoluteExcursion`/`rangeBreachExcursion`（§10.4）与`endpointInBaselineZone`/`endpointInAnyScenarioZone`/`realizedRangeInsideExpectedEnvelope`/`expectedEnvelopeTouched`（§10.4a）落地，取代单一的`rangeCovered`；
19. **情景权重不变量校验（P1-NEW-3修订）**——`scenarioWeights`写入`ForecastSnapshot`前必须校验有限性/范围/求和为100，并实现归一化+舍入算法（具体算法在实施工单中冻结）；
20. **`readinessLevel`不受账户状态影响的实现约束（P1-NEW-4修订）**——`ActionPermission`计算函数中，账户/风控相关输入只允许写入`gateStatus`/`riskConditions`，不得出现任何"账户余额/冷却期→修改readinessLevel或readinessCeiling"的代码路径，V1.4阶段应有对应的单元测试断言这一隔离（正式测试代码留待未来实施阶段编写，本文档不创建测试文件）。

### 17.2 V1.4 只预留接口（不实现真实数据接入）

§5 12个数据域约240项指标的绝大多数、§6 B-G组48项中除A组以外的全部——这些字段在类型定义中存在，运行时允许长期为`missing`，**不阻塞**当前基于K线的最小闭环运行。

### 17.3 服务器版本实现（本轮及V1.4均不涉及）

§16.3列出的全部服务器架构组件；24H/72H两个新增时间尺度的真正历史校准（需要足够长的历史数据积累周期，不可能在V1.4阶段完成）；乘法融合权重的实际拟合（§11.1"待验证初始参数"转正需要真实历史校准，这本身就是服务器版本的工作）。

### 17.4 仍需研究的数据源

§5的12个数据域绝大多数具体数据源、§6 B-G组的OKX/CoinGlass/Deribit/Glassnode/Coin Metrics等——具体每项的官方API/免费额度/速率限制/CORS/授权条款需要专门的数据源研究阶段核实（参照此前V1.4数据层规划已经建立的研究方法论，本文档不重复展开逐项核实工作，那是独立的数据源矩阵文档的职责）。

---

## 18. 安全边界（重申，贯穿全文，本节做最终汇总）

继续禁止：真实交易；连接交易所账户；读取API密钥或私钥；发送订单；盈利保证；伪造概率（`calibratedProbability`未满足§8.5门槛前恒为null）；使用未来数据（§4.3`availableAt`红线/§8.2/§14.1数据泄漏防线）；覆盖历史预测（§10.1/§14.1`ForecastSnapshot`不可变红线）；削弱v1.3.1门控（§12逐条映射红线）；把候选数据源写成已经接入（全文【标注】体系的存在意义）；把目标架构写成当前已实现功能（同上，§7.0a/§13并排示例是这条红线的具体落实）；把同一份原始数据重复采集后双重计权（§6.4数据所有权红线）；把`PRICE_ONLY_MODE`代理判断包装成`FULL_STATE_MODE`正式状态（§7.0a/§7.0b红线）；让24H/72H判断绕过既有15分钟交易生命周期创建`WATCHLIST`/`EXECUTABLE`（§12红线）；把`ProxyTransitionRecord`混入`FULL_STATE_STATS`或正式校准分母（§8.4红线）；在路径K线不完整时对`actualHigh`/`actualLow`/`mfe`/`mae`等字段填0或近似值而非`null`（§10.1/§10.5红线）；让`scenarioWeights`三项之和不等于100或含NaN/Infinity/负值（§10.1情景权重不变量红线）；让账户/风控状态修改`readinessLevel`或`readinessCeiling`（§11.4红线，账户状态只能影响`gateStatus`）。

---

## 19. 文档完成后自检（两轮CEO复审共关闭P0×6/P1×11后，逐项如实填写，不再直接写"全部通过"）

### 19.1 CEO第一轮复审 P0/P1 十项关闭核对表

| # | 问题 | 关闭方式 | 关闭位置 |
|---|---|---|---|
| P0-1 | 历史时间契约不足，可能未来数据泄漏 | 新增`DataVintageRef`七字段完整定义，`availableAt<=forecastCreatedAt`红线写入walk-forward规则，`DataRevisionEvent`追加式修订机制取代原地改写 | §4.3、§4.3.1、§8.5、§14.1 |
| P0-2 | 预测日志缺少正式验证所需字段 | `LongHorizonForecastLog`拆分为`ForecastSnapshot`（不可变）+`ForecastOutcomeEvent`（追加），定义方向判定规则/RANGE阈值冻结/起止K线/MFE-MAE口径/缺失K线排除/幂等回填 | §10.1-10.6 |
| P0-3 | A组数据不能支持完整八状态 | 新增`FULL_STATE_MODE`/`PRICE_ONLY_MODE`/`INSUFFICIENT_DATA`三运行模式，逐状态列出最低数据组/能否识别/降级输出/统计分组，`primaryState`非FULL_STATE_MODE下恒为`UNKNOWN`，§17.1第4条错误表述已修正 | §7.0a、§7.0b、§17.1第4条 |
| P0-4 | 24H/72H许可不得直接升级现有15分钟交易信号 | 重写§12：范围声明限定为24H/72H专属；不得单独创建WATCHLIST/EXECUTABLE；不得直接调用四个交易门控函数；`mode`字段恒为`DISPLAY_ONLY`/`AUDIT_ONLY` | §12全节重写 |
| P1-1 | TargetState误用含CONFLICTED的类型 | 拆分`TargetStateId`（S0-S7+UNKNOWN）与`FusionStateId`（含CONFLICTED），`ForecastResult`新增`fusionState`字段，`TargetState.primaryState`统一改用`TargetStateId`（`TransitionRecord`本身已在第二轮P0-NEW-1中进一步拆分为`FormalStateId`专用的`FormalTransitionRecord`，见§19.1b） | §6.3、§7.4、§8.4、§9场景4、§11.4 |
| P1-2 | 数据完整度简单用"已获得指标数÷48" | 新增`FeatureCompleteness`（`activeProfile`/`profileCompleteness`/`fullArchitectureCompleteness`/`criticalFeatureCompleteness`/`missingCriticalFeatures`），行动许可与置信度改为主要参考`criticalFeatureCompleteness` | §6.3、§13.2示例 |
| P1-3 | 事件帧被当作普通迁移步数插入288帧序列 | `EventSnapshot`独立时间戳体系与存储，`StateFrame.eventState`只存引用，迁移记录（第二轮拆分后的`FormalTransitionRecord`/`ProxyTransitionRecord`）均新增`elapsedTimeMs`真实经过时间字段 | §4.2、§4.5、§8.4 |
| P1-4 | 原始数据引用不足以保证可复现 | `ForecastSnapshot`新增`featureValuesUsed`/`featureEngineVersion`/`contentHash`，与`dataVintageRefs`共同保证"即使来源后续修订/删除也能重建当时输入" | §10.1、§14.1 |
| P1-5 | 六档行动许可假设简单线性顺序 | 拆分为`readinessLevel`（四档线性）与`gateStatus`（OPEN/WAIT/BLOCKED独立轴），`readinessCeiling`只约束前者 | §11.4、§9场景4、§12、§13示例 |
| P1-6 | 广度眼/精度眼数据所有权重叠 | 新增§6.4数据所有权表，逐项冻结8个易重叠指标的唯一权威采集所有者与下游只读引用方式，`DataVintageRef.sourceRef`作为去重落地字段 | §6.4、§4.3 |

### 19.1b CEO第二轮复审 新P0×2/新P1×5 关闭核对表

| # | 问题 | 关闭方式 | 关闭位置 |
|---|---|---|---|
| P0-NEW-1 | 正式状态迁移与代理状态迁移类型冲突 | 拆出`FormalStateId`（S0-S7，不含UNKNOWN）；`TransitionRecord`拆分为`FormalTransitionRecord`（仅FULL_STATE_MODE产生，进`FULL_STATE_STATS`）与`ProxyTransitionRecord`（仅PRICE_ONLY_MODE产生，`fromProxyState`/`toProxyState`为`PriceOnlyStateId`，进`PROXY_STATS`）；`INSUFFICIENT_DATA`不产生迁移记录；删除"UNKNOWN↔自身"设计；`TrajectoryScenarios.transitions`改为`TransitionBundle`判别联合（`kind:'formal'\|'proxy'\|'none'`） | §6.3、§8.4、§11.2、§11.4、§13示例、§14.1、§17.1第5条 |
| P0-NEW-2 | 路径K线完整性不足 | `ForecastOutcomeEvent`新增`expectedBarCount`/`observedBarCount`/`missingBarRefs`/`endpointDataComplete`/`pathDataComplete`/`pathEligibleForStatistics`/`directionEligibleForStatistics`；`actualHigh`/`actualLow`/`mfe`/`mae`改为`number\|null`，路径不完整时严格为null；方向类统计与路径类统计分母彻底分离 | §10.1、§10.5、§17.1第17条 |
| P1-NEW-1 | RANGE方向MFE/MAE公式未冻结 | 冻结RANGE专属指标`upperExcursion`/`lowerExcursion`/`maxAbsoluteExcursion`/`rangeBreachExcursion`公式；`expectedDirection='RANGE'`时`mfe`/`mae`恒为null，不借用带方向语义的公式 | §10.4、§10.4a |
| P1-NEW-2 | 区间覆盖指标含糊 | `rangeCovered`拆分为`endpointInBaselineZone`/`endpointInAnyScenarioZone`/`realizedRangeInsideExpectedEnvelope`/`expectedEnvelopeTouched`，并定义`expectedEnvelope`（三情景区间合并总下沿到总上沿） | §10.1、§10.4a |
| P1-NEW-3 | 情景权重缺乏不变量 | 冻结`scenarioWeights`不变量：三项均为有限数、范围0-100、禁止NaN/Infinity/负值、和恒为100（含归一化+舍入规则）；重申`scenarioWeights`≠`calibratedProbabilities`，不得复用字段 | §10.1 |
| P1-NEW-4 | 账户状态可能改变readinessLevel | 撤销draft-2"账户/风控可以把readinessLevel往下压"的错误注释；明确`readinessLevel`/`readinessCeiling`只由预测证据/数据质量/时间尺度/历史校准状态决定，账户状态只影响`gateStatus`，`riskConditions`仅供只读展示 | §11.4 |
| P1-NEW-5 | 15分钟K线边界与索引规则未冻结 | 新增`BarRef`（`openTime`/`closeTime`/`timeframeMs`/`sequenceIndex`/`barKey`）；`referenceBar`固定`sequenceIndex=0`且不计入目标路径；目标路径为`sequenceIndex 1..96/288`；要求按`sequenceIndex`遍历定位而非纯毫秒加法；标注`closeTime`边界约定须在实施工单中用真实API核实冻结 | §10.1、§10.2 |

### 19.2 逐项自检（如实反映修订后状态，不再统一写"通过"）

| # | 自检项 | 结论 |
|---|---|---|
| 1 | 四系统职责是否互不重叠 | 达标——见§3非重叠性核对表；§6.4进一步关闭了广度眼/精度眼之间此前未察觉的8项数据所有权重叠 |
| 2 | 预测融合与行动许可是否分离 | 达标——见§11.4 `ForecastResult`/`ActionPermission`两个独立接口；`ActionPermission`内部拆分为`readinessLevel`/`gateStatus`两个正交字段；第二轮进一步撤销了"账户可压低readinessLevel"的错误表述，账户状态现在只能触及`gateStatus`，分离边界比draft-2更严格（P1-NEW-4） |
| 3 | 240和48项是否标记为目标架构 | 达标——§5/§6开篇均有【目标架构】/【仍需研究/授权/付费】现实标注；§13.2新增示例进一步用具体数字（`fullArchitectureCompleteness=0.125`）量化"当前差距有多大"，比draft-1的文字声明更难被忽视 |
| 4 | 300帧是否包含as-of时间和数据质量 | 达标——见§4.3/§4.4 `DataVintageRef`完整七字段时间契约、`StateFrame.dataQuality`；§4.5关闭了draft-1"事件插入288帧序列"的错误表述 |
| 5 | 八状态是否具备可计算方向 | **部分达标，如实标注差距**——`FULL_STATE_MODE`下§7.1定义了每状态的完整可计算规则，其迁移记录（`FormalTransitionRecord`）类型与统计分组也已在第二轮冻结（§8.4）；但当前v1.3.1基线只有A组数据，只能运行在`PRICE_ONLY_MODE`，只产生`ProxyTransitionRecord`，无法产出真正的S0-S7判定或正式迁移率，该差距已通过§7.0a/§7.0b/§8.4/§13.2明确标注，不再像draft-1那样含糊带过 |
| 6 | 规则权重是否与概率严格分离 | 达标——见§8.2/§8.5/§11.1/§13示例，`calibratedProbability`全文恒为null（未校准场景） |
| 7 | 24H和72H是否独立验证 | 达标——见§10.1 `ForecastSnapshot`/`ForecastOutcomeEvent`独立结构，§9场景2允许方向不同；第二轮进一步补齐了路径K线完整性判定（`pathDataComplete`/`endpointDataComplete`）、RANGE专属指标、区间覆盖四分法、情景权重不变量、`BarRef`序号定位规则，此前"用targetBarRef存在就声称完整"的隐患已关闭（P0-NEW-2/P1-NEW-1/P1-NEW-2/P1-NEW-3/P1-NEW-5） |
| 8 | 冲突状态是否允许WAIT | 达标——见§9场景4 `fusionState='CONFLICTED'`/`gateStatus='WAIT'`/`readinessLevel`强制降为`OBSERVE`/`waitingForSignals` |
| 9 | 误差归因是否防止事后解释 | 达标——见§15.3"归因规则必须结果发生前预先定义"；§14.1补充说明`ErrorAttribution`同样通过`predictionId`独立记录，不内嵌`ForecastSnapshot` |
| 10 | 是否保留v1.3.1全部安全门控 | 达标——见§12全节重写后的红线1-10，源码已核实（`buildTradeProposal`/`processTradeGate`/信号快照字段）；本轮额外关闭了"24H/72H许可绕过既有信号创建"这一此前未覆盖的风险点（P0-4） |
| 11 | 是否诚实说明单文件HTML限制 | 达标——见§16.1-16.2，未在本轮改动 |
| 12 | 是否明确V1.4最小范围 | 达标——见§17.1-17.4；§17.1第4条已修正draft-1"用A组实现八状态"的错误表述，改为如实说明V1.4只能落地`PRICE_ONLY_MODE`代理输出 |
| 13 | 是否没有修改业务代码 | 达标——本轮只修改本文档一个文件（`GMKG_DRAGONFLY_ARCHITECTURE.md`），未修改任何HTML/JS/测试文件，未触碰工作区其他未跟踪文件 |

---

## 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| gmkg-draft-1 | 2026-07-17 | 初稿：冻结GMKG四系统核心原则、命名消歧（与既有蜻蜓捕猎模型区分）、360度/300帧工程定义、广度眼12域240项、精度眼48项、单眼八状态模型、迁移模型与概率红线、冲突裁决四场景、时间尺度、融合中枢双输出、与v1.3.1行动许可兼容映射、最终输出快照示例、验证学习闭环、误差归因、架构现实边界、V1.4最小范围建议、安全边界与自检 |
| gmkg-draft-2 | 2026-07-17 | CEO正文复审关闭P0×4/P1×6：①新增`DataVintageRef`七字段时间/版本契约+`DataRevisionEvent`追加式修订，冻结`availableAt<=forecastCreatedAt`防泄漏红线（P0-1）；②`LongHorizonForecastLog`拆分为不可变的`ForecastSnapshot`与追加式的`ForecastOutcomeEvent`，定义方向判定/RANGE阈值冻结/起止K线/MFE-MAE口径/缺失K线排除/幂等回填（P0-2）；③新增`FULL_STATE_MODE`/`PRICE_ONLY_MODE`/`INSUFFICIENT_DATA`三运行模式与逐状态最低数据组表，修正"用A组实现八状态"错误表述（P0-3）；④重写§12，24H/72H许可限定为`DISPLAY_ONLY`/`AUDIT_ONLY`，明确不得绕过既有15分钟交易生命周期创建WATCHLIST/EXECUTABLE或直接调用四个交易门控函数（P0-4）；⑤拆分`TargetStateId`与`FusionStateId`（P1-1）；⑥新增`FeatureCompleteness`四层完整度取代单一数字（P1-2）；⑦`EventSnapshot`独立时间栅格，`TransitionRecord`新增`elapsedTimeMs`（P1-3）；⑧`ForecastSnapshot`新增`featureValuesUsed`/`featureEngineVersion`/`contentHash`可复现性字段（P1-4）；⑨`ActionPermission`拆分为`readinessLevel`/`gateStatus`两个正交字段（P1-5）；⑩新增§6.4数据所有权表关闭8项广度眼/精度眼采集重叠（P1-6）；同步更新§13示例（并排展示FULL_STATE_MODE与PRICE_ONLY_MODE）、§17 V1.4范围、§19自检（改为逐项如实填写并新增P0/P1关闭核对表） |
| gmkg-draft-3 | 2026-07-17 | CEO第二轮正文复审关闭新P0×2/新P1×5：①拆出`FormalStateId`（S0-S7不含UNKNOWN），`TransitionRecord`拆分为`FormalTransitionRecord`（仅FULL_STATE_MODE，进FULL_STATE_STATS）与`ProxyTransitionRecord`（仅PRICE_ONLY_MODE，`fromProxyState`/`toProxyState`为PriceOnlyStateId，进PROXY_STATS），INSUFFICIENT_DATA不产生迁移记录，删除"UNKNOWN↔自身"设计，`TrajectoryScenarios.transitions`改为`TransitionBundle`判别联合（P0-NEW-1）；②`ForecastOutcomeEvent`新增`expectedBarCount`/`observedBarCount`/`missingBarRefs`/`endpointDataComplete`/`pathDataComplete`/`pathEligibleForStatistics`/`directionEligibleForStatistics`，`actualHigh`/`actualLow`/`mfe`/`mae`改为`number|null`且路径不完整时严格为null（P0-NEW-2）；③冻结RANGE专属`upperExcursion`/`lowerExcursion`/`maxAbsoluteExcursion`/`rangeBreachExcursion`公式，RANGE下mfe/mae恒为null（P1-NEW-1）；④`rangeCovered`拆分为`endpointInBaselineZone`/`endpointInAnyScenarioZone`/`realizedRangeInsideExpectedEnvelope`/`expectedEnvelopeTouched`并定义`expectedEnvelope`（P1-NEW-2）；⑤冻结`scenarioWeights`有限性/范围/求和为100的不变量，重申与`calibratedProbabilities`不共用字段（P1-NEW-3）；⑥撤销"账户可压低readinessLevel"的错误表述，明确账户状态只影响`gateStatus`（P1-NEW-4）；⑦新增`BarRef`统一引用结构与`sequenceIndex`定位规则，`referenceBar`不重复计入目标路径（P1-NEW-5）；同步更新§8.4、§10.1-10.5、§11.2、§11.4、§13两个示例JSON、§14.1、§17.1、§18安全边界、§19自检（新增19.1b核对表） |
