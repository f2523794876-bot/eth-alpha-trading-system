# V1_3_PAPER_TRADING_SPEC.md — ETH Alpha V1.3「真实行情模拟交易系统」算法与数据规范

版本：v1.3-draft-1
角色：本文档只做 V1.3「模拟交易账户」的**架构设计与验收规范**，不是实现代码，也不由本文档作者实现正式业务代码。
基准：main 分支 `v1.2.0` 标签（提交 `0dc1943`），本文档在 V1.1（`v1-core.js`，冻结）与 V1.2（`v1_2-forecast-core.js`，冻结）之上做**纯叠加**，不修改、不重写两者已验收的任何函数或算法。
唯一算法真相来源声明：本文档是 V1.3 模拟交易算法的唯一 source of truth。`V1_3_CODEX_IMPLEMENTATION_TASK.md` 的函数接口必须实现本文档定义的行为；`V1_3_ACCEPTANCE_TESTS.md` 的用例必须验证本文档定义的规则；`V1_3_ARCHITECTURE_REVIEW.md` 负责核对三者与 V1.1/V1.2/STRATEGY_SPEC.md 的一致性。四份文档如有冲突，以本文档为准。

**常驻免责声明（强制，任何页面状态下都必须可见，见§10）**：`模拟交易，不是真实下单，不连接交易所账户。`

---

## 0. 范围与既有文档的关系（必须先读，避免与历史结论冲突）

### 0.1 这是一次刻意的范围拆分，不是范围蔓延

`CODEX_IMPLEMENTATION_TASK.md`（V1）第1.4节、`STRATEGY_SPEC.md` 第936行、`V1_2_CODEX_IMPLEMENTATION_TASK.md` 第30/247行此前均把"模拟仓位（Paper Position Tracking）"与 WebSocket、条件提醒推送、长期运行监控四项**打包**列为"V3范围，V1/V2阶段禁止实现"。

本轮由CEO明确决策：**把"模拟仓位追踪"从原V3的四件套里单独拆出，提前作为独立的 V1.3 阶段实现**；WebSocket、条件提醒推送（`Notification` 主动推送）、长期运行监控**仍然留在未来某个V3阶段**，不因本次拆分被误认为一并提前——V1.3**不实现**这三项，任何実现都视为范围蔓延。历史文档中"模拟仓位=V3范围"的措辞在本次拆分后已过时，但按任务要求本轮只新增四份V1.3文档、不回头修改历史文档，此项不一致记录在 `V1_3_ARCHITECTURE_REVIEW.md` 供CEO决定是否回填修订历史文档。

### 0.2 与 `CODEX_IMPLEMENTATION_TASK.md` 第54/145行早期"模拟仓位"草稿概念的关系

V1 阶段文档曾用一句话粗略勾勒过"模拟仓位"概念（用户标记"如果此刻按建议开仓"，系统虚拟记录方向/开仓价/止损/目标，tick级比对浮动盈亏，触及止损/目标自动标记平仓结果并写回决策日志的 `outcome` 字段）。**本文档定义的 V1.3 系统在范围和数据结构上完全取代该草稿概念**：V1.3 是独立账户（现金/保证金/净值/已实现/未实现/手续费/滑点/回撤全套记账）+ 独立 localStorage 命名空间 + 独立状态机 + 独立日志，不是"写回决策日志的一个字段"。后续任何文档提到"模拟仓位"，均以本文档为准。

### 0.3 V1.3 不做的事（与用户需求第八节禁止事项一一对应）

不自动下真实订单；不读取/存储任何交易所API密钥；不连接用户真实交易所账户；不承诺盈利或给出保证性措辞；不允许亏损摊平；不允许用杠杆扩大风险预算（杠杆只影响保证金占用，见§5.5）；不修改 `v1-core.js`/`v1_2-forecast-core.js` 已验收的任何函数体；不实现V2历史校准（`outcomeAfter*Bar`/Brier/校准曲线）；不实现WebSocket、条件提醒推送（`Notification`）、长期运行监控；不在无用户点击确认的情况下自动建立模拟仓位——**任何**模拟开仓、加仓、减仓、平仓函数在设计上都必须要求一个只能来自真实用户点击事件的 `confirmationToken`/等价证据作为参数，不得由定时器或数据刷新回调直接调用。

---

## 1. 术语与数据结构总览

| # | 术语 | 定义 | 归属 | 字段/接口 |
|---|---|---|---|---|
| 1 | 模拟账户 Account | V1.3 唯一的虚拟资金主体，USDT计价，不对应任何真实资金 | V1.3新增 | `PaperAccount`，见§2 |
| 2 | 模拟合约语义 | "模拟USDT本位永续合约"记账方式（cash/equity/margin分离），但不实现真实合约的强平、资金费、逐仓/全仓切换 | V1.3新增 | 见§2.3 |
| 3 | 持仓 Position | 账户当前对ETH的方向性敞口（同一时刻至多一个方向，见§3.1） | V1.3新增 | `PaperPosition`，见§3 |
| 4 | 交易 Trade | 一次持仓从建立到彻底了结（含期间的加仓、部分止盈）的完整生命周期记录 | V1.3新增 | `PaperTrade`，见§3.2 |
| 5 | 成交 Fill | 一次不可变的撮合执行事件（开仓/加仓/部分平仓/止损/止盈/手动平仓） | V1.3新增 | `PaperFill`，见§3.3 |
| 6 | 交易方案 Proposal | 系统基于当前V1.1决策生成、等待用户点击确认的"如果开仓将会是这样"的只读预览，本身不改变账户状态 | V1.3新增 | `TradeProposal`，见§6.1 |
| 7 | 风险预算 Risk Budget | 单笔/试仓/加仓允许的最大亏损金额，来自账户净值与风险比例 | V1.3新增，复用 `C.calcRiskBudget` 核心公式 | 见§5 |
| 8 | 风险状态 Risk Regime | 账户当前是否允许新开仓/加仓的宏观状态（正常/日亏损锁定/回撤强制观察） | V1.3新增 | `PaperAccount.riskRegime`，见§5.4 |
| 9 | V1.1决策快照引用 | 建仓时刻 `d`（`buildDecision`输出）的**深拷贝**只读快照 | 只读消费V1.1 | 见§7.2 |
| 10 | V1.2预测快照引用 | 建仓时刻 `window.__prevForecast`（`F.buildForecast`输出）的**深拷贝**只读快照 | 只读消费V1.2 | 见§7.2 |
| 11 | 数据截止时间 | 建仓/成交判定所依据的最后一根**已收盘**15分钟K线的 `closeTime` | 只读消费V1.1 | `PaperFill.dataAsOf` |

**强制措辞规则**：V1.3 任何界面文案不得出现"稳赚""必涨""必跌""保证盈利""跟单必赚"等承诺性表述；净值/盈亏数字必须始终标注"模拟"二字或与常驻免责声明同屏出现。

---

## 2. 账户模型

### 2.1 `PaperAccount` 接口

```ts
interface PaperAccount {
  schemaVersion: string;            // 'v1.3-account-1'，字段增删必须递增，见§9.3
  algorithmVersion: string;         // 'v1.3-draft-1'，对应本文档版本，规则变化必须递增
  createdAt: number;                 // 账户首次创建时间（首次写入localStorage的时间）
  resetCount: number;                // 账户被重置的次数，重置不清零该计数本身
  currency: 'USDT';                  // 恒定
  initialCapital: number;            // 当前生效的初始本金，默认500，可修改（需二次确认，见§2.4）
  cash: number;                      // walletBalance：现金余额，只受已实现盈亏/手续费影响，不受浮动盈亏影响
  marginUsed: number;                // 当前所有未平仓position占用的保证金合计，见§2.3
  realizedPnlTotal: number;          // 累计已实现盈亏（含历史所有已平仓/部分平仓部分）
  feesTotal: number;                 // 累计手续费（USDT，正数，表示已扣除的成本）
  slippageCostTotal: number;         // 累计滑点成本（USDT，正数，纯报告字段，见§4.4，不重复计入cash）
  equityHighWaterMark: number;       // 账户净值历史最高点，用于最大回撤计算，见§5.4
  dailyAnchorDateUTC: string;        // 'YYYY-MM-DD'，当前生效的UTC自然日锚点，见§5.3
  dailyStartEquity: number;          // 当前UTC自然日开始时刻的净值快照
  riskRegime: 'NORMAL' | 'DAILY_LOSS_LOCKED' | 'FORCED_OBSERVATION'; // 见§5.4
  settings: PaperAccountSettings;    // 见2.2
  updatedAt: number;                 // 最近一次账户状态变化时间
}

interface PaperAccountSettings {
  leverage: number;                  // 1~3（含），默认1，见§5.5
  maxRiskPct: number;                // 单笔最大风险占净值比例，默认0.01（1%）
  trialRiskPct: number;              // 小仓试错风险占净值比例，默认0.005（0.5%）
  dailyLossLimitPct: number;         // 当日最大已实现亏损占"当日期初净值"比例，默认0.03（3%）
  maxDrawdownPct: number;            // 触发强制观察的回撤比例（相对equityHighWaterMark），默认0.10（10%）
  takerFeeRate: number;              // 单边手续费率，默认0.0005，对齐 `v1-core.js` COST_DEFAULT.takerFeeRate
  spreadRate: number;                // 点差率，默认0.0002，对齐 COST_DEFAULT.spreadRate
  slippageRate: number;              // 滑点率，默认0.0003，对齐 COST_DEFAULT.slippageRate
  pricePrecision: number;            // 价格小数位，默认2
  quantityPrecision: number;         // 数量小数位，默认3
  minNotional: number;               // 最小名义价值USDT，默认20
}
```

**默认值一览（对应用户需求第一/二/三节）**：

| 字段 | 默认值 | 500 USDT账户对应数值 |
|---|---:|---|
| `initialCapital` | 500 | — |
| `leverage` | 1（上限3） | — |
| `maxRiskPct` | 0.01 | 约5 USDT |
| `trialRiskPct` | 0.005 | 约2.5 USDT |
| `dailyLossLimitPct` | 0.03 | 约15 USDT（以当日期初净值计） |
| `maxDrawdownPct` | 0.10 | 约50 USDT（以净值历史最高点计，见§5.4说明） |
| `takerFeeRate` / `spreadRate` / `slippageRate` | 0.0005 / 0.0002 / 0.0003 | 与 `v1-core.js COST_DEFAULT` 完全一致，仅为模拟假设，**不代表Binance真实费率**，必须允许用户调整（复用 `C.validateRiskSettings` 同款校验风格，见§11） |

### 2.2 账户会计恒等式（红线，任何实现分支都不得违反）

```
equity(净值)        = cash + Σ(unrealizedPnl_i)          对所有当前OPEN/PARTIALLY_CLOSED的position i
availableCash(可用资金) = cash - marginUsed
marginUsed          = Σ(notional_i / leverage_i)          对所有当前OPEN/PARTIALLY_CLOSED的position i
cash                = initialCapital + realizedPnlTotal - feesTotal
```

`slippageCostTotal` **不**是独立的现金流，它是"如果没有滑点本应获得的价格"与"实际成交价"之差乘以数量的**报告统计口径**，滑点的实际财务影响已经体现在 `realizedPnlTotal`/`unrealizedPnl` 里（因为PnL用的就是含滑点的成交价），因此**不得**从 `cash` 里再单独扣一次 `slippageCostTotal`，否则会重复扣减（红线，见§12验收测试T4会专项验证不重复扣减）。

`unrealizedPnl` 恒等式与逐方向公式见§4.1；`equityHighWaterMark`/回撤定义见§5.4。

任何时刻必须满足 `cash >= 0` 且 `marginUsed <= cash`（否则视为实现错误，风险预算与保证金校验必须在成交前拦截，不允许成交后账户出现负现金或保证金超过现金的状态，见§6.7精度与最小名义价值中的前置校验顺序）。

### 2.3 "模拟USDT本位合约"语义边界

V1.3 采用与真实币安USDT本位永续合约类似的**记账语义**（cash/equity/margin分离、杠杆只影响保证金占用），但**不**实现：强平价计算、强平机制本身、资金费率结算（`fundingRate` 恒为0，仅预留字段对齐 `v1-core.js COST_DEFAULT.fundingRate` 与 `STRATEGY_SPEC.md §10.1b`）、逐仓/全仓模式切换、多币种保证金。V1.3 只有ETH一个交易标的，且同一时刻只允许一个方向的持仓（不支持同时多空对冲，见§3.1）。

**强平相关红线**：`STRATEGY_SPEC.md` 第20节已明确"本系统不追踪保证金、不计算强平价、不提供杠杆倍数建议"是V1/V2的边界；V1.3 是第一个真正冻结保证金的阶段，但**仍然不计算强平价、不模拟强制平仓**——`marginUsed` 只是一个记账占用数字，不会触发自动平仓；账户风险完全由§5的风险预算/日亏损/回撤规则控制，而不是靠模拟交易所强平。这样设计的原因：真实强平机制依赖标记价格、维持保证金率等币安私有参数，V1.3 无法可靠模拟，为避免"模拟强平"给用户错误的安全感或恐慌，V1.3 明确不做这件事，只在文档和UI里如实说明。

### 2.4 初始本金修改与账户重置

- 修改 `initialCapital`：只允许在**当前无任何OPEN/PARTIALLY_CLOSED持仓**时进行（否则历史持仓的 `marginUsed`/`riskBudget` 基准会失去意义）；修改流程必须是**两步**：第一次点击弹出确认对话（展示"当前将从X USDT改为Y USDT，账户其余累计统计是否保留"的选择），第二次显式确认后才生效。修改本金**不会**重置 `cash`/`realizedPnlTotal`/`feesTotal`/`equityHighWaterMark` 等历史累计字段，只改变 `initialCapital` 本身用于风险比例计算的基准，以及后续 `dailyStartEquity` 的下一次锚点计算基础——**除非**用户在确认对话中显式选择"同时重置账户"（等价于走§2.4b重置流程）。
- 重置账户：必须两步确认（同上模式，第二次确认文案必须显式包含"将清空全部模拟持仓、成交记录与统计数据，且不可恢复"字样）。重置后：`cash=initialCapital`、`marginUsed=0`、`realizedPnlTotal=0`、`feesTotal=0`、`slippageCostTotal=0`、`equityHighWaterMark=initialCapital`、`riskRegime='NORMAL'`、`dailyStartEquity=initialCapital`、`dailyAnchorDateUTC=`当天、`resetCount+=1`；`ethAlphaPaperTrades`/`ethAlphaPaperLog` 两个localStorage key**清空为空数组**（不是删除key，避免§9降级逻辑对"key不存在"和"key为空数组"产生歧义）。重置操作本身必须在 `ethAlphaPaperLog` 里写入一条不可删除的审计记录（`type:'ACCOUNT_RESET'`），该记录写在**清空之后**，因此清空后的日志数组第一条就是这次重置记录。

---

## 3. 持仓、交易与成交模型

### 3.1 持仓并发范围

V1.3 同一时刻**至多一个** `PaperPosition`（ETH，多或空二选一，不支持同时反向对冲）。这与V1.1同一时刻只给出一个 `biasDirection` 的设计天然一致（`STRATEGY_SPEC.md`/`v1-core.js` 从不同时输出多空两个"当前建议方向"）。已有反方向持仓时禁止开立新方向仓位——用户必须先平掉当前持仓，才能在系统换向后开新的反方向仓位。

### 3.2 `PaperTrade` 接口（对应用户需求第五节列出的全部字段）

```ts
interface PaperTrade {
  tradeId: string;                   // `PT-${createdAt}-${随机后缀}`
  direction: 'long' | 'short';
  status: PositionStatus;            // 见§3.4状态机
  createdAt: number;                  // 首次建仓成交时间
  entryTime: number;                  // 同createdAt（首笔开仓成交时间，加仓不改变entryTime）
  entryPrice: number;                 // 加权平均建仓价（含首次开仓与加仓，见§4.3）
  quantity: number;                   // 当前剩余数量（部分平仓/加仓后动态变化）
  initialQuantity: number;            // 首次开仓（试仓）时的数量，加仓上限约束依据（见§5.2）
  notional: number;                   // 当前剩余名义价值 = quantity * entryPrice（加权）
  leverage: number;                   // 开仓时刻账户设置的杠杆，交易生命周期内不可变（见§5.5）
  marginUsed: number;                 // 当前剩余 notional/leverage
  initialStop: number;                // 首次开仓时的止损价，不可变，供审计对比
  currentStop: number;                // 当前生效止损（移动止损后会变化，只能同方向收紧，见§6.8）
  targets: number[];                  // 建仓时冻结的目标价数组（来自V1.1 `d.targets`）
  invalidation: string[];             // 建仓时冻结的离场条件文案（来自V1.1 `d.exitConditions`）
  addOnCount: number;                 // 已发生的加仓次数，V1.3上限为1（见§5.2）
  fees: number;                       // 该笔交易累计手续费
  slippage: number;                   // 该笔交易累计滑点成本（报告口径，见§4.4）
  realizedPnl: number;                // 该笔交易累计已实现盈亏（部分平仓+最终平仓之和）
  unrealizedPnl: number;              // 该笔交易当前未实现盈亏（仅OPEN/PARTIALLY_CLOSED有意义，EXITED后恒为0）
  closeReason: string | null;         // 见§6.9离场原因枚举，未平仓为null
  closedAt: number | null;            // 完全了结时间，未平仓为null
  decisionSnapshot: FrozenDecisionSnapshot;  // 建仓时刻V1.1决策深拷贝快照，见§7.2
  forecastSnapshot: FrozenForecastSnapshot | null; // 建仓时刻V1.2预测深拷贝快照，允许为null（见§7.3）
  dataAsOf: number;                   // 建仓所依据的最后已收盘15分钟K线closeTime
  algorithmVersion: string;           // 建仓时刻 v1_3-paper-trading-core.js 的 PAPER_ALGORITHM_VERSION
  fills: PaperFill[];                 // 该交易的全部不可变成交记录，见§3.3，追加写入，不可修改历史元素
}
```

### 3.3 `PaperFill` 接口（不可变成交记录，对应用户需求"所有成交必须产生不可变成交记录"）

```ts
interface PaperFill {
  fillId: string;                     // `PF-${time}-${随机后缀}`，全局唯一
  tradeId: string;                    // 归属的PaperTrade
  fillType: 'OPEN' | 'ADD_ON' | 'PARTIAL_TP' | 'STOP_LOSS' | 'TAKE_PROFIT' | 'MANUAL_REDUCE' | 'MANUAL_CLOSE';
  side: 'BUY' | 'SELL';               // 多单开仓/加仓/止盈=BUY×2种语义中的一种、止损/平仓=对应反向，见§4.2方向表
  time: number;                       // 成交时间（模拟撮合发生的时间，见§6.4）
  referencePrice: number;             // 撮合前的参考价（见§6.1）
  fillPrice: number;                  // 实际成交价（已计入滑点，见§6.2）
  quantity: number;                   // 本次成交数量
  fee: number;                        // 本次成交手续费
  slippageCost: number;               // 本次成交滑点成本（|fillPrice-referencePrice|×quantity）
  realizedPnlDelta: number;           // 本次成交产生的已实现盈亏（OPEN/ADD_ON为0）
  dataAsOf: number;                   // 本次撮合所依据的已收盘K线closeTime
  barOpenTime: number | null;         // 若由K线OHLC扫描触发（止损/止盈/跳空），记录该K线openTime；点击型成交为null
  immutable: true;                    // 恒为true，标记该记录写入后不可再修改任何字段（仅供schema自证，非运行时强制字段）
}
```

**不可变约束的实现要求**：`fills` 数组只能 `push`，任何既有元素不得被修改或删除（即使账户重置，也是清空整个数组重新开始，不是修改历史元素）。

### 3.4 持仓状态机 `PositionStatus`

```
NO_POSITION → PENDING_ENTRY → OPEN → (PARTIALLY_CLOSED ⇄ OPEN 不适用，部分平仓后不可逆回OPEN) → PARTIALLY_CLOSED → EXITED
                     ↓                                                                              ↑
                 CANCELLED                                                                     （直接从OPEN也可到EXITED，见下方转换表）
                     
（任意生成方案后，若V1.1权限被硬性否决/数据失效）→ BLOCKED
```

| 当前状态 | 触发事件 | 下一状态 | 说明 |
|---|---|---|---|
| `NO_POSITION` | 用户点击"生成方案"，V1.1许可满足 | `PENDING_ENTRY` | 生成`TradeProposal`，不改变账户状态，见§6.1 |
| `NO_POSITION` | 用户点击"生成方案"，V1.1许可不满足 | `BLOCKED`（瞬时，仅用于UI提示，不落盘为Trade） | 显示否决原因，不产生`PaperTrade`记录 |
| `PENDING_ENTRY` | 用户点击"确认开仓"，二次校验仍通过 | `OPEN` | 产生首笔`OPEN`类型`PaperFill`，见§6 |
| `PENDING_ENTRY` | 用户取消，或方案过期（见§6.1有效期）未确认 | `CANCELLED` | 不产生任何`PaperFill`，`PaperTrade`仍会写入一条状态为`CANCELLED`的记录用于审计（`entryPrice`/`quantity`等为null） |
| `OPEN` | 触发止损（§6.8）或用户手动全部平仓 | `EXITED` | |
| `OPEN` | 触发首个目标位部分止盈（§6.9） | `PARTIALLY_CLOSED` | |
| `OPEN` | 用户点击"确认加仓"且§5.2条件满足 | `OPEN`（`addOnCount+1`） | 不改变状态本身，只更新`quantity`/`entryPrice`/`currentStop` |
| `PARTIALLY_CLOSED` | 剩余仓位继续触发止损/最终止盈/用户手动平剩余仓位 | `EXITED` | |
| `PARTIALLY_CLOSED` | 触发下一档部分止盈 | `PARTIALLY_CLOSED`（保持） | 仍有剩余仓位时保持本状态 |
| `OPEN`/`PARTIALLY_CLOSED` | 数据失效期间 | 状态不变，但UI显示"无法可靠估值"（见§8.2），**不允许**在此期间产生新的止损/止盈`PaperFill` | 数据恢复后按§8.3规则补算 |
| 任意非终态 | 账户重置 | （从localStorage中清空，不经过状态转换） | 见§2.4 |

`EXITED`/`CANCELLED`/`BLOCKED` 为终态，终态记录只读，不再产生新的 `PaperFill`（`BLOCKED` 不产生`PaperTrade`，只在UI/日志留痕，见上表）。

---

## 4. 盈亏、手续费与滑点公式

### 4.1 未实现盈亏（红线公式，多空不可混用）

```
多单：unrealizedPnl = (markPrice - entryPrice) × quantity
空单：unrealizedPnl = (entryPrice - markPrice) × quantity
```

`markPrice` 取值：账户估值刷新时刻（每次`v11decision`事件，约30秒一次，见§6.5）对应的V1.1决策 `d.price`（**未收盘实时价**，不是`d.confirmedPrice`）——理由：估值展示的目的是让用户看到"如果现在平仓大概值多少钱"，这天然应该用最新可得价格，而不是V1.1为了避免决策抖动而刻意使用的已收盘价；这与止损/止盈**判定**必须只用已收盘K线（§6.6）是两件不同的事，不得混淆（估值用实时价，成交判定用已收盘K线OHLC）。

### 4.2 已实现盈亏（部分/全部平仓）与买卖方向表

```
多单部分/全部平仓：realizedPnlDelta = (exitFillPrice - entryPrice) × closedQuantity
空单部分/全部平仓：realizedPnlDelta = (entryPrice - exitFillPrice) × closedQuantity
```

| 场景 | 方向 | `side` | 滑点不利方向（保守原则，见§6.2） |
|---|---|---|---|
| 多单开仓/加仓 | 买入建仓 | `BUY` | 向上滑点（成交价更高） |
| 多单止损/止盈/减仓/平仓 | 卖出平仓 | `SELL` | 向下滑点（成交价更低） |
| 空单开仓/加仓 | 卖出建仓 | `SELL` | 向下滑点（成交价更低） |
| 空单止损/止盈/减仓/平仓（回补） | 买入平仓 | `BUY` | 向上滑点（成交价更高） |

### 4.3 加权平均建仓价（加仓时的成本基础方法）

V1.3 采用**加权平均成本法**（不做FIFO/LIFO分批计价，理由：V1.3限定最多1次加仓，只有"首次试仓"与"1次加仓"两笔，加权平均已足够简单且与真实交易所"逐仓/全仓单一持仓均价"展示习惯一致）：

```
addOn前：entryPrice_0，quantity_0
加仓：entryPrice_1（本次加仓成交价），quantity_1
加仓后：quantity_new = quantity_0 + quantity_1
        entryPrice_new = (entryPrice_0 × quantity_0 + entryPrice_1 × quantity_1) / quantity_new
```

加仓**不产生** `realizedPnlDelta`（与开仓一致，纯粹是建立更多敞口）。

### 4.4 手续费与滑点公式

```
fee = notional_of_this_fill × takerFeeRate         // 每次成交（开/加/减/平/止损/止盈）单独收取，双边各收一次
slippageAdjustment = referencePrice × (spreadRate/2 + slippageRate)
fillPrice = 多单买入/空单回补(BUY)  ? referencePrice + slippageAdjustment
          : 多单卖出/空单开仓(SELL) ? referencePrice - slippageAdjustment
slippageCost = |fillPrice - referencePrice| × quantity      // 报告口径，见§2.2，不重复计入cash
```

`spreadRate/2 + slippageRate` 的组合方式与 `v1-core.js calcRiskBudget`/`STRATEGY_SPEC.md §10.1a` 的"单边综合成本率"公式结构完全一致（口径对齐，避免臆造新公式），差别只是这里额外把"手续费"从价格调整里分离出来单独计费（因为真实成交里手续费是独立扣款，不是价格的一部分），价格调整只承担点差与滑点。

**参数免责声明（强制文案，见§10）**：`当前手续费/点差/滑点参数为模拟假设，可在设置中调整，不代表Binance真实费率`。

---

## 5. 风险规则

### 5.1 单笔与试仓风险预算

复用 `v1-core.js` 已导出的 `calcRiskBudget(entry, stop, settings, cost)` 作为核心求解公式（`notional = maxLossAmount / lossPerDollar`，`lossPerDollar = |entry-stop|/entry + costRate`，`margin = notional/leverage`）——V1.3 调用方式为：

```
试仓：C.calcRiskBudget(proposal.entryPrice, proposal.stop, {capital: account_equity, maxRiskPct: settings.trialRiskPct, leverage: settings.leverage}, {takerFeeRate, spreadRate, slippageRate})
正常单笔（若某场景不走"先小仓试错"直接给最大单笔，见§5.6开放问题）：maxRiskPct改用 settings.maxRiskPct
```

`account_equity` 使用**风险预算计算发生时刻**的账户 `equity`（§2.2定义），不是 `initialCapital`——这样账户盈利后风险预算会同步放大、亏损后同步收紧，是专业风险管理的标准做法（"风险比例基于当前净值，不是死的初始本金"），且与 `dailyLossLimitPct`/`maxDrawdownPct` 分别使用"当日期初净值"/"历史最高净值"两个不同基准形成清晰的三层定义（逐笔用当前净值、当日用期初净值、总量用历史峰值），三者不得混淆。

### 5.2 加仓风险预算（实现 `STRATEGY_SPEC.md §8.2` 此前只有文字描述、V1.1本身无法验证的规则）

加仓允许的**全部**前提（逻辑与，缺一不可）：

1. 当前持仓 `unrealizedPnl > 0`（真实浮盈，由V1.3自己的持仓数据计算，不依赖V1.1——这正是V1.1 `buildAddOnCondition` 文案里"系统未连接真实持仓，无法验证当前是否浮盈"这句话所指出的、V1.1自身无法验证但V1.3必须验证的条件）。
2. 最新V1.1决策快照满足：`!isManual && dataHealth==='normal' && biasDirection === position.direction && !opportunityScores.blocked && signalPermission.addOnAllowed === true`（`addOnAllowed` 只在 `computeSignalPermission` 返回 `alignment==='full_aligned'` 时为true，即三周期同向且BTC三周期均支持，见`v1-core.js`）。
3. `position.addOnCount === 0`（V1.3每笔交易**最多允许1次加仓**，见§5.6开放问题，不支持连续多次加仓）。
4. `position.currentStop` 已经不劣于开仓价（多单 `currentStop >= entryPrice`，空单 `currentStop <= entryPrice`，即止损已经移动到保本或更优——这是"先确保本金不亏，才能谈加仓"的专业纪律前置条件，见§5.6标注为需要CEO确认的默认规则）。
5. 风险预算约束（`STRATEGY_SPEC.md §8.2` 原文公式）：
   ```
   trialRisk  = |entryPrice(试仓) - initialStop| × initialQuantity
   addOnRisk  = |addOnEntryPrice - currentStop(加仓后)| × addOnQuantity
   totalRiskAfterAddOn = trialRisk + addOnRisk
   riskBudget = account_equity × settings.maxRiskPct
   约束：totalRiskAfterAddOn <= riskBudget，否则拒绝加仓
   ```
6. `addOnQuantity <= initialQuantity`（加仓仓位不超过首次试仓仓位，`STRATEGY_SPEC.md §8.2` 原文红线）。

任一条件不满足，系统只能输出"禁止加仓"及具体原因，**不得**输出任何形式的"补仓/摊平"建议或按钮（红线，对应用户需求"禁止亏损摊平"与`STRATEGY_SPEC.md`"任何时候价格触及止损位，输出只能是离场文案"）。

### 5.3 当日亏损锁定

```
dailyAnchorDateUTC：UTC自然日（'YYYY-MM-DD'，Date.prototype.toISOString().slice(0,10)口径）
每次账户状态刷新时：若 当前UTC日期 !== account.dailyAnchorDateUTC，
  则先把 dailyStartEquity 重置为"重置前一刻的equity"，再把 dailyAnchorDateUTC 更新为当前UTC日期
  （即每天第一次触发状态刷新时，用"刷新前的净值"作为新一天的期初净值，不回溯篡改前一天已经发生的盈亏）

dailyLossLimit = dailyStartEquity × settings.dailyLossLimitPct
dailyRealizedLoss = max(0, dailyStartEquity - (dailyStartEquity + Σ(当日发生的realizedPnlDelta) - Σ(当日发生的fee)))
   （即：只统计"当日已实现"部分，未实现浮亏不计入当日亏损锁定判断，因为浮亏可能随价格恢复，不应提前锁死账户）
若 dailyRealizedLoss >= dailyLossLimit → riskRegime = 'DAILY_LOSS_LOCKED'（若当前不是更严重的FORCED_OBSERVATION）
```

`DAILY_LOSS_LOCKED` 在下一个UTC自然日到来、`dailyAnchorDateUTC` 翻转时自动解除（除非同时触发§5.4的总回撤锁定）。

### 5.4 总回撤强制观察状态

```
equityHighWaterMark_new = max(equityHighWaterMark_old, equity_当前)   // 每次估值刷新都检查
drawdownPct = (equityHighWaterMark - equity_当前) / equityHighWaterMark
若 drawdownPct >= settings.maxDrawdownPct → riskRegime = 'FORCED_OBSERVATION'
```

**采用净值历史最高点（high-water mark）而非固定初始本金作为回撤基准**——这是行业标准的"最大回撤"定义，也是本文档相对用户需求原文的一处**澄清**：用户给出的例子"总回撤达到10%，默认约50 USDT"在账户从未超过初始本金500 USDT之前，两种基准（历史最高点=500，或固定初始本金=500）数值完全相同，因此例子本身不足以区分两种定义；一旦账户盈利后（例如净值涨到700），本文档的定义要求从700回撤10%（跌破630）才触发观察，而不是从固定500回撤10%（跌破450）才触发——本文档采用更保守（更容易触发保护）的高水位定义。**此处是需要CEO确认的问题，见§13**，若CEO更倾向"始终以固定初始本金计算总回撤"，只需把公式里的 `equityHighWaterMark` 替换为 `initialCapital` 即可，不影响其余任何设计。

`FORCED_OBSERVATION` 状态**不会**自动解除（不像日亏损锁定次日自动解锁）——回撤是账户层面的严重信号，解除方式只能是：用户在UI显式点击"确认已了解风险并解除观察状态"的二次确认操作（写入`ethAlphaPaperLog`审计记录），或账户重置。

### 5.5 杠杆边界（红线）

```
leverage ∈ [1, 3]（整数或一位小数均可，由 validatePaperAccountSettings 校验，见§11）
margin = notional / leverage      // 杠杆只出现在这一个公式里
```

**杠杆绝不出现在**：`riskBudget`/`maxLossAmount`/`trialRisk`/`addOnRisk`/`dailyLossLimit`/`drawdownPct` 任何一个公式中——修改杠杆只改变 `marginUsed`（占用多少可用资金作为保证金），不改变任何一笔交易允许亏损的绝对金额上限。这是用户需求"杠杆只能用于保证金压力换算，不能扩大风险预算"的直接formalization，也是`STRATEGY_SPEC.md`第20节"系统不追踪保证金、不计算强平价、不提供杠杆倍数建议"边界在V1.3的延伸（V1.3虽然首次冻结`marginUsed`，但风险预算计算逻辑完全不感知杠杆倍数）。

`leverage` 在单笔交易生命周期内**不可变**——开仓后修改账户设置里的杠杆不会影响已存在的 `PaperTrade.leverage`/`marginUsed`，只影响下一笔新交易。

### 5.6 需要CEO确认的风险规则默认值（非红线，是本文档为填补需求原文未给出具体数字的空白而选择的默认方案）

1. **加仓次数上限**：本文档默认V1.3每笔交易最多1次加仓（§5.2条件3）。如需支持多次加仓，需要重新定义"加仓仓位不超过首次试仓仓位"是针对"每次加仓"还是"全部加仓总和"，以及多次加仓后的加权平均价/风险预算叠加公式，建议留到V1.4。
2. **加仓前止损必须已保本**（§5.2条件4）：需求原文未明确要求这一条，是本文档从"只在浮盈时加仓"精神延伸出的专业纪律建议，可能比CEO预期更严格。
3. **部分止盈默认分批比例与移动止损规则**（§6.9）：需求原文只说"部分止盈和移动保护规则"必须明确定义，未给出具体比例，本文档默认目标1平50%仓位并移动止损到保本价，目标2再平30%并移动止损到目标1价位，剩余20%持有至目标3或止损。
4. **总回撤基准（高水位 vs 固定初始本金）**：见§5.4。
5. **风险预算计算使用"当前净值"而非"固定初始本金"**（§5.1）：如CEO希望风险比例始终对应固定500 USDT（而不是随盈亏浮动），需要相应修改公式。

---

## 6. 模拟成交模型

### 6.1 交易方案生成（`TradeProposal`，不改变账户状态）

生成条件（逻辑与）：`!decision.isManual && decision.dataHealth==='normal' && decision.worthBetting===true && !decision.opportunityScores.blocked && decision.biasDirection in ['long','short'] && account.riskRegime !== 'FORCED_OBSERVATION' && account.riskRegime !== 'DAILY_LOSS_LOCKED' && 当前无OPEN/PARTIALLY_CLOSED持仓（或该持仓方向与decision.biasDirection一致时走加仓方案）`。

`TradeProposal` 字段：`direction`/`referencePrice`（生成时刻`decision.price`）/`estimatedStop`（=`decision.stopLoss`）/`estimatedTargets`（=`decision.targets`）/`riskBudget`（§5.1计算结果）/`suggestedQuantity`/`suggestedNotional`/`suggestedMargin`/`generatedAt`/`expiresAt`（`generatedAt+120000`，2分钟有效期，超过必须重新生成，防止用户对着一个已经过时的旧价格方案点确认）/`proposalId`（UUID风格随机串，用于§6.7防重复点击）。

`TradeProposal` **只读展示**，不写入`ethAlphaPaperTrades`，用户可以反复重新生成（每次生成新的`proposalId`，旧的失效）而不产生任何账户副作用。

### 6.2 开仓/加仓/减仓/平仓的参考价与撮合时间

- **参考价 `referencePrice`**：用户点击"确认"按钮那一刻，最近一次成功的V1.1刷新周期缓存的 `decision.price`（即 `window.__lastMarketData`/最近一次`v11decision`事件里的实时价），**不额外发起新的网络请求**——V1.3不新增任何REST调用，完全复用V1.1既有的30秒刷新周期（`work/v1-ui.template.html` 现有 `setInterval(refresh,30000)`）产生的数据。
- **撮合时间**：与用户点击时间**同步**（JS单线程，函数调用即完成撮合，无排队延迟模拟）——`PaperFill.time = Date.now()`（点击型成交），或触发K线的 `closeTime`（K线扫描型成交，见§6.6）。
- **陈旧行情禁止成交**：若最近一次 `decision.dataHealth !== 'normal'`，或距离最近一次成功刷新已超过 `assessOverallHealth`/`assessDataQuality` 既有定义的 `isStale` 阈值（`v1-core.js`：`max(2×TF_MS[timeframe], 30分钟)`，V1.3**不新定义**新的陈旧阈值，直接复用这个已验收的口径），则**拒绝**任何开仓/加仓/新止损止盈判定，仅允许对已有仓位做手动减仓/平仓（用户主动止损离场的权利始终保留，不能因为行情陈旧而把用户锁在里面出不去，但陈旧行情下的手动平仓必须在UI显式标注"该成交基于陈旧数据，仅供你主动离场使用，价格可能已过期"）。

### 6.3 滑点方向与手续费计算方式

见§4.4，不在此重复；核心原则：滑点永远对账户不利（保守原则），手续费按每次成交的名义价值独立计算，两者是分开的两笔成本，不得相互替代。

### 6.4 市价单成交时间

所有点击型操作（开仓/加仓/手动减仓/手动平仓）均为**模拟市价单**，语义上"提交即成交"，`fillTime = Date.now()`，不模拟真实交易所的网络延迟或部分成交排队。

### 6.5 REST轮询间隔（不新增）

V1.3 完全复用V1.1既有的30秒 `setInterval(refresh,30000)` 刷新节奏，通过监听既有的 `v11decision` 自定义事件驱动"账户重新估值"与"新收盘K线的止损止盈扫描"（见§6.6），**不新增任何独立的定时器或网络请求**，与V1.2遵循的"不重复造轮子"原则一致（`V1_2_ARCHITECTURE_REVIEW.md` 已确认V1.2同样直接监听既有`v11decision`事件）。

### 6.6 止损/止盈判定：只用已收盘K线OHLC扫描（不是逐笔行情）

V1.3 没有WebSocket、没有逐笔成交数据，只有REST轮询到的K线。止损/止盈判定**只**基于15分钟K线**已收盘**后的完整OHLC（`isClosed===true`），在"每次`v11decision`事件到来、且出现了此前未处理过的新收盘15分钟K线"时触发一次扫描，扫描顺序按 `openTime` 升序（防止一次刷新拿到多根积压的收盘K线时乱序处理，见§8.3恢复规则）：

```
对每根待处理的新收盘K线 bar（openTime递增顺序）：
  多单：
    hitStop = bar.low <= currentStop
    hitTarget = bar.high >= 当前生效目标价（部分止盈见§6.9，按"下一个未触发的目标"判断）
  空单：
    hitStop = bar.high >= currentStop
    hitTarget = bar.low <= 当前生效目标价
  若 hitStop && hitTarget 同时为真 → 按§6.7"同K线冲突"规则，只按止损处理（不触发止盈）
  否则若只有 hitStop → 按§6.8止损成交规则处理
  否则若只有 hitTarget → 按§6.9止盈成交规则处理
  处理完一根bar产生的状态变化（部分平仓/全部平仓）后，再继续用**更新后**的position状态判断下一根bar，不允许跳过中间bar只看最新一根
```

### 6.7 同一根K线止损与止盈冲突：按对账户更不利的结果处理

**红线**：`hitStop && hitTarget` 同时成立时，**永远**按止损成交处理，不触发止盈——因为止损代表亏损、止盈代表盈利，在无法确定K线内真实触达顺序的前提下，"假设更糟的情况发生了"是唯一不会让账户凭空获得不该有的盈利的保守假设。**不允许**实现任何"各按50%概率""按K线形态猜测顺序"等非保守处理方式。

### 6.8 止损成交与跳空规则

```
多单止损成交价确定：
  gapped = bar.open < currentStop   // 开盘价已经跳空穿过止损位
  基准价 = gapped ? bar.open : currentStop
  fillPrice = 基准价 - (基准价 × (spreadRate/2 + slippageRate))    // 卖出方向不利滑点

空单止损成交价确定：
  gapped = bar.open > currentStop
  基准价 = gapped ? bar.open : currentStop
  fillPrice = 基准价 + (基准价 × (spreadRate/2 + slippageRate))    // 买入回补方向不利滑点
```

**红线**：跳空场景下**禁止**假设成交在原止损价，必须使用"该根K线开盘后第一个可获得的价格"（即 `bar.open`）作为不利滑点的基准价，这是用户需求原文的直接formalization，也是与真实市场"跳空后止损单只能在跳空后的第一个可成交价附近成交，而不是原挂单价"行为一致的保守模拟。

### 6.9 止盈成交规则：只按计划价格成交，不因有利跳空而改善

```
多单止盈成交价：fillPrice = target价格 - (target价格 × (spreadRate/2 + slippageRate))   // 即使bar.open因有利跳空更高，也不采用更好的价格
空单止盈成交价：fillPrice = target价格 + (target价格 × (spreadRate/2 + slippageRate))
```

**保守原则的对称应用**：止损场景里不利跳空会让账户成交价"更差"（不采用原止损价的假设优待），止盈场景里即使出现有利跳空（例如多单目标位是105，K线开盘直接跳到110），也**不**假设账户能拿到110的好价格，只按计划的目标价105（扣减滑点）成交——两侧规则都只朝"对账户更不利"的方向偏置，不存在任何让模拟账户"运气爆棚"的路径。

### 6.10 部分止盈与移动止损默认方案（默认值，见§5.6开放问题3）

```
到达targets[0]：平仓quantity的50%，currentStop移动到entryPrice（保本，含手续费/滑点后的真正盈亏平衡价，见下方精确定义）
到达targets[1]：再平仓（原始quantity的）30%，currentStop移动到targets[0]
到达targets[2]（或未来新增的移动止盈规则）：剩余20%继续持有，直到最终止损或用户手动平仓
```

`currentStop` 移动到"保本"的精确定义：使得剩余仓位即使立即在该价位止损，`该笔Trade的realizedPnlTotal（含已经部分止盈的盈利）+ 剩余仓位在保本价止损的亏损 >= 0`——即保本价不是简单的 `entryPrice`，而是要把已经实现的部分止盈利润和至此累计的手续费/滑点一并折算，`currentStop_breakeven` 需要满足：

```
多单：(target0Price - entryPrice) × 0.5×quantity_原始 - fees累计 - slippage累计 + (currentStop_breakeven - entryPrice) × 剩余quantity = 0，解出currentStop_breakeven
空单：对称公式，方向相反
```

（这一步"精确保本价"计算复杂度较高，`V1_3_CODEX_IMPLEMENTATION_TASK.md` 会把它拆成一个独立可单测的纯函数 `calcBreakevenStop(trade)`，避免和撮合主流程耦合。）

**移动止损只能同方向收紧，不能放松**（多单`currentStop`只能上移不能下移，空单只能下移不能上移）——这是防止"移动保护"被误用成变相放大风险的红线。

### 6.11 多次点击防重复成交

```
account.actionLock: boolean   // 账户级互斥锁，任意一次开仓/加仓/减仓/平仓/重置操作执行期间为true
```

任何模拟交易函数的**第一条语句**必须是同步检查并设置 `actionLock`（`if (account.actionLock) return {ok:false, reason:'操作正在处理中，请勿重复点击'}; account.actionLock = true`），函数结束（无论成功失败）必须在 `finally` 中释放锁。此外，开仓/加仓操作必须校验 `proposalId` 与当前未过期、未消费的`TradeProposal`一致，且 `TradeProposal` 一旦被成功消费（用于产生了一次`OPEN`/`ADD_ON`类型`PaperFill`）立即标记为已消费，同一个 `proposalId` 不能被使用第二次——两层防护（同步锁+一次性方案消费）共同防止双击/连点导致重复开仓或重复加仓。UI层面也必须在锁定期间禁用相关按钮，但**不得**只依赖UI禁用（核心函数必须有自己的锁，UI禁用只是体验优化，不是唯一防线）。

### 6.12 价格精度、数量精度与最小名义价值

```
价格精度：round(price, pricePrecision)，四舍五入到settings.pricePrecision位小数（默认2位）
数量精度：floor(quantity, quantityPrecision)，向下取整到settings.quantityPrecision位小数（默认3位），
          向下取整是为了保证按精度截断后的真实名义价值不会超过风险预算算出的建议名义价值
最小名义价值：quantity × entryPrice >= settings.minNotional（默认20 USDT），
             低于该值时开仓/加仓请求必须拒绝，文案："计算出的模拟仓位名义价值低于最小名义价值Y USDT，风险预算过小或本金过低，本次不予开仓"
```

**声明**：以上精度与最小名义价值为V1.3模拟假设，**不调用**币安 `exchangeInfo` 接口获取真实交易规则（避免新增网络请求与新的数据源依赖），与真实市场实际值可能不同。

---

## 7. 与V1.1/V1.2联动

### 7.1 权限边界（红线）

- V1.1负责：交易许可（`opportunityScores.blocked`/`signalPermission`）、方向（`biasDirection`）、试仓/加仓结构性条件（`signalPermission.addOnAllowed`）、止损（`stopLoss`）、离场条件文案（`exitConditions`）。V1.3**只读消费**这些字段，不重新计算、不覆盖。
- V1.2负责：情景推演（`directionLabel`/`weights`/`priceRange`/`scenarioTargets`），**只能**作为`PaperTrade.forecastSnapshot`的只读存档字段，**不得**出现在任何开仓/加仓/减仓/平仓的条件判断表达式里——即使V1.2三个时窗的置信度或权重再高，也不能替代或绕过§6.1的开仓生成条件与§5.2的加仓条件。
- 数据失败（`dataHealth!=='normal'`）时：禁止新开仓、禁止加仓（§6.1/§5.2条件已包含），已有仓位保留但标记"无法可靠估值"（§8.2）。

### 7.2 建仓快照冻结（红线，防止"引用被后续刷新悄悄改写"）

```
decisionSnapshot = deepClone(decision)   // 例如 JSON.parse(JSON.stringify(decision))，只保留可序列化字段
forecastSnapshot = window.__prevForecast ? deepClone(window.__prevForecast) : null
```

**必须深拷贝，不得只保存对象引用**——即使当前 `v1-core.js`/`v1_2-forecast-core.js` 的实现看起来每次 `v11decision` 事件都会构造全新的 `decision`/`forecast` 对象（没有观察到跨tick复用同一个对象），V1.3也不能依赖这一实现细节的偶然性：已知 `v1-core.js` 内部存在"先构造对象、再对同一对象做属性赋值"的模式（例如 `e15.state=l.state`、`d.decisionLogId=log.id` 均发生在对象构造之后），说明这两个模块的作者习惯于原地修改已构造的对象；如果未来某次重构改成了"复用同一个对象跨tick更新字段"以节省内存分配，任何只持有引用而非深拷贝的下游代码都会在不知情的情况下看到历史快照被悄悄改写。这是本文档明确要求"深拷贝"而不是"保存引用"的具体技术依据，也是`V1_3_ACCEPTANCE_TESTS.md` T19专项测试的对象。

### 7.3 事件时序要求

V1.3 的 `v11decision` 监听器必须在构建产物（`eth-dynamic-trading-dashboard.html`）中位于V1.2预测脚本块**之后**（即 `/*__PAPER__*/` 占位符必须插入在 `/*__FORECAST__*/` 之后，见`V1_3_CODEX_IMPLEMENTATION_TASK.md`），从而保证同一次 `dispatchEvent('v11decision')` 同步触发的多个监听器里，V1.2的 `window.__prevForecast` 先于V1.3读取该值完成更新——避免V1.3拿到"上一个tick"的过期预测快照。`forecastSnapshot` 允许为 `null`（例如`decision.isManual`时V1.2不生成预测），但**不允许**开仓（`decision.isManual`本身已经在§6.1生成条件里被拦截）。

---

## 8. 异常与恢复规则

### 8.1 数据失败时禁止新开仓/加仓

见§6.2/§5.2，已覆盖，此处不再重复公式，只重申红线：`decision.dataHealth!=='normal'` 或 `decision.isManual===true` 时，`TradeProposal` 生成条件与加仓条件均为假，UI必须显示具体拒绝原因文字，不得静默无反应。

### 8.2 数据失败期间已有仓位的展示

`window.invalidateDashboard` 触发时（复用V1.1/V1.2已验收的既有钩子，V1.3在其包装链的末尾追加自己的处理，不改写前面已有的V1.1/V1.2处理逻辑），已有 `OPEN`/`PARTIALLY_CLOSED` 仓位：

- `unrealizedPnl`/`markPrice` 展示冻结为**最后一次成功估值时的数值**，UI在数字旁强制附加"无法可靠估值"标签与失效原因。
- **不**清空持仓本身（持仓状态不变，`fills`历史不受影响）。
- **不**在此期间执行§6.6的K线扫描（因为新数据本身不可靠或缺失，扫描逻辑天然没有输入）。

### 8.3 数据恢复后的重新估值与"不得伪造失效期间成交顺序"

数据恢复（下一次成功的`v11decision`事件，`dataHealth==='normal'`）后：

1. 立即用最新 `decision.price` 刷新 `markPrice`/`unrealizedPnl`，摘除"无法可靠估值"标签。
2. 取出本地已记录的"最后处理过的15分钟K线 `openTime`"（每笔`PaperTrade`独立记录一个`lastScannedBarOpenTime`），与本次恢复后 `marketData.eth.tf15m` 中**全部**`isClosed===true`且`openTime > lastScannedBarOpenTime`的K线，按§6.6顺序**逐根**扫描（不是只看最新一根），确保失效期间实际发生过的止损/止盈不会被跳过或"用当前价格反推一个从未真实发生过的成交顺序"来伪造。
3. 若 `marketData.eth.tf15m` 返回的历史K线数量不足以覆盖 `lastScannedBarOpenTime` 到当前的完整缺口（`fetchAllTimeframeKlines` 目前每次固定拉取有限根数的K线，理论上存在极端长时间断连导致缺口超出可回补范围的情况），则**不得**假装"没有发生任何触发"直接按最新价格继续计算浮动盈亏——必须显式标记该笔交易 `dataGapUnrecoverable: true`，UI提示"数据中断时间过长，无法完整重建期间是否触发止损/止盈，历史记录可能不完整"，并保守地按§6.7原则假设期间已触发止损（若K线覆盖范围内的第一根可得K线的最不利价格已经越过止损位），而不是假设仓位安然无恙地保留到现在。

---

## 9. localStorage Schema 与迁移版本

### 9.1 命名空间（三个独立key，均不与V1.1/V1.2既有key冲突）

| Key | 内容 | 类型 |
|---|---|---|
| `ethAlphaPaperAccount` | 单个 `PaperAccount` 对象 | Object |
| `ethAlphaPaperTrades` | `PaperTrade[]`（含各自内嵌的 `fills`） | Array |
| `ethAlphaPaperLog` | 扁平审计日志数组（每条记录一次生命周期事件：`OPENED`/`ADDED_ON`/`PARTIAL_TP`/`STOPPED_OUT`/`MANUAL_CLOSED`/`CANCELLED`/`BLOCKED_ATTEMPT`/`ACCOUNT_RESET`/`RISK_REGIME_CHANGED`等） | Array |

对照既有key：`ethAlphaDecisionLogs`（V1.1）、`ethAlphaRiskSettings`（V1.1）、`ethAlphaForecastLogs`（V1.2）——三个新key命名风格一致但字符串本身互不相同，V1.3**不读不写**前三者。

### 9.2 损坏JSON、容量不足与字段版本不兼容的安全降级

```
读取任一key时：try { JSON.parse(...) } catch { 视为空（Account走§9.4默认值重建，Trades/Log视为空数组） }
写入任一key时：try { storage.setItem(...) } catch(e) {
  若 e.name==='QuotaExceededError' → 返回 {ok:false, reason:'模拟交易存储空间不足'}，不抛出异常，不阻塞当前操作的内存态更新（账户/持仓状态本身已经在内存里正确变化，只是这次没能持久化，下次操作会重试写入）
  否则 → 返回 {ok:false, reason:'模拟交易数据写入失败：'+e.message}
}
```

字段版本不兼容（`schemaVersion`不是当前代码认识的版本号）：

```
若 读到的schemaVersion 是已知的旧版本 → 走§9.3定义的迁移函数升级后使用
若 读到的schemaVersion 是未知版本（比当前代码版本更新，或完全不认识的字符串）→ 不尝试猜测式解析，
  账户按§9.4默认值重建（等价于一次隐式重置），并在ethAlphaPaperLog写入一条SCHEMA_MISMATCH审计记录，
  UI必须提示"检测到不兼容的模拟账户数据版本，已重新初始化，历史记录可能不可读"，不得静默丢弃且不提示
```

### 9.3 迁移函数

```
migratePaperAccount(raw): PaperAccount    // 内部按 schemaVersion 做 switch-case 链式升级，每次只处理"上一版本→下一版本"的单步差异，不允许跳级臆测字段含义
migratePaperTrades(raw): PaperTrade[]
```

V1.3-draft-1本身是`v1.3-account-1`/`v1.3-trade-1`/`v1.3-log-1`三个schema的第一个版本，暂无历史版本需要迁移；迁移函数从第一天就必须存在（哪怕当前只有一个`case`分支），为未来版本升级预留结构，避免重蹈"V1.2最初没有为FACTOR_WEIGHTS设计版本绑定，后来才补"的覆辙（见`CLAUDE_CODE_REVIEW_V1_2_FINAL.md` P1-3）。

### 9.4 `PaperAccount` 默认值重建

等价于§2.4"重置账户"的最终状态（`initialCapital`取代码内置默认值500，而不是尝试从损坏数据里抢救任何字段）。

---

## 10. UI 区域字段规范

新增中文区域标题："**500 USDT模拟交易账户**"（若`initialCapital`被用户修改，标题动态显示为"**{initialCapital} USDT模拟交易账户**"），独立的 `<article class="card span12">`，置于V1.2走势预测区域下方，不得插入或穿插进V1.1/V1.2现有卡片内部。

**常驻文案（区域内任意状态下都必须可见）**：`模拟交易，不是真实下单，不连接交易所账户。`

必须显示的字段（对照用户需求第七节逐项落地，中文措辞）：

| 字段 | 中文文案 | 数据来源 |
|---|---|---|
| 账户初始资金 | 账户初始资金 | `account.initialCapital` |
| 可用资金 | 可用资金 | `account.cash - account.marginUsed` |
| 冻结保证金 | 冻结保证金 | `account.marginUsed` |
| 当前净值 | 当前净值（模拟） | `equity`（§2.2） |
| 已实现盈亏 | 累计已实现盈亏 | `account.realizedPnlTotal` |
| 未实现盈亏 | 当前未实现盈亏 | `Σ unrealizedPnl` |
| 累计手续费 | 累计手续费 | `account.feesTotal` |
| 累计滑点 | 累计滑点成本（模拟） | `account.slippageCostTotal` |
| 当日盈亏 | 当日盈亏 | `equity - account.dailyStartEquity` |
| 最大回撤 | 最大回撤（历史峰值口径） | `drawdownPct`（§5.4） |
| 当前风险状态 | 风险状态：正常 / 当日亏损已锁定 / 强制观察中 | `account.riskRegime` |
| 当前模拟仓位 | 当前模拟仓位 | `PaperTrade`（状态为OPEN/PARTIALLY_CLOSED的那一条，若无则显示"当前无持仓"） |
| 开仓/减仓/平仓按钮 | 生成方案 / 确认开仓 / 加仓 / 减仓 / 平仓 | 见§6按钮各自的前置条件禁用逻辑 |
| 风险预算计算 | 本次风险预算 | `calcRiskBudget`结果，需同时展示"最大亏损金额"与"建议名义价值/数量" |
| 模拟成交记录 | 模拟成交记录 | `PaperTrade.fills`（按时间倒序，每条展示`fillType`/价格/数量/手续费/滑点） |
| 模拟交易日志 | 模拟交易日志 | `ethAlphaPaperLog`（按时间倒序，最近10条，同V1.1日志区域的展示风格） |
| JSON/CSV导出 | 导出JSON / 导出CSV | 见§11导出函数 |
| 重置账户按钮 | 重置模拟账户 | 二次确认弹窗，见§2.4 |

**禁止措辞**（与V1.2一致的红线，扩展到V1.3语境）：不得出现"稳赚""必涨""必跌""保证盈利""跟单必赚"；净值/盈亏相关数字必须在同一屏幕内与常驻免责声明共同出现，不得单独抽出到一个从不显示免责声明的子视图。

---

## 11. 函数接口清单（不实现，供 `V1_3_CODEX_IMPLEMENTATION_TASK.md` 对照）

```
loadPaperAccount(storage): PaperAccount
savePaperAccount(account, storage): {ok, reason?}
validatePaperAccountSettings(settings): {ok, value?, message?}
resetPaperAccount(storage, confirmFn): PaperAccount        // confirmFn即window.confirm等价物，供测试注入mock
changeInitialCapital(storage, newCapital, confirmFn, alsoReset): {ok, account?, reason?}

buildTradeProposal(decision, account, direction): TradeProposal | {ok:false, reason}
confirmOpenPosition(proposal, decision, forecast, account, storage): {ok, trade?, reason?}
confirmAddOn(trade, decision, account, storage): {ok, trade?, reason?}
confirmReduce(trade, quantity, decision, account, storage): {ok, trade?, reason?}
confirmClose(trade, decision, account, storage): {ok, trade?, reason?}

scanClosedBarsForExits(trade, newClosedBars, account, storage): {ok, trade?, fills?}
calcBreakevenStop(trade): number
calcRiskRegime(account): PaperAccount['riskRegime']
calcUnrealizedPnl(trade, markPrice): number
calcDrawdown(account): {drawdownPct, equityHighWaterMark}

exportPaperLogsJSON(trades, log): string
exportPaperLogsCSV(trades, log): string

migratePaperAccount(raw): PaperAccount
migratePaperTrades(raw): PaperTrade[]
```

所有函数均为纯函数或"输入当前状态+副作用限定在传入的storage参数"风格，与`v1-core.js`/`v1_2-forecast-core.js`既有的`storage`参数注入模式一致，不得直接引用全局`window.localStorage`（便于Node测试注入mock storage，对照`saveDecisionLog(entry,storage)`/`saveForecastLog(entry,storage)`既有模式）。

---

## 12. 版本号红线（比照V1.2 `FACTOR_WEIGHT_CHECKSUM` 模式）

```
PAPER_SCHEMA_VERSION = 'v1.3-account-1' / 'v1.3-trade-1' / 'v1.3-log-1'   // 三个schema各自独立版本号
PAPER_ALGORITHM_VERSION = 'v1.3-draft-1'   // 对应本文档版本，§4-§6任何公式变化必须递增
```

任何修改§5风险预算数值默认值、§4手续费滑点公式、§6撮合规则的提交，必须同步递增 `PAPER_ALGORITHM_VERSION`，并在 `V1_3_ACCEPTANCE_TESTS.md` 增补对应回归用例——比照V1.2最终复审关闭的P1-3经验（`CLAUDE_CODE_REVIEW_V1_2_FINAL.md`），版本校验测试**必须**使用独立硬编码基准值，不得从运行时对象自证式反算。

---

## 13. 需要CEO确认的问题清单（本文档内标注"§5.6"等处的开放问题汇总，供实施前逐条拍板）

1. 总回撤10%锁定的基准：净值历史最高点（本文档默认，更保守）还是固定初始本金500 USDT？（§5.4）
2. 单笔/试仓风险预算基准：当前账户净值（本文档默认，随盈亏浮动）还是固定初始本金？（§5.1）
3. 加仓次数上限：V1.3是否限定最多1次加仓？（§5.2/§5.6-1）
4. 加仓前是否强制要求止损已移动到保本价？（§5.2条件4/§5.6-2）
5. 部分止盈默认分批比例（本文档默认50%/30%/20%）与移动止损档位是否符合预期？（§6.10/§5.6-3）
6. 数据中断且历史K线不足以完整回补时，是否认可"保守假设已触发止损"的降级处理？（§8.3第3点）

---

## 14. 变更记录

- v1.3-draft-1（本版本）：首次交付，基于main分支`v1.2.0`标签独立设计，不修改V1.1/V1.2任何已验收代码。
