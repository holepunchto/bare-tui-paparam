// valuesToArgv — turn a filled form's values into paparam argv tokens.
//
// This is the deterministic, AI-free counterpart to the model's `propose_argv`:
// given a catalog node (one command), its subcommand path, and the form values
// keyed by flag/arg name, it produces the exact tokens `command.parse` accepts.
//
// It aims for the MINIMAL correct command — a value left at its default, or an
// empty optional, is omitted (paparam fills defaults), so the confirmed line reads
// cleanly and teaches the user the shortest invocation.

// The reserved form-field key for a command's `rest` (trailing) arguments. Not a
// real flag/arg name (paparam names never start with '__'), so it can't collide.
const REST_KEY = '__rest'

// Is a form value present and non-blank? (Form fields return '' / [] / false
// rather than null, so this is mostly defensive.)
function isSet(v) {
  return v !== undefined && v !== null && String(v).trim() !== ''
}

function valuesToArgv(node, path, values = {}) {
  const argv = Array.isArray(path) ? path.filter(Boolean).map(String) : []

  // Positional args, in declaration order.
  for (const a of node.args || []) {
    const v = values[a.name]
    if (isSet(v)) argv.push(String(v))
  }

  // Flags.
  for (const f of node.flags || []) {
    const v = values[f.name]
    const long = longName(f)

    if (f.boolean) {
      const def = f.hasDefault ? !!f.default : false
      const actualValue = f.inverse ? !v : v
      const actualDefault = f.inverse ? !def : def
      // Emit only what differs from the default; paparam supports `--no-x`.
      if (actualValue === true && actualDefault !== true) argv.push('--' + long)
      else if (actualValue === false && actualDefault === true) argv.push('--no-' + long)
      continue
    }

    if (f.multi) {
      if (Array.isArray(v)) {
        for (const item of v) {
          if (isSet(item)) argv.push('--' + long, String(item))
        }
      }
      continue
    }

    // Single-value (or choice) flag: emit when set and not equal to the default.
    if (!isSet(v)) continue
    const s = String(v)
    const hasDef = f.hasDefault && f.default !== undefined && f.default !== null
    if (hasDef && s === String(f.default)) continue
    argv.push('--' + long, s)
  }

  // Rest (trailing) arguments, last.
  const rest = values[REST_KEY]
  if (Array.isArray(rest)) {
    for (const tok of rest) {
      if (isSet(tok)) argv.push(String(tok))
    }
  }

  return argv
}

// The canonical `--long` token to emit. Form values are keyed by the camelCased
// flag NAME (outDir), but the CLI token is the DECLARED long alias (out-dir), so
// we prefer the first multi-char alias and fall back to the name.
function longName(flag) {
  const long = (flag.aliases || []).find((a) => a.length > 1)
  return long || flag.name
}

module.exports = { valuesToArgv, REST_KEY, longName }
