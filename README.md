# bare-tui-paparam

**A menu/form helper for any [paparam] CLI.** Your tool already describes its whole surface in paparam — flags, args, subcommands, choices, defaults, descriptions. Add one line and `mytool --menu` drops the user into a filterable command picker, then a **real terminal form** for the command they chose, and finishes by handing you a result in the **exact shape paparam's `parse()` returns**.

```
   mytool --menu
        │
        ▼
   ┌──────────────┐   pick a command   ┌───────────────┐
   │  command     │ ─────────────────▶ │ bare-tui-form │ ──▶ fill it in
   │  picker      │                    │  (hardened)   │
   │ (filterable) │                    └───────────────┘
   └──────────────┘                            │
                                               ▼
              cmd.parse(argv, { run:false })   ← paparam validates; no runner fires
                      │
                      ▼
        onComplete(result, { argv })   ← result is paparam's parse() shape
```

The forms are generated from your **real** flag/arg metadata (a flag with `.choices()` becomes a picker, a boolean becomes a checkbox, defaults are prefilled, repeatables become editable lists). The argv it assembles is run through **your own command** with `{ run: false }` — so paparam itself validates it (unknown flag, missing arg, bad choice, your own `validate()` checks) and yields the canonical result **without executing your runner** until you say so.

Built on [bare-tui] and [bare-tui-form] (forms from JSON Schema, rendered through its hardening).

## Want AI assist?

Install the optional **[`bare-tui-paparam-ai`]** package. It **re-exports everything here** and adds:

- **`--find`** — type your goal in plain language; one AI call routes it to the right command, then shows that command's form.
- **`--hi`** — full agentic assist: the model curates which fields to ask and drip-feeds questions.
- **AI-backed in-form help** — press F1 / ctrl+k mid-form to ask a question.

Upgrading is a **one-line import change** — your `--menu` / `runMenu` code keeps working unchanged:

```js
// before — no network
const { isMenuMode, runMenu } = require('bare-tui-paparam')
// after — AI tiers light up; menu code is untouched
const { isMenuMode, runMenu, isInteractiveHelp, runWithConfirm } = require('bare-tui-paparam-ai')
```

## Install

```sh
npm install bare-tui-paparam bare-tui paparam
```

Runs on [Bare](https://bare.pears.com)

## Quick start

```js
const { command, flag, arg } = require('paparam')
const { isMenuMode, runMenu } = require('bare-tui-paparam')

const cmd = command(
  'run',
  arg('<link>', 'pear:// link or path to run'),
  flag('--store|-s [path]', 'storage path').default('./store'),
  flag('--mode|-m [mode]', 'how to run').choices(['terminal', 'desktop']),
  function run(c) {
    /* your real runner */
  }
)

if (isMenuMode(Bare.argv)) {
  // menu → pick a command → fill the form → confirm → run for real
  runMenu(cmd, { onComplete: (result, { argv }) => cmd.parse(argv) })
} else {
  cmd.parse(Bare.argv.slice(2)) // the normal CLI
}
```

Run it: `bare mytool.js --menu`. See [`examples/orbital-menu.js`](examples/orbital-menu.js) for a large multi-command tool exercising every field type.

## Entry points

- `isMenuMode(argv, flag = '--menu')` → did the user pass `--menu`?
- `menuHelp(command, opts)` → run the menu TUI; resolves the `MenuApp` (read
  `app.confirmed`).
- `runMenu(command, opts)` → `menuHelp` + confirm + run-for-real (or your
  `onComplete`).
- `buildMenuApp(command, opts, extras?)` → construct a `MenuApp` without running
  the TUI (embedding / tests).

### Options

- `uiSchema` — display hints per field (`{ flag: { 'ui:widget': 'file' | 'directory' 'textarea' | 'password' } }`). Path-like fields are auto-detected; this covers the ones a name/description doesn't reveal.
- `validators` — `{ <flag-or-arg name>: (value, { values }) => err | null }`.
- `validateSubmission` — `(result) => err | null`, the final whole-submission gate.
- `fieldHelp` — `{ <flag-or-arg name>: 'a note' }`. Drives the offline per-field help (F1 / ctrl+k shows the note for the focused field). You can also author these on the command itself with paparam's `.hint('…')`.
- `helpKeys` — override the help keys (default `['f1', 'ctrl+k']`).
- `onComplete` — `(result, { argv }) => any`, runs after the TUI exits instead of
  the default `command.parse`.

[paparam]: https://github.com/holepunchto/paparam
[bare-tui]: https://github.com/holepunchto/bare-tui
[bare-tui-form]: https://github.com/holepunchto/bare-tui-form
[`bare-tui-paparam-ai`]: https://github.com/holepunchto/bare-tui-paparam-ai
