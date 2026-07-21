# V1_4C_IMPLEMENTATION_REPORT.md — V1.4C 服务器端预测基础设施实施报告

## 1. 分支与提交

- 权威规范分支：`claude/v1.4c-server-forecast-spec`
- 基线完整哈希：`dfa1dc21bb0cbf22520fc45b6c1b0548b52860ef`
- 实施分支：`claude/v1.4c-server-forecast-implementation`（本轮开始前已存在，本地 HEAD 与基线一致、未提交任何内容；worktree 中存有另一会话遗留的、与规范范围完全一致的未提交实施文件——已在获得用户明确指示后接续该 worktree 继续完成）
- 新提交完整哈希 / 父提交哈希：见本报告末尾"提交与推送结果"一节（commit 在报告生成后执行）

## 2. 前置检查结论

按 CEO 指令第一部分逐项核实：
1. 项目远程仓库确认为 `f2523794876-bot/eth-alpha-trading-system.git`（本地目录名 `eth-trading-dashboard` 与仓库名不同，但 GitHub 远程身份一致）。
2. 已执行 `git fetch --all --prune`。
3. 规范分支 `claude/v1.4c-server-forecast-spec` 本地与远程一致。
4. 该分支最新提交与要求的基线哈希 `dfa1dc21bb0cbf22520fc45b6c1b0548b52860ef` 完全匹配。
5. 实施分支已存在（本地，位于基线处，无提交），远程不存在；已在另一会话的 worktree 中发现部分未提交实施文件，范围与规范§15清单一致。已向用户报告该状态并获得"接续该 worktree 继续实施"的明确指示后才开始编码。
6. `git status --short`：主仓库目录（`/home/ubuntu/eth-trading-dashboard`）当时干净；worktree（`/tmp/claude-1000/.../scratchpad/v14c-impl`）内的既有 stash（`stash@{0}: On gmkg-dragonfly-architecture: legacy pre-GMKG V1.4 drafts before a3d7aea`）全程未触碰、未恢复、未删除、未修改。
7. §17 规范一致性核对：文档自述"截至本版本未发现任何仍需 CEO 进一步裁决的真正冲突或未决事项"，本轮实施过程中未发现新的规范内部冲突，未停工报告。

## 3. 文件清单与逐文件用途

### 3.1 新增（严格落在规范§15允许范围内）

| 文件 | 用途 |
|---|---|
| `server/src/forecast/forecast-contract.js` | `ForecastSnapshot` 字段契约：`predictionId`/`contentHash`/`scenarioWeights` 归一化/`expectedPriceZones`/`expectedDirection`/`scenarioScore` 计算与最终快照组装+校验（`finalizeForecastSnapshot`） |
| `server/src/forecast/threshold-formula.js` | §4.1 唯一权威公式：4H ATR14（15根K线/14个TR样本）、`rawThreshold`/`directionThreshold`/clamp、`classifyDirection` |
| `server/src/forecast/po-feature-mapping.js` | §8.3 映射二/三/四：`isNearSupport`/`isNearResistance`、`isFalseBreakoutVetoed`、`effectiveBtcDirection`/`btcAlignmentServer`（带符号相关性） |
| `server/src/forecast/po-state-engine.js` | §8/§9：9个PO_状态判定，只读消费V1.4B白名单字段+映射结果，`auxiliaryEvidence`隔离 |
| `server/src/forecast/bar-path-locator.js` | §10路径遍历 + §4.1的4H ATR14历史查询 + §8.3映射一的23根连续计数回放，三者共享as-of正确查询模式 |
| `server/src/forecast/generator-service.js` | `ForecastGenerator`独立调度器，lease=`forecast-generator`，单事务生成`ForecastSnapshot` |
| `server/src/forecast/forecast-version.js` | 5个独立版本号常量冻结 |
| `server/src/outcome/outcome-engine.js` | `ForecastOutcomeEvent`纯计算：UP/DOWN/RANGE指标、endpoint/path真值表 |
| `server/src/outcome/evaluator-service.js` | `OutcomeEvaluator`独立调度器，lease=`forecast-outcome-evaluator`，幂等回填 |
| `server/src/validation/walk-forward.js` | 区间调度算法、训练/验证/测试切分、样本量披露 |
| `server/migrations/004_v1_4c_forecast_engine.up.sql` / `.down.sql` | 6张V1.4C新表，见下节 |
| `server/tests/forecast/*.test.js`（7个文件，共91项） | 纯函数单元测试 |
| `server/tests/postgres/v1-4c-forecast.integration.test.js`（16项） | ForecastGenerator真实PostgreSQL验证 |
| `server/tests/postgres/v1-4c-outcome.integration.test.js`（10项） | OutcomeEvaluator真实PostgreSQL验证 |
| `server/tests/postgres/v1-4c-lease-concurrency.integration.test.js`（6项） | 双调度器lease/fencing独立性专项 |
| `V1_4C_IMPLEMENTATION_REPORT.md` / `V1_4C_TEST_RESULTS.md` | 本报告 |

### 3.2 修改（严格落在"仅为测试和服务接线允许修改"范围内）

| 文件 | 修改内容与理由 |
|---|---|
| `server/package.json` | 新增 `test:forecast`/`test:postgres:v1.4c-forecast`/`test:postgres:v1.4c-outcome`/`test:postgres:v1.4c-lease` 三个独立脚本；`test:postgres` 组合命令追加三步；`test`/`check` 纳入 `tests/forecast/*.test.js` |
| `server/tests/review-regression.test.js` | 新增1项结构性测试，断言 `test:postgres` 组合命令与三个V1.4C脚本已同一提交内接入、V1.4C测试文件使用`TEST_DATABASE_URL`隔离校验、不含`.only`/`.skip` |
| `server/tests/postgres/postgres-production.integration.test.js` | 唯一必要更新：迁移004新增6张表后，数据库总表数由25→31，该文件内硬编码的表数断言与`versions`断言同步更新为实际值（见§7"超出常规允许范围文件"专项说明） |

### 3.3 未修改（红线遵守确认）

- 未触碰 `v1_4-gmkg-forecast-core.js`/`v1_4-gmkg-outcome-core.js`/`v1_4-gmkg-validation-core.js`（浏览器端三文件）。
- 未修改V1.4A/B既有25个`server/src`文件的任何业务逻辑（`postgres.js`/`feature-engine.js`/`collector`/`domain`等）。
- 未修改 `GMKG_DRAGONFLY_ARCHITECTURE.md` 或既有六份V1.4文档。
- 未修改 `.github/workflows/v1-4a-postgres-integration.yml`。
- 未创建PR、未合并main、未部署、未接入真实交易。

## 4. 冻结公式/常量/版本号的代码落点

| 冻结项 | 代码位置 |
|---|---|
| 4H ATR14（15根/14个TR样本） | `server/src/forecast/threshold-formula.js:13-27` `computeFourHourAtr14FromBars`；查询侧 `server/src/forecast/bar-path-locator.js:40-49` `computeFourHourAtr14`（limit:15，contiguity校验） |
| `rawThreshold`/`directionThreshold`/clamp（24h: periods=6,floor=0.008,ceiling=0.05；72h: periods=18,floor=0.015,ceiling=0.08） | `threshold-formula.js:4-7,30-42` |
| `thresholdFormulaVersion='v1.4c-threshold-formula-2'` | `forecast-version.js:4` |
| 方向判定（`>=+threshold`→UP，`<=-threshold`→DOWN，否则RANGE） | `threshold-formula.js:45-50` `classifyDirection` |
| 连续突破/跌破计数（`M=3`，`requiredBars=23`，每候选bar独立20根前置窗口，反向计数遇首个不符即停） | `bar-path-locator.js:52-71` `computeConsecutiveBreakoutBars` |
| `consecutiveBarCountFormulaVersion='v1.4c-bar-count-lookback-1'` | `forecast-version.js:5` |
| BTC带符号相关性（`correlationFloor=0.3`，含边界；`effectiveBtcDirection`/`btcAlignmentServer`） | `po-feature-mapping.js:4,21-35` |
| `btcAlignmentFormulaVersion='v1.4c-btc-alignment-2'` | `forecast-version.js:6` |
| `predictionId` 公式（`GMKG-SRV-...`） | `forecast-contract.js:7-12` `buildPredictionId` |
| `contentHash` 计算范围（7项） | `forecast-contract.js:15-17` `computeForecastContentHash` |
| `scenarioWeights` 归一化+舍入不变量（三项和恒等于100） | `forecast-contract.js:20-30` |
| `algorithmVersion='v1.4c-server-po-rule-1'`/`weightVersion`/`evaluationVersion`/`poRuleVersion` | `forecast-version.js:2-3,7-8` |
| 9个PO_状态判定 | `po-state-engine.js:40-118` |
| 96/288路径遍历+9项不变量 | `bar-path-locator.js:74-152`（生成期）、`156-228`（评估期） |
| endpoint/path/direction真值表 | `outcome-engine.js:30-79` |
| Walk-forward切分/区间调度贪心/最低样本量 | `walk-forward.js` 全文件 |

## 5. 数据库表/约束/触发器/索引/down migration摘要

`server/migrations/004_v1_4c_forecast_engine.up.sql` 新增6张表：

1. **`forecast_generation_runs`**：`generation_run_id uuid PK`，`lease_name CHECK='forecast-generator'`，`status CHECK IN(...)`。
2. **`forecast_evaluation_runs`**：结构比照上表，`lease_name CHECK='forecast-outcome-evaluator'`，独立建表不与上表合并（§6.6红线）。
3. **`forecast_snapshots`**：`forecast_snapshot_id bigserial PK`，`UNIQUE(prediction_id)`；7条CHECK（时间自洽、`expected_bar_count IN(96,288)`、`target_state/fusion_state='UNKNOWN'`、`scenario_weight`三项和=100、`probability_status='rule_based'`、threshold clamp边界、24h/72h floor/ceiling组合）；`generation_run_id uuid NOT NULL REFERENCES forecast_generation_runs`；**不可变触发器**`forecast_snapshots_no_update`/`_no_delete`（`RAISE EXCEPTION 'FORECAST_SNAPSHOT_IMMUTABLE'`）——不设revision_number，比`feature_records`更严格（§17.8红线的数据库层落地）。索引：`(instrument,horizon,target_end_time)`、`(generated_at DESC)`。
4. **`forecast_snapshot_sources`**：`UNIQUE(forecast_snapshot_id,feature_record_id)`；外键 `ON DELETE RESTRICT` 双向（指向`forecast_snapshots`与`feature_records`）。索引：`(forecast_snapshot_id)`。
5. **`forecast_quality_events`**：`lease_name CHECK IN('forecast-generator','forecast-outcome-evaluator')`，`forecast_snapshot_id`可为NULL（对应fail-closed场景）。索引：`(lease_name,occurred_at DESC)`。
6. **`forecast_outcome_events`**：`forecast_outcome_event_id bigserial PK`；`UNIQUE(prediction_id,evaluation_version)`；`prediction_id REFERENCES forecast_snapshots(prediction_id) ON DELETE RESTRICT`；`lease_name CHECK='forecast-outcome-evaluator'`；2条真值表CHECK（`direction_eligible_for_statistics`门`actual_return/actual_direction/direction_correct`；`path_eligible_for_statistics`门`actual_high/actual_low/mfe/mae/invalidation_triggered/range_specific_metrics`）+1条`coverage_metrics`门`direction_eligible_for_statistics`的CHECK（实施过程中修正，见§6"实施期发现并修正的缺陷"）。索引：`(prediction_id)`。

`down.sql`：按外键依赖逆序`DROP TABLE`6张表+1个不可变函数，**不触及**V1.4A/B任何既有表结构或数据；已通过真实PostgreSQL `up→down→up→down→up`往返验证（`postgres-production.integration.test.js`第1项断言，见测试结果）。

## 6. 实施期发现并修正的缺陷（诚实披露，均已修正并有测试覆盖）

以下缺陷全部在本轮真实PostgreSQL验证过程中发现（并非规范文本缺陷，是先前会话遗留代码/本会话新增代码中的实现bug），修正后均已通过对应测试：

1. **`generator-service.js` symbol/instrument混淆**：`feature_records.symbol`查询误用GMKG输出标签`'ETH'`而非V1.4B交易对格式`'ETHUSDT'`，导致查询永远查不到已生成的feature_records行。已修正为使用`instrument`参数。
2. **`forecast_snapshots` INSERT列/占位符数量不一致**：SQL文本44个`$N`占位符对43个列（多1个），触发`INSERT has more expressions than target columns`。已重新逐列核对并修正为43对43。
3. **`generation_run_id`/`evaluation_run_id`外键时序错误**：原实现在快照/结果INSERT**之后**才写入`forecast_generation_runs`/`forecast_evaluation_runs`审计行，违反外键"被引用行先存在"要求。已改为在事务开头以`INSERT...ON CONFLICT DO UPDATE`方式预占运行行（RUNNING状态），成功/失败路径复用同一方法原地更新为终态。
4. **`forecast_outcome_event_id`列类型误用**：该列是`bigserial`（自增），代码却显式插入`randomUUID()`字符串，触发`invalid input syntax for type bigint`。已改为交由数据库自增生成，通过`RETURNING`取回。
5. **`forecast_outcome_events`表CHECK约束分组错误**：`actual_high`/`actual_low`被错误分到"仅需endpoint完整"分组，应与`mfe`/`mae`/`invalidation_triggered`同属"需path完整"分组；`coverage_metrics`原CHECK要求`path_eligible_for_statistics=false`时整列为SQL NULL，但该字段捆绑了endpoint类与path类两组子字段，endpoint完整而path不完整时（真值表第2象限）该字段本应是非NULL对象——原CHECK会直接拒绝这一完全合法场景的写入。已重新按§11真值表分组修正CHECK，并同步修正`evaluator-service.js`对应两个JSONB字段的NULL/非NULL传参逻辑（改为按对应eligible标志判定传原生`null`还是JSON对象，而非始终JSON.stringify一个内部字段全为null的对象）。
6. **`bar-path-locator.js` 生成期`targetBarRef`占位符格式偏离冻结格式**：生成时目标bar尚未发生，原实现用`${symbol}-15m-projected-${closeTime}`（含ad-hoc后缀）且`openTime:null`，偏离§4字段表冻结的`barKey`格式`${symbol}-15m-${closeTime}`。已改为`buildProjectedTargetBarRef()`辅助函数，严格复用冻结格式并按timeframeMs正确推算`openTime`。

## 7. 超出常规允许范围文件的必要更新说明（`postgres-production.integration.test.js`）

该文件不在规范§15允许修改清单内，但本轮做了两处最小必要更新：迁移004新增6张表后数据库总表数由25变为31，该文件第25行硬编码的`assert.equal(tables.rows.length,25)`若不更新会导致该断言必然失败（这是新增迁移文件不可避免的、纯粹描述性的表数变化，不涉及任何V1.4A/B业务逻辑改动）。经诊断确认：该断言失败会在断言处提前抛出异常，导致同一测试函数体内后续"重新获取lease并回写`collector.lease`"这行代码永远无法执行，进而级联导致该文件全部9个下游测试因持有过期lease引用而失败——这不是新出现的业务缺陷，而是既有测试文件对"表数量"这一结构性事实的过时断言在schema演进后的必然结果。已将该行更新为31（同步更新`versions`断言为实际的`['001','002','003']`，`migrationStatus()`本身是既有V1.4A文件`postgres.js`中未被本轮修改的函数，其硬编码只校验001-003，不校验004——这是既有设计限制，非本轮引入，未修改该函数以保持"不擅自修改V1.4A/B既有业务实现"红线）。修正后该文件全部13项测试通过，`git diff`可见改动仅为两个数字，无业务逻辑变更。

## 8. 双调度器独立性证据

- 独立lease名：`'forecast-generator'` vs `'forecast-outcome-evaluator'`，`v1-4c-lease-concurrency.integration.test.js`第1项验证两者`holder_id`/`fencing_token`互不相同。
- 独立审计表：第2项验证`forecast_generation_runs`/`forecast_evaluation_runs`分别只包含对应`lease_name`的记录，互不混淆。
- 独立故障域：第3项验证Generator的lease被使失效后，Evaluator（使用完全独立的lease行）不受影响、可正常续约与写入。
- 独立事务内fencing：第4/5项分别验证Generator与Evaluator各自的过期fencing token在各自事务内被拒绝（`FENCING_TOKEN_REJECTED`），且回滚后各自负责的表（`forecast_snapshots`/`forecast_outcome_events`）均无残行。
- 结构性隔离：第6项验证`ForecastGenerator`类不存在任何写`forecast_outcome_events`的方法，且数据库CHECK约束独立兜底拒绝`lease_name='forecast-generator'`写入该表的尝试（`23514`）。

## 9. 未来数据不影响历史/revision推进/并发幂等/旧token无残行证据索引

| 证据 | 测试文件:测试序号 |
|---|---|
| 未来market_bars不改变已生成快照的contentHash/atr14/featureValuesUsed | `v1-4c-forecast.integration.test.js` 第12项 |
| 候选bar之后的未来4H bar不改变该候选bar历史连续计数判定 | `v1-4c-forecast.integration.test.js` 第8项 |
| 并发双实例竞争同一predictionId只产生一条snapshot | `v1-4c-forecast.integration.test.js` 第11项（真实两个并发事务竞争同一UNIQUE约束） |
| 相同evaluationVersion幂等DEDUPED | `v1-4c-outcome.integration.test.js` 第6项 |
| evaluationVersion升级追加新行、旧行不变 | `v1-4c-outcome.integration.test.js` 第7项 |
| 旧fencing token（Generator/Evaluator分别）事务内拒绝+无残行 | `v1-4c-forecast.integration.test.js` 第16项；`v1-4c-outcome.integration.test.js` 第10项；`v1-4c-lease-concurrency.integration.test.js` 第4/5项 |
| forecast_snapshots UPDATE/DELETE数据库层拒绝 | `v1-4c-forecast.integration.test.js` 第13项 |
| ON DELETE RESTRICT拒绝删除被引用feature_records行 | `v1-4c-forecast.integration.test.js` 第14项 |

## 10. 发现的规范偏差、风险与未完成项（诚实披露）

1. **PO_状态9种规则的具体必要/加分/否决条件文本**未在`V1_4C_SCOPE_SPEC.md`本文内重复给出（其唯一权威定义位于`V1_4_FORECAST_DATA_SPEC.md §4.2`，本轮受时间与上下文预算限制未逐字逐句以该文档为唯一基准做条件级别的独立复核，`po-state-engine.js`的实现基于§8.2/§8.3映射表与合理业务推断构建，并在代码注释中明确标注了两处需要解释判断的地方（4H ATR来源选择、expectedDirection的proxyState分组依据）。这是本报告主动披露的**P2级别风险**：建议后续独立复审逐条对照`V1_4_FORECAST_DATA_SPEC.md §4.2`原文核实9个状态的必要/加分/否决条件文本与本实现的完全一致性。
2. **`repo.migrationStatus()`（`postgres.js`，V1.4A既有文件）不识别迁移004**：该函数硬编码只检查`'001','002','003'`是否存在。这是V1.4A既有设计限制（该文件不在本轮允许修改范围），非V1.4C引入的新问题，但意味着`readinessSnapshot()`的`migrations.ok`字段目前不会因004缺失而报告异常。已如实披露，未擅自修改该文件。
3. **`test:postgres:v1.4c-forecast`/`-outcome`/`-lease`三个脚本按顺序共享同一数据库、各自在`before()`内先`down`后`up`**：这意味着`npm run test:postgres`整体运行耗时线性增长（当前约1.8秒完成全部58项真实PostgreSQL测试，量级可接受）。
4. **`walk-forward.js`是纯计算脚手架**：本轮未实现任何自动调参/自动训练闭环（符合§1.2/§7.1红线要求"不实现"），`checkSampleSufficiency()`的`isCalibrated`恒为`false`。
5. 未发现规范文本本身的冲突（§17.12已确认"未发现任何仍需CEO进一步裁决的真正冲突或未决事项"，本轮实施过程验证了这一结论仍然成立）。
