import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { canonicalJson } from './canonical-json.js';

const RFC3339_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const SCHEMA_ERROR_MESSAGES = Object.freeze({
  additionalProperties: 'unexpected property',
  const: 'value does not match the required constant',
  enum: 'value is not in the allowed set',
  format: 'value does not match the required format',
  maxItems: 'array has too many items',
  maximum: 'number exceeds the allowed maximum',
  minItems: 'array has too few items',
  minimum: 'number is below the allowed minimum',
  minLength: 'string is shorter than allowed',
  pattern: 'string does not match the required pattern',
  required: 'required value is missing',
  type: 'value has the wrong type',
  uniqueItems: 'array items must be unique'
});

export function isRfc3339DateTime(value) {
  if (typeof value !== 'string') return false;
  const match = RFC3339_DATE_TIME.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = match;
  const parts = [year, month, day, hour, minute, second].map(Number);
  if (parts[1] < 1 || parts[1] > 12 || parts[3] > 23 || parts[4] > 59 || parts[5] > 60) return false;
  if (offsetHour != null && (Number(offsetHour) > 23 || Number(offsetMinute) > 59)) return false;
  const leapYear = parts[0] % 4 === 0 && (parts[0] % 100 !== 0 || parts[0] % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (parts[2] < 1 || parts[2] > monthDays[parts[1] - 1]) return false;
  if (parts[5] === 60) {
    const leapSecondDay = (parts[1] === 6 && parts[2] === 30) || (parts[1] === 12 && parts[2] === 31);
    if (!value.endsWith('Z') || parts[3] !== 23 || parts[4] !== 59 || !leapSecondDay) return false;
  }
  return true;
}

function sanitizeInstancePath(instancePath) {
  if (!instancePath) return '';
  return instancePath.split('/').map((segment, index) => index === 0 ? '' : (/^\d+$/.test(segment) ? segment : '*')).join('/');
}

export class SchemaValidationError extends Error {
  constructor(errors) {
    super('JSON Schema validation failed');
    this.name = 'SchemaValidationError';
    this.code = 'SCHEMA_VALIDATION_FAILED';
    this.errors = errors.map(({ instancePath, keyword }) => ({
      instancePath: sanitizeInstancePath(instancePath),
      keyword,
      message: SCHEMA_ERROR_MESSAGES[keyword] || 'schema constraint failed'
    }));
  }
}

export function loadJsonSchema(pathOrUrl) {
  return JSON.parse(readFileSync(pathOrUrl, 'utf8'));
}

function registryError(code, message) {
  return Object.assign(new TypeError(message), { code });
}

function snapshotSchema(schema) {
  try {
    return JSON.parse(canonicalJson(schema));
  } catch {
    throw registryError('SCHEMA_INVALID', 'Schema must be safe JSON data');
  }
}

function createAjv() {
  const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
  ajv.addFormat('date-time', { type: 'string', validate: isRfc3339DateTime });
  ajv.addFormat('uuid', { type: 'string', validate: (value) => UUID.test(value) });
  return ajv;
}

function assertSchemaHeader(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) ||
      typeof schema.$id !== 'string' || schema.$id.length === 0) {
    throw registryError('SCHEMA_ID_REQUIRED', 'Schema must have a non-empty identifier');
  }
  if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') {
    throw registryError('SCHEMA_DIALECT_INVALID', 'Schema must declare Draft 2020-12');
  }
}

function buildCandidateAjv(schemas) {
  const ajv = createAjv();
  for (const schema of schemas) {
    let schemaIsValid = false;
    try {
      schemaIsValid = ajv.validateSchema(schema);
    } catch {
      schemaIsValid = false;
    }
    if (!schemaIsValid) {
      throw registryError('SCHEMA_INVALID', 'Schema does not satisfy the Draft 2020-12 meta-schema');
    }
  }
  try {
    for (const schema of schemas) ajv.addSchema(schema);
  } catch {
    throw registryError('SCHEMA_INVALID', 'Schema could not be registered');
  }
  try {
    for (const schema of schemas) {
      if (!ajv.getSchema(schema.$id)) {
        throw new Error('Schema did not compile');
      }
    }
  } catch {
    throw registryError('SCHEMA_REFERENCE_INVALID', 'Schema references could not be resolved');
  }
  return ajv;
}

export class Draft202012SchemaRegistry {
  #schemaSnapshots = new Map();

  constructor({ schemas = [] } = {}) {
    this.ajv = createAjv();
    this.schemaIds = new Set();
    if (schemas.length > 0) this.#registerSchemas(schemas);
  }

  addSchema(schema) {
    this.#registerSchemas([schema]);
    return this;
  }

  #registerSchemas(schemas) {
    const snapshots = schemas.map(snapshotSchema);
    const candidateSnapshots = new Map(this.#schemaSnapshots);
    for (const schema of snapshots) {
      assertSchemaHeader(schema);
      if (candidateSnapshots.has(schema.$id)) {
        throw registryError('SCHEMA_DUPLICATE', 'Schema identifier is already registered');
      }
      candidateSnapshots.set(schema.$id, schema);
    }

    // Build and fully compile an isolated candidate first. The live Registry and
    // Ajv instance are replaced only after every schema and reference succeeds.
    const candidateAjv = buildCandidateAjv([...candidateSnapshots.values()]);
    this.ajv = candidateAjv;
    this.#schemaSnapshots = candidateSnapshots;
    this.schemaIds = new Set(candidateSnapshots.keys());
    return snapshots;
  }

  resolveAll() {
    for (const schemaId of this.schemaIds) this.compile(schemaId);
    return this;
  }

  compile(schemaOrId) {
    if (typeof schemaOrId === 'string') {
      const validator = this.ajv.getSchema(schemaOrId);
      if (!validator) throw registryError('SCHEMA_NOT_FOUND', 'Schema identifier is not registered');
      return validator;
    }
    const [snapshot] = this.#registerSchemas([schemaOrId]);
    const validator = this.ajv.getSchema(snapshot.$id);
    if (!validator) throw registryError('SCHEMA_NOT_FOUND', 'Registered schema could not be compiled');
    return validator;
  }

  validate(schemaOrId, data) {
    const validator = this.compile(schemaOrId);
    if (!validator(data)) {
      throw new SchemaValidationError(validator.errors || []);
    }
    return data;
  }
}
