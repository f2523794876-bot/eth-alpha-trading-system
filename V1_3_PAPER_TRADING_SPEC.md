# V1_3_PAPER_TRADING_SPEC.md — ETH Alpha V1.3「真实行情模拟交易系统」算法与数据规范

版本：v1.3-draft-4（CEO正式撤销draft-2/draft-3"用户必须逐笔点击确认才建立模拟仓位"的授权模型，改为§16「真实行情自动模拟交易引擎」——用户只需一次性开启"自动模拟交易总开关"，之后系统按V1.1正式规则自行虚拟开仓/加仓/减仓/止损/分批止盈/移动保护/平仓；§15「建议档案与影子验证」保持不变；§0-§14中断言"逐笔点击"的具体条款已被本轮**原地改写**，§16.13/§17为完整的冲突旧定义扫描与撤销记录）
角色：本文档只做 V1.3「自动模拟交易引擎」+「建议档案与影子验证」的**架构设计与验收规范**，不是实现代码，也不由本文档作者实现正式业务代码。
基准：main 分支 `v1.2.0` 标签（提交 `0dc1943`），本文档在 V1.1（`v1-core.js`，冻结）与 V1.2（`v1_2-forecast-core.js`，冻结）之上做**纯叠加**，不修改、不重写两者已验收的任何函数或算法。draft-3新增内容额外基准提交 `36c45d27efde8efc2fd3004b3889bd9eeda90eb5`；draft-4额外基准提交 `484f95a8a2676d55c4c2d4a44deea1fe2e6b38ea`（draft-3）。
唯一算法真相来源声明：本文档是 V1.3 模拟交易算法的唯一 source of truth。`V1_3_CODEX_IMPLEMENTATION_TASK.md` 的函数接口必须实现本文档定义的行为；`V1_3_ACCEPTANCE_TESTS.md` 的用例必须验证本文档定义的规则；`V1_3_ARCHITECTURE_REVIEW.md` 负责核对三者与 V1.1/V1.2/STRATEGY_SPEC.md 的一致性。四份文档如有冲突，以本文档为准。
**三套系统边界声明（draft-4修订，红线）**：V1.3自本版本起包含三套严格分离的系统——① §2-§8/§16「模拟账户 Auto Paper Trading Account」（用户一次性开启"自动模拟交易总开关"并二次确认后，系统按§16.2十四项条件自动建仓/加仓/止损/分批止盈/平仓，用户保留暂停/恢复/禁止新开仓/紧急模拟平仓/关闭的宏观控制权，**不再要求每笔交易单独点击确认**——draft-2/draft-3"每笔交易需要用户点击"的旧定义已被本轮正式撤销，见§16.0/§17）；② §15「建议档案 Signal Archive」（系统给出可执行建议时自动、无条件冻结存档，与账户是否自动交易无关）；③ §15.6-§15.8「影子验证 Shadow Evaluation」（使用建议之后的真实已收盘K线客观验证建议表现，**不建立模拟仓位、不使用模拟保证金、不改变500 USDT账户任何字段**）。三者共享同一份V1.1/V1.2只读输入，但存储命名空间、状态机、资金语义完全独立，**任何实现都不得把影子验证产生的假设盈亏写入`PaperAccount`/`PaperTrade`任何字段**。

**常驻免责声明（强制，任何页面状态下都必须可见，见§10/§16.9）**：`使用真实市场行情自动进行虚拟交易，不发送真实订单。页面关闭或电脑休眠时不会实时运行。`（draft-4更新文案，替换draft-2/draft-3的"模拟交易，不是真实下单，不连接交易所账户"，新增"页面关闭/休眠不实时运行"的浏览器限制声明，见§16.8/CEO"八"）

---

## 0. 范围与既有文档的关系

### 0.1 这是一次刻意的范围拆分，不是范围蔓延

CEO已明确决策（本轮draft-2第7项）：**V1.3 = 真实行情模拟交易与模拟仓位；V3 = WebSocket、条件提醒、推送和长期运行监控**。历史文档中把"模拟仓位"与WebSocket/条件提醒/长期运行监控打包归入V3的过时措辞，已在本轮同步修订（见本次提交对 `CODEX_IMPLEMENTATION_TASK.md`/`STRATEGY_SPEC.md`/`PROJECT_AUDIT.md`/`ACCEPTANCE_TESTS.md`/`V1_IMPLEMENTATION_REPORT.md`/`V1_CHECKLIST.md`/`V1_2_CODEX_IMPLEMENTATION_TASK.md`/`V1_2_ARCHITECTURE_REVIEW.md`的范围性文字追加说明，未改动这些文档描述的V1.1/V1.2既有规范或代码本身）。

### 0.2 与 `CODEX_IMPLEMENTATION_TASK.md` 早期"模拟仓位"草稿概念的关系

V1 阶段文档曾用一句话粗略勾勒过"模拟仓位"概念（用户标记"如果此刻按建议开仓"，系统虚拟记录方向/开仓价/止损/目标，tick级比对浮动盈亏，触及止损/目标自动标记平仓结果并写回决策日志的 `outcome` 字段）。**本文档定义的 V1.3 系统在范围和数据结构上完全取代该草稿概念**：V1.3 是独立账户（现金/保证金/净值/已实现/未实现/手续费/滑点/回撤全套记账）+ 独立 localStorage 命名空间 + 独立状态机 + 独立日志，不是"写回决策日志的一个字段"。后续任何文档提到"模拟仓位"，均以本文档为准。

### 0.3 V1.3 不做的事

不自动下真实订单；不读取/存储任何交易所API密钥；不连接用户真实交易所账户；不承诺盈利或给出保证性措辞；不允许亏损摊平；不允许用杠杆扩大风险预算（杠杆只影响保证金占用，见§5.5）；不修改 `v1-core.js`/`v1_2-forecast-core.js` 已验收的任何函数体；不实现V2历史校准（`outcomeAfter*Bar`/Brier/校准曲线）；不实现WebSocket、条件提醒推送（`Notification`）、长期运行监控。

**（draft-4撤销，见§16.0/§17）** ~~不在无用户点击确认的情况下自动建立模拟仓位——任何模拟开仓、加仓、减仓、平仓、重置函数在设计上都必须要求一个只能来自真实用户点击事件的idempotencyKey作为参数，不得由定时器或数据刷新回调直接调用。~~ **CEO本轮已正式撤销这一条：V1.3的核心产品定义就是"根据V1.1正式规则自动进行虚拟开仓/加仓/减仓/止损/分批止盈/移动保护/平仓"（见§16），自动建仓/加仓由引擎在§16.2十四项条件满足时自动触发，不再要求逐笔用户点击；`idempotencyKey`改由引擎按确定性规则生成（见§16.8），不再要求"只能来自真实用户点击事件"。真正保留"必须来自用户点击"约束的操作收窄为：开启/暂停/恢复/禁止新开仓/紧急模拟平仓/关闭自动模拟交易（§16.1/§16.6，宏观控制与异常人工介入），以及`resetPaperAccount`/`changeInitialCapital`/`confirmForcedObservationAcknowledgement`（账户级设置操作，本来就不是"逐笔"操作，不受本轮撤销影响）。**

---

## 1. 术语与数据结构总览

| # | 术语 | 定义 | 归属 | 字段/接口 |
|---|---|---|---|---|
| 1 | 模拟账户 Account | V1.3 唯一的虚拟资金主体，USDT计价，不对应任何真实资金 | V1.3新增 | `PaperAccount`，见§2 |
| 2 | 模拟合约语义 | "模拟USDT本位永续合约"记账方式（cash/equity/margin分离），但不实现真实合约的强平、资金费、逐仓/全仓切换 | V1.3新增 | 见§2.3 |
| 3 | 持仓 Position | 账户当前对ETH的方向性敞口（同一时刻至多一个方向，见§3.1） | V1.3新增 | `PaperPosition`，见§3 |
| 4 | 交易 Trade | 一次持仓从建立到彻底了结（含期间的加仓、部分止盈、可能的数据缺口）的完整生命周期记录 | V1.3新增 | `PaperTrade`，见§3.2 |
| 5 | 成交 Fill | 一次不可变的撮合执行事件（开仓/加仓/部分平仓/止损/止盈/保守结算） | V1.3新增 | `PaperFill`，见§3.3 |
| 6 | 交易方案 Proposal | 系统基于当前V1.1决策生成的"引擎接下来将会这样做"的只读预览，本身不改变账户状态；draft-4起由引擎自动消费（不再等待用户点击确认），同时作为§16.9 UI"下一自动动作"字段的数据来源 | V1.3新增 | `TradeProposal`，见§6.1/§16.5 |
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

### 3.4 持仓状态机 `PositionStatus`（新增`UNRESOLVED_DATA_GAP`，CEO决策第6项；**draft-4起`PENDING_ENTRY`/`CANCELLED`/`BLOCKED`三个"等待用户点击确认"相关状态已撤销简化，见下方标注与§16.4完整新状态机**）

```
NO_POSITION → PENDING_ENTRY → OPEN ⇄ PARTIALLY_CLOSED → EXITED
                     ↓                  ↓        ↓
                 CANCELLED       UNRESOLVED_DATA_GAP → EXITED（仅经§8保守结算）
（生成方案时V1.1权限被否决/数据失效）→ BLOCKED（瞬时，不落盘为Trade）
```

**（draft-4撤销，见§17）** ~~`NO_POSITION`→`PENDING_ENTRY`→`OPEN`需要"生成方案"+"确认开仓"两次用户点击~~。**CEO本轮已撤销这一流程：`PaperTrade`记录只在引擎实际自动开仓（`autoEngineOpenPosition`，§16.2十四项条件全部满足）那一刻才创建，不再存在一个持久化的"已生成方案、等待用户确认"的`PENDING_ENTRY`中间态——`PENDING_ENTRY`/`CANCELLED`/`BLOCKED`三个状态整体移除**：`PaperTrade`简化为`NO_POSITION`（概念态，不落盘）→`OPEN`⇄`PARTIALLY_CLOSED`→`EXITED`，含`UNRESOLVED_DATA_GAP`分支，与draft-2其余部分完全一致，只是不再有开仓前的等待态。"引擎本想开仓但条件不满足"这类信息不再体现为`PaperTrade`的状态，而是体现在关联`SignalSnapshot`的`userActionStatus`投影值上（`AUTO_BLOCKED_BY_RISK`/`AUTO_BLOCKED_BY_POSITION`/`AUTO_MISSED_ENGINE_OFF`/`AUTO_MISSED_DATA_GAP`，见§15.9/§16.6新枚举），因为没有实际建仓，就没有对应的`PaperTrade`记录可以承载这个状态。

| 当前状态 | 触发事件 | 下一状态 | 说明 |
|---|---|---|---|
| `NO_POSITION` | 引擎判定§16.2十四项条件全部满足，自动执行开仓 | `OPEN` | 产生首笔`OPEN`成交，见§16.2（**替代原"用户点击生成方案/确认开仓"两步**） |
| `OPEN` | 触发止损或用户点击"紧急模拟平仓" | `EXITED` | |
| `OPEN` | 触发首个目标位部分止盈 | `PARTIALLY_CLOSED` | |
| `OPEN` | 引擎判定§16.2/§5.2加仓条件全部满足，自动执行加仓 | `OPEN`（`addOnCount+1`） | 不改变状态本身（**替代原"用户点击确认加仓"**） |
| `PARTIALLY_CLOSED` | 继续触发止损/最终止盈/用户点击"紧急模拟平仓" | `EXITED` | |
| `PARTIALLY_CLOSED` | 触发下一档部分止盈 | `PARTIALLY_CLOSED`（保持） | |
| `OPEN`/`PARTIALLY_CLOSED` | 数据恢复后§8回放确认缺口内出现且历史K线足以完整覆盖 | 恢复为回放前对应状态（`OPEN`或`PARTIALLY_CLOSED`），并把缺口期间应发生的成交按§6顺序补记 | 见§8.3/§16.7 |
| `OPEN`/`PARTIALLY_CLOSED` | 数据恢复后§8回放确认缺口内历史K线**无法**完整覆盖 | `UNRESOLVED_DATA_GAP` | 见§8.4/§16.7 |
| `UNRESOLVED_DATA_GAP` | 用户点击"紧急模拟平仓"（自动采用保守结算成交规则） | `EXITED`（`closeReason='DATA_GAP_CONSERVATIVE'`，`estimated=true`，`verified=false`） | 见§8.5/§16.6，唯一走出该状态的路径 |
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
8. **（draft-4撤销，见§17）** ~~每次加仓必须由用户再次点击确认，携带独立的idempotencyKey，不存在任何自动加仓路径。~~ **CEO本轮已撤销这一条：每次加仓由引擎在本节条件1-7全部满足时自动执行，携带引擎按`AUTO-ADDON-${tradeId}`规则确定性生成的`idempotencyKey`（§16.8），不再要求用户点击；每笔交易最多1次加仓的上限（条件5）保持不变。**

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

### 6.2 参考价与撮合时间（draft-4：开仓/加仓不再由"点击"驱动，改为引擎tick驱动，见§16.5）

- **参考价`referencePrice`**：**（draft-4撤销，见§17）** ~~用户点击"确认"按钮那一刻~~最近一次成功的V1.1刷新周期（30秒`v11decision`事件tick）缓存的`decision.price`，**不额外发起新的网络请求**。自动开仓/自动加仓的`referencePrice`取"引擎判定§16.2十四项条件全部满足的那次tick"缓存的`decision.price`；`emergencyClosePosition`（唯一保留的人工操作）的`referencePrice`取用户点击那一刻缓存的`decision.price`，与draft-2原逻辑一致。
- **撮合时间**：自动开仓/加仓/K线扫描型成交（止损/止盈）与触发K线的`closeTime`同步；`emergencyClosePosition`（人工介入型成交）与用户点击时间同步。
- **陈旧行情禁止成交**：`decision.dataHealth!=='normal'`时，拒绝任何自动开仓/加仓/新止损止盈判定，仅允许用户对已有持仓点击"紧急模拟平仓"（`UNRESOLVED_DATA_GAP`状态下同样只提供"紧急模拟平仓"，此时自动采用保守结算成交规则，见§3.4/§8/§16.6）。

### 6.3-6.4 滑点方向、手续费、市价单成交时间

见§4.4；所有自动/人工介入型操作均为模拟市价单，`fillTime`：自动成交=触发K线`closeTime`或引擎tick时间，`emergencyClosePosition`=`Date.now()`（点击时间）。

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

### 6.11 幂等键防重复操作（CEO决策第10项，draft-2/draft-3覆盖开仓/加仓/减仓/平仓/重置五种**点击型**操作；**draft-4起开仓/加仓/止损/止盈/平仓改为引擎自动触发，key的生成方来源相应改变，完整新规则见§16.8**）

```
account.actionLock: boolean   // 账户级互斥锁，任意一次状态变更操作执行期间为true，函数第一条语句同步检查并设置，finally中释放（机制本身不变，锁定的操作范围随draft-4调整，见§16.8）
```

**幂等键机制（真正的幂等语义，不是简单的"第二次拒绝"）**：每次调用状态变更核心函数，调用方必须传入一个稳定的`idempotencyKey`。**（draft-4撤销部分，见§17）** ~~开仓/加仓复用proposalId；减仓/平仓/重置由UI在用户点击的瞬间生成一个随机串~~——**draft-4起，自动开仓/自动加仓/自动止损/自动止盈/自动平仓的`idempotencyKey`不再由"用户点击瞬间"生成，而是由引擎按§16.8的确定性规则构造（例如`AUTO-OPEN-${signalId}`），使同一个信号/同一根K线/同一次数据缺口回放触发的重复处理天然收敛到同一个key；唯一仍由"用户点击瞬间"生成随机串的操作是`emergencyClosePosition`（紧急模拟平仓）与账户级设置操作（`resetPaperAccount`/`changeInitialCapital`/`confirmForcedObservationAcknowledgement`/§16.1的开启/暂停/恢复/禁止新开仓/关闭），这些仍然是真实点击事件驱动的。** 核心函数处理逻辑不变：

```
若 idempotencyKey 已存在于 account.processedIdempotencyKeys（或对应PaperFill/PaperLog历史记录中可查到）：
  不重新执行任何状态变更，直接返回**上一次**该key执行时的结果（从PaperFill/PaperLog中还原，保证多次调用幂等）
否则：
  正常执行操作，成功后把该key追加进processedIdempotencyKeys（有界环形缓冲，例如保留最近500个，足够覆盖"网络抖动导致的短时间重试"场景，不需要无限增长）
```

这与draft-1"一次性方案消费+拒绝重复"的设计相比，多了"重复调用返回原结果而不是报错"这一层——对UI更友好，且明确覆盖了减仓/平仓/重置等操作；draft-4进一步把这一层扩展到"引擎自身重复处理同一个自动化触发条件"的场景（REST重复数据、页面重复刷新、同一根K线重复处理、页面恢复重放、数据缺口回放、多次触发相同按钮事件），详见§16.8。

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
- 唯一允许的操作是§8.5"紧急模拟平仓（保守结算模式）"。
- 每次新的`v11decision`事件到来时，仍然尝试§8.3的回放（万一后续又有新的历史窗口数据能覆盖，虽然实际上`fetchAllTimeframeKlines`固定窗口向前滑动通常不会让更早的缺口重新变得可获取，但不排除未来实现变化，此项检查保留作为兜底，不作为主要解决路径）。

### 8.5 用户点击"紧急模拟平仓"以保守结算走出`UNRESOLVED_DATA_GAP`（唯一走出该状态的路径；draft-4起并入`emergencyClosePosition`，不再是独立函数`confirmConservativeSettlement`，见§16.6/§17）

```
emergencyClosePosition(trade, account, storage, idempotencyKey): {ok, trade?, reason?}
// trade.status==='UNRESOLVED_DATA_GAP'时，函数内部自动切换为本节定义的保守结算成交规则；
// 其余状态（OPEN/PARTIALLY_CLOSED）下按§16.6的常规"紧急模拟平仓"规则（当前markPrice+不利滑点）成交
```

- 只能由用户在UI显式点击"紧急模拟平仓"触发（`UNRESOLVED_DATA_GAP`状态下UI必须明确提示这是保守结算模式），文案必须包含"数据缺口无法完整回补，本次平仓按缺口后首个可获得的不利价格结算，结果仅为估算，不代表真实应得盈亏"。
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

## 10. UI 区域字段规范（draft-2/draft-3原始版本，**本节整体已被draft-4 §16.9取代，仅保留字段口径供参照，"开仓/加仓/减仓/平仓按钮"一行与常驻文案已作废，见下方标注**）

新增中文区域标题："**500 USDT模拟交易账户**"（若`initialCapital`被用户修改，标题动态显示为"**{initialCapital} USDT模拟交易账户**"），独立的`<article class="card span12">`，置于V1.2走势预测区域下方。**draft-4起该区域由§16.9的"500 USDT真实行情自动模拟交易"区域取代。**

**常驻文案（已作废，见§16.9新文案）**：~~`模拟交易，不是真实下单，不连接交易所账户。`~~

必须显示的字段（**以下字段口径不变，继续由§16.9引用**）：

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
| 当前模拟仓位 | 当前模拟仓位（含"数据缺口待处理"状态提示） | `PaperTrade`，`status==='UNRESOLVED_DATA_GAP'`时需醒目提示，唯一操作为§16.6"紧急模拟平仓"（`emergencyClosePosition`，此状态下自动采用保守结算成交规则） |
| ~~开仓/加仓/减仓/平仓按钮~~ | ~~生成方案 / 确认开仓 / 确认加仓 / 减仓 / 平仓 / 确认保守结算~~ | **已作废（draft-4撤销，见§16.0/§17）**：不再有逐笔点击按钮，改为§16.9的自动交易总开关/暂停/恢复/禁止新开仓/紧急模拟平仓控制面板 |
| 风险预算计算 | 本次风险预算（基于当前净值） | `calcRiskBudget`结果，UI必须显式标注"基于当前净值计算，非固定初始本金" |
| 模拟成交记录 | 模拟成交记录 | `PaperTrade.fills` |
| 模拟交易日志 | 模拟交易日志 | `ethAlphaPaperLog` |
| JSON/CSV导出 | 导出JSON / 导出CSV | 导出字段须含`estimated`/`verified`，供下游过滤 |
| 重置账户按钮 | 重置模拟账户 | 二次确认+`idempotencyKey`，见§2.4/§6.11（**保留，账户级设置操作，不属于本轮撤销的"逐笔点击"范畴**） |

**禁止措辞**：不得出现"稳赚""必涨""必跌""保证盈利""跟单必赚"；净值/盈亏相关数字必须在同一屏幕内与常驻免责声明共同出现。

---

## 11. 函数接口清单（draft-2/draft-3原始版本，**部分函数已被draft-4废弃/改名，见下方每行标注与§16.10完整新清单**）

```
loadPaperAccount(storage): PaperAccount
savePaperAccount(account, storage): {ok, reason?}
validatePaperAccountSettings(settings): {ok, value?, message?}
resetPaperAccount(storage, confirmFn, idempotencyKey): PaperAccount                                       // 保留，账户级设置操作
changeInitialCapital(storage, newCapital, confirmFn, alsoReset, idempotencyKey): {ok, account?, reason?}   // 保留，账户级设置操作

buildTradeProposal(decision, account, direction): TradeProposal | {ok:false, reason}                       // 保留，但角色改变：不再是"等待用户点击确认"的对象，改为引擎内部消费+UI"下一自动动作"只读预览，见§16.5
autoOpenPosition(proposal, decision, forecast, account, storage, idempotencyKey): {ok, trade?, reason?}    // 【已废弃，被§16.10 autoEngineOpenPosition取代】此签名是draft-3对draft-2confirmOpenPosition的字面改名，未反映"不再需要点击"这一本质变化
autoAddOn(trade, decision, account, storage, idempotencyKey): {ok, trade?, reason?}                        // 【已废弃，被§16.10 autoEngineAddOn取代】同上
confirmReduce(trade, quantity, decision, account, storage, idempotencyKey): {ok, trade?, reason?}          // 【已废弃，整体移除】CEO本轮明确不再保留手动部分减仓概念，分批止盈完全自动化（scanClosedBarsForExits既有机制），唯一保留的手动仓位操作是emergencyClosePosition
emergencyClosePosition(trade, decision, account, storage, idempotencyKey): {ok, trade?, reason?}           // 【保留但语义收窄】draft-2的"手动全部平仓"改为draft-4唯一保留的手动仓位操作——"紧急模拟平仓"（异常/风险时的人工介入，非常规操作），若trade.status==='UNRESOLVED_DATA_GAP'自动采用§8.5保守结算成交规则，见§16.6
confirmConservativeSettlement(trade, account, storage, idempotencyKey): {ok, trade?, reason?}              // 【已废弃，并入emergencyClosePosition】不再是独立函数，见上一行
confirmForcedObservationAcknowledgement(account, storage, idempotencyKey): {ok, account?, reason?}         // 保留，账户级风险确认操作

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
- v1.3-draft-3：新增CEO需求「建议档案与影子验证」（§15）——系统给出可执行建议时无论用户是否点击都自动、不可变地存档（`SignalSnapshot`），并使用建议产生**之后**的真实已收盘K线做只读影子验证，与§2-§8「模拟账户」严格资金隔离。§0-§14「模拟账户」规则本轮零改动，`PAPER_ALGORITHM_VERSION`保持`v1.3-draft-2`不变（理由见§15.14）。
- v1.3-draft-4（本版本）：CEO**正式撤销**draft-2/draft-3"模拟账户需要用户逐笔点击确认才生效"的授权模型，新增「真实行情自动模拟交易引擎」（§16）——用户只需一次性开启"自动模拟交易总开关"并二次确认，之后系统根据V1.1正式规则自动开仓/加仓/减仓/止损/50-30-20分批止盈/移动保护/平仓；新增引擎宏观状态机（`AUTO_PAPER_OFF/ARMED/RUNNING/PAUSED/RISK_LOCKED/DATA_BLOCKED`，§16.1）、自动开仓十四项条件（§16.2）、反向信号冷却期规则（§16.4）、真实市场模拟成交术语澄清（§16.5）、与建议档案的自动关联+五个新`userActionStatus`枚举（§15.9/§16.6）、浏览器心跳/离线回放机制（§16.7）、引擎自动幂等键生成规则（§16.8）。§0-§15中断言"用户点击才生效"的具体条款已**原地改写**（不是新增旁注），完整扫描/撤销记录见§17；`PENDING_ENTRY`/`CANCELLED`/`BLOCKED`三个状态与`confirmReduce`函数整体移除，`confirmConservativeSettlement`并入`emergencyClosePosition`；`PAPER_ALGORITHM_VERSION`/`SIGNAL_ARCHIVE_ALGORITHM_VERSION`均递增为`v1.3-draft-4`（§16.11）。§2/§4/§5.1/§5.3/§5.4/§5.5/§6.6-§6.10的账户会计恒等式、手续费滑点公式、风险预算/加仓/日亏损/回撤/杠杆数值与公式、K线扫描撮合红线**全部零改动**，仅触发方式改变。

---

## 15. 建议档案与影子验证 Signal Archive & Shadow Evaluation（draft-3新增，CEO本轮需求）

### 15.0 与§2-§8/§16「模拟账户」的边界（红线，逐条对应CEO本轮"一、严格区分三套系统"；**draft-4更新第③行——不再需要逐笔用户点击，见§16**）

| 系统 | 触发条件 | 是否需要用户操作 | 是否产生账户资金变化 | 存储命名空间 |
|---|---|---|---|---|
| ① 建议档案 Signal Archive | 系统给出可执行建议时（§15.3八条件同时满足） | **不需要**——自动记录，用户看没看到都会存档 | 否，无`equity`/`cash`概念 | `ethAlphaSignalArchive`/`ethAlphaSignalEvents`（§15.10） |
| ② 影子验证 Shadow Evaluation | 建议档案存在后，随后续已收盘K线自动评估 | **不需要**——纯只读评估，不接受任何用户输入来改变评估结果本身 | **否，红线**：不建立`PaperPosition`、不占用`marginUsed`、不产生`PaperFill`、不改变`PaperAccount`任何字段 | `ethAlphaShadowResults`（§15.10） |
| ③ 模拟账户 Auto Paper Trading Account（§2-§8/§16，draft-4更新） | 引擎处于`AUTO_PAPER_RUNNING`且§16.2十四项条件满足时**自动**执行 | **仅需一次性开启**（"自动模拟交易总开关"+二次确认，见§16.1）；运行期间**不需要**逐笔点击，用户只保留暂停/恢复/禁止新开仓/紧急模拟平仓/关闭的宏观控制权 | 是——`cash`/`equity`/`marginUsed`按§2.2恒等式变化 | `ethAlphaPaperAccount`/`ethAlphaPaperTrades`/`ethAlphaPaperLog`（§9） |

**红线**：任何函数如果同时读写`ethAlphaShadowResults`与`ethAlphaPaperAccount`/`ethAlphaPaperTrades`，或把`ShadowResult`的`realizedGrossR`/`realizedNetR`按某种换算写入`PaperAccount.realizedPnlGross`/`cash`等字段，视为违反本节红线，`V1_3_ACCEPTANCE_TESTS.md` T38专项验证资金隔离。三套系统之间唯一允许的合法关联，是§15.9定义的`linkedPaperTradeId`**指针**（只记录"哪条建议对应用户后来点了哪笔模拟交易"，不做任何数值换算或回写）。

### 15.1 新增术语与localStorage命名空间总览

| # | 术语 | 定义 | 归属 |
|---|---|---|---|
| 14 | 建议快照 SignalSnapshot | 系统在某一时刻真实给出的可执行建议的不可变存档记录 | draft-3新增，§15.2 |
| 15 | 建议指纹 signalFingerprint | 用于去重与版本判定的稳定标识 | draft-3新增，§15.4 |
| 16 | 建议生命周期 SignalLifecycleStatus | 建议从产生到最终结果的状态机 | draft-3新增，§15.5 |
| 17 | 影子撮合 Shadow Match | 只读地用后续已收盘K线判定建议是否触发进场/止损/目标 | draft-3新增，§15.6 |
| 18 | 影子结果 ShadowResult | 影子撮合产生的、可能随新K线到来而更新的当前评估投影 | draft-3新增，§15.6/§15.10 |
| 19 | 建议事件 SignalEvent | 记录建议生命周期变化、用户行为变化、关联关系变化的追加式审计条目 | draft-3新增，§15.10 |

命名空间：

| Key | 内容 | 类型 |
|---|---|---|
| `ethAlphaSignalArchive` | `SignalSnapshot[]`（创建后不可变） | Array |
| `ethAlphaSignalEvents` | `SignalEvent[]`（只能`push`，审计追加式） | Array |
| `ethAlphaShadowResults` | `ShadowResult[]`（每个`signalId`至多一条，允许被评估流程**覆盖更新**，是唯一允许覆写的存储——因为它是投影/缓存，不是原始记录，见§15.2红线的例外说明） | Array（按`signalId`唯一） |

### 15.2 `SignalSnapshot` 接口与不可变性规则（对应CEO"三、建议快照必须不可变"）

```ts
interface SignalSnapshot {
  signalId: string;                  // `SIG-${createdAt}-${随机后缀}`
  symbol: 'ETHUSDT';                 // V1.3现阶段恒定，字段保留为schema前向兼容
  direction: 'long' | 'short';       // 恒不含'long_caution'/'neutral'/'none'，见§15.3条件2
  createdAt: number;                 // 本条记录写入ethAlphaSignalArchive的时间
  dataAsOf: number;                  // 建议所依据的最后一根已收盘15分钟K线的closeTime（与draft-2 PaperFill.dataAsOf同口径）
  validFrom: number;                 // = dataAsOf（该确认K线收盘的那一刻起，该建议就已经"存在"，与系统实际写入时间createdAt可能有<30秒差异）
  validUntil: number;                // = dataAsOf + SIGNAL_DEFAULT_VALIDITY_MS（§15.11，仅约束"等待进场"阶段，见§15.5）
  lifecycleStatus: 'RECORDED';       // **创建时刻的固定值**，当前生命周期由ShadowResult投影提供，见下方"不可变性与投影"说明
  entryType: 'IMMEDIATE_ZONE';       // V1.3当前唯一支持的入场类型：基于V1.1 triggerPlans定义的进场区判定"触及"，不是限价单精确成交建模（见§15.6设计说明），字段保留枚举是为未来扩展预留
  entryZone: { lower: number; upper: number; estimatedEntry: number }; // 冻结自 decision.triggerPlans[direction] 的 triggerZone 边界与 estimatedEntry（v1-core.js buildTriggerPlan）
  triggerConditions: string[];       // 冻结自 [triggerPlans[direction].triggerCondition, .closeConfirmation, .btcCondition, .volumeCondition]，4条文案
  invalidation: string[];            // 冻结自 decision.exitConditions（与draft-2 PaperTrade.invalidation同一来源，5条文案，审计/展示用途，见§15.6设计说明——不作为独立于stopLoss的第二个数值触发位）
  stopLoss: number;                  // 冻结自 decision.stopLoss
  targets: number[];                 // 冻结自 decision.targets（3元素数组）
  riskRewardGross: number;           // 冻结自 decision.triggerPlans[direction].riskReward.grossValue（V1.1自己对该进场区计算的**计划阶段**毛盈亏比，不是影子验证事后的已实现值）
  riskRewardNet: number;             // 冻结自 decision.triggerPlans[direction].riskReward.netValue，同上，计划阶段净盈亏比
  decisionSnapshot: object;          // deepClone(decision)，完整V1.1决策快照（含signalPermission/opportunityScores/score/state/htfState/mtfState/ltf15m/mtf1h/htf4h等全部字段，ATR/EMA/Swing/成交量/动态支撑压力均已包含在ltf15m/mtf1h/htf4h内，不重复抽取）
  forecastSnapshot: object | null;   // deepClone(window.__prevForecast)，V1.2三时窗（m15/h1/h4）预测快照，只读存档证据，不参与§15.3创建判定（同draft-2 §7.1红线）
  btcStructureSnapshot: { tf15m: object; tf1h: object; tf4h: object }; // 只读调用v1-core.js已导出的analyzeKlines()对window.__lastMarketData.btc.{tf15m,tf1h,tf4h}生成的结构快照，deepClone冻结；补充decisionSnapshot本身未展开的BTC结构细节（decisionSnapshot只含btcPrice/btcAlignment摘要）——**只读复用既有导出函数，不重新做多空方向判断**
  feeAssumption: { takerFeeRate: number; spreadRate: number; slippageRate: number }; // 冻结自v1-core.js COST_DEFAULT，独立于任何PaperAccount.settings（Signal Archive不依赖账户存在）
  slippageAssumption: number;        // = spreadRate/2 + slippageRate，冻结值，供§15.6净R计算直接使用
  decisionAlgorithmVersion: string;  // 常量'v1-core@v1.2.0'，标识冻结的v1-core.js基准（v1-core.js本身不可修改，字段为未来受控修订预留可追溯性）
  forecastAlgorithmVersion: string;  // 常量'v1_2-forecast-core@v1.2.0'，同上理由
  riskRuleVersion: string;           // = 创建时刻的SIGNAL_ARCHIVE_ALGORITHM_VERSION（§15.14，本文档§15.3/§15.6规则版本，与PAPER_ALGORITHM_VERSION是独立版本号）
  sourceConfirmedBarTime: number;    // 该建议所依据的已收盘15分钟K线的openTime（用于§15.4指纹与§15.6影子撮合的起点游标）
  supersedesSignalId: string | null; // draft-3为满足CEO"四、版本规则"新增字段：若本条是同方向、指纹发生实质变化后创建的新版本，指向被取代的上一条signalId；首次创建为null
  acknowledgedAt: number | null;     // 用户首次在UI"看到"该建议的时间，创建时为null，只能由§15.9事件驱动的投影更新，原始数组元素本身不重写
  linkedPaperTradeId: string | null; // 引擎自动开仓后关联的PaperTrade.tradeId（draft-4起自动开仓触发，非用户点击，见§16.6），创建时为null，同上只能由投影更新
  userActionStatus: 'UNSEEN' | 'SEEN' | 'ACCEPTED' | 'REJECTED' | 'MISSED'; // 创建时固定为'UNSEEN'，当前值由投影提供
}
```

**不可变性与"投影"机制（红线，解决CEO"原始字段禁止被之后刷新覆盖或回写修改，后续变化只能追加事件"与字段清单本身含`lifecycleStatus`/`acknowledgedAt`/`linkedPaperTradeId`/`userActionStatus`这类看似会变化的字段之间的表面张力）**：

`ethAlphaSignalArchive`中存储的`SignalSnapshot`对象，**在写入后任何字段都不会被程序原地修改或覆盖**——包括上面列出的`lifecycleStatus`（恒为创建时的`'RECORDED'`）、`acknowledgedAt`/`linkedPaperTradeId`（恒为创建时的`null`）、`userActionStatus`（恒为创建时的`'UNSEEN'`）。这4个字段之所以仍然出现在`SignalSnapshot`接口里（满足CEO"至少保存"清单要求它们存在于快照结构中），是因为它们代表"创建那一刻的默认值"，具备审计意义（证明"这条建议刚创建时确实是未确认/未关联的"）。

**当前的实际值**（供UI展示、供准确度统计使用）由`getSignalCurrentView(signalId)`函数计算：以`ethAlphaSignalArchive`中的原始不可变记录为基底，**折叠**（fold）`ethAlphaSignalEvents`中该`signalId`的全部事件（按`time`升序）与`ethAlphaShadowResults`中该`signalId`的当前投影记录，得到一个"合并视图"对象，供UI渲染与导出使用。这个合并视图**不写回**`ethAlphaSignalArchive`。`ethAlphaShadowResults`本身作为投影缓存**允许**被覆盖更新（每次新的已收盘K线到来重新评估后原地更新该`signalId`对应的一条记录），这不违反不可变性红线，因为它从设计上就是"当前最新计算结果"的缓存，不是"原始建议记录"本身——`V1_3_ACCEPTANCE_TESTS.md` T31专项区分这两类存储的可变性预期。

### 15.3 建议创建条件（对应CEO"二、什么情况下创建建议档案"）

**八条件逻辑与（缺一不可）**，评估频率复用既有30秒`v11decision`事件（不新增定时器）：

| # | CEO条件 | 具体判定表达式 | 来源 |
|---|---|---|---|
| 1 | V1.1交易许可允许参与 | `decision.worthBetting === true` | `v1-core.js buildDecision()` |
| 2 | 方向为可执行多头或可执行空头 | `decision.biasDirection === 'long' \|\| decision.biasDirection === 'short'`（**不含**`'long_caution'`——后者是降级确信度状态，不视为"可执行"，与draft-2 §6.1 `TradeProposal`生成条件的方向白名单完全一致） | `decision.biasDirection` |
| 3 | 交易计划未被硬性规则blocked | `decision.opportunityScores.blocked === false` | `decision.opportunityScores` |
| 4 | 数据健康正常 | `decision.dataHealth === 'normal'` | `decision.dataHealth` |
| 5 | 使用已收盘K线形成正式状态 | 自动满足，无需额外判定——V1.1的`state`/`htfState`/`mtfState`状态机本身恒定基于`confirmedPrice`（已收盘K线），不存在"用未收盘价格形成正式状态"的路径 | v1-core.js `analyzeKlines()`设计不变量 |
| 6 | 存在确定的进场条件或进场区域 | `decision.triggerPlans[decision.biasDirection]`存在，且其`entryZone`可解析出有限数值的`lower`/`upper`边界 | `decision.triggerPlans` |
| 7 | 存在失效位、止损位和目标位 | `Number.isFinite(decision.stopLoss) && Array.isArray(decision.targets) && decision.targets.length>=1 && Array.isArray(decision.exitConditions) && decision.exitConditions.length>0` | `decision.stopLoss`/`decision.targets`/`decision.exitConditions` |
| 8 | 不是手动观察模式 | `decision.isManual === false` | `decision.isManual` |

条件1（`worthBetting`）本身的定义已经把"`!manual && health==='normal' && p.level==='trend_entry_allowed' && rr.status==='ok' && rr.netValue>=1.5`"合并在内（见v1-core.js），因此条件1、3、4、8存在字面重叠，本文档**刻意保留全部字面判定**（而不是只写`worthBetting===true`就够了）：这是为了防止`v1-core.js`未来若合法修订了`worthBetting`内部合成逻辑（红线允许的唯一变更路径），Signal Archive的创建判定不会静默继承一个不再等价的隐藏假设——显式罗列每一条使得任何后续review都能逐条核对，而不必反查`worthBetting`当前内部到底由哪些子条件合成。

**红线（对应CEO"不值得下注、数据异常、观察模式等状态继续由原有决策日志记录，不进入正式可执行建议档案"）**：以上八条件任一不满足，本次tick**不**创建`SignalSnapshot`，该决策继续且只继续写入既有`ethAlphaDecisionLogs`/`ethAlphaDecisionLogsV11`（V1.1既有机制，本轮不改动）。**红线**：V1.2预测（`forecastSnapshot`）不得出现在以上八条件的判断表达式里，只能作为快照证据字段（同draft-2 §7.1红线的延伸，`V1_3_ACCEPTANCE_TESTS.md` T29专项验证）。

### 15.4 `signalFingerprint`、去重与版本规则（对应CEO"四、建议去重与版本规则"）

```
signalFingerprint = [
  symbol,
  direction,
  sourceConfirmedBarTime,
  round(entryZone.lower, pricePrecision) + '-' + round(entryZone.upper, pricePrecision),
  round(stopLoss, pricePrecision),
  targets.map(t => round(t, pricePrecision)).join(','),
  decisionAlgorithmVersion,
  riskRuleVersion
].join('|')
```

**设计说明**：`signalFingerprint`是本文档定义的**确定性拼接字符串**，不是加密哈希摘要——选择字符串拼接而非哈希函数，是为了保持审计可读性（人工审查`ethAlphaSignalArchive`时可以直接读出指纹的构成，不需要反查哈希算法），且V1.3已有先例（`tradeId`/`fillId`/`signalId`均为模板字符串而非哈希，参见draft-2 §3.2/§3.3）。价格类字段参与拼接前统一按`pricePrecision`取整，避免浮点噪声导致同一根K线同一计划被误判为"发生了实质变化"。

**去重规则（红线）**：

1. **同一已收盘K线、同一方向、同一计划指纹只允许写入一次**：写入前必须在`ethAlphaSignalArchive`中查找是否已存在`sourceConfirmedBarTime`相同、`direction`相同、`signalFingerprint`完全相同的记录；若存在，本次tick**不写入**，直接返回该已存在记录（幂等读，不产生新`SignalSnapshot`也不产生新`SignalEvent`）。
2. **新版本创建条件**：仅当**同时**满足——(a) 出现了比该方向当前最新一条`SignalSnapshot`的`sourceConfirmedBarTime`更新的已收盘K线，**且**(b) 本次计算出的`signalFingerprint`与该方向当前最新一条记录不同（即方向、进场区、止损、目标或`riskRuleVersion`/`decisionAlgorithmVersion`任一实质分量发生变化）——才创建新的`SignalSnapshot`，其`supersedesSignalId`指向被取代的上一条`signalId`。**红线**：仅新K线收盘但计划各分量均未变化（指纹相同）时，**不得**创建新版本，即使`createdAt`时间戳会自然不同。
3. **红线（禁止用未收盘实时价格制造新建议）**：判断"是否出现新的已收盘K线"必须使用`sourceConfirmedBarTime`（K线`openTime`）比较，**不得**使用`decision.price`（未收盘实时价）或`Date.now()`触发新版本创建——同一根已收盘K线期间的重复30秒轮询，无论`decision.price`如何跳动，都不产生新记录或新版本。
4. 若被取代的旧版本（`supersedesSignalId`所指向的记录）当时的生命周期仍处于非终态（`WAITING_TRIGGER`等），创建新版本时必须向`ethAlphaSignalEvents`追加一条`eventType:'SUPERSEDED'`的事件记录在旧`signalId`名下（审计"这条建议后来被新版本取代"），**不得**因为出了新版本就把旧版本从`ethAlphaSignalArchive`中删除或修改其状态字段——旧版本自己的影子验证（§15.6）继续独立进行至其自然终态，两条记录在统计口径上都各自计数（§15.8不因版本取代而消除任何一条的统计权重，除非旧版本被取代前处于`WAITING_TRIGGER`，此时其最终结局仍按§15.5正常判定为`EXPIRED_UNTRIGGERED`/`INVALIDATED_BEFORE_ENTRY`/`TRIGGERED`等，不因"被取代"这件事本身产生一个新的终态)。

### 15.5 建议生命周期状态机 `SignalLifecycleStatus`（对应CEO"五、建议生命周期"）

```
RECORDED（创建瞬间，立即自动进入下一状态，非持久停留态）
  → WAITING_TRIGGER
      → TRIGGERED
          → TARGET_1_HIT → TARGET_2_HIT → TARGET_3_HIT → COMPLETED（终态）
          → STOPPED（终态，任一阶段触发原始stopLoss，见§15.6设计说明——不模拟移动止损）
          → UNRESOLVED_DATA_GAP（非终态，见§15.7）→（恢复后回到取消前状态继续判定，或转入下方终态）
      → EXPIRED_UNTRIGGERED（终态，validUntil前从未触及entryZone）
      → INVALIDATED_BEFORE_ENTRY（终态，触发前价格已越过stopLoss，见§15.6判定规则）
      → UNRESOLVED_DATA_GAP（非终态，见§15.7）
任意非终态 → CANCELLED_BY_RULE_CHANGE（终态，仅当riskRuleVersion在评估过程中发生不兼容升级，极少发生，见下方说明）
```

| 当前状态 | 触发事件 | 下一状态 |
|---|---|---|
| `RECORDED` | 写入`ethAlphaSignalArchive`后的首次影子评估tick | `WAITING_TRIGGER` |
| `WAITING_TRIGGER` | 已收盘K线触及`entryZone`（§15.6触发判定） | `TRIGGERED` |
| `WAITING_TRIGGER` | 已收盘K线触及`entryZone`**且同一根K线**也触及`stopLoss` | `STOPPED`（直接终态，跳过`TRIGGERED`的持久停留，但仍记一次`ENTRY_FILLED`+`STOP_FILLED`事件，见§15.6"同K线进场后止损"规则） |
| `WAITING_TRIGGER` | 尚未触及`entryZone`，但已收盘K线已越过`stopLoss`（§15.6判定） | `INVALIDATED_BEFORE_ENTRY` |
| `WAITING_TRIGGER` | 既未触及`entryZone`也未越过`stopLoss`，且最新已收盘K线时间 > `validUntil` | `EXPIRED_UNTRIGGERED` |
| `WAITING_TRIGGER` | 数据失效且恢复后无法完整回补 | `UNRESOLVED_DATA_GAP` |
| `TRIGGERED` | 触及`targets[0]` | `TARGET_1_HIT` |
| `TRIGGERED` | 触及原始`stopLoss` | `STOPPED` |
| `TARGET_1_HIT` | 触及`targets[1]` | `TARGET_2_HIT` |
| `TARGET_1_HIT` | 触及原始`stopLoss` | `STOPPED` |
| `TARGET_2_HIT` | 触及`targets[2]` | `TARGET_3_HIT` |
| `TARGET_2_HIT` | 触及原始`stopLoss`（理论极端反转场景，保留转换以保证状态机完整性） | `STOPPED` |
| `TARGET_3_HIT` | 立即 | `COMPLETED` |
| `TRIGGERED`/`TARGET_1_HIT`/`TARGET_2_HIT` | 数据失效且恢复后无法完整回补 | `UNRESOLVED_DATA_GAP` |
| `UNRESOLVED_DATA_GAP` | 数据恢复且回补完整（§15.7） | 回到进入该状态前的对应状态，按补齐的K线继续判定 |
| `UNRESOLVED_DATA_GAP` | 长期无法回补 | 保持`UNRESOLVED_DATA_GAP`，`verified=false`，不强制转终态（与draft-2 Paper Trading的`UNRESOLVED_DATA_GAP`不同，影子验证没有"用户确认保守结算"这个人工出口，因为影子验证本来就不产生真实/模拟资金后果，没有必须"结清"的压力——§15.7详述） |
| 任意非终态 | `riskRuleVersion`发生不兼容升级（管理员/实现方明确判定旧评估逻辑不适用于新规则，须写入`SignalEvent`说明原因） | `CANCELLED_BY_RULE_CHANGE` |

**红线**：`COMPLETED`/`STOPPED`/`EXPIRED_UNTRIGGERED`/`INVALIDATED_BEFORE_ENTRY`/`CANCELLED_BY_RULE_CHANGE`为终态，**不允许**重新变回`WAITING_TRIGGER`或任何其他非终态（CEO原文"不允许完成状态重新变回等待状态"）。`UNRESOLVED_DATA_GAP`不是终态，但离开该状态只能前进到"回补后按已收盘K线继续判定所得出的状态"，不允许倒退到比进入该状态前更早的生命周期阶段。

**设计说明（不模拟移动止损，红线）**：`TARGET_1_HIT`/`TARGET_2_HIT`之后判断`STOPPED`时，统一使用`SignalSnapshot.stopLoss`**原始冻结值**，**不**模拟draft-2 §6.10"移动止损到保本位"的仓位管理动作。理由：移动止损是Paper Trading账户里用户主动（或系统按规则代为执行）的**仓位管理决策**，而Signal Archive/Shadow Evaluation代表的是"如果完全按V1.1原始建议的止损止盈位置被动持有，结果客观上是什么"这一更纯粹的、不掺杂任何后续仓位管理假设的验证口径；如果引入移动止损假设，就是在事后为V1.1从未做出过的一个具体交易管理动作背书，属于臆造，与CEO"不得后见之明"的精神冲突。`V1_3_ACCEPTANCE_TESTS.md` T35专项验证`TARGET_1_HIT`之后止损判定仍使用原始`stopLoss`而非任何移动值。

**设计说明（"失效位"与"止损位"的数值收敛，红线澄清）**：CEO要求判断"触发进场后先到止损、失效位还是目标位"。经与V1.1现有数据结构核对（`decision.exitConditions`/`triggerPlans[direction].invalidation`均为**文案数组**，v1-core.js未定义独立于`stopLoss`的第二个数值失效价位），本文档**不为"失效位"臆造一个V1.1未定义的数值字段**：进场后的判定实际只需在`stopLoss`与`targets`之间比较先后（与draft-2 §6.7"同一根K线同时触发按止损处理"红线完全一致的收敛结论），`SignalSnapshot.invalidation`字段继续作为文案审计证据保留（供人工阅读该笔建议当时的结构性失效描述），但**不参与**状态机的数值判定。`V1_3_ARCHITECTURE_REVIEW.md`§9.3记录了这一设计判断供CEO复核。

### 15.6 影子撮合与评估规则（对应CEO"六、真实行情影子验证"）

**红线（禁止未来数据泄漏）**：影子撮合**只能**读取`openTime > sourceConfirmedBarTime`（严格晚于建议所依据的确认K线）且`isClosed===true`的15分钟K线，**禁止**使用建议形成之前的K线，也**禁止**使用当前尚未收盘的K线（`isClosed===false`）参与任何触发/止损/目标判定——只能等它收盘后作为下一次评估tick的输入。

**评估顺序（每根新收盘K线，按`openTime`递增顺序，逐根处理，不得跳根批量判断"最终结果"）**：

**A. `WAITING_TRIGGER`阶段（每根新K线依次判断，命中即停止本根K线的后续判断）**：

```
多头：entryHit  = bar.low  <= entryZone.upper
      invalidHit = !entryHit && bar.low  <= stopLoss     // 未触及进场区却已跌破止损：整段进场前提落空
空头：entryHit  = bar.high >= entryZone.lower
      invalidHit = !entryHit && bar.high >= stopLoss
```

1. 若`entryHit`：状态转`TRIGGERED`，`entryFillPrice = entryZone.estimatedEntry`（**不**在区间内插值假设更优/更差的具体成交点位——V1.1本身通过`estimatedEntry`已经给出了该进场区唯一的参考入场价，参见v1-core.js `buildTriggerPlan`，本文档只读复用，不新增假设）。
   - **同一根K线内**继续检查该K线是否也触及`stopLoss`（多头`bar.low<=stopLoss`，空头`bar.high>=stopLoss`）：若是，直接转`STOPPED`（CEO原文"同一根K线同时触发进场和止损，按进场后止损处理"），出场价按§15.6.B跳空规则计算；若同一根K线**也**触及`targets[0]`（无止损触发），视为进场后于同根K线内到达目标一，直接转`TARGET_1_HIT`（本文档为CEO未明确覆盖的"进场+目标同K线（无止损）"场景补充的自然推论，不与CEO任何已写明规则冲突）。
2. 否则若`invalidHit`：状态转`INVALIDATED_BEFORE_ENTRY`（终态，不计入触发后胜负率，见§15.8）。
3. 否则若该根K线的`closeTime > validUntil`：状态转`EXPIRED_UNTRIGGERED`（终态，**不算亏损**，见§15.8）。
4. 否则保持`WAITING_TRIGGER`，处理下一根K线。

**B. `TRIGGERED`及之后阶段（复用draft-2 §6.6-§6.9已验证的保守撮合红线，仅将`currentStop`替换为固定的`SignalSnapshot.stopLoss`，`targets[i]`替换为`SignalSnapshot.targets[i]`）**：

```
多头：hitStop = bar.low <= stopLoss；hitTarget = bar.high >= 当前生效目标价
空头：hitStop = bar.high >= stopLoss；hitTarget = bar.low <= 当前生效目标价
若 hitStop && hitTarget 同时为真 → 只按止损处理（红线，同draft-2 §6.7）
止损成交价：跳空规则同draft-2 §6.8——gapped = 多头bar.open<stopLoss/空头bar.open>stopLoss，基准价=gapped?bar.open:stopLoss，按§4.4方向表叠加不利滑点（CEO"跳空越过止损，按首个可获得的不利价格"）
目标成交价：只按计划目标价叠加不利滑点，不因有利跳空改善（同draft-2 §6.9，CEO"有利跳空不能假设获得优于目标位的成交"）
```

**MFE/MAE 公式**：从`TRIGGERED`那一刻起（含触发当根K线本身），到该建议达到终态（`STOPPED`/`COMPLETED`）为止（若长期未到终态则按当前已扫描到的最新已收盘K线累计计算，`ShadowResult`标记为"评估中"的中间值）：

```
多头：MFE = max(0, max(bar.high) - entryFillPrice)    // 取该区间全部已扫描K线high的最大值
      MAE = max(0, entryFillPrice - min(bar.low))     // 取该区间全部已扫描K线low的最小值
空头：MFE = max(0, entryFillPrice - min(bar.low))
      MAE = max(0, max(bar.high) - entryFillPrice)
```

**毛R与净R公式**（`R`以初始风险`|entryFillPrice - stopLoss|`为一个单位，`exitPrice`取该建议最终终态对应的出场成交价——`STOPPED`用止损成交价，`COMPLETED`用`targets[2]`成交价，`TARGET_1_HIT`/`TARGET_2_HIT`若长期停留未到终态则按当前最新已收盘K线的`close`估算一个"若现在了结"的临时净值，`ShadowResult`须明确标注该值是否为最终值）：

```
risk = |entryFillPrice - stopLoss|
多头：grossR = (exitPrice - entryFillPrice) / risk
空头：grossR = (entryFillPrice - exitPrice) / risk
净R调整（复用draft-2 §4.4方向表，用SignalSnapshot.feeAssumption/slippageAssumption代入，不产生真实资金流，纯算术）：
  entryPriceNet = 多头买入方向 entryFillPrice × (1 + slippageAssumption)，空头卖出方向 entryFillPrice × (1 - slippageAssumption)
  exitPriceNet  = 多头卖出方向 exitPrice × (1 - slippageAssumption)，空头买入方向 exitPrice × (1 + slippageAssumption)
  feeAdjustment = (entryPriceNet + exitPriceNet) × feeAssumption.takerFeeRate     // 双边各收一次手续费的等效价格调整
  多头：netR = (exitPriceNet - entryPriceNet - feeAdjustment) / risk
  空头：netR = (entryPriceNet - exitPriceNet - feeAdjustment) / risk
```

`EXPIRED_UNTRIGGERED`/`INVALIDATED_BEFORE_ENTRY`不计算MFE/MAE/毛R/净R（未发生假设进场，risk基准不存在，`ShadowResult`对应字段为`null`）。

**持有K线数量与持续时间**：`barsHeld = 从TRIGGERED所在K线到出场K线（含两端）的K线根数`，`durationMs = 出场K线closeTime - TRIGGERED所在K线的openTime`。

### 15.7 影子验证的数据缺口规则（对应CEO"九、数据缺口规则"）

复用draft-2 §8的设计精神（优先回补已收盘15分钟K线、按时间顺序重放、无法回补时不猜测胜负），但影子验证的数据缺口是**独立的**`ShadowDataGap`记录（附着在`ShadowResult`上，不是`PaperTrade.dataGap`）：

```ts
interface ShadowDataGap {
  startTime: number;
  missingBarCount: number | null;
  replayAttempts: { attemptedAt: number; coverageComplete: boolean; outcome: 'RESOLVED' | 'STILL_GAP' }[];
  resolvedAt: number | null;
}
```

- 回补成功（K线`openTime`序列相对缺口连续，判定方式同draft-2 §8.3）：按时间顺序逐根重放§15.6判定，`resolvedAt`记录，继续正常评估。
- 回补失败：`replayAttempts`追加`STILL_GAP`记录，生命周期状态维持`UNRESOLVED_DATA_GAP`，**不得**假设"大概率是盈利/亏损"而给出任何猜测性结果。
- **红线**：`ShadowResult.verified`字段在`lifecycleStatus==='UNRESOLVED_DATA_GAP'`期间恒为`false`，该记录**不计入**§15.8已验证准确度统计的任何分子/分母（`estimated`/`verified`语义与draft-2完全对齐，供下游过滤）。
- **红线（区分于draft-2的保守结算，CEO"不得使用用户确认的保守行政结算冒充真实市场结果"）**：影子验证**没有**类似draft-2 §8.5"用户确认保守结算"的人工出口——因为影子验证不产生真实或模拟资金后果，没有"必须结清账户"的业务压力，`UNRESOLVED_DATA_GAP`可以无限期保持，直到数据某天真正回补完整为止，**不允许**任何函数为影子验证发明一个"管理员/用户确认按估算价强制结算"的路径，那会把"未经验证的猜测"包装成看似客观的验证结果，与本节红线目的（客观检查系统准确度）直接冲突。

### 15.8 准确度统计口径（对应CEO"七、准确度统计口径"）

**红线：不得只显示一个"准确率"**，`computeSignalAccuracyStats(signals, shadowResults)`函数必须至少分别返回以下独立指标（均为只读聚合计算，不修改任何输入数据）：

| 指标 | 计算方式 | 分母说明 |
|---|---|---|
| 建议总数 | `count(signals)` | 全部已创建`SignalSnapshot`（含被`supersedesSignalId`取代的旧版本，各自独立计数） |
| 已触发数 | `count(lifecycleStatus in [TRIGGERED,TARGET_1_HIT,TARGET_2_HIT,TARGET_3_HIT,STOPPED,COMPLETED])` | — |
| 未触发过期数 | `count(lifecycleStatus===EXPIRED_UNTRIGGERED)` | — |
| 触发率 | 已触发数 / (建议总数 − 尚处于`WAITING_TRIGGER`/`UNRESOLVED_DATA_GAP`未决的数量) | 分母排除仍在等待中、尚无最终结果的记录 |
| 触发后止损率 | `count(STOPPED) / 已触发数` | **分母只用已触发数，`EXPIRED_UNTRIGGERED`不计入**（CEO"EXPIRED_UNTRIGGERED不计入触发后胜负率"） |
| 目标1到达率 | `count(lifecycleStatus in [TARGET_1_HIT,TARGET_2_HIT,TARGET_3_HIT,COMPLETED]) / 已触发数` | 同上 |
| 目标2到达率 | `count(lifecycleStatus in [TARGET_2_HIT,TARGET_3_HIT,COMPLETED]) / 已触发数` | 同上 |
| 目标3到达率（=完成率） | `count(lifecycleStatus in [TARGET_3_HIT,COMPLETED]) / 已触发数` | 同上 |
| 平均毛R | 已到达终态（`STOPPED`/`COMPLETED`）且`verified===true`的记录的`grossR`算术平均 | 见下方分母红线 |
| 平均净R | 同上，`netR`算术平均 | 同上 |
| 盈利因子 Profit Factor | `Σ(netR>0的netR) / \|Σ(netR<0的netR)\|` | 同上分母集合 |
| 平均MFE / 平均MAE | 同分母集合的算术平均 | 同上 |
| 多头/空头分别表现 | 以上全部指标按`direction`分组各算一遍 | — |
| 不同V1.1市场状态下表现 | 按`decisionSnapshot.state`（15分钟状态机六态）分组各算一遍以上指标 | — |
| 15分钟/1小时/4小时预测背景下表现 | 按`forecastSnapshot.m15/h1/h4.directionLabel`分组（`forecastSnapshot`为`null`的记录归入独立的"无预测快照"分组，不丢弃也不计入其他分组） | — |
| BTC支持/反对/中性时分别表现 | 按`decisionSnapshot.btcAlignment`（`'support'\|'conflict'\|'neutral'`）分组 | — |
| 用户执行/用户错过/用户主动放弃数量 | 按当前`userActionStatus`投影值（`ACCEPTED`/`MISSED`/`REJECTED`）计数 | — |
| 系统建议正确但用户错过的数量 | `count(userActionStatus===MISSED && lifecycleStatus in [TARGET_1_HIT,TARGET_2_HIT,TARGET_3_HIT,COMPLETED])` | — |
| 数据缺口导致无法验证的数量 | `count(lifecycleStatus===UNRESOLVED_DATA_GAP 或 ShadowResult.verified===false)` | 单独展示，不参与上方任何比率的分子分母 |

**分母红线（对应CEO"统计分母规则"）**：

1. `EXPIRED_UNTRIGGERED`**不计入**触发后胜负率（触发后止损率/目标123到达率）的分母——它既不是赢也不是输，是"从未发生"。
2. `UNRESOLVED_DATA_GAP`（含`ShadowResult.verified===false`的任何记录）**不计入**"已验证准确度"任何分子分母，只在"数据缺口导致无法验证的数量"单独展示。
3. `estimated===true`或`verified===false`的结果**不得**混入已验证统计——本节所有比率类指标的分母集合定义为`{已到达终态 STOPPED/COMPLETED/TARGET_N_HIT 且 verified===true}`，与`EXPIRED_UNTRIGGERED`/`INVALIDATED_BEFORE_ENTRY`（未发生进场，不适用R值统计）以及`UNRESOLVED_DATA_GAP`/`verified===false`（无法验证）三类互斥排除。
4. **红线（区分规则型前向验证与历史回测，CEO原文）**：`computeSignalAccuracyStats`的输出对象必须携带固定字段`statisticsBasis: 'FORWARD_RULE_BASED_SHADOW_EVALUATION'`，UI与导出文案必须明确标注"以下统计基于系统在**实际运行时点**给出的建议与其后真实行情表现的规则化影子验证，不是历史数据回测（backtest），不构成对未来准确率的保证或校准概率声明"——**禁止**出现"校准""概率""预测准确度保证"等措辞（同draft-2 §1强制措辞规则的延伸）。

### 15.9 用户行为关联（对应CEO"八、用户行为关联"；**draft-4整体重写，见§16.6/§17——原`ACCEPTED`/`REJECTED`两个"用户点击"语义的枚举值已撤销，被自动执行结果的五个新值取代**）

**`userActionStatus`枚举（draft-4）**：`'UNSEEN' | 'SEEN' | 'AUTO_EXECUTED' | 'AUTO_BLOCKED_BY_RISK' | 'AUTO_BLOCKED_BY_POSITION' | 'AUTO_MISSED_ENGINE_OFF' | 'AUTO_MISSED_DATA_GAP'`。**（draft-4撤销，见§17）** ~~`ACCEPTED`（用户点击"模拟开仓"）/`REJECTED`（用户点击"不采用该建议"）~~——CEO本轮已撤销逐笔点击模型，不再存在"用户对单条建议点击接受/拒绝"这个动作；`ACCEPTED`的语义由`AUTO_EXECUTED`取代（引擎自动执行），`REJECTED`语义不再产生（用户唯一能表达的"不要"是宏观的"暂停/禁止新开仓/关闭自动模拟交易"，不针对单条建议）。变化只能通过向`ethAlphaSignalEvents`追加事件驱动投影更新，不直接改写`ethAlphaSignalArchive`：

| 事件`eventType` | 触发时机 | 效果 |
|---|---|---|
| `SEEN` | 用户在UI打开"历史交易建议与影子验证"区域并且该建议进入可视区域 | `userActionStatus: UNSEEN → SEEN`，`acknowledgedAt`投影值记录首次SEEN时间 |
| `AUTO_EXECUTED` | 引擎自动开仓成功并关联该`signalId`（见下，§16.6） | `userActionStatus → AUTO_EXECUTED` |
| `AUTO_BLOCKED_BY_RISK` | 该`signalId`对应的进场区被触及（Shadow Evaluation判定`TRIGGERED`）那一刻，引擎因`riskRegime`为`DAILY_LOSS_LOCKED`/`FORCED_OBSERVATION`，或`engineState`为`AUTO_PAPER_PAUSED`/`AUTO_PAPER_RISK_LOCKED`，或`allowNewEntries===false`而未能开仓 | 系统自动追加，`userActionStatus → AUTO_BLOCKED_BY_RISK` |
| `AUTO_BLOCKED_BY_POSITION` | 该`signalId`触发那一刻，因已有冲突仓位（另一笔非终态`PaperTrade`）或同`signalId`已开过仓（§16.2条件12/13）而未能开仓 | 系统自动追加，`userActionStatus → AUTO_BLOCKED_BY_POSITION` |
| `AUTO_MISSED_ENGINE_OFF` | 该`signalId`触发那一刻，`engineState`为`AUTO_PAPER_OFF`/`AUTO_PAPER_ARMED`（引擎根本未运行） | 系统自动追加，`userActionStatus → AUTO_MISSED_ENGINE_OFF` |
| `AUTO_MISSED_DATA_GAP` | 该`signalId`在其有效期内因数据异常/引擎离线导致无法及时判定是否触发，最终以`EXPIRED_UNTRIGGERED`或`UNRESOLVED_DATA_GAP`收尾且从未产生`AUTO_EXECUTED` | 系统自动追加，`userActionStatus → AUTO_MISSED_DATA_GAP` |

以上五个`AUTO_*`事件**全部由引擎自动判定追加，不需要也不接受任何用户点击**——这与draft-3"`MISSED`是唯一不需要用户点击的例外"形成对照：draft-4下用户点击不再是`userActionStatus`变化的主要驱动力，`SEEN`（用户打开UI查看）是**唯一**仍由真实用户交互触发的事件。

**红线（对应CEO本轮"七、与建议档案和影子验证的关系"）**：

- 引擎判定某`signalId`对应的进场区被触及（§15.6 Shadow Evaluation的`WAITING_TRIGGER→TRIGGERED`转换）且§16.2十四项条件全部满足时，自动调用`autoEngineOpenPosition`，**必须**传入该`signalId`。
- 成功开仓后，必须向`ethAlphaSignalEvents`追加一条`eventType:'LINKED_PAPER_TRADE'`事件，携带`{signalId, tradeId, linkedAt}`，驱动该`signalId`的`linkedPaperTradeId`投影值更新为该`tradeId`，`userActionStatus`投影值同时更新为`AUTO_EXECUTED`。
- **红线**：`SignalSnapshot`原始记录本身（`ethAlphaSignalArchive`中的那条）不因此被修改——关联关系完全通过`SignalEvent`+投影表达。
- **红线（分别保存两个价格，不得混淆）**：关联后，`PaperTrade.entryPrice`（模拟账户真实成交价，draft-2定义）与`SignalSnapshot.entryZone.estimatedEntry`（建议理论进场价）是两个独立字段，**不得**互相覆盖或平均——`getSignalCurrentView(signalId)`合并视图必须同时暴露两者，供UI"系统建议表现 vs 引擎实际自动执行表现"对比展示（CEO"可以比较"要求）：前者用§15.6影子撮合逻辑计算（假设完全按建议执行的客观结果），后者读取`linkedPaperTradeId`对应`PaperTrade`的真实`fills`/`realizedPnl`（draft-2既有字段，只读引用，不重新计算）。
- **红线（对应CEO"自动账户结果也不得回写修改原始SignalSnapshot"）**：`PaperTrade`的任何后续状态变化（加仓/止损/止盈/平仓）**不得**回写`SignalSnapshot`任何原始字段，也**不得**修改`SignalSnapshot.riskRewardGross`/`riskRewardNet`（那是V1.1在建议产生时刻给出的计划值，与账户实际执行结果是两回事，混淆两者会让"建议本身的客观表现"与"账户实际执行受限于仓位/风控约束后的表现"无法区分对比）。

### 15.10 存储、迁移、损坏恢复、容量、导出与清空规则（对应CEO"十、存储与审计"）

**Schema版本**：`SIGNAL_ARCHIVE_SCHEMA_VERSION = 'v1.3-signal-1'`（`SignalSnapshot`/`SignalEvent`/`ShadowResult`三者共用一个schema版本号，因为三者总是同批引入、同批演进，拆分成三个版本号号只会增加迁移分支组合复杂度而没有实际收益）。

- **损坏JSON恢复**：`ethAlphaSignalArchive`/`ethAlphaSignalEvents`/`ethAlphaShadowResults`任一key解析失败，安全恢复为空数组，不抛出异常（同draft-2 §9.2模式）。
- **容量上限**：`ethAlphaSignalArchive`/`ethAlphaSignalEvents`各自保留最近**2000条**（超出后**只裁剪最旧的**，不做智能采样，避免"看似聪明的裁剪"引入统计偏差——CEO要求的是客观检查系统准确度，如果历史记录本身被有选择性地裁剪，准确度统计就不再客观）；`ethAlphaShadowResults`按`signalId`唯一，容量跟随`ethAlphaSignalArchive`现存记录集合，无需独立上限（不存在的`signalId`对应的`ShadowResult`应随之清理，避免孤儿记录）。
- **去重**：见§15.4，写入前必须查重。
- **追加式事件**：`ethAlphaSignalEvents`只能`push`，任何已写入元素不得修改或删除（同draft-2 `PaperFill.fills`不可变约束模式）。
- **JSON/CSV导出**：`exportSignalArchiveJSON(signals, events, shadowResults)`/`exportSignalArchiveCSV(...)`，CSV导出**必须**复用`v1-core.js`已导出的`csvCell`函数做公式注入转义（同draft-2 §11/T15.2先例，`=`/`+`/`-`/`@`开头字段值转义）。
- **不可变快照校验**：建议提供一个纯函数`verifySignalArchiveIntegrity(signals)`用于测试/审计，逐条比对当前存储内容与该`signalId`首次写入时的哈希/关键字段是否一致（发现被篡改即返回不一致清单），供`V1_3_ACCEPTANCE_TESTS.md` T31使用。
- **清空建议历史（红线，对应CEO"清空建议历史必须二次确认，不得顺带重置500 USDT模拟账户"）**：`resetSignalArchive(storage, confirmFn, idempotencyKey)`必须两步确认（同draft-2 §2.4模式），第二次确认文案必须显式包含"将清空全部建议档案、影子验证结果与相关事件记录，且不可恢复"字样，必须携带`idempotencyKey`。**红线**：该函数**只**清空`ethAlphaSignalArchive`/`ethAlphaSignalEvents`/`ethAlphaShadowResults`三个key，**绝对不得**读写`ethAlphaPaperAccount`/`ethAlphaPaperTrades`/`ethAlphaPaperLog`——即使某些`SignalSnapshot.linkedPaperTradeId`指向的`PaperTrade`仍然存在于模拟账户里，清空建议历史后这些`PaperTrade`记录必须原样保留不受影响（只是失去了指向它们的建议档案索引，`PaperTrade`本身不记录反向指针，不产生悬空引用问题）。`V1_3_ACCEPTANCE_TESTS.md` T42专项验证该红线。

### 15.11 默认有效期决定（对应CEO"十二、默认有效期"，检查结论与理由详见`V1_3_ARCHITECTURE_REVIEW.md`§9.2）

**检查结论**：V1.1（`v1-core.js`/`buildDecision()`）**没有**任何形式的`validUntil`/`expiry`/TTL字段或等价机制——决策对象只有`updatedAt`时间戳，结构性内容（state/S/R/stop/targets）随每根新15分钟收盘K线整体替换，没有"这份计划还有效多久"的显式声明。V1.2（`buildForecast()`）**有**明确先例：`forecast.{m15,h1,h4}.validUntil = dataAsOf + TF_MS[horizon]`，即每个时间窗预测的有效期恰好等于该时间窗自身的K线周期。

**决定**：`SIGNAL_DEFAULT_VALIDITY_MS = TF_MS['4h'] = 14400000`（4小时，等价16根15分钟K线）。`validUntil = dataAsOf + SIGNAL_DEFAULT_VALIDITY_MS`。

**理由**（详细论证见`V1_3_ARCHITECTURE_REVIEW.md`§9.2）：建议的结构性基础（`decision.htf4h`/`triggerPlans`所依赖的4h/1h/15m结构）以4小时级别的HTF状态为最终定调依据，而V1.2自己对最长预测窗口（`h4`）的有效期定义就是"该时间窗自身周期"（4小时）——V1.3选择与V1.2最长时间窗一致的4小时作为默认值，是复用系统中已经存在、已经过CEO/实现方认可的"有效期=结构所属周期"惯例，而不是发明一个全新的、无先例支撑的数字。该值**确定、可测试、有限**（不会无限等待进场），且实现方式与状态机§15.5的判定逻辑直接对应（第4根K线起才会出现"仍在等待触发"的持续观察，第16根收盘K线之后若仍未触发则强制`EXPIRED_UNTRIGGERED`）。**红线**：`validUntil`只在创建时按上述公式计算并冻结在`SignalSnapshot`里，不允许任何"后见之明"式的事后调整（CEO"不允许后见之明修改有效期"）——`V1_3_ACCEPTANCE_TESTS.md` T34专项验证`validUntil`创建后不可变。

### 15.12 UI 区域字段规范（对应CEO"十一、UI新增区域"）

新增独立`<article class="card span12">`区域，标题"**历史交易建议与影子验证**"，置于§10模拟账户区域下方。**持续显示**（同屏常驻，不因筛选/翻页消失）：

`影子验证使用后续真实行情评估历史建议，不代表真实成交、真实账户收益或未来保证。`

必须显示的字段（逐条对应CEO列出的清单）：建议产生时间(`createdAt`/`dataAsOf`)、方向(`direction`)、进场区域(`entryZone`)、止损和目标(`stopLoss`/`targets`)、有效期(`validFrom`–`validUntil`)、当前生命周期(`lifecycleStatus`投影值)、是否触发(派生自`lifecycleStatus`)、后续真实结果(出场原因/出场价)、毛R与净R(`ShadowResult.grossR`/`netR`)、MFE/MAE、用户是否看到(`userActionStatus`)、是否关联模拟交易(`linkedPaperTradeId`是否非空)、系统建议与用户执行结果对比(entryZone.estimatedEntry路径 vs 关联PaperTrade真实路径并列展示)。**筛选**：按方向/生命周期状态/时间范围。**汇总指标**：§15.8全部统计项。**导出**：JSON/CSV。

### 15.13 函数接口清单（draft-3新增，独立于draft-2 §11既有清单，不修改其中任何一行）

```
recordSignalIfEligible(decision, forecast, marketData, storage): {ok, signal?, reason?, deduped?}
loadSignalArchive(storage): SignalSnapshot[]
loadSignalEvents(storage): SignalEvent[]
appendSignalEvent(signalId, eventType, payload, storage): {ok, event?}
getSignalCurrentView(signalId, storage): SignalSnapshot & {当前投影字段}
evaluateShadowSignals(signals, marketData, storage): {ok, updated: ShadowResult[]}
calcSignalFingerprint(decision, direction, sourceConfirmedBarTime): string
computeSignalAccuracyStats(signals, shadowResults, filters?): SignalAccuracyStats
linkSignalToPaperTrade(signalId, tradeId, storage): {ok, event?}
markSignalSeen(signalId, storage): {ok}
markSignalRejected(signalId, storage): {ok}
resetSignalArchive(storage, confirmFn, idempotencyKey): {ok}
exportSignalArchiveJSON(signals, events, shadowResults): string
exportSignalArchiveCSV(signals, events, shadowResults): string
migrateSignalArchive(raw): SignalSnapshot[]
verifySignalArchiveIntegrity(signals): {ok, mismatches: string[]}
```

所有函数均为纯函数或"状态+storage参数注入"风格，不得直接引用全局`window.localStorage`（与draft-2 §11末尾要求一致）。

### 15.14 版本号红线（draft-3新增）

```
SIGNAL_ARCHIVE_SCHEMA_VERSION = 'v1.3-signal-1'
SIGNAL_ARCHIVE_ALGORITHM_VERSION = 'v1.3-draft-3'
```

**红线（与`PAPER_ALGORITHM_VERSION`的独立性说明，draft-3时点原文，**draft-4已更新见下方标注**）**：`PAPER_ALGORITHM_VERSION`（§12）**保持`'v1.3-draft-2'`不变**——本轮draft-3新增的是一套全新的、与§2-§8平行的子系统，§2-§8「模拟账户」自身的账户/风险/撮合规则字面**零改动**，没有理由虚假递增一个描述"模拟账户算法版本"的常量。`SIGNAL_ARCHIVE_ALGORITHM_VERSION`独立维护，任何修改§15.3创建条件、§15.5生命周期状态机、§15.6影子撮合规则、§15.8统计分母规则的未来提交，必须同步递增`SIGNAL_ARCHIVE_ALGORITHM_VERSION`（而不是`PAPER_ALGORITHM_VERSION`），并在`SignalSnapshot.riskRuleVersion`的取值范围与`V1_3_ACCEPTANCE_TESTS.md`新增对应回归用例。

**draft-4更新**：与draft-3不同，draft-4**确实**改变了§2-§8「模拟账户」本身的授权模型与部分函数接口（撤销`PENDING_ENTRY`/`CANCELLED`/`BLOCKED`状态、撤销`confirmReduce`、合并`confirmConservativeSettlement`进`emergencyClosePosition`、`idempotencyKey`生成方式改变），因此`PAPER_ALGORITHM_VERSION`本轮**递增为`'v1.3-draft-4'`**（不再保持`v1.3-draft-2`），`SIGNAL_ARCHIVE_ALGORITHM_VERSION`本身的创建/生命周期/撮合/统计规则未变，但其依赖的账户交互面变了，故一并递增为`'v1.3-draft-4'`，二者本轮再次统一（详见§16.11）。

### 15.15 仍需CEO确认的问题（本轮，Signal Archive & Shadow Evaluation）

无。CEO本轮"十二、默认有效期"要求的"若V1.1无正式定义，需自行提出确定、可测试、不会无限等待的默认值并说明理由"已由本文档§15.11给出（4小时，理由见上）。CEO本轮其余十三项要求（一至十四，除十二已单独处理）均已在§15.0-§15.14逐条落地，未发现需要CEO进一步决策的开放问题。若实现阶段（Codex编码）发现本文档未能预见的边界情况，将在`V1_3_IMPLEMENTATION_REPORT.md`中记录并视需要提请CEO补充决策。

---

## 16. 真实行情自动模拟交易引擎 Auto Paper Trading Engine（draft-4新增，CEO本轮正式撤销"逐笔点击确认"授权模型）

### 16.0 撤销声明（红线，最高优先级）

**CEO正式撤销**draft-2/draft-3中"模拟账户需要用户逐笔点击确认才生效"这一错误定义。**V1.3的最终产品定义**：系统使用真实Binance ETH/BTC行情，根据V1.1正式交易规则**自动**进行虚拟开仓、加仓、减仓、止损、50%/30%/20%分批止盈、移动保护、平仓，使用默认500 USDT虚拟账户。用户**只需首次开启一次"自动模拟交易总开关"并二次确认**，开启后只要引擎处于运行状态，系统根据§16.2/§4/§5/§6正式规则自行进行模拟交易，不再逐笔请求用户确认。用户保留的权力收窄为六项宏观控制：开启、暂停、恢复、禁止新开仓、紧急模拟平仓、关闭（§16.1/§16.6）。

**红线（三条不变的禁止事项，与draft-2/draft-3完全一致，未被本轮修订触碰）**：不连接真实交易所账户；不读取API密钥；不发送真实订单；不使用真实资金。§16通篇描述的"自动"仅指"引擎在虚拟账户内部按规则自动记账"，与"自动对接真实交易所下单"是两个完全不同的概念，任何实现都不得混淆。

本节与§0-§15其余部分的关系：§2（账户模型）、§4（盈亏/手续费/滑点公式）、§5（风险规则：风险预算/加仓条件/日亏损/回撤/杠杆边界）、§6.6-§6.10（K线扫描型撮合：同K线冲突/跳空/止盈/移动止损/保本位公式/50-30-20分批止盈）、§8（数据缺口检测与回放机制）**全部数值与公式零改动，只是触发方式从"用户点击"改为"引擎自动判定"**——本节不重复定义这些公式，只定义"引擎如何决定何时调用它们"。§0.3/§2.4/§3.4/§5.2条件8/§5.4/§6.2/§6.11/§8.5/§10/§11/§15.9中断言"用户点击"的具体条款已在原地改写为指向本节的指针，完整扫描记录见§17。

### 16.1 引擎宏观状态机 `EngineState`（对应CEO"二、授权方式修正"）

```ts
interface AutoEngineState {
  engineState: 'AUTO_PAPER_OFF' | 'AUTO_PAPER_ARMED' | 'AUTO_PAPER_RUNNING' | 'AUTO_PAPER_PAUSED' | 'AUTO_PAPER_RISK_LOCKED' | 'AUTO_PAPER_DATA_BLOCKED';
  allowNewEntries: boolean;          // 独立于engineState的开关，默认true，对应CEO"禁止新开仓"动作，见下方设计说明
  armedAt: number | null;            // 用户完成二次确认开启的时间
  lastEngineHeartbeat: number;       // 最近一次成功tick时间，见§16.7
  lastProcessedBarTime: number | null; // 最后成功处理过的15分钟confirmedBar openTime，见§16.7
  preDataBlockedState: 'AUTO_PAPER_RUNNING' | 'AUTO_PAPER_PAUSED' | 'AUTO_PAPER_RISK_LOCKED' | null; // 进入DATA_BLOCKED前的状态，供恢复时正确回退
}
```

**状态转换表**：

| 当前状态 | 触发事件 | 下一状态 |
|---|---|---|
| `AUTO_PAPER_OFF` | 用户第一次点击"开启自动模拟交易"（弹出确认对话） | 保持`AUTO_PAPER_OFF`，等待二次确认 |
| `AUTO_PAPER_OFF` | 用户完成二次确认，携带`idempotencyKey` | `AUTO_PAPER_ARMED` |
| `AUTO_PAPER_ARMED` | 下一次30秒`v11decision`事件tick到达（自动，无需用户操作） | `AUTO_PAPER_RUNNING` |
| `AUTO_PAPER_RUNNING` | 用户点击"暂停"（携带`idempotencyKey`） | `AUTO_PAPER_PAUSED` |
| `AUTO_PAPER_PAUSED` | 用户点击"恢复"（携带`idempotencyKey`） | `AUTO_PAPER_RUNNING` |
| `AUTO_PAPER_RUNNING`/`AUTO_PAPER_PAUSED` | `riskRegime`变为`DAILY_LOSS_LOCKED`或`FORCED_OBSERVATION`（§5.3/§5.4既有机制自动触发） | `AUTO_PAPER_RISK_LOCKED` |
| `AUTO_PAPER_RISK_LOCKED` | 日亏损次日UTC自动解锁（若未同时触发总回撤锁定），或用户完成`confirmForcedObservationAcknowledgement`（§5.4既有机制） | `AUTO_PAPER_RUNNING` |
| `AUTO_PAPER_RUNNING`/`AUTO_PAPER_PAUSED`/`AUTO_PAPER_RISK_LOCKED` | `decision.dataHealth!=='normal'` | `AUTO_PAPER_DATA_BLOCKED`（`preDataBlockedState`记录进入前状态） |
| `AUTO_PAPER_DATA_BLOCKED` | `decision.dataHealth==='normal'`恢复 | 回到`preDataBlockedState`记录的状态 |
| 任意非`AUTO_PAPER_OFF`状态 | 用户点击"关闭自动模拟交易"（二次确认+`idempotencyKey`） | `AUTO_PAPER_OFF` |

**`allowNewEntries`独立开关的设计说明（对应CEO"禁止新开仓"这一独立于暂停之外的动作）**：`allowNewEntries`不是`engineState`枚举的第七个值，而是一个可以在`AUTO_PAPER_RUNNING`状态下单独置为`false`的布尔标志，效果是"引擎继续正常运行、继续对已有仓位执行自动止损/止盈/移动保护/分批止盈（保护已有资金），但不再自动开立新仓位或加仓"，`engineState`本身仍显示`AUTO_PAPER_RUNNING`。这与`AUTO_PAPER_PAUSED`的区别是：**`AUTO_PAPER_PAUSED`同样保留对已有仓位的自动止损/止盈/移动保护**（设计判断，理由见下方），"暂停"与"禁止新开仓"在"是否开新仓"这一点上效果相同，区别在于`AUTO_PAPER_PAUSED`是更重的顶层状态切换（通常搭配用户即将调整设置等更大范围的意图），`allowNewEntries=false`是更轻量、可与"继续显示为运行中"共存的精细开关。

**设计判断（红线，为什么`AUTO_PAPER_PAUSED`/`AUTO_PAPER_RISK_LOCKED`/`AUTO_PAPER_DATA_BLOCKED`都不停止已有仓位的自动止损/止盈保护）**：这三个状态都只禁止"新开仓/新加仓"，**不禁止**`scanClosedBarsForExits`对已有仓位的自动止损/止盈/移动保护/分批止盈继续执行——与draft-2既有先例（`DAILY_LOSS_LOCKED`/`FORCED_OBSERVATION`状态下T8.2/T9.4已确立"减仓/平仓/止损止盈自动触发仍正常工作"）保持一致。理由：用户暂停/引擎被风控锁定/数据异常，都不代表用户希望放弃对已经投入的模拟资金的风险保护——若"暂停"意味着连已有仓位的止损都停止执行，会制造一个"点了暂停结果亏得更多"的反直觉、且与整个系统"风险控制优先"精神相悖的陷阱。唯一会让仓位真正处于"无保护"状态的操作是用户主动点击"紧急模拟平仓"立即了结，这是显式、可见的动作，不是暂停的隐藏副作用。

### 16.2 自动开仓的十四项条件（对应CEO"三、自动建仓条件"，逻辑与，缺一不可）

```
1.  engineState === 'AUTO_PAPER_RUNNING' && allowNewEntries === true
2.  decision.worthBetting === true                                              // V1.1交易许可允许参与
3.  decision.biasDirection === 'long' || decision.biasDirection === 'short'      // V1.1方向明确可执行（不含long_caution）
4.  对应signalId存在于ethAlphaSignalArchive且 Date.now() <= signal.validUntil    // 对应SignalSnapshot存在且仍在有效期（§15.11）
5.  !decision.opportunityScores.blocked                                          // 信号未blocked
6.  该signal的Shadow Evaluation本次评估判定entryZone被真实触及（§15.6 WAITING_TRIGGER→TRIGGERED转换），本次tick恰好完成该转换   // 进场条件或进场区域真实触发
7.  decision.dataHealth === 'normal'                                             // 数据健康正常
8.  Number.isFinite(signal.stopLoss) && signal.targets.length>=1 && signal.invalidation.length>0  // 存在有效止损、失效位和目标
9.  Number.isFinite(C.calcRiskBudget(...)的maxLossAmount结果) && maxLossAmount>0  // 风险预算有效
10. account.riskRegime !== 'DAILY_LOSS_LOCKED'                                   // 没有触发日亏损3%锁定
11. account.riskRegime !== 'FORCED_OBSERVATION'                                  // 没有触发总回撤10%锁定
12. 当前不存在任何非终态PaperTrade（OPEN/PARTIALLY_CLOSED/UNRESOLVED_DATA_GAP）  // 当前没有冲突仓位（同一时间最多一笔主交易，§16.3）
13. signal.linkedPaperTradeId === null                                          // 同一个signalId尚未开过仓
14. decision.isManual === false                                                 // 不是手动观察模式
```

**核心架构决定（红线，避免重复实现"进场区触及"判定）**：条件6**直接复用**§15.6 Shadow Evaluation已经实现的`entryZone`触及判定逻辑（`WAITING_TRIGGER→TRIGGERED`转换），**不在`v1_3-auto-engine-core.js`（见CODEX_TASK §8）中重新实现一遍相同的判定**——自动开仓在本质上就是"当Signal Archive的影子生命周期判定某条建议已经真实触发时，若同时满足其余13项账户/风控条件，则把这个'影子上已经发生的触发事件'真实落地为一笔`PaperTrade`"。这一设计同时天然满足CEO"每次自动建仓必须关联signalId"的要求（§16.6）：不存在脱离某个具体`signalId`凭空产生的自动开仓。

**红线（对应CEO"V1.2只能作为辅助证据，不能单独触发交易"）**：以上十四项条件表达式**不得**引用`forecast.m15`/`forecast.h1`/`forecast.h4`/`weights`/`directionLabel`等V1.2字段（与draft-2 §7.1/draft-3 §15.3同一红线的延伸，`V1_3_ACCEPTANCE_TESTS.md` T45.2专项验证）。

任一条件不满足，不产生`PaperTrade`，对应`signal.userActionStatus`投影值按§15.9新枚举更新为`AUTO_BLOCKED_BY_RISK`/`AUTO_BLOCKED_BY_POSITION`/`AUTO_MISSED_ENGINE_OFF`/`AUTO_MISSED_DATA_GAP`之一（具体映射见§15.9事件表）。

### 16.3 自动模拟仓位规则（对应CEO"四、自动模拟仓位规则"——**全部数值与公式复用§2/§4/§5/§6，本节只做清单式确认，不重复定义**）

| CEO规则 | 复用章节 | 是否本轮改动 |
|---|---|---|
| 初始资金500 USDT | §2.1 `initialCapital` | 否 |
| 交易标的ETHUSDT | §2.1 `currency`/术语表 | 否 |
| 同一时间最多一笔主交易，不同时持有多单和空单 | §3.1 | 否 |
| 默认1倍杠杆，最高3倍 | §5.5 | 否 |
| 杠杆不得扩大风险预算 | §5.5红线 | 否 |
| 小仓试错风险0.5%/单笔最大风险1% | §5.1 `trialRiskPct`/`maxRiskPct` | 否 |
| 当日最大亏损3% | §5.3 `dailyLossLimitPct` | 否 |
| 总回撤10% | §5.4 `maxDrawdownPct` | 否 |
| 每笔最多自动加仓一次 | §5.2条件5 | 否，触发方式改为§16.2/自动判定 |
| 禁止亏损加仓/加仓前必须已有浮盈 | §5.2条件1 | 否 |
| 加仓前止损必须移动到计入手续费和滑点后的成本保本位 | §5.2条件4、§6.10 `calcBreakevenStop` | 否 |
| 加仓后整笔交易最坏风险不超过当前净值1% | §5.2条件7 | 否 |
| 第一/二/三目标50%/30%/清空剩余 | §6.10 | 否 |

**加仓自动化（对应§5.2条件8的draft-4版本）**：`autoEngineAddOn`在§5.2条件1-7全部满足时，由引擎每次`v11decision`事件tick自动判定并执行，`idempotencyKey`按§16.8规则确定性生成，不再要求用户点击。加仓次数上限（每笔最多1次，条件5）与统一止损1%校验（条件7）**不可配置、不受任何自动化改动影响**。

### 16.4 反向信号（对应CEO"五、反向信号"，draft-4新增规则，`PaperAccount`新增字段）

```ts
interface PaperAccount {
  // ...draft-2既有字段不变...
  lastPositionClosedAt: number | null;         // 最近一笔PaperTrade完全平仓（EXITED）的时间
  lastPositionClosedDirection: 'long' | 'short' | null; // 该笔的方向
  lastPositionClosedBarOpenTime: number | null; // 该笔平仓成交所在（或紧随其后）已收盘K线的openTime，作为冷却期计数起点
}
```

**规则（逻辑顺序，仅当新候选信号方向与`lastPositionClosedDirection`相反时适用；同方向新信号不受本节冷却期约束，仅受§16.2条件12"当前无冲突仓位"约束）**：

1. **红线**：同一次`v11decision`刷新tick内，**不允许**"检测到已有仓位应平仓"与"同时对反向信号自动开仓"在同一tick内连续发生——已有仓位必须先按§6.6-§6.9既有K线扫描止损/止盈/移动保护规则**自然运行至`EXITED`**（不因为出现反向信号就发明一个额外的"强制平仓"路径，这与CEO"先根据V1.1离场规则处理已有仓位"直接对应），反向开仓判定只在原仓位已经是`EXITED`之后的**后续**tick才会被考虑。
2. 原仓位`EXITED`后，`lastPositionClosedAt`/`lastPositionClosedDirection`/`lastPositionClosedBarOpenTime`按上表更新。
3. **冷却期**：反向方向的新候选`signal`必须满足其`sourceConfirmedBarTime > lastPositionClosedBarOpenTime`（即该反向信号所依据的确认K线，必须晚于原仓位平仓所在K线，至少间隔一根已收盘15分钟K线）——`V1_3_ACCEPTANCE_TESTS.md` T48专项验证该冷却期不允许被绕过（即使§16.2其余十四项条件全部满足，冷却期不满足时反向开仓仍被拒绝）。
4. 冷却期满足后，反向信号是否仍然有效由§16.2十四项条件**正常重新判定**（含条件4"仍在有效期"、条件6"进场区真实触发"）——不存在任何"冷却期一到就自动反手"的捷径，必须重新走完整判定流程。

### 16.5 真实市场模拟成交术语（对应CEO"六、真实市场模拟成交"，术语澄清，映射到既有字段，不新增公式）

| CEO术语 | 定义 | 对应既有字段/概念 |
|---|---|---|
| `markPrice` | 实时估值价格，用于`unrealizedPnl`计算 | §4.1既有`markPrice`定义（取自`d.price`，未收盘实时价） |
| `triggerPrice` | 条件触发判定所用价格 | §6.6既有"只用已收盘K线OHLC扫描"机制中的`bar.high`/`bar.low`/`currentStop`/目标价，以及§15.6的`entryZone`触及判定 |
| `simulatedFillPrice` | 加入不利滑点后的模拟成交价 | §4.4既有`fillPrice`公式 |
| `confirmedBar` | 正式交易状态使用的已收盘K线 | 即`decision.confirmedPrice`所依据的最后一根`isClosed===true`K线，与§15.1"数据截止时间"术语同源 |
| `liveMarketData` | 只用于估值和模拟成交观察的实时数据 | `window.__lastMarketData`中未收盘的部分；**红线**：liveMarketData不得污染已收盘正式结构——与draft-2 §6.6"只用已收盘K线OHLC扫描"红线完全一致，本节只是给这个既有红线一个正式名称，不改变判定逻辑本身 |

`autoOpenPosition`（§11，已废弃）意义上的`referencePrice`即`markPrice`；开仓/加仓/止损/止盈成交价即`simulatedFillPrice`。`buildTradeProposal`（保留）现在的角色是：引擎每次tick内部先调用它得到"如果现在开仓/加仓会是这样"的只读结果，若§16.2/§5.2条件满足则**立即**用该结果调用`autoEngineOpenPosition`/`autoEngineAddOn`执行，同一对象也原样暴露给UI作为"下一自动动作"预览字段（§16.9），不再存在"生成方案后等待用户确认"的中间等待期。

### 16.6 与建议档案、影子验证的关系（对应CEO"七"，隔离红线重申）

**三套系统关系图（更新版，取代§15.0原表第③行，完整表见§15.0已更新内容）**：

```
① Signal Archive（自动存档，与引擎是否运行无关）
        │ signalId
        ▼（entryZone被Shadow Evaluation判定触及 + §16.2其余13项条件满足）
③ Auto Paper Account（引擎自动开仓，产生tradeId，回写linkedPaperTradeId指针）

② Shadow Evaluation（只读并行验证同一signalId的"理论表现"，永远不读写①③之外的任何状态，尤其不读写PaperAccount）
```

- 每次自动建仓/自动加仓**必须**关联`signalId`（§16.2条件6/§15.9），`PaperTrade`新增只读字段`linkedSignalId: string`（建仓时冻结，不可变，与`decisionSnapshot`同级别的建仓快照信息）。
- 新增`userActionStatus`五枚举值（`AUTO_EXECUTED`/`AUTO_BLOCKED_BY_RISK`/`AUTO_BLOCKED_BY_POSITION`/`AUTO_MISSED_ENGINE_OFF`/`AUTO_MISSED_DATA_GAP`）已在§15.9完整定义，本节不重复。
- **红线（延续§15.0，本轮重申）**：影子结果（`ShadowResult.grossR`/`netR`/`realizedGrossR`/`realizedNetR`等）**不得**进入500 USDT账户——即使某条`signal`最终被引擎实际执行（`AUTO_EXECUTED`），该`signal`自己的Shadow Evaluation计算仍然独立进行、独立存储在`ethAlphaShadowResults`，与`PaperTrade`的真实`fills`/`realizedPnl`是两条平行的、可以事后比较但绝不合并计算的数据流。
- **红线（对应CEO"自动账户结果也不得回写修改原始SignalSnapshot"）**：已在§15.9末尾红线明确，`PaperTrade`任何后续状态变化不得回写`SignalSnapshot`原始字段。

**`emergencyClosePosition`（唯一保留的手动仓位操作，对应CEO"紧急模拟平仓"）**：

```
emergencyClosePosition(trade, decision, account, storage, idempotencyKey): {ok, trade?, reason?}
```

- 任意时刻，只要存在非终态`PaperTrade`，用户均可点击"紧急模拟平仓"立即触发，无需满足任何前置条件（这是有意设计的例外——紧急情况下不应该被自动化规则本身挡住手动退出的路径）。
- `trade.status==='UNRESOLVED_DATA_GAP'`时，自动切换为§8.5定义的保守结算成交规则（缺口结束后第一根可获得K线的`open`价+不利滑点）；其余状态下按当前`markPrice`+§4.4常规不利滑点成交。
- `idempotencyKey`由UI在用户点击瞬间生成随机串，与draft-2既有模式一致（这是仍然真实需要"用户点击"的少数操作之一）。

### 16.7 浏览器运行限制与心跳/回放（对应CEO"八"）

**红线（能力边界声明，UI必须持续可见，见§16.9）**：只有页面打开、浏览器未休眠且网络正常时，引擎才能实时轮询运行；页面关闭或电脑休眠时，不能宣称系统仍在实时交易；真正24小时服务器常驻运行不属于V1.3范围（属于未来V3+方向，本文档不涉及）。

**心跳字段**（`AutoEngineState`，见§16.1）：`lastEngineHeartbeat`每次成功tick更新为`Date.now()`；`lastProcessedBarTime`每次成功处理完一根`confirmedBar`（含止损/止盈扫描、开仓/加仓判定）后更新为该bar的`openTime`。

**页面恢复后的回补流程（统一复用draft-2 §8.3机制，标注新的触发来源）**：

- `PaperTrade.dataGap`（draft-2既有接口）新增字段`gapCause: 'MARKET_DATA_INVALID' | 'ENGINE_OFFLINE'`，区分"市场数据本身失效"（原draft-2触发路径，`window.invalidateDashboard`）与"引擎离线导致错过K线"（draft-4新增触发路径：页面重新可见/`lastEngineHeartbeat`距今超过`TF_MS['15m']`时判定为离线过）——**两种缺口的回补/重放/无法回补时的处理机制完全复用§8.3-§8.4已有规则**（优先回补缺失的已收盘15分钟K线；回补成功后按时间顺序重放止损、目标、失效和离场；同K线冲突采用更不利结果；跳空止损采用首个可获得的不利价格；无法完整回补时进入`UNRESOLVED_DATA_GAP`；不得伪造中断期间的精确成交顺序），本节**不重新定义**这套机制，只声明触发来源的扩展。
- 页面加载/恢复可见时，比较`lastProcessedBarTime`与当前可获取的最新`confirmedBar.openTime`：若存在缺口，先执行回补重放（§8.3流程），全部处理完毕后才恢复正常的§16.2/§16.3自动判定（不允许跳过缺口直接假装从当前时刻继续）。
- UI必须显示：最近心跳（`lastEngineHeartbeat`的本地时间展示）、离线时长（`Date.now()-lastEngineHeartbeat`）、回放状态（是否存在待处理的`UNRESOLVED_DATA_GAP`/正在重放中）。

### 16.8 幂等与重复保护（对应CEO"九"，引擎自动生成key的确定性规则）

```
自动开仓: idempotencyKey = `AUTO-OPEN-${signalId}`                                    // 一个signalId只能触发一次自动开仓，与§16.2条件13"同一个signalId尚未开过仓"互为表里
自动加仓: idempotencyKey = `AUTO-ADDON-${tradeId}`                                     // 每笔trade最多一次加仓（§5.2条件5），key本身天然唯一
自动止损/止盈（K线扫描触发）: idempotencyKey = `AUTO-EXIT-${tradeId}-${barOpenTime}-${fillType}`  // 同一笔交易同一根K线同一类型成交只产生一次
数据缺口回放期间的补记成交: idempotencyKey = `AUTO-REPLAY-${tradeId}-${barOpenTime}-${fillType}`  // 与上一行同构，回放与实时扫描复用同一去重维度（tradeId+barOpenTime+fillType），保证"实时已处理过的K线"与"回放重新遇到的同一根K线"落到同一个key，天然幂等
紧急模拟平仓（用户点击）: idempotencyKey 由UI在点击瞬间生成随机串，同draft-2既有模式
暂停/恢复/禁止新开仓/关闭/开启: idempotencyKey 由UI在点击瞬间生成随机串
```

以上规则保证CEO列出的全部场景不产生重复成交或重复扣费：REST返回重复数据（同一`barOpenTime`重复到达，key相同，第二次直接返回原结果）、页面重复刷新（同上）、同一根K线重复处理（同上）、页面恢复（回放key与实时key同构，见上表）、数据缺口回放（同上）、多次触发相同按钮事件（人工操作类key由UI保证同一次点击的所有重试复用同一个随机串，同draft-2既有机制）。**红线**：同一个`signalId`最多建立一次主交易——由`AUTO-OPEN-${signalId}`的key构造方式与§16.2条件13共同保证，二者是同一红线的两层独立防护（条件13在决策层拦截，幂等key在执行层兜底，即使决策层出现竞态也不会产生第二笔`PaperTrade`）。

### 16.9 UI 区域字段规范（对应CEO"十"，取代§10原有区域）

新增独立`<article class="card span12">`区域，标题"**500 USDT真实行情自动模拟交易**"，置于§16.9本区域自身即为§10原"500 USDT模拟交易账户"区域的直接继任者，字段口径复用§10表格（`account.*`/`equity`/`marginUsed`等，见§10已标注"继续由§16.9引用"部分），新增/变更字段如下：

**持续显示**（同屏常驻）：`使用真实市场行情自动进行虚拟交易，不发送真实订单。页面关闭或电脑休眠时不会实时运行。`

必须显示的字段（新增/变更部分，其余沿用§10表格）：

| 字段 | 数据来源 |
|---|---|
| 自动交易总开关 | `engineState`，开启/关闭均需二次确认+`idempotencyKey`（§16.1） |
| 引擎状态 | `engineState`六态中文展示 |
| 最近心跳 | `lastEngineHeartbeat`本地时间展示（§16.7） |
| 最近处理K线 | `lastProcessedBarTime`本地时间展示 |
| 当前是否允许开仓 | `engineState==='AUTO_PAPER_RUNNING' && allowNewEntries===true`的布尔展示 |
| 阻止原因 | 若当前不允许开仓，展示具体原因（§16.2十四条件中未满足的那一条，或`engineState`/`allowNewEntries`本身的状态说明） |
| 当前模拟仓位 | `PaperTrade`（复用§10既有字段口径） |
| 来源signalId | `PaperTrade.linkedSignalId`（§16.6新增只读字段），可点击跳转到"历史交易建议与影子验证"区域对应记录 |
| 开仓价、数量、止损和目标 | `PaperTrade.entryPrice`/`quantity`/`currentStop`/`targets`（复用draft-2既有字段） |
| 下一自动动作 | `buildTradeProposal`当前tick的只读结果（§16.5新角色），无有效候选时展示"暂无" |
| 可用余额、保证金和净值 | 复用§10 |
| 已实现与未实现盈亏 | 复用§10 |
| 手续费和滑点 | 复用§10 |
| 当日盈亏 | 复用§10 |
| 最大回撤 | 复用§10 |
| 最近自动成交 | `PaperTrade.fills`（复用§10"模拟成交记录"） |
| 自动运行审计日志 | `ethAlphaPaperLog`（复用§10"模拟交易日志"），新增记录类型`ENGINE_STATE_CHANGE`/`AUTO_OPEN`/`AUTO_ADDON`/`ENGINE_HEARTBEAT_GAP` |
| 暂停、恢复、禁止新开仓及紧急平仓按钮 | 分别对应§16.1状态转换与§16.6`emergencyClosePosition` |

其余§10已有字段（初始资金/JSON-CSV导出/重置账户按钮等）原样保留，不重复列出。

### 16.10 函数接口清单（draft-4新增/变更，完整取代§11中与自动交易相关的部分，§11中`resetPaperAccount`/`changeInitialCapital`/`confirmForcedObservationAcknowledgement`/`scanClosedBarsForExits`/`replayDataGap`/`calcBreakevenStop`/`calcRiskRegime`/`calcUnrealizedPnl`/`calcDrawdown`/`calcDailyStartEquity`/导出/迁移函数原样保留不变）

```
armAutoEngine(storage, confirmFn, idempotencyKey): {ok, state?, reason?}          // OFF→ARMED，二次确认
tickAutoEngine(decision, forecast, marketData, account, signals, storage): {ok, actions: string[]}  // 每次v11decision事件调用，ARMED→RUNNING自动转换在此函数内部完成，内部依次调用下方各函数
pauseAutoEngine(storage, idempotencyKey): {ok, state?}
resumeAutoEngine(storage, idempotencyKey): {ok, state?}
setAllowNewEntries(allow, storage, idempotencyKey): {ok, state?}
disarmAutoEngine(storage, confirmFn, idempotencyKey): {ok, state?}                // 任意状态→OFF，二次确认

autoEngineOpenPosition(signal, decision, forecast, account, storage): {ok, trade?, reason?}   // 内部按AUTO-OPEN-${signalId}生成idempotencyKey，见§16.8
autoEngineAddOn(trade, signal, decision, account, storage): {ok, trade?, reason?}              // 内部按AUTO-ADDON-${tradeId}生成idempotencyKey
emergencyClosePosition(trade, decision, account, storage, idempotencyKey): {ok, trade?, reason?}  // 保留，唯一人工触发的仓位操作，见§16.6

checkReverseSignalCooldown(candidateSignal, account): {ok: boolean, reason?}      // §16.4冷却期判定
replayEngineOfflineGap(trade, marketData, account, storage): {ok, trade?, coverageComplete}  // 复用§8.3机制，gapCause='ENGINE_OFFLINE'

buildTradeProposal(decision, account, direction): TradeProposal | {ok:false, reason}  // 保留，角色见§16.5
scanClosedBarsForExits(trade, newClosedBars, account, storage): {ok, trade?, fills?}  // 保留，draft-2既有，零改动
```

### 16.11 版本号红线（draft-4更新）

```
PAPER_ALGORITHM_VERSION = 'v1.3-draft-4'            // 从v1.3-draft-2递增，理由见§15.14"draft-4更新"标注
PAPER_SCHEMA_VERSION = 'v1.3-account-3' / 'v1.3-trade-3' / 'v1.3-log-3'  // 新增AutoEngineState相关字段与PaperTrade.linkedSignalId/dataGap.gapCause，相对draft-2的-2版本递增
SIGNAL_ARCHIVE_ALGORITHM_VERSION = 'v1.3-draft-4'   // 与PAPER_ALGORITHM_VERSION本轮再次统一，见§15.14
```

`migratePaperAccount`/`migratePaperTrades`必须包含`v1.3-account-2→v1.3-account-3`/`v1.3-trade-2→v1.3-trade-3`的显式迁移分支：新增`AutoEngineState`全部字段按默认值补齐（`engineState`默认`'AUTO_PAPER_OFF'`，`allowNewEntries`默认`true`，其余心跳/冷却期字段默认`null`）；`PaperTrade.linkedSignalId`历史记录（若存在，即draft-2/draft-3阶段产生的手动开仓记录）补`null`；`dataGap.gapCause`历史记录补`'MARKET_DATA_INVALID'`（历史缺口全部视为原有触发路径，因为`ENGINE_OFFLINE`路径是draft-4才新增的判定）。

### 16.12 CEO"十一、删除全部冲突旧定义"落地确认

见§17完整扫描记录。本节确认：CEO列出的四条待删除/改写表述——"用户必须逐笔点击确认才建立模拟仓位"（§0.3/§15.0已改写）、"每次开仓必须手动接受"（§5.2条件8已改写）、"不实现无人确认的自动模拟开仓"（§0.3已改写，CODEX_TASK §1.2同步）、"PaperAccount只有用户点击才生效"（§15.0表格已改写）——均已在本文档原地改写为CEO要求的替换表述："用户通过总开关一次性授权自动模拟交易"（§16.0）、"运行期间系统按规则自行虚拟交易"（§16.0/§16.2）、"用户保留暂停和紧急平仓权力"（§16.1/§16.6）、"不连接真实账户，不发送真实订单"（§16.0红线，与原有红线完全一致未变）。

### 16.13 仍需CEO决定的问题（本轮，Auto Paper Trading Engine）

无。CEO本轮"一至十一"的全部要求已在§16.0-§16.12逐条落地。以下两点是本文档在CEO未明确指定时做出的设计判断，已在相应小节说明理由，供CEO复核（非"待决策"，是"已决策并记录依据"）：① `AUTO_PAPER_PAUSED`/`AUTO_PAPER_RISK_LOCKED`/`AUTO_PAPER_DATA_BLOCKED`三个状态均保留对已有仓位的自动止损/止盈保护，只禁止新开仓/加仓（§16.1设计判断）；② `UNRESOLVED_DATA_GAP`的唯一退出路径复用`emergencyClosePosition`而非新增独立按钮（§16.6，`confirmConservativeSettlement`并入其中，见§17）。若实现阶段发现本文档未能预见的边界情况，将在`V1_3_IMPLEMENTATION_REPORT.md`中记录并视需要提请CEO补充决策。

---

## 17. 全文冲突旧定义扫描与撤销记录（对应CEO"十一、删除全部冲突旧定义"，本节为完整审计记录，覆盖四份文档）

**扫描方法**：对`V1_3_PAPER_TRADING_SPEC.md`/`V1_3_CODEX_IMPLEMENTATION_TASK.md`/`V1_3_ACCEPTANCE_TESTS.md`/`V1_3_ARCHITECTURE_REVIEW.md`四份文档全文执行关键词扫描（"点击"、`confirmOpenPosition`、`confirmAddOn`、`confirmReduce`、`confirmClose`、`confirmConservativeSettlement`、`TradeProposal`/`buildTradeProposal`、"用户必须"、"手动接受"），逐条判定是否属于CEO列出的四类冲突旧定义或其直接衍生表述，逐条记录处理方式。

### 17.1 CEO明确列出的四条待删除/改写表述——处理结果

| CEO原文表述 | 是否在文档中找到 | 处理方式 | 位置 |
|---|---|---|---|
| "用户必须逐笔点击确认才建立模拟仓位" | 是（以"只有用户点击确认才建立仓位"等同义表述出现） | **原地改写**为"用户通过总开关一次性授权自动模拟交易，运行期间系统按规则自行虚拟交易" | SPEC 版本头、§0.3、§15.0表格第③行 |
| "每次开仓必须手动接受" | 是（以"每次加仓必须由用户再次点击确认"等同义表述出现） | **原地改写**为"每次加仓由引擎在条件满足时自动执行" | SPEC §5.2条件8 |
| "不实现无人确认的自动模拟开仓" | 是（§0.3原文，CODEX_TASK §1.2同步） | **原地改写**，V1.3当前产品定义就是自动开仓，改写为"不得连接真实账户/发送真实订单/使用真实资金"三条红线（性质不同的禁止事项被保留，"无人确认"这条被撤销） | SPEC §0.3，CODEX_TASK §1.2/§8.1 |
| "PaperAccount只有用户点击才生效" | 是（§15.0表格"是否需要用户点击"列） | **原地改写**为"仅需一次性开启（总开关+二次确认），运行期间不需要逐笔点击" | SPEC §15.0表格第③行 |

### 17.2 函数级改动清单（全部四份文档一致生效）

| 旧函数（draft-2/draft-3） | draft-4状态 | 新函数/去向 |
|---|---|---|
| `confirmOpenPosition`（draft-3已重命名`autoOpenPosition`） | 已废弃 | `autoEngineOpenPosition`（§16.10），由引擎在§16.2十四项条件满足时自动调用 |
| `confirmAddOn`（draft-3已重命名`autoAddOn`） | 已废弃 | `autoEngineAddOn`（§16.10），由引擎在§5.2条件满足时自动调用 |
| `confirmReduce` | **整体移除** | 无替代——CEO本轮明确不保留手动部分减仓概念，分批止盈完全由`scanClosedBarsForExits`自动执行 |
| `confirmClose` | 改名+语义收窄 | `emergencyClosePosition`（§16.6），从"常规手动平仓"收窄为"唯一保留的例外性人工介入操作" |
| `confirmConservativeSettlement` | **并入**`emergencyClosePosition` | 当`trade.status==='UNRESOLVED_DATA_GAP'`时，`emergencyClosePosition`内部自动切换为保守结算成交规则（§8.5/§16.6），不再是独立函数 |
| `buildTradeProposal`/`TradeProposal` | **保留，角色改变** | 不再是"等待用户点击确认"的对象，改为引擎内部消费+UI"下一自动动作"只读预览（§16.5） |
| `resetPaperAccount`/`changeInitialCapital`/`confirmForcedObservationAcknowledgement` | **保留，不变** | 账户级设置操作，本来就不是"逐笔交易"性质，不属于本轮撤销范围 |

### 17.3 状态机改动清单

| 旧状态/概念 | draft-4状态 | 说明 |
|---|---|---|
| `PositionStatus.PENDING_ENTRY` | **整体移除** | `PaperTrade`只在实际开仓那一刻创建，不再有"已生成方案、等待确认"的持久化中间态（SPEC §3.4） |
| `PositionStatus.CANCELLED` | **整体移除** | 无对应概念可取消（没有等待中的方案） |
| `PositionStatus.BLOCKED` | **整体移除，语义迁移** | "引擎本想开仓但条件不满足"改由关联`SignalSnapshot.userActionStatus`的`AUTO_BLOCKED_BY_RISK`/`AUTO_BLOCKED_BY_POSITION`/`AUTO_MISSED_ENGINE_OFF`/`AUTO_MISSED_DATA_GAP`四个新值承载（§15.9） |
| `SignalSnapshot.userActionStatus`的`ACCEPTED` | **撤销** | 由`AUTO_EXECUTED`取代 |
| `SignalSnapshot.userActionStatus`的`REJECTED` | **撤销，不再产生** | 用户不再对单条建议做接受/拒绝，只有宏观的暂停/禁止新开仓/关闭 |
| 新增：`EngineState`六态 | 新增 | `AUTO_PAPER_OFF/ARMED/RUNNING/PAUSED/RISK_LOCKED/DATA_BLOCKED`（§16.1） |
| 新增：`userActionStatus`五个`AUTO_*`值 | 新增 | `AUTO_EXECUTED`/`AUTO_BLOCKED_BY_RISK`/`AUTO_BLOCKED_BY_POSITION`/`AUTO_MISSED_ENGINE_OFF`/`AUTO_MISSED_DATA_GAP`（§15.9） |

### 17.4 逐文档扫描结果统计

| 文档 | 扫描到的"点击"相关表述总数（改动前） | 判定为冲突需改写 | 判定为合法保留（账户级设置/`emergencyClosePosition`/历史变更记录） |
|---|---|---|---|
| `V1_3_PAPER_TRADING_SPEC.md`（draft-3末尾状态，改动前） | 26处 | 15处已原地改写或标注（§0.3/§3.4/§5.2条件8/§6.2/§6.11/§8.5/§10/§11/§15.0/§15.2/§15.9，含术语表第6项） | 11处保留（`changeInitialCapital`两步确认、`emergencyClosePosition`点击时间、`FORCED_OBSERVATION`解除确认、历史changelog条目等，均为账户级设置操作或历史记录，非本轮撤销对象） |
| `V1_3_CODEX_IMPLEMENTATION_TASK.md` | 5处 | 全部5处已原地改写（§1.2/§1.3/§3步骤3/新增§8全篇） | 0 |
| `V1_3_ACCEPTANCE_TESTS.md` | 5处 | 全部5处已原地改写或已被函数级重命名覆盖（T16.1/T39.2-T39.4/T42.1，见§17.5） | 0 |
| `V1_3_ARCHITECTURE_REVIEW.md` | 3处 | 1处（T39.2引用行）已随ACCEPTANCE_TESTS同步更新 | 2处保留（历史设计说明，描述draft-1→draft-2的"重复点击"用户体验改进，非本轮撤销对象） |

### 17.5 已知残留与说明

`V1_3_ACCEPTANCE_TESTS.md`原T2/T3/T6/T7/T11/T17/T18/T19/T21/T23等既有测试用例（T1-T27）中大量出现的`confirmOpenPosition`/`confirmAddOn`已通过全文机械改名同步为`autoOpenPosition`/`autoAddOn`（draft-3已完成的第一次改名），但这两个名字本身在draft-4已被判定为废弃（见§17.2，实际应使用`autoEngineOpenPosition`/`autoEngineAddOn`）。**本文档不在T1-T27内逐条替换为最终函数名**——T1-T27测试的断言内容（会计恒等式、手续费滑点公式、加仓七条件、止损止盈撮合规则等）全部保持有效且未被本轮修订触碰，只是其中使用的函数名是draft-2/draft-3阶段的历史名称；`V1_3_ACCEPTANCE_TESTS.md`已在文件头新增字段/函数名对照说明（见文档T1章节前的红线注记）指向本表§17.2，供实现阶段Codex在编写`tests/v13-*.js`时使用正确的最终函数名。这是本文档在"全文替换风险"与"保持T1-T27两百余条已验证断言逐字稳定"之间做出的明确取舍，理由：T1-T27是draft-2两轮CEO决策已经核对过的成熟测试规范，逐条重写产生新错别字/断言遗漏的风险高于保留一份"函数名对照表"的认知成本。
