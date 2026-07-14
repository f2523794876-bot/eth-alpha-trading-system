# CODEX_IMPLEMENTATION_TASK.md — 给 Codex 开发阶段的完整实现任务

版本：v2.1（第三轮修订。CEO第二轮验收**不批准**V1停留在15分钟单周期，V1范围正式扩大为三周期REST决策核心，详见第1节。STRATEGY_SPEC.md 第12-20节的算法定义本身未变，变的是"V1阶段要不要现在实现"的边界）
依据：`PROJECT_AUDIT.md`（问题清单）+ `STRATEGY_SPEC.md`（算法真相来源）。本文档只定义"怎么落地成代码"，不重复定义算法本身——任何算法细节以 STRATEGY_SPEC.md 为准，如本文档与之冲突，以 STRATEGY_SPEC.md 为准并回来修正本文档。

角色分工：董事长最终决策，ChatGPT(CEO)负责调度与验收，Claude Code（本文档作者）负责架构设计与代码审计，**Codex 负责实际编码**。本文档是写给 Codex 的工单。

**历史回测框架"不在本阶段范围"这一表述在第二轮已被撤销**（历史回测是正式规划，只是排在V2）。**v2.0曾把三周期架构也一并列为V2/V3才做——这一条在第三轮被CEO明确推翻**：三周期REST数据与三周期决策现在是V1的硬性交付项，见第1.2节。

---

## 1. 开发基础与 V1/V2/V3 分阶段工程结构（v2.1：V1范围经CEO第二轮验收扩大）

### 1.1 分阶段的依据没变，但V1的边界线移动了
架构级新增原本有三项：三周期架构、WebSocket实时化、历史回测实验室。CEO第二轮验收决定：**三周期架构不再算"以后再做"的部分，必须在V1完成**；WebSocket和历史回测继续留在V3/V2。分阶段的意义因此收窄为"REST版三周期决策核心（V1）→ 历史验证引擎（V2）→ 实时化与运维能力（V3）"，不再是"单周期（V1）→ 多周期+实时+回测都往后拖"。

### 1.2 V1：三周期REST决策核心（本阶段Codex的实际交付范围，CEO批准的17项）
- 载体：仍是单文件 `eth-dynamic-trading-dashboard.html`，双击打开，不依赖构建工具。
- 数据源：**REST定时刷新，不要求WebSocket**（WS推迟到V3）。
- V1必须完成的17项（逐项对应STRATEGY_SPEC.md章节，全部要在这一轮交付，不是占位）：

| # | 必须完成项 | 对应STRATEGY_SPEC章节 |
|---|---|---|
| 1 | ETH和BTC的15分钟、1小时、4小时REST K线（共6路） | §0（多周期K线集合）、§14.1（REST部分） |
| 2 | 已收盘与未收盘K线分离 | §13、§0、§2.3 |
| 3 | 4小时战略方向（HTF六态） | §12.2 |
| 4 | 1小时趋势结构（复用§8六态） | §12.2末段 |
| 5 | 15分钟执行位置（六态状态机） | §8 |
| 6 | BTC对应周期联动 | §4、§12.3 |
| 7 | P0/P1修复 | §2.3（confirmedPrice）、PROJECT_AUDIT §4.1-4.7 |
| 8 | ATR、EMA、Swing | §3、§5 |
| 9 | 区域化支撑压力 | §15 |
| 10 | 毛盈亏比与净盈亏比（扣手续费/价差/滑点） | §10、§10.1a |
| 11 | 成交量质量 | §16 |
| 12 | 透明信号评分（现在4h/1h是真实数据，不是占位0分） | §17 |
| 13 | 小仓试错、专业加仓、离场条件 | §8.2 |
| 14 | 蜻蜓最佳拦截区 | §7 |
| 15 | 数据健康与安全降级（REST版三级健康状态） | §9、§14.5-§14.7（REST子集） |
| 16 | 决策日志（不含条件提醒推送，条件提醒移至V3） | §19.1 |
| 17 | 合成K线自动测试 | ACCEPTANCE_TESTS.md |

**与v2.0的关键差异**：第17节评分系统中"4小时方向"（20分）"1小时结构"（15分）两项**不再是固定0分的占位**，必须用真实的4小时/1小时REST快照计算；`DecisionOutput.signalPermission` 必须是 `computeSignalPermission`（§12.4）的真实计算结果，不是占位值；`DecisionLogEntry.htfState`/`mtfState` 必须填真实状态，不再是 `'not_available_v1'`。

- 轮询间隔建议（REST定时刷新，避免不必要的高频请求）：15分钟序列每20-30秒轮询一次，1小时序列每5分钟轮询一次，4小时序列每15-20分钟轮询一次——三个周期各自的K线本身变化频率不同，没必要都按15分钟的频率打Binance API。
- 工程要求（为V2/V3铺路，V1阶段必须做到）：`analyzeKlines`/`classifyState`/`buildAdvice`/`calcRiskReward` 等核心函数**必须是不依赖DOM的纯函数**（输入K线数组和快照对象，输出结构化结果，不直接操作 `document`），渲染层单独一层只读取这些函数的返回值写入DOM。这是 STRATEGY_SPEC §18.5 明确要求的，直接决定 V2 能否顺利复用。`classifyState` 必须做到"周期无关"，能不做修改地同时喂给15分钟和1小时数据用（STRATEGY_SPEC §12.2已经是按这个假设设计的）。

### 1.3 V2：历史验证引擎（不在本阶段范围，保持不变）
独立 Node.js 脚本/小工程，不要求单文件、不要求双击打开。复用 V1 的纯函数，实现 STRATEGY_SPEC §18 定义的回放引擎、防未来数据泄漏规则、训练/验证/测试集划分、滚动样本外验证、参数敏感性测试、统计报告产出。**本阶段Codex不需要写V2的任何代码**，但如果V1阶段把纯函数写成了依赖DOM的形式，将直接导致V2无法启动，因此V1阶段的"纯函数"要求是硬性的。

### 1.4 V3：WebSocket、条件提醒与长期运行监控（不在本阶段范围，范围经CEO第二轮验收调整；v1.3新增说明：本节原列的"模拟仓位"已拆出，不再属于V3，见下方标注与`V1_3_PAPER_TRADING_SPEC.md`）
在V1基础上叠加以下三项，**均不在本阶段Codex交付范围内**：
- **WebSocket实时架构**：STRATEGY_SPEC §14 完整WS连接状态机、自动重连退避、缺失K线检测、三周期同步（V1用REST轮询实现§14的对应子集，见1.2节）。
- **条件提醒推送**：STRATEGY_SPEC §19.2 八类条件提醒的浏览器 `Notification API` 推送（V1只做决策日志的被动记录，不做主动推送）。
- **长期运行监控（v2.1新增概念）**：页面长时间挂机运行时的自我监控——记录WebSocket/REST的可用率、平均延迟、重连次数、数据缺口次数等运行指标，属于运维可观测性功能，不影响交易判断逻辑本身。

**（v1.3范围调整说明）**：本节原有的第三项"模拟仓位（Paper Position Tracking，v2.1新增概念）"——即"允许用户在UI标记'如果此刻按建议开仓'，系统据此虚拟记录方向/开仓价/止损/目标，后续每个tick比对实时价格计算浮动盈亏，价格触及止损/目标时自动标记平仓结果并写回决策日志的`outcome`字段"这一简化构想——已由CEO决定拆出V3，作为独立的V1.3阶段实现，且实际交付范围远超本节原先的构想（真实账户记账、多空持仓生命周期、风险预算与日亏损/回撤锁定、保守成交撮合），详见`V1_3_PAPER_TRADING_SPEC.md`。本节此后不再是模拟仓位的权威定义来源。

### 1.5 本阶段产出物与授权事项（v2.1新增）
- 仍为单文件：`eth-dynamic-trading-dashboard.html`（直接改这一个文件）。如需新增测试脚本，遵循 ACCEPTANCE_TESTS.md 的建议（例如 `legacy-tests/run-tests.mjs`），不新建其他正式产品文件。
- **Codex被明确授权在项目目录内执行 `git init` 并提交一次开发基线**（含现有全部文件），这是CEO第二轮验收的决定，不需要再向用户确认，建议作为V1开发的第一步执行，便于后续追溯每一步改动。
- **旧文件（`index.html`/`style.css`/`app.js`/`eth-trading-dashboard.html`）本轮暂时保持原样，不删除、不移动、不归档**——这也是CEO的明确决定，第6节的相关表述已同步更新，不再建议移入 `legacy/`。
- **Binance API 在真实浏览器下的 CORS 与地域可用性，由 Codex 在V1阶段直接实测并记录结果**（覆盖全部6路REST请求，不只是过去验证过的15分钟一路），不是需要额外等待的前置阻塞条件，实测方法见第5节最后一步。

---

## 2. 函数接口（Codex 必须实现的最小函数集合，签名固定，内部实现细节自行组织但行为必须匹配 STRATEGY_SPEC.md）

```js
// ---- 数据获取（v2.1：扩展到6路REST，15m/1h/4h × ETH/BTC）----
async function fetchKlines(url) -> Kline[]                      // 已存在，保留，补加：超时(建议8s) + 单次重试
async function fetchAllTimeframeKlines() ->
  { eth: {tf15m: Kline[], tf1h: Kline[], tf4h: Kline[]}, btc: {tf15m: Kline[], tf1h: Kline[], tf4h: Kline[]} }
  | { partial: true, succeeded: string[], failed: string[] }    // 六路中只要有一路失败就标记partial，调用方按STRATEGY_SPEC §14.7健康状态降级，不是非黑即白的null

// ---- 基础指标 ----
function emaSeries(closes: number[], period: number) -> number[]
function calcATR(klines: Kline[], period: number) -> number | null
function findSwings(klines: Kline[]) -> { highs: SwingPoint[], lows: SwingPoint[] }   // 需内含 STRATEGY_SPEC §5.2 的六项异常处理，不是只做基本规则
function detectAnomalyBars(klines: Kline[], atr14: number) -> Set<number>             // 返回异常K线下标集合，STRATEGY_SPEC §9.3

// ---- 核心分析（周期无关，15分钟/1小时/4小时三个周期都调用同一份实现）----
function analyzeKlines(klines: Kline[], timeframe: '15m'|'1h'|'4h') -> AnalyzedSnapshot
  // 必须实现 STRATEGY_SPEC §1.2 完整字段，尤其 priorStructureHigh20/Low20 与 isBreakout/isBreakdown 的"冻结结构"定义（§2.1-§2.3），这是修复 P0 缺陷的核心函数
  // v2.1：三个周期（15m/1h/4h）各自独立调用本函数六次（ETH×3 + BTC×3），不写三套重复实现
function analyzeManual(input: ManualInput) -> AnalyzedSnapshot  // §9.5 手动模式降级规则；手动模式只能覆盖15分钟层，UI需说明4h/1h在手动模式下不可用

// ---- BTC联动 ----
function classifyBtcTrend(btcSnapshot: AnalyzedSnapshot) -> 'up'|'down'|'flat'   // §4，可直接复用analyzeKlines算出的trend字段，不必单独实现
function btcAlignment(ethBias: string, btcSnapshot: AnalyzedSnapshot) -> 'support'|'conflict'|'neutral'   // §4，15m/1h/4h三个周期各调用一次

// ---- 假突破分级 ----
function falseBreakoutTier(eth: AnalyzedSnapshot, btc: AnalyzedSnapshot) -> 'none'|'warning'|'confirmation_failed'   // §6，六项判据d1-d6全部实现，不能只做d2/d4两项；15m/4h各自独立调用（1h结构层是否需要假突破分级由§12.2决定，1h直接复用§8整套六态机制含此函数）

// ---- 状态机（15分钟执行层 + 1小时结构层，同一实现） ----
function classifyState(eth: AnalyzedSnapshot, btc: AnalyzedSnapshot, prevState?: string) -> { state: string, tier: string }
  // §8.1 六态优先级判定 + §8.3 防抖规则（prevState 用于防抖，允许为空，为空时不做防抖直接判定）
  // v2.1：1小时结构层直接调用本函数（输入换成1小时快照），不重新实现一份

// ---- 4小时HTF状态机（v2.1：从V2/V3草案转正为V1必须实现）----
function classifyHtfState(eth4h: AnalyzedSnapshot, btc4h: AnalyzedSnapshot, prevHtfState?: string) -> { state: string, tier: string }
  // §12.2，六个HTF状态（HTF_BULL_TREND/HTF_BEAR_TREND/HTF_BULL_PULLBACK/HTF_BEAR_REBOUND/HTF_RANGE/HTF_TRANSITION）
  // 复用§8.1的判定结构（进入/保持/退出/优先级），只是重命名和调整"趋势延续"语义，不是从零设计一套新状态机

// ---- 三周期信号权限（v2.1：从V2/V3草案转正为V1必须实现）----
function computeSignalPermission(htf, mtf, ltf, btcHtf, btcMtf, btcLtf, dataHealth) -> SignalPermission
  // §12.4，四条规则：三周期同向且BTC支持→trend_entry_allowed；15m逆4h→counter_trend_only；
  // 多周期冲突或BTC不支持→stand_aside；数据异常→blocked_by_data

// ---- 建议 / 试仓加仓离场 ----
function buildAdvice(eth, btc, stateInfo, signalPermission) -> { advice, biasDirection, entryZone }
  // v2.1：新增 signalPermission 参数，15分钟层给出的建议文案必须体现三周期权限判定的约束（例如counter_trend_only时必须声明"仅反弹/回调，不可加仓"）
function buildAddOnCondition(eth, biasDirection, signalPermission) -> string  // §8.2，独立字段，禁止省略；v2.1新增风险预算与signalPermission.addOnAllowed双重约束
function buildExitConditions(eth, stopLoss, targets, state) -> string[] // §8.2 五类离场条件全部列出（含v2.0新增BTC反向/假突破两类）
function buildStopAndTargets(eth, biasDirection) -> { stop, targets, base }  // §2.5 + §3.3，含v2.0移动止损

// ---- 盈亏比（毛/净两套） ----
function calcRiskReward(eth, btc, biasDirection, stop, targets, tradingCost) -> RiskReward   // §10，8类边界情况 + 2个flags + 毛/净RR（§10.1a），不是只处理risk<=0一种

// ---- 蜻蜓模型 ----
function bestInterceptionZone(state, tier, biasDirection, eth) -> { zone, text }  // §7，函数体只能引用已算好的状态量，不允许引入新判断分支

// ---- 数据质量 / 安全降级（v2.1：扩展到六路数据源与三周期同步）----
function assessDataQuality(klines: Kline[]) -> DataQuality        // §9.1 数量不足 + §9.2 陈旧判断，六路各自独立调用
function assessOverallHealth(ethTf, btcTf) -> 'normal'|'delayed'|'invalid'  // §14.5-§14.7 REST版：六路数据质量 + ETH/BTC同周期时间同步 + 三周期滞后检测综合得出
function validateManualInput(input: ManualInput) -> { ok: boolean, errorField?: string, message?: string }  // §9.4

// ---- 支撑压力区域 / 成交量质量 / 评分 ----
function buildSRZones(eth: AnalyzedSnapshot) -> { supportZones: SRZone[], resistanceZones: SRZone[] }   // §15 支撑压力区域化，15分钟层为主
function calcVolumeQuality(klines: Kline[], atr14: number, state: string) -> VolumeQuality               // §16 成交量质量
function calcScore(eth15m, eth1h, eth4h, riskReward, volumeQuality, dataHealth, signalPermission) -> ScoreBreakdown
  // §17，v2.1：4h/1h两项使用真实快照计算，不再是占位0分；signalPermission的alignment/level直接影响扣分项

// ---- 决策日志（v2.1：V1必须实现，不含条件提醒推送）----
function buildDecisionLogEntry(decision: DecisionOutput) -> DecisionLogEntry   // §19.1，htfState/mtfState 填真实三周期状态，不再是占位

// ---- 顶层编排（每个tick调用一次） ----
function buildDecision(ethTf, btcTf, manualInput, prevStates, tradingCost) -> DecisionOutput
  // ethTf/btcTf = {tf15m, tf1h, tf4h} 三路K线；prevStates = {ltf, mtf, htf} 三层防抖状态
  // 编排以上所有函数：三个周期各自 analyzeKlines → 15m/1h走classifyState，4h走classifyHtfState → computeSignalPermission →
  // 15分钟执行层输出建议 → buildSRZones/calcVolumeQuality/calcRiskReward/calcScore → 组装 DecisionOutput
  // 返回 STRATEGY_SPEC §1.4 定义的完整 DecisionOutput，htf4h/mtf1h/signalPermission 均为真实计算结果

// ---- V2/V3 接口草案（本阶段不实现，仅记录以保持与STRATEGY_SPEC架构一致，签名可能在V2/V3阶段调整）----
// function connectRealtimeStreams(onMessage, onStateChange) -> ConnectionHandle                             // §14 WS部分，V3
// function checkAlertConditions(prevDecision, decision) -> AlertEvent[]                                     // §19.2，V3（V1不做主动推送）
// function trackPaperPosition(decision, userAction) -> PaperPositionState                                   // 模拟仓位，已于v1.3拆出单独实现（不再是V3），见V1_3_PAPER_TRADING_SPEC.md
// function collectRuntimeHealthMetrics() -> RuntimeHealthReport                                             // 长期运行监控，V3新增
// function runBacktest(historicalKlines, params) -> BacktestReport                                          // §18，V2专属工程，不在HTML内
```

**禁止事项（接口层面）**：
- 任何一个"判断是否突破/跌破"的分支，禁止直接写 `price > eth.firstResistance.price` 这种自过滤比较，必须走 `eth.isBreakout`/`eth.isBreakdown`，且这两个字段必须用 `confirmedPrice` 而非 `price` 计算（STRATEGY_SPEC §2.3、§13 v2.0修正）。Code Review 时会专门检查这一点，这是本次任务的头号红线，v2.0起同时检查是否正确使用了 `confirmedPrice`。
- `buildDecision` 及其调用链中，任何函数都不得接收 `manualRefLevels`（人工参考位）作为参数（STRATEGY_SPEC §11 强约束）。
- 不允许把 §9.1 的"数据不足降级"逻辑散落到多个函数里各写一份，必须统一从 `assessDataQuality` 一个入口产出，其余函数只读取 `dataQuality` 字段做分支。
- （v2.0新增）不允许在 `calcVolumeQuality` 或任何成交量相关函数之外的地方，让成交量字段单独触发状态转换（STRATEGY_SPEC §16 硬性声明，成交量只能是六项假突破判据之一/评分分项之一/证据列表条目之一）。
- （v2.0新增）`calcScore` 的输出 `ScoreBreakdown.total` 不允许出现在 `worthBetting` 的判断表达式里（STRATEGY_SPEC §17.3），两条判断链路必须独立，Code Review会专门检查是否有人图省事把评分和硬性规则耦合在一起。
- （v2.1修正：原此处曾禁止"提前实现§12三周期权限"，该条已被CEO第二轮验收撤销——§12三周期权限现在是V1必须实现的部分，见第1.2节）**V1阶段仍然不得**实现 §14（WebSocket部分）、§18（回测引擎）、§19.2（条件提醒推送）、模拟仓位、长期运行监控的真实功能代码——这五项在当时是第1.3/1.4节明确的V2/V3范围，提前实现属于范围蔓延，会挤占V1核心工作的时间。（v1.3范围调整说明：模拟仓位已于v1.3阶段拆出单独实现，不再属于V3范围，见`V1_3_PAPER_TRADING_SPEC.md`；本条对V1阶段本身的历史约束不变。）

---

## 3. 数据流（单次 tick 的完整链路，v2.1：三周期版）

三个周期各自独立轮询（15m每20-30s，1h每5min，4h每15-20min，见第1.2节），下图展示的是"三路数据都到位后"合成一次完整决策的逻辑链路；某一路尚未到最新轮询时间时，沿用该路上一次的快照继续参与计算，不强制三路必须同一毫秒刷新。

```
[三路独立定时器 / 用户点击"重试"]
        │
        ▼
fetchAllTimeframeKlines() ──全部/部分失败──► 展示"实时数据获取失败"或"部分周期数据缺失"横幅
        │成功（或用户已填手动输入，手动仅覆盖15m层）
        ▼
assessDataQuality × 6（ETH/BTC × 15m/1h/4h 各一次，§9.1/§9.2）
        │
        ▼
assessOverallHealth(ethTf, btcTf) → dataHealth ∈ {normal, delayed, invalid}（§14.5-§14.7 REST版）
        │
        ├─ dataHealth=='invalid' ──► signalPermission强制blocked_by_data，worthBetting强制false（§12.4规则4），仍继续渲染但明确标注"数据失效"
        │
        ▼ (数据充分或降级但仍可展示)
analyzeKlines(eth15m,'15m')  analyzeKlines(eth1h,'1h')  analyzeKlines(eth4h,'4h')
analyzeKlines(btc15m,'15m')  analyzeKlines(btc1h,'1h')  analyzeKlines(btc4h,'4h')
        │                         │                         │
        ▼                         ▼                         ▼
falseBreakoutTier(eth15m,btc15m)  classifyState(eth1h,btc1h,prevMtfState)   classifyHtfState(eth4h,btc4h,prevHtfState)
        │                         │                         │
        ▼                         │                         │
classifyState(eth15m,btc15m,prevLtfState)                   │
        │                         │                         │
        └─────────────┬───────────┴─────────────────────────┘
                       ▼
          computeSignalPermission(htf, mtf, ltf, btcHtf, btcMtf, btcLtf, dataHealth)  （§12.4，四条规则）
                       │
                       ▼
          buildAdvice(eth15m, btc15m, ltfStateInfo, signalPermission)
          buildAddOnCondition / buildExitConditions / buildStopAndTargets（含移动止损）
                       │
                       ▼
          calcRiskReward（含毛/净RR，§10.1a）
                       │
                       ▼
          bestInterceptionZone
                       │
                       ▼
          buildSRZones ──► calcVolumeQuality ──► calcScore(eth15m, eth1h, eth4h, ..., signalPermission)（§15/§16/§17，评分现在4h/1h是真实值）
                       │
                       ▼
          组装 DecisionOutput（htf4h/mtf1h/signalPermission 均为真实计算结果，不是占位）
                       │
                       ▼
          buildDecisionLogEntry ──► 写入 localStorage（§19.1，htfState/mtfState填真实值）
                       │
                       ▼
          render(DecisionOutput) ──► 写入DOM（含三周期总览区域）
                       │
                       ▼
          prevLtfState/prevMtfState/prevHtfState = 本次三层状态   （供下一次tick各自防抖使用）
```
**V1不做的部分**：条件提醒推送（`checkAlertConditions`+`Notification`）、模拟仓位、长期运行监控——这三项在当时留给V3（第1.4节），本图未画出。（v1.3范围调整说明：模拟仓位已拆出，于v1.3阶段实现，不再属于V3，见`V1_3_PAPER_TRADING_SPEC.md`；条件提醒推送、长期运行监控仍留在V3。）

---

## 4. UI 区域（沿用现有页面分区，标注每个区域改动范围）

| 区域 | 现状 | 本阶段改动 |
|---|---|---|
| 顶部价格卡片（ETH/BTC价格+涨跌） | 已有 | 不变，仅数据来源换成 `DecisionOutput` 里的字段 |
| 数据源状态条 | 已有 | **新增**：数据陈旧横幅（§9.2）、异常K线剔除提示（§9.3） |
| 手动输入面板 | 已有6个字段 | 接入 `validateManualInput`，校验失败时逐字段报错，不再是简单的"全部非空即可" |
| 决策面板（状态/建议/盈亏比） | 已有 | 状态文案改为六个官方状态名（BULL_CONFIRMATION等），**新增**假突破分级徽标（风险提示/确认失败两种视觉区分） |
| 动态支撑压力系统 | 已有 | 字段来源改为 `AnalyzedSnapshot`，`recentHigh20/50` 与 `priorStructureHigh20/50` **必须分别展示**，不能只展示一个（否则用户无法理解"为什么显示的最高点和触发突破用的高点不一样"），置信度低的字段（`confidence='low'`）需要视觉弱化处理 |
| 支撑压力一览表格 | 已有 | **新增**行：`试仓条件`、`加仓条件`（PROJECT_AUDIT §4.3 回归项）、`离场条件`（3类都列出） |
| 多空逻辑解释 | 已有 | 文案生成逻辑改为读取 `stateReason` 字段，不再现场拼字符串 |
| 蜻蜓捕猎模型 | 已有 | 接入 `bestInterceptionZone` 返回值 |
| 操作计划 | 已有 | 补回加仓条件字段，明确区分"试仓"与"加仓"两行，不能合并 |
| 人工参考位 | 已有 | 不变，继续保持"仅展示、不参与计算"的隔离 |
| 风险提示 | 已有 | 不变 |
| 支撑压力区域（v2.0新增） | 无 | 新增区域，把原"动态支撑压力系统"里的单点数值，改为区域展示（上下边界+中心+置信度），置信度低的区域视觉弱化（§15） |
| 盈亏比（v2.0扩展） | 已有单一RR | 改为并排展示毛RR与净RR，附成本明细（手续费/价差/滑点合计扣了多少），三档提示文案改用净RR判断（§10.1a/10.2） |
| 成交量质量（v2.0新增） | 无 | 新增小面板：成交量/20均量比、主动买入占比、放量滞涨/缩量回踩标签、突破后量能持续性（§16） |
| 透明信号评分（v2.0新增，v2.1改为真实三周期口径） | 无 | 新增0-100评分卡片，展开显示每一项加分/扣分来源；**v2.1起"4小时方向""1小时结构"两项使用真实4h/1h快照计算，不再是固定0分的占位**；若 `overriddenByHardRule=true` 必须醒目提示"评分仅供参考，已被硬性规则否决"（§17） |
| 决策日志（v2.0新增，V1范围） | 无 | 新增列表面板，展示 `localStorage` 中最近的 `DecisionLogEntry`（含真实 `htfState`/`mtfState`），允许用户手动标记 `userAction`/`outcome`/`ruleCompliance`（§19.1） |
| 三周期总览区域（v2.1新增，替换原"多周期占位区"） | 无 | **V1必须实现的新区域**：并排展示4小时HTF状态、1小时结构状态、15分钟执行状态，以及 `signalPermission` 的判定结果（三周期是否同向、仓位上限建议、是否允许加仓、判定理由文案），这是三周期决策能力的核心可见入口，不能只是占位说明 |
| 条件提醒（v2.0新增，v2.1移至V3） | 无 | **本轮不实现**——推送式条件提醒（浏览器Notification）移至V3（第1.4节），V1不要求 |

---

## 5. 实现顺序（v2.1重排，严格按此顺序，前一步验证通过再进入下一步；本节全部属于V1阶段范围）

0. **（v2.1新增，CEO已授权）** 在项目目录执行 `git init`，把现有全部文件（四份文档+HTML）提交为开发基线，作为后续每一步改动的追溯起点。
1. **先写合成K线测试夹具**（不依赖真实API），覆盖 STRATEGY_SPEC §8.1 六个状态各自的进入场景 + PROJECT_AUDIT §4.1 描述的突破陷阱场景，**并新增覆盖第13节"K线内插针后收回"的未收盘K线场景**，以及T12-T14需要的三周期同向/逆势/BTC冲突合成场景（可以先只搭数据结构，具体断言在后面步骤逐步补上）。这一步先做是因为如果先改代码再补测试，很容易"改到测试通过为止"而不是"改到符合规范为止"。
2. 实现 `Kline.isClosed` 字段与 `confirmedPrice` 的推导（§0、§13），这是P0修复的进一步加固，必须先做。
3. 实现 `priorStructureHigh20/Low20`（§2.2）与 `isBreakout/isBreakdown`（§2.3，注意改用 `confirmedPrice`），用第1步的合成数据验证 P0 缺陷已修复（即 PROJECT_AUDIT §4.1 的合成场景现在应该正确输出 BULL_CONFIRMATION 而不是 STAND_ASIDE/neutral），并验证插针场景不会提前误判（T15）。
4. 实现 `findSwings` 的六项异常处理（§5.2，遍历范围按§13收缩到已收盘K线），补齐 `firstResistance/firstSupport` 的 fallback 链（§5.3）。
5. 实现 `falseBreakoutTier`（§6，六项判据全部到位）。
6. 实现 `classifyState`（§8.1 状态机 + §8.3 防抖），**先只用15分钟数据验证六态全部正确**。
7. 实现 `buildAdvice` / `buildAddOnCondition` / `buildExitConditions`（含BTC反向离场/假突破离场两类）/ `buildStopAndTargets`（含移动止损）（§2.5、§3.3、§8.2），此时 `signalPermission` 参数先传一个"始终允许"的占位值，第14步接入真实值后再回来核对文案联动是否正确。
8. 实现 `calcRiskReward`（§10，8类边界 + 毛/净RR + 交易成本模型 §10.1a）。
9. 实现 `bestInterceptionZone`（§7）。
10. 实现 `buildSRZones`（§15，支撑压力区域化）。
11. 实现 `calcVolumeQuality`（§16，成交量质量），并确认没有让成交量字段单独触发状态转换。
12. **（v2.1新增）** 实现 `fetchAllTimeframeKlines`，拉取ETH/BTC × 15m/1h/4h 六路REST K线，按第1.2节的建议间隔分别轮询，验证六路数据都能正常拿到且各自的 `assessDataQuality` 通过。
13. **（v2.1新增）** 对1小时K线复用第6步的 `classifyState`（只是换输入），用合成1小时数据验证六态在1小时周期上同样正确工作。
14. **（v2.1新增）** 实现 `classifyHtfState`（§12.2，4小时HTF六态，复用§8.1判定结构重命名），用合成4小时数据验证六个HTF状态（`HTF_BULL_TREND`等）各自能正确触发。
15. **（v2.1新增）** 实现 `computeSignalPermission`（§12.4，四条规则），用T12-T14的合成场景验证三周期同向/15分钟逆4小时/BTC周期冲突/多周期冲突分别给出正确的 `level`/`positionSizeCapPct`/`addOnAllowed`；回到第7步，把第7步的占位 `signalPermission` 换成真实值，核对 `buildAdvice`/`buildAddOnCondition` 的文案在 `counter_trend_only`/`stand_aside` 场景下确实收紧了措辞。
16. 实现 `calcScore`（§17，**这一步4h/1h两项已经有真实数据可用，不是占位0分**），确认 `worthBetting` 判断表达式没有引用 `score.total`，并验证三周期同向场景下总分能明显高于单周期或冲突场景（评分要能反映出三周期信号权限的差异，这是评分设计的核心意图）。
17. 实现 `assessDataQuality`（六路各自）与 `assessOverallHealth`（§14.5-§14.7 REST版：六路健康 + ETH/BTC同周期时间同步 + 三周期滞后检测）以及 `detectAnomalyBars`（§9.3），接入数据获取链路。
18. 实现 `validateManualInput`（§9.4）与手动模式降级（§9.5），并在UI明确说明手动模式只能覆盖15分钟层，4h/1h在手动模式下不可用。
19. 实现 `buildDecisionLogEntry`（§19.1，htf/mtf字段填真实值），接入 `localStorage` 持久化（**不实现** `checkAlertConditions`，那是V3范围）。
20. UI渲染层改造（第4节表格），把上面各步产出的 `DecisionOutput` 接入现有DOM渲染函数，**新增三周期总览区域**（替代原计划的"多周期占位区"）、区域化支撑压力、毛/净RR、成交量质量、评分、决策日志。
21. 真实浏览器手测（双击文件，不是起本地server），**验证全部6路REST请求**（不只是过去验证过的15分钟一路）在真实浏览器下的 CORS/网络表现，回填 PROJECT_AUDIT.md 第6节的"待验证"结论。
22. 跑 ACCEPTANCE_TESTS.md 全部V1标记用例（含T12-T15、T17.1/T17.4、T18-T20、T24），逐条勾选。

**明确不属于本次实现顺序的内容**（V2/V3范围，见第1.3/1.4节，本阶段不要主动去做）：WebSocket实时架构（§14 WS部分）、历史回测引擎（§18）、条件提醒推送（§19.2）、模拟仓位、长期运行监控。（v1.3范围调整说明：模拟仓位已拆出，于v1.3阶段实现，不再属于V3，见`V1_3_PAPER_TRADING_SPEC.md`；其余各项范围不变。）

---

## 6. 禁止事项（业务/合规红线，任何阶段都不能触碰）

1. **禁止自动下单**、禁止连接任何交易所交易接口（读K线公开行情除外）。
2. **禁止读取或存储任何交易账户信息、API Key、私钥、助记词**。
3. 禁止把"摊平亏损仓位"包装成"加仓"建议输出（STRATEGY_SPEC §8.2 已给出加仓的唯一合法定义，必须照此实现，不能自行放宽）。
4. 禁止承诺盈利、禁止使用"稳赚""必涨""内幕"等措辞，所有建议文案必须包含或链接到风险提示。
5. 禁止删除 `PROJECT_AUDIT.md` / `STRATEGY_SPEC.md` / `CODEX_IMPLEMENTATION_TASK.md` / `ACCEPTANCE_TESTS.md` 或旧版HTML文件。**（v2.1修正：原此处曾建议"若确需归档，移动到legacy/子目录"，CEO第二轮验收已明确决定旧文件本轮暂时保持原样，不删除、不移动、不归档，这条建议已撤销，不再执行任何迁移操作。）**
6. 禁止在没有补齐 ACCEPTANCE_TESTS.md 对应用例的情况下上线新状态分支或新建议文案模板。
7. 禁止引入 npm/React/Vite 等构建依赖，必须保持"双击HTML直接打开"的单文件形态（V1阶段；V2历史回测引擎允许是独立Node工程，见第1.3节）。
8. 禁止把 §3.3 明确列为"v1.0不做"的"按状态分档ATR系数"实现进本阶段代码，防止范围蔓延导致本阶段无法收敛。**（v2.0修正：原第8条曾一并禁止"历史回测框架"，该表述已被董事长/CEO撤销——历史回测本身不再是禁止事项，而是被安排到V2阶段，本阶段单纯是"不需要现在做"，不是"不允许做"，详见第1.3节与STRATEGY_SPEC.md §18。）**
9.（v2.0新增）**禁止自动杠杆/杠杆计算**：不得实现保证金追踪、强平价计算、杠杆倍数建议，`DecisionOutput` 任何子结构不应出现杠杆相关字段（STRATEGY_SPEC §20第1条）。
10.（v2.0新增）**禁止无限补仓**：延续第3条的精神，`buildAddOnCondition` 的实现必须同时满足STRATEGY_SPEC §8.2的加仓触发条件与风险预算上限约束，不能只判断价格条件而忽略风险预算检查。
11.（v2.0新增）**禁止黑箱AI直接决定买卖**：不得接入任何不可解释的机器学习模型直接输出方向，本系统所有判断必须是本文档和STRATEGY_SPEC.md定义的显式规则（STRATEGY_SPEC §20第2条）。
12.（v2.0新增）**不扩展到其他币种**：任何函数、UI文案、数据结构都不得引入 ETH/BTC 之外的交易对（STRATEGY_SPEC §20第3条）。
13.（v2.1修正：原第13条曾把"三周期数据拉取"也列为V1不得实现的范围，该条已被CEO第二轮验收撤销）V1阶段**不得**实现的是 WebSocket（§14 WS部分）、历史回测引擎（§18功能代码）、条件提醒推送（§19.2）、模拟仓位与长期运行监控（第1.4节）——三周期REST数据拉取与三周期决策（§12）现在**必须**在V1完成，不在此禁止之列。（v1.3范围调整说明：模拟仓位已于v1.3阶段拆出单独实现，不再属于V3范围，见`V1_3_PAPER_TRADING_SPEC.md`；本条对V1阶段本身的历史约束不变，其余三项范围不变。）
14.（v2.1新增）Codex被明确授权在项目目录内执行 `git init` 与开发基线提交（第1.5节），这不属于禁止事项，不需要事先询问用户——但仍需遵守本文档开头"Git Safety Protocol"精神：不强制推送、不重写历史、不跳过确认删除已有工作。

---

## 7. 完成标准（Definition of Done）

- [ ] `analyzeKlines` 输出的 `AnalyzedSnapshot` 包含 STRATEGY_SPEC §1.2 定义的全部字段，`priorStructureHigh20/Low20` 与 `isBreakout/isBreakdown` 已按 §2.2-§2.3 正确实现。
- [ ] PROJECT_AUDIT.md §4.1 描述的合成K线复现场景，改造后重新跑一遍，**必须输出 BULL_CONFIRMATION 而不是 STAND_ASIDE**（这是本阶段最核心的验收点，具体断言写入 ACCEPTANCE_TESTS.md）。
- [ ] 六状态机的进入/保持/退出/优先级/防抖全部按 §8.1/§8.3 实现，ACCEPTANCE_TESTS.md 对应用例全部通过。
- [ ] 假突破两级分级（§6）已实现并在UI上有可视区分，不再是单一布尔值。
- [ ] 加仓条件（`addOnCondition`）作为独立字段出现在UI和 `DecisionOutput` 中，不再缺失。
- [ ] 盈亏比8类边界情况 + 2个flag（§10）全部有对应分支和文案，不再是"risk<=0返回null"这一种粗糙处理。
- [ ] 数据不足/数据陈旧/异常K线三类安全降级（§9.1-§9.3）已实现，且降级发生时UI有明确、不可忽略的提示。
- [ ] 手动模式输入校验（§9.4）与能力降级声明（§9.5）已实现。
- [ ] 已在**真实浏览器双击本地文件**（而不是通过本地http server）的方式下验证过 Binance API 调用的实际表现，结果写回 PROJECT_AUDIT.md。
- [ ] ACCEPTANCE_TESTS.md 全部用例执行完毕并记录结果（通过/失败/不适用），失败项必须有修复或明确说明的遗留原因。
- [ ] 全程没有出现§6禁止事项列出的任何一条。
- [ ] 页面在人为断网、人为返回错误JSON、人为返回少于15根K线三种模拟异常输入下，都不能白屏/报JS异常/卡死，必须优雅降级到手动模式或"数据不足"提示。
- [ ]（v2.0新增）`isBreakout`/`isBreakdown` 已改用 `confirmedPrice`（STRATEGY_SPEC §2.3/§13），"K线内插针后收回"的合成场景不会被误判为已突破。
- [ ]（v2.0新增）支撑压力区域化（§15）、净盈亏比与交易成本模型（§10.1a）、成交量质量（§16）、透明信号评分（§17）、决策日志（§19.1）均已实现并在UI可见。
- [ ]（v2.0新增）评分系统的 `worthBetting` 判断未依赖 `score.total`（§17.3 硬性要求），Code Review需专门确认这一点。
- [ ]（v2.1修正）`fetchAllTimeframeKlines` 已实现，ETH/BTC × 15m/1h/4h 六路REST K线均能正常拉取；`DecisionOutput` 中的 `htf4h`/`mtf1h`/`signalPermission` 是**真实计算结果**，不是占位值；UI的"三周期总览区域"准确展示三个周期各自的真实状态与三周期权限判定结果。
- [ ]（v2.1新增）`classifyState` 已验证可在15分钟和1小时两个周期上无修改复用；`classifyHtfState`（4小时六态）已用合成数据验证六个状态各自能正确触发。
- [ ]（v2.1新增）`computeSignalPermission` 的四条规则（三周期同向/15分钟逆4小时/BTC周期冲突/多周期冲突或数据异常）均已用合成场景验证（对应ACCEPTANCE_TESTS.md T12-T14），`positionSizeCapPct`/`addOnAllowed` 输出符合STRATEGY_SPEC §12.4定义。
- [ ]（v2.1新增）透明评分（§17）"4小时方向""1小时结构"两项已使用真实4h/1h数据计算，不再是固定0分的占位。
- [ ]（v2.1新增）已确认没有实现WebSocket/回测引擎/条件提醒推送/模拟仓位/长期运行监控的功能代码（第6条第13款，V2/V3范围；v1.3范围调整说明：模拟仓位已于v1.3阶段拆出单独实现，不再属于V3范围，见`V1_3_PAPER_TRADING_SPEC.md`，本条对V1阶段本身的历史验收结论不变）。
- [ ]（v2.1新增）核心分析函数（`analyzeKlines`/`classifyState`/`classifyHtfState`/`computeSignalPermission`/`buildAdvice`/`calcRiskReward`等）均为不依赖DOM的纯函数，可被独立于渲染层单独调用和测试（为V2铺路，§1.2工程要求）。
- [ ]（v2.1新增）项目目录已 `git init` 并提交开发基线（第1.5节）。
- [ ]（v2.1新增）旧文件（三文件版+旧单文件版）保持原样，未被删除、移动或归档。

只有以上全部勾选完成，才能向 ChatGPT(CEO) 提交验收。
