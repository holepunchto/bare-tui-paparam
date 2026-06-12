// orbital (menu) — the no-AI, no-network face of the orbital demo CLI.
//
// Same big fictional mission-control surface as the AI example, but wired to the
// zero-AI tier: run it with `--menu`, pick a command from a filterable list, fill
// the form, confirm, and it runs. No provider, no `bare-fetch`, nothing leaves the
// machine. Per-field help (F1 / ctrl+k) still works — it shows the dev's static
// `fieldHelp` notes for the focused field.
//
//   bare examples/orbital-menu.js --menu
//   bare examples/orbital-menu.js launch MRDN-7 --pad A2 --fuel fusion   # the real CLI
//
// Want plain-language discovery (`--find`) or full agentic assist (`--hi`)?
// Install `bare-tui-paparam-ai` and see its examples/orbital-hi.js — the command
// definition is identical; only the entry points change.

const { command, flag, arg, header, summary, description } = require('paparam')
const { isMenuMode, runMenu } = require('..')

// ── the tool ────────────────────────────────────────────────────────────────
const cmd = command(
  'orbital',
  header('orbital — deep-space mission control'),
  summary('Plan launches, fly courses, move cargo, and talk to your fleet.'),
  description(
    'A unified console for the SS Meridian and her sister freighters. Most ops ' +
      'go launch → navigate → dock → cargo. Sensors and comms can run any time.'
  ),

  // launch — get a hull off the ground.
  command(
    'launch',
    summary('Schedule and execute a launch.'),
    arg('<vehicle>', 'hull id of the ship to launch, e.g. MRDN-7'),
    flag('--pad|-p [pad]', 'launch pad').choices(['A1', 'A2', 'B7', 'sea-platform']).default('A1'),
    flag('--fuel|-f [fuel]', 'drive type')
      .choices(['ion', 'chemical', 'fusion', 'antimatter'])
      .default('chemical'),
    // .hint('Antimatter is experimental and uncrewed-only; most flights use chemical or fusion.'),
    flag('--window|-w [window]', 'launch window, ISO-8601 (e.g. 2031-04-12T09:30Z)'),
    flag('--config [config]', 'vehicle profile to load'), // auto-detected → file picker
    flag('--flight-plan [path]', 'trajectory file to fly'), // dev-hinted → file picker
    flag('--abort-threshold [pct]', 'auto-abort if risk exceeds this percentage'),
    flag('--crewed', 'carry crew (use --no-crewed for an uncrewed flight)').default(true),
    flag('--dry-run|-n', 'rehearse the countdown without igniting'),
    runner('launch')
  ),

  // navigate — plot a course and lay in waypoints.
  command(
    'navigate',
    summary('Plot a course and lay in waypoints.'),
    arg('<destination>', 'where to go, e.g. "Gateway" or "Ceres Station"'),
    flag('--waypoint|-w [waypoint]', 'a waypoint to route through').multiple(),
    flag('--orbit [orbit]', 'insertion orbit at the destination').choices([
      'LEO',
      'MEO',
      'GEO',
      'lunar-transfer',
      'L2-halo'
    ]),
    // .hint('lunar-transfer is for trips to the Moon/Gateway; L2-halo is a deep-space parking orbit.'),
    flag('--avoid [region]', 'a hazard region to steer around').multiple(),
    flag('--max-burn [seconds]', 'longest single burn allowed, in seconds'),
    flag('--out-dir [dir]', 'where to write the computed telemetry'), // auto → directory picker
    runner('navigate')
  ),

  // dock — bring her in.
  command(
    'dock',
    summary('Dock to a station or another vessel.'),
    arg('<station>', 'the station or vessel to dock with'),
    flag('--bay [bay]', 'berth/bay identifier'),
    flag('--approach [approach]', 'approach mode')
      .choices(['auto', 'manual', 'tractor-assist'])
      .default('auto'),
    flag('--hard-seal', 'pressurize a hard seal after capture'),
    runner('dock')
  ),

  // cargo — move freight (nested: load / unload).
  command(
    'cargo',
    summary('Load, unload, and inspect freight.'),
    command(
      'load',
      summary('Load freight into a hold.'),
      arg('<hold>', 'which cargo hold to fill'),
      flag('--manifest [manifest]', 'cargo manifest to load from'), // dev-hinted → file picker
      flag('--item|-i [item]', 'an item to load (repeatable)').multiple(),
      flag('--climate [climate]', 'storage climate')
        .choices(['ambient', 'chilled', 'cryo', 'vacuum'])
        .default('ambient'),
      flag('--hazmat', 'manifest contains hazardous materials'),
      runner('cargo load')
    ),
    command(
      'unload',
      summary('Unload freight from a hold.'),
      arg('<hold>', 'which cargo hold to empty'),
      flag('--bay [bay]', 'destination bay on the station'),
      flag('--all', 'unload everything, ignore the manifest'),
      runner('cargo unload')
    )
  ),

  // scan — point the sensors at something.
  command(
    'scan',
    summary('Run a sensor sweep of a target.'),
    arg('<target>', 'what to scan, e.g. a body, sector, or contact'),
    flag('--band [band]', 'sensor band').choices([
      'visible',
      'infrared',
      'radar',
      'lidar',
      'gravimetric'
    ]),
    flag('--resolution [res]', 'sweep resolution')
      .choices(['low', 'med', 'high', 'ultra'])
      .default('med'),
    flag('--attach-file [path]', 'a prior scan to diff against'), // auto-detected → file picker
    flag('--passive', 'listen only — do not emit (stay hidden)'),
    runner('scan')
  ),

  // comms — send a transmission.
  command(
    'comms',
    summary('Send a transmission to a recipient.'),
    arg('<recipient>', 'callsign, station, or vessel to hail'),
    flag('--channel [channel]', 'transmission channel').choices([
      's-band',
      'x-band',
      'laser',
      'quantum'
    ]),
    // .hint('quantum only works within one light-second; use laser or x-band for farther links.'),
    flag('--priority [priority]', 'message priority')
      .choices(['routine', 'priority', 'flash', 'emergency'])
      .default('routine'),
    flag('--attach-file [path]', 'a file to transmit alongside the message'), // auto → file picker
    flag('--encrypt', 'encrypt end-to-end'),
    runner('comms')
  ),

  // report — export ops data.
  command(
    'report',
    summary('Generate an operations report.'),
    flag('--format [format]', 'output format')
      .choices(['pdf', 'csv', 'json', 'holo'])
      .default('pdf'),
    flag('--out-dir [dir]', 'directory to write the report into'), // auto → directory picker
    flag('--since [since]', 'only include events since this time (ISO-8601)'),
    flag('--section [section]', 'a section to include (repeatable)').multiple(),
    runner('report')
  )
)

// Every subcommand just prints what it would do — this is a demo, nothing flies.
function runner(label) {
  return function (c) {
    console.log(`[orbital ${label}]`, JSON.stringify({ args: c.args, flags: c.flags }, null, 2))
  }
}

// ── no-AI wiring ──────────────────────────────────────────────────────────────
// Display hints, per-field static help, and validators all work without a model.
// (`fieldHelp` here ADDS notes for fields without a `.hint()`; the `.hint()`s above
// cover fuel/orbit/channel. Both feed the offline F1 / ctrl+k help.)
const menuOpts = {
  uiSchema: {
    flightPlan: { 'ui:widget': 'file' },
    manifest: { 'ui:widget': 'file' }
  },
  fieldHelp: {
    vehicle: 'Hull ids look like MRDN-7 or SS-12 — two-to-four letters, a dash, then a number.'
  },
  validators: {
    vehicle: (v) =>
      /^[A-Z]{2,4}-\d{1,4}$/.test(v) ? null : 'expected a hull id like MRDN-7 or SS-12',
    abortThreshold: (v) => {
      const n = Number(v)
      return Number.isFinite(n) && n >= 0 && n <= 100 ? null : 'must be a percentage 0–100'
    }
  },
  validateSubmission: (result) => {
    const f = result.flags || {}
    if (f.fuel === 'antimatter' && f.crewed !== false) {
      return 'antimatter drives are uncrewed-only — add --no-crewed (or pick a different --fuel)'
    }
    if (f.priority === 'emergency' && !f.encrypt) {
      return 'emergency transmissions must be encrypted — add --encrypt'
    }
    return null
  }
}

if (require.main === module) {
  if (isMenuMode(Bare.argv)) {
    runMenu(cmd, menuOpts)
  } else {
    cmd.parse(Bare.argv.slice(2))
  }
}

module.exports = { cmd, menuOpts }
