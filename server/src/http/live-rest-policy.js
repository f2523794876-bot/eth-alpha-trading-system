import { isExternalRegionBlocked } from './client.js';

export const LIVE_REST_STATUS = Object.freeze({
  PASSED: 'PASS',
  REGION_BLOCKED: 'EXTERNAL_REGION_BLOCKED',
  FAILED: 'FAIL'
});

export async function runLiveRestOperation(operation, onRegionBlocked = () => {}) {
  try {
    await operation();
    return LIVE_REST_STATUS.PASSED;
  } catch (error) {
    if (!isExternalRegionBlocked(error)) throw error;
    onRegionBlocked(error);
    return LIVE_REST_STATUS.REGION_BLOCKED;
  }
}

export function summarizeLiveRestResults(results, expectedTotal = results.length) {
  const counts = { passed: 0, externalRegionBlocked: 0, failed: 0 };
  for (const status of results) {
    if (status === LIVE_REST_STATUS.PASSED) counts.passed += 1;
    else if (status === LIVE_REST_STATUS.REGION_BLOCKED) counts.externalRegionBlocked += 1;
    else counts.failed += 1;
  }
  const missing = Math.max(0, expectedTotal - results.length);
  counts.failed += missing;
  const status = counts.failed ? LIVE_REST_STATUS.FAILED
    : counts.externalRegionBlocked ? LIVE_REST_STATUS.REGION_BLOCKED
      : LIVE_REST_STATUS.PASSED;
  return Object.freeze({ status, total: expectedTotal, observed: results.length, missing, ...counts });
}
