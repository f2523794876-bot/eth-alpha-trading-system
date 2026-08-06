// T17 — 人工治理确认：机器侧只验证hash/身份，不做任何商业决策（V8_FINAL_R3.md §5 T17）。
//
// 真实的"董事长是否批准"发生在组织治理流程之外（人工签名登记），本模块不实现、不模拟、不
// 提供任何自动批准路径——唯一职责是：给定一份已经存在的治理授权记录（原始JSON，来自只读
// 治理登记处）与本次运行的身份（validationRunId/thresholdsSha256），验证其Schema、scope、
// decision、签署角色，并重算RFC8785 canonical SHA-256，产出可以原样嵌入D7 artifact
// `core.governanceAuthorizationRef`的最小引用对象。DRY_RUN固定返回null，且不允许附带任何记录
// （FORMAL商业授权与DRY_RUN物理/逻辑隔离——DRY_RUN绝不能意外携带一份真实授权记录）。
import { canonicalSha256 } from '../formal-research/canonical-json.js';
import { SchemaValidationError } from '../formal-research/schema-registry.js';
import { artifactSchemaRegistry as registry, GOVERNANCE_SCHEMA_ID } from './artifact-schema-registry.js';

export { GOVERNANCE_SCHEMA_ID };

function fail(code, message) {
  return Object.assign(new Error(message || code), { code });
}

// artifactMode: 'DRY_RUN' | 'FORMAL'
// record: 原始治理授权记录对象（人工登记处只读来源），DRY_RUN必须为null/undefined
// expectedValidationRunId/expectedThresholdsSha256：本次运行自己的身份，不接受记录里声明
// 的、与本次运行不匹配的授权（防止"复用别的run的批准"）。
export function resolveGovernanceAuthorizationRef({ artifactMode, record, expectedValidationRunId, expectedThresholdsSha256 }) {
  if (artifactMode === 'DRY_RUN') {
    if (record !== null && record !== undefined) {
      throw fail('GOVERNANCE_AUTHORIZATION_MISMATCH', 'DRY_RUN must not carry a governance authorization record');
    }
    return null;
  }
  if (artifactMode !== 'FORMAL') {
    throw fail('GOVERNANCE_AUTHORIZATION_INVALID', `unknown artifactMode: ${artifactMode}`);
  }
  if (record === null || record === undefined) {
    throw fail('GOVERNANCE_AUTHORIZATION_MISSING', 'FORMAL requires a governance authorization record');
  }
  try {
    registry.validate(GOVERNANCE_SCHEMA_ID, record);
  } catch (error) {
    if (error instanceof SchemaValidationError) throw fail('GOVERNANCE_AUTHORIZATION_INVALID', 'record failed Schema validation');
    throw error;
  }
  // Schema的const已经保证scope/decision/authorizedByRole/hashAlgorithm/schemaVersion取值合法；
  // 这里额外的等值检查是防御性的——不依赖"Schema以后被弱化"这一假设，机器验证不得只信任一层。
  if (record.authorizationScope !== 'FORMAL_RESEARCH_EXECUTION' || record.decision !== 'APPROVE'
    || record.authorizedByRole !== 'CHAIRMAN' || record.hashAlgorithm !== 'SHA-256') {
    throw fail('GOVERNANCE_AUTHORIZATION_INVALID', 'record scope/decision/role/hashAlgorithm is not an authorizing record');
  }
  if (record.validationRunId !== expectedValidationRunId) {
    throw fail('GOVERNANCE_AUTHORIZATION_MISMATCH', 'record validationRunId does not match this run');
  }
  if (record.thresholdsSha256 !== expectedThresholdsSha256) {
    throw fail('GOVERNANCE_AUTHORIZATION_MISMATCH', "record thresholdsSha256 does not match this run's frozen thresholds");
  }
  return Object.freeze({
    authorizationSchemaVersion: record.schemaVersion,
    recordSha256: canonicalSha256(record),
    hashAlgorithm: 'SHA-256',
    validationRunId: record.validationRunId,
    thresholdsSha256: record.thresholdsSha256,
    authorizationScope: record.authorizationScope,
    decision: record.decision
  });
}

// 验收要求"FORMAL授权PASS且ref可重算"：给定某个已发布/待发布artifact里的ref与其声称来源的
// 原始record，独立重新走一遍resolveGovernanceAuthorizationRef，确认能重算出逐字段相同的ref。
// 不信任ref本身的任何字段——全部从record重新推导后再比较。
export function verifyGovernanceAuthorizationRef(ref, record) {
  if (ref === null || ref === undefined) return record === null || record === undefined;
  const recomputed = resolveGovernanceAuthorizationRef({
    artifactMode: 'FORMAL', record,
    expectedValidationRunId: ref.validationRunId,
    expectedThresholdsSha256: ref.thresholdsSha256
  });
  return recomputed.authorizationSchemaVersion === ref.authorizationSchemaVersion
    && recomputed.recordSha256 === ref.recordSha256
    && recomputed.validationRunId === ref.validationRunId
    && recomputed.thresholdsSha256 === ref.thresholdsSha256
    && recomputed.authorizationScope === ref.authorizationScope
    && recomputed.decision === ref.decision;
}
