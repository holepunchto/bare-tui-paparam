// MenuApp — Tier 0 (no-AI menu) and Tier 1 (one-shot AI routing) command picker.
//
// The deterministic floor of the help ladder. The user reaches a command one of
// two ways, then everything after is identical and AI-free: fill the full form
// for that command → confirm → the assembled argv is validated through the real
// command (parse with run:false) and the dev's validateSubmission → `this.confirmed`
// is set and the TUI quits so the caller runs it for real.
//
//   Tier 0 (no router): pick a command from a flat, filterable list.
//   Tier 1 (a `router`): type a goal; ONE model call routes it to a command. The
//     list is still there as the manual fallback (and if the router can't match).
//
// Reuses the deterministic core (valuesToArgv + nodeSchema + evaluateArgv) the AI
// tiers also build on.
//
// Flow: [prompt → routing →] menu → forming → confirming → quit(confirmed). A
// single-command tool skips straight to its form.
const { quit, batch, key, style, list, textinput, spinner } = require('bare-tui')
const form = require('bare-tui-form')
const { nodeSchema, mergeUiSchema } = require('./fields')
const { attachValidators } = require('./validators')
const { valuesToArgv } = require('./argv')
const { evaluateArgv } = require('./evaluate')
const { helpContext } = require('./help-context')
const { HelpOverlay, DEFAULT_HELP_KEYS, helpKeysLabel } = require('./help-overlay')

const accent = (s) => style().bold(true).foreground('#5BC8FF').render(s)
const dim = (s) => style().faint(true).render(s)
const cmdStyle = (s) => style().bold(true).foreground('#39FF14').render(s)
const errStyle = (s) => style().foreground('#FF6B6B').render(s)

function wrap(text, w) {
  const out = []
  let line = ''
  for (const word of String(text).split(' ')) {
    if (line && style.width(line) + 1 + style.width(word) > w) {
      out.push(line)
      line = word
    } else {
      line = line ? line + ' ' + word : word
    }
  }
  if (line) out.push(line)
  return out
}

// Flatten the catalog into a flat list of runnable commands, each labelled by its
// full subcommand path ("cargo load") with the program-root name dropped.
//
// paparam gives every command a runner (a noop dispatcher on parents), so "has a
// runner" can't tell a real command from a namespace. We use the structure
// instead: a node is a command if it's a LEAF (no subcommands), or a parent that
// also takes its own positional args (a directly-invokable parent). Pure
// namespaces (subcommands, no own args — like `cargo`/`crew`) are skipped.
function isCommand(node) {
  const hasSubs = ((node && node.subcommands) || []).length > 0
  if (!hasSubs) return true
  return ((node && node.args) || []).length > 0
}

function runnableCommands(catalog) {
  const out = []
  walk(catalog, [])
  return out
  function walk(node, path) {
    if (isCommand(node)) {
      const label = path.length ? path.join(' ') : node.name || ''
      const summary = node.summary || node.header || ''
      out.push({ title: summary ? `${label} — ${summary}` : label, label, node, path })
    }
    for (const sub of (node && node.subcommands) || []) walk(sub, path.concat(sub.name))
  }
}

class MenuApp {
  // opts: { command, catalog, toolName, uiSchema, validators, validateSubmission,
  //         router } — router (Tier 1) is async (goal) => commandItem | null.
  constructor(opts = {}) {
    if (!opts.command || typeof opts.command.parse !== 'function') {
      throw new Error('MenuApp requires a paparam command')
    }
    this.command = opts.command
    this.catalog = opts.catalog
    this.toolName = opts.toolName || (this.catalog && this.catalog.name) || 'tool'
    this.devUiSchema = opts.uiSchema || null
    this.validators = opts.validators || null
    this.validateSubmission =
      typeof opts.validateSubmission === 'function' ? opts.validateSubmission : null
    this.router = typeof opts.router === 'function' ? opts.router : null
    // In-form help (F1 / ctrl+k): an answer-only Q&A overlay.
    this.helper = typeof opts.helper === 'function' ? opts.helper : null
    this.fieldHelp = opts.fieldHelp && typeof opts.fieldHelp === 'object' ? opts.fieldHelp : null
    this.helpKeys = Array.isArray(opts.helpKeys) ? opts.helpKeys : DEFAULT_HELP_KEYS
    this.help = null

    this.width = 80
    this.height = 24

    // Public result, read after the program exits: { run, argv, result }.
    this.confirmed = null

    this.form = null
    this.formError = ''
    this._pending = null // { node, path, item }
    this._pendingConfirm = null
    this._confirmLine = ''
    this._confirmYes = ''
    this._lastValues = null

    // Tier 1 routing.
    this.prompt = null
    this.spinner = null
    this.notice = '' // shown above the menu (e.g. "couldn't match …")
    this._routedGoal = ''

    this.commands = runnableCommands(this.catalog)
    this.menu = null

    if (this.commands.length <= 1) {
      // Single command (or a degenerate empty tree): straight to the form.
      this.state = 'forming'
      if (this.commands[0]) this._buildForm(this.commands[0])
    } else if (this.router) {
      // Tier 1: ask for a goal first; the list is the fallback.
      this.state = 'prompt'
      this.prompt = textinput.create({ placeholder: 'describe what you want…', prompt: '› ' })
      this.prompt.focus()
    } else {
      this.state = 'menu'
      this.menu = list.create({ items: this.commands, filterable: true })
    }
  }

  init() {
    if (this.state === 'menu') {
      this._sizeMenu()
      return null
    }
    if (this.form) return this._initForm()
    return null
  }

  update(msg) {
    if (msg && msg.type === 'resize') {
      this.width = msg.width || this.width
      this.height = msg.height || this.height
      if (this.help) this._layoutHelp()
      else if (this.state === 'menu') this._sizeMenu()
      else if (this.form) {
        this.form.update({ type: 'resize', width: this.width, height: this._formHeight() })
      }
      return [this, null]
    }

    // While the help panel is open it owns input (spinner.tick / keys / answer);
    // closing it restores the form untouched.
    if (this.help) return this._updateHelp(msg)

    if (msg && msg.type === 'spinner.tick') {
      if (this.state === 'routing' && this.spinner) {
        const [s, cmd] = this.spinner.update(msg)
        this.spinner = s
        return [this, cmd]
      }
      return [this, null]
    }

    if (msg && msg.type === 'menu.routed') return this._onRouted(msg)
    if (msg && msg.type === 'menu.evaluated') return this._onEvaluated(msg)

    // Embedded-form contract.
    if (msg && msg.type === 'form.submit') {
      if (this.state === 'confirming') return this._confirmAnswer(msg.values)
      return this._submitForm(msg.values)
    }
    if (msg && msg.type === 'form.cancel') {
      if (this.state === 'confirming') return this._confirmAnswer(null)
      return this._backToMenu()
    }

    // ctrl+c: inside a form it backs up (the form emits form.cancel); everywhere
    // else (prompt, routing, menu, single-command) it quits.
    if (key.matches(msg, 'ctrl+c')) {
      if ((this.state === 'forming' || this.state === 'confirming') && this.form) {
        const [f, cmd] = this.form.update(msg)
        this.form = f
        return [this, cmd]
      }
      return [this, quit]
    }

    // Tier 1 goal prompt: enter routes a typed goal; an empty enter browses all.
    if (this.state === 'prompt') {
      if (key.matches(msg, 'enter')) {
        const goal = (this.prompt.value || '').trim()
        if (!goal) return this._toMenu()
        return this._route(goal)
      }
      const [p, cmd] = this.prompt.update(msg)
      this.prompt = p
      return [this, cmd]
    }

    if (this.state === 'routing') return [this, null] // busy; ignore keys

    if (this.state === 'menu') {
      // Enter chooses the highlighted command — unless the list is mid-filter,
      // where enter belongs to the filter editor.
      if (key.matches(msg, 'enter') && !this.menu.filtering) {
        const item = this.menu.selectedItem()
        if (!item) return [this, null]
        this._buildForm(item)
        return [this, this._initForm()]
      }
      const [m] = this.menu.update(msg)
      this.menu = m
      return [this, null]
    }

    // A help key opens help while filling a command form — the AI Q&A overlay if
    // a provider is available, or a static panel for the focused field's dev note.
    if (
      this.state === 'forming' &&
      (this.helper || this._focusedFieldNote()) &&
      key.matches(msg, ...this.helpKeys)
    ) {
      return this._openHelp()
    }

    if (this.form) {
      const [f, cmd] = this.form.update(msg)
      this.form = f
      return [this, cmd]
    }
    return [this, null]
  }

  view() {
    const header = accent('  ' + this.toolName) + dim(' · menu')

    if (this.state === 'prompt') {
      return [
        header,
        '',
        dim('  What do you want to do? Describe it and press enter.'),
        '',
        '  ' + this.prompt.view(),
        '',
        dim('  enter to find the command · empty enter to browse all · ctrl+c quit')
      ].join('\n')
    }

    if (this.state === 'routing') {
      const sp = this.spinner ? this.spinner.view() : '…'
      return [header, '', '  ' + accent(sp) + ' ' + dim('finding the right command…')].join('\n')
    }

    if (this.state === 'menu') {
      const lines = [header, '']
      if (this.notice) {
        for (const l of wrap(this.notice, this.width - 4)) lines.push('  ' + dim(l))
        lines.push('')
      } else {
        lines.push(dim('  Pick a command — / to filter, enter to choose.'), '')
      }
      lines.push(this.menu.view(), '', dim('  enter choose · / filter · ctrl+c quit'))
      return lines.join('\n')
    }

    const lines = [header, '']
    if (this._pending) {
      lines.push(accent('  ' + (this.toolName + ' ' + this._pending.item.label).trim()))
      const sum = this._pending.node.summary || ''
      if (sum) lines.push(dim('  ' + sum))
      if (this._routedGoal) lines.push(dim('  goal: ' + this._routedGoal))
      lines.push('')
    }
    if (this.formError) {
      for (const l of wrap(this.formError, this.width - 4)) lines.push('  ' + errStyle('✗ ' + l))
      lines.push('')
    }
    if (this.state === 'confirming') {
      lines.push('  ' + cmdStyle('$ ' + this._confirmLine), '')
    }
    if (this.form) lines.push(this.form.view())
    // A legend for the in-form help key (shown for the AI, or when the focused
    // field has a dev note), then the help panel itself when open.
    if (this.state === 'forming' && !this.help) {
      const legend = this._helpLegend()
      if (legend) lines.push(dim('  ' + legend))
    }
    if (this.help) lines.push(this.help.view())
    return lines.join('\n')
  }

  // ── internals ──────────────────────────────────────────────────────────

  _buildForm(item, formData) {
    const { schema, uiSchema: autoUi } = nodeSchema(item.node)
    const ui = mergeUiSchema(autoUi, this.devUiSchema)
    const built = form.fromSchema(schema, { uiSchema: ui, formData })
    attachValidators(built, this.validators)
    this.form = built
    this._pending = { node: item.node, path: item.path, item }
    this.formError = ''
    this._routedGoal = '' // a manual pick; _onRouted re-sets this for routed opens
    this.state = 'forming'
  }

  _initForm() {
    this.form.update({ type: 'resize', width: this.width, height: this._formHeight() })
    return typeof this.form.init === 'function' ? this.form.init() : null
  }

  // Lines the forming/confirming view spends OUTSIDE the form (header, blank,
  // command breadcrumb, any error, the confirm line). The form is sized to fit in
  // what's left so the help legend below it isn't pushed off the screen.
  _aboveFormLines() {
    let n = 2 // header + blank
    if (this._pending) {
      n += 1 // "tool command label"
      if (this._pending.node && this._pending.node.summary) n += 1
      if (this._routedGoal) n += 1
      n += 1 // trailing blank
    }
    if (this.formError) n += wrap(this.formError, this.width - 4).length + 1
    if (this.state === 'confirming') n += 2 // "$ line" + blank
    return n
  }

  // Reserve a row for the help legend whenever help is possible this session.
  _legendReserve() {
    return this.state === 'forming' && (this.helper || this.fieldHelp) ? 1 : 0
  }

  _formHeight() {
    return Math.max(3, this.height - this._aboveFormLines() - this._legendReserve())
  }

  // ── in-form help (F1 / ctrl+k) ───────────────────────────────────────────

  _openHelp() {
    const field = this.form && this.form.ring ? this.form.ring.focused() : null
    const context = helpContext({
      toolName: this.toolName,
      path: this._pending ? this._pending.path : [],
      field,
      fieldHelp: this.fieldHelp
    })
    // With a provider → AI Q&A (the note rides in the context). Without one → a
    // static panel showing the focused field's dev note.
    this.help = new HelpOverlay({ ask: this.helper, context, note: this._focusedFieldNote() })
    this._layoutHelp()
    return [this, null]
  }

  // The dev's fieldHelp note for the currently focused field, or null.
  _focusedFieldNote() {
    if (!this.fieldHelp || !this.form || !this.form.ring) return null
    const f = this.form.ring.focused()
    const note = f && f.key ? this.fieldHelp[f.key] : null
    return typeof note === 'string' && note.trim() ? note.trim() : null
  }

  // The footer legend for help: the AI prompt when a provider is available, else a
  // per-field hint that only appears when the focused field actually has a note.
  _helpLegend() {
    if (this.helper) return helpKeysLabel(this.helpKeys) + ' · ask the AI about this command'
    return this._focusedFieldNote() ? helpKeysLabel(this.helpKeys) + ' · help for this field' : ''
  }

  _layoutHelp() {
    // The form and the help panel share the space below the breadcrumb chrome.
    const avail = Math.max(6, this.height - this._aboveFormLines())
    const panelH = Math.max(5, Math.floor(avail / 2))
    const formH = Math.max(3, avail - panelH)
    if (this.form) this.form.update({ type: 'resize', width: this.width, height: formH })
    this.help.setSize(Math.max(20, this.width - 2), panelH)
  }

  _updateHelp(msg) {
    const [o, cmd] = this.help.update(msg)
    this.help = o
    if (o.closed) {
      this.help = null
      if (this.form) {
        this.form.update({ type: 'resize', width: this.width, height: this._formHeight() })
      }
      return [this, null]
    }
    return [this, cmd]
  }

  _submitForm(values) {
    if (values === null) return this._backToMenu()
    this._lastValues = values
    const argv = valuesToArgv(this._pending.node, this._pending.path, values)
    // Validate off the update path; the result comes back as a menu.evaluated Msg.
    const cmd = () =>
      evaluateArgv(this.command, argv, { validateSubmission: this.validateSubmission })
        .then((res) => ({ type: 'menu.evaluated', argv, values, ...res }))
        .catch((err) => ({
          type: 'menu.evaluated',
          argv,
          values,
          error: (err && err.message) || String(err)
        }))
    return [this, cmd]
  }

  _onEvaluated(msg) {
    if (msg.error) {
      // Re-open the form prefilled so the user can fix it; show the error above.
      this._buildForm(this._pending.item, msg.values)
      this.formError = msg.error
      return [this, this._initForm()]
    }
    this._pendingConfirm = { run: true, argv: msg.argv, result: msg.result }
    this._confirmLine = (this.toolName + ' ' + msg.argv.join(' ')).trim()
    this.form = this._buildConfirm()
    this.state = 'confirming'
    return [this, this._initForm()]
  }

  _buildConfirm() {
    this._confirmYes = 'Yes — run it'
    return form.create({
      title: 'Run this command?',
      fields: [
        form.radio({
          name: 'choice',
          label: 'Proceed?',
          description: 'Run the command above for real, or go back and change it.',
          options: [this._confirmYes, 'No — change something'],
          selected: 0
        })
      ]
    })
  }

  _confirmAnswer(values) {
    const yes = values && values.choice === this._confirmYes
    if (yes) {
      this.confirmed = this._pendingConfirm
      this._pendingConfirm = null
      return [this, quit]
    }
    // No → back to the form, prefilled, to tweak.
    this._pendingConfirm = null
    this._buildForm(this._pending.item, this._lastValues)
    return [this, this._initForm()]
  }

  // ── Tier 1 routing ───────────────────────────────────────────────────────

  _route(goal) {
    this.state = 'routing'
    this._routedGoal = goal
    this.spinner = spinner.create({ fps: 12 })
    const router = this.router
    const cmd = () =>
      Promise.resolve()
        .then(() => router(goal))
        .then((item) => ({ type: 'menu.routed', goal, item: item || null }))
        .catch((err) => ({
          type: 'menu.routed',
          goal,
          item: null,
          error: (err && err.message) || String(err)
        }))
    return [this, batch(this.spinner.init(), cmd)]
  }

  _onRouted(msg) {
    this.spinner = null
    if (msg.item) {
      this._buildForm(msg.item)
      this._routedGoal = msg.goal // shown as context above the form
      return [this, this._initForm()]
    }
    // No match → drop to the manual menu with a note explaining why.
    this.notice = msg.error
      ? `Routing failed (${msg.error}). Pick a command:`
      : `Couldn't match “${msg.goal}”. Pick a command:`
    return this._toMenu(this.notice)
  }

  _toMenu(notice = '') {
    this._ensureMenu()
    this.notice = notice
    this.state = 'menu'
    this._sizeMenu()
    return [this, null]
  }

  _ensureMenu() {
    if (!this.menu) this.menu = list.create({ items: this.commands, filterable: true })
  }

  _backToMenu() {
    if (this.commands.length <= 1) return [this, quit] // nothing to go back to
    this.form = null
    this.formError = ''
    this._pending = null
    this._routedGoal = ''
    return this._toMenu('')
  }

  _sizeMenu() {
    if (!this.menu) return
    this.menu.width = Math.max(20, this.width - 2)
    this.menu.height = Math.max(3, this._bodyHeight() - 3)
  }

  _bodyHeight() {
    return Math.max(3, this.height - 4)
  }
}

module.exports = { MenuApp, runnableCommands }
