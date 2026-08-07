// D7 读取者唯一接受协议（V8_FINAL_R3.md §4.8）。
//
// 只观察两个正式路径（research-artifact.json + research-artifact.sha256.json），不读取temp、锁、
// publisher内存、发布意图/完成审计或任何隐藏marker。逐组件O_NOFOLLOW定位，拒绝symlink与路径逃逸。
// 本模块同时供两处复用：(a) artifact-publisher.js步骤10"发布器post-commit独立回读"，
// (b) 未来D8只读展示API的底层数据来源——两处都必须是"重新open正式路径执行同一验证算法"，
// 不得共享候选内存或彼此的读取结果缓存（§4.8.7红线）。
import path from 'node:path';
import { canonicalJson, canonicalSha256 } from '../formal-research/canonical-json.js';
import { SchemaValidationError } from '../formal-research/schema-registry.js';
import { lstatIfExists, readFileNoFollowSymlink } from './artifact-fs-primitives.js';
import { artifactSchemaRegistry as registry, ARTIFACT_SCHEMA_ID, SIDECAR_SCHEMA_ID } from './artifact-schema-registry.js';
import { assertResearchRunIdentity } from './research-run-status.js';

export { ARTIFACT_SCHEMA_ID, SIDECAR_SCHEMA_ID };

export const MAIN_FILE_NAME = 'research-artifact.json';
export const SIDECAR_FILE_NAME = 'research-artifact.sha256.json';
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024; // 防御性上限，非契约字段本身，仅约束读取者自身内存占用

function rejected(readerReasonCode, detail) {
  return Object.freeze({ readerStatus: 'REJECTED', readerReasonCode, detail: detail ?? null, artifact: null, sidecar: null });
}
function accepted(artifact, sidecar) {
  return Object.freeze({ readerStatus: 'ACCEPTED', readerReasonCode: 'NONE', detail: null, artifact, sidecar });
}

// targetDir: `${root}/{mode}/{validationRunId}/{evaluationIdentity}/`——调用方负责按§4.3拼出该路径
// 并确保root本身已通过assertRootDirectoryChainSafe校验；本函数只负责该目录内的pair读取协议本身。
export function readArtifactPair(targetDir) {
  const mainPath = path.join(targetDir, MAIN_FILE_NAME);
  const sidecarPath = path.join(targetDir, SIDECAR_FILE_NAME);

  const mainStatOuter = lstatIfExists(mainPath);
  const sidecarStatOuter = lstatIfExists(sidecarPath);
  if (!mainStatOuter && !sidecarStatOuter) return rejected('ARTIFACT_NOT_FOUND');
  if (!mainStatOuter || !sidecarStatOuter) return rejected('ARTIFACT_PAIR_INCOMPLETE');
  if (mainStatOuter.isSymbolicLink() || sidecarStatOuter.isSymbolicLink()) return rejected('ARTIFACT_READER_IO_FAILED', 'symlink rejected');

  let mainRead, sidecarRead;
  try {
    mainRead = readFileNoFollowSymlink(mainPath, MAX_ARTIFACT_BYTES);
    sidecarRead = readFileNoFollowSymlink(sidecarPath, MAX_ARTIFACT_BYTES);
  } catch {
    return rejected('ARTIFACT_READER_IO_FAILED');
  }

  let mainObj, sidecarObj;
  try {
    mainObj = JSON.parse(mainRead.bytes.toString('utf8'));
    sidecarObj = JSON.parse(sidecarRead.bytes.toString('utf8'));
  } catch {
    return rejected('ARTIFACT_SCHEMA_INVALID', 'invalid JSON');
  }

  try {
    registry.validate(ARTIFACT_SCHEMA_ID, mainObj);
    registry.validate(SIDECAR_SCHEMA_ID, sidecarObj);
  } catch (error) {
    if (error instanceof SchemaValidationError) return rejected('ARTIFACT_SCHEMA_INVALID', error.errors);
    throw error;
  }

  // 主文件RFC8785重编码必须与磁盘bytes逐字节相同（无trailing newline，UTF-8无BOM）。
  const recanonicalized = canonicalJson(mainObj);
  const onDiskText = mainRead.bytes.toString('utf8');
  if (recanonicalized !== onDiskText) return rejected('ARTIFACT_CANONICALIZATION_FAILED');

  const fullMainArtifactSha256 = canonicalSha256(mainObj);
  if (fullMainArtifactSha256 !== sidecarObj.fullMainArtifactSha256) return rejected('ARTIFACT_HASH_MISMATCH');

  const identityChecks = [
    ['validationRunId', mainObj.core?.validationRunId, sidecarObj.validationRunId],
    ['artifactMode', mainObj.artifactMode, sidecarObj.artifactMode],
    ['schemaVersion', mainObj.schemaVersion, sidecarObj.mainArtifactSchemaVersion],
    ['evaluationVersion', mainObj.core?.evaluationVersion, sidecarObj.evaluationVersion]
  ];
  for (const [, a, b] of identityChecks) {
    if (a !== b) return rejected('ARTIFACT_IDENTITY_MISMATCH');
  }

  let runIdentity;
  try { runIdentity = assertResearchRunIdentity(mainObj.core?.runIdentity); }
  catch { return rejected('ARTIFACT_IDENTITY_MISMATCH'); }
  if (runIdentity.validationRunId !== mainObj.core.validationRunId || runIdentity.artifactMode !== mainObj.artifactMode ||
      runIdentity.evaluationVersion !== mainObj.core.evaluationVersion || runIdentity.gitObjectFormat !== mainObj.core.gitObjectFormat ||
      runIdentity.sourceCommit !== mainObj.core.sourceCommit || runIdentity.datasetVersion !== mainObj.core.auditTrail?.datasetVersion ||
      runIdentity.researchFrom !== mainObj.core.researchFrom || runIdentity.researchTo !== mainObj.core.researchTo ||
      runIdentity.fixedAsOf !== mainObj.core.fixedAsOf || runIdentity.thresholdsSha256 !== canonicalSha256(mainObj.core.thresholds)) {
    return rejected('ARTIFACT_IDENTITY_MISMATCH');
  }

  return accepted(Object.freeze(mainObj), Object.freeze(sidecarObj));
}
