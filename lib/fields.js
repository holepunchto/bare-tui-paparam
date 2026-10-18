// Build a JSON Schema from the paparam flags/args the model chose to collect,
// plus any free-form questions it added (the hybrid form model).
//
// `collect` is a list of REAL flag/arg names (from the catalog); each becomes a
// field generated from paparam metadata — choices→enum (a select), boolean→a
// confirm, a value flag→text with the default prefilled, a repeatable flag→an
// editable list of values. `questions` is an UNTRUSTED JSON-Schema fragment the model
// authored for conceptual questions not tied to a flag; it is merged in and goes
// through fromSchema's full hardening downstream.
//
// We never bracket-assign a model-supplied key onto a normal object (that would
// let `__proto__` mutate the prototype before fromSchema's assertSafeKey ever
// runs); forbidden keys are dropped here with a warning, and the rest are set as
// own properties via defineProperty.
const { REST_KEY } = require('./argv')

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

function buildSchema(catalog, { collect = [], questions } = {}) {
  const warnings = []
  const index = indexNames(catalog)
  const properties = {}
  const uiSchema = {}
  const required = []

  for (const name of Array.isArray(collect) ? collect : []) {
    const hit = index.get(name)
    if (!hit) {
      warnings.push(`ignored unknown flag/arg "${name}"`)
      continue
    }
    if (Object.prototype.hasOwnProperty.call(properties, name)) continue
    if (FORBIDDEN_KEYS.has(name)) {
      warnings.push(`refused unsafe field name "${name}"`)
      continue
    }
    if (hit.kind === 'flag') {
      safeSet(properties, name, fieldForFlag(hit.def))
    } else {
      safeSet(properties, name, fieldForArg(hit.def))
      if (!hit.def.optional) required.push(name)
    }
    // Auto-hint obvious file/path flags & args so the form renders a browser. The
    // model can override (or drop) any of these via its own uiSchema downstream.
    const hint = pathHint(hit)
    if (hint) {
      safeSet(uiSchema, name, { 'ui:widget': hint === 'dir' ? 'directory' : 'file' })
    }
  }

  // Free-form questions: accept either a full schema ({ properties, required })
  // or a bare properties map. Untrusted — drop forbidden keys, hardening does
  // the rest in fromSchema.
  if (questions && typeof questions === 'object') {
    const qprops =
      questions.properties && typeof questions.properties === 'object'
        ? questions.properties
        : questions
    for (const key of Object.keys(qprops)) {
      if (FORBIDDEN_KEYS.has(key)) {
        warnings.push(`refused unsafe question name "${key}"`)
        continue
      }
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        warnings.push(`free-form question "${key}" collides with a flag/arg; kept the flag/arg`)
        continue
      }
      safeSet(properties, key, qprops[key])
    }
    if (Array.isArray(questions.required)) {
      for (const r of questions.required) {
        if (typeof r === 'string' && !FORBIDDEN_KEYS.has(r) && !required.includes(r)) {
          required.push(r)
        }
      }
    }
  }

  const schema = { type: 'object', properties }
  if (required.length) schema.required = required
  return { schema, uiSchema, warnings }
}

// Detect whether a collected flag/arg is a file or directory path, by its name
// and its description/help. Booleans, choice flags, and repeatable (multi) flags
// are never paths — they're confirms/selects/text. Returns 'file' | 'dir' | null.
//
// The name is split into tokens (camelCase, kebab- and snake_case all handled, so
// `outputFile` → ['output','file']) and matched whole-token against the sets —
// `profile` and `configure` are single tokens that DON'T match 'file'/'config'.
const DIR_TOKENS = new Set(['dir', 'dirs', 'directory', 'directories', 'folder', 'folders'])
// Strong, mostly-unambiguous path words. Deliberately NOT here: dest/destination/
// target/source — they name a place or object as often as a file (e.g. a nav
// destination, a scan target), so a name alone shouldn't trigger a file picker. A
// description that says "path"/"file" still catches the real ones (see FILE_TEXT),
// and the dev/model can always hint a `dest <path>` explicitly.
const FILE_TOKENS = new Set([
  'file',
  'files',
  'filename',
  'filenames',
  'logfile',
  'certfile',
  'keyfile',
  'path',
  'paths',
  'output',
  'input',
  'config',
  'conf',
  'src',
  'out',
  'log',
  'cert'
])
const DIR_TEXT = /\b(directory|directories|folder|folders)\b/i
const FILE_TEXT = /\bpath to\b|\bfile(name)?s?\b/i

function nameTokens(name) {
  return String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // split camelCase boundaries
    .split(/[-_\s]+/)
    .map((t) => t.toLowerCase())
    .filter(Boolean)
}

function pathHint(hit) {
  const def = hit.def
  if (hit.kind === 'flag' && (def.boolean || def.multi)) return null
  if (Array.isArray(def.choices) && def.choices.length) return null
  const toks = nameTokens(def.name)
  const text = `${def.description || ''} ${def.help || ''}`
  if (toks.some((t) => DIR_TOKENS.has(t)) || DIR_TEXT.test(text)) return 'dir'
  if (toks.some((t) => FILE_TOKENS.has(t)) || FILE_TEXT.test(text)) return 'file'
  return null
}

// Merge an auto-generated uiSchema with the model's: per-field, the model's keys
// win (it can override the auto hint, e.g. file → textarea, or add a placeholder),
// and forbidden keys are dropped on both sides. Strings stay untrusted — they're
// cleaned downstream by fromSchema.
function mergeUiSchema(auto, model) {
  const out = {}
  for (const k of Object.keys(auto || {})) {
    if (FORBIDDEN_KEYS.has(k)) continue
    safeSet(out, k, auto[k])
  }
  if (model && typeof model === 'object') {
    for (const k of Object.keys(model)) {
      if (FORBIDDEN_KEYS.has(k)) continue
      const a = out[k]
      const m = model[k]
      const mergeable = (v) => v && typeof v === 'object' && !Array.isArray(v)
      safeSet(out, k, mergeable(a) && mergeable(m) ? { ...a, ...m } : m)
    }
  }
  return out
}

// Build a form for ONE command (a single catalog node) collecting ALL its
// flags+args — the no-AI menu path. Unlike buildSchema (which indexes names across
// the whole tree for the model's `collect`), this reads the node directly, so
// flags shared across subcommands (e.g. --store) never collide. Returns
// { schema, uiSchema }; rest args become a list field under REST_KEY.
function nodeSchema(node = {}) {
  const properties = {}
  const uiSchema = {}
  const required = []

  for (const a of node.args || []) {
    if (FORBIDDEN_KEYS.has(a.name)) continue
    safeSet(properties, a.name, fieldForArg(a))
    if (!a.optional) required.push(a.name)
    const hint = pathHint({ kind: 'arg', def: a })
    if (hint) safeSet(uiSchema, a.name, { 'ui:widget': hint === 'dir' ? 'directory' : 'file' })
  }

  for (const f of node.flags || []) {
    if (FORBIDDEN_KEYS.has(f.name)) continue
    safeSet(properties, f.name, fieldForFlag(f))
    const hint = pathHint({ kind: 'flag', def: f })
    if (hint) safeSet(uiSchema, f.name, { 'ui:widget': hint === 'dir' ? 'directory' : 'file' })
  }

  if (node.rest) {
    safeSet(properties, REST_KEY, {
      type: 'array',
      items: { type: 'string' },
      title: cleanTitle(node.rest),
      description: node.rest.description || ''
    })
  }

  const schema = { type: 'object', properties }
  if (required.length) schema.required = required
  return { schema, uiSchema }
}

function cleanTitle(rest) {
  const help = (rest.help || '').replace(/[<>[\].]/g, '').trim()
  return help || 'additional arguments'
}

// Flatten the catalog tree into name → { kind:'flag'|'arg', def }. On a name
// collision across subcommands, the first (shallowest) definition wins.
function indexNames(catalog) {
  const index = new Map()
  walk(catalog)
  return index

  function walk(node) {
    for (const f of node.flags || []) {
      if (!index.has(f.name)) index.set(f.name, { kind: 'flag', def: f })
    }
    for (const a of node.args || []) {
      if (!index.has(a.name)) index.set(a.name, { kind: 'arg', def: a })
    }
    for (const sub of node.subcommands || []) walk(sub)
  }
}

function fieldForFlag(f) {
  const title = f.name
  const description = f.description || ''

  if (f.boolean) {
    return { type: 'boolean', title, description, inverse: f.inverse, default: false }
  }
  if (Array.isArray(f.choices) && f.choices.length) {
    const p = { type: 'string', title, description, enum: f.choices.slice() }
    if (f.hasDefault && f.choices.includes(f.default)) p.default = f.default
    return p
  }
  if (f.multi) {
    // Repeatable flag → an editable list of values (the form's list field). The
    // collected value is an array; the model repeats the flag for each entry.
    return { type: 'array', title, description, items: { type: 'string' } }
  }
  const p = { type: 'string', title, description }
  if (f.hasDefault && f.default !== undefined && f.default !== null) p.default = String(f.default)
  return p
}

function fieldForArg(a) {
  return { type: 'string', title: a.name, description: a.description || a.help || '' }
}

// Set an OWN property even for keys like '__proto__' without touching the
// prototype chain (defineProperty, not bracket assignment).
function safeSet(obj, key, value) {
  Object.defineProperty(obj, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true
  })
}

module.exports = { buildSchema, nodeSchema, indexNames, pathHint, mergeUiSchema }
