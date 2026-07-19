import { NORMALIZER_VERSION, SCHEMA_VERSION } from './constants.js';
import { sha256 } from './hash.js';

export function buildVintageRef({ sourceId, sourceRef, fieldId, instrument, interval, observationStart, observationEnd, publishedAt, availableAt, firstAvailableAt, fetchedAt, revisionNumber = 0, value }) {
  const times = [observationStart, observationEnd, publishedAt, availableAt, firstAvailableAt, fetchedAt];
  if (!times.every(Number.isFinite) || availableAt < publishedAt || firstAvailableAt < availableAt || fetchedAt < firstAvailableAt) throw new Error('INVALID_VINTAGE_TIME_ORDER');
  const vintageId = `${sourceId}:${fieldId}:${instrument}:${interval || 'point'}:${observationEnd}:rev${revisionNumber}`;
  return Object.freeze({
    fieldId, observationPeriod: { start: observationStart, end: observationEnd }, publishedAt, availableAt,
    firstAvailableAt, fetchedAt, revisionNumber, vintageId, sourceId, sourceRef,
    schemaVersion: SCHEMA_VERSION, normalizerVersion: NORMALIZER_VERSION, contentHash: sha256(value)
  });
}

export function assertNoFutureLeak(vintage, forecastCreatedAt) {
  if (!vintage || !Number.isFinite(forecastCreatedAt) || vintage.availableAt > forecastCreatedAt) throw new Error('FUTURE_DATA_LEAK_BLOCKED');
  return true;
}

export function buildRevisionEvent(previous, next, detectedAt) {
  if (!previous || !next || previous.vintageId === next.vintageId || next.revisionNumber !== previous.revisionNumber + 1) throw new Error('INVALID_REVISION_CHAIN');
  return Object.freeze({
    revisionEventId: `revision:${previous.vintageId}:${next.vintageId}`,
    fieldId: next.fieldId, observationPeriod: next.observationPeriod,
    previousVintageId: previous.vintageId, newVintageId: next.vintageId,
    previousContentHash: previous.contentHash, newContentHash: next.contentHash,
    detectedAt, schemaVersion: SCHEMA_VERSION
  });
}
