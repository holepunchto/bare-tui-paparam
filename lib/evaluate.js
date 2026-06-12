// evaluateArgv — parse argv through the real paparam command and run the dev's
// submission validator. Shared by the AI session (a model's propose_argv) and the
// no-AI menu (a deterministically assembled argv), so both validate identically.
//
// Returns { result } on success, or { error } with a human-readable message to
// surface (or feed back to the model). The command is parsed with run:false so the
// real runner never fires here — the caller runs it for real only after confirm.

// Parse `argv` through `command` without running it, then apply validateSubmission.
async function evaluateArgv(command, argv, { validateSubmission } = {}) {
  resetBail(command)
  let result = null
  try {
    result = command.parse(argv, { run: false, silent: true })
  } catch (err) {
    return { error: (err && err.message) || String(err) }
  }

  if (result === null) {
    const bail = readBail(command)
    return {
      error:
        bail || 'that parses to a help request, not a runnable command (do not include -h/--help)'
    }
  }

  if (typeof validateSubmission === 'function') {
    let verdict
    try {
      verdict = await validateSubmission(result, { argv, command })
    } catch (err) {
      verdict = 'validation failed: ' + ((err && err.message) || String(err))
    }
    if (verdict) return { error: String(verdict) }
  }

  return { result }
}

// Clear stale bail/current state across the whole command tree before a parse.
// `_reset()` (run inside parse) does not clear `.bailed`/`.current`, so a prior
// failure could otherwise be misread as the current one.
function resetBail(command) {
  const stack = [command]
  const seen = new Set()
  while (stack.length) {
    const node = stack.pop()
    if (!node || seen.has(node)) continue
    seen.add(node)
    node.bailed = null
    node.current = null
    for (const [, sub] of node._definedCommands || new Map()) stack.push(sub)
  }
}

// Read the human-readable bail off the deepest visited command. Only reached when
// the dev installed a bail handler (otherwise parse throws and we catch it).
function readBail(command) {
  let node = command
  const seen = new Set()
  while (node && node.current && !seen.has(node)) {
    seen.add(node)
    node = node.current
  }
  const b = node && node.bailed
  if (!b) return null
  if (b.bail && b.bail.reason) {
    const name = b.bail.flag ? b.bail.flag.name : b.bail.arg ? b.bail.arg.value : ''
    return b.bail.reason + (name ? ': ' + name : '')
  }
  if (b.error) return (b.error && b.error.message) || String(b.error)
  return 'invalid command'
}

module.exports = { evaluateArgv, resetBail, readBail }
