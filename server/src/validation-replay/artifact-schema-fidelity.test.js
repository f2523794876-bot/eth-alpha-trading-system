// D7六个Schema文件（formal-artifact/sidecar/lock/publish-result/governance-authorization/
// reader-result）与冻结契约V8_FINAL_R3.md §4.11-4.16原文的canonical字节级一致性——
// 与go-no-go-evaluator.test.js对D8 Schema的同款校验同一模式：向量/Schema从Markdown原文
// 用正则+$id提取，不是手工复制的第二份权威源。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonicalJson } from '../formal-research/canonical-json.js';
import { rawSchemas } from './artifact-schema-registry.js';

const CONTRACT_TEXT = readFileSync(new URL('../../../V1_4D_FORMAL_RESEARCH_EXECUTION_CONTRACT_V8_FINAL_R3.md', import.meta.url), 'utf8');

function contractSchema(schemaId) {
  const blocks = [...CONTRACT_TEXT.matchAll(/```json\n([\s\S]*?)\n```/g)];
  const matches = blocks
    .map(match => { try { return JSON.parse(match[1]); } catch { return null; } })
    .filter(value => value && typeof value === 'object' && !Array.isArray(value) && value.$id === schemaId);
  assert.equal(matches.length, 1, `expected exactly one frozen Schema block for ${schemaId}`);
  return matches[0];
}

const CASES = [
  ['artifact', 'https://eth-alpha.invalid/schema/v1.4d-formal-artifact-2.json'],
  ['sidecar', 'https://eth-alpha.invalid/schema/v1.4d-artifact-sidecar-1.json'],
  ['lock', 'https://eth-alpha.invalid/schema/v1.4d-artifact-lock-2.json'],
  ['publishResult', 'https://eth-alpha.invalid/schema/v1.4d-artifact-publish-result-4.json'],
  ['governance', 'https://eth-alpha.invalid/schema/v1.4d-governance-authorization-1.json'],
  ['readerResult', 'https://eth-alpha.invalid/schema/v1.4d-artifact-reader-result-1.json']
];

for (const [key, schemaId] of CASES) {
  test(`D7 Schema文件 ${key} 是冻结契约对应block的canonical-semantic副本`, () => {
    assert.equal(canonicalJson(rawSchemas[key]), canonicalJson(contractSchema(schemaId)));
  });
}
