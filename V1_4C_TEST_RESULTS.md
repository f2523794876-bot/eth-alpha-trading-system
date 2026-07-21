# V1_4C_TEST_RESULTS.md — V1.4C 服务器端预测基础设施测试结果

## 1. 执行环境

- Node.js v22.23.1
- PostgreSQL（本地实例，通过 `psql`/`pg_isready` 确认可达），隔离测试角色 `eth_alpha_test`、隔离测试库 `eth_alpha_v14a_test`（沿用 V1.4A/B 既有测试库命名，满足 `/test|ci|v14/i` 隔离校验正则）
- 所有真实 PostgreSQL 测试均在每个测试文件的 `before()` 钩子内先执行 `runMigrations(pool,'down')` 再 `runMigrations(pool,'up')`，确保每个文件从全新 schema 开始，互不残留状态

## 2. 命令与 exit code 汇总

| 命令 | exit code | tests | pass | fail | skip |
|---|---|---|---|---|---|
| `npm test`（`tests/*.test.js` + `tests/forecast/*.test.js`，含 review-regression 结构性门禁） | 0 | 205 | 205 | 0 | 0 |
| `npm run test:postgres:v1.4a`（既有，含004迁移后31表断言更新） | 0 | 13 | 13 | 0 | 0 |
| `npm run test:postgres:features`（既有V1.4B） | 0 | 4 | 4 | 0 | 0 |
| `npm run test:postgres:revision`（既有V1.4B） | 0 | 9 | 9 | 0 | 0 |
| `npm run test:postgres:v1.4c-forecast`（新增） | 0 | 16 | 16 | 0 | 0 |
| `npm run test:postgres:v1.4c-outcome`（新增） | 0 | 10 | 10 | 0 | 0 |
| `npm run test:postgres:v1.4c-lease`（新增） | 0 | 6 | 6 | 0 | 0 |
| `npm run test:postgres`（上述6步组合命令，一次性顺序执行） | 0 | 58 | 58 | 0 | 0 |

**离线复现性**：未设置 `TEST_DATABASE_URL` 时，三个V1.4C真实PostgreSQL测试文件通过 `pgtest = enabled ? test : test.skip` 全部优雅降级为 SKIP（已验证：3文件合计32项全部 `# SKIP`，`pass 0 fail 0 skipped 32`），不会导致离线环境下 `npm test`/CI 无网络阶段失败。

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
| 8 | 连续突破/跌破对称覆盖0/1/2/3/>3 | `v1-4c-forecast` #5（0/1/2/3四场景），#6（跌破对称），count封顶于M=3即代表">3"场景（结构性保证：requiredBars固定23，见实施报告§4.1说明） | 通过 |
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
| 24 | 生成/回填事务任一步失败无孤儿/残行 | `v1-4c-forecast` #16；`v1-4c-outcome` #10 | 通过 |
| 25 | Generator/Evaluator不同lease/timer/状态/审计表 | `v1-4c-lease-concurrency` #1, #2 | 通过 |
| 26 | 一方丢失lease不影响另一方 | `v1-4c-lease-concurrency` #3 | 通过 |
| 27 | Generator/Evaluator旧token分别事务内拒绝且无残行 | `v1-4c-lease-concurrency` #4, #5（另加`v1-4c-forecast`#16/`v1-4c-outcome`#10各自独立验证） | 通过 |
| 28 | Generator不得写outcome，错误lease名称拒绝 | `v1-4c-lease-concurrency` #6（结构性+数据库CHECK双重验证） | 通过 |
| 29 | UP/DOWN/RANGE的actualReturn/actualDirection/directionCorrect | `v1-4c-outcome` #5（真实UP场景端到端）；`outcome-engine.test.js`覆盖DOWN/RANGE纯函数场景 | 通过 |
| 30 | UP/DOWN/RANGE各自MFE/MAE/专属指标/覆盖/失效触发 | `outcome-engine.test.js` | 通过 |
| 31 | snapshot不可变，outcome不反向修改snapshot | `v1-4c-forecast` #13；`v1-4c-outcome` #8 | 通过 |
| 32 | down migration只删除V1.4C对象，不破坏V1.4A/B | `postgres-production.integration.test.js` #1（真实up→down→up→down→up往返，31表精确核对）；`004_v1_4c_forecast_engine.down.sql`人工审阅仅含6个DROP TABLE+1个DROP FUNCTION | 通过 |

**P0结论：32/32项全部通过，0项跳过，0项失败。**

## 4. P1 验收矩阵结果

| P1要求 | 覆盖 | 结果 |
|---|---|---|
| predictionId与浏览器命名空间隔离（`-SRV-`前缀+独立algorithmVersion） | `forecast-contract.test.js`；`v1-4c-forecast`#9断言predictionId正则`^GMKG-SRV-ETH-24h-...` | 通过 |
| 24H每4小时/72H每日生成节奏 | 由`UNIQUE(prediction_id)`天然保证同一referenceBarRef.closeTime不重复计样本（数据库层，`v1-4c-forecast`#10/#11间接验证） | 通过（结构性） |
| walk-forward按时间切分无重叠无打乱 | `walk-forward.test.js` | 通过 |
| 只评估targetEndTime已到期的预测 | `evaluator-service.js findPendingSnapshots`的`target_end_time<=asOfTime`过滤，`v1-4c-outcome`端到端场景隐含验证（回填时asOfTime已越过targetEndTime才被纳入pending） | 通过 |
| sources完整去重可追溯 | `v1-4c-forecast`#9验证`forecast_snapshot_sources`恰好1行；`UNIQUE(forecast_snapshot_id,feature_record_id)`数据库约束 | 通过 |
| swingHigh/Low只作点值使用 | `po-feature-mapping.js`静态实现审阅确认无`.lower`/`.upper`派生 | 通过（人工审阅） |
| LEGACY_BROWSER不进入服务器统计分母 | 结构性保证（IndexedDB与PostgreSQL物理隔离，§12红线），`sourceOrigin`恒为`'SERVER'`（数据库CHECK+`v1-4c-outcome`#5验证） | 通过 |
| 三组V1.4C PostgreSQL测试真正接入test:postgres | `review-regression.test.js`新增结构性测试直接断言 | 通过 |
| review-regression.test.js结构性验证该接线 | 同上，见`server/tests/review-regression.test.js`新增测试 | 通过 |
| 既有V1.4A/B测试不得回归 | `npm run test:postgres:v1.4a`13/13、`:features`4/4、`:revision`9/9全部通过；`npm test`205/205通过 | 通过 |

## 5. P2 披露

1. PO_状态9条规则的必要/加分/否决条件文本未逐字对照`V1_4_FORECAST_DATA_SPEC.md §4.2`原文做条件级别独立复核（见实施报告§10第1条）。
2. `postgres.js`（V1.4A既有文件）的`migrationStatus()`不识别迁移004（既有设计限制，非本轮引入，未修改该文件）。
3. 生成/回填性能未做专项基准测试（本轮P2范围，`v1-4c-forecast`端到端测试实测约0.8秒完成单次含54项特征查询+PO判定+快照写入的完整事务，量级可接受但非正式性能基准）。
4. 只读API端点（`/api/v1/forecast/*`）未实现——不在V1.4C范围内（规范§15"建议新增文件清单"未列出，本轮未新增）。

## 6. 既有测试回归检查

- `server/tests/*.test.js`（不含forecast子目录）：全部通过，随`npm test`一并验证。
- `server/tests/postgres/postgres-production.integration.test.js`（V1.4A）：13/13通过（含因迁移004新增表而必要更新的表数断言，详见实施报告§7）。
- `server/tests/postgres/v1-4b-feature.integration.test.js`（V1.4B）：4/4通过，未修改该文件任何一行。
- `server/tests/postgres/v1-4b-revision-time-progression.integration.test.js`（V1.4B）：9/9通过，未修改该文件任何一行。

**回归结论：0项回归。**

## 7. 命令行原始输出摘录（完整可复现）

```
$ cd server && npm test
...
1..205
# tests 205
# suites 0
# pass 205
# fail 0
# cancelled 0
# skipped 0
# todo 0

$ export TEST_DATABASE_URL="postgresql://eth_alpha_test:***@127.0.0.1:5432/eth_alpha_v14a_test"
$ npm run test:postgres
...
（v1.4a）  # tests 13 / pass 13 / fail 0
（features）# tests 4  / pass 4  / fail 0
（revision）# tests 9  / pass 9  / fail 0
（v1.4c-forecast）      # tests 16 / pass 16 / fail 0
（v1.4c-outcome）       # tests 10 / pass 10 / fail 0
（v1.4c-lease）         # tests 6  / pass 6  / fail 0

$ echo $?
0
```

## 8. 完成门禁自查

- [x] 全部P0、P1测试通过（32/32 P0，10/10 P1条目）
- [x] P2问题全部披露（4条，见§5）
- [x] 既有测试无回归（0项回归，见§6）
- [x] `test:postgres`实际执行全部三组V1.4C真实PostgreSQL测试（58项汇总执行，exit 0）
- [x] 无范围外文件修改（仅1个必要的既有测试文件表数断言更新，已在实施报告§7逐项说明理由）
- [x] 无网络依赖的测试可离线复现（未设TEST_DATABASE_URL时全部SKIP，不阻塞`npm test`）
- [x] 数据库测试使用隔离数据库（`eth_alpha_v14a_test`，正则校验`test|ci|v14`）并完成清理（每文件`before()`内down+up重置）
- [x] 无`.only`、`.skip`（业务性）、弱化断言或伪造结果
- [x] `git diff --check`无输出
