# ETH Alpha V1.4 GMKG 最小可验证闭环实施报告

实施分支：`codex/v1.4-gmkg-minimum-validation-loop`  
基线：`main` / `cc6975d4d1c74ef3b8d95c3eab68ef64d78cb7f2`  
实现模式：`PRICE_ONLY_MODE`，仅使用 Binance 现货 ETH/BTC × 15m/1h/4h 已收盘 K 线。

## 交付内容

- `v1_4-gmkg-forecast-core.js`：9 个 PO_* 价格代理状态、服务器时间已确认输入约束、24H/72H 快照、规则型情景权重、4H ATR 平方根时间缩放阈值、六窗口 SHA-256 审计引用。
- `v1_4-gmkg-outcome-core.js`：96/288 根目标路径定位、九项完整性不变量、不可变结果事件、方向/路径统计分母隔离、UP/DOWN/RANGE 指标。
- `v1_4-gmkg-validation-core.js`：按时间切分、标准区间调度有效样本数、冻结的误差归因与中性极端波动标记。
- `work/v1-gmkg-min-loop.template.html`：网络 I/O、原子持久化、幂等回填、完整 JSON/CSV 导出和中文展示层。
- `work/build-v1.js` / `work/v1-ui.template.html`：只新增 V1.4 精确占位符接线；既有替换链不变。
- `eth-dynamic-trading-dashboard.html`：由构建脚本生成的单文件正式页面。
- `tests/v1_4-gmkg-*.test.js`：V1.4 行为、结构追踪和真实 REST 测试。

## 生产闭环

1. 既有六路 REST 刷新完成后，V1.4 单独请求 `GET /api/v3/time`；失败时返回 `DATA_BLOCKED`，不猜测收盘状态。
2. 使用 Binance 服务器时间重新筛选六路已收盘 K 线，并生成六个 `KlineWindowRef`；任何未收盘、乱序、重复或无效输入直接拒绝。
3. 只对 ETH 生成独立 24H（96 根）和 72H（288 根）不可变 `ForecastSnapshot`。`primaryState` 与 `fusionState` 恒为 `UNKNOWN`，行动权限恒为 `DISPLAY_ONLY / WAIT`。
4. 同一 `predictionId` 不重复保存。快照与代理迁移记录采用内存预组装和失败回滚，防止孤儿记录。
5. 目标时间到达后，从 reference bar 起按时间顺序重新获取真实 15m K 线，逐根验证路径并追加 `ForecastOutcomeEvent` 与 `ErrorAttribution`；不覆盖原始快照。
6. `directionEligibleForStatistics` 与 `pathEligibleForStatistics` 独立计算；路径不完整时所有路径指标严格为 `null`。

## 规则与安全边界

- `scenarioWeights` 为规则型权重，整数且严格合计 100；`calibratedProbability` / `calibratedProbabilities` 恒为 `null`。
- 24H 阈值为 `ATR4h / referencePrice × sqrt(6)` 后限制在 0.8%–5%；72H 使用 `sqrt(18)` 后限制在 1.5%–8%。
- 存储键全部使用 `ethAlphaGmkg*` 命名空间，不复用或改写 V1.1–V1.3.1 日志。
- 容量异常保留全部既有证据，进入 `STORAGE_BLOCKED`，停止生成新快照并提示先导出 JSON；没有自动淘汰路径。
- V1.4 未调用 `recordSignalIfEligible`、`evaluateShadowSignals`、`buildTradeProposal`、`tickAutoEngine` 或 `processTradeGate`，不会创建 `WATCHLIST` / `EXECUTABLE`，不会影响交易许可或模拟账户。
- 未接入真实账户、API Key、真实订单、WebSocket、新闻、链上、衍生品、自动校准或服务器常驻功能。

## 兼容性

除下述 CEO 授权的 P0 修订外，既有核心文件均与基线逐字节一致：

- `v1-core.js` 旧 SHA-256：`0a4d9e712859d79ecae592aacffe371abfba29a2c6b7b76119a68c49e0471a97`
- `v1-core.js` 新 SHA-256：`252aacdf2dd7ac11e181738bc24728aee0b00d94ebb6b410692449cc628da9e0`
- 原冻结哈希因经真实 BTC 15m 数据证明的 P0 因果 ATR 错误而经 CEO 授权更新。修改仅限 `detectAnomalyBars()`：每根已收盘 K 线只使用其之前的已收盘 K 线计算 ATR14；5×ATR 阈值和异常数量大于5根的健康门均未改变。
- `v1_2-forecast-core.js`：`5cd29546ceae417c816bf7056c9fe4ddfc434548be90d1f2679fdb11f1dc250e`
- `v1_3-paper-trading-core.js`：`76fef6291d6c1583dacd312eb5c6a7161cc83d9e30ba7c0815c75ef2591ba0c3`
- `v1_3-signal-archive-core.js`：`a022cc7eeb2583419291a759281775d6e1228e8886388b01768ba5b1979864b5`
- `v1_3-auto-engine-core.js`：`6621aa6854264641f20214c920148766015cd330e252192ebc9e182dd5169133`
- `v1_3-trade-gate-diagnostics.js`：`7340e22b791c08410513a5b1e1d361caee758ba823f88669ae211c285dea2f85`

## 已知限制

- 本地 `localStorage` 是短期验证原型；长期证据存储仍需未来 IndexedDB 或服务器架构，本版不通过删除历史规避容量限制。
- 页面关闭或电脑休眠期间不会持续运行；回填在页面重新打开并成功取得服务器时间与行情后执行。
- Chrome 普通/无痕/禁用扩展的 `file://` Console 调用栈仍需在具备 Chrome 控制能力的人工环境完成；静态构建已证明页面不含 frame、外部脚本、外部样式或 `file://` 资源引用，GMKG Blob 导出仅在按钮点击后执行。本轮未在缺少调用栈时猜测修改导出代码。
- 真实 BTCUSDT 15m 保存样本在旧算法下误判27根，改用因果 ATR 后为0根；全部六路公开行情健康门正常，原四个 V1.2/V1.3 实时失败已关闭。

详细测试口径见 `V1_4_TEST_RESULTS.md`。
