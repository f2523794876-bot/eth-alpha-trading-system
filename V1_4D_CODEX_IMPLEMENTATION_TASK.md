# V1_4D_CODEX_IMPLEMENTATION_TASK.md — V1.4D Codex 实施工单（冻结草案）

版本：v1.4d-task-draft-4（第三阶段定向修订：dataset_version改为完整SHA-256，新增哈希契约实施阶段核实任务，见变更记录）
基线：`main@eb89c49f0957617c453ea2c0d149afb55e97dad0`
角色：本文档是**Codex实施阶段**（未来批准后）的唯一权威工单，定义文件范围、模块划分、构建顺序、复用/禁止复用边界。本文档**本身不是编码**，本轮不执行任何一步，不创建分支/提交/PR。

---

## 1. 范围红线

### 1.1 允许新增的文件（实施阶段，本轮不创建）

```
server/migrations/005_v1_4d_historical_validation_schema.up.sql   — 创建 historical_validation schema 及**八张表**（dataset_manifests/validation_runs/backfill_batches/replay_snapshots/replay_generation_runs/replay_outcome_events/replay_evaluation_runs/validation_reports，本轮新增`dataset_manifests`并订正draft-2"七张表"计数为八张）。**建表顺序必须遵循外键依赖**（见 V1_4D_HISTORICAL_REPLAY_SPEC.md §三.0 冻结顺序：CREATE SCHEMA → **dataset_manifests（置于最前）** → validation_runs → backfill_batches → replay_generation_runs → replay_evaluation_runs → replay_snapshots → replay_outcome_events → validation_reports），`validation_runs`/`replay_snapshots`/`validation_reports`的`dataset_version`列必须建为指向`dataset_manifests(dataset_version)`的正式外键，不得按字母序或随意顺序建表导致FK报错。**`dataset_manifests.dataset_version`列本轮改为完整SHA-256格式（`v1.4d-sha256-{64位十六进制}`，不截断，见 V1_4D_HISTORICAL_REPLAY_SPEC.md §2.9.0）；`content_hash`列必须实现为Postgres生成列（`GENERATED ALWAYS AS (substring(dataset_version from 15)) STORED`），不得作为独立可写列**。
server/migrations/005_v1_4d_historical_validation_schema.down.sql — 对应回滚（DROP SCHEMA historical_validation CASCADE，不触碰public schema任何对象）

server/src/backfill/binance-kline-backfill.js   — Binance历史K线分页拉取+写入market_bars（复用现有 http/client.js、sources/binance.js、config.js，只新增回填专属编排逻辑）；`available_at`/`fetched_at`写入回填任务真实执行时间，不得复用`domain/normalize.js`第37行`availableAt:closeTime`的实时路径赋值逻辑（见 V1_4D_DATA_BACKFILL_SPEC.md §2.9）
server/src/backfill/backfill-cli-entry.js       — 回填CLI入口（对应 package.json 新增 script，如 backfill:market-bars）
server/src/backfill/integrity-check.js          — 回填前后gap/duplicate/out-of-order校验（可复用第一阶段审计用过的SQL模式，抽成可测试的纯函数+查询封装）；**本轮明确：`dataset-manifest-builder.js`必须复用本模块的检测逻辑，不得另写第二套gap/duplicate/out-of-order判定**

server/src/validation-replay/canonical-manifest-content.js — **本轮新增模块**：纯函数，实现 V1_4D_HISTORICAL_REPLAY_SPEC.md §2.9.1/§2.9.2 冻结的"被哈希内容对象"构造。**具体契约（本轮补充，闭环截断P1时一并冻结）**：
  · 字段选取严格对照§2.9.1冻结绑定字段清单（含本轮新增纳入哈希内容的`manifestHashAlgorithmVersion`）；
  · `manifestMembers`排序：`(intervalName, openTime, revisionNumber, vintageId)`四级键，`vintageId`为强制的最终决胜字段（§2.9.2）；
  · `backfillBatchIds`排序：去重后按UUID文本字典序（§2.9.2）；
  · **类型纪律（红线，§2.9.5）**：`open`/`high`/`low`/`close`/`volume`/`quoteVolume`等源自Postgres `numeric`的字段一律以字符串传入，禁止`Number()`转换；`dataFrom`/`dataTo`以ISO8601字符串传入，禁止传`Date`对象；
  · **不得**在本模块内重新实现JSON规范化/哈希算法本身，只负责"选哪些字段、按什么顺序排列、以什么类型传入"，哈希计算委托给`domain/hash.js canonicalJsonHash()`。
server/src/validation-replay/hash-contract-verification.test.js — **本轮新增任务（用户要求"不能仅在架构评审中标记为待确认P2，必须写入实施任务"）**：实施阶段**第一步**必须新增的单元测试文件（不是生产代码模块，是测试文件，但作为独立任务项列出以确保不被遗漏），针对**当时实际运行的**`server/src/domain/hash.js canonicalJsonHash()`重新核实 V1_4D_HISTORICAL_REPLAY_SPEC.md §2.9.4 记录的四项结论（对象键排序/数值稳定性/数组保序/哈希算法），构造具体断言用例（见 V1_4D_ACCEPTANCE_TESTS.md R27.9/R27.10）；**若届时`domain/hash.js`已变化导致任一结论不再成立，必须立即停止使用该函数，改为在`canonical-manifest-content.js`内部实现§2.9冻结契约的独立版本化编码（不修改`domain/hash.js`本身——它是生产多处复用的既有模块，不在本轮允许修改范围），并同步递增`manifest_hash_algorithm_version`**
server/src/validation-replay/dataset-manifest-builder.js   — **本轮新增模块**：`npm run dataset:build-manifest`对应的核心逻辑——调用`integrity-check.js`确认目标范围零缺口/零重复/零乱序（不通过则拒绝生成manifest）→ 调用`canonical-manifest-content.js`构造内容对象 → 调用`domain/hash.js canonicalJsonHash()`计算完整64字符`content_hash` → 按 V1_4D_HISTORICAL_REPLAY_SPEC.md §2.9.0 公式`v1.4d-sha256-{完整64位}`拼出`dataset_version`字符串（**不得截断**）→ `INSERT ... ON CONFLICT(dataset_version) DO NOTHING`写入`dataset_manifests`
server/src/validation-replay/dataset-manifest-verifier.js  — **本轮新增模块**：实现 V1_4D_HISTORICAL_REPLAY_SPEC.md §4.1a 冻结的八步强制校验流程（含resume/dry-run场景下的重新校验），供`cli-entry.js`在启动时调用，任一步失败即返回对应的`DATASET_*`错误码，调用方据此fail closed，不生成任何`replay_snapshot`/`replay_outcome_event`
server/src/validation-replay/dataset-manifest-cli-entry.js — `npm run dataset:build-manifest`的CLI参数解析入口（`--symbol`/`--intervals`/`--from`/`--to`），编排上述`dataset-manifest-builder.js`

server/src/validation-replay/research-availability.js   — researchAvailability查询封装（不修改bar-path-locator.js本身，见§3），**必须写入`research_availability_rule_version='v1.4d-research-availability-1'`到每条产出记录**（见 V1_4D_HISTORICAL_REPLAY_SPEC.md §2.3）
server/src/validation-replay/replay-generator.js         — 历史ForecastSnapshot回放生成（复用po-state-engine.js/forecast-contract.js/threshold-formula.js/bar-path-locator.js纯函数，写入historical_validation.replay_*表，**全部SQL语句必须schema-qualified**，见 V1_4D_HISTORICAL_REPLAY_SPEC.md §三.2）；**不落库`ActionPermission`字段**（该概念不适用于本表，见同文档§2.3）；**启动前必须先经`dataset-manifest-verifier.js`校验通过**，不得绕过直接生成
server/src/validation-replay/replay-evaluator.js         — 历史ForecastOutcomeEvent回放评估（复用outcome-engine.js纯函数）
server/src/validation-replay/purge.js                    — 实现 V1_4D_DATA_BACKFILL_SPEC.md §1.1 冻结的边界样本purge规则（剔除`targetStartTime<boundary<=targetEndTime`的跨界样本，不计入`report_scope IN ('TRAIN','VALIDATION','TEST')`，保留在`ALL`视图），供`report-builder.js`调用；**不得**修改`server/src/validation/walk-forward.js`的`splitTimeOrdered`本身来实现purge，purge是`splitTimeOrdered`结果之上的独立后处理步骤
server/src/validation-replay/report-builder.js           — 统计报告生成（复用server/src/validation/walk-forward.js全部导出 + 上述purge.js，产出`purged_straddling_count`等字段）
server/src/validation-replay/po-diagnostic.js            — PO_UNKNOWN诊断报告生成（见 V1_4D_HISTORICAL_REPLAY_SPEC.md §六，四类候选原因并列，不预设结论）
server/src/validation-replay/cli-entry.js                — npm run validation:walk-forward 对应入口，解析CLI参数、编排上述模块、实现dry-run/resume/`--split`默认切分/UTC格式与顺序校验/resume参数一致性校验/启动横幅/**§4.1a manifest八步校验（先于一切replay/outcome生成逻辑调用`dataset-manifest-verifier.js`）**（见 V1_4D_HISTORICAL_REPLAY_SPEC.md §四全节）
server/src/validation-replay/cleanup-single-run.js        — 实现单个`validation_run_id`的清理顺序（见 V1_4D_HISTORICAL_REPLAY_SPEC.md §三.1 冻结的六步DELETE顺序），供实施阶段人工调用，不接入任何自动化调度或CLI默认行为；**明确不删除`dataset_manifests`（见同文档§三.1本轮新增红线）**

server/tests/backfill/*.test.js                 — 回填单元/集成测试（未来测试阶段新增，本轮不创建）
server/tests/validation-replay/*.test.js        — 回放单元/集成测试（同上）
server/tests/postgres/v1-4d-*.integration.test.js — 真实PostgreSQL集成测试（同上，命名延续既有 postgres/v1-4c-*.integration.test.js 惯例）
```

### 1.2 禁止修改的文件（红线）

```
server/src/index.js                         — 生产bootstrap()入口，不得引入任何historical_validation/回放相关import
server/src/lifecycle.js                     — 不得修改
server/src/collector/*                      — 不得修改
server/src/forecast/generator-service.js    — 不得修改（回放不复用其类方法，见 V1_4D_HISTORICAL_REPLAY_SPEC.md §4.7"禁止复用"清单）
server/src/outcome/evaluator-service.js     — 不得修改（同上）
server/src/features/*                       — 不得修改
server/src/api/server.js                    — 不得新增任何暴露historical_validation内容的路由（呼应隔离红线，本轮及实施阶段均不开放）
server/migrations/001_v1_4a_foundation.*.sql
server/migrations/002_v1_4a_review_fixes.*.sql
server/migrations/003_v1_4b_feature_engine.*.sql
server/migrations/004_v1_4c_forecast_engine.*.sql        — 已冻结生产schema，历史验证只能新增005号migration，不得修改前四个
deploy/systemd/eth-alpha-collector.service
deploy/systemd/eth-alpha-feature-generator.service        — 不得修改；回填/回放均以独立脚本/CLI运行，不新增systemd常驻服务（见 V1_4D_DATA_BACKFILL_SPEC.md §2.13"物理独立，不常驻"）
/etc/eth-alpha/collector.env（生产环境变量文件） — 不得修改；若回填/回放CLI需要独立环境变量（如BACKFILL_RATE_LIMIT_MS），走独立的.env文件或显式CLI参数，不追加到生产collector.env
```

**可复用但禁止修改其内部逻辑的现有纯函数模块**（引用即可，见`V1_4D_HISTORICAL_REPLAY_SPEC.md`§4.7完整清单）：
```
server/src/forecast/bar-path-locator.js
server/src/forecast/threshold-formula.js
server/src/forecast/po-state-engine.js
server/src/forecast/forecast-contract.js
server/src/outcome/outcome-engine.js
server/src/validation/walk-forward.js
server/src/domain/vintage.js
server/src/domain/hash.js
server/src/config.js（仅复用loadConfig()中DATABASE_URL/DB_SSL等既有字段，不为回填/回放新增字段污染生产config schema——回填/回放专属参数通过独立CLI flag或独立小型config模块处理）
```

### 1.3 本轮（文档阶段）动作

**本轮不新增、不修改上述任何代码文件、不创建migration、不建schema、不写historical_validation任何表、不执行任何回填/回放，只交付五份V1.4D文档本身。**

---

## 2. 数据结构唯一来源声明

| 结构/规则 | 唯一权威来源 |
|---|---|
| `ForecastSnapshot`/`ForecastOutcomeEvent`字段形状、PO_\*判定规则、`directionThreshold`公式 | `V1_4_FORECAST_DATA_SPEC.md`（生产字段定义不变，回放对应表字段镜像其结构，见下方"分层"原则） |
| walk-forward切分/重叠样本处理/误差归因规则/最低样本量门槛(30/10) | `V1_4_HISTORICAL_VALIDATION_SPEC.md`（本轮不重新定义，只在隔离环境中落地执行） |
| 生产point-in-time查询模式（`available_at<=asOfTime`等） | `server/src/forecast/bar-path-locator.js`现有实现（本轮不修改，回放层另建等价查询） |
| 回填协议、回填窗口选型、`researchAvailability`语义 | `V1_4D_DATA_BACKFILL_SPEC.md`（本轮新增，唯一权威） |
| `historical_validation`schema设计、CLI契约、统计报告字段、PO_UNKNOWN诊断结构 | `V1_4D_HISTORICAL_REPLAY_SPEC.md`（本轮新增，唯一权威） |
| `dataset_version`确定性生成规则、`dataset_manifests`表结构、manifest校验八步流程 | `V1_4D_HISTORICAL_REPLAY_SPEC.md`§2.8/§2.9/§4.0/§4.1a（本轮新增，唯一权威——`V1_4D_DATA_BACKFILL_SPEC.md`§2.10仅做交叉引用，不重复定义） |
| `canonicalJsonHash()`契约核实结论（对象键排序/数值稳定性/数组保序/哈希算法）、caller侧类型纪律 | `V1_4D_HISTORICAL_REPLAY_SPEC.md`§2.9.4/§2.9.5（本轮基于实际读取`server/src/domain/hash.js`源码得出，唯一权威） |

Codex实现任何字段前，必须先在对应文档中定位其权威定义，**不得**凭记忆或推测重新发明字段形状；涉及跨文档冲突（理论上不应发生，若发生）以**更晚版本号/更新日期**的文档为准，并需要在实施前提请人工确认，不得自行选择。

---

## 3. 函数接口分层（复用生产纯函数 + 新建回放专属数据访问层）

### 3.1 纯计算层（直接复用，禁止修改，禁止fork出第二份实现）

见`V1_4D_HISTORICAL_REPLAY_SPEC.md`§4.7"可直接复用"表格，不在本文档重复。**红线：不得为了"方便回放"复制一份`po-state-engine.js`/`forecast-contract.js`/`outcome-engine.js`的逻辑并做任何哪怕看似无害的改动**——回放与生产必须共享同一套判定逻辑的**同一份代码**，否则回放结果不代表生产算法的真实历史表现，整个V1.4D的意义就不成立。

### 3.2 回放专属数据访问层（新建，替代生产查询层中"生产状态耦合"的部分）

`research-availability.js`职责边界（红线）：
- **只**新增一个函数级别的等价查询封装，例如`locateReferenceBarAndPathForReplay(client, {instrument, horizon, historicalAsOfTime, symbol})`，内部SQL与`bar-path-locator.js`的`locateReferenceBarAndPath`**几乎完全相同**，唯一差异是可得性判据从`available_at<=asOfTime AND fetched_at<=asOfTime`改为`close_time<=historicalAsOfTime`（即`researchAvailability`公式，见`V1_4D_DATA_BACKFILL_SPEC.md`§2.9）+ `fetched_at<=回放任务实际发起的真实系统时间`（防止读到"正在进行中尚未提交完成"的回填批次，见该文档同节末段）。
- **不得**修改`bar-path-locator.js`本身去新增一个`useResearchAvailability`之类的flag参数——生产查询函数必须保持对生产场景的绝对纯粹，两条查询路径物理上是两份独立的SQL语句（可共享同一套单元测试断言辅助函数，但SQL文本本身分离），避免"一个开关同时影响生产与回放行为"这种耦合风险。
- 同样需要`computeFourHourAtr14ForReplay`/`computeConsecutiveBreakoutBarsForReplay`两个等价封装，逻辑同理。
- `waitForExactFeature`的回放等价版本：`waitForExactFeatureForReplay`——**不带重试等待循环**（生产版本的重试等待是为了应对"实时环境下特征还没算出来"这一真实竞态；回放场景下所有历史数据早已静态存在，若查询不到即代表数据缺口，应直接判定为`FEATURE_RECORD_MISSING`并`blocked`，不应该`setTimeout`空等）。

### 3.3 存储层（回放专属，不与生产表交互）

`replay-generator.js`/`replay-evaluator.js`的数据库写入**只**面向`historical_validation`schema下的`replay_snapshots`/`replay_generation_runs`/`replay_outcome_events`/`replay_evaluation_runs`四张业务表（schema全体共**八张表**，另四张`dataset_manifests`/`validation_runs`/`backfill_batches`/`validation_reports`分别由`dataset-manifest-builder.js`/`cli-entry.js`/`report-builder.js`/`backfill-cli-entry.js`写入），写入模式（`INSERT ... ON CONFLICT DO NOTHING`、先写审计行再写业务行满足外键顺序）**镜像**`generator-service.js`/`evaluator-service.js`生产写入逻辑的既有模式（复用"模式"，不复用"代码"，因为目标表结构不同、无lease耦合），但**不得**引入`assertLease`/`fencing_token`相关任何校验（回放没有lease）。

### 3.4 Dataset Manifest 层（本轮新增，独立于上述三层，是`replay-generator.js`的前置门禁）

`dataset-manifest-builder.js`（构建，写路径）与`dataset-manifest-verifier.js`（校验，只读路径）是两个职责严格分离的模块，**不得合并**：
- 构建（`dataset:build-manifest`命令）是**deliberate的一次性动作**，产生新的`dataset_manifests`行；
- 校验（`validation:walk-forward`启动时自动调用）是**每次执行都必须重新做**的只读确认，即使是`--dry-run`（见 V1_4D_HISTORICAL_REPLAY_SPEC.md §4.1a）；
- `replay-generator.js`/`replay-evaluator.js`**不得**直接调用`dataset-manifest-builder.js`（不得隐式"顺手建一个manifest"），只允许调用`dataset-manifest-verifier.js`做只读校验——这是为了保证"冻结一个数据集"始终是人工可审查的独立步骤，不会作为某次回放执行的隐藏副作用发生。

---

## 4. 构建顺序（实施阶段参考，本轮不执行）

1. **Migration 005**：按 V1_4D_HISTORICAL_REPLAY_SPEC.md §三.0 冻结顺序创建`historical_validation`schema与**八张表**（`dataset_manifests`置于最前），配套`.down.sql`。**先于**任何回填/回放代码。
2. **回填模块**（`server/src/backfill/*`）：先实现`integrity-check.js`（回填前基线校验，可独立于回填本身先行开发测试），再实现`binance-kline-backfill.js`主体分页拉取逻辑，最后`backfill-cli-entry.js`包装CLI参数。**先在`--dry-run`或极小时间窗口（如1天）验证幂等性/去重/ON CONFLICT行为**，再执行`V1_4D_DATA_BACKFILL_SPEC.md`推荐的**180天**窗口正式回填。
3. **Dataset Manifest 构建层**（`hash-contract-verification.test.js` → `canonical-manifest-content.js` → `dataset-manifest-builder.js` → `dataset-manifest-cli-entry.js`）：**本轮新增，插入在回填之后、任何回放代码之前**——**第一步必须先跑`hash-contract-verification.test.js`**，对当时实际的`domain/hash.js canonicalJsonHash()`重新核实§2.9.4四项结论，通过后才允许继续；`canonical-manifest-content.js`独立开发测试（构造内容对象+确定性排序+类型纪律，纯函数，最容易独立验证正确性）；`dataset-manifest-builder.js`接入`integrity-check.js`与`domain/hash.js canonicalJsonHash()`；确认对固定测试数据能稳定产出同一完整64位`dataset_version`后，才进入下一步。
4. **Dataset Manifest 校验层**（`dataset-manifest-verifier.js`）：独立开发测试§4.1a八步流程的每一步（含故意构造哈希不一致/记录数不一致/规则版本不一致等失败场景），确认全部fail closed路径正确后，才允许被`replay-generator.js`依赖。
5. **回放数据访问层**（`server/src/validation-replay/research-availability.js`）：先于`replay-generator.js`独立开发测试，因为它是后续所有回放正确性的地基（asOfTime防泄漏的具体落地点，含`research_availability_rule_version`写入）。
6. **回放生成/评估模块**（`replay-generator.js`/`replay-evaluator.js`）：**必须先接入第4步的`dataset-manifest-verifier.js`调用，再实现实际生成/评估逻辑**——校验失败时生成逻辑不得被触发，这个调用顺序本身就是测试重点。
7. **purge模块**（`purge.js`）：独立开发测试，验证跨边界样本剔除的正确性（构造targetStartTime/targetEndTime跨越边界的样例），再接入`report-builder.js`。
8. **统计报告**（`report-builder.js`）与**PO诊断**（`po-diagnostic.js`）。
9. **CLI入口**（`cli-entry.js`）整合以上全部模块，实现`--dry-run`/`--resume`/`--split`/参数校验/启动横幅/manifest八步校验调用。
10. **单run清理脚本**（`cleanup-single-run.js`）：独立开发测试，验证按§三.1顺序删除后`public.market_bars`/`public.feature_records`行数不变，且`dataset_manifests`不受影响。
11. 全部完成后，先对**严格最小窗口（130天，零缓冲，仅用于打通链路，不作为正式统计结论来源）**跑一次完整`dry-run`+真实执行，验证链路无误、验收测试全部通过（见`V1_4D_ACCEPTANCE_TESTS.md`），再决定是否推进到**180天推荐窗口**的正式回填与回放。

**红线：以上任一步骤，均不得在本轮（规范制定阶段）执行，需等待独立的实施授权。**

---

## 5. 明确排除（本轮及实施阶段均不做，除非未来有独立授权的新规范）

- 不做`calibratedProbabilities`实际赋值逻辑。
- 不做任何"根据回放结果自动调整`directionThreshold`/PO_\*阈值/`scenarioWeights`"的闭环。
- 不做跨24H/72H的合并模型或合并校准。
- 不做真实Brier Score计算。
- 不做融合中枢、S0–S7、ML训练、自动交易、任何真实持仓/下单逻辑。
- 不给`historical_validation`任何数据开放生产API读取接口。
- 不为回填/回放引入任何新的外部数据源（仍是Binance公开REST，与生产同源）。

---

## 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.4d-task-draft-1 | 2026-07-25 | 初稿：冻结文件范围红线、数据结构来源声明、纯计算层/数据访问层/存储层三层划分、构建顺序、明确排除清单 |
| v1.4d-task-draft-2 | 2026-07-25 | 第三阶段独立复审修订：①表数量订正为七张，新增migration建表顺序（§1.1）；②新增`purge.js`/`cleanup-single-run.js`两个模块任务；③`binance-kline-backfill.js`/`research-availability.js`任务说明中补充P0/P1裁决的具体落地要求（available_at诚实语义、research_availability_rule_version写入）；④构建顺序（§4）从7步扩为9步，纳入purge与清理脚本，推荐窗口数值同步订正为180天、最小窗口订正为130天 |
| v1.4d-task-draft-3 | 2026-07-26 | 第三阶段补充修订：关闭`dataset_version`内容哈希P1。①表数量**七张→八张**，`dataset_manifests`置于migration建表顺序最前；②新增5个模块任务：`canonical-manifest-content.js`/`dataset-manifest-builder.js`/`dataset-manifest-verifier.js`/`dataset-manifest-cli-entry.js`，`integrity-check.js`任务说明补充"manifest构建必须复用本模块，不得另写一套"；③新增§3.4 Dataset Manifest层职责边界（构建/校验严格分离，回放代码不得隐式建manifest）；④构建顺序（§4）从9步扩为11步，manifest构建/校验层插入回填之后、回放代码之前；⑤`replay-generator.js`任务说明新增"必须先经manifest校验通过"的强制依赖 |
| v1.4d-task-draft-4 | 2026-07-26 | 第三阶段定向修订：①migration任务明确`dataset_version`改为完整SHA-256（不截断）、`content_hash`须为Postgres生成列；②`canonical-manifest-content.js`任务补充详细契约（字段清单/四级排序含`vintageId`决胜字段/`backfillBatchIds`去重排序/numeric与时间字段类型纪律）；③**新增`hash-contract-verification.test.js`任务**（实施阶段第一步，重新核实`domain/hash.js canonicalJsonHash()`四项契约，若不成立则要求在`canonical-manifest-content.js`内部自建版本化编码，不得修改`domain/hash.js`本身）；④构建顺序§4第3步插入该核实任务为最前置步骤；⑤数据结构来源声明新增canonicalJsonHash核实结论行 |
