// D7相关五个Schema（artifact/sidecar/lock/publish-result/governance-authorization）的共享注册表。
// reader与publisher必须复用同一个registry实例/同一套编译结果，不得各自重复编译（避免行为分歧）。
import { Draft202012SchemaRegistry, loadJsonSchema } from '../formal-research/schema-registry.js';

const ARTIFACT_SCHEMA_URL = new URL('./schemas/v1-4d-formal-artifact.schema.json', import.meta.url);
const SIDECAR_SCHEMA_URL = new URL('./schemas/v1-4d-artifact-sidecar.schema.json', import.meta.url);
const LOCK_SCHEMA_URL = new URL('./schemas/v1-4d-artifact-lock.schema.json', import.meta.url);
const PUBLISH_RESULT_SCHEMA_URL = new URL('./schemas/v1-4d-artifact-publish-result.schema.json', import.meta.url);
const GOVERNANCE_SCHEMA_URL = new URL('./schemas/v1-4d-governance-authorization.schema.json', import.meta.url);
const READER_RESULT_SCHEMA_URL = new URL('./schemas/v1-4d-artifact-reader-result.schema.json', import.meta.url);

export const ARTIFACT_SCHEMA_ID = 'https://eth-alpha.invalid/schema/v1.4d-formal-artifact-2.json';
export const SIDECAR_SCHEMA_ID = 'https://eth-alpha.invalid/schema/v1.4d-artifact-sidecar-1.json';
export const LOCK_SCHEMA_ID = 'https://eth-alpha.invalid/schema/v1.4d-artifact-lock-2.json';
export const PUBLISH_RESULT_SCHEMA_ID = 'https://eth-alpha.invalid/schema/v1.4d-artifact-publish-result-4.json';
export const GOVERNANCE_SCHEMA_ID = 'https://eth-alpha.invalid/schema/v1.4d-governance-authorization-1.json';
export const READER_RESULT_SCHEMA_ID = 'https://eth-alpha.invalid/schema/v1.4d-artifact-reader-result-1.json';
export const RUN_IDENTITY_SCHEMA_ID = 'https://eth-alpha.invalid/schema/v1.4d-research-run-identity-1.json';

// §2.5 implementation binding.  The raw artifact schema below remains the
// byte-faithful frozen-contract copy used by fidelity verification.  Reader and
// writer compile this strict extension so legacy artifacts without the full
// identity fail closed while no frozen Markdown or frozen schema fixture is
// rewritten.
const runIdentitySchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema', $id: RUN_IDENTITY_SCHEMA_ID,
  type: 'object', additionalProperties: false,
  properties: {
    validationRunId: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' },
    artifactMode: { enum: ['FORMAL', 'DRY_RUN'] },
    configSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    thresholdsSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    gitObjectFormat: { enum: ['SHA1', 'SHA256'] },
    sourceIdentity: { type: 'string', minLength: 1, maxLength: 128 },
    sourceVersion: { type: 'string', minLength: 1, maxLength: 128 },
    sourceCommit: { type: 'string', pattern: '^(?:[0-9a-f]{40}|[0-9a-f]{64})$' },
    datasetVersion: { type: 'string', pattern: '^v1\\.4d-sha256-[0-9a-f]{64}$' },
    featureEngineVersion: { type: 'string', minLength: 1, maxLength: 128 },
    algorithmVersion: { type: 'string', minLength: 1, maxLength: 128 },
    ruleVersion: { type: 'string', minLength: 1, maxLength: 128 },
    evaluationVersion: { type: 'string', minLength: 1, maxLength: 128 },
    weightVersion: { type: 'string', minLength: 1, maxLength: 128 },
    horizons: { type: 'array', prefixItems: [{ const: '24h' }, { const: '72h' }], items: false, minItems: 2, maxItems: 2 },
    researchFrom: { type: 'string', format: 'date-time', pattern: 'Z$' },
    researchTo: { type: 'string', format: 'date-time', pattern: 'Z$' },
    fixedAsOf: { type: 'string', format: 'date-time', pattern: 'Z$' },
    runIdentitySha256: { type: 'string', pattern: '^[0-9a-f]{64}$' }
  },
  required: ['validationRunId', 'artifactMode', 'configSha256', 'thresholdsSha256', 'gitObjectFormat', 'sourceIdentity', 'sourceVersion', 'sourceCommit',
    'datasetVersion', 'featureEngineVersion', 'algorithmVersion', 'ruleVersion', 'evaluationVersion', 'weightVersion',
    'horizons', 'researchFrom', 'researchTo', 'fixedAsOf', 'runIdentitySha256']
};

const artifactSchema = loadJsonSchema(ARTIFACT_SCHEMA_URL);
const sidecarSchema = loadJsonSchema(SIDECAR_SCHEMA_URL);
const lockSchema = loadJsonSchema(LOCK_SCHEMA_URL);
const publishResultSchema = loadJsonSchema(PUBLISH_RESULT_SCHEMA_URL);
const governanceSchema = loadJsonSchema(GOVERNANCE_SCHEMA_URL);
const readerResultSchema = loadJsonSchema(READER_RESULT_SCHEMA_URL);

// 私有编译副本：契约的`if/then`条件分支（如artifactMode=FORMAL时core.auditTrail的强制值、
// gitObjectFormat=SHA1/SHA256时sourceCommit的长度）大量依赖"外层properties已声明类型，then分支
// 只补充额外约束"的写法——Ajv `strict:true`的strictTypes检查要求每个含`properties`/`pattern`等
// 关键字的子schema都有本地显式`type`，否则拒绝编译。这与go-no-go-evaluator.js对D8 input schema
// `sampleCount`的处理是同一类问题、同一处理原则：只把外层已经保证成立的类型（object/string/…）
// 补充标注到子schema本地，不新增、不放宽任何约束——递归遍历全部`$defs`/`properties`/`allOf.then`，
// 对缺失type但能从`properties`/`pattern`/`format`/`items`/`minimum`等关键字唯一推断出类型的节点
// 补齐`type`。交付给读取者/发布器以外任何用途的Schema文件本身（如通过canonical-JSON与冻结契约
// 比对的fidelity测试）继续使用未经此函数处理的原始版本，两者语义等价已由本文件下方
// `assertPatchIsSemanticallyRedundant`级别的测试覆盖（见artifact-schema-fidelity.test.js）。
function inferMissingType(node) {
  if (node.type || node.const !== undefined || node.enum || node.$ref) return null;
  if (node.properties) return 'object';
  if (node.pattern !== undefined || node.minLength !== undefined || node.maxLength !== undefined || node.format !== undefined) return 'string';
  if (node.items !== undefined) return 'array';
  if (node.minimum !== undefined || node.maximum !== undefined) return 'number';
  return null;
}
function patchConditionalBranch(node) {
  if (!node || typeof node !== 'object') return;
  const inferred = inferMissingType(node);
  if (inferred) node.type = inferred;
  if (node.properties) for (const key of Object.keys(node.properties)) patchConditionalBranch(node.properties[key]);
  if (node.items) patchConditionalBranch(node.items);
}
function patchAllConditionalBranches(schema) {
  const clone = structuredClone(schema);
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.allOf)) for (const clause of node.allOf) patchConditionalBranch(clause.then);
    if (node.$defs) for (const key of Object.keys(node.$defs)) visit(node.$defs[key]);
    if (node.properties) for (const key of Object.keys(node.properties)) visit(node.properties[key]);
  };
  visit(clone);
  return clone;
}

function extendArtifactWithCompleteRunIdentity(schema) {
  const clone = structuredClone(schema);
  clone.$defs.artifactCore.properties.runIdentity = { $ref: RUN_IDENTITY_SCHEMA_ID };
  clone.$defs.artifactCore.required.push('runIdentity');
  return clone;
}

const compilableArtifactSchema = patchAllConditionalBranches(extendArtifactWithCompleteRunIdentity(artifactSchema));
const compilablePublishResultSchema = patchAllConditionalBranches(publishResultSchema);
const compilableReaderResultSchema = patchAllConditionalBranches(readerResultSchema);

export const artifactSchemaRegistry = new Draft202012SchemaRegistry({
  schemas: [runIdentitySchema, compilableArtifactSchema, sidecarSchema, lockSchema, compilablePublishResultSchema, governanceSchema, compilableReaderResultSchema]
});

// 未经strictTypes补丁的原始byte-faithful版本，供fidelity测试与冻结契约canonical字节比对。
export const rawSchemas = Object.freeze({
  artifact: artifactSchema, sidecar: sidecarSchema, lock: lockSchema,
  publishResult: publishResultSchema, governance: governanceSchema, readerResult: readerResultSchema
});
