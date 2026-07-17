# V1_4_ACCEPTANCE_TESTS.md — V1.4 验收测试

版本：v1.4-tests-draft-1
基线：`main` @ `a3d7aea`
角色：本文档是 V1.4 验收测试的唯一权威清单，供未来 Codex 实施完成后逐条勾选。本轮**不创建任何测试代码**，只定义测试规范。每条测试包含：ID / 严重等级 / 前置条件 / 输入 / 步骤 / 预期结果 / 自动或人工 / 对应规范条款。

严重等级说明：**P0**=阻断性（不通过则不得进入下一步）、**P1**=功能正确性、**P2**=可用性/体验。

---

## T1. 未来数据泄漏与 `availableAt` 边界

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| T1.1 | P0 | 已构造一组`DataVintageRef`，`availableAt`分布在`forecastCreatedAt`前后 | `forecastCreatedAt=T` | 调用walk-forward样本筛选函数 | 只返回`availableAt<=T`的版本，`availableAt>T`的版本被排除 | 自动 | GMKG总架构§4.3；V1_4_HISTORICAL_VALIDATION_SPEC.md§2 |
| T1.2 | P0 | 同上 | 构造一个`revisionNumber=1`且`availableAt>T`的修订版本 | 以`T`为切点回放 | 必须使用`revisionNumber=0`（`availableAt<=T`）的版本，不得使用修订版本 | 自动 | GMKG总架构§4.3红线 |
| T1.3 | P1 | — | `dataCutoffTime`字段 | 检查`ForecastSnapshot.dataCutoffTime`与`dataVintageRefs`对应`availableAt`的关系 | `dataCutoffTime >= `所有引用vintage的`availableAt` | 自动 | V1_4_FORECAST_DATA_SPEC.md§6 |

## T2. Vintage修订与已收盘K线判定

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| T2.1 | P1 | — | 一根已收盘ETH 15m K线 | 生成对应`DataVintageRef` | `revisionNumber=0`，`publishedAt=availableAt=closeTime` | 自动 | V1_4_FORECAST_DATA_SPEC.md§8.4 |
| T2.2 | P2 | — | 检查代码中是否存在K线修订处理路径 | 代码审查 | 修订机制**存在占位**（`DataRevisionEvent`结构可用）但当前无实例产生，不得误报"修订发生" | 人工 | GMKG总架构§4.3.1 |

## T3. Binance 时间边界（真实REST）

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| T3.1 | P0 | 需要网络 | `GET klines?symbol=ETHUSDT&interval=15m&limit=5` | 实测响应，计算`closeTime-openTime` | 恒等于`899999`（=900000-1） | 自动（联网） | V1_4_FORECAST_DATA_SPEC.md§5.3 |
| T3.2 | P0 | 同上 | 相邻两根K线 | 计算`下一根openTime - 上一根closeTime` | 恒等于`1` | 自动（联网） | 同上 |
| T3.3 | P1 | 需要网络 | `GET klines?symbol=BTCUSDT&interval=4h&limit=5` | 同T3.1方法应用于4h周期 | `closeTime-openTime`恒等于`14399999` | 自动（联网） | 同上 |
| T3.4 | P0 | 需要网络；本地时钟人为调快2分钟（测试环境模拟） | 请求`GET /api/v3/time`获取Binance服务器时间，并与本地`Date.now()`对比 | 调用`referenceBar`选取逻辑 | "已收盘"判定必须以K线自身`closeTime`与**服务器时间**比较，不得使用本地`Date.now()`直接比较；本地时钟偏快场景下不得选中实际尚未真正收盘（相对服务器时间）的K线作为`referenceBar` | 自动（联网+时钟模拟） | V1_4_ARCHITECTURE_REVIEW.md P0-1 |

## T4. `PRICE_ONLY_MODE` 与 `primaryState=UNKNOWN`

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| T4.1 | P0 | A组数据完整 | 正常K线序列 | 调用`classifyProxyState` | `operatingMode='PRICE_ONLY_MODE'`，`primaryState==='UNKNOWN'`（恒定） | 自动 | GMKG总架构§7.0a；V1_4_FORECAST_DATA_SPEC.md§3 |
| T4.2 | P0 | — | 任意输入 | 检查返回对象 | `TargetState.primaryState`**不允许**出现`S0_ACCUMULATION`...`S7_REPAIR_RANGE`任一值 | 自动 | 同上 |
| T4.3 | P1 | ATR14不可计算 | 构造不足K线数组 | 调用`classifyProxyState` | `operatingMode='INSUFFICIENT_DATA'`，`proxyState=null` | 自动 | V1_4_FORECAST_DATA_SPEC.md§3.1 |

## T5. `proxyState` 不冒充正式状态

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| T5.1 | P0 | — | 全部9种`PriceOnlyStateId`枚举值 | 检查`evidenceText`生成结果 | 每条均以`[PRICE_ONLY]`前缀开头 | 自动 | V1_4_FORECAST_DATA_SPEC.md§4.5 |
| T5.2 | P0 | — | 同上 | 全文关键词扫描`evidenceText`/`stateEvidence`/`opposingEvidence` | 不包含"资金费率""OI""爆仓""订单簿""CVD""ETF净流量""链上""投降""出清确认""主力""操盘手""庄家" | 自动（关键词黑名单） | V1_4_FORECAST_DATA_SPEC.md§4.5红线 |
| T5.3 | P1 | — | UI渲染结果 | 人工检查页面展示 | 固定免责声明"当前仅基于价格结构代理判断...不代表GMKG正式八状态识别"可见 | 人工 | V1_4_CODEX_IMPLEMENTATION_TASK.md§6 |

## T6. 代理与正式统计隔离

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| T6.1 | P0 | — | 构造`ProxyTransitionRecord`若干条 | 检查`statsGroup`字段 | 恒为`'PROXY_STATS'` | 自动 | GMKG总架构§8.4 |
| T6.2 | P0 | — | 检查存储实现 | 审查`ethAlphaGmkgProxyTransitions`键的读写代码 | 与任何`FULL_STATE_STATS`/`FormalTransitionRecord`存储键完全分离，无共用代码路径 | 人工代码审查 | V1_4_CODEX_IMPLEMENTATION_TASK.md§4 |
| T6.3 | P0 | — | 检查校准/统计聚合函数 | 审查是否存在把`ProxyTransitionRecord`计入正式八状态准确率分母的代码路径 | 不存在这样的路径 | 人工代码审查 | GMKG总架构§8.4红线1 |

## T7. `INSUFFICIENT_DATA` 不生成迁移记录

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| T7.1 | P0 | 构造触发`INSUFFICIENT_DATA`的输入 | 数据不足K线 | 调用完整生成链路 | 不产生`FormalTransitionRecord`也不产生`ProxyTransitionRecord`，`transitions={kind:'none'}` | 自动 | GMKG总架构§8.4红线2 |

## T8. `TransitionBundle` 判别联合

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| T8.1 | P0 | PRICE_ONLY_MODE场景 | 正常输入 | 检查`candidateTrajectories.transitions` | `kind==='proxy'`，`records`元素均为`ProxyTransitionRecord`形状（含`fromProxyState`/`toProxyState`） | 自动 | GMKG总架构§11.2 |
| T8.2 | P0 | INSUFFICIENT_DATA场景 | 数据不足输入 | 同上 | `kind==='none'`，无`records`字段或为空 | 自动 | 同上 |
| T8.3 | P1 | — | 类型检查 | 静态类型检查/运行时断言 | 不存在`kind`之外携带`FormalTransitionRecord`与`ProxyTransitionRecord`混合的数组 | 自动 | 同上 |

## T9. 24H 目标路径（96根bar）与 `referenceBar` 排除

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| T9.1 | P0 | 完整历史K线 | 24H预测 | 检查`ForecastSnapshot.expectedBarCount` | `=96` | 自动 | V1_4_FORECAST_DATA_SPEC.md§5.2 |
| T9.2 | P0 | 同上 | `referenceBarRef`/`targetBarRef` | 检查`sequenceIndex` | `referenceBarRef.sequenceIndex===0`，`targetBarRef.sequenceIndex===96` | 自动 | GMKG总架构§10.2 |
| T9.3 | P0 | 同上 | 目标路径bar集合 | 检查是否包含`sequenceIndex=0`的bar | **不包含**，路径为`1..96` | 自动 | GMKG总架构§10.5.0 |

## T10. 72H 目标路径（288根bar）

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| T10.1 | P0 | 完整历史K线 | 72H预测 | 检查`expectedBarCount` | `=288` | 自动 | V1_4_FORECAST_DATA_SPEC.md§5.2 |
| T10.2 | P0 | 同上 | `targetBarRef` | 检查`sequenceIndex` | `=288` | 自动 | GMKG总架构§10.2 |

## T11. bar 缺失/重复/错序/未收盘/synthetic 或 estimated bar

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| T11.1 | P0 | 构造路径中缺1根bar | `sequenceIndex=47`缺失 | 调用`locateTargetPath` | `pathDataComplete=false`，`missingBarRefs`含该bar，`exclusionReasons`含`'bar_missing:sequenceIndex=47'` | 自动 | GMKG总架构§10.5.1第1/2/3项 |
| T11.2 | P0 | 构造重复`sequenceIndex` | 两根bar均标注`sequenceIndex=47` | 同上 | `pathDataComplete=false`，`exclusionReasons`含`'duplicate_sequenceIndex:47'` | 自动 | §10.5.1第4项 |
| T11.3 | P0 | 构造重复`barKey` | 两根bar`barKey`相同、`sequenceIndex`不同 | 同上 | `pathDataComplete=false`，`exclusionReasons`含`'duplicate_barKey:...'` | 自动 | §10.5.1第5项 |
| T11.4 | P0 | 构造时间错序 | 某根bar的`openTime`早于前一根`closeTime` | 同上 | `pathDataComplete=false`，`exclusionReasons`含`'non_monotonic_time:...'` | 自动 | §10.5.1第6项 |
| T11.5 | P0 | 构造`targetBar`索引不匹配 | `targetBarRef`实际`sequenceIndex≠expectedBarCount` | 同上 | `pathDataComplete=false`，`exclusionReasons`含`'target_bar_index_mismatch'` | 自动 | §10.5.1第7项 |
| T11.6 | P0 | 构造未收盘bar混入路径 | 路径末尾bar`closeTime>now` | 同上 | `pathDataComplete=false`，`exclusionReasons`含`'bar_not_closed:...'` | 自动 | §10.5.1第8项 |
| T11.7 | P0 | 构造`estimated`/`synthetic`标记bar | 某bar标注为回补估算值 | 同上 | `pathDataComplete=false`，`exclusionReasons`含`'estimated_bar_rejected:...'` | 自动 | §10.5.1第9项 |
| T11.8 | P0 | 全部九项均满足 | 完整真实路径 | 同上 | `pathDataComplete=true` | 自动 | §10.5.1 |

## T12. `endpointDataComplete` 与 `pathDataComplete` 独立判定

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| T12.1 | P0 | 构造`referenceBar`缺失但`sequenceIndex 1..N`完整 | — | 调用`locateTargetPath` | `endpointDataComplete=false`，`pathDataComplete=true` | 自动 | GMKG总架构§10.5.0第2点 |
| T12.2 | P0 | 构造`referenceBar`/`targetBar`均存在但路径中间缺bar | — | 同上 | `endpointDataComplete=true`，`pathDataComplete=false` | 自动 | 同上 |
| T12.3 | P0 | 两者均满足 | — | 计算`pathEligibleForStatistics` | `= pathDataComplete && endpointDataComplete` 均为true时才为true | 自动 | GMKG总架构§10.1 |

## T13. 两类统计分母（`pathEligibleForStatistics`/`directionEligibleForStatistics`）

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| T13.1 | P0 | `endpointDataComplete=true`，`pathDataComplete=false` | — | 检查两个分母字段 | `directionEligibleForStatistics=true`，`pathEligibleForStatistics=false` | 自动 | GMKG总架构§10.1/§10.5 |
| T13.2 | P0 | — | 检查方向准确率聚合函数 | 审查代码 | 只使用`directionEligibleForStatistics`筛选，不引用`pathEligibleForStatistics` | 人工代码审查 | 同上 |
| T13.3 | P0 | — | 检查MFE/MAE/区间覆盖聚合函数 | 审查代码 | 只使用`pathEligibleForStatistics`筛选 | 人工代码审查 | 同上 |

## T14. Nullable 字段

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| T14.1 | P0 | `referenceBarRef`缺失 | — | 检查`actualStartPrice` | `=null`，不填0、不填`referencePrice` | 自动 | GMKG总架构§10.1 |
| T14.2 | P0 | `targetBarRef`缺失 | — | 检查`actualEndPrice`/`actualReturn`/`actualDirection` | 三者均`=null` | 自动 | 同上 |
| T14.3 | P0 | `pathDataComplete=false` | — | 检查`actualHigh`/`actualLow`/`mfe`/`mae`/`invalidationTriggered` | 全部`=null` | 自动 | GMKG总架构§10.5.1 |
| T14.4 | P0 | — | 类型检查 | 静态审查interface定义 | `actualStartPrice`/`actualEndPrice`/`actualReturn`均为`number\|null`，`invalidationTriggered`为`boolean\|null` | 人工 | GMKG总架构§10.1（P1-NEW-6） |

## T15. `UP`/`DOWN`/`RANGE` 边界判定

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| T15.1 | P1 | `directionThreshold=0.02` | `actualReturn=0.02`（恰好等于阈值） | 判定方向 | `UP`（`>=`包含等号，见GMKG总架构§10.3） | 自动 | GMKG总架构§10.3 |
| T15.2 | P1 | 同上 | `actualReturn=-0.02` | 判定方向 | `DOWN`（`<=`包含等号） | 自动 | 同上 |
| T15.3 | P1 | 同上 | `actualReturn=0.0199999` | 判定方向 | `RANGE` | 自动 | 同上 |
| T15.4 | P1 | — | 检查`directionThreshold`计算 | 代入基准ATR/referencePrice | 结果落在24H `[0.008,0.05]`或72H `[0.015,0.08]` clamp区间内 | 自动 | V1_4_FORECAST_DATA_SPEC.md§7.1 |

## T16. RANGE 专属指标

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| T16.1 | P0 | `expectedDirection='RANGE'`，`pathDataComplete=true` | 构造actualHigh/actualLow | 计算 | `mfe=null`，`mae=null`，`upperExcursion`/`lowerExcursion`/`maxAbsoluteExcursion`/`rangeBreachExcursion`均为具体数值 | 自动 | GMKG总架构§10.4/§10.4a |
| T16.2 | P1 | 同上 | — | 验证`maxAbsoluteExcursion=max(upperExcursion,lowerExcursion)` | 公式正确 | 自动 | 同上 |
| T16.3 | P1 | 同上 | — | 验证`rangeBreachExcursion=max(0, maxAbsoluteExcursion-directionThreshold)` | 公式正确，全程未突破时为0 | 自动 | 同上 |

## T17. 四类区间覆盖指标

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| T17.1 | P1 | `endpointDataComplete=true` | `actualEndPrice`落入baseline区间 | 检查`endpointInBaselineZone` | `=true` | 自动 | GMKG总架构§10.4a |
| T17.2 | P1 | 同上 | `actualEndPrice`落入upside区间 | 检查`endpointInAnyScenarioZone` | `=true`，`endpointInBaselineZone=false` | 自动 | 同上 |
| T17.3 | P1 | `pathDataComplete=true` | 路径最高最低价均在`expectedEnvelope`内 | 检查`realizedRangeInsideExpectedEnvelope` | `=true` | 自动 | 同上 |
| T17.4 | P1 | `pathDataComplete=false` | — | 检查四个字段 | 全部`=null`，不得填`false` | 自动 | GMKG总架构§10.4a红线 |

## T18. `scenarioWeights` 合计100 / NaN-Infinity 拒绝

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| T18.1 | P0 | — | 任意`proxyState`+`stateConfidence`组合（覆盖全部9种状态×3档置信度） | 计算`scenarioWeights` | 三项之和**恒等于100**（整数） | 自动 | V1_4_FORECAST_DATA_SPEC.md§7.4 |
| T18.2 | P0 | 构造浮点误差场景 | 原始打分和为99.9999997 | 归一化+舍入 | 输出整数且和为100，余差记入最大项 | 自动 | 同上 |
| T18.3 | P0 | — | 构造导致`NaN`/`Infinity`/负值的异常输入 | 计算 | 函数拒绝该输入或clamp到合法范围，不得输出非法`scenarioWeights` | 自动 | GMKG总架构§10.1不变量 |

## T19. `calibratedProbability`/`calibratedProbabilities` 恒为 null

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| T19.1 | P0 | 全部V1.4代码路径 | 任意输入 | 全文关键词扫描是否存在给`calibratedProbabilities`/`calibratedProbability`赋非null值的代码 | 不存在 | 人工代码审查 | GMKG总架构§8.2/§8.5 |
| T19.2 | P0 | — | 生成的`ForecastSnapshot` | 检查`calibratedProbabilities`字段 | 三个情景key均为`null` | 自动 | 同上 |
| T19.3 | P0 | — | 生成的`brierScoreComponent`（若实现） | 检查 | `=null` | 自动 | V1_4_HISTORICAL_VALIDATION_SPEC.md§6 |

## T20. `ForecastSnapshot` 不可变 / `OutcomeEvent`追加 / 幂等回填 / 去重

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| T20.1 | P0 | 已生成一条`ForecastSnapshot` | 尝试回填结果 | 调用回填函数 | 不修改`ForecastSnapshot`任何字段，只新增`ForecastOutcomeEvent`记录 | 自动 | GMKG总架构§10.1/§14.1 |
| T20.2 | P0 | 同`predictionId`已存在快照 | 相同K线/instrument/horizon/algorithmVersion的重复生成请求 | 调用`buildForecastSnapshot` | 拒绝新建，返回已有记录 | 自动 | V1_4_FORECAST_DATA_SPEC.md§8.2 |
| T20.3 | P0 | 同`predictionId`+`evaluationVersion`已有`ForecastOutcomeEvent` | 重复调用回填函数 | — | 返回既有记录，不新建、不修改 | 自动 | GMKG总架构§10.6 |
| T20.4 | P1 | `evaluationVersion`升级 | 重新调用回填 | — | 追加新`outcomeEventId`，旧记录保留不覆盖 | 自动 | 同上 |

## T21. Schema迁移 / localStorage 损坏 / 存储超限

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| T21.1 | P1 | 构造旧`schemaVersion`数据 | — | 调用`load*`函数 | 自动迁移补齐字段，写回新版本 | 自动 | V1_4_CODEX_IMPLEMENTATION_TASK.md§4.1 |
| T21.2 | P0 | 构造损坏JSON（非法语法/关键字段类型错误） | — | 调用`load*`函数 | 默认拒绝，返回空集合，不抛未捕获异常 | 自动 | 同上 |
| T21.3 | P1 | 存储条数超过上限 | 新增记录 | 触发容量控制 | 优先淘汰已完成回填、时间最早的记录，未回填记录不被淘汰 | 自动 | V1_4_FORECAST_DATA_SPEC.md§8.3 |

## T22. JSON/CSV 导出安全

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| T22.1 | P1 | — | 正常数据 | 导出JSON | 内容完整、可反序列化还原 | 自动 | V1_4_CODEX_IMPLEMENTATION_TASK.md§8 |
| T22.2 | P0 | 构造以`=`/`+`/`-`/`@`开头的字段值（理论上不应出现，但防御性测试） | — | 导出CSV | 字段值被正确转义（前置单引号），不产生公式注入 | 自动 | 同上 |

## T23. `ActionPermission` 显示专属 / 不创建 WATCHLIST/EXECUTABLE / 不调用撮合函数

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| T23.1 | P0 | — | 任意24H/72H预测 | 检查`ActionPermission.mode` | 恒为`'DISPLAY_ONLY'` | 自动 | V1_4_FORECAST_DATA_SPEC.md§12.1 |
| T23.2 | P0 | — | 同上 | 检查`readinessLevel`/`readinessCeiling` | `readinessCeiling`恒为`'ALLOW_TEST'`，`readinessLevel`不超过此上限 | 自动 | 同上 |
| T23.3 | P0 | — | 同上 | 检查`gateStatus` | 恒为`'WAIT'` | 自动 | 同上 |
| T23.4 | P0 | — | 全部V1.4代码 | 全文扫描是否引用`recordSignalIfEligible`/`evaluateShadowSignals`/`tickAutoEngine`/`buildTradeProposal` | 不存在任何直接调用 | 人工代码审查 | V1_4_FORECAST_DATA_SPEC.md§12.2 |
| T23.5 | P0 | — | 运行完整V1.4生成链路 | 检查是否有信号档案（`OBSERVATION`/`WATCHLIST`/`EXECUTABLE`）被创建 | 不存在任何V1.4触发的信号档案创建 | 自动+人工 | 同上 |
| T23.6 | P0 | — | 检查`readinessLevel`计算函数签名 | 审查函数是否接受账户对象参数 | 不接受账户对象作为输入，从签名层面杜绝账户状态影响 | 人工代码审查 | 同上 |

## T24. V1.3.1 回归 / 页面关闭限制

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| T24.1 | P0 | V1.4代码已接入构建 | 运行既有V1.1/V1.2/V1.3/V1.3.1全部既有测试套件 | `npm run test:v1.4:regression` | 零回归，全部既有测试通过 | 自动 | V1_4_CODEX_IMPLEMENTATION_TASK.md§10 |
| T24.2 | P1 | — | 检查构建产物 | 关闭浏览器页面后重新打开 | V1.4新增展示区域正常渲染，不影响既有V1.1-V1.3.1区域 | 人工 | GMKG总架构§16.2 |
| T24.3 | P1 | — | 检查文档措辞 | 人工审查 | 明确声明"页面关闭后V1.4不具备24小时连续采集/推演能力，与既有单文件HTML限制一致" | 人工 | 同上 |

## T25. API 失败降级 / 真实 REST / 合成K线

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| T25.1 | P0 | 模拟Binance API请求失败 | 网络错误/超时 | 调用生成链路 | `operatingMode='INSUFFICIENT_DATA'`，不使用陈旧数据冒充当前值 | 自动（mock） | V1_4_FORECAST_DATA_SPEC.md§3.1 |
| T25.2 | P0 | 需要网络 | 真实API调用 | 端到端跑通一次完整24H预测生成 | 成功产出`ForecastSnapshot`，字段齐全 | 自动（联网） | V1_4_CODEX_IMPLEMENTATION_TASK.md§9.2 |
| T25.3 | P1 | — | 合成（人工构造）K线数组 | 覆盖T11全部九项异常场景 | 见T11各项预期结果 | 自动 | GMKG总架构§10.5.1 |

## T26. 旧功能不回归汇总（红线，逐版本确认）

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| T26.1 | P0 | — | V1.1既有测试套件 | 运行 | 全部通过，`v1-core.js`未被修改 | 自动 | ACCEPTANCE_TESTS.md（V1.1） |
| T26.2 | P0 | — | V1.2既有测试套件 | 运行 | 全部通过，`v1_2-forecast-core.js`未被修改 | 自动 | V1_2_ACCEPTANCE_TESTS.md |
| T26.3 | P0 | — | V1.3既有测试套件 | 运行 | 全部通过，`v1_3-*.js`未被修改 | 自动 | V1_3_ACCEPTANCE_TESTS.md |
| T26.4 | P0 | — | V1.3.1既有测试套件 | 运行 | 全部通过，`v1_3-trade-gate-diagnostics.js`未被修改 | 自动 | V1_3_1_IMPLEMENTATION_REPORT.md |

## T27. 误差归因规则不可变性（对应 `V1_4_ARCHITECTURE_REVIEW.md` P1-3）

| ID | 严重等级 | 前置条件 | 输入 | 步骤 | 预期结果 | 自动/人工 | 规范条款 |
|---|---|---|---|---|---|---|---|
| T27.1 | P1 | — | `attributeError`函数源码 | 静态审查函数实现 | 判定逻辑（§5.1对照表）以常量/固定映射表形式存在，不存在依据运行时输入动态改写判定规则本身的代码路径（区别于"依据输入选择已冻结规则的分支"这一正常行为） | 人工代码审查 | V1_4_HISTORICAL_VALIDATION_SPEC.md§5.3 |
| T27.2 | P1 | — | `attributionRuleVersion`字段 | 检查生成的`ErrorAttribution`记录 | 恒为`'v1.4-attribution-rule-1'`（当前唯一版本），历史记录中不出现同版本号对应不同判定结果的情况 | 自动 | 同上 |
| T27.3 | P1 | — | `notEvaluableCauses`字段 | 检查V1.4阶段生成的全部`ErrorAttribution`记录 | 均包含`V1_4_HISTORICAL_VALIDATION_SPEC.md`§5.1标注"否，标注NOT_EVALUABLE"的全部枚举值（`environment_misread`/`formal_transition_misread`/`fusion_weight_error`/`action_permission_error`/`execution_or_risk_param_error`，`data_revision`视当前是否触发而定） | 自动 | 同上 |

---

## 测试类别数量汇总

| 类别 | 用例数 |
|---|---|
| T1 未来数据泄漏与availableAt边界 | 3 |
| T2 Vintage修订与已收盘K线判定 | 2 |
| T3 Binance时间边界（真实REST） | 4 |
| T4 PRICE_ONLY_MODE与primaryState=UNKNOWN | 3 |
| T5 proxyState不冒充正式状态 | 3 |
| T6 代理与正式统计隔离 | 3 |
| T7 INSUFFICIENT_DATA不生成迁移记录 | 1 |
| T8 TransitionBundle判别联合 | 3 |
| T9 24H目标路径（96根bar）与referenceBar排除 | 3 |
| T10 72H目标路径（288根bar） | 2 |
| T11 bar缺失/重复/错序/未收盘/synthetic-estimated | 8 |
| T12 endpointDataComplete与pathDataComplete独立判定 | 3 |
| T13 两类统计分母 | 3 |
| T14 Nullable字段 | 4 |
| T15 UP/DOWN/RANGE边界判定 | 4 |
| T16 RANGE专属指标 | 3 |
| T17 四类区间覆盖指标 | 4 |
| T18 scenarioWeights合计100/NaN-Infinity拒绝 | 3 |
| T19 calibratedProbability恒为null | 3 |
| T20 ForecastSnapshot不可变/追加/幂等/去重 | 4 |
| T21 Schema迁移/损坏/超限 | 3 |
| T22 JSON/CSV导出安全 | 2 |
| T23 ActionPermission显示专属 | 6 |
| T24 V1.3.1回归/页面关闭限制 | 3 |
| T25 API失败降级/真实REST/合成K线 | 3 |
| T26 旧功能不回归汇总 | 4 |
| T27 误差归因规则不可变性 | 3 |
| **合计（27个功能类别）** | **90** |

（初稿26个功能类别83条；对应`V1_4_ARCHITECTURE_REVIEW.md`独立复审发现的P0-1/P1-3两项测试缺口，追加T3.4与T27共4条，最终27个功能类别、90条为唯一权威总数。）

---

## 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.4-tests-draft-1 | 2026-07-18 | 初稿：26个功能类别，共83条可执行/可判定测试用例，覆盖未来数据泄漏、PRICE_ONLY_MODE边界、路径完整性九不变量、nullable类型、两类统计分母、情景权重不变量、校准概率隔离、快照不可变性、ActionPermission显示专属隔离、V1.1-V1.3.1回归；同轮追加T3.4（referenceBar服务器时间校验）与T27（误差归因规则不可变性，3条），响应`V1_4_ARCHITECTURE_REVIEW.md`发现的P0-1/P1-3缺口，累计27个功能类别、90条为唯一权威总数 |
