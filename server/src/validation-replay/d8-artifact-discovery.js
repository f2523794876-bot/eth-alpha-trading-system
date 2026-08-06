// "最新已发布FORMAL结果在哪个目录"——冻结契约§4未定义任何latest/index机制（契约只定义
// `{root}/{formal|dry-run}/{validationRunId}/{evaluationIdentity}/`这一层确定性寻址，不定义
// "给定root，哪一个validationRunId是当前应该展示的最新正式结果"）。这是本轮为满足D8展示前端
// 需求而做的最小增补设计，不修改、不重新解释契约本身的目录/命名规则，只是在其之上增加一个
// 只读发现层。见最终报告"冻结契约之外的增补点"。
//
// 选择依据：不读取任何文件内容做排序（避免"为了排序而信任未经验证的数据"），只用sidecar
// 文件的rename mtime（= §4.6步骤8唯一commit point发生的时刻，文件系统层面可观察、不可被
// 业务内容伪造）作为发布先后的排序依据——挑出mtime最大的一个目录，只对这一个目录跑完整
// artifact-reader.js协议。如果这个"最新"目录读取失败（hash/Schema/路径任一失败），直接
// 报告FAILED，绝不静默回退去用更早、可能是"更旧但凑巧仍合法"的目录掩盖损坏（对称于前端侧
// "不得静默复用陈旧成功数据"的原则）。
import fs from 'node:fs';
import path from 'node:path';
import { SIDECAR_FILE_NAME } from './artifact-reader.js';

function listDirs(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
  } catch {
    return [];
  }
}

export function findLatestFormalArtifactDir(root) {
  const formalRoot = path.join(root, 'formal');
  let best = null;
  for (const runId of listDirs(formalRoot)) {
    const runPath = path.join(formalRoot, runId);
    for (const evaluationIdentity of listDirs(runPath)) {
      const leaf = path.join(runPath, evaluationIdentity);
      const sidecarPath = path.join(leaf, SIDECAR_FILE_NAME);
      let stat;
      try {
        stat = fs.lstatSync(sidecarPath);
      } catch {
        continue; // 还没有sidecar（未commit/进行中）：不是候选
      }
      if (stat.isSymbolicLink()) continue; // 防御：不追踪符号链接排序依据
      if (!best || stat.mtimeMs > best.mtimeMs) best = { dir: leaf, mtimeMs: stat.mtimeMs };
    }
  }
  return best ? best.dir : null;
}
