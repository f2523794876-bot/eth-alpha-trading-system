const EXIT_CODES = Object.freeze({ PASS: 0, FAIL: 1, NOT_EVALUABLE: 2, BLOCKED: 3 });

const CONFIG_CODES = new Set([
  'REPLAY_CONFIG_MISSING', 'POSTGRES_CONFIG_MISSING', 'FULL_REPLAY_PLAN_REQUIRED',
  'FULL_OFFLINE_MODE_INVALID',
  'DATABASE_URL_REQUIRED', 'MISSING_REQUIRED_ARG', 'MISSING_REQUIRED_PARAM'
]);

const DATA_NOT_READY_CODES = new Set([
  'DATASET_MANIFEST_NOT_FOUND', 'DATASET_MANIFEST_INVALID', 'DATASET_MANIFEST_MISMATCH',
  'MANIFEST_VERIFICATION_FAILED', 'SCORECARD_NOT_EVALUABLE', 'VALIDATION_RUN_ID_MISSING'
]);

export function exitCodeForStatus(status) {
  if (!(status in EXIT_CODES)) throw new TypeError(`Unknown verification status: ${status}`);
  return EXIT_CODES[status];
}

export function redactSensitiveText(value) {
  return String(value ?? '')
    .replace(/\b(postgres(?:ql)?:\/\/)[^\s'"`]+/gi, '$1[REDACTED]')
    .replace(/\b(password|pass|pwd|user|username|token)\s*[=:]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/\b(TEST_DATABASE_URL|V14D_REPLAY_DATABASE_URL|DATABASE_URL)\s*[=:]\s*[^\s]+/g, '$1=[REDACTED]');
}

export function extractChildErrorCode(stdout, stderr) {
  const combined = `${stdout ?? ''}\n${stderr ?? ''}`;
  const patterns = [
    /["']code["']\s*:\s*["']([A-Z0-9][A-Z0-9_]+)["']/,
    /\bcode\s*:\s*["']?([A-Z0-9][A-Z0-9_]+)["']?/,
    /\berrorCode\s*[:=]\s*["']?([A-Z0-9][A-Z0-9_]+)["']?/
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(combined);
    if (match) return match[1];
  }
  return null;
}

export function classifyReplayFailure({ code, stderr = '', spawnCode = null }) {
  const normalizedCode = code || spawnCode || null;
  if (CONFIG_CODES.has(normalizedCode)) return { classification: 'CONFIG_MISSING', status: 'BLOCKED' };
  if (DATA_NOT_READY_CODES.has(normalizedCode) || /^DATASET_MANIFEST_/.test(normalizedCode || '')) {
    return { classification: 'DATA_NOT_READY', status: 'BLOCKED' };
  }
  if (
    /ECONNREFUSED|ENOTFOUND|connection\s+(?:refused|terminated|failed)|database\s+.*(?:unavailable|does not exist)/i.test(stderr) ||
    /^08[A-Z0-9]{3}$/.test(normalizedCode || '') ||
    ['3D000', '28000', '28P01', 'ECONNREFUSED', 'ENOTFOUND', 'DATABASE_UNAVAILABLE', 'DATABASE_CONNECTION_FAILED'].includes(normalizedCode)
  ) {
    return { classification: 'EXECUTION_FAILURE', failureType: 'DATABASE_CONNECTION_FAILURE', status: 'FAIL' };
  }
  return { classification: 'EXECUTION_FAILURE', failureType: 'CHILD_PROCESS_FAILURE', status: 'FAIL' };
}

export function deriveVerificationStatus({ error = null, gates = [], replays = {}, mode = 'FULL' }) {
  if (error) {
    if (error.verificationStatus) return error.verificationStatus;
    return classifyReplayFailure({ code: error.code, stderr: error.stderrSummary || '' }).status;
  }
  const statuses = [
    ...gates.filter(gate => gate.required !== false).map(gate => gate.status),
    ...Object.values(replays).map(replay => replay.status)
  ];
  if (statuses.includes('FAIL')) return 'FAIL';
  if (statuses.includes('BLOCKED')) return 'BLOCKED';
  if (statuses.includes('NOT_EVALUABLE')) return 'NOT_EVALUABLE';
  if (mode === 'OFFLINE_LIGHTWEIGHT') {
    return statuses.length > 0 && statuses.every(status => status === 'PASS' || status === 'OUT_OF_SCOPE') ? 'PASS' : 'NOT_EVALUABLE';
  }
  return statuses.length > 0 && statuses.every(status => status === 'PASS' || status === 'EVALUATED') ? 'PASS' : 'NOT_EVALUABLE';
}
