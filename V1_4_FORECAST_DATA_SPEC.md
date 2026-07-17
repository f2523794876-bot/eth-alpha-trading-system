# V1_4_FORECAST_DATA_SPEC.md — V1.4 预测数据与历史验证基础 核心规范

正式名称：**V1.4 Forecast Data & Historical Validation Foundation — GMKG Minimum Verifiable Loop**
中文名称：**V1.4 预测数据与历史验证基础——GMKG 最小可验证闭环**

版本：v1.4-spec-draft-1
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

### 3.1 `INSUFFICIENT_DATA` 触发条件（V1.4具体冻结）

当且仅当以下任一条件成立时，`operatingMode='INSUFFICIENT_DATA'`（`primaryState='UNKNOWN'`，`proxyState=null`，只输出`candidateStates`）：

1. ETH或BTC任一周期（15m/1h/4h）K线数组长度不足以计算ATR14（沿用`v1-core.js` `assessDataQuality().sufficientForATR14`既有判定，不重新发明）；
2. `assessOverallHealth()`（`v1-core.js`既有函数）返回`'invalid'`；
3. 用于本次24H/72H预测的`referenceBarRef`对应K线本身缺失或未收盘。

否则（即A组数据完整可用）进入`PRICE_ONLY_MODE`，即使`assessOverallHealth()`返回`'delayed'`（数据延迟但结构未失效）也仍归入`PRICE_ONLY_MODE`，只是`featureCompleteness.criticalFeatureCompleteness`相应下调（见§5.4）。

---

## 4. `PriceOnlyStateId` 代理状态规则（本文档唯一权威定义，红线：具体数值已冻结，不留给Codex自行决定）

### 4.0 设计原则

- 全部9个代理状态**只使用A组特征**（现货价格、EMA、ATR、Swing、动态支撑压力、成交量比、BTC联动、假突破分级），**不引入**任何B-G组特征；
- 判定主要基于 **4小时周期**特征（`e4`，对应现有`analyzeKlines`/`classifyHtfState`输出），因为24H/72H的推演尺度与4小时结构的相关性高于15分钟噪音；1小时周期（`e1`）用于交叉确认；
- 阈值类型延续 GMKG总架构 §7.1 的"相对阈值为主、极值判定用绝对阈值"原则，本节全部使用**相对阈值**（相对自身ATR/成交量基线），因为V1.4阶段没有历史分位数统计基础，不可能冻结有意义的"绝对历史极值"；
- 每个状态的默认阈值标注为版本 `poThresholdVersion = 'v1.4-po-threshold-1'`——这是**初始默认值**，不是"永久正确值"，`V1_4_HISTORICAL_VALIDATION_SPEC.md` 的 walk-forward/消融流程负责未来重新标定；阈值修改必须递增此版本号（呼应`V1_2_FORECAST_SPEC.md`已确立的版本号红线，不重新发明）。

### 4.1 输入特征清单（全部已由 `v1-core.js`/`v1_2-forecast-core.js` 计算，本节只做只读消费，不新增采集）

`e4.price`、`e4.ema5/10/20`、`e4.atr14`、`e4.recentHigh20/recentLow20`、`e4.firstResistance/firstSupport`（含`.lower/.upper`区间）、`e4.isBreakout/isBreakdown`、`e4.breakoutBarsCount/breakdownBarsCount`、`e4.volumeRatio`、`e4.trend`（`'up'|'down'|'flat'`）、`e4.risingLows/fallingHighs`、`e1`（同名字段，1小时周期，交叉确认用）、`btcAlignment(direction, b4)`（复用`v1-core.js`既有函数）、`decision.dataHealth`。

### 4.2 九个代理状态定义

**`PO_RANGE_LOW_STRUCTURE`（区间低位结构代理，对应S0积累的价格结构侧证据）**
- 必要条件：`e4.price` 落入 `[e4.firstSupport.lower − 0.3×ATR14, e4.firstSupport.upper + 0.3×ATR14]` 区间内，**或** `e4.price <= e4.recentLow20 × 1.03`；且 `e4.trend ∈ {'flat','down'}`（非强势上行）。
- 加分条件：`e4.risingLows === true`（低点抬高）；`e4.volumeRatio` 在 `[0.8, 1.2]`（温和，非放量非缩量）。
- 否决条件：`e4.isBreakdown === true` 且 `e4.breakdownBarsCount >= 2`（已确认跌破，不满足"低位企稳"叙事）；`decision.dataHealth !== 'normal'`。
- 状态保持条件：连续满足必要条件的4小时K线数 `>= 2`（即8小时未破位）。
- 状态退出条件：`e4.price` 突破 `e4.firstResistance.upper + 0.3×ATR14`（转入`PO_BREAKOUT_UP_STRUCTURE`）或跌破 `e4.firstSupport.lower − 0.5×ATR14` 且已收盘确认（转入`PO_BREAKDOWN_STRUCTURE`）。
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
- 状态退出：跌破`e4.firstSupport.lower`（转入`PO_BREAKDOWN_STRUCTURE`）或重新创新高（退回`PO_TREND_UP_STRUCTURE`）。
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
| `featureValuesUsed` | 见§8.5 |
| `featureEngineVersion` | `'v1.4-po-feature-engine-1'` |
| `contentHash` | 见§8.5 |

### 7. 方向、幅度与情景生成（V1.4具体冻结）

### 7.1 `directionThreshold` 口径（红线，已冻结，不留白）

```
基准ATR = e15（ETH 15分钟analyzeKlines输出）的atr14，取referenceBar对应快照的值
directionThreshold(24h) = clamp( 2.0 × 基准ATR / referencePrice , 0.008 , 0.05 )   // 0.8%–5%
directionThreshold(72h) = clamp( 3.5 × 基准ATR / referencePrice , 0.015 , 0.08 )   // 1.5%–8%
```

**口径类型**：相对`referencePrice`的百分比，但由ATR驱动动态调整并做上下限clamp（避免极端低波动期阈值过小导致噪音全部误判为UP/DOWN，也避免极端高波动期阈值过大导致RANGE占比失真）。`directionThresholdVersion = 'v1.4-direction-threshold-1'`——版本冻结规则同GMKG总架构§10.3：口径/数值只能随算法版本一起变化，同版本内不得动态调整。

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

### 8.3 `schemaVersion` 与迁移

`ForecastSnapshot`存储对象增加顶层`schemaVersion: 'v1.4-forecastsnapshot-1'`字段（不在GMKG总架构接口定义内，是存储层元数据，供未来字段增删时的迁移判据，做法比照`V1_2_FORECAST_SPEC.md`已确立的`ForecastLogEntry.schemaVersion`模式）。`ForecastOutcomeEvent`存储对象同样增加`schemaVersion: 'v1.4-outcomeevent-1'`。迁移函数/损坏数据默认拒绝/最大存储量/超限处理/JSON导出的具体实现规则见`V1_4_CODEX_IMPLEMENTATION_TASK.md`（本文档只声明"必须有"，不重复定义"怎么写代码"）。

**红线**：损坏数据默认**拒绝**写入/读取（不静默容忍脏数据）；**不得静默删除未验证的预测**（`ForecastOutcomeEvent`尚未回填的`ForecastSnapshot`，超出存储上限时必须先淘汰**已完成回填**、时间最早的记录，不得优先淘汰未回填记录）；**不得用结果覆盖原始预测**（GMKG总架构§10.1核心红线的重申）。

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

### 8.5 `featureValuesUsed`/`contentHash`

`featureValuesUsed`固定包含：`e4`/`e1`的§4.1输入特征清单全部字段的实际数值快照（不是引用）、`directionThreshold`计算所用的`基准ATR`值、`referencePrice`。`contentHash` = 对`featureValuesUsed`+`algorithmVersion`+`weightVersion`+`datasetVersion`四者JSON序列化后取SHA-256（具体哈希算法由`V1_4_CODEX_IMPLEMENTATION_TASK.md`确定实现方式，本文档只冻结"用于计算hash的输入集合"）。

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

### 12.3 `fusionStateAtGeneration`/`fusionState` 取值（V1.4具体规则）

V1.4阶段广度眼未真实运行，无法产生真正的融合裁决（GMKG总架构§9冲突裁决场景1-4均要求`environmentPermission`等广度眼输出作为输入）。V1.4 `fusionState`**直接等于**`proxyState`对应的方向倾向映射（不产生`'CONFLICTED'`）：

```
fusionState = 
  proxyState ∈ {PO_BREAKOUT_UP_STRUCTURE, PO_TREND_UP_STRUCTURE} → 'S2_BULL_EXPANSION'（仅作展示标签借用，不代表FULL_STATE_MODE正式判定，见下方红线）
  proxyState ∈ {PO_BREAKDOWN_STRUCTURE, PO_TREND_DOWN_STRUCTURE} → 'S5_BEAR_EXPANSION'
  proxyState ∈ {PO_RANGE_LOW_STRUCTURE, PO_RANGE_RECOVERY_STRUCTURE, PO_UNKNOWN} → 'S0_ACCUMULATION'（占位，不代表正式积累判定）
  proxyState === PO_STALL_HIGH_STRUCTURE → 'S4_DISTRIBUTION'（占位）
  proxyState === PO_SHARP_DROP_STRUCTURE → 'S6_CAPITULATION'（占位）
```

**红线（必须在UI/日志中同时展示，防止误导）**：此处`fusionState`借用`FusionStateId`枚举值**仅作展示标签**，**必须**在同一UI区域/同一日志记录中**同时**展示`operatingMode='PRICE_ONLY_MODE'`与`targetState.primaryState='UNKNOWN'`，明确告知用户这是"基于价格结构代理推断的展示标签，不是GMKG总架构定义的正式八状态判定"。若`V1_4_ARCHITECTURE_REVIEW.md`审查认为这一借用方式仍有误导风险，应改为定义`fusionState = 'CONFLICTED'`恒定占位或专门的过渡展示值，具体裁决见该文档。

---

## 13. 与历史验证/误差归因的接口（指向性说明，具体规则见 `V1_4_HISTORICAL_VALIDATION_SPEC.md`）

V1.4的`ForecastSnapshot`/`ForecastOutcomeEvent`/`ErrorAttribution`记录，是`V1_4_HISTORICAL_VALIDATION_SPEC.md`定义的walk-forward流程的输入数据。本文档不重复定义该流程，只确保本文档产出的字段（尤其是`dataVintageRefs`/`generatedAt`/`dataCutoffTime`）满足该文档"`availableAt<=forecastCreatedAt`"防泄漏红线的输入要求。

---

## 14. 禁止事项清单（V1.4全文强制，汇总）

不得声称已接入§2.2列出的任何数据；不得在`PRICE_ONLY_MODE`下输出S0-S7正式状态或`FormalTransitionRecord`；不得使用暗示衍生品/链上/新闻数据的措辞；不得让`calibratedProbabilities`在V1.4阶段非null；不得让`scenarioWeights`三项之和不为100或含非法数值；不得让`readinessLevel`超过`'ALLOW_TEST'`（`readinessCeiling`红线）；不得让账户状态影响`readinessLevel`；不得创建`WATCHLIST`/`EXECUTABLE`或调用四个交易门控函数；不得用24H/72H结果覆盖既有15m/1h/4h预测日志；不得静默删除未回填的预测快照；不得用结果覆盖`ForecastSnapshot`原始字段；不得在数据不完整时对路径类指标填0或近似值；不得连接真实交易账户、读取API密钥、发送真实订单。

---

## 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.4-spec-draft-1 | 2026-07-18 | 初稿：基于`GMKG_DRAGONFLY_ARCHITECTURE.md`（main@a3d7aea）确立V1.4核心规范，冻结PO_*九状态具体判定规则、24H/72H时间尺度与Binance边界实测结论、directionThreshold口径、scenarioWeights归一化算法、predictionId生成与去重、ActionPermission填值规则、与既有15m/1h/4h展示关系 |
