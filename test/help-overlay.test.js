// Tests for the in-form help overlay and its integration into MenuApp.
const test = require('brittle')
const { command, arg, flag } = require('paparam')
const { KeyMsg } = require('bare-tui')
const { HelpOverlay } = require('../lib/help-overlay')
const { MenuApp } = require('../lib/menu-app')
const { introspect } = require('../lib/introspect')

const key = (name, opts = {}) =>
  new KeyMsg({
    name,
    sequence: opts.sequence ?? name,
    ctrl: !!opts.ctrl,
    meta: false,
    shift: false
  })
const type = (target, s) => s.split('').forEach((c) => target.update(key(c, { sequence: c })))

test('overlay: asking → loading → answer; answer renders to wrapped lines', (t) => {
  const o = new HelpOverlay({ ask: (q) => `you asked: ${q}`, context: 'ctx' })
  o.setSize(60, 8)
  t.is(o.state, 'asking', 'starts asking')

  type(o, 'why')
  const [, cmd] = o.update(key('enter'))
  t.is(o.state, 'loading', 'enter with a question → loading')
  t.ok(cmd, 'an ask Cmd was returned')

  o.update({ type: 'help.answered', text: '**bold** and some prose to wrap' })
  t.is(o.state, 'answer', 'answer delivered')
  t.ok(o.answerLines.length > 0, 'answer rendered to (ANSI-aware) lines')
})

test('overlay: esc closes from any state', (t) => {
  const o = new HelpOverlay({ ask: () => 'x' })
  o.update(key('escape', { sequence: '\x1b' }))
  t.ok(o.closed, 'closed flag set for the host to dismiss')
})

test('overlay: enter on an answer re-opens the question box', (t) => {
  const o = new HelpOverlay({ ask: () => 'x' })
  o.setSize(60, 8)
  o.update({ type: 'help.answered', text: 'hi' })
  o.update(key('enter'))
  t.is(o.state, 'asking', 'ready for another question')
})

test('overlay: the ask Cmd resolves to a help.answered Msg (and surfaces errors)', async (t) => {
  const ok = new HelpOverlay({ ask: (q, { context }) => `A:${q}|${context}`, context: 'CTX' })
  const m1 = await ok._askCmd('Q')()
  t.is(m1.type, 'help.answered')
  t.is(m1.text, 'A:Q|CTX', 'question + context threaded to the helper')

  const bad = new HelpOverlay({
    ask: () => {
      throw new Error('boom')
    }
  })
  const m2 = await bad._askCmd('q')()
  t.is(m2.error, 'boom', 'helper errors come back as a help.answered error')
})

test('overlay: a note with no AI opens straight to a static panel', (t) => {
  const o = new HelpOverlay({ note: 'just so you know' })
  o.setSize(60, 8)
  t.is(o.state, 'answer', 'static note → answer state immediately')
  t.absent(o.ask, 'no AI in static mode')
  t.ok(o.answerLines.length > 0, 'note rendered to lines')
  const v = require('bare-tui').style.stripAnsi(o.view())
  t.ok(/just so you know/.test(v), 'the note is shown')
  t.absent(/ask another/.test(v), 'no "ask another" without an AI')
})

// ── integration with MenuApp ────────────────────────────────────────────────

const fixture = () => command('t', arg('<x>', 'the x'), flag('--y [y]', 'the y'), () => {})
const catalog = (cmd) => introspect(cmd).catalog

test('buildMenuApp: menu entry path forwards fieldHelp/helpKeys to the app', (t) => {
  const { buildMenuApp } = require('../lib/paparam-guide')
  const cmd = fixture()
  // Mirrors the aiHelpers object a dev passes to runMenu(cmd, aiHelpers).
  const app = buildMenuApp(cmd, { fieldHelp: { y: 'note for y' }, helpKeys: ['f1'] })
  t.alike(app.fieldHelp, { y: 'note for y' }, 'fieldHelp reached the menu app')
  t.alike(app.helpKeys, ['f1'], 'helpKeys reached the menu app')
  t.absent(app.helper, 'no provider → no AI helper (Tier 0)')
})

test('MenuApp (no AI): field-help legend + static panel only for fields with a note', (t) => {
  const cmd = fixture()
  const app = new MenuApp({
    command: cmd,
    catalog: catalog(cmd),
    toolName: 't',
    fieldHelp: { y: 'use y wisely' } // NO helper — Tier 0
  })
  app.update({ type: 'resize', width: 60, height: 20 })

  // Focused on <x>, which has no note: no legend, F1 inert.
  t.is(app._focusedFieldNote(), null, 'no note on x')
  t.is(app._helpLegend(), '', 'no legend without a note (and no AI)')
  app.update(key('f1'))
  t.absent(app.help, 'F1 does nothing on a field with no note and no AI')

  // Move to --y, which has a note: legend offers field help, F1 shows it.
  app.update(key('tab'))
  t.is(app.form.ring.focused().key, 'y', 'focus moved to y')
  t.is(app._focusedFieldNote(), 'use y wisely', 'note resolved for y')
  t.ok(/help for this field/.test(app._helpLegend()), 'legend offers field help')
  app.update(key('f1'))
  t.ok(app.help, 'F1 opens the static help panel')
  t.is(app.help.state, 'answer', 'opens straight to the note')
  t.absent(app.help.ask, 'static mode — no AI call')
})

test('MenuApp: a help key opens help; esc closes; form input survives', (t) => {
  const cmd = fixture()
  const app = new MenuApp({
    command: cmd,
    catalog: catalog(cmd),
    toolName: 't',
    helper: () => 'answer',
    fieldHelp: { x: 'note for x' }
  })
  app.update({ type: 'resize', width: 60, height: 20 })
  t.is(app.state, 'forming', 'single command → straight to the form')

  type(app, 'hello') // into the focused <x> field
  app.update(key('f1'))
  t.ok(app.help, 'F1 opened the help overlay')
  t.ok(/note for x/.test(app.help.context), 'context carries the focused field + dev note')

  app.update(key('escape', { sequence: '\x1b' }))
  t.absent(app.help, 'esc closed the overlay')
  t.is(app.form.value().x, 'hello', 'form input preserved across the help detour')
})

test('MenuApp: ctrl+k also opens help', (t) => {
  const cmd = fixture()
  const app = new MenuApp({ command: cmd, catalog: catalog(cmd), toolName: 't', helper: () => 'a' })
  app.update({ type: 'resize', width: 60, height: 20 })
  app.update(key('k', { ctrl: true }))
  t.ok(app.help, 'ctrl+k opened the help overlay')
})

test('MenuApp: with no helper, the help key is ignored', (t) => {
  const cmd = fixture()
  const app = new MenuApp({ command: cmd, catalog: catalog(cmd), toolName: 't' })
  app.update({ type: 'resize', width: 60, height: 20 })
  app.update(key('f1'))
  t.absent(app.help, 'no provider/helper → F1 does nothing')
})
