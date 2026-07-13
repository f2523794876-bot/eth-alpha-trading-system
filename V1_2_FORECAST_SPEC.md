# V1_2_FORECAST_SPEC.md — ETH Alpha 走势预测层（概率预测层）算法与数据规范

版本：v1.2-draft-3（在 v1.2-draft-2 基础上关闭独立复审3项P1与3项P2；V1.1 `v1.1.0`/commit `d9289ef` 之上的**增量**文档，不修改、不覆盖 STRATEGY_SPEC.md 已定义的任何算法）
角色：本文档只做 V1.2「走势预测层」的**架构设计与验收规范**，不是实现代码，也不由本文档作者实现正式业务代码。
适用范围：ETH/USDT 走势预测面板，三个独立预测时窗——未来15分钟 / 未来1小时 / 未来4小时，均在 V1.1 已有的三周期数据（4H/1H/15m，ETH+BTC）之上计算，不新增任何数据源、不新增任何K线请求。
唯一算法真相来源声明：本文档是 V1.2 预测算法的唯一 source of truth。V1_2_CODEX_IMPLEMENTATION_TASK.md 中的函数接口必须实现本文档定义的行为；V1_2_ACCEPTANCE_TESTS.md 的用例必须验证本文档定义的规则；V1_2_ARCHITECTURE_REVIEW.md 负责核对三者一致性。四份文档如有冲突，以本文档为准。

**红线（贯穿全文，反复强调不为过）**：
- V1.2 是**只读消费层**——只读取 V1.1 已导出的 `AnalyzedSnapshot`、`DecisionOutput` 及 `v1-core.js` 已导出的纯函数，**不修改 `v1-core.js` 的任何一行**，不重新计算 EMA/ATR/Swing/S-R/状态机，不重新请求 K 线。
- V1.2 只产出**规则型方向倾向**，不产出、不暗示、不标注任何"真实概率""真实胜率""必涨""必跌"字样。所有第4-5节算出的百分比数字，UI 和日志字段命名必须显式带"权重"二字。
- V1.2 不下单、不读密钥、不做盈利承诺。数据异常/手动模式下必须清空预测，绝不用旧预测冒充当前预测。

---

## 0. 记号约定（v1.2-draft-3）

**订正说明**：draft-1 曾错误地假设 `C.buildDecision()` 接收的是"已经算好的 `{tf15m:AnalyzedSnapshot,...}`"对象，并假设 V1.2 可以直接复用这份引用。经与 `v1-core.js` 源码核对，这与事实不符：

- `C.fetchAllTimeframeKlines()`（`v1-core.js` 已导出）返回的真实结构是**原始K线**，不是分析结果：
  ```ts
  interface MarketData {
    eth: { tf15m: Kline[]; tf1h: Kline[]; tf4h: Kline[] };
    btc: { tf15m: Kline[]; tf1h: Kline[]; tf4h: Kline[] };
    partial: boolean;      // succeeded/failed 是否有缺失
    succeeded: string[];   // 成功周期标识，格式 'eth.tf15m' 等，见下方"周期标识格式"
    failed: string[];      // 失败周期标识，同上格式
  }
  ```
  （真实实现：`v1-core.js` 第12行，`id:asset+'.'+key`，`asset∈{'eth','btc'}`，`key∈{'tf15m','tf1h','tf4h'}`。）
- `C.buildDecision(et, bt, manual, prev, cost)` 的前两个参数 `et`/`bt` 就是 `MarketData.eth`/`MarketData.btc`（**原始K线**），`buildDecision` **内部自己调用** `analyzeKlines()` 六次（ETH/BTC × 15m/1h/4h），产出的分析快照**只有ETH的三个**通过 `DecisionOutput.ltf15m`/`mtf1h`/`htf4h` 对外暴露；**BTC的三个分析快照（15m/1h/4h）完全不对外暴露**，`DecisionOutput` 上不存在任何字段能拿到它们（真实实现：`v1-core.js` 第66行 `buildDecision` 函数体，`b15`/`b1`/`b4` 是函数内部局部变量，从未写入返回对象 `d`）。
- 因此 V1.2 若要在因子层用到 BTC 15m/1h/4h 的分析快照（§4.1 因子9需要），**只能自己对 `MarketData.eth`/`MarketData.btc` 的原始K线调用已导出的 `C.analyzeKlines(klines, timeframe, symbol)`**，重新得到六个 `AnalyzedSnapshot`（ETH×3 + BTC×3）。这是**只读派生**：`analyzeKlines` 是纯函数，用同样的原始K线重新调用，结果与 `buildDecision` 内部算出的完全一致（bit-identical），**不改变、不影响、不重算 V1.1 的决策结果**，只是让 V1.2 能读到 `buildDecision` 没有对外暴露的那部分（主要是BTC的1h/4h快照）。V1.2 **不得**复制 `analyzeKlines` 的实现，**不得**修改 `v1-core.js`。

**记号定义**：
- `marketData` 指上面的 `MarketData` 结构，是 `buildForecast()` 的**唯一** K线相关输入参数（见§11.2最终签名）。
- `ethSnap`/`btcSnap` 指 V1.2 内部对 `marketData.eth`/`marketData.btc` 六路原始K线分别调用 `C.analyzeKlines()` 后得到的 `{tf15m:AnalyzedSnapshot, tf1h:AnalyzedSnapshot, tf4h:AnalyzedSnapshot}` 派生对象，**不是外部传入的参数**，是 `buildForecast()`/`buildHorizonForecast()` 内部计算出的局部变量。本文档后续所有形如 `ethSnap.tf4h.trend`、`btcSnap.tf1h` 的写法均指这个内部派生对象，不再使用 draft-1 中错误的 `ethTf`/`btcTf` 记号。
- `decision` 指同一次 `refresh()` 里 `C.buildDecision(marketData.eth, marketData.btc, manual, prev, cost)` 的返回值（`DecisionOutput`，字段清单见 STRATEGY_SPEC.md §1.4 及 V1.1 增补字段）。`decision.ltf15m`/`mtf1h`/`htf4h` 就是 ETH 的三个快照，等价于（但不强制要求逐字节复用引用）`ethSnap.tf15m`/`tf1h`/`tf4h`——因为两者都是对同一份 `marketData.eth` 原始K线调用同一个纯函数 `analyzeKlines` 的结果，值必然相等；V1.2 内部实现可以选择直接复用 `decision.ltf15m`/`mtf1h`/`htf4h` 作为 `ethSnap` 的对应字段（省一次重复计算），但 `ethSnap.tf1h`（对应 `decision.mtf1h`）、`ethSnap.tf4h`（对应 `decision.htf4h`）与 BTC 三个快照的取得方式必须保持"自己调用 `analyzeKlines`"这一条路径不因实现取巧而绕开。
- `horizon` ∈ `{'15m','1h','4h'}`，三个预测时窗，与三周期数据的时间粒度一一对应（15分钟预测主要读 `ethSnap.tf15m`，1小时预测主要读 `ethSnap.tf1h`，4小时预测主要读 `ethSnap.tf4h`，但 §5 的12项因子在三个 horizon 下都会读取全部三个周期的快照，只是权重分配不同）。
- 所有正式方向判定、区间生成、失效条件判定，只使用相应快照的 `confirmedPrice`、`isClosed=true` 的K线、以及由这些K线派生的 `priorStructureHigh/Low`、`swingHighs/Lows`。未收盘的 `price` 只允许用于 §10.2 的盘中距离展示和过期提醒，不允许参与任何因子计分或区间计算。
- `now`：`buildForecast(marketData, decision, prevForecast, now)` 的第4个参数，调用方传入的当前时间戳（ms epoch）。`generatedAt`/`validUntil` 判定、§5.2 的 `isStale` 相关文案均基于这个显式传入的 `now`，不在纯函数内部调用 `Date.now()`（呼应 Codex 任务书对"纯函数"的要求：可测试、可复现）。

---

## 1. V1.2 目标（对齐需求原文，不做增删）

在 V1.1 交易决策核心之上新增一个独立的"走势预测面板"，对未来15分钟/1小时/4小时分别给出：方向倾向、上涨/下跌/震荡三类权重、可能上涨到达的价格区域、可能下跌到达的价格区域、最可能运行路径、预测失效条件、预测可信度、支持证据与反对证据。**预测层不能自动下单，不能承诺盈利，不能输出"必涨""必跌"。**

---

## 2. 必须区分的十个概念

这十个概念在 V1.2 规范正文、代码字段命名、UI 文案中必须逐一区分，不得混用同一个词。**在 V2 历史回测校准完成前，第3、8、9项的数字都是规则产物，不是统计意义上的概率；第10项在 V1.2 中不产出任何数值。**

| # | 概念 | 定义 | 来源 | V1.2 中的具体载体 |
|---|---|---|---|---|
| 1 | 市场状态 | V1.1 已确认的、对"现在"的结构化判断，事实性、回顾性 | V1.1（不变） | `decision.state` / `mtfState` / `htfState`（如 `BULL_CONFIRMATION`） |
| 2 | 方向倾向 | V1.2 对"未来"的规则型推断结论，前瞻性、非事实 | V1.2 新增 | `HorizonForecast.directionLabel`（偏多/偏空/震荡/不确定/数据不足） |
| 3 | 规则型预测权重 | 12项规则因子加权得到的三分桶占比，纯规则产物，未经历史验证 | V1.2 新增 | `DirectionWeights.{bullish,bearish,ranging}`，UI 必须写"偏多权重/偏空权重/震荡权重" |
| 4 | 经历史数据校准后的真实概率 | 用历史K线回放 + Brier Score 等统计方法校准出的、有统计意义的概率 | V2（本轮不实现） | 日志字段 `calibratedProbability`，V1.2 中永远为 `null` |
| 5 | 条件触发后的交易预案 | 满足入场条件后的具体操作计划 | V1.1（不变） | `decision.triggerPlans.long/short`，V1.2 不复制、只并排引用 |
| 6 | 动态目标位 | V1.1 已有的、与止损/入场绑定的可执行止盈位 | V1.1（不变） | `decision.targets` |
| 7 | 预计波动区间 | V1.2 对未来价格活动范围的规则型区间估计，探索性、非入场依据 | V1.2 新增 | `HorizonForecast.priceRange` |
| 8 | 可执行性评分 | 该信号是否值得下注的评分 | V1.1（不变，V1.2 只透传不重算） | `decision.opportunityScores` / `decision.worthBetting`，见 §11.3 |
| 9 | 置信度 | V1.2 对"这次预测本身数据完整度与规则内部一致性代理"的元评分，**不是**统计胜率、预测准确率或概率 | V1.2 新增 | `HorizonForecast.confidence`，UI 必须写"置信度（数据完整度与规则一致性代理评分，不是统计胜率或预测准确率）" |
| 10 | 胜率 | 该方向历史上真实兑现的比例 | V2（本轮不实现） | V1.2 不产出任何胜率数值，禁止出现"胜率XX%"字样 |

**强制措辞规则**：V1.2 当前只能得到规则型权重时，页面和日志一律使用"偏多权重""偏空权重""震荡权重"或同等表述；**禁止**出现"上涨概率60%""胜率70%"等未经校准的表述。任何新增文案在合并前必须逐条核对本表。

---

## 3. 核心数据结构

```ts
// ---- 因子层 ----
interface ForecastFactorResult {
  id: string;                 // 固定枚举，见§4，如 'trend4h'
  label: string;               // 中文名，如 "4小时趋势"
  weightMax: number;           // 该因子在当前horizon权重档位下的满额权重点数（0-100量表的一部分，见§4.2表）
  status: 'ok' | 'missing';    // 'missing' 时 bull/bear/range 都必须为0，points也必须为0
  bull: number;                 // 0..1，方向分配比例，bull+bear+range===1（status='ok'时）
  bear: number;
  range: number;
  points: { bull: number; bear: number; range: number }; // = weightMax × 对应比例，重归一化前的原始值
  evidenceText: string;         // 人类可读依据，如 "1H结构：BULL_CONFIRMATION（多头确认）"
}

// ---- 方向权重 ----
interface DirectionWeights {
  bullish: number;  // 0-100 整数，"偏多权重"
  bearish: number;  // 0-100 整数，"偏空权重"
  ranging: number;  // 0-100 整数，"震荡权重"
  // 不变量：bullish+bearish+ranging === 100（§5.3 保证）；数据不足时整个 DirectionWeights 为 null
}

// ---- 价格区间 ----
interface PriceRangeEstimate {
  lower: number;
  upper: number;
  basis: string[];   // 区间生成依据，逐条列出用到的数值来源，见§6.3
}

// ---- 情景目标 ----
interface ScenarioTargets {
  bullishZone: [number, number] | null;   // 偏多情景目标区
  bearishZone: [number, number] | null;   // 偏空情景目标区
  rangingZone: [number, number] | null;   // 震荡情景区间（= priceRange本身）
  disclaimer: '情景推演，不是确定预测';     // 常量字符串，必须原样输出，UI必须原样展示
}

// ---- 最可能路径 ----
type PathScenarioId =
  | 'INSUFFICIENT_DATA'      // 数据不足，不生成路径
  | 'PULLBACK_THEN_UP'       // 先回踩后上涨
  | 'BREAKOUT_THEN_PULLBACK' // 突破后回踩
  | 'RALLY_THEN_FADE'        // 先冲高后回落
  | 'BREAKDOWN_THEN_BOUNCE'  // 跌破后反抽
  | 'RANGE_ROUND_TRIP'       // 区间往返
  | 'TREND_CONTINUATION';    // 顺势延续（默认兜底路径）

interface PathScenario {
  id: PathScenarioId;
  text: string;   // 中文描述
}

// ---- 失效条件 ----
type InvalidationId =
  | 'INVALID_BREAK_SUPPORT'
  | 'INVALID_BREAK_RESISTANCE'
  | 'INVALID_BTC_REVERSE'
  | 'INVALID_VOLUME_FAIL'
  | 'INVALID_STALE_DATA';

interface InvalidationCondition {
  id: InvalidationId;
  text: string;              // 含具体价位/条件的中文描述
  basis: 'confirmedClose';   // 固定值，声明"必须用已收盘K线作为正式失效判断"
}

// ---- 置信度 ----
interface ConfidenceScore {
  score: number;              // 0-100
  label: '高' | '中' | '低';
  explanation: string;        // 如 "数据完整度100%，方向领先优势18分，三周期方向一致"
}

// ---- 单个时窗的完整预测 ----
interface HorizonForecast {
  horizon: '15m' | '1h' | '4h';
  directionLabel: '偏多' | '偏空' | '震荡' | '不确定' | '数据不足';
  weights: DirectionWeights | null;
  factors: ForecastFactorResult[];        // 固定12项，missing的因子也要出现（status='missing'）
  priceRange: PriceRangeEstimate | null;
  scenarioTargets: ScenarioTargets | null;
  mostLikelyPath: PathScenario | null;
  invalidation: InvalidationCondition[];  // directionLabel为'数据不足'时必须为[]
  confidence: ConfidenceScore | null;
  supportingEvidence: string[];           // 最多3条，见§9
  opposingEvidence: string[];             // 最多3条，见§9
  dataAsOf: number;                       // 生成预测所用confirmedPrice对应K线的closeTime（ms epoch）
  validUntil: number;                     // 预测有效期截止时间，见§10.3
  disclaimer: '规则型权重，尚未经过历史胜率校准'; // 常量，必须原样输出，UI必须醒目展示
  suppressedReason: string | null;        // directionLabel='数据不足'时必须给出具体原因
}

// ---- 顶层输出 ----
interface ForecastOutput {
  generatedAt: number;
  isManual: boolean;                      // 透传 decision.isManual
  blockedByV11: boolean;                  // 透传 decision.opportunityScores.blocked（V1.1硬性否决是否生效；v1-core.js 第66/51行确认 DecisionOutput 上不存在顶层 decision.blocked 字段，真实可读字段是 opportunityScores.blocked/hardBlocked 或 score.overriddenByHardRule，二者语义相同，V1.2统一取前者，因为它是 buildDecision 内部实际调用 calcOpportunityScores 后写入返回对象的字段，tests/third-review-tests.js 已有生产路径断言 d.opportunityScores.blocked）
  suppressedReason: string | null;        // 手动模式/整体数据异常时，说明三个horizon为何整体为空
  m15: HorizonForecast | null;
  h1: HorizonForecast | null;
  h4: HorizonForecast | null;
  executability: {
    worthBetting: boolean;                // 透传 decision.worthBetting，V1.2不重算
    tradability: number | null;           // 透传 decision.opportunityScores 中的可交易性分
    note: string;                         // worthBetting=false时固定包含"不值得下注"字样；blockedByV11=true时固定包含V1.1拒绝原因
  };
}
```

---

## 4. 预测因子清单（12项，防止重复计分的规则见§4.3）

### 4.1 因子定义与算法

| # | id | 中文名 | 数据来源（只读，不新算） | 方向判定规则（返回 bull/bear/range 三个比例，和为1） | 缺失数据判定 |
|---|---|---|---|---|---|
| 1 | `trend4h` | 4小时趋势 | `ethSnap.tf4h.trend` | `'up'→bull=1`；`'down'→bear=1`；`'flat'→range=1` | `dataQuality.sufficientForEMA20===false` → missing |
| 2 | `structure1h` | 1小时结构 | `decision.mtfState` | `BULL_CONFIRMATION→bull=1`；`BULL_PULLBACK→bull=0.7,range=0.3`；`BEAR_CONTINUATION→bear=1`；`RANGE_CHOP→range=1`；`TRANSITION_WATCH→`见下方"TRANSITION_WATCH唯一算法"（用 `ethSnap.tf1h`）；`STAND_ASIDE→range=1` | `ethSnap.tf1h.dataQuality.sufficientForSwing===false` → missing |
| 3 | `structure15m` | 15分钟执行结构 | `decision.state` | 同上映射规则，作用于15m状态；`TRANSITION_WATCH`用 `ethSnap.tf15m` | `ethSnap.tf15m.dataQuality.sufficientForSwing===false` → missing |
| 4 | `emaSlopeOwn` | EMA排列与斜率（预测目标自身周期） | 对目标horizon对应周期的收盘K线调用已导出的 `emaSeries(closes,5)`，取最近4个已收盘值算斜率 `slope=(ema5[-1]-ema5[-4])/atr14` | `slope>0.3→bull=1`；`slope<-0.3→bear=1`；否则 `range=1-|slope|/0.3`，剩余按符号分配给bull或bear | `atr14`为`null`或已收盘K线不足4根 → missing |
| 5 | `swingStructure` | Swing高低点结构 | 目标周期快照的 `swingHighs`/`swingLows` | 最近两个swing low抬高且最近两个swing high抬高→`bull=1`；两者都降低→`bear=1`；其余（含一高一低方向不一致的混合情形）→`range=1` | `swingHighs.length<2 或 swingLows.length<2` → missing（**已订正为"或"**，见问题6：只要任一侧不足2个点，摆动结构本身就不完整，不能因为另一侧恰好凑够2个就误判为"有效震荡结论"） |
| 6 | `atrState` | ATR波动状态 | 目标周期快照的 `atr14`/`atrPrev` | `atr14>atrPrev×1.15`（扩张）：若同周期状态机方向为多→`bull=1`，为空→`bear=1`，否则`range=1`；`atr14<atrPrev×0.85`（收缩）→`range=1`；其余→按同周期状态机方向50%+`range=0.5` | `atr14`或`atrPrev`为`null` → missing |
| 7 | `srDistance` | 动态支撑压力距离 | 用 §6.0 定义的 `C.buildSRZones(目标周期快照)` 得到 `resistanceZones[0]`(`r0`)/`supportZones[0]`(`s0`)，`C.calcPositionMetrics(confirmedPrice, s0, r0, atr14)` 算出 `supportDistanceAtr`/`resistanceDistanceAtr` | 距压力<0.4×距支撑（更靠近压力）→`bear=0.6,range=0.4`；距支撑<0.4×距压力（更靠近支撑）→`bull=0.6,range=0.4`；其余→`range=1` | **已订正为双边校验（问题7）**：`!isValidZone(r0,'resistance',confirmedPrice)` 或 `!isValidZone(s0,'support',confirmedPrice)` 或 `atr14` 无效（`null`/`NaN`/`≤0`）→ missing。任一侧（压力或支撑）越过 `confirmedPrice`（方向错误）、非有限数值、或ATR无效都会触发，不再是"两者同时为null才missing"这一几乎不可能触发的旧条件（`resolveLevels` 的ATR外推兜底导致 `firstResistance`/`firstSupport` 原始level本身几乎不会是`null`，真正会缺失的是加了ATR半宽后的zone） |
| 8 | `volumeQuality` | 成交量质量 | 对目标horizon对应周期自身的**原始K线数组**（`marketData.eth[对应tf]`，逐周期取用，不复用15m的量能；`calcVolumeQuality` 内部自行按 `isClosed` 过滤，调用方不预先过滤）调用 `C.calcVolumeQuality(marketData.eth[对应tf], ethSnap[horizon].atr14, 同周期状态机方向标签)`，取其 `ratio`/`sustained`/`takerBuyRatio` | **唯一阈值（问题5已订正，取代未定义的"与方向一致"）**：多头量能确认 `ratio>=1.2 && sustained===true && takerBuyRatio>=0.55` → `bull=1`；空头量能确认 `ratio>=1.2 && sustained===true && takerBuyRatio<=0.45` → `bear=1`；`0.45<takerBuyRatio<0.55`（含 `ratio>=1.2&&sustained` 但买盘比例中性）→`range=1`（量能扩张但方向不明，导向震荡，不确认任一方向）；`ratio<1.2` 或 `sustained===false` → `range=1`（未放量或未持续，不给方向加分） | `C.calcVolumeQuality()` 返回 `label==='unavailable'`（K线不足/`volume`基准为0）或 `takerBuyRatio===null`（`last.volume===0` 导致无法计算买盘占比）→ missing。`takerBuyRatio===null` **明确按missing处理**，不采用保守方向猜测，因为买盘占比缺失时无法验证问题5要求的双向阈值 |
| 9 | `btcAlignmentOwnTf` | BTC对应周期联动 | 只对目标horizon所在周期调用已导出的 `C.btcAlignment(bias, btcSnap[对应周期])`；名称明确表示它不是一次性汇总BTC三个周期 | `'support'→`按ETH本周期状态机方向`=1`；`'conflict'→range=0.7`+反方向`0.3`；`'neutral'→range=1` | 该周期BTC K线获取失败——即 `marketData.failed` 包含真实标识 `'btc.tf15m'`/`'btc.tf1h'`/`'btc.tf4h'`（**已订正为 `fetchAllTimeframeKlines` 真实key格式 `asset+'.'+key`，问题3**，不再使用不存在的 `'btc-tf4h'` 写法）→ **硬性missing，且触发§10.4整horizon降级**，不参与普通因子重归一化 |
| 10 | `falseBreakoutRisk` | 假突破风险 | **该horizon自己的** `C.falseBreakoutTier(ethSnap[horizon], btcSnap[horizon])`（**已订正为逐周期独立调用，问题4**，不是只代表15m的 `decision.falseBreakoutTier`；15m结果允许与 `decision.falseBreakoutTier` 做一致性断言，见§8） | `'confirmation_failed'→range=1`（原方向失效）；`'warning'→`原方向`0.5,range=0.5`；`'none'`且存在突破/跌破→原方向`=1`；`'none'`且无突破→`range=1` | 目标快照本身不可用（已被更上层的整体缺失判定拦截，不单独判missing） |
| 11 | `rangePosition` | 当前价格处于区间的位置 | `recentHigh20`/`recentLow20` 与 `confirmedPrice` 算出的区间位置百分比 | `>70%（近顶部）→bear=0.6,range=0.4`；`<30%（近底部）→bull=0.6,range=0.4`；其余→`range=1` | `recentHigh20`或`recentLow20`为`null` → missing |
| 12 | `timeframeAgreementProxy` | 三周期规则一致性代理（元因子） | 只读取因子1/2/3**已经算出的**主导方向（各自bull/bear/range中最大者），不重新读取原始K线；这是规则代理指标，不是统计准确率 | 三者主导方向一致→该方向`=1`；三者中两者一致→该方向`0.5,range=0.5`；三者互不相同→`range=1` | 因子1/2/3中有≥2个为missing → missing |

### 4.1.1 `TRANSITION_WATCH` 唯一算法（P0问题2修复：draft-1 的 `range=0.6+方向0.2` 总和只有0.8，违反 `ForecastFactorResult` 的 `bull+bear+range===1` 不变量）

因子2（`structure1h`，用 `ethSnap.tf1h`）、因子3（`structure15m`，用 `ethSnap.tf15m`）在状态机结果为 `TRANSITION_WATCH` 时，套用同一个函数（参数为该因子对应的目标周期快照 `snap`）：
```
function transitionWatchSplit(snap):
    range = 0.6
    若 !finite(snap.ema20) 或 !finite(snap.confirmedPrice):
        return { bull:0, bear:0, range:1 }   // 数据不足，全部导向震荡，不强行判方向
    若 snap.confirmedPrice > snap.ema20:
        return { bull:0.4, bear:0, range:0.6 }
    否则若 snap.confirmedPrice < snap.ema20:
        return { bull:0, bear:0.4, range:0.6 }
    否则（相等）:
        return { bull:0, bear:0, range:1 }
```
即：`range` 固定占0.6；`confirmedPrice>ema20` 时 `bull=0.4`；`confirmedPrice<ema20` 时 `bear=0.4`；相等或 `ema20`/`confirmedPrice` 任一不可用（数据不足）时退化为 `range=1`。三种分支的 `bull+bear+range` 恒等于1。`V1_2_ACCEPTANCE_TESTS.md` T14 新增断言：**每个 `status='ok'` 的因子，`bull+bear+range` 必须在浮点容差内等于1**（不只是检查三类最终权重和为100）。

### 4.2 三档权重表（每列必须合计100，Codex实现后必须有单元测试逐列求和校验）

| # | 因子id | 15m权重 | 1h权重 | 4h权重 |
|---|---|---|---|---|
| 1 | `trend4h` | 6 | 12 | 22 |
| 2 | `structure1h` | 10 | 20 | 14 |
| 3 | `structure15m` | 22 | 10 | 4 |
| 4 | `emaSlopeOwn` | 10 | 9 | 8 |
| 5 | `swingStructure` | 8 | 8 | 8 |
| 6 | `atrState` | 8 | 6 | 5 |
| 7 | `srDistance` | 12 | 10 | 8 |
| 8 | `volumeQuality` | 10 | 8 | 6 |
| 9 | `btcAlignmentOwnTf` | 6 | 9 | 12 |
| 10 | `falseBreakoutRisk` | 4 | 5 | 6 |
| 11 | `rangePosition` | 2 | 2 | 3 |
| 12 | `timeframeAgreementProxy` | 2 | 1 | 4 |

权重版本固定为 `v1.2-weights-1`，固定FNV-1a校验和为 `10996160`。该预期值与版本号作为独立规范快照写死，运行时不得从 `FACTOR_WEIGHTS` 自行计算“预期checksum”后再与自身比较。任意权重点数变化必须同步更新权重版本、固定checksum和本规范快照，否则校验失败。
| | **合计** | **100** | **100** | **100** |

设计意图：15分钟预测更看重自身周期的执行结构（因子3权重22）和成交量/S-R距离（近端确认）；4小时预测更看重4H自身趋势（因子1权重22）和BTC三周期联动（宏观相关性更重要，因子9权重12）；1小时预测介于两者之间。

### 4.3 防止重复计分的规则

- 因子12（多周期方向冲突）**不得**重新读取任何原始K线/EMA/Swing数据，只允许读取因子1/2/3已经算出的 `bull/bear/range` 主导方向作为输入，因为"三周期是否冲突"这一事实完全由三个因子各自的结论决定，不存在独立的原始数据来源。
- 因子4（EMA斜率）与因子1/2/3（趋势/结构分类）是不同信号：因子1/2/3 读取的是 `trend`/状态机分类结果（分类型、离散），因子4 读取的是 EMA5 本身的斜率变化率（连续型、只反映"变陡/变缓"，不反映"当前是否已经确认为趋势"），两者输入字段不同，允许并存。
- 因子7（S-R距离）与因子11（区间位置）是不同信号：因子7 用的是"距最近结构性压力/支撑位的ATR距离"（结构意义），因子11 用的是"当前价在最近20根K线极值区间内的百分比位置"（统计意义），两者字段来源不同（`firstResistance/firstSupport` vs `recentHigh20/recentLow20`），允许并存，但**权重刻意压低**（因子11最高只有3点）以避免变相重复计分区间位置这一事实两次。
- 因子9（BTC联动）与因子2/3/1不会重复：BTC联动只读BTC自己的快照与`btcAlignment()`结果，不读取ETH自身结构。
- 任何后续如需新增因子，必须在合并前对照本表逐项确认"读取的原始字段"与现有12项互不重叠，否则视为违反本节红线。

### 4.4 因子5（`swingStructure`）行为分类（P1问题6：修复后必须覆盖的5种情形）

`swingHighs.length<2 或 swingLows.length<2` → missing 这一订正后的判定，把"双边数据都够、但方向混合"和"任一边数据不够"彻底分开。`status='ok'` 时必须覆盖：
1. **只有高点降低但低点抬高**（`swingHighs`降序、`swingLows`升序，双边均≥2个点）→ 混合，`range=1`。
2. **只有低点降低但高点抬高**（对称混合）→ `range=1`。
3. **单边Swing缺失**（`swingHighs.length<2` 或 `swingLows.length<2`，不要求另一边同样不足）→ `status='missing'`。
4. **完整多头**（双边均≥2个点，最近两个swing high抬高且最近两个swing low抬高）→ `bull=1`。
5. **完整空头**（双边均≥2个点，两者都降低）→ `bear=1`。

以上5类是 `V1_2_ACCEPTANCE_TESTS.md` T23 的最低覆盖要求，逐类构造 fixture。

---

## 5. 方向权重计算算法

### 5.1 逐因子取点

对每个 horizon，遍历该 horizon 权重档位下的12个因子：
```
points.bull  = factor.weightMax × factor.bull
points.bear  = factor.weightMax × factor.bear
points.range = factor.weightMax × factor.range
```
`status='missing'` 的因子，`points` 三项强制为0，不参与下一步求和，其 `weightMax` 计入"缺失权重"。

### 5.2 硬性数据门槛（决定是否直接判"数据不足"，优先于一切计分）

对某个 horizon，若满足以下任一条件，`directionLabel='数据不足'`，`weights=null`，`priceRange/scenarioTargets/mostLikelyPath=null`，`invalidation=[]`，跳过5.3-5.4，直接进入§10的降级流程：

1. `decision.isManual === true`（手动观察模式，见§10.1，此时**三个horizon全部**为数据不足，不单独判断）。
2. `decision.dataHealth !== 'normal'` 且非手动模式（数据延迟/失效，见§10.2）。
3. 因子9（`btcAlignmentOwnTf`）在该horizon判定为"硬性missing"（对应周期BTC数据获取失败，见§10.4）。
4. 该horizon缺失权重总和（所有`status='missing'`因子的`weightMax`之和）≥ 40（即可用权重不足60）。
5. 该horizon对应周期自身的`AnalyzedSnapshot.dataQuality.isStale === true`。
6. 该horizon对应周期自身的 `ethSnap[horizon].atr14` 无效（`null`、`undefined`、`NaN` 或 `≤0`）——ATR是§6价格区间半径、§7情景目标ATR外推、多个因子（`emaSlopeOwn`/`atrState`/`srDistance`）missing判定的共同基础，一旦无效，priceRange/scenarioTargets 无法生成任何有意义的数值，且此时按 `assessDataQuality`（`v1-core.js`）的定义 `sufficientForATR14===false`（`closed.length<15`），该周期本身就已经过短，不适合再给出任何方向或区间结论，因此直接判"数据不足"而不是让 §6/§7 静默回退成毫无意义的默认值。

### 5.3 归一化与三分桶权重

若未触发§5.2门槛：
```
rawBull  = Σ points.bull  (对所有status='ok'的因子)
rawBear  = Σ points.bear
rawRange = Σ points.range
rawTotal = rawBull + rawBear + rawRange   // 恒等于该horizon的"可用权重总和"（≥60，因为已过§5.2第4条）
scale = 100 / rawTotal

bullish = round(rawBull  × scale)
bearish = round(rawBear  × scale)
ranging = 100 - bullish - bearish   // 强制补齐，保证三者之和恒为100

// 舍入保护：若ranging<0（三舍五入极端情况导致），从bullish/bearish中较大者扣除溢出量，直至ranging=0
```
此算法保证 `bullish+bearish+ranging===100` 对任意输入恒成立（§9 验收测试T14的依据）。

### 5.4 方向标签判定（在weights已算出的前提下）

```
top = max(bullish, bearish, ranging)
second = 次高值
margin = top - second

if margin < 8:
    directionLabel = '不确定'   // 权重仍然展示，只是没有清晰领先方向
elif top === ranging:
    directionLabel = '震荡'
elif top === bullish:
    directionLabel = '偏多'
else:
    directionLabel = '偏空'
```

---

## 6. 预计价格区间生成算法（P1问题8已重写：新增有限性/顺序/方向/最小宽度检查，禁止静默虚构结构依据）

进入本节前提：该horizon已通过§5.2全部门槛（尤其条件6：`atr14` 有效），`confirmedPrice`、`atr14` 均为有限正数。

### 6.0 区域近端/远端的精确定义（本节及§7共用，取代 draft-1 未定义字段的"近端"自然语言）

V1.2 通过已导出的 `C.buildSRZones(snapshot)` 得到该周期的 `{supportZones, resistanceZones}`（与V1.1图表标注使用的是同一份zone数据，非V1.2另造）。每个zone形如 `{lower, upper, center, ...}`（`v1-core.js` `buildSRZones` 真实返回结构）。**固定定义**（源于 `calcPositionMetrics` 对同一批zone的既有用法，`v1-core.js` 第43行，非V1.2自创）：

| 类型 | 近端（离 `confirmedPrice` 更近的一侧） | 远端 |
|---|---|---|
| 压力区（`resistanceZones[i]`，恒在价格上方） | `zone.lower` | `zone.upper` |
| 支撑区（`supportZones[i]`，恒在价格下方） | `zone.upper` | `zone.lower` |

**区域有效性判定** `isValidZone(zone, side, confirmedPrice)`：
```
finite(zone.lower) && finite(zone.upper) && zone.lower <= zone.upper
&& (side==='resistance' ? zone.lower > confirmedPrice : zone.upper < confirmedPrice)
```
第二个条件是"方向正确"检查：压力区的近端必须严格高于当前价，支撑区的近端必须严格低于当前价；由于 `zone` 的半宽是按ATR/簇宽度计算的（`buildSRZones` 内 `half=Math.max(.15*atr14, .5*clusterRange)`），当价格非常接近某个结构位、半宽较大时，zone边界可能"越过"当前价，此时该zone判定无效，不得用作区间/目标依据（这是问题8第4/8点"目标落在确认价错误方向"的直接防护）。

**注**：`AnalyzedSnapshot.firstResistance`/`firstSupport`（`resolveLevels` 产出的原始 level，非zone）在 `confirmedPrice`/`atr14` 均为有限值时，由 `v1-core.js` 的构造过程（`resolveLevels` 内按 `p.price>price`/`p.price<price` 过滤候选点，找不到候选时用ATR外推兜底）**保证**其 `.price` 恒在正确方向（压力恒高于价、支撑恒低于价）；因此"方向错误"这一失效模式实际只发生在**加了半宽的zone边界**上，不发生在原始level本身——本节的合法性检查因此以zone为准，不额外假设level本身会越界，但仍对其做有限性检查以防御 `confirmedPrice`/`atr14` 为 `NaN` 的极端输入。

### 6.1 基准点与半径

以该horizon对应周期自身的 `confirmedPrice` 为基准点，半径取该周期 `atr14` 乘以固定系数：

| horizon | ATR来源 | 系数k |
|---|---|---|
| 15m | `ethSnap.tf15m.atr14` | 1.2 |
| 1h | `ethSnap.tf1h.atr14` | 1.0 |
| 4h | `ethSnap.tf4h.atr14` | 1.0 |

```
initialLower = confirmedPrice - atr14 × k
initialUpper = confirmedPrice + atr14 × k
```
`initialLower < confirmedPrice < initialUpper` 恒成立（`atr14>0`），这是回退兜底区间，任何后续收紧/放宽步骤失败都必须能回退到这一步。

### 6.2 用结构位收紧/放宽（严格顺序执行，任一步产生非法结果立即回退到上一步的合法值）

```
resistanceZones = C.buildSRZones(ethSnap[horizon]).resistanceZones
supportZones    = C.buildSRZones(ethSnap[horizon]).supportZones
r0 = resistanceZones[0], r1 = resistanceZones[1]
s0 = supportZones[0],    s1 = supportZones[1]

upper = initialUpper
lower = initialLower
basis = ["confirmedPrice(horizon)=...", "ATR14(horizon)=...，半径系数k=...", "初始区间=[...]"]

// 上界收紧
若 isValidZone(r0,'resistance',confirmedPrice) 且 r0.lower < upper 且 !ethSnap[horizon].isBreakout:
    upper = r0.lower; basis.push("firstResistance近端=r0.lower，未突破，收紧上界")
否则若 ethSnap[horizon].isBreakout 且 isValidZone(r1,'resistance',confirmedPrice) 且 r1.lower < upper:
    upper = r1.lower; basis.push("已突破，改用secondResistance近端=r1.lower收紧上界")
// （isBreakout 时若 r1 无效，upper 保留ATR外推值，basis注明"已突破且无更高一级有效结构位，沿用ATR外推上界"）

// 下界收紧（对称）
若 isValidZone(s0,'support',confirmedPrice) 且 s0.upper > lower 且 !ethSnap[horizon].isBreakdown:
    lower = s0.upper; basis.push("firstSupport近端=s0.upper，未跌破，收紧下界")
否则若 ethSnap[horizon].isBreakdown 且 isValidZone(s1,'support',confirmedPrice) 且 s1.upper > lower:
    lower = s1.upper; basis.push("已跌破，改用secondSupport近端=s1.upper收紧下界")

// 按方向权重非对称放宽（仅在 weights!==null 时执行；weights===null 走§5.2门槛，不会到这里）
若 bullish >= 55 且 isValidZone(r1,'resistance',confirmedPrice) 且 r1.lower > upper:
    upper = r1.lower; basis.push("偏多权重≥55，上界放宽至secondResistance近端")
    若 isValidZone(s0,'support',confirmedPrice): lower = s0.upper   // 同时收紧下界形成非对称区间
否则若 bearish >= 55 且 isValidZone(s1,'support',confirmedPrice) 且 s1.upper < lower:
    lower = s1.upper; basis.push("偏空权重≥55，下界放宽至secondSupport近端")
    若 isValidZone(r0,'resistance',confirmedPrice): upper = r0.lower

// 最终合法性检查（finite / 顺序 / 方向 / 最小宽度，逐项检查，任一失败整体回退到initialLower/initialUpper）
合法条件 = finite(lower) && finite(upper) && lower < confirmedPrice && confirmedPrice < upper
           && (upper - lower) >= 0.3 × atr14 × k   // 最小宽度：不得因为结构位收紧导致区间窄到失去意义
若 不合法:
    lower = initialLower; upper = initialUpper
    basis = ["结构位冲突或宽度不足，已回退至ATR区间", "confirmedPrice(horizon)=...", "ATR14(horizon)=...，半径系数k=..."]
```
**红线**：本算法任何一步都只在"有效zone存在"时才使用它，`isValidZone` 判定失败时一律跳过该步骤（保留上一步的合法值），**不为了让 `lower<price<upper` 成立而伪造一个不存在的结构位**（问题8第8点）。找不到任何有效结构位时，最终结果就是纯ATR外推的 `initialLower/initialUpper`，这本身就是合法输出，不是"失败"。

### 6.3 生成依据（`basis` 字段，必须逐条列出，供UI展示和日后审计）

示例（1小时horizon，结构位正常收紧）：
```
[
  "confirmedPrice(1h)=3412.50",
  "ATR14(1h)=18.20，半径系数k=1.0",
  "初始区间=[3394.30, 3430.70]",
  "firstResistance近端=3448.00，未突破，本档不收紧上界",
  "firstSupport近端=3401.00，收紧下界至3401.00",
  "偏多权重62%（≥55），上界放宽至secondResistance近端=3465.00"
]
```
示例（结构位冲突回退）：
```
[
  "结构位冲突或宽度不足，已回退至ATR区间",
  "confirmedPrice(15m)=3412.50",
  "ATR14(15m)=6.10，半径系数k=1.2"
]
```

### 6.4 措辞红线（呼应问题9，见§10.8）

`PriceRangeEstimate` 是**规则型ATR结构推演区间**，不是经统计验证的置信区间。UI字段说明与本节文档均**必须**使用"规则型预计波动区间"或"ATR结构推演区间"其中之一指代这个区间；**禁止**使用"置信区间""覆盖率XX%""有XX%概率落在该区间"等暗示统计意义的措辞，直到V2完成历史覆盖率校准为止（详见§10.8）。

---

## 7. 情景目标生成算法（P1问题8已重写）

沿用§6.0定义的 `isValidZone`/近端/远端概念，`r0/r1/s0/s1` 同§6.2。

### 7.1 偏多情景目标区 `bullishZone`

```
若 isValidZone(r0,'resistance',confirmedPrice):
    near = r0.lower
    若 isValidZone(r1,'resistance',confirmedPrice) 且 r1.lower > near:
        far = r1.lower
        basis: "偏多目标区=[firstResistance近端, secondResistance近端]"
    否则:
        far = near + atr14 × 2.5
        basis: "secondResistance无效，偏多目标区上界改用ATR外推 = firstResistance近端 + ATR14×2.5"
否则:
    near = confirmedPrice + atr14 × 1.5
    far  = confirmedPrice + atr14 × 2.5
    basis: "firstResistance无效（越过confirmedPrice或非有限），偏多目标区整体改用ATR外推"

// 最终检查：finite、near<far、near>confirmedPrice、(far-near)>=0.1×atr14（最小宽度）
若 不满足任一条件: bullishZone = null（不得为了凑出区间而使用无效数值）
否则: bullishZone = [near, far]
```

### 7.2 偏空情景目标区 `bearishZone`（对称）

```
若 isValidZone(s0,'support',confirmedPrice):
    near = s0.upper
    若 isValidZone(s1,'support',confirmedPrice) 且 s1.upper < near:
        far = s1.upper
    否则:
        far = near - atr14 × 2.5
否则:
    near = confirmedPrice - atr14 × 1.5
    far  = confirmedPrice - atr14 × 2.5

// 最终检查：finite、far<near、near<confirmedPrice、(near-far)>=0.1×atr14
若 不满足任一条件: bearishZone = null
否则: bearishZone = [far, near]   // 数组按数值升序存放，[0]<[1]
```

### 7.3 与 confirmedPrice 的方向约束（问题8第1-4点，强制不变量）

- `bullishZone` 非 `null` 时，**两个边界必须都大于 `confirmedPrice`**（由7.1的构造过程保证：`near`/`far` 均基于"高于价"的zone或"价+正数ATR倍数"生成，不存在其它赋值路径）。
- `bearishZone` 非 `null` 时，**两个边界必须都小于 `confirmedPrice`**（同理，7.2的构造只使用"低于价"的zone或"价-正数ATR倍数"）。
- 若 `firstResistance`（或其zone）已经处于 `confirmedPrice` 下方（即 `isValidZone` 判定为false的"方向错误"情形），7.1 的 `若` 分支不会被采用，直接落入 `否则` 分支的ATR外推，**不允许**把这个已经在错误方向的旧结构位继续当作多头目标（同理适用于空头/支撑）。

### 7.4 震荡情景区间与免责声明

- **震荡情景区间** `rangingZone = [priceRange.lower, priceRange.upper]`（即§6算出的区间本身，因为"维持震荡"定义就是价格停留在预计波动区间内）
- `disclaimer` 常量 `'情景推演，不是确定预测'` 必须原样输出在 `ScenarioTargets` 对象和UI文案中，不得省略、不得改写为其他措辞。
- `directionLabel='数据不足'` 时，`scenarioTargets=null`，不生成任何情景目标。

---

## 8. 最可能路径生成算法

固定枚举、优先级从上到下第一个命中即返回（与 `classifyState` 的优先级设计风格一致，避免歧义）：

| 优先级 | id | 命中条件 | 中文文案 |
|---|---|---|---|
| 1 | `INSUFFICIENT_DATA` | `directionLabel ∈ {'数据不足'}` 或 `isManual===true` | "数据不足，暂不生成路径推演" |
| 2 | `BREAKOUT_THEN_PULLBACK` | `directionLabel==='偏多'` 且 该周期 `isBreakout===true` 且 `breakoutBarsCount≤3` 且 该horizon自己的 `falseBreakoutTier(horizon)!=='confirmation_failed'`（见§4.1因子10，逐周期计算，**不是** `decision.falseBreakoutTier`，那个只代表15m） | "突破关键压力后，可能出现回踩确认" |
| 3 | `BREAKDOWN_THEN_BOUNCE` | `directionLabel==='偏空'` 且 该周期 `isBreakdown===true` 且 `breakdownBarsCount≤3` 且 该horizon自己的 `falseBreakoutTier(horizon)!=='confirmation_failed'` | "跌破关键支撑后，可能出现反抽确认" |
| 4 | `PULLBACK_THEN_UP` | `directionLabel==='偏多'` 且 因子7(`srDistance`)判定当前更靠近压力（`bear`分量≥0.5）且 该horizon自己的 `falseBreakoutTier(horizon)!=='confirmation_failed'` | "可能先回踩，随后延续上涨" |
| 5 | `RALLY_THEN_FADE` | `directionLabel==='偏空'` 但因子5(`swingStructure`)显示近期仍有抬高的swing low（短期上冲力未消） | "可能先冲高测试压力，随后转跌" |
| 6 | `RANGE_ROUND_TRIP` | `directionLabel==='震荡'` | "价格可能在区间内往返运行" |
| 7 | `TREND_CONTINUATION`（兜底） | 以上都不命中，但 `directionLabel ∈ {'偏多','偏空'}` | "可能顺势延续原方向" |

`directionLabel==='不确定'` 且不满足条件1-6时，`mostLikelyPath=null`（不确定情况下不勉强给出路径，只展示权重和证据）。

**"该horizon自己的 `falseBreakoutTier(horizon)`"精确定义**（呼应问题4，见§4.1因子10的算法列）：对15m调用 `C.falseBreakoutTier(ethSnap.tf15m, btcSnap.tf15m)`，对1h调用 `C.falseBreakoutTier(ethSnap.tf1h, btcSnap.tf1h)`，对4h调用 `C.falseBreakoutTier(ethSnap.tf4h, btcSnap.tf4h)`——三次独立调用，各自只用本周期的ETH/BTC快照。15m结果允许与 `decision.falseBreakoutTier` 做一致性断言（两者应相等，因为 `decision.falseBreakoutTier` 内部就是 `classifyState(e15,b15,...)` 间接调用同一个 `falseBreakoutTier(e15,b15)`），但**不得**把15m算出的值直接复制给1h/4h使用。

---

## 9. 支持证据 / 反对证据算法

1. 取该horizon所有 `status='ok'` 的因子。
2. 若 `directionLabel ∈ {'偏多','偏空'}`：按对应方向（`points.bull`或`points.bear`）降序排序，取前3个且该分量`>0`的因子，生成 `supportingEvidence`（用其 `evidenceText`）；再按"拉向另外两个桶之和"降序排序，取前3个生成 `opposingEvidence`。
3. 若 `directionLabel==='震荡'`：`supportingEvidence`取`points.range`降序前3；`opposingEvidence`取`points.bull+points.bear`降序前3。
4. 若 `directionLabel==='不确定'`：`supportingEvidence`为空数组，`opposingEvidence`列出 `bullish/bearish/ranging` 三者具体数值并说明"无清晰领先方向（差距<8）"。
5. 每条证据文本必须包含：因子中文名、该因子读到的具体状态值、对该方向贡献的点数，如：`"1H结构：BULL_CONFIRMATION（多头确认），贡献偏多+18.0分"`。
6. `directionLabel==='数据不足'` 时，两个数组均为 `[]`。

---

## 10. 安全与降级规则（对应需求原文第六节，逐条落地）

### 10.1 手动观察模式
`decision.isManual===true` 时：`ForecastOutput.suppressedReason='手动观察模式：不生成方向预测、权重、目标或路径'`，`m15/h1/h4` 全部为 `null`。`executability.worthBetting` 固定读 `decision.worthBetting`（V1.1中手动模式下恒为`false`），`note` 固定含"手动观察模式不生成交易建议"。**不写入预测日志**（与V1.1决策日志规则一致，见§13.3）。

### 10.2 数据异常/失效（P0问题1第8点已补全：区分"v11decision触发但健康度差"与"v11decision根本不触发"两种异常）

两条独立但都必须覆盖的路径：

**(a) `buildForecast` 被正常调用，但 `decision.dataHealth !== 'normal'` 且非手动模式**：三个horizon直接判定为"数据不足"（§5.2条件2），**不得**保留、复用上一次 `prevForecast` 的任何字段（哪怕看起来"差不多"），也**不得**复用 `prevForecast` 对象本身的引用（必须产出全新对象，供测试用 `!==` 判等）。UI层渲染时必须以本次 `ForecastOutput` 为唯一真相源，不允许在渲染失败时静默回退显示旧预测。未收盘的实时价格此时仍可用于展示"当前价"和盘中距离，但不得参与任何预测判定。

**(b) `buildForecast` 这次刷新周期根本不会被调用**：根据§11.3对真实 `refresh()`/`render()` 代码的核对，`cache.partial===true`（任一路K线失败）或 `render(d)` 内部因 `d.dataHealth!=='normal'` 早退时，`v11decision` 事件当次都不会触发，V1.2 的 `buildForecast` 调用点（挂在 `v11decision` 监听器里）**不会执行**。这种情况**不能**因为"事件没触发、代码没跑"就让页面继续显示上一次成功刷新时留下的旧预测——必须依赖§11.3描述的 `window.invalidateDashboard` 钩子包装机制，在其被调用时同步执行 `clearForecast(reason)`：清空 `forecast15m`/`forecast1h`/`forecast4h` 三个区域为"预测已失效，等待下次成功刷新"，并将 `window.__prevForecast` 置 `null`（不是留着旧对象不管）。`V1_2_ACCEPTANCE_TESTS.md` T12（已重写，见问题11）与 T29 用真实DOM事件路径验证这条路径。

### 10.3 预测有效期
```
m15.validUntil = 该15m周期下一根K线的收盘时间（等价于 C.getCountdown15m 的endTime概念，套用到15m周期本身）
h1.validUntil  = 下一根1h K线收盘时间
h4.validUntil  = 下一根4h K线收盘时间
```
UI在 `now > validUntil` 时必须显示"预测已过期，等待刷新"，不得继续展示已过期的 `directionLabel`/`weights`/`priceRange` 当作当前有效结论（呼应"不能保留旧预测冒充当前预测"）。

### 10.4 BTC或关键周期缺失（P0问题3：周期标识已订正为真实格式）

`marketData.failed` 数组中若包含该horizon对应的ETH周期或对应的BTC周期，该horizon**强制**判定为"数据不足"（不进入§5.3计分，不做因子级missing处理，直接整体降级），`suppressedReason` 写明具体缺失的周期名。这是硬性要求（原文"BTC或关键周期缺失时必须降级为'不确定'或'数据不足'"），本规范选择更保守的"数据不足"而非"不确定"，因为关键周期缺失意味着无法计算，而不是"算出来了但不清晰"。

**周期标识格式（唯一真相，取代 draft-1 中错误的 `'btc-tf4h'` 等示例）**：与 `fetchAllTimeframeKlines`（`v1-core.js` 第12行 `id:asset+'.'+key`）完全一致，共6个可能取值：`'eth.tf15m'`、`'eth.tf1h'`、`'eth.tf4h'`、`'btc.tf15m'`、`'btc.tf1h'`、`'btc.tf4h'`。禁止使用连字符（`-`）或其他分隔符变体。判定映射：

| horizon | 该horizon依赖的两个key |
|---|---|
| 15m | `'eth.tf15m'`、`'btc.tf15m'` |
| 1h | `'eth.tf1h'`、`'btc.tf1h'` |
| 4h | `'eth.tf4h'`、`'btc.tf4h'` |

`marketData.failed.includes('eth.tf15m') || marketData.failed.includes('btc.tf15m')` → 15m horizon 数据不足，以此类推。这一判定与§11.4描述的"浏览器实际很少以partial=true调用buildForecast"并不矛盾——纯函数层面的正确性必须独立成立，见§11.4。

关于§11.3揭示的真实约束的补充说明：由于浏览器主循环里 `cache.partial===true` 会导致整体 `throw`（而不是把某个具体失败周期的 `d` 传给 `buildForecast`），"某个具体周期缺失、其余horizon不受影响"这一逐周期降级效果，在当前HTML接线下**只在直接调用 `buildForecast` 的单元/验收测试中可观察**，浏览器里表现为§10.2(b)的整体 `clearForecast`。这是已知、已记录的架构限制（不是本轮遗漏），本文档不修改 `refresh()` 的整体阻塞策略（那属于V1.1既有设计，不在本轮改动范围）。

### 10.5 不绕过V1.1硬性否决规则
`decision.opportunityScores.blocked===true`（即 `assessHardBlocks` 判定命中，`v1-core.js` 中 `hardBlocked` 是同一布尔值的别名字段，取其一即可）时：
- 方向预测（`directionLabel`/`weights`/`priceRange`/`scenarioTargets`/`mostLikelyPath`）**仍然正常计算并展示**，因为这是对"未来走势"的规则推演，不等同于"现在能否入场"。
- 但 `ForecastOutput.blockedByV11=true`，UI 必须在预测面板最上方强制显示："当前不满足V1.1交易许可，预测仅供参考，不构成入场理由"。
- `executability.note` 必须包含 `decision.warnings` 中记录的具体否决原因。
- **不允许**任何V1.2文案暗示"方向权重高=可以下单"。

### 10.6 赔率不合格时的强制提示
无论 `directionLabel` 或 `weights` 数值多高，只要 `decision.worthBetting===false`，`executability.note` 必须包含固定字样"不值得下注"，且该提示必须与方向预测面板并排展示在同一视觉区域内，不得让用户只看到"偏多权重78%"而看不到"不值得下注"。

### 10.7 通用禁止事项
不自动下单（V1.2 不产出任何下单/挂单调用）；不读取密钥（V1.2 模块不访问任何 API Key/环境变量）；不做盈利承诺（所有文案禁止"稳赚""必然""保证"等词）。

### 10.8 "预计区间"的语义边界（P1问题9）

`PriceRangeEstimate` 本质是§6描述的**规则型ATR结构推演区间**——半径来自ATR固定系数，边界可能被结构位收紧，全程没有经过任何历史数据的覆盖率/命中率验证。这与统计学意义上的"置信区间"（例如"95%置信区间"意味着重复采样95%的情形会落在区间内，是经过验证的统计陈述）完全不是一回事。

**强制措辞规则**：
- UI字段说明、`basis` 文案、日志字段注释中提到这个区间时，只能使用"规则型预计波动区间"或"ATR结构推演区间"这两种表述之一（二选一，全文档/全UI保持同一种，见§13）。
- **禁止**出现"置信区间""覆盖率XX%""有XX%概率落在该区间""统计显著""历史命中率XX%"等任何暗示该区间已经过统计验证的措辞。
- 在V2完成历史回放并算出真实的区间覆盖率（`ForecastLogEntry.rangeCoverage`，见§12）之前，`ForecastOutput`/UI/日志的任何地方都不得为这个区间标注百分比形式的"概率"或"置信度"数值——`HorizonForecast.confidence` 是"数据完整度元评分"，与"这个价格区间本身有多准"是两个不同概念，不得混用同一个数字。
- `V1_2_ACCEPTANCE_TESTS.md` T26 对此做正则扫描断言。

---

## 11. 与 V1.1 的接口关系

### 11.1 模块边界

新建独立模块 `v1_2-forecast-core.js`，UMD封装风格与 `v1-core.js` 一致，导出为 `window.ETHAlphaForecast`（Node端 `module.exports`）。该模块内部通过 `require('../v1-core.js')`（或浏览器端读取 `window.ETHAlphaCore`）调用其**已导出**的纯函数：`analyzeKlines`、`emaSeries`、`calcATR`、`btcAlignment`、`buildSRZones`、`calcPositionMetrics`、`calcVolumeQuality`、`falseBreakoutTier` 等。**不得复制这些函数的实现，不得修改 `v1-core.js` 的导出列表或任何函数体**。若确有必要用到 `v1-core.js` 未导出的私有辅助（如 `resolveLevels`），在 `v1_2-forecast-core.js` 内部另行实现一个命名不同、职责单一的等价小函数，并在代码注释中说明这是"独立小实现，非复用私有函数"，不允许要求修改 `v1-core.js` 的导出列表来间接绕过。

### 11.2 顶层函数签名（已按§0订正，取代 draft-1 中错误的 ethTf/btcTf-as-AnalyzedSnapshot 签名）

```ts
ETHAlphaForecast.buildForecast(
  marketData: {
    eth: { tf15m: Kline[]; tf1h: Kline[]; tf4h: Kline[] },
    btc: { tf15m: Kline[]; tf1h: Kline[]; tf4h: Kline[] },
    partial: boolean,
    succeeded: string[],
    failed: string[]
  },
  decision: DecisionOutput,
  prevForecast: ForecastOutput | null,
  now: number
) => ForecastOutput
```
`buildForecast` 内部第一步（`decision.isManual===false` 时）：
```js
const ethSnap = {
  tf15m: C.analyzeKlines(marketData.eth.tf15m, '15m', 'ETH'),
  tf1h:  C.analyzeKlines(marketData.eth.tf1h,  '1h',  'ETH'),
  tf4h:  C.analyzeKlines(marketData.eth.tf4h,  '4h',  'ETH'),
};
const btcSnap = {
  tf15m: C.analyzeKlines(marketData.btc.tf15m, '15m', 'BTC'),
  tf1h:  C.analyzeKlines(marketData.btc.tf1h,  '1h',  'BTC'),
  tf4h:  C.analyzeKlines(marketData.btc.tf4h,  '4h',  'BTC'),
};
```
（`decision.isManual===true` 时跳过这一步，直接进入§10.1的手动模式短路，不对不可信的 `marketData` 调用 `analyzeKlines`。）

### 11.3 HTML 接线（唯一允许改动 `refresh()` 的一行，其余全部在新增的第4个`<script>`块内完成）

真实 `refresh()`（`eth-dynamic-trading-dashboard.html`）当前实现：
```js
async function refresh(){
  ...
  try{
    cache=await C.fetchAllTimeframeKlines();
    const d=C.buildDecision(cache.eth,cache.btc,null,prev,C.COST_DEFAULT);
    if(cache.partial)throw Error('关键周期缺失：'+cache.failed.join(', '));
    render(d);
  }catch(e){
    window.invalidateDashboard?.(e.message);
    ...
  }finally{ ... }
}
```
关键事实（决定了V1.2只能怎么接线，不能怎么接线）：
1. `cache` 就是 §0 定义的 `marketData`（`fetchAllTimeframeKlines()` 的原始返回值），`buildForecast` 的第一个参数直接传它即可，不需要转换。
2. **只要 `cache.partial===true`（任意一路K线失败），`render(d)` 就不会被调用，`v11decision` 事件当次刷新周期内完全不会触发**——因为 `throw` 发生在 `render(d)` 之前。这是 V1.1 的既有行为，V1.2 不得也不能改变它。
3. `render(d)` 函数体自身开头还有一条独立的早退路径：`if(d.dataHealth!=='normal'&&!d.isManual){window.invalidateDashboard?.(reason,d);return;}`——数据到达但健康度判定为非 `normal`（如陈旧、ETH/BTC时间错位）时，同样**不会**走到 `render(d)` 末尾的 `v11decision` 派发。
4. 因此，`v11decision` **不触发**的场景一共有三类（refresh 整体 catch、cache.partial 导致的 throw、render 内部健康度早退），三者的唯一共同点是：**都会调用已存在的 `window.invalidateDashboard(...)` 钩子**（`v1-core.js`/HTML 第3个脚本块中定义并赋值给 `window.invalidateDashboard` 的既有函数，供页面在数据失效时清空全部V1.1只读展示区）。这是 V1.1 专门为"数据失效时清空旧展示"设计的通用钩子，V1.2 直接复用它，不需要新增事件、不需要碰 `refresh()`/`render()` 的既有分支逻辑。

**唯一允许的一行改动**（插入位置：`cache=await C.fetchAllTimeframeKlines();` 之后、`const d=C.buildDecision(...)` 之前，此时无论后续是否 `throw`，这一行都已执行完毕）：
```js
window.__lastMarketData = cache;
```
不允许在 `refresh()`/`render()`/`renderV11()` 内新增第二行、修改任何既有分支判断、修改既有 DOM 写入顺序。`window.__lastMarketData` 取代 draft-1 中不存在的 `window.__lastEthTf`/`window.__lastBtcTf` 概念——V1.2 不再假设有已分析好的快照被暴露到 `window` 上，只暴露最原始的六路K线集合，快照由 §11.2 描述的 `buildForecast` 内部自行派生。

第4个 `<script>` 块（新增文件/新增DOM，不改前三块）内完成剩余接线：
```js
document.addEventListener('v11decision', (e) => {
  const d = e.detail;
  const f = window.ETHAlphaForecast.buildForecast(window.__lastMarketData, d, window.__prevForecast, Date.now());
  window.__prevForecast = f;
  renderForecast(f);
});

// 包装（不修改）既有的 window.invalidateDashboard：数据失效导致 v11decision 不触发时，
// 三条路径最终都会调用到这里，统一清空预测面板，杜绝"旧预测留在页面"。
const prevInvalidateDashboard = window.invalidateDashboard;
window.invalidateDashboard = function(reason, known){
  if (typeof prevInvalidateDashboard === 'function') prevInvalidateDashboard(reason, known);
  clearForecast(reason);
};

function clearForecast(reason){
  window.__prevForecast = null;   // 不复用旧对象引用，下一次成功刷新必须产出全新 ForecastOutput
  // 将 forecast15m/forecast1h/forecast4h 三个DOM区域重置为"预测已失效，等待下次成功刷新"文案，
  // 并将 reason 写入界面（例如 forecastBlocked 区域），不得让方向/权重/区间/目标类数字继续停留在旧值。
}
```
这满足红线要求："数据异常/手动模式下必须清空预测，绝不用旧预测冒充当前预测"——即使某次刷新从未走到 `v11decision`，`clearForecast` 也一定会被触发，因为它挂在 `window.invalidateDashboard` 上，而不是挂在 `v11decision` 事件上。

`buildForecast` 保持为不访问 DOM/`window` 的纯函数（§11.2 签名本身不依赖 DOM），**不修改** `buildDecision` 本身的实现或返回值形状（保持101项V1.1测试的输入输出契约不变），**不修改**既有的 `render(d)` / `renderV11(d)` 函数体本身，新渲染逻辑作为**第4个独立脚本块**，只监听既有的 `v11decision` 事件——不新增 `v12forecast` 自定义事件（draft-1 曾设想新增该事件，但既然直接监听 `v11decision` 已足够且更简单，按"不重复造轮子"原则去掉这个多余概念）。

### 11.4 `marketData.failed` 在纯函数层面的用途（与11.3的浏览器实际行为分层）

由于11.3第2点的事实（`cache.partial===true` 时浏览器主循环根本不会调用到能拿到 `d` 的路径），**浏览器实时刷新场景下 `buildForecast` 实际不会被以 `marketData.partial===true` 为实参调用**——那种情况由 `clearForecast` 统一处理。但 `buildForecast`/`buildHorizonForecast` 作为纯函数，**仍必须正确实现 §10.4 描述的逐周期 `failed` 判定逻辑**，原因：
1. `V1_2_ACCEPTANCE_TESTS.md` 的 T10/T21 等用例需要直接构造 `partial:true` 的 `marketData` 对单个函数做单元验证，不经过浏览器；
2. 为未来（V2 或后续对 `refresh()` 本身的改造，例如放宽"任一周期失败即整体阻塞"的策略）预留正确的纯函数基础——一旦上层调用方式变化，`buildForecast` 不需要重新设计即可支持逐 horizon 降级；
3 `buildForecast` 是唯一对外入口，其正确性不应默许因为"当前唯一调用方恰好从不传入 partial=true"而打折扣。

---

### 11.5 可执行性评分的透传原则

`ForecastOutput.executability` **不重新计算**任何评分，只读取：
```
executability.worthBetting = decision.worthBetting
executability.tradability  = decision.opportunityScores ? decision.opportunityScores.tradability : null
```
理由：V1.1 的 `worthBetting` 是独立于 `score` 的红线判断（STRATEGY_SPEC §17.3 已有测试断言 `buildDecision` 源码不包含 `score.total` 字样），V1.2 若另造一个"可执行性评分"，必然与V1.1口径不一致，产生误导。V1.2 只做**展示层面的并排呈现**，不做二次判断。

---

## 12. 与 V2 历史校准的接口（P1问题10已重写：升级schema以保证可复现，见文末变更记录第10条）

**订正说明**：draft-1 的 `ForecastLogEntry` 只存 `tripleTimeframeFeatures` 这一份"少量摘要"（6个字符串），无法从日志反推出当时12项因子各自的 `bull/bear/range/points`，也就无法复现当时的方向权重是怎么算出来的——一旦 §4.2 的权重表或 §4.1 的因子算法在未来版本调整，旧日志将永久失去复现能力。draft-2 重写为：**日志必须完整到能独立复现当时的 `HorizonForecast` 计算结果，不依赖任何"当前代码版本"**。

V1.2 只需为以下字段预留结构和写入接口，**不实现**回放引擎、不实现Brier Score/方向准确率/覆盖率的计算逻辑，这些计算方法留给V2设计。

```ts
interface ForecastLogEntry {
  // ---- 0. 版本与可复现性元信息（新增，问题10核心诉求） ----
  schemaVersion: string;             // 本interface自身的版本号，当前 'v1.2-log-2'；interface字段增删时必须递增
  forecastAlgorithmVersion: string;  // 对应 V1_2_FORECAST_SPEC.md 的版本号，当前 'v1.2-draft-3'；§4-§9算法有任何行为变化时必须递增，见下方"版本号红线"
  factorWeightVersion: string;       // 对应 §4.2 权重表版本号，如 'v1.2-weights-1'；权重表数值变化时必须递增，独立于 forecastAlgorithmVersion（算法不变但只调权重时，只需升这个号）
  algorithmVersion: string;          // forecastAlgorithmVersion的审计别名，blocked日志也必须存在
  weightVersion: string;             // factorWeightVersion的审计别名，blocked日志也必须存在
  id: string;
  source: 'Binance';                 // 与 v1-core.js buildEnhancedLogEntry 的 source 字段口径一致，固定值
  symbol: 'ETHUSDT';                 // V1.2 预测面板固定针对 ETH/USDT，与 V1.1 pairs[0] 一致
  generatedAt: number;                // = ForecastOutput.generatedAt
  timestamp: number;                  // 兼容旧字段名，= generatedAt，新代码统一读 generatedAt，此字段只为与V1.1 buildDecisionLogEntry的timestamp命名习惯保持兼容
  horizon: '15m' | '1h' | '4h';
  dataAsOf: number;                   // = HorizonForecast.dataAsOf
  validUntil: number;                 // = HorizonForecast.validUntil
  status: 'valid' | 'blocked' | 'blocked_by_v11';
  blocked: boolean;
  blockReasons: string[];
  confirmedPrice: number | null;       // blocked审计固定为null
  atr14: number | null;                // blocked审计固定为null
  directionLabel: HorizonForecast['directionLabel'] | null; // blocked审计固定为null
  dataHealth: DecisionOutput['dataHealth'];   // 透传 decision.dataHealth，记录当时的数据健康度
  blockedByV11: boolean;               // = ForecastOutput.blockedByV11
  worthBetting: boolean;               // = ForecastOutput.executability.worthBetting
  // 1) 当时使用的已收盘K线：为避免日志体积爆炸，存引用（时间戳+周期即可反查Binance历史K线），不存整份K线数组
  closedKlineRef: { symbol: 'ETH' | 'BTC'; timeframe: '15m' | '1h' | '4h'; lastClosedOpenTime: number }[];  // 固定6条，ETH+BTC×三周期，取自§0 ethSnap/btcSnap各快照最后一根已收盘K线的openTime
  // 2) 完整12项因子结果（问题10核心新增，取代draft-1的tripleTimeframeFeatures摘要）：
  factorResults: {
    id: string;          // 同 ForecastFactorResult.id
    status: 'ok' | 'missing';
    bull: number;
    bear: number;
    range: number;
    weightMax: number;
    points: { bull: number; bear: number; range: number };
    evidenceText: string;
  }[];   // 恒为12项，missing的因子也必须出现（bull/bear/range/points均为0），供V2逐项重放§5.1-§5.3的计算过程
  // 3) 方向权重
  directionWeights: DirectionWeights | null;
  // 4) 预计区间
  priceRange: PriceRangeEstimate | null;
  // 5) 情景目标
  scenarioTargets: ScenarioTargets | null;
  // 6) 失效条件
  invalidation: InvalidationCondition[];
  mostLikelyPath: PathScenarioId | null;
  confidence: number | null;          // = HorizonForecast.confidence?.score ?? null
  // 7-12) 以下字段V1.2只建结构，值恒为null，由V2的历史回放脚本回填：
  outcomeAfter1Bar:  { realizedClose: number; mfe: number; mae: number; hitTargetFirst: boolean | null; hitInvalidationFirst: boolean | null } | null;
  outcomeAfter4Bars: { realizedClose: number; mfe: number; mae: number; hitTargetFirst: boolean | null; hitInvalidationFirst: boolean | null } | null;
  outcomeAfter16Bars:{ realizedClose: number; mfe: number; mae: number; hitTargetFirst: boolean | null; hitInvalidationFirst: boolean | null } | null;
  brierScoreComponent: number | null;
  directionAccuracy: boolean | null;
  rangeCoverage: boolean | null;
  calibrationBucket: number | null;   // 供未来校准曲线分桶用
  calibratedProbability: number | null;  // V2专用，V1.2中恒为null，禁止赋任何非null值
}
```

### 12.1 "bar"的唯一定义（问题10最后一点：`outcomeAfter1/4/16Bars` 的单位必须统一，四份文档只能选一种）

**唯一定义：`1 bar = 固定15分钟跨度**，不随该条日志自身的 `horizon` 字段变化（不是"以预测horizon自身周期为单位"这个选项）。理由：
- `1/4/16` 这三个数字本身就是 `15m : 1h : 4h` 的比例（`15m×1=15m`，`15m×4=1h`，`15m×16=4h`）——这不是巧合，是设计上刻意让"固定15分钟bar"与三个horizon对齐：对一条 `horizon='15m'` 的日志，`outcomeAfter1Bar` 就是检验该条15分钟预测本身到期（15分钟后）时的结果；对一条 `horizon='1h'` 的日志，`outcomeAfter4Bars`（4×15分钟=1小时后）才是检验该条1小时预测到期时的结果；对一条 `horizon='4h'` 的日志，`outcomeAfter16Bars`（16×15分钟=4小时后）才是检验该条4小时预测到期时的结果。
- 若改用"以预测horizon自身周期为单位"（即 `horizon='4h'` 时1 bar=4小时），`outcomeAfter16Bars` 就会变成"64小时后"，与该条日志的 `validUntil`（4小时后）严重错位，V2校准时无法用同一套"到期即检验"逻辑统一处理三个horizon，必须为每个horizon另写一套bar换算，属于不必要的复杂度。
- 因此：**每条 `ForecastLogEntry`，无论 `horizon` 是什么，`outcomeAfter1Bar/4Bars/16Bars` 都固定以ETH 15分钟K线的收盘为计量单位**，V2回放脚本统一用 `dataAsOf + N×15分钟` 定位对应的历史K线收盘价。`horizon='15m'` 的日志最关心 `outcomeAfter1Bar`，`horizon='1h'` 的日志最关心 `outcomeAfter4Bars`，`horizon='4h'` 的日志最关心 `outcomeAfter16Bars`，但三个字段对所有horizon都会照常填充（不因为"不是最关心的那个"就留空），供V2统一做多周期回看分析。
- `V1_2_ACCEPTANCE_TESTS.md` T31 断言这一定义在字段注释/建表函数中一致出现，且不得出现"随horizon变化"的实现。

### 12.2 版本号红线（保证"不能用后来修改的权重解释旧日志"）

- `schemaVersion`/`forecastAlgorithmVersion`/`factorWeightVersion` 三者独立递增，互不联动。
- 任何修改 §4.1 因子算法、§4.2 权重表数值、§5-§9 计算规则的提交，**必须**同步递增 `forecastAlgorithmVersion`（算法逻辑变化）和/或 `factorWeightVersion`（仅权重表数值变化）；只改 `ForecastLogEntry` 自身字段结构（增删字段）时递增 `schemaVersion`。
- V2 回放/校准脚本读取旧日志时，**必须**优先使用日志条目自带的 `factorResults`/`directionWeights`/`priceRange` 等已落盘的计算结果做校准，**禁止**用"当前代码版本重新跑一遍算法"去覆盖或解释历史日志——因为当前代码版本的权重表可能已经和写日志时不同，重新计算会产生与实际展示给用户的历史预测不一致的复现结果。`forecastAlgorithmVersion`/`factorWeightVersion` 的作用只是让V2能够按版本分组统计（例如"只用 v1.2-weights-2 之后的日志做校准"），不是让V2重新计算。

### 12.3 写入函数

写入函数（仿照 `v1-core.js` 中 `buildDecisionLogEntry`/`saveDecisionLog(entry, storage)` 的既有模式，`storage` 以参数注入而非硬编码 `window.localStorage`，便于Node测试传入mock storage）：`buildForecastLogEntry(forecast, horizonForecast, horizon, options?)` 生成单个horizon的日志条目，`saveForecastLog(entry, storage)` 写入独立的 `localStorage` key `ethAlphaForecastLogs`（对照V1.1实际使用的 `ethAlphaDecisionLogs`/`ethAlphaDecisionLogsV11`，命名风格保持一致但key本身必须不同，避免互相污染/超限清空互相挤占）。手动模式（`isManual===true`）**不写入**正式预测日志，与V1.1决策日志规则完全一致。

正常预测写 `status='valid'`；数据不足、数据陈旧、关键周期缺失、预测失败或预测过期必须写 `status='blocked'`、`blocked=true`、非空 `blockReasons`、`dataHealth`、`dataAsOf`、`horizon`、`algorithmVersion`、`weightVersion`，且 `calibratedProbability=null`。blocked审计的 `directionLabel`、`directionWeights`、`priceRange`、`scenarioTargets`、`mostLikelyPath`、`confidence` 必须为null，`invalidation`与已失效K线引用必须为空集合，不能沿用上一条成功预测。唯一键仍由交易对、时窗、`dataAsOf`、算法版本和权重版本组成；同一键只保留一条，最多保存1500条。

MFE（最大有利波动）/MAE（最大不利波动）、"是否先到目标还是先到失效位"的计算方法、Brier Score/方向准确率/区间覆盖率/校准曲线的具体统计公式，均属于V2范围，本文档不定义，只保证字段占位存在且命名到位，供V2直接读取而不需要改V1.2的日志schema。

---

## 13. UI 区域字段规范

正式单文件HTML由 `work/build-v1.js` 从模板和两个核心模块生成。构建脚本的每个文本替换目标与 `/*__CORE__*/`、`/*__FORECAST__*/` 占位符都必须校验精确出现次数；目标缺失或重复时立即抛错并终止构建，禁止静默输出残缺HTML。

新增中文区域标题："**走势预测与情景推演**"，作为独立的 `<article class="card span12">`（或拆分为3个 `span4` 子卡片，Codex任务中细化），置于V1.1现有面板下方，不得插入或穿插进V1.1现有卡片内部。

必须显示的字段（对照需求原文第八节逐项落地）：

| # | 需求项 | 对应数据字段 |
|---|---|---|
| 1 | 15分钟预测卡 | `forecast.m15`（含下列2-11全部子项） |
| 2 | 1小时预测卡 | `forecast.h1` |
| 3 | 4小时预测卡 | `forecast.h4` |
| 4 | 偏多/偏空/震荡权重 | `HorizonForecast.weights.{bullish,bearish,ranging}`，必须显示为"偏多权重62%"这类完整措辞，不得只写数字 |
| 5 | 预计波动区间 | `HorizonForecast.priceRange.{lower,upper}` + `basis` |
| 6 | 偏多目标区 | `HorizonForecast.scenarioTargets.bullishZone` |
| 7 | 偏空目标区 | `HorizonForecast.scenarioTargets.bearishZone` |
| 8 | 最可能路径 | `HorizonForecast.mostLikelyPath.text` |
| 9 | 失效条件 | `HorizonForecast.invalidation[].text`（列表） |
| 10 | 支持证据 | `HorizonForecast.supportingEvidence`（列表） |
| 11 | 反对证据 | `HorizonForecast.opposingEvidence`（列表） |
| 12 | 数据时间与预测有效期 | `HorizonForecast.dataAsOf` + `validUntil`，超期时显示"预测已过期，等待刷新" |
| 13 | 醒目提示 | `HorizonForecast.disclaimer`（"规则型权重，尚未经过历史胜率校准"），必须用与警示色一致的样式（参照现有 `.warn`/`.pill` 约定），常驻显示，不可折叠隐藏 |

此外必须显示（对应§10安全规则，不在需求原文列表但为红线要求所必须）：
- `blockedByV11===true` 时的强制文案（§10.5）。
- `executability.note` 中的"不值得下注"提示（§10.6），与预测面板并排。
- `directionLabel∈{'不确定','数据不足'}` 时的对应说明文案，且不得展示 `priceRange`/`scenarioTargets`/`mostLikelyPath` 为空却仍留白误导用户，必须显式文案说明原因（`suppressedReason`）。

**中文枚举映射**：沿用V1.1既有约定（`names`/`zhXxx` 风格对象），新增 `zhDirection={偏多:'偏多',偏空:'偏空',震荡:'震荡',不确定:'不确定',数据不足:'数据不足'}`（枚举值本身已是中文，此处仅为与既有代码风格保持一致，防止未来误用英文key）、`zhPathScenario`（12项 `PathScenarioId`→中文文案，见§8表格右列）、`zhInvalidation`（5项 `InvalidationId`→中文文案模板）。V1.1既有测试 `tests/v11-ui-tests.js` 中"可见静态文本无新增英文枚举"的检查原则，V1.2新增测试文件中必须有等价断言（见 V1_2_ACCEPTANCE_TESTS.md T17）。

---

## 14. 状态/标签优先级总表（供实现和测试对照）

```
方向标签优先级（由高到低，任一命中即停止判定）：
1. 手动观察模式        → 数据不足（suppressedReason='手动观察模式...'）
2. 数据健康非normal     → 数据不足
3. 该horizon关键周期/BTC缺失 → 数据不足
4. 可用权重<60（缺失权重≥40）→ 数据不足
5. 数据充分但margin<8   → 不确定
6. 三分桶最高为ranging  → 震荡
7. 三分桶最高为bullish  → 偏多
8. 三分桶最高为bearish  → 偏空
```

---

## 15. 禁止事项清单（V1.2 全文强制）

1. 禁止修改 `v1-core.js` 任何一行、任何导出签名。
2. 禁止修改 V1.1 既有的 `render(d)`/`renderV11(d)` 函数体。
3. 禁止在任何文案、日志字段、变量名中出现"真实概率""真实胜率""上涨概率XX%""胜率XX%""必涨""必跌""稳赚""保证盈利"。
4. 禁止手动观察模式下生成任何方向预测/权重/目标/路径/失效条件。
5. 禁止数据异常时复用/展示上一次的预测结果冒充当前预测。
6. 禁止绕过或弱化V1.1的 `assessHardBlocks` 硬性否决结论。
7. 禁止在 `worthBetting===false` 时隐藏或弱化"不值得下注"提示。
8. 禁止自动下单、禁止读取任何密钥/私钥/API Secret。
9. 禁止本轮实现V2回测引擎、WebSocket、真实概率校准算法（V2/V3范围）。
10. 禁止修改 `v1.1.0` tag 或其对应的 git 提交历史。

---

## 16. 变更记录（v1.2-draft-1 → v1.2-draft-2，CEO复审逐项关闭记录）

本节逐条记录CEO复审提出的问题、定位、修订方式，供 `V1_2_ARCHITECTURE_REVIEW.md` 交叉核对。

| # | 问题（CEO原文编号） | 优先级 | draft-1的错误 | draft-2的修订 | 对应章节 |
|---|---|---|---|---|---|
| 1 | 输入接口与V1.1真实代码不一致 | P0 | 假设 `C.buildDecision()` 接收已分析好的 `{tf15m:AnalyzedSnapshot,...}`；假设BTC三周期快照可从 `DecisionOutput` 直接拿到；使用不存在的 `window.__lastEthTf`/`window.__lastBtcTf` | 订正 `buildForecast` 签名为接收原始 `marketData`（`fetchAllTimeframeKlines()` 真实返回结构）；明确BTC 1h/4h快照必须由V1.2自行调用已导出的 `analyzeKlines` 派生（只读，bit-identical，不改变V1.1决策）；`window.__lastMarketData` 取代旧概念；异常刷新经 `window.invalidateDashboard` 包装统一触发 `clearForecast` | §0、§11.2、§11.3、§11.4 |
| 2 | `TRANSITION_WATCH` 分配不等于1 | P0 | `range=0.6+方向0.2`，总和0.8，违反 `bull+bear+range===1` 不变量 | 定义唯一算法 `transitionWatchSplit`：`range`固定0.6，`confirmedPrice>ema20→bull=0.4`，`<ema20→bear=0.4`，相等或数据不足→`range=1`（三分支和恒为1） | §4.1.1 |
| 3 | `failed` 周期标识格式错误 | P0 | 使用不存在的 `'btc-tf4h'` 等连字符格式示例 | 订正为 `fetchAllTimeframeKlines` 真实格式 `asset+'.'+key`（`'eth.tf15m'`/`'eth.tf1h'`/`'eth.tf4h'`/`'btc.tf15m'`/`'btc.tf1h'`/`'btc.tf4h'`，共6个），逐周期判定表 | §4.1因子9、§10.4 |
| 4 | 假突破风险未按三周期分别计算 | P1 | 三个horizon都直接用 `decision.falseBreakoutTier`（只代表15m） | 定义"该horizon自己的 `falseBreakoutTier(ethSnap[horizon], btcSnap[horizon])`"，三次独立调用；15m结果允许与 `decision.falseBreakoutTier` 做一致性断言，禁止直接复制给1h/4h | §4.1因子10、§8 |
| 5 | 成交量方向规则阈值未定义 | P1 | "takerBuyRatio与方向一致"无数值定义 | 唯一阈值：多头 `ratio≥1.2&&sustained&&takerBuyRatio≥0.55`；空头对称 `≤0.45`；`0.45~0.55`→range；`takerBuyRatio===null`→missing；明确三周期各自调用 `calcVolumeQuality`，不复用15m结果 | §4.1因子8 |
| 6 | Swing缺失规则误判 | P1 | `swingHighs.length<2 && swingLows.length<2`（"且"），单侧不足会被误判为有效震荡 | 改为"或"：任一侧不足2个点即missing；补全5类测试fixture要求（单边混合×2、单边缺失、完整多头、完整空头） | §4.1因子5、§4.4 |
| 7 | 支撑压力距离未要求双边有效 | P1 | 只有 `firstResistance`/`firstSupport` 同时为null才missing（`resolveLevels`兜底导致几乎不可能触发） | 改为双边校验 `isValidZone`：任一侧非有限、方向错误（越过confirmedPrice）或ATR无效即missing；精确定义zone近端/远端字段（压力用`lower`，支撑用`upper`） | §6.0、§4.1因子7 |
| 8 | 价格区间/情景目标合法性缺失 | P1 | 未规定突破后目标位选取、区间倒挂回退、虚假结构依据等边界情况 | 重写§6/§7：多头目标区两端必须>confirmedPrice，空头两端必须<confirmedPrice；已突破后必须找当前价正确方向下一有效结构区；无有效结构区时ATR外推；逐步finite/顺序/方向/最小宽度检查；`basis`必须记录选择与回退原因 | §6、§7 |
| 9 | "预计区间"语义误导 | P1 | 未明确区分规则型区间与统计置信区间 | 强制措辞"规则型预计波动区间"/"ATR结构推演区间"二选一，禁止"置信区间""覆盖率XX%"等表述，直至V2完成校准 | §6.4、§10.8 |
| 10 | V2日志schema不可复现 | P1 | `tripleTimeframeFeatures` 只存6个字符串摘要，无法复现12因子权重；`outcomeAfterNBars`的"bar"单位未定义 | `ForecastLogEntry` 新增 `schemaVersion`/`forecastAlgorithmVersion`/`factorWeightVersion`/`source`/`symbol`/`generatedAt`/`dataAsOf`/`validUntil`/`confirmedPrice`/`atr14`/`directionLabel`/`dataHealth`/`blockedByV11`/`worthBetting`/完整12项`factorResults`；`bar`唯一定义为固定15分钟跨度（`1/4/16`对应`15m/1h/4h`到期检验点）；版本号红线：改算法/权重必须递增对应版本号，禁止用新版本代码重算旧日志 | §12 |
| 11 | 测试T12断言错误 | P0（测试） | 断言"API失败后 `dataAsOf` 必须不同于 `prevForecast`"，但收盘K线时间可能恰好相同 | 删除该断言，改为验证：受影响horizon标记数据不足、各字段被清空、UI旧预测被清空/加失效标记、不复用`prevForecast`对象引用、`suppressedReason`列出真实失败周期、恢复后可重新渲染、全程走真实DOM事件路径 | 见 `V1_2_ACCEPTANCE_TESTS.md` T12 |
| 12 | 测试质量不足 | P1（测试） | 缺少端到端生产路径测试、fixture可能用自造字段绕过生产真实结构、缺少因子比例和为1的测试、过期后未验证遮蔽 | 见 `V1_2_ACCEPTANCE_TESTS.md` 新增/修订用例：端到端管线测试、真实字段fixture强制要求、比例和=1测试、过期遮蔽测试、DOM成功→失败→恢复测试、101项V1.1测试0失败回归要求 | `V1_2_ACCEPTANCE_TESTS.md` |
| 13 | 文档一致性 | — | draft-1 四份文档口径不一致 | draft-2 逐份同步修订，见本文档各处标注"已订正"处，并在 `V1_2_ARCHITECTURE_REVIEW.md` 中逐项核对四份文档口径一致 | 全文档 |

**发现但未在CEO原始清单中的额外修正**：`ForecastOutput.blockedByV11` 原定义为"透传 `decision.blocked`"，但核对 `v1-core.js` 源码（`buildDecision`/`calcOpportunityScores`/`calcScore`）后发现 `DecisionOutput` 上并不存在顶层 `blocked` 字段，真实可用字段是 `decision.opportunityScores.blocked`（同义字段 `hardBlocked`）或 `decision.score.overriddenByHardRule`。draft-2 统一改为透传 `decision.opportunityScores.blocked`，因为 `tests/third-review-tests.js` 已有生产路径断言此字段（`d.opportunityScores.blocked`），语义与"V1.1硬性否决"完全对应。见 §3、§10.5。
