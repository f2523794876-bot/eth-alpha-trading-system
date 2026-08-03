import { FEATURE_BAR_DEPENDENCIES } from '../features/feature-engine.js';

export const MANIFEST_CONTRACT_VERSION = 2;
export const MANIFEST_SCHEMA_VERSION = 'v1.4d-manifest-schema-2';
export const MANIFEST_DATASET_TYPE = 'MARKET_BARS';
export const MANIFEST_SOURCE = 'binance-spot';
export const MANIFEST_SOURCE_ID = 'binance-spot-rest';
export const MANIFEST_MARKET_TYPE = 'spot';

const DEPENDENCY_FIELDS = Object.freeze(['symbol', 'interval', 'marketType', 'source']);
const MEMBER_FIELDS = Object.freeze(['symbol', 'intervalName', 'marketType', 'source', 'openTime', 'closeTime', 'revisionNumber', 'vintageId', 'rowContentHash']);
const symbolPattern = /^[A-Z0-9]+$/;

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const dependencyKey = value => `${value.symbol}\0${value.interval}\0${value.marketType}\0${value.source}`;

function fail(code, message, detail = {}) {
  throw Object.assign(new Error(message), { code, ...detail });
}

function assertExactObject(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('MANIFEST_CONTRACT_INVALID', `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('MANIFEST_CONTRACT_UNKNOWN_FIELD', `${label} fields do not match the frozen contract`, { actual, expected });
}

function assertSymbol(symbol, label = 'symbol') {
  if (typeof symbol !== 'string' || !symbolPattern.test(symbol) || symbol !== symbol.toUpperCase()) {
    fail('MANIFEST_SYMBOL_INVALID', `${label} must be an uppercase alphanumeric string`, { symbol });
  }
}

export function authoritativeDependencySet() {
  return normalizeDependencySet(FEATURE_BAR_DEPENDENCIES.map(({ symbol, interval, marketType }) => ({
    symbol, interval, marketType, source: MANIFEST_SOURCE
  }))).dependencySet;
}

export function normalizeDependencySet(input) {
  if (!Array.isArray(input) || !input.length) fail('DATASET_MANIFEST_DEPENDENCY_INCOMPLETE', 'dependencySet must be a non-empty array');
  const byKey = new Map();
  for (const dependency of input) {
    assertExactObject(dependency, DEPENDENCY_FIELDS, 'dependency');
    assertSymbol(dependency.symbol, 'dependency.symbol');
    for (const field of ['interval', 'marketType', 'source']) if (typeof dependency[field] !== 'string' || !dependency[field]) fail('MANIFEST_CONTRACT_INVALID', `dependency.${field} must be a non-empty string`);
    byKey.set(dependencyKey(dependency), Object.freeze({ ...dependency }));
  }
  const dependencySet = [...byKey.values()].sort((a, b) =>
    compare(a.symbol, b.symbol) || compare(a.interval, b.interval) || compare(a.marketType, b.marketType) || compare(a.source, b.source));
  return Object.freeze({ dependencySet: Object.freeze(dependencySet), duplicatesRemoved: input.length - dependencySet.length });
}

export function symbolsFromDependencies(dependencySet) {
  const symbols = [...new Set(dependencySet.map(value => value.symbol))].sort(compare);
  for (const symbol of symbols) assertSymbol(symbol);
  return Object.freeze(symbols);
}

export function assertAuthoritativeDependencySet(input) {
  const normalized = normalizeDependencySet(input);
  const expected = authoritativeDependencySet();
  if (JSON.stringify(normalized.dependencySet) !== JSON.stringify(expected)) {
    const expectedKeys = new Set(expected.map(dependencyKey));
    const actualKeys = new Set(normalized.dependencySet.map(dependencyKey));
    fail('DATASET_MANIFEST_DEPENDENCY_UNGOVERNED', 'dependencySet must exactly equal FEATURE_BAR_DEPENDENCIES', {
      missingDependencies: expected.filter(value => !actualKeys.has(dependencyKey(value))),
      unexpectedDependencies: normalized.dependencySet.filter(value => !expectedKeys.has(dependencyKey(value)))
    });
  }
  return normalized;
}

export function normalizeV2Member(member) {
  assertExactObject(member, MEMBER_FIELDS, 'manifest member');
  assertSymbol(member.symbol, 'member.symbol');
  for (const field of ['intervalName', 'marketType', 'source', 'vintageId', 'rowContentHash']) if (typeof member[field] !== 'string' || !member[field]) fail('DATASET_MANIFEST_MEMBER_IDENTITY_MISSING', `member.${field} is required`);
  for (const field of ['openTime', 'closeTime', 'revisionNumber']) if (!Number.isSafeInteger(member[field]) || member[field] < 0) fail('DATASET_MANIFEST_MEMBER_IDENTITY_MISSING', `member.${field} must be a non-negative safe integer`);
  if (member.openTime >= member.closeTime) fail('DATASET_MANIFEST_MEMBER_IDENTITY_MISSING', 'member.openTime must precede member.closeTime');
  if (!/^[0-9a-f]{64}$/.test(member.rowContentHash)) fail('DATASET_MANIFEST_MEMBER_IDENTITY_MISSING', 'member.rowContentHash must be a complete SHA-256 digest');
  return Object.freeze({ ...member });
}

export function sortV2Members(members) {
  const seen = new Map();
  const normalized = [];
  for (const raw of members) {
    const member = normalizeV2Member(raw);
    const previous = seen.get(member.vintageId);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(member)) {
        fail('DATASET_MANIFEST_MEMBER_IDENTITY_MISSING', 'duplicate vintageId has conflicting identity', { vintageId: member.vintageId });
      }
      continue;
    }
    seen.set(member.vintageId, member);
    normalized.push(member);
  }
  return Object.freeze(normalized.sort((a, b) => compare(a.symbol, b.symbol) || compare(a.intervalName, b.intervalName) ||
    compare(a.marketType, b.marketType) || compare(a.source, b.source) || a.openTime - b.openTime ||
    a.revisionNumber - b.revisionNumber || compare(a.vintageId, b.vintageId)));
}

export function dependencyLabel(dependency) {
  return `${dependency.symbol}:${dependency.interval}`;
}
