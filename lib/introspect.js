// Introspection — read EVERYTHING a paparam command knows, two ways.
//
// A paparam `command(...)` is fully walkable at runtime: its flags, args, rest,
// subcommands, and every description/choice/default live on internal fields.
// We turn that into:
//
//   catalog  — a structured, machine-shaped tree the form builder reads to
//              generate fields from real flags/args (choices, defaults, types).
//   docsText — a human-readable brief for the system prompt: paparam's own
//              rendered help + a precise list of the EXACT names the model must
//              use in ask_user.collect (paparam camel-cases flag/arg names, and
//              those are the keys the form is built around).
//
// Everything derived from the command is run through cleanText: a paparam
// definition is the dev's own (trusted) code, but descriptions can still contain
// stray control bytes, and the same string later reaches the terminal.
const { cleanText } = require('bare-tui-form/harden')

// cleanText strips ALL control bytes including newlines/tabs, which is right for
// a single-line label but flattens paparam's multi-line help() layout into one
// run-on line. For the help/overview blobs (the dev's own trusted output, bound
// for the LLM prompt rather than straight to the terminal) we keep \n and \t and
// strip everything else — so ESC/OSC injection is still neutralized but the
// layout the model reads stays intact.
const NON_LAYOUT_CONTROL = new RegExp('[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f]', 'g')
function cleanMultiline(value) {
  return String(value || '').replace(NON_LAYOUT_CONTROL, '')
}

function introspect(command) {
  const catalog = catalogOf(command)
  const docsText = docsTextOf(command, catalog)
  return { catalog, docsText }
}

// A paparam Command → { name, summary, description, flags[], args[], rest, subcommands[] }.
function catalogOf(command) {
  const node = {
    name: command.name || '',
    header: cleanText(command.header || ''),
    summary: cleanText(command.summary || ''),
    description: cleanText(command.description || ''),
    flags: [],
    args: [],
    rest: null,
    subcommands: []
  }

  // _definedFlags is keyed by BOTH the primary name and every alias (all pointing
  // at the same Flag). Keep only the primary entry (key === flag.name), and drop
  // the built-in help flag and any hidden flag.
  for (const [key, flag] of command._definedFlags || new Map()) {
    if (key !== flag.name) continue
    if (flag.hidden || flag.name === 'help') continue
    node.flags.push({
      name: flag.name,
      aliases: Array.isArray(flag.aliases) ? flag.aliases.slice() : [],
      boolean: !!flag.boolean,
      multi: !!flag.multi,
      choices: Array.isArray(flag.valueChoices) ? flag.valueChoices.slice() : null,
      hasDefault: !!flag.hasDefault,
      default: flag.hasDefault ? flag.value : undefined,
      valueRequired: !!flag.valueRequired,
      description: cleanText(flag.description || '')
    })
  }

  for (const arg of command._definedArgs || []) {
    if (arg.hidden) continue
    node.args.push({
      name: arg.name,
      optional: !!arg.optional,
      help: cleanText(arg.help || ''),
      description: cleanText(arg.description || '')
    })
  }

  if (command._definedRest) {
    node.rest = {
      help: cleanText(command._definedRest.help || ''),
      description: cleanText(command._definedRest.description || '')
    }
  }

  for (const [, sub] of command._definedCommands || new Map()) {
    if (sub.hidden) continue
    node.subcommands.push(catalogOf(sub))
  }

  return node
}

// Build the docs brief: paparam's own help text, plus a precise name reference.
function docsTextOf(command, catalog) {
  const parts = []

  let help = ''
  try {
    help = command.help()
  } catch {
    // help() renders usage; if a malformed command throws, fall back to the catalog.
  }
  if (help) parts.push(cleanMultiline(help))

  if (catalog.subcommands.length) {
    let overview = ''
    try {
      overview = command.overview({ full: true })
    } catch {
      // ignore — the catalog reference below still lists every subcommand
    }
    if (overview) parts.push(cleanMultiline(overview))
  }

  parts.push('EXACT NAMES (use these in ask_user.collect and as flags in propose_argv):')
  parts.push(renderCatalog(catalog, ''))

  return parts.join('\n\n')
}

// A compact, indented reference of the real names the model must use.
function renderCatalog(node, indent) {
  const lines = []
  const head = node.name ? node.name : '(root)'
  lines.push(indent + 'command: ' + head + (node.summary ? ' — ' + node.summary : ''))

  if (node.args.length) {
    lines.push(indent + '  args:')
    for (const a of node.args) {
      const bits = [a.optional ? 'optional' : 'required']
      if (a.description) bits.push(a.description)
      lines.push(indent + '    <' + a.name + '> (' + bits.join('; ') + ')')
    }
  }

  if (node.flags.length) {
    lines.push(indent + '  flags:')
    for (const f of node.flags) {
      const bits = []
      bits.push(f.boolean ? 'boolean' : 'value')
      if (f.multi) bits.push('repeatable')
      if (f.choices) bits.push('choices: ' + f.choices.join(', '))
      if (f.hasDefault) bits.push('default: ' + f.default)
      const aliases = f.aliases.filter((a) => a !== f.name)
      if (aliases.length) bits.push('aliases: ' + aliases.join(', '))
      const desc = f.description ? ' — ' + f.description : ''
      lines.push(indent + '    --' + f.name + ' (' + bits.join('; ') + ')' + desc)
    }
  }

  if (node.rest) {
    lines.push(indent + '  rest: ' + (node.rest.help || '...') + ' ' + node.rest.description)
  }

  for (const sub of node.subcommands) {
    lines.push(renderCatalog(sub, indent + '  '))
  }

  return lines.join('\n')
}

module.exports = { introspect, catalogOf }
