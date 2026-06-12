// Tests for file/path auto-detection and the uiSchema merge that feeds the form.
// (The ParamSession-driven rendering tests live in bare-tui-paparam-ai, since the
// agentic session is part of the AI layer.)
const test = require('brittle')
const { command, flag, arg } = require('paparam')
const { introspect } = require('../lib/introspect')
const { buildSchema, pathHint, mergeUiSchema } = require('../lib/fields')

const catalog = (cmd) => introspect(cmd).catalog

test('pathHint: classifies by name tokens and by description', (t) => {
  const a = (def) => pathHint({ kind: 'arg', def })
  const f = (def) => pathHint({ kind: 'flag', def })

  t.is(a({ name: 'src' }), 'file', 'src → file')
  t.is(a({ name: 'outputFile' }), 'file', 'camelCase outputFile → file')
  t.is(a({ name: 'config' }), 'file', 'config → file')
  t.is(a({ name: 'output-path' }), 'file', 'kebab output-path → file')
  t.is(a({ name: 'dir' }), 'dir', 'dir → dir')
  t.is(a({ name: 'outputDir' }), 'dir', 'outputDir → dir (dir wins)')
  t.is(a({ name: 'profile' }), null, 'profile does NOT match file')
  t.is(a({ name: 'reconfigure' }), null, 'reconfigure does NOT match config')
  t.is(a({ name: 'name' }), null, 'plain name → no hint')
  // Place/object words are ambiguous — a bare name must NOT trigger a file picker.
  t.is(a({ name: 'destination' }), null, 'destination is a place, not a file')
  t.is(a({ name: 'target' }), null, 'target is an object, not a file')
  t.is(
    a({ name: 'dest', description: 'path to write to' }),
    'file',
    'but a path description still catches it'
  )

  t.is(
    a({ name: 'where', description: 'path to the bundle' }),
    'file',
    'description reveals a path'
  )
  t.is(
    a({ name: 'place', description: 'the target folder' }),
    'dir',
    'description reveals a folder'
  )

  t.is(f({ name: 'file', boolean: true }), null, 'boolean flag is never a path')
  t.is(f({ name: 'src', multi: true }), null, 'multi flag is never a path')
  t.is(f({ name: 'mode', choices: ['a', 'b'] }), null, 'choice flag is never a path')
})

test('buildSchema: returns a uiSchema hinting detected path fields', (t) => {
  const cmd = command(
    'tool',
    arg('<src>', 'source file'),
    flag('--out|-o [out]', 'where to write'),
    flag('--label [label]', 'a label'),
    () => {}
  )
  const { uiSchema } = buildSchema(catalog(cmd), { collect: ['src', 'out', 'label'] })
  t.alike(uiSchema.src, { 'ui:widget': 'file' }, '<src> hinted as a file')
  t.alike(uiSchema.out, { 'ui:widget': 'file' }, '--out hinted as a file')
  t.absent(uiSchema.label, '--label (no path signal) is not hinted')
})

test('mergeUiSchema: model overrides the auto widget, refines, and adds fields', (t) => {
  const auto = { out: { 'ui:widget': 'file' }, dir: { 'ui:widget': 'directory' } }
  const model = {
    out: { 'ui:widget': 'textarea' }, // override
    dir: { 'ui:placeholder': 'pick a folder' }, // refine, keep widget
    note: { 'ui:widget': 'password' } // new field
  }
  const merged = mergeUiSchema(auto, model)
  t.is(merged.out['ui:widget'], 'textarea', 'model overrides the auto widget')
  t.is(merged.dir['ui:widget'], 'directory', 'auto widget kept when model only adds keys')
  t.is(merged.dir['ui:placeholder'], 'pick a folder', 'model key merged into the auto field')
  t.is(merged.note['ui:widget'], 'password', 'a model-only field passes through')
})

test('mergeUiSchema: tolerates a missing model and drops pollution keys', (t) => {
  t.alike(
    mergeUiSchema({ a: { 'ui:widget': 'file' } }, undefined),
    { a: { 'ui:widget': 'file' } },
    'auto preserved with no model'
  )
  const model = JSON.parse('{"__proto__":{"ui:widget":"file"},"ok":{"ui:help":"hi"}}')
  const safe = mergeUiSchema({}, model)
  t.absent(Object.prototype.hasOwnProperty.call(safe, '__proto__'), 'forbidden key dropped')
  t.is(safe.ok['ui:help'], 'hi', 'safe key kept')
})
