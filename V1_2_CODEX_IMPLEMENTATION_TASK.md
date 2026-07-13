# V1_2_CODEX_IMPLEMENTATION_TASK.md — 给 Codex 的 V1.2「走势预测层」实现工单

版本：v1.2-draft-3（随 `V1_2_FORECAST_SPEC.md` v1.2-draft-3 同步修订）
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

### 步骤2：实现12项因子函数（spec §4.1，输入参数已按spec §0订正为 `ethSnap`/`btcSnap`，不是draft-1中不存在的 `ethTf`/`btcTf`）
- 每个因子实现为独立小函数 `factorTrend4h(ethSnap, horizon)`、`factorStructure1h(ethSnap, horizon, decision)` 等，签名统一返回 `ForecastFactorResult`（不含 `weightMax`，由步骤3按horizon注入）。`ethSnap`/`btcSnap` 是调用方（`buildHorizonForecast`）已经对 `marketData.eth`/`marketData.btc` 六路原始K线调用 `C.analyzeKlines()` 后得到的 `{tf15m,tf1h,tf4h}` 派生对象（spec §0/§11.2），因子函数内部**不得**自己再调用 `analyzeKlines`，只读取传入的快照，避免12个因子各自重复分析同一份K线。
- 因子2/3（`structure1h`/`structure15m`）在状态机结果为 `TRANSITION_WATCH` 时，必须调用 spec §4.1.1 定义的 `transitionWatchSplit(snap)` 辅助函数（`snap` 为该因子对应周期的快照），返回值直接作为 `{bull,bear,range}`；**不得**自造 `range=0.6+方向0.2` 这类总和不为1的旧算法。
- 因子4（`emaSlopeOwn`）需要调用已导出的 `C.emaSeries(closes, 5)`，`closes` 从对应周期**已收盘**K线数组中取，不使用未收盘K线参与斜率计算。
- 因子5（`swingStructure`）missing判定必须是"`swingHighs.length<2` **或** `swingLows.length<2`"（逻辑或，不是draft-1错误的逻辑与），且 `status='ok'` 时必须覆盖 spec §4.4 列出的5类情形（两种单侧混合、单边缺失走missing、完整多头、完整空头），单测按5类各建一个fixture。
- 因子7（`srDistance`）内部先调用 `C.buildSRZones(snapshot)` 取 `resistanceZones[0]`/`supportZones[0]`，再用 spec §6.0 定义的 `isValidZone(zone, side, confirmedPrice)` 做双边校验（任一侧无效或ATR无效即 `status='missing'`），校验通过后才调用 `C.calcPositionMetrics(confirmedPrice, s0, r0, atr14)`。`isValidZone` 作为模块内部小函数实现，签名与 spec §6.0 一致，同时供步骤4的价格区间/情景目标复用（不得写两份重复实现）。
- 因子8（`volumeQuality`）签名为 `factorVolumeQuality(rawKlinesForTf, atr14, stateBias)`，`rawKlinesForTf` 取自 `marketData.eth[对应tf]`（该horizon自身周期的原始K线，不是15m），内部调用 `C.calcVolumeQuality(rawKlinesForTf, atr14, stateBias)`。方向判定严格按 spec 问题5的唯一阈值实现：`ratio>=1.2&&sustained===true&&takerBuyRatio>=0.55`→多头，`<=0.45`→空头，`0.45~0.55`或 `ratio<1.2`或 `!sustained`→`range=1`；`label==='unavailable'` 或 `takerBuyRatio===null`→`status='missing'`（不做保守方向猜测）。
- 因子9（`btcAlignmentOwnTf`）签名为 `factorBtcAlignmentOwnTf(bias, btcSnapshotForHorizon, failedKeys, horizon)`，中文术语固定为“BTC对应周期联动”；`failedKeys` 即 `marketData.failed`（真实格式 `'btc.tf15m'`等，见spec §10.4），函数内部按 `horizon` 映射到对应的 `'btc.'+tfKey`，命中则返回 `status='missing', hardMissing:true`，供 `buildHorizonForecast` 识别并触发 spec §5.2 条件3的整horizon降级。
- 因子10（`falseBreakoutRisk`）签名为 `factorFalseBreakoutRisk(ethSnapshotForHorizon, btcSnapshotForHorizon)`，内部直接调用 `C.falseBreakoutTier(ethSnapshotForHorizon, btcSnapshotForHorizon)` 得到该horizon**自己的**tier（不接受外部传入的 `tier` 字符串，防止调用方把15m的 `decision.falseBreakoutTier` 传给1h/4h这类误用——signature本身锁死这条红线）。
- 因子12（`timeframeAgreementProxy`）必须以因子1/2/3的**计算结果对象**为输入参数，不接受K线/快照作为输入（强制签名 `factorTimeframeAgreementProxy(f1, f2, f3)`）；中文术语固定为“三周期规则一致性代理”，明确不是统计准确率。
- 自测：逐个因子写单元测试，用构造的 `AnalyzedSnapshot` fixture 覆盖"明确方向""震荡""missing"三种情况；因子2/3/5/7/8/9/10 额外覆盖本条目列出的专属边界（TRANSITION_WATCH三分支、swing五类、SR双边、成交量五档、BTC真实key、假突破逐周期）。

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
  agreementFactor   = timeframeAgreementProxy因子的 (bull或bear或range中最大分量) // 0..1，仅表示规则内部一致性代理
  score = round(100 × (dataCompleteness×0.4 + dominanceMargin×0.4 + agreementFactor×0.2))
  score 裁剪到 [0,100]
  label: score>=70→'高'；40<=score<70→'中'；<40→'低'
  ```
- `explanation` 字段用模板字符串拼出三个分量的具体数值，并固定说明“三周期规则一致性代理指标不是统计胜率或预测准确率”。

### 步骤6：实现安全降级（spec §10 全部6条）与顶层 `buildForecast()` 编排
- 严格按 spec §14 的"状态/标签优先级总表"实现判定顺序，不得调换。
- `buildForecast()` 是唯一对外入口，内部按 15m→1h→4h 顺序分别跑一遍步骤2-5的流水线，任何一步的门槛判定失败都在该horizon层面截断，不影响其他horizon。

### 步骤7：实现预测日志接口（spec §12，已按问题10重写schema）
- 三个版本号常量，模块顶部定义并导出：`SCHEMA_VERSION='v1.2-log-2'`、`FORECAST_ALGORITHM_VERSION='v1.2-draft-3'`、`FACTOR_WEIGHT_VERSION='v1.2-weights-1'`。后续任何修改 §4.1/§4.2/§5-§9 算法或权重表的提交，必须同步递增对应常量（spec §12.2版本号红线）。
- `buildForecastLogEntry(forecast, horizonForecast, horizon, options?)` + `saveForecastLog(entry, storage)` 使用独立key `ethAlphaForecastLogs`。正常预测写valid日志；数据不足、陈旧、关键周期缺失、预测失败和过期写blocked审计，并强制清空方向、权重、区间、目标、路径和置信度。blocked审计必须含 `status`/`blocked`/`blockReasons`/`dataHealth`/`dataAsOf`/`horizon`/`algorithmVersion`/`weightVersion`，`calibratedProbability`恒为null。
- `factorResults` 字段必须完整写入该horizon全部12项 `ForecastFactorResult`（含 `status='missing'` 的因子，逐项 `id/status/bull/bear/range/weightMax/points/evidenceText`），不得只写摘要——这是本轮相对draft-1 `tripleTimeframeFeatures` 摘要式记录的核心修订，保证V2能独立复现当时的方向权重计算过程而不依赖当前代码版本。
- `outcomeAfter1Bar`/`outcomeAfter4Bars`/`outcomeAfter16Bars` 三个字段**都要**产出结构（值恒为 `null`，等V2回填），字段命名与语义严格遵守 spec §12.1 的唯一定义：**固定15分钟为1个bar**，不随该条日志自身的 `horizon` 变化（`horizon='4h'` 的日志里 `outcomeAfter1Bar` 依然是"15分钟后"而不是"4小时后"）。实现中**不得**出现 `bar单位=horizon周期` 这类换算逻辑。
- 其余 `brierScoreComponent`/`directionAccuracy`/`rangeCoverage`/`calibrationBucket`/`calibratedProbability` 字段一律写 `null`，**不实现**任何回填逻辑。
- 手动模式（`decision.isManual===true`）不写日志，与V1.1现有 `if(d.isManual)return` 规则一致；`directionLabel==='数据不足'` 的horizon**仍然写入**日志（详见spec §12.3），不得跳过。

### 步骤8：UI 接线（不改现有三块脚本）
- `work/build-v1.js` 的替换链必须通过统一的精确计数函数执行；任一目标或核心占位符缺失、重复时构建失败，并为缺失、重复和正常替换增加自动测试。
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
- 唯一允许触碰 `refresh()` 函数体的改动（spec §11.3已核对真实源码给出精确定位）：在 `cache=await C.fetchAllTimeframeKlines();` 之后、`const d=C.buildDecision(cache.eth,cache.btc,null,prev,C.COST_DEFAULT);` 之前，插入且仅插入一行：
  ```js
  window.__lastMarketData = cache;
  ```
  不允许修改这行前后的既有分支判断、不允许改变既有DOM写入顺序、不允许新增第二行。`window.__lastMarketData` 就是 `fetchAllTimeframeKlines()` 的原始返回值（spec §0 的 `marketData`），**不是**已分析好的快照——draft-1 设想的 `window.__lastEthTf`/`__lastBtcTf`/`__lastFetchMeta` 三个变量在v1.1真实代码中并不存在对应的已算好数据可以直接暴露（BTC的1h/4h快照 `buildDecision` 内部算完就丢弃，不写入返回对象，见spec §0），因此本轮改为只暴露最原始的六路K线集合，`ethSnap`/`btcSnap` 由 `buildForecast` 内部通过 `C.analyzeKlines` 自行派生（spec §11.2）。
- 第4个 `<script>` 块内（新增文件/新增DOM，不改前三块），监听既有的 `v11decision` CustomEvent，**不新增**任何自定义事件：
  ```js
  document.addEventListener('v11decision', (e) => {
    const d = e.detail;
    const f = window.ETHAlphaForecast.buildForecast(window.__lastMarketData, d, window.__prevForecast, Date.now());
    window.__prevForecast = f;
    renderForecast(f);
  });

  // 包装（不修改）既有的 window.invalidateDashboard：
  // cache.partial===true 导致 throw、或 render(d) 内部因 dataHealth!=='normal' 早退时，
  // v11decision 当次刷新根本不会触发，必须靠这个钩子统一清空预测面板（spec §10.2(b)）。
  const prevInvalidateDashboard = window.invalidateDashboard;
  window.invalidateDashboard = function(reason, known){
    if (typeof prevInvalidateDashboard === 'function') prevInvalidateDashboard(reason, known);
    clearForecast(reason);
  };

  function clearForecast(reason){
    window.__prevForecast = null;   // 不复用旧对象引用
    // 将 forecast15m/forecast1h/forecast4h 三个DOM区域重置为"预测已失效，等待下次成功刷新"文案，
    // 并把 reason 写入 forecastBlocked 区域；不得让方向/权重/区间/目标类数字继续停留在旧值。
  }
  ```
- `renderForecast(f)` 独立函数，只做 `textContent`/`innerHTML` 写入，不改变 `f` 本身，遵循 V1.1 既有的直写DOM风格；`now > horizonForecast.validUntil` 时必须整体切换为"预测已过期，等待刷新"展示（清空/遮蔽方向、权重、区间、目标，不能只加一行提示同时旧数字继续显示，见 spec §10.3）。

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
// ---- 版本常量（spec §12.2）----
const SCHEMA_VERSION = 'v1.2-log-2';
const FORECAST_ALGORITHM_VERSION = 'v1.2-draft-3';
const FACTOR_WEIGHT_VERSION = 'v1.2-weights-1';

// ---- 因子层（spec §4.1，每个因子一个函数，统一返回 ForecastFactorResult 但不含 weightMax；
//      参数是 ethSnap/btcSnap —— buildHorizonForecast 内部对 marketData 六路原始K线调用 C.analyzeKlines 后
//      得到的派生快照，不是draft-1中不存在的 ethTf/btcTf）----
function factorTrend4h(ethSnap) -> Omit<ForecastFactorResult, 'weightMax'|'points'>   // 读 ethSnap.tf4h.trend
function factorStructure1h(ethSnap, decision) -> ...   // 读 decision.mtfState；TRANSITION_WATCH时调用 transitionWatchSplit(ethSnap.tf1h)
function factorStructure15m(ethSnap, decision) -> ...  // 读 decision.state；TRANSITION_WATCH时调用 transitionWatchSplit(ethSnap.tf15m)
function transitionWatchSplit(snap: AnalyzedSnapshot) -> { bull: number, bear: number, range: number }   // spec §4.1.1 唯一算法，供上面两个因子共用
function factorEmaSlopeOwn(closedCloses: number[], atr14: number|null) -> ...
function factorSwingStructure(snapshot: AnalyzedSnapshot) -> ...   // missing条件：swingHighs.length<2 || swingLows.length<2（逻辑或）
function factorAtrState(snapshot: AnalyzedSnapshot, decisionStateBias: 'up'|'down'|'flat') -> ...
function isValidZone(zone: {lower:number,upper:number}|null, side: 'support'|'resistance', confirmedPrice: number) -> boolean   // spec §6.0，因子7与§6/§7区间生成共用同一份实现
function factorSrDistance(snapshot: AnalyzedSnapshot) -> ...   // 内部调用 C.buildSRZones(snapshot) 取 r0/s0，isValidZone 双边校验后再调 C.calcPositionMetrics
function factorVolumeQuality(rawKlinesForTf: Kline[], atr14: number|null, decisionStateBias: 'up'|'down'|'flat') -> ...   // 内部调用 C.calcVolumeQuality(rawKlinesForTf, atr14, decisionStateBias)，唯一阈值见spec问题5
function factorBtcAlignmentOwnTf(bias: 'up'|'down'|'flat', btcSnapshotForHorizon: AnalyzedSnapshot, failedKeys: string[], horizon: '15m'|'1h'|'4h') -> ...
function factorFalseBreakoutRisk(ethSnapshotForHorizon: AnalyzedSnapshot, btcSnapshotForHorizon: AnalyzedSnapshot) -> ...   // 内部调用 C.falseBreakoutTier(ethSnapshotForHorizon, btcSnapshotForHorizon)，逐horizon独立调用，不接受外部传入的tier字符串
function factorRangePosition(recentHigh20, recentLow20, confirmedPrice) -> ...
function factorTimeframeAgreementProxy(f1, f2, f3) -> ...   // 只接受另外三个因子的结果对象，不接受快照

// ---- 权重与归一化（spec §4.2、§5）----
const FACTOR_WEIGHTS: Record<'15m'|'1h'|'4h', Record<string, number>>
function computeDirectionWeights(factorResults: ForecastFactorResult[], horizon: '15m'|'1h'|'4h')
  -> { weights: DirectionWeights|null, directionLabel: string, availableWeight: number }

// ---- 区间/目标/路径/失效（spec §6-§9，均通过 snapshot 内部调用 C.buildSRZones + isValidZone 取用结构位，不接受外部预先算好的zone）----
function buildPriceRange(snapshot: AnalyzedSnapshot, weights: DirectionWeights|null) -> PriceRangeEstimate
function buildScenarioTargets(snapshot: AnalyzedSnapshot, priceRange: PriceRangeEstimate) -> ScenarioTargets
function pickMostLikelyPath(directionLabel, ethSnapshotForHorizon: AnalyzedSnapshot, btcSnapshotForHorizon: AnalyzedSnapshot, factorResults) -> PathScenario | null   // 需要btcSnapshot是为了走§8表格里"该horizon自己的falseBreakoutTier"判定
function buildInvalidationConditions(directionLabel, mostLikelyPath, snapshot, decision) -> InvalidationCondition[]

// ---- 置信度与证据（spec 概念表#9、§9）----
function computeConfidence(availableWeight, top, second, timeframeAgreementProxyFactor) -> ConfidenceScore
function pickEvidence(directionLabel, factorResults) -> { supportingEvidence: string[], opposingEvidence: string[] }

// ---- 编排（spec §11.2，marketData 是 fetchAllTimeframeKlines() 的原始返回结构，buildForecast 内部自行调用 analyzeKlines 派生 ethSnap/btcSnap）----
function buildHorizonForecast(horizon: '15m'|'1h'|'4h', ethSnap, btcSnap, decision, marketData, prevForecast, now) -> HorizonForecast | null
function buildForecast(marketData: {eth:{tf15m:Kline[],tf1h:Kline[],tf4h:Kline[]}, btc:{tf15m:Kline[],tf1h:Kline[],tf4h:Kline[]}, partial:boolean, succeeded:string[], failed:string[]}, decision: DecisionOutput, prevForecast: ForecastOutput|null, now: number) -> ForecastOutput

// ---- V2 接口（spec §12，只建结构，不实现回填）----
function buildForecastLogEntry(forecast: ForecastOutput, horizonForecast: HorizonForecast, horizon: '15m'|'1h'|'4h') -> ForecastLogEntry
function saveForecastLog(entry: ForecastLogEntry, storage: Storage) -> void

// ---- 导出（v1_2-forecast-core.js 的 module.exports / window.ETHAlphaForecast）----
module.exports = {
  SCHEMA_VERSION, FORECAST_ALGORITHM_VERSION, FACTOR_WEIGHT_VERSION,
  factorTrend4h, factorStructure1h, factorStructure15m, transitionWatchSplit, factorEmaSlopeOwn, factorSwingStructure,
  factorAtrState, isValidZone, factorSrDistance, factorVolumeQuality, factorBtcAlignmentOwnTf, factorFalseBreakoutRisk,
  factorRangePosition, factorTimeframeAgreementProxy, FACTOR_WEIGHTS, computeDirectionWeights,
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
8. `node tests/v12-live-rest-test.js` 必须用真实Binance数据走 `fetchAllTimeframeKlines → buildDecision → buildForecast → 三时窗 → 日志写入/去重` 正式生产链，并与V1.1真实REST结果分开统计。
9. 手动浏览器验证：正常模式、手动观察模式、模拟数据异常（如断网）三种场景下新面板行为均符合 `V1_2_FORECAST_SPEC.md` §10 的安全降级规则。
10. 全文搜索 `git diff` 新增内容，不包含诱导性概率、必然涨跌或盈利承诺等禁用措辞（`V1_2_ACCEPTANCE_TESTS.md` T16 覆盖此项自动化检查）。
11. 四份V1.2文档（本文档 + `V1_2_FORECAST_SPEC.md` + `V1_2_ACCEPTANCE_TESTS.md` + `V1_2_ARCHITECTURE_REVIEW.md`）与最终实现互相一致，字段名、函数名、枚举值逐一对得上。

---

## 6. 禁止事项（本工单专属，叠加 `V1_2_FORECAST_SPEC.md` §15 的全局禁止事项）

1. 禁止修改 `v1-core.js`。
2. 禁止修改现有三个 `<script>` 块的既有逻辑（第2节步骤8明确的唯一例外除外）。
3. 禁止修改 `v1.1.0` tag、`main` 分支历史、任何已发布 release。
4. 禁止在 `v1_2-forecast-core.js` 中直接发起网络请求（K线数据必须由调用方通过 `marketData` 参数传入，预测层不自己 fetch）。
5. 禁止引入任何第三方npm包/CDN脚本。
6. 禁止实现V2回测引擎、WebSocket、条件提醒推送、模拟仓位追踪（V2/V3范围）。
7. 禁止实现任何下单、撤单、读取交易所API Key/Secret的代码。
8. 禁止调整 `V1_2_FORECAST_SPEC.md` §4.2 的权重表数值（如认为需要调整，先提出修改spec的请求，不擅自改）。
9. 禁止在未完成第2节步骤10全量回归前提交/合并代码。
10. 禁止将本工单范围扩大到"顺手优化"V1.1既有功能——发现V1.1既有问题（哪怕是明显bug）只记录、不修改，另行提出。
