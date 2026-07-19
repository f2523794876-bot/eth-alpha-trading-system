export async function measureServerTime(adapter, { now = Date.now, maxClockOffsetMs = 5000 } = {}) {
  const localRequestStartedAt = now();
  try {
    const response = await adapter.serverTime();
    const localResponseReceivedAt = now();
    const sourceServerTime = response.body?.serverTime;
    if (!Number.isSafeInteger(sourceServerTime)) return { ok: false, health: 'BLOCKED', reason: 'SERVER_TIME_INVALID', localRequestStartedAt, localResponseReceivedAt };
    const estimatedNetworkMidpoint = Math.floor((localRequestStartedAt + localResponseReceivedAt) / 2);
    const clockOffsetMs = sourceServerTime - estimatedNetworkMidpoint;
    const roundTripMs = localResponseReceivedAt - localRequestStartedAt;
    const ok = Math.abs(clockOffsetMs) <= maxClockOffsetMs;
    return { ok, health: ok ? 'HEALTHY' : 'BLOCKED', reason: ok ? null : 'CLOCK_OFFSET_EXCEEDED', sourceServerTime, localRequestStartedAt, localResponseReceivedAt, estimatedNetworkMidpoint, clockOffsetMs, roundTripMs, requestId: response.requestId };
  } catch (error) {
    const localResponseReceivedAt = now();
    return { ok: false, health: 'BLOCKED', reason: 'SERVER_TIME_UNAVAILABLE', errorCode: error.code || 'UNKNOWN', localRequestStartedAt, localResponseReceivedAt, roundTripMs: localResponseReceivedAt - localRequestStartedAt };
  }
}
