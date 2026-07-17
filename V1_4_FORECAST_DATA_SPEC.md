# V1_4_FORECAST_DATA_SPEC.md — V1.4 预测数据与历史验证基础 核心规范

正式名称：**V1.4 Forecast Data & Historical Validation Foundation — GMKG Minimum Verifiable Loop**
中文名称：**V1.4 预测数据与历史验证基础——GMKG 最小可验证闭环**

版本：v1.4-spec-draft-2（CEO本轮冻结裁决关闭P0-1/P0-2/P0-5/P1-2/P1-3及firstResistance/firstSupport字段形状订正后的修订版）
基线：`main` @ `a3d7aea`（含 V1.1/V1.2/V1.3/V1.3.1 + `GMKG_DRAGONFLY_ARCHITECTURE.md`，PR #6 已合并）
角色：本文档是 V1.4 六份文档中**唯一的核心业务规范**，回答"V1.4 具体要产出什么、用什么规则产出、这些规则的具体数值是多少"。本轮**只交付规范文档**，不修改 `GMKG_DRAGONFLY_ARCHITECTURE.md`、不修改任何 HTML/JS/测试/正式业务代码、不创建 PR、不合并 main、不开始编码。

---

## 0. 文档角色、依据与字段权威归属（红线，必须最先读到）

### 0.1 与 GMKG 总架构的关系

`GMKG_DRAGONFLY_ARCHITECTURE.md`（下称"GMKG总架构"）是 GMKG 概念、类型边界、运行模式、时间契约的**最高依据**。本文档**不重新发明**与其冲突的平行结构，只在 GMKG 总架构**刻意留白**的地方（"具体数值留待V1.4标定"）补上 V1.4 的**具体、可执行、已版本化**的规则。凡本文档与 GMKG 总架构冲突之处，以 GMKG 总架构为准，并应记录到 `V1_4_ARCHITECTURE_REVIEW.md`，不得在本文档内自行推翻总架构。

### 0.2 六份文档的字段权威归属矩阵（红线，防止复制后漂移）

| 字段/类型 | 唯一权威定义位置 | 其余文档的引用方式 |
|---|---|---|
| `DataVintageRef`/`DataRevisionEvent`/`StateFrame`/`EventSnapshot`/`WorldState`/`FrameDataQuality` | `GMKG_DRAGONFLY_ARCHITECTURE.md` §4.3/§4.3.1/§4.4/§4.5/§5.3 | 直接引用章节号，不复制字段列表 |
| `OperatingMode`/`FormalStateId`/`TargetStateId`/`FusionStateId`/`PriceOnlyStateId`/`TargetState`/`FeatureCompleteness` | GMKG总架构 §6.3/§7.0a/§7.0b | 直接引用，本文档§4只补充PO_*状态的**具体判定规则**，不重新定义类型本身 |
| `FormalTransitionRecord`/`ProxyTransitionRecord`/`TransitionBundle` | GMKG总架构 §8.4/§11.2 | 直接引用；本文档只声明V1.4实际产出`ProxyTransitionRecord`+`{kind:'none'}`，不产出`FormalTransitionRecord`实例 |
| `BarRef`/`ForecastSnapshot`/`ForecastOutcomeEvent`/`TrajectoryScenarios`/`ScenarioDetail`/`ForecastResult` | GMKG总架构 §10.1/§10.2/§11.2/§11.4 | 直接引用完整接口；本文档§6-§11补充V1.4的**具体字段取值规则**（如`directionThreshold`具体口径、`predictionId`生成算法），不重新定义接口形状 |
| `ActionPermission`（`readinessLevel`/`gateStatus`/`mode`等） | GMKG总架构 §11.4 | 直接引用；本文档§12只声明V1.4如何填这些字段的值 |
| `ErrorAttribution` | GMKG总架构 §15.2 | 直接引用类型；`V1_4_HISTORICAL_VALIDATION_SPEC.md` 定义V1.4的具体归因规则冻结 |
| PO_*状态具体判定规则（输入特征/阈值/滞后/最短持续bar数） | **本文档 §4**（唯一权威） | 其余五份文档引用本文档§4，不重复罗列具体数值 |
| `directionThreshold`/`scenarioWeights`归一化算法/`predictionId`生成与去重规则/存储schemaVersion | **本文档 §7-§9**（唯一权威） | 其余文档引用 |
| Walk-forward切分方法/重叠样本处理/误差归因规则冻结 | `V1_4_HISTORICAL_VALIDATION_SPEC.md`（唯一权威） | 本文档§13只做指向性说明 |
| 数据源真实/研究/目标三层状态 | `V1_4_DATA_SOURCE_MATRIX.md`（唯一权威） | 本文档§2只做"当前可用/不可用"的概括声明 |
| Codex实施步骤/文件清单/localStorage键名的**代码组织** | `V1_4_CODEX_IMPLEMENTATION_TASK.md`（唯一权威） | 本文档§9提到的存储规则是"要存什么"，具体"怎么实现"以CODEX_TASK为准 |
| 测试用例 | `V1_4_ACCEPTANCE_TESTS.md`（唯一权威） | — |
| 风险/未决问题 | `V1_4_ARCHITECTURE_REVIEW.md`（唯一权威） | — |

### 0.3 强制标注规则（延续 GMKG 总架构体系）

| 标注 | 含义 |
|---|---|
| 【V1.4真实实现】 | 本文档定义、V1.4阶段用当前Binance数据即可产出的真实能力 |
| 【V1.4接口占位】 | 结构/字段存在，但字段值在V1.4阶段恒为`null`/空/固定占位，等待未来数据接入 |
| 【推迟到服务器版本】 | 逻辑上属于GMKG范围，V1.4单文件/本地存储架构无法承担，需等§16服务器架构 |
| 【仍需研究】 | 数据源或方法学尚未核实，不在V1.4本轮承诺 |

---

## 1. V1.4 产品目标与优先级链条

V1.4 **不是**一次性完成全部 GMKG，只建设 GMKG 的**可验证骨架**，并使用当前真实可用的 Binance 公开现货 K 线形成**最小闭环**。

```
预测方向
  → 预测幅度和区间
  → 历史结果回填
  → 误差归因
  → Walk-forward验证
  → 模拟行动价值验证
  → 未来数据扩展
  → 真实交易（V1.4及可预见未来版本仍然禁止）
```

**红线**：本优先级链条决定了资源投入顺序——V1.4 的工程重心在"预测方向/幅度是否被正确记录、结果是否被正确回填、误差是否被正确归因"这条链路的**结构完整性**上，不在"模拟盈利好不好看"上（呼应 GMKG总架构 §2 红线2/3：预测与账户/模拟交易结果是不同的验证目标）。真实交易在 V1.4 及可预见的未来版本中**继续被禁止**，不因本轮建立了更完整的验证骨架而改变。

---

## 2. 现状边界（红线，逐项标注）

### 2.1 当前真实可用数据【V1.4真实实现】

- Binance 公开现货 REST：`ETHUSDT`、`BTCUSDT`，`15m`/`1h`/`4h` 三个周期，均为**已收盘K线**；
- OHLC、成交量、K线时间（`openTime`/`closeTime`）；
- 由现有 `v1-core.js`/`v1_2-forecast-core.js` 已实现的衍生特征：EMA5/10/20、ATR14、Swing高低点、动态支撑压力、`volumeRatio`成交量质量、`btcAlignment`BTC联动、`falseBreakoutTier`假突破分级、三周期状态机（`classifyState`/`classifyHtfState`）。

### 2.2 当前不具备的数据【仍需研究，本轮不接入】

240项广度眼完整数据；精度眼 B-G 组（订单簿/主动资金、衍生品杠杆、期权、资金流、链上供需、跨资产相对强弱）；资金费率、OI、爆仓、CVD、订单簿、ETF资金流、链上数据、期权、新闻事件；服务器24小时采集能力。

**红线**：本文档、`V1_4_DATA_SOURCE_MATRIX.md`、`V1_4_CODEX_IMPLEMENTATION_TASK.md`、`V1_4_ACCEPTANCE_TESTS.md` 全文**不得**把§2.2列出的任何一项写成"V1.4已接入"。

---

## 3. V1.4 运行模式（引用 GMKG总架构 §7.0a/§7.0b，本节确认 V1.4 的实际落地范围）

V1.4 **只能真实运行** `PRICE_ONLY_MODE`；A组现货K线数据不完整时进入 `INSUFFICIENT_DATA`；V1.4 **不得真实产出** `FULL_STATE_MODE`。

| 规则 | V1.4落地状态 |
|---|---|
| `PRICE_ONLY_MODE`下`TargetState.primaryState`恒为`'UNKNOWN'` | 【V1.4真实实现】强制校验，见§14验收 |
| 只能输出`PriceOnlyStateId`的`PO_*`代理状态 | 【V1.4真实实现】具体规则见§4 |
| 不得声称识别S0-S7正式状态 | 【V1.4真实实现】红线，`FULL_STATE_MODE`判定函数在V1.4阶段不被调用 |
| 不得声称看到Funding/OI/爆仓/订单流/ETF/链上 | 【V1.4真实实现】红线，PO_\*状态的`evidenceText`措辞审查见§4.9 |
| 只产生`ProxyTransitionRecord` | 【V1.4真实实现】 |
| 不产生`FormalTransitionRecord` | 【V1.4真实实现】类型/规则先行落地供未来复用，见GMKG总架构§17.1第5条 |
| `PROXY_STATS`与`FULL_STATE_STATS`永久隔离 | 【V1.4真实实现】存储层面用不同的键区分，见§9.4 |
| `INSUFFICIENT_DATA`不产生迁移记录 | 【V1.4真实实现】 |
| 代理状态不得进入正式八状态校准分母 | 【V1.4真实实现】 |

### 3.0 服务器时间前置门禁（红线，CEO已冻结裁决，P0-2，先于`operatingMode`判定执行）

**背景**：draft-1曾允许"本地时间减安全边际"作为Binance服务器时间校验的简化替代方案。CEO本轮已**撤销**这一备选方案，冻结为唯一路径。

**冻结规则**：

1. 生成任何24H/72H `ForecastSnapshot`之前，**必须**调用 `GET https://api.binance.com/api/v3/time` 获取Binance服务器时间；
2. 可以在**单次刷新周期内**缓存`serverTime`与本地时间的偏移量（`offset = serverTime − Date.now()`），避免同一刷新周期内重复请求；缓存**不得**跨刷新周期沿用（每次新的生成周期必须重新校验一次偏移，防止长时间运行后偏移漂移未被发现）；
3. K线"是否已收盘"的判定**必须**以 `候选K线.closeTime <= (Date.now() + offset)`（即换算到服务器时间坐标系）为准；
4. **禁止**直接用 `Date.now()`（未做服务器偏移校正）判定K线是否已收盘、进而选择`referenceBar`；
5. **禁止**"本地时间减1分钟/减任意安全边际"作为正式替代方案——这条路径在draft-1中曾被列为可接受的简化选项，本轮**明确撤销**，不再是合法实现路径；
6. **若`/api/v3/time`请求失败或超时（服务器时间不可用）**：
   - **fail closed**——整条生成流程立即中止；
   - **不创建**新的24H/72H `ForecastSnapshot`；
   - 返回明确的阻塞结果，`generationBlockedReason='SERVER_TIME_UNAVAILABLE'`，顶层状态标记为`'DATA_BLOCKED'`（见下方§3.0.1，这是比`operatingMode='INSUFFICIENT_DATA'`更前置的一道门禁，二者不是同一层级的判断）；
   - **不得**猜测`referenceBar`（不得退回"就用最后一次成功缓存的服务器时间偏移"这种隐性猜测）；
   - **不得**沿用上一次成功生成时的`referenceBarRef`/`generatedAt`伪装成本次预测的时间戳。

### 3.0.1 `DATA_BLOCKED` 与 `operatingMode` 的层级关系

```
DATA_BLOCKED（生成流程级别的前置门禁，本节新增）：
  触发条件：服务器时间不可获取（§3.0第6点）
  结果：不产生ForecastSnapshot，不产生operatingMode判断，只记录一条阻塞事件（结构见V1_4_CODEX_IMPLEMENTATION_TASK.md）

operatingMode（precision-eye状态判定级别，见§3.1，前提是已通过§3.0门禁）：
  'PRICE_ONLY_MODE' / 'INSUFFICIENT_DATA'（GMKG总架构§7.0a既有二态，V1.4不产出FULL_STATE_MODE）
```

**红线**：`DATA_BLOCKED`**不是**`OperatingMode`枚举的第三个值——`OperatingMode`类型本身（`GMKG_DRAGONFLY_ARCHITECTURE.md`§6.3定义）不因此扩展，`DATA_BLOCKED`是V1.4新增的、更前置的生成流程状态，只在服务器时间门禁失败时出现，此时**根本不产生**`TargetState`/`operatingMode`判断（不是"产生了一个`operatingMode='DATA_BLOCKED'`"，是"整个判断都没有发生"）。

### 3.1 `INSUFFICIENT_DATA` 触发条件（V1.4具体冻结，前提：已通过§3.0服务器时间门禁）

当且仅当以下任一条件成立时，`operatingMode='INSUFFICIENT_DATA'`（`primaryState='UNKNOWN'`，`proxyState=null`，只输出`candidateStates`）：

1. ETH或BTC任一周期（15m/1h/4h）K线数组长度不足以计算ATR14（沿用`v1-core.js` `assessDataQuality().sufficientForATR14`既有判定，不重新发明）；
2. `assessOverallHealth()`（`v1-core.js`既有函数）返回`'invalid'`；
3. 用于本次24H/72H预测的`referenceBarRef`对应K线（按§3.0服务器时间校正后判定）本身缺失或未收盘。

否则（即A组数据完整可用）进入`PRICE_ONLY_MODE`，即使`assessOverallHealth()`返回`'delayed'`（数据延迟但结构未失效）也仍归入`PRICE_ONLY_MODE`，只是`featureCompleteness.criticalFeatureCompleteness`相应下调（见§5.4）。

---

## 4. `PriceOnlyStateId` 代理状态规则（本文档唯一权威定义，红线：具体数值已冻结，不留给Codex自行决定）

### 4.0 设计原则

- 全部9个代理状态**只使用A组特征**（现货价格、EMA、ATR、Swing、动态支撑压力、成交量比、BTC联动、假突破分级），**不引入**任何B-G组特征；
- 判定主要基于 **4小时周期**特征（`e4`，对应现有`analyzeKlines`/`classifyHtfState`输出），因为24H/72H的推演尺度与4小时结构的相关性高于15分钟噪音；1小时周期（`e1`）用于交叉确认；
- 阈值类型延续 GMKG总架构 §7.1 的"相对阈值为主、极值判定用绝对阈值"原则，本节全部使用**相对阈值**（相对自身ATR/成交量基线），因为V1.4阶段没有历史分位数统计基础，不可能冻结有意义的"绝对历史极值"；
- 每个状态的默认阈值标注为版本 `poThresholdVersion = 'v1.4-po-threshold-1'`——这是**初始默认值**，不是"永久正确值"，`V1_4_HISTORICAL_VALIDATION_SPEC.md` 的 walk-forward/消融流程负责未来重新标定；阈值修改必须递增此版本号（呼应`V1_2_FORECAST_SPEC.md`已确立的版本号红线，不重新发明）。

### 4.1 输入特征清单（全部已由 `v1-core.js`/`v1_2-forecast-core.js` 计算，本节只做只读消费，不新增采集）

`e4.price`、`e4.ema5/10/20`、`e4.atr14`、`e4.recentHigh20/recentLow20`、`e4.isBreakout/isBreakdown`、`e4.breakoutBarsCount/breakdownBarsCount`、`e4.volumeRatio`、`e4.trend`（`'up'|'down'|'flat'`）、`e4.risingLows/fallingHighs`、`e4.hasLongUpperWick/hasLongLowerWick`、`e1`（同名字段，1小时周期，交叉确认用）、`btcAlignment(direction, b4)`（复用`v1-core.js`既有函数）、`decision.dataHealth`。

**字段形状红线（本轮核对v1-core.js源码后订正，取代draft-1的错误假设）**：`e4.firstResistance`/`e4.firstSupport`是`analyzeKlines()`直接产出的`level()`对象，其形状为`{price, source, confidence, clusterId, barsAgo}`——**只有`.price`，没有`.lower`/`.upper`字段**。§4.2中任何需要"区间"边界（`.lower`/`.upper`）的判定，**必须**改用`buildSRZones(e4)`的输出（`{supportZones, resistanceZones}`，其中每个zone元素形状为`{type, rank, center, lower, upper, confidence, source, sourceLabel, sourceSwingCount, zoneHalfWidth}`），即：区间下沿/上沿取自`buildSRZones(e4).supportZones[0].lower/.upper`（对应`firstSupport`）或`buildSRZones(e4).resistanceZones[0].lower/.upper`（对应`firstResistance`），**不得**假设`e4.firstSupport.lower`/`e4.firstResistance.upper`这类字段直接存在于原始快照对象上。

### 4.2 九个代理状态定义

**记号约定**：以下 `srZones = buildSRZones(e4)` 表示对`e4`调用`v1-core.js`既有`buildSRZones()`函数得到的区间结果；`srZones.supportZones[0].lower/.upper`即"第一支撑区"的下沿/上沿（对应`firstSupport`的区间化版本），`srZones.resistanceZones[0].lower/.upper`即"第一压力区"的下沿/上沿（对应`firstResistance`的区间化版本）——这两个字段**只存在于`buildSRZones()`的输出上**，不存在于`e4.firstSupport`/`e4.firstResistance`原始`level`对象本身（见§4.1字段形状红线）。

**`PO_RANGE_LOW_STRUCTURE`（区间低位结构代理，对应S0积累的价格结构侧证据）**
- 必要条件：`e4.price` 落入 `[srZones.supportZones[0].lower − 0.3×ATR14, srZones.supportZones[0].upper + 0.3×ATR14]` 区间内，**或** `e4.price <= e4.recentLow20 × 1.03`；且 `e4.trend ∈ {'flat','down'}`（非强势上行）。
- 加分条件：`e4.risingLows === true`（低点抬高）；`e4.volumeRatio` 在 `[0.8, 1.2]`（温和，非放量非缩量）。
- 否决条件：`e4.isBreakdown === true` 且 `e4.breakdownBarsCount >= 2`（已确认跌破，不满足"低位企稳"叙事）；`decision.dataHealth !== 'normal'`。
- 状态保持条件：连续满足必要条件的4小时K线数 `>= 2`（即8小时未破位）。
- 状态退出条件：`e4.price` 突破 `srZones.resistanceZones[0].upper + 0.3×ATR14`（转入`PO_BREAKOUT_UP_STRUCTURE`）或跌破 `srZones.supportZones[0].lower − 0.5×ATR14` 且已收盘确认（转入`PO_BREAKDOWN_STRUCTURE`）。
- 切换滞后：进入需连续2根4H K线确认，退出需1根已收盘4H K线确认突破/跌破（不对称，突破退出更快，呼应V1.1"已收盘确认"传统）。
- 最短持续bar数：2根4H bar（8小时）。
- 冲突处理：若同时满足`PO_RANGE_RECOVERY_STRUCTURE`条件（见下），以更晚近的出清事件为准（若近期`PO_SHARP_DROP_STRUCTURE`未曾触发，归入本状态；若曾触发，归入`PO_RANGE_RECOVERY_STRUCTURE`）。
- 数据不足处理：`e4`数据不足以计算ATR14时，直接归入`operatingMode='INSUFFICIENT_DATA'`，不产生本状态判定。
- 默认阈值：`0.3×ATR14`（区间容差）、`1.03`（低点容差比例）、`[0.8,1.2]`（成交量温和区间）、`2`根bar（最短持续/确认）。
- 阈值版本：`v1.4-po-threshold-1`。
- 不得使用的缺失数据：资金费率、OI、交易所净流出、大户持仓——**不得**在`evidenceText`中出现"资金费率转平""交易所净流出"等暗示已采集衍生品/链上数据的措辞。

**`PO_BREAKOUT_UP_STRUCTURE`（向上突破结构代理，对应S1准备阶段的价格结构侧证据，偏多方向）**
- 必要条件：`e4.isBreakout === true` 且 `e4.breakoutBarsCount ∈ [1,2]`（刚突破，未进入延续阶段）。
- 加分条件：`e4.volumeRatio >= 1.2`；`btcAlignment('long', b4) === 'support'`。
- 否决条件：`falseBreakoutTier ∈ {'warning','confirmation_failed'}`（复用v1.1既有假突破分级，不重新定义）。
- 状态保持：`breakoutBarsCount <= 2`。
- 状态退出：`breakoutBarsCount > 2` 时转入`PO_TREND_UP_STRUCTURE`；假突破分级转为`confirmation_failed`时退回`PO_RANGE_LOW_STRUCTURE`或`PO_RANGE_RECOVERY_STRUCTURE`（视之前状态而定）。
- 切换滞后：无额外滞后（突破本身已经是"已收盘确认"事件，见`e4.isBreakout`定义）。
- 最短持续bar数：1根4H bar。
- 冲突处理：若`e4`同时呈现`isBreakout`与`isBreakdown`（数据异常，理论不应同时为真），判定为数据异常，转入`INSUFFICIENT_DATA`并记录`exclusionReasons`。
- 数据不足处理：同上。
- 默认阈值：`breakoutBarsCount<=2`、`volumeRatio>=1.2`（沿用V1.1既有"1.20量比"惯例，不重新发明新数字）。
- 阈值版本：`v1.4-po-threshold-1`。
- 不得使用的缺失数据：OI变化率、订单簿失衡——不得声称"资金正在进场"。

**`PO_TREND_UP_STRUCTURE`（延续上行结构代理，对应S2多头扩张的价格结构侧证据）**
- 必要条件：`e4.trend === 'up'` 且 `e4.breakoutBarsCount > 2`（突破已进入延续阶段）。
- 加分条件：`e4.price` 沿`e4.ema20`上方运行且未跌破；`e1.trend === 'up'`（1小时同向）。
- 否决条件：`falseBreakoutTier === 'confirmation_failed'`。
- 状态保持：`e4.trend === 'up'`持续。
- 状态退出：`e4.trend`转为`'flat'`或`'down'`（转入`PO_STALL_HIGH_STRUCTURE`或`PO_TREND_DOWN_STRUCTURE`，视具体转折形态而定，见§4.3冲突处理表）。
- 切换滞后：退出需2根连续4H K线确认trend变化（防止单根抖动）。
- 最短持续bar数：3根4H bar（12小时）。
- 冲突处理：本状态与`PO_STALL_HIGH_STRUCTURE`可能同时有部分证据支持时（价格仍创新高但成交量背离），**保留在`PO_TREND_UP_STRUCTURE`**，仅在`stateEvidence`中标注背离迹象，不提前判定`PO_STALL_HIGH_STRUCTURE`（呼应§4.9红线：不得用价格结构代理去揣测"是否过热"，那是需要衍生品数据才能正式判断的S3范畴，PRICE_ONLY_MODE下宁可保守留在延续判定）。
- 数据不足处理：同上。
- 默认阈值：`breakoutBarsCount>2`（延续阈值）、`2`根bar（退出确认）、`3`根bar（最短持续）。
- 阈值版本：`v1.4-po-threshold-1`。
- 不得使用的缺失数据：资金费率/OI极值——**不得**输出"过热"或"透支"这类需要衍生品证据的判断，即使价格加速上涨也只能说"价格结构延续上行"。

**`PO_STALL_HIGH_STRUCTURE`（高位滞涨结构代理，对应S4派发的价格结构侧证据）**
- 必要条件：前置状态为`PO_TREND_UP_STRUCTURE`；`e4.price`相对近期高点`e4.recentHigh20`不再创新高，且已持续`>=2`根4H bar。
- 加分条件：`e4.volumeRatio < 1.0`（滞涨伴随缩量）；`e4.hasLongUpperWick === true`（长上影线，价格结构层面的滞涨信号）。
- 否决条件：`e4.price`重新突破`e4.recentHigh20`（应退回`PO_TREND_UP_STRUCTURE`，不满足滞涨）。
- 状态保持：不创新高持续。
- 状态退出：跌破`srZones.supportZones[0].lower`（转入`PO_BREAKDOWN_STRUCTURE`）或重新创新高（退回`PO_TREND_UP_STRUCTURE`）。
- 切换滞后：进入需2根bar确认，退出（跌破方向）需1根已收盘bar确认。
- 最短持续bar数：2根4H bar。
- 冲突处理：与`PO_TREND_UP_STRUCTURE`冲突时按"是否创新高"这一客观价格事实裁决，不依赖主观判断。
- 数据不足处理：同上。
- 默认阈值：`2`根bar（不创新高持续）、`volumeRatio<1.0`（缩量参考）。
- 阈值版本：`v1.4-po-threshold-1`。
- 不得使用的缺失数据：交易所净流入、大户持仓变化——不得声称"大户正在减仓"。

**`PO_BREAKDOWN_STRUCTURE`（向下突破结构代理，与`PO_BREAKOUT_UP_STRUCTURE`对称）**
- 必要条件：`e4.isBreakdown === true` 且 `e4.breakdownBarsCount ∈ [1,2]`。
- 加分条件：`e4.volumeRatio >= 1.2`；`btcAlignment('short', b4) === 'support'`。
- 否决条件：`falseBreakoutTier ∈ {'warning','confirmation_failed'}`。
- 其余（状态保持/退出/切换滞后/最短持续/冲突/数据不足/阈值/阈值版本/禁用数据）与`PO_BREAKOUT_UP_STRUCTURE`对称（方向相反）。

**`PO_TREND_DOWN_STRUCTURE`（延续下行结构代理，与`PO_TREND_UP_STRUCTURE`对称）**
- 必要条件：`e4.trend === 'down'` 且 `e4.breakdownBarsCount > 2`。
- 其余对称于`PO_TREND_UP_STRUCTURE`。

**`PO_SHARP_DROP_STRUCTURE`（价格结构急跌代理，对应S6投降/出清的价格结构侧证据——红线：不得称为"投降"或"出清"，只能称"价格结构急跌"）**
- 必要条件：单根4H K线跌幅 `(open-close)/open >= 3×ATR14/price`（相对自身波动率的急跌，绝对阈值类型——因为"急跌"本身是极值事件，需要绝对判据，呼应GMKG总架构§7.1"极值判定需要绝对阈值"原则）；且`e4.volumeRatio >= 1.8`（放量急跌）。
- 加分条件：`e4.hasLongLowerWick === true`（长下影线，价格结构层面的"探底回升"迹象，非"出清确认"）。
- 否决条件：数据不足（`e4.atr14`无效）时不得判定，这与GMKG总架构§7.1 `S6`"数据不足时宁可退回S5"的红线精神一致——本状态数据不足时退回`PO_TREND_DOWN_STRUCTURE`或直接`INSUFFICIENT_DATA`。
- 状态保持：急跌当根bar及其后1根bar内。
- 状态退出：急跌后波动率收窄（`e4.atr14`相对急跌当根显著下降）超过2根bar，转入`PO_RANGE_RECOVERY_STRUCTURE`。
- 切换滞后：进入不需滞后（急跌是即时事件），退出需2根bar确认波动率收窄。
- 最短持续bar数：1根4H bar（急跌本身可能极短）。
- 冲突处理：与`PO_TREND_DOWN_STRUCTURE`冲突时，若单根跌幅达到绝对阈值即优先判定为本状态（急跌证据权重更高）。
- 数据不足处理：见否决条件。
- 默认阈值：`3×ATR14`（急跌判据）、`1.8`（放量倍数）。
- 阈值版本：`v1.4-po-threshold-1`。
- **红线（呼应GMKG总架构§7.0b：本状态在B-G组数据齐全前禁止正式判定为S6）**：`evidenceText`必须明确写"仅基于价格结构急跌，未确认强平/杠杆出清"，**不得**使用"投降""出清""恐慌抛售确认"等确定性归因措辞，只能使用"价格结构层面观察到急跌"这类描述性措辞。

**`PO_RANGE_RECOVERY_STRUCTURE`（急跌后区间修复代理，对应S7修复震荡的价格结构侧证据）**
- 必要条件：前置状态为`PO_SHARP_DROP_STRUCTURE`；`e4.atr14`相对急跌当根bar下降`>=40%`。
- 加分条件：价格在近期急跌区间内往复（`e4.price`在`[急跌后低点, 急跌前高点×0.6+急跌后低点×0.4]`区间内波动，即修复到跌幅的约40%附近或以下，不强行量化"完全修复"）。
- 否决条件：价格重新创急跌阶段新低（应退回`PO_SHARP_DROP_STRUCTURE`）。
- 状态保持：波动率维持收窄状态。
- 状态退出：重新出现方向性突破（转入`PO_BREAKOUT_UP_STRUCTURE`/`PO_BREAKDOWN_STRUCTURE`）或创新低（退回`PO_SHARP_DROP_STRUCTURE`）。
- 切换滞后：退出需1根已收盘bar确认突破/跌破。
- 最短持续bar数：2根4H bar。
- 冲突处理：同§4.2 `PO_RANGE_LOW_STRUCTURE`条目。
- 数据不足处理：同上。
- 默认阈值：`40%`（波动率收窄幅度）。
- 阈值版本：`v1.4-po-threshold-1`。
- 不得使用的缺失数据：强平数据、多空持仓比——不得声称"杠杆已出清完毕"。

**`PO_UNKNOWN`（无法给出任何代理判断）**
- 触发条件：以上8项代理状态必要条件均不满足（如价格恰好处于两组条件的过渡地带、或`e4`/`e1`交叉确认冲突且无法用§4.2冲突处理表裁决）。
- **红线**：`PO_UNKNOWN`**不等于**`operatingMode='INSUFFICIENT_DATA'`——前者是"数据完整但价格结构本身处于无法归类的过渡态"，后者是"数据本身不足以支撑任何判断"，两者触发条件互斥，`stateEvidence`/`exclusionReasons`必须能区分记录的是哪一种原因。

### 4.3 冲突处理总表（跨状态，补充4.2中未尽事宜）

| 冲突情形 | 裁决规则 |
|---|---|
| `PO_TREND_UP_STRUCTURE` vs `PO_STALL_HIGH_STRUCTURE` | 以"是否创近期新高"这一客观价格事实裁决（见4.2 `PO_STALL_HIGH_STRUCTURE`必要条件） |
| `PO_RANGE_LOW_STRUCTURE` vs `PO_RANGE_RECOVERY_STRUCTURE` | 以"近期是否发生过`PO_SHARP_DROP_STRUCTURE`"这一历史事件裁决 |
| `PO_BREAKOUT_UP_STRUCTURE` vs `PO_BREAKDOWN_STRUCTURE` 同时触发 | 判定为数据异常（理论不应同时满足），转入`INSUFFICIENT_DATA`并记录 |
| `e4`与`e1`方向不一致 | 以`e4`（4小时）为主判定依据，`e1`不一致时`stateConfidence`下调并在`opposingEvidence`中注明 |

### 4.4 `stateConfidence` 计算（V1.4具体规则）

```
stateConfidence = 60（基础分，PRICE_ONLY_MODE的结构性上限，呼应§4.9红线：代理判断置信度不得与FULL_STATE_MODE同等对待）
  + 10（若加分条件全部满足）
  + 10（若e1与e4方向一致）
  − 20（若featureCompleteness.criticalFeatureCompleteness < 0.8，见§5.4）
  − 15（若decision.dataHealth === 'delayed'）
最终clamp到[0,60]区间（红线：PRICE_ONLY_MODE下stateConfidence永远不得超过60，为未来FULL_STATE_MODE同等证据强度下的更高置信度留出区分空间，这是GMKG总架构§7.0a"降级输出置信度必须显著低于同等证据强度在FULL_STATE_MODE下的取值"红线的具体量化落地）
```

### 4.5 状态版本与措辞审查（红线）

`poRuleVersion = 'v1.4-po-rule-1'`——本节§4.2定义的9个状态的判定逻辑本身的版本号，逻辑变化必须递增（独立于§4.2各状态内的`poThresholdVersion`，逻辑不变只调数值时只需递增`poThresholdVersion`，呼应`V1_2_FORECAST_SPEC.md`§12.2已确立的"算法版本与权重版本分离递增"纪律）。

**`evidenceText`措辞红线（逐条对应GMKG总架构§18安全边界）**：全部9个状态的`evidenceText`/`stateEvidence`/`opposingEvidence`：
1. 不得使用"资金费率""OI""爆仓""订单簿""CVD""ETF净流量""链上"等暗示已采集这些数据源的词汇；
2. 不得使用"投降""出清确认""主力吸筹""操盘手""庄家"等拟人化或确定性归因措辞；
3. 只能使用"价格结构显示……""成交量比……""相对近期高低点……"等基于A组现货数据可直接验证的客观描述；
4. 每条`evidenceText`必须以`'[PRICE_ONLY]'`前缀标注（呼应GMKG总架构"所有代理标签必须明确带PROXY或PRICE_ONLY标识"红线），供UI层与日志层统一识别代理来源的证据。

---

## 5. 时间尺度与数据完整度

### 5.1 保留既有三层（不修改）

15m（执行预测层，V1.1决策核心+V1.2预测层，【V1.4真实实现】不变）、1h（短期结构背景）、4h（趋势背景）——本文档**不重新定义**这三层的算法或数据结构，只作为§4 PO_\*状态判定的输入来源，呼应GMKG总架构§10红线。

### 5.2 新增 24H/72H（GMKG最小闭环核心，【V1.4真实实现】）

沿用 GMKG总架构 §10.1/§10.2 `ForecastSnapshot`/`BarRef`/`sequenceIndex`定义：

```
referenceBar = 预测生成时最后一根已收盘的ETH 15分钟K线，sequenceIndex=0，不计入目标路径
24H目标路径 = referenceBar之后连续96根15分钟bar（sequenceIndex 1..96）
72H目标路径 = referenceBar之后连续288根15分钟bar（sequenceIndex 1..288）
targetBar（24H）= sequenceIndex=96；targetBar（72H）= sequenceIndex=288
```

### 5.3 Binance K线边界实测冻结（红线，本文档已用真实API核实，非假设）

**已于2026-07-18用真实Binance现货REST核实**（`GET https://api.binance.com/api/v3/klines?symbol=ETHUSDT&interval=15m&limit=3` 与 `symbol=BTCUSDT&interval=4h&limit=2`，响应样本已存档于本次实施记录）：

```
closeTime = openTime + timeframeMs − 1     （例：15m的openTime=1784305800000时，closeTime=1784306699999，差值899999ms=900000−1）
下一根bar的openTime = 上一根bar的closeTime + 1     （例：1784306700000 = 1784306699999 + 1）
```

**冻结结论**：
1. `BarRef.closeTime = BarRef.openTime + BarRef.timeframeMs − 1`（15m时`timeframeMs=900000`，4h时`timeframeMs=14400000`，已分别用ETHUSDT-15m与BTCUSDT-4h两组真实响应验证，两个周期结论一致）；
2. `sequenceIndex`定位时，第N根bar的`openTime`理论值 `= referenceBar.closeTime + 1 + (N-1)×timeframeMs`，**但实现时仍必须按§10.5.1九项不变量逐根核对真实返回的K线序列，不得只做这一步算术推算就假设该bar必然存在**（呼应GMKG总架构§10.2红线2）；
3. `barKey`采用 `${symbol}-${timeframe}-${closeTime}` 格式（`closeTime`本身具有跨bar唯一性，且是K线"确定已收盘"的标志时间戳，比`openTime`更适合做去重键）。

### 5.4 与既有15m/1h/4h展示关系（红线，逐条冻结）

| 问题 | 冻结结论 |
|---|---|
| V1.4是否继续生成15m原有V1.2预测 | **是**——V1.1/V1.2既有15分钟/1小时/4小时预测链路完全不变，V1.4不修改、不替代 |
| V1.4是否生成24H/72H PRICE_ONLY预测 | **是**——新增独立生成，见§6 |
| 三者展示关系 | 24H/72H预测在UI上作为**新增的、独立的展示区块**呈现（"GMKG 24H/72H 展望"），与既有"走势预测与情景推演"卡片**并列而非嵌套或替换**，具体DOM位置由`V1_4_CODEX_IMPLEMENTATION_TASK.md`定义 |
| 是否用24H/72H结果覆盖原有15m预测日志 | **不得**——`ForecastSnapshot`（24H/72H）与既有`ForecastLogEntry`（15m/1h/4h，`v1_2-forecast-core.js`）是完全独立的存储、独立的localStorage键，互不覆盖、互不合并统计 |

### 5.5 `featureCompleteness` 具体计算（V1.4版本，引用GMKG总架构§6.3结构）

```
activeProfile = operatingMode（当前只会是'PRICE_ONLY_MODE'或'INSUFFICIENT_DATA'）
profileCompleteness = A组6项特征中status='ok'的比例（PRICE_ONLY_MODE正常情况下应为1.0）
fullArchitectureCompleteness = 6 / 48 = 0.125（固定值，因为B-G组42项当前恒为missing，见GMKG总架构§6.1）
criticalFeatureCompleteness = A组6项中，本次§4 PO_*判定实际依赖到的字段（见§4.1输入特征清单）的可得比例
missingCriticalFeatures = A组6项中缺失的具体字段名列表
```

---

## 6. 24H/72H PRICE_ONLY 预测输出字段（引用 GMKG总架构 `ForecastSnapshot`，本节确认V1.4的完整取值）

V1.4 的 `ForecastSnapshot` 严格使用 GMKG总架构 §10.1 定义的接口，逐字段取值规则：

| 字段 | V1.4取值规则 |
|---|---|
| `predictionId` | 见§8.1生成规则 |
| `instrument` | `'ETH'`（V1.4阶段只对ETH生成24H/72H预测，BTC的24H/72H预测留待未来版本，本文档不扩大范围） |
| `horizon` | `'24h'`或`'72h'` |
| `generatedAt`/`dataCutoffTime` | 生成时刻的时间戳，二者相等（V1.4当前唯一数据源是K线本身，无额外数据滞后） |
| `targetStartTime`/`targetEndTime` | 见§5.2 |
| `referencePrice`/`referenceBarRef`/`targetBarRef`/`expectedBarCount` | 见§5.2/§5.3 |
| `expectedDirection`/`directionThreshold` | 见§7 |
| `targetStateAtGeneration` | 恒为`'UNKNOWN'`（PRICE_ONLY_MODE下） |
| `fusionStateAtGeneration` | V1.4阶段融合中枢未真实运行广度眼输入，`fusionState`取值规则见§12.3 |
| `candidateTrajectories`（含`transitions: TransitionBundle`） | `transitions = {kind:'proxy', records: [...ProxyTransitionRecord]}` 或 `{kind:'none'}`（INSUFFICIENT_DATA时），见§4 |
| `baselineScenario`/`upsideScenario`/`downsideScenario` | 见§7.3情景生成规则 |
| `scenarioWeights` | 见§7.4 |
| `probabilityStatus` | 恒为`'rule_based'`（V1.4阶段不产生`similarity_based`或`calibrated`，历史样本积累不足，见`V1_4_HISTORICAL_VALIDATION_SPEC.md`） |
| `calibratedProbabilities` | 恒为`Record<string, null>`（三个情景key均为null） |
| `expectedPriceZones` | 见§7.3 |
| `triggerConditions`/`invalidationConditions` | 见§7.5 |
| `algorithmVersion` | `'v1.4-gmkg-loop-draft-1'` |
| `weightVersion` | `'v1.4-gmkg-scenario-weights-unvalidated-initial-1'`（呼应GMKG总架构§11.1"待验证初始参数"标注） |
| `datasetVersion` | `'v1.4-dataset-binance-spot-klines-only'` |
| `dataVintageRefs` | 引用的6条`DataVintageRef.vintageId`（ETH+BTC×15m/1h/4h各一条，见§8.4） |
| `klineWindowRefs`（P1-3新增） | 6个`KlineWindowRef`对象（ETH+BTC×15m/1h/4h各一个完整输入窗口审计引用，见§8.4a），补充`dataVintageRefs`只记单根K线版本、不足以证明特征计算实际用了哪一段历史序列的缺口 |
| `featureValuesUsed` | 见§8.5 |
| `featureEngineVersion` | `'v1.4-po-feature-engine-1'` |
| `contentHash` | 见§8.5 |

### 7. 方向、幅度与情景生成（V1.4具体冻结）

### 7.1 `directionThreshold` 口径（红线，P1-2，CEO已冻结裁决：4H ATR平方根时间缩放，取代draft-1的15分钟ATR固定倍数方案）

**背景**：draft-1用15分钟ATR直接乘固定系数（2.0/3.5）再套24H/72H的clamp下限，实践中系数偏小、下限偏高，会导致多数情况下`directionThreshold`长期贴着clamp下限，不能真实反映24H/72H尺度上应有的预期波动范围（15分钟尺度的短期噪音与24/72小时尺度的真实波动幅度不是同一量纲，简单倍数缩放没有时间尺度依据）。CEO本轮冻结为"4小时ATR + 平方根时间缩放"的规则型阈值公式：

```
volatilityUnit = e4.atr14 / referencePrice
  （e4 = ETH 4小时analyzeKlines输出，取referenceBar对应的、已收盘4小时K线计算出的ATR14；
   referencePrice = ForecastSnapshot.referencePrice，即referenceBar[15分钟]的收盘价）

24H：
  rawThreshold = volatilityUnit × sqrt(24 / 4)     // = volatilityUnit × sqrt(6)
  directionThreshold = clamp(rawThreshold, 0.008, 0.05)   // thresholdFloor=0.008，thresholdCeiling=0.05

72H：
  rawThreshold = volatilityUnit × sqrt(72 / 4)     // = volatilityUnit × sqrt(18)
  directionThreshold = clamp(rawThreshold, 0.015, 0.08)   // thresholdFloor=0.015，thresholdCeiling=0.08
```

**冻结规则（红线）**：

1. `volatilityUnit`使用的`atr14`**必须**来自**已收盘**的4小时K线（`e4.atr14`），**不得**使用未收盘4小时K线计算出的ATR值——理由：24H/72H是远长于15分钟的推演尺度，用与之量级更接近的4小时波动率做时间缩放基准，比直接挪用15分钟噪音级别的ATR更符合"用什么尺度的历史波动去外推什么尺度的未来区间"这一统计常识；
2. 时间缩放使用**平方根法则**（`sqrt(目标小时数/基准小时数)`）——这是波动率随时间平方根增长的经典统计近似（布朗运动/随机游走假设下标准差随`sqrt(t)`增长），不是任意选择的系数，24H相对4H基准是`sqrt(6)≈2.449`倍，72H是`sqrt(18)≈4.243`倍；
3. 该字段**仍是规则型阈值，不是校准概率**——平方根时间缩放是一个合理的**规则设计**，不构成"经过历史校准验证在ETH/BTC上确实成立"的统计结论，`directionThreshold`的地位与GMKG总架构§8.2"规则型权重≠统计概率"红线适用范围一致；
4. **必须保存以下字段**（供审计追溯与未来重新标定）：
   ```ts
   {
     rawThreshold: number,             // clamp前的原始计算值
     directionThreshold: number,       // clamp后实际使用的值
     thresholdFloor: number,           // 本次使用的下限（24H=0.008，72H=0.015）
     thresholdCeiling: number,         // 本次使用的上限（24H=0.05，72H=0.08）
     thresholdFormulaVersion: 'v1.4-threshold-formula-2'   // 见下方版本号，取代draft-1的directionThresholdVersion
   }
   ```
5. **`e4.atr14`无效时（数据不足以计算4小时ATR）不得猜测阈值**——此时`operatingMode`直接归入`INSUFFICIENT_DATA`（或触发§3.0`DATA_BLOCKED`，视具体缺失原因而定），不得用15分钟ATR退而求其次替代计算，也不得用固定默认值填充`directionThreshold`；
6. `thresholdFormulaVersion = 'v1.4-threshold-formula-2'`（取代draft-1的`directionThresholdVersion = 'v1.4-direction-threshold-1'`，字段改名以避免与旧版本混淆）——版本冻结规则同GMKG总架构§10.3：公式/系数/clamp边界只能随该版本号一起变化，同版本内不得动态调整。

### 7.2 UP/DOWN/RANGE 判定与MFE/MAE/区间覆盖

**完全复用 GMKG总架构 §10.3/§10.4/§10.4a 已冻结的公式**，本文档不重新定义，只声明V1.4的`directionThreshold`取值（见§7.1）作为该公式的具体输入。

### 7.3 情景生成规则（V1.4具体规则，`baselineScenario`/`upsideScenario`/`downsideScenario`）

```
基准价 = referencePrice
baselineScenario.priceZone = [referencePrice × (1 − 0.5×directionThreshold), referencePrice × (1 + 0.5×directionThreshold)]
  （即RANGE判定阈值一半宽度的居中区间，与expectedDirection='RANGE'的判定边界呼应）
upsideScenario.priceZone = [referencePrice × (1 + directionThreshold), referencePrice × (1 + 2×directionThreshold)]
downsideScenario.priceZone = [referencePrice × (1 − 2×directionThreshold), referencePrice × (1 − directionThreshold)]
```

`text`字段内容基于§4当前`proxyState`生成模板化描述（如`proxyState='PO_TREND_UP_STRUCTURE'`时，`upsideScenario.text`="若价格结构延续上行趋势，可能测试更高区域"），措辞遵守§4.5红线，不得使用确定性归因。

### 7.4 `scenarioWeights` 生成与归一化算法（红线，已冻结）

```
初始规则型打分（0-100，基于§4当前proxyState与stateConfidence）：
  若proxyState ∈ {PO_BREAKOUT_UP_STRUCTURE, PO_TREND_UP_STRUCTURE}：baseline=30, upside=50, downside=20
  若proxyState ∈ {PO_BREAKDOWN_STRUCTURE, PO_TREND_DOWN_STRUCTURE}：baseline=30, upside=20, downside=50
  若proxyState ∈ {PO_RANGE_LOW_STRUCTURE, PO_RANGE_RECOVERY_STRUCTURE, PO_UNKNOWN}：baseline=50, upside=25, downside=25
  若proxyState ∈ {PO_STALL_HIGH_STRUCTURE}：baseline=35, upside=25, downside=40
  若proxyState ∈ {PO_SHARP_DROP_STRUCTURE}：baseline=30, upside=20, downside=50

归一化与舍入（回应GMKG总架构§10.1不变量"必须存在归一化+舍入规则"）：
  1. 三项已按上表定义、和恒为100，理论上无需归一化；
  2. 若因stateConfidence修正（见下）导致和不为100，先做比例缩放：scaled_i = raw_i × 100 / sum(raw)；
  3. 四舍五入到整数；
  4. 舍入产生的余差（±1或±2）记入数值最大的一项，确保三项整数之和恒为100。

stateConfidence修正：以上baseline档位数值只在stateConfidence>=45时原样使用；stateConfidence<45时，三项一律向{baseline:45,upside:27,downside:28}方向线性插值（置信度越低，权重越趋近于三分接近均分但baseline仍略高，因为PRICE_ONLY_MODE下"看不清"本身就是一种默认倾向），插值系数 = stateConfidence/45。
```

**红线**：`scenarioWeights`是**规则型情景权重**，不是概率；`calibratedProbabilities`是校准概率的**唯一合法载体**（GMKG总架构§10.1红线4），V1.4当前恒为`null`。

### 7.5 `triggerConditions`/`invalidationConditions`

`triggerConditions`：模板化生成，如"24H目标窗口内，若15分钟已收盘价格突破`upsideScenario.priceZone`下沿，视为upside情景触发确认"。
`invalidationConditions`：如"若24H目标窗口内已收盘价格跌破`downsideScenario.priceZone`上沿，视为baseline/upside情景证据减弱"。均为模板文本，不需要额外数据源。

---

## 8. `ForecastSnapshot` 不可变性、去重与存储（V1.4具体规则）

### 8.1 `predictionId` 生成规则

```
predictionId = `GMKG-${instrument}-${horizon}-${referenceBarRef.closeTime}-${algorithmVersion}`
  例：GMKG-ETH-24h-1784306699999-v1.4-gmkg-loop-draft-1
```

### 8.2 去重键（红线：相同K线、相同instrument、相同horizon、相同algorithmVersion不得重复生成）

去重键 = `predictionId`本身（因为其构成已经唯一覆盖"相同referenceBar+相同instrument+相同horizon+相同algorithmVersion"）。写入前必须先查询是否已存在同`predictionId`的记录，存在则拒绝新建（返回已有记录，不覆盖，不追加重复项）。

### 8.3 `schemaVersion`、迁移与存储保留策略（P0-5，CEO已冻结裁决，取代draft-1"约1500条优先淘汰已完成旧快照"方案）

**背景**：draft-1曾设计"存储超过约1500条时优先淘汰已完成回填、时间最早的`ForecastSnapshot`"这一自动淘汰机制。CEO本轮裁决**撤销**此设计——`ForecastSnapshot`/`ForecastOutcomeEvent`/`ProxyTransitionRecord`/`ErrorAttribution`是**验证审计证据**，不是可随意轮转的缓存数据，不能为了腾出存储空间而静默销毁历史验证链路的一部分。

`ForecastSnapshot`存储对象增加顶层`schemaVersion: 'v1.4-forecastsnapshot-1'`字段（不在GMKG总架构接口定义内，是存储层元数据，供未来字段增删时的迁移判据，做法比照`V1_2_FORECAST_SPEC.md`已确立的`ForecastLogEntry.schemaVersion`模式）。`ForecastOutcomeEvent`存储对象同样增加`schemaVersion: 'v1.4-outcomeevent-1'`。

**冻结规则（红线）**：

1. **不得自动删除任何已经进入验证链路的历史记录**——`ForecastSnapshot`/`ForecastOutcomeEvent`/`ProxyTransitionRecord`/`ErrorAttribution`一旦写入，只能通过用户主动、明确的操作删除（如显式的"清空历史"二次确认，且该操作本身超出V1.4本轮范围，本文档不定义此类操作），**不存在**任何"容量超限自动淘汰"的代码路径；
2. **不得出现孤儿数据**——不得出现"存在`ForecastOutcomeEvent`但对应`predictionId`的`ForecastSnapshot`已被删除"，也不得出现"`ForecastSnapshot`本应被回填但因存储策略被意外整体移除"这类不完整验证链路的情形；
3. **写入必须是事务式/原子式语义**——单次写入操作（无论是新增`ForecastSnapshot`还是追加`ForecastOutcomeEvent`/`ProxyTransitionRecord`/`ErrorAttribution`）**要么全部成功，要么全部不写**，禁止出现"这条记录写了一半""关联的几张表只有部分更新成功"的部分写入状态；
4. **遇到`QuotaExceededError`或容量预警时**：
   - **保留全部已有数据**，不得为腾出空间而删除任何既有记录；
   - 设置顶层状态 `storageHealth = 'STORAGE_BLOCKED'`；
   - **停止创建新的`ForecastSnapshot`**（新的24H/72H预测生成请求直接返回阻塞结果，不尝试写入、不静默丢弃请求本身，需明确告知"存储已满"这一原因）；
   - UI**必须**明确提示用户"存储空间已满，请先导出JSON备份"（具体文案由`V1_4_CODEX_IMPLEMENTATION_TASK.md`/UI实现阶段定稿，语义不得偏离"先备份、不得清空"）；
   - **不得**通过删除旧证据来让系统"继续正常运行"——`storageHealth='STORAGE_BLOCKED'`是一个需要用户干预（导出+可能的主动清理）才能解除的状态，不是系统自动恢复的状态；
5. **JSON导出必须包含可以恢复完整验证链路的全部相关对象**——导出内容至少覆盖`ForecastSnapshot`/`ForecastOutcomeEvent`/`ProxyTransitionRecord`/`ErrorAttribution`四类记录的全集，导出文件本身即是"验证链路的完整快照"，具备离线恢复能力；
6. **V1.4明确定位为短期本地原型**——当前`localStorage`存储方案的容量限制是**已知且被接受**的短期局限，长期历史存储能力（不受浏览器`localStorage`容量约束）**推迟到**未来版本的`IndexedDB`本地存储或GMKG总架构§16.3定义的服务器架构，V1.4阶段不因为"localStorage太小"就违反§8.3第1-4条红线去做妥协；
7. 迁移函数（`schemaVersion`不匹配时的字段补齐）与损坏数据默认拒绝的具体实现规则见`V1_4_CODEX_IMPLEMENTATION_TASK.md`（本文档只声明"必须有""必须遵守以上红线"，不重复定义"怎么写代码"）。

**红线（重申）**：损坏数据默认**拒绝**写入/读取（不静默容忍脏数据）；**不得用结果覆盖原始预测**（GMKG总架构§10.1核心红线的重申）；**不得静默删除任何验证审计证据**（本节核心新增红线，取代draft-1的自动淘汰设计）。

### 8.4 `dataVintageRefs` 具体填充

V1.4阶段每条`ForecastSnapshot`固定引用6条`DataVintageRef`（ETH+BTC × 15m/1h/4h各一条已收盘K线），字段值：

```
fieldId = `${symbol}_${timeframe}_kline`
observationPeriod = 该K线的[openTime, closeTime]区间
publishedAt = closeTime（K线收盘即视为"发布"，无独立发布延迟）
availableAt = closeTime（Binance已收盘K线即时可查，无已知固定延迟；若采集器实测发现延迟，须记录实测值而非假设0）
firstAvailableAt = 首次被本系统采集到该K线时的时间戳
fetchedAt = 本次实际拉取时间
revisionNumber = 0（已收盘现货K线不存在修订机制）
vintageId = `${symbol}-${timeframe}-${closeTime}-rev0`
sourceId = 'binance-spot-rest'
sourceRef = 'binance-spot-klines'（唯一权威采集所有者标识，供未来接入其他数据源时的§6.4数据所有权表复用）
```

### 8.4a `KlineWindowRef`：完整输入窗口审计引用（红线，P1-3新增，取代"每symbol/timeframe只保存一条DataVintageRef"的不足）

**背景**：`DataVintageRef`（§8.4）只对每个`symbol`/`timeframe`记录**一根**已收盘K线的版本信息，无法证明EMA/ATR/Swing等衍生特征实际使用了**哪一段**历史K线序列——这些特征通常需要回看20/50根甚至更多历史K线（如`recentHigh50`/`swingHighs`），仅凭单根K线的`vintageId`不足以支撑"未来复现"或"审计追溯"。CEO本轮冻结新增`KlineWindowRef`结构，专门解决"输入窗口"的可审计性问题：

```ts
interface KlineWindowRef {
  symbol: 'BTCUSDT' | 'ETHUSDT';
  timeframe: '15m' | '1h' | '4h';
  firstOpenTime: number;             // 窗口内第一根（最早）K线的openTime
  lastCloseTime: number;              // 窗口内最后一根（最新，即referenceBar对应周期那根）K线的closeTime
  closedBarCount: number;             // 窗口内已收盘K线总数
  firstBarKey: string;                // 窗口内第一根K线的barKey（见GMKG总架构§10.1 BarRef.barKey格式）
  lastBarKey: string;                 // 窗口内最后一根K线的barKey
  contentHash: string;                // 覆盖窗口内全部K线（按序）实际参与特征计算的内容哈希，见下方规则
  source: 'BINANCE_SPOT';
  fetchedAt: number;                  // 本次实际拉取/组装该窗口的时间
}
```

**冻结规则（红线）**：

1. 每条`ForecastSnapshot`固定包含**六个**`KlineWindowRef`（`ETH`+`BTC` × `15m`/`1h`/`4h`，字段名建议`klineWindowRefs: KlineWindowRef[]`，长度恒为6）；
2. `contentHash`**必须**覆盖实际参与特征计算的、按时间顺序排列的K线内容（至少含每根K线的`openTime`/`closeTime`/`open`/`high`/`low`/`close`/`volume`），不得只对"窗口边界"（首尾各一根）计算哈希而假装覆盖了中间内容；
3. **必须只包含已收盘K线**——窗口构造时若混入未收盘K线（如实时价格所在的进行中K线），视为违反本节红线，`KlineWindowRef`不得包含它；
4. `ForecastSnapshot`**继续保留**`featureValuesUsed`（实际特征数值）与`featureEngineVersion`（§6输出字段表已定义），`KlineWindowRef`是**新增的补充审计层**，回答"这些特征数值是从哪一段原始K线序列算出来的"，不替代`featureValuesUsed`（后者是"算出来的结果"，前者是"算这个结果用的原始输入范围及其内容指纹"），也不替代`referenceBarRef`/`targetBarRef`（后两者是24H/72H路径定位的定盘K线引用，`KlineWindowRef`是特征计算的输入窗口引用，二者服务于不同目的，不得互相替代）；
5. **确定性要求**：相同的输入窗口（同一段K线序列）必须产生相同的`contentHash`；窗口内**任意**一根参与计算的K线内容发生变化（无论是新增、缺失还是数值修订），`contentHash`必须相应改变——这是`contentHash`作为审计指纹的存在意义，若无法保证这一点则不得声称已实现`KlineWindowRef`。

### 8.5 `featureValuesUsed`/`contentHash`

`featureValuesUsed`固定包含：`e4`/`e1`的§4.1输入特征清单全部字段的实际数值快照（不是引用）、`volatilityUnit`计算所用的`e4.atr14`值（见§7.1，取代draft-1"基准ATR"的模糊表述——本轮起`directionThreshold`公式基准明确为4小时ATR，不是15分钟ATR）、`referencePrice`。`ForecastSnapshot.contentHash`（快照级，区别于§8.4a`KlineWindowRef.contentHash`——窗口级）= 对`featureValuesUsed`+`algorithmVersion`+`weightVersion`+`datasetVersion`四者JSON序列化后取SHA-256（具体哈希算法由`V1_4_CODEX_IMPLEMENTATION_TASK.md`确定实现方式，本文档只冻结"用于计算hash的输入集合"）。

---

## 9. 存储隔离（红线，`PROXY_STATS`与`FULL_STATE_STATS`永久隔离的具体落地）

V1.4阶段所有`ProxyTransitionRecord`写入独立存储键（见`V1_4_CODEX_IMPLEMENTATION_TASK.md`键名规划），**不与**未来`FormalTransitionRecord`共用同一张表/同一个键；即使当前`FormalTransitionRecord`没有任何实例，存储层也要预留独立的空间/键位，防止未来直接往同一张表混写导致历史数据无法追溯分组。

---

## 10. 路径完整性（引用 GMKG总架构 §10.5，本节确认V1.4原样适用）

V1.4 `ForecastOutcomeEvent`回填时，`pathDataComplete`九项不变量、`endpointDataComplete`/`pathDataComplete`独立判定、`referenceBar`不计入目标路径等规则，**完全沿用** GMKG总架构 §10.5.0/§10.5.1/§10.5.2，本文档不重新定义、不放宽、不收紧。V1.4实现时的具体"回补机制"（如遇到`missingBarRefs`如何重试）由`V1_4_CODEX_IMPLEMENTATION_TASK.md`定义。

---

## 11. 方向与区间验证——预测正确性与模拟行动价值的边界（红线）

**必须明确区分（不同验证目标，不得混淆统计）**：

1. **方向正确**（`directionCorrect=true`）——只说明`actualDirection===expectedDirection`，是对**预测本身**的评价；
2. **可交易/可执行**——是`ActionPermission`（见§12）层面的判断，V1.4阶段`mode`恒为`DISPLAY_ONLY`/`AUDIT_ONLY`，不产生任何真实的可执行结论；
3. **模拟交易盈利**——是V1.3/V1.3.1既有模拟账户体系（`v1_3-paper-trading-core.js`）的统计范畴，其数据来源是"15分钟信号触发后如果照做"，与本文档24H/72H预测的验证目标完全不同（GMKG总架构§2红线3已确立此边界，本文档重申）。

**红线**：三者是**同一条大验证链路上的不同环节**，但**必须分别统计、分别存表**，不得因为都叫"验证"就合并成一张笼统的"准确率"报表。未来（V1.4之后）如需分析"预测正确但模拟亏损""预测错误但模拟盈利"这类交叉案例，必须通过各自独立记录的`predictionId`/`signalId`/时间戳做**关联查询**，不得在源头就把两套统计糅合。V1.4阶段**不实现**这类交叉分析（数据量不足，属于未来工作）。

---

## 12. `ActionPermission` 在 V1.4 的应用（引用 GMKG总架构 §11.4/§12，本节确认V1.4具体填值）

### 12.1 字段填值规则

| 字段 | V1.4取值规则 |
|---|---|
| `readinessLevel` | 由§4 `stateConfidence`与§7情景权重集中度共同决定：`stateConfidence>=45`且最高情景权重`>=45`时为`'PREPARE'`；`stateConfidence>=55`且最高情景权重`>=55`时为`'ALLOW_TEST'`；否则`'OBSERVE'`。**V1.4阶段`readinessLevel`永远不会达到`'ALLOW_EXECUTION'`**（见`readinessCeiling`规则） |
| `readinessCeiling` | 恒为`'ALLOW_TEST'`（V1.4未完成历史校准，见`V1_4_HISTORICAL_VALIDATION_SPEC.md`，`restrictionReasons`固定包含"24H/72H时间尺度尚未完成历史校准"） |
| `gateStatus` | 恒为`'WAIT'`（V1.4 24H/72H预测不接入任何账户/风控判断，见§12.2红线，不产生`'OPEN'`；也不因数据异常单独产生`'BLOCKED'`，数据异常时直接走`INSUFFICIENT_DATA`分支不生成`ActionPermission`） |
| `blockingReasons` | 空数组（`gateStatus`恒为`WAIT`而非`BLOCKED`） |
| `restrictionReasons` | 固定包含校准未完成的说明 |
| `waitingForSignals` | 固定包含"等待15m/1h/4h既有V1.1决策核心给出当前触发确认" |
| `riskConditions` | 空数组（V1.4不读取任何账户状态，见§12.2） |
| `mode` | 恒为`'DISPLAY_ONLY'` |

### 12.2 红线（逐条对应GMKG总架构§12红线，V1.4实施层面重申）

- 不得单独创建`WATCHLIST`；不得单独创建`EXECUTABLE`；
- 不得调用`recordSignalIfEligible`/`evaluateShadowSignals`/`tickAutoEngine`/`buildTradeProposal`；
- 不得改变V1.3.1现有15分钟交易生命周期的任何行为；
- GMKG（V1.4的24H/72H预测）只提供背景展示，不能补发交易许可；
- `readinessLevel`/`readinessCeiling`只由§12.1定义的预测证据/数据质量/时间尺度/历史校准状态决定，**不读取任何账户余额、保证金、冷却期、回撤锁定状态**——V1.4的24H/72H`ActionPermission`生成函数在设计上不接受账户对象作为输入参数，从函数签名层面杜绝账户状态影响`readinessLevel`的可能性（比GMKG总架构§11.4的"红线约束"更进一步的工程落地方式，具体签名见`V1_4_CODEX_IMPLEMENTATION_TASK.md`）。

### 12.3 `fusionStateAtGeneration`/`fusionState` 取值（红线，CEO已冻结裁决，P0-1，取代draft-1的S0-S7标签借用方案）

**背景**：draft-1曾把`fusionState`映射为`'S2_BULL_EXPANSION'`/`'S0_ACCUMULATION'`/`'S4_DISTRIBUTION'`/`'S5_BEAR_EXPANSION'`/`'S6_CAPITULATION'`等**正式状态命名**，即使附有"仅作展示标签"的免责声明，仍构成"代理判断冒充正式状态"的实质风险——用户看到字面命名即可能望文生义。CEO本轮已裁决**彻底废除**这一借用方案，不留任何过渡态或折衷方案。

**冻结规则（红线，逐条不得违反）**：

1. V1.4只运行`PRICE_ONLY_MODE`（`INSUFFICIENT_DATA`时不产生本节任何字段，见§3.1）；
2. `TargetState.primaryState`恒为`'UNKNOWN'`（GMKG总架构§7.0a既有红线，本节重申）；
3. **`fusionState`恒为`'UNKNOWN'`**——不借用`S0_ACCUMULATION`...`S7_REPAIR_RANGE`中任何一个，也不使用`'CONFLICTED'`；
4. **`fusionStateAtGeneration`恒为`'UNKNOWN'`**（`ForecastSnapshot`快照字段，与上一条同步冻结）；
5. V1.4的24H/72H预测输出中，唯一携带方向倾向信息的字段是`proxyState`（`PriceOnlyStateId`，`PO_*`枚举）与`scenarioWeights`（规则型情景权重），`fusionState`/`primaryState`不承载任何方向信息；
6. **不得用`'CONFLICTED'`代替`'UNKNOWN'`**——`'CONFLICTED'`（GMKG总架构§9场景4）的语义是"广度眼/精度眼/单眼三方证据经融合中枢综合后发现互相矛盾"，这要求三方**都已真实运行**且产生了可比较的输出；V1.4广度眼根本未运行，不存在"三眼发生冲突"这一事实，用`'CONFLICTED'`描述"某只眼没开"是语义误用，必须用`'UNKNOWN'`（"未评估"）而非`'CONFLICTED'`（"评估后发现冲突"）；
7. **不得新增任何"伪正式状态"**——不得发明新的展示态枚举值试图变相恢复方向标签借用的效果（如"`S2_LIKE`""`BULL_STRUCTURE_TAG`"等），`fusionState`字段值空间在V1.4阶段实质上是单一常量`'UNKNOWN'`；
8. **不得修改`GMKG_DRAGONFLY_ARCHITECTURE.md`里的正式类型**——`FusionStateId`/`TargetStateId`/`FormalStateId`的类型定义本身不变，本节只冻结"V1.4阶段这些类型的字段在实践中恒取哪个值"，不改变类型的可能取值范围；
9. **UI必须展示固定文案**："**融合状态：未评估（广度眼未运行）**"——与`proxyState`/`operatingMode='PRICE_ONLY_MODE'`/`primaryState='UNKNOWN'`同一视觉区块展示，不得省略、不得改写措辞、不得降低视觉权重使其难以被注意到；
10. `ForecastSnapshot.fusionStateAtGeneration`/`ForecastResult.fusionState`/示例JSON/`V1_4_CODEX_IMPLEMENTATION_TASK.md`/`V1_4_ACCEPTANCE_TESTS.md`/`V1_4_ARCHITECTURE_REVIEW.md`必须同步体现本节规则，不得任何一处遗留旧的S0-S7映射表述（见本文档变更记录与`V1_4_ARCHITECTURE_REVIEW.md`本轮P0/P1关闭表）。

```ts
// V1.4阶段实际类型收窄（不修改GMKG总架构定义本身，只是V1.4运行时的实际取值范围）：
fusionState: 'UNKNOWN'            // FusionStateId类型不变，V1.4运行时恒取此值
fusionStateAtGeneration: 'UNKNOWN'
```

---

## 13. 与历史验证/误差归因的接口（指向性说明，具体规则见 `V1_4_HISTORICAL_VALIDATION_SPEC.md`）

V1.4的`ForecastSnapshot`/`ForecastOutcomeEvent`/`ErrorAttribution`记录，是`V1_4_HISTORICAL_VALIDATION_SPEC.md`定义的walk-forward流程的输入数据。本文档不重复定义该流程，只确保本文档产出的字段（尤其是`dataVintageRefs`/`generatedAt`/`dataCutoffTime`）满足该文档"`availableAt<=forecastCreatedAt`"防泄漏红线的输入要求。

---

## 14. 禁止事项清单（V1.4全文强制，汇总）

不得声称已接入§2.2列出的任何数据；不得在`PRICE_ONLY_MODE`下输出S0-S7正式状态或`FormalTransitionRecord`；不得使用暗示衍生品/链上/新闻数据的措辞；不得让`fusionState`/`fusionStateAtGeneration`借用S0-S7或`CONFLICTED`标签（§12.3红线，恒为`'UNKNOWN'`）；不得用未经服务器时间校正的本地`Date.now()`判定K线已收盘、不得用"本地时间减安全边际"作为替代方案（§3.0红线）；服务器时间不可用时不得猜测`referenceBar`或沿用旧预测时间，必须`DATA_BLOCKED`并fail closed；不得把价格剧烈波动直接归因为`exogenous_shock`（该值在V1.4恒为`NOT_EVALUABLE`，见`V1_4_HISTORICAL_VALIDATION_SPEC.md`§5.1/§5.2a）；不得让`calibratedProbabilities`在V1.4阶段非null；不得让`scenarioWeights`三项之和不为100或含非法数值；不得让`readinessLevel`超过`'ALLOW_TEST'`（`readinessCeiling`红线）；不得让账户状态影响`readinessLevel`；不得创建`WATCHLIST`/`EXECUTABLE`或调用四个交易门控函数；不得用24H/72H结果覆盖既有15m/1h/4h预测日志；**不得静默删除任何已进入验证链路的历史记录**（`ForecastSnapshot`/`ForecastOutcomeEvent`/`ProxyTransitionRecord`/`ErrorAttribution`，§8.3红线，取代此前"淘汰已完成旧快照"的表述）；不得允许部分写入或产生孤儿数据；存储超限时不得继续删除数据维持运行，必须`storageHealth='STORAGE_BLOCKED'`并停止生成新预测；不得用结果覆盖`ForecastSnapshot`原始字段；不得在数据不完整时对路径类指标填0或近似值；不得连接真实交易账户、读取API密钥、发送真实订单。

---

## 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.4-spec-draft-1 | 2026-07-18 | 初稿：基于`GMKG_DRAGONFLY_ARCHITECTURE.md`（main@a3d7aea）确立V1.4核心规范，冻结PO_*九状态具体判定规则、24H/72H时间尺度与Binance边界实测结论、directionThreshold口径、scenarioWeights归一化算法、predictionId生成与去重、ActionPermission填值规则、与既有15m/1h/4h展示关系 |
| v1.4-spec-draft-2 | 2026-07-18 | CEO本轮冻结裁决：①§12.3彻底删除fusionState借用S0-S7标签的设计，恒为`'UNKNOWN'`，UI固定展示"融合状态：未评估"（P0-1）；②新增§3.0/§3.0.1服务器时间前置门禁，撤销"本地时间减安全边际"备选方案，服务器时间不可用时`DATA_BLOCKED`并fail closed（P0-2）；③重写§8.3存储保留策略，撤销"1500条优先淘汰已完成快照"设计，改为不删除历史+`storageHealth='STORAGE_BLOCKED'`+原子写入（P0-5）；④§7.1 `directionThreshold`公式改为4H已收盘ATR+平方根时间缩放，取代15分钟ATR固定倍数方案（P1-2）；⑤新增§8.4a `KlineWindowRef`六窗口审计引用结构（P1-3）；⑥核对`v1-core.js`源码后订正§4.1/§4.2三处`firstResistance`/`firstSupport`误用`.lower/.upper`的字段形状错误，改用`buildSRZones(e4)`结果；同步更新§6输出字段表、§14禁止事项清单 |
