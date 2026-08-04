export const TREND = Object.freeze({
  UP: 'UP',
  DOWN: 'DOWN',
  RANGE: 'RANGE'
});

export const TREND_VALUES = Object.freeze(Object.values(TREND));

export function isCanonicalTrend(value) {
  return TREND_VALUES.includes(value);
}

export function canonicalTrendOrNull(value) {
  return isCanonicalTrend(value) ? value : null;
}
