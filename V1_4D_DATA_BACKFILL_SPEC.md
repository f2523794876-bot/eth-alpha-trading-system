# V1_4D_DATA_BACKFILL_SPEC.md — V1.4D 历史数据回填规范（冻结草案）

版本：v1.4d-backfill-draft-4（第三阶段定向修订：随dataset_version格式改为完整SHA-256同步刷新交叉引用，见变更记录）
基线：`main@eb89c49f0957617c453ea2c0d149afb55e97dad0`（POST-DEPLOY HEALTHY）
角色：本文档是**历史K线回填范围、协议、数据可得性语义**的唯一权威文档。不涉及回放执行逻辑（见`V1_4D_HISTORICAL_REPLAY_SPEC.md`）。

**红线（贯穿全文）**：本文档只回填**正式历史市场数据**（`market_bars`，`formal`语义），不产出任何`ForecastSnapshot`/`ForecastOutcomeEvent`，不触碰生产`forecast_*`四张表，不获取/续租/释放任何生产lease。本轮**只制定规范，不执行回填**。

---

## 0. 已确认基准（引用V1.4D第一阶段审计，只读复核，不重新测量）

| 项目 | 数值 | 来源 |
|---|---|---|
| 15m formal K线现有覆盖 | 约7天（2026-07-18 13:00 ~ 2026-07-25 12:59:59.999 CST） | 第一阶段DB审计 |
| 1h formal K线现有覆盖 | 约22.6天 | 同上 |
| 4h formal K线现有覆盖 | 约85天 | 同上 |
| 24h `effectiveSampleCount`冻结门槛 | ≥30（`server/src/validation/walk-forward.js` `MIN_SAMPLE_THRESHOLDS`） | 已冻结代码常量 |
| 72h `effectiveSampleCount`冻结门槛 | ≥10 | 同上 |
| 现有15m数据下的实际effectiveSampleCount | 24h≈6~7，72h≈2~3 | 第一阶段精确复算（区间调度算法逐点模拟） |

---

## 1. 冻结历史数据回填范围

**版本说明（v1.4d-backfill-draft-2 修订）**：本节在第三阶段独立复审中被**整体重算并修正**。draft-1曾以"120天"为推荐窗口，其"三段切分后每段独立达标"的证明**未考虑跨切分边界的样本归属处理（purge）**，补上这一环节后，120天窗口的validation/test两段实际**跌破**门槛（见1.2节精确证明）。**本节结论从120天上调为180天，draft-1的120天结论作废，不得再引用。**

**事实标注规则（贯穿本文档，P1-3修订新增）**：本文档全文对每一条关键论断标注来源类型——**`OBSERVED`**（从生产代码/数据库/接口实测得到，可复查）、**`FROZEN_POLICY`**（V1.4D本轮人为冻结的研究规则，不是测得的事实，是设计选择）、**`ASSUMPTION`**（尚未被实测验证的假设，需在实施/回填后回头核实）。三者不得混淆表述。

### 1.0 冻结默认切分比例（`FROZEN_POLICY`，本轮新增）

draft-1曾把train/validation/test切分比例描述为"不冻结，可由调用方指定"，导致"用文档冻结的切分比例证明窗口是否达标"这一要求无所依附。**本轮冻结**：

> **默认切分比例 = 50% / 25% / 25%（train / validation / test，按`--from`~`--to`总日历天数比例计算，四舍五入到整数天）。**

这是**`FROZEN_POLICY`**，不是测得的事实。CLI仍允许调用方通过`--train-end`/`--validation-end`显式覆盖为任意其他边界（见`V1_4D_HISTORICAL_REPLAY_SPEC.md`§4.1），但：
1. 本文档下方全部窗口证明**均以50/25/25为基准**计算，不得在证明时假设"调用方可以选一个更有利的比例来凑达标"；
2. 若调用方既不传`--train-end`也不传`--validation-end`但要求三段切分，CLI必须按此冻结比例自动计算切分点（具体CLI参数形式见`V1_4D_HISTORICAL_REPLAY_SPEC.md`§4.1新增`--split`参数）。

### 1.1 边界样本处理：purge（冻结，P0级时间/方法论治理，本轮新增）

**问题**：`server/src/validation/walk-forward.js`的`splitTimeOrdered`按**`targetEndTime`单一维度**把样本分配到train/validation/test三桶。一条样本若其`targetStartTime`（生成/referenceBar时刻）落在train区间内，但其`targetEndTime`（=`targetStartTime`+24h或+72h）跨过了`trainEnd`边界、落入validation区间，该样本会被**完整计入validation桶**，尽管它是用train时代已知的信息生成的。

**这是否构成经典机器学习意义上的"测试集污染训练"？**——**不是**，因为V1.4D范围内**没有任何参数拟合/自动调参闭环**（`V1_4_HISTORICAL_VALIDATION_SPEC.md`§7.2/本规范CEO裁决第10条），PO规则与阈值是人工冻结的常量，不存在"用validation数据反过来影响train阶段拟合出的参数"这条经典泄漏路径。**但这仍然是一个真实的方法论问题**：该样本的统计结果（方向是否正确、MFE/MAE等）会被计入"validation区间的表现"，但它所依赖的价格结构判断实际发生在train区间，若train与validation恰好处于不同市场regime，这条跨界样本的表现既不能干净地代表train、也不能干净地代表validation，会模糊"不同时间段表现是否稳定"这一三段切分的**本来目的**（`STRATEGY_SPEC.md`§18.3）。

**冻结处理规则（purge）**：

> 任一已选中（`computeEffectiveSampleCount`去重后）的样本，若其`[targetStartTime, targetEndTime)`区间**跨越**`trainEnd`或`validationEnd`任一边界（即`targetStartTime < boundary <= targetEndTime`），**从该次三段切分统计（`report_scope IN ('TRAIN','VALIDATION','TEST')`）中剔除**，不计入任何一段；但**保留**在`report_scope='ALL'`（不分段）的整体报告中。剔除数量必须显式披露为`purgedStraddlingCount`（新增字段，落于`validation_reports`，见`V1_4D_HISTORICAL_REPLAY_SPEC.md`§2.7/§五修订）。

**是否需要embargo（时间缓冲区）？**——**不需要**。经典embargo用于防止"训练→测试→用测试结果附近的数据重新训练"这一**滚动再训练循环**中的信息回流；V1.4D**没有任何重新训练/重新调参循环**（CEO裁决第10条），三段切分只是描述性地展示同一套冻结规则在不同时间段的表现，不存在"validation结果影响下一轮train"这个回路，因此embargo没有对应的风险场景需要防护。**若未来V1.4D范围扩大到包含参数寻优（本轮及`V1_4_HISTORICAL_VALIDATION_SPEC.md`§7.2均明确禁止），必须重新引入embargo设计，不得假设purge足够**。

**管道顺序（冻结，避免实现阶段自行决定产生不同结果）**：
1. 在`--from`~`--to`整个请求范围内，按`instrument+horizon`分组，对`eligible`样本**全局**运行`computeEffectiveSampleCount`（贪心区间调度去重叠），得到一个跨越整个范围、内部互不重叠的样本集合；
2. 对该全局去重结果，按上述purge规则剔除跨边界样本；
3. 将剩余样本按`targetEndTime`分配到train/validation/test。

**红线**：**不得**先按边界把样本分成三桶、再分别在每个桶内独立跑`computeEffectiveSampleCount`——那样会在边界附近产生"桶内贪心重新起算"的结果，与"整个`--from`~`--to`范围本应是一串连续不重叠预测"的物理事实不符，且不同实现顺序会产生不同数字，破坏可复现性。

### 1.2 用purge重新证明窗口达标情况（取代draft-1未考虑purge的证明）

用生产同款`computeAlignedReferenceCloseTime`边界算法 + `computeEffectiveSampleCount`贪心区间调度算法 + 上述purge规则，对不同天数`D`（50/25/25切分）做逐点精确模拟（`OBSERVED`来自算法确定性复算，非估算）：

| D（天） | trainEnd(天) | validationEnd(天) | 24h train/val/test | 72h train/val/test | 24h val&test均≥30？ | 72h val&test均≥10？ |
|---|---|---|---|---|---|---|
| 31（draft-1旧"最小窗口"，仅总量层面，未做三段验证） | — | — | 总量30（未分段） | 总量10（未分段） | 不适用 | 不适用 |
| 120（draft-1旧"推荐窗口"，**purge后失败**） | 60 | 90 | 59 / 29 / 29 | 19 / 9 / 9 | **否**（29<30） | **否**（9<10） |
| **130（本轮：purge后严格最小窗口）** | 65 | 97 | 64 / 31 / 32 | 21 / **10** / **10** | 是（31,32≥30） | **是，但零缓冲**（恰好=10） |
| **180（本轮：新推荐窗口）★** | 90 | 135 | 89 / 44 / 44 | 29 / 14 / 14 | **是，有余量**（+47%） | **是，有余量**（+40%） |
| 365（长周期稳健性窗口，不变） | 182 | 273 | 181 / 90 / 91 | 60 / 29 / 30 | 是，余量更大 | 是，余量更大 |

**关键发现（本轮复审核心结论）：120天在考虑purge后，validation与test两段的24h样本均降至29（<30门槛），72h降至9（<10门槛）——draft-1"120天每段独立达标"的结论是错误的，原因是draft-1的证明用全局去重后的样本直接按`targetEndTime`分桶，没有剔除跨边界样本，虚增了边界附近两段的计数（120天时该虚增恰好是让29变成30、9变成10的那"临门一脚"，非常接近真实边界，掩盖了问题）。**

### 1.3 逐段详细数学证明（180天推荐窗口，50/25/25冻结切分）

| 维度 | train段 | validation段 | test段 |
|---|---|---|---|
| 边界（天） | day 0 ~ day 90 | day 90 ~ day 135 | day 135 ~ day 180 |
| **每段自然日数** | 90天 | 45天 | 45天 |
| **每段15m K线数**（`天数×96`，`OBSERVED`算法推算） | 8,640根 | 4,320根 | 4,320根 |
| **4h历史预热损耗** | **0天（条件性）**——见下方说明 | 0天（无需，预热只发生在整个窗口最起点，不在段边界重复） | 0天 |
| **24h标签路径尾部损耗（purge，跨`trainEnd`边界）** | 1个候选样本因`targetEndTime`跨过`trainEnd`被purge，不计入train也不计入validation | （同一批purge，计入下一列"跨界剔除"统计，不重复扣两次） | — |
| **24h标签路径尾部损耗（purge，跨`validationEnd`边界）** | — | 1个候选样本因跨`validationEnd`被purge | （同上，不重复扣） |
| **72h标签路径尾部损耗（同上机制，跨两条边界各1个）** | 1个 | 1个（跨`validationEnd`） | — |
| **72h/24h测试尾部成熟度损耗**（仅test段末尾，因窗口本身在day180结束，无法再有完整未来路径） | — | — | 24h：6个候选被排除（未成熟）；72h：3个候选被排除 |
| **理论最大effectiveSampleCount（24h，purge后）** | **89** | **44** | **44** |
| **理论最大effectiveSampleCount（72h，purge后）** | **29** | **14** | **14** |
| 24h冻结门槛(30)是否达标 | 是（train不设强制门槛，但也充裕） | **是**（44≥30，+47%余量） | **是**（44≥30，+47%余量） |
| 72h冻结门槛(10)是否达标 | 是 | **是**（14≥10，+40%余量） | **是**（14≥10，+40%余量） |

**4h预热损耗为"条件性0天"的说明（`ASSUMPTION`，依赖§2.1的另一条冻结承诺）**：本表所有候选点计算**假设**1h/4h历史数据已按§2.1回填至比15m窗口起点（day 0）早至少4天——这是§2.1已冻结的回填协议承诺，本身尚未被实测验证（因为回填还未执行），故标注为`ASSUMPTION`。**若该4天缓冲实施时被遗漏，train段最早约4天（≈4/90≈4.4%）的24h候选点会因`ATR14_4H_INSUFFICIENT`被blocked**，这一风险已通过`V1_4D_ACCEPTANCE_TESTS.md`新增测试项防护（见R19，本轮新增）。

**关于"预测点采样节奏"**：24h horizon候选点按每4小时边界产生（`FROZEN_POLICY`，源自`V1_4_HISTORICAL_VALIDATION_SPEC.md`§1.1已冻结节奏），72h horizon候选点按每日UTC边界产生（同上）。这是生产代码`bar-path-locator.js rhythmBoundaryMs()`已实现的**同一套**节奏常量，回放严格复用，不重新定义。

**关于"三段边界处的预测标签是否允许跨段"**：**不允许**——见1.1节purge规则，跨界样本从三段统计中剔除，只保留在`report_scope='ALL'`整体视图。

**关于"是否存在purge/embargo"**：**存在purge（本轮新增冻结），不需要embargo**（1.1节已论证原因）。

**关于"validation和test结果是否可能通过跨边界未来路径污染前一阶段"**：**在purge规则生效后不会**——任何路径跨越边界的样本被剔除出分段统计，不会出现"train段的表现其实混入了validation时期价格走势"这种污染；`report_scope='ALL'`视图仍然完整保留全部样本供整体分析，只是不参与"分段比较"这一特定用途。

**关于"120天究竟是严格最小窗口、近似最小窗口，还是带余量的推荐窗口"**：**均不是**——120天在draft-1的错误证明下曾被误判为"每段独立达标的最小窗口"，**实际上purge后120天两段均不达标，是不合格窗口，本轮作废该结论**。真实情况：
- **130天**是purge规则下的**严格最小窗口**（每段恰好达标，72h的validation/test段零缓冲，等于门槛值10，不建议用于正式统计，仅可作为"打通链路"的下限参考）；
- **180天**是**带余量的推荐窗口**（本轮新推荐，见1.5节）；
- **365天**保留为长周期稳健性窗口。

### 1.4 三个可选窗口（修订版）

| 窗口 | 15m回填天数 | 15m K线数(理论) | 说明 |
|---|---|---|---|
| **最小可执行窗口（不建议用于正式统计）** | ~~31天~~ **130天**（purge规则下的严格最小值，本轮修订） | ≈12,480根 | 三段切分后每段恰好达标，72h的validation/test段零缓冲（=10），仅建议用于打通回填/回放链路的最小闭环验证，不建议作为正式统计结论来源 |
| **推荐验证窗口** | ~~120天~~ **180天**（约6个月，本轮修订，取代draft-1错误结论） | ≈17,280根 | 三段切分后每段均有约40~47%余量，见1.3节逐段证明 |
| **长周期稳健性窗口** | 365天（约1年，不变） | ≈35,040根 | 余量更大，更高概率覆盖多种市场环境，回填成本最高 |

### 1.5 唯一推荐窗口（修订）

# **推荐窗口：180天（约6个月）15m formal历史数据**

**依据**：
1. **在purge规则下三段切分后每一段独立达标，且有实质缓冲**（+40%~47%），而非120天draft-1那种"看似达标、purge后即跌破"的脆弱结果；
2. `effectiveSampleCount`是**理论最大值**（`OBSERVED`算法在假设数据完全无缺口、无质量否决前提下的确定性计算结果）——真实回填的Binance数据可能存在少量缺口或质量否决导致`FEATURE_RECORD_MISSING`/`ATR14_4H_INSUFFICIENT`等`blocked`情形，**实际effectiveSampleCount只会更低，不会更高**；130天窗口零缓冲，任何真实世界的样本损耗都可能使其重新跌破门槛，**这是拒绝130天作为推荐窗口的直接理由**，180天的余量正是为吸收这种真实世界损耗预留的安全边际；
3. **优先保证市场环境多样性，而非只满足数学最低门槛**——6个月比此前的4个月（120天）有更高概率跨越多个短周期市场阶段；但**这仍只是概率性期望，不是保证**（`ASSUMPTION`），本规范继续要求（见`V1_4D_ACCEPTANCE_TESTS.md`）在回填完成后运行独立的regime多样性核查，**不得仅凭"回填了180天"就假定已观察到多种市场环境**；
4. 365天样本量更充裕但回填成本显著更高，边际改善速度放缓，作为130/180天验证通过后的后续升级选项，不作为本轮强制要求；
5. 130天（新的严格最小值）不满足"有意义的三段验证需要缓冲"这一要求，不作为推荐窗口，仅保留作为"最小闭环打通"的参考下限。

### 1.6 PO_\*状态细分：明确不因窗口增大而自动缓解（P1-4修订，删除一切"回填会自然改善"的暗示）

**`OBSERVED`事实**：生产现有15条真实`forecast_snapshots`（第一阶段审计所见）100%为`PO_UNKNOWN`。

**`ASSUMPTION`（不得当作`OBSERVED`结论）**：无论窗口选择31天、130天、180天还是365天，**均无法预先判断**回填后的历史价格路径在`po-state-engine.js`现有阈值下会产生怎样的PO_\*状态分布。总样本数（180天窗口下24h约177个、72h约57个，见1.3节）增大**只意味着"如果非UNKNOWN状态确实出现，有更多机会被观测到"**，**不意味着非UNKNOWN状态的出现频率会因为窗口变长而提高**——如果ETH在整个180天（或365天）窗口内的价格结构相对于当前阈值持续呈现"无法判定为任何结构性状态"，`PO_UNKNOWN`占比可能在任何窗口大小下都接近100%，其余8个状态样本可能仍为0或个位数。**这不是回填规模问题，是阈值/市场行为本身的独立问题**，必须在回放完成后通过`V1_4D_HISTORICAL_REPLAY_SPEC.md`§六的诊断结构实际验证，**不得在回填之前假设"窗口越大PO分布越均匀"**。

回填/回放完成后，若某PO_\*状态样本量为0或极低，必须在`validation_reports.po_state_breakdown`中如实标注为**样本不足**（引用`MIN_SAMPLE_THRESHOLD_NOT_FROZEN`，见`V1_4D_HISTORICAL_REPLAY_SPEC.md`§五），**不得**因为"已经用了推荐窗口"就推定该状态"验证已完成"。四类独立候选诊断原因（市场确实无结构 / 阈值过严 / 输入字段缺失 / 状态引擎实现错误）保持独立并列，不预设权重或结论，见`V1_4D_HISTORICAL_REPLAY_SPEC.md`§六诊断结构。

---

## 2. 安全、幂等的 Backfill 协议（冻结）

### 2.1 数据来源与分页

- **来源**：Binance 现货公开 REST Klines 接口（`GET /api/v3/klines`），复用现有 `server/src/sources/binance.js`/`server/src/http/client.js` 的公开REST客户端与限速/重试基础设施，**不新增数据源**。
- **本轮必须回填的周期**：**15m**（用户已指定，是唯一约束`effectiveSampleCount`的瓶颈周期）。
- **是否同时补齐1h/4h历史深度**：**是，必须同步补齐，且深度不得浅于所选15m窗口起点再往前推≥4天（覆盖§1.4的4h预热窗口需求）**。理由：
  1. `computeFourHourAtr14`/`computeConsecutiveBreakoutBars`在15m窗口**起点当天**就需要往前追溯15~23根4h K线；若4h数据起点与15m窗口起点相同，窗口最早约4天的候选referenceBar会因`ATR14_4H_INSUFFICIENT`被blocked，实质上白白损失约4天的15m有效候选（对180天推荐窗口影响约2.2%，对130天严格最小窗口影响约3.1%，不可忽略，本轮已在1.3节标注为条件性`ASSUMPTION`并要求验收测试防护）；
  2. `po-state-engine.js`的`trend4h`/`trend1h`等输入依赖1h/4h`feature_records`，其计算同样需要1h/4h历史；
  3. 现有生产4h数据已有85天深度、1h已有22.6天深度——**若目标窗口(如180天)超过现有1h覆盖，1h也需要补齐到"目标窗口起点−4天"；4h同理，若目标窗口超过现有85天覆盖(180天/365天窗口均超过)才需要补齐4h**。
  - **结论**：目标窗口为180天（或130天/365天）时，15m/1h/4h三个周期均需回填至"窗口起点−4天"为止。

- **分页方式**：Binance klines接口单次最多返回1000根K线，按`startTime`/`endTime`分页拉取，每页固定`limit=1000`，按`open_time`升序分页前进（`startTime = 上一页最后一根bar的open_time + intervalMs`），直至覆盖到目标窗口终点或触达当前时间。

### 2.2 UTC时间边界

- 所有分页请求的`startTime`/`endTime`参数使用**UTC毫秒时间戳**（Binance API原生语义），与生产`bar-path-locator.js`的`computeAlignedReferenceCloseTime`保持**同一时间基准（epoch UTC）**，避免时区换算引入的边界错位。
- 回填窗口边界（如"120天"）以**当前UTC时间**为终点向前推算，不使用CST或其他本地时区做窗口计算（存储层`timestamptz`本身与时区无关，此处特指**窗口宽度计算脚本本身**必须用UTC口径，防止因时区换算导致的"少一天"或"多一天"边界误差）。

### 2.3 每页数量、限速、重试、退避

复用现有`server/src/http/resilience.js`/`server/src/http/client.js`已验证的策略，**不新增独立限速逻辑**：
- 每页：1000根K线（Binance接口上限）。
- 限速：复用现有`config.js`的`maxRetries`/`backoffBaseMs`/`backoffCapMs`（指数退避+封顶），不为回填单独定义新的重试参数，除非未来发现回填场景的请求量级需要更保守的限速（如加入回填专属`BACKFILL_RATE_LIMIT_MS`可选环境变量，默认值等于线上采集节奏，本轮不冻结具体数值，留待实现阶段按Binance公开限速文档核实）。
- 重试：单页失败按现有退避策略重试，超过`maxRetries`后整个批次标记失败并停止（见§2.13停止条件），不静默跳过缺页。

### 2.4 校时要求

- 回填任务启动前必须执行与生产`collector/time-guard.js`同款的`measureServerTime()`服务器时间校验，`clockOffsetMs`超过`MAX_CLOCK_OFFSET_MS`时**fail closed，拒绝启动回填**（防止本机时钟偏移导致`fetched_at`记录错误，进而影响审计可信度）。

### 2.5 仅接受已收盘K线

- 分页拉取的最后一页可能包含尚未收盘的当前K线（`close_time > 服务器当前时间`），**必须过滤丢弃**，不写入`market_bars`（该表本身只存formal已收盘数据，`provisional_market_bars`是完全独立的表，回填不触碰）。

### 2.6 去重键与 ON CONFLICT 策略

- 复用现有唯一约束：`market_bars`表`vintage_id`唯一（`UNIQUE`），`raw_payloads`表`UNIQUE(request_id, content_hash)`。
- 写入语句使用 **`INSERT ... ON CONFLICT (vintage_id) DO NOTHING`**（与生产`postgres.js`写入`market_bars`的既有模式一致，不新发明写入语义）。
- **红线：回填绝不覆盖已有正式K线**——`DO NOTHING`保证任何`vintage_id`冲突（含与实时采集已产生的记录冲突）时静默跳过，不做`DO UPDATE`。

### 2.7 revision_number 处理

- 所有回填的formal K线**固定写入`revision_number=0`**（Binance现货已收盘K线不存在修订场景，与生产`V1_4_FORECAST_DATA_SPEC.md`§8.4"已收盘现货K线revision恒为0"的既有结论一致）。
- **红线：不修改任何现有`revision_number=0`记录**——回填只做`INSERT`，不做任何`UPDATE`；若回填过程中发现某根K线在生产表中已存在（`vintage_id`冲突），直接跳过（`DO NOTHING`），不比较新旧值、不覆盖、不"修正"。

### 2.8 `available_at`/`fetched_at`语义（P0，见§2.9详细裁决）

- `fetched_at` = 回填任务**实际执行该次HTTP请求**的真实系统时间（诚实记录，不伪造）。
- `available_at` = **同样是回填任务实际写入该行的真实系统时间**（见§2.9详细论证，**不等于`close_time`**，区别于`server/src/domain/normalize.js`第37行"`availableAt: closed ? closeTime : null`"这一**仅适用于实时采集路径**的既有约定）。
- `published_at` = `close_time`（K线本身的市场发生时间，与实时路径一致，这是描述"市场事实何时发生"，不是"我们何时知道"，语义上没有伪造问题）。
- `first_available_at` = 与`available_at`相同（回填场景下没有"多次修订取更早可得时间"的概念，首次即唯一次）。

### 2.9 P0：数据可得性语义裁决（时间泄漏治理红线，不得含糊处理）

**问题重述**：`market_bars.available_at`是生产point-in-time查询（`bar-path-locator.js`的`available_at<=asOfTime`过滤）判断"某数据在某历史时刻是否已知"的唯一依据。

- 若回填时把`available_at`设为**回填任务实际执行时间**（如"今天"）：诚实，但会导致**任何**历史`asOfTime`（哪怕是回填数据本身对应的市场时间）都查询不到这些回填K线（因为`available_at`(今天) > 历史`asOfTime`），回填变得对历史回放毫无意义。
- 若回填时把`available_at`设为**K线的`close_time`**（伪造成"当时就可得"）：能让历史回放查到数据，但**污染了`market_bars`作为生产诚实运营记录的语义**——未来任何审计"系统在历史某时刻真实知道什么"都会被这条伪造记录误导，且这本质上是从"未来"（回填发生的今天）向"过去"（历史`asOfTime`）注入信息，是**结构性的时间泄漏**，即使回填数据本身的数值是真实历史K线，"何时可得"这个元数据被伪造了。

**冻结裁决**：

1. **生产`market_bars`表的`available_at`/`fetched_at`永远记录真实、诚实的时间——回填的K线，`available_at`/`fetched_at`即为回填任务实际执行的系统时间，不等于`close_time`，不例外。** 这保证`market_bars`作为唯一生产运营记录的语义永不被污染，任何未来的生产point-in-time查询（不限于本轮历史回放）都能得到真实答案。**（`FROZEN_POLICY`）**
2. 历史回放（`V1_4D_HISTORICAL_REPLAY_SPEC.md`）需要一个**独立的、显式标注为"研究性/反事实假设"的可得性语义**，称为 **`researchAvailability`**：
   - 定义：**`researchAvailability(bar) = bar.close_time`。这是一条`FROZEN_POLICY`（V1.4D本轮为历史研究人为冻结的规则），不是对生产系统当时真实获得数据时间的描述、也不是一个物理测量值**——**修订措辞（P1-3修订，取代draft-1过强的"实测延迟"表述）**：draft-1曾把该公式描述为"实测延迟为0毫秒"，这一表述**不精确**，需订正如下：
     - `OBSERVED`（可复查的既有事实）：生产代码`server/src/domain/normalize.js`第37行对**实时采集路径**的已收盘K线，将`availableAt`赋值为`closeTime`本身（`availableAt: closed ? closeTime : null`），这是代码既有的赋值逻辑，只读查询2026-07-23 17:55起产生的实时采集数据，其`available_at − close_time`列差值确实全部为0——但这是在**验证代码确实按其自身逻辑赋值**，不是在独立测量一个物理网络/处理延迟。
     - `FROZEN_POLICY`：`researchAvailability=close_time`这一回放专用假设，是**为了与生产实时路径的既有赋值策略保持一致**而选定的研究规则，选择依据是"一致性优先于额外建模精度"，而不是"我们测量到了0毫秒的真实延迟因而外推到历史"。
     - **`researchAvailability`绝不能被描述、注释或文档化为"生产系统当时真实获得数据的时间"——它只表示"若当时处于实时采集状态，按生产既有赋值策略，数据将在`close_time`可得"这一反事实研究前提**，回填当时（历史上）系统并未实际采集/持有该数据，这一点必须在每条回放记录的`research_data_vintage`中显式声明（见下）。
   - `researchAvailability`**只存在于`historical_validation`schema的回放查询层**（即：历史回放读取`market_bars.close_time`+`revision_number=0`+`source`来源字段确认是formal数据后，在回放查询逻辑内部**临时计算**`researchAvailability=close_time`并用它替代`available_at`做`asOfTime`过滤），**绝不写回`market_bars.available_at`**，`market_bars`表本身的值不受历史回放影响。
   - **`research_availability_rule_version`（P1-2修订，新增独立字段，取代仅隐含在jsonb说明文字中的做法）**：`researchAvailability`公式本身必须有一个显式的、独立的版本标识符，**不得**仅隐含在`dataset_version`/`algorithm_version`或`research_data_vintage`的自由文本说明中——三者语义完全不同（`dataset_version`描述feature/market数据集本身版本，`algorithm_version`描述PO/预测算法版本，`research_availability_rule_version`描述"如何定义历史数据可得性"这一独立维度的规则版本）。本轮冻结初始值：**`research_availability_rule_version = 'v1.4d-research-availability-1'`**（对应本节公式`=close_time`）。字段落于`historical_validation.replay_snapshots`/`replay_outcome_events`两表，`NOT NULL`，具体列定义、非空规则、与其他字段的关系见`V1_4D_HISTORICAL_REPLAY_SPEC.md`§2.3/§2.5修订。**修改`researchAvailability`公式本身（例如未来改为`close_time + 建模延迟`）必须递增此版本号，形成新版本，不得覆盖或静默影响已产生的历史`validation_run`结果**——旧版本号下已生成的`replay_snapshots`/`replay_outcome_events`永久保留，新旧版本可并列比较，不得因公式修订而重新解释旧数据。
   - 每一条`historical_validation.replay_snapshots`/`replay_outcome_events`记录必须携带`research_data_vintage`字段，显式声明"本记录基于`researchAvailability`（`FROZEN_POLICY`，规则版本见`research_availability_rule_version`列）假设（=市场收盘时间，非系统真实获知时间）生成，不代表系统在历史该时刻真实持有此数据"。
3. **`historical_validation`是否允许使用回填数据**：允许，且**只能**通过`researchAvailability`语义使用，不允许任何回放代码路径直接读取或依赖`market_bars.available_at`做历史`asOfTime`过滤（那会因回填的`available_at`=回填执行时间而永远查不到数据，见上文悖论），必须统一改用`researchAvailability`计算式。
4. **`market_bars`的`fetched_at`（回填执行时间）本身仍然是回放系统判断"这批数据是否已经回填完成、可用于研究"的依据**——即：回放查询除了`researchAvailability<=asOfTime`外，还必须叠加`fetched_at<=回放任务发起的当前真实系统时间`（这一条对回填数据恒真，因为回填必然发生在回放之前；但保留此过滤是为了防止一种边界情况：若历史回放与仍在进行中的回填任务并发执行，只应看到已经完成回填并提交的行，不看到回填过程中的部分批次）。

**该裁决即为本文档对用户"必须设计并冻结一个不篡改生产数据可得性语义、同时允许历史研究回放的机制"的正式回答：机制名为`researchAvailability`，公式`= close_time`（`FROZEN_POLICY`，版本`v1.4d-research-availability-1`），只存在于回放查询层，不写回生产表。**

### 2.10 回填批次ID与审计记录

- 每次回填执行生成唯一`backfill_batch_id`（UUID），所有该批次写入的`market_bars`行需可追溯到该batch（建议：复用现有`raw_payloads`表存储原始响应+`request_id`，并在`historical_validation`schema新增一张`backfill_batches`审计表记录`batch_id`/`symbol`/`interval_name`/`requested_range`/`status`/`started_at`/`finished_at`/`rows_inserted`/`rows_deduped`/`error_code`，与生产`market_bars`表本身不新增列，避免修改生产schema——本表归属`historical_validation`schema，符合CEO裁决"生产schema不变"的边界）。

**与`dataset_version`的关系（本轮补充，闭环P1交叉引用）**：一次或多次`backfill_batch_id`共同构成某个`dataset_version`的输入来源——`backfill_batch_id`本身只是"回填执行了什么"的审计记录，**不等同于**`dataset_version`（后者是对`public.market_bars`某个查询范围的内容哈希快照，二者关系是"manifest引用若干个batch_id作为溯源信息，但manifest的正确性由内容哈希独立保证，不依赖batch记录本身"）。`dataset_version`不再是任意人工输入的自由字符串，其生成规则、绑定字段清单、`dataset_manifests`表结构的**唯一权威定义**在`V1_4D_HISTORICAL_REPLAY_SPEC.md`§2.8/§2.9，本文档不重复定义，仅在此处交叉引用。

### 2.11 中断后恢复方式

- 回填任务按`(interval_name, 时间分页游标)`为幂等单位执行；`backfill_batches`记录每一页的完成游标（`last_completed_open_time`）；中断后重新执行同一`batch_id`（或按`--resume`指定batch）时，从`last_completed_open_time + intervalMs`继续，已写入的页因`ON CONFLICT DO NOTHING`天然幂等，重复请求同一页不产生副作用，只是浪费一次API调用（可接受）。

### 2.12 回填前后完整性校验

- **回填前**：查询目标区间内`market_bars`现状（复用第一阶段审计用过的gap/duplicate/out-of-order检测SQL模式），确认待回填区间当前为空或已知状态，记录基线。
- **回填后**：对新写入区间重跑同一套gap/duplicate/out-of-order检测（`open_time`严格等步长递增、无重复、`close_time>open_time`、无未来行），**任一检测失败则整批标记为`ATTENTION_REQUIRED`，不自动重试覆盖**，人工介入前不得判定回填成功。

### 2.13 与实时Collector并行运行时的隔离和锁策略

- 回填任务**不获取、不续租、不释放**生产`collector_leases`表中任何行（`primary-collector`/`feature-generator`/`forecast-generator`/`forecast-outcome-evaluator`），即不与生产调度器产生任何lease竞争。
- 回填任务写入`market_bars`使用与生产`CollectorService`相同的数据库连接池即可（`INSERT ... ON CONFLICT DO NOTHING`本身是行级操作，PostgreSQL行级锁天然保证并发安全），**不需要额外应用层互斥锁**，因为：(a) 回填与实时采集写入的`vintage_id`按定义不可能相同（回填目标区间`close_time`早于实时采集覆盖的区间起点，除非目标窗口与现有覆盖重叠，此时`ON CONFLICT DO NOTHING`保证不覆盖实时已写入的行）；(b) 回填只`INSERT`不`UPDATE`/`DELETE`，不可能与实时采集的写入产生行级冲突需要额外协调。
- **不得阻塞实时采集服务**：回填任务作为独立进程/脚本运行，不常驻、不占用生产`eth-alpha-collector.service`/`eth-alpha-feature-generator.service`进程内的事件循环或定时器，二者物理独立，回填进程崩溃/挂起不影响生产服务；数据库连接池配置需为回填任务设置**独立的、较小的连接数上限**（建议≤5，具体数值留待实现阶段结合`postgresql.conf`的`max_connections`余量确定），避免抢占生产连接。

### 2.14 失败时停止条件和回滚边界

**停止条件（fail closed，不静默跳过）**：
- 单页HTTP请求超过`maxRetries`次仍失败；
- 校时失败（`clockOffsetMs`超限）；
- 回填后完整性校验（§2.12）发现gap/duplicate/out-of-order；
- 写入时触发`vintage_id`唯一约束**以外**的任何数据库错误（如CHECK约束失败，可能意味着上游数据本身异常）。

**回滚边界**：
- 回填是纯**追加式`INSERT`**操作，单条语句失败天然不影响已成功写入的其他行（不使用跨多页的大事务，每页/每小批量各自独立提交，避免"一页失败导致已成功的九百多页被回滚"）。
- **不提供"删除本次回填全部数据"的自动化回滚脚本**（本轮不实施代码，此设计留待实现阶段：若确需撤销，必须是显式的、按`backfill_batch_id`筛选、经人工确认的手动操作，且只删除`market_bars`中`revision_number=0`且可追溯到该`batch_id`的行——**不使用本轮设计的任何自动回滚**，避免误删实时采集产生的、`vintage_id`恰好落在同一时间区间的记录）。

---

## 3. 与生产约束的一致性自查（逐条对照CEO裁决第5条）

| CEO裁决第5条要求 | 本协议如何满足 |
|---|---|
| source/formal语义正确 | 回填数据写入`market_bars`（formal表），`source_id`/`endpoint_id`沿用现有`source_registry`/`source_endpoint_registry`真实来源标识，不新增虚假来源 |
| available_at/fetched_at时间语义可审计 | §2.9冻结：均为回填任务真实执行时间，不伪造为历史时间；`backfill_batch_id`可追溯 |
| 幂等 | `ON CONFLICT(vintage_id) DO NOTHING` + 按分页游标恢复 |
| 可恢复 | §2.11分页游标恢复机制 |
| 不覆盖已有记录 | `DO NOTHING`，无`DO UPDATE`路径 |
| 不修改现有revision=0数据 | 回填只`INSERT`，全程无`UPDATE market_bars`语句 |
| 不阻塞实时采集服务 | §2.13物理隔离、独立连接池、无共享lease |

---

## 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.4d-backfill-draft-1 | 2026-07-25 | 初稿：冻结回填窗口选项与推荐窗口、Binance分页协议、available_at/fetched_at诚实语义与researchAvailability裁决、幂等/恢复/隔离/回滚边界 |
| v1.4d-backfill-draft-2 | 2026-07-25 | 第三阶段独立复审修订：①发现draft-1"120天窗口三段均达标"证明未处理跨边界样本（purge），补上后120天实际不达标，**推荐窗口上调为180天**，最小窗口修订为130天（§1.1~1.5全面重写）；②冻结默认50/25/25切分比例（此前未冻结）；③新增purge规则（§1.1），明确不需要embargo；④§2.9新增`research_availability_rule_version`独立字段冻结，修订"实测延迟"措辞为区分`OBSERVED`/`FROZEN_POLICY`/`ASSUMPTION`；⑤§1.6重写PO_\*状态细分表述，删除一切暗示"回填会自然缓解PO_UNKNOWN"的措辞，明确样本总量增长≠状态分布改善；⑥全文标注`OBSERVED`/`FROZEN_POLICY`/`ASSUMPTION`事实类型 |
| v1.4d-backfill-draft-3 | 2026-07-26 | 第三阶段补充修订：关闭`dataset_version`内容哈希P1。§2.10新增"与`dataset_version`的关系"交叉引用小节，明确`dataset_version`不再是自由字符串、其生成规则与`dataset_manifests`表结构唯一权威定义已迁移至`V1_4D_HISTORICAL_REPLAY_SPEC.md`§2.8/§2.9（本文档不重复定义，避免同一概念在两份文档各说一套） |
| v1.4d-backfill-draft-4 | 2026-07-26 | 第三阶段定向修订：`dataset_version`格式由64-bit截断改为完整SHA-256（`v1.4d-sha256-{64hex}`），本文档§2.10交叉引用的目标章节内容已同步更新（唯一权威定义仍在`V1_4D_HISTORICAL_REPLAY_SPEC.md`§2.9，本文档不重复定义，仅随版本号同步刷新） |
