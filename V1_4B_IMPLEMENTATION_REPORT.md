# ETH Alpha V1.4B 实施报告

分支：`codex/v1.4b-feature-engine-foundation`  
基线：`main@3b997ee2baddc95ecf3712d533700ecc9b539855`（Release v1.4.1）  
实现提交：`8a7e0112f98308ea95e7e76018bf6a1b9ebf8580`。本报告元数据的后续纯文档提交哈希记录在最终交付消息。  
范围：统一特征工程、as-of时间契约、质量控制、来源追溯和PostgreSQL存储基础。没有训练模型、概率校准、规则权重修改、账户连接或真实交易。

## 1. 实现范围

新增 `server/src/features/` 五个规范模块及生成CLI：

- `feature-version.js`：冻结 `v1.4b-unified-1`、算法和来源数据集版本；
- `feature-contract.js`：稳定featureId、54项完整字段、null/availability、确定性contentHash和正式契约校验；
- `feature-quality.js`：HEALTHY/WARNING/DEGRADED/BLOCKED与关键窗口fail-closed；
- `feature-lineage.js`：来源自然键、revision、时间、raw引用、vintage和contentHash；
- `feature-engine.js`：单点、范围批量、dry-run、幂等、resume游标和生成后持久化；
- `generate-features.js`：使用独立 `feature-generator` lease 的运维入口，不暴露写HTTP接口。

## 2. 精确特征清单

价格/收益14项：`logReturn1/3/6/12`、`closeToEma5/10/20`、`ema5/10/20Slope`、`highLowRange`、`candleBodyRatio`、`upperWickRatio`、`lowerWickRatio`。

波动率5项：`atr14`、`atrNormalized`、`realizedVolatility`、`volatilityRegime`、`rangeExpansionRatio`。

成交量6项：`volumeRatio20`、`volumeZScore`、`quoteVolumeRatio`、`takerBuyRatio`、`takerSellRatio`、`takerImbalance`。

结构8项：`swingHigh`、`swingLow`、`distanceToSupportAtr`、`distanceToResistanceAtr`、`rangePosition`、`breakoutState`、`falseBreakoutRisk`、`structureState`。Swing只消费截至目标时点的过去窗口，没有未来确认。

衍生品9项：`fundingRate`、`fundingRateZScore`、`openInterest`、`openInterestChange`、`openInterestChangeRatio`、`longShortRatio`、`longShortRatioZScore`、`takerBuySellRatio`、`derivativesAvailability`。

BTC联动6项：`btcReturn`、`btcTrendState`、`btcVolatility`、`ethBtcReturnSpread`、`ethBtcRollingCorrelation`、`btcConflictState`。

多周期6项：`trend15m`、`trend1h`、`trend4h`、`multiTimeframeAlignment`、`multiTimeframeConflict`、`strategicRegime`。合计54项。

## 3. 时间契约与防未来泄漏

数据库读取采用双时间边界：来源观察时间/收盘时间必须 `<= targetBarCloseTime`；`publishedAt`、`availableAt`、`fetchedAt`必须 `<= asOfTime`。同自然键通过 `DISTINCT ON + revision DESC`选择当时可见的最新版本，不使用数据库“现在最新”替代历史时点版本。目标K线必须精确存在且已收盘；ETH 1h/4h、BTC三周期和四类衍生品均走相同边界。任何未来来源在查询层被排除，并在契约/lineage二次校验时fail closed。

缺失非关键衍生品保持 `null`、`availability=false`，进入 `missingFeatures`和`degradedReasons`。数据库不可用、目标未收盘、关键ETH 15m窗口不足、非法版本、时间契约失败或未来泄漏均为BLOCKED，BLOCKED记录不会作为正式特征持久化。

## 4. PostgreSQL迁移与revision

迁移 `003_v1_4b_feature_engine`新增：

- `feature_sets`
- `feature_records`
- `feature_source_refs`
- `feature_quality_events`
- `feature_generation_runs`
- `feature_revision_events`

自然键为 `symbol + targetInterval + targetBarCloseTime + featureSetVersion`。同内容返回DEDUPED；内容变化在advisory transaction lock内追加revision，旧记录不覆盖，并在同一事务写revision event、质量事件和全部source refs。任何一步失败全部回滚。所有正式写入复用V1.4A `transaction()`，在事务开始与提交前用PostgreSQL时间验证lease holder、fencing token及有效期。

## 5. 来源追溯和只读API

每个正式record同时保存 `sourceVintageRefs/sourceRevisionRefs` 冻结快照，并以 `feature_source_refs`原子展开。引用含数据集、来源、symbol、interval、自然键、revision、sourceTime、publishedAt、availableAt、rawPayloadId、数据库记录ID、vintageId和contentHash。

新增只读GET：按ID、时间范围、lineage、quality、generation runs、missing/degraded issues查询。API总守卫仍拒绝POST/PUT/PATCH/DELETE；没有新增公开写接口。

## 6. V1.4A P2关闭

1. 健康遥测默认保留90天，`HEALTH_RETENTION_DAYS`可配置。`maintenance:health`支持dry-run及安全删除，SQL只触及 `data_health_snapshots`，绝不删除raw、正式事实、revision或feature记录。
2. readiness不再使用990000ms常量。15m/1h/4h按各自周期 `expectedFrequencyMs × FRESHNESS_GRACE_MULTIPLIER`（默认3）独立计算并返回边界明细。

## 7. 安全边界与未完成事项

`server/src`中五个真实交易入口直接调用均为0。没有API密钥、签名请求、订单、账户、持仓或浏览器模拟账户修改。宏观数据继续 `UNAVAILABLE/null`，没有伪造值。浏览器V1.1–V1.4文件和正式HTML均未改动。

本机没有隔离 PostgreSQL/`TEST_DATABASE_URL`，因此新增4项真实PG测试与既有13项在本机明确SKIP。V1.4A 13项已有真实PostgreSQL 14 CI通过证据；V1.4B 4项已加入同一强制门禁，最终状态需以推送后CI为准。真实REST+PostgreSQL仍按既有独立Job执行；精确451只记 `EXTERNAL_REGION_BLOCKED`，不记PASS。

Push尝试结果：失败，原因是本机Git HTTPS凭据不可用（`could not read Username`）；没有修改remote或凭据，需由用户通过GitHub Desktop推送。实现提交完成时工作区干净，`main`与`origin/main`仍为 `3b997ee2baddc95ecf3712d533700ecc9b539855`。

## 8. PostgreSQL 14 CI fixture修复

GitHub Actions在`7de62a4a14f61866957da314eca0c27a8bf2954e`运行V1.4B PostgreSQL测试时，4项均在共享种子hook内失败。对象级核对表明`normalizeLongShort()`的正式输入为Binance全市场多空比结构：`symbol`、毫秒级`timestamp`，以及带前导零的十进制字符串`longShortRatio`、`longAccount`、`shortAccount`。测试fixture误写为`longAccount: '.52'`、`shortAccount: '.48'`，不符合冻结十进制字符串规则，故严格校验正确返回`LONG_SHORT_INVALID`。

修复仅把种子改为真实合法形状`'0.52'`/`'0.48'`，并在原4项PostgreSQL测试第一项中查询`long_short_ratios`核对三项数值确已通过生产标准化和仓库路径写入。另增加合法结构与三类非法结构的非联网回归。`normalizeLongShort()`生产实现、时间顺序红线、防未来泄漏、fencing和数据库约束均未改变。修复后共享hook可以完成，原4项测试将由PostgreSQL 14 CI真实执行，而不是以hookFailed结束。

## 9. Revision持久化缺陷根因定位与修复

独立对抗性复审在隔离PostgreSQL 14中用真实推进的时间戳（而非既有测试复用的同一常量时间戳）复现：写入`market_bars`及全部4张衍生品事实表的revision=0初始事实后，推进真实抓取时间（+3小时），使用相同自然键但不同业务内容尝试写入revision=1，5张表全部触发CHECK约束失败：

| 表 | 约束名 | 错误码 |
|---|---|---|
| market_bars | market_bars_check4 | 23514 |
| funding_rates | funding_rates_check | 23514 |
| open_interest | open_interest_time_order | 23514 |
| long_short_ratios | long_short_time_order | 23514 |
| taker_flow | taker_flow_time_order | 23514 |

失败行的实际时间字段：原记录`available_at=first_available_at=fetched_at`三者相等（初始写入，源自同一次抓取）；尝试写入的新revision行中，`first_available_at`被正确保留为原记录的旧值，但`available_at`被错误赋值为本次抓取的新`fetched_at`（远晚于保留的`first_available_at`），导致违反`CHECK(available_at<=first_available_at<=fetched_at)`。

**精确根因**：`server/src/db/postgres.js`的`saveMarketBar()`与`savePointFact()`在构造revision行时，把`available_at`列错误地重新赋值为“本次请求的抓取时间”（`bar.fetchedAt`/`fact.fetchedAt`），而不是保持为`normalizeKlines()`/`pointFact()`本就正确计算好的、随自然键固定不变的来源侧可用时间（K线为收盘时间`closeTime`，点状事实为观测时间`observedAt`）。`first_available_at`按设计（README“保留首个firstAvailableAt”）在revision间被正确保留为原记录旧值。这两处赋值逻辑本身各自正确，但被组合使用时产生矛盾：`available_at`本应是随自然键恒定的常量（与revision 0完全一致），却被换成了会随每次抓取真实推进的`fetched_at`；而`first_available_at`则被钉死在最早一次抓取的旧值上。当revision发生在真实、有意义的时间间隔之后（这正是revision的定义本身），`available_at`（新、大）必然超过`first_available_at`（旧、小），触发约束拒绝。既有17项真实PostgreSQL测试的revision用例均复用同一个固定`NOW`常量同时作为原始行与修订行的`fetchedAt`，使二者恰好相等，从而掩盖了这一必然在真实时间推进下发生的缺陷。

**修复**：`server/src/db/postgres.js`的`saveMarketBar()`第69行、`savePointFact()`内部`normalized`对象构造处，将`available_at`固定改为直接使用传入行自身的`bar.availableAt`/`fact.availableAt`（不再区分是否存在`previous`），与revision 0的原有行为完全一致；`first_available_at`的保留逻辑不变。同时修复`server/src/db/memory.js`中`upsertMarketBars`/`savePointFacts`的同构问题，保持MemoryRepository与真实PostgreSQL行为一致。未改动、未放宽任何CHECK约束、未改动未来数据防泄漏逻辑、未收盘K线拒绝逻辑、fencing校验或原始数据不可变触发器。

**为什么不会造成未来数据泄漏**：本次修复只改变了写入路径中`available_at`列的取值来源（从错误的“本次抓取时间”改回正确的“来源自身固定的可用时间”），不涉及、不放宽任何`publishedAt/availableAt/firstAvailableAt/fetchedAt/asOfTime`大小关系校验，也不影响`generateFeatureRecord`中的`future`布尔检查与`validateLineage`的双重未来来源校验；`loadFeatureInputs`的as-of查询逻辑（`available_at<=asOfTime AND fetched_at<=asOfTime`）未被修改，其中`fetched_at`因本次修复后仍随revision真实推进，继续正确充当revision可见性的判别边界。

**为什么不会覆盖或丢失旧revision**：修复后`saveMarketBar`/`savePointFact`仍然是纯INSERT（从不UPDATE已有行），旧revision在DEDUPED/REVISED任一分支下都不会被修改；`available_at`赋值方式的调整只影响新插入行自身的列值，不触及、不删除任何已存在的行。真实PostgreSQL测试确认修复前被CHECK约束拒绝的revision，在修复后能成功追加为新的一行，而revision 0原样保留、内容未变。

**五类事实表revision测试结果**：新增`server/tests/postgres/v1-4b-revision-time-progression.integration.test.js`，对`market_bars`及4张衍生品事实表逐一验证CREATED→DEDUPED→（真实时间推进+3小时后）REVISED→revision 0/1共存→revision事件存在→旧记录未覆盖，5项测试全部通过。

**as-of新旧revision边界结果**：新增独立测试验证，在修订自身的`fetched_at`可见时间点之前查询，`loadFeatureInputs`只能读到旧revision内容；在该时间点及之后查询，才能读到新revision内容；未出现修订提前可见的情况。

**PostgreSQL真实执行状态**：本次修复的全部验证（复现、根因确认、修复后回归、9项新增revision测试、既有13+4项测试、真实REST+PostgreSQL链）均在本机隔离PostgreSQL 14中真实执行，非本机SKIP、非引用CI证据。提交后仍需GitHub Actions PostgreSQL 14强制门禁独立复核。

## 10. Revision时间推进测试接入强制门禁

独立复审确认第9节新增的9项真实PostgreSQL测试虽然已经存在并曾在隔离数据库中单独通过，但`server/package.json`的`test:postgres`仍只串联V1.4A 13项与V1.4B原有4项，导致GitHub Actions调用组合命令时没有执行revision时间推进文件。本轮不修改任何revision生产逻辑，只新增`test:postgres:revision`脚本，并将强制组合固定为`test:postgres:v1.4a → test:postgres:features → test:postgres:revision`，预期合计26项。

`.github/workflows/v1-4a-postgres-integration.yml`的`postgres-production-path`继续直接执行`npm run test:postgres`，没有`continue-on-error`，因此任何一组失败都会使强制门禁失败。`server/tests/review-regression.test.js`新增结构性断言，同时锁定独立脚本路径、三段组合命令和workflow调用点，防止revision测试文件再次脱离CI。数据库CHECK、as-of时间红线、未来数据防泄漏、fencing及事务原子性均未修改或放宽。
