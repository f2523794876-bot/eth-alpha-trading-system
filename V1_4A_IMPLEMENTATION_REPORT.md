# ETH Alpha V1.4A 实施报告

实施分支：`codex/v1.4a-server-data-foundation`  
正式基线：`main@93d9feddab7d0fba01a87d7ea7e14355bf5868d3`（Release v1.4.0）  
范围：服务器数据采集、原始存储、标准化、健康与恢复基础；不实现预测替换、回测、账户连接或真实交易。

## 1. 交付概览

新增独立 `server/` Node.js ESM 服务，目标运行时 Node.js 22、数据库 PostgreSQL。现有 V1.1–V1.4 核心、构建模板和单文件 HTML 业务逻辑均未修改。服务进程不依赖浏览器生命周期，浏览器关闭后由 systemd 托管的服务仍可继续采集；本提交仅提供部署模板，没有修改任何服务器系统服务。

模块包括：

- 任务调度与单实例租约；
- Binance 公开源适配器与宏观源占位协议；
- 只读 HTTP 客户端、令牌桶、重试、指数退避、抖动和熔断；
- 服务器时间守卫；
- 原始响应、已收盘K线和衍生品事实标准化；
- 缺口识别、幂等回补任务与启动恢复基础；
- 数据健康状态与只读管理 API；
- PostgreSQL 版本化迁移、内存测试适配层、systemd 与 Ubuntu 运维文档。

选择 ESM 而非 TypeScript，是为了不引入额外编译链并保持 Ubuntu 22.04 + Node.js 22 直接运行。运行时唯一依赖为 PostgreSQL 驱动 `pg`；测试使用 Node 内置 test runner。

## 2. 数据源核验与实际接入

实现前同时核对了 Binance 官方文档与 2026-07-19 的真实公开响应。实际接入：

| 数据 | Source ID | 精确接口 | 真实响应状态 |
|---|---|---|---|
| Binance服务器时间 | `binance-spot-rest` | `GET https://api.binance.com/api/v3/time` | HTTP 200，`serverTime`为毫秒整数 |
| ETH/BTC现货K线 | 同上 | `GET /api/v3/klines`，`interval=15m/1h/4h` | 六路 HTTP 200 |
| ETH/BTC USDⓈ-M永续K线 | `binance-usdt-futures-rest` | `GET https://fapi.binance.com/fapi/v1/klines` | HTTP 200 |
| 资金费率 | 同上 | `GET /fapi/v1/fundingRate` | HTTP 200；含负资金费率真实样本 |
| Open Interest | 同上 | `GET /fapi/v1/openInterest` | HTTP 200 |
| 全市场账户多空比 | 同上 | `GET /futures/data/globalLongShortAccountRatio` | HTTP 200 |
| 主动买卖量 | 同上 | `GET /futures/data/takerlongshortRatio` | HTTP 200 |

官方依据：[Spot server time](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/general#check-server-time)、[Spot klines](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/market#klinecandlestick-data)、[USDⓈ-M market data](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data)。所有端点均为 `NONE`/公开市场数据路径，没有 API key、签名、账户权限或订单接口。

未接入：宏观数据。当前六份规范没有冻结一个无需密钥、官方且稳定的宏观源；因此只交付 `MacroSourceAdapter` 协议、源注册表和调度占位，状态明确为 `UNAVAILABLE / NO_FROZEN_OFFICIAL_KEYLESS_SOURCE`，没有接入非官方聚合站。

## 3. 时间、收盘与防未来泄漏

每个正式采集周期必须重新请求 `/api/v3/time`，记录：

- `sourceServerTime`
- `localRequestStartedAt`
- `localResponseReceivedAt`
- `estimatedNetworkMidpoint`
- `clockOffsetMs`
- `roundTripMs`

时间不可用或偏差超过可配置的保守默认值 5000ms 时，整体健康进入 `BLOCKED`，不写正式事实。规范冻结了“每周期重新获取、失败即阻断”，但没有冻结具体偏差数字，因此 V1.4A 将其配置化为 `MAX_CLOCK_OFFSET_MS`；没有修改既有 V1.4 算法。

只有 `closeTime <= sourceServerTime` 的K线进入 `market_bars`。未收盘K线不生成 `vintageId`、`availableAt` 或 `DataVintageRef`，只留在 raw/provisional 路径。`availableAt <= forecastCreatedAt` 可由 `available_at` 索引和 `assertNoFutureLeak` 独立验证。

## 4. 数据库与不可变语义

迁移 `001_v1_4a_foundation`创建：

`schema_migrations`、`source_registry`、`source_endpoint_registry`、`collection_runs`、`collection_attempts`、`raw_payloads`、`provisional_market_bars`、`market_bars`、`funding_rates`、`open_interest`、`long_short_ratios`、`taker_flow`、`data_revision_events`、`data_gaps`、`backfill_jobs`、`data_health_snapshots`、`source_audit_events`、`collector_leases`、`dead_letter_records`。

关键约束：

- 原始响应只 `INSERT`，按 `requestId + contentHash` 幂等，不存在覆盖路径；
- 标准化事实按来源、市场、交易对、周期、观察时间和修订号建立自然键；
- `vintageId`唯一；修订通过新 revision 和 `data_revision_events`追加；
- `firstAvailableAt`不会被后续重复抓取覆盖；
- `publishedAt <= availableAt <= firstAvailableAt <= fetchedAt`；
- 价格、数量、资金费率和成交量使用 PostgreSQL `NUMERIC`，Node标准化层保持交易所原始十进制字符串；
- `market_bars`对 OHLC关系、非负成交量、时间窗和正式收盘建立数据库约束；
- 96/288根路径查询使用 `(instrument, market_type, interval_name, open_time)`索引；
- migration checksum变化会拒绝启动迁移，禁止静默篡改已应用DDL。

Down脚本明确标为破坏性，只允许空的临时数据库；生产历史不得用回滚脚本清理。

## 5. 调度、限流、恢复与健康

- 现货六路每30秒一次；每轮先独立校验服务器时间。
- 永续三周期、资金费率、OI、多空比和主动买卖量每60秒拉取，事实按vintage去重。
- 默认令牌桶容量120、每秒补充2；端点使用官方权重的保守成本。
- 最多3次重试；基础250ms、上限10s、全抖动区间；429优先使用 `Retry-After`。
- 连续5次临时失败开启熔断，默认30秒后半开探测；永久4xx不重试。
- 任务使用 `Promise.allSettled`隔离，单个交易对或端点失败不会拖垮其他任务。
- 租约包含 holder、过期时间和 fencing token；第二实例不能同时成为leader。
- 缺口以自然范围形成稳定ID；回补任务稳定ID保证重复启动不重复创建；回补后重新检测并只在完整时标记解决。
- SIGTERM/SIGINT停止新调度，等待在途Promise完成，再关闭HTTP和数据库连接。

数据健康状态：`HEALTHY`、`WARNING`、`DEGRADED`、`BLOCKED`、`RECOVERING`。依据服务器时间、时钟偏差、最新成功时间、数据年龄、缺口、异常、连续失败、HTTP状态、限流、熔断和待回补量计算，不以“进程仍在运行”冒充健康。

## 6. 只读 API

实现以下端点：

`GET /health/live`、`GET /health/ready`、`GET /api/v1/collector/status`、`GET /api/v1/data-health`、`GET /api/v1/gaps`、`GET /api/v1/sources`、`GET /api/v1/bars`、`GET /api/v1/derivatives/funding`、`GET /api/v1/derivatives/open-interest`。

交易对、周期和市场类型使用白名单；单次最多1000行、最大366天；统一JSON错误不会返回堆栈、环境变量或数据库细节。服务默认只监听 `127.0.0.1`。

## 7. 安全与范围确认

- 没有账户、钱包、API key或Secret配置；
- 没有POST交易API、下单函数或真实交易入口；
- `recordSignalIfEligible`、`evaluateShadowSignals`、`buildTradeProposal`、`tickAutoEngine`、`processTradeGate`在 `server/` 中直接调用均为0；
- 未修改任何 V1.1–V1.4业务核心、交易许可、评分、模拟撮合或单文件页面代码；
- 未实现预测因子替换、概率校准、walk-forward训练、新闻、付费数据源或 V1.4B/C/D；
- 未部署、未创建PR、未合并main。

## 8. 已知限制与后续CEO决策

1. 当前执行环境没有可用的本地 PostgreSQL 服务/`psql`，因此DDL由一致测试适配层与静态约束测试验证，真实 PostgreSQL migration/up/down集成验收需在部署前的隔离数据库执行；这是一项明确环境阻塞，不伪报通过。
2. Binance公开多空比和主动买卖量只保留官方可查询窗口；长期历史从服务首次运行开始积累。
3. 需CEO确定正式服务器的原始JSON冷归档介质、保留年限、磁盘预算及灾备RPO/RTO。
4. 需CEO决定是否在 V1.4B 之前批准一个官方、无需密钥的宏观源；未批准前保持 `UNAVAILABLE`。
5. systemd、数据库用户和反向代理尚未安装；本阶段按要求只交付可部署代码。
