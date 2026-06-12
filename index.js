// bare-tui-paparam — a no-AI, no-network menu/form helper for any paparam CLI.
//
// A CLI built with paparam already describes its whole surface — flags, args,
// subcommands, choices, defaults, descriptions. This package turns that into an
// interactive experience with ZERO network capability in the dependency tree:
// run your tool with `--menu`, pick a command from a filterable list, fill a
// REAL form (rendered through bare-tui-form's hardening), confirm, and get back
// the exact object paparam's parse() returns. Per-field help (F1 / ctrl+k) works
// offline too, sourced from your `.hint()`s / `fieldHelp` map.
//
//   const { command, flag, arg } = require('paparam')
//   const { isMenuMode, runMenu } = require('bare-tui-paparam')
//
//   const cmd = command('run', arg('<link>', 'the link'),
//     flag('--storage|-s [path]', 'store path').default('/tmp'),
//     async (c) => { /* the real runner */ })
//
//   if (isMenuMode(Bare.argv)) {
//     await runMenu(cmd, { onComplete: (result, { argv }) => cmd.parse(argv) })
//   } else {
//     cmd.parse(Bare.argv.slice(2))
//   }
//
// Want AI assist (`--hi` agentic help, `--find` one-shot routing)? Install the
// optional `bare-tui-paparam-ai` package — it re-exports everything here and adds
// the AI entry points, so upgrading is a one-line import change.
const { hasFlag, isMenuMode, menuHelp, runMenu, buildMenuApp } = require('./lib/paparam-guide')
const { MenuApp, runnableCommands } = require('./lib/menu-app')
const { HelpOverlay, DEFAULT_HELP_KEYS, helpKeysLabel } = require('./lib/help-overlay')
const { helpContext } = require('./lib/help-context')
const { introspect, catalogOf } = require('./lib/introspect')
const { buildSchema, nodeSchema, mergeUiSchema, pathHint } = require('./lib/fields')
const { valuesToArgv, REST_KEY } = require('./lib/argv')
const { evaluateArgv } = require('./lib/evaluate')
const { attachValidators } = require('./lib/validators')

module.exports = {
  // Entry points — no-AI menu (`--menu`)
  isMenuMode, // isMenuMode(argv, flag='--menu') → boolean
  menuHelp, // menuHelp(command, opts) → runs the menu TUI, resolves the app
  runMenu, // runMenu(command, opts) → menu + confirm + run-for-real
  buildMenuApp, // buildMenuApp(command, opts, extras?) → MenuApp (no TUI; for embedding/tests)
  hasFlag, // hasFlag(argv, flag) → boolean (the generic argv detector)

  // The pieces, exposed for customization / headless use / the -ai layer
  MenuApp,
  runnableCommands, // runnableCommands(catalog) → leaf/own-arg commands the menu offers
  HelpOverlay, // the in-form F1/ctrl+k Q&A overlay (static-note mode here; AI mode in -ai)
  DEFAULT_HELP_KEYS,
  helpKeysLabel,
  helpContext, // helpContext({ toolName, path, field, fieldHelp }) → focus pointer string
  introspect, // introspect(command) → { docsText, catalog }
  catalogOf,
  buildSchema, // buildSchema(catalog, { collect, questions }) → { schema, uiSchema, warnings }
  nodeSchema, // nodeSchema(node) → { schema, uiSchema } for one command (menu path)
  mergeUiSchema, // mergeUiSchema(auto, model) → merged uiSchema (safe-key merge)
  pathHint, // pathHint(entry) → 'file'|'dir'|null (path auto-detection)
  valuesToArgv, // valuesToArgv(node, path, values) → argv tokens (deterministic)
  REST_KEY, // the form key carrying paparam rest args
  evaluateArgv, // evaluateArgv(command, argv, { validateSubmission }) → { result } | { error }
  attachValidators
}
