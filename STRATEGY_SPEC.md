# STRATEGY_SPEC.md — ETH Alpha 动态短线交易决策系统 · 策略与算法规范

版本：v2.1（第三轮修订。v1.0 的P0修复算法、ATR/EMA定义、Swing异常处理、假突破分级、状态机、盈亏比边界、人工参考位边界，以及v2.0新增的第12-19节算法定义**全部保留不变**，本版只调整"V1阶段要不要现在实现"的边界：CEO第二轮验收决定三周期架构（§12）与决策日志（§19.1）从"V2/V3以后再做"改为"V1必须做"，WebSocket（§14 WS部分）和条件提醒推送（§19.2）继续留在V3，详细边界见 CODEX_IMPLEMENTATION_TASK.md 第1节）
适用范围：ETH/USDT、BTC/USDT，**三周期联动**（4小时战略方向 / 1小时趋势结构 / 15分钟执行位置），BTC使用对应周期做联动确认。
**v1.0曾声明"适用范围：15分钟K线"、CODEX_IMPLEMENTATION_TASK.md v1.0曾声明"历史回测框架不在本阶段范围"——这两条表述已被董事长/CEO在第二轮明确推翻，v2.0起不再适用。** 第2-11节定义的算法（P0修复、ATR/EMA、Swing、假突破、15分钟状态机、盈亏比等）是**周期无关的通用规则**，对15分钟、1小时、4小时三个周期各自独立套用同一套公式，第12节起定义"如何把三个周期的结果组合成最终信号"。
本文档是 Codex 开发阶段的**唯一算法真相来源（source of truth）**。CODEX_IMPLEMENTATION_TASK.md 中的函数接口必须实现本文档定义的行为；ACCEPTANCE_TESTS.md 的测试用例必须验证本文档定义的规则。三者如有冲突，以本文档为准，发现冲突需先提出再决定谁改。V1/V2/V3 的分阶段交付范围见 CODEX_IMPLEMENTATION_TASK.md 第1节，本文档定义的是**完整目标规范**，不代表V1阶段必须一次性全部实现。

---

## 0. 记号约定

- 本系统同时维护 **6 个独立的K线序列**：{ETH, BTC} × {15分钟, 1小时, 4小时}。每个序列各自应用第2-11节的通用算法，产出各自独立的 `AnalyzedSnapshot`（第1.2节新增 `timeframe` 字段区分）。除非特别说明，第2-11节的公式对任意一个序列都成立，本节及之后用 `klines` 泛指其中任意一个序列。
- `klines`：长度为 `N`（目标 `N=100`）的K线数组，按时间升序排列，下标 `0..N-1`。**数组中的每一根K线都带 `isClosed` 标记（第1.1节），第 `N-1` 根（最新一根）既可能已收盘，也可能仍在滚动更新中，两种情况必须严格区分处理，规则见第13节。**
- **`price`（当前价，用于展示和盘中预警）**：取 `klines[N-1].close`，无论该K线是否已收盘。
- **`confirmedPrice`（确认价，用于正式状态判定）**：若 `klines[N-1].isClosed`，等于 `klines[N-1].close`；否则取 `klines[N-2].close`（最后一根已收盘K线的收盘价）。**第2-11节所有涉及状态机进入/退出判定、Swing确认、突破/跌破确认的地方，必须使用 `confirmedPrice`，不得使用可能未收盘的 `price`**（这是对 v1.0 "不区分是否已收盘"表述的直接修正，详细规则见第13节）。`price` 只能用于"当前价格"展示和第19节的盘中预警，不能用于确认类判断。
- 所有"最近M根K线"，除非特别标注"含当前K线"，默认**排除当前K线**，即取 `klines[N-1-M .. N-2]` 共M根。这是对 PROJECT_AUDIT.md §4.1 P0缺陷的直接修复，本节之后反复使用，务必按此约定实现。**排除当前K线这条规则本身就已经规避了"当前K线未收盘"的大部分风险**，因为冻结结构（`priorStructureHigh20` 等）天然只由已收盘K线构成；但 Swing 识别（第5节）和突破/跌破的最终确认（第13节）仍需要额外的显式收盘检查，不能只依赖"排除当前K线"这一条来兜底。

---

## 1. 数据结构

### 1.1 K线对象 `Kline`
```ts
interface Kline {
  openTime: number;   // ms epoch
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  takerBuyVolume: number; // 主动买入成交量，Binance klines字段[9]，第16节成交量质量需要
  closeTime: number;  // ms epoch
  isClosed: boolean;  // 第13节：REST数据用 Date.now()>=closeTime 判断；WebSocket用推送帧自带的 k.x 收盘标记，见第14.1节
}
```
`isClosed` 是本文档 v2.0 新增的核心字段，第2-11节所有算法在构造 `priorStructure*`、`swingHighs/Lows`、`confirmedPrice` 时都必须先用这个字段过滤，详见第13节。

### 1.2 单资产单周期分析快照 `AnalyzedSnapshot`（ETH/BTC × 15m/1h/4h，共6份，第0节）
```ts
interface AnalyzedSnapshot {
  symbol: 'ETH' | 'BTC';
  timeframe: '15m' | '1h' | '4h';   // v2.0新增，区分本快照属于哪个周期
  price: number;            // 展示用，可能来自未收盘K线
  confirmedPrice: number;   // 确认用，第0节，状态判定只能用这个
  ema5: number | null;
  ema10: number | null;
  ema20: number | null;
  atr14: number | null;
  atrPrev: number | null;        // 用于判断ATR环比是否收缩，取"5根K线之前"为基准重新算一次ATR14

  // 展示用统计（含当前K线，语义="最近M根K线的最高/最低点"，字面对应需求原文）
  recentHigh20: number;
  recentLow20: number;
  recentHigh50: number;
  recentLow50: number;

  // 触发用结构（不含当前K线，第0节约定的"冻结结构"，只有这组数字可以用来判断突破/跌破）
  priorStructureHigh20: number;
  priorStructureLow20: number;
  priorStructureHigh50: number;
  priorStructureLow50: number;

  // Swing结构（见第5节，含去重/过期/异常K线处理后的结果）
  swingHighs: SwingPoint[];      // 按时间升序，已做去重和异常剔除
  swingLows: SwingPoint[];
  firstResistance: LeveledPrice; // 当前价格上方最近摆动高点，找不到则回退，见第5.3节
  secondResistance: LeveledPrice;
  firstSupport: LeveledPrice;
  secondSupport: LeveledPrice;

  // 突破/跌破判定（第2.3节，唯一允许作为交易信号触发条件的字段）
  isBreakout: boolean;           // price > priorStructureHigh20
  isBreakdown: boolean;          // price < priorStructureLow20
  breakoutLevel: number | null;  // 突破时 = priorStructureHigh20，未突破为 null
  breakdownLevel: number | null; // 跌破时 = priorStructureLow20，未跌破为 null
  breakoutBarsCount: number;     // 连续处于"突破状态"的K线根数（用于假突破分级，第6节）
  breakdownBarsCount: number;

  volumeRatio: number | null;    // 当前K线成交量 / 最近20根(不含当前)平均成交量
  hasLongUpperWick: boolean;     // 当前K线是否长上影线（第6节定义）
  hasLongLowerWick: boolean;

  trend: 'up' | 'down' | 'flat'; // 第4节EMA排列判定
  risingLows: boolean | null;    // 最近两个Swing Low是否抬高，数据不足为null
  fallingHighs: boolean | null;

  dataQuality: DataQuality;      // 第9节
  isManual: boolean;
}

interface SwingPoint {
  index: number;
  price: number;
  time: number;         // openTime
  barsAgo: number;       // N-1-index，越大越"旧"
  clusterId: number;     // 聚集去重后的分组id，同组只取代表点，见5.4
}

interface LeveledPrice {
  price: number;
  source: 'swing' | 'priorStructure20' | 'priorStructure50' | 'atrExtrapolation';
  confidence: 'high' | 'medium' | 'low'; // 见5.3/5.5降级时标记为medium/low
}

interface DataQuality {
  klineCount: number;
  sufficientForEMA20: boolean;   // klineCount >= 25
  sufficientForATR14: boolean;   // klineCount >= 15
  sufficientForSwing: boolean;   // klineCount >= 5
  sufficientFor50: boolean;      // klineCount >= 51 (50根+当前)
  isStale: boolean;              // 见第9.2节
  lastCloseTime: number;
  anomalyBarsExcluded: number;   // 第9.3节剔除的异常K线数
}
```

### 1.3 手动输入 `ManualInput`
```ts
interface ManualInput {
  ethPrice: number;
  btcPrice: number;
  recentHigh: number;     // 用户目测的近期高点
  recentLow: number;      // 用户目测的近期低点
  high20: number;         // 用户目测的最近20根K线高点
  low20: number;          // 用户目测的最近20根K线低点
  atr?: number;           // 可选：用户直接给ATR，若省略按 (recentHigh-recentLow)/14 近似
  manualRefLevels?: number[]; // 可选：人工参考位，不参与计算，仅展示
}
```
校验规则（第9.4节强制）：`low20 <= high20`，`recentLow <= recentHigh`，`low20 >= recentLow*0.5`（防止量级输入错误，例如把BTC价格填进ETH框），任一不满足直接拒绝计算并指出具体字段。

### 1.4 决策输出 `DecisionOutput`
```ts
interface DecisionOutput {
  state: 'BULL_CONFIRMATION'|'BULL_PULLBACK'|'BEAR_CONTINUATION'|'TRANSITION_WATCH'|'RANGE_CHOP'|'STAND_ASIDE'; // 15分钟执行层状态，第8节
  stateReason: string;           // 命中该状态的具体条件说明（中文，用于UI"逻辑解释"区）
  falseBreakoutTier: 'none' | 'warning' | 'confirmation_failed'; // 第6节
  biasDirection: 'long' | 'long_caution' | 'short' | 'neutral';
  advice: string;                // 中文建议文案
  entryZone: string;
  addOnCondition: string;        // 第8.2节，必须存在，不可省略
  stopLoss: number | null;
  targets: [number|null, number|null, number|null];
  exitConditions: string[];      // 第8.2节，五类都要列出（v2.0新增BTC反向/假突破两类）
  riskReward: RiskReward;        // 第10节，含毛/净RR
  dragonflyText: string;         // 第7节
  worthBetting: boolean;         // 综合"信号权限矩阵"(第12节)判定后的"当前是否值得下注"，不再只看15分钟单周期
  btcAlignment: 'support' | 'conflict' | 'neutral'; // 15分钟周期的BTC联动，多周期联动见 signalPermission
  warnings: string[];            // 数据质量/假突破/边界情况提示汇总

  // ---- v2.0新增字段 ----
  signalPermission: SignalPermission;   // 第12节，三周期信号权限判定结果，可能否决/降级15分钟层的独立建议
  htf4h: AnalyzedSnapshot;              // 4小时快照（含HTF状态，第12节）
  mtf1h: AnalyzedSnapshot;              // 1小时快照
  supportZones: SRZone[];               // 第15节，区域化支撑（含第一/第二）
  resistanceZones: SRZone[];            // 第15节，区域化压力
  volumeQuality: VolumeQuality;         // 第16节
  score: ScoreBreakdown;                // 第17节，透明评分，不替代硬性规则
  dataHealth: 'normal' | 'delayed' | 'invalid'; // 第14.6节三级健康状态
  decisionLogId: string | null;         // 第19节，写入决策日志后的记录id，用于用户复盘时反查
}

interface SignalPermission {
  alignment: 'full_aligned' | 'partial_aligned' | 'counter_trend' | 'conflict';
  level: 'trend_entry_allowed' | 'counter_trend_only' | 'stand_aside' | 'blocked_by_data';
  addOnAllowed: boolean;
  positionSizeCapPct: number;  // 第12.4节，仓位上限建议（%），系统不追踪真实仓位，仅供UI展示参考
  reason: string;   // 中文说明，例如"4小时HTF_BULL_TREND，1小时BULL_CONFIRMATION，15分钟BULL_PULLBACK，BTC三周期均不弱：三周期同向"
}

interface RiskReward {
  // v2.0：value 字段拆分为 grossValue/netValue，完整定义与交易成本模型见第10.1a、10.4节，此处仅占位声明
  status: 'ok' | 'risk_zero_or_negative' | 'target_wrong_side' | 'price_past_target'
        | 'missing_level' | 'invalid_data' | 'both_sides_poor';
  grossValue: number | null;
  netValue: number | null;
  costAmount: number | null;
  flags: string[];
  message: string;
}
```

---

## 2. 动态支撑压力算法（修复版，对应 PROJECT_AUDIT.md §4.1）

### 2.1 展示统计（含当前K线）
```
recentHigh20 = max(k.high for k in klines[N-20 .. N-1])
recentLow20  = min(k.low  for k in klines[N-20 .. N-1])
recentHigh50 = max(k.high for k in klines[N-50 .. N-1])
recentLow50  = min(k.low  for k in klines[N-50 .. N-1])
```
用途：仅用于UI「最近20/50根K线最高/最低点」展示字段，**不得用于任何 if 判断触发交易信号**。

### 2.2 触发结构（冻结，不含当前K线）—— 唯一允许用于突破/跌破判定的量
```
priorStructureHigh20 = max(k.high for k in klines[N-21 .. N-2])
priorStructureLow20  = min(k.low  for k in klines[N-21 .. N-2])
priorStructureHigh50 = max(k.high for k in klines[N-51 .. N-2])
priorStructureLow50  = min(k.low  for k in klines[N-51 .. N-2])
```

### 2.3 突破/跌破判定（唯一合法触发条件，禁止使用"价格上方最近Swing"做触发）
```
isBreakout   = confirmedPrice > priorStructureHigh20   // v2.0：原 price 已改为 confirmedPrice，见第13节
isBreakdown  = confirmedPrice < priorStructureLow20    // v2.0：原 price 已改为 confirmedPrice，见第13节
breakoutLevel  = isBreakout  ? priorStructureHigh20 : null
breakdownLevel = isBreakdown ? priorStructureLow20  : null
```
**v2.0修正说明**：v1.0此处使用 `price`（可能来自未收盘K线），存在"K线内插针后又收回，被误判为已突破"的风险——例如当前15分钟K线还有10秒收盘，价格瞬间冲高刺穿压力位又跌回，若用 `price` 判断会短暂输出"已突破"的正式建议，但这根K线最终收盘时其实并未站稳。v2.0 改用 `confirmedPrice`（第0节定义：未收盘时取上一根已收盘K线的收盘价），使得正式的 `isBreakout`/`isBreakdown` **只在K线真正收盘之后才会翻转**，杜绝插针误判。未收盘期间的实时价格穿越只能触发第19节的"盘中预警"，不能直接改变 `isBreakout`/`isBreakdown` 和下游的 `state`。
**breakoutBarsCount / breakdownBarsCount** 的计算：向前遍历 `klines`，从 `N-1` 开始，只要 `klines[i].close > priorStructureHigh20`（该 `priorStructureHigh20` 用同一个冻结值，不随 i 变化）就计数+1，直到不满足为止；跌破同理。此计数用于第6节假突破分级和状态"保持/退出"判断。

### 2.4 动态第一/第二压力支撑（展示 + 未突破状态下的参考，允许用自过滤定义）
```
候选池 = swingHighs（第5节已去重/剔除异常）中 price > 当前price 的点，按price升序
firstResistance  = 候选池[0]，取不到则 fallback：
                    1) priorStructureHigh20（confidence=medium）
                    2) priorStructureHigh50（confidence=medium）
                    3) price + ATR*2（confidence=low，标记"外推位"）
secondResistance = 候选池[1]，取不到则 fallback 到 priorStructureHigh50 或以上外推规则
（firstSupport / secondSupport 对称，用 swingLows，price < 当前price，取最大的（最接近）者）
```
**重要边界**：`firstResistance`/`firstSupport` 只用于「未突破/未跌破」状态下的展示、以及 BULL_PULLBACK 等状态的进入判断（价格回踩支撑），**绝不能作为 isBreakout/isBreakdown 的判断依据**（这正是P0缺陷的根源，见 PROJECT_AUDIT.md §4.1）。

### 2.5 突破/跌破后的ATR目标位
```
若 isBreakout:
  targets = [breakoutLevel + ATR14*0.5, breakoutLevel + ATR14*1, breakoutLevel + ATR14*1.5]
若 isBreakdown:
  targets = [breakdownLevel - ATR14*0.5, breakdownLevel - ATR14*1, breakdownLevel - ATR14*1.5]
若都不成立（价格在结构区间内）:
  多头参考目标 = firstResistance（尚未突破时，第一目标就是"突破那一步"本身，不叠加ATR）
  空头参考目标 = firstSupport
```

---

## 3. ATR 与 EMA 算法

### 3.1 EMA
```
EMA_1 = close_1（用第一个收盘价做种子，非SMA种子，简化实现，需在代码注释中说明这不是所有平台的标准做法但对100根数据的收敛误差可忽略）
EMA_i = close_i * k + EMA_{i-1} * (1-k),  k = 2/(period+1)
```
周期分别为 5 / 10 / 20，输出最后一个值即为 `ema5`/`ema10`/`ema20`。

### 3.2 ATR（14周期，简单TR均值版，非Wilder平滑）
```
TR_i = max(high_i - low_i, |high_i - close_{i-1}|, |low_i - close_{i-1}|)   for i = 1..N-1
ATR14 = average(TR_{N-14} .. TR_{N-1})   （最近14个TR值的算术平均，含当前K线自己的TR）
```
**明确声明**：这是简化版ATR（算术平均），不是 Wilder(1978) 递归平滑版。两者在波动率骤变时数值会有差异（Wilder版更平滑、滞后更明显；本版对新增波动反应更快）。选择算术平均是为了实现简单、无需维护跨tick状态。**如果后续回测发现算术平均版噪音过大导致止损止盈频繁抖动，允许切换为 Wilder 平滑，但切换后必须重新跑一遍 ACCEPTANCE_TESTS.md 的ATR相关用例**，因为具体数值会变。

`atrPrev`：用同样公式在 `klines[0 .. N-6]`（即排除最近5根）上重新计算一次ATR14，用于第4节判断"ATR环比是否收缩"。

### 3.3 0.3×ATR 系数审查结论（对应需求§6"请审查0.3倍ATR是否合理"）

**结论：0.3×ATR 作为多单/空单失效位的缓冲系数，量级合理，可以作为v1.0固定默认值上线，但不应视为永久最优解，需要标注为"待回测优化参数"。** 理由：
1. 0.3×ATR 大约对应"约1/3个平均波动单位"的容错空间——既不会小到被正常噪音（单根K线内的正常抖动通常在0.2~0.5×ATR量级）反复扫损，也不会大到让止损离场景过远、破坏盈亏比。
2. 这个系数**与"当前处于什么市场状态"强相关**：震荡区间（RANGE_CHOP）中真实噪音幅度往往更大（因为区间内反复假突破），固定0.3可能偏紧；趋势延续（BULL_CONFIRMATION/BEAR_CONTINUATION）中价格移动更单向，0.3可能偏松、给出不必要的额外风险敞口。
3. **建议的演进路径（写入待办，不在v1.0强制实现）**：
   - v1.0：全状态统一使用固定 0.3×ATR，保证系统可预测、可测试。
   - v1.1候选：按状态分档——RANGE_CHOP用 0.4~0.5×ATR（放宽容错），BULL_CONFIRMATION/BEAR_CONTINUATION用 0.2~0.25×ATR（收紧，因为趋势中止损应该更靠近突破位），BULL_PULLBACK维持0.3×ATR。
   - v2候选：用第18节定义的历史行情实验室，对不同 ATR 系数（0.2/0.25/0.3/0.35/0.4/0.5）跑历史胜率与盈亏比统计后选定，而不是靠经验拍板——**这项工作现在有明确的归属（第18节回测实验室的V2阶段），不再是"未规划的独立任务"**（v2.0修正：v1.0此处曾写"回测框架本身不在本阶段范围内，需要新开一个独立任务"，当时"历史回测不做"整体已被撤销，此处同步更正）。
4. **V1阶段（Codex当前实现阶段）只需要实现固定 0.3×ATR 版本**，"按状态分档"和"用第18节回测实验室做ATR系数优化"都留到 V2 阶段（CODEX_IMPLEMENTATION_TASK.md 第1.3节），V1阶段不需要现在做，但不再是"明确禁止"的事项。

```
多单失效位 = firstSupport.price - ATR14 * 0.3   （未突破/回踩场景）或 breakdownLevel场景不适用
           若 isBreakout: 多单失效位 = breakoutLevel - ATR14 * 0.3   （突破后，失效位改用被突破的structure本身，而不是更早的firstSupport，理由见2.4的边界说明——避免复用一个过时的旧支撑导致止损距离过远）
空单失效位 = firstResistance.price + ATR14 * 0.3  （未跌破/反弹场景）
           若 isBreakdown: 空单失效位 = breakdownLevel + ATR14 * 0.3
```

---

## 4. BTC 联动判断

BTC 使用与 ETH **完全相同的第2、3节算法**独立生成一份 `AnalyzedSnapshot`（不含人工参考位、不需要盈亏比/建议文案）。

```
btc.trend = 'up'   if btc.price > btc.ema20 && btc.ema5 > btc.ema10 > btc.ema20
          = 'down' if btc.price < btc.ema20 && btc.ema5 < btc.ema10 < btc.ema20
          = 'flat' 否则
```

联动标签（供状态机与建议文案使用）：
```
btcAlignment(ethBias):
  if ethBias in ('long','long_caution'):
    'support'   if btc.trend != 'down'
    'conflict'  if btc.trend == 'down'
  if ethBias == 'short':
    'support'   if btc.trend == 'down'
    'conflict'  if btc.trend != 'down'
  if ethBias == 'neutral':
    'neutral'
```
`btc.isBreakout` / `btc.isBreakdown` 复用第2.3节同一套算法，供第6节假突破判定第4项"BTC是否同步突破"使用。

---

## 5. Swing High / Swing Low 识别

### 5.1 基本规则（需求原文）
```
klines[i] 是 Swing High  当且仅当  klines[i].high > klines[i-1].high
                              && klines[i].high > klines[i-2].high
                              && klines[i].high > klines[i+1].high
                              && klines[i].high > klines[i+2].high
（Swing Low 对称，用 low 且方向相反）
遍历范围：i = 2 .. N-3（需要前后各2根，天然要求确认存在2根K线的滞后，这是被接受的固定延迟，不是bug）
```
**v2.0补充（对应第13节"Swing确认只能使用已收盘数据"）**：若 `klines[N-1].isClosed==false`（当前最新K线尚未收盘），遍历上界必须改为 `N-4`（即整体先丢弃未收盘的那一根，等效于在 `klines[0..N-2]` 这个"全部已收盘"的子数组上按原公式跑），不能把未收盘的K线的 high/low 当作判断"是否是Swing"的比较基准，也不能让未收盘K线本身成为候选Swing点。

### 5.2 六种异常情况处理（对应 PROJECT_AUDIT.md §4.5，逐一给出规则）

| # | 异常情况 | 处理规则 |
|---|---|---|
| 1 | 当前价格上方没有 Swing High | `firstResistance` 按第2.4节 fallback 链：`priorStructureHigh20` → `priorStructureHigh50` → ATR外推位（`confidence='low'`），UI必须显示所用的是哪一档，不能悄悄外推却显示成"高置信度"的样子 |
| 2 | 当前价格下方没有 Swing Low | 同上，方向对称 |
| 3 | Swing点距离当前价格过近（`abs(swing.price - price) < 0.3*ATR14`） | 不剔除该点，但标记 `confidence='low'` 并在状态机中触发"防抖"：不允许仅因为价格穿过这个过近的点就在相邻两次刷新之间反复切换 BULL_CONFIRMATION ↔ TRANSITION_WATCH（见第8.4节防抖规则），触发判断改用 `priorStructureHigh20/Low20`（不受此干扰，因为它是固定窗口不是单点） |
| 4 | Swing点已过期（`barsAgo > 60`，即约15小时前） | 该点仍保留在 `swingHighs/swingLows` 数组中供"历史参考"展示，但**不参与 `firstResistance/firstSupport` 的默认候选优先级**——候选池优先取 `barsAgo <= 60` 的点，只有当60根以内完全没有可用Swing点时才放宽到全部历史 |
| 5 | 多个Swing点聚集（同方向两点价差 `< 0.3*ATR14`） | 视为同一压力/支撑"区域"，聚为一个 `clusterId`，代表点取该簇中最新（`barsAgo`最小）的一个；`secondResistance/secondSupport` 不得与 `firstResistance/firstSupport` 出自同一簇，必须是下一个不同簇的点，避免"第一压力1808、第二压力1809"这种伪双点位 |
| 6 | 价格出现跳跃/异常K线（单根K线振幅 `(high-low) > 5*ATR14`，或与前一根收盘价缺口 `abs(open - prevClose) > 3*ATR14`） | 该K线**不参与Swing候选**（其high/low不能被认定为Swing点），但仍保留在 `klines` 数组中参与EMA/ATR等连续型统计；同时计入 `dataQuality.anomalyBarsExcluded`，UI提示"检测到异常波动K线，已自动剔除、建议人工复核"，见第9.3节 |

### 5.3 Fallback 优先级总表（供 Codex 直接实现）
```
resolveResistance(candidates_above_price_sorted_asc, priorHigh20, priorHigh50, price, ATR):
  if candidates_above_price_sorted_asc 非空:
     取第一个，confidence='high'（若 barsAgo>60 则 confidence='medium'）
  elif priorHigh20 > price:
     用 priorHigh20，confidence='medium'
  elif priorHigh50 > price:
     用 priorHigh50，confidence='medium'
  else:
     用 price + ATR*2，confidence='low'（外推，需在UI明确标注"无历史压力参考，已用ATR外推，可信度低"）
```
支撑方向对称。

---

## 6. 假突破规则（两级：风险提示 / 确认失败）

### 6.1 六项判据
```
d1 突破幅度 = (price - priorStructureHigh20) / ATR14           （跌破方向符号相反）
d2 放量     = volumeRatio >= 1.2
d3 回落判定 = 在 breakoutBarsCount 对应的最近K线中，是否存在收盘价 < priorStructureHigh20（即冲高后又收回区间）
d4 BTC同步  = btc.isBreakout == true （空头看 btc.isBreakdown）
d5 持续根数 = breakoutBarsCount
d6 长影线   = hasLongUpperWick，定义：(high - close) / (high - low) > 0.5 且 (high - low) > 0.5*ATR14
             （长下影线对称：(close - low)/(high-low) > 0.5 且 振幅>0.5*ATR14）
```

### 6.2 分级规则
```
若 isBreakout:
  confirmation_failed（确认失败，禁止追多）当且仅当满足以下任一：
    - d3 为真（已经收回区间）
    - d4 为假 且 breakoutBarsCount <= 1（刚突破且BTC完全不同步）
    - d6 为真（长上影线，冲高回落形态）

  warning（风险提示，允许小仓谨慎跟随，非禁止）当且仅当不满足 confirmation_failed 但满足以下任一：
    - d1 < 0.15（突破幅度太小，噪音概率高）
    - d2 为假（未放量）
    - breakoutBarsCount == 1（刚发生，样本太少）

  none（确认通过）：不满足以上任何一条，即 d2真 且 d4真 且 breakoutBarsCount>=2 且无长上影线 且未回收区间
（跌破方向的三级规则对称，用 d4=btc.isBreakdown, d6=长下影线）
```
### 6.3 输出文案模板（占位符均取当前动态数值，不允许写死）
```
confirmation_failed: "跌破未得到BTC和成交量确认，不建议追空。" / "假突破风险，不建议重仓追多。"
                      需附具体原因，例如："价格已收回至 {priorStructureHigh20} 下方，视为假突破。"
warning:              "已突破 {breakoutLevel}，但{未放量/BTC未同步/刚突破样本不足}，建议减小仓位或等待再观察1-2根K线确认。"
none:                 正常进入 BULL_CONFIRMATION/BEAR_CONTINUATION 建议文案（第8节）。
```

---

## 7. 蜻蜓捕猎模型（形式化为可计算规则）

对应关系严格映射为程序变量：

| 蜻蜓模型概念 | 程序变量 |
|---|---|
| 猎物当前位置 | `price` |
| 上方潜在拦截位置 | `firstResistance.price`（未突破）或 `breakoutLevel`（已突破，作为已发生的拦截参考） |
| 下方潜在承接位置 | `firstSupport.price` / `breakdownLevel` |
| 移动速度 | `ATR14` |
| 加速度 | `volumeRatio`（相对20均量的倍数，>1加速，<1减速） |
| 风向 | `btc.trend` / `btcAlignment` |

### 7.1 最佳拦截区计算函数
```
function bestInterceptionZone(state, falseBreakoutTier, biasDirection, eth):
  if falseBreakoutTier in ('warning','confirmation_failed'):
     return {
       zone: '观望 / 等待回踩确认',
       text: f"当前疑似假突破（{触发原因}），不建议追{方向}，
              最佳拦截区仍在动态{支撑/压力} {对应价格} 附近，等待价格回到该区域再评估。"
     }
  if state == 'BULL_CONFIRMATION':
     return { zone:'回踩确认区', text: f"当前已突破动态压力 {breakoutLevel}，等待回踩不破后再介入，不在突破瞬间追价。" }
  if state == 'BULL_PULLBACK':
     return { zone:'动态支撑附近', text: f"当前不适合追多，最佳多头拦截区在动态支撑 {firstSupport} 附近，价格已进入该区域。" }
  if state == 'BEAR_CONTINUATION':
     return { zone:'反弹至动态压力', text: f"价格已跌破动态支撑，风向（BTC）同步转弱，最佳拦截区变为反弹至动态压力 {firstResistance} 附近。" }
  if state == 'RANGE_CHOP' or (price 在 firstSupport 与 firstResistance 中间且无明显偏向):
     return { zone:'区间中部，不介入', text: f"当前价格在动态支撑 {firstSupport} 与压力 {firstResistance} 中间，距两端都不够近，赔率不足，建议观望。" }
  # STAND_ASIDE / TRANSITION_WATCH 兜底
  return { zone:'观望', text: "ETH与BTC信号不一致或数据不足以判断最佳拦截区，建议观望。" }
```
此函数**不引入任何 §2-§6 之外的新判断逻辑**，只是把已经算好的状态量翻译成"拦截区"语言，避免"两套并行的判断标准"互相打架。

---

## 8. 状态机、试仓、加仓、离场

### 8.1 六状态定义（进入 / 保持 / 退出 / 优先级）

| 优先级 | 状态 | 进入条件 | 保持条件 | 退出条件 |
|---|---|---|---|---|
| 1（最高） | **TRANSITION_WATCH** | `falseBreakoutTier != 'none'`（第6节）；或 Swing数据质量为 `low` 且价格贴近关键位（第5.2第3项） | 触发原因未解除 | 触发原因解除，转入对应确认状态或回落到 RANGE_CHOP/STAND_ASIDE |
| 2 | **BULL_CONFIRMATION** | `isBreakout && falseBreakoutTier=='none' && btc.trend!='down'` | `price >= breakoutLevel - 0.3*ATR14 && btc.trend != 'down'` | `price < breakoutLevel - 0.3*ATR14`（跌破止损区） 或 `btc.trend=='down'` |
| 3 | **BEAR_CONTINUATION** | `isBreakdown && falseBreakoutTier=='none' && btc.trend=='down'` | `price <= breakdownLevel + 0.3*ATR14 && btc.trend=='down'` | `price > breakdownLevel + 0.3*ATR14` 或 `btc.trend!='down'` |
| 4 | **BULL_PULLBACK** | `!isBreakout && !isBreakdown && abs(price-firstSupport.price)<=0.3*ATR14 && price>=firstSupport.price-0.3*ATR14 && btc.trend!='down'` | 同进入条件持续 | 价格跌破 `firstSupport.price-0.3*ATR14`（转STAND_ASIDE/观察空头） 或 突破 `priorStructureHigh20`（转BULL_CONFIRMATION路径重新判定） |
| 5 | **RANGE_CHOP** | `!isBreakout && !isBreakdown && price∈[priorStructureLow20,priorStructureHigh20] && (max(ema5,ema10,ema20)-min(...))<0.5*ATR14 && atr14<=atrPrev && btc.trend=='flat'` | 同进入条件持续 | 任一子条件失效 |
| 6（兜底） | **STAND_ASIDE** | 以上都不满足 | 同上 | 直到满足其他任一状态进入条件 |

**判定顺序（伪代码，严格按优先级从高到低短路求值，避免二义性）**：
```python
def classify_state(eth, btc):
    tier = false_breakout_tier(eth, btc)          # 第6节
    if tier != 'none':
        return 'TRANSITION_WATCH', tier

    if eth.isBreakout and tier == 'none' and btc.trend != 'down':
        return 'BULL_CONFIRMATION', 'none'

    if eth.isBreakdown and tier == 'none' and btc.trend == 'down':
        return 'BEAR_CONTINUATION', 'none'

    if (not eth.isBreakout and not eth.isBreakdown
        and abs(eth.price - eth.firstSupport.price) <= 0.3 * eth.atr14
        and eth.price >= eth.firstSupport.price - 0.3 * eth.atr14
        and btc.trend != 'down'):
        return 'BULL_PULLBACK', 'none'

    ema_spread = max(eth.ema5, eth.ema10, eth.ema20) - min(eth.ema5, eth.ema10, eth.ema20)
    in_range = eth.priorStructureLow20 <= eth.price <= eth.priorStructureHigh20
    if (not eth.isBreakout and not eth.isBreakdown and in_range
        and ema_spread < 0.5 * eth.atr14
        and eth.atr14 <= eth.atrPrev
        and btc.trend == 'flat'):
        return 'RANGE_CHOP', 'none'

    return 'STAND_ASIDE', 'none'
```

### 8.2 试仓 / 加仓 / 离场（对应需求§13风险理念，必须严格区分）

```
试仓 TrialEntry：
  触发 = state in ('BULL_CONFIRMATION','BULL_PULLBACK','BEAR_CONTINUATION') 且 falseBreakoutTier != 'confirmation_failed'
  仓位 = "小仓"（建议占预设总仓位 10%~20%，具体数字由用户风险偏好决定，系统只给比例建议不给绝对金额）
  止损 = 第3.3节动态失效位

加仓 AddOn（专业加仓，唯一合法定义）：
  前提 = 已持有同方向仓位（由用户在UI手动确认"已持有"状态，系统不追踪真实持仓）
  触发 = 持仓方向为多：price 创出新的、高于建仓时 firstResistance 的 Swing High
         且 当前浮盈 >= 1 * ATR14（用"建仓价 - 当前失效位"衡量的初始风险单位对比浮盈，验证"方向已被验证"）
         且 未处于 falseBreakoutTier != 'none' 状态
         且 满足下方【风险预算上限】约束
  （持仓方向为空对称，用 Swing Low 创新低 + BTC同步）
  仓位 = 不超过初始试仓仓位，系统输出文案必须显式声明"加仓仓位不应超过首次试仓仓位"

  风险预算上限（v2.0新增，对应需求§九"加仓后总风险不能超过预设风险预算"）：
    riskBudget = 用户在UI设置的"单笔最大风险占总资金百分比"（默认建议值2%，可调，系统不强制但必须要求用户显式设置一次才能看到加仓建议）
    totalRiskAfterAddOn = 试仓风险(建仓价-试仓止损) + 加仓风险(加仓价-加仓后止损)，两笔按各自仓位加权
    约束 = totalRiskAfterAddOn <= riskBudget，超过则系统拒绝输出"允许加仓"，改为输出："当前加仓将使总风险超过预设上限 {riskBudget}%，建议维持现有仓位或先减少试仓仓位再加仓"
    系统不追踪真实资金，riskBudget 与仓位金额均由用户在UI输入，系统只做比例上的约束判断，不代替用户执行任何资金操作

移动止损 Trailing Stop（v2.0新增，对应需求§九"移动止损保护利润"）：
  触发前提 = 已进入 BULL_CONFIRMATION/BEAR_CONTINUATION 且价格已运行超过 targets[0]（第一目标已达到但用户选择继续持有部分仓位，而不是第8.2节默认的"目标1减仓1/3"）
  多头移动止损 = max(当前stopLoss, 最近一个已确认 Swing Low - 0.3*ATR14)，即止损只能向有利方向（向上）移动，不能倒退变得更宽松
  空头移动止损 = min(当前stopLoss, 最近一个已确认 Swing High + 0.3*ATR14)，同理只能向下移动
  系统行为 = 每个tick重新计算一次候选移动止损位，只有比当前止损更优（多头更高/空头更低）时才更新 DecisionOutput.stopLoss 并在 warnings 中提示"止损已上移至 {new} 保护利润"，否则维持原止损不倒退

摊平（不允许，系统不得生成此类建议）：
  定义 = 价格向不利方向移动、当前处于浮亏、且未出现上述"加仓"触发条件时，仍建议增加同方向仓位以降低平均成本
  系统行为 = 任何时候价格触及止损位，输出只能是"离场"文案，不能输出"补仓摊平"文案；
             即使用户在人工参考位里标了一个更低的"支撑"，系统也不得因为这个人工位而推翻已经触发的动态止损（对应需求§十"人工参考位不能覆盖动态算法"）

离场 Exit（五类，必须在 DecisionOutput.exitConditions 中全部列出，即使当前不适用也要注明"暂不适用"，其中4、5为v2.0新增）：
  1. 止损离场：price 触及 stopLoss（第3.3节，含移动止损后的新值）
  2. 止盈离场：price 触及 targets[0]/[1]/[2]，建议分批（目标1減仓1/3、目标2再减1/3、目标3清仓剩余），仅为建议非强制
  3. 结构破坏离场：state 从 BULL_* 系变为 BEAR_*/STAND_ASIDE（或反向），无论当前盈亏，都建议重新评估是否离场或减仓
  4. BTC反向离场（v2.0新增）：持仓期间 btcAlignment 由 support/neutral 转为 conflict，即使ETH自身状态尚未破坏，也应输出"BTC方向已转向，建议降低仓位或收紧止损"
  5. 假突破离场（v2.0新增）：持仓期间 falseBreakoutTier 由 none 转为 confirmation_failed（例如突破后价格又收回区间），应输出"原突破已被判定为假突破，建议立即离场而非等待止损"，这一条独立于止损位是否已被触及，是更早的预警性离场信号
```

### 8.3 防抖规则（第5.2第3项引用，避免状态在相邻两次刷新间反复横跳）
```
若上一次 tick 的 state 与本次计算的 state 不同，且触发差异的唯一原因是价格在某个 confidence='low' 的 Swing 点附近来回穿越（第5.2第3项场景）：
  保持上一次的 state 不变，直到价格相对该点的偏离超过 0.5*ATR14（比第5.2第3项的0.3*ATR14判定阈值更宽，形成滞回区间 hysteresis band）
```

### 8.4 测试用例映射
每个状态至少需要 1 个"进入"用例 + 1 个"不应误触发"的反例，具体合成K线构造方式在 ACCEPTANCE_TESTS.md 第2~7节给出，此处不重复。

---

## 9. 数据异常与安全降级

### 9.1 K线数量不足
```
if klineCount < 15:  ATR14 不可算 → 显示"数据不足"，状态机整体降级为特殊态 STAND_ASIDE，advice="数据不足15根K线，暂不给出交易建议"
if klineCount < 25:  EMA20不可靠（EMA20在<20根输入时数值会大幅失真）→ trend固定为'flat'（不判定方向），并在UI标注"EMA20样本不足，趋势判断已禁用"
if klineCount < 5:   Swing识别不可用 → firstResistance/firstSupport 全部走 fallback链（第5.3节）
if klineCount < 51:  recentHigh50/Low50、priorStructureHigh50/Low50 不可算 → 显示"数据不足（需51根含当前）"，中期压力支撑字段置空，不得用0或用20周期的值偷梁换柱填充
```
以上任何一条触发时，**系统必须在 UI 明确展示"因数据不足降级"的具体原因，不能安静地退化成一个数值上凑合能跑但语义已经不对的结果**。

### 9.2 数据陈旧
```
staleThreshold = 2 * 15分钟 = 30分钟
isStale = (Date.now() - klines[N-1].closeTime) > staleThreshold
```
若 `isStale=true`：页面持续显示已有的最后一次成功计算结果，但在最醒目位置（状态卡片正上方）加一条**不可关闭**的横幅："⚠ 数据已 X 分钟未更新，以下判断可能不反映最新行情"，且状态机的 `advice` 文案必须以"（基于陈旧数据）"为前缀。这是对需求§3"不能继续输出伪装成实时数据的交易建议"的直接落实。

### 9.3 单根K线数值异常
```
异常判定（任一成立即视为异常K线）：
  high < low
  high < max(open, close) 或 low > min(open, close)
  open <= 0 或 high <= 0 或 low <= 0 或 close <= 0
  (high - low) > 5 * ATR14（用剔除该异常K线前的ATR14基准判断，防止异常值污染自己的判断基准）
  abs(open - prevClose) > 3 * ATR14
处理：
  该K线不参与 Swing 候选（5.2第6项）与 EMA/ATR 连续统计的"高低点极值"角色，但其 close 仍计入 EMA 序列的连续性（避免整条EMA序列因为跳过一根而错位）——具体做法：EMA计算正常走完整序列（EMA对单点异常本身有一定平滑抵抗力），但 recentHigh/Low、priorStructureHigh/Low、Swing识别 三处必须显式跳过该异常K线的high/low参与极值运算。
  dataQuality.anomalyBarsExcluded += 1
  若单次拉取的100根K线中异常K线数 > 5：整体判定"数据源异常，不建议继续使用当前数据"，触发引导用户改用手动输入或稍后重试。
```

### 9.4 手动模式数值校验
第1.3节 `ManualInput` 校验规则复述：`low20<=high20`、`recentLow<=recentHigh`、`low20`与`recentLow`量级一致（防止误填BTC价格到ETH框，检测方式：`abs(low20-recentLow) < recentHigh*0.5` 等宽松量级校验，不追求精确，只防低级输入失误）。任一校验失败：拒绝计算，明确指出出错字段，不得用默认值静默替代用户的错误输入继续算下去。

### 9.5 手动模式下的能力降级声明（对应 PROJECT_AUDIT.md 已确认的能力边界）
手动模式下不可用：EMA排列判断（trend固定'flat'）、Swing识别（firstResistance/firstSupport 直接取 high20/low20 或 recentHigh/recentLow）、真实ATR（用 `(recentHigh-recentLow)/14` 近似，`confidence='low'`）、成交量判据（`volumeRatio=null`，假突破判定第6节 d2/d5 项永远视为"数据不可用"、降级为只能判定 `warning` 级别，不能判定 `confirmation_failed`，因为后者需要放量/BTC/影线等实时序列数据）、BTC联动（若未同时提供BTC的K线，`btc.trend='unknown'`，`btcAlignment='neutral'`，不构成 support 也不构成 conflict，所有依赖BTC同步的确认条件一律视为不满足，即手动模式下 BULL_CONFIRMATION/BEAR_CONTINUATION 两个需要BTC强确认的状态实际上很难进入，大概率停留在 TRANSITION_WATCH 或 STAND_ASIDE——这是刻意的保守设计，不是bug）。

---

## 10. 盈亏比（含8类边界情况 + v2.0净盈亏比）

### 10.1 基础公式（毛盈亏比）
```
多单：毛潜在收益 = targets[0] - price；潜在风险 = price - stopLoss；毛RR = 毛潜在收益/潜在风险
空单：毛潜在收益 = price - targets[0]；潜在风险 = stopLoss - price；毛RR = 毛潜在收益/潜在风险
```

### 10.1a 交易成本模型与净盈亏比（v2.0新增，对应需求§五）
```ts
interface TradingCost {
  makerFeeRate: number;   // 单边挂单手续费率，默认 0.0002（0.02%，用户可在UI调整）
  takerFeeRate: number;   // 单边吃单手续费率，默认 0.0005（0.05%）
  feeMode: 'maker' | 'taker'; // 默认 'taker'（保守估计，短线多为吃单成交）
  spreadEstimate: number; // 预计买卖价差，占价格百分比，默认 0.02%（ETH/USDT主流对流动性较好，可调）
  slippageEstimate: number; // 预计滑点，占价格百分比，默认 0.03%（15分钟短线快速行情下的经验缓冲）
  fundingRate?: number;   // 预留字段：资金费率（仅合约场景使用，当前不接账户、不计入net计算，见10.1b）
}
```
```
单边综合成本率 = (feeMode=='taker' ? takerFeeRate : makerFeeRate) + spreadEstimate/2 + slippageEstimate
开仓+平仓共两次穿越价差和两次手续费，故：
总成本率 = 2 * 单边综合成本率
总成本金额 = price * 总成本率

多单：净潜在收益 = 毛潜在收益 - 总成本金额；净RR = 净潜在收益 / 潜在风险
空单：净潜在收益 = 毛潜在收益 - 总成本金额；净RR = 净潜在收益 / 潜在风险
```
`DecisionOutput.riskReward` 必须同时输出 `grossValue`（毛RR）与 `netValue`（净RR）两个数字，UI必须并排展示，不能只展示一个（用户可能在心里默认自己看到的是"到手"的赔率，如果只展示毛RR会系统性高估真实赔率）。第10.2节的三档提示文案**统一改用净RR判断**，毛RR仅作参考展示，不作为提示阈值依据——这是刻意选择：宁可提示偏保守，也不能让用户以为"盈亏比>2"就等于到手赔率>2，实际上刨去成本后可能已经跌破1.5。

### 10.1b 资金费率预留字段（v2.0新增，对应需求§五"如果未来分析合约，可预留资金费率字段，但当前不接账户"）
`TradingCost.fundingRate` 字段已在接口中预留，**当前版本（现货短线）恒为 `undefined`，不参与任何计算**。这是一个纯粹的前向兼容占位符：如果未来产品扩展到合约分析，`fundingRate` 才会被用于计算"持仓期间预计资金费成本"并纳入净RR，但那需要接入合约行情和用户持仓周期假设，属于全新功能，不在本文档任何一个阶段（V1/V2/V3）的范围内。Codex 在当前阶段**只需要把这个字段声明出来并保持未使用**，不得实现任何资金费率相关的计算逻辑，也不得因为这个字段的存在而误以为需要接入合约账户。

### 10.2 三档提示（需求原文，逐字保留判断阈值；v2.0起阈值判断对象改为净RR，见10.1a）
```
netRR < 1.5:  "赔率一般，不建议重仓"
netRR > 2:    "赔率较好，可以考虑小仓试错"
netRR > 3:    "赔率优秀，但仍然需要BTC和成交量支持"
1.5<=netRR<=2: 补充档："赔率中等，可小仓参与，注意风控"（原文未定义此区间，为避免空隙留白，v1.0新增）
```
文案模板需同时报出两个数字，例如："净盈亏比 1.8（毛盈亏比 2.1，已扣除预计手续费/价差/滑点），赔率中等，可小仓参与，注意风控。" 不能只报一个数字让用户误以为看到的就是最终数字。

### 10.3 八类边界情况（RiskReward.status 枚举值对应）
| # | 情况 | status | 处理 |
|---|---|---|---|
| 1 | 风险=0（`price == stopLoss`） | `risk_zero_or_negative` | RR不可算，`message="止损位与当前价格重合，风险度量失效，建议重新确认止损设置"` |
| 2 | 风险<0（`price < stopLoss` 对多单，即价格已经在止损位下方） | `risk_zero_or_negative` | `message="当前价格已经处于止损位之下，止损已失效，不应再讨论开仓，应直接离场"` |
| 3 | 目标位方向错误（多单 `targets[0] <= price`，理论上不该发生，属于上游算法bug，但仍需兜底） | `target_wrong_side` | `message="目标位计算方向异常（目标不在盈利方向），已阻止输出盈亏比，请检查上游支撑压力计算"`，同时该状态需要被记录进日志供排查（不是用户输入错误，是代码缺陷信号） |
| 4 | 当前价格已经超过目标（多单 `price >= targets[0]`） | `price_past_target` | `message="当前价格已达到或超过第一目标位，继续持有的边际盈亏比下降，建议考虑部分止盈而不是用旧目标位继续计算盈亏比"` |
| 5 | 支撑压力缺失（`firstResistance`/`firstSupport` 均走到 `confidence='low'` 的外推档） | `missing_level` | `message="当前支撑压力位均为低置信度外推值，盈亏比仅供参考，不建议作为下注依据"`，RR仍计算但UI用醒目样式标注低置信度 |
| 6 | 数据无效（`price`/`stopLoss`/`targets[0]` 任一为 `null`/`NaN`） | `invalid_data` | `message="数据不完整，无法计算盈亏比"`，不输出任何数字 |
| 7 | 多空两边盈亏比都很差（多单RR<1.5 且 空单RR<1.5，两个方向都算出来看看） | 附加标记 `bothSidesPoor=true` | `message` 追加："当前无论多空方向，赔率都不理想，建议观望，不是"选一个方向凑合做"的时机" |
| 8 | 盈亏比很好但BTC方向冲突（RR>2 且 `btcAlignment=='conflict'`） | 附加标记 `btcConflictDespiteGoodRR=true` | `message` 追加："盈亏比数字上达标，但BTC方向与ETH建议方向冲突，赔率的可信度打折，建议降级为小仓试错而非按'赔率较好'正常仓位对待" |

**实现要求**：#7、#8 不是独立的 `status` 值，而是叠加在 `ok` 状态之上的布尔标记 + 文案追加，因为它们描述的是"RR算出来了，但有额外的可信度问题"，与#1-6"RR根本算不出来"是两类不同性质的问题，接口设计上必须分开（`RiskReward` 增加 `flags: string[]` 字段承载#7/#8，见第1.4节需相应补充，Codex实现时按此扩展）。

**v2.0补充**：上表中所有涉及具体数字判断的地方（#7的`<1.5`、#8的`>2`），第二轮起统一改用**净RR**判断，`price_past_target`/`risk_zero_or_negative` 等纯几何关系判断（价格与止损/目标的相对位置）与成本无关，不受此影响。`RiskReward` 接口相应扩展为同时携带毛/净两套数值，见第1.4节与第10.1a节。

### 10.4 `RiskReward` 接口 v2.0 扩展（对应第1.4节，Codex实现时以此为准）
```ts
interface RiskReward {
  status: 'ok' | 'risk_zero_or_negative' | 'target_wrong_side' | 'price_past_target'
        | 'missing_level' | 'invalid_data' | 'both_sides_poor';
  grossValue: number | null;   // 毛RR，v1.0的value字段改名
  netValue: number | null;     // 净RR（扣除交易成本），第10.1a节，三档提示以此为准
  costAmount: number | null;   // 第10.1a节 总成本金额，供UI展示"扣了多少"
  flags: string[];             // 'bothSidesPoor' | 'btcConflictDespiteGoodRR'，第10.3节#7/#8
  message: string;
}
```

---

## 11. 与人工参考位的边界（需求§十，强制约束）

1. 人工参考位（用户在页面手动输入的历史点位，例如旧系统的1770/1800/1834）**只能作为独立展示行**出现在"支撑压力一览"表格中，标注来源为"人工参考"。
2. 本文档定义的任何算法（第2-10节）**都不得读取人工参考位的值作为输入**。这是硬约束：Codex 实现时，计算 `AnalyzedSnapshot`/`DecisionOutput` 的函数签名中不应该出现 `manualRefLevels` 参数，从类型层面杜绝误用。
3. 即使人工参考位恰好等于某个动态计算出的支撑压力（数字巧合），系统也不能"因为人工位确认了动态位"而提高置信度或改变建议——两套体系必须完全解耦，人工位仅供使用者肉眼对照历史习惯的点位。

---

# 第二部分：三周期架构与实时化（v2.0新增，第12-20节）

第2-11节定义的所有算法（P0修复的冻结结构、ATR/EMA、Swing识别、假突破分级、15分钟六态状态机、盈亏比、蜻蜓模型）**周期无关**，本部分不重新定义这些算法，只定义"如何在4小时/1小时/15分钟三个周期上分别套用它们，以及如何把三份结果组合成最终信号"。

## 12. 三周期架构与信号权限矩阵

### 12.1 三个周期的角色
```
4小时（HTF, Higher Time Frame）：战略方向。回答"大方向是不是值得顺着做"。
1小时（MTF, Middle Time Frame）：趋势结构。回答"当前这个大方向下，中期结构是否健康"。
15分钟（LTF, Lower Time Frame）：执行位置。回答"现在这一刻，值不值得动手"，即第2-11节已定义的全部内容。
BTC：在每一个周期上都独立跑一遍同样的分析，作为该周期的"风向"确认。
```

### 12.2 4小时 HTF 状态机（六态，复用§8.1的判定结构，仅重命名和调整"趋势延续"语义）

| 优先级 | HTF状态 | 与15分钟状态机的对应关系 | 判定公式来源 |
|---|---|---|---|
| 1（最高） | **HTF_TRANSITION** | 对应 TRANSITION_WATCH | `falseBreakoutTier(4h) != 'none'`，复用第6节公式，全部字段替换为4小时快照 |
| 2 | **HTF_BULL_TREND** | 对应 BULL_CONFIRMATION，但强调"已确立的趋势"而非"刚突破的瞬间" | 复用§8.1 BULL_CONFIRMATION 进入/保持/退出公式，字段替换为4小时快照 |
| 3 | **HTF_BEAR_TREND** | 对应 BEAR_CONTINUATION | 复用§8.1 BEAR_CONTINUATION 公式，字段替换为4小时快照 |
| 4 | **HTF_BULL_PULLBACK** | 对应 BULL_PULLBACK | 复用§8.1 BULL_PULLBACK 公式，字段替换为4小时快照 |
| 4 | **HTF_BEAR_REBOUND** | BULL_PULLBACK 的方向对称版（价格反弹至4h压力区但未突破，且不要求BTC走强，只要求 `btc4h.trend != 'up'`） | 复用§8.1 BULL_PULLBACK 公式结构，方向取反，BTC条件对称调整 |
| 5（兜底） | **HTF_RANGE** | 对应 RANGE_CHOP | 复用§8.1 RANGE_CHOP 公式，字段替换为4小时快照 |

`HTF_BULL_PULLBACK` 与 `HTF_BEAR_REBOUND` 同为优先级4但方向互斥，不会同时触发（一个要求价格在支撑区，一个要求价格在压力区）。1小时（MTF）**直接复用第8节完整的六态状态机**（`BULL_CONFIRMATION`/`BULL_PULLBACK`/`BEAR_CONTINUATION`/`TRANSITION_WATCH`/`RANGE_CHOP`/`STAND_ASIDE`），只是输入换成1小时快照，不单独重命名——1小时的角色是"结构确认"，用与15分钟相同的状态语言反而便于用户理解"15分钟和1小时是不是在讲同一件事"。

### 12.3 三周期方向映射
```
mapDirection(state, biasDirection?):
  4h: HTF_BULL_TREND/HTF_BULL_PULLBACK -> 'long'; HTF_BEAR_TREND/HTF_BEAR_REBOUND -> 'short'; HTF_RANGE/HTF_TRANSITION -> 'neutral'
  1h: 直接用该周期 buildAdvice() 算出的 biasDirection，'long'/'long_caution' 归一为 'long'，'short' 为 'short'，'neutral' 为 'neutral'
  15m: 同1h的归一规则
btcOk(dir, btcSnapshot):
  dir=='long'  -> btcSnapshot.trend != 'down'
  dir=='short' -> btcSnapshot.trend == 'down'
  dir=='neutral' -> true
```

### 12.4 信号权限判定（对应需求原文四条规则，逐条实现）
```python
def compute_signal_permission(htf, mtf, ltf, btc_htf, btc_mtf, btc_ltf, data_health):
    # 规则4：数据异常，禁止实时建议（第14.6节三级健康状态）
    if data_health != 'normal':
        return SignalPermission('conflict', 'blocked_by_data', addOnAllowed=False,
                                 positionSizeCapPct=0,
                                 reason='数据异常/陈旧/周期不同步，禁止输出实时交易建议')

    dir_htf = map_direction(htf.state)
    dir_mtf = map_direction(mtf.state, mtf.biasDirection)
    dir_ltf = map_direction(ltf.state, ltf.biasDirection)

    # 规则1：三周期同向且BTC支持
    full_aligned = (dir_htf == dir_mtf == dir_ltf != 'neutral'
                    and btc_ok(dir_htf, btc_htf) and btc_ok(dir_mtf, btc_mtf) and btc_ok(dir_ltf, btc_ltf))
    if full_aligned:
        return SignalPermission('full_aligned', 'trend_entry_allowed', addOnAllowed=True,
                                 positionSizeCapPct=20,
                                 reason=f'三周期同向({dir_ltf})且BTC三周期均不冲突：允许小仓试错，确认后允许专业加仓（仍需满足§8.2加仓触发条件）')

    # 规则2：15分钟与4小时反向 —— 只能反弹/回调交易，不得升级为趋势仓
    counter_trend = (dir_ltf != 'neutral' and dir_htf != 'neutral' and dir_ltf != dir_htf)
    if counter_trend:
        return SignalPermission('counter_trend', 'counter_trend_only', addOnAllowed=False,
                                 positionSizeCapPct=5,
                                 reason=f'15分钟方向({dir_ltf})与4小时方向({dir_htf})相反：只能作为反弹/回调交易，不得升级为趋势仓，不允许加仓')

    # 部分同向：15分钟与1小时同向，但4小时处于HTF_RANGE/HTF_TRANSITION（大方向未破坏也未明确）
    partial_aligned = (dir_ltf == dir_mtf != 'neutral' and dir_htf == 'neutral'
                        and btc_ok(dir_mtf, btc_mtf) and btc_ok(dir_ltf, btc_ltf))
    if partial_aligned:
        return SignalPermission('partial_aligned', 'trend_entry_allowed', addOnAllowed=False,
                                 positionSizeCapPct=10,
                                 reason=f'15分钟与1小时同向({dir_ltf})，4小时暂未给出明确方向：允许小仓试错，暂不允许加仓，需等待4小时方向明确')

    # 规则3：多周期冲突且BTC不支持（含以上都不满足的其余情况）
    return SignalPermission('conflict', 'stand_aside', addOnAllowed=False,
                             positionSizeCapPct=0,
                             reason='多周期方向冲突，或方向一致但BTC不支持：STAND_ASIDE')
```
`positionSizeCapPct` 是本节新增的仓位上限建议（百分比，供UI展示，不是强制执行——系统不追踪真实仓位，只能建议），`DecisionOutput.signalPermission` 与 `worthBetting` 字段最终都由此函数的返回值决定：`worthBetting = (level=='trend_entry_allowed') and (falseBreakoutTier != 'confirmation_failed')`，即**15分钟单周期自己判断"值得下注"是不够的，必须同时通过多周期权限检查**，这是对第8节15分钟状态机的一层前置门禁，不是替代它。

---

## 13. 已收盘 / 未收盘 K线分离规则（对应需求二，逐条落实）

本节汇总并统一第0、2.3、5.1节已分别给出的修正，作为 Codex 实现时的单一检查清单：

1. **当前实时价格可以来自正在形成的K线**：`AnalyzedSnapshot.price` 字段允许取自 `klines[N-1]`（不论是否 `isClosed`），用于价格展示、盘中预警（第19节）、UI的"当前价格"卡片。
2. **未收盘K线只能产生盘中预警，不能确认正式状态**：任何"实时价格已经穿过压力/支撑/止损/目标"的情况，如果发生时最新K线 `isClosed==false`，只能触发第19.2节的"盘中预警"（文案必须显式包含"（未收盘，仅供参考）"），不能改变 `DecisionOutput.state`、`isBreakout`、`isBreakdown`、`falseBreakoutTier` 等任何"正式"字段。
3. **正式市场状态主要根据已收盘K线**：第8节状态机（15分钟、1小时）与第12.2节HTF状态机（4小时）的全部判定条件，使用 `confirmedPrice` 而非 `price`（第0节已定义），确保状态转换只在K线真正收盘后发生。
4. **Swing High/Low确认只能使用已收盘数据**：第5.1节遍历范围在最新K线未收盘时收缩到 `N-4`，已在该节写明。
5. **正式突破、跌破和状态转换不能使用未收盘K线直接确认**：第2.3节 `isBreakout`/`isBreakdown` 已改用 `confirmedPrice`。
6. **WebSocket的K线收盘标记必须进入数据结构**：`Kline.isClosed` 字段（第1.1节）在 WebSocket 数据源下直接取自 Binance kline 推送帧的 `k.x` 布尔字段（`x=true` 表示这根K线已收盘），不需要自己用时间推算，这是比REST更可靠的收盘判定来源，见第14.1节。
7. **REST返回的最后一根K线也必须通过时间判断是否已经收盘**：REST `/api/v3/klines` 不返回收盘标记，`isClosed = (Date.now() >= closeTime + REST_CLOSE_TOLERANCE_MS)`，`REST_CLOSE_TOLERANCE_MS` 建议取 `2000`（2秒网络与时钟误差容忍），避免在K线刚好收盘的边界时刻因为客户端时钟略慢而误判为未收盘。

**验收要点（呼应ACCEPTANCE_TESTS.md新增用例）**：构造一根"K线内插针后收回"的合成数据（最高价短暂超过 `priorStructureHigh20` 但收盘价收回区间内、且 `isClosed=true` 时最终收盘价确实未突破），系统在该K线收盘前（`isClosed=false`，用插针后的瞬时高点作为 `price`）不能输出 `BULL_CONFIRMATION`，只能输出盘中预警；该K线收盘后，因为 `confirmedPrice`（=该K线收盘价）仍在区间内，也依然不能输出 `BULL_CONFIRMATION`。

---

## 14. 实时数据架构（REST + WebSocket；v2.1：REST部分是V1范围，WebSocket部分是V3范围）

**V1范围声明**：V1阶段只实现本节的REST部分（14.1的REST子集、14.4缺失K线检测的REST版、14.5-14.7健康状态判断），**不实现WebSocket**（14.1的WS子集、14.2重连退避、14.3连接状态机留给V3）。V1用"定时轮询REST"稳定运行即可满足三周期决策的需要，CODEX_IMPLEMENTATION_TASK.md §1.2已给出具体轮询间隔建议（15m每20-30秒，1h每5分钟，4h每15-20分钟）。

### 14.1 数据源分工
```
REST（/api/v3/klines）——V1唯一数据源：
  - 页面首次加载时，为6个序列（ETH/BTC × 15m/1h/4h）各拉取一次历史K线（15m/1h取limit=100，4h取limit=100约合16.7天，足够覆盖第5节Swing识别和第9.1节数据量需求）
  - V1阶段：此后按各自周期的轮询间隔持续定时重新拉取（不接WebSocket），每次拉取到的最新一根K线按第13节isClosed规则（`Date.now() >= closeTime + 2000ms`）判断是否已收盘
  - V3阶段：WebSocket断线期间或重连后，用于"补齐缺口"（第14.4节missing kline detection触发）

WebSocket（wss://stream.binance.com:9443/stream?streams=ethusdt@kline_15m/ethusdt@kline_1h/ethusdt@kline_4h/btcusdt@kline_15m/btcusdt@kline_1h/btcusdt@kline_4h，组合流一次连接六路）——V3新增：
  - 页面加载完成、REST历史数据到位后建立连接，用于后续所有K线更新（含未收盘K线的滚动更新，以及 k.x=true 时的正式收盘事件）
  - 每条推送消息更新对应序列 `klines` 数组的最后一个元素（若 `k.t` 等于当前数组最后一根的 `openTime`）或追加新元素（若 `k.t` 是新的 openTime，此时上一根必须已经 `isClosed=true`，否则视为异常，第14.4节处理）
```

### 14.2 自动重连与指数退避（V3）
```
reconnectDelay = min(BASE_DELAY * 2^attemptCount + jitter(0, 500ms), MAX_DELAY)
BASE_DELAY = 1000ms, MAX_DELAY = 30000ms
attemptCount 在成功连接并稳定运行超过60秒后重置为0
连续失败超过 10 次：停止自动重连，`connectionState` 置为 `'failed'`，UI提示"实时连接多次失败，已切换为REST轮询兜底（间隔20秒）或请手动重试"，此时退回到 v1.0 已有的REST轮询逻辑作为保底，不让页面彻底失去数据来源
```

### 14.3 连接状态机（V3）
```ts
type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'failed' | 'rest_fallback';
```
UI必须展示当前 `connectionState`，不能只在彻底失败时才提示——`reconnecting` 状态也应有柔和提示（例如状态条变黄），因为此时数据可能正在变陈旧。

### 14.4 数据新鲜度与缺失K线检测（V1实现REST版：陈旧靠轮询失败/超时判断，缺口靠比对相邻K线openTime判断；V3再叠加WS专属检测）
```
每个序列独立维护 lastMessageAt（V1：最后一次REST轮询成功返回的时间戳；V3：最后一次收到该序列任意WS推送消息的时间戳）
staleThreshold(timeframe) = 2 * 周期时长   // 15m->30分钟, 1h->2小时, 4h->8小时，复用第9.2节思路，按周期缩放
isStreamStale(seriesId) = (Date.now() - lastMessageAt) > staleThreshold(timeframe)

缺失K线检测：
  对每个序列，新收到一根 isClosed=true 的K线时，检查其 openTime 是否恰好等于"上一根收盘K线 openTime + 周期毫秒数"
  若不等（说明中间有K线丢失，通常发生在重连后有数据缺口）：
     调用 REST 拉取 [上一根openTime, 新K线openTime) 区间的缺失K线（Binance klines支持 startTime/endTime 参数）补齐数组
     若补齐后仍不连续（REST也没有返回预期数量）：标记 dataQuality.gapDetected=true，UI提示"检测到K线缺口，数据可能不完整"
```

### 14.5 ETH/BTC 时间同步 与 三周期同步（V1，REST轮询时间戳版）
```
ethBtcDesync(timeframe) = abs(ethSeries[timeframe].lastCloseTime - btcSeries[timeframe].lastCloseTime) > 周期时长
  若为真：标记两者"不同步"，dataHealth 不能为 'normal'（第14.7节，此处修正原文误引用的14.6为14.7），因为BTC联动判断（第4、12节）建立在"两者反映同一时刻"的假设上，不同步的数据比较没有意义

timeframeSync(15m,1h,4h)：三个周期各自独立更新，不要求毫秒级对齐，但15分钟序列的最新收盘时间不应该早于1小时序列最新收盘时间减去1小时（否则说明15分钟流已经落后太多），同理1h相对4h。任一不满足记入 warnings，不强制阻断（因为周期之间天然有收盘时间差，这里只检测"离谱的滞后"而不是"完全同步"）
```

### 14.6 页面从后台恢复（V1：REST版，恢复时对6路各发起一次立即重新拉取；V3再叠加WS重连）
```
document.addEventListener('visibilitychange', ...):
  当 document.visibilityState 从 'hidden' 变为 'visible'：
    1.（V1）立即对6个序列各发起一次REST拉取（不等下一个定时器），确保挂起期间错过的数据被补齐
    2.（V3）检查WebSocket连接状态，若已断开则立即触发重连（不走退避的初始等待，因为这是用户主动唤醒场景，应尽快恢复）
```

### 14.7 三级数据健康状态（V1，REST版；对应需求"数据正常、数据延迟、数据失效三级"）
```
V1（REST轮询版）：
dataHealth =
  'normal'  : 全部6路REST轮询最近一次均成功 且 !isStreamStale（用第14.4节陈旧判断，按轮询间隔换算）且 !ethBtcDesync 且 dataQuality每个序列都满足第9.1节最低K线数量要求
  'delayed' : 至少一路最近一次轮询失败但重试未超过3次，或 isStreamStale 但未超过 2*staleThreshold，或 timeframeSync有warning但未达阻断级别 —— 此时页面继续展示，但状态条明确提示"数据延迟，判断可能滞后"，advice文案不强制加前缀（区别于第9.2节"陈旧"前缀，delayed是更轻的提示级别）
  'invalid' : 任一路 isStreamStale 超过 2*staleThreshold，或连续轮询失败超过3次，或 ethBtcDesync 为真，或K线数量低于第9.1节最低要求 —— 此时第12.4节 signalPermission 强制返回 'blocked_by_data'，DecisionOutput.worthBetting 强制为 false，UI用不可关闭的红色横幅提示"数据失效，已禁止输出实时交易建议"（呼应需求原文"数据失效时禁止输出实时交易建议"）

V3（叠加WebSocket后）：上述 'normal'/'delayed' 判断额外引入 `connectionState`（第14.3节，'open'/'reconnecting'/'failed'/'rest_fallback'）参与判断，逻辑上是本节REST版的超集，不是替换。
```

---

## 15. 支撑压力区域化（第2、5节的正式扩展）

第2.4节和第5.2节已定义的 `firstResistance`/`secondResistance`/`firstSupport`/`secondSupport` 和聚类去重（第5.2第5项）是本节的计算基础，本节把它们从"代表点"包装为"区域"：

```ts
interface SRZone {
  type: 'support' | 'resistance';
  rank: 1 | 2;                 // 第一 / 第二
  center: number;              // = 对应 LeveledPrice.price（第1.2节）
  upper: number;                // = center + zoneHalfWidth
  lower: number;                // = center - zoneHalfWidth
  confidence: 'high' | 'medium' | 'low';  // 复用 LeveledPrice.confidence
  sourceSwingCount: number;     // 该区域聚合了几个原始Swing点（第5.2第5项clusterId分组大小）
}

zoneHalfWidth = max(0.15 * ATR14, 0.5 * 该簇内Swing点价格极差)
  // ATR决定基础宽度（第四点"ATR决定区域宽度"），若聚类内的点本身价差较大，区域也相应变宽，取两者较大值
```
- **突破前冻结结构**：`priorStructureHigh20`/`priorStructureLow20`（第2.2节）本身不生成独立区域，而是作为 `isBreakout`/`isBreakdown` 判断的边界线（第2.3节），继续保持单值，不区域化——因为它是触发条件，需要清晰的二元判断，区域化反而会引入"到底算不算突破"的歧义。
- **突破后的下一目标区域**：第2.5节的 `targets[0]/[1]/[2]`（ATR×0.5/1/1.5）每个也生成一个窄区域 `{center: targets[i], upper: targets[i]+0.1*ATR14, lower: targets[i]-0.1*ATR14}`，向用户传达"目标位是一个大致区域，不是精确到分的价格"。
- UI展示要求：`confidence='low'` 的区域必须视觉弱化（虚线边框/降低不透明度），不能和 `high` 置信度区域同等展示，避免用户把外推位当成真实历史结构。

---

## 16. 成交量质量（扩展第2.3节 `volumeRatio`）

```ts
interface VolumeQuality {
  volumeRatio: number | null;         // 已有，第1.2节
  takerBuyRatio: number | null;       // = klines[N-1].takerBuyVolume / klines[N-1].volume；>0.5表示主动买盘占优
  volumeNoProgress: boolean;          // 放量滞涨：volumeRatio>=1.5 且 |close-open|/(high-low) < 0.3
  lowVolumePullback: boolean;         // 缩量回踩：state=='BULL_PULLBACK'(或对称空头场景) 且 volumeRatio<0.8，是回踩健康的正面信号
  breakoutVolumeSustained: 'sustained' | 'fading' | 'not_applicable';
    // isBreakout(或isBreakdown)期间，breakoutBarsCount根K线的volumeRatio平均值 >=1.1 记为 'sustained'，否则 'fading'；未处于突破/跌破状态记 'not_applicable'
}
```
`Kline.takerBuyVolume` 取 Binance klines 数据的字段索引 `[9]`（REST）或 WebSocket kline 推送帧的 `k.V`（Taker buy base asset volume）。

**硬性声明（对应需求原文"成交量只能作为证据之一，不能单独决定交易"）**：`VolumeQuality` 的任何字段都不能单独触发状态转换或建议改变——它只能作为：(a) 第6节假突破六项判据之一（已有的d2/d5）的数据来源，(b) 第17节评分的一个分项，(c) 第19节决策日志的"证据"列表条目。**不允许新增任何形如 `if (volumeQuality.xxx) { state = ... }` 的独立分支**，这是Code Review红线之一。

---

## 17. 透明信号评分（0-100，逐项可追溯，不替代硬性规则）

```ts
interface ScoreBreakdown {
  total: number;   // clamp(0, 100, 各加分项之和 - 各扣分项之和)
  items: { name: string; points: number; maxPoints: number; reason: string }[];
  deductions: { name: string; points: number; reason: string }[];
  overriddenByHardRule: boolean;   // true时即使total很高，worthBetting仍强制为false，UI必须醒目提示"评分仅供参考，已被硬性规则否决"
}
```

### 17.1 加分项（满分100，七项权重对应需求原文）
| 项目 | 满分 | 打分规则 |
|---|---|---|
| 4小时方向 | 20 | `HTF_BULL_TREND`/`HTF_BEAR_TREND`（且方向与15m一致）=20；`HTF_BULL_PULLBACK`/`HTF_BEAR_REBOUND`=14；`HTF_RANGE`=8；`HTF_TRANSITION`=4；方向与15分钟相反=0 |
| 1小时结构 | 15 | `BULL_CONFIRMATION`/`BEAR_CONTINUATION`（方向一致）=15；`BULL_PULLBACK`同向=11；`RANGE_CHOP`=6；`TRANSITION_WATCH`=3；方向冲突=0 |
| 15分钟位置 | 20 | `falseBreakoutTier=='none'` 且状态为 `BULL_CONFIRMATION`/`BEAR_CONTINUATION`=20；`BULL_PULLBACK`支撑有效=16；`TRANSITION_WATCH`(warning级)=8；`RANGE_CHOP`/`STAND_ASIDE`=2 |
| BTC联动 | 15 | 三周期 `btcAlignment` 均为 `support`=15；2/3为`support`=10；1/3为`support`=5；任一周期为`conflict`且与交易方向相关=0 |
| 成交量 | 10 | `breakoutVolumeSustained=='sustained'` 或 `takerBuyRatio` 与方向一致且>0.55=10；中性=5；`volumeNoProgress=true`=0 |
| 净盈亏比 | 15 | `netRR>3`=15；`netRR>2`=11；`1.5<=netRR<=2`=7；`netRR<1.5`=2；无法计算=0 |
| 数据质量 | 5 | `dataHealth=='normal'`=5；`'delayed'`=2；`'invalid'`=0 |

### 17.2 扣分项
| 项目 | 扣分 |
|---|---|
| 假突破 `warning` | -5 |
| 假突破 `confirmation_failed` | -20（且此时 `overriddenByHardRule=true`） |
| `counter_trend_only`（15m逆4h） | -15 |
| `stand_aside`（多周期冲突） | -30 |
| `blocked_by_data` | 总分直接归零，`overriddenByHardRule=true` |

### 17.3 评分与硬性规则的关系（必须实现，Code Review红线）
```
worthBetting = (signalPermission.level == 'trend_entry_allowed')
               and (falseBreakoutTier != 'confirmation_failed')
               and (dataHealth != 'invalid')
// 评分 score.total 不出现在上面这个表达式里！评分只用于UI展示"这个信号有多扎实"的参考仪表盘，
// 绝不能出现"score>=80 所以 worthBetting=true"这种反向依赖——防止未来有人为了让某个信号"看起来能下注"而调评分权重，
// 分数和是否可以下注必须是两条独立的判断链路，一条硬（第8/12节状态机+权限），一条软（本节评分仅供参考）。
```

---

## 18. 历史行情实验室（撤销v1.0"不做回测"结论，正式规划）

**v1.0 中 CODEX_IMPLEMENTATION_TASK.md 第6.8条"禁止把...历史回测框架...实现进本阶段代码"、STRATEGY_SPEC.md v1.0 §3.3"回测框架本身不在本阶段范围内"两处表述，董事长/CEO在第二轮已明确撤销，v2.0起历史回测是正式产品规划的一部分。**

### 18.1 数据
多年 ETH/USDT、BTC/USDT 历史K线，15分钟/1小时/4小时三个周期同步存储（可通过 Binance 历史K线分页拉取或 Binance Vision 历史数据文件获取，具体下载方式是V2阶段的工程实现细节，本文档只规定数据必须满足"三周期时间对齐、可回放"的要求）。

### 18.2 回放引擎与防止未来数据泄漏（look-ahead bias，重点）
```
回放时钟 t 从历史区间起点开始，逐根15分钟K线推进（1小时/4小时K线在其各自收盘时间点被"揭示"给引擎）
在任意时刻 t，引擎只能访问 openTime <= t 且已收盘（第13节isClosed语义在回放场景下等价于"openTime+周期时长 <= t"）的K线
Swing点确认延迟必须在回放中模拟：第5.1节要求"前后各2根K线"，回放到第i根K线时，只有当第i+2根也已经被回放引擎"揭示"，第i根才能被判定为Swing点——不能因为整个历史数据集其实早就存在于内存里，就提前用未来K线确认过去的Swing，这是历史回测最容易犯、也最容易导致"回测结果虚假优秀"的错误，必须作为V2阶段的第一优先级正确性要求
每笔模拟交易按第10.1a节 TradingCost 模型扣除手续费/价差/滑点后计算净盈亏
```

### 18.3 统计维度
- 顺4小时（`signalPermission.alignment=='full_aligned'`）与逆4小时（`'counter_trend'`）分别统计。
- BTC同步（`btcAlignment=='support'`）与冲突（`'conflict'`）分别统计。
- 按15分钟六态、4小时HTF六态分别统计。
- 数据集划分：训练区间 / 验证区间 / 测试区间，**按时间顺序切分**（不随机打乱，因为存在时序依赖，随机打乱会引入另一种数据泄漏）。
- 滚动样本外验证（walk-forward）：滚动窗口在训练区间上调参，紧接着的一段区间做样本外测试，窗口整体向前滚动，重复多轮，观察参数是否在不同时间段都稳定有效。
- 参数敏感性测试：对第3.3节的0.3×ATR止损系数、第6.1节的1.2倍放量阈值等关键参数做网格扰动（例如0.2/0.25/0.3/0.35/0.4），观察统计结果是否对参数取值过度敏感（过度敏感=过拟合信号，即使某个具体值历史表现最好也不能直接采用）。
- 模拟盘阶段：回测验证通过后，接入实时数据但不下单，只记录"如果照做，结果如何"，与回测结果交叉验证，防止回测本身低估了实盘的滑点/延迟。

### 18.4 统计指标（需求原文全部保留）
交易次数、胜率、平均盈利、平均亏损、期望值（=胜率×平均盈利 − 败率×平均亏损）、Profit Factor（=总盈利÷总亏损绝对值）、最大回撤、最大连续亏损次数，以上指标均按第18.3节各维度分别统计（不能只给一个笼统的总胜率）。

### 18.5 工程结构（不塞进单文件HTML，分阶段交付，对应需求"V1/V2/V3"，v2.1更新V1/V3边界）
```
V1 三周期REST决策核心（v2.1：范围经CEO第二轮验收扩大，不再是"15分钟单周期"）：
  仍是 eth-dynamic-trading-dashboard.html 单文件路线。
  数据源：第14节的REST部分（14.1的REST子集、14.4缺失K线检测的REST版、14.5-14.7健康状态的REST版），
  第14节WS部分（14.2重连退避、14.3连接状态机）明确推迟到V3，V1用定时轮询代替，不是"权宜之计"，是CEO批准的正式方案。
  第12节三周期架构（4小时HTF状态机+1小时结构+15分钟执行+信号权限矩阵）在V1阶段必须真实实现，不是占位。
  第19.1节决策日志在V1阶段必须实现（用真实三周期状态填充字段）；第19.2节条件提醒推送（Notification API）留给V3。
  关键工程要求：analyzeKlines/classifyState/classifyHtfState/computeSignalPermission/calcRiskReward等全部实现为不依赖DOM的纯函数
  （输入K线数组，输出快照/决策对象），这是V1阶段就要满足的架构约束，直接决定V2能否顺利复用。

V2 历史验证引擎（不变）：
  独立的 Node.js 脚本/小工程，不要求单文件、不要求双击打开（历史回测天然需要下载存储大量数据、运行较长时间的批量计算，
  不适合塞进一个需要在浏览器里跑的单文件页面）。
  直接 import/复用 V1 中已经写好的纯函数，跑第18.2节的回放引擎，产出第18.4节的统计报告（Markdown/CSV/独立HTML报告均可，不要求实时dashboard形态）。

V3 WebSocket、条件提醒、模拟仓位与长期运行监控（v2.1：范围调整，决策日志已移至V1）：
  在V1基础上叠加第14节完整WebSocket架构（含连接状态机、指数退避重连、三周期同步的实时版）、
  第19.2节条件提醒的浏览器 Notification 推送、模拟仓位（Paper Position Tracking，虚拟记录用户"如果照做"的持仓并跟踪浮动盈亏）、
  长期运行监控（连接可用率/延迟/重连次数等运维可观测性指标）。
```
**V2、V3 复用 V1 的核心纯函数，不重新实现一遍策略逻辑**——这是第2-11节反复强调"周期无关的纯函数"设计的直接原因，Codex在V1阶段如果把状态机逻辑和DOM渲染写死在一起，会直接导致V2阶段无法复用，必须返工。

---

## 19. 决策日志与条件提醒（v2.1：19.1决策日志属于V1范围，19.2条件提醒推送属于V3范围）

### 19.1 决策日志（V1）
```ts
interface DecisionLogEntry {
  id: string;
  timestamp: number;
  dataSource: 'api' | 'manual' | 'websocket';
  ethPrice: number;
  btcPrice: number;
  htfState: string;              // 4小时HTF状态
  mtfState: string;               // 1小时状态
  ltfState: string;               // 15分钟状态（DecisionOutput.state）
  supportZones: SRZone[];
  resistanceZones: SRZone[];
  atr15m: number | null;
  volumeQuality: VolumeQuality;
  riskReward: RiskReward;
  advice: string;
  supportingEvidence: string[];   // 支持该建议方向的判据，例如 ["4小时HTF_BULL_TREND","放量突破","净盈亏比2.3"]
  opposingEvidence: string[];     // 不利于该建议的判据，例如 ["1小时仍处于RANGE_CHOP","刚从4小时压力区回落"]
  stopLoss: number | null;
  targets: [number|null, number|null, number|null];
  userAction: 'followed' | 'ignored' | 'modified' | 'unknown';   // 用户手动标记，系统不代替判断
  outcome: 'win' | 'loss' | 'breakeven' | 'not_closed' | 'unknown'; // 用户手动回填
  ruleCompliance: 'followed_rules' | 'deviated' | 'unknown';        // 用户手动回填，是否遵守了系统给出的止损/目标纪律
}
```
`supportingEvidence`/`opposingEvidence` 的生成规则：遍历第17.1/17.2节评分明细，得分>=满分60%的项归入 supporting，扣分项和得分<40%的项归入 opposing，这样"证据"和"评分"共享同一套底层判据，不需要重新设计一套独立的证据抽取逻辑。

V1阶段决策日志可先用浏览器 `localStorage` 持久化（容量有限，建议只保留最近500条，超出后先进先出），V3阶段再评估是否需要更持久的存储方案。

### 19.2 条件提醒（V3，八类，对应需求原文；V1不实现主动推送，判断逻辑本身可提前写成纯函数供V3直接调用）
| # | 提醒条件 | 触发判定 |
|---|---|---|
| 1 | 进入最佳拦截区 | `bestInterceptionZone()`（第7节）返回的 `zone` 字段从"非拦截区"变为"拦截区"类值 |
| 2 | 突破或跌破关键区域 | `isBreakout`/`isBreakdown`（基于 `confirmedPrice`，第13节）从 `false` 变为 `true`；同时提供一个默认关闭的"盘中提前预警"开关，用 `price` 判断，文案必须标注"（未收盘，仅供参考）" |
| 3 | 回踩确认 | `state` 进入 `BULL_PULLBACK` 或对称的空头回踩场景 |
| 4 | BTC转向 | 任一周期 `btcAlignment` 发生变化，或 `signalPermission.alignment` 发生变化 |
| 5 | 假突破确认 | `falseBreakoutTier` 变为 `confirmation_failed` |
| 6 | 临近失效位 | `abs(price - stopLoss) < 0.3 * ATR14` |
| 7 | 到达目标 | `price` 触及 `targets[0]`/`[1]`/`[2]` 任一 |
| 8 | 数据失效 | `dataHealth` 变为 `'invalid'` |

提醒的呈现方式：V1/V3阶段用页面内醒目UI高亮 + 浏览器 `Notification API`（需用户主动授权），**不要求**短信/邮件/IM等外部推送通道——这类通道涉及用户联系方式等隐私信息的存储与第三方服务对接，超出"单文件HTML、不接外部账户"的边界，不在V1/V2/V3任何一个阶段的范围内。

---

## 20. 项目边界（补充，完整清单见CODEX_IMPLEMENTATION_TASK.md第6节）

延续第一轮已确立的边界（禁止自动下单、禁止读取账户/密钥、禁止把摊平包装成加仓、禁止盈利承诺），v2.0新增三条与本文档算法直接相关的边界，写在这里是因为它们影响接口设计而不只是流程纪律：

1. **禁止自动杠杆/杠杆计算**：本系统不追踪保证金、不计算强平价、不提供杠杆倍数建议，`DecisionOutput` 及其子结构中不应出现任何"杠杆倍数""强平价"字段。
2. **禁止黑箱AI直接决定买卖**：每一条 `advice` 都必须能展开为第17节评分明细和第19.1节证据/反对证据列表——不允许接入一个不可解释的机器学习模型直接输出方向而不给出规则依据，本文档定义的所有判断都必须是可读的显式规则（if/else、公式），不是训练出来的黑箱权重。
3. **不扩展到大量其他币种**：本系统范围固定为 ETH/USDT 与 BTC/USDT，V1/V2/V3 任何阶段都不得因"顺手""复用代码方便"扩展支持其他交易对。
