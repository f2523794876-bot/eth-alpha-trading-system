const DAY_MS = 86400000;
const MAX_HORIZON_MS = 72 * 3600000;

export function parseReplayDays(value) {
  if (value == null) return [];
  const normalized = String(value).trim().toLowerCase();
  const values = normalized === 'both' ? [7, 90] : normalized.split(',').map(part => Number(part.trim()));
  if (!values.length || values.some(days => ![7, 90].includes(days))) {
    throw Object.assign(new Error('--replay-days must be 7, 90, 7,90, or both'), { code: 'INVALID_REPLAY_DAYS' });
  }
  return [...new Set(values)].sort((a, b) => a - b);
}

export function computeReplayWindow({ days, replayTo, nowMs = Date.now() }) {
  if (![7, 90].includes(days)) throw Object.assign(new Error('days must be 7 or 90'), { code: 'INVALID_REPLAY_DAYS' });
  const toMs = replayTo == null ? nowMs - MAX_HORIZON_MS : Date.parse(replayTo);
  if (!Number.isFinite(toMs)) throw Object.assign(new Error('--replay-to must be a valid ISO-8601 timestamp'), { code: 'INVALID_REPLAY_TO' });
  return { fromMs: toMs - days * DAY_MS, toMs };
}
