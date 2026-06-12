// Tests for Tier 0 — the no-AI menu mode: the deterministic core (valuesToArgv,
// nodeSchema, evaluateArgv, runnableCommands) and the MenuApp flow end to end.
const test = require('brittle')
const { command, flag, arg, rest, summary } = require('paparam')
const { KeyMsg } = require('bare-tui')
const { introspect } = require('../lib/introspect')
const { nodeSchema } = require('../lib/fields')
const { valuesToArgv, REST_KEY } = require('../lib/argv')
const { evaluateArgv } = require('../lib/evaluate')
const { MenuApp, runnableCommands } = require('../lib/menu-app')

const catalog = (cmd) => introspect(cmd).catalog
const nodeByPath = (cat, path) => {
  let node = cat
  for (const name of path) node = (node.subcommands || []).find((s) => s.name === name)
  return node
}
const enter = () =>
  new KeyMsg({ name: 'enter', sequence: '\r', ctrl: false, meta: false, shift: false })

// A multi-command fixture covering every data type the menu must handle.
function fixture() {
  return command(
    'fleet',
    summary('fleet ops'),
    command(
      'cargo',
      summary('freight'),
      command(
        'load',
        summary('load a hold'),
        arg('<hold>', 'the hold'),
        flag('--manifest [manifest]', 'manifest file'),
        flag('--item|-i [item]', 'an item').multiple(),
        flag('--climate [climate]', 'climate').choices(['ambient', 'cryo']).default('ambient'),
        flag('--hazmat', 'hazmat'),
        () => {}
      )
    ),
    command(
      'launch',
      summary('launch'),
      arg('<vehicle>', 'hull'),
      flag('--crewed', 'crewed').default(true),
      flag('--out-dir [dir]', 'telemetry dir'),
      rest('[extra...]', 'passthrough'),
      () => {}
    )
  )
}

test('runnableCommands: lists real commands, skips namespaces', (t) => {
  const cmds = runnableCommands(catalog(fixture()))
  t.alike(
    cmds.map((c) => c.label),
    ['cargo load', 'launch'],
    'leaves only — fleet/cargo namespaces dropped'
  )
})

test('runnableCommands: a single-command tool yields exactly one', (t) => {
  const cmd = command('solo', arg('<x>', 'x'), () => {})
  const cmds = runnableCommands(catalog(cmd))
  t.is(cmds.length, 1, 'one command')
  t.alike(cmds[0].path, [], 'root path (no subcommand token)')
})

test('valuesToArgv: subcommand path, positionals, flags, defaults, multi', (t) => {
  const cat = catalog(fixture())
  const load = nodeByPath(cat, ['cargo', 'load'])
  const argv = valuesToArgv(load, ['cargo', 'load'], {
    hold: '2',
    manifest: '/m.csv',
    item: ['a', 'b'],
    climate: 'ambient', // equals the default → omitted
    hazmat: false // false boolean default-false → omitted
  })
  t.alike(
    argv,
    ['cargo', 'load', '2', '--manifest', '/m.csv', '--item', 'a', '--item', 'b'],
    'path + positional + value flag + repeated multi; default/false omitted'
  )
})

test('valuesToArgv: boolean inverse and non-default choice', (t) => {
  const cat = catalog(fixture())
  const launch = nodeByPath(cat, ['launch'])
  const argv = valuesToArgv(launch, ['launch'], {
    vehicle: 'MRDN-7',
    crewed: false, // default true → emit --no-crewed
    outDir: '/tel',
    [REST_KEY]: ['--raw', 'x']
  })
  t.alike(
    argv,
    ['launch', 'MRDN-7', '--no-crewed', '--out-dir', '/tel', '--raw', 'x'],
    '--no-crewed for the inverse, --out-dir uses the declared long token, rest appended last'
  )
})

test('valuesToArgv: a true boolean at default true is omitted', (t) => {
  const launch = nodeByPath(catalog(fixture()), ['launch'])
  const argv = valuesToArgv(launch, ['launch'], { vehicle: 'X-1', crewed: true })
  t.alike(argv, ['launch', 'X-1'], 'crewed=true equals default → omitted')
})

test('nodeSchema: builds the right field types for one command (+ rest)', (t) => {
  const launch = nodeByPath(catalog(fixture()), ['launch'])
  const { schema, uiSchema } = nodeSchema(launch)
  const p = schema.properties
  t.is(p.vehicle.type, 'string', 'arg → string field')
  t.is(p.crewed.type, 'boolean', 'boolean flag → confirm')
  t.alike(uiSchema.outDir, { 'ui:widget': 'directory' }, '--out-dir auto-detected as a directory')
  t.is(p[REST_KEY].type, 'array', 'rest → list field')
  t.alike(schema.required, ['vehicle'], 'required positional')
})

test('evaluateArgv: valid argv parses, bad argv returns an error', async (t) => {
  const cmd = fixture()
  const ok = await evaluateArgv(cmd, ['launch', 'MRDN-7'])
  t.ok(ok.result && ok.result.args.vehicle === 'MRDN-7', 'parsed result')
  // cargo load has no rest, so an unknown flag can't be absorbed → error.
  const bad = await evaluateArgv(cmd, ['cargo', 'load', '2', '--nope'])
  t.ok(bad.error, 'unknown flag surfaces an error')
})

test('MenuApp: pick a command, submit, confirm → confirmed argv', async (t) => {
  const cmd = fixture()
  const app = new MenuApp({ command: cmd, catalog: catalog(cmd), toolName: 'fleet' })
  app.update({ type: 'resize', width: 70, height: 24 })
  t.is(app.state, 'menu', 'starts at the menu')

  // Select "launch" and choose it.
  const cmds = runnableCommands(catalog(cmd))
  app.menu.selected = cmds.findIndex((c) => c.label === 'launch')
  app.update(enter())
  t.is(app.state, 'forming', 'opened the command form')
  t.is(app._pending.item.label, 'launch')

  // Submit the form; run the async evaluate Cmd and feed the result back.
  const [, evalCmd] = app.update({
    type: 'form.submit',
    values: { vehicle: 'MRDN-7', crewed: false, outDir: '/tel' }
  })
  app.update(await evalCmd())
  t.is(app.state, 'confirming', 'valid argv → confirm')

  // Confirm "yes".
  app.update({ type: 'form.submit', values: { choice: app._confirmYes } })
  t.alike(
    app.confirmed.argv,
    ['launch', 'MRDN-7', '--no-crewed', '--out-dir', '/tel'],
    'confirmed argv assembled deterministically'
  )
})

test('MenuApp: invalid submission re-prompts with the error', async (t) => {
  const cmd = fixture()
  const app = new MenuApp({
    command: cmd,
    catalog: catalog(cmd),
    toolName: 'fleet',
    // Force a failure to exercise the re-prompt path.
    validateSubmission: () => 'nope, fix it'
  })
  app.update({ type: 'resize', width: 70, height: 24 })
  const cmds = runnableCommands(catalog(cmd))
  app.menu.selected = cmds.findIndex((c) => c.label === 'launch')
  app.update(enter())

  const [, evalCmd] = app.update({ type: 'form.submit', values: { vehicle: 'MRDN-7' } })
  app.update(await evalCmd())
  t.is(app.state, 'forming', 'stayed on the form')
  t.is(app.formError, 'nope, fix it', 'error surfaced for the user to fix')
  t.absent(app.confirmed, 'nothing confirmed')
})

test('MenuApp: single-command tool skips the menu', (t) => {
  const cmd = command('solo', arg('<x>', 'x'), flag('--v', 'verbose'), () => {})
  const app = new MenuApp({ command: cmd, catalog: catalog(cmd), toolName: 'solo' })
  t.is(app.state, 'forming', 'went straight to the form')
  t.absent(app.menu, 'no menu built')
})
