import assert from 'node:assert/strict';
import test from 'node:test';
import { Draft202012SchemaRegistry, isRfc3339DateTime, SchemaValidationError } from './schema-registry.js';

const addressSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://example.invalid/address.json',
  $defs: {
    address: {
      type: 'object',
      properties: { city: { type: 'string', minLength: 1 } },
      required: ['city'],
      additionalProperties: false
    }
  }
};

const personSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://example.invalid/person.json',
  type: 'object',
  properties: {
    name: { type: 'string' },
    address: { $ref: 'https://example.invalid/address.json#/$defs/address' }
  },
  required: ['name', 'address'],
  unevaluatedProperties: false
};

test('Draft 2020-12 registry resolves local and cross-schema $ref', () => {
  const registry = new Draft202012SchemaRegistry({ schemas: [addressSchema, personSchema] });
  assert.equal(registry.validate('https://example.invalid/person.json', { name: 'Ada', address: { city: 'London' } }).name, 'Ada');
  assert.throws(
    () => registry.validate('https://example.invalid/person.json', { name: 'Ada', address: { city: '' } }),
    (error) => error instanceof SchemaValidationError && error.errors.some((item) => item.keyword === 'minLength')
  );
});

test('Draft 2020-12 prefixItems and unevaluatedProperties are enforced', () => {
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://example.invalid/official-2020-12-features.json',
    type: 'object',
    properties: {
      tuple: {
        type: 'array', prefixItems: [{ const: 'first' }, { type: 'integer' }],
        items: false, minItems: 2, maxItems: 2
      }
    },
    required: ['tuple'],
    unevaluatedProperties: false
  };
  const registry = new Draft202012SchemaRegistry({ schemas: [schema] });
  registry.validate(schema.$id, { tuple: ['first', 2] });
  assert.throws(() => registry.validate(schema.$id, { tuple: ['first', 2, 3] }), SchemaValidationError);
  assert.throws(() => registry.validate(schema.$id, { tuple: ['first', 2], extra: true }), SchemaValidationError);
});

test('registered date-time format validates leap years, offsets, fractions, and time boundaries', () => {
  for (const value of [
    '2024-02-29T00:00:00Z',
    '2024-02-29T23:59:59Z',
    '2026-01-01T00:00:00.1Z',
    '2026-01-01T00:00:00.123456Z',
    '2026-01-01T00:00:00.123+08:00',
    '2024-06-30T23:59:60Z'
  ]) assert.equal(isRfc3339DateTime(value), true, value);
  for (const value of [
    '2023-02-29T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-01-01T24:00:00Z',
    '2026-01-01T23:60:00Z',
    '2026-01-01T23:59:61Z',
    '2026-01-01T23:59:60Z',
    '2026-01-01T00:00:00',
    '2026-01-01t00:00:00z',
    '2026-01-01T00:00:00.Z',
    '2026-01-01T00:00:00,123Z',
    'not-a-date'
  ]) assert.equal(isRfc3339DateTime(value), false, value);

  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://example.invalid/date.json',
    type: 'string',
    format: 'date-time'
  };
  const registry = new Draft202012SchemaRegistry({ schemas: [schema] });
  registry.validate(schema.$id, '2024-02-29T23:59:59Z');
  assert.throws(() => registry.validate(schema.$id, '2023-02-29T00:00:00Z'), SchemaValidationError);
});

test('uuid format exactly matches the frozen lowercase UUID v1-v5 contract', () => {
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://example.invalid/uuid.json',
    type: 'string',
    format: 'uuid'
  };
  const registry = new Draft202012SchemaRegistry({ schemas: [schema] });
  for (const version of ['1', '2', '3', '4', '5']) {
    registry.validate(schema.$id, `123e4567-e89b-${version}2d3-a456-426614174000`);
  }
  for (const value of [
    '123e4567-e89b-62d3-a456-426614174000',
    '123e4567-e89b-72d3-a456-426614174000',
    '123e4567-e89b-82d3-a456-426614174000',
    '123E4567-E89B-42D3-A456-426614174000',
    '123e4567-e89b-42D3-a456-426614174000',
    '123e4567-e89b-42d3-7456-426614174000',
    '123e4567-e89b-42d3-a456-42661417400',
    '123e4567-e89b-42d3-a456-42661417400g'
  ]) assert.throws(() => registry.validate(schema.$id, value), SchemaValidationError, value);
});

test('unknown cross-schema references fail at schema registration', () => {
  assert.throws(() => new Draft202012SchemaRegistry({ schemas: [{
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://example.invalid/broken.json',
    $ref: 'https://example.invalid/missing.json'
  }] }), /can't resolve reference|MissingRefError/);
});

test('registry rejects schemas that do not explicitly declare Draft 2020-12', () => {
  assert.throws(() => new Draft202012SchemaRegistry({ schemas: [{
    $id: 'https://example.invalid/wrong-dialect.json', type: 'object'
  }] }), { code: 'SCHEMA_DIALECT_INVALID' });
});

test('direct object schemas pass the same Draft 2020-12 registration gates', () => {
  const registry = new Draft202012SchemaRegistry();
  const direct = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://example.invalid/direct.json',
    type: 'object', properties: { value: { type: 'integer' } },
    required: ['value'], additionalProperties: false
  };
  assert.equal(registry.validate(direct, { value: 1 }).value, 1);
  assert.throws(() => registry.validate(direct.$id, { value: '1' }), SchemaValidationError);
});

test('direct object schemas cannot bypass id, dialect, meta-schema, duplicate, or ref gates', () => {
  const registry = new Draft202012SchemaRegistry();
  assert.throws(() => registry.compile({
    $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'integer'
  }), { code: 'SCHEMA_ID_REQUIRED' });
  assert.throws(() => registry.compile({
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'https://example.invalid/old-draft.json', type: 'integer'
  }), { code: 'SCHEMA_DIALECT_INVALID' });
  assert.throws(() => registry.compile({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://example.invalid/invalid.json', type: 'not-a-json-schema-type'
  }), { code: 'SCHEMA_INVALID' });

  const duplicate = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://example.invalid/duplicate.json', type: 'integer'
  };
  registry.addSchema(duplicate);
  assert.throws(() => registry.addSchema(duplicate), { code: 'SCHEMA_DUPLICATE' });

  assert.throws(() => registry.compile({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://example.invalid/direct-missing-ref.json',
    $ref: 'https://example.invalid/not-registered.json'
  }), /can't resolve reference|MissingRefError/);
});

test('direct object schema gate errors do not echo caller-controlled schema content', () => {
  const secret = 'postgres://admin:secret@example.invalid/production';
  const registry = new Draft202012SchemaRegistry();
  let error;
  try {
    registry.compile({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://example.invalid/redacted-invalid.json',
      type: secret
    });
  } catch (caught) { error = caught; }
  assert.equal(error.code, 'SCHEMA_INVALID');
  assert.doesNotMatch(JSON.stringify(error), /admin|secret|production/);
});

test('public schema errors redact caller-controlled property names and values', () => {
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://example.invalid/redaction.json',
    type: 'object',
    properties: {
      nested: {
        type: 'object', properties: { value: { type: 'integer' } },
        required: ['value'], additionalProperties: false
      }
    },
    required: ['nested'],
    additionalProperties: false
  };
  const registry = new Draft202012SchemaRegistry({ schemas: [schema] });
  for (const [input, secret] of [
    [{ nested: { value: 1 }, 'secret-property-name': true }, 'secret-property-name'],
    [{ nested: { value: 'secret-property-value' } }, 'secret-property-value']
  ]) {
    let error;
    try { registry.validate(schema.$id, input); } catch (caught) { error = caught; }
    assert.ok(error instanceof SchemaValidationError);
    assert.doesNotMatch(JSON.stringify(error), new RegExp(secret));
    assert.deepEqual(Object.keys(error.errors[0]).sort(), ['instancePath', 'keyword', 'message']);
  }
  assert.equal(Object.hasOwn(new SchemaValidationError([]), 'schemaId'), false);
});
