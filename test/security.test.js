// Adversarial tests — the model's ask_user payload is untrusted, and we render
// it through bare-tui-form's hardening. These prove a hostile free-form schema
// is neutralized (the same posture bare-tui-form's CLAUDE.md requires of any
// consumer of untrusted schemas), and that model-derived command text can't
// repaint the terminal.
const test = require('brittle')
const form = require('bare-tui-form')
const { cleanText } = require('bare-tui-form/harden')
const { command, flag, arg } = require('paparam')
const { buildSchema } = require('../lib/fields')
const { introspect } = require('../lib/introspect')

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

function catalog() {
  const cmd = command('run', arg('<link>', 'link'), flag('--dev|-d', 'dev'), () => {})
  return introspect(cmd).catalog
}

test('terminal-control bytes in a free-form title are stripped', (t) => {
  const { schema } = buildSchema(catalog(), {
    collect: ['link'],
    questions: { evil: { type: 'string', title: 'a' + ESC + '[31mb' + BEL + 'c' } }
  })
  const built = form.fromSchema(schema)
  const field = built.fields.find((f) => f.key === 'evil')
  t.ok(field, 'field built')
  t.absent(field.label.includes(ESC), 'ESC byte stripped from label')
  t.absent(field.label.includes(BEL), 'BEL byte stripped from label')
})

test('a ReDoS pattern is screened and surfaced as a warning', (t) => {
  const { schema } = buildSchema(catalog(), {
    collect: ['link'],
    questions: { token: { type: 'string', pattern: '(a+)+$' } }
  })
  const built = form.fromSchema(schema)
  t.ok((built.warnings || []).length > 0, 'a warning was recorded for the refused pattern')
  // The field still exists and is usable; the dangerous pattern was simply dropped.
  const field = built.fields.find((f) => f.key === 'token')
  field.setValue('aaaaaaaaaaaaaaaaaaaaaaaa!')
  t.is(field.validate(), null, 'validation does not hang and the pattern check was dropped')
})

test('a __proto__ key in free-form questions cannot pollute the prototype', (t) => {
  // JSON.parse creates a genuine OWN __proto__ key (an object literal would set
  // the prototype instead, so there would be nothing to attack).
  const hostile = JSON.parse(
    '{"__proto__": {"type": "string", "title": "pwned"}, "safe": {"type": "string"}}'
  )
  const { schema, warnings } = buildSchema(catalog(), { collect: ['link'], questions: hostile })

  t.ok(
    warnings.some((w) => /unsafe question name/.test(w)),
    'the __proto__ key was refused with a warning'
  )
  t.absent(Object.prototype.title, 'Object.prototype not polluted')
  t.absent({}.title, 'plain objects not polluted')

  const built = form.fromSchema(schema)
  t.ok(
    built.fields.find((f) => f.key === 'safe'),
    'the safe field still built'
  )
  t.absent(
    built.fields.find((f) => f.key === '__proto__'),
    'no __proto__ field'
  )
})

test('cleanText neutralizes control bytes in a command line before display', (t) => {
  const dirty = 'run' + ESC + ']0;hacked' + BEL + ' --dev'
  const clean = cleanText(dirty)
  t.absent(clean.includes(ESC), 'ESC stripped')
  t.absent(clean.includes(BEL), 'BEL/OSC terminator stripped')
})
