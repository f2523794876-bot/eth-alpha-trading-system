import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonicalJson, canonicalJsonBytes, canonicalSha256 } from './canonical-json.js';

test('RFC 8785 section 3.2.2 specification example interoperates byte-for-byte', () => {
  const input = {
    numbers: [333333333.33333329, 1e30, 4.50, 2e-3, 1e-27],
    string: "€$\u000f\nA'B\"\\\"/",
    literals: [null, true, false]
  };
  const expected = '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\\"\\\\\\\"/"}';
  assert.equal(canonicalJson(input), expected);
  assert.deepEqual(canonicalJsonBytes(input), Buffer.from(expected, 'utf8'));
});

test('RFC 8785 sorts object keys while retaining caller array order', () => {
  assert.equal(canonicalJson({ z: 1, a: ['second', 'first'], nested: { β: 2, a: 1 } }),
    '{"a":["second","first"],"nested":{"a":1,"β":2},"z":1}');
});

test('canonical SHA-256 is the full lowercase digest over UTF-8 canonical bytes', () => {
  const input = { text: '以太坊', value: null, count: 3 };
  const expected = createHash('sha256').update(Buffer.from(canonicalJson(input), 'utf8')).digest('hex');
  assert.equal(canonicalSha256(input), expected);
  assert.match(canonicalSha256(input), /^[0-9a-f]{64}$/);
});

test('canonicalization is stable across insertion order', () => {
  const left = { b: 2, a: { y: null, x: 'value' } };
  const right = { a: { x: 'value', y: null }, b: 2 };
  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.equal(canonicalSha256(left), canonicalSha256(right));
});

test('project numeric boundary cases follow RFC 8785 JSON number serialization', () => {
  assert.equal(canonicalJson({ negativeZero: -0, small: 1e-7, integer: 9007199254740991 }),
    '{"integer":9007199254740991,"negativeZero":0,"small":1e-7}');
});

test('project Unicode and UTF-16 key ordering boundaries are deterministic', () => {
  const input = { '\ud83d\ude00': 'astral', '\u20ac': 'euro', '\r': 'control' };
  assert.equal(canonicalJson(input), '{"\\r":"control","€":"euro","😀":"astral"}');
  assert.equal(canonicalJson(input), canonicalJson(input));
});

for (const [name, value] of [
  ['undefined', { value: undefined }],
  ['NaN', { value: Number.NaN }],
  ['Infinity', { value: Number.POSITIVE_INFINITY }],
  ['-Infinity', { value: Number.NEGATIVE_INFINITY }],
  ['bigint', { value: 1n }],
  ['function', { value() {} }],
  ['symbol value', { value: Symbol('value') }],
  ['non-plain object', { value: new Date('2026-01-01T00:00:00.000Z') }],
  ['custom prototype', Object.create({ inherited: true })],
  ['lone surrogate', { value: '\ud800' }],
  ['sparse array', Array(1)]
]) {
  test(`canonicalization rejects ${name}`, () => {
    assert.throws(() => canonicalJson(value), { code: 'CANONICAL_JSON_INVALID' });
  });
}

test('canonicalization rejects cyclic input', () => {
  const value = {};
  value.self = value;
  assert.throws(() => canonicalJson(value), { code: 'CANONICAL_JSON_INVALID' });
});

test('canonicalization rejects accessors without executing getter or setter code', () => {
  let getterCalls = 0;
  let setterCalls = 0;
  const getterObject = {};
  Object.defineProperty(getterObject, 'secret', {
    enumerable: true,
    get() { getterCalls += 1; return 'secret'; }
  });
  const setterObject = {};
  Object.defineProperty(setterObject, 'secret', {
    enumerable: true,
    set() { setterCalls += 1; }
  });
  assert.throws(() => canonicalJson(getterObject), { code: 'CANONICAL_JSON_INVALID' });
  assert.throws(() => canonicalJson(setterObject), { code: 'CANONICAL_JSON_INVALID' });
  assert.equal(getterCalls, 0);
  assert.equal(setterCalls, 0);
});

test('canonicalization rejects Proxy objects without executing traps', () => {
  let trapCalls = 0;
  const value = new Proxy({ safe: true }, {
    getPrototypeOf() { trapCalls += 1; return Object.prototype; },
    ownKeys() { trapCalls += 1; return ['safe']; },
    getOwnPropertyDescriptor() { trapCalls += 1; return { enumerable: true, configurable: true, value: true }; }
  });
  assert.throws(() => canonicalJson(value), { code: 'CANONICAL_JSON_INVALID' });
  assert.equal(trapCalls, 0);
});

test('canonicalization rejects symbol and non-enumerable own properties', () => {
  const symbolObject = { value: 1 };
  symbolObject[Symbol('hidden')] = 2;
  assert.throws(() => canonicalJson(symbolObject), { code: 'CANONICAL_JSON_INVALID' });

  const hiddenObject = { value: 1 };
  Object.defineProperty(hiddenObject, 'hidden', { value: 2, enumerable: false });
  assert.throws(() => canonicalJson(hiddenObject), { code: 'CANONICAL_JSON_INVALID' });
});

test('canonicalization rejects arrays with symbol or extra non-index own properties', () => {
  const extra = [1];
  extra.extra = 2;
  assert.throws(() => canonicalJson(extra), { code: 'CANONICAL_JSON_INVALID' });
  const symbol = [1];
  symbol[Symbol('extra')] = 2;
  assert.throws(() => canonicalJson(symbol), { code: 'CANONICAL_JSON_INVALID' });
});

test('null-prototype plain data objects remain valid JSON-domain input', () => {
  const value = Object.create(null);
  value.answer = 42;
  assert.equal(canonicalJson(value), '{"answer":42}');
});

test('repeated canonical bytes and SHA-256 remain identical for legal data', () => {
  const value = { array: [3, 2, 1], nested: { text: '以太坊', value: null } };
  assert.deepEqual(canonicalJsonBytes(value), canonicalJsonBytes(value));
  assert.equal(canonicalSha256(value), canonicalSha256(value));
});
