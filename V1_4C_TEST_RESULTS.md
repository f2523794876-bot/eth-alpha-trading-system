# V1_4C_TEST_RESULTS.md — V1.4C 服务器端预测基础设施测试结果

## 0B. P0-1/P1-1服务生命周期加固专项（本轮，2026-07-24）

Codex对提交`41b03b3`的独立复审判定**REQUEST CHANGES**，指出三项待修复问题：

- **P0-1**：启动失败后没有回滚已启动服务——若`forecastGenerator.start()`/`outcomeEvaluator.start()`失败，此前已启动的`collector`/`api`不会被可靠停止，顶层只设置`process.exitCode=1`，残留定时器/监听端口可能使进程继续存活。
- **P1-1**：`ForecastGenerator`/`OutcomeEvaluator`的`stop()`只清定时器和触发`AbortController`，未等待正在执行的`runOnce()`真正结束就可能被上层视为"已停止"，也没有释放自身持有的lease。
- **P2-1**：测试报告数字与实际结果不一致——本文档当时仍写`209/209`，而修复前离线`npm test`实际已是`214/214/0/0`，证据滞后。

### 本轮修复内容

1. **P0-1**：新增`server/src/lifecycle.js`，导出通用、可注入的`startStagesWithRollback()`/`stopStagesInOrder()`/`createIdempotentCloser()`。`server/src/index.js`的`bootstrap()`改为将`collector`/`api`/`forecastGenerator`/`outcomeEvaluator`四个组件表达为`{name,start,stop}`阶段数组，按顺序启动；任一阶段`start()`失败时对已成功启动的阶段按逆序调用`stop()`回滚，单个阶段`stop()`报错只记录、不阻断其余阶段回滚、也不替换最终抛出的原始启动错误；全部组件（含回滚）结束后才通过`createIdempotentCloser()`关闭共享Postgres连接池且保证只关闭一次；不依赖`process.exit()`，回滚完成后原样重新抛出启动错误，使进程能够真正失败退出。正常关停复用同一个`stopStagesInOrder()`，与失败回滚遵循同一套逆序生命周期顺序（`outcomeEvaluator→forecastGenerator→api→collector`最后才关数据库）。
2. **P1-1**：`ForecastGenerator`（`server/src/forecast/generator-service.js`）与`OutcomeEvaluator`（`server/src/outcome/evaluator-service.js`）各自独立新增`inflight`跟踪集合与`track()`方法（未复用彼此代码，只共享同一套已在`FeatureGeneratorService`验证过的模式，独立理解后各自实现）；`schedule()`/`scheduleHeartbeat()`的调度tick与对外的`runOnce()`统一经`track()`注册进`inflight`。`stop()`重写为幂等（内部缓存`stopPromise`，并发/重复调用只执行一次真正的清理），顺序为：停止调度并清定时器→`abortController.abort()`中断可取消工作→`await Promise.allSettled([...inflight])`等待全部已注册在途任务结束→仅在`lease`存在且未被判定丢失(`leaseLost`)时，按`lease_name`+`holder_id`+`fencing_token`三者精确匹配调用新增的`releaseLease()`释放自身lease（不可能影响其他owner持有的同名lease行）；释放失败被记录但不会让`stop()`本身抛出。
3. **P2-1**：本文件与`V1_4C_IMPLEMENTATION_REPORT.md`同步更新为本轮修复后**实际执行**得到的真实测试数字（见下），不预先假设固定数值。

### 新增专项测试（18项，全部离线可执行，不依赖数据库/网络）

- `server/tests/lifecycle-rollback.test.js`（6项）：ForecastGenerator启动失败触发collector/api逆序回滚且outcomeEvaluator从未被启动；OutcomeEvaluator启动失败触发collector/api/forecastGenerator逆序回滚且forecastGenerator已获取的lease被释放；某组件`stop()`报错不阻断其余组件回滚，且最终抛出的仍是原始启动错误而非清理错误；共享数据库连接在回滚与正常关停两条路径下都只关闭一次；正常关停按逆序执行且Forecast/Outcome先于数据库关闭完成收尾；`createIdempotentCloser()`本身的并发/重复调用幂等性。
- `server/tests/forecast/forecast-generator-shutdown.test.js`（6项）：`runOnce()`执行中调用`stop()`必须等待其结束才返回并随后释放lease；`stop()`之后不再产生新的调度执行；不释放其他owner/token持有的lease；重复调用`stop()`幂等且只释放一次；`runOnce()`因fencing token被拒绝失败时`inflight`不残留；lease释放失败被记录而不让`stop()`抛出。
- `server/tests/forecast/outcome-evaluator-shutdown.test.js`（6项，独立实现，未复制`forecast-generator-shutdown.test.js`或Codex修复包中的代码，只与之共享测试基础设施`tests/helpers/fake-lease-pool.js`）：覆盖与上一条完全对应的六类场景。

### 离线测试实际结果（本轮，`cd server && npm test`）

```
tests 232
pass 232
fail 0
skip 0
```

修复前基线`41b03b3`离线`npm test`实际为`214/214/0/0`（非文档曾声称的`209/209`）；本轮新增18项专项测试，`214+18=232`，与实际执行结果一致——数字是执行后据实记录，不是预先假设。

`npm run check`（`node --check src/index.js && npm test`同等范围）：exit 0，`232/232/0/0`；另对本轮新增/修改的四个源文件单独执行`node --check`（`src/lifecycle.js`/`src/index.js`/`src/forecast/generator-service.js`/`src/outcome/evaluator-service.js`）均通过。

附加验证（不计入`npm test`范围，单独执行确认无回归）：`npm run test:features` → `44/44 pass，0 fail`。

### PostgreSQL集成测试：本轮**未执行**

原因：当前实施环境未设置`TEST_DATABASE_URL`。`pg_isready`探测到`127.0.0.1:5432`有可达的PostgreSQL实例，但该实例正是本机生产服务`eth-alpha-collector`（systemd单元，`/opt/eth-alpha/eth-alpha-trading-system`，以`eth-alpha`系统用户运行，本次任务账号无读写权限）实际连接使用的数据库所在实例；任务边界明确禁止连接或修改生产数据库，且要求PostgreSQL集成测试"仅在已经配置隔离测试数据库且不会接触生产库时执行"。本轮未新建隔离测试角色/数据库、未设置`TEST_DATABASE_URL`，因此`npm run test:postgres`及其六个子命令（`test:postgres:v1.4a`/`:features`/`:revision`/`:v1.4c-forecast`/`:v1.4c-outcome`/`:v1.4c-lease`）均**未执行**，不得视为通过，也没有用模拟/历史结果冒充本轮已验证。下方§2表格中标注为"历史记录"的PostgreSQL数字来自此前（配置了隔离测试库的环境下）的记录，非本轮重新验证；本轮改动的4个文件（`lifecycle.js`/`index.js`/`generator-service.js`/`evaluator-service.js`）均不涉及该表所覆盖的P0/P1业务验收矩阵本身（预测公式、Snapshot/Outcome数据口径、时间契约均未改动），但lease释放/心跳相关代码路径的真实PostgreSQL端到端验证仍待CI或配置了隔离库的环境补充执行。

## 0A. FeatureGenerator生产生命周期专项（2026-07-23）

新增14项可在无数据库环境执行的行为测试：

- 10项独立服务生命周期：新正式15m K线自动生成、时间键幂等、无K线安全空转、租约
  互斥、过期接管、重启补漏、单目标故障隔离、心跳丢失停止、SIGTERM等待在途事务、
  systemd独立服务/collector非强依赖。
- 4项预测就绪门：精确reference时间键、稍晚特征有界重试、超时返回null并fail
  closed、停止时中断等待。

专项执行结果：**14 passed，0 failed，0 skipped**。

真实PostgreSQL套件新增生产路径断言：独立服务扫描真实`market_bars`并写入精确
`feature_records`，重复轮询仍只有一行；既有V1.4C forecast端到端测试同步改为为每个
24h/72h reference边界生成精确特征，禁止旧特征回退。该套件需要隔离
`TEST_DATABASE_URL`，当前受限Mac沙箱未提供PostgreSQL，留待CI/复审环境执行。组合
门禁预期由原62项增至**63项**（13+5+9+17+10+9）；本地只验证到22项正确识别为
SKIP，未把它们计为通过。

本环境合并非联网扫描（`server/tests/*.test.js`、features、forecast）共258项：
**247 passed，11 failed**。11项全部是API测试启动本机监听端口时被沙箱拒绝，错误均为
`listen EPERM 127.0.0.1`；没有业务断言失败。拆除需要监听端口的API用例后，可执行的
247项全部通过。该环境限制不得记为产品通过，CI/标准本机仍须重新执行完整命令并达到
0失败。

分组复核：

- `server/tests/forecast/*.test.js`：**96 passed，0 failed**；
- `feature-generator-service.test.js`：**10 passed，0 failed**；
- `review-regression.test.js`：**17 passed，0 failed**；
- 本轮涉及的PostgreSQL文件在未配置`TEST_DATABASE_URL`时：**22 skipped**，未冒充通过；
- 两次构建产物SHA-256均为
  `fe969b5d76cbecb4a19b47093ee698f12d38bbf01e0fd36b50dc1add3ac2c5c8`，且构建前后
  正式HTML哈希不变。

真实Binance REST在本沙箱执行13项：0 passed、10 failed、3 skipped。失败根因是环境
DNS禁用（`ENOTFOUND api.binance.com`/`fapi.binance.com`，后续同端点触发
`CIRCUIT_OPEN`）；3项REST+PostgreSQL因无`TEST_DATABASE_URL`跳过。该结果明确记为
**环境阻塞/未验收**，不是产品通过，也没有用伪响应代替真实REST。复审或CI环境必须
重新执行真实网络与真实PostgreSQL门禁。

## 0. 文档变更记录（Codex 独立复审 REQUEST CHANGES 后的修订）

Codex 对提交 `1b0343e4eee7f1bded2316f40c1257840250c4db` 的独立复审判定 REQUEST CHANGES，指出三项问题（P0-1 两个调度器从未接入生产启动入口、P1-1 心跳续约缺失、P1-2 生成节奏门禁未真正实现），并指出本文档 §4 表格中"24H每4小时/72H每日生成节奏"一行错误地声称该上限单靠 `UNIQUE(prediction_id)` 约束即可自动成立——这一结论是**错误的**：不同的 `referenceBar.closeTime` 会产生不同的 `predictionId`，`UNIQUE(prediction_id)` 约束只能防止*同一个* `referenceBar` 被重复计为两条快照，无法阻止应用层对*不同* `referenceBar`（例如每次 15 分钟轮询都取"最新一根已收盘 bar"）反复生成，从而使 24H/72H 正式样本量随轮询频率线性增长。该结论已在本轮修订中更正，见 §4 与 §9（新增）。本文档 §2/§3/§6/§7/§8 的测试数量、通过结果也已同步更新为修复后的最终真实执行结果。

## 1. 执行环境

- Node.js v22.23.1
- PostgreSQL（本地实例，通过 `psql`/`pg_isready` 确认可达），隔离测试角色 `eth_alpha_test`、隔离测试库 `eth_alpha_v14a_test`（沿用 V1.4A/B 既有测试库命名，满足 `/test|ci|v14/i` 隔离校验正则）
- 所有真实 PostgreSQL 测试均在每个测试文件的 `before()` 钩子内先执行 `runMigrations(pool,'down')` 再 `runMigrations(pool,'up')`，确保每个文件从全新 schema 开始，互不残留状态

## 2. 命令与 exit code 汇总

| 命令 | exit code | tests | pass | fail | skip | 本轮（2026-07-24）是否重新执行 |
|---|---|---|---|---|---|---|
| `npm test`（`tests/*.test.js` + `tests/forecast/*.test.js`，含 review-regression 结构性门禁 + 本轮新增18项生命周期测试） | 0 | 232 | 232 | 0 | 0 | **是，本轮实际执行，见§0B** |
| `npm run test:postgres:v1.4a`（既有，含004迁移后31表断言更新） | 0 | 13 | 13 | 0 | 0 | 否——历史记录，本轮未配置`TEST_DATABASE_URL`，未执行，见§0B |
| `npm run test:postgres:features`（既有V1.4B） | 0 | 4 | 4 | 0 | 0 | 否——同上，未执行 |
| `npm run test:postgres:revision`（既有V1.4B） | 0 | 9 | 9 | 0 | 0 | 否——同上，未执行 |
| `npm run test:postgres:v1.4c-forecast`（含P1-2真实节奏门禁测试） | 0 | 17 | 17 | 0 | 0 | 否——同上，未执行 |
| `npm run test:postgres:v1.4c-outcome` | 0 | 10 | 10 | 0 | 0 | 否——同上，未执行 |
| `npm run test:postgres:v1.4c-lease`（含P0-1/P1-1真实心跳测试） | 0 | 9 | 9 | 0 | 0 | 否——同上，未执行 |
| `npm run test:postgres`（上述6步组合命令，一次性顺序执行） | 0 | 62 | 62 | 0 | 0 | 否——同上，未执行 |

上表PostgreSQL相关7行的`exit code`/`tests`/`pass`/`fail`/`skip`列为此前（配置了隔离`TEST_DATABASE_URL`的环境下）的历史记录，**本轮未重新执行**，不作为本轮验收依据；本轮唯一实际重新执行并验证的是`npm test`一行，详见§0B。

**离线复现性**：未设置 `TEST_DATABASE_URL` 时，三个V1.4C真实PostgreSQL测试文件通过 `pgtest = enabled ? test : test.skip` 全部优雅降级为 SKIP，不会导致离线环境下 `npm test`/CI 无网络阶段失败。

**无 `.only`/`.skip`（业务断言）**：已对 `tests/postgres/v1-4c-*.test.js` 与 `tests/forecast/*.test.js` 做静态扫描，除 `pgtest` 声明本身依赖的 `test.skip` 降级模式外，无任何业务测试使用 `.only`/裸 `.skip`。

**`git diff --check`**：无输出（无空白符错误）。

## 3. P0 验收矩阵逐项结果

对照本次实施任务书"十、必须实现的验收覆盖"P0清单：

| # | P0 要求 | 覆盖测试 | 结果 |
|---|---|---|---|
| 1 | 服务器时间不可用/未来数据/未收盘数据fail closed | `v1-4c-forecast` #15（服务器时间不可用）；`bar-path-locator.js`/`threshold-formula.js`内建"不得使用未收盘bar"结构性保证，纯函数测试`bar-path-locator.test.js`覆盖 | 通过 |
| 2 | 修改dataCutoffTime之后的未来数据不改变历史快照/状态/contentHash | `v1-4c-forecast` #12 | 通过 |
| 3 | 24H/72H路径缺失/重复/乱序/未收盘及endpoint/path四象限 | `v1-4c-outcome` #1-#4（四象限）；`bar-path-locator.test.js`覆盖重复/乱序/未收盘纯函数场景 | 通过 |
| 4 | ATR仅14根失败；15根用14个TR样本成功 | `v1-4c-forecast` #2, #3 | 通过 |
| 5 | ATR窗口异常/referencePrice异常全部失败 | `v1-4c-forecast` #4（窗口缺口）；`threshold-formula.test.js`覆盖referencePrice<=0/非有限 | 通过 |
| 6 | 24H/72H rawThreshold/clamp上下边界和等号边界 | `threshold-formula.test.js`（纯函数，逐位手算对照+边界） | 通过 |
| 7 | actualReturn恰好等于±threshold时UP/DOWN边界 | `threshold-formula.test.js` | 通过 |
| 8 | 连续突破/跌破对称覆盖0/1/2/3/>3 | `v1-4c-forecast` #5（0/1/2/3四场景），#6（跌破对称），count封顶于M=3即代表">3"场景 | 通过 |
| 9 | 遇第一根不符方向立即停止 | `v1-4c-forecast` #6 | 通过 |
| 10 | 三候选bar分别使用自身之前20根历史 | `v1-4c-forecast` #5（每场景candidate的priorWindow各自独立构造并验证结果） | 通过 |
| 11 | 历史不足或23根窗口异常返回INSUFFICIENT_DATA | `v1-4c-forecast` #7 | 通过 |
| 12 | 修改候选bar之后数据不改变该候选bar历史判定 | `v1-4c-forecast` #8 | 通过 |
| 13-16 | BTC相关性正/负相关同向反向、±0.3边界、UNKNOWN全覆盖 | `po-feature-mapping.test.js`（纯函数，覆盖全部符号×方向组合+缺失/NaN/Infinity/flat） | 通过 |
| 17 | 9种PO_状态进入/保持/退出/否决 | `po-state-engine.test.js` | 通过 |
| 18 | auxiliaryEvidence冲突不改变PO_状态 | `po-state-engine.test.js`（冲突记录测试） | 通过 |
| 19 | 相同prediction并发生成只产生一条snapshot | `v1-4c-forecast` #11（同一lease下两个真实并发事务竞争同一UNIQUE约束） | 通过 |
| 20 | 相同prediction+evaluationVersion并发回填只产生一条outcome | `v1-4c-outcome` #6（幂等DEDUPED验证） | 通过 |
| 21 | 新evaluationVersion追加、旧行不变 | `v1-4c-outcome` #7 | 通过 |
| 22 | snapshot UPDATE/DELETE数据库触发器拒绝 | `v1-4c-forecast` #13 | 通过 |
| 23 | 删除被引用feature/snapshot由ON DELETE RESTRICT拒绝 | `v1-4c-forecast` #14 | 通过 |
| 24 | 生成/回填事务任一步失败无孤儿/残行 | `v1-4c-forecast` #16；`v1-4c-outcome` #10；`v1-4c-lease-concurrency` #9（心跳失败停止后无残行，新增） | 通过 |
| 25 | Generator/Evaluator不同lease/timer/状态/审计表 | `v1-4c-lease-concurrency` #1, #2, #7（新增，`start()`独立性验证） | 通过 |
| 26 | 一方丢失lease不影响另一方 | `v1-4c-lease-concurrency` #3；#9（新增，心跳失败场景下的独立性） | 通过 |
| 27 | Generator/Evaluator旧token分别事务内拒绝且无残行 | `v1-4c-lease-concurrency` #4, #5（另加`v1-4c-forecast`#16/`v1-4c-outcome`#10各自独立验证） | 通过 |
| 28 | Generator不得写outcome，错误lease名称拒绝 | `v1-4c-lease-concurrency` #6（结构性+数据库CHECK双重验证） | 通过 |
| 29 | UP/DOWN/RANGE的actualReturn/actualDirection/directionCorrect | `v1-4c-outcome` #5（真实UP场景端到端）；`outcome-engine.test.js`覆盖DOWN/RANGE纯函数场景 | 通过 |
| 30 | UP/DOWN/RANGE各自MFE/MAE/专属指标/覆盖/失效触发 | `outcome-engine.test.js` | 通过 |
| 31 | snapshot不可变，outcome不反向修改snapshot | `v1-4c-forecast` #13；`v1-4c-outcome` #8 | 通过 |
| 32 | down migration只删除V1.4C对象，不破坏V1.4A/B | `postgres-production.integration.test.js` #1（真实up→down→up→down→up往返，31表精确核对）；`004_v1_4c_forecast_engine.down.sql`人工审阅仅含6个DROP TABLE+1个DROP FUNCTION | 通过 |

**P0结论：32/32项全部通过，0项跳过，0项失败。**

## 4. P1 验收矩阵结果（含本轮 Codex 复审修复）

| P1要求 | 覆盖 | 结果 |
|---|---|---|
| predictionId与浏览器命名空间隔离（`-SRV-`前缀+独立algorithmVersion） | `forecast-contract.test.js`；`v1-4c-forecast`#9断言predictionId正则`^GMKG-SRV-ETH-24h-...` | 通过 |
| **24H每4小时/72H每UTC自然日最多生成一条正式快照（P1-2，本轮修复）** | **`bar-path-locator.js` 新增 `computeAlignedReferenceCloseTime()`：referenceBar 必须精确落在节奏边界（24H=4小时整点，72H=UTC自然日整点），不再是"最近一根已收盘bar"；`v1-4c-forecast`#17 用真实PostgreSQL模拟21次连续15分钟轮询直接断言：24H恰好生成2次（对应2个不同4H边界）、72H恰好生成1次（对应1个UTC日边界），且每个边界内的高频轮询（16次/3次）均正确DEDUPED为同一份快照；另验证"重启/双实例竞争"场景下全新Generator实例仍确定性解析到同一referenceBar** | **通过（原文档"仅靠UNIQUE(prediction_id)约束自动成立"的结论已判定错误并删除，见§0/§9）** |
| walk-forward按时间切分无重叠无打乱 | `walk-forward.test.js` | 通过 |
| 只评估targetEndTime已到期的预测 | `evaluator-service.js findPendingSnapshots`的`target_end_time<=asOfTime`过滤，`v1-4c-outcome`端到端场景隐含验证（回填时asOfTime已越过targetEndTime才被纳入pending） | 通过 |
| sources完整去重可追溯 | `v1-4c-forecast`#9验证`forecast_snapshot_sources`恰好1行；`UNIQUE(forecast_snapshot_id,feature_record_id)`数据库约束 | 通过 |
| swingHigh/Low只作点值使用 | `po-feature-mapping.js`静态实现审阅确认无`.lower`/`.upper`派生 | 通过（人工审阅） |
| LEGACY_BROWSER不进入服务器统计分母 | 结构性保证（IndexedDB与PostgreSQL物理隔离，§12红线），`sourceOrigin`恒为`'SERVER'`（数据库CHECK+`v1-4c-outcome`#5验证） | 通过 |
| 三组V1.4C PostgreSQL测试真正接入test:postgres | `review-regression.test.js`结构性测试直接断言 | 通过 |
| review-regression.test.js结构性验证该接线 | 同上；本轮新增3项结构性测试分别验证P0-1生产接线、P1-1心跳实现、P1-2节奏边界实现，见§9 | 通过 |
| **两个调度器正式接入生产启动入口（P0-1，本轮修复）** | **`server/src/index.js` `bootstrap()`导入并实例化`ForecastGenerator`/`OutcomeEvaluator`，调用各自`start()`/`stop()`，纳入graceful shutdown；`v1-4c-lease-concurrency`#7用真实PostgreSQL验证两者能各自成功`start()`并持有独立lease/running/heartbeatTimer/abortController** | **通过（新增）** |
| **独立心跳续约，跨lease TTL周期持续工作（P1-1，本轮修复）** | **`generator-service.js`/`evaluator-service.js`新增`heartbeat()`/`scheduleHeartbeat()`，复用CollectorService已验证的UPDATE续约SQL模式；`v1-4c-lease-concurrency`#8用真实时间推进（等待>3个lease TTL周期）验证fencing_token不变、expires_at持续被推进；#9验证心跳续约失败后真正停止（running=false/leaseLost=true/timers清空）且不产生残行，另一调度器不受影响** | **通过（新增）** |
| 既有V1.4A/B测试不得回归 | `npm run test:postgres:v1.4a`13/13、`:features`4/4、`:revision`9/9（历史记录，本轮未重新执行，见§0B）；`npm test`本轮实际执行232/232通过 | 通过 |

## 5. P2 披露

1. PO_状态9条规则的必要/加分/否决条件文本未逐字对照`V1_4_FORECAST_DATA_SPEC.md §4.2`原文做条件级别独立复核（见实施报告§10第1条，本轮未涉及，维持原披露）。
2. `postgres.js`（V1.4A既有文件）的`migrationStatus()`不识别迁移004（既有设计限制，非本轮引入，未修改该文件）。
3. 生成/回填性能未做专项基准测试。
4. 只读API端点（`/api/v1/forecast/*`）未实现——不在V1.4C范围内。
5. **（本轮新增披露）** `ForecastGenerator.start()`/`OutcomeEvaluator.start()`的默认`intervalMs`（生成/回填轮询间隔，当前5分钟）未做专项的"最优轮询频率"评估，只保证正确性（不产生多余样本），未来可根据实际4H/UTC日边界触发的及时性需求调整，但这属于运维调参范畴，不影响正确性结论。
6. **（本轮新增披露）** 生产环境中`ForecastGenerator`/`OutcomeEvaluator`的`serverTimeProvider`复用`measureServerTime(adapter,...)`发起独立的Binance服务器时间HTTP请求（与CollectorService各自独立请求，三者互不共享请求/超时/熔断状态）；本轮未新增对该HTTP路径本身的专项测试（该函数本身已有V1.4A既有测试覆盖），只在真实PostgreSQL测试中用可控的`serverTimeProvider`桩替换，未做端到端真实Binance网络联调（不在`test:postgres`范围内，避免引入网络依赖）。

## 6. 既有测试回归检查

- `server/tests/*.test.js`（不含forecast子目录）：全部通过，随`npm test`一并验证。
- `server/tests/postgres/postgres-production.integration.test.js`（V1.4A）：13/13通过（含因迁移004新增表而必要更新的表数断言，详见实施报告§7）。
- `server/tests/postgres/v1-4b-feature.integration.test.js`（V1.4B）：4/4通过，未修改该文件任何一行。
- `server/tests/postgres/v1-4b-revision-time-progression.integration.test.js`（V1.4B）：9/9通过，未修改该文件任何一行。

**回归结论：0项回归。**

## 7. 命令行原始输出摘录

### 本轮（2026-07-24，P0-1/P1-1生命周期修复）实际执行

```
$ cd server && npm test
...
1..232
# tests 232
# suites 0
# pass 232
# fail 0
# cancelled 0
# skipped 0
# todo 0

$ echo $?
0

$ npm run check
...
1..232
# pass 232
# fail 0
$ echo $?
0

$ npm run test:features
...
1..44
# pass 44
# fail 0
```

`npm run test:postgres`及其六个子命令本轮**未执行**（未配置`TEST_DATABASE_URL`，见§0B），以下为此前环境的历史记录，非本轮输出：

```
（历史记录，非本轮执行）
（v1.4a）        # tests 13 / pass 13 / fail 0
（features）     # tests 4  / pass 4  / fail 0
（revision）     # tests 9  / pass 9  / fail 0
（v1.4c-forecast）# tests 17 / pass 17 / fail 0
（v1.4c-outcome） # tests 10 / pass 10 / fail 0
（v1.4c-lease）   # tests 9  / pass 9  / fail 0
```

## 8. 完成门禁自查

- [x] 全部P0、P1测试通过（32/32 P0，13/13 P1条目——历史记录，本轮未改动业务逻辑，未重新执行其PostgreSQL验证部分，见§0B）
- [x] P2问题全部披露（6条，见§5）
- [x] 既有测试无回归（本轮`npm test`232/232，含18项新增生命周期测试，0 fail）
- [ ] `test:postgres`本轮**未执行**（未配置隔离`TEST_DATABASE_URL`，不得视为通过，见§0B详细说明；历史62项为此前环境记录）
- [x] 无范围外文件修改（本轮只修改`server/src/index.js`/`server/src/lifecycle.js`（新增）/`server/src/forecast/generator-service.js`/`server/src/outcome/evaluator-service.js`及对应测试与本文档/实施报告，未触及交易策略、预测公式、Snapshot/Outcome数据口径、时间契约或数据库schema）
- [x] 无网络依赖的测试可离线复现（`npm test`不依赖网络/数据库，232/232）
- [ ] 本轮未新建/使用隔离数据库（PostgreSQL集成测试未执行，见§0B）
- [x] 无`.only`、`.skip`（业务性）、弱化断言或伪造结果——本轮新增18项测试均为真实执行的正向/负向断言，无任何跳过或伪造
- [x] `git diff --check`无输出（本轮提交前已复核）

## 9. Codex 复审三项修复的详细证据（本轮新增）

### 9.1 P0-1：生产启动接线

- `server/src/index.js`：`bootstrap()`新增导入`ForecastGenerator`/`OutcomeEvaluator`，构造独立`serverTimeProvider`（复用`measureServerTime(adapter,...)`，无状态工具函数，不构成调度状态共享），分别以`${collectorId}-forecast-generator`/`${collectorId}-outcome-evaluator`为`holderId`实例化，调用`forecastGenerator.start()`/`outcomeEvaluator.start()`，并纳入`stop()`的`Promise.allSettled`并行graceful shutdown。
- 真实验证：`v1-4c-lease-concurrency.integration.test.js` #7——用真实PostgreSQL分别调用两者的`start()`，断言均成功持有独立lease（`holder_id`分别匹配预期）、`running=true`、`heartbeatTimer`已启动、`abortController`互不相等（不同引用）、`timers`数组互不相等；调用`stop()`后断言`running=false`且`abortController.signal.aborted=true`。
- 结构性验证：`review-regression.test.js`新增测试直接读取`index.js`源码，断言导入语句、实例化语句、`start()`/`stop()`调用链均存在。

### 9.2 P1-1：独立心跳续约

- `generator-service.js`/`evaluator-service.js`均新增：`heartbeat()`（真实执行`UPDATE collector_leases SET heartbeat_at=clock_timestamp(),expires_at=...WHERE lease_name=$1 AND holder_id=$2 AND fencing_token=$3 AND expires_at>clock_timestamp()`，续约失败立即`loseLease('LEASE_LOST')`并抛出）、`scheduleHeartbeat()`（独立`setTimeout`递归定时器链，与生成/回填轮询定时器分开存放于`this.heartbeatTimer`，`clearSchedulers()`一并清理）。
- 真实时间推进验证：`v1-4c-lease-concurrency.integration.test.js` #8——设置`leaseTtlMs=900ms`，`heartbeatIntervalMs=250ms`，`start()`后真实等待`>3×leaseTtlMs`（约3.35秒），断言两个调度器均仍`running=true`/`leaseLost=false`，`fencingToken`跨心跳周期保持不变（证明是持续续约而非重新acquire），数据库真实`expires_at`确认仍未过期且持续被推进。
- 真实失败场景验证：#9——真实推进Generator持有lease的`fencing_token`（模拟被抢占），真实等待心跳定时器触发一次（`250ms+500ms`），断言Generator的`running=false`/`leaseLost=true`/`abortController.signal.aborted=true`/`heartbeatTimer=null`/`timers.length=0`；再等待1秒确认`forecast_generation_runs`行数未增长（无使用旧token的残行写入）；全程Evaluator不受影响，继续`running=true`且经过更长时间仍正常。
- 结构性验证：`review-regression.test.js`新增测试断言两个文件均包含`async start(`/`async heartbeat()`/`scheduleHeartbeat(`/真实的`UPDATE collector_leases SET heartbeat_at=clock_timestamp()`续约SQL/`this.loseLease('LEASE_LOST')`/独立`abortController`/`async stop()`。

### 9.3 P1-2：确定性生成节奏门禁

- `bar-path-locator.js`新增`computeAlignedReferenceCloseTime(asOfTime, horizon)`：24H边界=4小时整点（`(closeTime+1) % 14400000 === 0`），72H边界=UTC自然日整点（`(closeTime+1) % 86400000 === 0`），纯算术函数，仅依赖`asOfTime`与`horizon`，不依赖数据库状态或调用时机。`locateReferenceBarAndPath()`的referenceBar查询从原来的`ORDER BY open_time DESC LIMIT 1`（"最近一根已收盘bar"）改为对该计算出的精确边界时刻做`close_time=to_timestamp($2/1000.0)`精确匹配——若该边界时刻的bar尚不存在/不可见，判定为"本轮尚未到生成时刻"，fail closed，不得退而求其次选用邻近bar。
- 真实节奏模拟验证：`v1-4c-forecast.integration.test.js` #17——独立种子（`RHYTHM_END`锚点，每根bar各自的`fetchedAt`=自身`closeTime`+1秒，避免整批数据在轮询窗口早期被as-of可见性规则统一遮蔽），模拟21次连续15分钟轮询（offset -18 至 +2），直接断言：
  - 24H：恰好2次`INSERTED`（referenceBar分别为`RHYTHM_END-14400000`与`RHYTHM_END`两个不同4H边界），offset -18/-17两次轮询因边界外数据未采集而`BLOCKED`（未到生成时刻），其余全部`DEDUPED`；offset -16..-1共16次高频轮询全部解析到同一个referenceBar，仅第1次`INSERTED`，其余15次`DEDUPED`。
  - 72H：恰好1次`INSERTED`（referenceBar=`RHYTHM_END`，唯一命中的UTC自然日边界），offset -18..-1共18次轮询均`BLOCKED`（上一个日边界在采集范围之外，未到生成时刻），其余2次`DEDUPED`。
  - 重启/双实例竞争：全新的第二个`ForecastGenerator`实例（不同`holderId`，模拟进程重启）在当前窗口内轮询，确定性解析到与第一个实例完全相同的referenceBar并`DEDUPED`，不产生新样本。
- 结构性验证：`review-regression.test.js`新增测试断言`bar-path-locator.js`导出`computeAlignedReferenceCloseTime`、referenceBar查询已改为精确匹配模式、不再包含旧的"最近一根"查询模式；并断言本文档不再包含旧的错误表述。
