# V1_4D_ACCEPTANCE_TESTS.md — V1.4D 验收测试（冻结草案）

版本：v1.4d-tests-draft-5（多symbol Dataset Manifest契约补充：新增R28共24条测试，对照`V1_4D_MULTI_SYMBOL_MANIFEST_ADDENDUM.md`落地，见变更记录）
基线：`main@eb89c49f0957617c453ea2c0d149afb55e97dad0`
角色：本文档是 V1.4D（历史数据回填 + 隔离式Walk-forward回放）验收测试的唯一权威清单，供未来Codex实施完成后逐条勾选。**本轮不创建任何测试代码**，只定义测试规范。

严重等级说明：**P0**=阻断性（不通过则不得进入下一步/不得判定`READY_FOR_IMPLEMENTATION_REVIEW`）、**P1**=功能正确性、**P2**=可用性/体验。

ID前缀`R`（Replay/回填）区别于既有`T`系列（V1.4主线），避免编号冲突。

---

## R1. 回填幂等与分页边界

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| R1.1 | P0 | 空`market_bars`目标区间 | 对同一`(symbol, interval, from, to)`连续执行回填两次 | 第二次执行后对比第一次执行后的行数与内容哈希 | 行数、内容完全一致，第二次执行`rows_inserted=0`，`rows_deduped=`全部页面行数 | 自动（集成） | V1_4D_DATA_BACKFILL_SPEC.md§2.6 |
| R1.2 | P0 | — | 构造跨越多页边界（如`limit=1000`情形下第1000/1001根K线）的连续时间区间 | 执行回填，检查`open_time`序列 | 页与页之间无缺口、无重复，`open_time`严格按`intervalMs`递增 | 自动（集成，可mock Binance响应分页） | V1_4D_DATA_BACKFILL_SPEC.md§2.1 |
| R1.3 | P1 | — | 请求区间恰好落在两页边界中间 | 执行回填 | 分页游标正确对齐，不产生半页重复请求 | 自动 | 同上 |

## R2. UTC 边界与未收盘隔离

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| R2.1 | P0 | — | 窗口宽度计算脚本，跨越本地时区DST/非DST边界的测试机 | 执行"计算N天前的UTC起点"逻辑 | 结果与用UTC epoch直接运算的结果完全一致，不受运行机器本地时区影响 | 自动 | V1_4D_DATA_BACKFILL_SPEC.md§2.2 |
| R2.2 | P0 | mock Binance返回一页数据，末尾含一根`close_time>当前服务器时间`的未收盘K线 | 执行回填 | 该未收盘K线**必须被过滤丢弃**，不写入`market_bars`，也不写入`provisional_market_bars`（回填流程完全不碰该表） | 自动 | V1_4D_DATA_BACKFILL_SPEC.md§2.5 |
| R2.3 | P1 | — | 回填任务启动前mock`measureServerTime()`返回`clockOffsetMs`超过`MAX_CLOCK_OFFSET_MS` | 尝试启动回填 | fail closed，拒绝启动，不发起任何HTTP请求或写入 | 自动 | V1_4D_DATA_BACKFILL_SPEC.md§2.4 |

## R3. 缺口、重复、乱序检测

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| R3.1 | P0 | 回填后的`market_bars`目标区间 | 执行回填后完整性校验 | 校验`open_time`序列步长、`close_time>open_time`、无未来行 | 全部通过则批次标记`SUCCEEDED`；任一失败则标记`ATTENTION_REQUIRED`，不自动重试覆盖 | 自动 | V1_4D_DATA_BACKFILL_SPEC.md§2.12 |
| R3.2 | P0 | mock一次网络故障导致某一页丢失 | 执行回填后完整性校验 | 必须检测出该缺口，不得被静默忽略 | 自动（故障注入） | 同上 |
| R3.3 | P1 | 目标区间与现有实时采集覆盖区间部分重叠 | 执行回填 | 重叠部分因`vintage_id`冲突被`ON CONFLICT DO NOTHING`跳过，不产生重复行，完整性校验仍通过 | 自动 | V1_4D_DATA_BACKFILL_SPEC.md§2.6/§2.13 |

## R4. 实际回填时间与 research availability 语义（P0，时间泄漏治理核心）

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| R4.1 | **P0** | 回填一根`close_time`为90天前的历史K线，回填任务实际执行时间为"今天" | 检查该行`available_at`/`fetched_at`列 | 二者均等于**回填任务实际执行的系统时间**（"今天"），**严禁**等于`close_time`（90天前） | 自动 | V1_4D_DATA_BACKFILL_SPEC.md§2.9裁决1 |
| R4.2 | **P0** | 同上，另用生产`bar-path-locator.js`现有查询（`available_at<=asOfTime`）以90天前某`asOfTime`查询该行 | 执行生产point-in-time查询 | **查询不到该行**（因为`available_at`（今天）> `asOfTime`（90天前））——验证生产查询语义未被污染，回填不会让生产逻辑误以为历史上早已知道这条数据 | 自动 | 同上 |
| R4.3 | **P0** | 同一行数据，改用回放专属`research-availability.js`查询，`researchAvailability=close_time` | 以`asOfTime=close_time+1ms`执行回放查询 | **能查询到该行**，验证回放侧的`researchAvailability`机制正确工作 | 自动 | V1_4D_DATA_BACKFILL_SPEC.md§2.9裁决2/3 |
| R4.4 | P1 | — | 检查`replay_snapshots`/`replay_outcome_events`任意一行的`research_data_vintage`字段 | 内容审查 | 必须包含`researchAvailability`公式版本声明与所消费`market_bars`行的`available_at`/`close_time`快照，缺失则判定不合格 | 自动 | V1_4D_HISTORICAL_REPLAY_SPEC.md§2.3 |

## R5. `asOfTime` 未来泄漏攻击测试

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| R5.1 | **P0** | 构造某历史`referenceCloseTime=T`，其后96根15m路径K线**故意**在`researchAvailability`意义下部分"尚未发生"（`close_time>T+24h`的边界之外不存在，或人为把某根未来bar的`close_time`设置早于其真实市场时间以模拟攻击） | 以`historicalAsOfTime=T`执行回放生成 | 只能看到`close_time<=researchAvailability`边界内的bar，**任何**`close_time`晚于`T`的15m bar不得出现在`observedBars`/`missingBarRefs`判定的"已观测"集合中 | 自动 | V1_4D_HISTORICAL_REPLAY_SPEC.md§4.7；`domain/vintage.js assertNoFutureLeak` |
| R5.2 | **P0** | 全代码路径静态审查 | `server/src/validation-replay/*`全部文件 | grep检查`Date.now()`/`serverTimeProvider`/`new Date()`（不含测试固定输入）出现次数 | **零命中**——回放代码路径不得存在任何真实当前时间来源作为`historical_as_of_time`输入 | 自动（静态扫描）+人工复核 | V1_4D_HISTORICAL_REPLAY_SPEC.md§4.3 |
| R5.3 | P0 | `--to`参数设置为"当前时间-1小时"（不满足§4.3边界要求） | 尝试启动回放CLI | 拒绝启动，返回`INVALID_REPLAY_RANGE` | 自动 | V1_4D_HISTORICAL_REPLAY_SPEC.md§4.3 |
| R5.4 | P1 | 构造revision场景（未来若接入有修订风险的数据源时的回归测试占位，当前`market_bars`恒`revision_number=0`） | 若某bar存在多个revision，且高revision的`available_at`晚于`asOfTime` | 回放查询 | 必须选中`available_at<=asOfTime`（或回放语境下`researchAvailability`口径）的**最高**revision，不得选中未来才可得的修订版本 | 自动 | 同R5.1；呼应`bar-path-locator.js`既有`ORDER BY revision_number DESC`模式 |

## R6. Revision 选择正确性

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| R6.1 | P1 | — | 回填写入的全部行 | 检查`revision_number`列 | 恒为0，与生产`revision`语义一致 | 自动 | V1_4D_DATA_BACKFILL_SPEC.md§2.7 |
| R6.2 | P0 | 已存在`revision_number=0`的一行 | 尝试对该行发起任何形式的回填"更新" | 执行回填（目标区间与已有行重叠） | 该行内容**逐字节不变**（无`UPDATE`语句执行） | 自动 | V1_4D_DATA_BACKFILL_SPEC.md§2.7红线 |

## R7. 历史schema与生产schema物理隔离

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| R7.1 | **P0** | migration 005已应用 | 查询`information_schema.tables WHERE table_schema='historical_validation'` | 确认恰好存在**八张**表（`dataset_manifests`/`validation_runs`/`backfill_batches`/`replay_snapshots`/`replay_generation_runs`/`replay_outcome_events`/`replay_evaluation_runs`/`validation_reports`），数量不多不少，均在该schema下、不在`public`下 | 自动 | V1_4D_HISTORICAL_REPLAY_SPEC.md§二 |
| R7.1a | P1 | 同上 | 查询建表时间戳/migration执行日志中的DDL顺序 | 核对实际建表顺序 | 与§三.0冻结顺序一致（先`validation_runs`/`backfill_batches`，后依赖它们的表，最后`validation_reports`），验证migration脚本未因顺序错误导致FK报错后被迫调整 | 自动/人工 | V1_4D_HISTORICAL_REPLAY_SPEC.md§三.0 |
| R7.2 | **P0** | — | 检查`historical_validation.*`全部表的外键定义 | 逐表审查 | 无任何外键指向`public.forecast_snapshots`/`forecast_outcome_events`/`forecast_generation_runs`/`forecast_evaluation_runs`/`collector_leases`；`public`schema下四张`forecast_*`表也无任何列/约束指向`historical_validation` | 自动（schema内省查询）+人工复核 | V1_4D_HISTORICAL_REPLAY_SPEC.md§三 |
| R7.3 | P1 | — | `server/src/api/server.js`全文 | 代码审查 | 无任何路由查询`historical_validation`schema | 人工 | 同上 |
| R7.4 | P1 | — | `server/src/index.js`/`lifecycle.js`/四个生产服务类 | 代码审查 | 无任何import/引用`server/src/validation-replay/*`或`server/src/backfill/*` | 人工 | V1_4D_CODEX_IMPLEMENTATION_TASK.md§1.2 |

## R8. 生产统计分母与生产lease不受影响

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| R8.1 | **P0** | 记录回放执行前`public.forecast_snapshots`/`forecast_outcome_events`/`forecast_generation_runs`/`forecast_evaluation_runs`行数与`content_hash`集合 | 执行一次完整回放（非dry-run，覆盖24h与72h，跨越多个历史节奏边界） | 回放执行完成后重新查询同四张表 | 行数、内容**逐行不变**（零新增、零修改、零删除） | 自动（集成） | 用户CEO裁决第3条 |
| R8.2 | **P0** | 回放执行前后 | 查询`collector_leases`表全部行 | 对比`acquired_at`/`fencing_token`/`holder_id` | **逐字段不变**——回放不曾获取/续租/释放任何生产lease | 自动 | CEO裁决第4条 |
| R8.3 | P1 | 回放执行期间 | 监控实时生产`forecast-generator`/`forecast-outcome-evaluator`两个lease的heartbeat | 观察回放执行窗口 | heartbeat持续按生产自身节奏刷新，无中断、无fencing_token异常跳变 | 自动（长时间观察）或人工 | 呼应R18 |

## R9. `dry-run` 与 `resume`

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| R9.1 | **P0** | — | `--dry-run`执行完整24h+72h回放 | 执行前后对比`historical_validation`**五张**业务表（不含`validation_runs`自身审计行，也不含`backfill_batches`——后者不属于回放CLI写入目标，见R9.1a） | `replay_snapshots`/`replay_generation_runs`/`replay_outcome_events`/`replay_evaluation_runs`/`validation_reports`**零新增行**；`validation_runs`允许新增1行（`dry_run=true`） | 自动 | V1_4D_HISTORICAL_REPLAY_SPEC.md§4.2 |
| R9.1a | P1 | — | `--dry-run`执行期间 | 检查`backfill_batches`表 | **零变化**——回放CLI（`validation:walk-forward`）不应触碰该表，它只由回填CLI写入 | 自动 | V1_4D_HISTORICAL_REPLAY_SPEC.md§4.2 |
| R9.1b | P1 | `--dry-run`执行 | 检查stdout输出 | 核对是否输出"执行计划" | 必须包含预计推进的`historical_as_of_time`节奏点数量、预计`backfill_batch_id`范围、预计purge边界 | 自动 | V1_4D_HISTORICAL_REPLAY_SPEC.md§4.2 |
| R9.2 | P0 | 一次真实（非dry-run）回放在处理到第N个历史节奏边界时被人为中断（kill进程） | `--resume <validation_run_id>` | 重新执行 | 从`last_completed`游标之后继续，不重复计算已完成部分，最终结果与"从未中断、一次性跑完"完全一致（`content_hash`比对） | 自动（故障注入+集成） | V1_4D_HISTORICAL_REPLAY_SPEC.md§4.4 |
| R9.3 | P0 | — | 同一`validation_run_id`执行两次完整回放（无中断） | 对比两次执行后`replay_snapshots`等表最终状态 | 完全一致，第二次执行不产生任何重复行（`ON CONFLICT DO NOTHING`） | 自动 | V1_4D_HISTORICAL_REPLAY_SPEC.md§4.5 |

## R10. `prediction_id` 命名空间隔离

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| R10.1 | **P0** | — | 回放生成的全部`replay_snapshots.prediction_id` | 字符串前缀检查 | 100%以`GMKG-REPLAY-`开头 | 自动 | V1_4D_HISTORICAL_REPLAY_SPEC.md§一 |
| R10.2 | P0 | 构造一个`referenceCloseTime`与生产已有真实`forecast_snapshots`行完全相同的历史回放场景 | 生成对应`replay_snapshots`行 | 其`prediction_id`与生产`forecast_snapshots`对应行的`prediction_id`**字符串不同**（前缀`GMKG-REPLAY-`≠`GMKG-SRV-`），二者可以同时存在于各自的表中互不冲突 | 自动 | 同上 |

## R11. 八张表可变性分类断言（本轮扩展，取代draft-1仅覆盖两张表的做法）

按`V1_4D_HISTORICAL_REPLAY_SPEC.md`§2.0三分类分别断言，不再笼统称"不可变表"（`dataset_manifests`本轮归入B类，见R11.1a）：

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| R11.1 | P0 | — | 全仓库`server/src/validation-replay/*`+`server/src/backfill/*`代码 | grep`UPDATE replay_snapshots`、grep`UPDATE replay_outcome_events`（B类：严格只增型） | 零命中 | 自动（静态扫描） | V1_4D_HISTORICAL_REPLAY_SPEC.md§2.0/§2.3 |
| R11.1a | **P0** | 同上 | grep`UPDATE dataset_manifests`（本轮新增，B类） | 静态扫描 | 零命中；详细的内容级"覆盖测试"见R26.14 | 自动（静态扫描） | V1_4D_HISTORICAL_REPLAY_SPEC.md§2.0/§2.8 |
| R11.2 | P0 | 已存在一条`replay_outcome_events`记录 | 对同一`(prediction_id, evaluation_version, research_availability_rule_version)`重复执行评估 | 检查表内容 | 不产生第二条记录，原记录不变（`ON CONFLICT DO NOTHING`） | 自动 | V1_4D_HISTORICAL_REPLAY_SPEC.md§2.5 |
| R11.3 | P1 | `validation_runs`/`backfill_batches`/`replay_generation_runs`/`replay_evaluation_runs`（A类：状态机型）任一行处于`RUNNING`状态 | 正常执行流程 | 观察该行状态转移 | 允许原地`UPDATE status`/`finished_at`/`error_code`等字段**恰好一次**（RUNNING→终态） | 自动 | V1_4D_HISTORICAL_REPLAY_SPEC.md§2.0 |
| R11.4 | **P0** | A类表任一行已进入终态（`SUCCEEDED`/`FAILED`/`BLOCKED`/`ATTENTION_REQUIRED`） | 尝试对该行发起任何形式的二次`UPDATE`（含状态、时间戳、计数字段） | 执行更新语句 | 应用层拒绝执行（不产生数据库层面的额外约束依赖，由代码逻辑保证），验收测试断言更新前后内容逐字节不变 | 自动 | V1_4D_HISTORICAL_REPLAY_SPEC.md§2.0 |
| R11.5 | P1 | `validation_reports`（C类：覆盖写例外）已存在一份报告 | 用完全相同的输入数据重新生成同一`(validation_run_id, horizon, report_scope)`报告 | 对比覆盖前后`content_hash` | 应完全一致（相同输入产生相同输出，覆盖写不引入不确定性） | 自动 | V1_4D_HISTORICAL_REPLAY_SPEC.md§2.7 |

## R12. MFE/MAE 与 path/endpoint 完整性

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| R12.1 | P1 | 一个`pathEligibleForStatistics=true`的历史回放样本 | 执行评估 | 检查`mfe`/`mae`数值 | 与直接复用`outcome-engine.js computeForecastOutcome()`对同一输入的计算结果**完全一致**（复用同一份代码，不重新实现公式） | 自动 | V1_4D_HISTORICAL_REPLAY_SPEC.md§4.7 |
| R12.2 | P1 | `pathEligibleForStatistics=false`的样本（未来路径数据不完整） | 执行评估 | `mfe`/`mae`/`actual_high`/`actual_low`等路径类字段必须为NULL（CHECK约束层面强制） | 自动 | V1_4D_HISTORICAL_REPLAY_SPEC.md§2.5 |
| R12.3 | P1 | `directionEligibleForStatistics=false`的样本 | 执行评估 | `actual_return`/`actual_direction`/`direction_correct`必须为NULL | 自动 | 同上 |

## R13. raw/effective 样本披露与时间顺序切分

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| R13.1 | P0 | 一批已生成的`replay_snapshots`+`replay_outcome_events` | 执行`report-builder.js` | 检查`validation_reports`行 | 同时包含`rawSampleCount`与`effectiveSampleCount`（direction/path各一对），不得只展示一个 | 自动 | V1_4D_HISTORICAL_REPLAY_SPEC.md§五 |
| R13.2 | P0 | — | `report-builder.js`调用`splitTimeOrdered`/`computeEffectiveSampleCount`的方式 | 代码审查+单元测试 | 直接调用`server/src/validation/walk-forward.js`既有导出函数，未重新实现或复制一份算法 | 自动+人工 | V1_4D_CODEX_IMPLEMENTATION_TASK.md§3.1 |
| R13.3 | P0 | 构造样本集合并打乱输入顺序（reverse数组）后调用切分逻辑 | 两次调用，输入顺序不同 | 对比输出 | 结果完全一致（确定性排序，不依赖输入顺序，呼应`walk-forward.test.js`既有同款测试） | 自动 | `server/tests/forecast/walk-forward.test.js`既有用例延伸 |

## R14. `LEGACY_BROWSER` 排除

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| R14.1 | P1 | — | `historical_validation`全部表的`source_origin`（若定义为枚举）或等效列 | 检查CHECK约束 | 只允许`'HISTORICAL_REPLAY'`，不包含`'LEGACY_BROWSER'`或`'SERVER'` | 自动 | V1_4D_HISTORICAL_REPLAY_SPEC.md§2.3 |
| R14.2 | P1 | — | `report-builder.js`统计逻辑 | 代码审查 | 不存在任何读取IndexedDB或浏览器端存储的代码路径（物理隔离在服务器端代码中天然满足，此测试确认没有引入例外） | 人工 | `V1_4C_SCOPE_SPEC.md`CEO裁决六 |

## R15. `calibratedProbabilities` / Brier 字段恒 null

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| R15.1 | **P0** | — | `replay_snapshots.calibrated_probabilities` | 尝试插入非NULL值（测试性违规插入） | 数据库CHECK约束拒绝，插入失败 | 自动 | CEO裁决第6条 |
| R15.2 | **P0** | — | `replay_snapshots.brier_score_component` | 同上 | CHECK约束拒绝任何非NULL值 | 自动 | V1_4D_HISTORICAL_REPLAY_SPEC.md§2.3 |
| R15.3 | P0 | — | `replay_snapshots.target_state_at_generation`/`fusion_state_at_generation` | 尝试插入非`'UNKNOWN'`值 | CHECK约束拒绝 | 自动 | CEO裁决第7条 |
| R15.4 | P1 | — | 全部`report-builder.js`产出报告 | 内容检查 | 不包含任何真实交易/仓位建议文本 | 人工+关键词扫描 | 用户任务边界；`ActionPermission`语义 |

## R16. `primaryCause`/`notEvaluableCauses` 误差归因

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| R16.1 | P1 | 一条`directionEligibleForStatistics=true`且`direction_correct=false`的样本 | 执行归因标注 | 检查`primary_cause`取值 | 只能取自`V1_4_HISTORICAL_VALIDATION_SPEC.md`§5.1"可评估"/"部分可评估"子集，不得出现`exogenous_shock` | 自动 | 同规范§5.1/§5.2a |
| R16.2 | P1 | — | 任意样本的`not_evaluable_causes` | 检查是否显式列出`environment_misread`/`formal_transition_misread`/`fusion_weight_error`/`action_permission_error`/`exogenous_shock`等全部V1.4D阶段不可评估项 | 必须显式列出，不得省略 | 自动 | 同规范§5.2红线 |
| R16.3 | P1 | 价格剧烈波动样本 | 检查`unexplainedExtremeMove`标记 | 该标记不得出现在`primary_cause`/`secondary_causes`枚举值中，只能作为独立诊断字段 | 自动 | 同规范§5.2a |

## R17. `PO_UNKNOWN` 诊断报告

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| R17.1 | P1 | 一批回放样本 | 执行`po-diagnostic.js` | 检查输出结构 | 包含9个PO_\*状态（含`PO_UNKNOWN`）各自的raw/effective计数、`inputConditionHitRates`、`stateTransitionMatrix` | 自动 | V1_4D_HISTORICAL_REPLAY_SPEC.md§六 |
| R17.2 | **P0** | 全代码路径审查 | `server/src/forecast/po-state-engine.js` | 对比V1.4D实施前后的文件内容/哈希 | **逐字节不变**——诊断报告生成过程不得修改PO判定逻辑 | 自动（内容哈希比对）+人工 | 用户任务"仅做规范设计，不修改PO规则" |
| R17.3 | P1 | `poUnknownShare`达到某个观察到的高比例（不预设具体数值触发） | 检查`persistentUnknownDiagnosis`输出 | 四类可能性（市场无结构/阈值过严/字段缺失/引擎错误）均有对应`evidence`字段，不得只给结论不给证据，不得預设结论 | 人工审查报告内容 | 同上 |

## R18. 生产服务在验证期间持续 HEALTHY

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| R18.1 | **P0** | 生产`eth-alpha-collector.service`/`eth-alpha-feature-generator.service`均`active/running` | 执行一次完整回放（真实180天推荐窗口规模） | 全程每分钟采样一次`/health/live`/`/health/ready` | 全程200 + `ok:true`，无一次503或异常 | 自动（长时间观察脚本） | 呼应V1.4D第一阶段"部署后长周期只读复核"方法论 |
| R18.2 | **P0** | 同上 | 回放执行前后 | 对比`NRestarts`/`ActiveEnterTimestamp` | 无重启，PID不变 | 自动 | 同上 |
| R18.3 | P1 | 同上 | 回放执行期间 | 监控`pg_stat_activity` | 生产连接数无异常增长趋势，回放专属连接数保持在独立、较小的上限内（见`V1_4D_DATA_BACKFILL_SPEC.md`§2.13） | 自动 | 同上 |

## R19. 边界与预热损耗（本轮新增，呼应`V1_4D_DATA_BACKFILL_SPEC.md`§1.1/§1.3逐段证明）

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| R19.1 | **P0** | 构造一个`targetStartTime`在`trainEnd`之前、`targetEndTime`在`trainEnd`之后的样本（跨界样本） | 执行`purge.js` | 检查该样本在`report_scope='TRAIN'`与`report_scope='VALIDATION'`两份报告中的归属 | **两份报告都不包含该样本**，且`report_scope='ALL'`报告**包含**该样本，`purged_straddling_count`在TRAIN/VALIDATION报告中各计数一次 | 自动 | V1_4D_DATA_BACKFILL_SPEC.md§1.1 |
| R19.2 | P0 | 同上，构造跨越`validationEnd`的样本 | 同上 | 同上逻辑应用于`validationEnd` | 该样本不计入VALIDATION也不计入TEST | 自动 | 同上 |
| R19.3 | P0 | 完整180天窗口回放（真实执行） | 按§1.3逐段证明表核对 | 统计train/validation/test三段24h/72h各自`effectiveSampleCount` | 与§1.3理论值（train:89/29，validation:44/14，test:44/14）**在真实数据无缺口场景下应完全一致**；若不一致需排查差异来源（缺口/质量否决/purge实现错误） | 自动（集成，180天真实数据） | V1_4D_DATA_BACKFILL_SPEC.md§1.3 |
| R19.4 | P1 | 4h/1h回填**未**按§2.1延伸至15m窗口起点−4天（人为构造缺失该缓冲的场景） | 执行回放train段最早几天的候选点 | 检查这些候选点的`blocked_count`/`error_code` | 应观察到`ATR14_4H_INSUFFICIENT`，验证"预热损耗"确实是有条件的（缓冲缺失时会真实发生，不是文档空谈） | 自动（集成，故意构造反例） | V1_4D_DATA_BACKFILL_SPEC.md§1.3"条件性0天"说明 |

## R20. `ActionPermission` 攻击测试（P1-1新增）

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| R20.1 | **P0** | migration 005已应用 | 尝试直接对`historical_validation.replay_snapshots`执行`ALTER TABLE ... ADD COLUMN action_permission text` 后插入`'FULL_AUTO'`/`'LIVE_TRADE'`等真实交易类权限值（测试性构造，验证schema设计本身不为此类字段预留空间） | 检查表结构与写入尝试 | 基线schema（migration 005冻结定义）**本不包含**`action_permission`列，任何试图写入交易权限语义的值都**没有对应的落库位置**——若测试环境中被临时加了这样一列，视为对冻结schema的违规修改，测试应标记失败并要求撤销该列 | 自动+人工复核 | V1_4D_HISTORICAL_REPLAY_SPEC.md§2.3 |
| R20.2 | **P0** | `server/src/validation-replay/report-builder.js`（实施后）全文 | grep`ActionPermission`/`DISPLAY_ONLY`/`AUDIT_ONLY`/`FULL_AUTO`/`LIVE`/`EXECUTE` | 静态扫描 | 不存在任何计算、赋值或返回`ActionPermission`（或语义等价字段）的代码路径 | 自动（静态扫描） | 同上 |
| R20.3 | P1 | — | `server/src/api/server.js` | 静态扫描 | 无任何路由返回`historical_validation`任何表的内容（自然也不可能返回其`ActionPermission`，因为根本没有暴露面） | 自动 | V1_4D_HISTORICAL_REPLAY_SPEC.md§三.2 |

## R21. schema-qualified 写入与 `search_path` 防护（本轮新增）

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| R21.1 | **P0** | 全仓库`server/src/validation-replay/*`+`server/src/backfill/*`代码 | 静态扫描全部SQL字符串（`INSERT INTO`/`UPDATE`/`SELECT ... FROM`等） | 检查目标为`historical_validation`表的语句 | 100%使用`historical_validation.<table>`全限定名，**零命中**未加schema前缀的裸表名（如裸写`replay_snapshots`而非`historical_validation.replay_snapshots`） | 自动（静态扫描/AST解析） | V1_4D_HISTORICAL_REPLAY_SPEC.md§三.2 |
| R21.2 | P1 | 数据库连接显式设置`search_path='historical_validation,public'` | 执行一次完整回放 | 对比与默认`search_path`下执行的结果 | 完全一致（因为代码从不依赖`search_path`隐式解析，显式schema前缀使结果与`search_path`配置无关） | 自动（集成，参数化连接配置） | 同上 |

## R22. `HISTORICAL RESEARCH ONLY` 启动横幅

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| R22.1 | P1 | — | 启动CLI（含`--dry-run`与非dry-run两种模式） | 捕获stdout首几行 | 包含"HISTORICAL RESEARCH ONLY"字样及不产出交易信号的声明 | 自动 | V1_4D_HISTORICAL_REPLAY_SPEC.md§4.1 |

## R23. CLI 参数 fail-closed 矩阵（本轮新增）

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| R23.1 | **P0** | — | `--from 2026-01-01 08:00:00`（非UTC ISO8601，缺`Z`且含空格） | 启动CLI | 拒绝，返回`INVALID_TIME_FORMAT`，不做本地时区兜底解析 | 自动 | V1_4D_HISTORICAL_REPLAY_SPEC.md§4.1 |
| R23.2 | **P0** | — | `--from`晚于`--train-end` | 启动CLI | 拒绝，返回`INVALID_SPLIT_ORDER` | 自动 | 同上 |
| R23.3 | **P0** | — | `--train-end`等于`--validation-end` | 启动CLI | 拒绝，返回`INVALID_SPLIT_ORDER`（要求严格小于，不允许相等） | 自动 | 同上 |
| R23.4 | P0 | — | 同时传入`--split 50/25/25`与`--train-end`/`--validation-end` | 启动CLI | 拒绝，返回`CONFLICTING_SPLIT_PARAMS` | 自动 | 同上 |
| R23.5 | P1 | — | 只传`--from`/`--to`/`--symbol`/`--horizons`/`--algorithm-version`/`--dataset-version`/`--rule-version`，不传`--split`也不传`--train-end`/`--validation-end` | 启动CLI | 不做三段切分，只产出`report_scope='ALL'`一份报告（与draft-1既有行为一致，未因新增`--split`而改变"不切分"这一默认路径） | 自动 | 同上 |
| R23.6 | P1 | — | 传`--split 50/25/25`，`--from`~`--to`跨度180天 | 启动CLI后检查实际生效的`train_end_utc`/`validation_end_utc` | 分别等于`from+90天`/`from+135天`（四舍五入规则一致） | 自动 | 同上 |
| R23.7 | **P0** | 已存在`validation_run_id=X`，原参数`--algorithm-version v1`记录在案 | `--resume X --algorithm-version v2`（与原run不一致） | 启动CLI | 拒绝，返回`RESUME_PARAM_MISMATCH`，错误信息中点名`algorithm-version`不一致 | 自动 | V1_4D_HISTORICAL_REPLAY_SPEC.md§4.4 |
| R23.8 | P1 | 同上 | `--resume X`（不传`--algorithm-version`，省略） | 启动CLI | 视为沿用原run的`v1`，正常继续，不视为冲突 | 自动 | 同上 |

## R24. 单个 `validation_run` 清理顺序

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| R24.1 | **P0** | 已存在一个完整`validation_run`（含`replay_snapshots`/`replay_outcome_events`等全部下游数据），记录执行前`public.market_bars`/`public.feature_records`行数与内容哈希 | 按`V1_4D_HISTORICAL_REPLAY_SPEC.md`§三.1冻结顺序执行清理 | 清理完成后重新查询`public.market_bars`/`public.feature_records` | 行数、内容**逐行不变**；`historical_validation`该run相关的**六张**表（不含`backfill_batches`/`dataset_manifests`，本轮更新排除项从一张扩为两张）数据清零；`backfill_batches`/`dataset_manifests`均不受影响 | 自动（集成） | V1_4D_HISTORICAL_REPLAY_SPEC.md§三.1 |
| R24.2 | P1 | 存在两个`validation_run`共享同一`backfill_batch_id` | 清理其中一个run | 检查`backfill_batches`该行 | 不受影响，另一个run的数据也不受影响 | 自动 | 同上 |
| R24.3 | **P0**（本轮新增） | 存在两个`validation_run`共享同一`dataset_version` | 清理其中一个run | 检查`dataset_manifests`该行 | 不受影响（manifest与run是多对一引用关系，见§三.1红线），另一个run仍可正常查询该manifest | 自动 | V1_4D_HISTORICAL_REPLAY_SPEC.md§三.1本轮新增红线 |

## R25. `research_availability_rule_version`

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| R25.1 | P1 | — | `replay_snapshots`/`replay_outcome_events`任意行 | 检查`research_availability_rule_version`列 | 非NULL，等于`'v1.4d-research-availability-1'` | 自动 | V1_4D_DATA_BACKFILL_SPEC.md§2.9 |
| R25.2 | **P0** | 已存在使用规则版本`v1`产生的`replay_snapshots`行 | 模拟规则升级为`v2`（同一`prediction_id`、不同`research_availability_rule_version`）后重新生成 | 检查表内容 | **两条记录并存**（复合唯一约束生效），旧版本`v1`记录未被覆盖或删除 | 自动 | V1_4D_HISTORICAL_REPLAY_SPEC.md§2.3 |

## R26. Dataset Manifest 与 `dataset_version` 确定性（本轮新增，关闭dataset_version内容哈希P1，对照用户任务五15项逐条落地）

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| R26.1 | **P0** | 固定一批`market_bars`测试数据 | 用两种不同的SQL查询顺序（如`ORDER BY open_time`与不加`ORDER BY`依赖物理存储顺序）取出同一批行，分别构建manifest | 对比两次`content_hash` | **完全一致**——`manifest_members`确定性排序（intervalName→openTime→revisionNumber）消除了查询顺序的影响 | 自动 | V1_4D_HISTORICAL_REPLAY_SPEC.md§2.9第3点 |
| R26.2 | **P0** | 同一批`market_bars`测试数据 | 在系统时钟人为调整为不同时刻（mock）的两次独立执行中分别构建manifest | 对比两次`content_hash`与`dataset_version` | **完全一致**——`created_at`等执行时间不进入哈希内容（见§2.9"禁止纳入哈希内容的字段"） | 自动（mock时钟） | V1_4D_HISTORICAL_REPLAY_SPEC.md§2.9第5点 |
| R26.3 | **P0** | 已构建一份manifest | 修改其中一根K线的`close`值（测试环境构造，模拟内容篡改），重新构建manifest | 对比修改前后`content_hash` | **不同**——`rowContentHash`覆盖OHLCV六个字段 | 自动 | V1_4D_HISTORICAL_REPLAY_SPEC.md§2.9第4点 |
| R26.4 | **P0** | 已构建一份manifest，对应K线`revision_number=0` | 构造该K线存在`revision_number=1`的新版本（测试环境），重新构建manifest | 对比`content_hash` | **不同**——`manifest_members`包含`revisionNumber`字段 | 自动 | 同上 |
| R26.5 | **P0** | 已构建一份manifest，涵盖`backfill_batch_ids=[A,B]` | 追加一次回填产生`batch_id=C`落在同一时间范围内，重新构建manifest | 对比`content_hash`与`backfill_batch_ids` | **不同**——`backfill_batch_ids`是被哈希字段之一（即使新增批次没有引入新K线，只要`backfill_batch_ids`集合变化就应反映为新版本；若该场景实际未引入新K线导致集合不变，测试改为验证"若集合确实不同则哈希必不同"这一逻辑蕴含关系） | 自动 | V1_4D_HISTORICAL_REPLAY_SPEC.md§2.9绑定字段清单 |
| R26.6 | **P0** | 已构建一份manifest，`record_count=N` | 人为在`dataset_manifests`行的`record_count`列写入`N+1`（测试性构造不一致，模拟数据损坏或实现bug） | 用`dataset-manifest-verifier.js`对该`dataset_version`执行校验 | fail closed，返回`DATASET_RECORD_COUNT_MISMATCH` | 自动 | V1_4D_HISTORICAL_REPLAY_SPEC.md§4.1a第4步 |
| R26.7 | **P0** | 已构建一份manifest，`data_from`/`data_to`已知 | 人为篡改manifest行的`data_to`（测试性构造） | 执行校验 | fail closed，返回`DATASET_TIME_RANGE_MISMATCH` | 自动 | 同上 |
| R26.8 | **P0** | 已构建一份manifest，`research_availability_rule_version='v1.4d-research-availability-1'` | 校验时代码内置的当前规则版本被mock为`'v2'` | 执行校验 | fail closed，返回`DATASET_RESEARCH_AVAILABILITY_VERSION_MISMATCH` | 自动（mock） | V1_4D_HISTORICAL_REPLAY_SPEC.md§4.1a第5步 |
| R26.9 | **P0** | 已构建一份manifest，`dataset_version`字符串本身未变 | 在manifest冻结**之后**，对`public.market_bars`该范围内某一行做测试性直接篡改（绕过正常写入路径，模拟"版本号没变但实际内容被改"的极端场景） | 用该`dataset_version`重新执行校验（重算`content_hash`） | fail closed，返回`DATASET_CONTENT_HASH_MISMATCH`——**证明校验依赖重新计算的哈希，而非只信任`dataset_version`字符串本身** | 自动（故障注入） | V1_4D_HISTORICAL_REPLAY_SPEC.md§4.1a第2-3步 |
| R26.10 | **P0** | 一个`validation_run`已完成部分`historical_as_of_time`推进（中途状态） | 在触发`--resume`**之前**，人为篡改该run所绑定`dataset_version`对应manifest范围内的`market_bars`数据 | 执行`--resume` | fail closed（§4.1a第7步：resume必须重新完整执行1-5步），不得从"已验证过一次"为由跳过，也不得继续推进`historical_as_of_time` | 自动（故障注入） | V1_4D_HISTORICAL_REPLAY_SPEC.md§4.1a第7步 |
| R26.11 | P1 | 一个`validation_run`已完成并绑定`dataset_version=X`（对应120天范围manifest） | 之后执行一次新的回填，把`market_bars`覆盖范围扩展到180天（**不覆盖**已有120天内的任何行，纯增量） | 重新查询`dataset_version=X`对应的manifest并执行校验 | **校验仍然通过**（`content_hash`不变，因为manifest范围内的数据未被触碰，回填的增量数据在manifest覆盖范围之外）——旧run依然可以正确解析、复现原始冻结数据集 | 自动（集成） | 用户任务二"后续补数...不得悄悄改变旧validation_run绑定的数据集" |
| R26.12 | **P0** | — | `--dry-run`执行，且人为构造manifest哈希不一致的场景（同R26.9手法） | 执行 | fail closed，且`replay_snapshots`等五张业务表**零写入**（与R9.1"dry-run零写入"要求叠加验证：dry-run既要在校验失败时零写入，也要在校验成功时——因为dry-run本身就不写入业务表——保持零写入） | 自动 | V1_4D_HISTORICAL_REPLAY_SPEC.md§4.1a第8步 |
| R26.13 | **P0** | 任一R26.6~R26.10场景触发mismatch | 检查`historical_validation`全部业务表 | `replay_snapshots`/`replay_generation_runs`/`replay_outcome_events`/`replay_evaluation_runs`/`validation_reports`**均无新增行**；`validation_runs`该次尝试标记为`FAILED`（不是`PARTIAL`或`SUCCEEDED`） | 自动 | V1_4D_HISTORICAL_REPLAY_SPEC.md§4.1a红线 |
| R26.14 | **P0** | 已存在一条`dataset_manifests`行 | 尝试对该行执行`UPDATE dataset_manifests SET record_count = record_count + 1 WHERE dataset_version = $1`（测试性违规写入，验证"不可原地覆盖"这一属性，而非只验证应用代码不这么写） | 执行 | 若应用层通过独立数据库角色权限限制该表只可`INSERT`（建议实施阶段考虑，非本轮强制），则数据库层拒绝；无论如何，`server/src/validation-replay/*`全部生产代码路径中不得出现该语句（R11.1a已覆盖静态扫描），本测试从"运行时行为"角度做补充验证 | 自动+人工复核 | V1_4D_HISTORICAL_REPLAY_SPEC.md§2.0/§2.8 |
| R26.15 | **P0** | `public.provisional_market_bars`表中存在与manifest覆盖范围时间重叠的行 | 构建manifest / 执行回放校验 | `canonical-manifest-content.js`/`dataset-manifest-builder.js`/`dataset-manifest-verifier.js`**均不查询**`provisional_market_bars`，manifest内容与该表完全无关；即使该表内容变化，`content_hash`也不受影响 | 自动（静态扫描 + 集成对照） | V1_4D_HISTORICAL_REPLAY_SPEC.md§2.8`source_formal_semantics`；`V1_4D_DATA_BACKFILL_SPEC.md`§2.13"不读取或写入provisional_market_bars" |

## R27. `dataset_version` 完整哈希与排序确定性专项（本轮新增，闭环截断P1的定向修订，对照用户本轮8项要求逐条落地）

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| R27.1 | **P0** | migration 005已应用 | 检查`dataset_manifests.dataset_version`列的实际取值格式 | 构建任意一份manifest，检查生成的`dataset_version`字符串 | 前缀`v1.4d-sha256-`之后**恰好64个十六进制字符**（完整SHA-256），**不得**是16个字符（64-bit）或任何其他截断长度；同时检查`content_hash`生成列的值与`dataset_version`去前缀后的部分**逐字符相等** | 自动 | V1_4D_HISTORICAL_REPLAY_SPEC.md§2.9.0 |
| R27.2 | **P0** | 固定一批`backfill_batch_ids=[C, A, B]`（故意乱序构造输入） | 分别以`[C,A,B]`与`[A,B,C]`两种输入顺序调用`canonical-manifest-content.js`构建manifest | 对比两次`dataset_version` | **完全一致**——`backfillBatchIds`排序规则（去重+UUID字典序，§2.9.2）消除了输入顺序的影响 | 自动 | V1_4D_HISTORICAL_REPLAY_SPEC.md§2.9.2 |
| R27.3 | **P0** | 固定一批`market_bars`测试数据（同R26.1，本条从"批次顺序"角度补充，R26.1从"K线查询顺序"角度覆盖，两者互补不重复） | 用两种不同顺序查询/传入`manifest_members`原始（未排序）候选列表 | 分别构建manifest | 对比两次`dataset_version` | **完全一致**——排序在`canonical-manifest-content.js`内部统一执行，与调用方传入顺序无关 | 自动 | V1_4D_HISTORICAL_REPLAY_SPEC.md§2.9.2 |
| R27.4 | **P0** | 构造两条K线记录，`intervalName`/`openTime`/`revisionNumber`三者**完全相同**（测试环境人为构造并列场景，模拟未来可能出现的多数据源冗余情形），仅`vintageId`不同 | 分别以两种不同的记录先后顺序传入 | 构建manifest并对比两次`dataset_version` | **完全一致**——`vintageId`作为第四级决胜字段消除了前三字段并列时的排序歧义，结果不依赖输入顺序 | 自动 | V1_4D_HISTORICAL_REPLAY_SPEC.md§2.9.2红线 |
| R27.5 | **P0** | 已构建一份manifest，`manifest_hash_algorithm_version='v1.4d-manifest-hash-1'` | 内容完全不变，仅`manifestHashAlgorithmVersion`输入值mock为`'v1.4d-manifest-hash-2'`后重新构建 | 对比两次`dataset_version` | **不同**——`manifestHashAlgorithmVersion`本轮已纳入被哈希内容（§2.9.1/§2.9.4订正），版本变化确定性反映为不同`dataset_version`，不依赖"算法实现变了输出大概率也变" | 自动（mock） | V1_4D_HISTORICAL_REPLAY_SPEC.md§2.8`manifest_hash_algorithm_version`行订正说明 |
| R27.6 | **P0** | 已构建一份manifest，`manifest_schema_version='v1.4d-manifest-schema-1'` | 内容完全不变，仅`manifestSchemaVersion`输入值mock为`'v1.4d-manifest-schema-2'`后重新构建 | 对比两次`dataset_version` | **不同** | 自动（mock） | V1_4D_HISTORICAL_REPLAY_SPEC.md§2.9.1 |
| R27.7 | **P0** | 已构建一份manifest | 分别故意制造三种不一致：①仅改`dataset_version`字符串本身（如手工拼错几位十六进制）但`content_hash`生成列必然同步变化，实际不可能"只改一个不改另一个"（因生成列结构性绑定）——本条改为验证**若有人试图绕过生成列机制直接操纵底层存储**（测试环境模拟，如直接`UPDATE pg_catalog`级别的破坏，仅用于验证verifier的"重新计算并比对"是否真的独立于DB存储的`content_hash`值，而不是简单读取该列） | 用`dataset-manifest-verifier.js`重新计算哈希并与manifest行比对 | 三种不一致场景（版本串异常/存储被破坏/manifest与实际market_bars内容不符）**均fail closed**，返回对应`DATASET_*`错误码，不生成任何`replay_snapshot`/`replay_outcome_event`/`validation_report` | 自动（故障注入，含边界性测试） | V1_4D_HISTORICAL_REPLAY_SPEC.md§4.1a |
| R27.8 | **P0** | `canonical-manifest-content.js`（实施后）源码 | 构造一组测试输入（含小数价格如`"1845.6700"`），调用该模块生成manifest内容对象 | 断言对象中`open`/`high`/`low`/`close`/`volume`/`quoteVolume`对应字段的`typeof`均为`'string'`；断言`dataFrom`/`dataTo`均为字符串而非`Date`实例 | 全部为字符串类型，验证§2.9.5"caller侧类型纪律"被遵守，防止未来维护者引入`Number()`转换导致浮点精度问题 | 自动（单元测试） | V1_4D_HISTORICAL_REPLAY_SPEC.md§2.9.5 |
| R27.9 | **P0** | 实施阶段，`hash-contract-verification.test.js`首次运行 | 对当时实际的`server/src/domain/hash.js canonicalJsonHash()`分别构造：乱序键对象、含小数的number输入、含数组的对象、已知输入的sha256已知输出 | 逐一断言 | 键排序结果与手工排序一致；数组元素顺序与输入顺序完全一致（不被重排）；哈希输出与用`node:crypto`独立计算的sha256参考值一致 | 自动（单元测试） | V1_4D_HISTORICAL_REPLAY_SPEC.md§2.9.4 |
| R27.10 | P1 | 同上 | 故意传入`Date`对象/`undefined`/`NaN`等非法类型给`canonicalJsonHash()` | 调用 | 应抛出`RAW_JSON_UNSERIALIZABLE`等异常（fail closed），不得静默返回某个哈希值 | 自动（单元测试） | V1_4D_HISTORICAL_REPLAY_SPEC.md§2.9.4"额外确认的正面特性" |
| R27.11 | **P0** | 一个`validation_run`已完成部分推进 | 在`--resume`前，人为让R27.5/R27.6/R27.7任一种不一致场景发生 | 执行`--resume` | fail closed，不得因"上次已验证过"跳过（同R26.10逻辑，本条覆盖版本变化类不一致，R26.10覆盖内容篡改类不一致，两者互补） | 自动（故障注入） | V1_4D_HISTORICAL_REPLAY_SPEC.md§4.1a第7步 |
| R27.12 | **P0** | 同上 | `--dry-run`时发生R27.5/R27.6/R27.7任一种不一致 | 执行 | fail closed，五张业务表零写入（同R26.12逻辑，本条覆盖版本变化类不一致） | 自动 | V1_4D_HISTORICAL_REPLAY_SPEC.md§4.1a第8步 |

## R28. 多symbol Dataset Manifest 契约（本轮新增，对照`V1_4D_MULTI_SYMBOL_MANIFEST_ADDENDUM.md`24项场景逐条落地）

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| R28.1 | **P0** | migration 007已应用，BTCUSDT/ETHUSDT 15m/1h/4h（BTC仅15m）均已回填至同一窗口 | `dataset:build-manifest --contract-version 2 --from --to --fixed-as-of` | 执行构建 | 成功产生一条`manifest_contract_version=2`行，`symbols=["BTCUSDT","ETHUSDT"]`，`dependency_set`恰好四条，`record_count`/`per_dependency_record_count`与实际回填行数一致 | 自动（集成） | 附录§二/§三 |
| R28.2 | **P0** | 已构建一份`manifest_contract_version=1`（仅ETH）的Manifest | 将该Manifest的`dataset_version`传给要求多symbol治理的Feature Backfill正式运行 | 执行 | fail closed，返回`DATASET_MANIFEST_CONTRACT_VERSION_UNSUPPORTED` | 自动 | 附录§九.1第1条/§十第3条 |
| R28.3 | **P0** | 构造一份`manifest_contract_version=2`候选，`dependency_set`缺少`{BTCUSDT,15m}`（人为构造非法输入模拟builder bug） | 尝试构建/或直接以此manifest执行Feature Backfill | 执行 | fail closed，返回`DATASET_MANIFEST_DEPENDENCY_UNGOVERNED`，`missingDependencies`列出该条目 | 自动 | 附录§三第3条/§九.1第3条 |
| R28.4 | **P0** | 构造`dependency_set`额外包含`{BTCUSDT,1h}`（未批准的隐式依赖） | 尝试构建 | 执行 | 构建拒绝（不满足"与`FEATURE_BAR_DEPENDENCIES`投影完全相等"要求），不产生该行 | 自动 | 附录§三第3条 |
| R28.5 | **P0** | 固定一批底层K线数据 | 以两种不同的`dependency_set`枚举顺序（如`[BTC15m,ETH1h,ETH15m,ETH4h]`与`[ETH15m,ETH1h,ETH4h,BTC15m]`）分别构建 | 对比两次`dataset_version` | 完全一致——第三节排序规则消除输入顺序影响 | 自动 | 附录§三第4条/§六 |
| R28.6 | **P0** | 同上批数据 | 以两种不同的`manifest_members`候选枚举顺序分别构建 | 对比两次`dataset_version` | 完全一致——第五节七元组排序规则消除输入顺序影响 | 自动 | 附录§五第2条/§六 |
| R28.7 | **P0** | 构造`dependency_set`输入中人为重复一条`{ETHUSDT,15m,spot,binance-spot}` | 构建 | 执行 | 去重后只保留一条，`dataset_version`与不重复输入构建结果一致，且记录WARNING | 自动 | 附录§三第4条 |
| R28.8 | **P0** | 已存在一条`manifest_contract_version`被测试性构造为`3`（非法值，绕过应用层，直接构造DB行或mock返回） | verifier读取该行 | 执行校验 | fail closed，返回`DATASET_MANIFEST_CONTRACT_VERSION_UNSUPPORTED`；同时验证数据库CHECK约束`dataset_manifests_contract_version_known`本身拒绝任何常规INSERT写入该值 | 自动 | 附录§一第4条 |
| R28.9 | **P0** | 同R28.2 | 同R28.2 | 同R28.2 | 同R28.2（本条与R28.2为同一场景的两个措辞，验收时可合并勾选，保留双编号以对应用户原始24项清单不遗漏第9项） | 自动 | 附录§九.1第1条/§十第3条 |
| R28.10 | **P0** | 已成功构建一份契约版本2 Manifest | 用完全相同的`from`/`to`/`fixedAsOf`/底层数据重新执行构建 | 执行 | 幂等返回既有行（`ON CONFLICT(dataset_version) DO NOTHING`），不产生新行，`logical_window_hash`相同 | 自动 | 附录§七第3条 |
| R28.11 | **P0** | 已成功构建一份契约版本2 Manifest（窗口W） | 保持窗口W不变，人为改变底层`market_bars`内容后重新构建 | 执行 | 拒绝插入，返回`DATASET_MANIFEST_LOGICAL_WINDOW_CONFLICT` | 自动（故障注入） | 附录§七第4条 |
| R28.12 | **P0** | 两个进程同时对同一窗口W发起构建 | 并发执行 | 观察结果 | 恰好一个成功`INSERT`，另一个收到幂等返回或`LOGICAL_WINDOW_CONFLICT`（取决于内容是否相同），不会产生两条同`logical_window_hash`的行 | 自动（集成，并发注入） | 附录§七第6-7条 |
| R28.13 | **P0** | 构造BTCUSDT 15m多3条、ETHUSDT 15m少3条的场景（模拟净额抵消） | 执行完整性校验 | 检查`per_dependency_integrity_check_result` | 两个依赖分组**分别独立**报告非零异常，整体构建失败；不得因总量净差为0而判定通过 | 自动 | 附录§八第2条 |
| R28.14 | **P0** | 构造某依赖存在`close_time > fixed_as_of`的K线 | 执行构建 | 执行 | 该行不得计入该依赖成员/计数，若因此导致覆盖不完整则整体构建失败 | 自动 | 附录§四第5条 |
| R28.15 | **P0** | 构造一条`vintage_id`不在`manifest_members`内的历史K线用于查询 | 以该Manifest执行Feature Backfill输入查询 | 执行 | 该行被排除，返回`SOURCE_NOT_IN_DATASET_MANIFEST`（若被显式请求）或静默不出现在结果集中（若为集合查询） | 自动 | 附录§九.1第4条 |
| R28.16 | **P0** | `public.market_bars`全表存在大量不属于该Manifest覆盖窗口/依赖的BTC/ETH行 | 以该Manifest执行`loadHistoricalFeatureInputs` | 执行真实PostgreSQL查询 | 只返回`vintage_id`在`manifest.memberVintageIds`内的行，全库其余行不出现在结果集，即使数量上远超预期 | 自动（真实PostgreSQL集成） | 附录§五第6-7条 |
| R28.17 | P1 | 一次完整的多symbol Feature计算 | 检查产出的血缘/审计记录 | 内容审查 | 同时包含ETH与BTC两个symbol的输入引用、Manifest身份、`dependency_set`、涉及的`vintageId`子集、`fixed_as_of` | 自动+人工复核 | 附录§九.3 |
| R28.18 | **P0** | — | `--dry-run`执行契约版本2完整校验+计划输出 | 执行 | 9.1全部验证正常执行（只读），`replay_snapshots`等业务表零写入，验证失败时同样零写入 | 自动 | 附录§九.3第4条 |
| R28.19 | **P0** | 干净测试数据库，仅应用至migration 006 | 依次执行migration 007 up → down → up | 逐步检查 | up成功新增列/约束；down在零契约版本2记录时成功回滚（列/约束消失，`symbol`恢复NOT NULL）；再次up成功恢复到与第一次up后完全一致的schema状态 | 自动（集成，真实PostgreSQL） | 附录§十一 |
| R28.20 | **P0** | 已应用migration 007并已构建至少一条契约版本2 Manifest | 尝试执行migration 007 down | 执行 | 守卫触发，`RAISE EXCEPTION 'MIGRATION_007_ROLLBACK_BLOCKED...'`，回滚被中止，契约版本2数据与契约版本1数据均保持不变、可继续查询、可继续共存 | 自动（集成） | 附录§十一.3 |
| R28.21 | **P0** | — | 按附录§六.4完整`manifestContentObject`构造输入 | 用实际`canonicalJsonHash()`计算 | 输出`contentHash`必须逐字符等于附录冻结的golden值`0a0e3225e83ff09c9dcf22c6a87de317cfe94d0b6854b7c8c2f25e20d6bade46` | 自动（单元测试，golden test） | 附录§六.4 |
| R28.22 | **P0** | 真实隔离PostgreSQL测试库，写入BTC+ETH共计40+条真实K线（部分在治理范围内，部分故意在范围外） | 构建契约版本2 Manifest后执行`loadHistoricalFeatureInputs` | 执行真实查询（非mock） | 只返回治理范围内的行，范围外行(含"全库存在但未被治理"的BTC/ETH行)一律不返回，与既有单symbol场景下的真实PostgreSQL验证方法一致 | 自动（真实PostgreSQL集成） | 附录§五第6-7条 |
| R28.23 | **P0** | 构建过程在写入`dataset_manifests`前的完整性校验阶段人为触发失败（故障注入） | 执行构建 | 检查事务状态 | 整个事务`ROLLBACK`，不产生部分写入的`dataset_manifests`行，`historical_validation`其余表不受影响 | 自动（故障注入+集成） | 附录§七第7条 |
| R28.24 | P1 | "服务器历史72/-72"取证任务尚未实际执行 | 检查任何本轮产出文档（含本附录、既有五份文档）对该问题的状态标注 | 全文检索 | 全部标注为`NOT_CONFIRMED`，不存在任何将其描述为"已确认"/"已解决"的表述；本轮不执行任何只读取证查询 | 人工（文档检索）+自动（关键词扫描） | 附录§八第3-4条 |

---

## 总数统计（占位，供实施阶段逐条勾选后统计更新）

本轮（多symbol Manifest契约补充后）共冻结 **28个测试类别 / 约127条测试用例**，其中 **P0约79条**，覆盖时间泄漏治理（R4/R5，最高优先级）、生产隔离（R7/R8/R18/R21）、幂等与恢复（R1/R9/R23.7）、命名空间隔离（R10/R25）、可变性分类（R11）、红线字段CHECK（R15/R17.2/R20）、边界处理（R19）、CLI健壮性（R22/R23）、清理顺序（R24）、dataset_version内容哈希确定性与fail-closed（R26，15条）、完整哈希与排序决胜字段/canonicalJsonHash实施阶段核实（R27，12条）、**多symbol Dataset Manifest契约：依赖治理/内容哈希/逻辑窗口/完整性隔离/legacy策略/Migration 007 up-down-up/golden哈希测试向量（R28，本轮新增，24条）**。

---

## 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.4d-tests-draft-1 | 2026-07-25 | 初稿：冻结18个测试类别，覆盖用户任务七全部24项要求 |
| v1.4d-tests-draft-2 | 2026-07-25 | 第三阶段独立复审修订：①R7.1表数量订正为七张+新增R7.1a建表顺序测试；②R9.1订正为"五张业务表"+新增R9.1a/R9.1b；③R11从两条扩展为五条，按§2.0三分类（状态机型/严格只增型/覆盖写例外）分别断言，不再笼统称"不可变"；④新增R19（边界预热损耗）、R20（ActionPermission攻击测试）、R21（schema-qualified/search_path防护）、R22（启动横幅）、R23（CLI fail-closed矩阵，含UTC格式/顺序/split默认/resume一致性）、R24（单run清理顺序）、R25（research_availability_rule_version）共7个新测试类别；⑤总数统计更新为25类别/约75条/P0约33条 |
| v1.4d-tests-draft-3 | 2026-07-26 | 第三阶段补充修订：关闭`dataset_version`内容哈希P1。①R7.1订正为**八张**表；②R11新增R11.1a（`dataset_manifests`静态扫描）；③R24.1排除项从一张扩为两张（`backfill_batches`+`dataset_manifests`），新增R24.3；④新增**R26共15条测试**，覆盖用户任务五全部15项要求（确定性哈希×5、fail-closed×5、resume/dry-run/mismatch场景×3、manifest不可覆盖×1、provisional数据排除×1）；⑤总数统计更新为26类别/约91条/P0约47条 |
| v1.4d-tests-draft-4 | 2026-07-26 | 第三阶段定向修订：新增**R27共12条测试**，对照用户本轮8项要求逐条落地——完整哈希不截断验证（R27.1）、批次顺序无关性（R27.2）、成员查询顺序无关性（R27.3）、排序并列决胜字段确定性（R27.4）、哈希算法版本变化必产生不同版本（R27.5）、schema版本变化必产生不同版本（R27.6）、多种不一致场景fail-closed（R27.7）、类型纪律单元测试（R27.8）、canonicalJsonHash实施阶段核实（R27.9/R27.10）、resume/dry-run覆盖版本变化类不一致（R27.11/R27.12）；总数统计更新为27类别/约103条/P0约58条 |
| v1.4d-tests-draft-5 | 2026-08-03 | 多symbol Dataset Manifest契约补充：新增**R28共24条测试**，对照`V1_4D_MULTI_SYMBOL_MANIFEST_ADDENDUM.md`全部24项要求场景逐条落地——依赖集合正确性与笛卡尔积禁止（R28.1/R28.3/R28.4/R28.7）、契约版本fail-closed（R28.2/R28.8/R28.9）、排序确定性（R28.5/R28.6）、逻辑窗口幂等/冲突/并发（R28.10-R28.12）、跨依赖抵消禁止（R28.13）、as-of与成员治理边界（R28.14/R28.15）、真实PostgreSQL全库排他性验证（R28.16/R28.22）、血缘完整性（R28.17）、dry-run零写入（R28.18）、Migration 007 up/down/up与回滚守卫（R28.19/R28.20）、golden哈希测试向量（R28.21）、事务回滚（R28.23）、72/-72状态标注核查（R28.24）；总数统计更新为28类别/约127条/P0约79条 |
