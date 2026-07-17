# V1_4_DATA_SOURCE_MATRIX.md — V1.4 数据源分层矩阵

版本：v1.4-matrix-draft-1
基线：`main` @ `a3d7aea`
角色：本文档是**数据源真实性/研究状态**的唯一权威记录。不购买、不开通任何付费服务，不接入任何真实交易账户，不读取任何交易所API交易密钥。分三层：**A. V1.4真实使用**、**B. V1.4只研究不接入**、**C. GMKG目标架构（240+48项，40-60候选权威来源）**。

**核实纪律（红线）**：本文档区分"本轮（2026-07-18）现场核实"与"基于既有认知、未在本轮重新核实"两种状态，**不得**把后者包装成前者。凡标注"已核实"必须附真实核实方式（`curl`/`WebFetch`实测）与日期；凡本轮未做现场核实的条目，一律如实标注"未在本轮核实"，并说明V1.4实际接入前必须重新查证。

---

## A. V1.4 真实使用（【V1.4真实实现】，本轮已现场核实）

| 数据名称 | 提供方 | 官方/第三方 | 权威性 |
|---|---|---|---|
| ETHUSDT/BTCUSDT 现货K线（15m/1h/4h） | Binance | 官方交易所 | 一手数据，最高权威 |

### A.1 详情（唯一使用的数据源）

- **官方页面/API**：`GET https://api.binance.com/api/v3/klines?symbol={SYMBOL}&interval={INTERVAL}&limit={N}`，文档 `developers.binance.com/docs/binance-spot-api-docs/rest-api/market-data-endpoints`。
- **本轮现场核实**（2026-07-18，`curl`直接调用生产端点，非文档推测）：
  - `GET .../klines?symbol=ETHUSDT&interval=15m&limit=3` 返回3根已收盘K线，实测 `closeTime = openTime + 899999`（即 `timeframeMs(900000) − 1`），下一根`openTime = 上一根closeTime + 1`；
  - `GET .../klines?symbol=BTCUSDT&interval=4h&limit=2` 返回2根已收盘K线，实测 `closeTime = openTime + 14399999`（即`timeframeMs(14400000) − 1`），边界关系与15m周期一致；
  - 结论已写入 `V1_4_FORECAST_DATA_SPEC.md` §5.3，作为`BarRef.closeTime`公式的实测依据。
- **准确性**：交易所自身撮合引擎产生的一手行情，无第三方转译误差。
- **更新频率**：K线随周期收盘更新（15分钟/1小时/4小时各一次）。
- **典型延迟**：已收盘K线立即可查，实测无感知延迟（同一`curl`调用往返 < 1秒）。
- **时间戳定义**：`openTime`/`closeTime`均为ms epoch，UTC；边界关系见上方现场核实结论。
- **历史范围**：ETHUSDT/BTCUSDT现货K线可回溯至各自上线时间（覆盖多年），远超V1.4历史校准窗口需求。
- **免费/付费**：完全免费，公开市场数据端点，无需注册。
- **API限制**：与现有V1.1/V1.2/V1.3代码共享同一IP权重桶（`X-MBX-USED-WEIGHT`），`klines`端点权重较低（约1-2，视`limit`而定）。
- **CORS**：**已验证**——V1.1至V1.3.1三轮独立复审均实测浏览器`fetch`/Node `fetch`可直连200 OK，生产HTML长期browser端直连运行（`V1_4_DATA_SOURCE_MATRIX.md`历史版本、`CLAUDE_CODE_REVIEW*.md`已反复确认，本轮`curl`验证只是复核端点行为本身，不改变CORS结论）。
- **授权/再分发限制**：Binance API条款禁止转售原始数据，允许自有产品内部分析使用；V1.4继续遵守既有条款（与V1.1-V1.3.1相同）。
- **浏览器可用性**：可直接浏览器调用（当前单文件HTML架构依赖此特性）。
- **是否需要服务器**：不需要（V1.4延续单文件/本地存储架构，见`V1_4_CODEX_IMPLEMENTATION_TASK.md`）。
- **数据修订**：无（已收盘K线一旦生成不回改；`DataVintageRef.revisionNumber`固定为0，见`V1_4_FORECAST_DATA_SPEC.md`§8.4）。
- **失效降级方式**：延续`v1-core.js`既有的`assessOverallHealth()`三级模型（`normal`/`delayed`/`invalid`），失败时整体判定`operatingMode='INSUFFICIENT_DATA'`，不使用陈旧K线冒充当前值。
- **`sourceRef`所有者**：`'binance-spot-klines'`（唯一权威采集所有者标识，见`V1_4_FORECAST_DATA_SPEC.md`§8.4）。
- **对15m/24H/72H的预期价值**：15m/1h/4h既有价值不变（V1.1/V1.2既有实现）；24H/72H预测的`referenceBar`/`targetBar`定位、`referencePrice`基准、A组特征输入，均**完全依赖**此数据源，是V1.4唯一的正式数据输入。
- **V1.4是否实施**：**是**，唯一实施的数据源。
- **核实状态**：**已核实**（本轮`curl`现场验证）。
- **核实日期**：2026-07-18。

---

## B. V1.4 只研究、不接入（【仍需研究】，本轮部分现场核实可达性，不代表V1.4接入）

**红线重申**：本节列出的每一项，V1.4阶段**均不接入、不采集、不在任何预测因子中使用**。逐项记录的目的是为未来版本立项提供依据，**不构成V1.4的实施承诺**。

| # | 数据名称 | 数据域 | 提供方 | 官方/第三方 | 免费/付费 | 需要服务器 | V1.4是否实施 | 核实状态 |
|---|---|---|---|---|---|---|---|---|
| B1 | 永续合约资金费率 | 衍生品 | Binance Futures | 官方 | 免费 | 是 | 否 | 部分核实（见B.1） |
| B2 | 未平仓量OI | 衍生品 | Binance Futures | 官方 | 免费 | 是 | 否 | 未在本轮核实 |
| B3 | 强平数据 | 衍生品 | Binance Futures WS | 官方 | 免费 | 是 | 否 | 未在本轮核实 |
| B4 | 多空账户/持仓比 | 衍生品 | Binance Futures | 官方 | 免费 | 是 | 否 | 未在本轮核实 |
| B5 | 订单簿/大额成交/CVD原料 | 现货订单流 | Binance Spot REST/WS | 官方 | 免费 | 是 | 否 | 未在本轮核实（CORS/端点行为需重测，不能沿用klines端点的CORS结论直接推广） |
| B6 | 多交易所价格/资金流 | 现货订单流 | OKX/Coinbase官方API | 官方 | 免费 | 是 | 否 | 未在本轮核实 |
| B7 | 交易所净流入/流出、鲸鱼转账、链上活跃度、Gas | 链上 | Etherscan | 官方链上数据+第三方索引 | 免费层（不稳定） | 是 | 否 | 未在本轮核实 |
| B8 | 稳定币供应 | 链上/宏观 | DeFiLlama | 第三方索引 | 免费 | 是 | 否 | 未在本轮核实 |
| B9 | ETH现货ETF每日净流量 | 资金流 | Farside Investors | 第三方聚合 | 免费（页面） | 是 | 否 | **本轮尝试核实失败**（见B.9） |
| B10 | 质押流入/退出 | 链上 | beaconcha.in | 第三方 | 免费层不稳定 | 是 | 否 | 未在本轮核实 |
| B11 | 期权状态（Put/Call、IV） | 衍生品 | Deribit | 官方交易所 | 免费 | 是 | 否 | 未在本轮核实 |
| B12 | 宏观利率/通胀/GDP等 | 宏观 | FRED/ALFRED | 官方央行统计 | 免费（需Key） | 是 | 否 | **本轮尝试核实失败**（见B.12） |
| B13 | 跨资产（纳指/VIX/黄金/原油） | 宏观 | Stooq/Yahoo非官方 | 第三方 | 免费（非正式） | 是 | 否 | 未在本轮核实 |
| B14 | BTC主导率/加密总市值 | 加密广域 | CoinGecko `/global` | 第三方（行业事实标准） | 免费 | 建议服务器统一管理 | 否 | **本轮已核实**（见B.14） |
| B15 | 新闻/事件（FOMC/CPI日历、监管、安全事件） | 事件 | 官方发布日历/人工录入 | 官方（日历）/人工（事件） | 免费 | 是 | 否 | 未在本轮核实 |

### B.1 永续合约资金费率（部分核实）

- 官方页面：`developers.binance.com/docs/derivatives/usds-margined-futures/market-data`。
- **本轮WebFetch尝试**：访问该文档落地页未能取得资金费率历史端点的具体路径/权重/历史深度参数（页面为产品总览页，未直接展示端点级细节），**未能完成端点级核实**。
- 基于既有认知（**未在本轮重新核实**，V1.4B若立项须重新查证）：端点路径`GET /fapi/v1/fundingRate`（历史）、`GET /fapi/v1/premiumIndex`（当前预测费率），免费公开市场数据，历史深度可回溯至合约上线，更新频率8小时/次。
- 是否需要服务器：是（合约API子域名`fapi.binance.com`的CORS策略未经本轮实测，不可沿用现货`api.binance.com`的CORS结论）。
- V1.4是否实施：否。

### B.9 ETH现货ETF净流量（核实失败记录）

- **本轮WebFetch尝试**：`https://farside.co.uk/eth/` 返回 **HTTP 403 Forbidden**，可能是反爬虫/机器人拦截，本轮**未能获取页面内容**。
- **如实结论**：无法在本轮确认该页面当前的数据格式、更新时点、是否仍为免费访问——历史认知（页面为HTML表格、无正式JSON API、免费访问）**不构成本轮核实**，V1.4B若立项必须用人工浏览器访问或改用其他抓取方式重新确认，且需评估反爬虫机制对自动化采集的实际影响。
- V1.4是否实施：否。

### B.12 FRED宏观数据API（核实失败记录）

- **本轮WebFetch尝试**：`https://fred.stlouisfed.org/docs/api/fred/` 返回 **HTTP 403 Forbidden**，本轮**未能获取页面内容**。
- **如实结论**：无法在本轮确认当前FRED API注册流程、速率限制具体数值——历史认知（免费注册Key、无严格速率上限但要求"合理使用"）**不构成本轮核实**。
- V1.4是否实施：否。

### B.14 CoinGecko `/global`（本轮已核实）

- **本轮WebFetch实测**（2026-07-18）：直接请求 `https://api.coingecko.com/api/v3/global`，**确认无需API Key即可响应**，返回真实数据：活跃加密货币17,630种、活跃市场1,504个、全球总市值约2.28万亿美元、BTC主导率约56.4%、ETH占比约9.8%、24小时总成交量约655亿美元，另含50余种法币/贵金属计价换算。
- 结论：该端点**基础访问确认可行**，可作为未来"加密总市值"/"BTC主导率"两项精度眼G组/广度眼指标的候选数据源；速率限制具体数值本轮未核实（历史认知为"免费层有限制，注册Demo Key更稳定"），V1.4B若立项须另行确认当前速率限制条款。
- V1.4是否实施：否（GMKG目标架构C层候选，非V1.4本轮范围）。

---

## C. GMKG 目标架构（【目标架构】，240+48项指标 / 40-60候选权威来源）

**红线**：本节汇总 `GMKG_DRAGONFLY_ARCHITECTURE.md` §5/§6 已定义的目标覆盖范围，**不新增、不修改**该文档已冻结的指标域划分与数量（广度眼12域约240项、精度眼A-G组48项），本节只做"候选来源"层面的记录，供未来版本立项参考。

### C.1 广度眼12域约240项（引用 GMKG总架构 §5.1，不重复定义域划分本身）

| 域 | 指标数 | 候选权威来源（示例，未核实，非V1.4范围） |
|---|---|---|
| 全球增长状态 | 22 | 各国统计局官方发布、OECD、Trading Economics |
| 通胀状态 | 20 | FRED/ALFRED、欧央行统计、BLS |
| 就业和收入状态 | 18 | BLS、FRED |
| 全球央行与政策状态 | 20 | 美联储/欧央行/日央行官网 |
| 全球流动性和利率 | 28 | FRED、纽约联储 |
| 美元与全球货币 | 18 | FRED（`DTWEXBGS`）、Stooq |
| 全球股票和风险偏好 | 22 | CBOE官方、Stooq、Yahoo非官方 |
| 信用和杠杆状态 | 16 | FRED信用利差序列 |
| 商品、能源和运输 | 22 | CBOE、Stooq |
| 仓位和资金流 | 18 | CFTC COT报告官方、Farside |
| 地缘政治与政策 | 18 | 官方新闻稿、人工录入 |
| 加密广域状态 | 18 | CoinGecko、DeFiLlama |
| **合计** | **240** | — |

### C.2 精度眼BTC/ETH各48项（引用 GMKG总架构 §6.1）

| 组 | 指标数 | 候选权威来源（示例，未核实） |
|---|---|---|
| A 价格与成交结构 | 6 | Binance现货（**V1.4已实施**，见§A） |
| B 订单簿与主动资金 | 8 | Binance Spot REST/WS、多交易所 |
| C 衍生品杠杆 | 10 | Binance Futures、OKX、Bybit |
| D 期权状态 | 6 | Deribit |
| E 资金进入与退出 | 6 | Etherscan、Farside、SoSoValue |
| F 链上供需 | 8 | Etherscan、DeFiLlama |
| G 相对强弱与跨资产 | 4 | 由A-F组派生，非独立采集 |
| **合计** | **48** | — |

### C.3 候选权威来源汇总（40-60个数量级估计，未逐一核实条款，非V1.4范围）

Binance（现货+合约）、OKX、Coinbase、Bybit、Deribit、Etherscan、DeFiLlama、CoinGecko、Farside Investors、SoSoValue、FRED/ALFRED、CBOE、Stooq、Yahoo Finance（非官方）、SEC EDGAR、各国央行官网、CFTC、beaconcha.in、Ethereum Foundation官方博客——共计约18个已列名+各国统计局/多国央行（每国可能单独计1个来源）合计可扩展到40-60个数量级，具体清单需在未来版本立项时逐一核实官方条款、免费额度、CORS策略、历史深度，**本文档不对这40-60个候选来源逐一现场核实**，只承认其作为GMKG目标架构候选清单存在。

---

## 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.4-matrix-draft-1 | 2026-07-18 | 初稿：分层记录V1.4真实使用（Binance现货K线，本轮`curl`+`WebFetch`现场核实）、V1.4只研究不接入（15项，部分现场核实可达性/失败记录）、GMKG目标架构候选来源汇总（引用GMKG总架构§5/§6，不重新定义域划分） |
