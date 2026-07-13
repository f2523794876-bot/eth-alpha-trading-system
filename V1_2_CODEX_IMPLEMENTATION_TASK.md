# V1_2_CODEX_IMPLEMENTATION_TASK.md — 给 Codex 的 V1.2「走势预测层」实现工单

版本：v1.2-draft-1
依据：`V1_2_FORECAST_SPEC.md`（算法真相来源，本文档只定义"怎么落地成代码"，不重复定义算法，任何算法细节冲突以该文档为准）+ 现有 `v1-core.js`（V1.1冻结核心，不可修改）。
角色分工：本文档作者（Claude Code）负责本轮 V1.2 的架构设计与验收规范，**不编写正式业务代码**；Codex 负责实际编码；PROJECT_AUDIT.md / STRATEGY_SPEC.md / ACCEPTANCE_TESTS.md / V1_IMPLEMENTATION_REPORT.md / TEST_RESULTS.md 是 V1.1 的既有交付物，本轮不改动。

**前提声明（Codex 开工前必读）**：
- `main` 分支 `v1.1.0`（commit `d9289ef`）是已发布稳定版本，**不得修改、不得覆盖、不得回退**。
- 本轮工作只在 `claude/v1.2-forecast-spec` 或后续由该分支派生的实现分支上进行。
- `v1-core.js` 是冻结文件，**逐字节不可修改**（包括注释、空行、导出顺序）。V1.2 所有新代码只能以"新文件 + 新增DOM + 新增监听器"的方式叠加。
- `eth-dynamic-trading-dashboard.html` 现有三个 `<script>` 块（核心模块 / V1核心render / V1.1增强层）**不可修改其现有内容**，只允许在文件末尾追加新的 DOM 区块和第4个 `<script>` 块。
- 现有101项V1.1自动化测试（`tests/v1-tests.js` 38 + `tests/v11-tests.js` 17 + `tests/audit-fixes-tests.js` 15 + `tests/v11-ui-tests.js` 12 + `tests/third-review-tests.js` 11 + `tests/live-rest-test.js` 8）跑完后必须仍是 `passed=101 failed=0`（`live-rest-test.js` 的8项网络冒烟测试单独统计，不计入101，与 `TEST_RESULTS.md` 现有口径一致）。

---

## 1. 交付范围边界

### 1.1 本轮（V1.2）必须完成
对照 `V1_2_FORECAST_SPEC.md` 全文：
1. 新文件 `v1_2-forecast-core.js`：纯函数模块，实现 §3-§12 定义的全部数据结构与算法（12项因子、权重归一化、价格区间、情景目标、最可能路径、失效条件、置信度、证据、安全降级、预测日志写入接口）。
2. `eth-dynamic-trading-dashboard.html` 新增：
   - 第4个 `<script>` 块：加载 `v1_2-forecast-core.js`（内联，与前三块风格一致，不用外部 `<script src=...>`，沿用现有"零外部依赖"约定），监听 `v11decision` 或直接在 `refresh()` 内追加调用，渲染"走势预测与情景推演"区域。
   - 新增 DOM 区块（§2 细化其结构），不插入到现有卡片内部。
3. 新测试文件（至少）：`tests/v12-forecast-tests.js`、`tests/v12-ui-tests.js`，覆盖 `V1_2_ACCEPTANCE_TESTS.md` 全部用例。
4. `TEST_RESULTS.md` 风格的新文档 `V1_2_TEST_RESULTS.md`（如后续实现轮次产出，本轮不要求现在写，仅在此列出以确保命名一致性预留）。

### 1.2 本轮明确不做（V2/V3 范围，禁止顺手实现）
- 不实现历史回放引擎、不实现 Brier Score / 方向准确率 / 区间覆盖率 / 校准曲线的计算逻辑（只建日志字段结构，见 spec §12）。
- 不接 WebSocket，不改变现有 REST 轮询节奏。
- 不实现模拟仓位追踪、条件提醒推送。
- 不实现任何自动下单、任何交易所下单/撤单 API 调用。
- 不新增任何需要 API Key/私钥的功能。

---

## 2. 实施顺序（Codex 必须按此顺序推进，每步做完自测再进入下一步）

### 步骤1：搭建 `v1_2-forecast-core.js` 骨架与模块边界测试
- UMD 封装（照抄 `v1-core.js` 头部模式），`module.exports` + `window.ETHAlphaForecast`。
- 先写一个空的 `buildForecast()` 返回全 `null` 的 `ForecastOutput`，跑通 `require('../v1-core.js')` 引用链路。
- 自测：新建 `tests/v12-forecast-tests.js`，第一个测试就断言 `require('../v1_2-forecast-core.js').toString()` 不包含对 `v1-core.js` 内部私有函数名的裸调用（防止意外复制实现）。

### 步骤2：实现12项因子函数（spec §4.1）
- 每个因子实现为独立小函数 `factorTrend4h(ethTf, decision)`、`factorStructure1h(...)` 等，签名统一返回 `ForecastFactorResult`（不含 `weightMax`，由步骤3按horizon注入）。
- 因子4（`emaSlopeOwn`）需要调用已导出的 `C.emaSeries(closes, 5)`，`closes` 从对应周期**已收盘**K线数组中取，不使用未收盘K线参与斜率计算。
- 因子12（`mtfConflict`）必须以因子1/2/3的**计算结果对象**为输入参数，不接受K线/快照作为输入（强制签名 `factorMtfConflict(f1, f2, f3)`），从函数签名层面锁死"不得重复读取原始数据"的红线。
- 自测：逐个因子写单元测试，用构造的 `AnalyzedSnapshot` fixture 覆盖"明确方向""震荡""missing"三种情况。

### 步骤3：实现权重表与归一化（spec §4.2、§5）
- 权重表用一个纯数据常量 `FACTOR_WEIGHTS = { '15m': {trend4h:6, ...}, '1h': {...}, '4h': {...} }`，直接照抄 spec §4.2 表格数值，**不得调整**（如认为数值需要调整，必须先回到 spec 提出再决定，不允许 Codex 自行改权重）。
- 实现 `computeDirectionWeights(factorResults, horizon)`，严格按 spec §5.2-§5.3 的门槛判断与舍入保护逻辑实现。
- 自测：对 `FACTOR_WEIGHTS` 三档各写一个求和断言（`Object.values(...).reduce(sum)===100`），对归一化函数用边界输入（全部因子missing、恰好40点缺失、恰好60点可用）逐一断言。

### 步骤4：实现价格区间 / 情景目标 / 路径 / 失效条件（spec §6-§9）
- 严格按 spec 给出的公式实现，不引入 spec 未定义的额外收紧/放宽规则。
- 路径判定必须实现为"优先级数组从上到下第一个命中即返回"的显式结构（如一个 `PATH_RULES` 数组配合 `Array.prototype.find`），不要写成难以测试的多层嵌套 `if`。
- 自测：为 spec §8 表格中的7个路径ID各构造至少一个能命中的 fixture。

### 步骤5：实现置信度、证据生成（spec 概念表#9、§9）
- 置信度公式（spec 未给出精确公式，此处补全，Codex 严格照此实现，不得自创）：
  ```
  dataCompleteness = 可用权重总和 / 100        // 0..1
  dominanceMargin   = (top - second) / 100      // 0..1，top/second见spec §5.4
  agreementFactor   = mtfConflict因子的 (bull或bear或range中最大分量)   // 0..1，越接近1表示三周期越一致
  score = round(100 × (dataCompleteness×0.4 + dominanceMargin×0.4 + agreementFactor×0.2))
  score 裁剪到 [0,100]
  label: score>=70→'高'；40<=score<70→'中'；<40→'低'
  ```
- `explanation` 字段用模板字符串拼出三个分量的具体数值，便于人工审计（例如："数据完整度88%，方向领先优势22分，三周期一致性76%"）。

### 步骤6：实现安全降级（spec §10 全部6条）与顶层 `buildForecast()` 编排
- 严格按 spec §14 的"状态/标签优先级总表"实现判定顺序，不得调换。
- `buildForecast()` 是唯一对外入口，内部按 15m→1h→4h 顺序分别跑一遍步骤2-5的流水线，任何一步的门槛判定失败都在该horizon层面截断，不影响其他horizon。

### 步骤7：实现预测日志接口（spec §12）
- `buildForecastLogEntry(forecast, horizon)` + `saveForecastLog(entry, storage)`（`storage` 参数注入，签名对照 `v1-core.js` 现有 `saveDecisionLog(entry, storage)` 的既有模式），`localStorage` key 用 `ethAlphaForecastLogs`（对照V1.1实际使用的 `ethAlphaDecisionLogs`/`ethAlphaDecisionLogsV11`，**必须是不同的key**，避免存储互相覆盖或共用容量上限时互相挤占）。
- `outcomeAfter*`/`brierScoreComponent`/`directionAccuracy`/`rangeCoverage`/`calibrationBucket`/`calibratedProbability` 字段一律写 `null`，**不实现**任何回填逻辑。
- 手动模式（`decision.isManual===true`）不写日志，与V1.1现有 `if(d.isManual)return` 规则一致。

### 步骤8：UI 接线（不改现有三块脚本）
- 在 `eth-dynamic-trading-dashboard.html` 现有 `</section>`（V1.1网格结束标签，具体定位以文件当前实际结构为准，Codex 实现时自行定位不猜测行号）之后，新增：
  ```html
  <section class="grid" id="forecastSection">
    <article class="card span12">
      <h2>走势预测与情景推演</h2>
      <div class="pill warn" id="forecastDisclaimer">规则型权重，尚未经过历史胜率校准</div>
      <div id="forecastBlocked" class="warn" style="display:none"></div>
      <div id="forecastBetting" class="warn" style="display:none"></div>
      <div class="grid">
        <article class="card span4"><h2>未来15分钟</h2><div id="forecast15m"></div></article>
        <article class="card span4"><h2>未来1小时</h2><div id="forecast1h"></div></article>
        <article class="card span4"><h2>未来4小时</h2><div id="forecast4h"></div></article>
      </div>
    </article>
  </section>
  ```
  （具体 class 命名沿用现有 `.card`/`.span4`/`.span12`/`.pill`/`.warn` 约定，实际DOM细节允许Codex按现有CSS调整，但**语义ID命名**必须保持 `forecast15m`/`forecast1h`/`forecast4h`/`forecastDisclaimer`/`forecastBlocked`/`forecastBetting`，供 `V1_2_ACCEPTANCE_TESTS.md` 的UI测试按ID断言。）
- 第4个 `<script>` 块内，在现有 `refresh()` 调用链**之后**（不修改 `refresh()` 函数体本身，改为在其成功回调路径末尾追加一行调用，或监听其已有的 `v11decision` CustomEvent）：
  ```js
  document.addEventListener('v11decision', (e) => {
    const d = e.detail;
    const f = window.ETHAlphaForecast.buildForecast(window.__lastEthTf, window.__lastBtcTf, d, window.__lastFetchMeta, window.__prevForecast);
    window.__prevForecast = f;
    renderForecast(f);
  });
  ```
  （`window.__lastEthTf`/`__lastBtcTf`/`__lastFetchMeta` 需要在现有 `refresh()` 内补一行赋值以暴露给这个新监听器；这是本工单**唯一允许**触碰 `refresh()` 函数体的地方，且只能是"新增一行赋值"，不能修改其既有逻辑分支、不能改变其既有的DOM写入/异常处理行为。若技术上有更干净、完全不用碰 `refresh()` 的方案（例如让 `buildDecision` 调用点所在的闭包直接多传一个回调），Codex 可自行选择，但目标不变：现有 `refresh()` 对外可观察行为必须逐字节保持不变，第三方无法通过跑101项测试或读函数字符串察觉任何差异。）
- `renderForecast(f)` 独立函数，只做 `textContent`/`innerHTML` 写入，不改变 `f` 本身，遵循 V1.1 既有的直写DOM风格。

### 步骤9：中文枚举映射
- 新增 `zhPathScenario`、`zhInvalidation`、`zhDirectionExplain` 等映射对象，风格与现有 `names`/`zhTrend`/`zhAlign` 一致，声明在第4个脚本块顶部。
- 自测：仿照 `tests/v11-ui-tests.js` 的"可见静态文本无新增英文枚举"检查，为新脚本块单独写等价断言（见 `V1_2_ACCEPTANCE_TESTS.md` T17）。

### 步骤10：全量回归
- 依次运行 `node tests/v1-tests.js`、`node tests/v11-tests.js`、`node tests/audit-fixes-tests.js`、`node tests/v11-ui-tests.js`、`node tests/third-review-tests.js`，确认仍是各自原有的通过数、`0 failed`。
- 运行新增的 `node tests/v12-forecast-tests.js`、`node tests/v12-ui-tests.js`，确认 `V1_2_ACCEPTANCE_TESTS.md` 全部用例通过。
- 手动浏览器验证：打开 `eth-dynamic-trading-dashboard.html`，确认V1.1原有全部面板行为不变，新预测面板正常渲染，手动观察模式下新面板显示"数据不足/不生成预测"而不是报错或空白无说明。

---

## 3. 函数接口清单（Codex 必须实现的最小函数集合，签名固定；内部实现细节自行组织，但行为必须匹配 `V1_2_FORECAST_SPEC.md`）

```js
// ---- 因子层（spec §4.1，每个因子一个函数，统一返回 ForecastFactorResult 但不含 weightMax）----
function factorTrend4h(ethTf, decision) -> Omit<ForecastFactorResult, 'weightMax'|'points'>
function factorStructure1h(ethTf, decision) -> ...
function factorStructure15m(ethTf, decision) -> ...
function factorEmaSlopeOwn(closedCloses: number[], atr14: number|null) -> ...
function factorSwingStructure(snapshot: AnalyzedSnapshot) -> ...
function factorAtrState(snapshot: AnalyzedSnapshot, decisionStateBias: 'up'|'down'|'flat') -> ...
function factorSrDistance(positionMetrics) -> ...
function factorVolumeQuality(volumeQuality, decisionStateBias) -> ...
function factorBtcAlignment3tf(bias: 'up'|'down'|'flat', btcSnapshot: AnalyzedSnapshot) -> ... // status='missing'时须能表达"硬性missing"（见spec§10.4），建议返回值带 hardMissing:true 标记
function factorFalseBreakoutRisk(tier: string, hasBreakout: boolean, hasBreakdown: boolean) -> ...
function factorRangePosition(recentHigh20, recentLow20, confirmedPrice) -> ...
function factorMtfConflict(f1, f2, f3) -> ...   // 只接受另外三个因子的结果对象，不接受快照

// ---- 权重与归一化（spec §4.2、§5）----
const FACTOR_WEIGHTS: Record<'15m'|'1h'|'4h', Record<string, number>>
function computeDirectionWeights(factorResults: ForecastFactorResult[], horizon: '15m'|'1h'|'4h')
  -> { weights: DirectionWeights|null, directionLabel: string, availableWeight: number }

// ---- 区间/目标/路径/失效（spec §6-§9）----
function buildPriceRange(snapshot, weights, decisionZones) -> PriceRangeEstimate
function buildScenarioTargets(snapshot, priceRange, decisionZones) -> ScenarioTargets
function pickMostLikelyPath(directionLabel, snapshot, factorResults) -> PathScenario | null
function buildInvalidationConditions(directionLabel, mostLikelyPath, snapshot, decision) -> InvalidationCondition[]

// ---- 置信度与证据（spec 概念表#9、§9）----
function computeConfidence(availableWeight, top, second, mtfConflictFactor) -> ConfidenceScore
function pickEvidence(directionLabel, factorResults) -> { supportingEvidence: string[], opposingEvidence: string[] }

// ---- 编排（spec §11.2）----
function buildHorizonForecast(horizon, ethTf, btcTf, decision, fetchMeta) -> HorizonForecast | null
function buildForecast(ethTf, btcTf, decision, fetchMeta, prevForecast) -> ForecastOutput

// ---- V2 接口（spec §12，只建结构，不实现回填）----
function buildForecastLogEntry(forecast: ForecastOutput, horizon: '15m'|'1h'|'4h') -> ForecastLogEntry
function saveForecastLog(entry: ForecastLogEntry, storage: Storage) -> void

// ---- 导出（v1_2-forecast-core.js 的 module.exports / window.ETHAlphaForecast）----
module.exports = {
  factorTrend4h, factorStructure1h, factorStructure15m, factorEmaSlopeOwn, factorSwingStructure,
  factorAtrState, factorSrDistance, factorVolumeQuality, factorBtcAlignment3tf, factorFalseBreakoutRisk,
  factorRangePosition, factorMtfConflict, FACTOR_WEIGHTS, computeDirectionWeights,
  buildPriceRange, buildScenarioTargets, pickMostLikelyPath, buildInvalidationConditions,
  computeConfidence, pickEvidence, buildHorizonForecast, buildForecast,
  buildForecastLogEntry, saveForecastLog,
};
```

每个因子函数必须是**纯函数**（无DOM访问，无 `Date.now()` 之外的隐藏状态依赖——若需要"当前时间"用于陈旧判断，作为参数传入而不是内部直接调用），与 `v1-core.js` 现有全部函数的"纯函数"约定一致，这是为 V2 复用铺路的硬性要求（呼应 `CODEX_IMPLEMENTATION_TASK.md` §1.2 对 V1.1 提出的同一要求）。

---

## 4. UI 改动清单

见第2节步骤8的DOM结构与步骤9的中文映射要求。额外约束：
- 新面板的CSS **复用**现有 `.card`/`.span4`/`.span12`/`.pill`/`.warn`/`.good`/`.bad`/`.muted`/`.row`/`.zone` 类，**不新增**大量自定义样式类（除非现有类确实无法表达"区间/情景目标/路径"这类新概念，此时新增的类名前缀必须为 `.forecast-`，避免与V1.1既有类名冲突）。
- 不使用任何外部图表库/CDN脚本（沿用现有"零外部依赖"红线，`tests/v11-ui-tests.js` 已有断言，V1.2 新UI测试须有等价断言）。
- 新面板在 `decision.isManual===true` 或 `dataHealth!=='normal'` 时必须显示明确的"数据不足/不生成预测"文案，不得留空白区域（留白会被用户误读为"加载中"或"无异常"）。

---

## 5. Definition of Done（本轮 Codex 实现完成的判定标准）

1. `v1_2-forecast-core.js` 存在，导出第3节列出的全部函数，且都是纯函数（无 `document`/`window` 直接访问）。
2. `v1-core.js` 文件哈希与本轮开工前完全一致（`git diff v1-core.js` 为空）。
3. `eth-dynamic-trading-dashboard.html` 中原有三个 `<script>` 块内容除本工单第2节步骤8明确允许的"一行赋值"外，`git diff` 为空。
4. 新增 `tests/v12-forecast-tests.js`、`tests/v12-ui-tests.js` 均可通过 `node tests/v12-*.js` 独立运行，输出 `RESULT passed=N failed=0`。
5. `V1_2_ACCEPTANCE_TESTS.md` 列出的全部验收用例逐条通过。
6. 原有5个测试文件（`v1-tests.js`/`v11-tests.js`/`audit-fixes-tests.js`/`v11-ui-tests.js`/`third-review-tests.js`）通过数与 `TEST_RESULTS.md` 记录的101项完全一致，无新增失败。
7. `node tests/live-rest-test.js` 仍能正常连接 Binance 并输出 `RESULT passed=8 failed=0`（网络环境允许的前提下）。
8. 手动浏览器验证：正常模式、手动观察模式、模拟数据异常（如断网）三种场景下新面板行为均符合 `V1_2_FORECAST_SPEC.md` §10 的安全降级规则。
9. 全文搜索 `git diff` 新增内容，不包含"真实概率""胜率XX%""必涨""必跌""稳赚""保证盈利"等禁用措辞（`V1_2_ACCEPTANCE_TESTS.md` T16 覆盖此项自动化检查）。
10. 四份V1.2文档（本文档 + `V1_2_FORECAST_SPEC.md` + `V1_2_ACCEPTANCE_TESTS.md` + `V1_2_ARCHITECTURE_REVIEW.md`）与最终实现互相一致，字段名、函数名、枚举值逐一对得上。

---

## 6. 禁止事项（本工单专属，叠加 `V1_2_FORECAST_SPEC.md` §15 的全局禁止事项）

1. 禁止修改 `v1-core.js`。
2. 禁止修改现有三个 `<script>` 块的既有逻辑（第2节步骤8明确的唯一例外除外）。
3. 禁止修改 `v1.1.0` tag、`main` 分支历史、任何已发布 release。
4. 禁止在 `v1_2-forecast-core.js` 中直接发起网络请求（K线数据必须由调用方通过 `ethTf`/`btcTf` 参数传入，预测层不自己 fetch）。
5. 禁止引入任何第三方npm包/CDN脚本。
6. 禁止实现V2回测引擎、WebSocket、条件提醒推送、模拟仓位追踪（V2/V3范围）。
7. 禁止实现任何下单、撤单、读取交易所API Key/Secret的代码。
8. 禁止调整 `V1_2_FORECAST_SPEC.md` §4.2 的权重表数值（如认为需要调整，先提出修改spec的请求，不擅自改）。
9. 禁止在未完成第2节步骤10全量回归前提交/合并代码。
10. 禁止将本工单范围扩大到"顺手优化"V1.1既有功能——发现V1.1既有问题（哪怕是明显bug）只记录、不修改，另行提出。
