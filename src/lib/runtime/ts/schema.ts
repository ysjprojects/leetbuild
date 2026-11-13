/**
 * Fastify's route validation (`schema: {body, querystring, params, headers}`), as Fastify 4 compiles
 * it with Ajv 8 and its default options — `coerceTypes: 'array'`, `useDefaults: true`,
 * `removeAdditional: true`, `allErrors: false`: types are coerced (a query's `"5"` to 5, a lone value
 * to a one-item array and back), missing properties take their `default`, properties an
 * `additionalProperties: false` object does not declare are removed, and the first failure answers
 * 400 `FST_ERR_VALIDATION` with Ajv's message (`body/duration_s must be <= 14400`).
 *
 * The keywords: type (and `nullable`), required, properties, additionalProperties, enum, const,
 * minimum, maximum, exclusiveMinimum, exclusiveMaximum, minLength, maxLength (in code points, as
 * Ajv counts), pattern (a `u` RegExp), items, minItems, maxItems, default, and the annotations
 * (title, description …). Any other keyword is refused when the route is registered: a schema this
 * runtime cannot enforce must not pass for one it does.
 */

/** One Ajv error, as Fastify keeps it on `error.validation`. */
export interface SchemaError {
  instancePath: string;
  schemaPath: string;
  keyword: string;
  params: Record<string, unknown>;
  message: string;
}

/** Validates `data` in place (coercions land in its parent, defaults and removals in the object); the first error, or null. */
export type Validate = (data: unknown) => SchemaError | null;

const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'array', 'object']);

const ANNOTATIONS = new Set([
  'title',
  'description',
  '$comment',
  'examples',
  'default',
  '$id',
  '$schema',
  'deprecated',
  'readOnly',
  'writeOnly',
]);

const KEYWORDS = new Set([
  'type',
  'nullable',
  'required',
  'properties',
  'additionalProperties',
  'enum',
  'const',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'pattern',
  'items',
  'minItems',
  'maxItems',
]);

/** A JSON object (not an array, not null): what a schema, and an object a schema validates, is. */
export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** JSON Pointer escaping, as Ajv builds `instancePath`. */
const pointer = (key: string | number): string => `/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;

/** Ajv's `equal` (fast-deep-equal) for `const` and `enum`. */
const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return a !== a && b !== b;
};

const hasType = (type: string, data: unknown): boolean => {
  switch (type) {
    case 'string':
      return typeof data === 'string';
    case 'number':
      return typeof data === 'number';
    case 'integer':
      return typeof data === 'number' && !(data % 1) && !Number.isNaN(data);
    case 'boolean':
      return typeof data === 'boolean';
    case 'null':
      return data === null;
    case 'array':
      return Array.isArray(data);
    default:
      return isObject(data);
  }
};

/** A string Ajv takes for a number: non-empty, and `s == +s` (so `" 5 "` is 5 and `"0x10"` is 16). */
const numeric = (s: string): boolean => s !== '' && !Number.isNaN(Number(s));

const NO_COERCION = Symbol('no coercion');

/** Ajv's `coerceTypes: 'array'`, in the order of the schema's types: the coerced value, or NO_COERCION. */
const coerce = (types: string[], value: unknown): unknown => {
  // Objects are never coerced to: a schema of type object alone answers a type error.
  if (!types.some(t => t !== 'object')) return NO_COERCION;
  let data = value;
  // A one-item array is unwrapped first, and kept if its item already has one of the types.
  if (Array.isArray(data) && data.length === 1) {
    data = data[0];
    if (types.some(t => hasType(t, data))) return data;
  }
  for (const t of types) {
    switch (t) {
      case 'string':
        if (typeof data === 'number' || typeof data === 'boolean') return String(data);
        if (data === null) return '';
        break;
      case 'number':
        if (typeof data === 'boolean' || data === null || (typeof data === 'string' && numeric(data)))
          return Number(data);
        break;
      case 'integer':
        if (
          typeof data === 'boolean' ||
          data === null ||
          (typeof data === 'string' && numeric(data) && !(Number(data) % 1))
        )
          return Number(data);
        break;
      case 'boolean':
        if (data === 'false' || data === 0 || data === null) return false;
        if (data === 'true' || data === 1) return true;
        break;
      case 'null':
        if (data === '' || data === 0 || data === false) return null;
        break;
      case 'array':
        if (typeof data === 'string' || typeof data === 'number' || typeof data === 'boolean' || data === null)
          return [data];
        break;
      default:
        break;
    }
  }
  return NO_COERCION;
};

interface Node {
  schemaPath: string;
  types: string[];
  required: string[];
  properties: [string, Node][];
  defaults: [string, unknown][];
  /** false: undeclared properties are removed; a node: they are validated against it; null: anything goes. */
  additional: false | Node | null;
  items: Node | null;
  enumValues: unknown[] | null;
  constValue: {value: unknown} | null;
  limits: {keyword: string; limit: number; ok: (n: number) => boolean; message: string}[];
  minLength: number | null;
  maxLength: number | null;
  pattern: {source: string; regexp: RegExp} | null;
  minItems: number | null;
  maxItems: number | null;
  /** A boolean schema: true accepts anything, false nothing. */
  always: boolean | null;
}

const fail = (where: string, path: string, why: string): never => {
  throw new Error(`${where}: schema${path === '' ? '' : ` at ${path}`} ${why}`);
};

const nonNegativeInteger = (where: string, path: string, keyword: string, v: unknown): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0)
    fail(where, path, `${keyword} must be a non-negative integer, got ${JSON.stringify(v)}`);
  return v as number;
};

const compileNode = (schema: unknown, where: string, schemaPath: string): Node => {
  const node: Node = {
    schemaPath,
    types: [],
    required: [],
    properties: [],
    defaults: [],
    additional: null,
    items: null,
    enumValues: null,
    constValue: null,
    limits: [],
    minLength: null,
    maxLength: null,
    pattern: null,
    minItems: null,
    maxItems: null,
    always: null,
  };
  if (typeof schema === 'boolean') {
    node.always = schema;
    return node;
  }
  if (!isObject(schema))
    return fail(where, schemaPath, `must be an object or a boolean, got ${JSON.stringify(schema)}`);
  for (const keyword of Object.keys(schema))
    if (!KEYWORDS.has(keyword) && !ANNOTATIONS.has(keyword))
      fail(
        where,
        schemaPath,
        `uses '${keyword}', which this runtime's Fastify validation does not enforce (it enforces ${[...KEYWORDS].join(
          ', ',
        )}): check it in the handler instead`,
      );
  const {type} = schema;
  if (type !== undefined) {
    const types = Array.isArray(type) ? type : [type];
    for (const t of types)
      if (typeof t !== 'string' || !TYPES.has(t)) fail(where, schemaPath, `has an unknown type ${JSON.stringify(t)}`);
    node.types = types as string[];
  }
  if (schema.nullable === true) {
    if (node.types.length === 0) fail(where, schemaPath, `uses 'nullable' without 'type'`);
    if (!node.types.includes('null')) node.types.push('null');
  } else if (schema.nullable !== undefined && schema.nullable !== false)
    fail(where, schemaPath, `'nullable' must be a boolean`);
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || schema.required.some(r => typeof r !== 'string'))
      fail(where, schemaPath, `'required' must be an array of property names`);
    node.required = schema.required as string[];
  }
  if (schema.properties !== undefined) {
    if (!isObject(schema.properties)) fail(where, schemaPath, `'properties' must be an object`);
    for (const [name, sub] of Object.entries(schema.properties as Record<string, unknown>)) {
      const child = compileNode(sub, where, `${schemaPath}/properties${pointer(name)}`);
      node.properties.push([name, child]);
      if (isObject(sub) && sub.default !== undefined) node.defaults.push([name, sub.default]);
    }
  }
  if (schema.additionalProperties === false) node.additional = false;
  else if (schema.additionalProperties !== undefined && schema.additionalProperties !== true)
    node.additional = compileNode(schema.additionalProperties, where, `${schemaPath}/additionalProperties`);
  if (schema.items !== undefined) {
    if (Array.isArray(schema.items))
      fail(
        where,
        schemaPath,
        `uses 'items' as a tuple (an array of schemas), which this runtime's Fastify validation does not enforce`,
      );
    node.items = compileNode(schema.items, where, `${schemaPath}/items`);
  }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0)
      fail(where, schemaPath, `'enum' must be a non-empty array`);
    node.enumValues = schema.enum as unknown[];
  }
  if ('const' in schema) node.constValue = {value: schema.const};
  const bounds: [string, string, (n: number, limit: number) => boolean][] = [
    ['maximum', '<=', (n, l) => n <= l],
    ['minimum', '>=', (n, l) => n >= l],
    ['exclusiveMaximum', '<', (n, l) => n < l],
    ['exclusiveMinimum', '>', (n, l) => n > l],
  ];
  for (const [keyword, comparison, test] of bounds) {
    const limit = schema[keyword];
    if (limit === undefined) continue;
    if (typeof limit !== 'number')
      fail(where, schemaPath, `'${keyword}' must be a number, got ${JSON.stringify(limit)}`);
    node.limits.push({
      keyword,
      limit: limit as number,
      ok: n => test(n, limit as number),
      message: `must be ${comparison} ${limit}`,
    });
  }
  if (schema.minLength !== undefined)
    node.minLength = nonNegativeInteger(where, schemaPath, 'minLength', schema.minLength);
  if (schema.maxLength !== undefined)
    node.maxLength = nonNegativeInteger(where, schemaPath, 'maxLength', schema.maxLength);
  if (schema.minItems !== undefined) node.minItems = nonNegativeInteger(where, schemaPath, 'minItems', schema.minItems);
  if (schema.maxItems !== undefined) node.maxItems = nonNegativeInteger(where, schemaPath, 'maxItems', schema.maxItems);
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== 'string') fail(where, schemaPath, `'pattern' must be a string`);
    try {
      node.pattern = {source: schema.pattern as string, regexp: new RegExp(schema.pattern as string, 'u')};
    } catch (e) {
      fail(where, schemaPath, `has an invalid 'pattern': ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return node;
};

const error = (
  node: Node,
  instancePath: string,
  keyword: string,
  params: Record<string, unknown>,
  message: string,
): SchemaError => ({instancePath, schemaPath: `${node.schemaPath}/${keyword}`, keyword, params, message});

/** Validate `holder[key]`, writing a coerced value back into `holder`. */
const check = (
  node: Node,
  holder: Record<string | number, unknown>,
  key: string | number,
  path: string,
): SchemaError | null => {
  if (node.always !== null)
    return node.always
      ? null
      : {
          instancePath: path,
          schemaPath: node.schemaPath,
          keyword: 'false schema',
          params: {},
          message: 'boolean schema is false',
        };
  let data = holder[key];
  if (node.types.length > 0 && !node.types.some(t => hasType(t, data))) {
    const coerced = coerce(node.types, data);
    if (coerced === NO_COERCION)
      return error(node, path, 'type', {type: node.types.join(',')}, `must be ${node.types.join(',')}`);
    data = coerced;
    holder[key] = coerced;
  }
  // Keywords for any type first (const, then enum), then the number, string, array and object ones, as Ajv orders them.
  if (node.constValue !== null && !deepEqual(data, node.constValue.value))
    return error(node, path, 'const', {allowedValue: node.constValue.value}, 'must be equal to constant');
  if (node.enumValues !== null && !node.enumValues.some(v => deepEqual(data, v)))
    return error(node, path, 'enum', {allowedValues: node.enumValues}, 'must be equal to one of the allowed values');
  if (typeof data === 'number')
    for (const limit of node.limits)
      if (!limit.ok(data))
        return error(
          node,
          path,
          limit.keyword,
          {comparison: limit.message.split(' ')[2], limit: limit.limit},
          limit.message,
        );
  if (typeof data === 'string') {
    const length = node.maxLength !== null || node.minLength !== null ? [...data].length : 0;
    if (node.maxLength !== null && length > node.maxLength)
      return error(
        node,
        path,
        'maxLength',
        {limit: node.maxLength},
        `must NOT have more than ${node.maxLength} characters`,
      );
    if (node.minLength !== null && length < node.minLength)
      return error(
        node,
        path,
        'minLength',
        {limit: node.minLength},
        `must NOT have fewer than ${node.minLength} characters`,
      );
    if (node.pattern !== null && !node.pattern.regexp.test(data))
      return error(
        node,
        path,
        'pattern',
        {pattern: node.pattern.source},
        `must match pattern "${node.pattern.source}"`,
      );
  }
  if (Array.isArray(data)) {
    if (node.maxItems !== null && data.length > node.maxItems)
      return error(node, path, 'maxItems', {limit: node.maxItems}, `must NOT have more than ${node.maxItems} items`);
    if (node.minItems !== null && data.length < node.minItems)
      return error(node, path, 'minItems', {limit: node.minItems}, `must NOT have fewer than ${node.minItems} items`);
    if (node.items !== null) {
      // An array is indexed like any holder: its items' coercions land in it.
      const items = data as unknown as Record<number, unknown>;
      for (let i = 0; i < data.length; i++) {
        const failed = check(node.items, items, i, `${path}${pointer(i)}`);
        if (failed !== null) return failed;
      }
    }
  }
  if (isObject(data)) {
    for (const [name, value] of node.defaults) if (data[name] === undefined) data[name] = structuredClone(value);
    for (const name of node.required)
      if (data[name] === undefined)
        return error(node, path, 'required', {missingProperty: name}, `must have required property '${name}'`);
    if (node.additional !== null) {
      const declared = new Set(node.properties.map(([name]) => name));
      for (const name of Object.keys(data)) {
        if (declared.has(name)) continue;
        if (node.additional === false) delete data[name];
        else {
          const failed = check(node.additional, data, name, `${path}${pointer(name)}`);
          if (failed !== null) return failed;
        }
      }
    }
    for (const [name, child] of node.properties) {
      if (data[name] === undefined) continue;
      const failed = check(child, data, name, `${path}${pointer(name)}`);
      if (failed !== null) return failed;
    }
  }
  return null;
};

/** Compile one part's schema; `where` names the route and the part in a registration error. Throws on what it cannot enforce. */
export function compileSchema(schema: unknown, where: string): Validate {
  const root = compileNode(schema, where, '#');
  return data => check(root, {data}, 'data', '');
}
