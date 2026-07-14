# ETH Alpha V1.2 测试结果

执行日期：2026-07-13（Asia/Shanghai）

## 数量口径

| 类别 | 通过 | 失败 | 环境阻塞 |
|---|---:|---:|---:|
| V1.2预测核心、因子、权重、区间、目标、路径、日志 | 250 | 0 | 0 |
| V1.2单文件UI、真实页面事件与日志接线 | 49 | 0 | 0 |
| **V1.2新增非联网自动化合计** | **299** | **0** | **0** |
| V1.1非联网回归 | 93 | 0 | 0 |
| V1.1 Binance真实REST冒烟 | 8 | 0 | 0 |
| V1.2 Binance真实REST正式生产链 | 24 | 0 | 0 |
| 人工Chrome双击验收 | 0 | 0 | 1 |

V1.1历史自动化口径为93项非联网回归加8项真实REST，共101项通过、0失败。真实REST和人工Chrome在本报告中同时单独列出，不将人工验收计入自动化数量。

## V1.2关键结果

- 三个时窗均能从六路原始K线经V1.1纯函数派生已收盘快照，并生成12项因子、三类规则权重、区间、三类情景目标、路径、失效条件、证据与置信度。
- 15m/1h/4h三档权重分别求和为100；全部因子输出比例、点数和最终权重均为有限值。
- 明确多头、明确空头、震荡、冲突、BTC反向、假突破、成交量不足、ATR扩张、数据陈旧、关键周期缺失和手动观察模式均有自动化覆盖。
- 未收盘实时tick变化不会改变正式方向、权重、区间或路径。
- 数据失败会清空全部预测数字并将上一预测引用置空；恢复后重新构建。
- 过期预测整卡遮蔽，不保留旧权重、区间或目标。
- 页面真实 `v11decision` 事件成功生成三个预测卡并写入3条预测日志；相同事件重复触发后仍为3条。
- 日志唯一键、版本变化、新K线、horizon隔离、1500条容量、损坏JSON和QuotaExceededError均通过测试。
- 数据不足、数据健康失效、关键周期缺失和过期预测均写blocked审计日志，且不携带旧方向、权重、区间、目标、路径或置信度；手动观察模式不写正式预测日志。
- 固定权重checksum与版本显式绑定；任意点数、版本或checksum单独变化均失败，合法更新必须同步三者。
- “BTC对应周期联动”“三周期规则一致性代理”在规范、代码、测试和UI证据中术语一致；置信度明确不是统计胜率或预测准确率。
- 构建脚本对每个替换目标执行精确次数校验，目标缺失或重复时测试确认构建失败。
- V2预留字段全部为 `null`，1/4/16 bar固定以15分钟为单位。
- 新增源码和UI未包含自动下单、网络请求、外部CDN、WebSocket、密钥访问或未经校准的确定性表述。

## 真实REST结果

V1.1真实REST：Binance `ETHUSDT`/`BTCUSDT` × `15m`/`1h`/`4h` 六路各返回120根K线；V1.1决策健康状态为 `normal`，结果 `8 passed, 0 failed`。

V1.2真实REST正式生产链：真实数据依次经过 `fetchAllTimeframeKlines → buildDecision → buildForecast → 三个时窗 → 预测日志写入/去重`。15m、1h、4h均生成有效预测，权重各自严格合计100，区间与目标有限且有序，三条日志写入且重复刷新不膨胀；数据不足写blocked审计且不携带旧预测，手动模式不写日志。结果 `24 passed, 0 failed`。

## 人工Chrome验收

状态：环境阻塞。

已按要求尝试连接真实Chrome控制环境，但当前执行环境返回Chrome扩展浏览器不可用，无法进行可信的 `file://` 双击人工验收。因此以下人工项目未宣称通过：正常页面视觉渲染、真实断网/恢复交互、过期视觉遮蔽和Chrome localStorage现场检查。

自动化真实DOM事件测试已经覆盖相同业务路径，但不替代人工Chrome验收。

## 可复现命令

使用Codex bundled Node：

```sh
node work/build-v1.js
node tests/v1-tests.js
node tests/v11-tests.js
node tests/audit-fixes-tests.js
node tests/v11-ui-tests.js
node tests/third-review-tests.js
node tests/v12-forecast-tests.js
node tests/v12-ui-tests.js
node tests/live-rest-test.js
node tests/v12-live-rest-test.js
```
