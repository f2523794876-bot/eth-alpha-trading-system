# V1_4D_HISTORICAL_REPLAY_SPEC.md — V1.4D 隔离式历史 Walk-forward 回放规范（冻结草案）

版本：v1.4d-replay-draft-4（第三阶段定向修订：废止64-bit截断dataset_version，改为完整SHA-256；实际核实canonicalJsonHash()源码；manifest_members排序补齐vintageId决胜字段，见变更记录）
基线：`main@eb89c49f0957617c453ea2c0d149afb55e97dad0`
角色：本文档是 **`historical_validation`独立schema设计、历史回放CLI契约、Walk-forward统计/报告字段、PO_UNKNOWN诊断方法**的唯一权威文档。消费`V1_4D_DATA_BACKFILL_SPEC.md`产出的`market_bars`回填数据；复用`V1_4_HISTORICAL_VALIDATION_SPEC.md`的切分/重叠样本/最低样本量/误差归因规则（不重新定义，只在隔离环境中执行）。

**红线（贯穿全文）**：本文档定义的回放**读**生产`market_bars`/`feature_records`（只读），**写**仅限`historical_validation`schema自己的表；**绝不**写生产`forecast_snapshots`/`forecast_outcome_events`/`forecast_generation_runs`/`forecast_evaluation_runs`四张表（CEO裁决第3条）；**绝不**获取/续租/释放生产`collector_leases`任何行（CEO裁决第4条）；**绝不**仅靠扩展生产表`source_origin`做隔离（CEO裁决第2条，本文档使用独立schema）。

---

## 一、历史prediction_id命名空间

生产格式对照：

| 来源 | 格式 | 示例 |
|---|---|---|
| V1.4C 服务器实时生成 | `GMKG-SRV-${instrument}-${horizon}-${referenceCloseTime}-${algorithmVersion}` | `GMKG-SRV-ETH-24h-1784923199999-v1.4c-server-po-rule-1` |
| 浏览器端遗留（`LEGACY_BROWSER`，IndexedDB，物理隔离） | `GMKG-${instrument}-...`（无`SRV`段） | — |
| **历史回放（本文档新增）** | **`GMKG-REPLAY-${instrument}-${horizon}-${historicalReferenceCloseTime}-${algorithmVersion}-${datasetVersion}`** | `GMKG-REPLAY-ETH-24h-1781654399999-v1.4c-server-po-rule-1-v1.4d-sha256-3a7f9c2e1b8d4f6a0e5c7b9d2a1f8e6c4b0d3a9f7e2c5b8d1a6f4e0c9b2d7a3f`（`datasetVersion`本轮起为完整SHA-256格式，见§2.9，字符串显著变长，`prediction_id`长度随之增加，均在text列合理范围内） |

**冻结规则**：
1. `REPLAY`段是硬编码常量，任何回放生成的`prediction_id`必须以`GMKG-REPLAY-`开头，与`GMKG-SRV-`（生产）、`GMKG-`（浏览器遗留）三者字符串前缀两两互斥，即使`referenceCloseTime`/`algorithmVersion`恰好相同也不可能碰撞。
2. `datasetVersion`必须编入`prediction_id`（生产`GMKG-SRV-`格式不含此段）——原因：历史回放可能对**同一个**`historicalReferenceCloseTime`用**不同回填批次/不同数据完整性状态**重跑（例如先用一批回填的数据跑一次，之后又补充回填了更早历史后重跑），二者理论上应产生可区分的记录，不应被`ON CONFLICT`静默去重成同一行。**`datasetVersion`本身不再是人工输入的自由字符串**——本轮（P1闭环修订）已改为由§2.8`dataset_manifests`冻结的内容哈希确定性生成，见§2.9。
3. `historical_validation`schema内的`replay_snapshots.prediction_id`**不做**按`validation_run_id`分段的额外命名空间隔离——即同一个`(instrument, horizon, historicalReferenceCloseTime, algorithmVersion, datasetVersion)`组合，无论被哪个`validation_run`触发，都收敛到同一条`prediction_id`，`validation_run_id`只记录在关联的`replay_generation_runs`审计行里——这是刻意设计：允许多个`validation_run`（例如同一rule_version下的resume/rerun）安全复用已计算过的历史快照，不重复计算，天然幂等。
4. **`research_availability_rule_version`不编入`prediction_id`字符串本身**（P1-2修订，与`datasetVersion`的处理方式不同）——`prediction_id`唯一性改为§2.3/§2.5冻结的**复合唯一约束**`UNIQUE(prediction_id, research_availability_rule_version)`（`replay_outcome_events`另加`evaluation_version`），效果等价（不同规则版本可并存、不覆盖），但不需要为此进一步拉长本已较长的`prediction_id`字符串。**本轮备注（dataset_version P1闭环后的关系说明，非结构变更）**：`research_availability_rule_version`现已是§2.9`dataset_version`哈希内容的一部分，规则版本变化会连带产生不同的`dataset_version`、进而连带产生不同的`prediction_id`——这意味着上述复合唯一约束在正常路径下已带有一定冗余（`prediction_id`不同时约束自然满足）。**本轮不撤销该复合约束**（撤销属于超出"关闭dataset_version P1"范围的架构变更，留待未来独立评审），保留作为纵深防御，防止实现阶段出现"`dataset_version`生成逻辑本身有bug、遗漏了`research_availability_rule_version`"这一类情形下的静默覆盖。

---

## 二、`historical_validation` 独立 schema 设计

**表数量口径（本轮再次修订：七张→八张）**：`historical_validation`schema共冻结**八张表**：①**`dataset_manifests`（本轮新增，见§2.8）**②`validation_runs`③`backfill_batches`④`replay_snapshots`⑤`replay_generation_runs`⑥`replay_outcome_events`⑦`replay_evaluation_runs`⑧`validation_reports`。draft-2曾冻结为七张（订正draft-1"六张"的漏计错误），本轮为关闭`dataset_version`内容哈希P1，新增`dataset_manifests`作为`dataset_version`的唯一权威落地表，表数量随之增至**八张**。后续文档、追溯矩阵、验收测试全部同步至八张，不得再出现"七张"或"六张"的旧表述。

**物理隔离声明（对照CEO裁决第2/3条）**：本schema下所有表**不与**生产`public`schema的`forecast_snapshots`/`forecast_outcome_events`/`forecast_generation_runs`/`forecast_evaluation_runs`存在任何外键关系；**只**通过只读方式引用`public.market_bars`/`public.feature_records`（外键或应用层引用均可，具体在实现阶段决定，但读方向单向：`historical_validation`→`public`，不存在反向依赖）；生产`public`schema的四张`forecast_*`表**不新增**任何指向`historical_validation`的列或约束——两个方向都不耦合。

### 2.0 八张表的可变性分类（本轮更新：新增`dataset_manifests`归入B类）

draft-1曾笼统地把除`validation_reports`外的表都称为"不可变"，draft-2已订正为三分类。本轮新增`dataset_manifests`，归入**B类（严格只增型）**——原因见§2.8：其主键`dataset_version`本身由内容哈希确定性生成，"修改manifest内容"在语义上等价于"产生一个新的、dataset_version不同的manifest"，不存在"原地更新同一版本号所指内容"的合法场景。

| 分类 | 表 | 行为 |
|---|---|---|
| **A. 状态机型（RUNNING期间允许原地更新，终态后冻结，不允许再次UPDATE）** | `validation_runs`、`backfill_batches`、`replay_generation_runs`、`replay_evaluation_runs` | 镜像生产`forecast_generation_runs`/`forecast_evaluation_runs`的既有模式：创建时`status='RUNNING'`，执行过程中/结束时**允许**原地`UPDATE status/finished_at/error_code`等字段一次，一旦进入终态（`SUCCEEDED`/`FAILED`/`BLOCKED`/`ATTENTION_REQUIRED`）后**不再允许任何UPDATE** |
| **B. 严格只增型（自创建起从不允许任何UPDATE）** | `replay_snapshots`、`replay_outcome_events`、**`dataset_manifests`（本轮新增归类）** | 与生产`forecast_snapshots`/`forecast_outcome_events`同一红线：`INSERT ... ON CONFLICT DO NOTHING`，全生命周期无`UPDATE`路径；`dataset_manifests`额外满足"内容寻址"性质——`dataset_version`（主键）本身是内容的哈希摘要，同一内容必产生同一主键，不同内容必产生不同主键，因而"原地UPDATE"在语义上是自相矛盾的操作，不只是被红线禁止，是被数据模型本身排除 |
| **C. 覆盖写例外（唯一允许重复覆盖的表）** | `validation_reports` | 见2.7，因为是可重新计算的派生统计视图，不是原始观测记录 |

`V1_4D_ACCEPTANCE_TESTS.md` R11系列须按此三分类分别断言（A类断言"终态后无UPDATE"，B类断言"从不UPDATE"，C类不做不可变断言，见验收测试修订）；`dataset_manifests`的"不可篡改"额外要求见R26新增测试（原地覆盖测试）。

### 2.1 `validation_runs`（每次回放执行的顶层审计记录）

| 属性 | 定义 |
|---|---|
| 主键 | `validation_run_id`（uuid） |
| 唯一约束 | 无（同一参数组合允许多次独立执行，用于对比/resume/重跑） |
| 外键 | `resumed_from_run_id` → `validation_runs.validation_run_id`（nullable，自引用，记录resume链）；**`dataset_version` → `dataset_manifests.dataset_version`（NOT NULL，本轮新增外键，见§2.8/§三.0红线——CLI必须先有对应的冻结manifest才能创建run）** |
| 关键列 | `symbol`, `horizons`（jsonb数组，如`["24h","72h"]`）, `from_utc`, `to_utc`, `algorithm_version`, `dataset_version`, `rule_version`, `train_end_utc`, `validation_end_utc`（三段切分点，`splitTimeOrdered`参数直接落库） |
| `dry_run` | boolean，`true`时全程零写入（见四.2） |
| `run status` | `status` CHECK IN (`'RUNNING'`,`'SUCCEEDED'`,`'FAILED'`,`'PARTIAL'`) |
| `failure_reason`/`data_quality_reason` | `error_code` text nullable + `blocked_reasons` jsonb（记录因数据不完整/未达门槛等导致的非致命阻塞原因列表，区分"程序性failure"与"数据不足"两类） |
| `created_at`/`started_at`/`finished_at` | timestamptz |
| 幂等策略 | 每次CLI调用**默认**生成新的`validation_run_id`（不是幂等单例）；幂等性体现在**下游**`replay_snapshots`/`replay_outcome_events`按`prediction_id`去重，同一逻辑预测不会因为运行了多个`validation_run`而重复计算或重复计入统计 |
| 不可变策略 | `status`/`finished_at`/`error_code`允许在运行过程中更新（因为这本身就是运行状态机），**运行结束(`SUCCEEDED`/`FAILED`)后不再允许修改任何字段**（应用层保证，不建表级触发器，保持与生产`forecast_generation_runs`一致的"允许运行中原地更新，终态后只读"模式） |

### 2.2 `backfill_batches`（支持表，承接`V1_4D_DATA_BACKFILL_SPEC.md`§2.10审计需求）

| 属性 | 定义 |
|---|---|
| 主键 | `backfill_batch_id`（uuid） |
| 关键列 | `symbol`, `interval_name`, `requested_start_utc`, `requested_end_utc`, `last_completed_open_time`（恢复游标）, `status` CHECK IN(`'RUNNING'`,`'SUCCEEDED'`,`'FAILED'`,`'ATTENTION_REQUIRED'`), `rows_inserted`, `rows_deduped`, `error_code`, `started_at`, `finished_at`, `created_at` |
| 幂等策略 | 按`last_completed_open_time`恢复，见`V1_4D_DATA_BACKFILL_SPEC.md`§2.11 |
| 不可变策略 | 终态（`SUCCEEDED`/`FAILED`/`ATTENTION_REQUIRED`）后只读 |

### 2.3 `replay_snapshots`（历史`ForecastSnapshot`对应物）

字段集合**对齐**生产`forecast_snapshots`（同名字段语义完全一致，复用`forecast-contract.js`的`finalizeForecastSnapshot`产出结构），额外增补回放专属溯源列：

| 属性 | 定义 |
|---|---|
| 主键 | `replay_snapshot_id`（bigserial） |
| 唯一约束 | **`UNIQUE(prediction_id, research_availability_rule_version)`**（复合唯一约束，P1-2修订：不是单纯`UNIQUE(prediction_id)`——见下方`research_availability_rule_version`行说明其原因） |
| 外键 | `generation_run_id` → `replay_generation_runs.generation_run_id`（NOT NULL，同生产"被引用行先存在"模式）；`backfill_batch_id` → `backfill_batches.backfill_batch_id`（nullable，记录该快照所用数据主要来自哪次回填批次，供审计追溯）；**`dataset_version` → `dataset_manifests.dataset_version`（NOT NULL，本轮新增外键）** |
| 与生产同构字段 | `instrument`,`horizon`,`generated_at`,`data_cutoff_time`,`target_start_time`,`target_end_time`,`reference_price`,`reference_bar_ref`,`target_bar_ref`,`expected_bar_count`,`expected_direction`,`direction_threshold`,`raw_threshold`,`threshold_floor/ceiling`,`threshold_formula_version`,`atr14_four_hour_at_generation`,`proxy_state_at_generation`,`candidate_trajectories`,`scenario_weight_*`,`expected_price_zones`,`trigger/invalidation_conditions`,`feature_values_used`,`feature_record_ids`,`content_hash` |
| **`target_state_at_generation`** | CHECK恒`'UNKNOWN'`（与生产同一红线，CEO裁决第7条） |
| **`fusion_state_at_generation`** | CHECK恒`'UNKNOWN'` |
| **`calibrated_probabilities`** | CHECK恒`IS NULL`（CEO裁决第6条） |
| **`probability_status`** | CHECK恒`'rule_based'` |
| **`brier_score_component`** | 新增列，CHECK恒`IS NULL`（占位，呼应`V1_4_HISTORICAL_VALIDATION_SPEC.md`§6，V1.4D阶段同样不计算真实值） |
| `algorithm_version`/`weight_version`/`dataset_version` | 与生产同名同义 |
| **`rule_version`** | 新增列（PO规则版本，来源于`po-state-engine.js`的`poRuleVersion`，独立于`algorithm_version`记录，便于未来PO规则单独升版时追溯） |
| **`historical_as_of_time`** | 新增列，timestamptz NOT NULL，本条快照回放时使用的模拟历史时钟（对照生产`asOfTime`来源于实时`serverTimeProvider()`，回放版必须来自CLI `--from`/`--to`范围内按节奏推进的历史值，见四.1） |
| **`research_data_vintage`** | 新增列，jsonb NOT NULL，记录：实际消费的`market_bars`/`feature_records`行的`available_at`/`as_of_time`/`close_time`快照、所属`backfill_batch_id`列表、以及"本记录不代表系统历史上真实持有此数据"的显式声明文本——**这是本条记录"合法性"的完整审计证据链**，任何复现性核查都从这里出发 |
| **`research_availability_rule_version`**（P1-2修订，新增独立列，取代仅隐含在jsonb内的做法） | text NOT NULL，冻结初始值`'v1.4d-research-availability-1'`（见`V1_4D_DATA_BACKFILL_SPEC.md`§2.9）。**唯一键/幂等关系**：与`prediction_id`组成**复合唯一约束**`UNIQUE(prediction_id, research_availability_rule_version)`——原因：`prediction_id`本身（`GMKG-REPLAY-...-algorithmVersion-datasetVersion`）不编码"用哪条可得性规则读取的数据"，若只用`UNIQUE(prediction_id)`，一旦`researchAvailability`公式修订产生新版本号（`algorithm_version`/`dataset_version`均未变），重跑会因`prediction_id`冲突被`ON CONFLICT DO NOTHING`静默吞掉，新规则版本的结果永远生成不了、旧规则版本的记录被误认为"已经是最新结果"——这是必须杜绝的静默数据丢失。改为复合唯一约束后，同一`prediction_id`在不同`research_availability_rule_version`下可以**并存多条**，新旧版本互不覆盖、可直接对比查询。**修改`researchAvailability`公式**必须递增此版本号，并通过一次**独立的新`validation_run`**产出新版本的记录，不得覆盖或静默影响已产生的历史结果；本列本身**不可变**（同一行一旦写入永不更新） |
| `source_origin` | 新增独立枚举，CHECK恒`'HISTORICAL_REPLAY'`（本schema内部固定值，与生产`'SERVER'`/`'LEGACY_BROWSER'`两个枚举值不共享同一CHECK域，物理上不可能被生产查询误读为生产来源——呼应CEO裁决第2条"禁止仅通过扩展生产表source_origin做隔离"：这里是**独立schema+独立CHECK域**的双重隔离，不是"在生产表里加一个新枚举值"） |
| **`action_permission`**（P1-1修订，新增说明，非新增列） | **本表不设此列**——生产`forecast_snapshots`本身也不落库`ActionPermission`（该概念是`GMKG_DRAGONFLY_ARCHITECTURE.md`定义的**API响应层**概念，按请求上下文计算，不持久化），`replay_snapshots`与生产结构保持一致，同样不落库。CEO裁决第9条（`ActionPermission`只能`DISPLAY_ONLY`/`AUDIT_ONLY`）的满足方式是**结构性排除**：`historical_validation`schema**没有任何API暴露面**（见§三隔离保证清单），因此**不存在任何代码路径会为回放数据计算或返回`ActionPermission`**，不是"每次都正确算出DISPLAY_ONLY"，而是"根本没有计算这件事发生"——比"总是返回正确值"更强的保证。若未来任何后续阶段开放`historical_validation`只读展示接口，该新规范必须重新显式定义返回的`ActionPermission`恒为`DISPLAY_ONLY`或`AUDIT_ONLY`，不得援引本条"以前没暴露过所以现在也安全"。对应攻击测试见`V1_4D_ACCEPTANCE_TESTS.md` R20（本轮新增）。 |
| `created_at` | timestamptz default now() |
| 幂等策略 | `INSERT...ON CONFLICT(prediction_id) DO NOTHING`，与生产模式一致 |
| 不可变策略 | **无`UPDATE`路径**（分类B，见§2.0），与生产`forecast_snapshots`同一红线：一旦写入永不修改 |

### 2.4 `replay_generation_runs`（历史`ForecastGenerationRun`审计对应物）

| 属性 | 定义 |
|---|---|
| 主键 | `generation_run_id`（uuid） |
| 外键 | `validation_run_id` → `validation_runs.validation_run_id` NOT NULL |
| 关键列 | `instrument`,`horizon`,`historical_as_of_time`,`status` CHECK IN(`'RUNNING'`,`'SUCCEEDED'`,`'FAILED'`,`'BLOCKED'`)，`generated_count`,`deduped_count`,`blocked_count`,`error_code`,`started_at`,`finished_at` |
| **无`lease_name`/`fencing_token`列**（与生产`forecast_generation_runs`的关键结构差异——本表不依附任何lease机制，CEO裁决第4条） |
| 幂等策略 | 同一`(validation_run_id, instrument, horizon, historical_as_of_time)`重复执行时，其触发的`replay_snapshots`写入天然因`prediction_id`唯一约束去重；本表自身允许同一逻辑尝试产生新的`generation_run_id`行（审计每一次尝试，不去重审计记录本身，只去重业务结果） |
| 不可变策略 | 终态后只读 |

### 2.5 `replay_outcome_events`（历史`ForecastOutcomeEvent`对应物）

字段集合对齐生产`forecast_outcome_events`：

| 属性 | 定义 |
|---|---|
| 主键 | `replay_outcome_event_id`（bigserial） |
| 唯一约束 | **`UNIQUE(prediction_id, evaluation_version, research_availability_rule_version)`**（P1-2修订，复合唯一约束，理由同2.3：`researchAvailability`规则版本变化必须产生可并存的新记录，不得被静默去重） |
| 外键 | `prediction_id` → `replay_snapshots.prediction_id`（`ON DELETE RESTRICT`，与生产同构）；`evaluation_run_id` → `replay_evaluation_runs.evaluation_run_id` NOT NULL |
| 与生产同构字段 | `evaluation_version`,`evaluated_at`,`endpoint_data_complete`,`path_data_complete`,`direction_eligible_for_statistics`,`path_eligible_for_statistics`,`actual_return`,`actual_direction`,`direction_correct`,`actual_high/low`,`mfe`,`mae`,`range_specific_metrics`,`invalidation_triggered/reason`,`coverage_metrics`,`missing_bar_refs`,`content_hash` + 与生产完全相同的两条CHECK红线（`direction_eligible_for_statistics`为false时相关方向字段必须为NULL；`path_eligible_for_statistics`为false时相关路径字段必须为NULL） |
| **`historical_as_of_time`** | 新增列，本条评估使用的模拟历史时钟（等于该预测`target_end_time`所在的回放推进时刻，而非评估执行的真实系统时间） |
| **`research_data_vintage`** | 新增列，同2.3语义，记录评估时消费的future path bars的数据可得性审计证据 |
| **`research_availability_rule_version`** | text NOT NULL，语义与幂等/唯一键关系同2.3 |
| `source_origin` | CHECK恒`'HISTORICAL_REPLAY'` |
| `primary_cause`/`secondary_causes`/`attribution_evidence`/`attribution_confidence`/`requires_human_review`/`not_evaluable_causes`/`attribution_rule_version` | 新增列，落地`V1_4_HISTORICAL_VALIDATION_SPEC.md`§5冻结的误差归因结构（生产schema目前也未实现，本schema作为V1.4D范围**一并**补齐，见`V1_4D_CODEX_IMPLEMENTATION_TASK.md`任务边界） |
| `created_at` | timestamptz default now() |
| 幂等策略 | `ON CONFLICT(prediction_id,evaluation_version,research_availability_rule_version) DO NOTHING` |
| 不可变策略 | 无`UPDATE`路径（分类B，见§2.0） |

### 2.6 `replay_evaluation_runs`

结构对齐生产`forecast_evaluation_runs`，去掉`lease_name`/`fencing_token`，增加`validation_run_id`外键，语义同2.4，不再重复列出。

### 2.7 `validation_reports`（统计结果表）

| 属性 | 定义 |
|---|---|
| 主键 | `report_id`（uuid） |
| 唯一约束 | `UNIQUE(validation_run_id, horizon, report_scope)`（`report_scope` CHECK IN(`'ALL'`,`'TRAIN'`,`'VALIDATION'`,`'TEST'`,`'ROLLING_WINDOW'`)，同一run同一horizon同一切分区间只产出一份报告，重跑同run覆盖同一份而非累积——**唯一允许"覆盖写"的表**，因为报告是统计结果的物化视图，不是不可变的原始观测记录，见下方"不可变策略"说明其边界） |
| 外键 | `validation_run_id` → `validation_runs.validation_run_id`；**`dataset_version` → `dataset_manifests.dataset_version`（NOT NULL，本轮新增外键）** |
| 关键列 | `raw_sample_count`,`effective_sample_count`（分别针对`direction`/`path`两类分母各一份，即4个数字：`direction_raw`,`direction_effective`,`path_raw`,`path_effective`），`sample_sufficient`（boolean，对照冻结门槛30/10），**`purged_straddling_count`**（P1-3/§1.1修订新增，integer NOT NULL default 0，`report_scope IN ('TRAIN','VALIDATION','TEST')`时记录因跨越`trainEnd`/`validationEnd`边界被剔除、未计入本段统计的样本数，`report_scope='ALL'`时恒为0——因为purge只影响分段视图，不影响整体视图），`po_state_breakdown`（jsonb，9个PO_\*状态各自的raw/effective样本数与方向准确率等，样本不足的状态显式标注），`up_down_range_breakdown`（jsonb），`formal_proxy_disclosure`（jsonb，声明本报告涉及的数据100%来自formal，不含proxy——path评估本就只读formal，此字段是显式披露而非计算结果），`calibrated_probabilities_status`固定文本`'null (V1.4D not eligible)'`,`brier_score_component`恒NULL,`error_attribution_summary`（jsonb，各`primaryCause`/`notEvaluableCauses`计数分布） |
| `algorithm_version`/`rule_version`/`dataset_version`/`research_availability_rule_version` | 与该run一致，冗余存储便于报告独立查询无需回连`validation_runs`；`research_availability_rule_version`取该report所汇总的`replay_snapshots`/`replay_outcome_events`实际使用的版本（正常情况下应全部一致，若同一report范围内出现多个版本混杂，视为异常，report生成时应报错而非静默汇总，防止混用不同可得性规则的数据产出同一份统计） |
| `content_hash` | char(64)，报告内容（不含`report_id`/`created_at`本身）的规范化哈希，用于检测"同一run同一scope是否产生了不同结果"（若覆盖写导致哈希变化但输入参数未变，属于异常，需要在验收测试中覆盖，见D文档） |
| `created_at` | timestamptz default now() |
| 幂等策略 | 同一`(validation_run_id, horizon, report_scope)`重复生成时**覆盖写**（`ON CONFLICT(...) DO UPDATE`），因为报告本身是可重新计算的派生视图，不是原始观测；**但其依赖的`replay_snapshots`/`replay_outcome_events`原始数据不可变**，故报告的覆盖写不构成"篡改历史"，只是"用同样不变的原始数据重新算一遍统计口径"，理论上应产生完全相同的`content_hash`（除非切分点等参数本身在resume/rerun间发生变化，那种情况通过`validation_run_id`不同天然区分） |
| 不可变策略 | 上述"仅报告表允许覆盖写"是本schema**唯一**的例外（分类C，见§2.0），且仅限统计结果，不涉及任何原始预测/评估记录 |

### 2.8 `dataset_manifests`（本轮新增，关闭`dataset_version`内容哈希P1的唯一权威落地表）

**角色**：`dataset_version`不再是任意人工输入的自由字符串，而是本表某一行内容的确定性哈希摘要。任何`validation_runs`/`replay_snapshots`/`validation_reports`引用的`dataset_version`都必须能在本表中找到对应行，否则视为无效版本号。

| 属性 | 定义 |
|---|---|
| 主键 | **`dataset_version`（text，非UUID/非自增，见§2.9生成公式）**——内容寻址：同一内容必产生同一主键，不同内容必产生不同主键，是本表与其余七张表最大的结构差异。**本轮修订（关闭截断P1）：`dataset_version`携带完整64字符十六进制SHA-256摘要，不做任何截断**（draft-3曾错误地只截取前16位/64-bit，作为长期内容寻址主键的碰撞裕量不足，本轮废止该设计，见§2.9） |
| 唯一约束 | 主键已保证唯一；`content_hash`列为**Postgres生成列**（`GENERATED ALWAYS AS`，见下），与主键值结构性恒等，不存在两者"分歧"的可能性，因此不需要额外`UNIQUE`约束或"启动时一致性校验二者是否相等"这一步骤——生成列的设计本身消除了这类校验的必要性（这比"两个独立列+运行时校验相等"更强的保证：数据库不允许它们不相等） |
| 外键 | 无外键指向本schema其他表或`public`schema（本表是被引用方，不是引用方；本表也**不**通过外键结构性引用`public.market_bars`，理由见§2.9"为何不设DB级FK"） |
| `manifest_schema_version` | text NOT NULL，冻结初始值`'v1.4d-manifest-schema-1'`，描述被哈希的内容对象的**字段形状**（哪些字段、嵌套结构），修改字段形状必须递增此版本号；**是被哈希内容的一部分**（见§2.9） |
| `manifest_hash_algorithm_version` | text NOT NULL，冻结初始值`'v1.4d-manifest-hash-1'`，描述**哈希函数与规范化序列化算法**本身的版本（对应`server/src/domain/hash.js`现有`canonicalJsonHash()`实现，见§2.9核实结论），若该函数实现变化必须递增此版本号；**本轮修订：也是被哈希内容的一部分**（draft-3曾把它排除在哈希内容外，理由是"避免循环定义"——本轮订正该理由不成立：把一个固定的版本标签字符串作为哈希函数的输入之一，不构成"哈希引用自身输出"的循环，而是与其余字段完全对等的普通输入项；纳入哈希内容后，"算法版本变化"这一事件本身也会**确定性地**反映为不同`dataset_version`，不再依赖"算法实现变了输出大概率也会变"这一较弱的隐含保证） |
| `content_hash` | **`char(64) GENERATED ALWAYS AS (substring(dataset_version from 15)) STORED`**——由`dataset_version`去掉`v1.4d-sha256-`前缀（13字符）后的剩余64字符十六进制机械推导，数据库层面保证与`dataset_version`携带的哈希值逐字符相等，不允许独立写入 |
| `symbol` | text NOT NULL |
| `intervals` | jsonb NOT NULL，本manifest覆盖的K线周期集合，如`["15m","1h","4h"]`，序列化时固定排序（见§2.9） |
| `data_from`/`data_to` | timestamptz NOT NULL，本manifest覆盖的数据时间范围（`data_from`含、`data_to`不含，与`market_bars`查询边界语义一致） |
| `backfill_batch_ids` | jsonb NOT NULL，本manifest所涵盖的`backfill_batches.backfill_batch_id`集合（去重后按§2.9冻结规则排序的数组） |
| `source_formal_semantics` | text NOT NULL CHECK恒`'market_bars:formal:spot'`（固定常量，声明本manifest只可能来自`public.market_bars`表的formal/spot数据，不涉及`provisional_market_bars`，呼应`V1_4D_DATA_BACKFILL_SPEC.md`§2.13"不读取或写入provisional_market_bars"） |
| `research_availability_rule_version` | text NOT NULL，本manifest冻结时所用的`researchAvailability`规则版本（见`V1_4D_DATA_BACKFILL_SPEC.md`§2.9），**是被哈希内容的一部分**（见下方§2.9） |
| `record_count` | integer NOT NULL CHECK(record_count>=0)，本manifest涵盖的K线总行数（跨全部`intervals`求和） |
| `per_interval_record_count` | jsonb NOT NULL，按周期拆分的行数，如`{"15m":17280,"1h":4320,"4h":1080}` |
| `integrity_check_result` | jsonb NOT NULL，manifest冻结时对涵盖范围重新运行的gap/duplicate/out-of-order检查结果，如`{"gapCount":0,"duplicateCount":0,"outOfOrderCount":0}`——**冻结要求：manifest构建时若该结果任一项不为0，拒绝生成manifest（fail closed），不允许"带着已知缺口"的manifest被冻结**；该结果本身仍然进入内容哈希（见§2.9），使得"校验规则未来变严格"这类情形也会诚实反映为新的`dataset_version` |
| `manifest_members` | jsonb NOT NULL，本manifest涵盖的每一根K线的身份与内容摘要列表，元素形状`{intervalName, openTime, vintageId, revisionNumber, rowContentHash}`，**按§2.9冻结的确定性顺序排序（含全局唯一的`vintageId`作为最终并列决胜字段，杜绝排序歧义）**，是内容哈希覆盖的核心部分（用于检测"任一K线OHLCV变化"这类内容篡改） |
| `created_at` | timestamptz NOT NULL DEFAULT now()——**明确排除在内容哈希之外**（见§2.9"禁止纳入哈希的字段"），仅供审计"这个manifest是什么时候被冻结的"，不影响`dataset_version`取值 |
| 幂等策略 | `INSERT ... ON CONFLICT(dataset_version) DO NOTHING`——重新构建同一内容范围的manifest会得到相同的`dataset_version`，天然幂等去重，不产生重复行 |
| 不可变策略 | 分类B（严格只增型，见§2.0），且由内容寻址的主键设计从根本上排除"原地修改"这一操作的合法性 |

### 2.9 `dataset_version` 确定性生成规则（本轮重写：废止截断设计，采用完整SHA-256）

#### 2.9.0 `dataset_version` 最终格式（冻结，取代draft-3的截断方案）

```
dataset_version = `v1.4d-sha256-${contentHash}`
```
其中`contentHash`是`canonicalJsonHash(manifestContentObject)`产出的**完整64字符十六进制小写SHA-256摘要，不做任何截断**。示例（长度77字符）：
```
v1.4d-sha256-3a7f9c2e1b8d4f6a0e5c7b9d2a1f8e6c4b0d3a9f7e2c5b8d1a6f4e0c9b2d7a3f
```
**冻结理由**：64字符十六进制=256-bit，碰撞概率在生日悖论下对任何可预见的历史数据集规模（哪怕未来十年每天生成一份manifest，总量仍远低于2^128量级）都可忽略不计；相比之下draft-3曾使用的16字符十六进制=64-bit，虽然对当前样本规模也"够用"，但**没有理由主动引入本可避免的截断风险**——完整摘要的存储与索引成本（额外48字符）相对于其消除的风险而言微不足道，优先采用完整SHA-256，不采用"128-bit截断+content_hash冗余列+启动时校验相等"这一更复杂的备选方案。

#### 2.9.1 冻结绑定字段清单（`canonical manifest input`，内容哈希必须覆盖，缺一不可，本轮按用户清单逐项对齐）

```
manifestSchemaVersion（即 manifest_schema_version）
manifestHashAlgorithmVersion（即 manifest_hash_algorithm_version，本轮新增纳入，见2.9.4订正说明）
symbol
intervals
dataFrom（即 data_from，ISO8601字符串）
dataTo（即 data_to，ISO8601字符串）
backfillBatchIds（排序后的 backfill_batch_ids，见2.9.2）
manifestMembers（确定性排序后的 manifest_members，见2.9.2）
sourceFormalSemantics（即 source_formal_semantics）
researchAvailabilityRuleVersion（即 research_availability_rule_version）
recordCount（即 record_count）
perIntervalRecordCount（即 per_interval_record_count）
integrityCheckResult（即 integrity_check_result）
```

字段名采用`camelCase`（与数据库列的`snake_case`存储形式做映射，映射关系是1:1机械转换，不改变语义）。

#### 2.9.2 冻结排序规则（本轮重写：消除一切可能并列的歧义）

**`backfillBatchIds`排序规则**：
1. 先按`backfill_batch_id`（UUID）**去重**（同一批次ID在输入列表中只可能出现一次，若构建逻辑因bug产生重复，去重后不影响结果，但仍应在`dataset-manifest-builder.js`中记录一条WARNING，见Codex任务）；
2. 按UUID的**标准文本表示（小写、带连字符的规范形式）做严格字典序（逐字符按UTF-16 code unit）升序排列**。
3. UUID全局唯一，因此**不存在排序并列的可能性**，这条排序规则本身不需要再加任何tie-breaker。

**`manifestMembers`排序规则（红线：不得只依赖可能并列的部分字段）**：
1. 排序键为四元组，**依次比较**：`(intervalName, openTime, revisionNumber, vintageId)`；
2. `intervalName`：字典序（`'15m' < '1h' < '4h'`）；
3. `openTime`：数值升序（安全整数范围内的epoch毫秒，无精度损失风险）；
4. `revisionNumber`：数值升序；
5. **`vintageId`（本轮新增第四级排序键，闭环用户"不得只依赖可能出现并列值的部分字段"要求）**：字典序。`vintage_id`在生产`market_bars`表上有`UNIQUE`约束（全局唯一），是**唯一能保证不会与前三个字段一起仍然并列**的字段——理论上，若因未来schema演进等原因导致同一`(intervalName, openTime, revisionNumber)`组合出现多行（例如引入多数据源冗余采集），前三个字段将无法分出确定顺序，只有加入全局唯一的`vintageId`作为最终决胜字段，才能保证排序结果**对任意输入都严格确定**，不依赖"实践中大概率不会并列"这一概率性假设。

#### 2.9.3 每根K线的 `rowContentHash`

对该行`(open, high, low, close, volume, quoteVolume)`六个字段，按此固定顺序、以Postgres `numeric`类型的原始十进制字符串形式（**不经过JS `Number`类型转换**，避免浮点表示误差）拼装为待哈希的子对象，交给`canonicalJsonHash()`计算——理由见2.9.5"caller侧类型纪律"，该子哈希结果本身以字符串形式作为`manifestMembers`对应元素的`rowContentHash`字段值，参与外层的最终哈希。

#### 2.9.4 `canonicalJsonHash()` 核实结论（本轮实际读取`server/src/domain/hash.js`源码核实，不再标记为"待确认P2"）

**已完整读取`server/src/domain/hash.js`全文（37行），逐项核实结论如下**：

| 核实项 | 源码依据 | 结论 |
|---|---|---|
| 对象键是否规范化排序 | `canonicalJsonStringify`内部：`Object.keys(current).sort().map(key => ...)` | **是**——对象键统一按JS默认字符串字典序排序后再序列化，与调用方传入对象时的键书写顺序无关 |
| 数值/null/字符串序列化是否稳定 | `null`→字面量`'null'`；string/boolean→`JSON.stringify`；number→`JSON.stringify`并有`Number.isFinite`前置校验（非有限数直接抛出`RAW_JSON_UNSERIALIZABLE`） | **稳定，但有一个必须由调用方遵守的前提**：`JSON.stringify`对JS `number`类型的序列化基于IEEE-754双精度浮点表示，对**整数**（在`Number.MAX_SAFE_INTEGER`范围内，本场景下`openTime`/`revisionNumber`/`recordCount`等皆属此类）无精度损失、完全稳定；但对**小数**（OHLCV价格/成交量等源自Postgres `numeric`类型的字段）若以JS `number`传入，存在浮点精度损失/表示歧义风险——**这不是`canonicalJsonHash()`本身的缺陷，是调用方必须遵守的类型纪律**：本规范要求`canonical-manifest-content.js`对所有源自Postgres `numeric`的字段一律以**字符串**形式传入，不转换为JS `number`（见2.9.5） |
| 数组是否严格保留调用方顺序 | `canonicalJsonStringify`/`canonicalJsonHash`底层`encode`函数的数组分支：`current.map(encode).join(',')`，**不含任何`.sort()`调用** | **是，已确认**——数组元素按调用方传入的原始顺序逐一编码，函数本身**不会**对数组重新排序。这正是本规范要求`manifestMembers`/`backfillBatchIds`必须由调用方**预先**按2.9.2冻结规则排序后再传入的原因：排序职责在调用方，不在`canonicalJsonHash()`内部 |
| 是否采用冻结的哈希算法 | `sha256 = value => createHash('sha256').update(...).digest('hex')`（`node:crypto`），`canonicalJsonHash = value => sha256(canonicalJsonStringify(value))` | **是**——标准SHA-256（Node内置`crypto`模块），十六进制小写输出，与`manifest_hash_algorithm_version='v1.4d-manifest-hash-1'`所指代的算法一致 |

**额外确认的正面特性（超出四项核实要求，一并记录）**：`canonicalJsonStringify`对`undefined`/`bigint`/`function`/`symbol`类型、非纯JSON对象（如`Date`实例，其原型不是`Object.prototype`）、循环引用均**主动抛出异常**（`RAW_JSON_UNSERIALIZABLE`/`RAW_JSON_CIRCULAR`），即：若`canonical-manifest-content.js`意外传入`Date`对象而非ISO8601字符串，`canonicalJsonHash()`会**立即fail closed**，不会静默产生错误结果——这是`domain/hash.js`自带的安全网，但**仅覆盖"传入了非法类型"这一类错误，不覆盖"传入了合法但精度有损的JS number表示小数"这一类错误**（后者仍需2.9.5的调用方纪律兜底）。

**结论：`canonicalJsonHash()`满足本规范的确定性哈希契约，继续复用，不新建第二套哈希/序列化实现**。用户要求"如果现有函数不满足契约，规范必须要求在允许新增的模块中实现版本化canonical manifest编码"——**该条件不成立（现有函数满足契约），故不触发新建模块的要求**；但2.9.5的调用方类型纪律是本轮据此核实结果新增的**强制**要求，必须写入`canonical-manifest-content.js`的实现任务与验收测试（见`V1_4D_CODEX_IMPLEMENTATION_TASK.md`/`V1_4D_ACCEPTANCE_TESTS.md`R27新增项），不得只在本文档提及。

#### 2.9.5 Caller侧类型纪律（红线，`canonical-manifest-content.js`必须遵守）

1. 所有源自Postgres `numeric`类型的字段（`rowContentHash`计算中的`open`/`high`/`low`/`close`/`volume`/`quoteVolume`）**必须**以字符串形式传入`canonicalJsonHash()`，不得做`Number(...)`转换。
2. 所有时间字段（`dataFrom`/`dataTo`）**必须**以ISO8601字符串形式传入，不得传入JS `Date`对象（会被`canonicalJsonHash()`直接拒绝，见2.9.4）。
3. 整数字段（`openTime`/`revisionNumber`/`recordCount`/`perIntervalRecordCount`内部计数）可以是JS `number`（安全整数范围内无精度风险）。
4. `canonical-manifest-content.js`必须有单元测试断言：构造对象中所有"源自numeric"字段的`typeof`均为`'string'`，防止未来维护者不小心引入`Number()`转换（见验收测试R27.8）。

#### 2.9.6 禁止纳入哈希内容的字段（红线，防止破坏确定性，本轮不变）

`created_at`（manifest自身的）、`fetched_at`/回填任务实际执行时间、`backfill_batches`各批次的`started_at`/`finished_at`（只有`backfill_batch_id`本身进入哈希，批次的执行时间不进入）、任何数据库自增主键（`market_bar_id`等）、任何"本次查询/本次构建"相关的临时性时间戳。

#### 2.9.7 冻结性质（对照用户要求逐条确认）

- **同一内容必须生成同一`dataset_version`**：是——`canonicalJsonHash()`是纯函数（已核实），相同规范化输入产生相同输出，2.9.2排序规则消除了"查询顺序不同"这一变量（含并列场景，已用`vintageId`兜底）。
- **任一受保护内容变化必须生成不同`dataset_version`**：是——`manifestMembers`覆盖每根K线的`rowContentHash`（任一OHLCV值变化）、`revisionNumber`（revision选择变化）、`vintageId`集合本身（批次/覆盖范围变化）；`backfillBatchIds`（批次集合变化）；`researchAvailabilityRuleVersion`（可得性规则版本变化）；`integrityCheckResult`（质量检查结果变化）；`manifestSchemaVersion`/`manifestHashAlgorithmVersion`（格式/算法版本变化，本轮新纳入哈希内容）；任一变化都会改变`canonicalJsonHash()`的输入，从而**确定性地**改变输出，不依赖"算法变了输出大概率也会变"这类弱保证。
- **`created_at`、实际执行时间等非数据内容不得进入哈希**：是——见2.9.6红线。

**为何`dataset_manifests`不通过数据库外键结构性引用`public.market_bars`**：`manifest_members`是**冻结时刻**对`market_bars`当前状态的快照式内容摘要，而不是对`market_bars`具体行的持续性引用——`market_bars`本身没有为每行单独设计一个可供外键引用的稳定业务主键列（其PK是自增`market_bar_id`，业务身份靠`vintage_id`唯一约束表达），且更根本的原因是：**manifest的价值恰恰在于它不随`market_bars`未来变化而改变**（用户要求"旧run必须继续绑定原始manifest和哈希"）——如果设计成外键引用，`market_bars`行被后续回填流程新增/该区间被进一步补全时，无法定义"外键应该指向哪些新增的行"，而content-hash快照式设计天然regardless于`market_bars`后续如何变化，都能诚实回答"我当初冻结的究竟是什么"。

---

## 三、隔离保证清单（对照CEO裁决逐条自证）

### 三.0 Migration创建顺序（本轮更新：新增`dataset_manifests`并置于最前）

八张表存在外键依赖，migration 005的DDL**必须**按以下顺序创建（先被引用者先建），`.down.sql`按逆序`DROP`（或直接`DROP SCHEMA historical_validation CASCADE`一次性处理，效果等价且更不易遗漏依赖顺序）：

```
1. CREATE SCHEMA historical_validation;
2. dataset_manifests        （本轮新增，置于最前——无外键依赖，且被validation_runs/replay_snapshots/validation_reports引用，必须最先存在）
3. validation_runs          （FK → dataset_manifests(dataset_version)；自引用 resumed_from_run_id 可延后加约束或建表时允许NULL自引用）
4. backfill_batches         （无外键依赖，独立）
5. replay_generation_runs   （FK → validation_runs）
6. replay_evaluation_runs   （FK → validation_runs）
7. replay_snapshots         （FK → replay_generation_runs, backfill_batches, dataset_manifests(dataset_version)）
8. replay_outcome_events    （FK → replay_snapshots, replay_evaluation_runs）
9. validation_reports       （FK → validation_runs, dataset_manifests(dataset_version)）
```

**红线（本轮新增）**：`validation_runs`/`replay_snapshots`/`validation_reports`三表的`dataset_version`列**必须**是`REFERENCES historical_validation.dataset_manifests(dataset_version)`的正式外键，**不得**仅作为无约束的自由文本列——这是杜绝"CLI传入一个从未冻结过的`dataset_version`字符串"这一整类错误的数据库层兜底（应用层的CLI校验见§四新增流程，二者是纵深防御关系，不是互相替代）。

### 三.1 单个`validation_run`清理顺序（本轮新增，弥补draft-1只讨论"删整个schema"未讨论"删单次运行"的空白）

CEO裁决"删除实验运行不得影响市场原始数据或生产预测"此前只在draft-1中以"删除整个`historical_validation`schema不影响`public`schema"的粒度证明，**未覆盖"只删除某一个`validation_run_id`产生的数据、保留schema和其他run"这一更常见的清理场景**。本轮冻结该场景的删除顺序（按外键依赖，先删子表再删父表，避免`ON DELETE RESTRICT`报错中断）：

```
1. DELETE FROM replay_outcome_events WHERE evaluation_run_id IN (SELECT evaluation_run_id FROM replay_evaluation_runs WHERE validation_run_id = $1);
2. DELETE FROM replay_snapshots WHERE generation_run_id IN (SELECT generation_run_id FROM replay_generation_runs WHERE validation_run_id = $1);
3. DELETE FROM replay_evaluation_runs WHERE validation_run_id = $1;
4. DELETE FROM replay_generation_runs WHERE validation_run_id = $1;
5. DELETE FROM validation_reports WHERE validation_run_id = $1;
6. DELETE FROM validation_runs WHERE validation_run_id = $1;
```

**红线**：
- 该删除序列**只触碰`historical_validation`schema内部**，**不**涉及、不级联到`public.market_bars`/`public.feature_records`（回放表对生产表只有只读引用，无`ON DELETE CASCADE`反向传导，见下方§三.2隔离保证清单）；
- `backfill_batches`**不在**上述删除范围内——它归属"回填批次"而非"某次回放run"，一个`backfill_batch_id`可能被多个`validation_run`引用（历史数据一次回填、多次复用回放），删除单个`validation_run`**不得**删除其引用过的`backfill_batches`行；
- **`dataset_manifests`同样不在删除范围内（本轮新增红线）**——一个`dataset_version`（即一份冻结的manifest）可能被多个`validation_run`引用（同一冻结数据集上跑不同`algorithm_version`/`rule_version`的对比实验是正常场景），删除单个`validation_run`**不得**删除其引用过的`dataset_manifests`行，理由与`backfill_batches`一致，且更进一步——**manifest的存在本身独立于任何具体run是否还活着**，它是"这份数据集当初长什么样"的永久证据，即使所有引用它的run都被清理，manifest本身仍应保留（除非未来有独立的、显式的manifest生命周期管理规范，本轮不涉及）；
- 本轮**不实施**该删除脚本，仅冻结顺序供实施阶段编码时遵循，并要求对应验收测试（见`V1_4D_ACCEPTANCE_TESTS.md`新增项）验证执行后`public.market_bars`行数/内容不变。

### 三.2 隔离保证清单（对照CEO裁决逐条自证）

| 隔离维度 | 保证方式 |
|---|---|
| 不进入生产实时统计分母 | `replay_snapshots`/`replay_outcome_events`物理上不是`forecast_snapshots`/`forecast_outcome_events`，生产统计代码（现有及未来）没有任何理由查询`historical_validation`schema——只要生产代码不显式`SET search_path`或写跨schema查询（本规范禁止任何此类代码，见`V1_4D_CODEX_IMPLEMENTATION_TASK.md`） |
| **写操作是否显式schema-qualified（本轮新增，回应"是否真实可执行"复审）** | **`V1_4D_CODEX_IMPLEMENTATION_TASK.md`冻结要求**：`server/src/validation-replay/*`与`server/src/backfill/*`全部SQL语句，凡目标为`historical_validation`schema下任一表，**必须**显式写全限定表名（如`historical_validation.replay_snapshots`），**不得**依赖数据库连接的默认`search_path`隐式解析——理由：若某次连接的`search_path`被意外配置为包含`public`在前，一条本应写`historical_validation.replay_snapshots`但省略了schema前缀、且恰好`public`下存在同名表（当前不存在，但作为架构层防御不应假设未来也不存在）的语句，会被静默误写到错误的schema。本条**不依赖运行时配置正确性**，是代码书写规范层面的强制要求，验收测试见R21（本轮新增，静态扫描全部SQL字符串）。 |
| **`search_path`是否可能导致误写生产表（本轮新增）** | 即使某次连接`search_path`被外部配置为`historical_validation, public`（`historical_validation`在前），由于上一行"强制schema-qualified"的书写规范，`search_path`的默认解析顺序**不会被触发**（因为代码从不依赖它做隐式解析）；`historical_validation`与`public`两个schema下**不存在任何同名表**（`replay_snapshots`≠`forecast_snapshots`等，命名本身就不冲突），进一步降低即使误依赖`search_path`也会写错表的风险 |
| 生产API默认不可读取 | `server/src/api/server.js`现有路由全部只查询`public`schema下的生产表；本轮不新增任何暴露`historical_validation`内容的API路由（若未来需要只读展示，属于独立后续规范，本轮不预留接口设计，呼应`V1_4C_SCOPE_SPEC.md`CEO裁决六.6同类边界） |
| 生产调度器不知道其存在 | `CollectorService`/`ForecastGenerator`/`OutcomeEvaluator`/`FeatureGeneratorService`四个生产类完全不引用`historical_validation`任何表名，回放代码是独立可执行入口（见四），不被生产`bootstrap()`导入或启动 |
| 不使用生产lease | `historical_validation`所有表均无`lease_name`/`fencing_token`外键约束绑定`collector_leases`；回放执行入口的数据库写入不经过`assertLease()`（该函数本身也不会被回放代码调用） |
| 删除实验运行不影响市场原始数据或生产预测 | 见§三.1单run清理顺序 + 本行：`replay_snapshots`等表对`public.market_bars`/`public.feature_records`**只有只读引用，不设置`ON DELETE CASCADE`反向传导**（即删除`historical_validation`任何数据，不会级联影响`market_bars`；反过来`market_bars`任何行也不依赖`historical_validation`是否存在）；删除整个`historical_validation`schema是一个独立、可逆、不触碰`public`schema的操作（本轮不执行，仅确认设计上具备该性质） |
| `backfill_batches`与其余七张表的schema归属是否一致 | **是**——`backfill_batches`与其余七张表（含本轮新增`dataset_manifests`）**同属`historical_validation`schema**（§2.2/§2.8已定义，均在同一次migration 005中创建），不存在"回填审计表在一个schema、回放表在另一个schema"的割裂 |
| **`dataset_manifests`是否只存在于历史验证schema（本轮新增）** | **是**——`market_bars`本身不存储manifest或content_hash相关列（回填协议`V1_4D_DATA_BACKFILL_SPEC.md`未对生产`market_bars`表做任何schema变更），manifest是`historical_validation`独有的派生结构 |
| `source_origin='HISTORICAL_REPLAY'`是否只存在于历史验证schema | **是**——该值只出现在`historical_validation.replay_snapshots`/`replay_outcome_events`两表的CHECK约束域内；生产`public.forecast_snapshots`的CHECK约束域仅`{'SERVER'}`，`public.forecast_outcome_events`仅`{'SERVER','LEGACY_BROWSER'}`，两个CHECK域均**不包含**`'HISTORICAL_REPLAY'`，且两个schema的CHECK约束互相独立，不存在"扩展生产CHECK域"的操作路径（CEO裁决第2条的直接落实） |

---

## 四、历史回放执行入口

### 4.0 前置步骤：冻结数据集清单（本轮新增，两步流程的第一步）

在运行`validation:walk-forward`之前，必须先用**独立命令**冻结一份`dataset_manifests`记录（不由`validation:walk-forward`隐式触发，避免"冻结数据集"这一需要审慎对待的动作被当作副作用悄悄发生）：

```
npm run dataset:build-manifest -- \
  --symbol ETHUSDT \
  --intervals 15m,1h,4h \
  --from 2026-01-26T00:00:00Z \
  --to 2026-07-25T00:00:00Z
```

该命令对指定范围重新运行gap/duplicate/out-of-order完整性检查（复用`V1_4D_DATA_BACKFILL_SPEC.md`§2.12同款检测逻辑），检查通过后按§2.9公式构建`manifest_members`、计算`content_hash`、得到`dataset_version`，`INSERT`进`dataset_manifests`（`ON CONFLICT(dataset_version) DO NOTHING`，天然幂等——对同一内容范围重复执行不产生副作用，只是重新算一遍并确认哈希一致）。**完整性检查未通过则拒绝生成manifest**，打印失败原因，不写入任何行。命令输出`dataset_version`字符串，供下一步`validation:walk-forward --dataset-version <该值>`使用。

### 4.1 CLI 契约（冻结）

```
npm run validation:walk-forward -- \
  --symbol ETHUSDT \
  --from 2026-01-26T00:00:00Z \
  --to 2026-07-25T00:00:00Z \
  --horizons 24h,72h \
  --algorithm-version v1.4c-server-po-rule-1 \
  --dataset-version v1.4d-sha256-3a7f9c2e1b8d4f6a0e5c7b9d2a1f8e6c4b0d3a9f7e2c5b8d1a6f4e0c9b2d7a3f \
  --rule-version v1.4c-po-rule-1 \
  --split 50/25/25 \
  --dry-run
```
（等价的显式边界写法：以180天推荐窗口为例，`--train-end 2026-04-25T00:00:00Z --validation-end 2026-06-09T00:00:00Z`，与`--split 50/25/25`自动换算结果一致）

| 参数 | 必需 | 说明 |
|---|---|---|
| `--symbol` | 是 | 目前仅支持`ETHUSDT`（与生产`DEFAULT_GENERATION_TARGETS`一致，不扩大范围） |
| `--from`/`--to` | 是 | **UTC ISO8601**（`YYYY-MM-DDTHH:mm:ssZ`），回放的`historical_as_of_time`推进范围（含义：从`from`开始按horizon节奏推进候选`referenceCloseTime`，直到`to`），**必须**是历史时间（见4.3红线）。**格式校验（fail closed，本轮新增）**：非UTC格式（如缺失`Z`后缀、使用其他时区偏移量、非ISO8601）一律拒绝启动，返回`INVALID_TIME_FORMAT`，不做"尽力解析"或本地时区兜底 |
| `--horizons` | 是 | 逗号分隔，`24h`/`72h`子集，两者分开执行分开报告（呼应§五统计要求） |
| `--algorithm-version` | 是 | 显式指定，不读取代码里当前的`FEATURE_ALGORITHM_VERSION`常量作为隐式默认——**回放必须显式声明用的是哪个算法版本**，防止"代码升级后忘记声明，产出的历史报告实际混用了新旧版本"这类静默错误 |
| `--dataset-version` | 是 | 必须是`historical_validation.dataset_manifests`中**已存在**的`dataset_version`值（见§2.9生成规则）——**不再是任意人工字符串**，CLI启动前强制执行§4.1a冻结的校验流程，找不到对应manifest或内容校验失败一律拒绝启动 |
| `--rule-version` | 是 | PO规则版本，显式声明 |
| `--train-end`/`--validation-end` | 否，与`--split`二选一（见下） | 直接透传给`splitTimeOrdered({trainEnd, validationEnd})` |
| **`--split <train%/validation%/test%>`**（本轮新增） | 否，与`--train-end`/`--validation-end`二选一；三者都不传则整个`--from`~`--to`区间只产出`report_scope='ALL'`一份报告，不做三段切分 | **冻结默认值`50/25/25`**（见`V1_4D_DATA_BACKFILL_SPEC.md`§1.0）——按`--from`~`--to`总日历天数乘以比例、四舍五入到整数天，自动换算为`trainEnd`/`validationEnd`绝对时间戳，等价于手工传`--train-end`/`--validation-end`。**红线：`--split`与`--train-end`/`--validation-end`不得同时传入**，同时出现视为参数冲突，拒绝启动（`CONFLICTING_SPLIT_PARAMS`） |
| `--dry-run` | 否，默认false | 见4.2 |
| `--resume <validation_run_id>` | 否 | 见4.4，**冻结新规则**：必须与原run全部参数一致，不一致则拒绝 |

**参数顺序校验（fail closed，本轮新增）**：启动时必须校验 `from < trainEnd < validationEnd < to`（严格小于，不允许相等或颠倒）——三段切分点必须落在`[from, to)`区间内部且互不重合，任一不满足直接拒绝启动，返回`INVALID_SPLIT_ORDER`，不静默调整或忽略切分参数。

**启动横幅（fail-safe UX，本轮新增）**：CLI每次启动（含`--dry-run`）必须在stdout首行打印醒目警告，例如：
```
================================================================
  HISTORICAL RESEARCH ONLY — 本次运行为历史研究回放
  写入目标：historical_validation schema（与生产数据完全隔离）
  不产出交易信号、不代表当前市场状态、不得用于实盘决策
================================================================
```
该横幅**不是**装饰性文本，是`V1_4D_ACCEPTANCE_TESTS.md`验收测试可断言的**必需输出**（见R22）。

**输出**：控制台打印本次`validation_run_id`；执行完成后所有统计结果落库于`historical_validation.validation_reports`，不额外生成文件（是否叠加Markdown/CSV导出留待实现阶段按需扩展，非本轮冻结范围）。

### 4.1a Dataset Manifest 强制校验流程（本轮新增，P1闭环核心，**先于**一切replay/outcome生成逻辑执行）

无论`--dry-run`与否、无论是否`--resume`，`validation:walk-forward`在做任何`historical_as_of_time`推进或写入之前，**必须**按以下八步顺序执行（对照用户"三、CLI自动校验"逐条冻结）：

```
第1步：SELECT * FROM historical_validation.dataset_manifests WHERE dataset_version = <--dataset-version传入值>;
        找不到 → fail closed，返回 DATASET_MANIFEST_NOT_FOUND，不得继续。

第2步：用该manifest行记录的 symbol/intervals/data_from/data_to/backfill_batch_ids，
        对 public.market_bars 重新执行与manifest构建时完全相同的查询与§2.9规范化序列化，
        重新计算 recomputedContentHash。

第3步：比对 recomputedContentHash 与 manifest.content_hash（完整64字符十六进制，即dataset_version去掉
        "v1.4d-sha256-"前缀后的完整剩余部分，本轮起不存在任何截断形式）。
        不一致 → fail closed，返回 DATASET_CONTENT_HASH_MISMATCH，列出manifest记录的record_count/data_from/data_to
        与本次重新查询得到的对应值，辅助定位差异来源；不得继续。

第4步：独立比对 record_count、per_interval_record_count、data_from、data_to、backfill_batch_ids
        （即使第3步哈希已隐含这些信息，仍单独比对以产生更具体的错误信息，而非只报"哈希不一致"）：
        任一不一致 → fail closed，对应错误码 DATASET_RECORD_COUNT_MISMATCH / DATASET_TIME_RANGE_MISMATCH /
        DATASET_BATCH_SET_MISMATCH，不得继续。

第5步：比对 manifest.research_availability_rule_version 与本次CLI/代码内置的当前
        research_availability_rule_version：不一致 → fail closed，返回
        DATASET_RESEARCH_AVAILABILITY_VERSION_MISMATCH，不得继续
        （此情形意味着自manifest冻结以来researchAvailability规则已升级，必须先用
        dataset:build-manifest对同一数据范围重新冻结一份新manifest、取得新dataset_version后才能继续）。

第6步：以上五步全部通过后，才允许进入 historical_as_of_time 推进循环，
        开始（或继续）生成 replay_snapshots/replay_outcome_events。

第7步（resume专属）：--resume时，第1~5步必须【重新完整执行一次】，不得因为"上次已经验证过"而跳过——
        因为resume可能发生在初次执行之后的任意时间点，此期间market_bars可能已发生额外回填，
        必须重新确认manifest仍然内容一致。

第8步（dry-run专属）：--dry-run时，第1~7步【同样完整执行】（这些校验本身只是SELECT+哈希计算，
        天然只读，不违反"dry-run零写入"）；校验通过后，dry-run按§4.2继续输出执行计划但不写入
        replay_snapshots等业务表；校验失败时，dry-run同样fail closed并报告失败原因，
        这正是dry-run最重要的用途之一——在真正写入前就能发现数据集已漂移。
```

**红线**：
- **禁止仅相信CLI传入的`--dataset-version`字符串**——上述第1~5步是强制的、不可跳过的服务端重新验证，`--dataset-version`参数本身只是一个**待验证的声明**，不是可信输入。
- **任一环节fail closed时，禁止生成任何`replay_snapshot`/`replay_outcome_event`/`validation_report`**，也不得把`validation_runs`本次尝试标记为除`FAILED`外的任何终态。
- 该校验流程是`server/src/validation-replay/`新增模块`dataset-manifest-verifier.js`的职责（见`V1_4D_CODEX_IMPLEMENTATION_TASK.md`新增任务），与§4.1a描述的八步一一对应，不得在实施阶段简化或合并步骤。

### 4.2 `dry-run`

`--dry-run`时，回放执行**完整的读取+计算**逻辑（含`bar-path-locator.js`定位、feature查询、PO状态计算、outcome计算），但**所有数据库写入调用替换为空操作**——即`replay_snapshots`/`replay_generation_runs`/`replay_outcome_events`/`replay_evaluation_runs`/`validation_reports`**五张业务表**（本轮订正：不含`backfill_batches`——该表不属于回放CLI的写入目标，属于回填CLI，见`V1_4D_DATA_BACKFILL_SPEC.md`；也不含`validation_runs`——见下）在`dry-run`模式下**零写入**（`validation_runs`本身允许写入一行记录本次dry-run的执行审计，因为这不是"业务数据"，是"我跑过一次dry-run"这一事实的记录，其`dry_run=true`列本身就是为了让审计者能区分）。dry-run模式用于验证CLI参数解析、时间范围、数据可得性检查是否正确，**必须输出一份"执行计划"**（本轮新增要求：列出预计推进的`historical_as_of_time`节奏点数量、预计涉及的`backfill_batch_id`范围、预计的purge边界，供使用者在真正写入前复核），但不产出可用于统计的实际结果。

### 4.3 禁止使用真实当前时间代替 `historical_as_of_time`（红线）

回放执行入口在启动时**必须**校验 `--to <= 当前真实UTC时间 - max(24h, 72h对应的horizon窗口长度)`（即请求的回放终点必须早于"现在减去最长horizon"，否则会退化为对着未成熟数据做"未来路径"评估，产生大量`BLOCKED`/`INSUFFICIENT_DATA`，且存在把最近若干天误当作"历史"实际却在追赶实时的语义混淆风险）——校验失败直接拒绝启动（`INVALID_REPLAY_RANGE`）。回放内部的`historical_as_of_time`来源**只能**是`--from`到`--to`之间按`computeAlignedReferenceCloseTime`节奏推进算出的历史时间戳序列，**代码路径中不得出现任何`Date.now()`/`serverTimeProvider()`调用被用作`asOfTime`输入**（验收测试见D文档"asOfTime未来泄漏攻击测试"）。

### 4.4 `resume`（本轮补强：必须绑定原run全部冻结参数）

`--resume <validation_run_id>`：读取该`validation_run_id`已产生的`replay_generation_runs`/`replay_evaluation_runs`记录，确定已完成的`historical_as_of_time`推进游标，从下一个未处理的节奏边界继续，不重跑已成功的部分（即使重跑，`prediction_id`唯一约束也会使其安全去重，`resume`只是性能优化，不是正确性前提）。

**红线（本轮新增，防止"resume"被误用为"用新参数悄悄接着跑"）**：`--resume <validation_run_id>`时，CLI**必须**从`validation_runs`表读取原run记录的`symbol`/`horizons`/`from_utc`/`to_utc`/`algorithm_version`/`dataset_version`/`rule_version`/`train_end_utc`/`validation_end_utc`，并与本次命令行传入的同名参数逐一比对：
- 若本次命令行**省略**了某参数，视为"沿用原run的值"，不算冲突；
- 若本次命令行**显式传入**且与原run记录的值**不一致**，**拒绝启动**，返回`RESUME_PARAM_MISMATCH`，并在错误信息中列出具体哪个参数不一致——**不得**静默采用新值继续跑（那样会导致同一个`validation_run_id`下混杂两种参数产生的数据，破坏可复现性与审计链）；
- `research_availability_rule_version`/`FEATURE_ALGORITHM_VERSION`等**代码内置版本常量**若在resume时与原run记录的版本不一致（例如两次执行之间代码升级了），同样**拒绝启动**，要求发起一个全新的`validation_run`而非resume。
- **本节与§4.1a的关系**：上述参数一致性比对（"resume是否用了同一套参数"）与§4.1a的manifest内容校验（"`dataset_version`所指内容是否仍与冻结时一致"）是**两个独立的校验层**，都必须通过——前者防止"参数被偷偷换掉"，后者防止"参数没变但`dataset_version`背后的实际数据已经漂移"（例如`market_bars`被追加写入导致重新查询结果不同，即使这种情况在正常回填协议下不应发生，仍作为纵深防御保留）。

### 4.5 同一 run 重复执行幂等

同一`validation_run_id`（通过`--resume`或误操作重复触发同一次执行，且参数经4.4校验一致）多次运行，最终`replay_snapshots`/`replay_outcome_events`表状态**收敛一致**（`ON CONFLICT DO NOTHING`），`validation_reports`因是覆盖写而**总是反映最新一次运行后的完整视图**，不会因重复执行产生统计口径错误（不会重复计数）。

### 4.6 禁止事项（红线，代码层面必须体现，见Codex任务边界文档）

- 禁止调用生产`ForecastGenerator.executeRunOnce()`/`OutcomeEvaluator`对应的顶层运行方法（这两个方法硬编码生产`serverTimeProvider()`与生产lease，语义上就不可能安全复用于回放，见第一阶段审计结论）。
- 禁止任何数据库写语句目标为`forecast_snapshots`/`forecast_outcome_events`/`forecast_generation_runs`/`forecast_evaluation_runs`。
- 禁止调用`acquireLease`/`heartbeat`/`releaseLease`/`assertLease`等任何生产lease相关函数。

### 4.7 可复用的现有纯函数 vs 禁止复用的生产服务包装层

| 可直接复用（纯函数，`asOfTime`已参数化，无生产状态副作用） | 说明 |
|---|---|
| `bar-path-locator.js`：`computeAlignedReferenceCloseTime`,`locateReferenceBarAndPath`,`computeFourHourAtr14`,`computeConsecutiveBreakoutBars`,`rhythmBoundaryMs` | 唯一需要调整：内部查询目前用`available_at<=asOfTime`，回放场景需改为消费`researchAvailability`（见`V1_4D_DATA_BACKFILL_SPEC.md`§2.9），**具体做法是在回放专用的数据访问层包一层等价查询（同样的`close_time`/`revision_number`选取逻辑，只是可得性判据换成`researchAvailability=close_time`），不修改这些函数本身的签名和已有生产查询**（避免动生产代码引入回归风险） |
| `threshold-formula.js`：`computeDirectionThreshold`,`computeFourHourAtr14FromBars` | 纯数学函数，直接复用 |
| `po-state-engine.js`：`evaluatePoState` | 纯函数，直接复用，**不修改任何阈值/规则**（呼应§六红线） |
| `forecast-contract.js`：`finalizeForecastSnapshot`,`computeExpectedPriceZones`,`deriveExpectedDirection`,`computeRawScenarioScore`,`buildTriggerConditions`,`buildInvalidationConditions` | 纯函数，直接复用 |
| `outcome-engine.js`：`computeForecastOutcome` | 纯函数，直接复用 |
| `server/src/validation/walk-forward.js`：全部导出 | 直接复用，本来就是为此设计 |
| `domain/vintage.js`：`assertNoFutureLeak` | 建议在回放数据访问层显式调用作为二次防护 |
| **`domain/hash.js`：`canonicalJsonHash`（P1闭环核心依赖，本轮已实际核实源码满足契约，见§2.9.4）** | 生产已在`feature_records.content_hash`/`forecast_snapshots.content_hash`/`forecast_quality_events.content_hash`等多处使用的规范化JSON哈希函数，`dataset_manifests.content_hash`/`dataset_version`生成（§2.9）**直接复用同一份实现**，不新建第二套规范化算法；调用方（`canonical-manifest-content.js`）须遵守§2.9.5类型纪律（numeric字段传字符串、时间字段传ISO8601字符串） |

| **禁止复用（生产服务/入口层，含隐藏的生产副作用）** | 原因 |
|---|---|
| `ForecastGenerator`类的`start`/`schedule`/`executeRunOnce`/`generateSnapshot`/`transaction`/`acquireLease`/`heartbeat`/`releaseLease` | 硬编码生产lease/生产表/实时`serverTimeProvider` |
| `OutcomeEvaluator`类的等价方法 | 同上 |
| `waitForExactFeature`（`ForecastGenerator`方法） | 虽逻辑是纯粹的point-in-time查询，但该方法是类实例方法，与生产`this.abortController`/`this.featureWaitMs`等生产调度状态耦合，回放层应实现独立的等价查询函数（同样的SQL模式：`as_of_time<=$asOfTime`），不直接调用此方法 |
| `CollectorService`/`FeatureGeneratorService`/`bootstrap()` | 与回放完全无关，回放不启动任何生产服务实例 |

---

## 五、Walk-forward 统计与报告（冻结字段清单）

`validation_reports`每份报告必须包含（对照用户任务五全部逐项落实到2.7节字段）：

- `rawSampleCount`/`effectiveSampleCount`：direction类、path类分别独立（4个数字），24h/72h分别独立报告（不同`report_scope`/`horizon`各自一份）。
- UP/DOWN/RANGE独立统计：`up_down_range_breakdown`按`expected_direction`分组。
- `directionCorrect`：来自`replay_outcome_events.direction_correct`聚合。
- MFE/MAE：来自`replay_outcome_events.mfe`/`mae`聚合（复用`outcome-engine.js`既有公式，不重新定义）。
- path完整性/endpoint完整性：`path_data_complete`/`endpoint_data_complete`比例披露。
- PO_\*状态交叉统计：`po_state_breakdown`，9个状态各自的raw/effective样本数、方向准确率、样本不足标注（见§六）。
- formal/proxy来源披露：`formal_proxy_disclosure`，显式声明path评估100%来自formal（`market_bars`），回放从不读`provisional_market_bars`（呼应`V1_4D_DATA_BACKFILL_SPEC.md`§2.13"不读取或写入provisional_market_bars"）。
- train/validation/test固定时间切分结果：`report_scope`区分的多份报告。
- rolling window结果：`report_scope='ROLLING_WINDOW'`，配合`rollingWalkForwardWindows`产出的多个子窗口各自一份（或以jsonb数组形式在同一份报告内展开，具体粒度留待实现阶段，不改变"必须报告"这一冻结要求）。
- 不允许随机打乱：`splitTimeOrdered`本身无随机成分，验收测试覆盖（见D文档）。
- 不允许根据测试结果反向修改规则：`algorithm_version`/`rule_version`在`validation_runs`创建时冻结写入，运行中/运行后不可修改；若需调整PO规则，必须走独立新`rule_version`+全新`validation_run`（呼应§六）。
- `calibratedProbabilities`保持null：`calibrated_probabilities_status`固定文本声明。
- Brier Score字段只允许null占位：`brier_score_component`列CHECK恒NULL。
- `primaryCause`/`notEvaluableCauses`误差归因结构：`replay_outcome_events`落地`V1_4_HISTORICAL_VALIDATION_SPEC.md`§5.1/§5.2冻结的判定规则表，`error_attribution_summary`做聚合展示。
- 样本不足标记：`sample_sufficient`字段 + `checkSampleSufficiency()`产出的`disclosure`文案直接落库展示。
- **PO状态最低门槛尚未冻结的显式披露**：`po_state_breakdown`中每个状态的记录必须携带固定文案标记，如`"MIN_SAMPLE_THRESHOLD_NOT_FROZEN（仅horizon级别30/10已冻结，按PO_状态细分的最低门槛本规范未定义，不得凭空推断充分性）"`。
- **跨边界剔除披露（本轮新增，呼应`V1_4D_DATA_BACKFILL_SPEC.md`§1.1 purge规则）**：`report_scope IN ('TRAIN','VALIDATION','TEST')`时，`purged_straddling_count`必须展示，且报告文案必须说明"该数字之和未计入本段effectiveSampleCount，完整样本请见`report_scope='ALL'`视图"。
- **`ActionPermission`不出现（本轮新增，P1-1）**：任何`validation_reports`内容**不得**包含`ActionPermission`字段或等价的交易权限标注——本schema从设计上不计算此字段（见§2.3行内说明），报告生成代码路径不得新增该计算。
- **`research_availability_rule_version`随报告披露（本轮新增，P1-2）**：`validation_reports`应在报告元信息中带出本次统计所基于的`research_availability_rule_version`，供读者判断该报告是否基于最新的可得性规则版本产生。

---

## 六、PO_UNKNOWN 专项诊断规范（仅设计，不修改PO规则）

**背景**：生产现有15条真实快照100%为`PO_UNKNOWN`，样本太少不能下结论（第一阶段审计已明确态度）。**本轮明确订正（P1-4修订）**：更大的回放窗口（130/180/365天）只意味着"如果非UNKNOWN状态确实在历史价格路径中出现过，有更多机会被回放观测到"，**不意味着回填/回放本身会让PO_UNKNOWN占比自然下降**——`PO_UNKNOWN`占比高低取决于`po-state-engine.js`现有阈值与ETH真实历史价格结构的相互作用，这一关系在回放执行、拿到`poStateDistribution`实际结果之前**无法预判**（详见`V1_4D_DATA_BACKFILL_SPEC.md`§1.6，两文档结论一致）。本节只为回放报告设计**诊断结构**，以便无论回放结果显示`PO_UNKNOWN`占比是否依然很高，都能用同一套预先冻结的四类候选原因框架去分析成因，而不是在看到结果后临时决定怎么解读。

### 6.1 回放完成后的诊断报告结构（新增字段，落于`validation_reports`或独立`po_diagnostic_summary`子结构）

```
poDiagnosticReport (per validation_run, per horizon):
  poStateDistribution: { [poState in 9种PO_*状态]: { rawCount, effectiveCount, shareOfTotal } }
  poUnknownShare: number  // PO_UNKNOWN占effectiveSampleCount总数的比例
  inputConditionHitRates: {
    // evaluatePoState()各判定分支的输入条件命中率，纯统计，不涉及修改判定逻辑
    // 例如：closeToEma5落在各判定区间的比例、breakoutState各取值比例、swingHigh/Low缺失比例等
    // 具体字段清单在实现阶段对照po-state-engine.js当前分支条件逐条枚举，本规范只冻结"必须逐条件统计命中率"这一要求
  }
  stateTransitionMatrix: { [fromState]: { [toState]: count } }  // 相邻回放样本（按targetStartTime排序）之间proxyState的转移计数
  persistentUnknownDiagnosis: {
    // 当poUnknownShare过高（无预设数值门槛，由分析者结合inputConditionHitRates与stateTransitionMatrix人工研判）时，
    // 报告必须列出以下四类可能性各自的支持/反对证据，不预设结论：
    marketTrulyStructureless: { evidence: [...] },      // 1. 市场确实无结构
    thresholdTooStrict: { evidence: [...] },             // 2. 阈值过严
    inputFieldsLongTermMissing: { evidence: [...] },     // 3. 输入字段长期缺失（对照feature_records的DERIVATIVES_INCOMPLETE等质量标记）
    stateEngineImplementationError: { evidence: [...] }  // 4. 状态引擎实现错误（如与po-state-engine.js单元测试预期不符的边界样例）
  }
```

### 6.2 红线

1. **禁止在看到回放结果后立即修改`po-state-engine.js`的任何阈值/判定条件**——本文档只定义诊断报告的**结构**，不授权任何"发现UNKNOWN占比高就顺手调阈值"的操作。
2. **如确需调整PO规则**：必须（a）形成新的`rule_version`（version递增，不得静默覆盖当前版本），（b）新版本必须重新走一次**完全独立的**`validation_run`（不得复用旧`validation_run_id`下已产生的`replay_snapshots`，因为PO规则变了，历史快照的`proxy_state_at_generation`等字段基于旧规则计算，混用会产生方法论错误），（c）新旧两个`rule_version`的报告必须并列保留、可对比，不得覆盖删除旧版本报告。
3. 本诊断报告是**描述性**输出，不产出任何"建议调整为XX阈值"的具体数值建议——那属于人工判断+独立规范修订流程，不是回放系统自动产出的内容。

---

## 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.4d-replay-draft-1 | 2026-07-25 | 初稿：冻结`historical_validation`schema五张核心表+一张支持表设计、历史prediction_id命名空间、CLI契约与resume/dry-run/幂等语义、可复用纯函数与禁止复用清单、Walk-forward统计报告字段、PO_UNKNOWN诊断结构与红线 |
| v1.4d-replay-draft-2 | 2026-07-25 | 第三阶段独立复审修订：①表数量口径订正为**七张**（§二，draft-1changelog漏计`validation_runs`）；②新增§2.0可变性三分类（状态机型/严格只增型/覆盖写例外），纠正"五张不可变表"的不精确表述；③`replay_snapshots`/`replay_outcome_events`新增独立列`research_availability_rule_version`，唯一约束改为复合键，防止规则版本变化被静默去重（P1-2）；④`replay_snapshots`新增`action_permission`结构性排除说明与攻击测试引用（P1-1）；⑤新增§三.0 migration创建顺序、§三.1单run清理顺序、§三.2隔离表新增search_path/schema-qualified/source_origin独立CHECK域三项验证；⑥CLI新增`--split`默认50/25/25、UTC格式/顺序fail-closed校验、resume参数一致性校验、HISTORICAL RESEARCH ONLY启动横幅（§四）；⑦§五新增purge披露、ActionPermission不出现声明；⑧§六订正PO_UNKNOWN背景表述，删除"拿到更大样本后能区分成因"的隐含乐观预期（P1-4） |
| v1.4d-replay-draft-3 | 2026-07-26 | 第三阶段补充修订：关闭`dataset_version`内容哈希P1。①表数量**七张→八张**，新增`dataset_manifests`（§2.8），归入分类B（§2.0）；②新增§2.9冻结`dataset_version`确定性生成规则（绑定字段清单、复用`domain/hash.js canonicalJsonHash()`、`manifest_members`确定性排序、禁止纳入哈希的字段红线、`dataset_version`格式公式）；③`validation_runs`/`replay_snapshots`/`validation_reports`的`dataset_version`列改为正式外键指向`dataset_manifests`（§三.0迁移顺序同步更新，`dataset_manifests`置于最前）；④新增§4.0两步流程（先`dataset:build-manifest`冻结，后`validation:walk-forward`引用）与§4.1a八步强制校验流程（含resume/dry-run场景的重新校验要求）；⑤§三.1清理顺序新增`dataset_manifests`不随单run删除的红线；⑥§4.7复用清单新增`domain/hash.js canonicalJsonHash` |
| v1.4d-replay-draft-4 | 2026-07-26 | 第三阶段定向修订（关闭截断P1）：①**废止`dataset_version`64-bit截断格式**（`v1.4d-ds-{16hex}`），改为**完整SHA-256**`v1.4d-sha256-{64hex}`（§2.9.0），不采用"128-bit截断+content_hash冗余列"备选方案；②`content_hash`列改为Postgres**生成列**（`GENERATED ALWAYS AS`），结构性消除与`dataset_version`分歧的可能性，不再需要"启动时校验二者相等"这一步骤；③`manifest_hash_algorithm_version`订正为**纳入**哈希内容（draft-3"避免循环定义"的理由被本轮推翻，纳入后算法版本变化可确定性反映为不同版本号）；④`manifest_members`排序规则新增第四级决胜字段`vintageId`（全局唯一），彻底消除排序并列歧义；⑤`backfillBatchIds`排序规则明确去重+UUID字典序；⑥**实际读取`server/src/domain/hash.js`源码**（37行）逐项核实四项契约（键排序/数值稳定性/数组保序/哈希算法），结论：满足契约，继续复用，同时新增§2.9.5"caller侧类型纪律"红线（numeric字段/时间字段的字符串化要求），不再标记"待确认P2"；⑦CLI示例与`prediction_id`示例同步更新为完整哈希格式 |
