# V1_4D_180D_FORMAL_RESEARCH_PLAN.md — V1.4D 180天正式历史研究执行方案

版本：v1.4d-180d-plan-draft-3（第二轮定向修复：修正Phase 2/4/4.5/5数据库连接环境变量路由描述，见变更记录）
基线：`main@4a30a69dae4a6f8da15a5e130f68e37da1d0c17d`
状态：**PLAN ONLY — 本文档本轮未执行，未写入任何数据库，未修改任何生产代码/冻结文档/Migration**
角色：本文档是V1.4D「180天正式历史研究」的唯一执行方案，供未来独立CEO授权后按本文档逐阶段执行；本文档本身不构成该授权。

```
FORMAL_180_DAY_RESEARCH_STATUS = NOT_STARTED
FORMAL_180_DAY_RESEARCH_AUTHORIZED = NO
V1_5_AUTHORIZED = NO
PRODUCTION_DEPLOYMENT_AUTHORIZED = NO
AUTOMATIC_TRADING_AUTHORIZED = NO
```

---

## 0. 研究周期口径（贯穿全文，不得偏离）

| 周期 | 定位 | 依据 |
|---|---|---|
| **180天** | **推荐的正式历史研究窗口** | `V1_4D_DATA_BACKFILL_SPEC.md` §1.5 "# 推荐窗口：180天（约6个月）15m formal历史数据" |
| 130天 | 不推荐的pipeline smoke-test严格最低窗口，**不满足**正式历史研究要求（72h的validation/test段零缓冲） | 同上 §1.1/§1.4/§1.5 |
| 365天 | 可选的长周期稳健性升级窗口，本方案不要求、不覆盖 | 同上 §1.4 |

本方案**只**为180天窗口设计；不涉及130天（已明确排除，仅用于链路打通，非本方案范围）；365天留作独立后续方案。

---

## 1. 只读现状核查结论（执行方案设计前，本轮已完成，证据见括注）

对`main@4a30a69`的真实实现与测试逐项核查，结论如下（未依据文件名或旧报告推断）：

| 核查项 | 结论 | 证据 |
|---|---|---|
| 研究CLI入口 | `backfill:market-bars`→`backfill-cli-entry.js`；`dataset:build-manifest`→`dataset-manifest-cli-entry.js`（契约版本1/2）；`validation:walk-forward`→`cli-entry.js`；`features:backfill-historical`→`historical-feature-backfill-cli.js`；`dataset:inventory-manifests`→只读诊断 | `server/package.json` scripts |
| 回填/manifest/**historical feature backfill**/replay/evaluation/report/audit模块 | 全部存在且互相编排（不是占位符）：`binance-kline-backfill.js`/`integrity-check.js`（回填+完整性）、`dataset-manifest-v2.js`/`multi-symbol-manifest-contract.js`/`canonical-manifest-content.js`（Manifest）、**`historical-feature-backfill.js`/`historical-feature-backfill-cli.js`（历史Feature预计算，写入生产`public.feature_records`，是Phase 5读取特征的唯一数据来源——`replay-generator.js`本身从不计算特征，只读取该表，见`findExactFeatureForReplay`；本轮修复前的draft-1遗漏了这一必需阶段，已在Phase 4.5补齐，见下）**、`replay-generator.js`/`replay-evaluator.js`（回放/评估，`cli-entry.js`调用）、`report-builder.js`/`purge.js`/`po-diagnostic.js`（报告）、`historical_validation.*`八张表（审计） | 直接读取各文件，见下文引用 |
| 交易对与周期 | 依赖矩阵精确四条，非笛卡尔积：ETHUSDT 15m/1h/4h + BTCUSDT 15m | `server/src/features/feature-engine.js` `FEATURE_BAR_DEPENDENCIES`（本轮原文读取） |
| 数据源与时间语义 | Binance现货公开REST；`researchAvailability(bar)=close_time`（`FROZEN_POLICY`，非生产`available_at`真实获知时间）；`fetched_at<=回放发起时真实系统时间` | `V1_4D_DATA_BACKFILL_SPEC.md` §2.9 |
| asOfTime/泄漏防护 | `validateReplayRange`强制`--to <= 当前真实UTC - 72h`；`computeIntegrityBoundary`按`fixedAsOf`裁剪`effectiveTo`；SQL查询联合约束`close_time<=fixedAsOf`+`vintage_id=ANY(governedVintageIds)` | `cli-entry.js`（本轮原文读取）；`dataset-manifest-v2.js`/`postgres.js`（此前独立复审已逐行核实） |
| resume/checkpoint | 真实断点续跑：`computeResumeCheckpoint`按`(validation_run_id,horizon)`从`replay_generation_runs`/`replay_evaluation_runs`终态推导`resumeFromIndex`，不完整/不连续时`fail closed`（`RESUME_CHECKPOINT_INCONSISTENT`）；`weight-version`/`evaluation-version`resume时强制与该run已有记录一致 | `cli-entry.js` `computeResumeCheckpoint`/`checkResumeVersionConsistency`（本轮原文读取） |
| dry-run | `validation:walk-forward --dry-run`：完整执行读取+生成+评估计算链路，仅将数据库写入替换为空操作，且输出`dry_run_execution_plan`（`rhythmPointCount`/`backfillBatchIds`/`purgeBoundary`/各阶段状态计数）；`dataset:build-manifest --dry-run`与`backfill:market-bars --dry-run`同样存在 | `cli-entry.js` `runWalkForward`（本轮原文读取） |
| 数据完整性检测 | `computeIntegrityBoundary`+`inspectIntegrityRows`（gap/duplicate/out-of-order），契约版本2下按`dependency_set`逐条独立检测，禁止跨依赖抵消 | `integrity-check.js`（本轮原文读取）；`V1_4D_MULTI_SYMBOL_MANIFEST_ADDENDUM.md`§八 |
| 数据版本/可复现性 | `dataset_version = v1.4d-sha256-{完整64位内容哈希}`；契约版本2需`--contract-version 2`且从`FEATURE_BAR_DEPENDENCIES`机械推导依赖集合，不接受人工`--symbol`/`--intervals` | `dataset-manifest-cli-entry.js`（本轮原文读取） |
| 失败状态/blocked reasons | `backfill_batches.status`∈{RUNNING,SUCCEEDED,FAILED,ATTENTION_REQUIRED}；`validation_runs.status`**Schema层面**（`server/migrations/005_v1_4d_historical_validation_schema.up.sql`第65行`CHECK`约束）允许∈{RUNNING,SUCCEEDED,FAILED,**PARTIAL**}，但`PARTIAL`本轮核对`cli-entry.js`/`replay-generator.js`/`replay-evaluator.js`/`report-builder.js`全文**无任何写入路径**——当前代码实际只会产生{RUNNING,SUCCEEDED,FAILED}三种，`PARTIAL`是schema预留但当前实现从未使用的第四个合法值，二者须分开陈述，不得混为一谈；`blocked_reasons`结构化追加(phase/horizon/historicalAsOfTime/message/code)；历史Feature Backfill另有独立的`feature_generation_runs`审计表与`summary.blockedPoints`/`summary.failedPoints`计数（见Phase 4.5） | `backfill-cli-entry.js`/`cli-entry.js` `markValidationRunFailed`（本轮原文读取）；migration 005第65行CHECK约束（本轮原文读取） |
| 结果输出/报告字段 | `validation_reports`：`directionRawSampleCount`/`directionEffectiveSampleCount`/`pathRawSampleCount`/`pathEffectiveSampleCount`/`sampleSufficient`/`purgedStraddlingCount`/`poStateBreakdown`/`upDownRangeBreakdown`/`formalProxyDisclosure`/`calibratedProbabilitiesStatus`(恒`'null (V1.4D not eligible)'`)/`errorAttributionSummary` | `report-builder.js`（本轮原文读取） |
| 数据库/磁盘/内存/运行时间 | **部分可由代码确定，部分必须环境核验**——见§C.6（数据量级公式）/§E.3（运行时间与资源预算，本轮新增，12项均标记`ENVIRONMENT_VALIDATION_REQUIRED`） | 见下 |
| 是否存在阻止180天正式研究的P0/P1 | **未发现**——所有前述模块均存在、互相编排、有对应测试；此前三轮独立终审（PR#20/#21/#22）已确认main上无P0/P1，仅3个已知P2（错误码文档登记不完整、pg客户端DeprecationWarning、pull_request无法捕获直接push main），均与本方案无关 | 本轮读取+此前三轮独立终审记录 |

**结论：不存在必须先修复的P0/P1，可以继续制定执行方案。**

---

## A. 研究目标与非目标

### A.1 本研究验证什么

1. 在ETHUSDT 15m/1h/4h + BTCUSDT 15m四条治理依赖的180天真实历史数据上，`po-state-engine.js`当前冻结的PO_\*判定规则、`threshold-formula.js`当前冻结的`directionThreshold`公式，产出的方向分类（UP/DOWN/RANGE）预测，在24h与72h两个horizon下的**方向判定准确率**、**样本充分性**（相对`MIN_SAMPLE_THRESHOLDS={24h:30,72h:10}`）、**MFE/MAE路径统计**表现如何。
2. PO_\*九状态（含`PO_UNKNOWN`）在真实180天ETH价格路径下的实际分布，以及`po-diagnostic.js`产出的诊断证据（`inputConditionHitRates`/`stateTransitionMatrix`/`persistentUnknownDiagnosis`四类候选原因）。
3. train/validation/test三段切分（50/25/25冻结默认）下表现是否稳定一致（`report_scope`分段对比）。
4. 端到端工程闭环（回填→Manifest→回放→评估→报告→审计）在180天真实规模数据下是否可复现、可审计、可断点续跑。

### A.2 本研究不验证什么

1. **不验证**任何形式的交易执行/持仓/资金曲线/净盈利能力——V1.4D全链路（`outcome-engine.js`/`forecast-contract.js`）经本轮原文核查**不包含任何手续费、滑点、资金费率、仓位规模或PnL计算**（见§B.7）。
2. **不验证**`calibratedProbabilities`——`replay_snapshots.calibrated_probabilities`/`validation_reports.calibratedProbabilitiesStatus`按CEO裁决第6条恒为`null`/`'null (V1.4D not eligible)'`，本研究不产出、不推断任何概率校准结论。
3. **不验证**跨24h/72h的合并模型、融合中枢、ML训练、自动交易——均在`V1_4D_CODEX_IMPLEMENTATION_TASK.md`§5明确排除范围内，本研究不重新引入。
4. **不构成**生产部署批准、V1.5启动批准或自动交易授权——三者均需独立、明确的后续授权（见§J）。

---

## B. 冻结研究契约

| 项目 | 值/规则 | 来源 | 状态 |
|---|---|---|---|
| 研究周期 | **180天**（唯一正式窗口） | `V1_4D_DATA_BACKFILL_SPEC.md`§1.5 | 已冻结 |
| UTC起止时间确定规则 | `researchTo`= 执行时选定的、满足`validateReplayRange`（`to <= 当前真实UTC−72h`）且对齐15m边界的UTC时间戳；`researchFrom = researchTo − 180×86400000ms`；回填/Manifest范围额外向前扩展4天warm-up：`backfillFrom = researchFrom − 4×86400000ms`（见§C.2理由）——**具体日历日期本身未定，属PRE_EXECUTION_DECISION_REQUIRED**，但确定规则本身已冻结、可机械执行 | `cli-entry.js` `validateReplayRange`；`V1_4D_DATA_BACKFILL_SPEC.md`§2.1 | 规则已冻结，具体值待定 |
| 交易对 | ETHUSDT（研究/预测标的），BTCUSDT（仅作为治理依赖输入，不产出自身预测） | `feature-engine.js` `FEATURE_BAR_DEPENDENCIES` | 已冻结 |
| 时间周期 | 15m（候选bar）、1h、4h（特征输入） | 同上 | 已冻结 |
| 预测周期(horizon) | 24h、72h（`HORIZONS`常量，无第三选项） | `cli-entry.js` | 已冻结 |
| directionThreshold | **非固定数值，逐快照按公式计算**：`rawThreshold = atr14FourHourAtGeneration / referencePrice × sqrt(periods)`，`clamp(rawThreshold, floor, ceiling)`；24h: periods=6,floor=0.008,ceiling=0.05；72h: periods=18,floor=0.015,ceiling=0.08 | `threshold-formula.js`（本轮原文读取） | 已冻结（公式+参数） |
| scenarioWeights | 非固定数值，逐快照由`forecast-contract.js`按`V1_4_FORECAST_DATA_SPEC.md`§7.4三档分组规则计算，`baseline+upside+downside=100`，版本标识`WEIGHT_VERSION='v1.4c-server-weight-1'` | `forecast-contract.js`/`forecast-version.js` | 已冻结（规则，非常数表） |
| 成本/手续费/滑点假设 | **代码未建模**——`outcome-engine.js`/`forecast-contract.js`全文搜索零命中fee/slippage/commission/pnl/position size | 本轮原文grep核查 | **PRE_EXECUTION_DECISION_REQUIRED**：需CEO明确本研究是否只产出"pre-cost方向/区间预测准确性"结论（推荐默认，与现有代码能力一致），或要求额外设计成本模型（超出本方案与现有代码范围，不得擅自发明假设值） |
| 数据源 | Binance现货公开REST Klines（`GET /api/v3/klines`），复用`server/src/sources/binance.js`，`source_id='binance-spot-rest'` | `V1_4D_DATA_BACKFILL_SPEC.md`§2.1；`multi-symbol-manifest-contract.js` `MANIFEST_SOURCE_ID` | 已冻结 |
| 代码SHA | `main@4a30a69dae4a6f8da15a5e130f68e37da1d0c17d`（本方案设计基线）——**正式执行前必须重新核实main HEAD未变或已知晓任何变化并重新评估**，见Go/No-Go门禁G.1 | 本文档头部声明 | 待执行时锁定/复核 |
| 数据集版本(dataset_version) | 契约版本2 Manifest的内容哈希，**只能在Phase 4执行`dataset:build-manifest --contract-version 2`后得到，不得预先编造** | `dataset-manifest-v2.js` | 待执行产出 |
| 配置摘要 | `algorithm-version=v1.4c-server-po-rule-1`；`rule-version=v1.4c-po-rule-1`；`weight-version=v1.4c-server-weight-1`；`evaluation-version=v1.4c-outcome-evaluation-1`；`research-availability-rule-version=v1.4d-research-availability-1`（代码内置，CLI不接受覆盖）；`feature-set-version=v1.4b-unified-1`；`feature-algorithm-version=v1.4b-feature-engine-1`；`--split 50/25/25` | `forecast-version.js`/`research-availability.js`/`feature-version.js`（本轮原文读取） | 已冻结（值已知，需在命令中显式传入，CLI不做隐式默认） |
| 随机性控制 | 全链路核查未发现任何随机数/采样/shuffle环节——`splitTimeOrdered`按时间顺序确定性切分，`computeEffectiveSampleCount`贪心区间调度确定性去重叠，PO判定/阈值计算均为纯函数无随机性；因此**无需设置随机种子**，同一输入在任意次数重跑下必须产生逐字节相同的`dataset_version`/报告`content_hash`（已有R26/R27/hash-contract-verification测试覆盖此性质） | `walk-forward.js`/`purge.js`/`report-builder.js`（本轮原文读取+既有测试） | 已冻结（结构性无随机性，非需要"控制"的维度） |

---

## C. 数据准备

### C.1 180天所需数据覆盖范围与bar数量

按§B确定规则计算（`researchTo`/`researchFrom`待定，以下为**相对天数的机械公式**，不预设具体日期）：

| 依赖 | interval | 研究窗口bar数(180天) | +4天warm-up bar数 | 合计需回填bar数 |
|---|---|---|---|---|
| ETHUSDT | 15m | 180×96 = 17,280 | 4×96 = 384 | 17,664 |
| ETHUSDT | 1h | 180×24 = 4,320 | 4×24 = 96 | 4,416 |
| ETHUSDT | 4h | 180×6 = 1,080 | 4×6 = 24 | 1,104 |
| BTCUSDT | 15m | 180×96 = 17,280 | 4×96 = 384 | 17,664 |
| **合计** | — | **39,960** | **888** | **40,848** |

### C.2 warm-up/lookback理由（不得省略，历史上曾导致真实失败）

`computeFourHourAtr14`/`computeConsecutiveBreakoutBars`在研究窗口**起点当天**需要向前回溯15~23根4h K线；若4h/1h数据起点与研究窗口起点相同，窗口最早约4天的候选点会因`ATR14_4H_INSUFFICIENT`被blocked（`V1_4D_DATA_BACKFILL_SPEC.md`§1.3"条件性0天"说明，且此前独立复审中曾实测复现过"Manifest声明范围未覆盖ATR回溯需求导致`SOURCE_OUTSIDE_DATASET_MANIFEST`"的真实失败）。**因此`backfill:market-bars`与`dataset:build-manifest`的`--from`必须是`backfillFrom = researchFrom − 4天`，而`validation:walk-forward`的`--from`必须是`researchFrom`本身（候选生成窗口不含warm-up段）**——三个CLI的时间参数**不是同一个值**，必须在命令模板中显式区分（见§D Phase 4/5）。

### C.3 数据完整性门槛

- 回填后：`checkIntegrity`要求`gapCount=0 且 duplicateCount=0 且 outOfOrderCount=0`，任一不满足→`backfill_batches.status='ATTENTION_REQUIRED'`，不自动重试覆盖（`V1_4D_DATA_BACKFILL_SPEC.md`§2.12）。
- Manifest构建：契约版本2下按`dependency_set`四条独立执行gap/duplicate/out-of-order检测，任一依赖不满足即整体拒绝构建（`DATASET_MANIFEST_DEPENDENCY_INCOMPLETE`），**不得**因总量抵消而放行（`V1_4D_MULTI_SYMBOL_MANIFEST_ADDENDUM.md`§八）。

### C.4 fetched_at/asOfTime约束

`available_at`/`fetched_at`记录回填任务**真实执行时间**，不伪造为`close_time`；历史回放侧独立使用`researchAvailability(bar)=close_time`（`FROZEN_POLICY`，`research_availability_rule_version='v1.4d-research-availability-1'`），且叠加`fetched_at<=回放发起时真实系统时间`——防止回放读到"仍在回填中、尚未提交完成"的批次（`V1_4D_DATA_BACKFILL_SPEC.md`§2.9）。

### C.5 数据来源与回填步骤

Binance现货公开REST，按`(symbol,interval)`独立分页拉取，`ON CONFLICT(vintage_id) DO NOTHING`天然幂等；4个依赖需**分别**执行`backfill:market-bars`（见§D Phase 4命令模板），不得用一次调用覆盖多个symbol/interval组合（CLI本身`--intervals`支持逗号分隔多个周期，但`--symbol`每次只能一个）。

### C.6 数据库容量与磁盘预估方法

**可由代码/schema确定的部分**：`market_bars`表每行的列结构固定（`open`/`high`/`low`/`close`/`volume`/`quote_volume`等numeric字段+若干text/timestamptz字段），40,848行的表内数据量级可估算（数量级：约40,848行×约200~400字节/行原始数据 ≈ 8~16MB，不含索引/TOAST/WAL开销）；`dataset_manifests.manifest_members`（jsonb，180天四依赖约39,960个成员对象）会显著增加该表单行大小（数量级：每成员对象约200~300字节序列化后，39,960个≈8~12MB的单个jsonb值）。

**必须环境核验的部分**（代码本身无法确定，见§E.3）：目标PostgreSQL实例当前磁盘剩余空间、索引/TOAST/WAL实际膨胀系数、`historical_validation`schema当前已有数据量（是否已有此前测试遗留的行）、`pg.Pool`实际可用连接数上限（代码固定`max:10`，但服务器`max_connections`总量需环境查询）；`public.feature_records`本轮新增写入量未在此给出精确公式，需在Phase 4.5实际执行后结合`summary.requestedPoints`与单行实际大小估算，标记`ENVIRONMENT_VALIDATION_REQUIRED`。

### C.7 与Historical Feature Backfill（Phase 4.5）的关系（本轮新增，交叉引用）

本节§C.1-§C.6全部围绕`public.market_bars`原始K线的回填范围展开；**Phase 4.5的`public.feature_records`预计算是在market_bars回填完成之后的独立数据准备步骤，其覆盖范围与目标是`[researchFrom,researchTo)`（不含§C.2的4天warm-up缓冲——特征计算本身通过`FEATURE_BAR_DEPENDENCIES`各依赖的`minimumBars`要求隐式复用warm-up区间的原始K线，不需要在`feature_records`的候选点范围上重复外扩）**。详细命令模板、写入边界、通过/阻塞条件见§D Phase 4.5。

---

## D. 分阶段执行流程

**红线（贯穿全部阶段）**：全部命令均以**命令模板**形式给出，本轮**不执行**任何一条；`--symbol`/`--from`/`--to`等尖括号占位符在真正执行时由操作者按§B/§C规则代入真实值，不得由本文档预先编造。

**数据库连接路由与身份保护（本轮修正NEW-P1-1，逐一原文核对`server/src/backfill/backfill-cli-entry.js`/`server/src/validation-replay/dataset-manifest-cli-entry.js`/`server/src/validation-replay/cli-entry.js`/`server/src/features/historical-feature-backfill-cli.js`/`server/src/config.js`/`server/src/db/research-database-guard.js`/`server/scripts/v1-4d-manifest-inventory.mjs`及各自测试后确认）**：

- `backfill:market-bars`（Phase 2/4，`backfill-cli-entry.js`）、`dataset:build-manifest`（Phase 4，`dataset-manifest-cli-entry.js`）、`validation:walk-forward`（Phase 5，`cli-entry.js`）三者均调用`loadConfig()`（`config.js`第13行`databaseUrl: process.env.DATABASE_URL || ''`），**只读`DATABASE_URL`**，命令前缀必须使用`DATABASE_URL=<research_db_url>`。
- `features:backfill-historical`（Phase 4.5，`historical-feature-backfill-cli.js`）**不经过**`loadConfig()`，直接构造`{databaseUrl: env.TEST_DATABASE_URL, dbSsl:false}`，**只读`TEST_DATABASE_URL`、不接受`DATABASE_URL`回退**（`historical-feature-backfill-cli.js`第12行原文核对，回归测试`server/tests/features/historical-feature-backfill.test.js`第36-81行逐条断言此契约），命令前缀必须使用`TEST_DATABASE_URL=<research_db_url>`。
- 上述四个正式流程CLI**均不导入、不调用**`assertExplicitResearchDatabaseIdentity`，**均不读取**`V14D_DATABASE_IDENTITY`环境变量（全仓`grep`确认零命中）。该函数与该环境变量**只被**独立诊断脚本`server/scripts/v1-4d-manifest-inventory.mjs`使用（第5/24行`assertExplicitResearchDatabaseIdentity(env[INVENTORY_DATABASE_IDENTITY_ENV])`），**该脚本不属于本方案Phase 0-9流程的任何一步**，不得把它的契约套用到上述四个CLI的命令模板或Go/No-Go条件中。
- 四个正式流程CLI真正依赖的数据库身份保护统一来自`research-database-guard.js`的`createGuardedResearchPgPool()`，包含两层校验：①建立连接前，`parseResearchDatabaseTarget(databaseUrl)`只解析连接串声明的库名，要求精确等于硬编码的`RESEARCH_DATABASE_NAME`（当前为`eth_alpha_v14d_test`），否则`DATABASE_URL_REQUIRED`/`DATABASE_URL_INVALID`/`DATABASE_TARGET_REJECTED`；②建立连接后，执行`SELECT current_database()`二次核验，不一致同样`DATABASE_TARGET_REJECTED`并关闭连接。该两层保护与是否设置`V14D_DATABASE_IDENTITY`**无关**，无论该变量是否存在都会生效。
- 任何阶段开始前，操作者仍必须独立确认所用命令实际解析出的数据库主机/端口/库名精确等于允许的研究数据库，并确认该阶段实际执行后`current_database()`二次核验确已通过——**"对应环境变量已设置"不等同于"数据库身份已验证"**，真正的验证结果以`createGuardedResearchPgPool`的返回/抛出为准。

### Phase 0：环境与基线核验

- **输入**：无（只读查询）
- **说明（本轮修正NEW-P1-1，避免与CLI环境变量契约混淆）**：`$RESEARCH_DB_URL`是本文档Phase 0/3/7中仅供人工`psql`只读核查使用的**独立**shell变量名，与`npm run`命令实际读取的`DATABASE_URL`（Phase 2/4/5）/`TEST_DATABASE_URL`（Phase 4.5）没有代码层面的绑定关系；操作者应将其设置为与Phase 2/4/4.5/5即将使用的同一个研究数据库连接串取值相同，但变量名本身不需要、也不应该与任何CLI的`process.env`读取名一致。
- **命令模板**：
  ```
  git rev-parse HEAD   # 确认锁定main SHA
  git status --short   # 确认工作树干净
  psql "$RESEARCH_DB_URL" -c "SELECT current_database();"
  psql "$RESEARCH_DB_URL" -c "SELECT version FROM schema_migrations ORDER BY version;"
  psql "$RESEARCH_DB_URL" -c "SELECT count(*) FROM historical_validation.dataset_manifests;"
  psql "$RESEARCH_DB_URL" -c "SELECT count(*) FROM historical_validation.validation_runs;"
  psql "$RESEARCH_DB_URL" -c "SELECT pg_database_size(current_database());"
  df -h   # 磁盘剩余空间
  ```
- **前置条件**：无
- **输出**：main SHA记录、工作树clean确认、目标库身份=`eth_alpha_v14d_test`、当前migration版本、`historical_validation`各表现有行数基线、当前DB大小、磁盘剩余空间
- **通过条件**：目标库确为`eth_alpha_v14d_test`（非`eth_alpha`/`postgres`/其他）；migration版本包含001-007；磁盘剩余空间显著大于§C.6预估量级
- **阻塞条件**：目标库身份不匹配；migration版本缺失；磁盘不足；**目标库存在无法解释的既有数据**（**PRE_EXECUTION_DECISION_REQUIRED**：`eth_alpha_v14d_test`此前曾在本项目历史上被记录为存在"不可追溯"的历史行为学证据的时期——Phase 0必须重新、独立地核实该数据库当前实际状态，并由CEO决定是在现有状态基础上叠加180天研究数据，还是要求先完成一次独立授权的清理/重建）
- **失败后恢复**：无写入，直接重新核查
- **是否产生数据库写入**：**否**（全部只读）

### Phase 1：配置冻结

- **输入**：Phase 0核验结果 + §B冻结契约
- **命令模板**：无可执行命令；本阶段产出一份"本次运行配置清单"文本文件（人工/脚本生成，记录§B全部字段的实际取值，含本次选定的`researchFrom`/`researchTo`具体日期）
- **前置条件**：Phase 0通过
- **输出**：配置清单（含具体UTC日期、全部version字符串、split比例）
- **通过条件**：配置清单每一项均可追溯到§B冻结值或本文档规则计算结果，不含任何本阶段临时发明的数值
- **阻塞条件**：任何字段无法从§B/§C规则确定
- **失败后恢复**：修改配置清单重新核对，无状态需回滚
- **是否产生数据库写入**：否

### Phase 2：只读dry-run

- **输入**：Phase 1配置清单
- **命令模板**：
  ```
  DATABASE_URL=<research_db_url> \
    npm run backfill:market-bars -- --symbol ETHUSDT --intervals 15m,1h,4h --from <backfillFrom> --to <researchTo> --as-of <researchTo-1ms> --dry-run
  DATABASE_URL=<research_db_url> \
    npm run backfill:market-bars -- --symbol BTCUSDT --intervals 15m --from <backfillFrom> --to <researchTo> --as-of <researchTo-1ms> --dry-run
  ```
- **前置条件**：Phase 1完成
- **输出**：dry-run结果（预计分页数、当前`market_bars`已有覆盖范围对比）
- **通过条件**：dry-run正常返回，无异常抛出
- **阻塞条件**：`AS_OF_REQUIRED`/`DRY_RUN_RESUME_CONFLICT`等参数错误；网络/校时失败(`SERVER_TIME_UNAVAILABLE`)
- **失败后恢复**：修正参数重跑，无状态需回滚（dry-run不写入`backfill_batches`）
- **是否产生数据库写入**：**否**

### Phase 3：数据覆盖和完整性检查（回填前基线）

- **输入**：Phase 2确认的当前`market_bars`覆盖状态
- **命令模板**：
  ```
  psql "$RESEARCH_DB_URL" -c "SELECT interval_name, min(open_time), max(open_time), count(*) FROM public.market_bars WHERE instrument='ETHUSDT' AND market_type='spot' GROUP BY interval_name;"
  psql "$RESEARCH_DB_URL" -c "SELECT interval_name, min(open_time), max(open_time), count(*) FROM public.market_bars WHERE instrument='BTCUSDT' AND market_type='spot' GROUP BY interval_name;"
  ```
- **前置条件**：Phase 2通过
- **输出**：当前已有数据范围与本次需回填范围`[backfillFrom, researchTo)`的差集（决定实际需要拉取的分页数量）
- **通过条件**：明确列出仍需回填的时间段
- **阻塞条件**：无（只读）
- **失败后恢复**：不适用
- **是否产生数据库写入**：否

### Phase 4：正式回填 + Manifest构建

- **输入**：Phase 3确认的实际待回填范围
- **命令模板**：
  ```
  # 4个依赖各自独立回填（真实执行，非dry-run）
  DATABASE_URL=<research_db_url> \
    npm run backfill:market-bars -- --symbol ETHUSDT --intervals 15m,1h,4h --from <backfillFrom> --to <researchTo> --as-of <researchTo-1ms>
  DATABASE_URL=<research_db_url> \
    npm run backfill:market-bars -- --symbol BTCUSDT --intervals 15m --from <backfillFrom> --to <researchTo> --as-of <researchTo-1ms>

  # 契约版本2多symbol Manifest构建（注意：manifest的--from与回填的--from相同，均为backfillFrom）
  DATABASE_URL=<research_db_url> \
    npm run dataset:build-manifest -- --contract-version 2 --from <backfillFrom> --to <researchTo> --fixed-as-of <researchTo-1ms>
  ```
- **前置条件**：Phase 3确认待回填范围；`AS_OF_REQUIRED`等参数齐全
- **输出**：4条`backfill_batches`记录（各自`status`）；1条`dataset_manifests`记录（`dataset_version`即为本次研究的数据集版本，**必须记录留档**）
- **通过条件**：全部4个`backfill_batches`最终`status='SUCCEEDED'`；`dataset:build-manifest`返回`status='SUCCEEDED'`（非`REJECTED`）
- **阻塞条件**：任一`backfill_batches`落入`ATTENTION_REQUIRED`（完整性检测失败）或`FAILED`；Manifest构建返回`REJECTED`（`errorCode`含`DATASET_MANIFEST_DEPENDENCY_INCOMPLETE`等）——**均不得跳过或强行继续**，须回到Phase 3重新核实缺口
- **失败后恢复（红线：`--resume`必须逐interval单独调用，不得携带多个`--intervals`）**：`backfill-cli-entry.js`第175-180行`if(args.resume&&intervals.length>1)throw...{code:'RESUME_INTERVALS_CONFLICT'}`——**每个`(symbol,interval)`组合对应独立的`backfill_batch_id`**（同文件头部注释第4行），`--resume`**只能**配合**单一**`--intervals`值使用。**明确禁止**以下形式（会被立即拒绝，不会按预期续跑）：
  ```
  # 错误示例——ETHUSDT批次原始调用是--intervals 15m,1h,4h，若其中1h失败，
  # 不得直接对完整三周期列表resume：
  npm run backfill:market-bars -- --symbol ETHUSDT --intervals 15m,1h,4h --from <backfillFrom> --to <researchTo> --as-of <researchTo-1ms> --resume <某个batch_id>
  ```
  **正确做法**：只对失败的那一个interval单独resume，**不得**携带其余已成功的周期；`--from`/`--to`/`--as-of`/`--symbol`/该interval必须与该interval原始批次记录完全一致（`assertResumeBatchCompatible`校验），例如若ETHUSDT的`1h`周期失败（其对应批次ID为`<1h_backfill_batch_id>`）：
  ```
  DATABASE_URL=<research_db_url> \
    npm run backfill:market-bars -- \
    --symbol ETHUSDT \
    --intervals 1h \
    --from <backfillFrom> \
    --to <researchTo> \
    --as-of <researchTo-1ms> \
    --resume <1h_backfill_batch_id>
  ```
  ETHUSDT的`15m`/`4h`两个周期若已各自`SUCCEEDED`，各自拥有**独立**的`backfill_batch_id`，**不需要**、也**不得**在恢复`1h`时一并携带；`ATTENTION_REQUIRED`批次**不可**`--resume`（人工介入前不得判定成功，见`V1_4D_DATA_BACKFILL_SPEC.md`§2.12）。Phase 8独立复核须检查实际执行的任何`--resume`调用确实不存在多`--intervals`冲突。
- **是否产生数据库写入**：**是**（`market_bars`追加式INSERT；`backfill_batches`/`dataset_manifests`审计与内容寻址记录，二者均不可原地覆盖）

### Phase 4.5：Historical Feature Backfill（**必需阶段**——Phase 5产出有效样本的前提条件，draft-1曾遗漏，本轮补齐）

- **目标**：为`[researchFrom, researchTo)`整个研究窗口内的ETHUSDT 15m每一个24h节奏点，预先计算并持久化`public.feature_records`。**`validation:walk-forward`（Phase 5）自身从不计算特征，只通过`findExactFeatureForReplay()`只读消费该表**（`server/src/validation-replay/replay-generator.js`第54-63行）；`backfill:market-bars`（Phase 4）与`dataset:build-manifest`（Phase 4）均**从不写入**`feature_records`（本轮原文grep核对，二者代码零命中`feature_records`）。若本阶段未完成或覆盖不全，Phase 5会对未覆盖的节奏点逐一返回`blocked('FEATURE_RECORD_MISSING',...)`（同文件第104-105行）——**不抛异常、不中止run，`validation_runs.status`仍可能显示`SUCCEEDED`，但产出的有效样本数为0，是一个不会被现有异常处理捕获的静默失效模式**。本阶段因此是**必需**前置条件，不是可选优化。
- **输入**：Phase 4产出的契约版本2`dataset_version`。
- **前置条件**：Phase 4的Manifest已`status='SUCCEEDED'`且`dataset_version`已记录留档。
- **命令模板**（脚本名核对自`server/package.json`第26行`"features:backfill-historical": "node src/features/historical-feature-backfill-cli.js"`；参数名逐一核对自`historical-feature-backfill-cli.js` `parseHistoricalBackfillArgs`）：
  ```
  TEST_DATABASE_URL=<research_db_url> \
    npm run features:backfill-historical -- \
    --symbol ETHUSDT --interval 15m \
    --from <researchFrom> --to <researchTo> \
    --feature-version v1.4b-unified-1 \
    --algorithm-version v1.4b-feature-engine-1 \
    --dataset-version <Phase4产出的dataset_version> \
    --batch-size 25
  ```
  **红线（两个"--algorithm-version"含义不同，不得混淆）**：本阶段`--algorithm-version`是**特征计算算法版本**，必须精确等于`FEATURE_ALGORITHM_VERSION`（`server/src/features/feature-version.js`第3行：`'v1.4b-feature-engine-1'`）；这与Phase 5`validation:walk-forward --algorithm-version`（**PO判定/预测算法版本**，`ALGORITHM_VERSION='v1.4c-server-po-rule-1'`，`server/src/forecast/forecast-version.js`第2行）是**两个独立维度、恰好复用同一flag名称、但取值完全不同**的参数，不得互相代入。`--feature-version`必须精确等于`FEATURE_SET_VERSION`（`feature-version.js`第2行：`'v1.4b-unified-1'`）。三者不一致时`historical-feature-backfill.js`第21-22行分别返回`FEATURE_VERSION_MISMATCH`/`ALGORITHM_VERSION_MISMATCH`，fail closed，不静默使用默认值。本轮已核对代码常量定义、注释与既有单元测试三方一致，**不存在代码/规范/测试互相矛盾的情况**，因此该值可直接冻结引用，不列为待决定项。
  - `--symbol`/`--interval`当前**只接受**`ETHUSDT`/`15m`（`validateHistoricalBackfillOptions`第17-18行），其他值返回`INVALID_SYMBOL`/`INVALID_INTERVAL`。
  - `--dataset-version`必须匹配`HISTORICAL_DATASET_VERSION_PATTERN=/^v1\.4d-sha256-[a-f0-9]{64}$/`（同文件第7/23行），即Phase 4产出的**同一个**契约版本2`dataset_version`字符串。
  - `--batch-size`默认**25**（`historical-feature-backfill-cli.js`第6行`parseHistoricalBackfillArgs`已冻结默认值，本方案直接引用，不重复列为CEO决策），允许范围`[1,1000]`（`validateHistoricalBackfillOptions`第24行）——纯运维分批参数，不改变研究结果，见§K.2 `PRE_EXECUTION_OPERATIONAL_DECISION_REQUIRED`第1项。
  - 本CLI**只读**`env.TEST_DATABASE_URL`（不接受`DATABASE_URL`回退，`historical-feature-backfill-cli.js`第12行原文核对）；本轮修正（NEW-P1-1）：**Phase 2/Phase 4/Phase 4.5/Phase 5全部四个正式流程CLI均不调用`assertExplicitResearchDatabaseIdentity`、均不读取`V14D_DATABASE_IDENTITY`**（该函数/环境变量只被独立诊断脚本`server/scripts/v1-4d-manifest-inventory.mjs`使用，与本方案Phase 0-9流程无关），并非"Phase 4.5是例外、Phase 4/5需要它"；四者的**唯一**差异是数据库连接串来源的环境变量名不同——Phase 2/4/5的CLI经`loadConfig()`读取`DATABASE_URL`，本阶段（Phase 4.5）直接读取`TEST_DATABASE_URL`。无论读取哪个环境变量，全部四个CLI都统一受`createGuardedResearchPgPool`的目标库名声明（`parseResearchDatabaseTarget`）+连接后`current_database()`二次核验双重保护，只能对准`eth_alpha_v14d_test`。
- **输出**：`public.feature_records`新增行；`public.feature_generation_runs`一条审计行（`runId`，非dry-run时）。
- **数据库写入边界（红线：不得描述为只读）**：**是，写入**——本阶段写入**生产**`public.feature_records`表（`server/migrations/003_v1_4b_feature_engine.up.sql`第33行定义，`UNIQUE(symbol,target_interval,target_bar_close_time,feature_set_version,revision_number)`；不属于`historical_validation`schema，是与实时特征生成共享的同一张表，二者按`target_bar_close_time`落在不同的时间区间天然不冲突）；同时写入`public.feature_generation_runs`。
- **通过条件**：`runHistoricalFeatureBackfill`返回`status:'SUCCEEDED'`，`summary.blockedPoints===0`且`summary.failedPoints===0`。
- **阻塞条件**：Manifest门禁失败（`DATASET_MANIFEST_CONTRACT_VERSION_UNSUPPORTED`/`DATASET_MANIFEST_SCOPE_MISMATCH`/`DATASET_MANIFEST_DEPENDENCY_UNGOVERNED`/`DATASET_MANIFEST_RANGE_INSUFFICIENT`/`DATASET_MANIFEST_MEMBERS_MISSING`/`DATASET_MANIFEST_MEMBER_IDENTITY_MISSING`/`DATASET_MANIFEST_DEPENDENCY_INCOMPLETE`/`DATASET_RESEARCH_AVAILABILITY_VERSION_MISMATCH`，见`historical-feature-backfill.js`第51-62行`validateVerifiedManifest`）；单点`INPUT_WINDOW_INCOMPLETE`/`INPUT_BAR_ORDER_INVALID`/`TARGET_BAR_MISSING`/`INPUT_BAR_GAP`/`FUTURE_LEAK_DETECTED`/`SOURCE_IDENTITY_INCOMPLETE`/`SOURCE_OUTSIDE_DATASET_MANIFEST`/`SOURCE_NOT_IN_DATASET_MANIFEST`/`FEATURE_QUALITY_BLOCKED`——**任一单点异常都会导致整个批次`throw`并中止循环**（不吞掉、不跳过继续处理后续点，见`runHistoricalFeatureBackfill`第91-93行catch块），`summary.status`转为`BLOCKED`或`CONFLICT`（`error.code==='HISTORICAL_FEATURE_CONFLICT'`时）。
- **dry-run行为**：`--dry-run`时完整执行门禁校验+`generateFeatureRecord`计算，但跳过`saveHistoricalFeatureRecord`（零写入`feature_records`）与`startHistoricalFeatureRun`/`finishHistoricalFeatureRun`（零写入`feature_generation_runs`），逐点返回`status:'WOULD_GENERATE'`（`runHistoricalFeatureBackfill`第76/88行原文核对）。
- **checkpoint/resume行为**：本CLI**不提供**类似Phase 5那样从数据库终态自动推导恢复点的机制；`--resume-after <referenceTime>`是**调用方手动指定**的游标（须满足`(value+1)%900000===0`且落在`[from,to)`区间内，见`validateHistoricalBackfillOptions`第26行），效果是跳过`<=该值`的候选点。由于`saveHistoricalFeatureRecord`对内容一致的已存在记录返回`ALREADY_PRESENT`（幂等），**`--resume-after`是性能优化而非正确性必需项**。
- **失败后恢复**：**最简单且安全的方式是使用完全相同的`--from`/`--to`/`--feature-version`/`--algorithm-version`/`--dataset-version`重新执行整条命令**——已成功持久化的历史点会被判定为`ALREADY_PRESENT`（幂等跳过，不重复写入、不报错），处理自然从未完成处继续；若需节省时间，可显式传入`--resume-after <上次summary.results中最后一个非BLOCKED点的referenceTime，或查询public.feature_records实际max(target_bar_close_time)得到>`。**`HISTORICAL_FEATURE_CONFLICT`必须视为停止并人工排查的信号，不得自动重试覆盖**（理论上manifest内容寻址+确定性计算下不应出现内容冲突，出现即代表数据或代码存在未预期问题）。
- **审计和复现产物**：`feature_generation_runs`行（`runId`/`status`/时间戳）；`feature_records`每行的`content_hash`/`source_vintage_refs`/`source_revision_refs`/`availability`（可复现性证据）。
- **与Phase 4 dataset_version的绑定关系**：本阶段的`--dataset-version`必须是Phase 4产出的同一个契约版本2`dataset_version`；`validateVerifiedManifest`重新调用`PostgresRepository.verifyHistoricalFeatureDataset`（`server/src/db/postgres.js`第132行，内部`requiredContractVersion:2`）逐项核验，任何漂移一律fail closed。
- **正式执行前核验查询模板（本轮不执行，仅供未来Go/No-Go使用，全部表名/列名核对自`server/migrations/003_v1_4b_feature_engine.up.sql`第33-62行）**：
  ```sql
  -- 覆盖范围、总量、版本一致性
  SELECT symbol, target_interval, feature_set_version, algorithm_version, source_dataset_version,
         min(target_bar_close_time) AS earliest, max(target_bar_close_time) AS latest, count(*) AS total_rows
  FROM public.feature_records
  WHERE symbol='ETHUSDT' AND target_interval='15m'
  GROUP BY symbol, target_interval, feature_set_version, algorithm_version, source_dataset_version;

  -- 重复检测（UNIQUE约束理论上已禁止，此查询作为独立核验）
  SELECT symbol, target_interval, target_bar_close_time, feature_set_version, revision_number, count(*)
  FROM public.feature_records
  WHERE symbol='ETHUSDT' AND target_interval='15m'
  GROUP BY symbol, target_interval, target_bar_close_time, feature_set_version, revision_number
  HAVING count(*) > 1;

  -- 缺口检测（候选点按24h节奏每4小时=14,400,000ms一个，相邻间隔应恒等于该值）
  SELECT target_bar_close_time,
         target_bar_close_time - lag(target_bar_close_time) OVER (ORDER BY target_bar_close_time) AS gap_ms
  FROM public.feature_records
  WHERE symbol='ETHUSDT' AND target_interval='15m' AND feature_set_version='v1.4b-unified-1'
  ORDER BY target_bar_close_time;
  ```
- **Phase 5依赖声明**：**Phase 5不得在本阶段`status='SUCCEEDED'`且经上述查询确认覆盖完整前启动**——见§E Go/No-Go门禁新增条款。

### Phase 5：历史回放

- **输入**：Phase 4产出的`dataset_version`；**Phase 4.5已成功完成且覆盖确认**
- **前置条件**：Phase 4的Manifest已`SUCCEEDED`；**Phase 4.5已`SUCCEEDED`且`public.feature_records`覆盖`[researchFrom,researchTo)`全部24h节奏点（见Phase 4.5核验查询模板）**；`validateReplayRange`要求执行时刻的真实UTC时间 ≥ `researchTo + 72h`
- **命令模板**：
  ```
  DATABASE_URL=<research_db_url> \
    npm run validation:walk-forward -- \
    --symbol ETHUSDT --from <researchFrom> --to <researchTo> --horizons 24h,72h \
    --algorithm-version v1.4c-server-po-rule-1 \
    --dataset-version <Phase4产出的dataset_version> \
    --rule-version v1.4c-po-rule-1 \
    --weight-version v1.4c-server-weight-1 \
    --evaluation-version v1.4c-outcome-evaluation-1 \
    --split 50/25/25
  ```
  （**注意**：本阶段`--from`是`researchFrom`，**不是**Phase 4的`backfillFrom`——见§C.2区分；本阶段`--algorithm-version`是`v1.4c-server-po-rule-1`，与Phase 4.5的`--algorithm-version=v1.4b-feature-engine-1`是不同含义、不同取值，不得互相代入，见Phase 4.5红线说明）
- **输出**：`validation_run_id`；`replay_generation_runs`/`replay_evaluation_runs`/`replay_snapshots`/`replay_outcome_events`记录
- **通过条件**：命令返回`plan`且未抛出异常，`validation_runs.status='SUCCEEDED'`；**新增（本轮修复）**：`plan.results`中`phase==='generation'`且`status==='BLOCKED'`且`reason==='FEATURE_RECORD_MISSING'`的条目数须为**0**（若确有真实、有限、有据可查的原因需要允许少量缺失，须依据§K.1第7项冻结的允许阈值判断，**不得事后解释**）；`replay_generation_runs.blocked_count`聚合值不得等于本次请求的总节奏点数（即不得100% BLOCKED）；每个`(horizon,report_scope)`报告的`directionEffectiveSampleCount`/`pathEffectiveSampleCount`不得为0（若为0须先排查是否为Feature覆盖问题，而非直接认定为"真实市场无信号"）
- **阻塞条件**：§4.1a manifest八步校验任一失败（数据集漂移等）；`RESUME_CHECKPOINT_INCONSISTENT`；生成/评估阶段未处理异常（`validation_runs.status`转为`FAILED`，`blocked_reasons`记录阶段/节奏点）；**新增**：`FEATURE_RECORD_MISSING`超过§K.1第7项冻结的允许阈值（若冻结规范未规定阈值，视为要求严格为0，任何非零出现即为阻塞，须回到Phase 4.5核验覆盖缺口，不得放行）
- **失败后恢复**：`--resume <validation_run_id>`（省略参数视为沿用原run，显式传入且不一致则`RESUME_PARAM_MISMATCH`拒绝；`weight-version`/`evaluation-version`每次仍须显式提供且须与原run已产生记录一致，具体规则见Phase 6）；**已到达终态(SUCCEEDED/FAILED)的run禁止再次resume**
- **是否产生数据库写入**：**是**（`historical_validation.validation_runs`/`replay_generation_runs`/`replay_evaluation_runs`/`replay_snapshots`/`replay_outcome_events`，全部只写`historical_validation` schema，不触碰生产`forecast_*`四表）

### Phase 6：Evaluation（已包含于Phase 5单一CLI调用内，独立列出以满足审查颗粒度）

- 说明：`validation:walk-forward`内部对每个节奏点顺序执行"生成→评估"（见`cli-entry.js` `runWalkForward`循环体），不存在独立的"evaluation单独命令"——本阶段与Phase 5共享同一次调用与同一份产出。
- **evaluation-version resume规则（本轮修正措辞，精确对应`checkResumeVersionConsistency`真实语义，`cli-entry.js`第349-399行原文核对）**：
  1. 若该`validation_run_id`名下**至今尚无任何**成功生成的snapshot（即`priorEvaluationVersions.length===0`），则`--resume`时可以自由提供**任意**`--evaluation-version`值（含全新值），会被接受并成为该run自此以后的唯一`evaluation_version`。
  2. 若该run名下**已存在恰好一个**`evaluation_version`的历史记录（`priorEvaluationVersions.length===1`），`--resume`时提供的`--evaluation-version`**必须**与该已有值完全一致，否则拒绝并返回`RESUME_EVALUATION_VERSION_MISMATCH`。
  3. 若该run名下**已存在多个不同**`evaluation_version`的历史记录（`priorEvaluationVersions.length>1`，理论上不应发生，但代码作为纵深防御检查），**无论此次提供什么值都会被拒绝**，返回`RESUME_MIXED_EVALUATION_VERSIONS`。
  4. **不存在"任何时候都能挂载全新evaluation-version"这回事**——只有情形1（该run从未产生过任何评估记录）才允许自由指定；一旦该run已经在某个`evaluation_version`下产生过评估结果，后续`--resume`只能延续同一版本，若确需切换到新`evaluation_version`评估同一批快照，必须发起一个**全新的**`validation_run`（不得复用旧`validation_run_id`），新旧结果并列保留。
  5. `weight-version`适用完全相同的三态规则（`checkResumeVersionConsistency`同一函数内`priorWeightVersions`逻辑对称）。
- **通过/阻塞/恢复条件**：与Phase 5相同。

### Phase 7：报告与审计产物

- **输入**：Phase 5/6完成后的`validation_run_id`
- **命令模板**：报告在`runWalkForward`内部`!dryRun`分支自动调用`buildValidationReports`并写入`validation_reports`（见`cli-entry.js`），**不是**独立CLI命令；审计产物通过只读SQL提取：
  ```
  psql "$RESEARCH_DB_URL" -c "SELECT * FROM historical_validation.validation_reports WHERE validation_run_id='<id>';"
  psql "$RESEARCH_DB_URL" -c "SELECT * FROM historical_validation.validation_runs WHERE validation_run_id='<id>';"
  ```
- **前置条件**：Phase 5/6非dry-run且`SUCCEEDED`
- **输出**：每个`(horizon,report_scope)`组合一份`validation_reports`行（24h/72h × ALL/TRAIN/VALIDATION/TEST，共8份）
- **通过条件**：8份报告均已生成，`content_hash`存在
- **阻塞条件**：Phase 5/6未成功完成则不会产生报告
- **失败后恢复**：报告表允许覆盖写（分类C），可安全重新生成
- **是否产生数据库写入**：**是**（仅`validation_reports`，覆盖写语义）

### Phase 8：独立复核

- **输入**：Phase 7全部报告 + Phase 0-7全部审计记录
- **命令模板**：无固定命令；由**非执行者本人**的独立审查者，仅依据仓库代码+`historical_validation`schema只读查询，复现§G全部指标并核对§H偏差清单；**须额外用Phase 4.5"正式执行前核验查询模板"重新核对`public.feature_records`覆盖完整、`FEATURE_RECORD_MISSING`未超出§K.1第7项冻结的允许阈值**
- **前置条件**：Phase 7完成
- **输出**：独立复核结论文档（含是否发现§H任一偏差迹象）
- **通过条件**：复核者能独立复现report数字（对比`content_hash`一致）；未发现§H偏差迹象
- **阻塞条件**：复核者无法复现（数据/流程不透明）；发现任一§H偏差迹象
- **失败后恢复**：视具体问题回退到相应Phase重跑
- **是否产生数据库写入**：否（只读复核）

### Phase 9：CEO接受或拒绝结论

- **输入**：Phase 8独立复核结论
- **命令模板**：无（人工决策）
- **前置条件**：Phase 8通过
- **输出**：CEO对本次180天正式历史研究结论的**接受**或**拒绝**决定，及后续行动方向（继续研究/调整规则重新走独立`rule_version`/终止/其他）
- **通过条件**：CEO显式记录决定
- **阻塞条件**：无决定记录时，不得默认视为"通过"
- **失败后恢复**：不适用（终点阶段）
- **是否产生数据库写入**：否

---

## E. Go/No-Go 门禁

**分两组：Phase 4（正式回填）开始前必须满足第1-10条；Phase 5（历史回放）开始前额外必须满足第11-15条（Historical Feature Backfill相关）。**

### E.1 Phase 4开始前（原有10条，不变）

1. main SHA已锁定并在启动脚本中显式记录（`git rev-parse HEAD`），若与本方案设计基线`4a30a69`不同，须重新核对本方案是否仍然准确。
2. 工作树`git status --short`为空。
3. §B配置清单已冻结（Phase 1产出），无占位符残留。
4. **数据库备份或可恢复措施**：正式回填/Manifest构建前，对`eth_alpha_v14d_test`执行一次`pg_dump`基线备份（只读操作，不修改现状），确保任何后续问题可追溯对比。
5. Phase 3数据完整性核查确认待回填范围清晰、无歧义。
6. Phase 2 dry-run通过，无异常。
7. Phase 0确认磁盘/连接数余量充足（§C.6）。
8. 不存在P0/P1（本文档§1已确认此刻为NONE；正式执行前须重新核实，因main可能已推进）。
9. **正式研究获得单独CEO授权**（`FORMAL_180_DAY_RESEARCH_AUTHORIZED`由NO改为YES，须独立于本方案文档的批准动作）。
10. **数据库连接环境变量已按各CLI真实契约设置，且已通过Phase 0/连接后二次核验确认目标库精确为`eth_alpha_v14d_test`**（本轮修正NEW-P1-1，`V14D_DATABASE_IDENTITY`与本条无关，见§D开头说明）：`backfill:market-bars`/`dataset:build-manifest`/`validation:walk-forward`（Phase 2/4/5）经`loadConfig()`只读`DATABASE_URL`；`features:backfill-historical`（Phase 4.5）只读`TEST_DATABASE_URL`（不接受`DATABASE_URL`回退）。**变量已设置**只是前提，真正的通过条件是`createGuardedResearchPgPool`在建连前的库名声明校验与建连后`SELECT current_database()`二次核验均已实际通过（而非仅凭变量存在即视为已验证）。

### E.2 Phase 5（历史回放）开始前额外新增（本轮修复，对应P0-1）

11. **Historical Feature Backfill（Phase 4.5）已成功完成**——`runHistoricalFeatureBackfill`返回`status='SUCCEEDED'`，`summary.blockedPoints===0`且`summary.failedPoints===0`。
12. **`public.feature_records`覆盖完整研究窗口**——用Phase 4.5"正式执行前核验查询模板"确认`min(target_bar_close_time)`/`max(target_bar_close_time)`覆盖`[researchFrom,researchTo)`且无缺口（相邻`target_bar_close_time`间隔恒为14,400,000ms）、无重复。
13. **symbol/interval/feature_set_version/algorithm_version/dataset_version与冻结配置一致**——即`public.feature_records`实际持久化的这五个字段值精确等于`ETHUSDT`/`15m`/`v1.4b-unified-1`/`v1.4b-feature-engine-1`/Phase 4产出的`dataset_version`，不存在混杂多个版本值的行。
14. **`FEATURE_RECORD_MISSING`不是全量或大规模出现**——若Phase 4.5本身已`SUCCEEDED`且覆盖核验通过，Phase 5理论上不应再遇到该错误；若仍出现，须先判定原因（例如Phase 5的`--from`/`--to`与Phase 4.5实际覆盖范围不一致），不得直接放行。允许的**有限**缺失阈值与原因见§K.1第7项`PRE_EXECUTION_DECISION_REQUIRED`——冻结规范未规定该阈值，默认立场是**严格为0**，除非CEO给出明确、有限、书面记录原因的例外。
15. **有效feature记录数量和覆盖边界通过核验**——`count(*)`量级应与§C.1"研究窗口bar数"表中ETHUSDT 15m相应行（180×96=17,280，按24h节奏点粒度换算后的预期数量另需在Phase 4.5实际执行时结合`enumerateHistoricalFeaturePoints`的24h-rhythm间隔重新推算，本方案不预先编造具体期望值，留待Phase 4.5输出的`summary.requestedPoints`作为权威期望值）一致，且`summary.generatedPoints+summary.alreadyPresent`应等于`summary.requestedPoints`。

### E.3 运行时间与资源预算（本轮新增，对应P2-3，正式执行前必须取得，本方案不得发明数值）

16. 预计`market-bars`回填耗时——`ENVIRONMENT_VALIDATION_REQUIRED`（取决于Binance API实际限速/网络延迟，代码层面只冻结了退避策略参数`maxRetries`/`backoffBaseMs`/`backoffCapMs`，未冻结任何总耗时估算公式）。
17. 预计Historical Feature Backfill耗时——`ENVIRONMENT_VALIDATION_REQUIRED`（取决于`--batch-size`与单点`generateFeatureRecord`计算耗时的实测值，代码未提供耗时估算）。
18. 预计`validation:walk-forward`/replay耗时——`ENVIRONMENT_VALIDATION_REQUIRED`（取决于节奏点总数×单点生成+评估耗时的实测值）。
19. 预计evaluation/report耗时——`ENVIRONMENT_VALIDATION_REQUIRED`（`buildValidationReports`对8份报告的聚合查询耗时取决于`replay_snapshots`/`replay_outcome_events`实际行数）。
20. 数据库容量增长预估——§C.6已给出量级公式（约8-16MB market_bars + 约8-12MB manifest_members jsonb + `feature_records`/`replay_*`表的增量，后者本轮未给出具体量级公式，标记`ENVIRONMENT_VALIDATION_REQUIRED`）。
21. 磁盘空间——`ENVIRONMENT_VALIDATION_REQUIRED`（Phase 0`df -h`只能取得执行时刻的实际值）。
22. 内存——`ENVIRONMENT_VALIDATION_REQUIRED`（代码层面`pg.Pool`固定`max:10`连接，未见任何进程级内存上限配置，实际内存占用取决于Node进程本身与并发查询结果集大小，需执行环境实测）。
23. CPU——`ENVIRONMENT_VALIDATION_REQUIRED`（代码未做任何CPU资源预留/限制声明，回填/回放均为单进程顺序执行，无并行计算，CPU需求预计不高但未经实测量化）。
24. PostgreSQL连接余量——`ENVIRONMENT_VALIDATION_REQUIRED`（代码固定`pg.Pool max:10`，服务器`max_connections`总量与当前其他连接占用需环境查询，见Phase 0命令模板可扩展）。
25. API速率限制——已有代码层面的退避机制（`maxRetries`/`backoffBaseMs`/`backoffCapMs`），但Binance公开REST的实际限速阈值/时间窗口需以Binance官方文档为准，本方案不擅自引用具体数字。
26. 可接受维护窗口——`ENVIRONMENT_VALIDATION_REQUIRED`，属纯运维/CEO排期决定，不属于研究契约本身，与研究结论有效性无关。
27. 任务超时与中断恢复预算——`ENVIRONMENT_VALIDATION_REQUIRED`；代码本身**不设**任何超时上限（各CLI均为长时间运行的前台进程，无内置timeout），实际可接受的最长运行时长/何时判定为"卡住需要人工介入"属于运维决策，不属于研究契约。

---

## F. 中止与恢复

| 情形 | 处理规则 |
|---|---|
| checkpoint | `backfill_batches.last_completed_open_time`（回填侧）；**`feature_records`已持久化行本身即隐式checkpoint（Historical Feature Backfill侧，无独立游标列，见下）**；`replay_generation_runs`/`replay_evaluation_runs`终态记录（回放侧，见`computeResumeCheckpoint`） |
| resume | `--resume <backfill_batch_id>`（严格同symbol/**单一**interval/range/as-of，**不得携带多个`--intervals`**，见Phase 4"失败后恢复"红线）；**`--resume-after <referenceTime>`（Historical Feature Backfill侧，手动指定游标，非必需——见Phase 4.5）**；`--resume <validation_run_id>`（省略参数继承原run，显式且不一致则拒绝；`weight-version`/`evaluation-version`三态规则见Phase 6） |
| 幂等性 | `market_bars`：`ON CONFLICT(vintage_id) DO NOTHING`；**`feature_records`：`saveHistoricalFeatureRecord`对内容一致的已存在记录返回`ALREADY_PRESENT`（应用层幂等判定，非数据库`ON CONFLICT`；内容不一致则`HISTORICAL_FEATURE_CONFLICT`，须人工排查，不得自动重试覆盖）**；`replay_snapshots`/`replay_outcome_events`：`ON CONFLICT DO NOTHING`；`dataset_manifests`：`ON CONFLICT(dataset_version) DO NOTHING`（同内容重复构建幂等返回既有行） |
| 不连续checkpoint | `computeResumeCheckpoint`检测到"后面的点已完成但前面未完成"时`fail closed`（`RESUME_CHECKPOINT_INCONSISTENT`），**不得**猜测性选择恢复边界 |
| 部分成功 | `backfill_batches.status='ATTENTION_REQUIRED'`（完整性检测失败，不可自动resume，须人工判定后决定是否需要全新批次重跑）；`validation_runs.status='FAILED'`（`blocked_reasons`记录失败阶段） |
| 数据污染 | 若Phase 8/独立复核发现`market_bars`存在与本次研究窗口重叠但来源可疑的行，须暂停并对照Phase 0备份排查，不得在未查明前继续 |
| 数据源异常 | Binance API错误/限速：既有指数退避+`maxRetries`策略处理，超限后批次标记`FAILED`，需人工判断是否重试 |
| 数据库连接异常 | 各CLI在`finally`块中确保`pool.end()`；`withManifestPersistenceConnection`保证异常路径下`client.release()`不泄漏（此前独立复审已验证） |
| 失败状态 | 见上，均落在`FAILED`/`ATTENTION_REQUIRED`两类终态，`error_code`/`blocked_reasons`结构化记录 |
| 清理规则 | 若确需彻底废弃某次`validation_run`，使用`cleanupSingleRun`（六表事务性DELETE，**不删除**`backfill_batches`/`dataset_manifests`，二者可能被其他run共享或独立永久保留）；`backfill_batches`/`dataset_manifests`本身**无**清理路径（immutable，只增不删） |
| 何时必须从头开始 | Manifest构建`REJECTED`且原因是依赖数据本身有不可修复缺口（如Binance历史数据缺口无法补齐）；**Historical Feature Backfill出现`HISTORICAL_FEATURE_CONFLICT`且排查后确认是`feature_records`历史行内容本身有误（而非本次重算逻辑有误）**；`RESUME_CHECKPOINT_INCONSISTENT`且无法通过既有审计记录判定安全恢复点；Phase 8发现数据污染且无法排除 |

---

## G. 研究指标与接受标准

**红线：不得仅以方向胜率作为通过标准；不得在结果不理想后补定阈值（见§H）。**

| 类别 | 具体指标 | 数据来源 | 是否已有量化通过门槛 |
|---|---|---|---|
| 1. 工程有效性 | 8份`validation_reports`全部生成；`content_hash`可复现；Phase 8独立复核一致 | Phase 7/8 | 是（§E已列） |
| 2. 数据有效性 | `sampleSufficient`（相对`MIN_SAMPLE_THRESHOLDS`={24h:30,72h:10}）；`purgedStraddlingCount`合理性 | `report-builder.js` | 是（30/10已冻结） |
| 3. 预测质量（方向分类） | `upDownRangeBreakdown`各UP/DOWN/RANGE组的`directionAccuracy` | 同上 | **否**——冻结规范未定义"多少准确率算通过"，**PRE_EXECUTION_DECISION_REQUIRED** |
| 4. 方向分类表现 | 同上，按`report_scope`(ALL/TRAIN/VALIDATION/TEST)对比稳定性 | 同上 | 同上，稳定性判据未冻结，**PRE_EXECUTION_DECISION_REQUIRED** |
| 5. RANGE表现 | RANGE组`directionAccuracy`（即"正确判定为RANGE"比例） | 同上 | 同上 |
| 6. 不同预测周期表现 | 24h vs 72h分别统计，不得合并 | 同上 | 结构已冻结（分开报告），阈值未冻结 |
| 7. 不同市场状态表现 | `poStateBreakdown`按9个PO_\*状态分组的样本数/准确率 | `po-diagnostic.js` | 结构已冻结，"样本不足"标注已冻结（`MIN_SAMPLE_THRESHOLD_NOT_FROZEN`），**按PO状态细分的门槛本身仍未冻结** |
| 8. 成本后表现 | — | — | **不适用**——见§B"成本假设"，代码未建模，若无独立设计则本项本轮**不产出** |
| 9. MFE/MAE | `replay_outcome_events.mfe`/`mae`（复用`outcome-engine.js`既有公式） | 同上 | 无固定"通过阈值"，属描述性统计 |
| 10. 样本量 | `directionRawSampleCount`/`directionEffectiveSampleCount`/`pathRawSampleCount`/`pathEffectiveSampleCount` | 同上 | 是（充分性判据同第2项） |
| 11. 置信区间/不确定性 | **代码未提供**——`checkSampleSufficiency`只做二元充分性判断(`isCalibrated:false`)，不产出置信区间 | 同上 | **PRE_EXECUTION_DECISION_REQUIRED**：若需要置信区间/不确定性量化，须独立设计统计方法，不属于现有代码能力，本方案不得擅自发明公式 |
| 12. 策略是否值得继续研究 | 综合1-11项的人工判断 | Phase 9 CEO决策 | **PRE_EXECUTION_DECISION_REQUIRED**：综合判断标准本身（例如"多少个PO状态达到样本充分且准确率超过随机基线才算值得继续"）未冻结，留待Phase 9由CEO结合Phase 8独立复核意见决定，不得由执行脚本自动判定 |

---

## H. 防止研究偏差

| 偏差类型 | 本方案/既有实现的防护 |
|---|---|
| look-ahead bias | `researchAvailability=close_time`+`fetched_at<=回放发起时刻`双重约束；`validateReplayRange`强制`--to<=当前真实UTC-72h`；SQL级`close_time<=fixed_as_of` |
| data leakage | Manifest内容寻址+`vintage_id=ANY(governedVintageIds)`治理，禁止读取未治理bar；契约版本2强制ETH+BTC依赖集合精确匹配，不得多读/少读 |
| survivorship bias | 本研究只涉及ETHUSDT/BTCUSDT两个持续存在的现货交易对，不涉及"选股"场景，该偏差类型在当前研究设计下**不适用**（如实说明，非回避） |
| parameter tuning leakage | `algorithm-version`/`rule-version`/`weight-version`/`threshold-formula`版本在`validation_runs`创建时冻结写入，运行中不可修改；train段结果不得反过来调整用于validation/test段的规则（§六红线：如需调整PO规则须走独立新`rule_version`+全新`validation_run`） |
| cherry-picking | Phase 7固定产出全部8份`(horizon,report_scope)`报告，不允许选择性只生成/只展示部分组合；`errorAttributionSummary`要求披露`notEvaluableCauses`（5类结构性不可评估原因），不得隐藏 |
| 重复试验 | 同一`(instrument,horizon,referenceCloseTime,algorithmVersion,datasetVersion)`天然幂等去重（`ON CONFLICT DO NOTHING`），重复调用不产生"多次抽样选好看结果"的空间；若确需对比不同规则版本，必须是独立`rule_version`+独立`validation_run`，新旧结果**并列保留**，不得覆盖删除旧版本 |
| 事后修改阈值 | `directionThreshold`/`scenarioWeights`公式与参数在代码层冻结（§B），Phase 9 CEO决策**不得**据此反过来修改`threshold-formula.js`常量后重新宣称"本次研究通过"——如需调整阈值，须走独立规范修订+全新代码版本+全新`validation_run` |
| 多重比较 | 8份报告固定粒度(horizon×report_scope)，不额外做更细粒度的"多切法选好结果"式比较；PO状态9类分组是结构性冻结的分组方式，非按结果挑选的事后分组 |
| 结果不理想时选择性隐藏 | §D Phase 8要求**独立于执行者**的复核，Phase 9 CEO决策基于Phase 7全部8份报告+`errorAttributionSummary`，**不得**只呈报部分`report_scope`或部分horizon；`validation_runs`/`replay_snapshots`/`replay_outcome_events`均为不可变审计记录（分类A/B），执行者事后无法悄悄修改已产生的原始记录 |

---

## I. 产物清单（正式研究完成后必须保留）

| 产物 | 存储位置/形式 |
|---|---|
| run ID | `validation_runs.validation_run_id` |
| 代码SHA | Phase 0记录的`git rev-parse HEAD` |
| 配置 | Phase 1配置清单文件 |
| manifest | `dataset_manifests`行（`dataset_version`/`dependency_set`/`manifest_members`等，内容寻址永久保留） |
| DataVintage | `manifest_members`内每条`vintageId`/`rowContentHash`；`replay_snapshots`/`replay_outcome_events`的`research_data_vintage`字段 |
| 数据完整性报告 | `dataset_manifests.integrity_check_result`列（契约版本2下承载`perDependencyIntegrityCheckResult`）与`dataset_manifests.per_interval_record_count`列（承载`perDependencyRecordCount`）——**本轮修正**：此前版本曾将二者映射写反，本轮已重新核对`server/src/validation-replay/dataset-manifest-v2.js` `persist()`函数的INSERT参数顺序与`server/src/db/postgres.js`第132行`verifyHistoricalFeatureDataset`的字段映射（`perDependencyRecordCount:manifest.per_interval_record_count`，`perDependencyIntegrityCheckResult:manifest.integrity_check_result`），确认上述映射为准确的唯一正确对应关系；`backfill_batches`各批次记录；**新增（Phase 4.5）**：`public.feature_generation_runs`各次尝试记录 |
| replay结果 | `replay_snapshots`/`replay_generation_runs` |
| **历史Feature记录（Phase 4.5新增产物）** | `public.feature_records`（`content_hash`/`source_vintage_refs`/`source_revision_refs`/`availability`字段承载可复现性证据） |
| evaluation结果 | `replay_outcome_events`/`replay_evaluation_runs` |
| report | `validation_reports`8份 |
| audit记录 | 全部`historical_validation`表本身即审计记录（B/A两类不可变分类） |
| 失败/阻塞记录 | `backfill_batches.error_code`；`validation_runs.blocked_reasons`（结构化jsonb数组） |
| 命令和时间 | 执行时的实际命令行（含全部参数）+`started_at`/`finished_at`时间戳 |
| 数据库版本 | Phase 0记录的`schema_migrations`版本列表（001-007） |
| 环境摘要 | Phase 0核验记录（DB身份、磁盘、`pg_database_size`等） |
| 复核结论 | Phase 8独立复核文档 + Phase 9 CEO决策记录 |

---

## J. 授权边界

```
FORMAL_180_DAY_RESEARCH_STATUS = NOT_STARTED
FORMAL_180_DAY_RESEARCH_AUTHORIZED = NO
V1_5_AUTHORIZED = NO
PRODUCTION_DEPLOYMENT_AUTHORIZED = NO
AUTOMATIC_TRADING_AUTHORIZED = NO
```

本方案文档本身**不构成**上述任一授权。任何阶段的实际执行均需独立于本文档的、明确的CEO授权，且授权范围以本文档Go/No-Go门禁（§E）第9条为准。

---

## K. 执行前决策清单汇总（本轮新增，严格区分"影响研究结论有效性"的CEO决策与"纯运维、不改变研究契约"的操作决策）

### K.1 PRE_EXECUTION_DECISION_REQUIRED（影响研究契约/结论有效性，必须由CEO决定，本方案与任何执行脚本均不得擅自设定）

1. `researchFrom`/`researchTo`具体UTC日历日期（确定规则见§B，规则已冻结，数值本身未定）。
2. 成本/手续费/滑点假设范围（`outcome-engine.js`/`forecast-contract.js`代码零建模，见§B；需CEO明确本研究是否只产出pre-cost结论）。
3. 方向分类准确率/稳定性的量化通过阈值（§G第3/4/5项，冻结规范未规定数值）。
4. 置信区间/不确定性量化方法（§G第11项，`checkSampleSufficiency`只做二元充分性判断，不提供CI计算，现有代码无此能力）。
5. "策略是否值得继续研究"的综合判断标准（§G第12项，留待Phase 9由CEO结合Phase 8独立复核意见决定）。
6. `eth_alpha_v14d_test`当前状态是否需要先完成一次独立授权的清理/重建（Phase 0阻塞条件）。
7. **（本轮新增，对应P0-1修复）`FEATURE_RECORD_MISSING`允许的有限缺失阈值与具体允许原因**——冻结规范未规定该阈值；本方案的默认立场是Phase 5/§E.2第14条要求**严格为0**；若确需允许非零但有限的缺失，必须由CEO在正式执行前给出**书面、有限、附带明确原因**的例外阈值，**不得由执行者在实际出现缺失后倒推一个"看起来合理"的数值**（即不得事后定阈值）。

### K.2 PRE_EXECUTION_OPERATIONAL_DECISION_REQUIRED（纯运维/资源规划参数，不改变研究契约与结论有效性，代码已冻结默认值的直接引用，不需要单独走CEO研究决策流程）

1. **Historical Feature Backfill的`--batch-size`**——代码已冻结默认值**25**（`historical-feature-backfill-cli.js`第6行`parseHistoricalBackfillArgs`），本方案建议直接采用该默认值；允许范围`[1,1000]`（`validateHistoricalBackfillOptions`第24行），调整只影响单批处理数量与进度反馈粒度，**不改变最终计算结果或研究结论**，不需要固定为某个"更方便"的数字，也不需要单独走CEO决策——沿用代码默认值即可，仅在有具体性能/超时原因时才调整。
2. **`--resume-after`使用策略**——见Phase 4.5"checkpoint/resume行为"：默认建议**不使用**（依赖`saveHistoricalFeatureRecord`的`ALREADY_PRESENT`幂等特性，直接用相同`--from`/`--to`重跑即可安全恢复，无需手动计算游标）；仅在需要节省重跑耗时时才手动指定，取值来源见Phase 4.5"失败后恢复"。
3. **§E.3运行时间/资源预算全部12项（第16-27条，均标记`ENVIRONMENT_VALIDATION_REQUIRED`）**——均需在正式执行前实测/查询取得，不改变研究结论有效性，只影响排期与资源规划，不需要CEO就具体数值做研究性决策（是否愿意投入该资源仍是运维/预算层面的决定，但不属于"研究契约"范畴）。

---

## 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.4d-180d-plan-draft-1 | 2026-08-04 | 初稿：基于`main@4a30a69`只读现状核查（CLI入口、依赖矩阵、resume/checkpoint、dry-run、完整性检测、报告字段等均取自当前代码原文），制定180天正式历史研究九阶段执行方案、冻结契约、Go/No-Go门禁、偏差防护与产物清单；标记全部未冻结项为`PRE_EXECUTION_DECISION_REQUIRED`，不擅自发明数值；本轮未执行任何研究、未写入数据库 |
| v1.4d-180d-plan-draft-2 | 2026-08-04 | 第一轮定向修复（独立终审发现1项P0/1项P1/4项新增P2后的修复）：①**修复P0-1**——新增"Phase 4.5：Historical Feature Backfill"必需阶段（`features:backfill-historical`/`historical-feature-backfill-cli.js`，写入生产`public.feature_records`，Phase 5的`findExactFeatureForReplay`唯一数据来源），本轮原文核对`--feature-version`（`FEATURE_SET_VERSION='v1.4b-unified-1'`）与本阶段专属`--algorithm-version`（`FEATURE_ALGORITHM_VERSION='v1.4b-feature-engine-1'`，**与Phase 5的`--algorithm-version='v1.4c-server-po-rule-1'`是不同维度、不得混淆**）三方（代码常量/注释/既有测试）一致，无冲突；同步更新§1现状核查表、§E Go/No-Go（新增E.2五条）、§C.7交叉引用、Phase 5通过/阻塞条件（新增`FEATURE_RECORD_MISSING`须为0）、§F中止恢复（新增feature backfill幂等/resume行为）、§I产物清单（新增`feature_records`/`feature_generation_runs`）、Phase 8独立复核（新增feature覆盖核验）；②**修复P1-1**——更正Phase 4"失败后恢复"，明确`--resume`只能配合单一`--intervals`使用（`RESUME_INTERVALS_CONFLICT`），补充禁止示例与正确单周期恢复示例；③**修复P2-1**——更正§I"数据完整性报告"行`integrity_check_result`/`per_interval_record_count`与`perDependencyIntegrityCheckResult`/`perDependencyRecordCount`的字段映射（此前写反）；④**修复P2-2**——更正§1"失败状态/blocked reasons"行，区分`validation_runs.status`的schema允许值{RUNNING,SUCCEEDED,FAILED,PARTIAL}与当前代码实际只产生的{RUNNING,SUCCEEDED,FAILED}；⑤**修复P2-3**——新增§E.3运行时间与资源预算12项，全部标记`ENVIRONMENT_VALIDATION_REQUIRED`，不发明具体数值；⑥**修复P2-4**——重写Phase 6，精确复述`checkResumeVersionConsistency`三态规则（无历史记录时可自由指定/已有恰好一个记录时必须一致/已有多个记录时一律拒绝），明确排除"任何时候都能挂载新evaluation-version"的误读；⑦新增§K执行前决策清单汇总，区分`PRE_EXECUTION_DECISION_REQUIRED`（含本轮新增第7项`FEATURE_RECORD_MISSING`阈值）与`PRE_EXECUTION_OPERATIONAL_DECISION_REQUIRED`（`--batch-size`引用代码真实默认值25、`--resume-after`策略、运行时间资源预算）；⑧修正两处此前遗留的错误章节引用（"§三.12/§三.13"改为实际存在的"§C.6/§E.3"）；本轮未处理三个仓库既有P2，未修改生产代码/测试/五份冻结文档/Migration/Closure Report/Addendum/workflow，未执行任何回填/Feature Backfill/回放/研究，未连接任何数据库 |
| v1.4d-180d-plan-draft-3 | 2026-08-04 | 第二轮定向修复（独立二轮复审发现NEW-P1-1后的修复，仅修正数据库连接环境变量路由描述，不改动已闭环的原1项P0/1项P1/4项P2实质内容）：本轮原文重新核对`server/src/backfill/backfill-cli-entry.js`/`server/src/validation-replay/dataset-manifest-cli-entry.js`/`server/src/validation-replay/cli-entry.js`/`server/src/features/historical-feature-backfill-cli.js`/`server/src/config.js`/`server/src/db/research-database-guard.js`/`server/scripts/v1-4d-manifest-inventory.mjs`及各自测试，确认：`backfill:market-bars`/`dataset:build-manifest`/`validation:walk-forward`（Phase 2/4/5）均经`loadConfig()`只读`DATABASE_URL`；`features:backfill-historical`（Phase 4.5）只读`TEST_DATABASE_URL`（不接受`DATABASE_URL`回退）；`assertExplicitResearchDatabaseIdentity`/`V14D_DATABASE_IDENTITY`**只被**独立诊断脚本`v1-4d-manifest-inventory.mjs`使用，与Phase 2/4/4.5/5四个正式流程CLI**均无关**。据此：①修正§D开头红线声明，删除"所有阶段均通过`assertExplicitResearchDatabaseIdentity`路由、必须设置`V14D_DATABASE_IDENTITY`"的错误全称断言，改为按CLI真实契约分别说明数据库URL环境变量来源与`createGuardedResearchPgPool`两层保护（库名声明校验+连接后`current_database()`二次核验）；②Phase 2/4（含Phase4"正确做法"resume示例）/Phase 5命令模板统一将`V14D_DATABASE_IDENTITY=research TEST_DATABASE_URL=<research_db_url>`改为`DATABASE_URL=<research_db_url>`（7处）；③Phase 4.5命令模板保持`TEST_DATABASE_URL=<research_db_url>`不变（与其真实代码契约一致）；④重写Phase 4.5"红线"对比措辞，不再声称"与Phase4/Phase5使用的CLI不同"，改为准确陈述四个CLI均不使用`V14D_DATABASE_IDENTITY`，唯一差异是数据库URL环境变量名不同；⑤重写§E.1第10条，删除对`V14D_DATABASE_IDENTITY`的误引用，改为按Phase分别列出真实环境变量并强调"变量已设置"不等同于"身份已验证"；⑥Phase 0/3/7的人工`psql`只读核查命令统一改用独立shell变量`$RESEARCH_DB_URL`（原`$TEST_DATABASE_URL`），并在Phase 0新增说明该变量与CLI内部读取的`DATABASE_URL`/`TEST_DATABASE_URL`无代码绑定关系，避免混淆；⑦全文重新grep`DATABASE_URL`/`TEST_DATABASE_URL`/`V14D_DATABASE_IDENTITY`/`assertExplicitResearchDatabaseIdentity`/`createGuardedResearchPgPool`确认修改后全文一致、无残留错误命令。本轮**未改动**Phase 4.5的位置、脚本名与参数、`feature-version`/`algorithm-version`/`dataset_version`绑定、`requiredContractVersion=2`、`feature_records`写入边界、`FEATURE_RECORD_MISSING`门禁与零有效样本阻断条件、单周期resume规则、字段映射、`PARTIAL`状态说明、§E.3十二项运行时资源核验、evaluation-version三态恢复规则、§K全部7+3项决策清单、130/180/365天窗口定义、全部授权状态字段（仍为NO/NOT_STARTED）；本轮未处理三个仓库既有P2，未修改生产代码/测试/五份冻结文档/Migration/Closure Report/Addendum/workflow，未执行任何回填/Feature Backfill/回放/研究，未连接任何数据库 |
