import { readFile, writeFile } from 'node:fs/promises';

export const REQUIRED_GROUPS = Object.freeze({
  targeted_postgres: 37,
  complete_v1_4d_postgres: 162,
  authenticity_report_scorecard: 118,
  report_scorecard_rejection_probes: 5,
  backfill_p1_6_regression: 1
});

export const REQUIRED_SCENARIOS = Object.freeze([
  'new_snapshot_insert', 'reused_identical', 'identity_conflict',
  'fresh_zero_blocked', 'fresh_partial_blocked', 'fresh_all_evaluated',
  'report_gate', 'scorecard_gate', 'conflict_aftermath'
]);

function rows(text, columns, label) {
  return text.trim().split(/\r?\n/).filter(Boolean).map((line, index) => {
    const fields = line.split('\t');
    if (fields.length !== columns) throw new Error(`${label} row ${index + 1} has ${fields.length} columns`);
    return fields;
  });
}

export function validateGateResults(groupText, scenarioText) {
  const errors = [];
  const groups = rows(groupText, 5, 'group');
  for (const [name, minimum] of Object.entries(REQUIRED_GROUPS)) {
    const matches = groups.filter(row => row[0] === name);
    if (matches.length !== 1) {
      errors.push(`${name}: expected exactly once, found ${matches.length}`);
      continue;
    }
    const [, ...rawNumbers] = matches[0];
    if (rawNumbers.some(value => !/^\d+$/.test(value))) {
      errors.push(`${name}: malformed statistics`);
      continue;
    }
    const [rc, pass, fail, skip] = rawNumbers.map(Number);
    if (rc !== 0) errors.push(`${name}: rc=${rc}`);
    if (fail !== 0) errors.push(`${name}: fail=${fail}`);
    if (skip !== 0) errors.push(`${name}: skip=${skip}`);
    if (pass < minimum) errors.push(`${name}: pass=${pass}, minimum=${minimum}`);
  }
  for (const row of groups) if (!Object.hasOwn(REQUIRED_GROUPS, row[0])) errors.push(`unexpected group: ${row[0]}`);

  const scenarios = rows(scenarioText, 2, 'scenario');
  for (const name of REQUIRED_SCENARIOS) {
    const matches = scenarios.filter(row => row[0] === name);
    if (matches.length !== 1) errors.push(`${name}: expected exactly once, found ${matches.length}`);
    else if (matches[0][1] !== 'PASS') errors.push(`${name}: result=${matches[0][1]}`);
  }
  for (const row of scenarios) if (!REQUIRED_SCENARIOS.includes(row[0])) errors.push(`unexpected scenario: ${row[0]}`);
  if (errors.length) throw Object.assign(new Error(errors.join('\n')), { code: 'V14D_WORKFLOW_GATE_FAILED', errors });
  return { groups: groups.length, scenarios: scenarios.length };
}

function requirePattern(text, pattern, scenario) {
  if (!pattern.test(text)) throw new Error(`Missing evidence for ${scenario}: ${pattern}`);
}

export async function collectScenarioEvidence(logDirectory, outputPath) {
  const targeted = await readFile(`${logDirectory}/targeted_postgres.tap`, 'utf8');
  const authenticity = await readFile(`${logDirectory}/authenticity_report_scorecard.tap`, 'utf8');
  const probes = await readFile(`${logDirectory}/report-scorecard-rejection-probes.tap`, 'utf8');
  requirePattern(targeted, /INSERTED：完整生成流程/, 'new_snapshot_insert');
  requirePattern(targeted, /AUTHENTICITY_CONFLICT_CALLS[^\n]*"call":1[^\n]*"status":"INSERTED"[^\n]*"call":2[^\n]*"status":"REUSED_IDENTICAL"[^\n]*"call":3[^\n]*"error_code":"REPLAY_SNAPSHOT_IDENTITY_CONFLICT"/, 'identity sequence');
  requirePattern(authenticity, /fresh and resume authenticity matrices distinguish inserts, identical reuse, conflicts and zero recomputation/, 'fresh matrix');
  requirePattern(targeted, /完整非dry-run执行：单个24h节奏点产出replay_snapshots/, 'fresh_all_evaluated');
  requirePattern(probes, /Report rejects FAILED validation run[\s\S]*Report rejects BLOCKED validation run/, 'report_gate');
  requirePattern(probes, /Scorecard rejects FAILED validation run[\s\S]*Scorecard rejects BLOCKED validation run[\s\S]*Scorecard rejects inconsistent authenticity evidence/, 'scorecard_gate');
  requirePattern(targeted, /AUTHENTICITY_CONFLICT_DATABASE[^\n]*"matching_snapshot_count":1[^\n]*"downstream_counts":\{"evaluations":0,"reports":0\}/, 'conflict_aftermath');
  const output = REQUIRED_SCENARIOS.map(name => `${name}\tPASS`).join('\n') + '\n';
  await writeFile(outputPath, output);
  return output;
}

function validGroups() {
  return Object.entries(REQUIRED_GROUPS).map(([name, pass]) => `${name}\t0\t${pass}\t0\t0`).join('\n') + '\n';
}
function validScenarios() { return REQUIRED_SCENARIOS.map(name => `${name}\tPASS`).join('\n') + '\n'; }

export function selfTest() {
  validateGateResults(validGroups(), validScenarios());
  const cases = [
    ['all skip', validGroups().replace('targeted_postgres\t0\t37\t0\t0', 'targeted_postgres\t0\t0\t0\t37'), validScenarios()],
    ['zero pass', validGroups().replace('targeted_postgres\t0\t37\t0\t0', 'targeted_postgres\t0\t0\t0\t0'), validScenarios()],
    ['missing group', validGroups().split('\n').filter(line => !line.startsWith('targeted_postgres\t')).join('\n'), validScenarios()],
    ['duplicate group', validGroups() + 'targeted_postgres\t0\t37\t0\t0\n', validScenarios()],
    ['nonzero fail', validGroups().replace('targeted_postgres\t0\t37\t0\t0', 'targeted_postgres\t0\t37\t1\t0'), validScenarios()],
    ['nonzero rc', validGroups().replace('targeted_postgres\t0\t37\t0\t0', 'targeted_postgres\t1\t37\t0\t0'), validScenarios()],
    ['missing scenario', validGroups(), validScenarios().split('\n').filter(line => !line.startsWith('identity_conflict\t')).join('\n')]
  ];
  for (const [name, groups, scenarios] of cases) {
    let rejected = false;
    try { validateGateResults(groups, scenarios); } catch { rejected = true; }
    if (!rejected) throw new Error(`Gate self-test did not reject: ${name}`);
  }
  return cases.map(([name]) => name);
}

const [mode, first, second] = process.argv.slice(2);
if (mode === '--self-test') console.log(`GATE_SELF_TEST PASS | ${selfTest().join(', ')}`);
else if (mode === '--collect-scenarios') await collectScenarioEvidence(first, second);
else if (mode === '--validate') console.log(JSON.stringify(validateGateResults(await readFile(first, 'utf8'), await readFile(second, 'utf8'))));
else if (import.meta.url === `file://${process.argv[1]}`) throw new Error('Usage: --self-test | --collect-scenarios <log-dir> <output> | --validate <groups.tsv> <scenarios.tsv>');
