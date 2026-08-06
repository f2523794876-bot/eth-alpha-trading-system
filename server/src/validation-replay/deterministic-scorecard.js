// T14 — 确定性Scorecard构建（V8_FINAL_R3.md §5 T14 / §4.1唯一承诺）。
//
// `research-scorecard.js::buildResearchScorecard()`（Batch1既有代码，不修改）在其输出对象中写入
// `generatedAt: new Date().toISOString()`——这是一处wall-clock泄漏：相同输入在不同实际执行时刻
// 调用会产生不同字节，违反§4.1"运行wall-clock只写独立runtime记录，不进入主文件、sidecar或业务
// hash"以及"T14的时间只取validation run冻结的finished_at"的强制要求。
//
// 本模块不修改research-scorecard.js本身（既有代码，禁止修改范围内），而是在其输出之上做一层
// 确定性适配：用调用方传入的、已经冻结在validation_runs.finished_at的时间戳覆盖wall-clock字段，
// 验证覆盖后的对象是RFC8785可canonicalize的纯数据，并提供双构造一致性自检工具函数（供T19/测试用）。
import { canonicalJson, canonicalSha256 } from '../formal-research/canonical-json.js';
import { buildResearchScorecard } from './research-scorecard.js';

function fail(code, message) {
  return Object.assign(new Error(message || code), { code });
}

// inputRows/options：与buildResearchScorecard()签名完全一致，透传不做任何业务逻辑改动。
// validationRunFinishedAt：冻结的run完成时间（ISO8601 UTC字符串），唯一允许的时间来源。
export function buildDeterministicScorecard(inputRows, options, { validationRunFinishedAt }) {
  if (typeof validationRunFinishedAt !== 'string' || !validationRunFinishedAt.endsWith('Z')) {
    throw fail('SCORECARD_SCHEMA_INVALID', 'validationRunFinishedAt must be a canonical UTC ISO8601 string');
  }
  const raw = buildResearchScorecard(inputRows, options);
  // 唯一允许的"改写"：把wall-clock生成时间替换为冻结的run完成时间。不触碰其余任何字段
  // （不重算、不裁剪、不新增业务字段），確保这是纯粹的确定性适配，不是第二套统计实现。
  const deterministic = { ...raw, generatedAt: validationRunFinishedAt };
  // JSON标准语义归一化：JS的`undefined`不是JSON值（例如极端稀疏输入下`buildScope()`某些字段
  // 合法地是undefined）。`JSON.stringify`本身会静默丢弃这类key，这是JS→JSON边界的标准、
  // 广泛采用的语义，不是本模块新发明的规则；`canonicalJson()`比标准JSON.stringify更严格
  // （显式拒绝undefined以防止调用方无意间遗漏字段），因此这里先过一遍标准JSON往返，
  // 使传给canonicalJson()的对象已经是合法JSON值集合，不改变任何"确实有值"的字段。
  let normalized;
  try {
    normalized = JSON.parse(JSON.stringify(deterministic));
  } catch (error) {
    throw fail('SCORECARD_SCHEMA_INVALID', `scorecard is not JSON-serializable: ${error.message}`);
  }
  let canonical;
  try {
    canonical = canonicalJson(normalized);
  } catch (error) {
    throw fail('SCORECARD_SCHEMA_INVALID', `scorecard is not canonicalizable: ${error.message}`);
  }
  return Object.freeze({
    scorecard: Object.freeze(JSON.parse(canonical)),
    canonicalJson: canonical,
    // 与上面canonicalize的对象保持同一来源：canonicalSha256()内部同样调用canonicalJson()，
    // 若仍传入未归一化的deterministic，在degenerate-input（含undefined字段）场景下会与上面
    // 同样的原因再次抛出——必须对normalized取hash，而不是对可能含undefined的deterministic取hash。
    sha256: canonicalSha256(normalized)
  });
}

// 双构造一致性自检（§4.1唯一承诺 + T14验收测试"双构造隔一分钟"要求）：用两次独立调用
// （调用方负责在测试中制造真实的时间间隔/不同wall-clock环境）验证canonical bytes/hash完全相同。
// 本函数只做比较，不重新实现buildDeterministicScorecard的逻辑。
export function assertDeterministicScorecardsMatch(resultA, resultB) {
  if (resultA.canonicalJson !== resultB.canonicalJson) {
    throw fail('SCORECARD_NONDETERMINISTIC', 'two independent constructions produced different canonical bytes');
  }
  if (resultA.sha256 !== resultB.sha256) {
    throw fail('SCORECARD_NONDETERMINISTIC', 'two independent constructions produced different SHA-256');
  }
  return true;
}
