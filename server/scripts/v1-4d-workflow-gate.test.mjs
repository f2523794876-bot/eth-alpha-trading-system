import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REQUIRED_GROUPS, REQUIRED_SCENARIOS, collectScenarioEvidence, selfTest, validateGateResults } from './v1-4d-workflow-gate.mjs';

const groups = () => Object.entries(REQUIRED_GROUPS).map(([name, pass]) => `${name}\t0\t${pass}\t0\t0`).join('\n');
const scenarios = () => REQUIRED_SCENARIOS.map(name => `${name}\tPASS`).join('\n');

test('workflow gate accepts the complete verified baseline', () => {
  assert.deepEqual(validateGateResults(groups(), scenarios()), { groups: 5, scenarios: 9 });
});

test('workflow gate self-test rejects skip, empty, missing, duplicate, failure, rc and scenario gaps', () => {
  assert.deepEqual(selfTest(), ['all skip', 'zero pass', 'missing group', 'duplicate group', 'nonzero fail', 'nonzero rc', 'missing scenario']);
});

test('scenario collector requires exact per-scenario test and database diagnostics', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'v1-4d-gate-evidence-'));
  const logs = path.join(root, 'logs');
  await mkdir(logs);
  await writeFile(path.join(logs, 'targeted_postgres.tap'), [
    'ok 1 - INSERTED：完整生成流程',
    'AUTHENTICITY_CONFLICT_CALLS [{"call":1,"status":"INSERTED"},{"call":2,"status":"REUSED_IDENTICAL"},{"call":3,"status":"THREW","error_code":"REPLAY_SNAPSHOT_IDENTITY_CONFLICT"}]',
    'ok 2 - 完整非dry-run执行：单个24h节奏点产出replay_snapshots',
    'AUTHENTICITY_CONFLICT_DATABASE {"matching_snapshot_count":1,"downstream_counts":{"evaluations":0,"reports":0}}'
  ].join('\n'));
  await writeFile(path.join(logs, 'authenticity_report_scorecard.tap'), 'ok 1 - fresh and resume authenticity matrices distinguish inserts, identical reuse, conflicts and zero recomputation\n');
  await writeFile(path.join(logs, 'report-scorecard-rejection-probes.tap'), [
    'ok 1 - Report rejects FAILED validation run',
    'ok 2 - Scorecard rejects FAILED validation run',
    'ok 3 - Report rejects BLOCKED validation run',
    'ok 4 - Scorecard rejects BLOCKED validation run',
    'ok 5 - Scorecard rejects inconsistent authenticity evidence'
  ].join('\n'));
  const output = path.join(root, 'scenarios.tsv');
  await collectScenarioEvidence(logs, output);
  assert.equal(await readFile(output, 'utf8'), `${scenarios()}\n`);
  await writeFile(path.join(logs, 'targeted_postgres.tap'), 'ok 1 - unrelated\n');
  await assert.rejects(collectScenarioEvidence(logs, output), /Missing evidence/);
});
