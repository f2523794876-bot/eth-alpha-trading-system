# V1_3_PAPER_TRADING_SPEC.md — ETH Alpha V1.3「真实行情模拟交易系统」算法与数据规范

版本：v1.3-draft-2（CEO对draft-1的七项决策+三项统一规则已逐条落地，修订摘要见§14变更记录）
角色：本文档只做 V1.3「模拟交易账户」的**架构设计与验收规范**，不是实现代码，也不由本文档作者实现正式业务代码。
基准：main 分支 `v1.2.0` 标签（提交 `0dc1943`），本文档在 V1.1（`v1-core.js`，冻结）与 V1.2（`v1_2-forecast-core.js`，冻结）之上做**纯叠加**，不修改、不重写两者已验收的任何函数或算法。
唯一算法真相来源声明：本文档是 V1.3 模拟交易算法的唯一 source of truth。`V1_3_CODEX_IMPLEMENTATION_TASK.md` 的函数接口必须实现本文档定义的行为；`V1_3_ACCEPTANCE_TESTS.md` 的用例必须验证本文档定义的规则；`V1_3_ARCHITECTURE_REVIEW.md` 负责核对三者与 V1.1/V1.2/STRATEGY_SPEC.md 的一致性。四份文档如有冲突，以本文档为准。

**常驻免责声明（强制，任何页面状态下都必须可见，见§10）**：`模拟交易，不是真实下单，不连接交易所账户。`

---

## 0. 范围与既有文档的关系

### 0.1 这是一次刻意的范围拆分，不是范围蔓延

CEO已明确决策（本轮draft-2第7项）：**V1.3 = 真实行情模拟交易与模拟仓位；V3 = WebSocket、条件提醒、推送和长期运行监控**。历史文档中把"模拟仓位"与WebSocket/条件提醒/长期运行监控打包归入V3的过时措辞，已在本轮同步修订（见本次提交对 `CODEX_IMPLEMENTATION_TASK.md`/`STRATEGY_SPEC.md`/`PROJECT_AUDIT.md`/`ACCEPTANCE_TESTS.md`/`V1_IMPLEMENTATION_REPORT.md`/`V1_CHECKLIST.md`/`V1_2_CODEX_IMPLEMENTATION_TASK.md`/`V1_2_ARCHITECTURE_REVIEW.md`的范围性文字追加说明，未改动这些文档描述的V1.1/V1.2既有规范或代码本身）。

### 0.2 与 `CODEX_IMPLEMENTATION_TASK.md` 早期"模拟仓位"草稿概念的关系

V1 阶段文档曾用一句话粗略勾勒过"模拟仓位"概念（用户标记"如果此刻按建议开仓"，系统虚拟记录方向/开仓价/止损/目标，tick级比对浮动盈亏，触及止损/目标自动标记平仓结果并写回决策日志的 `outcome` 字段）。**本文档定义的 V1.3 系统在范围和数据结构上完全取代该草稿概念**：V1.3 是独立账户（现金/保证金/净值/已实现/未实现/手续费/滑点/回撤全套记账）+ 独立 localStorage 命名空间 + 独立状态机 + 独立日志，不是"写回决策日志的一个字段"。后续任何文档提到"模拟仓位"，均以本文档为准。

### 0.3 V1.3 不做的事

不自动下真实订单；不读取/存储任何交易所API密钥；不连接用户真实交易所账户；不承诺盈利或给出保证性措辞；不允许亏损摊平；不允许用杠杆扩大风险预算（杠杆只影响保证金占用，见§5.5）；不修改 `v1-core.js`/`v1_2-forecast-core.js` 已验收的任何函数体；不实现V2历史校准（`outcomeAfter*Bar`/Brier/校准曲线）；不实现WebSocket、条件提醒推送（`Notification`）、长期运行监控；不在无用户点击确认的情况下自动建立模拟仓位——**任何**模拟开仓、加仓、减仓、平仓、重置函数在设计上都必须要求一个只能来自真实用户点击事件的 `idempotencyKey`（见§6.11）作为参数，不得由定时器或数据刷新回调直接调用。

---

## 1. 术语与数据结构总览

| # | 术语 | 定义 | 归属 | 字段/接口 |
|---|---|---|---|---|
| 1 | 模拟账户 Account | V1.3 唯一的虚拟资金主体，USDT计价，不对应任何真实资金 | V1.3新增 | `PaperAccount`，见§2 |
| 2 | 模拟合约语义 | "模拟USDT本位永续合约"记账方式（cash/equity/margin分离），但不实现真实合约的强平、资金费、逐仓/全仓切换 | V1.3新增 | 见§2.3 |
| 3 | 持仓 Position | 账户当前对ETH的方向性敞口（同一时刻至多一个方向，见§3.1） | V1.3新增 | `PaperPosition`，见§3 |
| 4 | 交易 Trade | 一次持仓从建立到彻底了结（含期间的加仓、部分止盈、可能的数据缺口）的完整生命周期记录 | V1.3新增 | `PaperTrade`，见§3.2 |
| 5 | 成交 Fill | 一次不可变的撮合执行事件（开仓/加仓/部分平仓/止损/止盈/保守结算） | V1.3新增 | `PaperFill`，见§3.3 |
| 6 | 交易方案 Proposal | 系统基于当前V1.1决策生成、等待用户点击确认的"如果开仓将会是这样"的只读预览，本身不改变账户状态 | V1.3新增 | `TradeProposal`，见§6.1 |
| 7 | 风险预算 Risk Budget | 单笔/试仓/加仓允许的最大亏损金额，**恒以当前净值`equity`为基准**（红线，见§5.1，CEO决策第2项） | V1.3新增，复用 `C.calcRiskBudget` 核心公式 | 见§5 |
| 8 | 风险状态 Risk Regime | 账户当前是否允许新开仓/加仓的宏观状态 | V1.3新增 | `PaperAccount.riskRegime`，见§5.4 |
| 9 | V1.1决策快照引用 | 建仓时刻 `d`（`buildDecision`输出）的**深拷贝**只读快照 | 只读消费V1.1 | 见§7.2 |
| 10 | V1.2预测快照引用 | 建仓时刻 `window.__prevForecast`（`F.buildForecast`输出）的**深拷贝**只读快照 | 只读消费V1.2 | 见§7.2 |
| 11 | 数据截止时间 | 建仓/成交判定所依据的最后一根**已收盘**15分钟K线的 `closeTime` | 只读消费V1.1 | `PaperFill.dataAsOf` |
| 12 | 数据缺口 Data Gap | 持仓期间出现的、无法完整回补的已收盘K线断档（CEO决策第6项） | V1.3新增 | `PaperTrade.dataGap`，见§8 |
| 13 | 幂等键 Idempotency Key | 每次开仓/加仓/减仓/平仓/重置操作携带的稳定标识，用于保证同一操作重复提交只产生一次状态变化（CEO决策第10项） | V1.3新增 | 见§6.11 |

**强制措辞规则**：V1.3 任何界面文案不得出现"稳赚""必涨""必跌""保证盈利""跟单必赚"等承诺性表述；净值/盈亏数字必须始终标注"模拟"二字或与常驻免责声明同屏出现。

---

## 2. 账户模型

### 2.1 `PaperAccount` 接口

```ts
interface PaperAccount {
  schemaVersion: string;            // 'v1.3-account-2'，字段增删必须递增，见§9.3
  algorithmVersion: string;         // 'v1.3-draft-2'，对应本文档版本，规则变化必须递增
  createdAt: number;                 // 账户首次创建时间（首次写入localStorage的时间）
  resetCount: number;                // 账户被重置的次数，重置不清零该计数本身
  currency: 'USDT';                  // 恒定
  initialCapital: number;            // 当前生效的初始本金，默认500，可修改（需二次确认，见§2.4）
  cash: number;                      // walletBalance：现金余额，只受已实现盈亏/手续费影响，不受浮动盈亏影响
  marginUsed: number;                // 当前所有未平仓position占用的保证金合计，见§2.3
  realizedPnlGross: number;          // 累计已实现盈亏（含历史所有已平仓/部分平仓部分，未扣手续费，见§2.2命名红线）
  feesTotal: number;                 // 累计手续费（USDT，正数，表示已扣除的成本）
  slippageCostReport: number;        // 累计滑点成本（USDT，正数，**纯报告字段**，见§2.2，不重复计入cash）
  peakEquity: number;                // 账户净值历史最高点，只在账户重置时归零重建，其余任何操作（含入金/改本金）不得静默重置，见§2.4/§5.4（CEO决策第1项）
  dailyAnchorDateUTC: string;        // 'YYYY-MM-DD'，当前生效的UTC自然日锚点，见§5.3
  dailyStartEquity: number;          // 当前UTC自然日"日初"净值快照，重建规则见§5.3（CEO决策第8项）
  riskRegime: 'NORMAL' | 'DAILY_LOSS_LOCKED' | 'FORCED_OBSERVATION'; // 见§5.4
  settings: PaperAccountSettings;    // 见2.2
  updatedAt: number;                 // 最近一次账户状态变化时间
  processedIdempotencyKeys: string[]; // 最近处理过的幂等键（有界环形缓冲，见§6.11），用于重复提交的原样回放
}

interface PaperAccountSettings {
  leverage: number;                  // 1~3（含），默认1，见§5.5
  maxRiskPct: number;                // 单笔最大风险占**当前净值**比例，默认0.01（1%）
  trialRiskPct: number;              // 小仓试错风险占**当前净值**比例，默认0.005（0.5%）
  dailyLossLimitPct: number;         // 当日最大已实现亏损占"当日期初净值"比例，默认0.03（3%）
  maxDrawdownPct: number;            // 触发强制观察的回撤比例（相对peakEquity），默认0.10（10%）
  takerFeeRate: number;              // 单边手续费率，默认0.0005，对齐 `v1-core.js` COST_DEFAULT.takerFeeRate
  spreadRate: number;                // 点差率，默认0.0002，对齐 COST_DEFAULT.spreadRate
  slippageRate: number;              // 滑点率，默认0.0003，对齐 COST_DEFAULT.slippageRate
  pricePrecision: number;            // 价格小数位，默认2
  quantityPrecision: number;         // 数量小数位，默认3
  minNotional: number;               // 最小名义价值USDT，默认20
}
```

**默认值一览（对应用户需求第一/二/三节，数值本身draft-1已定，draft-2未变）**：

| 字段 | 默认值 | 500 USDT账户对应数值 |
|---|---:|---|
| `initialCapital` | 500 | — |
| `leverage` | 1（上限3） | — |
| `maxRiskPct` | 0.01 | 约5 USDT（以**当前净值**计，非固定值，见§5.1） |
| `trialRiskPct` | 0.005 | 约2.5 USDT（以**当前净值**计，非固定值） |
| `dailyLossLimitPct` | 0.03 | 约15 USDT（以当日期初净值计） |
| `maxDrawdownPct` | 0.10 | 约50 USDT（以`peakEquity`历史最高点计，见§5.4） |
| `takerFeeRate` / `spreadRate` / `slippageRate` | 0.0005 / 0.0002 / 0.0003 | 与 `v1-core.js COST_DEFAULT` 完全一致，仅为模拟假设，**不代表Binance真实费率**，必须允许用户调整 |

### 2.2 账户会计恒等式（红线，CEO决策第9项，字段命名以本节为准）

```
cash             = initialCapital + realizedPnlGross - feesTotal
equity（净值）    = cash + unrealizedPnl                         对所有当前OPEN/PARTIALLY_CLOSED/UNRESOLVED_DATA_GAP的position求和unrealizedPnl
availableBalance（可用余额） = equity - marginUsed                 **注意：以equity为基准，不是cash**（与draft-1的`availableCash=cash-marginUsed`不同，本次由CEO明确修正为cross-margin语义：浮动盈亏同步影响可用余额）
marginUsed       = Σ(notional_i / leverage_i)                     对所有当前OPEN/PARTIALLY_CLOSED/UNRESOLVED_DATA_GAP的position i
```

`slippageCostReport` **不**是独立的现金流，它是"如果没有滑点本应获得的价格"与"实际成交价"之差乘以数量的**报告统计口径**，滑点的实际财务影响已经体现在 `realizedPnlGross`/`unrealizedPnl` 里（因为PnL用的就是含滑点的成交价），因此**不得**从 `cash` 里再单独扣一次 `slippageCostReport`，否则会重复扣减（红线，`V1_3_ACCEPTANCE_TESTS.md` T4/T27专项验证不重复扣减）。

`realizedPnlGross` 命名中的"Gross"强调它是**未扣手续费的价格盈亏**（`Σ(exitFillPrice-entryPrice)×closedQuantity`，多空方向见§4.2），手续费在 `feesTotal` 单独累计，`cash`恒等式里两者相减——这是CEO为避免"已实现盈亏"字段本身含义模糊（到底扣没扣手续费）而要求的明确区分（决策第9项字段清单）。

任何时刻必须满足 `cash >= 0` 且 `marginUsed <= equity`（`availableBalance>=0`的等价表述，因为`availableBalance=equity-marginUsed`）——风险预算与保证金校验必须在成交前拦截，不允许成交后账户出现负现金或保证金超过净值的状态。

### 2.3 "模拟USDT本位合约"语义边界

V1.3 采用与真实币安USDT本位永续合约类似的**记账语义**（cash/equity/margin分离、杠杆只影响保证金占用），但**不**实现：强平价计算、强平机制本身、资金费率结算（`fundingRate` 恒为0，仅预留字段对齐 `v1-core.js COST_DEFAULT.fundingRate` 与 `STRATEGY_SPEC.md §10.1b`）、逐仓/全仓模式切换、多币种保证金。V1.3 只有ETH一个交易标的，且同一时刻只允许一个方向的持仓（不支持同时多空对冲，见§3.1）。

**强平相关红线**：`STRATEGY_SPEC.md` 第20节已明确"本系统不追踪保证金、不计算强平价、不提供杠杆倍数建议"是V1/V2的边界；V1.3 是第一个真正冻结保证金的阶段，但**仍然不计算强平价、不模拟强制平仓**——`marginUsed` 只是一个记账占用数字，不会触发自动平仓；账户风险完全由§5的风险预算/日亏损/回撤规则控制，而不是靠模拟交易所强平。

### 2.4 初始本金修改与账户重置（`peakEquity`不得被静默重置，CEO决策第1项）

- 修改 `initialCapital`：只允许在**当前无任何OPEN/PARTIALLY_CLOSED/UNRESOLVED_DATA_GAP持仓**时进行；流程必须是**两步确认**（第一次点击弹出确认对话，第二次显式确认后才生效）。修改本金**不会**重置 `cash`/`realizedPnlGross`/`feesTotal`/`peakEquity`/`dailyStartEquity`/`dailyAnchorDateUTC` 等任何历史累计或锚点字段——**红线**：`peakEquity`只允许在§2.4b账户重置流程中被重建，任何入金/改初始本金/杠杆或费率设置修改都**不得**触碰`peakEquity`，否则会让一个已经历史性回撤过10%的账户，仅仅因为用户调高了`initialCapital`就悄悄清空回撤记录、绕开§5.4的强制观察状态——这正是CEO决策第1项特别强调"普通入金参数修改不得静默重置"要防止的场景。
- 重置账户（§2.4b）：必须两步确认（同上模式，第二次确认文案必须显式包含"将清空全部模拟持仓、成交记录与统计数据，且不可恢复"字样）。重置后：`cash=initialCapital`、`marginUsed=0`、`realizedPnlGross=0`、`feesTotal=0`、`slippageCostReport=0`、`peakEquity=initialCapital`（**唯一允许重建`peakEquity`的路径**）、`riskRegime='NORMAL'`、`dailyStartEquity=initialCapital`、`dailyAnchorDateUTC=`当天（UTC）、`resetCount+=1`、`processedIdempotencyKeys=[]`；`ethAlphaPaperTrades`/`ethAlphaPaperLog` 两个localStorage key**清空为空数组**。重置操作本身必须在 `ethAlphaPaperLog` 里写入一条不可删除的审计记录（`type:'ACCOUNT_RESET'`），写在**清空之后**。重置操作本身也必须携带`idempotencyKey`（见§6.11，CEO决策第10项）。

---

## 3. 持仓、交易与成交模型

### 3.1 持仓并发范围

V1.3 同一时刻**至多一个** `PaperPosition`（ETH，多或空二选一，不支持同时反向对冲），与V1.1同一时刻只给出一个 `biasDirection` 的设计天然一致。已有持仓（含`UNRESOLVED_DATA_GAP`状态）时禁止开立新方向仓位。

### 3.2 `PaperTrade` 接口

```ts
interface PaperTrade {
  tradeId: string;                   // `PT-${createdAt}-${随机后缀}`
  direction: 'long' | 'short';
  status: PositionStatus;            // 见§3.4状态机（新增UNRESOLVED_DATA_GAP，CEO决策第6项）
  createdAt: number;
  entryTime: number;
  entryPrice: number;                 // 加权平均建仓价（含首次开仓与至多1次加仓，见§4.3）
  quantity: number;                   // 当前剩余数量
  initialQuantity: number;            // 首次开仓（试仓）时的数量，加仓上限约束依据（见§5.2）
  notional: number;                   // 当前剩余名义价值 = quantity * entryPrice（加权）
  leverage: number;                   // 开仓时刻账户设置的杠杆，交易生命周期内不可变（见§5.5）
  marginUsed: number;
  initialStop: number;                // 首次开仓时的止损价，不可变，供审计对比
  currentStop: number;                // 当前生效止损（移动止损/加仓保本位后会变化，只能同方向收紧或持平，见§6.10）
  targets: number[];                  // 建仓时冻结的目标价数组（来自V1.1 `d.targets`）
  invalidation: string[];             // 建仓时冻结的离场条件文案（来自V1.1 `d.exitConditions`）
  addOnCount: number;                 // 已发生的加仓次数，V1.3上限为1（CEO决策第3项，红线，不可配置）
  fees: number;
  slippage: number;                   // 该笔交易累计滑点成本（报告口径，见§4.4）
  realizedPnl: number;                // 该笔交易累计已实现盈亏（Gross口径，未扣手续费，与§2.2一致）
  unrealizedPnl: number;
  closeReason: string | null;         // 见§6.13离场原因枚举，未平仓为null
  closedAt: number | null;
  estimated: boolean;                 // 默认false；仅在经§8保守结算流程平仓时为true（CEO决策第6项）
  verified: boolean;                  // 默认true；estimated=true时恒为false（CEO决策第6项）
  dataGap: PaperDataGap | null;       // 见§8，无数据缺口历史时为null
  decisionSnapshot: FrozenDecisionSnapshot;
  forecastSnapshot: FrozenForecastSnapshot | null;
  dataAsOf: number;
  algorithmVersion: string;           // 建仓时刻 v1_3-paper-trading-core.js 的 PAPER_ALGORITHM_VERSION
  lastScannedBarOpenTime: number;     // 最后处理过的15分钟K线openTime，供§8断线恢复重放使用
  fills: PaperFill[];
}

interface PaperDataGap {
  startTime: number;                  // 检测到数据失效的时间（`invalidateDashboard`触发时刻）
  detectedAt: number;                 // 同startTime，语义别名，便于审计日志直读
  missingBarCount: number | null;     // 缺口内应有但未能回补的15分钟K线数量估计，无法估计时为null
  replayAttempts: PaperDataGapReplayAttempt[]; // 每一次"数据恢复后尝试回放"的记录，即使回放失败也要追加，不可覆盖
  resolvedAt: number | null;          // 若回放最终完整覆盖缺口并恢复正常扫描，记录时间；否则为null
  conservativeSettlementConfirmedAt: number | null; // 用户确认"保守结算"的时间，未确认为null
}

interface PaperDataGapReplayAttempt {
  attemptedAt: number;
  recoveredBarsFrom: number | null;   // 本次尝试实际取得的最早一根已收盘K线openTime
  recoveredBarsTo: number | null;
  coverageComplete: boolean;          // 是否完整覆盖了startTime到现在的缺口
  outcome: 'RESOLVED' | 'STILL_GAP';
}
```

### 3.3 `PaperFill` 接口（不可变成交记录）

```ts
interface PaperFill {
  fillId: string;                     // `PF-${time}-${随机后缀}`，全局唯一
  tradeId: string;
  fillType: 'OPEN' | 'ADD_ON' | 'PARTIAL_TP' | 'STOP_LOSS' | 'TAKE_PROFIT' | 'MANUAL_REDUCE' | 'MANUAL_CLOSE' | 'CONSERVATIVE_SETTLEMENT';
  side: 'BUY' | 'SELL';
  time: number;
  referencePrice: number;
  fillPrice: number;
  quantity: number;
  fee: number;
  slippageCost: number;
  realizedPnlDelta: number;           // Gross口径，OPEN/ADD_ON为0
  dataAsOf: number;
  barOpenTime: number | null;         // K线扫描型成交记录触发K线openTime；点击型成交为null
  idempotencyKey: string;             // 产生本次成交的操作幂等键（CEO决策第10项），供审计追溯
  immutable: true;
}
```

**不可变约束**：`fills` 数组只能 `push`，任何既有元素不得被修改或删除。

### 3.4 持仓状态机 `PositionStatus`（新增`UNRESOLVED_DATA_GAP`，CEO决策第6项）

```
NO_POSITION → PENDING_ENTRY → OPEN ⇄ PARTIALLY_CLOSED → EXITED
                     ↓                  ↓        ↓
                 CANCELLED       UNRESOLVED_DATA_GAP → EXITED（仅经§8保守结算）
（生成方案时V1.1权限被否决/数据失效）→ BLOCKED（瞬时，不落盘为Trade）
```

| 当前状态 | 触发事件 | 下一状态 | 说明 |
|---|---|---|---|
| `NO_POSITION` | 用户点击"生成方案"，V1.1许可满足 | `PENDING_ENTRY` | §6.1 |
| `NO_POSITION` | 用户点击"生成方案"，V1.1许可不满足 | `BLOCKED`（瞬时UI提示） | 不产生`PaperTrade`记录 |
| `PENDING_ENTRY` | 用户点击"确认开仓"，二次校验通过 | `OPEN` | 产生首笔`OPEN`成交 |
| `PENDING_ENTRY` | 用户取消，或方案过期未确认 | `CANCELLED` | 不产生任何`PaperFill` |
| `OPEN` | 触发止损或用户手动全部平仓 | `EXITED` | |
| `OPEN` | 触发首个目标位部分止盈 | `PARTIALLY_CLOSED` | |
| `OPEN` | 用户点击"确认加仓"且§5.2条件满足 | `OPEN`（`addOnCount+1`） | 不改变状态本身 |
| `PARTIALLY_CLOSED` | 继续触发止损/最终止盈/手动平剩余仓位 | `EXITED` | |
| `PARTIALLY_CLOSED` | 触发下一档部分止盈 | `PARTIALLY_CLOSED`（保持） | |
| `OPEN`/`PARTIALLY_CLOSED` | 数据恢复后§8回放确认缺口内出现且历史K线足以完整覆盖 | 恢复为回放前对应状态（`OPEN`或`PARTIALLY_CLOSED`），并把缺口期间应发生的成交按§6顺序补记 | 见§8.3 |
| `OPEN`/`PARTIALLY_CLOSED` | 数据恢复后§8回放确认缺口内历史K线**无法**完整覆盖 | `UNRESOLVED_DATA_GAP` | 见§8.4 |
| `UNRESOLVED_DATA_GAP` | 用户显式确认"保守结算" | `EXITED`（`closeReason='DATA_GAP_CONSERVATIVE'`，`estimated=true`，`verified=false`） | 见§8.5，唯一走出该状态的路径 |
| 任意非终态 | 账户重置 | （从localStorage中清空，不经过状态转换） | 见§2.4 |

`EXITED`/`CANCELLED`/`BLOCKED` 为终态。`UNRESOLVED_DATA_GAP`不是终态但**只有一条**合法出口（保守结算），期间不接受加仓/新的自动止损止盈扫描，仅接受"保守结算"确认这一个操作（连减仓/普通平仓也不再提供，因为一旦无法确认期间是否已发生成交，"部分/全部按当前价平仓"同样是在编造一个未经证实的成交顺序——只有§8.5定义的、使用"首个可获得的不利价格"的保守结算才被允许）。

---

## 4. 盈亏、手续费与滑点公式

### 4.1 未实现盈亏

```
多单：unrealizedPnl = (markPrice - entryPrice) × quantity
空单：unrealizedPnl = (entryPrice - markPrice) × quantity
```

`markPrice` 取值：账户估值刷新时刻（每次`v11decision`事件，约30秒一次）对应的V1.1决策 `d.price`（未收盘实时价）。`UNRESOLVED_DATA_GAP`状态下`unrealizedPnl`冻结为进入该状态前的最后一次估值（见§8.4），不再随行情刷新更新，UI必须显示"无法可靠估值"。

### 4.2 已实现盈亏（Gross口径）与买卖方向表

```
多单部分/全部平仓：realizedPnlDelta = (exitFillPrice - entryPrice) × closedQuantity
空单部分/全部平仓：realizedPnlDelta = (entryPrice - exitFillPrice) × closedQuantity
```

| 场景 | 方向 | `side` | 滑点不利方向 |
|---|---|---|---|
| 多单开仓/加仓 | 买入建仓 | `BUY` | 向上滑点 |
| 多单止损/止盈/减仓/平仓/保守结算 | 卖出平仓 | `SELL` | 向下滑点 |
| 空单开仓/加仓 | 卖出建仓 | `SELL` | 向下滑点 |
| 空单止损/止盈/减仓/平仓/保守结算（回补） | 买入平仓 | `BUY` | 向上滑点 |

### 4.3 加权平均建仓价（加仓时的成本基础方法）

V1.3 采用**加权平均成本法**，且加仓上限为1次（CEO决策第3项）：

```
addOn前：entryPrice_0，quantity_0
加仓：entryPrice_1（本次加仓成交价），quantity_1（≤initialQuantity，见§5.2条件6）
加仓后：quantity_new = quantity_0 + quantity_1
        entryPrice_new = (entryPrice_0 × quantity_0 + entryPrice_1 × quantity_1) / quantity_new
```

加仓**不产生** `realizedPnlDelta`。

### 4.4 手续费与滑点公式

```
fee = notional_of_this_fill × takerFeeRate
slippageAdjustment = referencePrice × (spreadRate/2 + slippageRate)
fillPrice = 多单买入/空单回补(BUY)  ? referencePrice + slippageAdjustment
          : 多单卖出/空单开仓(SELL) ? referencePrice - slippageAdjustment
slippageCost = |fillPrice - referencePrice| × quantity      // 报告口径，累计到slippageCostReport，见§2.2，不重复计入cash
```

**参数免责声明（强制文案，见§10）**：`当前手续费/点差/滑点参数为模拟假设，可在设置中调整，不代表Binance真实费率`。

---

## 5. 风险规则

### 5.1 单笔与试仓风险预算（红线，CEO决策第2项）

```
maxLossAmount(单笔) = equity_当前 × settings.maxRiskPct
maxLossAmount(试仓) = equity_当前 × settings.trialRiskPct
```

**红线**：风险预算计算**只能**使用§2.2定义的`equity`（当前净值，随已实现和未实现盈亏实时变化），**禁止**使用`initialCapital`（固定初始本金）、`notional`（名义本金）或任何经杠杆放大/缩小后的资金数字作为基准——这是CEO决策第2项的直接约束，`V1_3_ACCEPTANCE_TESTS.md`新增T23专项验证任意杠杆倍数下风险预算金额不变（只要`equity`不变）。

复用 `v1-core.js` 已导出的 `calcRiskBudget(entry, stop, settings, cost)` 作为核心求解公式：

```
C.calcRiskBudget(proposal.entryPrice, proposal.stop, {capital: equity_当前, maxRiskPct: settings.trialRiskPct或maxRiskPct, leverage: settings.leverage}, {takerFeeRate, spreadRate, slippageRate})
```

（`calcRiskBudget`内部形参名为`capital`，V1.3调用时传入的实参值是`equity_当前`而不是字面意义的"资本金"，这是刻意的调用方式，不代表`calcRiskBudget`本身需要修改——`v1-core.js`是冻结代码，只读调用。）

### 5.2 加仓风险预算（对应`STRATEGY_SPEC.md §8.2`原始意图，CEO决策第4项已给出精确化的统一止损口径，本节以CEO决策为准）

加仓允许的**全部**前提（逻辑与，缺一不可，均对应CEO决策第4项各条）：

1. **原仓位存在浮盈**：`unrealizedPnl > 0`（真实浮盈，由V1.3自己的持仓数据计算）。
2. **V1.1许可仍有效**：`!decision.isManual && decision.dataHealth==='normal' && decision.biasDirection===position.direction && !decision.opportunityScores.blocked`。
3. **专业加仓条件满足**：`decision.signalPermission.addOnAllowed===true`（仅`alignment==='full_aligned'`时为true）。
4. **原仓位止损已移动到成本调整后的保本位或更有利位置**：`currentStop`已满足§6.10定义的`calcBreakevenStop`所得价位（或更优，多单`currentStop>=breakevenStop`，空单`currentStop<=breakevenStop`）——成本调整保本位的精确公式见§6.10，**必须**计入开仓手续费、预计平仓手续费和实际滑点三项成本（CEO决策第4项第5点），不是简单的`entryPrice`。
5. `position.addOnCount === 0`（V1.3每笔交易**最多允许1次加仓**，红线，不可配置，CEO决策第3项）。
6. `addOnQuantity <= initialQuantity`（加仓仓位不超过首次试仓仓位）。
7. **统一止损口径下加仓后最坏损失不超过当前净值1%**（CEO决策第4项第6点，取代draft-1的"试仓风险+加仓风险分别求和"口径，因为`PaperTrade`本身只有一个`currentStop`字段，统一口径与实际schema一致）：
   ```
   entryPrice_new = 加仓后的加权平均建仓价（§4.3）
   quantity_new   = quantity_0 + addOnQuantity
   unifiedStop    = 加仓后生效的currentStop（必须仍然满足条件4的保本或更优要求）
   多单worstCaseLoss = max(0, (entryPrice_new - unifiedStop) × quantity_new)
   空单worstCaseLoss = max(0, (unifiedStop - entryPrice_new) × quantity_new)
   约束：worstCaseLoss <= equity_当前 × settings.maxRiskPct，否则拒绝加仓并给出超出的具体金额
   ```
8. **每次加仓必须由用户再次点击确认**，携带独立的`idempotencyKey`（§6.11），不存在任何自动加仓路径。

任一条件不满足，系统只能输出"禁止加仓"及具体原因，**不得**输出任何形式的"补仓/摊平"建议或按钮。

### 5.3 当日亏损锁定（CEO决策第8项：UTC自然日 + 确定性回退，不得用当前净值掩盖当日已有亏损）

```
dailyAnchorDateUTC：UTC自然日（'YYYY-MM-DD'，Date.prototype.toISOString().slice(0,10)口径）
```

**`dailyStartEquity`的重建公式（红线，同时覆盖"正常跨日"与"应用重新加载/首次启动缺快照"两种场景，不得分别处理导致口径不一致）**：

```
每次账户状态刷新时，若 当前UTC日期 !== account.dailyAnchorDateUTC，或account从未记录过dailyAnchorDateUTC（首次启动）：
  todayFills = 今天（UTC自然日）已经发生的全部PaperFill（跨全部PaperTrade）
  dailyStartEquity_new = equity_当前 - Σ(todayFills.realizedPnlDelta) + Σ(todayFills.fee)
  dailyAnchorDateUTC = 当前UTC日期
  dailyStartEquity = dailyStartEquity_new
```

**为什么不能直接用`equity_当前`作为`dailyStartEquity`**：如果账户在今天已经发生过成交（例如应用中途刷新/重启，或本来就是当天首次计算但当天已经有过实现盈亏），直接把"此刻的净值"当作"今天的期初净值"会把今天已经发生的已实现盈亏悄悄"清零"，导致`dailyRealizedLoss`计算基准错误、可能掩盖已经逼近或超过当日亏损上限的事实——这正是CEO决策第8项"不能使用当前净值掩盖当日已有亏损"要防止的场景。上述公式通过"从当前净值反减今天已经发生的已实现盈亏、反加今天已经发生的手续费"，精确重建出"如果今天还没发生任何成交，此刻净值本应是多少"，在正常跨日场景（`todayFills`为空）下自然退化为`dailyStartEquity_new=equity_当前`，与直觉一致；在应用重启/首次启动场景下则能正确追溯。

```
dailyLossLimit = dailyStartEquity × settings.dailyLossLimitPct
dailyRealizedLoss = max(0, dailyStartEquity - (dailyStartEquity + Σ(今天全部realizedPnlDelta) - Σ(今天全部fee)))
若 dailyRealizedLoss >= dailyLossLimit → riskRegime = 'DAILY_LOSS_LOCKED'（若当前不是更严重的FORCED_OBSERVATION）
```

只统计"当日已实现"部分，未实现浮亏不计入当日亏损锁定判断。`DAILY_LOSS_LOCKED`在下一个UTC自然日到来、`dailyAnchorDateUTC`翻转时自动解除（除非同时触发§5.4的总回撤锁定）。

**UI要求（CEO决策第8项）**：当日盈亏、当日锁定状态相关的时间边界必须**同时**显示UTC时间与用户本地时间（例如"当日基准：2026-07-15 00:00 UTC（本地时间 2026-07-15 08:00）"），不得只显示其中一个。

### 5.4 总回撤强制观察状态（CEO决策第1项，`peakEquity`定义已确定，不再是开放问题）

```
peakEquity_new = max(peakEquity_old, equity_当前)   // 每次估值刷新都检查，只增不减
drawdown = (peakEquity - equity_当前) / peakEquity
若 drawdown >= settings.maxDrawdownPct → riskRegime = 'FORCED_OBSERVATION'
```

**`peakEquity`只在账户重置时重建**（`peakEquity=initialCapital`，见§2.4b），除此之外**任何**操作——包括修改`initialCapital`、修改杠杆/费率设置、任何成交——都**不得**使`peakEquity`降低或被重新初始化为当前值（红线，CEO决策第1项原文"peakEquity只在账户重置时重置，普通入金参数修改不得静默重置"）。

`FORCED_OBSERVATION`状态**不会**自动解除——回撤是账户层面的严重信号，解除方式只能是：用户在UI显式点击"确认已了解风险并解除观察状态"的二次确认操作（携带`idempotencyKey`，写入`ethAlphaPaperLog`审计记录），或账户重置。

### 5.5 杠杆边界（红线）

```
leverage ∈ [1, 3]
margin = notional / leverage      // 杠杆只出现在这一个公式里
```

**杠杆绝不出现在**：`maxLossAmount`/加仓统一止损worstCaseLoss/`dailyLossLimit`/`drawdown`任何一个公式中——修改杠杆只改变`marginUsed`（从而改变`availableBalance`），不改变任何一笔交易允许亏损的绝对金额上限。`leverage`在单笔交易生命周期内**不可变**。

---

## 6. 模拟成交模型

### 6.1 交易方案生成（`TradeProposal`，不改变账户状态）

生成条件（逻辑与）：`!decision.isManual && decision.dataHealth==='normal' && decision.worthBetting===true && !decision.opportunityScores.blocked && decision.biasDirection in ['long','short'] && account.riskRegime !== 'FORCED_OBSERVATION' && account.riskRegime !== 'DAILY_LOSS_LOCKED' && 当前无OPEN/PARTIALLY_CLOSED/UNRESOLVED_DATA_GAP持仓（或该持仓方向与decision.biasDirection一致时走加仓方案）`。

`TradeProposal`字段：`direction`/`referencePrice`/`estimatedStop`（=`decision.stopLoss`）/`estimatedTargets`（=`decision.targets`）/`riskBudget`（§5.1）/`suggestedQuantity`/`suggestedNotional`/`suggestedMargin`/`generatedAt`/`expiresAt`（`generatedAt+120000`，2分钟有效期）/`proposalId`。

`TradeProposal`**只读展示**，不写入`ethAlphaPaperTrades`。

### 6.2 参考价与撮合时间

- **参考价`referencePrice`**：用户点击"确认"按钮那一刻，最近一次成功的V1.1刷新周期缓存的`decision.price`，**不额外发起新的网络请求**。
- **撮合时间**：与用户点击时间同步（点击型成交），或触发K线的`closeTime`（K线扫描型成交）。
- **陈旧行情禁止成交**：`decision.dataHealth!=='normal'`时，拒绝任何开仓/加仓/新止损止盈判定，仅允许对已有持仓做手动减仓/平仓（`UNRESOLVED_DATA_GAP`状态除外，见§3.4/§8，该状态下连普通手动平仓都不提供，只提供保守结算）。

### 6.3-6.4 滑点方向、手续费、市价单成交时间

见§4.4；所有点击型操作均为模拟市价单，`fillTime=Date.now()`。

### 6.5 REST轮询间隔（不新增）

V1.3完全复用V1.1既有的30秒`setInterval(refresh,30000)`刷新节奏，通过监听既有的`v11decision`事件驱动估值刷新与K线扫描，不新增任何独立定时器或网络请求。

### 6.6 止损/止盈判定：只用已收盘K线OHLC扫描

```
对每根待处理的新收盘K线bar（openTime递增顺序）：
  多单：hitStop = bar.low <= currentStop；hitTarget = bar.high >= 当前生效目标价
  空单：hitStop = bar.high >= currentStop；hitTarget = bar.low <= 当前生效目标价
  若hitStop && hitTarget同时为真 → 按§6.7只按止损处理
  否则若只有hitStop → 按§6.8处理；否则若只有hitTarget → 按§6.9处理
```

### 6.7 同一根K线止损与止盈冲突：按对账户更不利的结果处理

**红线**：`hitStop && hitTarget`同时成立时，**永远**按止损成交处理，不触发止盈。

### 6.8 止损成交与跳空规则

```
多单：gapped = bar.open < currentStop；基准价 = gapped ? bar.open : currentStop；fillPrice = 基准价 - 基准价×(spreadRate/2+slippageRate)
空单：gapped = bar.open > currentStop；基准价 = gapped ? bar.open : currentStop；fillPrice = 基准价 + 基准价×(spreadRate/2+slippageRate)
```

**红线**：跳空场景下禁止假设成交在原止损价，必须使用该根K线开盘后第一个可获得的价格作为不利滑点的基准价。

### 6.9 止盈成交规则：只按计划价格成交，不因有利跳空而改善

```
多单：fillPrice = target价格 - target价格×(spreadRate/2+slippageRate)
空单：fillPrice = target价格 + target价格×(spreadRate/2+slippageRate)
```

### 6.10 部分止盈、移动止损与"成本调整后保本位"精确公式（CEO决策第5项比例已定；决策第4项要求的保本位公式在此给出闭式解）

**三档部分止盈固定比例（基于`initialQuantity`，不随加仓重新计算百分比，避免精度漂移累积，CEO决策第5项）**：

```
tp1Qty = floor(initialQuantity × 0.50, quantityPrecision)   // 到达targets[0]时平仓
tp2Qty = floor(initialQuantity × 0.30, quantityPrecision)   // 到达targets[1]时平仓
第三档（到达targets[2]，或最终止损/手动平仓/保守结算）一律直接平掉"当前trade.quantity的全部剩余数量"，
  不再按"initialQuantity×0.20"重新计算——这是CEO决策第5项"必须处理数量精度和尾差，最后一次平仓清除全部剩余数量"的直接实现：
  只要最后一次平仓永远取"当前剩余的全部"而不是独立算出的一个数字，就不可能因为浮点数/取整误差residual出无法清空的尾差。
```

若加仓发生（只可能发生在`tp1`已触发之后，因为加仓前置条件4要求止损已移动到保本位，而V1.3唯一能把止损移动到保本位的路径就是§6.10本身在`tp1`触发时执行的移动止损——也即加仓在设计上只能发生在第一档部分止盈之后），加仓带来的新增数量`addOnQuantity`不单独定义自己的分批止盈档位，而是并入"剩余数量"，在`tp2`（仍按`initialQuantity×0.30`固定量结算，不含加仓部分）之后，最终随最后一档"清空当前剩余全部"一并了结——这样任何时候都不会因为加仓打乱百分比基准而产生对不上的尾差。

**移动止损规则**：
```
到达targets[0]（tp1成交后）：currentStop移动到calcBreakevenStop(trade)（见下方公式，即"成本调整后保本位"）
到达targets[1]（tp2成交后）：currentStop移动到targets[0]
```
移动止损只能同方向收紧或持平，不能放松（多单`currentStop`只能上移，空单只能下移）。

**`calcBreakevenStop(trade)`闭式解（CEO决策第4项：必须计入开仓手续费、预计平仓手续费和实际滑点三项成本）**：

记 `R = trade.realizedPnl - trade.fees`（已实现的Gross盈亏减去至今累计手续费，即"扣费后的实际到手结果"，含任何已经发生的部分止盈），`Q = trade.quantity`（当前剩余数量），`E = trade.entryPrice`（加权平均建仓价），`k = settings.spreadRate/2 + settings.slippageRate`（价格不利调整比例），`f = settings.takerFeeRate`：

```
多单：calcBreakevenStop = (E × Q − R) / (Q × (1−f) × (1−k))
空单：calcBreakevenStop = (R + E × Q) / (Q × (1+f) × (1+k))
```

**推导依据**：设该保本止损价为`S`，触发时的止损成交价（含§6.8不利滑点）为`stopFillPrice = S×(1−k)`（多单）或`S×(1+k)`（空单），平仓时还要再扣一次手续费`stopFillPrice×Q×f`。要求"如果现在按`S`止损离场，整笔交易含已实现部分在内的净结果=0"：

```
多单：R + (stopFillPrice − E) × Q − stopFillPrice × Q × f = 0
    ⟹ stopFillPrice × Q × (1−f) = E×Q − R
    ⟹ stopFillPrice = (E×Q−R) / (Q×(1−f))
    ⟹ S = stopFillPrice / (1−k) = (E×Q−R) / (Q×(1−f)×(1−k))

空单：R + (E − stopFillPrice) × Q − stopFillPrice × Q × f = 0
    ⟹ E×Q − stopFillPrice×Q×(1+f) + R = 0
    ⟹ stopFillPrice = (R+E×Q) / (Q×(1+f))
    ⟹ S = stopFillPrice / (1+k) = (R+E×Q) / (Q×(1+f)×(1+k))
```

`R=0`（无历史已实现盈亏）且`f=k=0`（零成本假设）时，两个公式均退化为`S=E`（即最朴素的"止损=入场价"），验证公式在退化情形下正确；`f,k>0`时，多单`S>E`（止损需高于入场价一点才能真正覆盖成本），空单`S<E`（止损需低于入场价一点），方向符合直觉。

### 6.11 幂等键防重复操作（CEO决策第10项，覆盖全部五种操作：开仓/加仓/减仓/平仓/重置）

```
account.actionLock: boolean   // 账户级互斥锁，任意一次上述五种操作执行期间为true，函数第一条语句同步检查并设置，finally中释放
```

**幂等键机制（真正的幂等语义，不是简单的"第二次拒绝"）**：每次调用开仓/加仓/减仓/平仓/重置对应的核心函数，调用方（UI）必须传入一个稳定的`idempotencyKey`（建议：开仓/加仓复用`proposalId`；减仓/平仓/重置由UI在用户点击的瞬间生成一个随机串并在该次点击的所有重试中保持不变）。核心函数处理逻辑：

```
若 idempotencyKey 已存在于 account.processedIdempotencyKeys（或对应PaperFill/PaperLog历史记录中可查到）：
  不重新执行任何状态变更，直接返回**上一次**该key执行时的结果（从PaperFill/PaperLog中还原，保证多次调用幂等）
否则：
  正常执行操作，成功后把该key追加进processedIdempotencyKeys（有界环形缓冲，例如保留最近500个，足够覆盖"网络抖动导致的短时间重试"场景，不需要无限增长）
```

这与draft-1"一次性方案消费+拒绝重复"的设计相比，多了"重复调用返回原结果而不是报错"这一层——对UI更友好（用户重复点击不会看到一个困惑的错误提示，而是看到和第一次一样的成功结果），且明确覆盖了draft-1未覆盖的减仓/平仓/重置三种操作。

### 6.12 价格精度、数量精度与最小名义价值

（与draft-1一致，未变更）

```
价格精度：round(price, pricePrecision)
数量精度：floor(quantity, quantityPrecision)（向下取整，防止超出风险预算）
最小名义价值：quantity × entryPrice >= settings.minNotional（默认20 USDT），否则拒绝开仓/加仓
```

**声明**：以上精度与最小名义价值为V1.3模拟假设，不调用币安`exchangeInfo`接口获取真实交易规则。

### 6.13 离场原因枚举

`STOP_LOSS` | `TAKE_PROFIT`（含分批） | `MANUAL_CLOSE` | `MANUAL_REDUCE`（部分） | `DATA_GAP_CONSERVATIVE`（新增，CEO决策第6项，见§8.5）。

---

## 7. 与V1.1/V1.2联动

### 7.1 权限边界（红线）

- V1.1负责：交易许可、方向、试仓/加仓结构性条件、止损、离场条件文案。V1.3**只读消费**，不重新计算、不覆盖。
- V1.2负责：情景推演，**只能**作为`PaperTrade.forecastSnapshot`的只读存档字段，**不得**出现在任何开仓/加仓/减仓/平仓的条件判断表达式里。
- 数据失败时：禁止新开仓、禁止加仓，已有仓位保留但标记"无法可靠估值"（§8）。

### 7.2 建仓快照冻结（红线）

```
decisionSnapshot = deepClone(decision)   // JSON.parse(JSON.stringify(decision))
forecastSnapshot = window.__prevForecast ? deepClone(window.__prevForecast) : null
```

**必须深拷贝，不得只保存对象引用**（技术依据见draft-1对`v1-core.js`原地属性赋值模式的分析，本轮未变）。

### 7.3 事件时序要求

V1.3的`v11decision`监听器必须在构建产物中位于V1.2预测脚本块**之后**，保证`window.__prevForecast`先于V1.3读取完成更新。

---

## 8. 异常与恢复规则（CEO决策第6项，`UNRESOLVED_DATA_GAP`完整流程）

### 8.1 数据失败时禁止新开仓/加仓

`decision.dataHealth!=='normal'`或`decision.isManual===true`时，`TradeProposal`生成条件与加仓条件均为假。

### 8.2 数据失败期间：保留已有仓位，标记无法可靠估值

`window.invalidateDashboard`触发时，已有`OPEN`/`PARTIALLY_CLOSED`仓位：

- `unrealizedPnl`/`markPrice`冻结为最后一次成功估值的数值，UI强制附加"无法可靠估值"标签与失效原因。
- **不**清空持仓本身。
- **不**执行§6.6的K线扫描。
- 若此次失效尚未产生`trade.dataGap`记录，则创建一条：`dataGap={startTime:Date.now(), detectedAt:Date.now(), missingBarCount:null, replayAttempts:[], resolvedAt:null, conservativeSettlementConfirmedAt:null}`。

### 8.3 数据恢复后优先获取缺失K线，按时间顺序逐根回放（不得伪造成交顺序）

数据恢复（下一次`dataHealth==='normal'`）后：

1. 取出`trade.lastScannedBarOpenTime`，与本次恢复后`marketData.eth.tf15m`中**全部**`isClosed===true`且`openTime>lastScannedBarOpenTime`的K线。
2. 若这些K线**完整覆盖**从`dataGap.startTime`对应的应有K线到现在（即不存在"应该有但取不到"的中间空洞——通过比较`openTime`序列是否等间隔`TF_MS['15m']`连续判断），记为一次成功的`replayAttempt`（`coverageComplete:true`），按§6.6-6.9顺序**逐根**扫描执行原有止损/止盈/同K线冲突/跳空规则，扫描完成后：
   - 若期间未触发任何止损/止盈：状态恢复为回放前状态（`OPEN`或`PARTIALLY_CLOSED`），`dataGap.resolvedAt=Date.now()`，恢复正常估值与后续自动扫描。
   - 若期间触发了止损/止盈：按§6.7-6.9规则正常产生`PaperFill`并推进状态（可能变为`EXITED`/`PARTIALLY_CLOSED`），同样视为缺口已解决（`dataGap.resolvedAt=Date.now()`），因为这些成交本身就是"如实回放"而不是"伪造"——伪造指的是跳过回放直接假设"一切正常"，不是指"回放后确实发现触发了止损"这件事本身。
3. 若这些K线**不能完整覆盖**缺口（`fetchAllTimeframeKlines`固定窗口大小导致早期K线已经滑出可获取范围），记为`coverageComplete:false`的`replayAttempt`，`missingBarCount`按能确定的缺口跨度估算，状态变为`UNRESOLVED_DATA_GAP`（见§8.4），**不得**假装没有发生任何触发直接按最新价格继续计算浮动盈亏。

`replayAttempts`数组**每次尝试都追加一条**，即使是`STILL_GAP`结果也要记录，不可覆盖或删除历史尝试记录（供审计"系统确实多次尝试过回补，不是消极放弃"）。

### 8.4 `UNRESOLVED_DATA_GAP`状态下的行为限制

- 不接受加仓、普通减仓、普通平仓——因为一旦无法确认缺口期间是否已经发生真实成交，"当前quantity/entryPrice/currentStop"这些字段本身的正确性已经存疑，任何"部分平仓"操作都需要先假设这些字段仍然可信，这与"不得伪造成交顺序"的精神矛盾。
- 唯一允许的操作是§8.5"确认保守结算"。
- 每次新的`v11decision`事件到来时，仍然尝试§8.3的回放（万一后续又有新的历史窗口数据能覆盖，虽然实际上`fetchAllTimeframeKlines`固定窗口向前滑动通常不会让更早的缺口重新变得可获取，但不排除未来实现变化，此项检查保留作为兜底，不作为主要解决路径）。

### 8.5 用户确认"保守结算"（唯一走出`UNRESOLVED_DATA_GAP`的路径）

```
confirmConservativeSettlement(trade, idempotencyKey): {ok, trade?, reason?}
```

- 只能由用户在UI显式点击"确认保守结算"触发，文案必须包含"数据缺口无法完整回补，本次平仓按缺口后首个可获得的不利价格结算，结果仅为估算，不代表真实应得盈亏"。
- 成交价：`fillPrice`取"缺口结束后**第一根**可获得的已收盘K线"的`open`价格（即"首个可获得的价格"），再按§4.4方向应用不利滑点——多单按SELL方向向下不利滑点，空单按BUY方向向上不利滑点。
- `fillType='CONSERVATIVE_SETTLEMENT'`，`closeReason='DATA_GAP_CONSERVATIVE'`。
- 平仓后该笔`PaperTrade`：`status='EXITED'`、`estimated=true`、`verified=false`、`dataGap.conservativeSettlementConfirmedAt=Date.now()`。
- **红线**：任何当前或未来（V1.4+）在V1.3日志基础上计算的策略胜率、平均盈亏比、预测准确率等统计，**必须**先过滤掉`estimated===true`的交易，不得混入——V1.3自身当前不计算任何此类统计，但导出的`PaperTrade`记录必须让下游消费者能够依据`estimated`/`verified`两个字段可靠地做这个过滤，这是这两个字段存在的唯一目的。
- 审计日志（`ethAlphaPaperLog`）必须为该笔交易保留：`dataGap.startTime`（缺口起点）、`dataGap.replayAttempts`（全部回补尝试，含时间与结果）、`dataGap.conservativeSettlementConfirmedAt`（用户确认时间）——三者缺一不可，供事后核查"这不是系统随便决定的，而是完整记录了不可抗力+用户知情确认"。

---

## 9. localStorage Schema 与迁移版本

### 9.1 命名空间

| Key | 内容 | 类型 |
|---|---|---|
| `ethAlphaPaperAccount` | 单个`PaperAccount`对象 | Object |
| `ethAlphaPaperTrades` | `PaperTrade[]`（含各自内嵌的`fills`与`dataGap`） | Array |
| `ethAlphaPaperLog` | 扁平审计日志数组 | Array |

### 9.2 损坏JSON、容量不足与字段版本不兼容的安全降级

（与draft-1一致，未变更，见§9.2原文逻辑：JSON.parse失败视为空/默认重建；`QuotaExceededError`返回`{ok:false,reason:'模拟交易存储空间不足'}`且不阻塞内存态；未知`schemaVersion`按默认值重建并写`SCHEMA_MISMATCH`审计记录。）

### 9.3 迁移函数与版本号

`v1.3-account-2`/`v1.3-trade-2`/`v1.3-log-2`（本轮字段变更——`peakEquity`/`availableBalance`/`realizedPnlGross`/`slippageCostReport`重命名、新增`estimated`/`verified`/`dataGap`/`processedIdempotencyKeys`等字段——相对draft-1的`v1.3-account-1`/`v1.3-trade-1`/`v1.3-log-1`递增了schema版本号，`migratePaperAccount`/`migratePaperTrades`必须包含`v1.3-account-1→v1.3-account-2`/`v1.3-trade-1→v1.3-trade-2`的显式迁移分支：`availableCash`字段丢弃（不再持久化存储，改为运行时按公式计算，不落盘）、`equityHighWaterMark`→`peakEquity`直接更名保留数值、`realizedPnlTotal`→`realizedPnlGross`直接更名保留数值、`slippageCostTotal`→`slippageCostReport`直接更名保留数值，`estimated`/`verified`默认补`true`（历史记录一律视为非估算）、`dataGap`默认补`null`、`processedIdempotencyKeys`默认补`[]`）。

---

## 10. UI 区域字段规范

新增中文区域标题："**500 USDT模拟交易账户**"（若`initialCapital`被用户修改，标题动态显示为"**{initialCapital} USDT模拟交易账户**"），独立的`<article class="card span12">`，置于V1.2走势预测区域下方。

**常驻文案**：`模拟交易，不是真实下单，不连接交易所账户。`

必须显示的字段：

| 字段 | 中文文案 | 数据来源 |
|---|---|---|
| 账户初始资金 | 账户初始资金 | `account.initialCapital` |
| 可用余额 | 可用余额 | `equity - marginUsed`（§2.2，**不是**`cash-marginUsed`） |
| 冻结保证金 | 冻结保证金 | `account.marginUsed` |
| 当前净值 | 当前净值（模拟） | `equity` |
| 已实现盈亏 | 累计已实现盈亏（税前，即扣手续费前） | `account.realizedPnlGross` |
| 未实现盈亏 | 当前未实现盈亏 | `Σ unrealizedPnl` |
| 累计手续费 | 累计手续费 | `account.feesTotal` |
| 累计滑点 | 累计滑点成本（模拟，仅供参考） | `account.slippageCostReport` |
| 当日盈亏 | 当日盈亏 | `equity - account.dailyStartEquity` |
| 当日/回撤时间边界 | 当日基准：{UTC日期} 00:00 UTC（本地时间 {本地时间}） | §5.3，**必须同时显示UTC与本地时间** |
| 最大回撤 | 最大回撤（历史净值峰值口径） | `drawdown`（§5.4，基准为`peakEquity`） |
| 当前风险状态 | 风险状态：正常 / 当日亏损已锁定 / 强制观察中 | `account.riskRegime` |
| 当前模拟仓位 | 当前模拟仓位（含"数据缺口待处理"状态提示） | `PaperTrade`，`status==='UNRESOLVED_DATA_GAP'`时需醒目提示并只提供"确认保守结算"按钮 |
| 开仓/加仓/减仓/平仓按钮 | 生成方案 / 确认开仓 / 确认加仓 / 减仓 / 平仓 / 确认保守结算 | 各自前置条件禁用逻辑见§5-§8 |
| 风险预算计算 | 本次风险预算（基于当前净值） | `calcRiskBudget`结果，UI必须显式标注"基于当前净值计算，非固定初始本金" |
| 模拟成交记录 | 模拟成交记录 | `PaperTrade.fills` |
| 模拟交易日志 | 模拟交易日志 | `ethAlphaPaperLog` |
| JSON/CSV导出 | 导出JSON / 导出CSV | 导出字段须含`estimated`/`verified`，供下游过滤 |
| 重置账户按钮 | 重置模拟账户 | 二次确认+`idempotencyKey`，见§2.4/§6.11 |

**禁止措辞**：不得出现"稳赚""必涨""必跌""保证盈利""跟单必赚"；净值/盈亏相关数字必须在同一屏幕内与常驻免责声明共同出现。

---

## 11. 函数接口清单

```
loadPaperAccount(storage): PaperAccount
savePaperAccount(account, storage): {ok, reason?}
validatePaperAccountSettings(settings): {ok, value?, message?}
resetPaperAccount(storage, confirmFn, idempotencyKey): PaperAccount
changeInitialCapital(storage, newCapital, confirmFn, alsoReset, idempotencyKey): {ok, account?, reason?}

buildTradeProposal(decision, account, direction): TradeProposal | {ok:false, reason}
confirmOpenPosition(proposal, decision, forecast, account, storage, idempotencyKey): {ok, trade?, reason?}
confirmAddOn(trade, decision, account, storage, idempotencyKey): {ok, trade?, reason?}
confirmReduce(trade, quantity, decision, account, storage, idempotencyKey): {ok, trade?, reason?}
confirmClose(trade, decision, account, storage, idempotencyKey): {ok, trade?, reason?}
confirmConservativeSettlement(trade, account, storage, idempotencyKey): {ok, trade?, reason?}
confirmForcedObservationAcknowledgement(account, storage, idempotencyKey): {ok, account?, reason?}

scanClosedBarsForExits(trade, newClosedBars, account, storage): {ok, trade?, fills?}
replayDataGap(trade, marketData, account, storage): {ok, trade?, coverageComplete}
calcBreakevenStop(trade, settings): number
calcRiskRegime(account): PaperAccount['riskRegime']
calcUnrealizedPnl(trade, markPrice): number
calcDrawdown(account): {drawdown, peakEquity}
calcDailyStartEquity(account, todayFills): number

exportPaperLogsJSON(trades, log): string
exportPaperLogsCSV(trades, log): string

migratePaperAccount(raw): PaperAccount
migratePaperTrades(raw): PaperTrade[]
```

所有函数均为纯函数或"输入当前状态+副作用限定在传入的storage参数"风格，不得直接引用全局`window.localStorage`。

---

## 12. 版本号红线

```
PAPER_SCHEMA_VERSION = 'v1.3-account-2' / 'v1.3-trade-2' / 'v1.3-log-2'
PAPER_ALGORITHM_VERSION = 'v1.3-draft-2'
```

任何修改§5风险预算数值默认值、§4手续费滑点公式、§6撮合规则（含§6.10保本位公式）的提交，必须同步递增`PAPER_ALGORITHM_VERSION`，并在`V1_3_ACCEPTANCE_TESTS.md`增补对应回归用例。版本校验测试必须使用独立硬编码基准值，不得从运行时对象自证式反算（比照`CLAUDE_CODE_REVIEW_V1_2_FINAL.md`关闭的P1-3经验）。

---

## 13. 需要CEO确认的问题（draft-1的7项已全部由CEO决策关闭，本节归零；若实现阶段浮现新的开放问题，将在后续版本追加）

无（draft-1列出的7项开放问题——总回撤基准、风险预算基准、加仓次数上限、加仓保本前置、部分止盈比例、数据中断降级策略、历史文档措辞——均已由CEO在本轮逐条决策，见§14变更记录逐项对照）。

---

## 14. 变更记录

- v1.3-draft-1：首次交付，基于main分支`v1.2.0`标签独立设计。
- v1.3-draft-2（本版本）：CEO七项决策+三项统一规则全部落地：
  1. 总回撤基准确定为`peakEquity`（历史最高净值），且明确只在账户重置时重建（§5.4/§2.4）。
  2. 单笔1%/试仓0.5%风险预算基准确定为当前净值`equity`，禁止使用名义本金/杠杆后资金/固定初始本金（§5.1，红线）。
  3. 加仓次数上限确定为每笔交易最多1次，不可配置（§5.2条件5）。
  4. 加仓前置条件精确化：浮盈+V1.1许可+专业加仓条件+止损已达成本调整保本位+统一止损口径下加仓后最坏损失≤当前净值1%+用户再次点击确认+禁止摊平（§5.2），并给出`calcBreakevenStop`闭式解（§6.10）。
  5. 部分止盈比例确定为50/30/20，且明确最后一档清空全部剩余数量以避免精度尾差（§6.10）。
  6. 新增`UNRESOLVED_DATA_GAP`状态与完整的数据缺口检测/回放/保守结算流程，新增`estimated`/`verified`字段与`closeReason='DATA_GAP_CONSERVATIVE'`（§3.4/§8）。
  7. 历史文档"模拟仓位=V3"过时措辞已同步修订（见本次提交对8份历史文档的追加说明，不改变V1.1/V1.2规范和代码）。
  8. 当日亏损锁定改为UTC自然日+确定性`dailyStartEquity`重建公式，UI同时显示UTC与本地时间（§5.3）。
  9. 账户会计字段重命名并明确公式：`equity`/`cash`/`availableBalance`（=`equity-marginUsed`，非`cash-marginUsed`）/`marginUsed`/`realizedPnlGross`/`unrealizedPnl`/`feesTotal`/`slippageCostReport`（§2.2）。
  10. 引入统一的`idempotencyKey`机制，覆盖开仓/加仓/减仓/平仓/重置全部五种操作，具备真正的幂等重放语义（§6.11）。
