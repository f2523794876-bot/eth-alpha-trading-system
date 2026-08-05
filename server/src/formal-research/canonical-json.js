import { createHash } from 'node:crypto';
import { types } from 'node:util';
import canonicalize from 'canonicalize';

export class CanonicalJsonError extends TypeError {
  constructor(message, path = '$') {
    super(`${message} at ${path}`);
    this.name = 'CanonicalJsonError';
    this.code = 'CANONICAL_JSON_INVALID';
    this.path = path;
  }
}

function assertJsonValue(value, path, ancestors) {
  if (value === null) return;

  const valueType = typeof value;
  if (valueType === 'string') {
    assertUnicodeScalarString(value, path);
    return;
  }
  if (valueType === 'boolean') return;
  if (valueType === 'number') {
    if (!Number.isFinite(value)) throw new CanonicalJsonError('Non-finite numbers are not JSON values', path);
    return;
  }
  if (valueType !== 'object') throw new CanonicalJsonError(`Unsupported ${valueType} value`, path);
  if (types.isProxy(value)) throw new CanonicalJsonError('Proxy objects are not JSON data values', path);
  if (ancestors.has(value)) throw new CanonicalJsonError('Cyclic structures cannot be canonicalized', path);

  ancestors.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new CanonicalJsonError('Only ordinary arrays can be canonicalized', path);
    }
    const ownKeys = Reflect.ownKeys(value);
    const allowedKeys = new Set(['length']);
    for (let index = 0; index < value.length; index += 1) {
      const key = String(index);
      allowedKeys.add(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) throw new CanonicalJsonError('Sparse arrays are not JSON values', `${path}[${index}]`);
      assertEnumerableDataDescriptor(descriptor, `${path}[${index}]`);
      assertJsonValue(descriptor.value, `${path}[${index}]`, ancestors);
    }
    for (const key of ownKeys) {
      if (typeof key === 'symbol' || !allowedKeys.has(key)) {
        throw new CanonicalJsonError('Arrays cannot contain symbol or non-index own properties', path);
      }
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalJsonError('Only plain objects can be canonicalized', path);
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'symbol') throw new CanonicalJsonError('Symbol own keys are not JSON properties', path);
      assertUnicodeScalarString(key, `${path}.<key>`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      assertEnumerableDataDescriptor(descriptor, `${path}.${key}`);
      assertJsonValue(descriptor.value, `${path}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}

function assertEnumerableDataDescriptor(descriptor, path) {
  if (!descriptor || descriptor.get !== undefined || descriptor.set !== undefined || !Object.hasOwn(descriptor, 'value')) {
    throw new CanonicalJsonError('Accessor properties are not JSON data properties', path);
  }
  if (descriptor.enumerable !== true) {
    throw new CanonicalJsonError('Non-enumerable own properties are not JSON data properties', path);
  }
}

function assertUnicodeScalarString(value, path) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new CanonicalJsonError('Lone Unicode surrogate is not valid I-JSON', path);
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new CanonicalJsonError('Lone Unicode surrogate is not valid I-JSON', path);
    }
  }
}

export function canonicalJson(value) {
  assertJsonValue(value, '$', new Set());
  const result = canonicalize(value);
  if (typeof result !== 'string') throw new CanonicalJsonError('Canonicalization did not produce JSON text');
  return result;
}

export function canonicalJsonBytes(value) {
  return Buffer.from(canonicalJson(value), 'utf8');
}

export function canonicalSha256(value) {
  return createHash('sha256').update(canonicalJsonBytes(value)).digest('hex');
}
