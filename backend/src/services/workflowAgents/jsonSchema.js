// A small JSON Schema validator for the subset the module uses: tool inputs and an
// agent's editable output schema. No dependency, so the backend image does not
// need a rebuild of node_modules for this module.
//
// Supported: type (incl. arrays of types), enum, const, required, properties,
// additionalProperties (boolean or schema), items, minItems, maxItems, minimum,
// maximum, minLength, maxLength, pattern, anyOf, oneOf, allOf. Unknown keywords are
// ignored, which is the JSON Schema default.

const MAX_ERRORS = 50;

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(expected, actual) {
  if (expected === actual) return true;
  if (expected === 'number' && actual === 'integer') return true;
  return false;
}

function validate(schema, value, path = '$', errors = []) {
  if (errors.length >= MAX_ERRORS || !schema || typeof schema !== 'object') return errors;
  const push = (msg) => { if (errors.length < MAX_ERRORS) errors.push(`${path}: ${msg}`); };
  const actual = typeOf(value);

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(t => typeMatches(t, actual))) {
      push(`expected ${types.join(' or ')}, got ${actual}`);
      return errors;
    }
  }
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) push(`must equal ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.some(e => JSON.stringify(e) === JSON.stringify(value))) {
    push(`must be one of ${schema.enum.map(e => JSON.stringify(e)).join(', ')}`);
  }

  if (actual === 'string') {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) push(`must be at least ${schema.minLength} characters`);
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) push(`must be at most ${schema.maxLength} characters`);
    if (typeof schema.pattern === 'string') {
      try { if (!new RegExp(schema.pattern).test(value)) push(`must match ${schema.pattern}`); } catch { /* bad pattern: ignore */ }
    }
  }
  if (actual === 'number' || actual === 'integer') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) push(`must be >= ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) push(`must be <= ${schema.maximum}`);
  }
  if (actual === 'array') {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) push(`must have at least ${schema.minItems} items`);
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) push(`must have at most ${schema.maxItems} items`);
    if (schema.items && typeof schema.items === 'object') {
      value.forEach((item, i) => validate(schema.items, item, `${path}[${i}]`, errors));
    }
  }
  if (actual === 'object') {
    const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) if (!Object.prototype.hasOwnProperty.call(value, key)) push(`missing required property "${key}"`);
    }
    for (const [key, v] of Object.entries(value)) {
      if (props[key]) validate(props[key], v, `${path}.${key}`, errors);
      else if (schema.additionalProperties === false) push(`unexpected property "${key}"`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        validate(schema.additionalProperties, v, `${path}.${key}`, errors);
      }
    }
  }
  if (Array.isArray(schema.allOf)) for (const s of schema.allOf) validate(s, value, path, errors);
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some(s => validate(s, value, path, []).length === 0)) push('does not match any allowed shape');
  if (Array.isArray(schema.oneOf) && schema.oneOf.filter(s => validate(s, value, path, []).length === 0).length !== 1) push('must match exactly one allowed shape');
  return errors;
}

/** Is `schema` itself usable? Returns a list of problems (empty = fine). */
function checkSchema(schema) {
  const problems = [];
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return ['The output schema must be a JSON object.'];
  const walk = (s, path) => {
    if (!s || typeof s !== 'object') return;
    if (s.type !== undefined) {
      const types = Array.isArray(s.type) ? s.type : [s.type];
      const bad = types.filter(t => !['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'].includes(t));
      if (bad.length) problems.push(`${path}: unknown type ${bad.join(', ')}`);
    }
    if (s.properties) for (const [k, v] of Object.entries(s.properties)) walk(v, `${path}.${k}`);
    if (s.items) walk(s.items, `${path}[]`);
    for (const key of ['anyOf', 'oneOf', 'allOf']) if (Array.isArray(s[key])) s[key].forEach((x, i) => walk(x, `${path}.${key}[${i}]`));
    if (typeof s.pattern === 'string') { try { new RegExp(s.pattern); } catch { problems.push(`${path}: invalid pattern`); } }
  };
  walk(schema, '$');
  return problems;
}

module.exports = { validate, checkSchema, typeOf };
