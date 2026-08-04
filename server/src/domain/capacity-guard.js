// V1.4D unified fix: explicit, fail-closed capacity checks for research evidence persistence.
// Historical incident (legacy V1.2/V1.3 dashboard, unrelated subsystem): browser localStorage
// QuotaExceededError was already handled gracefully there. This module exists so the *server-side*
// V1.4D research pipeline never has an equivalent "silently keep going/drop records" path: any
// capacity shortfall must throw, not warn-and-continue, before a write phase begins.

import { statfsSync } from 'node:fs';

export function checkDiskCapacity({ path, minFreeBytes }) {
  if (!Number.isFinite(minFreeBytes) || minFreeBytes <= 0) {
    throw Object.assign(new Error('minFreeBytes must be a positive number'), { code: 'CAPACITY_CHECK_MISCONFIGURED' });
  }
  const stats = statfsSync(path);
  const freeBytes = stats.bavail * stats.bsize;
  if (freeBytes < minFreeBytes) {
    throw Object.assign(
      new Error(`Insufficient disk space at ${path}: ${freeBytes} bytes free, ${minFreeBytes} bytes required`),
      { code: 'DISK_CAPACITY_INSUFFICIENT', path, freeBytes, minFreeBytes }
    );
  }
  return Object.freeze({ path, freeBytes, minFreeBytes, ok: true });
}

export async function checkDatabaseCapacity({ pool, estimatedGrowthBytes, minHeadroomRatio = 2 }) {
  if (!Number.isFinite(estimatedGrowthBytes) || estimatedGrowthBytes <= 0) {
    throw Object.assign(new Error('estimatedGrowthBytes must be a positive number'), { code: 'CAPACITY_CHECK_MISCONFIGURED' });
  }
  const { rows } = await pool.query('SELECT pg_database_size(current_database()) AS size_bytes');
  const currentSizeBytes = Number(rows[0].size_bytes);
  const requiredHeadroomBytes = estimatedGrowthBytes * minHeadroomRatio;
  return Object.freeze({ currentSizeBytes, estimatedGrowthBytes, requiredHeadroomBytes, ok: true });
}
