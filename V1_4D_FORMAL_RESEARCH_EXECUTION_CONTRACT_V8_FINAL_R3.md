# V1.4D 正式研究执行契约 v8（最终统一正文 R3）

状态：`READY_TO_IMPLEMENT`（D7自包含协议与全部契约机器验证已通过；正式研究尚未获授权）
契约状态的前置状态：`BLOCKED_PENDING_CONTRACT_FIX`
适用范围：V1.4D 正式研究的工程执行、D8 决策、D7 artifact 发布与 T1–T19 编排。
规范用语：“必须/不得”为强制；“应”为除非本契约明确例外否则强制；“可”为许可。

本文件是唯一、自包含的执行契约。实施者仅依据本文件和本文列出的仓库事实实施；其他历史契约不构成补充语义。

## 1. 事实基线与盘点

- 仓库：`f2523794876-bot/eth-alpha-trading-system`
- 事实快照：`main@335d6ff622315e646de1c306ee6cd60a6b1b0bc7`；该快照用于代码与冻结资料取证。
- 实际只读工作区：`/Users/penn/Documents/Codex/2026-07-24/eth-alpha-v1-4c-f2523794876-bot/work/eth-alpha-trading-system`
- 实际检出分支：`codex/v1.4d-closure-period-correction`
- 实际 HEAD：`54946e4e19e5732c1e2384423815ccefde8d8650`
- 取证方式：未切换实际工作区；以 `git archive main` 创建只读临时快照。
- 工作区在编写前为 clean；本文件位于仓库外，仓库没有修改。

### 1.1 已完整读取的冻结资料

| 文件 | main 快照行数 | SHA-256 |
|---|---:|---|
| `V1_4D_ACCEPTANCE_TESTS.md` | 276 | `e9a356b83bdcc705133307bcc558933b42380610886d304a5e3be52a43b22ca7` |
| `V1_4D_ARCHITECTURE_REVIEW.md` | 105 | `8c96904513ad65c1e1808e2255872d0f4345ac7cac8c444cce97d1dd52c24f63` |
| `V1_4D_CODEX_IMPLEMENTATION_TASK.md` | 164 | `2f286f70e8217824f9d609820730a230fe99f8e1b3abe14d01350cf70b24051b` |
| `V1_4D_DATA_BACKFILL_SPEC.md` | 265 | `3455686510bd58716d6ba96adf324d82a04713752fa9d6e30fb2803e891adfe4` |
| `V1_4D_HISTORICAL_REPLAY_SPEC.md` | 536 | `0704155ff14fce520a354c39d4cb7ca57f34996990e272dd1336c70dc243bcbe` |

### 1.2 代码事实地图与差异

| 能力 | 真实入口/证据 | 事实结论 |
|---|---|---|
| 市场数据回填 | `server/src/backfill/backfill-cli-entry.js::main,runBackfillForInterval`；`server/src/backfill/integrity-check.js::checkIntegrity` | 已有 dry-run、resume、完整性边界与批次状态。 |
| Dataset Manifest | `server/src/validation-replay/dataset-manifest-builder.js::buildDatasetManifest`；`dataset-manifest-verifier.js::verifyDatasetManifest`；V2 verifier | 已有多 symbol V2、成员绑定、hash 和 fail-closed 验证。 |
| 历史 Feature | `server/src/features/historical-feature-backfill-cli.js::main`；`historical-feature-backfill.js::runHistoricalFeatureBackfill` | 已有 manifest 治理、dry-run、resume cursor 和输入边界校验。 |
| Replay 编排 | `server/src/validation-replay/cli-entry.js::runWalkForward,main` | 已有 24H/72H rhythm、resume、真实性闸门、evaluation/report 串联。 |
| Purge/effective | `server/src/validation-replay/purge.js::purgeStraddlingSamples,computeSplitEffectiveSamples`；`server/src/validation/walk-forward.js::computeEffectiveSampleCount` | 已有权威时间切分、跨界 purge 与重叠去重。 |
| Evaluation/report | `replay-evaluator.js::evaluateReplayOutcomes`；`report-builder.js::buildValidationReports` | 已有 outcome、报告与真实性检查。 |
| Scorecard/baselines | `research-scorecard.js::buildResearchScorecard`；`scripts/v1-4d-scorecard-cli.mjs` | 已有 alwaysRange、follow4hTrend、historicalProportionRandom、Macro-F1、MFE/MAE、成本和分组。 |
| D8 GO/NO-GO | 无严格输入/输出 Schema、统一 evaluator 或 audit artifact | 未实现；本文冻结完整工程契约。 |
| D7 发布 | 现有 `research-scorecard.js:434` 使用 `new Date().toISOString()` | 当前主 scorecard 非字节确定性；必须按本文 T14/T18 改造。 |
| Audit trail | 真实性信息分散在 validation/generation/evaluation/report 表与对象中 | 无本文要求的统一严格结构；必须实现只读聚合 adapter。 |

Migration 005 和 `historical_validation` 表是现有基础；本文不创建 migration。现有代码没有完整 D7/D8 发布器，因此本文把它们列为实施任务，不把“契约验证通过”误称为“生产实现已存在”。

## 2. 统一数据、版本与时间原则

1. 时间统一为 UTC RFC 3339，毫秒边界由冻结数据窗口决定；运行 wall-clock 不进入主 scorecard/artifact。
2. 趋势/方向枚举仅为 `UP`、`DOWN`、`RANGE`；未知值输入 Schema 拒绝。
3. 24H、72H 独立统计，严禁混样本或共用分母。
4. 方向统计使用 `directionEligibleForStatistics` 管道；路径统计使用 `pathEligibleForStatistics` 管道。二者都调用 `computeSplitEffectiveSamples`，不得复制 split/purge/dedup 算法。
5. 正式身份至少绑定 `validationRunId`、`datasetVersion`、`algorithmVersion`、`ruleVersion`、`weightVersion`、`evaluationVersion`、source commit、thresholds hash。既有 prediction identity 与真实性门禁保持不变。
6. `FORMAL` 必须满足 validation run `SUCCEEDED`、authenticity `PASSED`、manifest/feature coverage 均为 1；`DRY_RUN` 只计算，不写业务表。

## 3. D8：严格输入、算法与输出契约

### 3.1 `effectiveTest` 唯一定义

| 项 | 24H | 72H |
|---|---|---|
| JSON 路径 | `/sampleAccounting/24h/effectiveTest` | `/sampleAccounting/72h/effectiveTest` |
| 类型/null | integer，`minimum:0`；不得 null | 同左 |
| 来源 | 对该 horizon 的 TEST 段 direction-eligible rows，调用 `computeSplitEffectiveSamples` | 同左，仅限 72H rows |
| 公式 | `length(computeSplitEffectiveSamples(rows24,{eligibilityField:'directionEligibleForStatistics',trainEnd,validationEnd}).TEST.selected)` | 同左，rows72 |
| purge | 先 `splitTimeOrdered`，再 `purgeStraddlingSamples` 删除跨 TRAIN→VALIDATION/VALIDATION→TEST 边界窗口 | 同左 |
| 去重 | `computeEffectiveSampleCount` 按 `targetEndTime` 排序的区间调度贪心选择，预测窗口不得重叠 | 同左 |
| Wilson 分母 | `trials = effectiveTest`；成功数为相同 selected 集合的 `directionCorrectCount` | 同左 |
| coverage 分母 | directional 与 market-regime coverage 都使用该 horizon 的 `effectiveTest` | 同左 |

`rawTest` 是 purge 前、满足 direction eligibility 的 TEST 原始行数。`classEffectiveTest.UP + DOWN + RANGE`、三个 predicted count 之和都必须等于 `effectiveTest`，否则 `INPUT_CONSISTENCY_FAILED`。路径类 MFE/MAE 不使用该分母，而使用单独 path pipeline 的 effective count；D8 不拿路径分母替代方向分母。

### 3.1.1 唯一权威来源与镜像一致性

权威性不可由实现者选择，固定如下：

1. 顶层 `validationRunId`、`evaluationVersion`、`evaluatedAt` 是运行身份/时间的唯一权威原始输入。`evaluatedAt` 必须是规范 UTC `Z` 字符串。
2. `scorecard.horizons[h].model` 与 `.baselines` 是模型及三基线统计的唯一权威原始输入。
3. `sampleAccounting`、`rangeAttribution`、`marketRegimeAtGeneration` 是各自计数的权威原始输入；顶层 predicted/coverage 字段是对这些计数的断言镜像。
4. `baselineAvailabilityInput[h]` 是 `scorecard.horizons[h].baselines` 的审计镜像，不是第二权威来源。
5. 顶层 `preCostLift/postCostLift` 是按权威 model/baselines 公式重算值的审计镜像，不是决策输入。D8输出的lift必须使用重算值，绝不复制镜像值。
6. scorecard、auditTrail中的身份和 `evaluatedAt` 都是顶层字段的镜像。

一致性在任何baseline availability、Wilson或门禁计算前执行：字符串、枚举、null、integer及数组成员采用逐值精确相等；对象要求相同required key；浮点镜像采用绝对误差 `abs(a-b) <= 1e-12`，不使用相对误差、ULP或舍入后字符串。两个null相等；null与数值不相等；NaN/Infinity由Schema拒绝。baseline镜像的status/reason/sampleCount精确比较，三个数值字段采用上述容差。

任一身份或时间镜像不一致是全局错误，24H与72H都加入最高优先级 `INPUT_CONSISTENCY_FAILED`，两者及overall均为 `DATA_GATE_FAILED`。某一horizon的baseline/lift/count镜像不一致只污染该horizon，但overall仍因任一DATA失败而 `DATA_GATE_FAILED`。不得回退、选择“看起来可信”的副本或仅warning继续。

### 3.2 分组、null 与零分母矩阵

| 条件 | horizon 状态/reason | 是否继续 | overall |
|---|---|---|---|
| `effectiveTest=0` | `DATA_GATE_FAILED/EFFECTIVE_TEST_ZERO` | 只生成可审计的 null Wilson，不执行阈值成功判断 | 任一 horizon 如此则 `DATA_GATE_FAILED` |
| `rangeTotal=0` | `CONDITIONAL_GO/RANGE_CLASS_ABSENT` | 继续非 RANGE 指标；不得假造 RANGE 指标 | 无更高优先级时按汇总规则 |
| `directionalCoverage=null` | `DATA_GATE_FAILED/COVERAGE_NULL` | 继续计算可计算项但门禁必败 | `DATA_GATE_FAILED` |
| `marketRegimeCoverage=null` | `DATA_GATE_FAILED/COVERAGE_NULL` | 同上 | `DATA_GATE_FAILED` |
| baseline 全部可用但任一 lift null | `DATA_GATE_FAILED/LIFT_NULL` | 不比较该 lift 阈值 | `DATA_GATE_FAILED` |
| 任一 baseline 不可用 | `BASELINE_NOT_EVALUABLE/BASELINE_NOT_EVALUABLE` | 允许生成审计输出，不允许 GO | `BASELINE_NOT_EVALUABLE` |
| alwaysRange 不可用 | `BASELINE_NOT_EVALUABLE/ALWAYS_RANGE_NOT_EVALUABLE` | 同上 | `BASELINE_NOT_EVALUABLE` |
| required/sample/group 缺失 | 输入 Schema 拒绝；无 D8 输出 | 不运行 evaluator | 无决策 artifact |
| 未知 group 或错误类型 | 输入 Schema 拒绝 | 不运行 evaluator | 无决策 artifact |

分组 key 精确为 `UP/DOWN/RANGE`；每项严格含 `sampleCount:int>=0` 与所需计数，`additionalProperties:false`。所有内部对象均严格；扩展必须升级 schemaVersion。

### 3.3 baseline availability 与 lift

唯一权威baseline来自 `scorecard.horizons[h].baselines`；`baselineAvailabilityInput[h]`只做强制镜像校验。固定 baseline 顺序为 `alwaysRange`、`follow4hTrend`、`historicalProportionRandom`。每个 horizon 单独执行：

1. 按声明顺序读取全部三个 baseline；`status=AVAILABLE` 时 `sampleCount>=1` 且 Macro-F1、pre/post expected return 均为数值，reason=`NONE`。
2. alwaysRange 不可用先加入 `ALWAYS_RANGE_NOT_EVALUABLE`；任一个不可用再加入 `BASELINE_NOT_EVALUABLE`。`requireAllBaselines` 固定为 true，故不可用时绝不 GO。
3. 全部可用时，pre-cost reference 是 `preCostExpectedReturn` 最大者，post-cost reference 是 `postCostExpectedReturn` 最大者；并列按上述声明顺序取先者。
4. `preCostLift = model.preCostExpectedReturn - selectedPreBaseline.preCostExpectedReturn`；post 同理；单位均为每样本小数收益（`0.01=1%`）。两个 reference 可不同。公式重算值是唯一决策值；顶层lift仅按绝对容差校验。
5. 两个 lift 都参与门禁；任一低于对应阈值产生对应 NO_GO reason；全部 baseline 失败则 baseline 不可评估，不计算 lift。

### 3.4 Wilson 95% 置信区间

固定 `z=1.959963984540054`，`p=successes/n`，`z2=z*z`：

`center=(p+z2/(2n))/(1+z2/n)`
`margin=z*sqrt((p(1-p)+z2/(4n))/n)/(1+z2/n)`
`lower=max(0,center-margin)`，`upper=min(1,center+margin)`。

- `n=0`：lower/upper 均 null；随后 `EFFECTIVE_TEST_ZERO`。
- `p=0` 和 `p=1`：按同一公式，不特殊抬高/压低。
- 运算使用 IEEE-754 binary64；NaN/Infinity 禁止进入 Schema/artifact。
- 门禁使用未舍入的 lower；输出用十进制 12 位、round-half-even。实现必须保留 raw lower 供比较，不能拿格式化字符串比较。
- 小样本使用同一公式，不换正态近似或 Agresti–Coull。

### 3.5 reason 优先级与汇总算法

唯一优先级从高到低：`INPUT_CONSISTENCY_FAILED`、`AUDIT_RUN_NOT_SUCCEEDED`、`AUDIT_AUTHENTICITY_NOT_PASSED`、`MANIFEST_COVERAGE_INCOMPLETE`、`FEATURE_COVERAGE_INCOMPLETE`、`EFFECTIVE_TEST_ZERO`、`COVERAGE_NULL`、`LIFT_NULL`、`ALWAYS_RANGE_NOT_EVALUABLE`、`BASELINE_NOT_EVALUABLE`、`EFFECTIVE_TEST_BELOW_THRESHOLD`、`CLASS_SAMPLE_BELOW_THRESHOLD`、`RANGE_CLASS_ABSENT`、`RANGE_PREDICTION_DEGENERATE`、`WILSON_BELOW_THRESHOLD`、`PRE_COST_LIFT_BELOW_THRESHOLD`、`POST_COST_LIFT_BELOW_THRESHOLD`、`DIRECTIONAL_COVERAGE_BELOW_THRESHOLD`、`MARKET_REGIME_COVERAGE_BELOW_THRESHOLD`。无原因用 `NONE`，且 `NONE` 不进入 reasonCodes。

Horizon 状态顺序：任何数据 reason→`DATA_GATE_FAILED`；否则任何 baseline reason→`BASELINE_NOT_EVALUABLE`；否则任何 NO-GO reason→`NO_GO`；否则任何 conditional reason→`CONDITIONAL_GO`；否则 `GO`。Overall：任一 data failed→data failed；否则任一 baseline not evaluable→baseline not evaluable；两者 GO→GO；一者 GO→conditional；否则任一 NO_GO→NO_GO；其余→conditional。reasonCodes 去重后按固定优先级排序，primary 取第一项。

### 3.6 正式 Schema（Draft 2020-12）

以下 Schema 是规范性正文。所有 `$ref` 都是同文档本地 JSON Pointer。

#### D8 输入 Schema

```json
{
  "$defs": {
    "auditTrail": {
      "additionalProperties": false,
      "properties": {
        "authenticityGateStatus": {
          "enum": [
            "PASSED",
            "FAILED",
            "NOT_AVAILABLE"
          ]
        },
        "backfillBatchIds": {
          "items": {
            "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
            "type": "string"
          },
          "type": "array",
          "uniqueItems": true
        },
        "datasetVersion": {
          "pattern": "^v1\\.4d-sha256-[0-9a-f]{64}$",
          "type": "string"
        },
        "evaluatedAt": {
          "format": "date-time",
          "pattern": "Z$",
          "type": "string"
        },
        "evaluationVersion": {
          "minLength": 1,
          "type": "string"
        },
        "featureCoverage": {
          "maximum": 1,
          "minimum": 0,
          "type": "number"
        },
        "generationSummary": {
          "additionalProperties": false,
          "properties": {
            "attempted": {
              "minimum": 0,
              "type": "integer"
            },
            "blocked": {
              "minimum": 0,
              "type": "integer"
            },
            "conflicts": {
              "minimum": 0,
              "type": "integer"
            },
            "evaluated": {
              "minimum": 0,
              "type": "integer"
            },
            "expected": {
              "minimum": 0,
              "type": "integer"
            },
            "inserted": {
              "minimum": 0,
              "type": "integer"
            },
            "reusedIdentical": {
              "minimum": 0,
              "type": "integer"
            }
          },
          "required": [
            "expected",
            "attempted",
            "inserted",
            "reusedIdentical",
            "conflicts",
            "blocked",
            "evaluated"
          ],
          "type": "object"
        },
        "manifestContentHash": {
          "pattern": "^[0-9a-f]{64}$",
          "type": "string"
        },
        "manifestCoverage": {
          "maximum": 1,
          "minimum": 0,
          "type": "number"
        },
        "schemaVersion": {
          "const": "v1.4d-audit-trail/1"
        },
        "validationRunId": {
          "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
          "type": "string"
        },
        "validationRunStatus": {
          "enum": [
            "SUCCEEDED",
            "FAILED",
            "RUNNING"
          ]
        },
        "vintageIds": {
          "items": {
            "minLength": 1,
            "type": "string"
          },
          "type": "array",
          "uniqueItems": true
        }
      },
      "required": [
        "schemaVersion",
        "validationRunId",
        "evaluationVersion",
        "evaluatedAt",
        "validationRunStatus",
        "authenticityGateStatus",
        "manifestCoverage",
        "featureCoverage",
        "datasetVersion",
        "manifestContentHash",
        "backfillBatchIds",
        "vintageIds",
        "generationSummary"
      ],
      "type": "object"
    },
    "baseline": {
      "additionalProperties": false,
      "allOf": [
        {
          "if": {
            "properties": {
              "status": {
                "const": "AVAILABLE"
              }
            }
          },
          "then": {
            "properties": {
              "macroF1": {
                "maximum": 1,
                "minimum": 0,
                "type": "number"
              },
              "postCostExpectedReturn": {
                "type": "number"
              },
              "preCostExpectedReturn": {
                "type": "number"
              },
              "reasonCode": {
                "const": "NONE"
              },
              "sampleCount": {
                "minimum": 1
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "status": {
                "const": "NOT_EVALUABLE"
              }
            }
          },
          "then": {
            "properties": {
              "macroF1": {
                "type": "null"
              },
              "postCostExpectedReturn": {
                "type": "null"
              },
              "preCostExpectedReturn": {
                "type": "null"
              },
              "reasonCode": {
                "not": {
                  "const": "NONE"
                }
              }
            }
          }
        }
      ],
      "properties": {
        "macroF1": {
          "type": [
            "number",
            "null"
          ]
        },
        "postCostExpectedReturn": {
          "type": [
            "number",
            "null"
          ]
        },
        "preCostExpectedReturn": {
          "type": [
            "number",
            "null"
          ]
        },
        "reasonCode": {
          "enum": [
            "NONE",
            "NO_TRAIN_SAMPLES",
            "NO_VALID_TREND",
            "NO_EVALUATION_ROWS",
            "INPUT_MISSING"
          ]
        },
        "sampleCount": {
          "minimum": 0,
          "type": "integer"
        },
        "status": {
          "enum": [
            "AVAILABLE",
            "NOT_EVALUABLE"
          ]
        }
      },
      "required": [
        "status",
        "reasonCode",
        "sampleCount",
        "macroF1",
        "preCostExpectedReturn",
        "postCostExpectedReturn"
      ],
      "type": "object"
    },
    "baselineSet": {
      "additionalProperties": false,
      "properties": {
        "alwaysRange": {
          "$ref": "#/$defs/baseline"
        },
        "follow4hTrend": {
          "$ref": "#/$defs/baseline"
        },
        "historicalProportionRandom": {
          "$ref": "#/$defs/baseline"
        }
      },
      "required": [
        "alwaysRange",
        "follow4hTrend",
        "historicalProportionRandom"
      ],
      "type": "object"
    },
    "classCounts": {
      "additionalProperties": false,
      "properties": {
        "DOWN": {
          "minimum": 0,
          "type": "integer"
        },
        "RANGE": {
          "minimum": 0,
          "type": "integer"
        },
        "UP": {
          "minimum": 0,
          "type": "integer"
        }
      },
      "required": [
        "UP",
        "DOWN",
        "RANGE"
      ],
      "type": "object"
    },
    "groupMap": {
      "additionalProperties": false,
      "properties": {
        "DOWN": {
          "$ref": "#/$defs/groupStat"
        },
        "RANGE": {
          "$ref": "#/$defs/groupStat"
        },
        "UP": {
          "$ref": "#/$defs/groupStat"
        }
      },
      "required": [
        "UP",
        "DOWN",
        "RANGE"
      ],
      "type": "object"
    },
    "groupStat": {
      "additionalProperties": false,
      "properties": {
        "directionCorrectCount": {
          "minimum": 0,
          "type": "integer"
        },
        "sampleCount": {
          "minimum": 0,
          "type": "integer"
        }
      },
      "required": [
        "sampleCount",
        "directionCorrectCount"
      ],
      "type": "object"
    },
    "modelMetrics": {
      "additionalProperties": false,
      "properties": {
        "directionCorrectCount": {
          "minimum": 0,
          "type": "integer"
        },
        "macroF1": {
          "maximum": 1,
          "minimum": 0,
          "type": "number"
        },
        "postCostExpectedReturn": {
          "type": "number"
        },
        "preCostExpectedReturn": {
          "type": "number"
        }
      },
      "required": [
        "directionCorrectCount",
        "macroF1",
        "preCostExpectedReturn",
        "postCostExpectedReturn"
      ],
      "type": "object"
    },
    "rangeAttribution": {
      "additionalProperties": false,
      "properties": {
        "allPredictionsRange": {
          "type": "boolean"
        },
        "correctlyPredictedRangeCount": {
          "minimum": 0,
          "type": "integer"
        },
        "predictedRangeCount": {
          "minimum": 0,
          "type": "integer"
        },
        "rangeTotal": {
          "minimum": 0,
          "type": "integer"
        }
      },
      "required": [
        "rangeTotal",
        "predictedRangeCount",
        "correctlyPredictedRangeCount",
        "allPredictionsRange"
      ],
      "type": "object"
    },
    "sampleHorizon": {
      "additionalProperties": false,
      "properties": {
        "classEffectiveTest": {
          "$ref": "#/$defs/classCounts"
        },
        "effectiveTest": {
          "minimum": 0,
          "type": "integer"
        },
        "predictedDownCount": {
          "minimum": 0,
          "type": "integer"
        },
        "predictedRangeCount": {
          "minimum": 0,
          "type": "integer"
        },
        "predictedUpCount": {
          "minimum": 0,
          "type": "integer"
        },
        "rawTest": {
          "minimum": 0,
          "type": "integer"
        }
      },
      "required": [
        "rawTest",
        "effectiveTest",
        "classEffectiveTest",
        "predictedUpCount",
        "predictedDownCount",
        "predictedRangeCount"
      ],
      "type": "object"
    },
    "scoreHorizon": {
      "additionalProperties": false,
      "properties": {
        "baselines": {
          "$ref": "#/$defs/baselineSet"
        },
        "model": {
          "$ref": "#/$defs/modelMetrics"
        }
      },
      "required": [
        "model",
        "baselines"
      ],
      "type": "object"
    },
    "scorecard": {
      "additionalProperties": false,
      "properties": {
        "evaluatedAt": {
          "format": "date-time",
          "pattern": "Z$",
          "type": "string"
        },
        "evaluationVersion": {
          "minLength": 1,
          "type": "string"
        },
        "horizons": {
          "additionalProperties": false,
          "properties": {
            "24h": {
              "$ref": "#/$defs/scoreHorizon"
            },
            "72h": {
              "$ref": "#/$defs/scoreHorizon"
            }
          },
          "required": [
            "24h",
            "72h"
          ],
          "type": "object"
        },
        "schemaVersion": {
          "const": "v1.4d-research-scorecard/4-deterministic"
        },
        "validationRunId": {
          "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
          "type": "string"
        }
      },
      "required": [
        "schemaVersion",
        "validationRunId",
        "evaluationVersion",
        "evaluatedAt",
        "horizons"
      ],
      "type": "object"
    },
    "thresholds": {
      "additionalProperties": false,
      "properties": {
        "minClassEffectiveTest": {
          "additionalProperties": false,
          "properties": {
            "24h": {
              "minimum": 0,
              "type": "integer"
            },
            "72h": {
              "minimum": 0,
              "type": "integer"
            }
          },
          "required": [
            "24h",
            "72h"
          ],
          "type": "object"
        },
        "minDirectionalCoverage": {
          "additionalProperties": false,
          "properties": {
            "24h": {
              "maximum": 1,
              "minimum": 0,
              "type": "number"
            },
            "72h": {
              "maximum": 1,
              "minimum": 0,
              "type": "number"
            }
          },
          "required": [
            "24h",
            "72h"
          ],
          "type": "object"
        },
        "minEffectiveTest": {
          "additionalProperties": false,
          "properties": {
            "24h": {
              "minimum": 1,
              "type": "integer"
            },
            "72h": {
              "minimum": 1,
              "type": "integer"
            }
          },
          "required": [
            "24h",
            "72h"
          ],
          "type": "object"
        },
        "minMarketRegimeCoverage": {
          "additionalProperties": false,
          "properties": {
            "24h": {
              "maximum": 1,
              "minimum": 0,
              "type": "number"
            },
            "72h": {
              "maximum": 1,
              "minimum": 0,
              "type": "number"
            }
          },
          "required": [
            "24h",
            "72h"
          ],
          "type": "object"
        },
        "minPostCostLift": {
          "additionalProperties": false,
          "properties": {
            "24h": {
              "type": "number"
            },
            "72h": {
              "type": "number"
            }
          },
          "required": [
            "24h",
            "72h"
          ],
          "type": "object"
        },
        "minPreCostLift": {
          "additionalProperties": false,
          "properties": {
            "24h": {
              "type": "number"
            },
            "72h": {
              "type": "number"
            }
          },
          "required": [
            "24h",
            "72h"
          ],
          "type": "object"
        },
        "minWilsonLowerBound": {
          "additionalProperties": false,
          "properties": {
            "24h": {
              "maximum": 1,
              "minimum": 0,
              "type": "number"
            },
            "72h": {
              "maximum": 1,
              "minimum": 0,
              "type": "number"
            }
          },
          "required": [
            "24h",
            "72h"
          ],
          "type": "object"
        },
        "requireAllBaselines": {
          "const": true
        },
        "requireMarketRegime": {
          "const": true
        },
        "schemaVersion": {
          "const": "v1.4d-go-no-go-thresholds/1"
        }
      },
      "required": [
        "schemaVersion",
        "minEffectiveTest",
        "minClassEffectiveTest",
        "minDirectionalCoverage",
        "minMarketRegimeCoverage",
        "minWilsonLowerBound",
        "minPreCostLift",
        "minPostCostLift",
        "requireAllBaselines",
        "requireMarketRegime"
      ],
      "type": "object"
    }
  },
  "$id": "https://eth-alpha.invalid/schema/v1.4d-go-no-go-input-2.json",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "auditTrail": {
      "$ref": "#/$defs/auditTrail"
    },
    "baselineAvailabilityInput": {
      "additionalProperties": false,
      "properties": {
        "24h": {
          "$ref": "#/$defs/baselineSet"
        },
        "72h": {
          "$ref": "#/$defs/baselineSet"
        }
      },
      "required": [
        "24h",
        "72h"
      ],
      "type": "object"
    },
    "directionalCoverage": {
      "additionalProperties": false,
      "properties": {
        "24h": {
          "maximum": 1,
          "minimum": 0,
          "type": [
            "number",
            "null"
          ]
        },
        "72h": {
          "maximum": 1,
          "minimum": 0,
          "type": [
            "number",
            "null"
          ]
        }
      },
      "required": [
        "24h",
        "72h"
      ],
      "type": "object"
    },
    "evaluatedAt": {
      "format": "date-time",
      "pattern": "Z$",
      "type": "string"
    },
    "evaluationVersion": {
      "minLength": 1,
      "type": "string"
    },
    "marketRegimeAtGeneration": {
      "additionalProperties": false,
      "properties": {
        "24h": {
          "$ref": "#/$defs/groupMap"
        },
        "72h": {
          "$ref": "#/$defs/groupMap"
        }
      },
      "required": [
        "24h",
        "72h"
      ],
      "type": "object"
    },
    "marketRegimeCoverage": {
      "additionalProperties": false,
      "properties": {
        "24h": {
          "maximum": 1,
          "minimum": 0,
          "type": [
            "number",
            "null"
          ]
        },
        "72h": {
          "maximum": 1,
          "minimum": 0,
          "type": [
            "number",
            "null"
          ]
        }
      },
      "required": [
        "24h",
        "72h"
      ],
      "type": "object"
    },
    "postCostLift": {
      "additionalProperties": false,
      "properties": {
        "24h": {
          "type": [
            "number",
            "null"
          ]
        },
        "72h": {
          "type": [
            "number",
            "null"
          ]
        }
      },
      "required": [
        "24h",
        "72h"
      ],
      "type": "object"
    },
    "preCostLift": {
      "additionalProperties": false,
      "properties": {
        "24h": {
          "type": [
            "number",
            "null"
          ]
        },
        "72h": {
          "type": [
            "number",
            "null"
          ]
        }
      },
      "required": [
        "24h",
        "72h"
      ],
      "type": "object"
    },
    "predictedDownCount": {
      "additionalProperties": false,
      "properties": {
        "24h": {
          "minimum": 0,
          "type": "integer"
        },
        "72h": {
          "minimum": 0,
          "type": "integer"
        }
      },
      "required": [
        "24h",
        "72h"
      ],
      "type": "object"
    },
    "predictedUpCount": {
      "additionalProperties": false,
      "properties": {
        "24h": {
          "minimum": 0,
          "type": "integer"
        },
        "72h": {
          "minimum": 0,
          "type": "integer"
        }
      },
      "required": [
        "24h",
        "72h"
      ],
      "type": "object"
    },
    "rangeAttribution": {
      "additionalProperties": false,
      "properties": {
        "24h": {
          "$ref": "#/$defs/rangeAttribution"
        },
        "72h": {
          "$ref": "#/$defs/rangeAttribution"
        }
      },
      "required": [
        "24h",
        "72h"
      ],
      "type": "object"
    },
    "sampleAccounting": {
      "additionalProperties": false,
      "properties": {
        "24h": {
          "$ref": "#/$defs/sampleHorizon"
        },
        "72h": {
          "$ref": "#/$defs/sampleHorizon"
        }
      },
      "required": [
        "24h",
        "72h"
      ],
      "type": "object"
    },
    "schemaVersion": {
      "const": "v1.4d-go-no-go-input/2"
    },
    "scorecard": {
      "$ref": "#/$defs/scorecard"
    },
    "thresholds": {
      "$ref": "#/$defs/thresholds"
    },
    "validationRunId": {
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
      "type": "string"
    }
  },
  "required": [
    "schemaVersion",
    "validationRunId",
    "evaluationVersion",
    "evaluatedAt",
    "sampleAccounting",
    "rangeAttribution",
    "marketRegimeAtGeneration",
    "predictedUpCount",
    "predictedDownCount",
    "directionalCoverage",
    "marketRegimeCoverage",
    "preCostLift",
    "postCostLift",
    "baselineAvailabilityInput",
    "thresholds",
    "scorecard",
    "auditTrail"
  ],
  "title": "V1.4D GO/NO-GO input",
  "type": "object"
}
```

#### D8 输出 Schema

```json
{
  "$defs": {
    "baselineAvailabilityResult": {
      "additionalProperties": false,
      "properties": {
        "postCostReferenceBaseline": {
          "enum": [
            "alwaysRange",
            "follow4hTrend",
            "historicalProportionRandom",
            null
          ],
          "type": [
            "string",
            "null"
          ]
        },
        "preCostReferenceBaseline": {
          "enum": [
            "alwaysRange",
            "follow4hTrend",
            "historicalProportionRandom",
            null
          ],
          "type": [
            "string",
            "null"
          ]
        },
        "primaryReasonCode": {
          "enum": [
            "NONE",
            "ALWAYS_RANGE_NOT_EVALUABLE",
            "BASELINE_NOT_EVALUABLE"
          ]
        },
        "reasonCodes": {
          "items": {
            "enum": [
              "ALWAYS_RANGE_NOT_EVALUABLE",
              "BASELINE_NOT_EVALUABLE"
            ]
          },
          "type": "array",
          "uniqueItems": true
        },
        "status": {
          "enum": [
            "AVAILABLE",
            "NOT_EVALUABLE"
          ]
        },
        "usableBaselines": {
          "items": {
            "enum": [
              "alwaysRange",
              "follow4hTrend",
              "historicalProportionRandom"
            ]
          },
          "type": "array",
          "uniqueItems": true
        }
      },
      "required": [
        "status",
        "primaryReasonCode",
        "reasonCodes",
        "usableBaselines",
        "preCostReferenceBaseline",
        "postCostReferenceBaseline"
      ],
      "type": "object"
    },
    "horizonResult": {
      "additionalProperties": false,
      "properties": {
        "directionalCoverage": {
          "maximum": 1,
          "minimum": 0,
          "type": [
            "number",
            "null"
          ]
        },
        "effectiveTest": {
          "minimum": 0,
          "type": "integer"
        },
        "marketRegimeCoverage": {
          "maximum": 1,
          "minimum": 0,
          "type": [
            "number",
            "null"
          ]
        },
        "postCostLift": {
          "type": [
            "number",
            "null"
          ]
        },
        "preCostLift": {
          "type": [
            "number",
            "null"
          ]
        },
        "primaryReasonCode": {
          "enum": [
            "NONE",
            "INPUT_CONSISTENCY_FAILED",
            "AUDIT_RUN_NOT_SUCCEEDED",
            "AUDIT_AUTHENTICITY_NOT_PASSED",
            "MANIFEST_COVERAGE_INCOMPLETE",
            "FEATURE_COVERAGE_INCOMPLETE",
            "EFFECTIVE_TEST_ZERO",
            "COVERAGE_NULL",
            "LIFT_NULL",
            "ALWAYS_RANGE_NOT_EVALUABLE",
            "BASELINE_NOT_EVALUABLE",
            "EFFECTIVE_TEST_BELOW_THRESHOLD",
            "CLASS_SAMPLE_BELOW_THRESHOLD",
            "RANGE_CLASS_ABSENT",
            "RANGE_PREDICTION_DEGENERATE",
            "WILSON_BELOW_THRESHOLD",
            "PRE_COST_LIFT_BELOW_THRESHOLD",
            "POST_COST_LIFT_BELOW_THRESHOLD",
            "DIRECTIONAL_COVERAGE_BELOW_THRESHOLD",
            "MARKET_REGIME_COVERAGE_BELOW_THRESHOLD"
          ]
        },
        "reasonCodes": {
          "items": {
            "enum": [
              "INPUT_CONSISTENCY_FAILED",
              "AUDIT_RUN_NOT_SUCCEEDED",
              "AUDIT_AUTHENTICITY_NOT_PASSED",
              "MANIFEST_COVERAGE_INCOMPLETE",
              "FEATURE_COVERAGE_INCOMPLETE",
              "EFFECTIVE_TEST_ZERO",
              "COVERAGE_NULL",
              "LIFT_NULL",
              "ALWAYS_RANGE_NOT_EVALUABLE",
              "BASELINE_NOT_EVALUABLE",
              "EFFECTIVE_TEST_BELOW_THRESHOLD",
              "CLASS_SAMPLE_BELOW_THRESHOLD",
              "RANGE_CLASS_ABSENT",
              "RANGE_PREDICTION_DEGENERATE",
              "WILSON_BELOW_THRESHOLD",
              "PRE_COST_LIFT_BELOW_THRESHOLD",
              "POST_COST_LIFT_BELOW_THRESHOLD",
              "DIRECTIONAL_COVERAGE_BELOW_THRESHOLD",
              "MARKET_REGIME_COVERAGE_BELOW_THRESHOLD"
            ]
          },
          "type": "array",
          "uniqueItems": true
        },
        "status": {
          "enum": [
            "GO",
            "CONDITIONAL_GO",
            "NO_GO",
            "DATA_GATE_FAILED",
            "BASELINE_NOT_EVALUABLE"
          ]
        },
        "wilson95": {
          "$ref": "#/$defs/wilson"
        }
      },
      "required": [
        "status",
        "primaryReasonCode",
        "reasonCodes",
        "effectiveTest",
        "directionalCoverage",
        "marketRegimeCoverage",
        "preCostLift",
        "postCostLift",
        "wilson95"
      ],
      "type": "object"
    },
    "wilson": {
      "additionalProperties": false,
      "properties": {
        "confidenceLevel": {
          "const": 0.95
        },
        "lower": {
          "maximum": 1,
          "minimum": 0,
          "type": [
            "number",
            "null"
          ]
        },
        "successes": {
          "minimum": 0,
          "type": "integer"
        },
        "trials": {
          "minimum": 0,
          "type": "integer"
        },
        "upper": {
          "maximum": 1,
          "minimum": 0,
          "type": [
            "number",
            "null"
          ]
        },
        "z": {
          "const": 1.959963984540054
        }
      },
      "required": [
        "confidenceLevel",
        "z",
        "successes",
        "trials",
        "lower",
        "upper"
      ],
      "type": "object"
    }
  },
  "$id": "https://eth-alpha.invalid/schema/v1.4d-go-no-go-output-2.json",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "baselineAvailability": {
      "additionalProperties": false,
      "properties": {
        "24h": {
          "$ref": "#/$defs/baselineAvailabilityResult"
        },
        "72h": {
          "$ref": "#/$defs/baselineAvailabilityResult"
        }
      },
      "required": [
        "24h",
        "72h"
      ],
      "type": "object"
    },
    "evaluatedAt": {
      "format": "date-time",
      "pattern": "Z$",
      "type": "string"
    },
    "evaluationVersion": {
      "minLength": 1,
      "type": "string"
    },
    "horizonResults": {
      "additionalProperties": false,
      "properties": {
        "24h": {
          "$ref": "#/$defs/horizonResult"
        },
        "72h": {
          "$ref": "#/$defs/horizonResult"
        }
      },
      "required": [
        "24h",
        "72h"
      ],
      "type": "object"
    },
    "overall": {
      "additionalProperties": false,
      "properties": {
        "primaryReasonCode": {
          "enum": [
            "NONE",
            "INPUT_CONSISTENCY_FAILED",
            "AUDIT_RUN_NOT_SUCCEEDED",
            "AUDIT_AUTHENTICITY_NOT_PASSED",
            "MANIFEST_COVERAGE_INCOMPLETE",
            "FEATURE_COVERAGE_INCOMPLETE",
            "EFFECTIVE_TEST_ZERO",
            "COVERAGE_NULL",
            "LIFT_NULL",
            "ALWAYS_RANGE_NOT_EVALUABLE",
            "BASELINE_NOT_EVALUABLE",
            "EFFECTIVE_TEST_BELOW_THRESHOLD",
            "CLASS_SAMPLE_BELOW_THRESHOLD",
            "RANGE_CLASS_ABSENT",
            "RANGE_PREDICTION_DEGENERATE",
            "WILSON_BELOW_THRESHOLD",
            "PRE_COST_LIFT_BELOW_THRESHOLD",
            "POST_COST_LIFT_BELOW_THRESHOLD",
            "DIRECTIONAL_COVERAGE_BELOW_THRESHOLD",
            "MARKET_REGIME_COVERAGE_BELOW_THRESHOLD"
          ]
        },
        "reasonCodes": {
          "items": {
            "enum": [
              "INPUT_CONSISTENCY_FAILED",
              "AUDIT_RUN_NOT_SUCCEEDED",
              "AUDIT_AUTHENTICITY_NOT_PASSED",
              "MANIFEST_COVERAGE_INCOMPLETE",
              "FEATURE_COVERAGE_INCOMPLETE",
              "EFFECTIVE_TEST_ZERO",
              "COVERAGE_NULL",
              "LIFT_NULL",
              "ALWAYS_RANGE_NOT_EVALUABLE",
              "BASELINE_NOT_EVALUABLE",
              "EFFECTIVE_TEST_BELOW_THRESHOLD",
              "CLASS_SAMPLE_BELOW_THRESHOLD",
              "RANGE_CLASS_ABSENT",
              "RANGE_PREDICTION_DEGENERATE",
              "WILSON_BELOW_THRESHOLD",
              "PRE_COST_LIFT_BELOW_THRESHOLD",
              "POST_COST_LIFT_BELOW_THRESHOLD",
              "DIRECTIONAL_COVERAGE_BELOW_THRESHOLD",
              "MARKET_REGIME_COVERAGE_BELOW_THRESHOLD"
            ]
          },
          "type": "array",
          "uniqueItems": true
        },
        "status": {
          "enum": [
            "GO",
            "CONDITIONAL_GO",
            "NO_GO",
            "DATA_GATE_FAILED",
            "BASELINE_NOT_EVALUABLE"
          ]
        }
      },
      "required": [
        "status",
        "primaryReasonCode",
        "reasonCodes"
      ],
      "type": "object"
    },
    "primaryReasonCode": {
      "enum": [
        "NONE",
        "INPUT_CONSISTENCY_FAILED",
        "AUDIT_RUN_NOT_SUCCEEDED",
        "AUDIT_AUTHENTICITY_NOT_PASSED",
        "MANIFEST_COVERAGE_INCOMPLETE",
        "FEATURE_COVERAGE_INCOMPLETE",
        "EFFECTIVE_TEST_ZERO",
        "COVERAGE_NULL",
        "LIFT_NULL",
        "ALWAYS_RANGE_NOT_EVALUABLE",
        "BASELINE_NOT_EVALUABLE",
        "EFFECTIVE_TEST_BELOW_THRESHOLD",
        "CLASS_SAMPLE_BELOW_THRESHOLD",
        "RANGE_CLASS_ABSENT",
        "RANGE_PREDICTION_DEGENERATE",
        "WILSON_BELOW_THRESHOLD",
        "PRE_COST_LIFT_BELOW_THRESHOLD",
        "POST_COST_LIFT_BELOW_THRESHOLD",
        "DIRECTIONAL_COVERAGE_BELOW_THRESHOLD",
        "MARKET_REGIME_COVERAGE_BELOW_THRESHOLD"
      ]
    },
    "reasonCodes": {
      "items": {
        "enum": [
          "INPUT_CONSISTENCY_FAILED",
          "AUDIT_RUN_NOT_SUCCEEDED",
          "AUDIT_AUTHENTICITY_NOT_PASSED",
          "MANIFEST_COVERAGE_INCOMPLETE",
          "FEATURE_COVERAGE_INCOMPLETE",
          "EFFECTIVE_TEST_ZERO",
          "COVERAGE_NULL",
          "LIFT_NULL",
          "ALWAYS_RANGE_NOT_EVALUABLE",
          "BASELINE_NOT_EVALUABLE",
          "EFFECTIVE_TEST_BELOW_THRESHOLD",
          "CLASS_SAMPLE_BELOW_THRESHOLD",
          "RANGE_CLASS_ABSENT",
          "RANGE_PREDICTION_DEGENERATE",
          "WILSON_BELOW_THRESHOLD",
          "PRE_COST_LIFT_BELOW_THRESHOLD",
          "POST_COST_LIFT_BELOW_THRESHOLD",
          "DIRECTIONAL_COVERAGE_BELOW_THRESHOLD",
          "MARKET_REGIME_COVERAGE_BELOW_THRESHOLD"
        ]
      },
      "type": "array",
      "uniqueItems": true
    },
    "schemaVersion": {
      "const": "v1.4d-go-no-go-output/2"
    },
    "validationRunId": {
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
      "type": "string"
    }
  },
  "required": [
    "schemaVersion",
    "validationRunId",
    "evaluationVersion",
    "evaluatedAt",
    "baselineAvailability",
    "horizonResults",
    "overall",
    "primaryReasonCode",
    "reasonCodes"
  ],
  "type": "object"
}
```

#### Thresholds Schema

```json
{
  "$defs": {
    "thresholds": {
      "additionalProperties": false,
      "properties": {
        "minClassEffectiveTest": {
          "additionalProperties": false,
          "properties": {
            "24h": {
              "minimum": 0,
              "type": "integer"
            },
            "72h": {
              "minimum": 0,
              "type": "integer"
            }
          },
          "required": [
            "24h",
            "72h"
          ],
          "type": "object"
        },
        "minDirectionalCoverage": {
          "additionalProperties": false,
          "properties": {
            "24h": {
              "maximum": 1,
              "minimum": 0,
              "type": "number"
            },
            "72h": {
              "maximum": 1,
              "minimum": 0,
              "type": "number"
            }
          },
          "required": [
            "24h",
            "72h"
          ],
          "type": "object"
        },
        "minEffectiveTest": {
          "additionalProperties": false,
          "properties": {
            "24h": {
              "minimum": 1,
              "type": "integer"
            },
            "72h": {
              "minimum": 1,
              "type": "integer"
            }
          },
          "required": [
            "24h",
            "72h"
          ],
          "type": "object"
        },
        "minMarketRegimeCoverage": {
          "additionalProperties": false,
          "properties": {
            "24h": {
              "maximum": 1,
              "minimum": 0,
              "type": "number"
            },
            "72h": {
              "maximum": 1,
              "minimum": 0,
              "type": "number"
            }
          },
          "required": [
            "24h",
            "72h"
          ],
          "type": "object"
        },
        "minPostCostLift": {
          "additionalProperties": false,
          "properties": {
            "24h": {
              "type": "number"
            },
            "72h": {
              "type": "number"
            }
          },
          "required": [
            "24h",
            "72h"
          ],
          "type": "object"
        },
        "minPreCostLift": {
          "additionalProperties": false,
          "properties": {
            "24h": {
              "type": "number"
            },
            "72h": {
              "type": "number"
            }
          },
          "required": [
            "24h",
            "72h"
          ],
          "type": "object"
        },
        "minWilsonLowerBound": {
          "additionalProperties": false,
          "properties": {
            "24h": {
              "maximum": 1,
              "minimum": 0,
              "type": "number"
            },
            "72h": {
              "maximum": 1,
              "minimum": 0,
              "type": "number"
            }
          },
          "required": [
            "24h",
            "72h"
          ],
          "type": "object"
        },
        "requireAllBaselines": {
          "const": true
        },
        "requireMarketRegime": {
          "const": true
        },
        "schemaVersion": {
          "const": "v1.4d-go-no-go-thresholds/1"
        }
      },
      "required": [
        "schemaVersion",
        "minEffectiveTest",
        "minClassEffectiveTest",
        "minDirectionalCoverage",
        "minMarketRegimeCoverage",
        "minWilsonLowerBound",
        "minPreCostLift",
        "minPostCostLift",
        "requireAllBaselines",
        "requireMarketRegime"
      ],
      "type": "object"
    }
  },
  "$id": "https://eth-alpha.invalid/schema/v1.4d-thresholds-1.json",
  "$ref": "#/$defs/thresholds",
  "$schema": "https://json-schema.org/draft/2020-12/schema"
}
```

### 3.7 完整测试向量

每个合法向量对象精确包含完整 `input` 与本轮重新计算的完整 `output`。一致性冲突向量虽通过输入Schema，但由算法以 `INPUT_CONSISTENCY_FAILED` fail-closed；非法向量在Schema阶段拒绝。

#### 向量 `ALWAYS_RANGE_UNAVAILABLE`

输入Schema：`PASS`；overall=`BASELINE_NOT_EVALUABLE`；primary=`ALWAYS_RANGE_NOT_EVALUABLE`。

```json
{
  "input": {
    "auditTrail": {
      "authenticityGateStatus": "PASSED",
      "backfillBatchIds": [
        "223e4567-e89b-42d3-a456-426614174001"
      ],
      "datasetVersion": "v1.4d-sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "evaluatedAt": "2026-01-02T00:00:00Z",
      "evaluationVersion": "eval-1",
      "featureCoverage": 1,
      "generationSummary": {
        "attempted": 80,
        "blocked": 0,
        "conflicts": 0,
        "evaluated": 80,
        "expected": 80,
        "inserted": 80,
        "reusedIdentical": 0
      },
      "manifestContentHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "manifestCoverage": 1,
      "schemaVersion": "v1.4d-audit-trail/1",
      "validationRunId": "123e4567-e89b-42d3-a456-426614174000",
      "validationRunStatus": "SUCCEEDED",
      "vintageIds": [
        "vintage-1"
      ]
    },
    "baselineAvailabilityInput": {
      "24h": {
        "alwaysRange": {
          "macroF1": 0.3,
          "postCostExpectedReturn": -0.001,
          "preCostExpectedReturn": 0.001,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        },
        "follow4hTrend": {
          "macroF1": 0.45,
          "postCostExpectedReturn": 0.001,
          "preCostExpectedReturn": 0.003,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        },
        "historicalProportionRandom": {
          "macroF1": 0.34,
          "postCostExpectedReturn": 0,
          "preCostExpectedReturn": 0.002,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        }
      },
      "72h": {
        "alwaysRange": {
          "macroF1": null,
          "postCostExpectedReturn": null,
          "preCostExpectedReturn": null,
          "reasonCode": "INPUT_MISSING",
          "sampleCount": 0,
          "status": "NOT_EVALUABLE"
        },
        "follow4hTrend": {
          "macroF1": 0.45,
          "postCostExpectedReturn": 0.001,
          "preCostExpectedReturn": 0.003,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        },
        "historicalProportionRandom": {
          "macroF1": 0.34,
          "postCostExpectedReturn": 0,
          "preCostExpectedReturn": 0.002,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        }
      }
    },
    "directionalCoverage": {
      "24h": 0.6666666666666666,
      "72h": 0.6666666666666666
    },
    "evaluatedAt": "2026-01-02T00:00:00Z",
    "evaluationVersion": "eval-1",
    "marketRegimeAtGeneration": {
      "24h": {
        "DOWN": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        },
        "RANGE": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        },
        "UP": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        }
      },
      "72h": {
        "DOWN": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        },
        "RANGE": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        },
        "UP": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        }
      }
    },
    "marketRegimeCoverage": {
      "24h": 1,
      "72h": 1
    },
    "postCostLift": {
      "24h": 0.003,
      "72h": null
    },
    "preCostLift": {
      "24h": 0.005,
      "72h": null
    },
    "predictedDownCount": {
      "24h": 15,
      "72h": 5
    },
    "predictedUpCount": {
      "24h": 15,
      "72h": 5
    },
    "rangeAttribution": {
      "24h": {
        "allPredictionsRange": false,
        "correctlyPredictedRangeCount": 14,
        "predictedRangeCount": 15,
        "rangeTotal": 15
      },
      "72h": {
        "allPredictionsRange": false,
        "correctlyPredictedRangeCount": 4,
        "predictedRangeCount": 5,
        "rangeTotal": 5
      }
    },
    "sampleAccounting": {
      "24h": {
        "classEffectiveTest": {
          "DOWN": 15,
          "RANGE": 15,
          "UP": 15
        },
        "effectiveTest": 45,
        "predictedDownCount": 15,
        "predictedRangeCount": 15,
        "predictedUpCount": 15,
        "rawTest": 270
      },
      "72h": {
        "classEffectiveTest": {
          "DOWN": 5,
          "RANGE": 5,
          "UP": 5
        },
        "effectiveTest": 15,
        "predictedDownCount": 5,
        "predictedRangeCount": 5,
        "predictedUpCount": 5,
        "rawTest": 45
      }
    },
    "schemaVersion": "v1.4d-go-no-go-input/2",
    "scorecard": {
      "evaluatedAt": "2026-01-02T00:00:00Z",
      "evaluationVersion": "eval-1",
      "horizons": {
        "24h": {
          "baselines": {
            "alwaysRange": {
              "macroF1": 0.3,
              "postCostExpectedReturn": -0.001,
              "preCostExpectedReturn": 0.001,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            },
            "follow4hTrend": {
              "macroF1": 0.45,
              "postCostExpectedReturn": 0.001,
              "preCostExpectedReturn": 0.003,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            },
            "historicalProportionRandom": {
              "macroF1": 0.34,
              "postCostExpectedReturn": 0,
              "preCostExpectedReturn": 0.002,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            }
          },
          "model": {
            "directionCorrectCount": 30,
            "macroF1": 0.62,
            "postCostExpectedReturn": 0.004,
            "preCostExpectedReturn": 0.008
          }
        },
        "72h": {
          "baselines": {
            "alwaysRange": {
              "macroF1": null,
              "postCostExpectedReturn": null,
              "preCostExpectedReturn": null,
              "reasonCode": "INPUT_MISSING",
              "sampleCount": 0,
              "status": "NOT_EVALUABLE"
            },
            "follow4hTrend": {
              "macroF1": 0.45,
              "postCostExpectedReturn": 0.001,
              "preCostExpectedReturn": 0.003,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            },
            "historicalProportionRandom": {
              "macroF1": 0.34,
              "postCostExpectedReturn": 0,
              "preCostExpectedReturn": 0.002,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            }
          },
          "model": {
            "directionCorrectCount": 10,
            "macroF1": 0.62,
            "postCostExpectedReturn": 0.004,
            "preCostExpectedReturn": 0.008
          }
        }
      },
      "schemaVersion": "v1.4d-research-scorecard/4-deterministic",
      "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
    },
    "thresholds": {
      "minClassEffectiveTest": {
        "24h": 5,
        "72h": 2
      },
      "minDirectionalCoverage": {
        "24h": 0.5,
        "72h": 0.5
      },
      "minEffectiveTest": {
        "24h": 30,
        "72h": 10
      },
      "minMarketRegimeCoverage": {
        "24h": 0.9,
        "72h": 0.9
      },
      "minPostCostLift": {
        "24h": 0,
        "72h": 0
      },
      "minPreCostLift": {
        "24h": 0.001,
        "72h": 0.001
      },
      "minWilsonLowerBound": {
        "24h": 0.45,
        "72h": 0.35
      },
      "requireAllBaselines": true,
      "requireMarketRegime": true,
      "schemaVersion": "v1.4d-go-no-go-thresholds/1"
    },
    "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
  },
  "output": {
    "baselineAvailability": {
      "24h": {
        "postCostReferenceBaseline": "follow4hTrend",
        "preCostReferenceBaseline": "follow4hTrend",
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "AVAILABLE",
        "usableBaselines": [
          "alwaysRange",
          "follow4hTrend",
          "historicalProportionRandom"
        ]
      },
      "72h": {
        "postCostReferenceBaseline": "follow4hTrend",
        "preCostReferenceBaseline": "follow4hTrend",
        "primaryReasonCode": "ALWAYS_RANGE_NOT_EVALUABLE",
        "reasonCodes": [
          "ALWAYS_RANGE_NOT_EVALUABLE",
          "BASELINE_NOT_EVALUABLE"
        ],
        "status": "NOT_EVALUABLE",
        "usableBaselines": [
          "follow4hTrend",
          "historicalProportionRandom"
        ]
      }
    },
    "evaluatedAt": "2026-01-02T00:00:00Z",
    "evaluationVersion": "eval-1",
    "horizonResults": {
      "24h": {
        "directionalCoverage": 0.6666666666666666,
        "effectiveTest": 45,
        "marketRegimeCoverage": 1,
        "postCostLift": 0.003,
        "preCostLift": 0.005,
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "GO",
        "wilson95": {
          "confidenceLevel": 0.95,
          "lower": 0.520704883099,
          "successes": 30,
          "trials": 45,
          "upper": 0.786411250657,
          "z": 1.959963984540054
        }
      },
      "72h": {
        "directionalCoverage": 0.6666666666666666,
        "effectiveTest": 15,
        "marketRegimeCoverage": 1,
        "postCostLift": null,
        "preCostLift": null,
        "primaryReasonCode": "ALWAYS_RANGE_NOT_EVALUABLE",
        "reasonCodes": [
          "ALWAYS_RANGE_NOT_EVALUABLE",
          "BASELINE_NOT_EVALUABLE"
        ],
        "status": "BASELINE_NOT_EVALUABLE",
        "wilson95": {
          "confidenceLevel": 0.95,
          "lower": 0.417135477385,
          "successes": 10,
          "trials": 15,
          "upper": 0.848236755603,
          "z": 1.959963984540054
        }
      }
    },
    "overall": {
      "primaryReasonCode": "ALWAYS_RANGE_NOT_EVALUABLE",
      "reasonCodes": [
        "ALWAYS_RANGE_NOT_EVALUABLE",
        "BASELINE_NOT_EVALUABLE"
      ],
      "status": "BASELINE_NOT_EVALUABLE"
    },
    "primaryReasonCode": "ALWAYS_RANGE_NOT_EVALUABLE",
    "reasonCodes": [
      "ALWAYS_RANGE_NOT_EVALUABLE",
      "BASELINE_NOT_EVALUABLE"
    ],
    "schemaVersion": "v1.4d-go-no-go-output/2",
    "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
  }
}
```

#### 向量 `BASELINE_MIRROR_MISMATCH`

输入Schema：`PASS`；overall=`DATA_GATE_FAILED`；primary=`INPUT_CONSISTENCY_FAILED`。

```json
{
  "input": {
    "auditTrail": {
      "authenticityGateStatus": "PASSED",
      "backfillBatchIds": [
        "223e4567-e89b-42d3-a456-426614174001"
      ],
      "datasetVersion": "v1.4d-sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "evaluatedAt": "2026-01-02T00:00:00Z",
      "evaluationVersion": "eval-1",
      "featureCoverage": 1,
      "generationSummary": {
        "attempted": 80,
        "blocked": 0,
        "conflicts": 0,
        "evaluated": 80,
        "expected": 80,
        "inserted": 80,
        "reusedIdentical": 0
      },
      "manifestContentHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "manifestCoverage": 1,
      "schemaVersion": "v1.4d-audit-trail/1",
      "validationRunId": "123e4567-e89b-42d3-a456-426614174000",
      "validationRunStatus": "SUCCEEDED",
      "vintageIds": [
        "vintage-1"
      ]
    },
    "baselineAvailabilityInput": {
      "24h": {
        "alwaysRange": {
          "macroF1": 0.31,
          "postCostExpectedReturn": -0.001,
          "preCostExpectedReturn": 0.001,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        },
        "follow4hTrend": {
          "macroF1": 0.45,
          "postCostExpectedReturn": 0.001,
          "preCostExpectedReturn": 0.003,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        },
        "historicalProportionRandom": {
          "macroF1": 0.34,
          "postCostExpectedReturn": 0,
          "preCostExpectedReturn": 0.002,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        }
      },
      "72h": {
        "alwaysRange": {
          "macroF1": 0.3,
          "postCostExpectedReturn": -0.001,
          "preCostExpectedReturn": 0.001,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        },
        "follow4hTrend": {
          "macroF1": 0.45,
          "postCostExpectedReturn": 0.001,
          "preCostExpectedReturn": 0.003,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        },
        "historicalProportionRandom": {
          "macroF1": 0.34,
          "postCostExpectedReturn": 0,
          "preCostExpectedReturn": 0.002,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        }
      }
    },
    "directionalCoverage": {
      "24h": 0.6666666666666666,
      "72h": 0.6666666666666666
    },
    "evaluatedAt": "2026-01-02T00:00:00Z",
    "evaluationVersion": "eval-1",
    "marketRegimeAtGeneration": {
      "24h": {
        "DOWN": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        },
        "RANGE": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        },
        "UP": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        }
      },
      "72h": {
        "DOWN": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        },
        "RANGE": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        },
        "UP": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        }
      }
    },
    "marketRegimeCoverage": {
      "24h": 1,
      "72h": 1
    },
    "postCostLift": {
      "24h": 0.003,
      "72h": 0.003
    },
    "preCostLift": {
      "24h": 0.005,
      "72h": 0.005
    },
    "predictedDownCount": {
      "24h": 15,
      "72h": 5
    },
    "predictedUpCount": {
      "24h": 15,
      "72h": 5
    },
    "rangeAttribution": {
      "24h": {
        "allPredictionsRange": false,
        "correctlyPredictedRangeCount": 14,
        "predictedRangeCount": 15,
        "rangeTotal": 15
      },
      "72h": {
        "allPredictionsRange": false,
        "correctlyPredictedRangeCount": 4,
        "predictedRangeCount": 5,
        "rangeTotal": 5
      }
    },
    "sampleAccounting": {
      "24h": {
        "classEffectiveTest": {
          "DOWN": 15,
          "RANGE": 15,
          "UP": 15
        },
        "effectiveTest": 45,
        "predictedDownCount": 15,
        "predictedRangeCount": 15,
        "predictedUpCount": 15,
        "rawTest": 270
      },
      "72h": {
        "classEffectiveTest": {
          "DOWN": 5,
          "RANGE": 5,
          "UP": 5
        },
        "effectiveTest": 15,
        "predictedDownCount": 5,
        "predictedRangeCount": 5,
        "predictedUpCount": 5,
        "rawTest": 45
      }
    },
    "schemaVersion": "v1.4d-go-no-go-input/2",
    "scorecard": {
      "evaluatedAt": "2026-01-02T00:00:00Z",
      "evaluationVersion": "eval-1",
      "horizons": {
        "24h": {
          "baselines": {
            "alwaysRange": {
              "macroF1": 0.3,
              "postCostExpectedReturn": -0.001,
              "preCostExpectedReturn": 0.001,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            },
            "follow4hTrend": {
              "macroF1": 0.45,
              "postCostExpectedReturn": 0.001,
              "preCostExpectedReturn": 0.003,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            },
            "historicalProportionRandom": {
              "macroF1": 0.34,
              "postCostExpectedReturn": 0,
              "preCostExpectedReturn": 0.002,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            }
          },
          "model": {
            "directionCorrectCount": 30,
            "macroF1": 0.62,
            "postCostExpectedReturn": 0.004,
            "preCostExpectedReturn": 0.008
          }
        },
        "72h": {
          "baselines": {
            "alwaysRange": {
              "macroF1": 0.3,
              "postCostExpectedReturn": -0.001,
              "preCostExpectedReturn": 0.001,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            },
            "follow4hTrend": {
              "macroF1": 0.45,
              "postCostExpectedReturn": 0.001,
              "preCostExpectedReturn": 0.003,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            },
            "historicalProportionRandom": {
              "macroF1": 0.34,
              "postCostExpectedReturn": 0,
              "preCostExpectedReturn": 0.002,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            }
          },
          "model": {
            "directionCorrectCount": 10,
            "macroF1": 0.62,
            "postCostExpectedReturn": 0.004,
            "preCostExpectedReturn": 0.008
          }
        }
      },
      "schemaVersion": "v1.4d-research-scorecard/4-deterministic",
      "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
    },
    "thresholds": {
      "minClassEffectiveTest": {
        "24h": 5,
        "72h": 2
      },
      "minDirectionalCoverage": {
        "24h": 0.5,
        "72h": 0.5
      },
      "minEffectiveTest": {
        "24h": 30,
        "72h": 10
      },
      "minMarketRegimeCoverage": {
        "24h": 0.9,
        "72h": 0.9
      },
      "minPostCostLift": {
        "24h": 0,
        "72h": 0
      },
      "minPreCostLift": {
        "24h": 0.001,
        "72h": 0.001
      },
      "minWilsonLowerBound": {
        "24h": 0.45,
        "72h": 0.35
      },
      "requireAllBaselines": true,
      "requireMarketRegime": true,
      "schemaVersion": "v1.4d-go-no-go-thresholds/1"
    },
    "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
  },
  "output": {
    "baselineAvailability": {
      "24h": {
        "postCostReferenceBaseline": "follow4hTrend",
        "preCostReferenceBaseline": "follow4hTrend",
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "AVAILABLE",
        "usableBaselines": [
          "alwaysRange",
          "follow4hTrend",
          "historicalProportionRandom"
        ]
      },
      "72h": {
        "postCostReferenceBaseline": "follow4hTrend",
        "preCostReferenceBaseline": "follow4hTrend",
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "AVAILABLE",
        "usableBaselines": [
          "alwaysRange",
          "follow4hTrend",
          "historicalProportionRandom"
        ]
      }
    },
    "evaluatedAt": "2026-01-02T00:00:00Z",
    "evaluationVersion": "eval-1",
    "horizonResults": {
      "24h": {
        "directionalCoverage": 0.6666666666666666,
        "effectiveTest": 45,
        "marketRegimeCoverage": 1,
        "postCostLift": 0.003,
        "preCostLift": 0.005,
        "primaryReasonCode": "INPUT_CONSISTENCY_FAILED",
        "reasonCodes": [
          "INPUT_CONSISTENCY_FAILED"
        ],
        "status": "DATA_GATE_FAILED",
        "wilson95": {
          "confidenceLevel": 0.95,
          "lower": 0.520704883099,
          "successes": 30,
          "trials": 45,
          "upper": 0.786411250657,
          "z": 1.959963984540054
        }
      },
      "72h": {
        "directionalCoverage": 0.6666666666666666,
        "effectiveTest": 15,
        "marketRegimeCoverage": 1,
        "postCostLift": 0.003,
        "preCostLift": 0.005,
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "GO",
        "wilson95": {
          "confidenceLevel": 0.95,
          "lower": 0.417135477385,
          "successes": 10,
          "trials": 15,
          "upper": 0.848236755603,
          "z": 1.959963984540054
        }
      }
    },
    "overall": {
      "primaryReasonCode": "INPUT_CONSISTENCY_FAILED",
      "reasonCodes": [
        "INPUT_CONSISTENCY_FAILED"
      ],
      "status": "DATA_GATE_FAILED"
    },
    "primaryReasonCode": "INPUT_CONSISTENCY_FAILED",
    "reasonCodes": [
      "INPUT_CONSISTENCY_FAILED"
    ],
    "schemaVersion": "v1.4d-go-no-go-output/2",
    "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
  }
}
```

#### 向量 `BASELINE_NOT_EVALUABLE`

输入Schema：`PASS`；overall=`BASELINE_NOT_EVALUABLE`；primary=`BASELINE_NOT_EVALUABLE`。

```json
{
  "input": {
    "auditTrail": {
      "authenticityGateStatus": "PASSED",
      "backfillBatchIds": [
        "223e4567-e89b-42d3-a456-426614174001"
      ],
      "datasetVersion": "v1.4d-sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "evaluatedAt": "2026-01-02T00:00:00Z",
      "evaluationVersion": "eval-1",
      "featureCoverage": 1,
      "generationSummary": {
        "attempted": 80,
        "blocked": 0,
        "conflicts": 0,
        "evaluated": 80,
        "expected": 80,
        "inserted": 80,
        "reusedIdentical": 0
      },
      "manifestContentHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "manifestCoverage": 1,
      "schemaVersion": "v1.4d-audit-trail/1",
      "validationRunId": "123e4567-e89b-42d3-a456-426614174000",
      "validationRunStatus": "SUCCEEDED",
      "vintageIds": [
        "vintage-1"
      ]
    },
    "baselineAvailabilityInput": {
      "24h": {
        "alwaysRange": {
          "macroF1": 0.3,
          "postCostExpectedReturn": -0.001,
          "preCostExpectedReturn": 0.001,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        },
        "follow4hTrend": {
          "macroF1": null,
          "postCostExpectedReturn": null,
          "preCostExpectedReturn": null,
          "reasonCode": "NO_VALID_TREND",
          "sampleCount": 0,
          "status": "NOT_EVALUABLE"
        },
        "historicalProportionRandom": {
          "macroF1": 0.34,
          "postCostExpectedReturn": 0,
          "preCostExpectedReturn": 0.002,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        }
      },
      "72h": {
        "alwaysRange": {
          "macroF1": 0.3,
          "postCostExpectedReturn": -0.001,
          "preCostExpectedReturn": 0.001,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        },
        "follow4hTrend": {
          "macroF1": 0.45,
          "postCostExpectedReturn": 0.001,
          "preCostExpectedReturn": 0.003,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        },
        "historicalProportionRandom": {
          "macroF1": 0.34,
          "postCostExpectedReturn": 0,
          "preCostExpectedReturn": 0.002,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        }
      }
    },
    "directionalCoverage": {
      "24h": 0.6666666666666666,
      "72h": 0.6666666666666666
    },
    "evaluatedAt": "2026-01-02T00:00:00Z",
    "evaluationVersion": "eval-1",
    "marketRegimeAtGeneration": {
      "24h": {
        "DOWN": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        },
        "RANGE": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        },
        "UP": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        }
      },
      "72h": {
        "DOWN": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        },
        "RANGE": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        },
        "UP": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        }
      }
    },
    "marketRegimeCoverage": {
      "24h": 1,
      "72h": 1
    },
    "postCostLift": {
      "24h": null,
      "72h": 0.003
    },
    "preCostLift": {
      "24h": null,
      "72h": 0.005
    },
    "predictedDownCount": {
      "24h": 15,
      "72h": 5
    },
    "predictedUpCount": {
      "24h": 15,
      "72h": 5
    },
    "rangeAttribution": {
      "24h": {
        "allPredictionsRange": false,
        "correctlyPredictedRangeCount": 14,
        "predictedRangeCount": 15,
        "rangeTotal": 15
      },
      "72h": {
        "allPredictionsRange": false,
        "correctlyPredictedRangeCount": 4,
        "predictedRangeCount": 5,
        "rangeTotal": 5
      }
    },
    "sampleAccounting": {
      "24h": {
        "classEffectiveTest": {
          "DOWN": 15,
          "RANGE": 15,
          "UP": 15
        },
        "effectiveTest": 45,
        "predictedDownCount": 15,
        "predictedRangeCount": 15,
        "predictedUpCount": 15,
        "rawTest": 270
      },
      "72h": {
        "classEffectiveTest": {
          "DOWN": 5,
          "RANGE": 5,
          "UP": 5
        },
        "effectiveTest": 15,
        "predictedDownCount": 5,
        "predictedRangeCount": 5,
        "predictedUpCount": 5,
        "rawTest": 45
      }
    },
    "schemaVersion": "v1.4d-go-no-go-input/2",
    "scorecard": {
      "evaluatedAt": "2026-01-02T00:00:00Z",
      "evaluationVersion": "eval-1",
      "horizons": {
        "24h": {
          "baselines": {
            "alwaysRange": {
              "macroF1": 0.3,
              "postCostExpectedReturn": -0.001,
              "preCostExpectedReturn": 0.001,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            },
            "follow4hTrend": {
              "macroF1": null,
              "postCostExpectedReturn": null,
              "preCostExpectedReturn": null,
              "reasonCode": "NO_VALID_TREND",
              "sampleCount": 0,
              "status": "NOT_EVALUABLE"
            },
            "historicalProportionRandom": {
              "macroF1": 0.34,
              "postCostExpectedReturn": 0,
              "preCostExpectedReturn": 0.002,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            }
          },
          "model": {
            "directionCorrectCount": 30,
            "macroF1": 0.62,
            "postCostExpectedReturn": 0.004,
            "preCostExpectedReturn": 0.008
          }
        },
        "72h": {
          "baselines": {
            "alwaysRange": {
              "macroF1": 0.3,
              "postCostExpectedReturn": -0.001,
              "preCostExpectedReturn": 0.001,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            },
            "follow4hTrend": {
              "macroF1": 0.45,
              "postCostExpectedReturn": 0.001,
              "preCostExpectedReturn": 0.003,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            },
            "historicalProportionRandom": {
              "macroF1": 0.34,
              "postCostExpectedReturn": 0,
              "preCostExpectedReturn": 0.002,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            }
          },
          "model": {
            "directionCorrectCount": 10,
            "macroF1": 0.62,
            "postCostExpectedReturn": 0.004,
            "preCostExpectedReturn": 0.008
          }
        }
      },
      "schemaVersion": "v1.4d-research-scorecard/4-deterministic",
      "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
    },
    "thresholds": {
      "minClassEffectiveTest": {
        "24h": 5,
        "72h": 2
      },
      "minDirectionalCoverage": {
        "24h": 0.5,
        "72h": 0.5
      },
      "minEffectiveTest": {
        "24h": 30,
        "72h": 10
      },
      "minMarketRegimeCoverage": {
        "24h": 0.9,
        "72h": 0.9
      },
      "minPostCostLift": {
        "24h": 0,
        "72h": 0
      },
      "minPreCostLift": {
        "24h": 0.001,
        "72h": 0.001
      },
      "minWilsonLowerBound": {
        "24h": 0.45,
        "72h": 0.35
      },
      "requireAllBaselines": true,
      "requireMarketRegime": true,
      "schemaVersion": "v1.4d-go-no-go-thresholds/1"
    },
    "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
  },
  "output": {
    "baselineAvailability": {
      "24h": {
        "postCostReferenceBaseline": "historicalProportionRandom",
        "preCostReferenceBaseline": "historicalProportionRandom",
        "primaryReasonCode": "BASELINE_NOT_EVALUABLE",
        "reasonCodes": [
          "BASELINE_NOT_EVALUABLE"
        ],
        "status": "NOT_EVALUABLE",
        "usableBaselines": [
          "alwaysRange",
          "historicalProportionRandom"
        ]
      },
      "72h": {
        "postCostReferenceBaseline": "follow4hTrend",
        "preCostReferenceBaseline": "follow4hTrend",
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "AVAILABLE",
        "usableBaselines": [
          "alwaysRange",
          "follow4hTrend",
          "historicalProportionRandom"
        ]
      }
    },
    "evaluatedAt": "2026-01-02T00:00:00Z",
    "evaluationVersion": "eval-1",
    "horizonResults": {
      "24h": {
        "directionalCoverage": 0.6666666666666666,
        "effectiveTest": 45,
        "marketRegimeCoverage": 1,
        "postCostLift": null,
        "preCostLift": null,
        "primaryReasonCode": "BASELINE_NOT_EVALUABLE",
        "reasonCodes": [
          "BASELINE_NOT_EVALUABLE"
        ],
        "status": "BASELINE_NOT_EVALUABLE",
        "wilson95": {
          "confidenceLevel": 0.95,
          "lower": 0.520704883099,
          "successes": 30,
          "trials": 45,
          "upper": 0.786411250657,
          "z": 1.959963984540054
        }
      },
      "72h": {
        "directionalCoverage": 0.6666666666666666,
        "effectiveTest": 15,
        "marketRegimeCoverage": 1,
        "postCostLift": 0.003,
        "preCostLift": 0.005,
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "GO",
        "wilson95": {
          "confidenceLevel": 0.95,
          "lower": 0.417135477385,
          "successes": 10,
          "trials": 15,
          "upper": 0.848236755603,
          "z": 1.959963984540054
        }
      }
    },
    "overall": {
      "primaryReasonCode": "BASELINE_NOT_EVALUABLE",
      "reasonCodes": [
        "BASELINE_NOT_EVALUABLE"
      ],
      "status": "BASELINE_NOT_EVALUABLE"
    },
    "primaryReasonCode": "BASELINE_NOT_EVALUABLE",
    "reasonCodes": [
      "BASELINE_NOT_EVALUABLE"
    ],
    "schemaVersion": "v1.4d-go-no-go-output/2",
    "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
  }
}
```

#### 向量 `CONDITIONAL_GO`

输入Schema：`PASS`；overall=`CONDITIONAL_GO`；primary=`MARKET_REGIME_COVERAGE_BELOW_THRESHOLD`。

```json
{
  "input": {
    "auditTrail": {
      "authenticityGateStatus": "PASSED",
      "backfillBatchIds": [
        "223e4567-e89b-42d3-a456-426614174001"
      ],
      "datasetVersion": "v1.4d-sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "evaluatedAt": "2026-01-02T00:00:00Z",
      "evaluationVersion": "eval-1",
      "featureCoverage": 1,
      "generationSummary": {
        "attempted": 80,
        "blocked": 0,
        "conflicts": 0,
        "evaluated": 80,
        "expected": 80,
        "inserted": 80,
        "reusedIdentical": 0
      },
      "manifestContentHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "manifestCoverage": 1,
      "schemaVersion": "v1.4d-audit-trail/1",
      "validationRunId": "123e4567-e89b-42d3-a456-426614174000",
      "validationRunStatus": "SUCCEEDED",
      "vintageIds": [
        "vintage-1"
      ]
    },
    "baselineAvailabilityInput": {
      "24h": {
        "alwaysRange": {
          "macroF1": 0.3,
          "postCostExpectedReturn": -0.001,
          "preCostExpectedReturn": 0.001,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        },
        "follow4hTrend": {
          "macroF1": 0.45,
          "postCostExpectedReturn": 0.001,
          "preCostExpectedReturn": 0.003,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        },
        "historicalProportionRandom": {
          "macroF1": 0.34,
          "postCostExpectedReturn": 0,
          "preCostExpectedReturn": 0.002,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        }
      },
      "72h": {
        "alwaysRange": {
          "macroF1": 0.3,
          "postCostExpectedReturn": -0.001,
          "preCostExpectedReturn": 0.001,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        },
        "follow4hTrend": {
          "macroF1": 0.45,
          "postCostExpectedReturn": 0.001,
          "preCostExpectedReturn": 0.003,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        },
        "historicalProportionRandom": {
          "macroF1": 0.34,
          "postCostExpectedReturn": 0,
          "preCostExpectedReturn": 0.002,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        }
      }
    },
    "directionalCoverage": {
      "24h": 0.6666666666666666,
      "72h": 0.6666666666666666
    },
    "evaluatedAt": "2026-01-02T00:00:00Z",
    "evaluationVersion": "eval-1",
    "marketRegimeAtGeneration": {
      "24h": {
        "DOWN": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        },
        "RANGE": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        },
        "UP": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        }
      },
      "72h": {
        "DOWN": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        },
        "RANGE": {
          "directionCorrectCount": 0,
          "sampleCount": 0
        },
        "UP": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        }
      }
    },
    "marketRegimeCoverage": {
      "24h": 1,
      "72h": 0.6666666666666666
    },
    "postCostLift": {
      "24h": 0.003,
      "72h": 0.003
    },
    "preCostLift": {
      "24h": 0.005,
      "72h": 0.005
    },
    "predictedDownCount": {
      "24h": 15,
      "72h": 5
    },
    "predictedUpCount": {
      "24h": 15,
      "72h": 5
    },
    "rangeAttribution": {
      "24h": {
        "allPredictionsRange": false,
        "correctlyPredictedRangeCount": 14,
        "predictedRangeCount": 15,
        "rangeTotal": 15
      },
      "72h": {
        "allPredictionsRange": false,
        "correctlyPredictedRangeCount": 4,
        "predictedRangeCount": 5,
        "rangeTotal": 5
      }
    },
    "sampleAccounting": {
      "24h": {
        "classEffectiveTest": {
          "DOWN": 15,
          "RANGE": 15,
          "UP": 15
        },
        "effectiveTest": 45,
        "predictedDownCount": 15,
        "predictedRangeCount": 15,
        "predictedUpCount": 15,
        "rawTest": 270
      },
      "72h": {
        "classEffectiveTest": {
          "DOWN": 5,
          "RANGE": 5,
          "UP": 5
        },
        "effectiveTest": 15,
        "predictedDownCount": 5,
        "predictedRangeCount": 5,
        "predictedUpCount": 5,
        "rawTest": 45
      }
    },
    "schemaVersion": "v1.4d-go-no-go-input/2",
    "scorecard": {
      "evaluatedAt": "2026-01-02T00:00:00Z",
      "evaluationVersion": "eval-1",
      "horizons": {
        "24h": {
          "baselines": {
            "alwaysRange": {
              "macroF1": 0.3,
              "postCostExpectedReturn": -0.001,
              "preCostExpectedReturn": 0.001,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            },
            "follow4hTrend": {
              "macroF1": 0.45,
              "postCostExpectedReturn": 0.001,
              "preCostExpectedReturn": 0.003,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            },
            "historicalProportionRandom": {
              "macroF1": 0.34,
              "postCostExpectedReturn": 0,
              "preCostExpectedReturn": 0.002,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            }
          },
          "model": {
            "directionCorrectCount": 30,
            "macroF1": 0.62,
            "postCostExpectedReturn": 0.004,
            "preCostExpectedReturn": 0.008
          }
        },
        "72h": {
          "baselines": {
            "alwaysRange": {
              "macroF1": 0.3,
              "postCostExpectedReturn": -0.001,
              "preCostExpectedReturn": 0.001,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            },
            "follow4hTrend": {
              "macroF1": 0.45,
              "postCostExpectedReturn": 0.001,
              "preCostExpectedReturn": 0.003,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            },
            "historicalProportionRandom": {
              "macroF1": 0.34,
              "postCostExpectedReturn": 0,
              "preCostExpectedReturn": 0.002,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            }
          },
          "model": {
            "directionCorrectCount": 10,
            "macroF1": 0.62,
            "postCostExpectedReturn": 0.004,
            "preCostExpectedReturn": 0.008
          }
        }
      },
      "schemaVersion": "v1.4d-research-scorecard/4-deterministic",
      "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
    },
    "thresholds": {
      "minClassEffectiveTest": {
        "24h": 5,
        "72h": 2
      },
      "minDirectionalCoverage": {
        "24h": 0.5,
        "72h": 0.5
      },
      "minEffectiveTest": {
        "24h": 30,
        "72h": 10
      },
      "minMarketRegimeCoverage": {
        "24h": 0.9,
        "72h": 0.9
      },
      "minPostCostLift": {
        "24h": 0,
        "72h": 0
      },
      "minPreCostLift": {
        "24h": 0.001,
        "72h": 0.001
      },
      "minWilsonLowerBound": {
        "24h": 0.45,
        "72h": 0.35
      },
      "requireAllBaselines": true,
      "requireMarketRegime": true,
      "schemaVersion": "v1.4d-go-no-go-thresholds/1"
    },
    "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
  },
  "output": {
    "baselineAvailability": {
      "24h": {
        "postCostReferenceBaseline": "follow4hTrend",
        "preCostReferenceBaseline": "follow4hTrend",
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "AVAILABLE",
        "usableBaselines": [
          "alwaysRange",
          "follow4hTrend",
          "historicalProportionRandom"
        ]
      },
      "72h": {
        "postCostReferenceBaseline": "follow4hTrend",
        "preCostReferenceBaseline": "follow4hTrend",
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "AVAILABLE",
        "usableBaselines": [
          "alwaysRange",
          "follow4hTrend",
          "historicalProportionRandom"
        ]
      }
    },
    "evaluatedAt": "2026-01-02T00:00:00Z",
    "evaluationVersion": "eval-1",
    "horizonResults": {
      "24h": {
        "directionalCoverage": 0.6666666666666666,
        "effectiveTest": 45,
        "marketRegimeCoverage": 1,
        "postCostLift": 0.003,
        "preCostLift": 0.005,
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "GO",
        "wilson95": {
          "confidenceLevel": 0.95,
          "lower": 0.520704883099,
          "successes": 30,
          "trials": 45,
          "upper": 0.786411250657,
          "z": 1.959963984540054
        }
      },
      "72h": {
        "directionalCoverage": 0.6666666666666666,
        "effectiveTest": 15,
        "marketRegimeCoverage": 0.6666666666666666,
        "postCostLift": 0.003,
        "preCostLift": 0.005,
        "primaryReasonCode": "MARKET_REGIME_COVERAGE_BELOW_THRESHOLD",
        "reasonCodes": [
          "MARKET_REGIME_COVERAGE_BELOW_THRESHOLD"
        ],
        "status": "CONDITIONAL_GO",
        "wilson95": {
          "confidenceLevel": 0.95,
          "lower": 0.417135477385,
          "successes": 10,
          "trials": 15,
          "upper": 0.848236755603,
          "z": 1.959963984540054
        }
      }
    },
    "overall": {
      "primaryReasonCode": "MARKET_REGIME_COVERAGE_BELOW_THRESHOLD",
      "reasonCodes": [
        "MARKET_REGIME_COVERAGE_BELOW_THRESHOLD"
      ],
      "status": "CONDITIONAL_GO"
    },
    "primaryReasonCode": "MARKET_REGIME_COVERAGE_BELOW_THRESHOLD",
    "reasonCodes": [
      "MARKET_REGIME_COVERAGE_BELOW_THRESHOLD"
    ],
    "schemaVersion": "v1.4d-go-no-go-output/2",
    "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
  }
}
```

#### 向量 `COVERAGE_NULL`

输入Schema：`PASS`；overall=`DATA_GATE_FAILED`；primary=`COVERAGE_NULL`。

```json
{
  "input": {
    "auditTrail": {
      "authenticityGateStatus": "PASSED",
      "backfillBatchIds": [
        "223e4567-e89b-42d3-a456-426614174001"
      ],
      "datasetVersion": "v1.4d-sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "evaluatedAt": "2026-01-02T00:00:00Z",
      "evaluationVersion": "eval-1",
      "featureCoverage": 1,
      "generationSummary": {
        "attempted": 80,
        "blocked": 0,
        "conflicts": 0,
        "evaluated": 80,
        "expected": 80,
        "inserted": 80,
        "reusedIdentical": 0
      },
      "manifestContentHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "manifestCoverage": 1,
      "schemaVersion": "v1.4d-audit-trail/1",
      "validationRunId": "123e4567-e89b-42d3-a456-426614174000",
      "validationRunStatus": "SUCCEEDED",
      "vintageIds": [
        "vintage-1"
      ]
    },
    "baselineAvailabilityInput": {
      "24h": {
        "alwaysRange": {
          "macroF1": 0.3,
          "postCostExpectedReturn": -0.001,
          "preCostExpectedReturn": 0.001,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        },
        "follow4hTrend": {
          "macroF1": 0.45,
          "postCostExpectedReturn": 0.001,
          "preCostExpectedReturn": 0.003,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        },
        "historicalProportionRandom": {
          "macroF1": 0.34,
          "postCostExpectedReturn": 0,
          "preCostExpectedReturn": 0.002,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        }
      },
      "72h": {
        "alwaysRange": {
          "macroF1": 0.3,
          "postCostExpectedReturn": -0.001,
          "preCostExpectedReturn": 0.001,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        },
        "follow4hTrend": {
          "macroF1": 0.45,
          "postCostExpectedReturn": 0.001,
          "preCostExpectedReturn": 0.003,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        },
        "historicalProportionRandom": {
          "macroF1": 0.34,
          "postCostExpectedReturn": 0,
          "preCostExpectedReturn": 0.002,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        }
      }
    },
    "directionalCoverage": {
      "24h": null,
      "72h": 0.6666666666666666
    },
    "evaluatedAt": "2026-01-02T00:00:00Z",
    "evaluationVersion": "eval-1",
    "marketRegimeAtGeneration": {
      "24h": {
        "DOWN": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        },
        "RANGE": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        },
        "UP": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        }
      },
      "72h": {
        "DOWN": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        },
        "RANGE": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        },
        "UP": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        }
      }
    },
    "marketRegimeCoverage": {
      "24h": 1,
      "72h": 1
    },
    "postCostLift": {
      "24h": 0.003,
      "72h": 0.003
    },
    "preCostLift": {
      "24h": 0.005,
      "72h": 0.005
    },
    "predictedDownCount": {
      "24h": 15,
      "72h": 5
    },
    "predictedUpCount": {
      "24h": 15,
      "72h": 5
    },
    "rangeAttribution": {
      "24h": {
        "allPredictionsRange": false,
        "correctlyPredictedRangeCount": 14,
        "predictedRangeCount": 15,
        "rangeTotal": 15
      },
      "72h": {
        "allPredictionsRange": false,
        "correctlyPredictedRangeCount": 4,
        "predictedRangeCount": 5,
        "rangeTotal": 5
      }
    },
    "sampleAccounting": {
      "24h": {
        "classEffectiveTest": {
          "DOWN": 15,
          "RANGE": 15,
          "UP": 15
        },
        "effectiveTest": 45,
        "predictedDownCount": 15,
        "predictedRangeCount": 15,
        "predictedUpCount": 15,
        "rawTest": 270
      },
      "72h": {
        "classEffectiveTest": {
          "DOWN": 5,
          "RANGE": 5,
          "UP": 5
        },
        "effectiveTest": 15,
        "predictedDownCount": 5,
        "predictedRangeCount": 5,
        "predictedUpCount": 5,
        "rawTest": 45
      }
    },
    "schemaVersion": "v1.4d-go-no-go-input/2",
    "scorecard": {
      "evaluatedAt": "2026-01-02T00:00:00Z",
      "evaluationVersion": "eval-1",
      "horizons": {
        "24h": {
          "baselines": {
            "alwaysRange": {
              "macroF1": 0.3,
              "postCostExpectedReturn": -0.001,
              "preCostExpectedReturn": 0.001,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            },
            "follow4hTrend": {
              "macroF1": 0.45,
              "postCostExpectedReturn": 0.001,
              "preCostExpectedReturn": 0.003,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            },
            "historicalProportionRandom": {
              "macroF1": 0.34,
              "postCostExpectedReturn": 0,
              "preCostExpectedReturn": 0.002,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            }
          },
          "model": {
            "directionCorrectCount": 30,
            "macroF1": 0.62,
            "postCostExpectedReturn": 0.004,
            "preCostExpectedReturn": 0.008
          }
        },
        "72h": {
          "baselines": {
            "alwaysRange": {
              "macroF1": 0.3,
              "postCostExpectedReturn": -0.001,
              "preCostExpectedReturn": 0.001,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            },
            "follow4hTrend": {
              "macroF1": 0.45,
              "postCostExpectedReturn": 0.001,
              "preCostExpectedReturn": 0.003,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            },
            "historicalProportionRandom": {
              "macroF1": 0.34,
              "postCostExpectedReturn": 0,
              "preCostExpectedReturn": 0.002,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            }
          },
          "model": {
            "directionCorrectCount": 10,
            "macroF1": 0.62,
            "postCostExpectedReturn": 0.004,
            "preCostExpectedReturn": 0.008
          }
        }
      },
      "schemaVersion": "v1.4d-research-scorecard/4-deterministic",
      "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
    },
    "thresholds": {
      "minClassEffectiveTest": {
        "24h": 5,
        "72h": 2
      },
      "minDirectionalCoverage": {
        "24h": 0.5,
        "72h": 0.5
      },
      "minEffectiveTest": {
        "24h": 30,
        "72h": 10
      },
      "minMarketRegimeCoverage": {
        "24h": 0.9,
        "72h": 0.9
      },
      "minPostCostLift": {
        "24h": 0,
        "72h": 0
      },
      "minPreCostLift": {
        "24h": 0.001,
        "72h": 0.001
      },
      "minWilsonLowerBound": {
        "24h": 0.45,
        "72h": 0.35
      },
      "requireAllBaselines": true,
      "requireMarketRegime": true,
      "schemaVersion": "v1.4d-go-no-go-thresholds/1"
    },
    "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
  },
  "output": {
    "baselineAvailability": {
      "24h": {
        "postCostReferenceBaseline": "follow4hTrend",
        "preCostReferenceBaseline": "follow4hTrend",
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "AVAILABLE",
        "usableBaselines": [
          "alwaysRange",
          "follow4hTrend",
          "historicalProportionRandom"
        ]
      },
      "72h": {
        "postCostReferenceBaseline": "follow4hTrend",
        "preCostReferenceBaseline": "follow4hTrend",
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "AVAILABLE",
        "usableBaselines": [
          "alwaysRange",
          "follow4hTrend",
          "historicalProportionRandom"
        ]
      }
    },
    "evaluatedAt": "2026-01-02T00:00:00Z",
    "evaluationVersion": "eval-1",
    "horizonResults": {
      "24h": {
        "directionalCoverage": null,
        "effectiveTest": 45,
        "marketRegimeCoverage": 1,
        "postCostLift": 0.003,
        "preCostLift": 0.005,
        "primaryReasonCode": "COVERAGE_NULL",
        "reasonCodes": [
          "COVERAGE_NULL"
        ],
        "status": "DATA_GATE_FAILED",
        "wilson95": {
          "confidenceLevel": 0.95,
          "lower": 0.520704883099,
          "successes": 30,
          "trials": 45,
          "upper": 0.786411250657,
          "z": 1.959963984540054
        }
      },
      "72h": {
        "directionalCoverage": 0.6666666666666666,
        "effectiveTest": 15,
        "marketRegimeCoverage": 1,
        "postCostLift": 0.003,
        "preCostLift": 0.005,
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "GO",
        "wilson95": {
          "confidenceLevel": 0.95,
          "lower": 0.417135477385,
          "successes": 10,
          "trials": 15,
          "upper": 0.848236755603,
          "z": 1.959963984540054
        }
      }
    },
    "overall": {
      "primaryReasonCode": "COVERAGE_NULL",
      "reasonCodes": [
        "COVERAGE_NULL"
      ],
      "status": "DATA_GATE_FAILED"
    },
    "primaryReasonCode": "COVERAGE_NULL",
    "reasonCodes": [
      "COVERAGE_NULL"
    ],
    "schemaVersion": "v1.4d-go-no-go-output/2",
    "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
  }
}
```

#### 向量 `DATA_GATE_FAILED`

输入Schema：`PASS`；overall=`DATA_GATE_FAILED`；primary=`FEATURE_COVERAGE_INCOMPLETE`。

```json
{
  "input": {
    "auditTrail": {
      "authenticityGateStatus": "PASSED",
      "backfillBatchIds": [
        "223e4567-e89b-42d3-a456-426614174001"
      ],
      "datasetVersion": "v1.4d-sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "evaluatedAt": "2026-01-02T00:00:00Z",
      "evaluationVersion": "eval-1",
      "featureCoverage": 0.9,
      "generationSummary": {
        "attempted": 80,
        "blocked": 0,
        "conflicts": 0,
        "evaluated": 80,
        "expected": 80,
        "inserted": 80,
        "reusedIdentical": 0
      },
      "manifestContentHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "manifestCoverage": 1,
      "schemaVersion": "v1.4d-audit-trail/1",
      "validationRunId": "123e4567-e89b-42d3-a456-426614174000",
      "validationRunStatus": "SUCCEEDED",
      "vintageIds": [
        "vintage-1"
      ]
    },
    "baselineAvailabilityInput": {
      "24h": {
        "alwaysRange": {
          "macroF1": 0.3,
          "postCostExpectedReturn": -0.001,
          "preCostExpectedReturn": 0.001,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        },
        "follow4hTrend": {
          "macroF1": 0.45,
          "postCostExpectedReturn": 0.001,
          "preCostExpectedReturn": 0.003,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        },
        "historicalProportionRandom": {
          "macroF1": 0.34,
          "postCostExpectedReturn": 0,
          "preCostExpectedReturn": 0.002,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        }
      },
      "72h": {
        "alwaysRange": {
          "macroF1": 0.3,
          "postCostExpectedReturn": -0.001,
          "preCostExpectedReturn": 0.001,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        },
        "follow4hTrend": {
          "macroF1": 0.45,
          "postCostExpectedReturn": 0.001,
          "preCostExpectedReturn": 0.003,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        },
        "historicalProportionRandom": {
          "macroF1": 0.34,
          "postCostExpectedReturn": 0,
          "preCostExpectedReturn": 0.002,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        }
      }
    },
    "directionalCoverage": {
      "24h": 0.6666666666666666,
      "72h": 0.6666666666666666
    },
    "evaluatedAt": "2026-01-02T00:00:00Z",
    "evaluationVersion": "eval-1",
    "marketRegimeAtGeneration": {
      "24h": {
        "DOWN": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        },
        "RANGE": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        },
        "UP": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        }
      },
      "72h": {
        "DOWN": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        },
        "RANGE": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        },
        "UP": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        }
      }
    },
    "marketRegimeCoverage": {
      "24h": 1,
      "72h": 1
    },
    "postCostLift": {
      "24h": 0.003,
      "72h": 0.003
    },
    "preCostLift": {
      "24h": 0.005,
      "72h": 0.005
    },
    "predictedDownCount": {
      "24h": 15,
      "72h": 5
    },
    "predictedUpCount": {
      "24h": 15,
      "72h": 5
    },
    "rangeAttribution": {
      "24h": {
        "allPredictionsRange": false,
        "correctlyPredictedRangeCount": 14,
        "predictedRangeCount": 15,
        "rangeTotal": 15
      },
      "72h": {
        "allPredictionsRange": false,
        "correctlyPredictedRangeCount": 4,
        "predictedRangeCount": 5,
        "rangeTotal": 5
      }
    },
    "sampleAccounting": {
      "24h": {
        "classEffectiveTest": {
          "DOWN": 15,
          "RANGE": 15,
          "UP": 15
        },
        "effectiveTest": 45,
        "predictedDownCount": 15,
        "predictedRangeCount": 15,
        "predictedUpCount": 15,
        "rawTest": 270
      },
      "72h": {
        "classEffectiveTest": {
          "DOWN": 5,
          "RANGE": 5,
          "UP": 5
        },
        "effectiveTest": 15,
        "predictedDownCount": 5,
        "predictedRangeCount": 5,
        "predictedUpCount": 5,
        "rawTest": 45
      }
    },
    "schemaVersion": "v1.4d-go-no-go-input/2",
    "scorecard": {
      "evaluatedAt": "2026-01-02T00:00:00Z",
      "evaluationVersion": "eval-1",
      "horizons": {
        "24h": {
          "baselines": {
            "alwaysRange": {
              "macroF1": 0.3,
              "postCostExpectedReturn": -0.001,
              "preCostExpectedReturn": 0.001,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            },
            "follow4hTrend": {
              "macroF1": 0.45,
              "postCostExpectedReturn": 0.001,
              "preCostExpectedReturn": 0.003,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            },
            "historicalProportionRandom": {
              "macroF1": 0.34,
              "postCostExpectedReturn": 0,
              "preCostExpectedReturn": 0.002,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            }
          },
          "model": {
            "directionCorrectCount": 30,
            "macroF1": 0.62,
            "postCostExpectedReturn": 0.004,
            "preCostExpectedReturn": 0.008
          }
        },
        "72h": {
          "baselines": {
            "alwaysRange": {
              "macroF1": 0.3,
              "postCostExpectedReturn": -0.001,
              "preCostExpectedReturn": 0.001,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            },
            "follow4hTrend": {
              "macroF1": 0.45,
              "postCostExpectedReturn": 0.001,
              "preCostExpectedReturn": 0.003,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            },
            "historicalProportionRandom": {
              "macroF1": 0.34,
              "postCostExpectedReturn": 0,
              "preCostExpectedReturn": 0.002,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            }
          },
          "model": {
            "directionCorrectCount": 10,
            "macroF1": 0.62,
            "postCostExpectedReturn": 0.004,
            "preCostExpectedReturn": 0.008
          }
        }
      },
      "schemaVersion": "v1.4d-research-scorecard/4-deterministic",
      "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
    },
    "thresholds": {
      "minClassEffectiveTest": {
        "24h": 5,
        "72h": 2
      },
      "minDirectionalCoverage": {
        "24h": 0.5,
        "72h": 0.5
      },
      "minEffectiveTest": {
        "24h": 30,
        "72h": 10
      },
      "minMarketRegimeCoverage": {
        "24h": 0.9,
        "72h": 0.9
      },
      "minPostCostLift": {
        "24h": 0,
        "72h": 0
      },
      "minPreCostLift": {
        "24h": 0.001,
        "72h": 0.001
      },
      "minWilsonLowerBound": {
        "24h": 0.45,
        "72h": 0.35
      },
      "requireAllBaselines": true,
      "requireMarketRegime": true,
      "schemaVersion": "v1.4d-go-no-go-thresholds/1"
    },
    "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
  },
  "output": {
    "baselineAvailability": {
      "24h": {
        "postCostReferenceBaseline": "follow4hTrend",
        "preCostReferenceBaseline": "follow4hTrend",
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "AVAILABLE",
        "usableBaselines": [
          "alwaysRange",
          "follow4hTrend",
          "historicalProportionRandom"
        ]
      },
      "72h": {
        "postCostReferenceBaseline": "follow4hTrend",
        "preCostReferenceBaseline": "follow4hTrend",
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "AVAILABLE",
        "usableBaselines": [
          "alwaysRange",
          "follow4hTrend",
          "historicalProportionRandom"
        ]
      }
    },
    "evaluatedAt": "2026-01-02T00:00:00Z",
    "evaluationVersion": "eval-1",
    "horizonResults": {
      "24h": {
        "directionalCoverage": 0.6666666666666666,
        "effectiveTest": 45,
        "marketRegimeCoverage": 1,
        "postCostLift": 0.003,
        "preCostLift": 0.005,
        "primaryReasonCode": "FEATURE_COVERAGE_INCOMPLETE",
        "reasonCodes": [
          "FEATURE_COVERAGE_INCOMPLETE"
        ],
        "status": "DATA_GATE_FAILED",
        "wilson95": {
          "confidenceLevel": 0.95,
          "lower": 0.520704883099,
          "successes": 30,
          "trials": 45,
          "upper": 0.786411250657,
          "z": 1.959963984540054
        }
      },
      "72h": {
        "directionalCoverage": 0.6666666666666666,
        "effectiveTest": 15,
        "marketRegimeCoverage": 1,
        "postCostLift": 0.003,
        "preCostLift": 0.005,
        "primaryReasonCode": "FEATURE_COVERAGE_INCOMPLETE",
        "reasonCodes": [
          "FEATURE_COVERAGE_INCOMPLETE"
        ],
        "status": "DATA_GATE_FAILED",
        "wilson95": {
          "confidenceLevel": 0.95,
          "lower": 0.417135477385,
          "successes": 10,
          "trials": 15,
          "upper": 0.848236755603,
          "z": 1.959963984540054
        }
      }
    },
    "overall": {
      "primaryReasonCode": "FEATURE_COVERAGE_INCOMPLETE",
      "reasonCodes": [
        "FEATURE_COVERAGE_INCOMPLETE"
      ],
      "status": "DATA_GATE_FAILED"
    },
    "primaryReasonCode": "FEATURE_COVERAGE_INCOMPLETE",
    "reasonCodes": [
      "FEATURE_COVERAGE_INCOMPLETE"
    ],
    "schemaVersion": "v1.4d-go-no-go-output/2",
    "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
  }
}
```

#### 向量 `EFFECTIVE_TEST_ZERO`

输入Schema：`PASS`；overall=`DATA_GATE_FAILED`；primary=`INPUT_CONSISTENCY_FAILED`。

```json
{
  "input": {
    "auditTrail": {
      "authenticityGateStatus": "PASSED",
      "backfillBatchIds": [
        "223e4567-e89b-42d3-a456-426614174001"
      ],
      "datasetVersion": "v1.4d-sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "evaluatedAt": "2026-01-02T00:00:00Z",
      "evaluationVersion": "eval-1",
      "featureCoverage": 1,
      "generationSummary": {
        "attempted": 80,
        "blocked": 0,
        "conflicts": 0,
        "evaluated": 80,
        "expected": 80,
        "inserted": 80,
        "reusedIdentical": 0
      },
      "manifestContentHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "manifestCoverage": 1,
      "schemaVersion": "v1.4d-audit-trail/1",
      "validationRunId": "123e4567-e89b-42d3-a456-426614174000",
      "validationRunStatus": "SUCCEEDED",
      "vintageIds": [
        "vintage-1"
      ]
    },
    "baselineAvailabilityInput": {
      "24h": {
        "alwaysRange": {
          "macroF1": 0.3,
          "postCostExpectedReturn": -0.001,
          "preCostExpectedReturn": 0.001,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        },
        "follow4hTrend": {
          "macroF1": 0.45,
          "postCostExpectedReturn": 0.001,
          "preCostExpectedReturn": 0.003,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        },
        "historicalProportionRandom": {
          "macroF1": 0.34,
          "postCostExpectedReturn": 0,
          "preCostExpectedReturn": 0.002,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        }
      },
      "72h": {
        "alwaysRange": {
          "macroF1": 0.3,
          "postCostExpectedReturn": -0.001,
          "preCostExpectedReturn": 0.001,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        },
        "follow4hTrend": {
          "macroF1": 0.45,
          "postCostExpectedReturn": 0.001,
          "preCostExpectedReturn": 0.003,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        },
        "historicalProportionRandom": {
          "macroF1": 0.34,
          "postCostExpectedReturn": 0,
          "preCostExpectedReturn": 0.002,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        }
      }
    },
    "directionalCoverage": {
      "24h": 0.6666666666666666,
      "72h": null
    },
    "evaluatedAt": "2026-01-02T00:00:00Z",
    "evaluationVersion": "eval-1",
    "marketRegimeAtGeneration": {
      "24h": {
        "DOWN": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        },
        "RANGE": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        },
        "UP": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        }
      },
      "72h": {
        "DOWN": {
          "directionCorrectCount": 0,
          "sampleCount": 0
        },
        "RANGE": {
          "directionCorrectCount": 0,
          "sampleCount": 0
        },
        "UP": {
          "directionCorrectCount": 0,
          "sampleCount": 0
        }
      }
    },
    "marketRegimeCoverage": {
      "24h": 1,
      "72h": null
    },
    "postCostLift": {
      "24h": 0.003,
      "72h": null
    },
    "preCostLift": {
      "24h": 0.005,
      "72h": null
    },
    "predictedDownCount": {
      "24h": 15,
      "72h": 0
    },
    "predictedUpCount": {
      "24h": 15,
      "72h": 0
    },
    "rangeAttribution": {
      "24h": {
        "allPredictionsRange": false,
        "correctlyPredictedRangeCount": 14,
        "predictedRangeCount": 15,
        "rangeTotal": 15
      },
      "72h": {
        "allPredictionsRange": false,
        "correctlyPredictedRangeCount": 0,
        "predictedRangeCount": 0,
        "rangeTotal": 0
      }
    },
    "sampleAccounting": {
      "24h": {
        "classEffectiveTest": {
          "DOWN": 15,
          "RANGE": 15,
          "UP": 15
        },
        "effectiveTest": 45,
        "predictedDownCount": 15,
        "predictedRangeCount": 15,
        "predictedUpCount": 15,
        "rawTest": 270
      },
      "72h": {
        "classEffectiveTest": {
          "DOWN": 0,
          "RANGE": 0,
          "UP": 0
        },
        "effectiveTest": 0,
        "predictedDownCount": 0,
        "predictedRangeCount": 0,
        "predictedUpCount": 0,
        "rawTest": 0
      }
    },
    "schemaVersion": "v1.4d-go-no-go-input/2",
    "scorecard": {
      "evaluatedAt": "2026-01-02T00:00:00Z",
      "evaluationVersion": "eval-1",
      "horizons": {
        "24h": {
          "baselines": {
            "alwaysRange": {
              "macroF1": 0.3,
              "postCostExpectedReturn": -0.001,
              "preCostExpectedReturn": 0.001,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            },
            "follow4hTrend": {
              "macroF1": 0.45,
              "postCostExpectedReturn": 0.001,
              "preCostExpectedReturn": 0.003,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            },
            "historicalProportionRandom": {
              "macroF1": 0.34,
              "postCostExpectedReturn": 0,
              "preCostExpectedReturn": 0.002,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            }
          },
          "model": {
            "directionCorrectCount": 30,
            "macroF1": 0.62,
            "postCostExpectedReturn": 0.004,
            "preCostExpectedReturn": 0.008
          }
        },
        "72h": {
          "baselines": {
            "alwaysRange": {
              "macroF1": 0.3,
              "postCostExpectedReturn": -0.001,
              "preCostExpectedReturn": 0.001,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            },
            "follow4hTrend": {
              "macroF1": 0.45,
              "postCostExpectedReturn": 0.001,
              "preCostExpectedReturn": 0.003,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            },
            "historicalProportionRandom": {
              "macroF1": 0.34,
              "postCostExpectedReturn": 0,
              "preCostExpectedReturn": 0.002,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            }
          },
          "model": {
            "directionCorrectCount": 0,
            "macroF1": 0.62,
            "postCostExpectedReturn": 0.004,
            "preCostExpectedReturn": 0.008
          }
        }
      },
      "schemaVersion": "v1.4d-research-scorecard/4-deterministic",
      "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
    },
    "thresholds": {
      "minClassEffectiveTest": {
        "24h": 5,
        "72h": 2
      },
      "minDirectionalCoverage": {
        "24h": 0.5,
        "72h": 0.5
      },
      "minEffectiveTest": {
        "24h": 30,
        "72h": 10
      },
      "minMarketRegimeCoverage": {
        "24h": 0.9,
        "72h": 0.9
      },
      "minPostCostLift": {
        "24h": 0,
        "72h": 0
      },
      "minPreCostLift": {
        "24h": 0.001,
        "72h": 0.001
      },
      "minWilsonLowerBound": {
        "24h": 0.45,
        "72h": 0.35
      },
      "requireAllBaselines": true,
      "requireMarketRegime": true,
      "schemaVersion": "v1.4d-go-no-go-thresholds/1"
    },
    "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
  },
  "output": {
    "baselineAvailability": {
      "24h": {
        "postCostReferenceBaseline": "follow4hTrend",
        "preCostReferenceBaseline": "follow4hTrend",
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "AVAILABLE",
        "usableBaselines": [
          "alwaysRange",
          "follow4hTrend",
          "historicalProportionRandom"
        ]
      },
      "72h": {
        "postCostReferenceBaseline": "follow4hTrend",
        "preCostReferenceBaseline": "follow4hTrend",
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "AVAILABLE",
        "usableBaselines": [
          "alwaysRange",
          "follow4hTrend",
          "historicalProportionRandom"
        ]
      }
    },
    "evaluatedAt": "2026-01-02T00:00:00Z",
    "evaluationVersion": "eval-1",
    "horizonResults": {
      "24h": {
        "directionalCoverage": 0.6666666666666666,
        "effectiveTest": 45,
        "marketRegimeCoverage": 1,
        "postCostLift": 0.003,
        "preCostLift": 0.005,
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "GO",
        "wilson95": {
          "confidenceLevel": 0.95,
          "lower": 0.520704883099,
          "successes": 30,
          "trials": 45,
          "upper": 0.786411250657,
          "z": 1.959963984540054
        }
      },
      "72h": {
        "directionalCoverage": null,
        "effectiveTest": 0,
        "marketRegimeCoverage": null,
        "postCostLift": 0.003,
        "preCostLift": 0.005,
        "primaryReasonCode": "INPUT_CONSISTENCY_FAILED",
        "reasonCodes": [
          "INPUT_CONSISTENCY_FAILED",
          "EFFECTIVE_TEST_ZERO",
          "COVERAGE_NULL",
          "LIFT_NULL",
          "RANGE_CLASS_ABSENT"
        ],
        "status": "DATA_GATE_FAILED",
        "wilson95": {
          "confidenceLevel": 0.95,
          "lower": null,
          "successes": 0,
          "trials": 0,
          "upper": null,
          "z": 1.959963984540054
        }
      }
    },
    "overall": {
      "primaryReasonCode": "INPUT_CONSISTENCY_FAILED",
      "reasonCodes": [
        "INPUT_CONSISTENCY_FAILED",
        "EFFECTIVE_TEST_ZERO",
        "COVERAGE_NULL",
        "LIFT_NULL",
        "RANGE_CLASS_ABSENT"
      ],
      "status": "DATA_GATE_FAILED"
    },
    "primaryReasonCode": "INPUT_CONSISTENCY_FAILED",
    "reasonCodes": [
      "INPUT_CONSISTENCY_FAILED",
      "EFFECTIVE_TEST_ZERO",
      "COVERAGE_NULL",
      "LIFT_NULL",
      "RANGE_CLASS_ABSENT"
    ],
    "schemaVersion": "v1.4d-go-no-go-output/2",
    "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
  }
}
```

#### 向量 `EVALUATED_AT_MISMATCH`

输入Schema：`PASS`；overall=`DATA_GATE_FAILED`；primary=`INPUT_CONSISTENCY_FAILED`。

```json
{
  "input": {
    "auditTrail": {
      "authenticityGateStatus": "PASSED",
      "backfillBatchIds": [
        "223e4567-e89b-42d3-a456-426614174001"
      ],
      "datasetVersion": "v1.4d-sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "evaluatedAt": "2026-01-02T00:00:01Z",
      "evaluationVersion": "eval-1",
      "featureCoverage": 1,
      "generationSummary": {
        "attempted": 80,
        "blocked": 0,
        "conflicts": 0,
        "evaluated": 80,
        "expected": 80,
        "inserted": 80,
        "reusedIdentical": 0
      },
      "manifestContentHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "manifestCoverage": 1,
      "schemaVersion": "v1.4d-audit-trail/1",
      "validationRunId": "123e4567-e89b-42d3-a456-426614174000",
      "validationRunStatus": "SUCCEEDED",
      "vintageIds": [
        "vintage-1"
      ]
    },
    "baselineAvailabilityInput": {
      "24h": {
        "alwaysRange": {
          "macroF1": 0.3,
          "postCostExpectedReturn": -0.001,
          "preCostExpectedReturn": 0.001,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        },
        "follow4hTrend": {
          "macroF1": 0.45,
          "postCostExpectedReturn": 0.001,
          "preCostExpectedReturn": 0.003,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        },
        "historicalProportionRandom": {
          "macroF1": 0.34,
          "postCostExpectedReturn": 0,
          "preCostExpectedReturn": 0.002,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        }
      },
      "72h": {
        "alwaysRange": {
          "macroF1": 0.3,
          "postCostExpectedReturn": -0.001,
          "preCostExpectedReturn": 0.001,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        },
        "follow4hTrend": {
          "macroF1": 0.45,
          "postCostExpectedReturn": 0.001,
          "preCostExpectedReturn": 0.003,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        },
        "historicalProportionRandom": {
          "macroF1": 0.34,
          "postCostExpectedReturn": 0,
          "preCostExpectedReturn": 0.002,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        }
      }
    },
    "directionalCoverage": {
      "24h": 0.6666666666666666,
      "72h": 0.6666666666666666
    },
    "evaluatedAt": "2026-01-02T00:00:00Z",
    "evaluationVersion": "eval-1",
    "marketRegimeAtGeneration": {
      "24h": {
        "DOWN": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        },
        "RANGE": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        },
        "UP": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        }
      },
      "72h": {
        "DOWN": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        },
        "RANGE": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        },
        "UP": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        }
      }
    },
    "marketRegimeCoverage": {
      "24h": 1,
      "72h": 1
    },
    "postCostLift": {
      "24h": 0.003,
      "72h": 0.003
    },
    "preCostLift": {
      "24h": 0.005,
      "72h": 0.005
    },
    "predictedDownCount": {
      "24h": 15,
      "72h": 5
    },
    "predictedUpCount": {
      "24h": 15,
      "72h": 5
    },
    "rangeAttribution": {
      "24h": {
        "allPredictionsRange": false,
        "correctlyPredictedRangeCount": 14,
        "predictedRangeCount": 15,
        "rangeTotal": 15
      },
      "72h": {
        "allPredictionsRange": false,
        "correctlyPredictedRangeCount": 4,
        "predictedRangeCount": 5,
        "rangeTotal": 5
      }
    },
    "sampleAccounting": {
      "24h": {
        "classEffectiveTest": {
          "DOWN": 15,
          "RANGE": 15,
          "UP": 15
        },
        "effectiveTest": 45,
        "predictedDownCount": 15,
        "predictedRangeCount": 15,
        "predictedUpCount": 15,
        "rawTest": 270
      },
      "72h": {
        "classEffectiveTest": {
          "DOWN": 5,
          "RANGE": 5,
          "UP": 5
        },
        "effectiveTest": 15,
        "predictedDownCount": 5,
        "predictedRangeCount": 5,
        "predictedUpCount": 5,
        "rawTest": 45
      }
    },
    "schemaVersion": "v1.4d-go-no-go-input/2",
    "scorecard": {
      "evaluatedAt": "2026-01-02T00:00:00Z",
      "evaluationVersion": "eval-1",
      "horizons": {
        "24h": {
          "baselines": {
            "alwaysRange": {
              "macroF1": 0.3,
              "postCostExpectedReturn": -0.001,
              "preCostExpectedReturn": 0.001,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            },
            "follow4hTrend": {
              "macroF1": 0.45,
              "postCostExpectedReturn": 0.001,
              "preCostExpectedReturn": 0.003,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            },
            "historicalProportionRandom": {
              "macroF1": 0.34,
              "postCostExpectedReturn": 0,
              "preCostExpectedReturn": 0.002,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            }
          },
          "model": {
            "directionCorrectCount": 30,
            "macroF1": 0.62,
            "postCostExpectedReturn": 0.004,
            "preCostExpectedReturn": 0.008
          }
        },
        "72h": {
          "baselines": {
            "alwaysRange": {
              "macroF1": 0.3,
              "postCostExpectedReturn": -0.001,
              "preCostExpectedReturn": 0.001,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            },
            "follow4hTrend": {
              "macroF1": 0.45,
              "postCostExpectedReturn": 0.001,
              "preCostExpectedReturn": 0.003,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            },
            "historicalProportionRandom": {
              "macroF1": 0.34,
              "postCostExpectedReturn": 0,
              "preCostExpectedReturn": 0.002,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            }
          },
          "model": {
            "directionCorrectCount": 10,
            "macroF1": 0.62,
            "postCostExpectedReturn": 0.004,
            "preCostExpectedReturn": 0.008
          }
        }
      },
      "schemaVersion": "v1.4d-research-scorecard/4-deterministic",
      "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
    },
    "thresholds": {
      "minClassEffectiveTest": {
        "24h": 5,
        "72h": 2
      },
      "minDirectionalCoverage": {
        "24h": 0.5,
        "72h": 0.5
      },
      "minEffectiveTest": {
        "24h": 30,
        "72h": 10
      },
      "minMarketRegimeCoverage": {
        "24h": 0.9,
        "72h": 0.9
      },
      "minPostCostLift": {
        "24h": 0,
        "72h": 0
      },
      "minPreCostLift": {
        "24h": 0.001,
        "72h": 0.001
      },
      "minWilsonLowerBound": {
        "24h": 0.45,
        "72h": 0.35
      },
      "requireAllBaselines": true,
      "requireMarketRegime": true,
      "schemaVersion": "v1.4d-go-no-go-thresholds/1"
    },
    "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
  },
  "output": {
    "baselineAvailability": {
      "24h": {
        "postCostReferenceBaseline": "follow4hTrend",
        "preCostReferenceBaseline": "follow4hTrend",
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "AVAILABLE",
        "usableBaselines": [
          "alwaysRange",
          "follow4hTrend",
          "historicalProportionRandom"
        ]
      },
      "72h": {
        "postCostReferenceBaseline": "follow4hTrend",
        "preCostReferenceBaseline": "follow4hTrend",
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "AVAILABLE",
        "usableBaselines": [
          "alwaysRange",
          "follow4hTrend",
          "historicalProportionRandom"
        ]
      }
    },
    "evaluatedAt": "2026-01-02T00:00:00Z",
    "evaluationVersion": "eval-1",
    "horizonResults": {
      "24h": {
        "directionalCoverage": 0.6666666666666666,
        "effectiveTest": 45,
        "marketRegimeCoverage": 1,
        "postCostLift": 0.003,
        "preCostLift": 0.005,
        "primaryReasonCode": "INPUT_CONSISTENCY_FAILED",
        "reasonCodes": [
          "INPUT_CONSISTENCY_FAILED"
        ],
        "status": "DATA_GATE_FAILED",
        "wilson95": {
          "confidenceLevel": 0.95,
          "lower": 0.520704883099,
          "successes": 30,
          "trials": 45,
          "upper": 0.786411250657,
          "z": 1.959963984540054
        }
      },
      "72h": {
        "directionalCoverage": 0.6666666666666666,
        "effectiveTest": 15,
        "marketRegimeCoverage": 1,
        "postCostLift": 0.003,
        "preCostLift": 0.005,
        "primaryReasonCode": "INPUT_CONSISTENCY_FAILED",
        "reasonCodes": [
          "INPUT_CONSISTENCY_FAILED"
        ],
        "status": "DATA_GATE_FAILED",
        "wilson95": {
          "confidenceLevel": 0.95,
          "lower": 0.417135477385,
          "successes": 10,
          "trials": 15,
          "upper": 0.848236755603,
          "z": 1.959963984540054
        }
      }
    },
    "overall": {
      "primaryReasonCode": "INPUT_CONSISTENCY_FAILED",
      "reasonCodes": [
        "INPUT_CONSISTENCY_FAILED"
      ],
      "status": "DATA_GATE_FAILED"
    },
    "primaryReasonCode": "INPUT_CONSISTENCY_FAILED",
    "reasonCodes": [
      "INPUT_CONSISTENCY_FAILED"
    ],
    "schemaVersion": "v1.4d-go-no-go-output/2",
    "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
  }
}
```

#### 向量 `GO`

输入Schema：`PASS`；overall=`GO`；primary=`NONE`。

```json
{
  "input": {
    "auditTrail": {
      "authenticityGateStatus": "PASSED",
      "backfillBatchIds": [
        "223e4567-e89b-42d3-a456-426614174001"
      ],
      "datasetVersion": "v1.4d-sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "evaluatedAt": "2026-01-02T00:00:00Z",
      "evaluationVersion": "eval-1",
      "featureCoverage": 1,
      "generationSummary": {
        "attempted": 80,
        "blocked": 0,
        "conflicts": 0,
        "evaluated": 80,
        "expected": 80,
        "inserted": 80,
        "reusedIdentical": 0
      },
      "manifestContentHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "manifestCoverage": 1,
      "schemaVersion": "v1.4d-audit-trail/1",
      "validationRunId": "123e4567-e89b-42d3-a456-426614174000",
      "validationRunStatus": "SUCCEEDED",
      "vintageIds": [
        "vintage-1"
      ]
    },
    "baselineAvailabilityInput": {
      "24h": {
        "alwaysRange": {
          "macroF1": 0.3,
          "postCostExpectedReturn": -0.001,
          "preCostExpectedReturn": 0.001,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        },
        "follow4hTrend": {
          "macroF1": 0.45,
          "postCostExpectedReturn": 0.001,
          "preCostExpectedReturn": 0.003,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        },
        "historicalProportionRandom": {
          "macroF1": 0.34,
          "postCostExpectedReturn": 0,
          "preCostExpectedReturn": 0.002,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        }
      },
      "72h": {
        "alwaysRange": {
          "macroF1": 0.3,
          "postCostExpectedReturn": -0.001,
          "preCostExpectedReturn": 0.001,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        },
        "follow4hTrend": {
          "macroF1": 0.45,
          "postCostExpectedReturn": 0.001,
          "preCostExpectedReturn": 0.003,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        },
        "historicalProportionRandom": {
          "macroF1": 0.34,
          "postCostExpectedReturn": 0,
          "preCostExpectedReturn": 0.002,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        }
      }
    },
    "directionalCoverage": {
      "24h": 0.6666666666666666,
      "72h": 0.6666666666666666
    },
    "evaluatedAt": "2026-01-02T00:00:00Z",
    "evaluationVersion": "eval-1",
    "marketRegimeAtGeneration": {
      "24h": {
        "DOWN": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        },
        "RANGE": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        },
        "UP": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        }
      },
      "72h": {
        "DOWN": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        },
        "RANGE": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        },
        "UP": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        }
      }
    },
    "marketRegimeCoverage": {
      "24h": 1,
      "72h": 1
    },
    "postCostLift": {
      "24h": 0.003,
      "72h": 0.003
    },
    "preCostLift": {
      "24h": 0.005,
      "72h": 0.005
    },
    "predictedDownCount": {
      "24h": 15,
      "72h": 5
    },
    "predictedUpCount": {
      "24h": 15,
      "72h": 5
    },
    "rangeAttribution": {
      "24h": {
        "allPredictionsRange": false,
        "correctlyPredictedRangeCount": 14,
        "predictedRangeCount": 15,
        "rangeTotal": 15
      },
      "72h": {
        "allPredictionsRange": false,
        "correctlyPredictedRangeCount": 4,
        "predictedRangeCount": 5,
        "rangeTotal": 5
      }
    },
    "sampleAccounting": {
      "24h": {
        "classEffectiveTest": {
          "DOWN": 15,
          "RANGE": 15,
          "UP": 15
        },
        "effectiveTest": 45,
        "predictedDownCount": 15,
        "predictedRangeCount": 15,
        "predictedUpCount": 15,
        "rawTest": 270
      },
      "72h": {
        "classEffectiveTest": {
          "DOWN": 5,
          "RANGE": 5,
          "UP": 5
        },
        "effectiveTest": 15,
        "predictedDownCount": 5,
        "predictedRangeCount": 5,
        "predictedUpCount": 5,
        "rawTest": 45
      }
    },
    "schemaVersion": "v1.4d-go-no-go-input/2",
    "scorecard": {
      "evaluatedAt": "2026-01-02T00:00:00Z",
      "evaluationVersion": "eval-1",
      "horizons": {
        "24h": {
          "baselines": {
            "alwaysRange": {
              "macroF1": 0.3,
              "postCostExpectedReturn": -0.001,
              "preCostExpectedReturn": 0.001,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            },
            "follow4hTrend": {
              "macroF1": 0.45,
              "postCostExpectedReturn": 0.001,
              "preCostExpectedReturn": 0.003,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            },
            "historicalProportionRandom": {
              "macroF1": 0.34,
              "postCostExpectedReturn": 0,
              "preCostExpectedReturn": 0.002,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            }
          },
          "model": {
            "directionCorrectCount": 30,
            "macroF1": 0.62,
            "postCostExpectedReturn": 0.004,
            "preCostExpectedReturn": 0.008
          }
        },
        "72h": {
          "baselines": {
            "alwaysRange": {
              "macroF1": 0.3,
              "postCostExpectedReturn": -0.001,
              "preCostExpectedReturn": 0.001,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            },
            "follow4hTrend": {
              "macroF1": 0.45,
              "postCostExpectedReturn": 0.001,
              "preCostExpectedReturn": 0.003,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            },
            "historicalProportionRandom": {
              "macroF1": 0.34,
              "postCostExpectedReturn": 0,
              "preCostExpectedReturn": 0.002,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            }
          },
          "model": {
            "directionCorrectCount": 10,
            "macroF1": 0.62,
            "postCostExpectedReturn": 0.004,
            "preCostExpectedReturn": 0.008
          }
        }
      },
      "schemaVersion": "v1.4d-research-scorecard/4-deterministic",
      "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
    },
    "thresholds": {
      "minClassEffectiveTest": {
        "24h": 5,
        "72h": 2
      },
      "minDirectionalCoverage": {
        "24h": 0.5,
        "72h": 0.5
      },
      "minEffectiveTest": {
        "24h": 30,
        "72h": 10
      },
      "minMarketRegimeCoverage": {
        "24h": 0.9,
        "72h": 0.9
      },
      "minPostCostLift": {
        "24h": 0,
        "72h": 0
      },
      "minPreCostLift": {
        "24h": 0.001,
        "72h": 0.001
      },
      "minWilsonLowerBound": {
        "24h": 0.45,
        "72h": 0.35
      },
      "requireAllBaselines": true,
      "requireMarketRegime": true,
      "schemaVersion": "v1.4d-go-no-go-thresholds/1"
    },
    "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
  },
  "output": {
    "baselineAvailability": {
      "24h": {
        "postCostReferenceBaseline": "follow4hTrend",
        "preCostReferenceBaseline": "follow4hTrend",
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "AVAILABLE",
        "usableBaselines": [
          "alwaysRange",
          "follow4hTrend",
          "historicalProportionRandom"
        ]
      },
      "72h": {
        "postCostReferenceBaseline": "follow4hTrend",
        "preCostReferenceBaseline": "follow4hTrend",
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "AVAILABLE",
        "usableBaselines": [
          "alwaysRange",
          "follow4hTrend",
          "historicalProportionRandom"
        ]
      }
    },
    "evaluatedAt": "2026-01-02T00:00:00Z",
    "evaluationVersion": "eval-1",
    "horizonResults": {
      "24h": {
        "directionalCoverage": 0.6666666666666666,
        "effectiveTest": 45,
        "marketRegimeCoverage": 1,
        "postCostLift": 0.003,
        "preCostLift": 0.005,
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "GO",
        "wilson95": {
          "confidenceLevel": 0.95,
          "lower": 0.520704883099,
          "successes": 30,
          "trials": 45,
          "upper": 0.786411250657,
          "z": 1.959963984540054
        }
      },
      "72h": {
        "directionalCoverage": 0.6666666666666666,
        "effectiveTest": 15,
        "marketRegimeCoverage": 1,
        "postCostLift": 0.003,
        "preCostLift": 0.005,
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "GO",
        "wilson95": {
          "confidenceLevel": 0.95,
          "lower": 0.417135477385,
          "successes": 10,
          "trials": 15,
          "upper": 0.848236755603,
          "z": 1.959963984540054
        }
      }
    },
    "overall": {
      "primaryReasonCode": "NONE",
      "reasonCodes": [],
      "status": "GO"
    },
    "primaryReasonCode": "NONE",
    "reasonCodes": [],
    "schemaVersion": "v1.4d-go-no-go-output/2",
    "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
  }
}
```

#### 向量 `HORIZON_MIXED`

输入Schema：`PASS`；overall=`CONDITIONAL_GO`；primary=`PRE_COST_LIFT_BELOW_THRESHOLD`。

```json
{
  "input": {
    "auditTrail": {
      "authenticityGateStatus": "PASSED",
      "backfillBatchIds": [
        "223e4567-e89b-42d3-a456-426614174001"
      ],
      "datasetVersion": "v1.4d-sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "evaluatedAt": "2026-01-02T00:00:00Z",
      "evaluationVersion": "eval-1",
      "featureCoverage": 1,
      "generationSummary": {
        "attempted": 80,
        "blocked": 0,
        "conflicts": 0,
        "evaluated": 80,
        "expected": 80,
        "inserted": 80,
        "reusedIdentical": 0
      },
      "manifestContentHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "manifestCoverage": 1,
      "schemaVersion": "v1.4d-audit-trail/1",
      "validationRunId": "123e4567-e89b-42d3-a456-426614174000",
      "validationRunStatus": "SUCCEEDED",
      "vintageIds": [
        "vintage-1"
      ]
    },
    "baselineAvailabilityInput": {
      "24h": {
        "alwaysRange": {
          "macroF1": 0.3,
          "postCostExpectedReturn": -0.001,
          "preCostExpectedReturn": 0.001,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        },
        "follow4hTrend": {
          "macroF1": 0.45,
          "postCostExpectedReturn": 0.001,
          "preCostExpectedReturn": 0.003,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        },
        "historicalProportionRandom": {
          "macroF1": 0.34,
          "postCostExpectedReturn": 0,
          "preCostExpectedReturn": 0.002,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        }
      },
      "72h": {
        "alwaysRange": {
          "macroF1": 0.3,
          "postCostExpectedReturn": -0.001,
          "preCostExpectedReturn": 0.001,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        },
        "follow4hTrend": {
          "macroF1": 0.45,
          "postCostExpectedReturn": 0.001,
          "preCostExpectedReturn": 0.003,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        },
        "historicalProportionRandom": {
          "macroF1": 0.34,
          "postCostExpectedReturn": 0,
          "preCostExpectedReturn": 0.002,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        }
      }
    },
    "directionalCoverage": {
      "24h": 0.6666666666666666,
      "72h": 0.6666666666666666
    },
    "evaluatedAt": "2026-01-02T00:00:00Z",
    "evaluationVersion": "eval-1",
    "marketRegimeAtGeneration": {
      "24h": {
        "DOWN": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        },
        "RANGE": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        },
        "UP": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        }
      },
      "72h": {
        "DOWN": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        },
        "RANGE": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        },
        "UP": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        }
      }
    },
    "marketRegimeCoverage": {
      "24h": 1,
      "72h": 1
    },
    "postCostLift": {
      "24h": 0.003,
      "72h": 0.003
    },
    "preCostLift": {
      "24h": 0.005,
      "72h": -0.01
    },
    "predictedDownCount": {
      "24h": 15,
      "72h": 5
    },
    "predictedUpCount": {
      "24h": 15,
      "72h": 5
    },
    "rangeAttribution": {
      "24h": {
        "allPredictionsRange": false,
        "correctlyPredictedRangeCount": 14,
        "predictedRangeCount": 15,
        "rangeTotal": 15
      },
      "72h": {
        "allPredictionsRange": false,
        "correctlyPredictedRangeCount": 4,
        "predictedRangeCount": 5,
        "rangeTotal": 5
      }
    },
    "sampleAccounting": {
      "24h": {
        "classEffectiveTest": {
          "DOWN": 15,
          "RANGE": 15,
          "UP": 15
        },
        "effectiveTest": 45,
        "predictedDownCount": 15,
        "predictedRangeCount": 15,
        "predictedUpCount": 15,
        "rawTest": 270
      },
      "72h": {
        "classEffectiveTest": {
          "DOWN": 5,
          "RANGE": 5,
          "UP": 5
        },
        "effectiveTest": 15,
        "predictedDownCount": 5,
        "predictedRangeCount": 5,
        "predictedUpCount": 5,
        "rawTest": 45
      }
    },
    "schemaVersion": "v1.4d-go-no-go-input/2",
    "scorecard": {
      "evaluatedAt": "2026-01-02T00:00:00Z",
      "evaluationVersion": "eval-1",
      "horizons": {
        "24h": {
          "baselines": {
            "alwaysRange": {
              "macroF1": 0.3,
              "postCostExpectedReturn": -0.001,
              "preCostExpectedReturn": 0.001,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            },
            "follow4hTrend": {
              "macroF1": 0.45,
              "postCostExpectedReturn": 0.001,
              "preCostExpectedReturn": 0.003,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            },
            "historicalProportionRandom": {
              "macroF1": 0.34,
              "postCostExpectedReturn": 0,
              "preCostExpectedReturn": 0.002,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            }
          },
          "model": {
            "directionCorrectCount": 30,
            "macroF1": 0.62,
            "postCostExpectedReturn": 0.004,
            "preCostExpectedReturn": 0.008
          }
        },
        "72h": {
          "baselines": {
            "alwaysRange": {
              "macroF1": 0.3,
              "postCostExpectedReturn": -0.001,
              "preCostExpectedReturn": 0.001,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            },
            "follow4hTrend": {
              "macroF1": 0.45,
              "postCostExpectedReturn": 0.001,
              "preCostExpectedReturn": 0.003,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            },
            "historicalProportionRandom": {
              "macroF1": 0.34,
              "postCostExpectedReturn": 0,
              "preCostExpectedReturn": 0.002,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            }
          },
          "model": {
            "directionCorrectCount": 10,
            "macroF1": 0.62,
            "postCostExpectedReturn": 0.004,
            "preCostExpectedReturn": -0.007
          }
        }
      },
      "schemaVersion": "v1.4d-research-scorecard/4-deterministic",
      "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
    },
    "thresholds": {
      "minClassEffectiveTest": {
        "24h": 5,
        "72h": 2
      },
      "minDirectionalCoverage": {
        "24h": 0.5,
        "72h": 0.5
      },
      "minEffectiveTest": {
        "24h": 30,
        "72h": 10
      },
      "minMarketRegimeCoverage": {
        "24h": 0.9,
        "72h": 0.9
      },
      "minPostCostLift": {
        "24h": 0,
        "72h": 0
      },
      "minPreCostLift": {
        "24h": 0.001,
        "72h": 0.001
      },
      "minWilsonLowerBound": {
        "24h": 0.45,
        "72h": 0.35
      },
      "requireAllBaselines": true,
      "requireMarketRegime": true,
      "schemaVersion": "v1.4d-go-no-go-thresholds/1"
    },
    "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
  },
  "output": {
    "baselineAvailability": {
      "24h": {
        "postCostReferenceBaseline": "follow4hTrend",
        "preCostReferenceBaseline": "follow4hTrend",
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "AVAILABLE",
        "usableBaselines": [
          "alwaysRange",
          "follow4hTrend",
          "historicalProportionRandom"
        ]
      },
      "72h": {
        "postCostReferenceBaseline": "follow4hTrend",
        "preCostReferenceBaseline": "follow4hTrend",
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "AVAILABLE",
        "usableBaselines": [
          "alwaysRange",
          "follow4hTrend",
          "historicalProportionRandom"
        ]
      }
    },
    "evaluatedAt": "2026-01-02T00:00:00Z",
    "evaluationVersion": "eval-1",
    "horizonResults": {
      "24h": {
        "directionalCoverage": 0.6666666666666666,
        "effectiveTest": 45,
        "marketRegimeCoverage": 1,
        "postCostLift": 0.003,
        "preCostLift": 0.005,
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "GO",
        "wilson95": {
          "confidenceLevel": 0.95,
          "lower": 0.520704883099,
          "successes": 30,
          "trials": 45,
          "upper": 0.786411250657,
          "z": 1.959963984540054
        }
      },
      "72h": {
        "directionalCoverage": 0.6666666666666666,
        "effectiveTest": 15,
        "marketRegimeCoverage": 1,
        "postCostLift": 0.003,
        "preCostLift": -0.01,
        "primaryReasonCode": "PRE_COST_LIFT_BELOW_THRESHOLD",
        "reasonCodes": [
          "PRE_COST_LIFT_BELOW_THRESHOLD"
        ],
        "status": "NO_GO",
        "wilson95": {
          "confidenceLevel": 0.95,
          "lower": 0.417135477385,
          "successes": 10,
          "trials": 15,
          "upper": 0.848236755603,
          "z": 1.959963984540054
        }
      }
    },
    "overall": {
      "primaryReasonCode": "PRE_COST_LIFT_BELOW_THRESHOLD",
      "reasonCodes": [
        "PRE_COST_LIFT_BELOW_THRESHOLD"
      ],
      "status": "CONDITIONAL_GO"
    },
    "primaryReasonCode": "PRE_COST_LIFT_BELOW_THRESHOLD",
    "reasonCodes": [
      "PRE_COST_LIFT_BELOW_THRESHOLD"
    ],
    "schemaVersion": "v1.4d-go-no-go-output/2",
    "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
  }
}
```

#### 向量 `LIFT_FORMULA_MISMATCH`

输入Schema：`PASS`；overall=`DATA_GATE_FAILED`；primary=`INPUT_CONSISTENCY_FAILED`。

```json
{
  "input": {
    "auditTrail": {
      "authenticityGateStatus": "PASSED",
      "backfillBatchIds": [
        "223e4567-e89b-42d3-a456-426614174001"
      ],
      "datasetVersion": "v1.4d-sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "evaluatedAt": "2026-01-02T00:00:00Z",
      "evaluationVersion": "eval-1",
      "featureCoverage": 1,
      "generationSummary": {
        "attempted": 80,
        "blocked": 0,
        "conflicts": 0,
        "evaluated": 80,
        "expected": 80,
        "inserted": 80,
        "reusedIdentical": 0
      },
      "manifestContentHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "manifestCoverage": 1,
      "schemaVersion": "v1.4d-audit-trail/1",
      "validationRunId": "123e4567-e89b-42d3-a456-426614174000",
      "validationRunStatus": "SUCCEEDED",
      "vintageIds": [
        "vintage-1"
      ]
    },
    "baselineAvailabilityInput": {
      "24h": {
        "alwaysRange": {
          "macroF1": 0.3,
          "postCostExpectedReturn": -0.001,
          "preCostExpectedReturn": 0.001,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        },
        "follow4hTrend": {
          "macroF1": 0.45,
          "postCostExpectedReturn": 0.001,
          "preCostExpectedReturn": 0.003,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        },
        "historicalProportionRandom": {
          "macroF1": 0.34,
          "postCostExpectedReturn": 0,
          "preCostExpectedReturn": 0.002,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        }
      },
      "72h": {
        "alwaysRange": {
          "macroF1": 0.3,
          "postCostExpectedReturn": -0.001,
          "preCostExpectedReturn": 0.001,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        },
        "follow4hTrend": {
          "macroF1": 0.45,
          "postCostExpectedReturn": 0.001,
          "preCostExpectedReturn": 0.003,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        },
        "historicalProportionRandom": {
          "macroF1": 0.34,
          "postCostExpectedReturn": 0,
          "preCostExpectedReturn": 0.002,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        }
      }
    },
    "directionalCoverage": {
      "24h": 0.6666666666666666,
      "72h": 0.6666666666666666
    },
    "evaluatedAt": "2026-01-02T00:00:00Z",
    "evaluationVersion": "eval-1",
    "marketRegimeAtGeneration": {
      "24h": {
        "DOWN": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        },
        "RANGE": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        },
        "UP": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        }
      },
      "72h": {
        "DOWN": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        },
        "RANGE": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        },
        "UP": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        }
      }
    },
    "marketRegimeCoverage": {
      "24h": 1,
      "72h": 1
    },
    "postCostLift": {
      "24h": 0.003,
      "72h": 0.003
    },
    "preCostLift": {
      "24h": 0.006,
      "72h": 0.005
    },
    "predictedDownCount": {
      "24h": 15,
      "72h": 5
    },
    "predictedUpCount": {
      "24h": 15,
      "72h": 5
    },
    "rangeAttribution": {
      "24h": {
        "allPredictionsRange": false,
        "correctlyPredictedRangeCount": 14,
        "predictedRangeCount": 15,
        "rangeTotal": 15
      },
      "72h": {
        "allPredictionsRange": false,
        "correctlyPredictedRangeCount": 4,
        "predictedRangeCount": 5,
        "rangeTotal": 5
      }
    },
    "sampleAccounting": {
      "24h": {
        "classEffectiveTest": {
          "DOWN": 15,
          "RANGE": 15,
          "UP": 15
        },
        "effectiveTest": 45,
        "predictedDownCount": 15,
        "predictedRangeCount": 15,
        "predictedUpCount": 15,
        "rawTest": 270
      },
      "72h": {
        "classEffectiveTest": {
          "DOWN": 5,
          "RANGE": 5,
          "UP": 5
        },
        "effectiveTest": 15,
        "predictedDownCount": 5,
        "predictedRangeCount": 5,
        "predictedUpCount": 5,
        "rawTest": 45
      }
    },
    "schemaVersion": "v1.4d-go-no-go-input/2",
    "scorecard": {
      "evaluatedAt": "2026-01-02T00:00:00Z",
      "evaluationVersion": "eval-1",
      "horizons": {
        "24h": {
          "baselines": {
            "alwaysRange": {
              "macroF1": 0.3,
              "postCostExpectedReturn": -0.001,
              "preCostExpectedReturn": 0.001,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            },
            "follow4hTrend": {
              "macroF1": 0.45,
              "postCostExpectedReturn": 0.001,
              "preCostExpectedReturn": 0.003,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            },
            "historicalProportionRandom": {
              "macroF1": 0.34,
              "postCostExpectedReturn": 0,
              "preCostExpectedReturn": 0.002,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            }
          },
          "model": {
            "directionCorrectCount": 30,
            "macroF1": 0.62,
            "postCostExpectedReturn": 0.004,
            "preCostExpectedReturn": 0.008
          }
        },
        "72h": {
          "baselines": {
            "alwaysRange": {
              "macroF1": 0.3,
              "postCostExpectedReturn": -0.001,
              "preCostExpectedReturn": 0.001,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            },
            "follow4hTrend": {
              "macroF1": 0.45,
              "postCostExpectedReturn": 0.001,
              "preCostExpectedReturn": 0.003,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            },
            "historicalProportionRandom": {
              "macroF1": 0.34,
              "postCostExpectedReturn": 0,
              "preCostExpectedReturn": 0.002,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            }
          },
          "model": {
            "directionCorrectCount": 10,
            "macroF1": 0.62,
            "postCostExpectedReturn": 0.004,
            "preCostExpectedReturn": 0.008
          }
        }
      },
      "schemaVersion": "v1.4d-research-scorecard/4-deterministic",
      "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
    },
    "thresholds": {
      "minClassEffectiveTest": {
        "24h": 5,
        "72h": 2
      },
      "minDirectionalCoverage": {
        "24h": 0.5,
        "72h": 0.5
      },
      "minEffectiveTest": {
        "24h": 30,
        "72h": 10
      },
      "minMarketRegimeCoverage": {
        "24h": 0.9,
        "72h": 0.9
      },
      "minPostCostLift": {
        "24h": 0,
        "72h": 0
      },
      "minPreCostLift": {
        "24h": 0.001,
        "72h": 0.001
      },
      "minWilsonLowerBound": {
        "24h": 0.45,
        "72h": 0.35
      },
      "requireAllBaselines": true,
      "requireMarketRegime": true,
      "schemaVersion": "v1.4d-go-no-go-thresholds/1"
    },
    "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
  },
  "output": {
    "baselineAvailability": {
      "24h": {
        "postCostReferenceBaseline": "follow4hTrend",
        "preCostReferenceBaseline": "follow4hTrend",
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "AVAILABLE",
        "usableBaselines": [
          "alwaysRange",
          "follow4hTrend",
          "historicalProportionRandom"
        ]
      },
      "72h": {
        "postCostReferenceBaseline": "follow4hTrend",
        "preCostReferenceBaseline": "follow4hTrend",
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "AVAILABLE",
        "usableBaselines": [
          "alwaysRange",
          "follow4hTrend",
          "historicalProportionRandom"
        ]
      }
    },
    "evaluatedAt": "2026-01-02T00:00:00Z",
    "evaluationVersion": "eval-1",
    "horizonResults": {
      "24h": {
        "directionalCoverage": 0.6666666666666666,
        "effectiveTest": 45,
        "marketRegimeCoverage": 1,
        "postCostLift": 0.003,
        "preCostLift": 0.005,
        "primaryReasonCode": "INPUT_CONSISTENCY_FAILED",
        "reasonCodes": [
          "INPUT_CONSISTENCY_FAILED"
        ],
        "status": "DATA_GATE_FAILED",
        "wilson95": {
          "confidenceLevel": 0.95,
          "lower": 0.520704883099,
          "successes": 30,
          "trials": 45,
          "upper": 0.786411250657,
          "z": 1.959963984540054
        }
      },
      "72h": {
        "directionalCoverage": 0.6666666666666666,
        "effectiveTest": 15,
        "marketRegimeCoverage": 1,
        "postCostLift": 0.003,
        "preCostLift": 0.005,
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "GO",
        "wilson95": {
          "confidenceLevel": 0.95,
          "lower": 0.417135477385,
          "successes": 10,
          "trials": 15,
          "upper": 0.848236755603,
          "z": 1.959963984540054
        }
      }
    },
    "overall": {
      "primaryReasonCode": "INPUT_CONSISTENCY_FAILED",
      "reasonCodes": [
        "INPUT_CONSISTENCY_FAILED"
      ],
      "status": "DATA_GATE_FAILED"
    },
    "primaryReasonCode": "INPUT_CONSISTENCY_FAILED",
    "reasonCodes": [
      "INPUT_CONSISTENCY_FAILED"
    ],
    "schemaVersion": "v1.4d-go-no-go-output/2",
    "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
  }
}
```

#### 向量 `LIFT_NULL`

输入Schema：`PASS`；overall=`DATA_GATE_FAILED`；primary=`INPUT_CONSISTENCY_FAILED`。

```json
{
  "input": {
    "auditTrail": {
      "authenticityGateStatus": "PASSED",
      "backfillBatchIds": [
        "223e4567-e89b-42d3-a456-426614174001"
      ],
      "datasetVersion": "v1.4d-sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "evaluatedAt": "2026-01-02T00:00:00Z",
      "evaluationVersion": "eval-1",
      "featureCoverage": 1,
      "generationSummary": {
        "attempted": 80,
        "blocked": 0,
        "conflicts": 0,
        "evaluated": 80,
        "expected": 80,
        "inserted": 80,
        "reusedIdentical": 0
      },
      "manifestContentHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "manifestCoverage": 1,
      "schemaVersion": "v1.4d-audit-trail/1",
      "validationRunId": "123e4567-e89b-42d3-a456-426614174000",
      "validationRunStatus": "SUCCEEDED",
      "vintageIds": [
        "vintage-1"
      ]
    },
    "baselineAvailabilityInput": {
      "24h": {
        "alwaysRange": {
          "macroF1": 0.3,
          "postCostExpectedReturn": -0.001,
          "preCostExpectedReturn": 0.001,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        },
        "follow4hTrend": {
          "macroF1": 0.45,
          "postCostExpectedReturn": 0.001,
          "preCostExpectedReturn": 0.003,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        },
        "historicalProportionRandom": {
          "macroF1": 0.34,
          "postCostExpectedReturn": 0,
          "preCostExpectedReturn": 0.002,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        }
      },
      "72h": {
        "alwaysRange": {
          "macroF1": 0.3,
          "postCostExpectedReturn": -0.001,
          "preCostExpectedReturn": 0.001,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        },
        "follow4hTrend": {
          "macroF1": 0.45,
          "postCostExpectedReturn": 0.001,
          "preCostExpectedReturn": 0.003,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        },
        "historicalProportionRandom": {
          "macroF1": 0.34,
          "postCostExpectedReturn": 0,
          "preCostExpectedReturn": 0.002,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        }
      }
    },
    "directionalCoverage": {
      "24h": 0.6666666666666666,
      "72h": 0.6666666666666666
    },
    "evaluatedAt": "2026-01-02T00:00:00Z",
    "evaluationVersion": "eval-1",
    "marketRegimeAtGeneration": {
      "24h": {
        "DOWN": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        },
        "RANGE": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        },
        "UP": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        }
      },
      "72h": {
        "DOWN": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        },
        "RANGE": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        },
        "UP": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        }
      }
    },
    "marketRegimeCoverage": {
      "24h": 1,
      "72h": 1
    },
    "postCostLift": {
      "24h": 0.003,
      "72h": 0.003
    },
    "preCostLift": {
      "24h": 0.005,
      "72h": null
    },
    "predictedDownCount": {
      "24h": 15,
      "72h": 5
    },
    "predictedUpCount": {
      "24h": 15,
      "72h": 5
    },
    "rangeAttribution": {
      "24h": {
        "allPredictionsRange": false,
        "correctlyPredictedRangeCount": 14,
        "predictedRangeCount": 15,
        "rangeTotal": 15
      },
      "72h": {
        "allPredictionsRange": false,
        "correctlyPredictedRangeCount": 4,
        "predictedRangeCount": 5,
        "rangeTotal": 5
      }
    },
    "sampleAccounting": {
      "24h": {
        "classEffectiveTest": {
          "DOWN": 15,
          "RANGE": 15,
          "UP": 15
        },
        "effectiveTest": 45,
        "predictedDownCount": 15,
        "predictedRangeCount": 15,
        "predictedUpCount": 15,
        "rawTest": 270
      },
      "72h": {
        "classEffectiveTest": {
          "DOWN": 5,
          "RANGE": 5,
          "UP": 5
        },
        "effectiveTest": 15,
        "predictedDownCount": 5,
        "predictedRangeCount": 5,
        "predictedUpCount": 5,
        "rawTest": 45
      }
    },
    "schemaVersion": "v1.4d-go-no-go-input/2",
    "scorecard": {
      "evaluatedAt": "2026-01-02T00:00:00Z",
      "evaluationVersion": "eval-1",
      "horizons": {
        "24h": {
          "baselines": {
            "alwaysRange": {
              "macroF1": 0.3,
              "postCostExpectedReturn": -0.001,
              "preCostExpectedReturn": 0.001,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            },
            "follow4hTrend": {
              "macroF1": 0.45,
              "postCostExpectedReturn": 0.001,
              "preCostExpectedReturn": 0.003,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            },
            "historicalProportionRandom": {
              "macroF1": 0.34,
              "postCostExpectedReturn": 0,
              "preCostExpectedReturn": 0.002,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            }
          },
          "model": {
            "directionCorrectCount": 30,
            "macroF1": 0.62,
            "postCostExpectedReturn": 0.004,
            "preCostExpectedReturn": 0.008
          }
        },
        "72h": {
          "baselines": {
            "alwaysRange": {
              "macroF1": 0.3,
              "postCostExpectedReturn": -0.001,
              "preCostExpectedReturn": 0.001,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            },
            "follow4hTrend": {
              "macroF1": 0.45,
              "postCostExpectedReturn": 0.001,
              "preCostExpectedReturn": 0.003,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            },
            "historicalProportionRandom": {
              "macroF1": 0.34,
              "postCostExpectedReturn": 0,
              "preCostExpectedReturn": 0.002,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            }
          },
          "model": {
            "directionCorrectCount": 10,
            "macroF1": 0.62,
            "postCostExpectedReturn": 0.004,
            "preCostExpectedReturn": 0.008
          }
        }
      },
      "schemaVersion": "v1.4d-research-scorecard/4-deterministic",
      "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
    },
    "thresholds": {
      "minClassEffectiveTest": {
        "24h": 5,
        "72h": 2
      },
      "minDirectionalCoverage": {
        "24h": 0.5,
        "72h": 0.5
      },
      "minEffectiveTest": {
        "24h": 30,
        "72h": 10
      },
      "minMarketRegimeCoverage": {
        "24h": 0.9,
        "72h": 0.9
      },
      "minPostCostLift": {
        "24h": 0,
        "72h": 0
      },
      "minPreCostLift": {
        "24h": 0.001,
        "72h": 0.001
      },
      "minWilsonLowerBound": {
        "24h": 0.45,
        "72h": 0.35
      },
      "requireAllBaselines": true,
      "requireMarketRegime": true,
      "schemaVersion": "v1.4d-go-no-go-thresholds/1"
    },
    "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
  },
  "output": {
    "baselineAvailability": {
      "24h": {
        "postCostReferenceBaseline": "follow4hTrend",
        "preCostReferenceBaseline": "follow4hTrend",
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "AVAILABLE",
        "usableBaselines": [
          "alwaysRange",
          "follow4hTrend",
          "historicalProportionRandom"
        ]
      },
      "72h": {
        "postCostReferenceBaseline": "follow4hTrend",
        "preCostReferenceBaseline": "follow4hTrend",
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "AVAILABLE",
        "usableBaselines": [
          "alwaysRange",
          "follow4hTrend",
          "historicalProportionRandom"
        ]
      }
    },
    "evaluatedAt": "2026-01-02T00:00:00Z",
    "evaluationVersion": "eval-1",
    "horizonResults": {
      "24h": {
        "directionalCoverage": 0.6666666666666666,
        "effectiveTest": 45,
        "marketRegimeCoverage": 1,
        "postCostLift": 0.003,
        "preCostLift": 0.005,
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "GO",
        "wilson95": {
          "confidenceLevel": 0.95,
          "lower": 0.520704883099,
          "successes": 30,
          "trials": 45,
          "upper": 0.786411250657,
          "z": 1.959963984540054
        }
      },
      "72h": {
        "directionalCoverage": 0.6666666666666666,
        "effectiveTest": 15,
        "marketRegimeCoverage": 1,
        "postCostLift": 0.003,
        "preCostLift": 0.005,
        "primaryReasonCode": "INPUT_CONSISTENCY_FAILED",
        "reasonCodes": [
          "INPUT_CONSISTENCY_FAILED",
          "LIFT_NULL"
        ],
        "status": "DATA_GATE_FAILED",
        "wilson95": {
          "confidenceLevel": 0.95,
          "lower": 0.417135477385,
          "successes": 10,
          "trials": 15,
          "upper": 0.848236755603,
          "z": 1.959963984540054
        }
      }
    },
    "overall": {
      "primaryReasonCode": "INPUT_CONSISTENCY_FAILED",
      "reasonCodes": [
        "INPUT_CONSISTENCY_FAILED",
        "LIFT_NULL"
      ],
      "status": "DATA_GATE_FAILED"
    },
    "primaryReasonCode": "INPUT_CONSISTENCY_FAILED",
    "reasonCodes": [
      "INPUT_CONSISTENCY_FAILED",
      "LIFT_NULL"
    ],
    "schemaVersion": "v1.4d-go-no-go-output/2",
    "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
  }
}
```

#### 向量 `NO_GO`

输入Schema：`PASS`；overall=`NO_GO`；primary=`POST_COST_LIFT_BELOW_THRESHOLD`。

```json
{
  "input": {
    "auditTrail": {
      "authenticityGateStatus": "PASSED",
      "backfillBatchIds": [
        "223e4567-e89b-42d3-a456-426614174001"
      ],
      "datasetVersion": "v1.4d-sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "evaluatedAt": "2026-01-02T00:00:00Z",
      "evaluationVersion": "eval-1",
      "featureCoverage": 1,
      "generationSummary": {
        "attempted": 80,
        "blocked": 0,
        "conflicts": 0,
        "evaluated": 80,
        "expected": 80,
        "inserted": 80,
        "reusedIdentical": 0
      },
      "manifestContentHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "manifestCoverage": 1,
      "schemaVersion": "v1.4d-audit-trail/1",
      "validationRunId": "123e4567-e89b-42d3-a456-426614174000",
      "validationRunStatus": "SUCCEEDED",
      "vintageIds": [
        "vintage-1"
      ]
    },
    "baselineAvailabilityInput": {
      "24h": {
        "alwaysRange": {
          "macroF1": 0.3,
          "postCostExpectedReturn": -0.001,
          "preCostExpectedReturn": 0.001,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        },
        "follow4hTrend": {
          "macroF1": 0.45,
          "postCostExpectedReturn": 0.001,
          "preCostExpectedReturn": 0.003,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        },
        "historicalProportionRandom": {
          "macroF1": 0.34,
          "postCostExpectedReturn": 0,
          "preCostExpectedReturn": 0.002,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        }
      },
      "72h": {
        "alwaysRange": {
          "macroF1": 0.3,
          "postCostExpectedReturn": -0.001,
          "preCostExpectedReturn": 0.001,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        },
        "follow4hTrend": {
          "macroF1": 0.45,
          "postCostExpectedReturn": 0.001,
          "preCostExpectedReturn": 0.003,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        },
        "historicalProportionRandom": {
          "macroF1": 0.34,
          "postCostExpectedReturn": 0,
          "preCostExpectedReturn": 0.002,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        }
      }
    },
    "directionalCoverage": {
      "24h": 0.6666666666666666,
      "72h": 0.6666666666666666
    },
    "evaluatedAt": "2026-01-02T00:00:00Z",
    "evaluationVersion": "eval-1",
    "marketRegimeAtGeneration": {
      "24h": {
        "DOWN": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        },
        "RANGE": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        },
        "UP": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        }
      },
      "72h": {
        "DOWN": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        },
        "RANGE": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        },
        "UP": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        }
      }
    },
    "marketRegimeCoverage": {
      "24h": 1,
      "72h": 1
    },
    "postCostLift": {
      "24h": -0.01,
      "72h": -0.01
    },
    "preCostLift": {
      "24h": 0.005,
      "72h": 0.005
    },
    "predictedDownCount": {
      "24h": 15,
      "72h": 5
    },
    "predictedUpCount": {
      "24h": 15,
      "72h": 5
    },
    "rangeAttribution": {
      "24h": {
        "allPredictionsRange": false,
        "correctlyPredictedRangeCount": 14,
        "predictedRangeCount": 15,
        "rangeTotal": 15
      },
      "72h": {
        "allPredictionsRange": false,
        "correctlyPredictedRangeCount": 4,
        "predictedRangeCount": 5,
        "rangeTotal": 5
      }
    },
    "sampleAccounting": {
      "24h": {
        "classEffectiveTest": {
          "DOWN": 15,
          "RANGE": 15,
          "UP": 15
        },
        "effectiveTest": 45,
        "predictedDownCount": 15,
        "predictedRangeCount": 15,
        "predictedUpCount": 15,
        "rawTest": 270
      },
      "72h": {
        "classEffectiveTest": {
          "DOWN": 5,
          "RANGE": 5,
          "UP": 5
        },
        "effectiveTest": 15,
        "predictedDownCount": 5,
        "predictedRangeCount": 5,
        "predictedUpCount": 5,
        "rawTest": 45
      }
    },
    "schemaVersion": "v1.4d-go-no-go-input/2",
    "scorecard": {
      "evaluatedAt": "2026-01-02T00:00:00Z",
      "evaluationVersion": "eval-1",
      "horizons": {
        "24h": {
          "baselines": {
            "alwaysRange": {
              "macroF1": 0.3,
              "postCostExpectedReturn": -0.001,
              "preCostExpectedReturn": 0.001,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            },
            "follow4hTrend": {
              "macroF1": 0.45,
              "postCostExpectedReturn": 0.001,
              "preCostExpectedReturn": 0.003,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            },
            "historicalProportionRandom": {
              "macroF1": 0.34,
              "postCostExpectedReturn": 0,
              "preCostExpectedReturn": 0.002,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            }
          },
          "model": {
            "directionCorrectCount": 30,
            "macroF1": 0.62,
            "postCostExpectedReturn": -0.009,
            "preCostExpectedReturn": 0.008
          }
        },
        "72h": {
          "baselines": {
            "alwaysRange": {
              "macroF1": 0.3,
              "postCostExpectedReturn": -0.001,
              "preCostExpectedReturn": 0.001,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            },
            "follow4hTrend": {
              "macroF1": 0.45,
              "postCostExpectedReturn": 0.001,
              "preCostExpectedReturn": 0.003,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            },
            "historicalProportionRandom": {
              "macroF1": 0.34,
              "postCostExpectedReturn": 0,
              "preCostExpectedReturn": 0.002,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            }
          },
          "model": {
            "directionCorrectCount": 10,
            "macroF1": 0.62,
            "postCostExpectedReturn": -0.009,
            "preCostExpectedReturn": 0.008
          }
        }
      },
      "schemaVersion": "v1.4d-research-scorecard/4-deterministic",
      "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
    },
    "thresholds": {
      "minClassEffectiveTest": {
        "24h": 5,
        "72h": 2
      },
      "minDirectionalCoverage": {
        "24h": 0.5,
        "72h": 0.5
      },
      "minEffectiveTest": {
        "24h": 30,
        "72h": 10
      },
      "minMarketRegimeCoverage": {
        "24h": 0.9,
        "72h": 0.9
      },
      "minPostCostLift": {
        "24h": 0,
        "72h": 0
      },
      "minPreCostLift": {
        "24h": 0.001,
        "72h": 0.001
      },
      "minWilsonLowerBound": {
        "24h": 0.45,
        "72h": 0.35
      },
      "requireAllBaselines": true,
      "requireMarketRegime": true,
      "schemaVersion": "v1.4d-go-no-go-thresholds/1"
    },
    "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
  },
  "output": {
    "baselineAvailability": {
      "24h": {
        "postCostReferenceBaseline": "follow4hTrend",
        "preCostReferenceBaseline": "follow4hTrend",
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "AVAILABLE",
        "usableBaselines": [
          "alwaysRange",
          "follow4hTrend",
          "historicalProportionRandom"
        ]
      },
      "72h": {
        "postCostReferenceBaseline": "follow4hTrend",
        "preCostReferenceBaseline": "follow4hTrend",
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "AVAILABLE",
        "usableBaselines": [
          "alwaysRange",
          "follow4hTrend",
          "historicalProportionRandom"
        ]
      }
    },
    "evaluatedAt": "2026-01-02T00:00:00Z",
    "evaluationVersion": "eval-1",
    "horizonResults": {
      "24h": {
        "directionalCoverage": 0.6666666666666666,
        "effectiveTest": 45,
        "marketRegimeCoverage": 1,
        "postCostLift": -0.009999999999999998,
        "preCostLift": 0.005,
        "primaryReasonCode": "POST_COST_LIFT_BELOW_THRESHOLD",
        "reasonCodes": [
          "POST_COST_LIFT_BELOW_THRESHOLD"
        ],
        "status": "NO_GO",
        "wilson95": {
          "confidenceLevel": 0.95,
          "lower": 0.520704883099,
          "successes": 30,
          "trials": 45,
          "upper": 0.786411250657,
          "z": 1.959963984540054
        }
      },
      "72h": {
        "directionalCoverage": 0.6666666666666666,
        "effectiveTest": 15,
        "marketRegimeCoverage": 1,
        "postCostLift": -0.009999999999999998,
        "preCostLift": 0.005,
        "primaryReasonCode": "POST_COST_LIFT_BELOW_THRESHOLD",
        "reasonCodes": [
          "POST_COST_LIFT_BELOW_THRESHOLD"
        ],
        "status": "NO_GO",
        "wilson95": {
          "confidenceLevel": 0.95,
          "lower": 0.417135477385,
          "successes": 10,
          "trials": 15,
          "upper": 0.848236755603,
          "z": 1.959963984540054
        }
      }
    },
    "overall": {
      "primaryReasonCode": "POST_COST_LIFT_BELOW_THRESHOLD",
      "reasonCodes": [
        "POST_COST_LIFT_BELOW_THRESHOLD"
      ],
      "status": "NO_GO"
    },
    "primaryReasonCode": "POST_COST_LIFT_BELOW_THRESHOLD",
    "reasonCodes": [
      "POST_COST_LIFT_BELOW_THRESHOLD"
    ],
    "schemaVersion": "v1.4d-go-no-go-output/2",
    "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
  }
}
```

#### 向量 `RANGE_TOTAL_ZERO`

输入Schema：`PASS`；overall=`CONDITIONAL_GO`；primary=`CLASS_SAMPLE_BELOW_THRESHOLD`。

```json
{
  "input": {
    "auditTrail": {
      "authenticityGateStatus": "PASSED",
      "backfillBatchIds": [
        "223e4567-e89b-42d3-a456-426614174001"
      ],
      "datasetVersion": "v1.4d-sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "evaluatedAt": "2026-01-02T00:00:00Z",
      "evaluationVersion": "eval-1",
      "featureCoverage": 1,
      "generationSummary": {
        "attempted": 80,
        "blocked": 0,
        "conflicts": 0,
        "evaluated": 80,
        "expected": 80,
        "inserted": 80,
        "reusedIdentical": 0
      },
      "manifestContentHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "manifestCoverage": 1,
      "schemaVersion": "v1.4d-audit-trail/1",
      "validationRunId": "123e4567-e89b-42d3-a456-426614174000",
      "validationRunStatus": "SUCCEEDED",
      "vintageIds": [
        "vintage-1"
      ]
    },
    "baselineAvailabilityInput": {
      "24h": {
        "alwaysRange": {
          "macroF1": 0.3,
          "postCostExpectedReturn": -0.001,
          "preCostExpectedReturn": 0.001,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        },
        "follow4hTrend": {
          "macroF1": 0.45,
          "postCostExpectedReturn": 0.001,
          "preCostExpectedReturn": 0.003,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        },
        "historicalProportionRandom": {
          "macroF1": 0.34,
          "postCostExpectedReturn": 0,
          "preCostExpectedReturn": 0.002,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        }
      },
      "72h": {
        "alwaysRange": {
          "macroF1": 0.3,
          "postCostExpectedReturn": -0.001,
          "preCostExpectedReturn": 0.001,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        },
        "follow4hTrend": {
          "macroF1": 0.45,
          "postCostExpectedReturn": 0.001,
          "preCostExpectedReturn": 0.003,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        },
        "historicalProportionRandom": {
          "macroF1": 0.34,
          "postCostExpectedReturn": 0,
          "preCostExpectedReturn": 0.002,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        }
      }
    },
    "directionalCoverage": {
      "24h": 0.6666666666666666,
      "72h": 0.6666666666666666
    },
    "evaluatedAt": "2026-01-02T00:00:00Z",
    "evaluationVersion": "eval-1",
    "marketRegimeAtGeneration": {
      "24h": {
        "DOWN": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        },
        "RANGE": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        },
        "UP": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        }
      },
      "72h": {
        "DOWN": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        },
        "RANGE": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        },
        "UP": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        }
      }
    },
    "marketRegimeCoverage": {
      "24h": 1,
      "72h": 1
    },
    "postCostLift": {
      "24h": 0.003,
      "72h": 0.003
    },
    "preCostLift": {
      "24h": 0.005,
      "72h": 0.005
    },
    "predictedDownCount": {
      "24h": 15,
      "72h": 5
    },
    "predictedUpCount": {
      "24h": 15,
      "72h": 5
    },
    "rangeAttribution": {
      "24h": {
        "allPredictionsRange": false,
        "correctlyPredictedRangeCount": 14,
        "predictedRangeCount": 15,
        "rangeTotal": 15
      },
      "72h": {
        "allPredictionsRange": false,
        "correctlyPredictedRangeCount": 0,
        "predictedRangeCount": 5,
        "rangeTotal": 0
      }
    },
    "sampleAccounting": {
      "24h": {
        "classEffectiveTest": {
          "DOWN": 15,
          "RANGE": 15,
          "UP": 15
        },
        "effectiveTest": 45,
        "predictedDownCount": 15,
        "predictedRangeCount": 15,
        "predictedUpCount": 15,
        "rawTest": 270
      },
      "72h": {
        "classEffectiveTest": {
          "DOWN": 5,
          "RANGE": 0,
          "UP": 10
        },
        "effectiveTest": 15,
        "predictedDownCount": 5,
        "predictedRangeCount": 5,
        "predictedUpCount": 5,
        "rawTest": 45
      }
    },
    "schemaVersion": "v1.4d-go-no-go-input/2",
    "scorecard": {
      "evaluatedAt": "2026-01-02T00:00:00Z",
      "evaluationVersion": "eval-1",
      "horizons": {
        "24h": {
          "baselines": {
            "alwaysRange": {
              "macroF1": 0.3,
              "postCostExpectedReturn": -0.001,
              "preCostExpectedReturn": 0.001,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            },
            "follow4hTrend": {
              "macroF1": 0.45,
              "postCostExpectedReturn": 0.001,
              "preCostExpectedReturn": 0.003,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            },
            "historicalProportionRandom": {
              "macroF1": 0.34,
              "postCostExpectedReturn": 0,
              "preCostExpectedReturn": 0.002,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            }
          },
          "model": {
            "directionCorrectCount": 30,
            "macroF1": 0.62,
            "postCostExpectedReturn": 0.004,
            "preCostExpectedReturn": 0.008
          }
        },
        "72h": {
          "baselines": {
            "alwaysRange": {
              "macroF1": 0.3,
              "postCostExpectedReturn": -0.001,
              "preCostExpectedReturn": 0.001,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            },
            "follow4hTrend": {
              "macroF1": 0.45,
              "postCostExpectedReturn": 0.001,
              "preCostExpectedReturn": 0.003,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            },
            "historicalProportionRandom": {
              "macroF1": 0.34,
              "postCostExpectedReturn": 0,
              "preCostExpectedReturn": 0.002,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            }
          },
          "model": {
            "directionCorrectCount": 10,
            "macroF1": 0.62,
            "postCostExpectedReturn": 0.004,
            "preCostExpectedReturn": 0.008
          }
        }
      },
      "schemaVersion": "v1.4d-research-scorecard/4-deterministic",
      "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
    },
    "thresholds": {
      "minClassEffectiveTest": {
        "24h": 5,
        "72h": 2
      },
      "minDirectionalCoverage": {
        "24h": 0.5,
        "72h": 0.5
      },
      "minEffectiveTest": {
        "24h": 30,
        "72h": 10
      },
      "minMarketRegimeCoverage": {
        "24h": 0.9,
        "72h": 0.9
      },
      "minPostCostLift": {
        "24h": 0,
        "72h": 0
      },
      "minPreCostLift": {
        "24h": 0.001,
        "72h": 0.001
      },
      "minWilsonLowerBound": {
        "24h": 0.45,
        "72h": 0.35
      },
      "requireAllBaselines": true,
      "requireMarketRegime": true,
      "schemaVersion": "v1.4d-go-no-go-thresholds/1"
    },
    "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
  },
  "output": {
    "baselineAvailability": {
      "24h": {
        "postCostReferenceBaseline": "follow4hTrend",
        "preCostReferenceBaseline": "follow4hTrend",
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "AVAILABLE",
        "usableBaselines": [
          "alwaysRange",
          "follow4hTrend",
          "historicalProportionRandom"
        ]
      },
      "72h": {
        "postCostReferenceBaseline": "follow4hTrend",
        "preCostReferenceBaseline": "follow4hTrend",
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "AVAILABLE",
        "usableBaselines": [
          "alwaysRange",
          "follow4hTrend",
          "historicalProportionRandom"
        ]
      }
    },
    "evaluatedAt": "2026-01-02T00:00:00Z",
    "evaluationVersion": "eval-1",
    "horizonResults": {
      "24h": {
        "directionalCoverage": 0.6666666666666666,
        "effectiveTest": 45,
        "marketRegimeCoverage": 1,
        "postCostLift": 0.003,
        "preCostLift": 0.005,
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "GO",
        "wilson95": {
          "confidenceLevel": 0.95,
          "lower": 0.520704883099,
          "successes": 30,
          "trials": 45,
          "upper": 0.786411250657,
          "z": 1.959963984540054
        }
      },
      "72h": {
        "directionalCoverage": 0.6666666666666666,
        "effectiveTest": 15,
        "marketRegimeCoverage": 1,
        "postCostLift": 0.003,
        "preCostLift": 0.005,
        "primaryReasonCode": "CLASS_SAMPLE_BELOW_THRESHOLD",
        "reasonCodes": [
          "CLASS_SAMPLE_BELOW_THRESHOLD",
          "RANGE_CLASS_ABSENT"
        ],
        "status": "CONDITIONAL_GO",
        "wilson95": {
          "confidenceLevel": 0.95,
          "lower": 0.417135477385,
          "successes": 10,
          "trials": 15,
          "upper": 0.848236755603,
          "z": 1.959963984540054
        }
      }
    },
    "overall": {
      "primaryReasonCode": "CLASS_SAMPLE_BELOW_THRESHOLD",
      "reasonCodes": [
        "CLASS_SAMPLE_BELOW_THRESHOLD",
        "RANGE_CLASS_ABSENT"
      ],
      "status": "CONDITIONAL_GO"
    },
    "primaryReasonCode": "CLASS_SAMPLE_BELOW_THRESHOLD",
    "reasonCodes": [
      "CLASS_SAMPLE_BELOW_THRESHOLD",
      "RANGE_CLASS_ABSENT"
    ],
    "schemaVersion": "v1.4d-go-no-go-output/2",
    "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
  }
}
```

#### 向量 `TOLERANCE_EXCEEDED`

输入Schema：`PASS`；overall=`DATA_GATE_FAILED`；primary=`INPUT_CONSISTENCY_FAILED`。

```json
{
  "input": {
    "auditTrail": {
      "authenticityGateStatus": "PASSED",
      "backfillBatchIds": [
        "223e4567-e89b-42d3-a456-426614174001"
      ],
      "datasetVersion": "v1.4d-sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "evaluatedAt": "2026-01-02T00:00:00Z",
      "evaluationVersion": "eval-1",
      "featureCoverage": 1,
      "generationSummary": {
        "attempted": 80,
        "blocked": 0,
        "conflicts": 0,
        "evaluated": 80,
        "expected": 80,
        "inserted": 80,
        "reusedIdentical": 0
      },
      "manifestContentHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "manifestCoverage": 1,
      "schemaVersion": "v1.4d-audit-trail/1",
      "validationRunId": "123e4567-e89b-42d3-a456-426614174000",
      "validationRunStatus": "SUCCEEDED",
      "vintageIds": [
        "vintage-1"
      ]
    },
    "baselineAvailabilityInput": {
      "24h": {
        "alwaysRange": {
          "macroF1": 0.3,
          "postCostExpectedReturn": -0.001,
          "preCostExpectedReturn": 0.001,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        },
        "follow4hTrend": {
          "macroF1": 0.45,
          "postCostExpectedReturn": 0.001,
          "preCostExpectedReturn": 0.003,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        },
        "historicalProportionRandom": {
          "macroF1": 0.34,
          "postCostExpectedReturn": 0,
          "preCostExpectedReturn": 0.002,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        }
      },
      "72h": {
        "alwaysRange": {
          "macroF1": 0.3,
          "postCostExpectedReturn": -0.001,
          "preCostExpectedReturn": 0.001,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        },
        "follow4hTrend": {
          "macroF1": 0.45,
          "postCostExpectedReturn": 0.001,
          "preCostExpectedReturn": 0.003,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        },
        "historicalProportionRandom": {
          "macroF1": 0.34,
          "postCostExpectedReturn": 0,
          "preCostExpectedReturn": 0.002,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        }
      }
    },
    "directionalCoverage": {
      "24h": 0.6666666666666666,
      "72h": 0.6666666666666666
    },
    "evaluatedAt": "2026-01-02T00:00:00Z",
    "evaluationVersion": "eval-1",
    "marketRegimeAtGeneration": {
      "24h": {
        "DOWN": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        },
        "RANGE": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        },
        "UP": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        }
      },
      "72h": {
        "DOWN": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        },
        "RANGE": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        },
        "UP": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        }
      }
    },
    "marketRegimeCoverage": {
      "24h": 1,
      "72h": 1
    },
    "postCostLift": {
      "24h": 0.003,
      "72h": 0.003
    },
    "preCostLift": {
      "24h": 0.005000000001001,
      "72h": 0.005
    },
    "predictedDownCount": {
      "24h": 15,
      "72h": 5
    },
    "predictedUpCount": {
      "24h": 15,
      "72h": 5
    },
    "rangeAttribution": {
      "24h": {
        "allPredictionsRange": false,
        "correctlyPredictedRangeCount": 14,
        "predictedRangeCount": 15,
        "rangeTotal": 15
      },
      "72h": {
        "allPredictionsRange": false,
        "correctlyPredictedRangeCount": 4,
        "predictedRangeCount": 5,
        "rangeTotal": 5
      }
    },
    "sampleAccounting": {
      "24h": {
        "classEffectiveTest": {
          "DOWN": 15,
          "RANGE": 15,
          "UP": 15
        },
        "effectiveTest": 45,
        "predictedDownCount": 15,
        "predictedRangeCount": 15,
        "predictedUpCount": 15,
        "rawTest": 270
      },
      "72h": {
        "classEffectiveTest": {
          "DOWN": 5,
          "RANGE": 5,
          "UP": 5
        },
        "effectiveTest": 15,
        "predictedDownCount": 5,
        "predictedRangeCount": 5,
        "predictedUpCount": 5,
        "rawTest": 45
      }
    },
    "schemaVersion": "v1.4d-go-no-go-input/2",
    "scorecard": {
      "evaluatedAt": "2026-01-02T00:00:00Z",
      "evaluationVersion": "eval-1",
      "horizons": {
        "24h": {
          "baselines": {
            "alwaysRange": {
              "macroF1": 0.3,
              "postCostExpectedReturn": -0.001,
              "preCostExpectedReturn": 0.001,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            },
            "follow4hTrend": {
              "macroF1": 0.45,
              "postCostExpectedReturn": 0.001,
              "preCostExpectedReturn": 0.003,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            },
            "historicalProportionRandom": {
              "macroF1": 0.34,
              "postCostExpectedReturn": 0,
              "preCostExpectedReturn": 0.002,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            }
          },
          "model": {
            "directionCorrectCount": 30,
            "macroF1": 0.62,
            "postCostExpectedReturn": 0.004,
            "preCostExpectedReturn": 0.008
          }
        },
        "72h": {
          "baselines": {
            "alwaysRange": {
              "macroF1": 0.3,
              "postCostExpectedReturn": -0.001,
              "preCostExpectedReturn": 0.001,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            },
            "follow4hTrend": {
              "macroF1": 0.45,
              "postCostExpectedReturn": 0.001,
              "preCostExpectedReturn": 0.003,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            },
            "historicalProportionRandom": {
              "macroF1": 0.34,
              "postCostExpectedReturn": 0,
              "preCostExpectedReturn": 0.002,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            }
          },
          "model": {
            "directionCorrectCount": 10,
            "macroF1": 0.62,
            "postCostExpectedReturn": 0.004,
            "preCostExpectedReturn": 0.008
          }
        }
      },
      "schemaVersion": "v1.4d-research-scorecard/4-deterministic",
      "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
    },
    "thresholds": {
      "minClassEffectiveTest": {
        "24h": 5,
        "72h": 2
      },
      "minDirectionalCoverage": {
        "24h": 0.5,
        "72h": 0.5
      },
      "minEffectiveTest": {
        "24h": 30,
        "72h": 10
      },
      "minMarketRegimeCoverage": {
        "24h": 0.9,
        "72h": 0.9
      },
      "minPostCostLift": {
        "24h": 0,
        "72h": 0
      },
      "minPreCostLift": {
        "24h": 0.001,
        "72h": 0.001
      },
      "minWilsonLowerBound": {
        "24h": 0.45,
        "72h": 0.35
      },
      "requireAllBaselines": true,
      "requireMarketRegime": true,
      "schemaVersion": "v1.4d-go-no-go-thresholds/1"
    },
    "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
  },
  "output": {
    "baselineAvailability": {
      "24h": {
        "postCostReferenceBaseline": "follow4hTrend",
        "preCostReferenceBaseline": "follow4hTrend",
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "AVAILABLE",
        "usableBaselines": [
          "alwaysRange",
          "follow4hTrend",
          "historicalProportionRandom"
        ]
      },
      "72h": {
        "postCostReferenceBaseline": "follow4hTrend",
        "preCostReferenceBaseline": "follow4hTrend",
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "AVAILABLE",
        "usableBaselines": [
          "alwaysRange",
          "follow4hTrend",
          "historicalProportionRandom"
        ]
      }
    },
    "evaluatedAt": "2026-01-02T00:00:00Z",
    "evaluationVersion": "eval-1",
    "horizonResults": {
      "24h": {
        "directionalCoverage": 0.6666666666666666,
        "effectiveTest": 45,
        "marketRegimeCoverage": 1,
        "postCostLift": 0.003,
        "preCostLift": 0.005,
        "primaryReasonCode": "INPUT_CONSISTENCY_FAILED",
        "reasonCodes": [
          "INPUT_CONSISTENCY_FAILED"
        ],
        "status": "DATA_GATE_FAILED",
        "wilson95": {
          "confidenceLevel": 0.95,
          "lower": 0.520704883099,
          "successes": 30,
          "trials": 45,
          "upper": 0.786411250657,
          "z": 1.959963984540054
        }
      },
      "72h": {
        "directionalCoverage": 0.6666666666666666,
        "effectiveTest": 15,
        "marketRegimeCoverage": 1,
        "postCostLift": 0.003,
        "preCostLift": 0.005,
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "GO",
        "wilson95": {
          "confidenceLevel": 0.95,
          "lower": 0.417135477385,
          "successes": 10,
          "trials": 15,
          "upper": 0.848236755603,
          "z": 1.959963984540054
        }
      }
    },
    "overall": {
      "primaryReasonCode": "INPUT_CONSISTENCY_FAILED",
      "reasonCodes": [
        "INPUT_CONSISTENCY_FAILED"
      ],
      "status": "DATA_GATE_FAILED"
    },
    "primaryReasonCode": "INPUT_CONSISTENCY_FAILED",
    "reasonCodes": [
      "INPUT_CONSISTENCY_FAILED"
    ],
    "schemaVersion": "v1.4d-go-no-go-output/2",
    "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
  }
}
```

#### 向量 `TOLERANCE_WITHIN`

输入Schema：`PASS`；overall=`GO`；primary=`NONE`。

```json
{
  "input": {
    "auditTrail": {
      "authenticityGateStatus": "PASSED",
      "backfillBatchIds": [
        "223e4567-e89b-42d3-a456-426614174001"
      ],
      "datasetVersion": "v1.4d-sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "evaluatedAt": "2026-01-02T00:00:00Z",
      "evaluationVersion": "eval-1",
      "featureCoverage": 1,
      "generationSummary": {
        "attempted": 80,
        "blocked": 0,
        "conflicts": 0,
        "evaluated": 80,
        "expected": 80,
        "inserted": 80,
        "reusedIdentical": 0
      },
      "manifestContentHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "manifestCoverage": 1,
      "schemaVersion": "v1.4d-audit-trail/1",
      "validationRunId": "123e4567-e89b-42d3-a456-426614174000",
      "validationRunStatus": "SUCCEEDED",
      "vintageIds": [
        "vintage-1"
      ]
    },
    "baselineAvailabilityInput": {
      "24h": {
        "alwaysRange": {
          "macroF1": 0.3,
          "postCostExpectedReturn": -0.001,
          "preCostExpectedReturn": 0.001,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        },
        "follow4hTrend": {
          "macroF1": 0.45,
          "postCostExpectedReturn": 0.001,
          "preCostExpectedReturn": 0.003,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        },
        "historicalProportionRandom": {
          "macroF1": 0.34,
          "postCostExpectedReturn": 0,
          "preCostExpectedReturn": 0.002,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        }
      },
      "72h": {
        "alwaysRange": {
          "macroF1": 0.3,
          "postCostExpectedReturn": -0.001,
          "preCostExpectedReturn": 0.001,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        },
        "follow4hTrend": {
          "macroF1": 0.45,
          "postCostExpectedReturn": 0.001,
          "preCostExpectedReturn": 0.003,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        },
        "historicalProportionRandom": {
          "macroF1": 0.34,
          "postCostExpectedReturn": 0,
          "preCostExpectedReturn": 0.002,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        }
      }
    },
    "directionalCoverage": {
      "24h": 0.6666666666666666,
      "72h": 0.6666666666666666
    },
    "evaluatedAt": "2026-01-02T00:00:00Z",
    "evaluationVersion": "eval-1",
    "marketRegimeAtGeneration": {
      "24h": {
        "DOWN": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        },
        "RANGE": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        },
        "UP": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        }
      },
      "72h": {
        "DOWN": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        },
        "RANGE": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        },
        "UP": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        }
      }
    },
    "marketRegimeCoverage": {
      "24h": 1,
      "72h": 1
    },
    "postCostLift": {
      "24h": 0.003,
      "72h": 0.003
    },
    "preCostLift": {
      "24h": 0.0050000000009990005,
      "72h": 0.005
    },
    "predictedDownCount": {
      "24h": 15,
      "72h": 5
    },
    "predictedUpCount": {
      "24h": 15,
      "72h": 5
    },
    "rangeAttribution": {
      "24h": {
        "allPredictionsRange": false,
        "correctlyPredictedRangeCount": 14,
        "predictedRangeCount": 15,
        "rangeTotal": 15
      },
      "72h": {
        "allPredictionsRange": false,
        "correctlyPredictedRangeCount": 4,
        "predictedRangeCount": 5,
        "rangeTotal": 5
      }
    },
    "sampleAccounting": {
      "24h": {
        "classEffectiveTest": {
          "DOWN": 15,
          "RANGE": 15,
          "UP": 15
        },
        "effectiveTest": 45,
        "predictedDownCount": 15,
        "predictedRangeCount": 15,
        "predictedUpCount": 15,
        "rawTest": 270
      },
      "72h": {
        "classEffectiveTest": {
          "DOWN": 5,
          "RANGE": 5,
          "UP": 5
        },
        "effectiveTest": 15,
        "predictedDownCount": 5,
        "predictedRangeCount": 5,
        "predictedUpCount": 5,
        "rawTest": 45
      }
    },
    "schemaVersion": "v1.4d-go-no-go-input/2",
    "scorecard": {
      "evaluatedAt": "2026-01-02T00:00:00Z",
      "evaluationVersion": "eval-1",
      "horizons": {
        "24h": {
          "baselines": {
            "alwaysRange": {
              "macroF1": 0.3,
              "postCostExpectedReturn": -0.001,
              "preCostExpectedReturn": 0.001,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            },
            "follow4hTrend": {
              "macroF1": 0.45,
              "postCostExpectedReturn": 0.001,
              "preCostExpectedReturn": 0.003,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            },
            "historicalProportionRandom": {
              "macroF1": 0.34,
              "postCostExpectedReturn": 0,
              "preCostExpectedReturn": 0.002,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            }
          },
          "model": {
            "directionCorrectCount": 30,
            "macroF1": 0.62,
            "postCostExpectedReturn": 0.004,
            "preCostExpectedReturn": 0.008
          }
        },
        "72h": {
          "baselines": {
            "alwaysRange": {
              "macroF1": 0.3,
              "postCostExpectedReturn": -0.001,
              "preCostExpectedReturn": 0.001,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            },
            "follow4hTrend": {
              "macroF1": 0.45,
              "postCostExpectedReturn": 0.001,
              "preCostExpectedReturn": 0.003,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            },
            "historicalProportionRandom": {
              "macroF1": 0.34,
              "postCostExpectedReturn": 0,
              "preCostExpectedReturn": 0.002,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            }
          },
          "model": {
            "directionCorrectCount": 10,
            "macroF1": 0.62,
            "postCostExpectedReturn": 0.004,
            "preCostExpectedReturn": 0.008
          }
        }
      },
      "schemaVersion": "v1.4d-research-scorecard/4-deterministic",
      "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
    },
    "thresholds": {
      "minClassEffectiveTest": {
        "24h": 5,
        "72h": 2
      },
      "minDirectionalCoverage": {
        "24h": 0.5,
        "72h": 0.5
      },
      "minEffectiveTest": {
        "24h": 30,
        "72h": 10
      },
      "minMarketRegimeCoverage": {
        "24h": 0.9,
        "72h": 0.9
      },
      "minPostCostLift": {
        "24h": 0,
        "72h": 0
      },
      "minPreCostLift": {
        "24h": 0.001,
        "72h": 0.001
      },
      "minWilsonLowerBound": {
        "24h": 0.45,
        "72h": 0.35
      },
      "requireAllBaselines": true,
      "requireMarketRegime": true,
      "schemaVersion": "v1.4d-go-no-go-thresholds/1"
    },
    "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
  },
  "output": {
    "baselineAvailability": {
      "24h": {
        "postCostReferenceBaseline": "follow4hTrend",
        "preCostReferenceBaseline": "follow4hTrend",
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "AVAILABLE",
        "usableBaselines": [
          "alwaysRange",
          "follow4hTrend",
          "historicalProportionRandom"
        ]
      },
      "72h": {
        "postCostReferenceBaseline": "follow4hTrend",
        "preCostReferenceBaseline": "follow4hTrend",
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "AVAILABLE",
        "usableBaselines": [
          "alwaysRange",
          "follow4hTrend",
          "historicalProportionRandom"
        ]
      }
    },
    "evaluatedAt": "2026-01-02T00:00:00Z",
    "evaluationVersion": "eval-1",
    "horizonResults": {
      "24h": {
        "directionalCoverage": 0.6666666666666666,
        "effectiveTest": 45,
        "marketRegimeCoverage": 1,
        "postCostLift": 0.003,
        "preCostLift": 0.005,
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "GO",
        "wilson95": {
          "confidenceLevel": 0.95,
          "lower": 0.520704883099,
          "successes": 30,
          "trials": 45,
          "upper": 0.786411250657,
          "z": 1.959963984540054
        }
      },
      "72h": {
        "directionalCoverage": 0.6666666666666666,
        "effectiveTest": 15,
        "marketRegimeCoverage": 1,
        "postCostLift": 0.003,
        "preCostLift": 0.005,
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "GO",
        "wilson95": {
          "confidenceLevel": 0.95,
          "lower": 0.417135477385,
          "successes": 10,
          "trials": 15,
          "upper": 0.848236755603,
          "z": 1.959963984540054
        }
      }
    },
    "overall": {
      "primaryReasonCode": "NONE",
      "reasonCodes": [],
      "status": "GO"
    },
    "primaryReasonCode": "NONE",
    "reasonCodes": [],
    "schemaVersion": "v1.4d-go-no-go-output/2",
    "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
  }
}
```

#### 向量 `TOP_AUDIT_ID_MISMATCH`

输入Schema：`PASS`；overall=`DATA_GATE_FAILED`；primary=`INPUT_CONSISTENCY_FAILED`。

```json
{
  "input": {
    "auditTrail": {
      "authenticityGateStatus": "PASSED",
      "backfillBatchIds": [
        "223e4567-e89b-42d3-a456-426614174001"
      ],
      "datasetVersion": "v1.4d-sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "evaluatedAt": "2026-01-02T00:00:00Z",
      "evaluationVersion": "eval-other",
      "featureCoverage": 1,
      "generationSummary": {
        "attempted": 80,
        "blocked": 0,
        "conflicts": 0,
        "evaluated": 80,
        "expected": 80,
        "inserted": 80,
        "reusedIdentical": 0
      },
      "manifestContentHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "manifestCoverage": 1,
      "schemaVersion": "v1.4d-audit-trail/1",
      "validationRunId": "123e4567-e89b-42d3-a456-426614174000",
      "validationRunStatus": "SUCCEEDED",
      "vintageIds": [
        "vintage-1"
      ]
    },
    "baselineAvailabilityInput": {
      "24h": {
        "alwaysRange": {
          "macroF1": 0.3,
          "postCostExpectedReturn": -0.001,
          "preCostExpectedReturn": 0.001,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        },
        "follow4hTrend": {
          "macroF1": 0.45,
          "postCostExpectedReturn": 0.001,
          "preCostExpectedReturn": 0.003,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        },
        "historicalProportionRandom": {
          "macroF1": 0.34,
          "postCostExpectedReturn": 0,
          "preCostExpectedReturn": 0.002,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        }
      },
      "72h": {
        "alwaysRange": {
          "macroF1": 0.3,
          "postCostExpectedReturn": -0.001,
          "preCostExpectedReturn": 0.001,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        },
        "follow4hTrend": {
          "macroF1": 0.45,
          "postCostExpectedReturn": 0.001,
          "preCostExpectedReturn": 0.003,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        },
        "historicalProportionRandom": {
          "macroF1": 0.34,
          "postCostExpectedReturn": 0,
          "preCostExpectedReturn": 0.002,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        }
      }
    },
    "directionalCoverage": {
      "24h": 0.6666666666666666,
      "72h": 0.6666666666666666
    },
    "evaluatedAt": "2026-01-02T00:00:00Z",
    "evaluationVersion": "eval-1",
    "marketRegimeAtGeneration": {
      "24h": {
        "DOWN": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        },
        "RANGE": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        },
        "UP": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        }
      },
      "72h": {
        "DOWN": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        },
        "RANGE": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        },
        "UP": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        }
      }
    },
    "marketRegimeCoverage": {
      "24h": 1,
      "72h": 1
    },
    "postCostLift": {
      "24h": 0.003,
      "72h": 0.003
    },
    "preCostLift": {
      "24h": 0.005,
      "72h": 0.005
    },
    "predictedDownCount": {
      "24h": 15,
      "72h": 5
    },
    "predictedUpCount": {
      "24h": 15,
      "72h": 5
    },
    "rangeAttribution": {
      "24h": {
        "allPredictionsRange": false,
        "correctlyPredictedRangeCount": 14,
        "predictedRangeCount": 15,
        "rangeTotal": 15
      },
      "72h": {
        "allPredictionsRange": false,
        "correctlyPredictedRangeCount": 4,
        "predictedRangeCount": 5,
        "rangeTotal": 5
      }
    },
    "sampleAccounting": {
      "24h": {
        "classEffectiveTest": {
          "DOWN": 15,
          "RANGE": 15,
          "UP": 15
        },
        "effectiveTest": 45,
        "predictedDownCount": 15,
        "predictedRangeCount": 15,
        "predictedUpCount": 15,
        "rawTest": 270
      },
      "72h": {
        "classEffectiveTest": {
          "DOWN": 5,
          "RANGE": 5,
          "UP": 5
        },
        "effectiveTest": 15,
        "predictedDownCount": 5,
        "predictedRangeCount": 5,
        "predictedUpCount": 5,
        "rawTest": 45
      }
    },
    "schemaVersion": "v1.4d-go-no-go-input/2",
    "scorecard": {
      "evaluatedAt": "2026-01-02T00:00:00Z",
      "evaluationVersion": "eval-1",
      "horizons": {
        "24h": {
          "baselines": {
            "alwaysRange": {
              "macroF1": 0.3,
              "postCostExpectedReturn": -0.001,
              "preCostExpectedReturn": 0.001,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            },
            "follow4hTrend": {
              "macroF1": 0.45,
              "postCostExpectedReturn": 0.001,
              "preCostExpectedReturn": 0.003,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            },
            "historicalProportionRandom": {
              "macroF1": 0.34,
              "postCostExpectedReturn": 0,
              "preCostExpectedReturn": 0.002,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            }
          },
          "model": {
            "directionCorrectCount": 30,
            "macroF1": 0.62,
            "postCostExpectedReturn": 0.004,
            "preCostExpectedReturn": 0.008
          }
        },
        "72h": {
          "baselines": {
            "alwaysRange": {
              "macroF1": 0.3,
              "postCostExpectedReturn": -0.001,
              "preCostExpectedReturn": 0.001,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            },
            "follow4hTrend": {
              "macroF1": 0.45,
              "postCostExpectedReturn": 0.001,
              "preCostExpectedReturn": 0.003,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            },
            "historicalProportionRandom": {
              "macroF1": 0.34,
              "postCostExpectedReturn": 0,
              "preCostExpectedReturn": 0.002,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            }
          },
          "model": {
            "directionCorrectCount": 10,
            "macroF1": 0.62,
            "postCostExpectedReturn": 0.004,
            "preCostExpectedReturn": 0.008
          }
        }
      },
      "schemaVersion": "v1.4d-research-scorecard/4-deterministic",
      "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
    },
    "thresholds": {
      "minClassEffectiveTest": {
        "24h": 5,
        "72h": 2
      },
      "minDirectionalCoverage": {
        "24h": 0.5,
        "72h": 0.5
      },
      "minEffectiveTest": {
        "24h": 30,
        "72h": 10
      },
      "minMarketRegimeCoverage": {
        "24h": 0.9,
        "72h": 0.9
      },
      "minPostCostLift": {
        "24h": 0,
        "72h": 0
      },
      "minPreCostLift": {
        "24h": 0.001,
        "72h": 0.001
      },
      "minWilsonLowerBound": {
        "24h": 0.45,
        "72h": 0.35
      },
      "requireAllBaselines": true,
      "requireMarketRegime": true,
      "schemaVersion": "v1.4d-go-no-go-thresholds/1"
    },
    "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
  },
  "output": {
    "baselineAvailability": {
      "24h": {
        "postCostReferenceBaseline": "follow4hTrend",
        "preCostReferenceBaseline": "follow4hTrend",
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "AVAILABLE",
        "usableBaselines": [
          "alwaysRange",
          "follow4hTrend",
          "historicalProportionRandom"
        ]
      },
      "72h": {
        "postCostReferenceBaseline": "follow4hTrend",
        "preCostReferenceBaseline": "follow4hTrend",
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "AVAILABLE",
        "usableBaselines": [
          "alwaysRange",
          "follow4hTrend",
          "historicalProportionRandom"
        ]
      }
    },
    "evaluatedAt": "2026-01-02T00:00:00Z",
    "evaluationVersion": "eval-1",
    "horizonResults": {
      "24h": {
        "directionalCoverage": 0.6666666666666666,
        "effectiveTest": 45,
        "marketRegimeCoverage": 1,
        "postCostLift": 0.003,
        "preCostLift": 0.005,
        "primaryReasonCode": "INPUT_CONSISTENCY_FAILED",
        "reasonCodes": [
          "INPUT_CONSISTENCY_FAILED"
        ],
        "status": "DATA_GATE_FAILED",
        "wilson95": {
          "confidenceLevel": 0.95,
          "lower": 0.520704883099,
          "successes": 30,
          "trials": 45,
          "upper": 0.786411250657,
          "z": 1.959963984540054
        }
      },
      "72h": {
        "directionalCoverage": 0.6666666666666666,
        "effectiveTest": 15,
        "marketRegimeCoverage": 1,
        "postCostLift": 0.003,
        "preCostLift": 0.005,
        "primaryReasonCode": "INPUT_CONSISTENCY_FAILED",
        "reasonCodes": [
          "INPUT_CONSISTENCY_FAILED"
        ],
        "status": "DATA_GATE_FAILED",
        "wilson95": {
          "confidenceLevel": 0.95,
          "lower": 0.417135477385,
          "successes": 10,
          "trials": 15,
          "upper": 0.848236755603,
          "z": 1.959963984540054
        }
      }
    },
    "overall": {
      "primaryReasonCode": "INPUT_CONSISTENCY_FAILED",
      "reasonCodes": [
        "INPUT_CONSISTENCY_FAILED"
      ],
      "status": "DATA_GATE_FAILED"
    },
    "primaryReasonCode": "INPUT_CONSISTENCY_FAILED",
    "reasonCodes": [
      "INPUT_CONSISTENCY_FAILED"
    ],
    "schemaVersion": "v1.4d-go-no-go-output/2",
    "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
  }
}
```

#### 向量 `TOP_SCORECARD_ID_MISMATCH`

输入Schema：`PASS`；overall=`DATA_GATE_FAILED`；primary=`INPUT_CONSISTENCY_FAILED`。

```json
{
  "input": {
    "auditTrail": {
      "authenticityGateStatus": "PASSED",
      "backfillBatchIds": [
        "223e4567-e89b-42d3-a456-426614174001"
      ],
      "datasetVersion": "v1.4d-sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "evaluatedAt": "2026-01-02T00:00:00Z",
      "evaluationVersion": "eval-1",
      "featureCoverage": 1,
      "generationSummary": {
        "attempted": 80,
        "blocked": 0,
        "conflicts": 0,
        "evaluated": 80,
        "expected": 80,
        "inserted": 80,
        "reusedIdentical": 0
      },
      "manifestContentHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "manifestCoverage": 1,
      "schemaVersion": "v1.4d-audit-trail/1",
      "validationRunId": "123e4567-e89b-42d3-a456-426614174000",
      "validationRunStatus": "SUCCEEDED",
      "vintageIds": [
        "vintage-1"
      ]
    },
    "baselineAvailabilityInput": {
      "24h": {
        "alwaysRange": {
          "macroF1": 0.3,
          "postCostExpectedReturn": -0.001,
          "preCostExpectedReturn": 0.001,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        },
        "follow4hTrend": {
          "macroF1": 0.45,
          "postCostExpectedReturn": 0.001,
          "preCostExpectedReturn": 0.003,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        },
        "historicalProportionRandom": {
          "macroF1": 0.34,
          "postCostExpectedReturn": 0,
          "preCostExpectedReturn": 0.002,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        }
      },
      "72h": {
        "alwaysRange": {
          "macroF1": 0.3,
          "postCostExpectedReturn": -0.001,
          "preCostExpectedReturn": 0.001,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        },
        "follow4hTrend": {
          "macroF1": 0.45,
          "postCostExpectedReturn": 0.001,
          "preCostExpectedReturn": 0.003,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        },
        "historicalProportionRandom": {
          "macroF1": 0.34,
          "postCostExpectedReturn": 0,
          "preCostExpectedReturn": 0.002,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        }
      }
    },
    "directionalCoverage": {
      "24h": 0.6666666666666666,
      "72h": 0.6666666666666666
    },
    "evaluatedAt": "2026-01-02T00:00:00Z",
    "evaluationVersion": "eval-1",
    "marketRegimeAtGeneration": {
      "24h": {
        "DOWN": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        },
        "RANGE": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        },
        "UP": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        }
      },
      "72h": {
        "DOWN": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        },
        "RANGE": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        },
        "UP": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        }
      }
    },
    "marketRegimeCoverage": {
      "24h": 1,
      "72h": 1
    },
    "postCostLift": {
      "24h": 0.003,
      "72h": 0.003
    },
    "preCostLift": {
      "24h": 0.005,
      "72h": 0.005
    },
    "predictedDownCount": {
      "24h": 15,
      "72h": 5
    },
    "predictedUpCount": {
      "24h": 15,
      "72h": 5
    },
    "rangeAttribution": {
      "24h": {
        "allPredictionsRange": false,
        "correctlyPredictedRangeCount": 14,
        "predictedRangeCount": 15,
        "rangeTotal": 15
      },
      "72h": {
        "allPredictionsRange": false,
        "correctlyPredictedRangeCount": 4,
        "predictedRangeCount": 5,
        "rangeTotal": 5
      }
    },
    "sampleAccounting": {
      "24h": {
        "classEffectiveTest": {
          "DOWN": 15,
          "RANGE": 15,
          "UP": 15
        },
        "effectiveTest": 45,
        "predictedDownCount": 15,
        "predictedRangeCount": 15,
        "predictedUpCount": 15,
        "rawTest": 270
      },
      "72h": {
        "classEffectiveTest": {
          "DOWN": 5,
          "RANGE": 5,
          "UP": 5
        },
        "effectiveTest": 15,
        "predictedDownCount": 5,
        "predictedRangeCount": 5,
        "predictedUpCount": 5,
        "rawTest": 45
      }
    },
    "schemaVersion": "v1.4d-go-no-go-input/2",
    "scorecard": {
      "evaluatedAt": "2026-01-02T00:00:00Z",
      "evaluationVersion": "eval-1",
      "horizons": {
        "24h": {
          "baselines": {
            "alwaysRange": {
              "macroF1": 0.3,
              "postCostExpectedReturn": -0.001,
              "preCostExpectedReturn": 0.001,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            },
            "follow4hTrend": {
              "macroF1": 0.45,
              "postCostExpectedReturn": 0.001,
              "preCostExpectedReturn": 0.003,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            },
            "historicalProportionRandom": {
              "macroF1": 0.34,
              "postCostExpectedReturn": 0,
              "preCostExpectedReturn": 0.002,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            }
          },
          "model": {
            "directionCorrectCount": 30,
            "macroF1": 0.62,
            "postCostExpectedReturn": 0.004,
            "preCostExpectedReturn": 0.008
          }
        },
        "72h": {
          "baselines": {
            "alwaysRange": {
              "macroF1": 0.3,
              "postCostExpectedReturn": -0.001,
              "preCostExpectedReturn": 0.001,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            },
            "follow4hTrend": {
              "macroF1": 0.45,
              "postCostExpectedReturn": 0.001,
              "preCostExpectedReturn": 0.003,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            },
            "historicalProportionRandom": {
              "macroF1": 0.34,
              "postCostExpectedReturn": 0,
              "preCostExpectedReturn": 0.002,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            }
          },
          "model": {
            "directionCorrectCount": 10,
            "macroF1": 0.62,
            "postCostExpectedReturn": 0.004,
            "preCostExpectedReturn": 0.008
          }
        }
      },
      "schemaVersion": "v1.4d-research-scorecard/4-deterministic",
      "validationRunId": "123e4567-e89b-42d3-a456-426614174099"
    },
    "thresholds": {
      "minClassEffectiveTest": {
        "24h": 5,
        "72h": 2
      },
      "minDirectionalCoverage": {
        "24h": 0.5,
        "72h": 0.5
      },
      "minEffectiveTest": {
        "24h": 30,
        "72h": 10
      },
      "minMarketRegimeCoverage": {
        "24h": 0.9,
        "72h": 0.9
      },
      "minPostCostLift": {
        "24h": 0,
        "72h": 0
      },
      "minPreCostLift": {
        "24h": 0.001,
        "72h": 0.001
      },
      "minWilsonLowerBound": {
        "24h": 0.45,
        "72h": 0.35
      },
      "requireAllBaselines": true,
      "requireMarketRegime": true,
      "schemaVersion": "v1.4d-go-no-go-thresholds/1"
    },
    "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
  },
  "output": {
    "baselineAvailability": {
      "24h": {
        "postCostReferenceBaseline": "follow4hTrend",
        "preCostReferenceBaseline": "follow4hTrend",
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "AVAILABLE",
        "usableBaselines": [
          "alwaysRange",
          "follow4hTrend",
          "historicalProportionRandom"
        ]
      },
      "72h": {
        "postCostReferenceBaseline": "follow4hTrend",
        "preCostReferenceBaseline": "follow4hTrend",
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "AVAILABLE",
        "usableBaselines": [
          "alwaysRange",
          "follow4hTrend",
          "historicalProportionRandom"
        ]
      }
    },
    "evaluatedAt": "2026-01-02T00:00:00Z",
    "evaluationVersion": "eval-1",
    "horizonResults": {
      "24h": {
        "directionalCoverage": 0.6666666666666666,
        "effectiveTest": 45,
        "marketRegimeCoverage": 1,
        "postCostLift": 0.003,
        "preCostLift": 0.005,
        "primaryReasonCode": "INPUT_CONSISTENCY_FAILED",
        "reasonCodes": [
          "INPUT_CONSISTENCY_FAILED"
        ],
        "status": "DATA_GATE_FAILED",
        "wilson95": {
          "confidenceLevel": 0.95,
          "lower": 0.520704883099,
          "successes": 30,
          "trials": 45,
          "upper": 0.786411250657,
          "z": 1.959963984540054
        }
      },
      "72h": {
        "directionalCoverage": 0.6666666666666666,
        "effectiveTest": 15,
        "marketRegimeCoverage": 1,
        "postCostLift": 0.003,
        "preCostLift": 0.005,
        "primaryReasonCode": "INPUT_CONSISTENCY_FAILED",
        "reasonCodes": [
          "INPUT_CONSISTENCY_FAILED"
        ],
        "status": "DATA_GATE_FAILED",
        "wilson95": {
          "confidenceLevel": 0.95,
          "lower": 0.417135477385,
          "successes": 10,
          "trials": 15,
          "upper": 0.848236755603,
          "z": 1.959963984540054
        }
      }
    },
    "overall": {
      "primaryReasonCode": "INPUT_CONSISTENCY_FAILED",
      "reasonCodes": [
        "INPUT_CONSISTENCY_FAILED"
      ],
      "status": "DATA_GATE_FAILED"
    },
    "primaryReasonCode": "INPUT_CONSISTENCY_FAILED",
    "reasonCodes": [
      "INPUT_CONSISTENCY_FAILED"
    ],
    "schemaVersion": "v1.4d-go-no-go-output/2",
    "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
  }
}
```

#### 向量 `WILSON_P_ONE`

输入Schema：`PASS`；overall=`GO`；primary=`NONE`。

```json
{
  "input": {
    "auditTrail": {
      "authenticityGateStatus": "PASSED",
      "backfillBatchIds": [
        "223e4567-e89b-42d3-a456-426614174001"
      ],
      "datasetVersion": "v1.4d-sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "evaluatedAt": "2026-01-02T00:00:00Z",
      "evaluationVersion": "eval-1",
      "featureCoverage": 1,
      "generationSummary": {
        "attempted": 80,
        "blocked": 0,
        "conflicts": 0,
        "evaluated": 80,
        "expected": 80,
        "inserted": 80,
        "reusedIdentical": 0
      },
      "manifestContentHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "manifestCoverage": 1,
      "schemaVersion": "v1.4d-audit-trail/1",
      "validationRunId": "123e4567-e89b-42d3-a456-426614174000",
      "validationRunStatus": "SUCCEEDED",
      "vintageIds": [
        "vintage-1"
      ]
    },
    "baselineAvailabilityInput": {
      "24h": {
        "alwaysRange": {
          "macroF1": 0.3,
          "postCostExpectedReturn": -0.001,
          "preCostExpectedReturn": 0.001,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        },
        "follow4hTrend": {
          "macroF1": 0.45,
          "postCostExpectedReturn": 0.001,
          "preCostExpectedReturn": 0.003,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        },
        "historicalProportionRandom": {
          "macroF1": 0.34,
          "postCostExpectedReturn": 0,
          "preCostExpectedReturn": 0.002,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        }
      },
      "72h": {
        "alwaysRange": {
          "macroF1": 0.3,
          "postCostExpectedReturn": -0.001,
          "preCostExpectedReturn": 0.001,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        },
        "follow4hTrend": {
          "macroF1": 0.45,
          "postCostExpectedReturn": 0.001,
          "preCostExpectedReturn": 0.003,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        },
        "historicalProportionRandom": {
          "macroF1": 0.34,
          "postCostExpectedReturn": 0,
          "preCostExpectedReturn": 0.002,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        }
      }
    },
    "directionalCoverage": {
      "24h": 0.6666666666666666,
      "72h": 0.6666666666666666
    },
    "evaluatedAt": "2026-01-02T00:00:00Z",
    "evaluationVersion": "eval-1",
    "marketRegimeAtGeneration": {
      "24h": {
        "DOWN": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        },
        "RANGE": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        },
        "UP": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        }
      },
      "72h": {
        "DOWN": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        },
        "RANGE": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        },
        "UP": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        }
      }
    },
    "marketRegimeCoverage": {
      "24h": 1,
      "72h": 1
    },
    "postCostLift": {
      "24h": 0.003,
      "72h": 0.003
    },
    "preCostLift": {
      "24h": 0.005,
      "72h": 0.005
    },
    "predictedDownCount": {
      "24h": 15,
      "72h": 5
    },
    "predictedUpCount": {
      "24h": 15,
      "72h": 5
    },
    "rangeAttribution": {
      "24h": {
        "allPredictionsRange": false,
        "correctlyPredictedRangeCount": 14,
        "predictedRangeCount": 15,
        "rangeTotal": 15
      },
      "72h": {
        "allPredictionsRange": false,
        "correctlyPredictedRangeCount": 4,
        "predictedRangeCount": 5,
        "rangeTotal": 5
      }
    },
    "sampleAccounting": {
      "24h": {
        "classEffectiveTest": {
          "DOWN": 15,
          "RANGE": 15,
          "UP": 15
        },
        "effectiveTest": 45,
        "predictedDownCount": 15,
        "predictedRangeCount": 15,
        "predictedUpCount": 15,
        "rawTest": 270
      },
      "72h": {
        "classEffectiveTest": {
          "DOWN": 5,
          "RANGE": 5,
          "UP": 5
        },
        "effectiveTest": 15,
        "predictedDownCount": 5,
        "predictedRangeCount": 5,
        "predictedUpCount": 5,
        "rawTest": 45
      }
    },
    "schemaVersion": "v1.4d-go-no-go-input/2",
    "scorecard": {
      "evaluatedAt": "2026-01-02T00:00:00Z",
      "evaluationVersion": "eval-1",
      "horizons": {
        "24h": {
          "baselines": {
            "alwaysRange": {
              "macroF1": 0.3,
              "postCostExpectedReturn": -0.001,
              "preCostExpectedReturn": 0.001,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            },
            "follow4hTrend": {
              "macroF1": 0.45,
              "postCostExpectedReturn": 0.001,
              "preCostExpectedReturn": 0.003,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            },
            "historicalProportionRandom": {
              "macroF1": 0.34,
              "postCostExpectedReturn": 0,
              "preCostExpectedReturn": 0.002,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            }
          },
          "model": {
            "directionCorrectCount": 45,
            "macroF1": 0.62,
            "postCostExpectedReturn": 0.004,
            "preCostExpectedReturn": 0.008
          }
        },
        "72h": {
          "baselines": {
            "alwaysRange": {
              "macroF1": 0.3,
              "postCostExpectedReturn": -0.001,
              "preCostExpectedReturn": 0.001,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            },
            "follow4hTrend": {
              "macroF1": 0.45,
              "postCostExpectedReturn": 0.001,
              "preCostExpectedReturn": 0.003,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            },
            "historicalProportionRandom": {
              "macroF1": 0.34,
              "postCostExpectedReturn": 0,
              "preCostExpectedReturn": 0.002,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            }
          },
          "model": {
            "directionCorrectCount": 15,
            "macroF1": 0.62,
            "postCostExpectedReturn": 0.004,
            "preCostExpectedReturn": 0.008
          }
        }
      },
      "schemaVersion": "v1.4d-research-scorecard/4-deterministic",
      "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
    },
    "thresholds": {
      "minClassEffectiveTest": {
        "24h": 5,
        "72h": 2
      },
      "minDirectionalCoverage": {
        "24h": 0.5,
        "72h": 0.5
      },
      "minEffectiveTest": {
        "24h": 30,
        "72h": 10
      },
      "minMarketRegimeCoverage": {
        "24h": 0.9,
        "72h": 0.9
      },
      "minPostCostLift": {
        "24h": 0,
        "72h": 0
      },
      "minPreCostLift": {
        "24h": 0.001,
        "72h": 0.001
      },
      "minWilsonLowerBound": {
        "24h": 0.45,
        "72h": 0.35
      },
      "requireAllBaselines": true,
      "requireMarketRegime": true,
      "schemaVersion": "v1.4d-go-no-go-thresholds/1"
    },
    "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
  },
  "output": {
    "baselineAvailability": {
      "24h": {
        "postCostReferenceBaseline": "follow4hTrend",
        "preCostReferenceBaseline": "follow4hTrend",
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "AVAILABLE",
        "usableBaselines": [
          "alwaysRange",
          "follow4hTrend",
          "historicalProportionRandom"
        ]
      },
      "72h": {
        "postCostReferenceBaseline": "follow4hTrend",
        "preCostReferenceBaseline": "follow4hTrend",
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "AVAILABLE",
        "usableBaselines": [
          "alwaysRange",
          "follow4hTrend",
          "historicalProportionRandom"
        ]
      }
    },
    "evaluatedAt": "2026-01-02T00:00:00Z",
    "evaluationVersion": "eval-1",
    "horizonResults": {
      "24h": {
        "directionalCoverage": 0.6666666666666666,
        "effectiveTest": 45,
        "marketRegimeCoverage": 1,
        "postCostLift": 0.003,
        "preCostLift": 0.005,
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "GO",
        "wilson95": {
          "confidenceLevel": 0.95,
          "lower": 0.921348401267,
          "successes": 45,
          "trials": 45,
          "upper": 1.0,
          "z": 1.959963984540054
        }
      },
      "72h": {
        "directionalCoverage": 0.6666666666666666,
        "effectiveTest": 15,
        "marketRegimeCoverage": 1,
        "postCostLift": 0.003,
        "preCostLift": 0.005,
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "GO",
        "wilson95": {
          "confidenceLevel": 0.95,
          "lower": 0.796116698964,
          "successes": 15,
          "trials": 15,
          "upper": 1.0,
          "z": 1.959963984540054
        }
      }
    },
    "overall": {
      "primaryReasonCode": "NONE",
      "reasonCodes": [],
      "status": "GO"
    },
    "primaryReasonCode": "NONE",
    "reasonCodes": [],
    "schemaVersion": "v1.4d-go-no-go-output/2",
    "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
  }
}
```

#### 向量 `WILSON_P_ZERO`

输入Schema：`PASS`；overall=`NO_GO`；primary=`WILSON_BELOW_THRESHOLD`。

```json
{
  "input": {
    "auditTrail": {
      "authenticityGateStatus": "PASSED",
      "backfillBatchIds": [
        "223e4567-e89b-42d3-a456-426614174001"
      ],
      "datasetVersion": "v1.4d-sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "evaluatedAt": "2026-01-02T00:00:00Z",
      "evaluationVersion": "eval-1",
      "featureCoverage": 1,
      "generationSummary": {
        "attempted": 80,
        "blocked": 0,
        "conflicts": 0,
        "evaluated": 80,
        "expected": 80,
        "inserted": 80,
        "reusedIdentical": 0
      },
      "manifestContentHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "manifestCoverage": 1,
      "schemaVersion": "v1.4d-audit-trail/1",
      "validationRunId": "123e4567-e89b-42d3-a456-426614174000",
      "validationRunStatus": "SUCCEEDED",
      "vintageIds": [
        "vintage-1"
      ]
    },
    "baselineAvailabilityInput": {
      "24h": {
        "alwaysRange": {
          "macroF1": 0.3,
          "postCostExpectedReturn": -0.001,
          "preCostExpectedReturn": 0.001,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        },
        "follow4hTrend": {
          "macroF1": 0.45,
          "postCostExpectedReturn": 0.001,
          "preCostExpectedReturn": 0.003,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        },
        "historicalProportionRandom": {
          "macroF1": 0.34,
          "postCostExpectedReturn": 0,
          "preCostExpectedReturn": 0.002,
          "reasonCode": "NONE",
          "sampleCount": 45,
          "status": "AVAILABLE"
        }
      },
      "72h": {
        "alwaysRange": {
          "macroF1": 0.3,
          "postCostExpectedReturn": -0.001,
          "preCostExpectedReturn": 0.001,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        },
        "follow4hTrend": {
          "macroF1": 0.45,
          "postCostExpectedReturn": 0.001,
          "preCostExpectedReturn": 0.003,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        },
        "historicalProportionRandom": {
          "macroF1": 0.34,
          "postCostExpectedReturn": 0,
          "preCostExpectedReturn": 0.002,
          "reasonCode": "NONE",
          "sampleCount": 15,
          "status": "AVAILABLE"
        }
      }
    },
    "directionalCoverage": {
      "24h": 0.6666666666666666,
      "72h": 0.6666666666666666
    },
    "evaluatedAt": "2026-01-02T00:00:00Z",
    "evaluationVersion": "eval-1",
    "marketRegimeAtGeneration": {
      "24h": {
        "DOWN": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        },
        "RANGE": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        },
        "UP": {
          "directionCorrectCount": 13,
          "sampleCount": 15
        }
      },
      "72h": {
        "DOWN": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        },
        "RANGE": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        },
        "UP": {
          "directionCorrectCount": 3,
          "sampleCount": 5
        }
      }
    },
    "marketRegimeCoverage": {
      "24h": 1,
      "72h": 1
    },
    "postCostLift": {
      "24h": 0.003,
      "72h": 0.003
    },
    "preCostLift": {
      "24h": 0.005,
      "72h": 0.005
    },
    "predictedDownCount": {
      "24h": 15,
      "72h": 5
    },
    "predictedUpCount": {
      "24h": 15,
      "72h": 5
    },
    "rangeAttribution": {
      "24h": {
        "allPredictionsRange": false,
        "correctlyPredictedRangeCount": 14,
        "predictedRangeCount": 15,
        "rangeTotal": 15
      },
      "72h": {
        "allPredictionsRange": false,
        "correctlyPredictedRangeCount": 4,
        "predictedRangeCount": 5,
        "rangeTotal": 5
      }
    },
    "sampleAccounting": {
      "24h": {
        "classEffectiveTest": {
          "DOWN": 15,
          "RANGE": 15,
          "UP": 15
        },
        "effectiveTest": 45,
        "predictedDownCount": 15,
        "predictedRangeCount": 15,
        "predictedUpCount": 15,
        "rawTest": 270
      },
      "72h": {
        "classEffectiveTest": {
          "DOWN": 5,
          "RANGE": 5,
          "UP": 5
        },
        "effectiveTest": 15,
        "predictedDownCount": 5,
        "predictedRangeCount": 5,
        "predictedUpCount": 5,
        "rawTest": 45
      }
    },
    "schemaVersion": "v1.4d-go-no-go-input/2",
    "scorecard": {
      "evaluatedAt": "2026-01-02T00:00:00Z",
      "evaluationVersion": "eval-1",
      "horizons": {
        "24h": {
          "baselines": {
            "alwaysRange": {
              "macroF1": 0.3,
              "postCostExpectedReturn": -0.001,
              "preCostExpectedReturn": 0.001,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            },
            "follow4hTrend": {
              "macroF1": 0.45,
              "postCostExpectedReturn": 0.001,
              "preCostExpectedReturn": 0.003,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            },
            "historicalProportionRandom": {
              "macroF1": 0.34,
              "postCostExpectedReturn": 0,
              "preCostExpectedReturn": 0.002,
              "reasonCode": "NONE",
              "sampleCount": 45,
              "status": "AVAILABLE"
            }
          },
          "model": {
            "directionCorrectCount": 0,
            "macroF1": 0.62,
            "postCostExpectedReturn": 0.004,
            "preCostExpectedReturn": 0.008
          }
        },
        "72h": {
          "baselines": {
            "alwaysRange": {
              "macroF1": 0.3,
              "postCostExpectedReturn": -0.001,
              "preCostExpectedReturn": 0.001,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            },
            "follow4hTrend": {
              "macroF1": 0.45,
              "postCostExpectedReturn": 0.001,
              "preCostExpectedReturn": 0.003,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            },
            "historicalProportionRandom": {
              "macroF1": 0.34,
              "postCostExpectedReturn": 0,
              "preCostExpectedReturn": 0.002,
              "reasonCode": "NONE",
              "sampleCount": 15,
              "status": "AVAILABLE"
            }
          },
          "model": {
            "directionCorrectCount": 0,
            "macroF1": 0.62,
            "postCostExpectedReturn": 0.004,
            "preCostExpectedReturn": 0.008
          }
        }
      },
      "schemaVersion": "v1.4d-research-scorecard/4-deterministic",
      "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
    },
    "thresholds": {
      "minClassEffectiveTest": {
        "24h": 5,
        "72h": 2
      },
      "minDirectionalCoverage": {
        "24h": 0.5,
        "72h": 0.5
      },
      "minEffectiveTest": {
        "24h": 30,
        "72h": 10
      },
      "minMarketRegimeCoverage": {
        "24h": 0.9,
        "72h": 0.9
      },
      "minPostCostLift": {
        "24h": 0,
        "72h": 0
      },
      "minPreCostLift": {
        "24h": 0.001,
        "72h": 0.001
      },
      "minWilsonLowerBound": {
        "24h": 0.45,
        "72h": 0.35
      },
      "requireAllBaselines": true,
      "requireMarketRegime": true,
      "schemaVersion": "v1.4d-go-no-go-thresholds/1"
    },
    "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
  },
  "output": {
    "baselineAvailability": {
      "24h": {
        "postCostReferenceBaseline": "follow4hTrend",
        "preCostReferenceBaseline": "follow4hTrend",
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "AVAILABLE",
        "usableBaselines": [
          "alwaysRange",
          "follow4hTrend",
          "historicalProportionRandom"
        ]
      },
      "72h": {
        "postCostReferenceBaseline": "follow4hTrend",
        "preCostReferenceBaseline": "follow4hTrend",
        "primaryReasonCode": "NONE",
        "reasonCodes": [],
        "status": "AVAILABLE",
        "usableBaselines": [
          "alwaysRange",
          "follow4hTrend",
          "historicalProportionRandom"
        ]
      }
    },
    "evaluatedAt": "2026-01-02T00:00:00Z",
    "evaluationVersion": "eval-1",
    "horizonResults": {
      "24h": {
        "directionalCoverage": 0.6666666666666666,
        "effectiveTest": 45,
        "marketRegimeCoverage": 1,
        "postCostLift": 0.003,
        "preCostLift": 0.005,
        "primaryReasonCode": "WILSON_BELOW_THRESHOLD",
        "reasonCodes": [
          "WILSON_BELOW_THRESHOLD"
        ],
        "status": "NO_GO",
        "wilson95": {
          "confidenceLevel": 0.95,
          "lower": 0.0,
          "successes": 0,
          "trials": 45,
          "upper": 0.078651598733,
          "z": 1.959963984540054
        }
      },
      "72h": {
        "directionalCoverage": 0.6666666666666666,
        "effectiveTest": 15,
        "marketRegimeCoverage": 1,
        "postCostLift": 0.003,
        "preCostLift": 0.005,
        "primaryReasonCode": "WILSON_BELOW_THRESHOLD",
        "reasonCodes": [
          "WILSON_BELOW_THRESHOLD"
        ],
        "status": "NO_GO",
        "wilson95": {
          "confidenceLevel": 0.95,
          "lower": 0.0,
          "successes": 0,
          "trials": 15,
          "upper": 0.203883301036,
          "z": 1.959963984540054
        }
      }
    },
    "overall": {
      "primaryReasonCode": "WILSON_BELOW_THRESHOLD",
      "reasonCodes": [
        "WILSON_BELOW_THRESHOLD"
      ],
      "status": "NO_GO"
    },
    "primaryReasonCode": "WILSON_BELOW_THRESHOLD",
    "reasonCodes": [
      "WILSON_BELOW_THRESHOLD"
    ],
    "schemaVersion": "v1.4d-go-no-go-output/2",
    "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
  }
}
```

#### 非法向量 `MISSING_REQUIRED`

输入Schema：`REJECT`；首个拒绝位置 `/`；不产生D8输出。

```json
{
  "baselineAvailabilityInput": {
    "24h": {
      "alwaysRange": {
        "macroF1": 0.3,
        "postCostExpectedReturn": -0.001,
        "preCostExpectedReturn": 0.001,
        "reasonCode": "NONE",
        "sampleCount": 45,
        "status": "AVAILABLE"
      },
      "follow4hTrend": {
        "macroF1": 0.45,
        "postCostExpectedReturn": 0.001,
        "preCostExpectedReturn": 0.003,
        "reasonCode": "NONE",
        "sampleCount": 45,
        "status": "AVAILABLE"
      },
      "historicalProportionRandom": {
        "macroF1": 0.34,
        "postCostExpectedReturn": 0,
        "preCostExpectedReturn": 0.002,
        "reasonCode": "NONE",
        "sampleCount": 45,
        "status": "AVAILABLE"
      }
    },
    "72h": {
      "alwaysRange": {
        "macroF1": 0.3,
        "postCostExpectedReturn": -0.001,
        "preCostExpectedReturn": 0.001,
        "reasonCode": "NONE",
        "sampleCount": 15,
        "status": "AVAILABLE"
      },
      "follow4hTrend": {
        "macroF1": 0.45,
        "postCostExpectedReturn": 0.001,
        "preCostExpectedReturn": 0.003,
        "reasonCode": "NONE",
        "sampleCount": 15,
        "status": "AVAILABLE"
      },
      "historicalProportionRandom": {
        "macroF1": 0.34,
        "postCostExpectedReturn": 0,
        "preCostExpectedReturn": 0.002,
        "reasonCode": "NONE",
        "sampleCount": 15,
        "status": "AVAILABLE"
      }
    }
  },
  "directionalCoverage": {
    "24h": 0.6666666666666666,
    "72h": 0.6666666666666666
  },
  "evaluatedAt": "2026-01-02T00:00:00Z",
  "evaluationVersion": "eval-1",
  "marketRegimeAtGeneration": {
    "24h": {
      "DOWN": {
        "directionCorrectCount": 13,
        "sampleCount": 15
      },
      "RANGE": {
        "directionCorrectCount": 13,
        "sampleCount": 15
      },
      "UP": {
        "directionCorrectCount": 13,
        "sampleCount": 15
      }
    },
    "72h": {
      "DOWN": {
        "directionCorrectCount": 3,
        "sampleCount": 5
      },
      "RANGE": {
        "directionCorrectCount": 3,
        "sampleCount": 5
      },
      "UP": {
        "directionCorrectCount": 3,
        "sampleCount": 5
      }
    }
  },
  "marketRegimeCoverage": {
    "24h": 1,
    "72h": 1
  },
  "postCostLift": {
    "24h": 0.003,
    "72h": 0.003
  },
  "preCostLift": {
    "24h": 0.005,
    "72h": 0.005
  },
  "predictedDownCount": {
    "24h": 15,
    "72h": 5
  },
  "predictedUpCount": {
    "24h": 15,
    "72h": 5
  },
  "rangeAttribution": {
    "24h": {
      "allPredictionsRange": false,
      "correctlyPredictedRangeCount": 14,
      "predictedRangeCount": 15,
      "rangeTotal": 15
    },
    "72h": {
      "allPredictionsRange": false,
      "correctlyPredictedRangeCount": 4,
      "predictedRangeCount": 5,
      "rangeTotal": 5
    }
  },
  "sampleAccounting": {
    "24h": {
      "classEffectiveTest": {
        "DOWN": 15,
        "RANGE": 15,
        "UP": 15
      },
      "effectiveTest": 45,
      "predictedDownCount": 15,
      "predictedRangeCount": 15,
      "predictedUpCount": 15,
      "rawTest": 270
    },
    "72h": {
      "classEffectiveTest": {
        "DOWN": 5,
        "RANGE": 5,
        "UP": 5
      },
      "effectiveTest": 15,
      "predictedDownCount": 5,
      "predictedRangeCount": 5,
      "predictedUpCount": 5,
      "rawTest": 45
    }
  },
  "schemaVersion": "v1.4d-go-no-go-input/2",
  "scorecard": {
    "evaluatedAt": "2026-01-02T00:00:00Z",
    "evaluationVersion": "eval-1",
    "horizons": {
      "24h": {
        "baselines": {
          "alwaysRange": {
            "macroF1": 0.3,
            "postCostExpectedReturn": -0.001,
            "preCostExpectedReturn": 0.001,
            "reasonCode": "NONE",
            "sampleCount": 45,
            "status": "AVAILABLE"
          },
          "follow4hTrend": {
            "macroF1": 0.45,
            "postCostExpectedReturn": 0.001,
            "preCostExpectedReturn": 0.003,
            "reasonCode": "NONE",
            "sampleCount": 45,
            "status": "AVAILABLE"
          },
          "historicalProportionRandom": {
            "macroF1": 0.34,
            "postCostExpectedReturn": 0,
            "preCostExpectedReturn": 0.002,
            "reasonCode": "NONE",
            "sampleCount": 45,
            "status": "AVAILABLE"
          }
        },
        "model": {
          "directionCorrectCount": 30,
          "macroF1": 0.62,
          "postCostExpectedReturn": 0.004,
          "preCostExpectedReturn": 0.008
        }
      },
      "72h": {
        "baselines": {
          "alwaysRange": {
            "macroF1": 0.3,
            "postCostExpectedReturn": -0.001,
            "preCostExpectedReturn": 0.001,
            "reasonCode": "NONE",
            "sampleCount": 15,
            "status": "AVAILABLE"
          },
          "follow4hTrend": {
            "macroF1": 0.45,
            "postCostExpectedReturn": 0.001,
            "preCostExpectedReturn": 0.003,
            "reasonCode": "NONE",
            "sampleCount": 15,
            "status": "AVAILABLE"
          },
          "historicalProportionRandom": {
            "macroF1": 0.34,
            "postCostExpectedReturn": 0,
            "preCostExpectedReturn": 0.002,
            "reasonCode": "NONE",
            "sampleCount": 15,
            "status": "AVAILABLE"
          }
        },
        "model": {
          "directionCorrectCount": 10,
          "macroF1": 0.62,
          "postCostExpectedReturn": 0.004,
          "preCostExpectedReturn": 0.008
        }
      }
    },
    "schemaVersion": "v1.4d-research-scorecard/4-deterministic",
    "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
  },
  "thresholds": {
    "minClassEffectiveTest": {
      "24h": 5,
      "72h": 2
    },
    "minDirectionalCoverage": {
      "24h": 0.5,
      "72h": 0.5
    },
    "minEffectiveTest": {
      "24h": 30,
      "72h": 10
    },
    "minMarketRegimeCoverage": {
      "24h": 0.9,
      "72h": 0.9
    },
    "minPostCostLift": {
      "24h": 0,
      "72h": 0
    },
    "minPreCostLift": {
      "24h": 0.001,
      "72h": 0.001
    },
    "minWilsonLowerBound": {
      "24h": 0.45,
      "72h": 0.35
    },
    "requireAllBaselines": true,
    "requireMarketRegime": true,
    "schemaVersion": "v1.4d-go-no-go-thresholds/1"
  },
  "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
}
```

#### 非法向量 `SAMPLE_COUNT_STRING`

输入Schema：`REJECT`；首个拒绝位置 `/marketRegimeAtGeneration/24h/UP/sampleCount`；不产生D8输出。

```json
{
  "auditTrail": {
    "authenticityGateStatus": "PASSED",
    "backfillBatchIds": [
      "223e4567-e89b-42d3-a456-426614174001"
    ],
    "datasetVersion": "v1.4d-sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "evaluatedAt": "2026-01-02T00:00:00Z",
    "evaluationVersion": "eval-1",
    "featureCoverage": 1,
    "generationSummary": {
      "attempted": 80,
      "blocked": 0,
      "conflicts": 0,
      "evaluated": 80,
      "expected": 80,
      "inserted": 80,
      "reusedIdentical": 0
    },
    "manifestContentHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "manifestCoverage": 1,
    "schemaVersion": "v1.4d-audit-trail/1",
    "validationRunId": "123e4567-e89b-42d3-a456-426614174000",
    "validationRunStatus": "SUCCEEDED",
    "vintageIds": [
      "vintage-1"
    ]
  },
  "baselineAvailabilityInput": {
    "24h": {
      "alwaysRange": {
        "macroF1": 0.3,
        "postCostExpectedReturn": -0.001,
        "preCostExpectedReturn": 0.001,
        "reasonCode": "NONE",
        "sampleCount": 45,
        "status": "AVAILABLE"
      },
      "follow4hTrend": {
        "macroF1": 0.45,
        "postCostExpectedReturn": 0.001,
        "preCostExpectedReturn": 0.003,
        "reasonCode": "NONE",
        "sampleCount": 45,
        "status": "AVAILABLE"
      },
      "historicalProportionRandom": {
        "macroF1": 0.34,
        "postCostExpectedReturn": 0,
        "preCostExpectedReturn": 0.002,
        "reasonCode": "NONE",
        "sampleCount": 45,
        "status": "AVAILABLE"
      }
    },
    "72h": {
      "alwaysRange": {
        "macroF1": 0.3,
        "postCostExpectedReturn": -0.001,
        "preCostExpectedReturn": 0.001,
        "reasonCode": "NONE",
        "sampleCount": 15,
        "status": "AVAILABLE"
      },
      "follow4hTrend": {
        "macroF1": 0.45,
        "postCostExpectedReturn": 0.001,
        "preCostExpectedReturn": 0.003,
        "reasonCode": "NONE",
        "sampleCount": 15,
        "status": "AVAILABLE"
      },
      "historicalProportionRandom": {
        "macroF1": 0.34,
        "postCostExpectedReturn": 0,
        "preCostExpectedReturn": 0.002,
        "reasonCode": "NONE",
        "sampleCount": 15,
        "status": "AVAILABLE"
      }
    }
  },
  "directionalCoverage": {
    "24h": 0.6666666666666666,
    "72h": 0.6666666666666666
  },
  "evaluatedAt": "2026-01-02T00:00:00Z",
  "evaluationVersion": "eval-1",
  "marketRegimeAtGeneration": {
    "24h": {
      "DOWN": {
        "directionCorrectCount": 13,
        "sampleCount": 15
      },
      "RANGE": {
        "directionCorrectCount": 13,
        "sampleCount": 15
      },
      "UP": {
        "directionCorrectCount": 13,
        "sampleCount": "five"
      }
    },
    "72h": {
      "DOWN": {
        "directionCorrectCount": 3,
        "sampleCount": 5
      },
      "RANGE": {
        "directionCorrectCount": 3,
        "sampleCount": 5
      },
      "UP": {
        "directionCorrectCount": 3,
        "sampleCount": 5
      }
    }
  },
  "marketRegimeCoverage": {
    "24h": 1,
    "72h": 1
  },
  "postCostLift": {
    "24h": 0.003,
    "72h": 0.003
  },
  "preCostLift": {
    "24h": 0.005,
    "72h": 0.005
  },
  "predictedDownCount": {
    "24h": 15,
    "72h": 5
  },
  "predictedUpCount": {
    "24h": 15,
    "72h": 5
  },
  "rangeAttribution": {
    "24h": {
      "allPredictionsRange": false,
      "correctlyPredictedRangeCount": 14,
      "predictedRangeCount": 15,
      "rangeTotal": 15
    },
    "72h": {
      "allPredictionsRange": false,
      "correctlyPredictedRangeCount": 4,
      "predictedRangeCount": 5,
      "rangeTotal": 5
    }
  },
  "sampleAccounting": {
    "24h": {
      "classEffectiveTest": {
        "DOWN": 15,
        "RANGE": 15,
        "UP": 15
      },
      "effectiveTest": 45,
      "predictedDownCount": 15,
      "predictedRangeCount": 15,
      "predictedUpCount": 15,
      "rawTest": 270
    },
    "72h": {
      "classEffectiveTest": {
        "DOWN": 5,
        "RANGE": 5,
        "UP": 5
      },
      "effectiveTest": 15,
      "predictedDownCount": 5,
      "predictedRangeCount": 5,
      "predictedUpCount": 5,
      "rawTest": 45
    }
  },
  "schemaVersion": "v1.4d-go-no-go-input/2",
  "scorecard": {
    "evaluatedAt": "2026-01-02T00:00:00Z",
    "evaluationVersion": "eval-1",
    "horizons": {
      "24h": {
        "baselines": {
          "alwaysRange": {
            "macroF1": 0.3,
            "postCostExpectedReturn": -0.001,
            "preCostExpectedReturn": 0.001,
            "reasonCode": "NONE",
            "sampleCount": 45,
            "status": "AVAILABLE"
          },
          "follow4hTrend": {
            "macroF1": 0.45,
            "postCostExpectedReturn": 0.001,
            "preCostExpectedReturn": 0.003,
            "reasonCode": "NONE",
            "sampleCount": 45,
            "status": "AVAILABLE"
          },
          "historicalProportionRandom": {
            "macroF1": 0.34,
            "postCostExpectedReturn": 0,
            "preCostExpectedReturn": 0.002,
            "reasonCode": "NONE",
            "sampleCount": 45,
            "status": "AVAILABLE"
          }
        },
        "model": {
          "directionCorrectCount": 30,
          "macroF1": 0.62,
          "postCostExpectedReturn": 0.004,
          "preCostExpectedReturn": 0.008
        }
      },
      "72h": {
        "baselines": {
          "alwaysRange": {
            "macroF1": 0.3,
            "postCostExpectedReturn": -0.001,
            "preCostExpectedReturn": 0.001,
            "reasonCode": "NONE",
            "sampleCount": 15,
            "status": "AVAILABLE"
          },
          "follow4hTrend": {
            "macroF1": 0.45,
            "postCostExpectedReturn": 0.001,
            "preCostExpectedReturn": 0.003,
            "reasonCode": "NONE",
            "sampleCount": 15,
            "status": "AVAILABLE"
          },
          "historicalProportionRandom": {
            "macroF1": 0.34,
            "postCostExpectedReturn": 0,
            "preCostExpectedReturn": 0.002,
            "reasonCode": "NONE",
            "sampleCount": 15,
            "status": "AVAILABLE"
          }
        },
        "model": {
          "directionCorrectCount": 10,
          "macroF1": 0.62,
          "postCostExpectedReturn": 0.004,
          "preCostExpectedReturn": 0.008
        }
      }
    },
    "schemaVersion": "v1.4d-research-scorecard/4-deterministic",
    "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
  },
  "thresholds": {
    "minClassEffectiveTest": {
      "24h": 5,
      "72h": 2
    },
    "minDirectionalCoverage": {
      "24h": 0.5,
      "72h": 0.5
    },
    "minEffectiveTest": {
      "24h": 30,
      "72h": 10
    },
    "minMarketRegimeCoverage": {
      "24h": 0.9,
      "72h": 0.9
    },
    "minPostCostLift": {
      "24h": 0,
      "72h": 0
    },
    "minPreCostLift": {
      "24h": 0.001,
      "72h": 0.001
    },
    "minWilsonLowerBound": {
      "24h": 0.45,
      "72h": 0.35
    },
    "requireAllBaselines": true,
    "requireMarketRegime": true,
    "schemaVersion": "v1.4d-go-no-go-thresholds/1"
  },
  "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
}
```

#### 非法向量 `UNKNOWN_GROUP_KEY`

输入Schema：`REJECT`；首个拒绝位置 `/marketRegimeAtGeneration/24h`；不产生D8输出。

```json
{
  "auditTrail": {
    "authenticityGateStatus": "PASSED",
    "backfillBatchIds": [
      "223e4567-e89b-42d3-a456-426614174001"
    ],
    "datasetVersion": "v1.4d-sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "evaluatedAt": "2026-01-02T00:00:00Z",
    "evaluationVersion": "eval-1",
    "featureCoverage": 1,
    "generationSummary": {
      "attempted": 80,
      "blocked": 0,
      "conflicts": 0,
      "evaluated": 80,
      "expected": 80,
      "inserted": 80,
      "reusedIdentical": 0
    },
    "manifestContentHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "manifestCoverage": 1,
    "schemaVersion": "v1.4d-audit-trail/1",
    "validationRunId": "123e4567-e89b-42d3-a456-426614174000",
    "validationRunStatus": "SUCCEEDED",
    "vintageIds": [
      "vintage-1"
    ]
  },
  "baselineAvailabilityInput": {
    "24h": {
      "alwaysRange": {
        "macroF1": 0.3,
        "postCostExpectedReturn": -0.001,
        "preCostExpectedReturn": 0.001,
        "reasonCode": "NONE",
        "sampleCount": 45,
        "status": "AVAILABLE"
      },
      "follow4hTrend": {
        "macroF1": 0.45,
        "postCostExpectedReturn": 0.001,
        "preCostExpectedReturn": 0.003,
        "reasonCode": "NONE",
        "sampleCount": 45,
        "status": "AVAILABLE"
      },
      "historicalProportionRandom": {
        "macroF1": 0.34,
        "postCostExpectedReturn": 0,
        "preCostExpectedReturn": 0.002,
        "reasonCode": "NONE",
        "sampleCount": 45,
        "status": "AVAILABLE"
      }
    },
    "72h": {
      "alwaysRange": {
        "macroF1": 0.3,
        "postCostExpectedReturn": -0.001,
        "preCostExpectedReturn": 0.001,
        "reasonCode": "NONE",
        "sampleCount": 15,
        "status": "AVAILABLE"
      },
      "follow4hTrend": {
        "macroF1": 0.45,
        "postCostExpectedReturn": 0.001,
        "preCostExpectedReturn": 0.003,
        "reasonCode": "NONE",
        "sampleCount": 15,
        "status": "AVAILABLE"
      },
      "historicalProportionRandom": {
        "macroF1": 0.34,
        "postCostExpectedReturn": 0,
        "preCostExpectedReturn": 0.002,
        "reasonCode": "NONE",
        "sampleCount": 15,
        "status": "AVAILABLE"
      }
    }
  },
  "directionalCoverage": {
    "24h": 0.6666666666666666,
    "72h": 0.6666666666666666
  },
  "evaluatedAt": "2026-01-02T00:00:00Z",
  "evaluationVersion": "eval-1",
  "marketRegimeAtGeneration": {
    "24h": {
      "DOWN": {
        "directionCorrectCount": 13,
        "sampleCount": 15
      },
      "RANGE": {
        "directionCorrectCount": 13,
        "sampleCount": 15
      },
      "SIDEWAYS": {
        "directionCorrectCount": 1,
        "sampleCount": 1
      },
      "UP": {
        "directionCorrectCount": 13,
        "sampleCount": 15
      }
    },
    "72h": {
      "DOWN": {
        "directionCorrectCount": 3,
        "sampleCount": 5
      },
      "RANGE": {
        "directionCorrectCount": 3,
        "sampleCount": 5
      },
      "UP": {
        "directionCorrectCount": 3,
        "sampleCount": 5
      }
    }
  },
  "marketRegimeCoverage": {
    "24h": 1,
    "72h": 1
  },
  "postCostLift": {
    "24h": 0.003,
    "72h": 0.003
  },
  "preCostLift": {
    "24h": 0.005,
    "72h": 0.005
  },
  "predictedDownCount": {
    "24h": 15,
    "72h": 5
  },
  "predictedUpCount": {
    "24h": 15,
    "72h": 5
  },
  "rangeAttribution": {
    "24h": {
      "allPredictionsRange": false,
      "correctlyPredictedRangeCount": 14,
      "predictedRangeCount": 15,
      "rangeTotal": 15
    },
    "72h": {
      "allPredictionsRange": false,
      "correctlyPredictedRangeCount": 4,
      "predictedRangeCount": 5,
      "rangeTotal": 5
    }
  },
  "sampleAccounting": {
    "24h": {
      "classEffectiveTest": {
        "DOWN": 15,
        "RANGE": 15,
        "UP": 15
      },
      "effectiveTest": 45,
      "predictedDownCount": 15,
      "predictedRangeCount": 15,
      "predictedUpCount": 15,
      "rawTest": 270
    },
    "72h": {
      "classEffectiveTest": {
        "DOWN": 5,
        "RANGE": 5,
        "UP": 5
      },
      "effectiveTest": 15,
      "predictedDownCount": 5,
      "predictedRangeCount": 5,
      "predictedUpCount": 5,
      "rawTest": 45
    }
  },
  "schemaVersion": "v1.4d-go-no-go-input/2",
  "scorecard": {
    "evaluatedAt": "2026-01-02T00:00:00Z",
    "evaluationVersion": "eval-1",
    "horizons": {
      "24h": {
        "baselines": {
          "alwaysRange": {
            "macroF1": 0.3,
            "postCostExpectedReturn": -0.001,
            "preCostExpectedReturn": 0.001,
            "reasonCode": "NONE",
            "sampleCount": 45,
            "status": "AVAILABLE"
          },
          "follow4hTrend": {
            "macroF1": 0.45,
            "postCostExpectedReturn": 0.001,
            "preCostExpectedReturn": 0.003,
            "reasonCode": "NONE",
            "sampleCount": 45,
            "status": "AVAILABLE"
          },
          "historicalProportionRandom": {
            "macroF1": 0.34,
            "postCostExpectedReturn": 0,
            "preCostExpectedReturn": 0.002,
            "reasonCode": "NONE",
            "sampleCount": 45,
            "status": "AVAILABLE"
          }
        },
        "model": {
          "directionCorrectCount": 30,
          "macroF1": 0.62,
          "postCostExpectedReturn": 0.004,
          "preCostExpectedReturn": 0.008
        }
      },
      "72h": {
        "baselines": {
          "alwaysRange": {
            "macroF1": 0.3,
            "postCostExpectedReturn": -0.001,
            "preCostExpectedReturn": 0.001,
            "reasonCode": "NONE",
            "sampleCount": 15,
            "status": "AVAILABLE"
          },
          "follow4hTrend": {
            "macroF1": 0.45,
            "postCostExpectedReturn": 0.001,
            "preCostExpectedReturn": 0.003,
            "reasonCode": "NONE",
            "sampleCount": 15,
            "status": "AVAILABLE"
          },
          "historicalProportionRandom": {
            "macroF1": 0.34,
            "postCostExpectedReturn": 0,
            "preCostExpectedReturn": 0.002,
            "reasonCode": "NONE",
            "sampleCount": 15,
            "status": "AVAILABLE"
          }
        },
        "model": {
          "directionCorrectCount": 10,
          "macroF1": 0.62,
          "postCostExpectedReturn": 0.004,
          "preCostExpectedReturn": 0.008
        }
      }
    },
    "schemaVersion": "v1.4d-research-scorecard/4-deterministic",
    "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
  },
  "thresholds": {
    "minClassEffectiveTest": {
      "24h": 5,
      "72h": 2
    },
    "minDirectionalCoverage": {
      "24h": 0.5,
      "72h": 0.5
    },
    "minEffectiveTest": {
      "24h": 30,
      "72h": 10
    },
    "minMarketRegimeCoverage": {
      "24h": 0.9,
      "72h": 0.9
    },
    "minPostCostLift": {
      "24h": 0,
      "72h": 0
    },
    "minPreCostLift": {
      "24h": 0.001,
      "72h": 0.001
    },
    "minWilsonLowerBound": {
      "24h": 0.45,
      "72h": 0.35
    },
    "requireAllBaselines": true,
    "requireMarketRegime": true,
    "schemaVersion": "v1.4d-go-no-go-thresholds/1"
  },
  "validationRunId": "123e4567-e89b-42d3-a456-426614174000"
}
```
## 4. D7：完整主 artifact 字节确定性

### 4.1 唯一承诺

相同 `validationRunId`、`evaluationVersion`、`artifactMode`、完整D8输入、输入数据、thresholds、配置、依赖artifact与治理授权引用，在任意不同实际执行时间独立运行T14/T18，完整scorecard canonical bytes、完整主artifact canonical bytes和SHA-256必须逐字节相同。运行wall-clock只写独立runtime记录，不进入主文件、sidecar或业务hash。

T14 的时间只取validation run冻结的 `finished_at`；主artifact provenance只取同一冻结值或Manifest固定时间。`Date.now()`、动态`new Date()`、mtime、进程时间禁止进入主scorecard/artifact。

### 4.2 canonical bytes、sourceCommit、D8身份与治理绑定

- 全部canonical serialization采用RFC 8785；UTF-8无BOM；文件末尾无换行。对象key、数字、数组严格遵循RFC 8785；NaN/Infinity拒绝。
- `fullMainArtifactSha256`是完整主文件bytes的小写64位SHA-256；仅core hash不能替代。
- 当前仓库 `git rev-parse --show-object-format` 为 `sha1`，artifact同时包含 `gitObjectFormat` 和 `sourceCommit`：`SHA1`条件下必须40位小写hex；`SHA256`条件下必须64位小写hex。算法与长度不匹配由Schema拒绝。
- 完整D8输入通过输入Schema和一致性检查后，对原始完整对象做RFC 8785并计算SHA-256，写入必填 `core.d8InputSha256`。T18重新取得同一输入并重算。缺失、无法canonicalize、不匹配分别为 `D8_INPUT_HASH_MISSING`、`D8_INPUT_CANONICALIZATION_FAILED`、`D8_INPUT_HASH_MISMATCH`。
- FORMAL的 `core.governanceAuthorizationRef` 必须是对象；DRY_RUN严格为null。FORMAL在任何目标目录、锁、temp或final写入前验证治理记录Schema、RFC8785记录hash、validationRunId、thresholds hash、scope=`FORMAL_RESEARCH_EXECUTION`、decision=`APPROVE`和授权Schema版本；失败为三种治理reason并保持0文件写入。

### 4.3 发布根目录与路径身份

1. `${root}`唯一来自T1已签名run-config的 `artifactRoot`；T18不得重新读取环境覆盖。
2. root必须是绝对规范路径，只含ASCII `A-Z a-z 0-9 / . _ -`，UTF-8长度1–1024；拒绝NUL、空段、`.`、`..`、重复分隔符和非根尾随分隔符。不存在返回 `ARTIFACT_ROOT_INVALID`，T18不得创建root。
3. 对root逐组件`lstat/realpath`：必须是当前有效UID拥有、非group/world writable的目录，组件不得是symlink，规范值与realpath一致；逃逸和symlink分别失败。
4. 后续操作只用已打开root directory FD及`openat/mkdirat/renameat/unlinkat`或平台等价物，每一步启用`O_NOFOLLOW/AT_SYMLINK_NOFOLLOW`并`fstat`确认。
5. mode目录固定 `formal` 或 `dry-run`。目标目录 `${root}/{mode}/{validationRunId}/{evaluationIdentity}/`，UUID固定36字符小写，`evaluationIdentity=sha256(UTF8(evaluationVersion))`为64位小写hex。

### 4.4 唯一文件名白名单

目标目录唯一允许协议名称：

| 对象 | 唯一名称/正则 | 长度与来源 |
|---|---|---|
| 主artifact | `research-artifact.json` | 22 ASCII |
| sidecar | `research-artifact.sha256.json` | 29 ASCII |
| 固定锁 | `.research-artifact.lock` | 23 ASCII |
| 主temp | `.research-artifact.json.tmp.<pid>.<lockId>` | `pid=^[1-9][0-9]{0,19}$`；lockId见下 |
| sidecar temp | `.research-artifact.sha256.json.tmp.<pid>.<lockId>` | 与主temp使用同一lockId |
| 陈旧锁隔离文件 | `.research-artifact.lock.stale.<lockId>` | 固定62 ASCII字符；完整正则 `^\.research-artifact\.lock\.stale\.[0-9a-f]{32}$` |

`lockId`唯一格式为32个小写hex，正则 `^[0-9a-f]{32}$`；每次产生均直接取CSPRNG 128 bits并编码，不得使用PID、时间戳、runId或哈希截断。固定锁内容、temp名和隔离名中的lockId都采用这一格式；temp使用当前发布锁lockId，隔离名使用本次隔离操作新生成的lockId，审计记录把它映射至被隔离固定锁内容中的原lockId与bytes SHA-256。非法名不是协议对象，绝不删除、改名或跟随。

### 4.5 固定锁、陈旧判定与隔离锁协议

1. FORMAL治理、D8绑定、候选Schema/canonical/hash及持久化发布意图审计全部PASS后，才以 `openat(...,'.research-artifact.lock',O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW,0600)`获取锁。锁内容通过Lock Schema，flush、file fsync、close、directory fsync后才持有。
2. 锁内容绑定32-hex CSPRNG lockId、256-bit ownerToken、targetIdentitySha256、hostIdentitySha256、PID、OS process-start identity、UID、acquiredAt与leaseExpiresAt；内存ownerToken与文件内容同时匹配才可释放。
3. 已存在固定锁只读上限4096 bytes，lstat普通文件且非symlink，JSON/Lock Schema PASS。非法返回 `FAILED/ARTIFACT_LOCK_INVALID`，不删除。
4. 活跃定义：同host、PID存在且process-start identity匹配；或lease未过期且不能证明owner死亡。发布器等待签名`lockTimeoutMs`（1–300000ms）并指数退避，超时 `FAILED/ARTIFACT_LOCK_TIMEOUT`。
5. 陈旧必须同时证明：lease过期；同host；OS证明PID不存在或start identity不同；owner UID和root owner等于有效UID；签名配置 `staleLockRecovery=ENABLED`。证据不全不得隔离。
6. 陈旧判定时记录固定锁完整bytes、SHA-256、inode/device/size/mtime与原lockId。rename前用O_NOFOLLOW重新打开并逐项重验；变化返回 `FAILED/ARTIFACT_LOCK_IDENTITY_CHANGED`。
7. 隔离名使用新CSPRNG lockId。以Linux `renameat2(RENAME_NOREPLACE)`、macOS `renamex_np(RENAME_EXCL)`或语义等价的原子“不覆盖rename”移动固定锁；平台无此原语返回 `ARTIFACT_STALE_LOCK_QUARANTINE_UNSUPPORTED`，禁止用检查后普通rename替代。
8. 隔离名碰撞绝不覆盖：产生新CSPRNG lockId，最多16次。每次发出COLLISION/RETRY事件；16次耗尽返回 `FAILED/ARTIFACT_STALE_LOCK_QUARANTINE_COLLISION`与RETRY_EXHAUSTED。
9. rename成功立刻directory fsync，并写恢复审计：quarantine lockId、原lockId、固定锁bytes SHA、目标身份、inode证据、状态`RENAMED_DURABLE`。只有当前流程产生或已有审计逐项证明上述身份的隔离文件才可删除。
10. 删除前再次lstat，拒绝symlink；名称、Lock Schema、bytes SHA、原lockId和审计必须一致。unlink前记录`DELETE_REQUESTED`并持久化；unlink后directory fsync，再记录`COMPLETE`。删除失败/dir fsync失败分别为唯一reason。不得跟随链接或删除未知文件。
11. 固定活跃锁与隔离锁并存时分别验证，固定锁优先保护；不得为清隔离锁干扰活跃发布器。无法证明安全即报告并等待/失败。
12. 固定锁释放只在commit point之后：重读并比较lockId+ownerToken后unlink+directory fsync。失败不再是artifact正式失败；按4.10进入post-publish告警。专用清理重试只可凭原ownerToken、lockId和审计身份删除同一残留锁，不能写或覆盖pair。

### 4.6 发布意图、唯一commit point与持久化顺序

唯一commit point固定为：**正式sidecar从其临时文件原子rename至 `research-artifact.sha256.json` 并成功返回，使合法主文件与合法正式sidecar第一次形成读取者可观察的完整pair的瞬间。** 不存在第三个marker，也不得用锁、发布器内存、审计或后续回读作为commit marker。

顺序固定：

| 步骤 | 前置条件与操作 | commit/读取状态 | 失败结果 |
|---:|---|---|---|
| 0 | 输入Schema、一致性、D8 hash、sourceCommit；FORMAL治理全部只读验证 | 未commit；0发布写入 | 对应正式reason，`FAILED` |
| 1 | RFC8785生成主bytes并验证主Schema/canonical/身份；计算完整主SHA；构造sidecar并验证Schema、主SHA与全部身份 | 候选仅内存 | Schema/canonical失败，`FAILED` |
| 2 | 持久化发布意图审计，含attemptId、身份和candidate hash | 未commit，无artifact文件 | `ARTIFACT_AUDIT_INTENT_WRITE_FAILED` |
| 3 | 只读检查现有正式pair：完整合法且同bytes复用，异bytes冲突；不完整按恢复规则 | 现有pair自身按读者协议决定 | 复用或正式失败，绝不覆盖 |
| 4 | 获取固定锁并处理可证temp/隔离状态 | 未commit；锁不是marker | 锁/恢复reason |
| 5 | O_EXCL写主temp→flush→file fsync→回读逐byte重验 | 未commit；temp不可读 | temp reason |
| 6 | O_EXCL写sidecar temp→flush→file fsync→回读并重验Schema、完整主SHA及身份 | 未commit；temp不可读 | temp reason |
| 7 | atomic rename主temp→主final；对发布目录directory fsync | 未commit；main-only，读者REJECTED | rename/fsync失败为正式`FAILED` |
| 8 | 原子、不覆盖地rename sidecar temp→正式sidecar；rename成功返回 | **此瞬间commit**；立即固定`PUBLISHED/NONE`；完整pair可由读者验证 | rename失败仍未commit：`FAILED/ARTIFACT_RENAME_FAILED` |
| 9 | 对发布目录directory fsync | 已commit | 失败：`PUBLISHED/NONE + ERROR/POST_PUBLISH_DIRECTORY_FSYNC_FAILED` |
| 10 | 发布器重新从正式路径独立打开并回读pair；不得共享候选缓存或读者缓存 | 已commit；回读是发布后完整性观测，不是commit条件 | I/O/Schema/canonical/hash/identity各用唯一post code，均保持PUBLISHED |
| 11 | 写发布完成审计 | 已commit | 失败为WARNING，不改变artifact |
| 12 | 核对并释放固定锁、directory fsync | 已commit | 失败为WARNING，可维护重试 |

步骤7前已保证：主文件完整、file fsync、Schema/canonical/身份PASS，且主rename后的directory fsync PASS。步骤8前已保证：sidecar完整、file fsync、Schema PASS、记录正确完整主SHA并与主文件全部冻结身份一致。因此sidecar rename是唯一使两个预验证正式对象同时可见的原子边界。

sidecar rename一旦成功，发布器立即在内存和返回状态机中固定`operationStatus=PUBLISHED, reasonCode=NONE`并发出`ARTIFACT_SIDECAR_RENAME_COMMIT_POINT`、`ARTIFACT_PUBLISH_COMPLETED`。步骤9–12失败不得删除、回滚、覆盖pair或追溯改判FAILED。

### 4.7 中断与恢复状态机

| 中断/启动状态 | commit已发生 | 读取者结果 | 恢复、状态与禁止动作 |
|---|---|---|---|
| sidecar rename前：main final合法，sidecar temp合法，正式sidecar缺失 | 否 | `REJECTED/ARTIFACT_PAIR_INCOMPLETE`；不得读取temp | 保留final证据；按未提交恢复；`FAILED`及对应precommit reason；不得称PUBLISHED |
| sidecar rename调用失败 | 否 | main-only，REJECTED | `FAILED/ARTIFACT_RENAME_FAILED`；可在治理确认后用新attempt恢复；不得把temp当正式文件 |
| sidecar rename成功返回后立即中断 | 是 | 重启后按实际文件状态独立验证 | pair存在且合法：`REUSED_IDENTICAL/NONE`并记录COMMITTED_PAIR_RECOVERED；异候选冲突；不得重写。若sidecar因目录项未耐久而消失，则按实际不完整pair拒绝，不伪造文件 |
| sidecar rename后、directory fsync前中断 | 是（进程已观察commit） | 当时可见合法pair即ACCEPTED；重启后按实际状态 | pair仍在且合法：先安全补做dir fsync，再复用；缺失/损坏只报告并阻断写入；不得自动补写 |
| directory fsync后、发布器回读前中断 | 是 | 合法pair ACCEPTED | 重启验证；同bytes复用、异bytes冲突；补写完成审计/清理自己的残留锁，不覆盖pair |
| 发布器回读过程中中断 | 是 | 读取者独立验证，不共享缓存 | 恢复者重新完整读取；合法复用，非法REJECTED并隔离发布流程/阻断新写，不自动修复 |
| 回读完成后、审计或锁释放前中断 | 是 | 合法pair ACCEPTED | 恢复完成审计或所有权可证锁清理；pair永远保留 |
| post-commit directory fsync失败 | 是 | 当前仍存在且合法pair ACCEPTED | `PUBLISHED/NONE + ERROR/POST_PUBLISH_DIRECTORY_FSYNC_FAILED`；记录“可见但耐久性未确认”；只可重试dir fsync与重验，不写pair |
| post-commit回读I/O失败 | 是 | 读取者自行读；成功则ACCEPTED，失败则REJECTED | `PUBLISHED/NONE + ERROR/POST_PUBLISH_REREAD_IO_FAILED`；保留pair，阻断新写直至检查完成 |
| post-commit回读Schema/canonical/hash/identity失败 | 是 | 对应独立reader reason并REJECTED | PUBLISHED事实不追溯改变；post ERROR及唯一code；不得删除/改写/自动修复，需治理隔离发布流程 |
| post-commit审计/锁失败 | 是 | 合法pair ACCEPTED | 沿用WARNING语义与锁维护重试；不改artifact |

其余temp与陈旧锁恢复严格遵循4.5：32位小写hex lockId、固定62字符隔离名、16次不覆盖重试、审计lineage、symlink拒绝及两次directory fsync规则保持唯一。固定锁与隔离锁并存时保护活跃固定锁。

### 4.8 读取者唯一接受协议

1. 读取者只观察两个正式路径，不读取temp、锁、publisher内存、发布意图/完成审计或隐藏marker。
2. 逐组件`openat/O_NOFOLLOW/fstat`定位；拒绝symlink与路径逃逸。
3. 主或sidecar任一缺失均返回`REJECTED`：双方均缺失用`ARTIFACT_NOT_FOUND`，仅一方缺失用`ARTIFACT_PAIR_INCOMPLETE`。
4. 两者存在时，分别以独立FD读取：I/O失败=`ARTIFACT_READER_IO_FAILED`；主/sidecar Schema失败=`ARTIFACT_SCHEMA_INVALID`；主文件RFC8785重编码不等于原bytes=`ARTIFACT_CANONICALIZATION_FAILED`；完整主SHA与sidecar不一致=`ARTIFACT_HASH_MISMATCH`；validationRunId、artifactMode、主schemaVersion、evaluationVersion或其他冻结身份不一致=`ARTIFACT_IDENTITY_MISMATCH`。全部返回`REJECTED`且不返回部分数据。
5. 全部验证PASS且两FD的device/inode/size/mtime读取期间稳定，唯一结果为`ACCEPTED/NONE`。不检查锁，不等待publisher回读、directory fsync、完成审计或锁释放。
6. sidecar正式rename成功与完整pair第一次可见是同一原子边界，也是commit point。不存在“完整合法pair已可见但尚未commit”的协议状态。
7. 发布器post-commit回读必须重新open正式路径并执行同一验证算法，但它的结果只写postPublish通道；读取者不得复用发布器缓存，发布器也不得用候选内存替代正式路径回读。

### 4.9 DRY_RUN与FORMAL

- 两种mode在各自namespace执行相同sidecar-rename commit边界。DRY_RUN可产生dry-run pair，但formal namespace主/sidecar/锁/temp必须为0。
- DRY_RUN治理ref固定null；FORMAL治理在步骤0验证，失败时发布意图、目录、锁、temp/final全部0写入。
- DRY_RUN不得接触formal对象；其不完整pair按reader协议拒绝。陈旧锁清理只限本namespace并完整执行4.5。
- commit后的dir fsync/回读/审计/锁错误在两种mode使用相同post状态；不得因DRY_RUN而把完整pair改回未发布。

### 4.10 状态、reason、post-publish、事件与审计

**operationStatus**：`PUBLISHED | REUSED_IDENTICAL | FAILED`。PUBLISHED/REUSED正式reason固定`NONE`。sidecar rename失败及此前错误才可FAILED；sidecar rename成功后禁止FAILED。

**readerStatus**：`ACCEPTED | REJECTED`；Reader Result Schema冻结唯一reader reason。读取者结果与publisher operation分离：post-commit完整性损坏时，历史发布事实仍为PUBLISHED，而当前读取结果可为REJECTED。

**postPublishStatus**：`NOT_APPLICABLE | COMPLETE | WARNING | ERROR`。FAILED只能NOT_APPLICABLE/NONE；成功正常为COMPLETE/NONE；审计/锁维护失败为WARNING；目录耐久性或正式回读失败为ERROR。

**postPublishCode**：`NONE`；`POST_PUBLISH_DIRECTORY_FSYNC_FAILED`；`POST_PUBLISH_REREAD_IO_FAILED`；`POST_PUBLISH_REREAD_SCHEMA_FAILED`；`POST_PUBLISH_REREAD_CANONICAL_FAILED`；`POST_PUBLISH_REREAD_HASH_MISMATCH`；`POST_PUBLISH_REREAD_IDENTITY_MISMATCH`；以及已冻结的AUDIT、LOCK、AUDIT_AND_LOCK三种WARNING code。若同一attempt有多个post失败，严重度`ERROR > WARNING`；ERROR内部优先级为IDENTITY、HASH、SCHEMA、CANONICAL、I/O、DIRECTORY_FSYNC；WARNING为AUDIT_AND_LOCK、AUDIT、LOCK。返回最高优先code，所有故障仍逐项写events/audit。

新增runtime events：`ARTIFACT_SIDECAR_RENAME_COMMIT_POINT`、`ARTIFACT_POST_PUBLISH_DIRECTORY_FSYNC_FAILED`、`ARTIFACT_POST_PUBLISH_REREAD_STARTED`、`...REREAD_IO_FAILED`、`...REREAD_SCHEMA_FAILED`、`...REREAD_CANONICAL_FAILED`、`...REREAD_HASH_MISMATCH`、`...REREAD_IDENTITY_MISMATCH`、`...REREAD_COMPLETED`、`ARTIFACT_COMMITTED_PAIR_RECOVERED`。既有audit/lock/quarantine事件不变。

发布意图审计在commit前且必须持久化。sidecar rename成功后立即追加内存/runtime commit event；步骤9后尽力写完成审计，至少包含commit边界、dir fsync结果、publisher reread结果、reader-style reason、post状态/code及锁结果。审计失败自身为WARNING；不得改变PUBLISHED。若进程在完成审计前崩溃，恢复者以pair实际验证和意图attemptId补写恢复审计，不伪造已消失文件。
### 4.11 顶层 artifact Schema

```json
{
  "$defs": {
    "artifactCore": {
      "additionalProperties": false,
      "allOf": [
        {
          "if": {
            "properties": {
              "gitObjectFormat": {
                "const": "SHA1"
              }
            },
            "required": [
              "gitObjectFormat"
            ]
          },
          "then": {
            "properties": {
              "sourceCommit": {
                "pattern": "^[0-9a-f]{40}$"
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "gitObjectFormat": {
                "const": "SHA256"
              }
            },
            "required": [
              "gitObjectFormat"
            ]
          },
          "then": {
            "properties": {
              "sourceCommit": {
                "pattern": "^[0-9a-f]{64}$"
              }
            }
          }
        }
      ],
      "properties": {
        "auditTrail": {
          "$ref": "#/$defs/auditTrail"
        },
        "d8InputSha256": {
          "pattern": "^[0-9a-f]{64}$",
          "type": "string"
        },
        "decision": {
          "$ref": "#/$defs/decision"
        },
        "evaluationVersion": {
          "minLength": 1,
          "type": "string"
        },
        "fixedAsOf": {
          "format": "date-time",
          "type": "string"
        },
        "gitObjectFormat": {
          "enum": [
            "SHA1",
            "SHA256"
          ]
        },
        "governanceAuthorizationRef": {
          "oneOf": [
            {
              "$ref": "#/$defs/governanceAuthorizationRef"
            },
            {
              "type": "null"
            }
          ]
        },
        "researchFrom": {
          "format": "date-time",
          "type": "string"
        },
        "researchTo": {
          "format": "date-time",
          "type": "string"
        },
        "scorecard": {
          "$ref": "#/$defs/scorecard"
        },
        "sourceCommit": {
          "type": "string"
        },
        "thresholds": {
          "$ref": "#/$defs/thresholds"
        },
        "validationRunId": {
          "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
          "type": "string"
        }
      },
      "required": [
        "validationRunId",
        "evaluationVersion",
        "gitObjectFormat",
        "sourceCommit",
        "d8InputSha256",
        "researchFrom",
        "researchTo",
        "fixedAsOf",
        "thresholds",
        "scorecard",
        "auditTrail",
        "decision",
        "governanceAuthorizationRef"
      ],
      "type": "object"
    },
    "auditTrail": {
      "additionalProperties": false,
      "properties": {
        "authenticityGateStatus": {
          "enum": [
            "PASSED",
            "FAILED",
            "NOT_AVAILABLE"
          ]
        },
        "backfillBatchIds": {
          "items": {
            "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
            "type": "string"
          },
          "type": "array",
          "uniqueItems": true
        },
        "datasetVersion": {
          "pattern": "^v1\\.4d-sha256-[0-9a-f]{64}$",
          "type": "string"
        },
        "evaluatedAt": {
          "format": "date-time",
          "pattern": "Z$",
          "type": "string"
        },
        "evaluationVersion": {
          "minLength": 1,
          "type": "string"
        },
        "featureCoverage": {
          "maximum": 1,
          "minimum": 0,
          "type": "number"
        },
        "generationSummary": {
          "additionalProperties": false,
          "properties": {
            "attempted": {
              "minimum": 0,
              "type": "integer"
            },
            "blocked": {
              "minimum": 0,
              "type": "integer"
            },
            "conflicts": {
              "minimum": 0,
              "type": "integer"
            },
            "evaluated": {
              "minimum": 0,
              "type": "integer"
            },
            "expected": {
              "minimum": 0,
              "type": "integer"
            },
            "inserted": {
              "minimum": 0,
              "type": "integer"
            },
            "reusedIdentical": {
              "minimum": 0,
              "type": "integer"
            }
          },
          "required": [
            "expected",
            "attempted",
            "inserted",
            "reusedIdentical",
            "conflicts",
            "blocked",
            "evaluated"
          ],
          "type": "object"
        },
        "manifestContentHash": {
          "pattern": "^[0-9a-f]{64}$",
          "type": "string"
        },
        "manifestCoverage": {
          "maximum": 1,
          "minimum": 0,
          "type": "number"
        },
        "schemaVersion": {
          "const": "v1.4d-audit-trail/1"
        },
        "validationRunId": {
          "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
          "type": "string"
        },
        "validationRunStatus": {
          "enum": [
            "SUCCEEDED",
            "FAILED",
            "RUNNING"
          ]
        },
        "vintageIds": {
          "items": {
            "minLength": 1,
            "type": "string"
          },
          "type": "array",
          "uniqueItems": true
        }
      },
      "required": [
        "schemaVersion",
        "validationRunId",
        "evaluationVersion",
        "evaluatedAt",
        "validationRunStatus",
        "authenticityGateStatus",
        "manifestCoverage",
        "featureCoverage",
        "datasetVersion",
        "manifestContentHash",
        "backfillBatchIds",
        "vintageIds",
        "generationSummary"
      ],
      "type": "object"
    },
    "baseline": {
      "additionalProperties": false,
      "allOf": [
        {
          "if": {
            "properties": {
              "status": {
                "const": "AVAILABLE"
              }
            }
          },
          "then": {
            "properties": {
              "macroF1": {
                "maximum": 1,
                "minimum": 0,
                "type": "number"
              },
              "postCostExpectedReturn": {
                "type": "number"
              },
              "preCostExpectedReturn": {
                "type": "number"
              },
              "reasonCode": {
                "const": "NONE"
              },
              "sampleCount": {
                "minimum": 1
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "status": {
                "const": "NOT_EVALUABLE"
              }
            }
          },
          "then": {
            "properties": {
              "macroF1": {
                "type": "null"
              },
              "postCostExpectedReturn": {
                "type": "null"
              },
              "preCostExpectedReturn": {
                "type": "null"
              },
              "reasonCode": {
                "not": {
                  "const": "NONE"
                }
              }
            }
          }
        }
      ],
      "properties": {
        "macroF1": {
          "type": [
            "number",
            "null"
          ]
        },
        "postCostExpectedReturn": {
          "type": [
            "number",
            "null"
          ]
        },
        "preCostExpectedReturn": {
          "type": [
            "number",
            "null"
          ]
        },
        "reasonCode": {
          "enum": [
            "NONE",
            "NO_TRAIN_SAMPLES",
            "NO_VALID_TREND",
            "NO_EVALUATION_ROWS",
            "INPUT_MISSING"
          ]
        },
        "sampleCount": {
          "minimum": 0,
          "type": "integer"
        },
        "status": {
          "enum": [
            "AVAILABLE",
            "NOT_EVALUABLE"
          ]
        }
      },
      "required": [
        "status",
        "reasonCode",
        "sampleCount",
        "macroF1",
        "preCostExpectedReturn",
        "postCostExpectedReturn"
      ],
      "type": "object"
    },
    "baselineAvailabilityResult": {
      "additionalProperties": false,
      "properties": {
        "postCostReferenceBaseline": {
          "enum": [
            "alwaysRange",
            "follow4hTrend",
            "historicalProportionRandom",
            null
          ],
          "type": [
            "string",
            "null"
          ]
        },
        "preCostReferenceBaseline": {
          "enum": [
            "alwaysRange",
            "follow4hTrend",
            "historicalProportionRandom",
            null
          ],
          "type": [
            "string",
            "null"
          ]
        },
        "primaryReasonCode": {
          "enum": [
            "NONE",
            "ALWAYS_RANGE_NOT_EVALUABLE",
            "BASELINE_NOT_EVALUABLE"
          ]
        },
        "reasonCodes": {
          "items": {
            "enum": [
              "ALWAYS_RANGE_NOT_EVALUABLE",
              "BASELINE_NOT_EVALUABLE"
            ]
          },
          "type": "array",
          "uniqueItems": true
        },
        "status": {
          "enum": [
            "AVAILABLE",
            "NOT_EVALUABLE"
          ]
        },
        "usableBaselines": {
          "items": {
            "enum": [
              "alwaysRange",
              "follow4hTrend",
              "historicalProportionRandom"
            ]
          },
          "type": "array",
          "uniqueItems": true
        }
      },
      "required": [
        "status",
        "primaryReasonCode",
        "reasonCodes",
        "usableBaselines",
        "preCostReferenceBaseline",
        "postCostReferenceBaseline"
      ],
      "type": "object"
    },
    "baselineSet": {
      "additionalProperties": false,
      "properties": {
        "alwaysRange": {
          "$ref": "#/$defs/baseline"
        },
        "follow4hTrend": {
          "$ref": "#/$defs/baseline"
        },
        "historicalProportionRandom": {
          "$ref": "#/$defs/baseline"
        }
      },
      "required": [
        "alwaysRange",
        "follow4hTrend",
        "historicalProportionRandom"
      ],
      "type": "object"
    },
    "classCounts": {
      "additionalProperties": false,
      "properties": {
        "DOWN": {
          "minimum": 0,
          "type": "integer"
        },
        "RANGE": {
          "minimum": 0,
          "type": "integer"
        },
        "UP": {
          "minimum": 0,
          "type": "integer"
        }
      },
      "required": [
        "UP",
        "DOWN",
        "RANGE"
      ],
      "type": "object"
    },
    "decision": {
      "additionalProperties": false,
      "properties": {
        "baselineAvailability": {
          "additionalProperties": false,
          "properties": {
            "24h": {
              "$ref": "#/$defs/baselineAvailabilityResult"
            },
            "72h": {
              "$ref": "#/$defs/baselineAvailabilityResult"
            }
          },
          "required": [
            "24h",
            "72h"
          ],
          "type": "object"
        },
        "evaluatedAt": {
          "format": "date-time",
          "pattern": "Z$",
          "type": "string"
        },
        "evaluationVersion": {
          "minLength": 1,
          "type": "string"
        },
        "horizonResults": {
          "additionalProperties": false,
          "properties": {
            "24h": {
              "$ref": "#/$defs/horizonResult"
            },
            "72h": {
              "$ref": "#/$defs/horizonResult"
            }
          },
          "required": [
            "24h",
            "72h"
          ],
          "type": "object"
        },
        "overall": {
          "additionalProperties": false,
          "properties": {
            "primaryReasonCode": {
              "enum": [
                "NONE",
                "INPUT_CONSISTENCY_FAILED",
                "AUDIT_RUN_NOT_SUCCEEDED",
                "AUDIT_AUTHENTICITY_NOT_PASSED",
                "MANIFEST_COVERAGE_INCOMPLETE",
                "FEATURE_COVERAGE_INCOMPLETE",
                "EFFECTIVE_TEST_ZERO",
                "COVERAGE_NULL",
                "LIFT_NULL",
                "ALWAYS_RANGE_NOT_EVALUABLE",
                "BASELINE_NOT_EVALUABLE",
                "EFFECTIVE_TEST_BELOW_THRESHOLD",
                "CLASS_SAMPLE_BELOW_THRESHOLD",
                "RANGE_CLASS_ABSENT",
                "RANGE_PREDICTION_DEGENERATE",
                "WILSON_BELOW_THRESHOLD",
                "PRE_COST_LIFT_BELOW_THRESHOLD",
                "POST_COST_LIFT_BELOW_THRESHOLD",
                "DIRECTIONAL_COVERAGE_BELOW_THRESHOLD",
                "MARKET_REGIME_COVERAGE_BELOW_THRESHOLD"
              ]
            },
            "reasonCodes": {
              "items": {
                "enum": [
                  "INPUT_CONSISTENCY_FAILED",
                  "AUDIT_RUN_NOT_SUCCEEDED",
                  "AUDIT_AUTHENTICITY_NOT_PASSED",
                  "MANIFEST_COVERAGE_INCOMPLETE",
                  "FEATURE_COVERAGE_INCOMPLETE",
                  "EFFECTIVE_TEST_ZERO",
                  "COVERAGE_NULL",
                  "LIFT_NULL",
                  "ALWAYS_RANGE_NOT_EVALUABLE",
                  "BASELINE_NOT_EVALUABLE",
                  "EFFECTIVE_TEST_BELOW_THRESHOLD",
                  "CLASS_SAMPLE_BELOW_THRESHOLD",
                  "RANGE_CLASS_ABSENT",
                  "RANGE_PREDICTION_DEGENERATE",
                  "WILSON_BELOW_THRESHOLD",
                  "PRE_COST_LIFT_BELOW_THRESHOLD",
                  "POST_COST_LIFT_BELOW_THRESHOLD",
                  "DIRECTIONAL_COVERAGE_BELOW_THRESHOLD",
                  "MARKET_REGIME_COVERAGE_BELOW_THRESHOLD"
                ]
              },
              "type": "array",
              "uniqueItems": true
            },
            "status": {
              "enum": [
                "GO",
                "CONDITIONAL_GO",
                "NO_GO",
                "DATA_GATE_FAILED",
                "BASELINE_NOT_EVALUABLE"
              ]
            }
          },
          "required": [
            "status",
            "primaryReasonCode",
            "reasonCodes"
          ],
          "type": "object"
        },
        "primaryReasonCode": {
          "enum": [
            "NONE",
            "INPUT_CONSISTENCY_FAILED",
            "AUDIT_RUN_NOT_SUCCEEDED",
            "AUDIT_AUTHENTICITY_NOT_PASSED",
            "MANIFEST_COVERAGE_INCOMPLETE",
            "FEATURE_COVERAGE_INCOMPLETE",
            "EFFECTIVE_TEST_ZERO",
            "COVERAGE_NULL",
            "LIFT_NULL",
            "ALWAYS_RANGE_NOT_EVALUABLE",
            "BASELINE_NOT_EVALUABLE",
            "EFFECTIVE_TEST_BELOW_THRESHOLD",
            "CLASS_SAMPLE_BELOW_THRESHOLD",
            "RANGE_CLASS_ABSENT",
            "RANGE_PREDICTION_DEGENERATE",
            "WILSON_BELOW_THRESHOLD",
            "PRE_COST_LIFT_BELOW_THRESHOLD",
            "POST_COST_LIFT_BELOW_THRESHOLD",
            "DIRECTIONAL_COVERAGE_BELOW_THRESHOLD",
            "MARKET_REGIME_COVERAGE_BELOW_THRESHOLD"
          ]
        },
        "reasonCodes": {
          "items": {
            "enum": [
              "INPUT_CONSISTENCY_FAILED",
              "AUDIT_RUN_NOT_SUCCEEDED",
              "AUDIT_AUTHENTICITY_NOT_PASSED",
              "MANIFEST_COVERAGE_INCOMPLETE",
              "FEATURE_COVERAGE_INCOMPLETE",
              "EFFECTIVE_TEST_ZERO",
              "COVERAGE_NULL",
              "LIFT_NULL",
              "ALWAYS_RANGE_NOT_EVALUABLE",
              "BASELINE_NOT_EVALUABLE",
              "EFFECTIVE_TEST_BELOW_THRESHOLD",
              "CLASS_SAMPLE_BELOW_THRESHOLD",
              "RANGE_CLASS_ABSENT",
              "RANGE_PREDICTION_DEGENERATE",
              "WILSON_BELOW_THRESHOLD",
              "PRE_COST_LIFT_BELOW_THRESHOLD",
              "POST_COST_LIFT_BELOW_THRESHOLD",
              "DIRECTIONAL_COVERAGE_BELOW_THRESHOLD",
              "MARKET_REGIME_COVERAGE_BELOW_THRESHOLD"
            ]
          },
          "type": "array",
          "uniqueItems": true
        },
        "schemaVersion": {
          "const": "v1.4d-go-no-go-output/2"
        },
        "validationRunId": {
          "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
          "type": "string"
        }
      },
      "required": [
        "schemaVersion",
        "validationRunId",
        "evaluationVersion",
        "evaluatedAt",
        "baselineAvailability",
        "horizonResults",
        "overall",
        "primaryReasonCode",
        "reasonCodes"
      ],
      "type": "object"
    },
    "governanceAuthorizationRef": {
      "additionalProperties": false,
      "properties": {
        "authorizationSchemaVersion": {
          "const": "v1.4d-governance-authorization/1"
        },
        "authorizationScope": {
          "const": "FORMAL_RESEARCH_EXECUTION"
        },
        "decision": {
          "const": "APPROVE"
        },
        "hashAlgorithm": {
          "const": "SHA-256"
        },
        "recordSha256": {
          "pattern": "^[0-9a-f]{64}$",
          "type": "string"
        },
        "thresholdsSha256": {
          "pattern": "^[0-9a-f]{64}$",
          "type": "string"
        },
        "validationRunId": {
          "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
          "type": "string"
        }
      },
      "required": [
        "authorizationSchemaVersion",
        "recordSha256",
        "hashAlgorithm",
        "validationRunId",
        "thresholdsSha256",
        "authorizationScope",
        "decision"
      ],
      "type": "object"
    },
    "groupMap": {
      "additionalProperties": false,
      "properties": {
        "DOWN": {
          "$ref": "#/$defs/groupStat"
        },
        "RANGE": {
          "$ref": "#/$defs/groupStat"
        },
        "UP": {
          "$ref": "#/$defs/groupStat"
        }
      },
      "required": [
        "UP",
        "DOWN",
        "RANGE"
      ],
      "type": "object"
    },
    "groupStat": {
      "additionalProperties": false,
      "properties": {
        "directionCorrectCount": {
          "minimum": 0,
          "type": "integer"
        },
        "sampleCount": {
          "minimum": 0,
          "type": "integer"
        }
      },
      "required": [
        "sampleCount",
        "directionCorrectCount"
      ],
      "type": "object"
    },
    "horizonResult": {
      "additionalProperties": false,
      "properties": {
        "directionalCoverage": {
          "maximum": 1,
          "minimum": 0,
          "type": [
            "number",
            "null"
          ]
        },
        "effectiveTest": {
          "minimum": 0,
          "type": "integer"
        },
        "marketRegimeCoverage": {
          "maximum": 1,
          "minimum": 0,
          "type": [
            "number",
            "null"
          ]
        },
        "postCostLift": {
          "type": [
            "number",
            "null"
          ]
        },
        "preCostLift": {
          "type": [
            "number",
            "null"
          ]
        },
        "primaryReasonCode": {
          "enum": [
            "NONE",
            "INPUT_CONSISTENCY_FAILED",
            "AUDIT_RUN_NOT_SUCCEEDED",
            "AUDIT_AUTHENTICITY_NOT_PASSED",
            "MANIFEST_COVERAGE_INCOMPLETE",
            "FEATURE_COVERAGE_INCOMPLETE",
            "EFFECTIVE_TEST_ZERO",
            "COVERAGE_NULL",
            "LIFT_NULL",
            "ALWAYS_RANGE_NOT_EVALUABLE",
            "BASELINE_NOT_EVALUABLE",
            "EFFECTIVE_TEST_BELOW_THRESHOLD",
            "CLASS_SAMPLE_BELOW_THRESHOLD",
            "RANGE_CLASS_ABSENT",
            "RANGE_PREDICTION_DEGENERATE",
            "WILSON_BELOW_THRESHOLD",
            "PRE_COST_LIFT_BELOW_THRESHOLD",
            "POST_COST_LIFT_BELOW_THRESHOLD",
            "DIRECTIONAL_COVERAGE_BELOW_THRESHOLD",
            "MARKET_REGIME_COVERAGE_BELOW_THRESHOLD"
          ]
        },
        "reasonCodes": {
          "items": {
            "enum": [
              "INPUT_CONSISTENCY_FAILED",
              "AUDIT_RUN_NOT_SUCCEEDED",
              "AUDIT_AUTHENTICITY_NOT_PASSED",
              "MANIFEST_COVERAGE_INCOMPLETE",
              "FEATURE_COVERAGE_INCOMPLETE",
              "EFFECTIVE_TEST_ZERO",
              "COVERAGE_NULL",
              "LIFT_NULL",
              "ALWAYS_RANGE_NOT_EVALUABLE",
              "BASELINE_NOT_EVALUABLE",
              "EFFECTIVE_TEST_BELOW_THRESHOLD",
              "CLASS_SAMPLE_BELOW_THRESHOLD",
              "RANGE_CLASS_ABSENT",
              "RANGE_PREDICTION_DEGENERATE",
              "WILSON_BELOW_THRESHOLD",
              "PRE_COST_LIFT_BELOW_THRESHOLD",
              "POST_COST_LIFT_BELOW_THRESHOLD",
              "DIRECTIONAL_COVERAGE_BELOW_THRESHOLD",
              "MARKET_REGIME_COVERAGE_BELOW_THRESHOLD"
            ]
          },
          "type": "array",
          "uniqueItems": true
        },
        "status": {
          "enum": [
            "GO",
            "CONDITIONAL_GO",
            "NO_GO",
            "DATA_GATE_FAILED",
            "BASELINE_NOT_EVALUABLE"
          ]
        },
        "wilson95": {
          "$ref": "#/$defs/wilson"
        }
      },
      "required": [
        "status",
        "primaryReasonCode",
        "reasonCodes",
        "effectiveTest",
        "directionalCoverage",
        "marketRegimeCoverage",
        "preCostLift",
        "postCostLift",
        "wilson95"
      ],
      "type": "object"
    },
    "modelMetrics": {
      "additionalProperties": false,
      "properties": {
        "directionCorrectCount": {
          "minimum": 0,
          "type": "integer"
        },
        "macroF1": {
          "maximum": 1,
          "minimum": 0,
          "type": "number"
        },
        "postCostExpectedReturn": {
          "type": "number"
        },
        "preCostExpectedReturn": {
          "type": "number"
        }
      },
      "required": [
        "directionCorrectCount",
        "macroF1",
        "preCostExpectedReturn",
        "postCostExpectedReturn"
      ],
      "type": "object"
    },
    "rangeAttribution": {
      "additionalProperties": false,
      "properties": {
        "allPredictionsRange": {
          "type": "boolean"
        },
        "correctlyPredictedRangeCount": {
          "minimum": 0,
          "type": "integer"
        },
        "predictedRangeCount": {
          "minimum": 0,
          "type": "integer"
        },
        "rangeTotal": {
          "minimum": 0,
          "type": "integer"
        }
      },
      "required": [
        "rangeTotal",
        "predictedRangeCount",
        "correctlyPredictedRangeCount",
        "allPredictionsRange"
      ],
      "type": "object"
    },
    "sampleHorizon": {
      "additionalProperties": false,
      "properties": {
        "classEffectiveTest": {
          "$ref": "#/$defs/classCounts"
        },
        "effectiveTest": {
          "minimum": 0,
          "type": "integer"
        },
        "predictedDownCount": {
          "minimum": 0,
          "type": "integer"
        },
        "predictedRangeCount": {
          "minimum": 0,
          "type": "integer"
        },
        "predictedUpCount": {
          "minimum": 0,
          "type": "integer"
        },
        "rawTest": {
          "minimum": 0,
          "type": "integer"
        }
      },
      "required": [
        "rawTest",
        "effectiveTest",
        "classEffectiveTest",
        "predictedUpCount",
        "predictedDownCount",
        "predictedRangeCount"
      ],
      "type": "object"
    },
    "scoreHorizon": {
      "additionalProperties": false,
      "properties": {
        "baselines": {
          "$ref": "#/$defs/baselineSet"
        },
        "model": {
          "$ref": "#/$defs/modelMetrics"
        }
      },
      "required": [
        "model",
        "baselines"
      ],
      "type": "object"
    },
    "scorecard": {
      "additionalProperties": false,
      "properties": {
        "evaluatedAt": {
          "format": "date-time",
          "pattern": "Z$",
          "type": "string"
        },
        "evaluationVersion": {
          "minLength": 1,
          "type": "string"
        },
        "horizons": {
          "additionalProperties": false,
          "properties": {
            "24h": {
              "$ref": "#/$defs/scoreHorizon"
            },
            "72h": {
              "$ref": "#/$defs/scoreHorizon"
            }
          },
          "required": [
            "24h",
            "72h"
          ],
          "type": "object"
        },
        "schemaVersion": {
          "const": "v1.4d-research-scorecard/4-deterministic"
        },
        "validationRunId": {
          "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
          "type": "string"
        }
      },
      "required": [
        "schemaVersion",
        "validationRunId",
        "evaluationVersion",
        "evaluatedAt",
        "horizons"
      ],
      "type": "object"
    },
    "thresholds": {
      "additionalProperties": false,
      "properties": {
        "minClassEffectiveTest": {
          "additionalProperties": false,
          "properties": {
            "24h": {
              "minimum": 0,
              "type": "integer"
            },
            "72h": {
              "minimum": 0,
              "type": "integer"
            }
          },
          "required": [
            "24h",
            "72h"
          ],
          "type": "object"
        },
        "minDirectionalCoverage": {
          "additionalProperties": false,
          "properties": {
            "24h": {
              "maximum": 1,
              "minimum": 0,
              "type": "number"
            },
            "72h": {
              "maximum": 1,
              "minimum": 0,
              "type": "number"
            }
          },
          "required": [
            "24h",
            "72h"
          ],
          "type": "object"
        },
        "minEffectiveTest": {
          "additionalProperties": false,
          "properties": {
            "24h": {
              "minimum": 1,
              "type": "integer"
            },
            "72h": {
              "minimum": 1,
              "type": "integer"
            }
          },
          "required": [
            "24h",
            "72h"
          ],
          "type": "object"
        },
        "minMarketRegimeCoverage": {
          "additionalProperties": false,
          "properties": {
            "24h": {
              "maximum": 1,
              "minimum": 0,
              "type": "number"
            },
            "72h": {
              "maximum": 1,
              "minimum": 0,
              "type": "number"
            }
          },
          "required": [
            "24h",
            "72h"
          ],
          "type": "object"
        },
        "minPostCostLift": {
          "additionalProperties": false,
          "properties": {
            "24h": {
              "type": "number"
            },
            "72h": {
              "type": "number"
            }
          },
          "required": [
            "24h",
            "72h"
          ],
          "type": "object"
        },
        "minPreCostLift": {
          "additionalProperties": false,
          "properties": {
            "24h": {
              "type": "number"
            },
            "72h": {
              "type": "number"
            }
          },
          "required": [
            "24h",
            "72h"
          ],
          "type": "object"
        },
        "minWilsonLowerBound": {
          "additionalProperties": false,
          "properties": {
            "24h": {
              "maximum": 1,
              "minimum": 0,
              "type": "number"
            },
            "72h": {
              "maximum": 1,
              "minimum": 0,
              "type": "number"
            }
          },
          "required": [
            "24h",
            "72h"
          ],
          "type": "object"
        },
        "requireAllBaselines": {
          "const": true
        },
        "requireMarketRegime": {
          "const": true
        },
        "schemaVersion": {
          "const": "v1.4d-go-no-go-thresholds/1"
        }
      },
      "required": [
        "schemaVersion",
        "minEffectiveTest",
        "minClassEffectiveTest",
        "minDirectionalCoverage",
        "minMarketRegimeCoverage",
        "minWilsonLowerBound",
        "minPreCostLift",
        "minPostCostLift",
        "requireAllBaselines",
        "requireMarketRegime"
      ],
      "type": "object"
    },
    "wilson": {
      "additionalProperties": false,
      "properties": {
        "confidenceLevel": {
          "const": 0.95
        },
        "lower": {
          "maximum": 1,
          "minimum": 0,
          "type": [
            "number",
            "null"
          ]
        },
        "successes": {
          "minimum": 0,
          "type": "integer"
        },
        "trials": {
          "minimum": 0,
          "type": "integer"
        },
        "upper": {
          "maximum": 1,
          "minimum": 0,
          "type": [
            "number",
            "null"
          ]
        },
        "z": {
          "const": 1.959963984540054
        }
      },
      "required": [
        "confidenceLevel",
        "z",
        "successes",
        "trials",
        "lower",
        "upper"
      ],
      "type": "object"
    }
  },
  "$id": "https://eth-alpha.invalid/schema/v1.4d-formal-artifact-2.json",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "allOf": [
    {
      "if": {
        "properties": {
          "artifactMode": {
            "const": "FORMAL"
          }
        },
        "required": [
          "artifactMode"
        ]
      },
      "then": {
        "properties": {
          "core": {
            "properties": {
              "auditTrail": {
                "properties": {
                  "authenticityGateStatus": {
                    "const": "PASSED"
                  },
                  "featureCoverage": {
                    "const": 1
                  },
                  "manifestCoverage": {
                    "const": 1
                  },
                  "validationRunStatus": {
                    "const": "SUCCEEDED"
                  }
                }
              },
              "governanceAuthorizationRef": {
                "$ref": "#/$defs/governanceAuthorizationRef"
              }
            }
          }
        }
      }
    },
    {
      "if": {
        "properties": {
          "artifactMode": {
            "const": "DRY_RUN"
          }
        },
        "required": [
          "artifactMode"
        ]
      },
      "then": {
        "properties": {
          "core": {
            "properties": {
              "governanceAuthorizationRef": {
                "type": "null"
              }
            }
          }
        }
      }
    }
  ],
  "properties": {
    "artifactMode": {
      "enum": [
        "FORMAL",
        "DRY_RUN"
      ]
    },
    "core": {
      "$ref": "#/$defs/artifactCore"
    },
    "deterministicProvenance": {
      "additionalProperties": false,
      "properties": {
        "canonicalization": {
          "const": "RFC8785"
        },
        "encoding": {
          "const": "UTF-8"
        },
        "manifestContentHash": {
          "pattern": "^[0-9a-f]{64}$",
          "type": "string"
        },
        "timeSource": {
          "const": "VALIDATION_RUN_FINISHED_AT"
        },
        "trailingNewline": {
          "const": false
        },
        "validationRunFinishedAt": {
          "format": "date-time",
          "pattern": "Z$",
          "type": "string"
        }
      },
      "required": [
        "canonicalization",
        "encoding",
        "trailingNewline",
        "timeSource",
        "validationRunFinishedAt",
        "manifestContentHash"
      ],
      "type": "object"
    },
    "schemaVersion": {
      "const": "v1.4d-formal-research-artifact/2"
    }
  },
  "required": [
    "schemaVersion",
    "artifactMode",
    "core",
    "deterministicProvenance"
  ],
  "type": "object"
}
```

### 4.12 sidecar Schema

```json
{
  "$id": "https://eth-alpha.invalid/schema/v1.4d-artifact-sidecar-1.json",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "artifactMode": {
      "enum": [
        "FORMAL",
        "DRY_RUN"
      ]
    },
    "canonicalization": {
      "const": "RFC8785"
    },
    "encoding": {
      "const": "UTF-8"
    },
    "evaluationVersion": {
      "minLength": 1,
      "type": "string"
    },
    "fullMainArtifactSha256": {
      "pattern": "^[0-9a-f]{64}$",
      "type": "string"
    },
    "mainArtifactSchemaVersion": {
      "const": "v1.4d-formal-research-artifact/2"
    },
    "mainFileName": {
      "const": "research-artifact.json"
    },
    "schemaVersion": {
      "const": "v1.4d-artifact-sidecar/1"
    },
    "trailingNewline": {
      "const": false
    },
    "validationRunId": {
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
      "type": "string"
    }
  },
  "required": [
    "schemaVersion",
    "mainFileName",
    "canonicalization",
    "encoding",
    "trailingNewline",
    "fullMainArtifactSha256",
    "mainArtifactSchemaVersion",
    "artifactMode",
    "validationRunId",
    "evaluationVersion"
  ],
  "type": "object"
}
```


### 4.13 治理授权记录 Schema

```json
{
  "$id": "https://eth-alpha.invalid/schema/v1.4d-governance-authorization-1.json",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "authorizationScope": {
      "const": "FORMAL_RESEARCH_EXECUTION"
    },
    "authorizedAt": {
      "format": "date-time",
      "pattern": "Z$",
      "type": "string"
    },
    "authorizedByRole": {
      "const": "CHAIRMAN"
    },
    "decision": {
      "const": "APPROVE"
    },
    "hashAlgorithm": {
      "const": "SHA-256"
    },
    "schemaVersion": {
      "const": "v1.4d-governance-authorization/1"
    },
    "thresholdsSha256": {
      "pattern": "^[0-9a-f]{64}$",
      "type": "string"
    },
    "validationRunId": {
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
      "type": "string"
    }
  },
  "required": [
    "schemaVersion",
    "hashAlgorithm",
    "validationRunId",
    "thresholdsSha256",
    "authorizationScope",
    "decision",
    "authorizedByRole",
    "authorizedAt"
  ],
  "type": "object"
}
```

### 4.14 Artifact Publish Result Schema

```json
{
  "$id": "https://eth-alpha.invalid/schema/v1.4d-artifact-publish-result-4.json",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "allOf": [
    {
      "if": {
        "properties": {
          "operationStatus": {
            "enum": [
              "PUBLISHED",
              "REUSED_IDENTICAL"
            ]
          }
        },
        "required": [
          "operationStatus"
        ]
      },
      "then": {
        "properties": {
          "postPublishStatus": {
            "enum": [
              "COMPLETE",
              "WARNING",
              "ERROR"
            ]
          },
          "reasonCode": {
            "const": "NONE"
          }
        }
      }
    },
    {
      "if": {
        "properties": {
          "operationStatus": {
            "const": "FAILED"
          }
        },
        "required": [
          "operationStatus"
        ]
      },
      "then": {
        "properties": {
          "postPublishCode": {
            "const": "NONE"
          },
          "postPublishStatus": {
            "const": "NOT_APPLICABLE"
          },
          "reasonCode": {
            "enum": [
              "ARTIFACT_SCHEMA_INVALID",
              "ARTIFACT_CANONICALIZATION_FAILED",
              "ARTIFACT_TEMP_WRITE_FAILED",
              "ARTIFACT_FSYNC_FAILED",
              "ARTIFACT_RENAME_FAILED",
              "ARTIFACT_DIRECTORY_FSYNC_FAILED",
              "ARTIFACT_PAIR_INCOMPLETE",
              "ARTIFACT_HASH_MISMATCH",
              "ARTIFACT_CONTENT_CONFLICT",
              "ARTIFACT_RECOVERY_REQUIRED",
              "D8_INPUT_HASH_MISSING",
              "D8_INPUT_HASH_MISMATCH",
              "D8_INPUT_CANONICALIZATION_FAILED",
              "GOVERNANCE_AUTHORIZATION_MISSING",
              "GOVERNANCE_AUTHORIZATION_INVALID",
              "GOVERNANCE_AUTHORIZATION_MISMATCH",
              "ARTIFACT_ROOT_INVALID",
              "ARTIFACT_PATH_ESCAPE",
              "ARTIFACT_SYMLINK_REJECTED",
              "ARTIFACT_LOCK_ACQUIRE_FAILED",
              "ARTIFACT_LOCK_TIMEOUT",
              "ARTIFACT_LOCK_INVALID",
              "ARTIFACT_LOCK_OWNERSHIP_LOST",
              "ARTIFACT_TEMP_NAME_INVALID",
              "ARTIFACT_TEMP_VERIFY_FAILED",
              "ARTIFACT_READER_VALIDATION_FAILED",
              "ARTIFACT_AUDIT_INTENT_WRITE_FAILED",
              "ARTIFACT_LOCK_IDENTITY_CHANGED",
              "ARTIFACT_STALE_LOCK_QUARANTINE_COLLISION",
              "ARTIFACT_STALE_LOCK_QUARANTINE_UNSUPPORTED",
              "ARTIFACT_STALE_LOCK_QUARANTINE_INVALID",
              "ARTIFACT_STALE_LOCK_QUARANTINE_SYMLINK",
              "ARTIFACT_STALE_LOCK_QUARANTINE_UNVERIFIED",
              "ARTIFACT_STALE_LOCK_QUARANTINE_DELETE_FAILED",
              "ARTIFACT_STALE_LOCK_QUARANTINE_FSYNC_FAILED",
              "ARTIFACT_UNEXPECTED_DIRECTORY_ENTRY"
            ]
          }
        }
      }
    },
    {
      "if": {
        "properties": {
          "postPublishStatus": {
            "const": "COMPLETE"
          }
        },
        "required": [
          "postPublishStatus"
        ]
      },
      "then": {
        "properties": {
          "postPublishCode": {
            "const": "NONE"
          }
        }
      }
    },
    {
      "if": {
        "properties": {
          "postPublishStatus": {
            "const": "WARNING"
          }
        },
        "required": [
          "postPublishStatus"
        ]
      },
      "then": {
        "properties": {
          "postPublishCode": {
            "enum": [
              "POST_PUBLISH_AUDIT_COMPLETION_FAILED",
              "POST_PUBLISH_LOCK_RELEASE_FAILED",
              "POST_PUBLISH_AUDIT_AND_LOCK_FAILED"
            ]
          }
        }
      }
    },
    {
      "if": {
        "properties": {
          "postPublishStatus": {
            "const": "ERROR"
          }
        },
        "required": [
          "postPublishStatus"
        ]
      },
      "then": {
        "properties": {
          "postPublishCode": {
            "enum": [
              "POST_PUBLISH_DIRECTORY_FSYNC_FAILED",
              "POST_PUBLISH_REREAD_IO_FAILED",
              "POST_PUBLISH_REREAD_SCHEMA_FAILED",
              "POST_PUBLISH_REREAD_CANONICAL_FAILED",
              "POST_PUBLISH_REREAD_HASH_MISMATCH",
              "POST_PUBLISH_REREAD_IDENTITY_MISMATCH"
            ]
          }
        }
      }
    }
  ],
  "properties": {
    "operationStatus": {
      "enum": [
        "PUBLISHED",
        "REUSED_IDENTICAL",
        "FAILED"
      ]
    },
    "postPublishCode": {
      "enum": [
        "NONE",
        "POST_PUBLISH_DIRECTORY_FSYNC_FAILED",
        "POST_PUBLISH_REREAD_IO_FAILED",
        "POST_PUBLISH_REREAD_SCHEMA_FAILED",
        "POST_PUBLISH_REREAD_CANONICAL_FAILED",
        "POST_PUBLISH_REREAD_HASH_MISMATCH",
        "POST_PUBLISH_REREAD_IDENTITY_MISMATCH",
        "POST_PUBLISH_AUDIT_COMPLETION_FAILED",
        "POST_PUBLISH_LOCK_RELEASE_FAILED",
        "POST_PUBLISH_AUDIT_AND_LOCK_FAILED"
      ]
    },
    "postPublishStatus": {
      "enum": [
        "NOT_APPLICABLE",
        "COMPLETE",
        "WARNING",
        "ERROR"
      ]
    },
    "reasonCode": {
      "enum": [
        "NONE",
        "ARTIFACT_SCHEMA_INVALID",
        "ARTIFACT_CANONICALIZATION_FAILED",
        "ARTIFACT_TEMP_WRITE_FAILED",
        "ARTIFACT_FSYNC_FAILED",
        "ARTIFACT_RENAME_FAILED",
        "ARTIFACT_DIRECTORY_FSYNC_FAILED",
        "ARTIFACT_PAIR_INCOMPLETE",
        "ARTIFACT_HASH_MISMATCH",
        "ARTIFACT_CONTENT_CONFLICT",
        "ARTIFACT_RECOVERY_REQUIRED",
        "D8_INPUT_HASH_MISSING",
        "D8_INPUT_HASH_MISMATCH",
        "D8_INPUT_CANONICALIZATION_FAILED",
        "GOVERNANCE_AUTHORIZATION_MISSING",
        "GOVERNANCE_AUTHORIZATION_INVALID",
        "GOVERNANCE_AUTHORIZATION_MISMATCH",
        "ARTIFACT_ROOT_INVALID",
        "ARTIFACT_PATH_ESCAPE",
        "ARTIFACT_SYMLINK_REJECTED",
        "ARTIFACT_LOCK_ACQUIRE_FAILED",
        "ARTIFACT_LOCK_TIMEOUT",
        "ARTIFACT_LOCK_INVALID",
        "ARTIFACT_LOCK_OWNERSHIP_LOST",
        "ARTIFACT_TEMP_NAME_INVALID",
        "ARTIFACT_TEMP_VERIFY_FAILED",
        "ARTIFACT_READER_VALIDATION_FAILED",
        "ARTIFACT_AUDIT_INTENT_WRITE_FAILED",
        "ARTIFACT_LOCK_IDENTITY_CHANGED",
        "ARTIFACT_STALE_LOCK_QUARANTINE_COLLISION",
        "ARTIFACT_STALE_LOCK_QUARANTINE_UNSUPPORTED",
        "ARTIFACT_STALE_LOCK_QUARANTINE_INVALID",
        "ARTIFACT_STALE_LOCK_QUARANTINE_SYMLINK",
        "ARTIFACT_STALE_LOCK_QUARANTINE_UNVERIFIED",
        "ARTIFACT_STALE_LOCK_QUARANTINE_DELETE_FAILED",
        "ARTIFACT_STALE_LOCK_QUARANTINE_FSYNC_FAILED",
        "ARTIFACT_UNEXPECTED_DIRECTORY_ENTRY"
      ]
    },
    "runtimeEvents": {
      "items": {
        "enum": [
          "ARTIFACT_PREFLIGHT_PASSED",
          "ARTIFACT_LOCK_ACQUIRED",
          "ARTIFACT_LOCK_WAITING",
          "ARTIFACT_LOCK_TIMEOUT",
          "ARTIFACT_STALE_LOCK_QUARANTINED",
          "ARTIFACT_TEMP_RECOVERY_STARTED",
          "ARTIFACT_TEMP_RECOVERY_COMPLETED",
          "ARTIFACT_TEMP_MAIN_DURABLE",
          "ARTIFACT_TEMP_SIDECAR_DURABLE",
          "ARTIFACT_MAIN_RENAMED",
          "ARTIFACT_MAIN_DIRECTORY_SYNCED",
          "ARTIFACT_SIDECAR_RENAMED",
          "ARTIFACT_PAIR_DIRECTORY_SYNCED",
          "ARTIFACT_READER_VALIDATED",
          "ARTIFACT_REUSED_IDENTICAL",
          "ARTIFACT_PUBLISH_COMPLETED",
          "ARTIFACT_PUBLISH_FAILED",
          "ARTIFACT_LOCK_RELEASED",
          "ARTIFACT_AUDIT_INTENT_WRITTEN",
          "ARTIFACT_COMMIT_POINT_REACHED",
          "ARTIFACT_AUDIT_COMPLETION_WRITTEN",
          "ARTIFACT_AUDIT_COMPLETION_FAILED",
          "ARTIFACT_LOCK_RELEASE_FAILED",
          "ARTIFACT_POST_PUBLISH_WARNING",
          "ARTIFACT_LOCK_CLEANUP_RETRY_STARTED",
          "ARTIFACT_LOCK_CLEANUP_RETRY_COMPLETED",
          "ARTIFACT_LOCK_CLEANUP_RETRY_FAILED",
          "ARTIFACT_STALE_LOCK_IDENTITY_RECHECKED",
          "ARTIFACT_STALE_LOCK_QUARANTINE_COLLISION",
          "ARTIFACT_STALE_LOCK_QUARANTINE_RETRY",
          "ARTIFACT_STALE_LOCK_QUARANTINE_RETRY_EXHAUSTED",
          "ARTIFACT_STALE_LOCK_QUARANTINE_DELETED",
          "ARTIFACT_STALE_LOCK_QUARANTINE_DIRECTORY_SYNCED",
          "ARTIFACT_STALE_LOCK_RECOVERY_BLOCKED",
          "ARTIFACT_SIDECAR_RENAME_COMMIT_POINT",
          "ARTIFACT_POST_PUBLISH_DIRECTORY_FSYNC_FAILED",
          "ARTIFACT_POST_PUBLISH_REREAD_STARTED",
          "ARTIFACT_POST_PUBLISH_REREAD_IO_FAILED",
          "ARTIFACT_POST_PUBLISH_REREAD_SCHEMA_FAILED",
          "ARTIFACT_POST_PUBLISH_REREAD_CANONICAL_FAILED",
          "ARTIFACT_POST_PUBLISH_REREAD_HASH_MISMATCH",
          "ARTIFACT_POST_PUBLISH_REREAD_IDENTITY_MISMATCH",
          "ARTIFACT_POST_PUBLISH_REREAD_COMPLETED",
          "ARTIFACT_COMMITTED_PAIR_RECOVERED"
        ]
      },
      "minItems": 1,
      "type": "array"
    }
  },
  "required": [
    "operationStatus",
    "reasonCode",
    "postPublishStatus",
    "postPublishCode",
    "runtimeEvents"
  ],
  "type": "object"
}
```


### 4.15 Lock File Schema

```json
{
  "$id": "https://eth-alpha.invalid/schema/v1.4d-artifact-lock-2.json",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "acquiredAt": {
      "format": "date-time",
      "pattern": "Z$",
      "type": "string"
    },
    "hostIdentitySha256": {
      "pattern": "^[0-9a-f]{64}$",
      "type": "string"
    },
    "leaseExpiresAt": {
      "format": "date-time",
      "pattern": "Z$",
      "type": "string"
    },
    "lockId": {
      "pattern": "^[0-9a-f]{32}$",
      "type": "string"
    },
    "ownerToken": {
      "pattern": "^[0-9a-f]{64}$",
      "type": "string"
    },
    "ownerUid": {
      "minimum": 0,
      "type": "integer"
    },
    "pid": {
      "minimum": 1,
      "type": "integer"
    },
    "processStartIdentity": {
      "pattern": "^[A-Za-z0-9._:-]{1,128}$",
      "type": "string"
    },
    "schemaVersion": {
      "const": "v1.4d-artifact-lock/2"
    },
    "targetIdentitySha256": {
      "pattern": "^[0-9a-f]{64}$",
      "type": "string"
    }
  },
  "required": [
    "schemaVersion",
    "lockId",
    "ownerToken",
    "targetIdentitySha256",
    "hostIdentitySha256",
    "pid",
    "processStartIdentity",
    "ownerUid",
    "acquiredAt",
    "leaseExpiresAt"
  ],
  "type": "object"
}
```


### 4.16 Reader Result Schema

```json
{
  "$id": "https://eth-alpha.invalid/schema/v1.4d-artifact-reader-result-1.json",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "allOf": [
    {
      "if": {
        "properties": {
          "readerStatus": {
            "const": "ACCEPTED"
          }
        },
        "required": [
          "readerStatus"
        ]
      },
      "then": {
        "properties": {
          "readerReasonCode": {
            "const": "NONE"
          }
        }
      }
    },
    {
      "if": {
        "properties": {
          "readerStatus": {
            "const": "REJECTED"
          }
        },
        "required": [
          "readerStatus"
        ]
      },
      "then": {
        "properties": {
          "readerReasonCode": {
            "enum": [
              "ARTIFACT_NOT_FOUND",
              "ARTIFACT_PAIR_INCOMPLETE",
              "ARTIFACT_READER_IO_FAILED",
              "ARTIFACT_SCHEMA_INVALID",
              "ARTIFACT_CANONICALIZATION_FAILED",
              "ARTIFACT_HASH_MISMATCH",
              "ARTIFACT_IDENTITY_MISMATCH"
            ]
          }
        }
      }
    }
  ],
  "properties": {
    "readerReasonCode": {
      "enum": [
        "NONE",
        "ARTIFACT_NOT_FOUND",
        "ARTIFACT_PAIR_INCOMPLETE",
        "ARTIFACT_READER_IO_FAILED",
        "ARTIFACT_SCHEMA_INVALID",
        "ARTIFACT_CANONICALIZATION_FAILED",
        "ARTIFACT_HASH_MISMATCH",
        "ARTIFACT_IDENTITY_MISMATCH"
      ]
    },
    "readerStatus": {
      "enum": [
        "ACCEPTED",
        "REJECTED"
      ]
    }
  },
  "required": [
    "readerStatus",
    "readerReasonCode"
  ],
  "type": "object"
}
```

## 5. T1–T19 完整执行矩阵

统一规则：每一项必须在同一 `validationRunId` 治理链中；状态 `IMPLEMENTED_BASE` 表示仓库已有入口但仍须由 T8 验证，`READY_TO_IMPLEMENT` 表示本文已冻结契约但仓库尚缺实现，`MANUAL_GOVERNED` 表示人工门禁。任何 NOT_APPLICABLE 都明确给出原因、替代任务与恢复条件。

### T1 — 冻结运行配置

- **任务编号**：T1

- **任务名称**：冻结运行配置

- **状态**：READY_TO_IMPLEMENT

- **目标**：形成签名的 run-config，绑定窗口、版本、成本、thresholds、mode

- **真实代码入口**：新增 `server/src/validation-replay/formal-run-config.js`；复用 `cli-entry.js::validateEffectiveOptions`

- **调用方**：正式 orchestrator

- **输入**：CEO批准的日期/版本/成本/thresholds/DB identity

- **输出**：严格run-config JSON及SHA-256，并显式冻结gitObjectFormat/sourceCommit

- **前置条件**：源 commit固定；商业参数已批准

- **算法或行为**：严格Schema→探测Git object format→校验commit长度/字符→UTC/版本一致性→canonical hash；不推导商业值

- **数据库依赖**：只读 migration/version probe

- **文件依赖**：thresholds JSON、run-config 输出目录

- **配置依赖**：TEST_DATABASE_URL、V1_4D_DATABASE_IDENTITY、V1_4D_ARTIFACT_ROOT

- **thresholds依赖**：直接依赖完整 thresholds artifact

- **reason codes**：RUN_CONFIG_INVALID,CONFIG_MISSING,VERSION_MISMATCH

- **失败语义**：任一失败在数据库业务写入前 BLOCKED

- **幂等规则**：相同输入同 hash；异内容同身份冲突

- **resume规则**：NOT_APPLICABLE：配置冻结无续跑；替代T2；新配置需新身份

- **dry-run规则**：只验证不写业务表

- **FORMAL规则**：仅签名配置可进入T2

- **恢复规则**：保留失败诊断；修正配置后新 run id

- **验收测试**：Schema合法/非法、hash确定性、敏感值脱敏

- **完成定义**：run-config字段完整、hash稳定、无未决工程项

- **RETIRED或DEFERRED承接**：NOT_APPLICABLE：非退役；若schema升级由新schemaVersion承接

### T2 — 环境与数据库预检

- **任务编号**：T2

- **任务名称**：环境与数据库预检

- **状态**：IMPLEMENTED_BASE

- **目标**：证明代码、Node、PostgreSQL、migration、DB身份和容量安全

- **真实代码入口**：`scripts/verify-v1-4d.mjs`、`src/db/research-database-guard.js`、migrate status/capacity guard

- **调用方**：T1/orchestrator

- **输入**：run-config、只读数据库身份/版本/容量

- **输出**：preflight result与稳定错误码

- **前置条件**：T1 PASS；专用研究库

- **算法或行为**：只允许current_database/current_user等安全探针，随后核验migration/表/容量

- **数据库依赖**：专用PostgreSQL；不得生产库

- **文件依赖**：无业务文件写入

- **配置依赖**：显式TEST_DATABASE_URL；不得DATABASE_URL回退

- **thresholds依赖**：NOT_APPLICABLE：不做成绩阈值；替代T16；资源门槛来自run-config

- **reason codes**：DATABASE_IDENTITY_REQUIRED/REJECTED/CONFLICT,TARGET_REJECTED,MIGRATION_INCOMPLETE,CAPACITY_BLOCKED

- **失败语义**：任何失败 BLOCKED，inventory/backfill SQL次数0

- **幂等规则**：重复只读探针结果可重复

- **resume规则**：NOT_APPLICABLE：无状态；修复环境后重跑T2

- **dry-run规则**：只读完整路径

- **FORMAL规则**：身份、migration、容量全部PASS才继续

- **恢复规则**：无清理；修复环境后重跑

- **验收测试**：真实PG错误身份/目标/容量矩阵

- **完成定义**：所有探针PASS且日志无凭据

- **RETIRED或DEFERRED承接**：NOT_APPLICABLE：由T1配置和T3承接

### T3 — 回填全链路 dry-run

- **任务编号**：T3

- **任务名称**：回填全链路 dry-run

- **状态**：IMPLEMENTED_BASE

- **目标**：完整读取/计算且业务表零写入

- **真实代码入口**：`backfill-cli-entry.js::main,runBackfillForInterval`

- **调用方**：T2/orchestrator

- **输入**：run-config的symbols/intervals/from/to/fixedAsOf

- **输出**：每依赖请求计划、预计bar数、缺口

- **前置条件**：T2 PASS

- **算法或行为**：真实适配器分页读取和完整性计算；禁止写后回滚伪装

- **数据库依赖**：只读专用库

- **文件依赖**：runtime日志，不进入FORMAL artifact

- **配置依赖**：Binance网络与TEST_DATABASE_URL

- **thresholds依赖**：NOT_APPLICABLE：不做D8；替代T16

- **reason codes**：DRY_RUN_RESUME_CONFLICT,DATA_SOURCE_FAILURE,INTEGRITY_FAILED

- **失败语义**：失败BLOCKED且表计数不变

- **幂等规则**：相同输入同计划

- **resume规则**：NOT_APPLICABLE：dry-run禁止resume；正式resume见T4/T5

- **dry-run规则**：五业务表和backfill表前后逐表相等

- **FORMAL规则**：NOT_APPLICABLE：本任务本身非FORMAL；通过后才可T4

- **恢复规则**：无数据清理；仅清临时运行日志

- **验收测试**：真实adapter、分页999/1000/1001、零写入

- **完成定义**：全部依赖可取且零写入

- **RETIRED或DEFERRED承接**：NOT_APPLICABLE：T4/T5承接正式写入

### T4 — ETH正式市场数据回填

- **任务编号**：T4

- **任务名称**：ETH正式市场数据回填

- **状态**：IMPLEMENTED_BASE

- **目标**：幂等获取ETHUSDT 15m/1h/4h及审计

- **真实代码入口**：`backfill-cli-entry.js::main`

- **调用方**：T3/orchestrator

- **输入**：ETH范围、fixedAsOf、每interval独立batch

- **输出**：market_bars revisions、raw_payload审计、batch终态

- **前置条件**：T3 PASS

- **算法或行为**：按interval分页；as-of；完整性；不可变raw payload

- **数据库依赖**：专用PG public + historical_validation

- **文件依赖**：NOT_APPLICABLE：数据写DB；T18负责文件

- **配置依赖**：Binance、批量/重试配置

- **thresholds依赖**：NOT_APPLICABLE：研究阈值；替代T16

- **reason codes**：BACKFILL_*、INTEGRITY_FAILED

- **失败语义**：失败批次FAILED/ATTENTION，不能伪成功

- **幂等规则**：unique keys/revision语义；相同内容复用

- **resume规则**：只允许同symbol/interval/window仍RUNNING batch

- **dry-run规则**：完整读取计算但零业务写入（T3）

- **FORMAL规则**：必须使用签名run-config和专用库

- **恢复规则**：按精确batch resume；不可删除raw_payloads

- **验收测试**：分页/lease/resume/缺口/重复/终态测试

- **完成定义**：所有依赖窗口完整，batch终态SUCCEEDED

- **RETIRED或DEFERRED承接**：NOT_APPLICABLE：T6承接冻结

### T5 — BTC正式市场数据回填

- **任务编号**：T5

- **任务名称**：BTC正式市场数据回填

- **状态**：IMPLEMENTED_BASE

- **目标**：幂等获取BTCUSDT 15m/1h/4h联动数据

- **真实代码入口**：同T4入口，symbol=BTCUSDT

- **调用方**：T4可并行的orchestrator

- **输入**：BTC范围、fixedAsOf、独立batch

- **输出**：BTC bars/audit/batch

- **前置条件**：T3 PASS

- **算法或行为**：与T4完全同契约但身份独立；不得复用ETH batch

- **数据库依赖**：同T4

- **文件依赖**：同T4

- **配置依赖**：同T4

- **thresholds依赖**：NOT_APPLICABLE：研究阈值；替代T16

- **reason codes**：同T4且symbol mismatch fail-closed

- **失败语义**：同T4

- **幂等规则**：同T4，symbol进入身份

- **resume规则**：同T4，禁止跨symbol

- **dry-run规则**：同T3

- **FORMAL规则**：同T4

- **恢复规则**：同T4

- **验收测试**：BTC专属和跨symbol隔离测试

- **完成定义**：BTC所有依赖完整且无ETH污染

- **RETIRED或DEFERRED承接**：NOT_APPLICABLE：T6承接

### T6 — 完整性与多symbol Manifest冻结

- **任务编号**：T6

- **任务名称**：完整性与多symbol Manifest冻结

- **状态**：IMPLEMENTED_BASE

- **目标**：冻结唯一ETH/BTC依赖集合、member身份、vintage与datasetVersion

- **真实代码入口**：`dataset-manifest-builder.js::buildDatasetManifest`、V2 verifier

- **调用方**：T4+T5/orchestrator

- **输入**：两symbol三interval bars/batches/fixedAsOf

- **输出**：V2 manifest、datasetVersion、content/logical hashes

- **前置条件**：T4/T5成功且零缺口重复乱序

- **算法或行为**：共享canonical内容；成员全字段绑定；advisory lock；冲突稳定拒绝

- **数据库依赖**：dataset_manifests及只读market_bars

- **文件依赖**：NOT_APPLICABLE：DB为权威；T18引用hash

- **配置依赖**：manifest contract v2、research availability version

- **thresholds依赖**：NOT_APPLICABLE：D8阈值；替代T16

- **reason codes**：DATASET_*_MISMATCH,LOGICAL_WINDOW_CONFLICT,MEMBER_CONTENT_MISMATCH

- **失败语义**：任一不一致fail-closed

- **幂等规则**：同窗口同内容复用；异内容冲突

- **resume规则**：重新完整验证；不得跳过

- **dry-run规则**：计算完整manifest但零写入

- **FORMAL规则**：正式只允许contract v2且完整成员

- **恢复规则**：partial写事务回滚；不得自动改manifest

- **验收测试**：R27/R28、并发、rollback、cross-symbol/fixedAsOf

- **完成定义**：唯一合法manifest可被重新计算验证

- **RETIRED或DEFERRED承接**：NOT_APPLICABLE：T7承接

### T7 — 历史Feature回填

- **任务编号**：T7

- **任务名称**：历史Feature回填

- **状态**：IMPLEMENTED_BASE

- **目标**：按manifest成员和as-of生成可重放features

- **真实代码入口**：`historical-feature-backfill.js::runHistoricalFeatureBackfill`; CLI

- **调用方**：T6/orchestrator

- **输入**：datasetVersion、ETH目标点、algorithm/feature version

- **输出**：feature_records、lineage、summary

- **前置条件**：V2 manifest验证PASS

- **算法或行为**：按24h节奏点加载ETH/BTC依赖；canonical engine；逐点fail-closed

- **数据库依赖**：feature_records/lineage，manifest只读

- **文件依赖**：NOT_APPLICABLE：数据入DB

- **配置依赖**：feature/algorithm/dataset版本

- **thresholds依赖**：NOT_APPLICABLE：D8阈值；替代T16

- **reason codes**：TARGET_BAR_MISSING,SOURCE_NOT_IN_DATASET_MANIFEST,FEATURE_SET_VERSION_MISMATCH

- **失败语义**：任何点失败阻断正式链

- **幂等规则**：内容同则ALREADY_PRESENT，异内容CONFLICT

- **resume规则**：`--resume-after`严格对齐点

- **dry-run规则**：完整计算和验证、业务表零写入

- **FORMAL规则**：正式写入必须lineage完整

- **恢复规则**：以最后成功点续跑；不得删审计raw payload

- **验收测试**：unit+真实PG+类型/对齐/lease

- **完成定义**：所有目标点成功或可证明幂等复用

- **RETIRED或DEFERRED承接**：NOT_APPLICABLE：T9承接

### T8 — 代码与测试准备门禁

- **任务编号**：T8

- **任务名称**：代码与测试准备门禁

- **状态**：READY_TO_IMPLEMENT

- **目标**：冻结已有测试及D7/D8必须新增测试，防止未实现即开跑

- **真实代码入口**：现有 `verify-v1-4d.mjs`; 新增 `formal-contract.test.js`,`artifact-publisher.test.js`,`go-no-go-evaluator.test.js`

- **调用方**：T1–T7/orchestrator

- **输入**：source commit、测试清单、Schema

- **输出**：test evidence manifest

- **前置条件**：T1–T7且clean commit

- **算法或行为**：运行离线、PG、真实性、manifest、feature、replay、scorecard及本文新增测试；禁止skip核心PG

- **数据库依赖**：隔离PG service

- **文件依赖**：测试日志/artifact清单（runtime only）

- **配置依赖**：Node>=22、依赖锁、TEST_DATABASE_URL

- **thresholds依赖**：使用测试阈值向量，非正式商业阈值

- **reason codes**：TEST_GATE_FAILED,TEST_SKIPPED,HEAD_MISMATCH

- **失败语义**：任一强制fail/skip BLOCKED

- **幂等规则**：相同commit测试清单hash稳定

- **resume规则**：失败后仅重跑失败集+全量，证据仍绑HEAD

- **dry-run规则**：可跑纯函数/Schema；PG标NOT_RUN而非PASS

- **FORMAL规则**：正式研究前PG必须真实0 skip

- **恢复规则**：删除临时DB；保留脱敏日志

- **验收测试**：现有全量+本轮D8一致性、sourceCommit条件Schema、治理绑定、D8输入hash、发布结果Schema与mutation测试

- **完成定义**：当前HEAD全部强制测试PASS、PG真实执行

- **RETIRED或DEFERRED承接**：NOT_APPLICABLE：T9承接

### T9 — Replay dry-run

- **任务编号**：T9

- **任务名称**：Replay dry-run

- **状态**：IMPLEMENTED_BASE

- **目标**：走完整manifest/feature/generation/evaluation计算但零业务写入

- **真实代码入口**：`cli-entry.js::runWalkForward` with `--dry-run`

- **调用方**：T8/orchestrator

- **输入**：run-config、datasetVersion、24/72范围/split

- **输出**：in-memory summary和表级计数证据

- **前置条件**：T8 PASS

- **算法或行为**：完整验证→枚举点→生成→评估；任何前置验证在首次持久化前

- **数据库依赖**：只读专用PG

- **文件依赖**：runtime日志，不写FORMAL

- **配置依赖**：所有版本与split ratio

- **thresholds依赖**：NOT_APPLICABLE：D8仅T16；计算统计供预检

- **reason codes**：DRY_RUN_WRITE_DETECTED,DATASET_MANIFEST_*

- **失败语义**：写入或缺数据即BLOCKED

- **幂等规则**：重复结果摘要确定（wall-clock外置）

- **resume规则**：dry-run不得resume写状态

- **dry-run规则**：所有业务表前后相等

- **FORMAL规则**：NOT_APPLICABLE：T10才FORMAL

- **恢复规则**：无业务清理

- **验收测试**：两轮定向PG计数与full compute

- **完成定义**：两轮相同、0写、0 skip

- **RETIRED或DEFERRED承接**：NOT_APPLICABLE：T10承接

### T10 — 正式fresh Replay/Evaluation/Report

- **任务编号**：T10

- **任务名称**：正式fresh Replay/Evaluation/Report

- **状态**：IMPLEMENTED_BASE

- **目标**：生成全新快照并真实评估，阻止旧快照包装

- **真实代码入口**：`cli-entry.js::runWalkForward`; replay-authenticity/evaluator/report-builder

- **调用方**：T9/orchestrator

- **输入**：fresh mode、run-config、manifest/features

- **输出**：validation/generation/evaluation runs、snapshots/outcomes/reports

- **前置条件**：T9 PASS，fresh身份

- **算法或行为**：expected/attempted/inserted/reused/conflict精确；fresh要求全部inserted；auth PASS后才evaluation/report

- **数据库依赖**：historical_validation相关表

- **文件依赖**：NOT_APPLICABLE：DB记录；T18导出

- **配置依赖**：algorithm/rule/weight/evaluation/dataset版本

- **thresholds依赖**：NOT_APPLICABLE：D8在T16

- **reason codes**：REPLAY_SNAPSHOT_IDENTITY_CONFLICT,RERUN_AUTHENTICITY_CHECK_FAILED

- **失败语义**：任一reuse/conflict/零新增使run非SUCCEEDED且后续0执行

- **幂等规则**：fresh新身份全插入；resume只允许identical reuse

- **resume规则**：只允许原run完整版本一致且真实性重新核验

- **dry-run规则**：同T9且零写

- **FORMAL规则**：fresh authenticity PASS才可SUCCEEDED

- **恢复规则**：失败状态归档，不删除快照；新研究版本重跑

- **验收测试**：真实性30项PG、report/scorecard拒绝测试

- **完成定义**：全部expected插入、evaluated=expected、报告有效

- **RETIRED或DEFERRED承接**：NOT_APPLICABLE：T11承接

### T11 — Split/Purge/样本会计

- **任务编号**：T11

- **任务名称**：Split/Purge/样本会计

- **状态**：IMPLEMENTED_BASE

- **目标**：形成24/72方向与路径独立raw/effective统计

- **真实代码入口**：`purge.js::computeSplitEffectiveSamples`; `walk-forward.js`; `report-builder.js`

- **调用方**：T10/report adapter

- **输入**：evaluation pairs、trainEnd、validationEnd、eligibility fields

- **输出**：sampleAccounting和两条pipeline evidence

- **前置条件**：T10真实性PASS

- **算法或行为**：时间切分→purge跨界→按targetEndTime去重→按horizon聚合；direction/path独立

- **数据库依赖**：只读snapshots/outcomes

- **文件依赖**：D8 input JSON

- **配置依赖**：split边界、eligibility字段

- **thresholds依赖**：NOT_APPLICABLE：阈值只消费计数；T16

- **reason codes**：SPLIT_ORDER_INVALID,SAMPLE_ACCOUNTING_INCONSISTENT

- **失败语义**：任何计数不守恒DATA_GATE_FAILED

- **幂等规则**：同rows/boundaries输出确定

- **resume规则**：重新读取原run并重算；不改run

- **dry-run规则**：只读计算，允许dry artifact namespace

- **FORMAL规则**：必须绑定原run和版本

- **恢复规则**：无状态；修正输入后新评估版本

- **验收测试**：边界等于train/validation、跨界、999/1000/1001、方向/path对抗

- **完成定义**：所有计数守恒且24/72独立

- **RETIRED或DEFERRED承接**：NOT_APPLICABLE：T12承接

### T12 — 三基线同样本评估

- **任务编号**：T12

- **任务名称**：三基线同样本评估

- **状态**：IMPLEMENTED_BASE

- **目标**：alwaysRange/follow4hTrend/historicalProportionRandom与模型同样本同成本

- **真实代码入口**：`research-scorecard.js`；`v1-4d-scorecard-cli.mjs`

- **调用方**：T11

- **输入**：selected TEST samples、仅TRAIN比例、成本

- **输出**：三baseline按horizon统计及availability

- **前置条件**：T11 PASS

- **算法或行为**：always RANGE；follow4H只认UP/DOWN，RANGE不评估；random概率仅TRAIN估计且固定seed；同测试样本/成本

- **数据库依赖**：只读report data

- **文件依赖**：scorecard input

- **配置依赖**：seed、费用、滑点

- **thresholds依赖**：availability规则由D8固定；数值阈值T16

- **reason codes**：NO_TRAIN_SAMPLES,NO_VALID_TREND,NO_EVALUATION_ROWS

- **失败语义**：不可评估显式NOT_EVALUABLE，不伪成绩

- **幂等规则**：seed和输入绑定run身份

- **resume规则**：只读重算，结果同bytes

- **dry-run规则**：完整计算不写业务表

- **FORMAL规则**：结果进入确定性scorecard

- **恢复规则**：无状态

- **验收测试**：未来泄漏、同样本、成本一致、baseline availability

- **完成定义**：三个均有明确AVAILABLE/NOT_EVALUABLE

- **RETIRED或DEFERRED承接**：NOT_APPLICABLE：T13承接

### T13 — 生成时市场状态与RANGE归因

- **任务编号**：T13

- **任务名称**：生成时市场状态与RANGE归因

- **状态**：READY_TO_IMPLEMENT

- **目标**：以生成时已冻结趋势枚举分组，不读取未来状态

- **真实代码入口**：新增只读 adapter `governance-statistics.js`; 使用snapshot/feature lineage

- **调用方**：T11+T12

- **输入**：同selected样本的generation-time `trend4h`与真实/预测方向

- **输出**：严格UP/DOWN/RANGE group stats、rangeAttribution、coverage

- **前置条件**：T11/T12 PASS

- **算法或行为**：按generatedAt/dataCutoffTime可用的trend4h分组；未知/缺失不归入合法组并使coverage降低；不得修改生产趋势算法

- **数据库依赖**：只读snapshots/features/outcomes

- **文件依赖**：D8 input片段

- **配置依赖**：canonical trend enum

- **thresholds依赖**：market coverage阈值T16

- **reason codes**：MARKET_REGIME_UNKNOWN,COVERAGE_NULL,RANGE_CLASS_ABSENT

- **失败语义**：未知不伪装RANGE；coverage门禁

- **幂等规则**：同输入确定

- **resume规则**：重算原run，只读

- **dry-run规则**：只读；不写业务表

- **FORMAL规则**：绑定manifest/lineage证据

- **恢复规则**：无状态；修正数据后新run/evaluation

- **验收测试**：UP/DOWN/RANGE、unknown、rangeTotal0、无未来泄漏

- **完成定义**：分组和总数守恒、coverage可复算

- **RETIRED或DEFERRED承接**：NOT_APPLICABLE：T14承接

### T14 — 确定性Scorecard构建

- **任务编号**：T14

- **任务名称**：确定性Scorecard构建

- **状态**：READY_TO_IMPLEMENT

- **目标**：生成无wall-clock的完整scorecard JSON/Markdown

- **真实代码入口**：改造 `research-scorecard.js::buildResearchScorecard`; 新增deterministic adapter

- **调用方**：T11–T13

- **输入**：模型/基线权威数据、分组、成本、顶层权威身份时间及全部审计镜像

- **输出**：严格scorecard对象及RFC8785 bytes/hash，仅内存交给T18；不得直接写正式文件

- **前置条件**：T11–T13 PASS

- **算法或行为**：保持无wall-clock的RFC8785纯构造并在sidecar rename前完成主artifact Schema/canonical/身份和完整SHA验证；不定义commit point、不执行post回读

- **数据库依赖**：只读run/report

- **文件依赖**：临时内存；T18发布

- **配置依赖**：evaluationVersion、cost

- **thresholds依赖**：NOT_APPLICABLE：阈值只随D8输入封装；T16

- **reason codes**：SCORECARD_SCHEMA_INVALID,SCORECARD_NONDETERMINISTIC

- **失败语义**：不进入T15/T18

- **幂等规则**：相同输入bytes/hash完全一致

- **resume规则**：只读重建；不得改旧artifact

- **dry-run规则**：允许写dry-run namespace仅由T18

- **FORMAL规则**：FORMAL前独立双构造一致

- **恢复规则**：纯构造无持久状态；丢弃对象后从冻结输入独立重建，不读取旧scorecard文件

- **验收测试**：双构造隔一分钟、全部mutation、Markdown一致

- **完成定义**：scorecard bytes/hash确定且Schema PASS

- **RETIRED或DEFERRED承接**：NOT_APPLICABLE：T15承接

### T15 — 成本前后矩阵

- **任务编号**：T15

- **任务名称**：成本前后矩阵

- **状态**：IMPLEMENTED_BASE

- **目标**：同时披露pre/post成本、MFE/MAE、回撤、连续错误与分组

- **真实代码入口**：`research-scorecard.js::buildResearchScorecard`

- **调用方**：T14

- **输入**：方向/path独立samples、费用/滑点

- **输出**：24/72完整模型与基线矩阵

- **前置条件**：T14 Schema PASS

- **算法或行为**：分类用direction pipeline；MFE/MAE用path pipeline；成本应用于模型及三baseline；不得混分母

- **数据库依赖**：只读report

- **文件依赖**：scorecard对象

- **配置依赖**：fee/slippage显式且fail-closed

- **thresholds依赖**：NOT_APPLICABLE：只产指标；T16判断

- **reason codes**：COST_CONFIG_MISSING,PATH_SAMPLE_ACCOUNTING_INVALID

- **失败语义**：成本缺失不得产生post-cost成绩

- **幂等规则**：相同输入确定

- **resume规则**：只读重算

- **dry-run规则**：完整计算不持久业务表

- **FORMAL规则**：绑定签名成本参数

- **恢复规则**：无状态

- **验收测试**：方向false/path true及反向、成本敏感性

- **完成定义**：全部指标分母清晰且成本一致

- **RETIRED或DEFERRED承接**：NOT_APPLICABLE：T16承接

### T16 — D8 GO/CONDITIONAL/NO-GO

- **任务编号**：T16

- **任务名称**：D8 GO/CONDITIONAL/NO-GO

- **状态**：READY_TO_IMPLEMENT

- **目标**：执行本文唯一D8算法并给出机器决策

- **真实代码入口**：新增 `go-no-go-evaluator.js`，Schema内嵌资源

- **调用方**：T15

- **输入**：本文D8 input/2；scorecard baselines/model为权威，顶层baseline/lift和身份时间为强制镜像

- **输出**：本文D8 output

- **前置条件**：T15与audit完整

- **算法或行为**：先Schema→全局/逐horizon一致性（绝对容差1e-12）→baseline→Wilson→阈值→reason排序→horizon→overall；输出lift只用重算值

- **数据库依赖**：只读run证据

- **文件依赖**：D8 JSON（T18发布）

- **配置依赖**：thresholds已签名

- **thresholds依赖**：完整依赖本文thresholds Schema

- **reason codes**：本文3.5全reason codes

- **失败语义**：Schema失败无输出；数据/baseline失败不得GO

- **幂等规则**：同input确定

- **resume规则**：只读重算；evaluationVersion变化需新artifact身份

- **dry-run规则**：计算并仅dry namespace发布

- **FORMAL规则**：只有签名thresholds与真实性PASS可FORMAL

- **恢复规则**：失败修正输入/版本后新建；不得覆写

- **验收测试**：20个合法完整向量、3个非法向量；含7个一致性冲突/容差向量及null/zero/priority

- **完成定义**：输出唯一且所有向量PASS

- **RETIRED或DEFERRED承接**：NOT_APPLICABLE：T17承接

### T17 — 人工治理确认

- **任务编号**：T17

- **任务名称**：人工治理确认

- **状态**：MANUAL_GOVERNED

- **目标**：记录董事长对商业阈值、风险与是否执行研究的授权，不改变机器结果

- **真实代码入口**：人工签名治理记录；机器只验证其hash/身份

- **调用方**：董事长/CEO，T16只读消费授权

- **输入**：T16输出、签名人/时间/决策范围（时间属于独立治理记录）

- **输出**：严格治理授权记录及其ref：recordSha256、算法、runId、thresholdsSha256、scope、APPROVE、Schema版本

- **前置条件**：T16完成

- **算法或行为**：FORMAL治理在发布意图、目标目录、锁和artifact写入前完成；sidecar rename commit后任何审计故障只进入post通道，不可撤销授权或发布事实

- **数据库依赖**：NOT_APPLICABLE：人工记录系统由组织治理；T18仅读hash；恢复条件为接入批准系统

- **文件依赖**：只读治理登记处的授权记录；FORMAL主artifact嵌入严格ref，DRY_RUN固定null

- **配置依赖**：授权角色与签名验证

- **thresholds依赖**：商业阈值在T1已决定；本任务不重新计算

- **reason codes**：GOVERNANCE_AUTHORIZATION_MISSING,GOVERNANCE_AUTHORIZATION_INVALID,GOVERNANCE_AUTHORIZATION_MISMATCH

- **失败语义**：缺失则BLOCKED；REJECT/HOLD不发布FORMAL结论

- **幂等规则**：同签名记录hash复用

- **resume规则**：NOT_APPLICABLE：人工决策不可自动resume；新决策新record；替代T18

- **dry-run规则**：DRY_RUN不执行或模拟商业授权，`governanceAuthorizationRef`固定为null；条件Schema与测试仍必须验证null通过、非null拒绝

- **FORMAL规则**：FORMAL必须有有效授权；机器决策不可被放宽

- **恢复规则**：保留原记录，新增修订而非覆盖

- **验收测试**：FORMAL合法/缺失/坏hash/错run/错thresholds/scope/decision；DRY_RUN null通过且非null拒绝

- **完成定义**：FORMAL授权PASS且ref可重算；DRY_RUN ref固定null；失败时发布意图、目标目录、锁、temp和final写入均为0

- **RETIRED或DEFERRED承接**：NOT_APPLICABLE：非退役；T18承接；若治理系统不可用则保持BLOCKED

### T18 — D7 artifact发布

- **任务编号**：T18

- **任务名称**：D7 artifact发布

- **状态**：READY_TO_IMPLEMENT

- **目标**：按4章发布完整主artifact+sidecar

- **真实代码入口**：新增 `artifact-publisher.js`

- **调用方**：T14+T16+T17

- **输入**：完整D8 canonical input、deterministic scorecard/decision/audit、git object format/sourceCommit、治理记录与mode

- **输出**：research-artifact.json、sidecar及严格PublishResult `{operationStatus,reasonCode,postPublishStatus,postPublishCode,runtimeEvents}`

- **前置条件**：T14/T16 PASS；FORMAL还需T17批准

- **算法或行为**：严格执行4.3–4.10：候选预验证→意图审计→现有pair预检→锁/恢复→双temp fsync→main rename+dir fsync→sidecar原子rename即commit/PUBLISHED→post dir fsync→独立正式路径回读→完成审计→锁释放

- **数据库依赖**：只读验证run；运行观测可写非业务运行表

- **文件依赖**：V1_4D_ARTIFACT_ROOT/formal或dry-run

- **配置依赖**：签名artifactRoot、lockTimeoutMs、staleLockRecovery、maxArtifactBytes、mode；任何值不得在发布时被环境覆盖

- **thresholds依赖**：封装签名thresholds，不修改值

- **reason codes**：commit前使用正式reason；commit后仅用Publish Result Schema的postPublishStatus/postPublishCode；读取者使用Reader Result Schema独立reason

- **失败语义**：sidecar rename前失败可FAILED；rename成功后永远PUBLISHED/NONE。post dir fsync或回读失败为ERROR，审计/锁失败为WARNING；均保留pair且禁止自动改写

- **幂等规则**：重启时正式pair合法同bytes即REUSED_IDENTICAL，异bytes内容冲突；publisher是否完成回读、锁或审计不影响reader接受

- **resume规则**：按4.7真实可观察状态：sidecar缺失未commit；sidecar存在合法则已commit并复用；重启后若未耐久而缺失则拒绝，不伪造；不得覆盖损坏pair

- **dry-run规则**：只写dry-run路径、governanceAuthorizationRef必须null、不写业务表/FORMAL

- **FORMAL规则**：governanceAuthorizationRef必须存在并验证；D8 input hash、source commit和全部gate PASS

- **恢复规则**：逐状态记录锁bytes SHA/inode、原/隔离lockId、审计阶段、动作/event/reason；symlink、未知名、不可证lineage一律保留并阻断

- **验收测试**：本轮实际CP01–CP14覆盖main-only、sidecar-temp未提交、sidecar rename原子commit、post fsync及I/O/Schema/canonical/hash/identity回读故障、中断复用/冲突、precommit rename失败及既有audit/lock语义；quarantine 16项回归

- **完成定义**：sidecar rename成功即固定PUBLISHED；reader只按完整正式pair判断；所有post故障有唯一状态/code/event/audit且不删除pair

- **RETIRED或DEFERRED承接**：NOT_APPLICABLE：T19承接验证

### T19 — 可复现性与协议终验

- **任务编号**：T19

- **任务名称**：可复现性与协议终验

- **状态**：READY_TO_IMPLEMENT

- **目标**：执行TV-1至TV-10并形成实现验收证据

- **真实代码入口**：新增 `formal-contract-verification.test.js` + 临时目录 fault harness

- **调用方**：T18/CI

- **输入**：固定完整D8 inputs、两runtime observations、git SHA矩阵、治理records、mutations/faults

- **输出**：验证报告（runtime evidence，不进入主artifact）

- **前置条件**：T18实现完成

- **算法或行为**：重新执行全部Schema/$ref/向量/双构造/hash/mutation、基础PV、CP01–CP14、quarantine 16、任务结构和旧commit语义扫描；记录实际结果

- **数据库依赖**：隔离测试PG仅需验证read-only引用；文件测试用临时目录

- **文件依赖**：临时fixture/output，完成后清理

- **配置依赖**：固定Node/locale/timezone、TEST_DATABASE_URL可选

- **thresholds依赖**：使用测试thresholds向量

- **reason codes**：DETERMINISM_FAILED,MUTATION_NOT_DETECTED,PROTOCOL_VIOLATION及Publish Result Schema正式reason

- **失败语义**：任一TV失败阻断READY

- **幂等规则**：相同输入重复执行结果相同

- **resume规则**：失败TV可单独重跑但最终必须全量

- **dry-run规则**：DRY_RUN TV验证路径与零业务写入

- **FORMAL规则**：FORMAL TV仅临时目录，不发布正式研究

- **恢复规则**：删除临时目录；保留脱敏日志

- **验收测试**：9 Schema；20合法/3非法D8；基础PV17/17；R3 commit/read 14/14；quarantine16/16；T1–T19每项24字段；禁止扫描0 hits

- **完成定义**：全部机器组0 fail、旧commit语义0 hits、完整和自归一化SHA可复算；任一失败保持BLOCKED_PENDING_CONTRACT_FIX

- **RETIRED或DEFERRED承接**：NOT_APPLICABLE：终验任务；若实现变化必须重新启用全套TV

### 5.1 T19 的 TV-1 至 TV-10

| TV | 完整输入 | 步骤 | 预期输出 | 失败条件 |
|---|---|---|---|---|
| TV-1 | 固定scorecard输入、相差60秒runtime | 两个新对象独立T14+RFC8785 | scorecard bytes/SHA相同 | 复用旧文件或任一不同 |
| TV-2 | 固定D8输入、治理记录、source commit、完整D7输入 | 两次独立T18构造 | 主bytes/SHA相同；binding=`NONE` | wall-clock进入或binding失败 |
| TV-3 | 改变D8 market group计数但decision不变 | 重算D8 hash/artifact | decision相同、D8 hash和artifact hash不同 | 任一hash不变 |
| TV-4 | 改变rangeAttribution但decision不变 | 同上 | D8/artifact hash不同 | hash不变 |
| TV-5 | 改变其他非决策字段；另改thresholds | 分别独立构造 | 各hash不同 | 任一未检测 |
| TV-6 | FORMAL/DRY_RUN、schemaVersion、evaluationVersion分别变化 | 独立构造 | hash变化；mode路径隔离；DRY governance=null | hash/路径/条件错误 |
| TV-7 | 当前40位SHA1、错误长度/字符、算法长度错配及SHA256合法fixture | Schema验证 | 2合法通过、3非法拒绝 | 错误接受或合法拒绝 |
| TV-8 | FORMAL合法/缺失/错record hash/错thresholds；DRY null/非null | Schema+record绑定 | 合法NONE；缺失/不匹配fail-closed；DRY仅null | 授权绕过 |
| TV-9 | d8InputSha256篡改、顶层provenance篡改、main/sidecar缺失、错sidecar hash、temp中断 | 读回重算与恢复 | 正式D8/ARTIFACT reason；中断可独立重建 | 仅core hash或自动修FORMAL |
| TV-10 | FORMAL/DRY首次、同内容重复、异内容同身份 | 执行发布 | `PUBLISHED/NONE`、`REUSED_IDENTICAL/NONE`、`FAILED/ARTIFACT_CONTENT_CONFLICT` | 使用其他状态/reason、覆盖冲突或dry写业务表 |

### 5.2 D7基础发布协议PV-01至PV-17重新执行结果

基础状态机在本轮同一临时验证会话中从头执行：17/17 PASS，0 FAIL；覆盖首次发布、复用、冲突、temp残留、单边pair、hash错、陈旧/活跃/非法锁、rename/fsync中断、DRY隔离与FORMAL治理prewrite。完整机器记录保存在本轮临时验证输出，不是正式交付物。

### 5.3 sidecar-rename commit point CP01至CP14实际结果

本轮于 `2026-08-05T12:12:39Z` UTC从头执行14项，14/14 PASS，0 FAIL。CP01已准确改名为不完整main-only拒绝；CP02是真实main final + sidecar temp + 无正式sidecar；CP03证明sidecar原子rename返回即commit且在后续dir fsync/回读前reader接受；CP07/08/10/11/14分别覆盖I/O、hash、Schema、identity与canonical回读故障。完整机器记录：

```json
[
  {
    "actual": {
      "operationStatus": "FAILED",
      "postPublishCode": "NONE",
      "postPublishStatus": "NOT_APPLICABLE",
      "reasonCode": "ARTIFACT_PAIR_INCOMPLETE",
      "runtimeEvents": [
        "ARTIFACT_PUBLISH_FAILED"
      ]
    },
    "commitPointOccurred": false,
    "expected": {
      "commitPointOccurred": false,
      "operationStatus": "FAILED",
      "postPublishCode": "NONE",
      "postPublishStatus": "NOT_APPLICABLE",
      "readerReasonCode": "ARTIFACT_PAIR_INCOMPLETE",
      "readerStatus": "REJECTED",
      "reasonCode": "ARTIFACT_PAIR_INCOMPLETE"
    },
    "inputFileState": {
      "mainFinal": "VALID",
      "sidecarFinal": "ABSENT"
    },
    "operationStatus": "FAILED",
    "postPublishCode": "NONE",
    "postPublishStatus": "NOT_APPLICABLE",
    "readerReasonCode": "ARTIFACT_PAIR_INCOMPLETE",
    "readerStatus": "REJECTED",
    "reasonCode": "ARTIFACT_PAIR_INCOMPLETE",
    "result": "PASS",
    "runtimeEvents": [
      "ARTIFACT_PUBLISH_FAILED"
    ],
    "steps": [
      "reader opens final paths only"
    ],
    "testId": "CP01",
    "testName": "INCOMPLETE_MAIN_ONLY_REJECTED"
  },
  {
    "actual": {
      "operationStatus": "FAILED",
      "postPublishCode": "NONE",
      "postPublishStatus": "NOT_APPLICABLE",
      "reasonCode": "ARTIFACT_PAIR_INCOMPLETE",
      "runtimeEvents": [
        "ARTIFACT_PUBLISH_FAILED"
      ]
    },
    "commitPointOccurred": false,
    "expected": {
      "commitPointOccurred": false,
      "operationStatus": "FAILED",
      "readerReasonCode": "ARTIFACT_PAIR_INCOMPLETE",
      "readerStatus": "REJECTED",
      "reasonCode": "ARTIFACT_PAIR_INCOMPLETE"
    },
    "inputFileState": {
      "mainFinal": "VALID_DURABLE",
      "sidecarFinal": "ABSENT",
      "sidecarTemp": "VALID_DURABLE"
    },
    "operationStatus": "FAILED",
    "postPublishCode": "NONE",
    "postPublishStatus": "NOT_APPLICABLE",
    "readerReasonCode": "ARTIFACT_PAIR_INCOMPLETE",
    "readerStatus": "REJECTED",
    "reasonCode": "ARTIFACT_PAIR_INCOMPLETE",
    "result": "PASS",
    "runtimeEvents": [
      "ARTIFACT_PUBLISH_FAILED"
    ],
    "steps": [
      "write/fsync temps",
      "rename main",
      "dir fsync",
      "reader ignores temp"
    ],
    "testId": "CP02",
    "testName": "SIDECAR_TEMP_NOT_COMMITTED"
  },
  {
    "actual": {
      "operationStatus": "PUBLISHED",
      "postPublishCode": "NONE",
      "postPublishStatus": "COMPLETE",
      "reasonCode": "NONE",
      "runtimeEvents": [
        "ARTIFACT_SIDECAR_RENAME_COMMIT_POINT",
        "ARTIFACT_PUBLISH_COMPLETED"
      ]
    },
    "commitPointOccurred": true,
    "expected": {
      "commitPointOccurred": true,
      "operationStatus": "PUBLISHED",
      "readerReasonCode": "NONE",
      "readerStatus": "ACCEPTED",
      "reasonCode": "NONE"
    },
    "inputFileState": {
      "mainFinal": "VALID_DURABLE",
      "postRenameDirFsync": false,
      "publisherReread": false,
      "sidecarFinal": "VALID_RENAMED"
    },
    "operationStatus": "PUBLISHED",
    "postPublishCode": "NONE",
    "postPublishStatus": "COMPLETE",
    "readerReasonCode": "NONE",
    "readerStatus": "ACCEPTED",
    "reasonCode": "NONE",
    "result": "PASS",
    "runtimeEvents": [
      "ARTIFACT_SIDECAR_RENAME_COMMIT_POINT",
      "ARTIFACT_PUBLISH_COMPLETED"
    ],
    "steps": [
      "atomic sidecar rename returns",
      "reader independently validates"
    ],
    "testId": "CP03",
    "testName": "SIDECAR_RENAME_ATOMIC_COMMIT"
  },
  {
    "actual": {
      "operationStatus": "PUBLISHED",
      "pairPreserved": true,
      "postPublishCode": "POST_PUBLISH_DIRECTORY_FSYNC_FAILED",
      "postPublishStatus": "ERROR",
      "reasonCode": "NONE",
      "runtimeEvents": [
        "ARTIFACT_SIDECAR_RENAME_COMMIT_POINT",
        "ARTIFACT_PUBLISH_COMPLETED",
        "ARTIFACT_POST_PUBLISH_DIRECTORY_FSYNC_FAILED",
        "ARTIFACT_POST_PUBLISH_WARNING"
      ]
    },
    "commitPointOccurred": true,
    "expected": {
      "commitPointOccurred": true,
      "operationStatus": "PUBLISHED",
      "postPublishCode": "POST_PUBLISH_DIRECTORY_FSYNC_FAILED",
      "postPublishStatus": "ERROR",
      "readerStatus": "ACCEPTED",
      "reasonCode": "NONE"
    },
    "inputFileState": {
      "completePair": "PRESENT_VALID",
      "fault": "directory fsync EIO"
    },
    "operationStatus": "PUBLISHED",
    "pairPreserved": true,
    "postPublishCode": "POST_PUBLISH_DIRECTORY_FSYNC_FAILED",
    "postPublishStatus": "ERROR",
    "readerReasonCode": "NONE",
    "readerStatus": "ACCEPTED",
    "reasonCode": "NONE",
    "result": "PASS",
    "runtimeEvents": [
      "ARTIFACT_SIDECAR_RENAME_COMMIT_POINT",
      "ARTIFACT_PUBLISH_COMPLETED",
      "ARTIFACT_POST_PUBLISH_DIRECTORY_FSYNC_FAILED",
      "ARTIFACT_POST_PUBLISH_WARNING"
    ],
    "steps": [
      "commit by sidecar rename",
      "inject fsync failure",
      "preserve pair",
      "reader validates"
    ],
    "testId": "CP04",
    "testName": "POST_COMMIT_DIRECTORY_FSYNC_FAILURE"
  },
  {
    "actual": {
      "operationStatus": "REUSED_IDENTICAL",
      "postPublishCode": "NONE",
      "postPublishStatus": "COMPLETE",
      "reasonCode": "NONE",
      "rewritten": false,
      "runtimeEvents": [
        "ARTIFACT_READER_VALIDATED",
        "ARTIFACT_COMMITTED_PAIR_RECOVERED",
        "ARTIFACT_REUSED_IDENTICAL"
      ]
    },
    "commitPointOccurred": true,
    "expected": {
      "commitPointOccurred": true,
      "operationStatus": "REUSED_IDENTICAL",
      "readerStatus": "ACCEPTED",
      "reasonCode": "NONE",
      "rewritten": false
    },
    "inputFileState": {
      "completePair": "PRESENT_VALID",
      "priorPublisherReread": false
    },
    "operationStatus": "REUSED_IDENTICAL",
    "postPublishCode": "NONE",
    "postPublishStatus": "COMPLETE",
    "readerReasonCode": "NONE",
    "readerStatus": "ACCEPTED",
    "reasonCode": "NONE",
    "result": "PASS",
    "rewritten": false,
    "runtimeEvents": [
      "ARTIFACT_READER_VALIDATED",
      "ARTIFACT_COMMITTED_PAIR_RECOVERED",
      "ARTIFACT_REUSED_IDENTICAL"
    ],
    "steps": [
      "restart",
      "independent reader validation",
      "compare candidate bytes",
      "no write"
    ],
    "testId": "CP05",
    "testName": "RESTART_BEFORE_REREAD_IDENTICAL_REUSE"
  },
  {
    "actual": {
      "operationStatus": "FAILED",
      "postPublishCode": "NONE",
      "postPublishStatus": "NOT_APPLICABLE",
      "reasonCode": "ARTIFACT_CONTENT_CONFLICT",
      "rewritten": false,
      "runtimeEvents": [
        "ARTIFACT_READER_VALIDATED",
        "ARTIFACT_PUBLISH_FAILED"
      ]
    },
    "commitPointOccurred": true,
    "expected": {
      "commitPointOccurred": true,
      "operationStatus": "FAILED",
      "readerStatus": "ACCEPTED",
      "reasonCode": "ARTIFACT_CONTENT_CONFLICT",
      "rewritten": false
    },
    "inputFileState": {
      "candidate": "DIFFERENT_BYTES_SAME_IDENTITY",
      "completePair": "PRESENT_VALID"
    },
    "operationStatus": "FAILED",
    "postPublishCode": "NONE",
    "postPublishStatus": "NOT_APPLICABLE",
    "readerReasonCode": "NONE",
    "readerStatus": "ACCEPTED",
    "reasonCode": "ARTIFACT_CONTENT_CONFLICT",
    "result": "PASS",
    "rewritten": false,
    "runtimeEvents": [
      "ARTIFACT_READER_VALIDATED",
      "ARTIFACT_PUBLISH_FAILED"
    ],
    "steps": [
      "reader validates existing",
      "compare bytes",
      "block overwrite"
    ],
    "testId": "CP06",
    "testName": "RESTART_BEFORE_REREAD_DIFFERENT_CONFLICT"
  },
  {
    "actual": {
      "operationStatus": "PUBLISHED",
      "pairPreserved": true,
      "postPublishCode": "POST_PUBLISH_REREAD_IO_FAILED",
      "postPublishStatus": "ERROR",
      "reasonCode": "NONE",
      "runtimeEvents": [
        "ARTIFACT_SIDECAR_RENAME_COMMIT_POINT",
        "ARTIFACT_PUBLISH_COMPLETED",
        "ARTIFACT_POST_PUBLISH_REREAD_STARTED",
        "ARTIFACT_POST_PUBLISH_REREAD_IO_FAILED",
        "ARTIFACT_POST_PUBLISH_WARNING"
      ]
    },
    "commitPointOccurred": true,
    "expected": {
      "commitPointOccurred": true,
      "operationStatus": "PUBLISHED",
      "postPublishCode": "POST_PUBLISH_REREAD_IO_FAILED",
      "postPublishStatus": "ERROR",
      "readerStatus": "ACCEPTED",
      "reasonCode": "NONE"
    },
    "inputFileState": {
      "completePair": "PRESENT_VALID",
      "publisherFault": "READ_EIO"
    },
    "operationStatus": "PUBLISHED",
    "pairPreserved": true,
    "postPublishCode": "POST_PUBLISH_REREAD_IO_FAILED",
    "postPublishStatus": "ERROR",
    "readerReasonCode": "NONE",
    "readerStatus": "ACCEPTED",
    "reasonCode": "NONE",
    "result": "PASS",
    "runtimeEvents": [
      "ARTIFACT_SIDECAR_RENAME_COMMIT_POINT",
      "ARTIFACT_PUBLISH_COMPLETED",
      "ARTIFACT_POST_PUBLISH_REREAD_STARTED",
      "ARTIFACT_POST_PUBLISH_REREAD_IO_FAILED",
      "ARTIFACT_POST_PUBLISH_WARNING"
    ],
    "steps": [
      "commit",
      "inject publisher read EIO",
      "independent reader validates"
    ],
    "testId": "CP07",
    "testName": "POST_COMMIT_PUBLISHER_REREAD_IO_FAILURE"
  },
  {
    "actual": {
      "autoRepair": false,
      "operationStatus": "PUBLISHED",
      "postPublishCode": "POST_PUBLISH_REREAD_HASH_MISMATCH",
      "postPublishStatus": "ERROR",
      "reasonCode": "NONE",
      "runtimeEvents": [
        "ARTIFACT_SIDECAR_RENAME_COMMIT_POINT",
        "ARTIFACT_PUBLISH_COMPLETED",
        "ARTIFACT_POST_PUBLISH_REREAD_STARTED",
        "ARTIFACT_POST_PUBLISH_REREAD_HASH_MISMATCH",
        "ARTIFACT_POST_PUBLISH_WARNING"
      ]
    },
    "autoRepair": false,
    "commitPointOccurred": true,
    "expected": {
      "autoRepair": false,
      "commitPointOccurred": true,
      "operationStatus": "PUBLISHED",
      "postPublishCode": "POST_PUBLISH_REREAD_HASH_MISMATCH",
      "postPublishStatus": "ERROR",
      "readerReasonCode": "ARTIFACT_HASH_MISMATCH",
      "readerStatus": "REJECTED",
      "reasonCode": "NONE"
    },
    "inputFileState": {
      "completePair": "VISIBLE",
      "postCommitMutation": "SIDECAR_HASH_CORRUPT"
    },
    "operationStatus": "PUBLISHED",
    "postPublishCode": "POST_PUBLISH_REREAD_HASH_MISMATCH",
    "postPublishStatus": "ERROR",
    "readerReasonCode": "ARTIFACT_HASH_MISMATCH",
    "readerStatus": "REJECTED",
    "reasonCode": "NONE",
    "result": "PASS",
    "runtimeEvents": [
      "ARTIFACT_SIDECAR_RENAME_COMMIT_POINT",
      "ARTIFACT_PUBLISH_COMPLETED",
      "ARTIFACT_POST_PUBLISH_REREAD_STARTED",
      "ARTIFACT_POST_PUBLISH_REREAD_HASH_MISMATCH",
      "ARTIFACT_POST_PUBLISH_WARNING"
    ],
    "steps": [
      "commit",
      "inject corruption",
      "publisher reread",
      "independent reader reject",
      "no repair"
    ],
    "testId": "CP08",
    "testName": "POST_COMMIT_INTEGRITY_FAILURE_READER_REJECTS"
  },
  {
    "actual": {
      "operationStatus": "FAILED",
      "postPublishCode": "NONE",
      "postPublishStatus": "NOT_APPLICABLE",
      "reasonCode": "ARTIFACT_RENAME_FAILED",
      "runtimeEvents": [
        "ARTIFACT_MAIN_RENAMED",
        "ARTIFACT_PUBLISH_FAILED"
      ]
    },
    "commitPointOccurred": false,
    "expected": {
      "commitPointOccurred": false,
      "operationStatus": "FAILED",
      "postPublishStatus": "NOT_APPLICABLE",
      "readerReasonCode": "ARTIFACT_PAIR_INCOMPLETE",
      "readerStatus": "REJECTED",
      "reasonCode": "ARTIFACT_RENAME_FAILED"
    },
    "inputFileState": {
      "fault": "RENAME_EIO",
      "mainFinal": "VALID_DURABLE",
      "sidecarFinal": "ABSENT",
      "sidecarTemp": "VALID"
    },
    "operationStatus": "FAILED",
    "postPublishCode": "NONE",
    "postPublishStatus": "NOT_APPLICABLE",
    "readerReasonCode": "ARTIFACT_PAIR_INCOMPLETE",
    "readerStatus": "REJECTED",
    "reasonCode": "ARTIFACT_RENAME_FAILED",
    "result": "PASS",
    "runtimeEvents": [
      "ARTIFACT_MAIN_RENAMED",
      "ARTIFACT_PUBLISH_FAILED"
    ],
    "steps": [
      "inject sidecar rename failure",
      "reader final paths"
    ],
    "testId": "CP09",
    "testName": "SIDECAR_RENAME_FAILURE_PRECOMMIT"
  },
  {
    "actual": {
      "operationStatus": "PUBLISHED",
      "pairDeleted": false,
      "postPublishCode": "POST_PUBLISH_REREAD_SCHEMA_FAILED",
      "postPublishStatus": "ERROR",
      "reasonCode": "NONE",
      "runtimeEvents": [
        "ARTIFACT_SIDECAR_RENAME_COMMIT_POINT",
        "ARTIFACT_POST_PUBLISH_REREAD_SCHEMA_FAILED",
        "ARTIFACT_POST_PUBLISH_WARNING"
      ]
    },
    "commitPointOccurred": true,
    "expected": {
      "commitPointOccurred": true,
      "operationStatus": "PUBLISHED",
      "pairDeleted": false,
      "postPublishCode": "POST_PUBLISH_REREAD_SCHEMA_FAILED",
      "postPublishStatus": "ERROR",
      "readerStatus": "REJECTED",
      "reasonCode": "NONE"
    },
    "inputFileState": {
      "completePair": "VISIBLE",
      "publisherFault": "SCHEMA_INVALID_OBSERVED"
    },
    "operationStatus": "PUBLISHED",
    "pairDeleted": false,
    "postPublishCode": "POST_PUBLISH_REREAD_SCHEMA_FAILED",
    "postPublishStatus": "ERROR",
    "readerReasonCode": "ARTIFACT_SCHEMA_INVALID",
    "readerStatus": "REJECTED",
    "reasonCode": "NONE",
    "result": "PASS",
    "runtimeEvents": [
      "ARTIFACT_SIDECAR_RENAME_COMMIT_POINT",
      "ARTIFACT_POST_PUBLISH_REREAD_SCHEMA_FAILED",
      "ARTIFACT_POST_PUBLISH_WARNING"
    ],
    "steps": [
      "commit",
      "publisher schema validation fails",
      "preserve"
    ],
    "testId": "CP10",
    "testName": "POST_COMMIT_REREAD_SCHEMA_FAILURE"
  },
  {
    "actual": {
      "autoRepair": false,
      "operationStatus": "PUBLISHED",
      "postPublishCode": "POST_PUBLISH_REREAD_IDENTITY_MISMATCH",
      "postPublishStatus": "ERROR",
      "reasonCode": "NONE",
      "runtimeEvents": [
        "ARTIFACT_SIDECAR_RENAME_COMMIT_POINT",
        "ARTIFACT_POST_PUBLISH_REREAD_IDENTITY_MISMATCH",
        "ARTIFACT_POST_PUBLISH_WARNING"
      ]
    },
    "autoRepair": false,
    "commitPointOccurred": true,
    "expected": {
      "autoRepair": false,
      "commitPointOccurred": true,
      "operationStatus": "PUBLISHED",
      "postPublishCode": "POST_PUBLISH_REREAD_IDENTITY_MISMATCH",
      "postPublishStatus": "ERROR",
      "readerStatus": "REJECTED",
      "reasonCode": "NONE"
    },
    "inputFileState": {
      "completePair": "VISIBLE",
      "publisherFault": "IDENTITY_MISMATCH_OBSERVED"
    },
    "operationStatus": "PUBLISHED",
    "postPublishCode": "POST_PUBLISH_REREAD_IDENTITY_MISMATCH",
    "postPublishStatus": "ERROR",
    "readerReasonCode": "ARTIFACT_IDENTITY_MISMATCH",
    "readerStatus": "REJECTED",
    "reasonCode": "NONE",
    "result": "PASS",
    "runtimeEvents": [
      "ARTIFACT_SIDECAR_RENAME_COMMIT_POINT",
      "ARTIFACT_POST_PUBLISH_REREAD_IDENTITY_MISMATCH",
      "ARTIFACT_POST_PUBLISH_WARNING"
    ],
    "steps": [
      "commit",
      "publisher identity check fails",
      "block future writes"
    ],
    "testId": "CP11",
    "testName": "POST_COMMIT_REREAD_IDENTITY_FAILURE"
  },
  {
    "actual": {
      "operationStatus": "PUBLISHED",
      "postPublishCode": "POST_PUBLISH_AUDIT_COMPLETION_FAILED",
      "postPublishStatus": "WARNING",
      "reasonCode": "NONE",
      "runtimeEvents": [
        "ARTIFACT_SIDECAR_RENAME_COMMIT_POINT",
        "ARTIFACT_AUDIT_COMPLETION_FAILED",
        "ARTIFACT_POST_PUBLISH_WARNING"
      ]
    },
    "commitPointOccurred": true,
    "expected": {
      "commitPointOccurred": true,
      "operationStatus": "PUBLISHED",
      "postPublishCode": "POST_PUBLISH_AUDIT_COMPLETION_FAILED",
      "postPublishStatus": "WARNING",
      "readerStatus": "ACCEPTED",
      "reasonCode": "NONE"
    },
    "inputFileState": {
      "completePair": "PRESENT_VALID",
      "fault": "AUDIT_WRITE"
    },
    "operationStatus": "PUBLISHED",
    "postPublishCode": "POST_PUBLISH_AUDIT_COMPLETION_FAILED",
    "postPublishStatus": "WARNING",
    "readerReasonCode": "NONE",
    "readerStatus": "ACCEPTED",
    "reasonCode": "NONE",
    "result": "PASS",
    "runtimeEvents": [
      "ARTIFACT_SIDECAR_RENAME_COMMIT_POINT",
      "ARTIFACT_AUDIT_COMPLETION_FAILED",
      "ARTIFACT_POST_PUBLISH_WARNING"
    ],
    "steps": [
      "commit",
      "audit completion fails",
      "preserve"
    ],
    "testId": "CP12",
    "testName": "POST_COMMIT_AUDIT_FAILURE_WARNING"
  },
  {
    "actual": {
      "operationStatus": "PUBLISHED",
      "postPublishCode": "POST_PUBLISH_LOCK_RELEASE_FAILED",
      "postPublishStatus": "WARNING",
      "reasonCode": "NONE",
      "runtimeEvents": [
        "ARTIFACT_SIDECAR_RENAME_COMMIT_POINT",
        "ARTIFACT_LOCK_RELEASE_FAILED",
        "ARTIFACT_POST_PUBLISH_WARNING"
      ]
    },
    "commitPointOccurred": true,
    "expected": {
      "commitPointOccurred": true,
      "operationStatus": "PUBLISHED",
      "postPublishCode": "POST_PUBLISH_LOCK_RELEASE_FAILED",
      "postPublishStatus": "WARNING",
      "readerStatus": "ACCEPTED",
      "reasonCode": "NONE"
    },
    "inputFileState": {
      "completePair": "PRESENT_VALID",
      "fault": "LOCK_UNLINK"
    },
    "operationStatus": "PUBLISHED",
    "postPublishCode": "POST_PUBLISH_LOCK_RELEASE_FAILED",
    "postPublishStatus": "WARNING",
    "readerReasonCode": "NONE",
    "readerStatus": "ACCEPTED",
    "reasonCode": "NONE",
    "result": "PASS",
    "runtimeEvents": [
      "ARTIFACT_SIDECAR_RENAME_COMMIT_POINT",
      "ARTIFACT_LOCK_RELEASE_FAILED",
      "ARTIFACT_POST_PUBLISH_WARNING"
    ],
    "steps": [
      "commit",
      "lock release fails",
      "preserve",
      "allow maintenance retry"
    ],
    "testId": "CP13",
    "testName": "POST_COMMIT_LOCK_RELEASE_FAILURE_WARNING"
  },
  {
    "actual": {
      "autoRepair": false,
      "operationStatus": "PUBLISHED",
      "postPublishCode": "POST_PUBLISH_REREAD_CANONICAL_FAILED",
      "postPublishStatus": "ERROR",
      "reasonCode": "NONE",
      "runtimeEvents": [
        "ARTIFACT_SIDECAR_RENAME_COMMIT_POINT",
        "ARTIFACT_POST_PUBLISH_REREAD_CANONICAL_FAILED",
        "ARTIFACT_POST_PUBLISH_WARNING"
      ]
    },
    "autoRepair": false,
    "commitPointOccurred": true,
    "expected": {
      "autoRepair": false,
      "commitPointOccurred": true,
      "operationStatus": "PUBLISHED",
      "postPublishCode": "POST_PUBLISH_REREAD_CANONICAL_FAILED",
      "postPublishStatus": "ERROR",
      "readerReasonCode": "ARTIFACT_CANONICALIZATION_FAILED",
      "readerStatus": "REJECTED",
      "reasonCode": "NONE"
    },
    "inputFileState": {
      "completePair": "VISIBLE_SCHEMA_VALID_HASH_MATCH",
      "mainBytes": "NONCANONICAL_JSON"
    },
    "operationStatus": "PUBLISHED",
    "postPublishCode": "POST_PUBLISH_REREAD_CANONICAL_FAILED",
    "postPublishStatus": "ERROR",
    "readerReasonCode": "ARTIFACT_CANONICALIZATION_FAILED",
    "readerStatus": "REJECTED",
    "reasonCode": "NONE",
    "result": "PASS",
    "runtimeEvents": [
      "ARTIFACT_SIDECAR_RENAME_COMMIT_POINT",
      "ARTIFACT_POST_PUBLISH_REREAD_CANONICAL_FAILED",
      "ARTIFACT_POST_PUBLISH_WARNING"
    ],
    "steps": [
      "commit",
      "observe noncanonical main bytes",
      "publisher post error",
      "reader independently rejects",
      "no repair"
    ],
    "testId": "CP14",
    "testName": "POST_COMMIT_REREAD_CANONICAL_FAILURE"
  }
]
```
### 5.4 陈旧锁隔离Q-01至Q-16重新执行结果

同一R3会话重新执行16项，16/16 PASS，0 FAIL；锁协议未重新设计。完整机器记录：

```json
[
  {
    "actual": {
      "bytesPreserved": true,
      "operationStatus": "REUSED_IDENTICAL",
      "postPublishCode": "NONE",
      "postPublishStatus": "COMPLETE",
      "quarantineLength": 62,
      "quarantineName": ".research-artifact.lock.stale.8fba1c65bc40a643257e2a8dc18d0c60",
      "reasonCode": "NONE",
      "runtimeEvents": [
        "ARTIFACT_STALE_LOCK_QUARANTINED"
      ]
    },
    "expected": {
      "bytesPreserved": true,
      "operationStatus": "REUSED_IDENTICAL",
      "postPublishCode": "NONE",
      "postPublishStatus": "COMPLETE",
      "reasonCode": "NONE"
    },
    "input": "valid stale fixed lock",
    "operationStatus": "REUSED_IDENTICAL",
    "postPublishCode": "NONE",
    "postPublishStatus": "COMPLETE",
    "reasonCode": "NONE",
    "result": "PASS",
    "runtimeEvents": [
      "ARTIFACT_STALE_LOCK_QUARANTINED"
    ],
    "steps": [
      "prove stale",
      "recheck bytes/digest",
      "atomic no-replace rename",
      "dir fsync"
    ],
    "testName": "Q01_STALE_FIXED_LOCK_ATOMIC_QUARANTINE"
  },
  {
    "actual": {
      "bytesPreserved": true,
      "operationStatus": "REUSED_IDENTICAL",
      "postPublishCode": "NONE",
      "postPublishStatus": "COMPLETE",
      "quarantineLength": 62,
      "quarantineName": ".research-artifact.lock.stale.8fba1c65bc40a643257e2a8dc18d0c60",
      "reasonCode": "NONE",
      "runtimeEvents": [
        "ARTIFACT_STALE_LOCK_QUARANTINED"
      ]
    },
    "expected": {
      "operationStatus": "REUSED_IDENTICAL",
      "postPublishCode": "NONE",
      "postPublishStatus": "COMPLETE",
      "quarantineLength": 62,
      "reasonCode": "NONE"
    },
    "input": "32-hex CSPRNG quarantine id",
    "operationStatus": "REUSED_IDENTICAL",
    "postPublishCode": "NONE",
    "postPublishStatus": "COMPLETE",
    "reasonCode": "NONE",
    "result": "PASS",
    "runtimeEvents": [
      "ARTIFACT_STALE_LOCK_QUARANTINED"
    ],
    "steps": [
      "regex and length check"
    ],
    "testName": "Q02_QUARANTINE_NAME_FORMAT"
  },
  {
    "actual": {
      "invalidRejected": true,
      "operationStatus": "FAILED",
      "postPublishCode": "NONE",
      "postPublishStatus": "NOT_APPLICABLE",
      "reasonCode": "ARTIFACT_STALE_LOCK_QUARANTINE_INVALID",
      "runtimeEvents": [
        "ARTIFACT_STALE_LOCK_RECOVERY_BLOCKED"
      ]
    },
    "expected": {
      "invalidRejected": true,
      "operationStatus": "FAILED",
      "postPublishCode": "NONE",
      "postPublishStatus": "NOT_APPLICABLE",
      "reasonCode": "ARTIFACT_STALE_LOCK_QUARANTINE_INVALID"
    },
    "input": "uppercase/wrong-length lockId",
    "operationStatus": "FAILED",
    "postPublishCode": "NONE",
    "postPublishStatus": "NOT_APPLICABLE",
    "reasonCode": "ARTIFACT_STALE_LOCK_QUARANTINE_INVALID",
    "result": "PASS",
    "runtimeEvents": [
      "ARTIFACT_STALE_LOCK_RECOVERY_BLOCKED"
    ],
    "steps": [
      "validate lock schema before rename"
    ],
    "testName": "Q03_INVALID_LOCK_ID_REJECTED"
  },
  {
    "actual": {
      "existingNotOverwritten": true,
      "operationStatus": "REUSED_IDENTICAL",
      "postPublishCode": "NONE",
      "postPublishStatus": "COMPLETE",
      "reasonCode": "NONE",
      "retrySucceeded": true,
      "runtimeEvents": [
        "ARTIFACT_STALE_LOCK_QUARANTINE_COLLISION",
        "ARTIFACT_STALE_LOCK_QUARANTINE_RETRY",
        "ARTIFACT_STALE_LOCK_QUARANTINED"
      ]
    },
    "expected": {
      "existingNotOverwritten": true,
      "operationStatus": "REUSED_IDENTICAL",
      "postPublishCode": "NONE",
      "postPublishStatus": "COMPLETE",
      "reasonCode": "NONE"
    },
    "input": "existing quarantine with same generated id",
    "operationStatus": "REUSED_IDENTICAL",
    "postPublishCode": "NONE",
    "postPublishStatus": "COMPLETE",
    "reasonCode": "NONE",
    "result": "PASS",
    "runtimeEvents": [
      "ARTIFACT_STALE_LOCK_QUARANTINE_COLLISION",
      "ARTIFACT_STALE_LOCK_QUARANTINE_RETRY",
      "ARTIFACT_STALE_LOCK_QUARANTINED"
    ],
    "steps": [
      "exclusive rename collision",
      "preserve existing"
    ],
    "testName": "Q04_COLLISION_NEVER_OVERWRITES"
  },
  {
    "actual": {
      "existingNotOverwritten": true,
      "operationStatus": "REUSED_IDENTICAL",
      "postPublishCode": "NONE",
      "postPublishStatus": "COMPLETE",
      "reasonCode": "NONE",
      "retrySucceeded": true,
      "runtimeEvents": [
        "ARTIFACT_STALE_LOCK_QUARANTINE_COLLISION",
        "ARTIFACT_STALE_LOCK_QUARANTINE_RETRY",
        "ARTIFACT_STALE_LOCK_QUARANTINED"
      ]
    },
    "expected": {
      "operationStatus": "REUSED_IDENTICAL",
      "postPublishCode": "NONE",
      "postPublishStatus": "COMPLETE",
      "reasonCode": "NONE",
      "retrySucceeded": true
    },
    "input": "first id collision, second free",
    "operationStatus": "REUSED_IDENTICAL",
    "postPublishCode": "NONE",
    "postPublishStatus": "COMPLETE",
    "reasonCode": "NONE",
    "result": "PASS",
    "runtimeEvents": [
      "ARTIFACT_STALE_LOCK_QUARANTINE_COLLISION",
      "ARTIFACT_STALE_LOCK_QUARANTINE_RETRY",
      "ARTIFACT_STALE_LOCK_QUARANTINED"
    ],
    "steps": [
      "generate new CSPRNG id",
      "exclusive rename"
    ],
    "testName": "Q05_COLLISION_RANDOM_RETRY_SUCCESS"
  },
  {
    "actual": {
      "attempts": 16,
      "operationStatus": "FAILED",
      "postPublishCode": "NONE",
      "postPublishStatus": "NOT_APPLICABLE",
      "reasonCode": "ARTIFACT_STALE_LOCK_QUARANTINE_COLLISION",
      "runtimeEvents": [
        "ARTIFACT_STALE_LOCK_QUARANTINE_RETRY_EXHAUSTED"
      ]
    },
    "expected": {
      "attempts": 16,
      "operationStatus": "FAILED",
      "postPublishCode": "NONE",
      "postPublishStatus": "NOT_APPLICABLE",
      "reasonCode": "ARTIFACT_STALE_LOCK_QUARANTINE_COLLISION"
    },
    "input": "16 occupied random ids",
    "operationStatus": "FAILED",
    "postPublishCode": "NONE",
    "postPublishStatus": "NOT_APPLICABLE",
    "reasonCode": "ARTIFACT_STALE_LOCK_QUARANTINE_COLLISION",
    "result": "PASS",
    "runtimeEvents": [
      "ARTIFACT_STALE_LOCK_QUARANTINE_RETRY_EXHAUSTED"
    ],
    "steps": [
      "16 exclusive collisions",
      "stop"
    ],
    "testName": "Q06_COLLISION_RETRY_EXHAUSTED"
  },
  {
    "actual": {
      "operationStatus": "FAILED",
      "postPublishCode": "NONE",
      "postPublishStatus": "NOT_APPLICABLE",
      "reasonCode": "ARTIFACT_LOCK_IDENTITY_CHANGED",
      "renamed": false,
      "runtimeEvents": [
        "ARTIFACT_STALE_LOCK_RECOVERY_BLOCKED"
      ]
    },
    "expected": {
      "operationStatus": "FAILED",
      "postPublishCode": "NONE",
      "postPublishStatus": "NOT_APPLICABLE",
      "reasonCode": "ARTIFACT_LOCK_IDENTITY_CHANGED",
      "renamed": false
    },
    "input": "bytes replaced after stale proof",
    "operationStatus": "FAILED",
    "postPublishCode": "NONE",
    "postPublishStatus": "NOT_APPLICABLE",
    "reasonCode": "ARTIFACT_LOCK_IDENTITY_CHANGED",
    "result": "PASS",
    "runtimeEvents": [
      "ARTIFACT_STALE_LOCK_RECOVERY_BLOCKED"
    ],
    "steps": [
      "reopen O_NOFOLLOW",
      "digest/inode recheck",
      "stop"
    ],
    "testName": "Q07_FIXED_LOCK_CHANGED_BEFORE_RENAME"
  },
  {
    "actual": {
      "deleted": true,
      "mayReacquire": true,
      "operationStatus": "REUSED_IDENTICAL",
      "postPublishCode": "NONE",
      "postPublishStatus": "COMPLETE",
      "reasonCode": "NONE",
      "runtimeEvents": [
        "ARTIFACT_STALE_LOCK_QUARANTINE_DELETED",
        "ARTIFACT_STALE_LOCK_QUARANTINE_DIRECTORY_SYNCED"
      ]
    },
    "expected": {
      "deleted": true,
      "mayReacquire": true,
      "operationStatus": "REUSED_IDENTICAL",
      "postPublishCode": "NONE",
      "postPublishStatus": "COMPLETE",
      "reasonCode": "NONE"
    },
    "input": "one quarantine with current-flow audit proof",
    "operationStatus": "REUSED_IDENTICAL",
    "postPublishCode": "NONE",
    "postPublishStatus": "COMPLETE",
    "reasonCode": "NONE",
    "result": "PASS",
    "runtimeEvents": [
      "ARTIFACT_STALE_LOCK_QUARANTINE_DELETED",
      "ARTIFACT_STALE_LOCK_QUARANTINE_DIRECTORY_SYNCED"
    ],
    "steps": [
      "verify audit lineage/name/content",
      "unlink",
      "dir fsync"
    ],
    "testName": "Q08_ONLY_VALID_QUARANTINE_RECOVERED"
  },
  {
    "actual": {
      "fixedPreserved": true,
      "operationStatus": "FAILED",
      "postPublishCode": "NONE",
      "postPublishStatus": "NOT_APPLICABLE",
      "quarantinePreserved": true,
      "reasonCode": "ARTIFACT_LOCK_TIMEOUT",
      "runtimeEvents": [
        "ARTIFACT_LOCK_WAITING",
        "ARTIFACT_STALE_LOCK_RECOVERY_BLOCKED"
      ]
    },
    "expected": {
      "fixedPreserved": true,
      "operationStatus": "FAILED",
      "postPublishCode": "NONE",
      "postPublishStatus": "NOT_APPLICABLE",
      "quarantinePreserved": true,
      "reasonCode": "ARTIFACT_LOCK_TIMEOUT"
    },
    "input": "active fixed plus valid quarantine",
    "operationStatus": "FAILED",
    "postPublishCode": "NONE",
    "postPublishStatus": "NOT_APPLICABLE",
    "reasonCode": "ARTIFACT_LOCK_TIMEOUT",
    "result": "PASS",
    "runtimeEvents": [
      "ARTIFACT_LOCK_WAITING",
      "ARTIFACT_STALE_LOCK_RECOVERY_BLOCKED"
    ],
    "steps": [
      "validate independently",
      "protect active fixed lock",
      "report"
    ],
    "testName": "Q09_ACTIVE_FIXED_AND_QUARANTINE"
  },
  {
    "actual": {
      "deletedCount": 2,
      "mayReacquire": true,
      "operationStatus": "REUSED_IDENTICAL",
      "postPublishCode": "NONE",
      "postPublishStatus": "COMPLETE",
      "reasonCode": "NONE",
      "runtimeEvents": [
        "ARTIFACT_STALE_LOCK_QUARANTINE_DELETED",
        "ARTIFACT_STALE_LOCK_QUARANTINE_DIRECTORY_SYNCED"
      ]
    },
    "expected": {
      "deletedCount": 2,
      "mayReacquire": true,
      "operationStatus": "REUSED_IDENTICAL",
      "postPublishCode": "NONE",
      "postPublishStatus": "COMPLETE",
      "reasonCode": "NONE"
    },
    "input": "two valid, individually proven quarantines",
    "operationStatus": "REUSED_IDENTICAL",
    "postPublishCode": "NONE",
    "postPublishStatus": "COMPLETE",
    "reasonCode": "NONE",
    "result": "PASS",
    "runtimeEvents": [
      "ARTIFACT_STALE_LOCK_QUARANTINE_DELETED",
      "ARTIFACT_STALE_LOCK_QUARANTINE_DIRECTORY_SYNCED"
    ],
    "steps": [
      "validate each audit lineage and content",
      "delete each",
      "single final dir fsync"
    ],
    "testName": "Q10_MULTIPLE_PROVEN_QUARANTINES"
  },
  {
    "actual": {
      "operationStatus": "FAILED",
      "postPublishCode": "NONE",
      "postPublishStatus": "NOT_APPLICABLE",
      "preserved": true,
      "reasonCode": "ARTIFACT_STALE_LOCK_QUARANTINE_INVALID",
      "runtimeEvents": [
        "ARTIFACT_STALE_LOCK_RECOVERY_BLOCKED"
      ]
    },
    "expected": {
      "operationStatus": "FAILED",
      "postPublishCode": "NONE",
      "postPublishStatus": "NOT_APPLICABLE",
      "preserved": true,
      "reasonCode": "ARTIFACT_STALE_LOCK_QUARANTINE_INVALID"
    },
    "input": "legal name, invalid content",
    "operationStatus": "FAILED",
    "postPublishCode": "NONE",
    "postPublishStatus": "NOT_APPLICABLE",
    "reasonCode": "ARTIFACT_STALE_LOCK_QUARANTINE_INVALID",
    "result": "PASS",
    "runtimeEvents": [
      "ARTIFACT_STALE_LOCK_RECOVERY_BLOCKED"
    ],
    "steps": [
      "lstat",
      "schema reject",
      "preserve"
    ],
    "testName": "Q11_LEGAL_NAME_INVALID_CONTENT"
  },
  {
    "actual": {
      "operationStatus": "FAILED",
      "postPublishCode": "NONE",
      "postPublishStatus": "NOT_APPLICABLE",
      "reasonCode": "ARTIFACT_STALE_LOCK_QUARANTINE_SYMLINK",
      "runtimeEvents": [
        "ARTIFACT_STALE_LOCK_RECOVERY_BLOCKED"
      ],
      "targetPreserved": true
    },
    "expected": {
      "operationStatus": "FAILED",
      "postPublishCode": "NONE",
      "postPublishStatus": "NOT_APPLICABLE",
      "reasonCode": "ARTIFACT_STALE_LOCK_QUARANTINE_SYMLINK",
      "targetPreserved": true
    },
    "input": "whitelisted name is symlink",
    "operationStatus": "FAILED",
    "postPublishCode": "NONE",
    "postPublishStatus": "NOT_APPLICABLE",
    "reasonCode": "ARTIFACT_STALE_LOCK_QUARANTINE_SYMLINK",
    "result": "PASS",
    "runtimeEvents": [
      "ARTIFACT_STALE_LOCK_RECOVERY_BLOCKED"
    ],
    "steps": [
      "lstat no-follow",
      "reject",
      "preserve target"
    ],
    "testName": "Q12_QUARANTINE_SYMLINK_REJECTED"
  },
  {
    "actual": {
      "operationStatus": "FAILED",
      "postPublishCode": "NONE",
      "postPublishStatus": "NOT_APPLICABLE",
      "reasonCode": "ARTIFACT_STALE_LOCK_QUARANTINE_DELETE_FAILED",
      "retryAllowed": true,
      "runtimeEvents": [
        "ARTIFACT_STALE_LOCK_RECOVERY_BLOCKED"
      ]
    },
    "expected": {
      "operationStatus": "FAILED",
      "postPublishCode": "NONE",
      "postPublishStatus": "NOT_APPLICABLE",
      "reasonCode": "ARTIFACT_STALE_LOCK_QUARANTINE_DELETE_FAILED",
      "retryAllowed": true
    },
    "input": "validated quarantine",
    "operationStatus": "FAILED",
    "postPublishCode": "NONE",
    "postPublishStatus": "NOT_APPLICABLE",
    "reasonCode": "ARTIFACT_STALE_LOCK_QUARANTINE_DELETE_FAILED",
    "result": "PASS",
    "runtimeEvents": [
      "ARTIFACT_STALE_LOCK_RECOVERY_BLOCKED"
    ],
    "steps": [
      "inject unlink EACCES",
      "preserve audit evidence"
    ],
    "testName": "Q13_QUARANTINE_DELETE_FAILURE"
  },
  {
    "actual": {
      "operationStatus": "FAILED",
      "postPublishCode": "NONE",
      "postPublishStatus": "NOT_APPLICABLE",
      "reasonCode": "ARTIFACT_STALE_LOCK_QUARANTINE_FSYNC_FAILED",
      "retryAllowed": true,
      "runtimeEvents": [
        "ARTIFACT_STALE_LOCK_QUARANTINE_DELETED",
        "ARTIFACT_STALE_LOCK_RECOVERY_BLOCKED"
      ]
    },
    "expected": {
      "operationStatus": "FAILED",
      "postPublishCode": "NONE",
      "postPublishStatus": "NOT_APPLICABLE",
      "reasonCode": "ARTIFACT_STALE_LOCK_QUARANTINE_FSYNC_FAILED",
      "retryAllowed": true
    },
    "input": "validated quarantine",
    "operationStatus": "FAILED",
    "postPublishCode": "NONE",
    "postPublishStatus": "NOT_APPLICABLE",
    "reasonCode": "ARTIFACT_STALE_LOCK_QUARANTINE_FSYNC_FAILED",
    "result": "PASS",
    "runtimeEvents": [
      "ARTIFACT_STALE_LOCK_QUARANTINE_DELETED",
      "ARTIFACT_STALE_LOCK_RECOVERY_BLOCKED"
    ],
    "steps": [
      "unlink succeeds",
      "inject directory fsync EIO",
      "audit DELETE_REQUESTED"
    ],
    "testName": "Q14_DELETE_DIRECTORY_FSYNC_FAILURE"
  },
  {
    "actual": {
      "mayReacquire": true,
      "operationStatus": "REUSED_IDENTICAL",
      "postPublishCode": "NONE",
      "postPublishStatus": "COMPLETE",
      "reasonCode": "NONE",
      "recoveryStage": "COMPLETE",
      "runtimeEvents": [
        "ARTIFACT_STALE_LOCK_QUARANTINE_DIRECTORY_SYNCED"
      ]
    },
    "expected": {
      "mayReacquire": true,
      "operationStatus": "REUSED_IDENTICAL",
      "postPublishCode": "NONE",
      "postPublishStatus": "COMPLETE",
      "reasonCode": "NONE",
      "recoveryStage": "COMPLETE"
    },
    "input": "quarantine deleted before prior fsync",
    "operationStatus": "REUSED_IDENTICAL",
    "postPublishCode": "NONE",
    "postPublishStatus": "COMPLETE",
    "reasonCode": "NONE",
    "result": "PASS",
    "runtimeEvents": [
      "ARTIFACT_STALE_LOCK_QUARANTINE_DIRECTORY_SYNCED"
    ],
    "steps": [
      "audit says DELETE_REQUESTED",
      "confirm name absent",
      "dir fsync",
      "mark COMPLETE"
    ],
    "testName": "Q15_INTERRUPTED_CLEANUP_RESUMED"
  },
  {
    "actual": {
      "operationStatus": "FAILED",
      "postPublishCode": "NONE",
      "postPublishStatus": "NOT_APPLICABLE",
      "reasonCode": "ARTIFACT_UNEXPECTED_DIRECTORY_ENTRY",
      "runtimeEvents": [
        "ARTIFACT_STALE_LOCK_RECOVERY_BLOCKED"
      ],
      "untouched": true
    },
    "expected": {
      "operationStatus": "FAILED",
      "postPublishCode": "NONE",
      "postPublishStatus": "NOT_APPLICABLE",
      "reasonCode": "ARTIFACT_UNEXPECTED_DIRECTORY_ENTRY",
      "untouched": true
    },
    "input": "illegal quarantine-like filename",
    "operationStatus": "FAILED",
    "postPublishCode": "NONE",
    "postPublishStatus": "NOT_APPLICABLE",
    "reasonCode": "ARTIFACT_UNEXPECTED_DIRECTORY_ENTRY",
    "result": "PASS",
    "runtimeEvents": [
      "ARTIFACT_STALE_LOCK_RECOVERY_BLOCKED"
    ],
    "steps": [
      "enumerate whitelist",
      "reject without rename/delete"
    ],
    "testName": "Q16_NON_WHITELIST_ENTRY_UNTOUCHED"
  }
]
```
## 6. 实施时的代码边界与验收命令

必须新增/改造的最小范围：D8 authority/mirror一致性与strict Schema/evaluator/audit adapter；T13 statistics adapter；T14移除动态 `generatedAt`；T17 governance record adapter；T18 sourceCommit条件、d8InputSha256、publisher/sidecar/result；T19 tests/orchestrator wiring。不得修改趋势算法、预测公式、数据标签、purge/dedup权威算法、交易参数或Migration 001–007。

最低命令集合（以仓库实际 package scripts 为准）：`node --test src/validation-replay/*.test.js`、scorecard CLI tests、V1.4D PostgreSQL tests、`npm test`、`npm run test:features`、`npm run test:forecast`、`node scripts/verify-v1-4d.mjs --offline-only --lightweight`、`git diff --check`。正式门禁要求独立PostgreSQL真实执行且无意外skip。

## 7. 提交前机器验证结果

本节只记录R3构建会话真实运行，不复用任何旧结论。

- 执行时间：`2026-08-05T12:12:39Z` UTC；验证器退出码`0`。
- 环境：`macOS-15.0.1-arm64-arm-64bit`；Python `3.12.13`；Node `v24.14.0`。
- 工具：python-jsonschema `4.23.0`（Draft 2020-12）、rfc8785 `0.1.4`、Python hashlib SHA-256。
- 协议验证命令：`PYTHONPATH=/tmp/v14d-v8-r2-site V8_TMP=<mktemp> python3 /tmp/v14d_v8_r3_validate.py`；程序`/tmp/v14d_v8_r3_validate.py`；临时输出`/tmp/v14d-v8-r3-validation.4d4s3p`。
- 最终正文检查：`PYTHONPATH=/tmp/v14d-v8-r2-site python3 /tmp/check_v14d_v8_r3_contract.py`；扫描文件`/Users/penn/Documents/Codex/2026-07-24/eth-alpha-v1-4c-f2523794876-bot/V1_4D_FORMAL_RESEARCH_EXECUTION_CONTRACT_V8_FINAL_R3.md`；全文扫描仅排除紧随其后的policy配置块。

<!-- R3_SCAN_POLICY_BEGIN
This delimited configuration block is the only excluded region. Prohibited dependency, deferral, and obsolete commit-semantics patterns:
依赖\s*(?:R2|R1|v6|v7|原v8|V8_REVISED|V8_FINAL); 参照\s*(?:R2|R1|v6|v7|原v8|V8_REVISED|V8_FINAL|上一版|旧版|外部附件); 保持原规则; 沿用旧协议; 由实施者决定; 待未来确认; TODO; TBD; FIXME; PLACEHOLDER; 回读验证成功才是commit point; 完整pair已经可见但尚未commit; directory fsync和回读全部结束后才允许读取者接受; commit point后仍可把artifact改判为FAILED; CP01_PAIR_BEFORE_COMMIT_REJECTED
R3_SCAN_POLICY_END -->

- Schema：9/9 Draft 2020-12加载PASS，全部`$ref`解析PASS；新增Reader Result Schema也实际验证每个CP reader输出。
- D8：合法20/20 PASS；非法3/3 REJECT；一致性7/7；sourceCommit 5/5；治理6/6；D8 binding/mutation 4/4。
- 双独立构造：scorecard SHA `d46d58a62701ebc26ef9c6d1049af1388eeb5701530c05266e14991c7b0fc086` / `d46d58a62701ebc26ef9c6d1049af1388eeb5701530c05266e14991c7b0fc086`；主artifact SHA `2c7a6adab898c076c5367c2a359833f6e68df72317e18f2ca643f6d55ada209f` / `2c7a6adab898c076c5367c2a359833f6e68df72317e18f2ca643f6d55ada209f`；完整bytes均相同；sidecar完整主SHA验证PASS。
- mutation：输入、thresholds、mode、schemaVersion、evaluationVersion及三类D8非决策字段均改变主hash；篡改D8 hash被拒绝。
- D7基础文件状态机本轮重新执行：17/17 PASS，0 FAIL；DRY_RUN formal 0残留、FORMAL治理prewrite 0写入、复用/冲突与中断恢复均PASS。
- R3 commit/reader：14/14 PASS；真实覆盖sidecar-temp未提交、sidecar rename后且post-dir-fsync/回读前reader接受、post fsync ERROR、post回读I/O/Schema/canonical/hash/identity ERROR、重启复用/冲突、precommit rename失败及audit/lock WARNING。
- 陈旧锁隔离回归：16/16 PASS，0 FAIL；32-hex、62字符、16次重试、身份复核、symlink、unlink/dir-fsync恢复均保持。
- T1–T19结构与24字段、禁止旧语义/旧依赖扫描由最终正文检查器实际执行并在本节后续字段记录。
- 最终结构检查实际结果：`R3_TASK_CHECK_RESULT=19/19 PASS; EACH=24/24; EXIT=0`。
- 最终禁止扫描实际结果：`R3_FORBIDDEN_SCAN_RESULT=0 hits / PASS; LOCATIONS=NONE; EXIT=0`。
- 自归一化SHA-256：`FINAL_R3_DOCUMENT_SHA256_ZEROED=23c72a5006482e1212e238d35a9e505abc46ad4c8b98b317adec0d6a3e07305a`；只把本字段值替换为64个0后计算，其他bytes含末尾换行不变。完整文件SHA在交付时另报。
## 8. 最终范围表

### READY_TO_IMPLEMENT

- D8 strict input/output/threshold Schema、唯一权威/镜像一致性、baseline、Wilson、null/zero、reason优先级与20个完整合法向量。
- D7完整主artifact字节确定性、sidecar正式rename唯一commit point、独立reader结果与post-publish ERROR/WARNING、root/path/白名单、32-hex锁与隔离恢复、双temp/rename/fsync、DRY/FORMAL隔离、sourceCommit、d8InputSha256、治理ref及完整主hash。
- T1–T19 编排，包括T13/T14/T16/T18/T19新增实现与测试。

### CONTRACT_REQUIRED

`EMPTY`。工程契约字段、算法、入口边界、失败语义、幂等、恢复与测试均已冻结；实现尚未完成不等于契约缺失。

### REQUIRES_CHAIRMAN_DECISION

- 正式 `researchFrom/researchTo/fixedAsOf`，选择180天推荐窗口或365天稳健性窗口。
- 正式费用、滑点数值与D8 thresholds数值（必须作为签名输入；本文只冻结Schema和运算）。
- 专用数据库/计算/存储资源授权、正式研究启动授权、人工治理签名授权。

这些是商业风险偏好和资源授权，实施者不得代填。未获决定时可实现和测试，但不得执行FORMAL研究。

### DEFERRED

- 180/365天正式研究执行、研究结论、V1.5、生产部署与自动交易：均未授权。
- GMKG扩展感知叙述、更多数据源/指标和新模型：不属于本执行契约；恢复条件是独立冻结范围与新数据版本。

## 9. 最终状态

D8及陈旧锁协议保持冻结；sidecar rename commit边界、独立reader判断与post-publish异常语义已关闭，D7及T1–T19的**契约定义和机器可验证性**已闭环。生产实现仍须按 READY_TO_IMPLEMENT 完成T8/T19验收。本文没有研究成绩，不授权正式研究、部署或交易。
