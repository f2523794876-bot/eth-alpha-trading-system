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
