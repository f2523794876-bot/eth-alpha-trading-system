import { spawn } from 'node:child_process';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { computeReplayWindow, parseReplayDays } from './v1-4d-verification-arguments.mjs';
import {
  classifyReplayFailure, deriveVerificationStatus, exitCodeForStatus,
  extractChildErrorCode, redactSensitiveText
} from './v1-4d-verification-contract.mjs';

const FROZEN_REF = 'dc6e573cdbc5aece7b932ab1cbbbe3daa3623437';
const FROZEN_DOCS = Object.freeze([
  'V1_4D_DATA_BACKFILL_SPEC.md',
  'V1_4D_HISTORICAL_REPLAY_SPEC.md',
  'V1_4D_CODEX_IMPLEMENTATION_TASK.md',
  'V1_4D_ACCEPTANCE_TESTS.md',
  'V1_4D_ARCHITECTURE_REVIEW.md'
]);
const argv = process.argv.slice(2);
const valueArg = name => {
  const inline = argv.find(value => value.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};
const hasArg = name => argv.includes(`--${name}`);
const replayDays = parseReplayDays(valueArg('replay-days'));
const replayTo = valueArg('replay-to');
const mode = hasArg('lightweight') ? 'OFFLINE_LIGHTWEIGHT' : 'FULL';
const feeBpsArg = valueArg('fee-bps');
const slippageBpsArg = valueArg('slippage-bps');
const formalCosts = feeBpsArg == null || slippageBpsArg == null ? null : {
  feeBps: Number(feeBpsArg), slippageBps: Number(slippageBpsArg)
};
if (replayTo != null) computeReplayWindow({ days: 7, replayTo });

const startedAt = new Date().toISOString();
const report = {
  schemaVersion: 'v1.4d-verification/3', startedAt, status: 'RUNNING', mode, replayDays, gates: [],
  replays: Object.fromEntries([7, 90].map(days => [String(days), replayDays.includes(days)
    ? { status: 'PENDING' }
    : { status: mode === 'OFFLINE_LIGHTWEIGHT' ? 'OUT_OF_SCOPE' : 'NOT_EVALUABLE', reason: `${days}-day replay was not requested.` }]))
};

async function run(label, command, args, { cwd = process.cwd(), env = {}, required = true } = {}) {
  const gate = { label, command: [command, ...args].join(' '), required, startedAt: new Date().toISOString() };
  report.gates.push(gate);
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  let spawnError = null;
  const exitCode = await new Promise(resolve => {
    let settled = false;
    const finish = value => { if (!settled) { settled = true; resolve(value); } };
    child.once('error', error => { spawnError = error; stderr += `${error.code || 'SPAWN_ERROR'}: ${error.message}\n`; finish(null); });
    child.once('close', finish);
  });
  if (stdout) process.stdout.write(redactSensitiveText(stdout));
  if (stderr) process.stderr.write(redactSensitiveText(stderr));
  const sourceCode = exitCode === 0 ? null : (spawnError?.code || extractChildErrorCode(stdout, stderr));
  const failure = exitCode === 0 ? null : classifyReplayFailure({ code: sourceCode, stderr });
  Object.assign(gate, {
    finishedAt: new Date().toISOString(), exitCode, status: exitCode === 0 ? 'PASS' : 'FAIL',
    sourceCode, classification: failure?.classification ?? null, failureType: failure?.failureType ?? null,
    stdoutTail: redactSensitiveText(stdout.slice(-4000)), stderrTail: redactSensitiveText(stderr.slice(-4000))
  });
  Object.defineProperty(gate, 'fullStdout', { value: stdout, enumerable: false });
  Object.defineProperty(gate, 'fullStderr', { value: stderr, enumerable: false });
  if (exitCode !== 0 && required) {
    throw Object.assign(new Error(sourceCode ? `${label} failed: ${sourceCode}` : `${label} failed with exit code ${exitCode}`), {
      code: sourceCode || 'CHILD_PROCESS_FAILED', gate,
      classification: failure.classification, failureType: failure.failureType,
      verificationStatus: failure.status,
      stderrSummary: redactSensitiveText(stderr.slice(-4000))
    });
  }
  return gate;
}

function replayArgs(days) {
  const required = ['V14D_DATASET_VERSION', 'V14D_ALGORITHM_VERSION', 'V14D_RULE_VERSION', 'V14D_WEIGHT_VERSION', 'V14D_EVALUATION_VERSION'];
  const missing = required.filter(name => !process.env[name]);
  if (!process.env.V14D_REPLAY_DATABASE_URL) missing.push('V14D_REPLAY_DATABASE_URL');
  if (missing.length) throw Object.assign(new Error(`Historical replay requested but configuration is missing: ${missing.join(', ')}`), { code: 'REPLAY_CONFIG_MISSING', missing });
  const { fromMs, toMs } = computeReplayWindow({ days, replayTo });
  return [
    'src/validation-replay/cli-entry.js', '--symbol', process.env.V14D_SYMBOL || 'ETH',
    '--from', new Date(fromMs).toISOString(), '--to', new Date(toMs).toISOString(),
    '--horizons', '24h,72h', '--split', '50/25/25',
    '--algorithm-version', process.env.V14D_ALGORITHM_VERSION,
    '--dataset-version', process.env.V14D_DATASET_VERSION,
    '--rule-version', process.env.V14D_RULE_VERSION,
    '--weight-version', process.env.V14D_WEIGHT_VERSION,
    '--evaluation-version', process.env.V14D_EVALUATION_VERSION,
    '--authenticity-mode', 'fresh'
  ];
}

async function publish(error = null) {
  report.finishedAt = new Date().toISOString();
  report.status = deriveVerificationStatus({ error, gates: report.gates, replays: report.replays, mode });
  report.error = error ? {
    message: redactSensitiveText(error.message), code: error.code || null, missing: error.missing || null,
    classification: error.classification || null, failureType: error.failureType || null,
    stderrSummary: error.stderrSummary || null
  } : null;
  await writeFile('v1-4d-verification-report.json', `${JSON.stringify(report, null, 2)}\n`);
  const markdown = [
    mode === 'OFFLINE_LIGHTWEIGHT' ? '# V1.4D offline/lightweight checks' : '# V1.4D full verification', '',
    `- Mode: **${mode}**`, `- Status: **${report.status}**`, `- Replay days: ${replayDays.length ? replayDays.join(', ') : 'not requested'}`, '',
    '| Gate | Required | Status |', '|---|---:|---|',
    ...report.gates.map(gate => `| ${gate.label} | ${gate.required ? 'yes' : 'no'} | ${gate.status || 'NOT_RUN'} |`),
    '', '## Historical replay status', '',
    '| Window | Status | Validation run | Scorecard |', '|---|---|---|---|',
    ...[7, 90].map(days => {
      const replay = report.replays[String(days)];
      return `| ${days} days | ${replay.status} | ${replay.validationRunId || '—'} | ${replay.scorecardJson || replay.reason || '—'} |`;
    }),
    ...(error ? ['', `- Error: \`${error.message}\``] : [])
  ].join('\n');
  await writeFile('v1-4d-verification-report.md', `${markdown}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  process.exitCode = exitCodeForStatus(report.status);
}

try {
  if (mode === 'FULL' && (!replayDays.includes(7) || !replayDays.includes(90))) {
    throw Object.assign(new Error('Full V1.4D verification requires --replay-days=both'), {
      code: 'FULL_REPLAY_PLAN_REQUIRED', classification: 'CONFIG_MISSING', verificationStatus: 'BLOCKED'
    });
  }
  if (mode === 'FULL' && (feeBpsArg == null || slippageBpsArg == null)) {
    throw Object.assign(new Error('--fee-bps and --slippage-bps are both required for full verification'), {
      code: 'SCORECARD_COST_ASSUMPTIONS_REQUIRED', classification: 'CONFIG_MISSING', verificationStatus: 'BLOCKED'
    });
  }
  if (mode === 'FULL' && (!Number.isFinite(formalCosts.feeBps) || formalCosts.feeBps < 0 || !Number.isFinite(formalCosts.slippageBps) || formalCosts.slippageBps < 0)) {
    throw Object.assign(new Error('--fee-bps and --slippage-bps must be finite non-negative numbers'), {
      code: 'SCORECARD_COST_ASSUMPTIONS_INVALID', classification: 'CONFIG_MISSING', verificationStatus: 'BLOCKED'
    });
  }
  if (mode === 'FULL' && hasArg('offline-only')) {
    throw Object.assign(new Error('--offline-only is valid only with --lightweight; full verification cannot omit PostgreSQL'), {
      code: 'FULL_OFFLINE_MODE_INVALID', classification: 'CONFIG_MISSING', verificationStatus: 'BLOCKED'
    });
  }
  if (mode === 'FULL' && !process.env.TEST_DATABASE_URL) {
    throw Object.assign(new Error('TEST_DATABASE_URL is required for full V1.4D verification'), {
      code: 'POSTGRES_CONFIG_MISSING', classification: 'CONFIG_MISSING', verificationStatus: 'BLOCKED'
    });
  }
  if (mode === 'FULL') for (const days of replayDays) replayArgs(days);
  await run('Patch whitespace', 'git', ['diff', '--check'], { cwd: '..' });
  await run('Frozen draft-4 documents', 'git', ['diff', '--exit-code', FROZEN_REF, '--', ...FROZEN_DOCS], { cwd: '..' });
  await run('Validation replay unit tests', process.execPath, ['--test', ...await (async () => {
    const { readdir } = await import('node:fs/promises');
    return (await readdir('src/validation-replay')).filter(name => name.endsWith('.test.js')).sort().map(name => `src/validation-replay/${name}`);
  })()]);
  await run('Verification bundle CLI tests', process.execPath, ['--test', 'scripts/v1-4d-scorecard-cli.test.mjs']);
  if (hasArg('lightweight')) {
    report.gates.push({ label: 'Server unit tests', required: false, status: 'OUT_OF_SCOPE', reason: 'Offline/lightweight mode; run full verification for complete server regression.' });
  } else {
    await run('Server unit tests', process.execPath, ['--test', ...await (async () => {
      const { readdir } = await import('node:fs/promises');
      const rootTests = (await readdir('tests')).filter(name => name.endsWith('.test.js')).sort().map(name => `tests/${name}`);
      const forecastTests = (await readdir('tests/forecast')).filter(name => name.endsWith('.test.js')).sort().map(name => `tests/forecast/${name}`);
      return [...rootTests, ...forecastTests];
    })()]);
  }
  if (process.env.TEST_DATABASE_URL && !hasArg('offline-only')) {
    await run('PostgreSQL migrations and integration tests', process.execPath, ['scripts/v1-4d-postgres-validation.mjs']);
  } else {
    report.gates.push({
      label: 'PostgreSQL migrations and integration tests', required: !hasArg('offline-only'),
      status: mode === 'OFFLINE_LIGHTWEIGHT' ? 'OUT_OF_SCOPE' : hasArg('offline-only') ? 'NOT_EVALUABLE' : 'BLOCKED',
      reason: 'TEST_DATABASE_URL is not configured'
    });
    if (!hasArg('offline-only')) throw Object.assign(new Error('TEST_DATABASE_URL is required; use --offline-only only for a deliberate local partial check'), { code: 'POSTGRES_CONFIG_MISSING' });
  }
  const replayErrors = [];
  for (const days of replayDays) {
    const replayState = report.replays[String(days)];
    try {
      const replay = await run(`${days}-day historical replay`, process.execPath, replayArgs(days), {
        env: { DATABASE_URL: process.env.V14D_REPLAY_DATABASE_URL }
      });
      const validationRunId = /^validation_run_id\s+(.+)$/m.exec(replay.fullStdout)?.[1]?.trim();
      if (!validationRunId) throw Object.assign(new Error('Replay completed without a machine-readable validation_run_id'), { code: 'VALIDATION_RUN_ID_MISSING' });
      const scorecardJson = `v1-4d-research-scorecard-${days}d.json`;
      const scorecardMarkdown = `v1-4d-research-scorecard-${days}d.md`;
      await run(`${days}-day research scorecard`, process.execPath, [
        'scripts/v1-4d-scorecard-cli.mjs', `--validation-run-id=${validationRunId}`,
        `--evaluation-version=${process.env.V14D_EVALUATION_VERSION}`,
        `--output=${scorecardJson}`, `--markdown-output=${scorecardMarkdown}`,
        `--fee-bps=${formalCosts.feeBps}`, `--slippage-bps=${formalCosts.slippageBps}`,
        `--seed=${valueArg('seed') || 1404}`
      ], { env: { V14D_REPLAY_DATABASE_URL: process.env.V14D_REPLAY_DATABASE_URL } });
      const scorecard = JSON.parse(await readFile(scorecardJson, 'utf8'));
      if (scorecard.status !== 'EVALUATED' || scorecard.horizons?.['24h']?.status !== 'EVALUATED' || scorecard.horizons?.['72h']?.status !== 'EVALUATED') {
        throw Object.assign(new Error(`${days}-day scorecard is not fully evaluable for both 24H and 72H`), { code: 'SCORECARD_NOT_EVALUABLE' });
      }
      Object.assign(replayState, { status: 'EVALUATED', validationRunId, scorecardJson, scorecardMarkdown });
    } catch (error) {
      const failure = error.classification
        ? { classification: error.classification, failureType: error.failureType, status: error.verificationStatus || 'FAIL' }
        : classifyReplayFailure({ code: error.code, stderr: error.stderrSummary || '' });
      Object.assign(replayState, {
        status: failure.status,
        reason: redactSensitiveText(error.message),
        code: error.code || null,
        classification: failure.classification,
        failureType: failure.failureType || null,
        stderrSummary: error.stderrSummary || null
      });
      replayErrors.push({ days, error });
    }
  }
  if (replayErrors.length) {
    const first = replayErrors.find(item => report.replays[String(item.days)].status === 'FAIL')?.error || replayErrors[0].error;
    const firstState = report.replays[String(replayErrors.find(item => item.error === first).days)];
    throw Object.assign(new Error(`Historical replay bundle ${firstState.status === 'FAIL' ? 'failed' : 'blocked'} for ${replayErrors.map(item => `${item.days}d`).join(', ')}: ${first.message}`), {
      code: first.code || 'REPLAY_BLOCKED', missing: first.missing || null,
      classification: firstState.classification, failureType: firstState.failureType,
      verificationStatus: firstState.status,
      stderrSummary: firstState.stderrSummary,
      replayErrors: replayErrors.map(item => ({ days: item.days, message: redactSensitiveText(item.error.message), code: item.error.code || null }))
    });
  }
  await publish();
} catch (error) {
  for (const replay of Object.values(report.replays)) {
    if (replay.status === 'PENDING') Object.assign(replay, {
      status: 'BLOCKED',
      reason: redactSensitiveText(`Not executed because an earlier required step blocked: ${error.message}`),
      code: error.code || null,
      classification: error.classification || null,
      failureType: error.failureType || null
    });
  }
  await publish(error);
}
