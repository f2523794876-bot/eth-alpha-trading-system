import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalJson, canonicalSha256 } from '../formal-research/canonical-json.js';
import { Draft202012SchemaRegistry, loadJsonSchema, SchemaValidationError } from '../formal-research/schema-registry.js';
import { validateEffectiveOptions } from './cli-entry.js';

const THRESHOLDS_SCHEMA_URL = new URL('../formal-research/schemas/v1-4d-thresholds.schema.json', import.meta.url);
const RUN_CONFIG_SCHEMA_URL = new URL('../formal-research/schemas/v1-4d-formal-run-config.schema.json', import.meta.url);
const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const FORMAL_RUN_CONFIG_SCHEMA_ID = 'https://eth-alpha.invalid/schema/v1.4d-formal-run-config-1.json';

const thresholdsSchema = loadJsonSchema(THRESHOLDS_SCHEMA_URL);
const runConfigSchema = loadJsonSchema(RUN_CONFIG_SCHEMA_URL);
const registry = new Draft202012SchemaRegistry({ schemas: [thresholdsSchema, runConfigSchema] });

function fail(code, message, details) {
  return Object.assign(new Error(message), { code, ...(details === undefined ? {} : { details }) });
}

function assertCanonicalUtc(value, field) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw fail('RUN_CONFIG_INVALID', `${field} must be canonical UTC RFC 3339 with millisecond precision`);
  }
  return date.getTime();
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

export function normalizeGitObjectFormat(value) {
  if (value === 'sha1' || value === 'SHA1') return 'SHA1';
  if (value === 'sha256' || value === 'SHA256') return 'SHA256';
  throw fail('RUN_CONFIG_INVALID', `Unsupported Git object format: ${value}`);
}

export function readGitIdentity({ repositoryRoot } = {}) {
  if (!repositoryRoot) throw fail('CONFIG_MISSING', 'repositoryRoot is required to freeze source identity');
  try {
    const runGit = (args) => String(execFileSync('git', args, {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })).trim();
    return {
      gitObjectFormat: normalizeGitObjectFormat(runGit(['rev-parse', '--show-object-format'])),
      sourceCommit: runGit(['rev-parse', 'HEAD'])
    };
  } catch (error) {
    if (error?.code === 'RUN_CONFIG_INVALID') throw error;
    throw fail('CONFIG_MISSING', 'Unable to read the repository Git identity', {
      causeName: typeof error?.name === 'string' ? error.name : 'Error',
      causeCode: typeof error?.code === 'string' ? error.code : null
    });
  }
}

export function validateFormalRunConfig(config) {
  try {
    registry.validate(FORMAL_RUN_CONFIG_SCHEMA_ID, config);
  } catch (error) {
    if (error instanceof SchemaValidationError) {
      throw fail('RUN_CONFIG_INVALID', error.message, error.errors);
    }
    throw error;
  }

  const researchFrom = assertCanonicalUtc(config.researchFrom, 'researchFrom');
  const researchTo = assertCanonicalUtc(config.researchTo, 'researchTo');
  const fixedAsOf = assertCanonicalUtc(config.fixedAsOf, 'fixedAsOf');
  if (!(researchFrom < researchTo && researchTo <= fixedAsOf)) {
    throw fail('RUN_CONFIG_INVALID', 'Times must satisfy researchFrom < researchTo <= fixedAsOf');
  }

  validateEffectiveOptions({
    symbol: config.symbols[0],
    from: researchFrom,
    to: researchTo,
    horizons: config.horizons,
    algorithmVersion: config.algorithmVersion,
    datasetVersion: config.datasetVersion,
    ruleVersion: config.ruleVersion,
    weightVersion: config.weightVersion,
    evaluationVersion: config.evaluationVersion
  });
  return config;
}

export function freezeFormalRunConfig(input) {
  let safeInput;
  try {
    // canonicalJson performs the descriptor/prototype/Proxy check before any
    // property value is read. Parsing its output creates a plain data snapshot,
    // so all later reads and spreads operate only on trusted JSON-domain data.
    safeInput = JSON.parse(canonicalJson(input));
  } catch {
    throw fail('RUN_CONFIG_INVALID', 'Formal run config input must be safe JSON data');
  }
  if (!safeInput || typeof safeInput !== 'object' || Array.isArray(safeInput)) {
    throw fail('RUN_CONFIG_INVALID', 'Formal run config input must be an object');
  }
  const detectedIdentity = readGitIdentity({ repositoryRoot: REPOSITORY_ROOT });
  const normalizedIdentity = {
    gitObjectFormat: normalizeGitObjectFormat(detectedIdentity.gitObjectFormat),
    sourceCommit: detectedIdentity.sourceCommit
  };
  for (const key of ['gitObjectFormat', 'sourceCommit']) {
    if (safeInput[key] !== undefined && safeInput[key] !== normalizedIdentity[key]) {
      throw fail('VERSION_MISMATCH', `${key} does not match the checked-out repository`);
    }
  }

  const candidate = { ...safeInput, ...normalizedIdentity };
  validateFormalRunConfig(candidate);
  const serialized = canonicalJson(candidate);
  const config = deepFreeze(JSON.parse(serialized));
  const result = {
    config,
    canonicalJson: serialized,
    sha256: canonicalSha256(config)
  };
  Object.defineProperty(result, 'canonicalBytes', {
    enumerable: true,
    get() { return Buffer.from(serialized, 'utf8'); }
  });
  return Object.freeze(result);
}
