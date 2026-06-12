// HelpOverlay — an embedded "ask a question" panel for form mode.
//
// A small Model-Update-View controller the host app composites below the (still
// visible) form: the user types a question, the AI answers, and esc returns to the
// form with everything intact. The host owns WHEN it opens (a help key) and routes
// Msgs to it while `this.closed` is false; the overlay owns the Q&A.
//
//   const o = new HelpOverlay({ ask, context })   // ask: (q,{context}) => Promise<string>
//   o.setSize(width, panelHeight)
//   const [o2, cmd] = o.update(msg)
//   if (o2.closed) { /* host drops it, restores the form */ }
//
// States: asking → loading → answer (esc closes from any; enter on an answer asks
// another). The answer is rendered through bare-tui-markdown and scrolled with our
// own ANSI-aware line window (pgup/pgdn) — NOT bare-tui's viewport, which slices by
// raw byte length and would corrupt styled lines.
const { batch, key, style, textinput, spinner } = require('bare-tui')
const md = require('bare-tui-markdown')

const accent = (s) => style().bold(true).foreground('#5BC8FF').render(s)
const dim = (s) => style().faint(true).render(s)
const errStyle = (s) => style().foreground('#FF6B6B').render(s)

// Keys that open the help panel in form mode. F1 is the discoverable primary;
// ctrl+k is a ctrl-style alternate that (unlike ctrl+g) zellij doesn't bind. Both
// are overridable per-CLI via the entry-point `helpKeys` option. (ctrl+? can't be
// used — terminals send \x7f, which decodes to backspace.)
const DEFAULT_HELP_KEYS = ['f1', 'ctrl+k']

// Render the help keys for a footer legend, e.g. ['f1','ctrl+k'] → "F1 / ctrl+k".
function helpKeysLabel(keys) {
  return (keys || []).map((k) => (/^f\d+$/.test(k) ? k.toUpperCase() : k)).join(' / ')
}

class HelpOverlay {
  // `ask` (AI Q&A) and/or `note` (the dev's static fieldHelp). With an `ask` we
  // start at the question box; with only a `note` we open straight to it (no AI).
  constructor({ ask, context, note } = {}) {
    this.ask = typeof ask === 'function' ? ask : null
    this.context = context || ''
    this.note = typeof note === 'string' ? note.trim() : ''
    this.input = textinput.create({ placeholder: 'ask about this command…', prompt: '? ' }).focus()
    this.spinner = null
    this.question = ''
    this.answer = ''
    this.error = ''
    this.closed = false
    this.width = 80
    this.panelHeight = 8
    this.answerLines = [] // ANSI-aware wrapped answer (from bare-tui-markdown)
    this.scroll = 0

    if (!this.ask && this.note) {
      // Static field help: nothing to ask, just show the note.
      this.state = 'answer'
      this.answer = this.note
      this._rebuildAnswer()
    } else {
      this.state = 'asking'
    }
  }

  setSize(width, panelHeight) {
    this.width = Math.max(20, width || this.width)
    this.panelHeight = Math.max(4, panelHeight || this.panelHeight)
    if (this.answer) this._rebuildAnswer()
    return this
  }

  update(msg) {
    if (msg && msg.type === 'help.answered') return this._onAnswered(msg)

    if (msg && msg.type === 'spinner.tick') {
      if (this.state === 'loading' && this.spinner) {
        const [s, cmd] = this.spinner.update(msg)
        this.spinner = s
        return [this, cmd]
      }
      return [this, null]
    }

    if (msg && msg.type === 'key') {
      if (key.matches(msg, 'escape')) {
        this.closed = true
        return [this, null]
      }
      if (this.state === 'asking') {
        if (key.matches(msg, 'enter')) {
          const q = (this.input.value || '').trim()
          if (!q) return [this, null]
          this.question = q
          this.error = ''
          this.state = 'loading'
          this.spinner = spinner.create({ fps: 12 })
          return [this, batch(this.spinner.init(), this._askCmd(q))]
        }
        const [i, cmd] = this.input.update(msg)
        this.input = i
        return [this, cmd]
      }
      if (this.state === 'answer') {
        // Enter asks another question — only meaningful when there's an AI.
        if (this.ask && key.matches(msg, 'enter')) {
          this.state = 'asking'
          this.input.reset()
          this.answer = ''
          this.error = ''
          this.answerLines = []
          this.scroll = 0
          return [this, null]
        }
        this._scroll(msg)
        return [this, null]
      }
      // loading: keys (other than esc) are ignored
    }
    return [this, null]
  }

  _askCmd(q) {
    const ask = this.ask
    const context = this.context
    return () =>
      Promise.resolve()
        .then(() => (ask ? ask(q, { context }) : 'No help provider is available.'))
        .then((text) => ({ type: 'help.answered', text: text || '' }))
        .catch((err) => ({ type: 'help.answered', error: (err && err.message) || String(err) }))
  }

  _onAnswered(msg) {
    this.spinner = null
    this.state = 'answer'
    if (msg.error) {
      this.error = msg.error
      this.answer = ''
      this.answerLines = []
    } else {
      this.answer = msg.text || '(no answer)'
      this.error = ''
      this._rebuildAnswer()
    }
    return [this, null]
  }

  _answerRows() {
    // panel = rule + question line + blank + [answer] + hint
    return Math.max(2, this.panelHeight - 4)
  }

  // Wrap the answer with the ANSI-aware markdown renderer (whole lines, never
  // byte-sliced), and reset the scroll window.
  _rebuildAnswer() {
    const w = Math.max(10, this.width - 2)
    this.answerLines = md.renderLines(this.answer, { width: w })
    this.scroll = 0
  }

  _scroll(msg) {
    const rows = this._answerRows()
    const max = Math.max(0, this.answerLines.length - rows)
    if (key.matches(msg, 'pageup')) this.scroll -= rows
    else if (key.matches(msg, 'pagedown')) this.scroll += rows
    else if (key.matches(msg, 'up')) this.scroll -= 1
    else if (key.matches(msg, 'down')) this.scroll += 1
    this.scroll = Math.max(0, Math.min(this.scroll, max))
  }

  view() {
    const w = this.width
    const rule = dim('─'.repeat(Math.max(4, w)))
    const lines = [rule]

    if (this.state === 'asking') {
      lines.push('  ' + this.input.view())
      lines.push(dim('  esc cancel · enter ask'))
      return lines.join('\n')
    }

    // Header: the asked question, or (static field help) a simple label.
    if (this.question) lines.push('  ' + accent('? ') + this.question)
    else lines.push('  ' + accent('ℹ ') + dim('field help'))
    if (this.state === 'loading') {
      const sp = this.spinner ? this.spinner.view() : '…'
      lines.push('  ' + accent(sp) + ' ' + dim('thinking…'))
      return lines.join('\n')
    }

    // answer
    lines.push('')
    const askHint = this.ask ? ' · enter ask another' : ''
    if (this.error) {
      lines.push('  ' + errStyle('✗ ' + this.error))
    } else {
      const rows = this._answerRows()
      const window = this.answerLines.slice(this.scroll, this.scroll + rows)
      for (const ln of window) lines.push('  ' + ln)
      const scrollHint = this.answerLines.length > rows ? ' · pgup/pgdn scroll' : ''
      lines.push(dim('  esc close' + askHint + scrollHint))
      return lines.join('\n')
    }
    lines.push(dim('  esc close' + askHint))
    return lines.join('\n')
  }
}

module.exports = { HelpOverlay, DEFAULT_HELP_KEYS, helpKeysLabel }
