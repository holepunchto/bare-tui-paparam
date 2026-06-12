// Public entry points — the no-AI tier.
//
//   isMenuMode(argv, flag)   — did the user pass `--menu` (or your flag)?
//   menuHelp(command, opts)  — build the no-AI menu TUI and run it.
//   runMenu(command, opts)   — menuHelp + confirm + run-for-real.
//   buildMenuApp(...)        — construct a MenuApp without running the TUI
//                              (embedding/tests; the single dev-opt mapping point).
//
// The AI tiers (`--hi`, `--find`) and providers live in the optional
// `bare-tui-paparam-ai` package, which re-exports everything here. A MenuApp
// accepts injected `router`/`helper` extras, so the `-ai` package layers the AI
// in without this file knowing anything about it.
const { MenuApp } = require('./menu-app')
const { introspect } = require('./introspect')

// True if `flag` appears in argv (defaulting to Bare.argv minus the runtime+script).
function hasFlag(argv, flag) {
  let list = argv
  if (!Array.isArray(list)) {
    list = typeof Bare !== 'undefined' && Bare.argv ? Bare.argv.slice(2) : []
  }
  return list.includes(flag)
}

// True if `flag` (default '--menu') appears in argv — the no-AI menu trigger.
function isMenuMode(argv, flag = '--menu') {
  return hasFlag(argv, flag)
}

// Construct a MenuApp from a command + opts WITHOUT running the TUI — the single
// place the dev options (uiSchema, validators, validateSubmission, fieldHelp,
// helpKeys) are mapped onto the app, so menu and route modes stay in sync (and the
// wiring is unit-testable). `extras` carries the route-mode router/helper (supplied
// by bare-tui-paparam-ai) and lets callers reuse an already-built catalog.
function buildMenuApp(command, opts = {}, extras = {}) {
  if (!command || typeof command.parse !== 'function') {
    throw new Error('buildMenuApp requires a paparam command')
  }
  const catalog = extras.catalog || introspect(command).catalog
  return new MenuApp({
    command,
    catalog,
    toolName: opts.toolName || command.name,
    uiSchema: opts.uiSchema,
    validators: opts.validators,
    validateSubmission: opts.validateSubmission,
    fieldHelp: opts.fieldHelp,
    helpKeys: opts.helpKeys,
    router: extras.router || null,
    helper: extras.helper || null
  })
}

// Build a no-AI menu guide and run the TUI. Resolves with the MenuApp (read
// `app.confirmed`). No provider needed — this is the zero-AI tier. Dev `fieldHelp`
// still drives static per-field help in the menu.
//   opts: toolName, uiSchema, validators, validateSubmission, fieldHelp, mouse
function menuHelp(command, opts = {}) {
  const { Program } = require('bare-tui')
  const app = buildMenuApp(command, opts)
  return new Program(app, { mouse: opts.mouse !== false }).run()
}

// Run the menu, then run-for-real on confirm. Resolves with the confirmed
// { run, argv, result } or null if the user quit without confirming.
async function runMenu(command, opts = {}) {
  const { onComplete, ...rest } = opts
  const app = await menuHelp(command, rest)
  const confirmed = app && app.confirmed
  if (confirmed && confirmed.run) {
    if (typeof onComplete === 'function') {
      await onComplete(confirmed.result, { argv: confirmed.argv })
    } else {
      command.parse(confirmed.argv)
    }
  }
  return confirmed || null
}

module.exports = {
  hasFlag,
  isMenuMode,
  buildMenuApp,
  menuHelp,
  runMenu
}
