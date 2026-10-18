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

// ── groups ─────────────────────────────────────────────────────────────────

const key = (name, extra = {}) =>
  new KeyMsg({ name, sequence: '', ctrl: false, meta: false, shift: false, ...extra })

function groupedFixture() {
  return command(
    'fleet',
    command('launch', arg('<vehicle>', 'hull'), () => {}),
    command('dock', arg('<station>', 'station'), () => {}),
    command('scan', arg('<target>', 'target'), () => {}),
    command('report', () => {})
  )
}

function groupedApp(groups) {
  const cmd = groupedFixture()
  const app = new MenuApp({ command: cmd, catalog: catalog(cmd), toolName: 'fleet', groups })
  app.update({ type: 'resize', width: 70, height: 24 })
  return app
}

const GROUPS = [
  { title: 'Flight', description: 'fly', help: 'flight help', commands: ['launch', 'dock'] },
  { title: 'Sensors', commands: ['scan'] }
]

const rowLabels = (menu) =>
  menu.rows.map((r) => (r.type === 'header' ? '#' + r.group.title : r.item.label))

test('groups: headers + commands, unclaimed commands land in Other', (t) => {
  const app = groupedApp(GROUPS)
  t.alike(rowLabels(app.menu), [
    '#Flight',
    'launch',
    'dock',
    '#Sensors',
    'scan',
    '#Other',
    'report'
  ])
  t.ok(app.menu.selectedGroup(), 'cursor starts on the first header')
  t.ok(app.view().includes('Flight'), 'header rendered')
})

test('groups: enter on a header collapses/expands; arrows walk headers too', (t) => {
  const app = groupedApp(GROUPS)
  app.update(enter())
  t.alike(rowLabels(app.menu), ['#Flight', '#Sensors', 'scan', '#Other', 'report'], 'collapsed')
  t.is(app.state, 'menu', 'still on the menu')
  app.update(key('down'))
  t.is(app.menu.selectedGroup().title, 'Sensors', 'down from a collapsed header → next header')
  app.update(key('up'))
  app.update(key('right'))
  t.alike(rowLabels(app.menu).slice(0, 3), ['#Flight', 'launch', 'dock'], 'right expands')
  app.update(key('down'))
  app.update(key('left'))
  t.is(app.menu.selectedGroup().title, 'Flight', 'left on a command jumps to its header')
})

test('groups: enter on a command opens its form', (t) => {
  const app = groupedApp(GROUPS)
  app.update(key('down'))
  app.update(enter())
  t.is(app.state, 'forming')
  t.is(app._pending.item.label, 'launch')
})

test('groups: help key on a header opens the group help; esc returns', (t) => {
  const app = groupedApp(GROUPS)
  app.update(key('f1'))
  t.ok(app.help, 'help open')
  t.ok(app.view().includes('flight help'), 'shows the group help')
  app.update(key('escape', { sequence: '\x1b' }))
  t.absent(app.help, 'closed')
  t.is(app.state, 'menu', 'back on the menu')
  // A header without help ignores the key.
  app.update(enter()) // collapse Flight
  app.update(key('down')) // → Sensors
  app.update(key('f1'))
  t.absent(app.help, 'no help for Sensors')
})

test('groups: filtering ignores collapse and skips headers', (t) => {
  const app = groupedApp([{ ...GROUPS[0], collapsed: true }, GROUPS[1]])
  t.alike(rowLabels(app.menu), ['#Flight', '#Sensors', 'scan', '#Other', 'report'])
  app.update(key('/', { sequence: '/' }))
  for (const ch of 'doc') app.update(key(ch, { sequence: ch }))
  t.alike(rowLabels(app.menu), ['#Flight', 'dock'], 'only matching group shown, expanded')
  t.is(app.menu.selectedItem().label, 'dock', 'cursor on the match, not the header')
})

test('groups: the cursor stays in view on a short screen through collapse/expand', (t) => {
  const { cmd, menuOpts } = require('../examples/orbital-menu.js')
  const app = new MenuApp({
    command: cmd,
    catalog: catalog(cmd),
    toolName: 'orbital',
    groups: menuOpts.groups
  })
  app.update({ type: 'resize', width: 70, height: 11 })
  const m = app.menu
  const inView = () =>
    m.selected >= m.offset &&
    m.selected < m.offset + m.height &&
    m.offset <= Math.max(0, m.rows.length - m.height)
  let ok = true
  for (let i = 0; i < m.rows.length + 2; i++) {
    app.update(key('down'))
    ok = ok && inView()
  }
  // Up to the Sensors header, collapse it, expand it, then back to the top.
  while (m.selectedGroup() === null || m.selectedGroup().title !== 'Sensors & comms') {
    app.update(key('up'))
  }
  app.update(enter())
  ok = ok && inView()
  app.update(key('right'))
  ok = ok && inView()
  for (let i = 0; i < m.rows.length + 2; i++) {
    app.update(key('up'))
    ok = ok && inView()
  }
  t.ok(ok, 'cursor always within the visible window, no dead space at the bottom')
  t.is(m.offset, 0, 'scrolled back to the top')
})
