# V1_2_FORECAST_SPEC.md — ETH Alpha 走势预测层（概率预测层）算法与数据规范

版本：v1.2-draft-1（本轮新增，V1.1 `v1.1.0`/commit `d9289ef` 之上的**增量**文档，不修改、不覆盖 STRATEGY_SPEC.md 已定义的任何算法）
角色：本文档只做 V1.2「走势预测层」的**架构设计与验收规范**，不是实现代码，也不由本文档作者实现正式业务代码。
适用范围：ETH/USDT 走势预测面板，三个独立预测时窗——未来15分钟 / 未来1小时 / 未来4小时，均在 V1.1 已有的三周期数据（4H/1H/15m，ETH+BTC）之上计算，不新增任何数据源、不新增任何K线请求。
唯一算法真相来源声明：本文档是 V1.2 预测算法的唯一 source of truth。V1_2_CODEX_IMPLEMENTATION_TASK.md 中的函数接口必须实现本文档定义的行为；V1_2_ACCEPTANCE_TESTS.md 的用例必须验证本文档定义的规则；V1_2_ARCHITECTURE_REVIEW.md 负责核对三者一致性。四份文档如有冲突，以本文档为准。

**红线（贯穿全文，反复强调不为过）**：
- V1.2 是**只读消费层**——只读取 V1.1 已导出的 `AnalyzedSnapshot`、`DecisionOutput` 及 `v1-core.js` 已导出的纯函数，**不修改 `v1-core.js` 的任何一行**，不重新计算 EMA/ATR/Swing/S-R/状态机，不重新请求 K 线。
- V1.2 只产出**规则型方向倾向**，不产出、不暗示、不标注任何"真实概率""真实胜率""必涨""必跌"字样。所有第4-5节算出的百分比数字，UI 和日志字段命名必须显式带"权重"二字。
- V1.2 不下单、不读密钥、不做盈利承诺。数据异常/手动模式下必须清空预测，绝不用旧预测冒充当前预测。

---

## 0. 记号约定

- 本文档使用的 `ethTf`/`btcTf` 指 HTML `refresh()` 中已经算好、传给 `C.buildDecision()` 的同一份 `{tf15m:AnalyzedSnapshot, tf1h:AnalyzedSnapshot, tf4h:AnalyzedSnapshot}` 对象（`C` = `window.ETHAlphaCore`）。V1.2 直接复用这份对象的引用，不重新调用 `analyzeKlines`。
- `decision` 指同一次 `refresh()` 里 `C.buildDecision(ethTf, btcTf, manual, prev, cost)` 的返回值（`DecisionOutput`，字段清单见 STRATEGY_SPEC.md §1.4 及 V1.1 增补字段）。
- `horizon` ∈ `{'15m','1h','4h'}`，三个预测时窗，与三周期数据的时间粒度一一对应（15分钟预测主要读 `ethTf.tf15m`，1小时预测主要读 `ethTf.tf1h`，4小时预测主要读 `ethTf.tf4h`，但 §5 的12项因子在三个 horizon 下都会读取全部三个周期的快照，只是权重分配不同）。
- 所有正式方向判定、区间生成、失效条件判定，只使用相应快照的 `confirmedPrice`、`isClosed=true` 的K线、以及由这些K线派生的 `priorStructureHigh/Low`、`swingHighs/Lows`。未收盘的 `price` 只允许用于 §10.2 的盘中距离展示和过期提醒，不允许参与任何因子计分或区间计算。

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
| 9 | 置信度 | V1.2 对"这次预测本身数据完整度与内部一致性"的元评分，**不是**胜率，不是概率 | V1.2 新增 | `HorizonForecast.confidence`，UI 必须写"置信度（数据完整度评分，非胜率）" |
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
  blockedByV11: boolean;                  // 透传 decision.blocked（V1.1硬性否决是否生效）
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
| 1 | `trend4h` | 4小时趋势 | `ethTf.tf4h.trend` | `'up'→bull=1`；`'down'→bear=1`；`'flat'→range=1` | `dataQuality.sufficientForEMA20===false` → missing |
| 2 | `structure1h` | 1小时结构 | `decision.mtfState` | `BULL_CONFIRMATION→bull=1`；`BULL_PULLBACK→bull=0.7,range=0.3`；`BEAR_CONTINUATION→bear=1`；`RANGE_CHOP→range=1`；`TRANSITION_WATCH→range=0.6`+按`confirmedPrice`相对`ema20`方向补齐`bull`或`bear`各0.2；`STAND_ASIDE→range=1` | `ethTf.tf1h.dataQuality.sufficientForSwing===false` → missing |
| 3 | `structure15m` | 15分钟执行结构 | `decision.state` | 同上映射规则，作用于15m状态 | `ethTf.tf15m.dataQuality.sufficientForSwing===false` → missing |
| 4 | `emaSlopeOwn` | EMA排列与斜率（预测目标自身周期） | 对目标horizon对应周期的收盘K线调用已导出的 `emaSeries(closes,5)`，取最近4个已收盘值算斜率 `slope=(ema5[-1]-ema5[-4])/atr14` | `slope>0.3→bull=1`；`slope<-0.3→bear=1`；否则 `range=1-|slope|/0.3`，剩余按符号分配给bull或bear | `atr14`为`null`或已收盘K线不足4根 → missing |
| 5 | `swingStructure` | Swing高低点结构 | 目标周期快照的 `swingHighs`/`swingLows` | 最近两个swing low抬高且最近两个swing high抬高→`bull=1`；两者都降低→`bear=1`；其余（含混合、不足2个）→`range=1` | `swingHighs.length<2 && swingLows.length<2` → missing |
| 6 | `atrState` | ATR波动状态 | 目标周期快照的 `atr14`/`atrPrev` | `atr14>atrPrev×1.15`（扩张）：若同周期状态机方向为多→`bull=1`，为空→`bear=1`，否则`range=1`；`atr14<atrPrev×0.85`（收缩）→`range=1`；其余→按同周期状态机方向50%+`range=0.5` | `atr14`或`atrPrev`为`null` → missing |
| 7 | `srDistance` | 动态支撑压力距离 | `C.calcPositionMetrics()` 已算出的距压力/支撑ATR距离 | 距压力<0.4×距支撑（更靠近压力）→`bear=0.6,range=0.4`；距支撑<0.4×距压力（更靠近支撑）→`bull=0.6,range=0.4`；其余→`range=1` | 目标周期 `firstResistance` 和 `firstSupport` 均为`null` → missing |
| 8 | `volumeQuality` | 成交量质量 | `C.calcVolumeQuality()` 的 `ratio`/`sustained`/`takerBuyRatio` | `ratio≥1.2 && sustained && takerBuyRatio` 与同周期状态机方向一致→该方向`=1`；否则→`range=1`（未确认的量能视为不确定，不给方向加分） | `volumeRatio===null` → missing |
| 9 | `btcAlignment3tf` | BTC三周期联动 | 对目标horizon所在周期，调用已导出的 `C.btcAlignment(bias, btcTf[对应周期])` | `'support'→`按ETH本周期状态机方向`=1`；`'conflict'→range=0.7`+反方向`0.3`；`'neutral'→range=1` | 该周期BTC K线获取失败（`fetchAllTimeframeKlines` 的 `failed` 列表包含该BTC周期）→ **硬性missing，且触发§10.4整horizon降级**，不参与普通因子重归一化 |
| 10 | `falseBreakoutRisk` | 假突破风险 | `decision.falseBreakoutTier`（对应周期） | `'confirmation_failed'→range=1`（原方向失效）；`'warning'→`原方向`0.5,range=0.5`；`'none'`且存在突破/跌破→原方向`=1`；`'none'`且无突破→`range=1` | 目标快照本身不可用（已被更上层的整体缺失判定拦截，不单独判missing） |
| 11 | `rangePosition` | 当前价格处于区间的位置 | `recentHigh20`/`recentLow20` 与 `confirmedPrice` 算出的区间位置百分比 | `>70%（近顶部）→bear=0.6,range=0.4`；`<30%（近底部）→bull=0.6,range=0.4`；其余→`range=1` | `recentHigh20`或`recentLow20`为`null` → missing |
| 12 | `mtfConflict` | 多周期方向冲突（元因子） | 只读取因子1/2/3**已经算出的**主导方向（各自bull/bear/range中最大者），不重新读取原始K线 | 三者主导方向一致→该方向`=1`；三者中两者一致→该方向`0.5,range=0.5`；三者互不相同→`range=1` | 因子1/2/3中有≥2个为missing → missing |

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
| 9 | `btcAlignment3tf` | 6 | 9 | 12 |
| 10 | `falseBreakoutRisk` | 4 | 5 | 6 |
| 11 | `rangePosition` | 2 | 2 | 3 |
| 12 | `mtfConflict` | 2 | 1 | 4 |
| | **合计** | **100** | **100** | **100** |

设计意图：15分钟预测更看重自身周期的执行结构（因子3权重22）和成交量/S-R距离（近端确认）；4小时预测更看重4H自身趋势（因子1权重22）和BTC三周期联动（宏观相关性更重要，因子9权重12）；1小时预测介于两者之间。

### 4.3 防止重复计分的规则

- 因子12（多周期方向冲突）**不得**重新读取任何原始K线/EMA/Swing数据，只允许读取因子1/2/3已经算出的 `bull/bear/range` 主导方向作为输入，因为"三周期是否冲突"这一事实完全由三个因子各自的结论决定，不存在独立的原始数据来源。
- 因子4（EMA斜率）与因子1/2/3（趋势/结构分类）是不同信号：因子1/2/3 读取的是 `trend`/状态机分类结果（分类型、离散），因子4 读取的是 EMA5 本身的斜率变化率（连续型、只反映"变陡/变缓"，不反映"当前是否已经确认为趋势"），两者输入字段不同，允许并存。
- 因子7（S-R距离）与因子11（区间位置）是不同信号：因子7 用的是"距最近结构性压力/支撑位的ATR距离"（结构意义），因子11 用的是"当前价在最近20根K线极值区间内的百分比位置"（统计意义），两者字段来源不同（`firstResistance/firstSupport` vs `recentHigh20/recentLow20`），允许并存，但**权重刻意压低**（因子11最高只有3点）以避免变相重复计分区间位置这一事实两次。
- 因子9（BTC联动）与因子2/3/1不会重复：BTC联动只读BTC自己的快照与`btcAlignment()`结果，不读取ETH自身结构。
- 任何后续如需新增因子，必须在合并前对照本表逐项确认"读取的原始字段"与现有12项互不重叠，否则视为违反本节红线。

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
3. 因子9（`btcAlignment3tf`）在该horizon判定为"硬性missing"（对应周期BTC数据获取失败，见§10.4）。
4. 该horizon缺失权重总和（所有`status='missing'`因子的`weightMax`之和）≥ 40（即可用权重不足60）。
5. 该horizon对应周期自身的`AnalyzedSnapshot.dataQuality.isStale === true`。

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

## 6. 预计价格区间生成算法

### 6.1 基准点与半径

以该horizon对应周期自身的 `confirmedPrice` 为基准点，半径取该周期 `atr14` 乘以固定系数：

| horizon | ATR来源 | 系数k |
|---|---|---|
| 15m | `ethTf.tf15m.atr14` | 1.2 |
| 1h | `ethTf.tf1h.atr14` | 1.0 |
| 4h | `ethTf.tf4h.atr14` | 1.0 |

```
initialLower = confirmedPrice - atr14 × k
initialUpper = confirmedPrice + atr14 × k
```

### 6.2 用结构位收紧/放宽

- 若 `initialUpper` 超过该周期 `firstResistance` zone 近端价格，且该压力位尚未被确认突破（`!isBreakout`），则 `upper` 收紧为该压力zone近端；反之若已确认突破，则改用 `secondResistance`（若存在）或保留ATR外推值。
- 若 `initialLower` 超过该周期 `firstSupport` zone 近端价格（跌破方向同理），对称处理。
- 若 `bullish ≥ 55`（方向权重明显偏多），允许 `upper` 放宽至 `secondResistance` 近端（若存在），但 `lower` 收紧至 `firstSupport` 近端，形成非对称区间体现方向倾向；`bearish ≥ 55` 时对称反向处理；两者都不满足时使用对称的 `initialLower/initialUpper`。
- 收紧/放宽后必须保证 `lower < confirmedPrice < upper`；若结构位导致区间倒挂（`lower ≥ upper`），放弃结构收紧，回退到§6.1的对称ATR区间（并在`basis`中注明"结构位冲突，已回退至ATR区间"）。

### 6.3 生成依据（`basis` 字段，必须逐条列出，供UI展示和日后审计）

示例（1小时horizon）：
```
[
  "confirmedPrice(1h)=3412.50",
  "ATR14(1h)=18.20，半径系数k=1.0",
  "初始区间=[3394.30, 3430.70]",
  "firstResistance zone近端=3448.00，未突破，本档不收紧上界",
  "firstSupport zone近端=3401.00，收紧下界至3401.00",
  "偏多权重62%（≥55），上界放宽至secondResistance近端=3465.00"
]
```

---

## 7. 情景目标生成算法

- **偏多情景目标区** `bullishZone = [firstResistance近端, secondResistance近端 或 (firstResistance近端 + atr14×2.5，当secondResistance不存在时)]`
- **偏空情景目标区** `bearishZone = [secondSupport近端 或 (firstSupport近端 - atr14×2.5)，firstSupport近端]`
- **震荡情景区间** `rangingZone = [priceRange.lower, priceRange.upper]`（即§6算出的区间本身，因为"维持震荡"定义就是价格停留在预计波动区间内）
- `disclaimer` 常量 `'情景推演，不是确定预测'` 必须原样输出在 `ScenarioTargets` 对象和UI文案中，不得省略、不得改写为其他措辞。
- `directionLabel='数据不足'` 时，`scenarioTargets=null`，不生成任何情景目标。

---

## 8. 最可能路径生成算法

固定枚举、优先级从上到下第一个命中即返回（与 `classifyState` 的优先级设计风格一致，避免歧义）：

| 优先级 | id | 命中条件 | 中文文案 |
|---|---|---|---|
| 1 | `INSUFFICIENT_DATA` | `directionLabel ∈ {'数据不足'}` 或 `isManual===true` | "数据不足，暂不生成路径推演" |
| 2 | `BREAKOUT_THEN_PULLBACK` | `directionLabel==='偏多'` 且 该周期 `isBreakout===true` 且 `breakoutBarsCount≤3` 且 `falseBreakoutTier!=='confirmation_failed'` | "突破关键压力后，可能出现回踩确认" |
| 3 | `BREAKDOWN_THEN_BOUNCE` | `directionLabel==='偏空'` 且 该周期 `isBreakdown===true` 且 `breakdownBarsCount≤3` 且 `falseBreakoutTier!=='confirmation_failed'` | "跌破关键支撑后，可能出现反抽确认" |
| 4 | `PULLBACK_THEN_UP` | `directionLabel==='偏多'` 且 因子7(`srDistance`)判定当前更靠近压力（`bear`分量≥0.5）且 `falseBreakoutTier!=='confirmation_failed'` | "可能先回踩，随后延续上涨" |
| 5 | `RALLY_THEN_FADE` | `directionLabel==='偏空'` 但因子5(`swingStructure`)显示近期仍有抬高的swing low（短期上冲力未消） | "可能先冲高测试压力，随后转跌" |
| 6 | `RANGE_ROUND_TRIP` | `directionLabel==='震荡'` | "价格可能在区间内往返运行" |
| 7 | `TREND_CONTINUATION`（兜底） | 以上都不命中，但 `directionLabel ∈ {'偏多','偏空'}` | "可能顺势延续原方向" |

`directionLabel==='不确定'` 且不满足条件1-6时，`mostLikelyPath=null`（不确定情况下不勉强给出路径，只展示权重和证据）。

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

### 10.2 数据异常/失效
`decision.dataHealth !== 'normal'` 且非手动模式：三个horizon直接判定为"数据不足"，**不得**保留、复用上一次 `prevForecast` 的任何字段（哪怕看起来"差不多"）。UI层渲染时必须以本次 `ForecastOutput` 为唯一真相源，不允许在渲染失败时静默回退显示旧预测。未收盘的实时价格此时仍可用于展示"当前价"和盘中距离，但不得参与任何预测判定。

### 10.3 预测有效期
```
m15.validUntil = 该15m周期下一根K线的收盘时间（等价于 C.getCountdown15m 的endTime概念，套用到15m周期本身）
h1.validUntil  = 下一根1h K线收盘时间
h4.validUntil  = 下一根4h K线收盘时间
```
UI在 `now > validUntil` 时必须显示"预测已过期，等待刷新"，不得继续展示已过期的 `directionLabel`/`weights`/`priceRange` 当作当前有效结论（呼应"不能保留旧预测冒充当前预测"）。

### 10.4 BTC或关键周期缺失
`ethTf`/`btcTf` 的 `fetchAllTimeframeKlines` 返回的 `failed` 列表中，若包含该horizon对应的ETH周期或对应的BTC周期，该horizon**强制**判定为"数据不足"（不进入§5.3计分，不做因子级missing处理，直接整体降级），`suppressedReason` 写明具体缺失的周期名。这是硬性要求（原文"BTC或关键周期缺失时必须降级为'不确定'或'数据不足'"），本规范选择更保守的"数据不足"而非"不确定"，因为关键周期缺失意味着无法计算，而不是"算出来了但不清晰"。

### 10.5 不绕过V1.1硬性否决规则
`decision.blocked===true`（即 `assessHardBlocks` 判定命中）时：
- 方向预测（`directionLabel`/`weights`/`priceRange`/`scenarioTargets`/`mostLikelyPath`）**仍然正常计算并展示**，因为这是对"未来走势"的规则推演，不等同于"现在能否入场"。
- 但 `ForecastOutput.blockedByV11=true`，UI 必须在预测面板最上方强制显示："当前不满足V1.1交易许可，预测仅供参考，不构成入场理由"。
- `executability.note` 必须包含 `decision.warnings` 中记录的具体否决原因。
- **不允许**任何V1.2文案暗示"方向权重高=可以下单"。

### 10.6 赔率不合格时的强制提示
无论 `directionLabel` 或 `weights` 数值多高，只要 `decision.worthBetting===false`，`executability.note` 必须包含固定字样"不值得下注"，且该提示必须与方向预测面板并排展示在同一视觉区域内，不得让用户只看到"偏多权重78%"而看不到"不值得下注"。

### 10.7 通用禁止事项
不自动下单（V1.2 不产出任何下单/挂单调用）；不读取密钥（V1.2 模块不访问任何 API Key/环境变量）；不做盈利承诺（所有文案禁止"稳赚""必然""保证"等词）。

---

## 11. 与 V1.1 的接口关系

### 11.1 模块边界

新建独立模块 `v1_2-forecast-core.js`，UMD封装风格与 `v1-core.js` 一致，导出为 `window.ETHAlphaForecast`（Node端 `module.exports`）。该模块内部通过 `require('../v1-core.js')`（或浏览器端读取 `window.ETHAlphaCore`）调用其**已导出**的纯函数：`emaSeries`、`calcATR`、`btcAlignment`、`calcPositionMetrics`、`calcVolumeQuality`、`falseBreakoutTier` 等。**不得复制这些函数的实现，不得修改 `v1-core.js` 的导出列表或任何函数体**。若确有必要用到 `v1-core.js` 未导出的私有辅助（如 `resolveLevels`），在 `v1_2-forecast-core.js` 内部另行实现一个命名不同、职责单一的等价小函数，并在代码注释中说明这是"独立小实现，非复用私有函数"，不允许要求修改 `v1-core.js` 的导出列表来间接绕过。

### 11.2 顶层函数签名

```ts
ETHAlphaForecast.buildForecast(
  ethTf: { tf15m: AnalyzedSnapshot; tf1h: AnalyzedSnapshot; tf4h: AnalyzedSnapshot },
  btcTf: { tf15m: AnalyzedSnapshot; tf1h: AnalyzedSnapshot; tf4h: AnalyzedSnapshot },
  decision: DecisionOutput,
  fetchMeta: { partial: boolean; failed: string[] },   // 复用 fetchAllTimeframeKlines 的返回，用于§10.4判定
  prevForecast: ForecastOutput | null
) => ForecastOutput
```
调用时机：HTML `refresh()` 中，在 `const d = C.buildDecision(...)` 之后追加：
```js
const f = F.buildForecast(ethTf, btcTf, d, cache, prevForecastRef);
document.dispatchEvent(new CustomEvent('v12forecast', { detail: f }));
prevForecastRef = f;
```
**不修改** `buildDecision` 本身的实现或返回值形状（保持101项V1.1测试的输入输出契约不变），**不修改**既有的 `render(d)` / `renderV11(d)` 函数，新渲染逻辑作为**第4个独立脚本块**，只监听新的 `v12forecast` 事件（与V1.1监听`v11decision`事件、不改V1核心render的既有扩展方式完全一致）。

### 11.3 可执行性评分的透传原则

`ForecastOutput.executability` **不重新计算**任何评分，只读取：
```
executability.worthBetting = decision.worthBetting
executability.tradability  = decision.opportunityScores ? decision.opportunityScores.tradability : null
```
理由：V1.1 的 `worthBetting` 是独立于 `score` 的红线判断（STRATEGY_SPEC §17.3 已有测试断言 `buildDecision` 源码不包含 `score.total` 字样），V1.2 若另造一个"可执行性评分"，必然与V1.1口径不一致，产生误导。V1.2 只做**展示层面的并排呈现**，不做二次判断。

---

## 12. 与 V2 历史校准的接口

V1.2 只需为以下字段预留结构和写入接口，**不实现**回放引擎、不实现Brier Score/方向准确率/覆盖率的计算逻辑，这些计算方法留给V2设计。

```ts
interface ForecastLogEntry {
  id: string;
  timestamp: number;
  horizon: '15m' | '1h' | '4h';
  // 1) 当时使用的已收盘K线：为避免日志体积爆炸，存引用（时间戳+周期即可反查Binance历史K线），不存整份K线数组
  closedKlineRef: { symbol: 'ETH' | 'BTC'; timeframe: string; lastClosedOpenTime: number }[];
  // 2) 三周期特征快照：只存各因子的结论值，不存原始K线
  tripleTimeframeFeatures: {
    htf4hTrend: string; mtf1hState: string; ltf15mState: string;
    btcAlignment4h: string; btcAlignment1h: string; btcAlignment15m: string;
  };
  // 3) 方向权重
  directionWeights: DirectionWeights;
  // 4) 预计区间
  priceRange: PriceRangeEstimate;
  // 5) 情景目标
  scenarioTargets: ScenarioTargets;
  // 6) 失效条件
  invalidation: InvalidationCondition[];
  mostLikelyPath: PathScenarioId;
  confidence: number;
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
写入函数（仿照 `v1-core.js` 中 `buildDecisionLogEntry`/`saveDecisionLog(entry, storage)` 的既有模式，`storage` 以参数注入而非硬编码 `window.localStorage`，便于Node测试传入mock storage）：`buildForecastLogEntry(forecast, horizon)` 生成条目，`saveForecastLog(entry, storage)` 写入独立的 `localStorage` key `ethAlphaForecastLogs`（对照V1.1实际使用的 `ethAlphaDecisionLogs`/`ethAlphaDecisionLogsV11`，命名风格保持一致但key本身必须不同，避免互相污染/超限清空互相挤占）。手动模式（`isManual===true`）**不写入**预测日志，与V1.1决策日志规则完全一致。

MFE（最大有利波动）/MAE（最大不利波动）、"是否先到目标还是先到失效位"的计算方法、Brier Score/方向准确率/区间覆盖率/校准曲线的具体统计公式，均属于V2范围，本文档不定义，只保证字段占位存在且命名到位，供V2直接读取而不需要改V1.2的日志schema。

---

## 13. UI 区域字段规范

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
