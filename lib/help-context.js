// help-context — the per-request focus pointer for in-form help.
//
// Pure (no provider, no network): given the command path + the focused form
// field + the dev's optional per-field note, it builds the short "where the user
// is" string. Both the no-AI static help (MenuApp) and the AI helper (the `-ai`
// package's createHelper) feed off it, so it lives in the deterministic base.
//
//   const ctx = helpContext({ toolName, path, field, fieldHelp })

// The per-request focus pointer: which command + field the user is on (and its
// current value), plus the dev's per-field note for that field, if any. `path` is
// the subcommand path (e.g. ['cargo','load']); `field` is the focused form field.
function helpContext({ toolName, path, field, fieldHelp } = {}) {
  const where = [toolName, ...(Array.isArray(path) ? path : [])].filter(Boolean).join(' ')
  const lines = []
  if (where) lines.push(`The user is filling: \`${where}\`.`)
  if (field && field.key) {
    let value
    try {
      value = field.value()
    } catch {
      value = undefined
    }
    const shown = formatValue(value)
    const label = field.label && field.label !== field.key ? ` (${field.label})` : ''
    lines.push(
      `They are on the \`${field.key}\`${label} field${shown ? `, current value: ${shown}` : ''}.`
    )
    if (field.description) lines.push(`Field description: ${field.description}`)
    const note = fieldHelp && field.key ? fieldHelp[field.key] : null
    if (typeof note === 'string' && note.trim()) {
      lines.push(`Author note for this field: ${note.trim()}`)
    }
  }
  return lines.join('\n')
}

function formatValue(v) {
  if (v === undefined || v === null || v === '') return ''
  if (Array.isArray(v)) return v.length ? JSON.stringify(v) : ''
  return String(v)
}

module.exports = { helpContext }
