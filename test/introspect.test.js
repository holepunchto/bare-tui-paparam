const test = require('brittle')
const { command, flag, arg, rest, summary, header } = require('paparam')
const { introspect } = require('../lib/introspect')

function sampleCommand() {
  return command(
    'run',
    header('App runner'),
    summary('Run an app from a link'),
    arg('<roomLink>', 'the room link key'),
    arg('[channel]', 'optional channel'),
    flag('--storage|-s [path]', 'store path').default('/tmp'),
    flag('--mode|-m [mode]', 'run mode').choices(['dev', 'prod']),
    flag('--blind|-b [key]', 'blind peer key').multiple(),
    flag('--verbose|-v', 'verbose logging'),
    flag('--secret [s]', 'hidden').hide(),
    rest('[...app-args]', 'args passed to the app'),
    () => {
      throw new Error('runner must never execute during introspection')
    }
  )
}

test('catalog lists each real flag once, deduped and filtered', (t) => {
  const { catalog } = introspect(sampleCommand())
  const names = catalog.flags.map((f) => f.name)
  t.alike(
    names,
    ['storage', 'mode', 'blind', 'verbose'],
    'help and hidden flags excluded, aliases deduped'
  )

  const byName = Object.fromEntries(catalog.flags.map((f) => [f.name, f]))
  t.is(byName.verbose.boolean, true, 'boolean flag detected')
  t.is(byName.storage.boolean, false)
  t.is(byName.storage.hasDefault, true)
  t.is(byName.storage.default, '/tmp', 'default captured')
  t.alike(byName.mode.choices, ['dev', 'prod'], 'choices captured')
  t.is(byName.blind.multi, true, 'repeatable flag detected')
  t.alike(
    byName.storage.aliases.filter((a) => a !== 'storage'),
    ['s'],
    'alias captured'
  )
})

test('catalog lists args with optionality and rest', (t) => {
  const { catalog } = introspect(sampleCommand())
  t.alike(
    catalog.args.map((a) => [a.name, a.optional]),
    [
      ['roomLink', false],
      ['channel', true]
    ]
  )
  t.ok(catalog.rest, 'rest captured')
})

test('catalog recurses into subcommands', (t) => {
  const cmd = command(
    'pear',
    summary('top'),
    command('run', summary('run an app'), arg('<link>', 'link'), () => {}),
    command('seed', summary('seed an app'), arg('<channel>', 'channel'), () => {})
  )
  const { catalog, docsText } = introspect(cmd)
  const subs = catalog.subcommands.map((s) => s.name).sort()
  t.alike(subs, ['run', 'seed'], 'both subcommands present')
  t.ok(docsText.includes('run'), 'docsText mentions subcommand')
  t.ok(docsText.includes('EXACT NAMES'), 'docsText has the name reference')
})
