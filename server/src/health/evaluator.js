export function evaluateHealth(input, now = Date.now()) {
  const reasons = [];
  if (input.serverTimeAvailable === false) reasons.push('SERVER_TIME_UNAVAILABLE');
  if (Number.isFinite(input.clockOffsetMs) && Math.abs(input.clockOffsetMs) > input.maxClockOffsetMs) reasons.push('CLOCK_OFFSET_EXCEEDED');
  if ((input.unresolvedGapCount || 0) > 0) reasons.push('UNRESOLVED_GAPS');
  if ((input.consecutiveFailures || 0) >= 5) reasons.push('CONSECUTIVE_FAILURES');
  if (input.latestSuccessAt && input.expectedFrequencyMs && now - input.latestSuccessAt > input.expectedFrequencyMs * 3) reasons.push('STALE_DATA');
  if (input.circuitOpen) reasons.push('CIRCUIT_OPEN');
  let state = 'HEALTHY';
  if (reasons.includes('SERVER_TIME_UNAVAILABLE') || reasons.includes('CLOCK_OFFSET_EXCEEDED')) state = 'BLOCKED';
  else if (reasons.includes('CONSECUTIVE_FAILURES') || reasons.includes('STALE_DATA')) state = 'DEGRADED';
  else if (reasons.length) state = input.recovering ? 'RECOVERING' : 'WARNING';
  return Object.freeze({ state, reasons, evaluatedAt: now, ...input });
}
