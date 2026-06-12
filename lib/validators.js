// Attach developer-provided validators to a built form's fields, by name.
//
// `fromSchema` only wires validators derived from the schema itself (pattern,
// minLength, …). To let a dev attach their OWN async checks for specific flags
// or args, we post-process the built form's fields: for each field whose value
// `key` matches a key in the dev's `validators` map, we install a validator.
//
// Two details the bare-tui-form Field contract forces (see fields/base.js):
//   - `_isAsync` is computed from `_validate.constructor.name === 'AsyncFunction'`
//     AT CONSTRUCTION. We're installing after construction, and we wrap the dev
//     fn to inject a context arg — so the wrapper is never an AsyncFunction. We
//     therefore set `_isAsync` from the ORIGINAL fn, so the form's async path
//     (spinner, debounce, stale-result rejection, submit-time re-validation gate)
//     fires correctly. (A dev whose validator returns a promise must mark it
//     `async`, exactly as for a hand-written field.)
//   - a field built from the schema may already carry a sync validator; we run
//     that first and only call the dev's validator if it passed, so neither is lost.
//
// `validators` is a flat map: <flag-or-arg name> →
//   (value, { values }) => string | null | Promise<string | null>
function attachValidators(form, validators) {
  if (!validators || typeof validators !== 'object') return form
  if (!form || !Array.isArray(form.fields)) return form

  for (const field of form.fields) {
    const fn = pick(validators, field.key) || pick(validators, field.label)
    if (typeof fn !== 'function') continue

    const prev = field._validate // schema-derived sync validator, if any
    const prevAsync = field._isAsync

    field._validate = function (value) {
      if (prev && !prevAsync) {
        const e = prev(value)
        if (e) return e
      }
      return fn(value, { values: safeValues(form) })
    }
    // Async if either the dev fn or a pre-existing schema validator was async.
    field._isAsync = isAsyncFn(fn) || prevAsync
  }

  return form
}

function pick(map, key) {
  if (!key) return undefined
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined
}

function isAsyncFn(fn) {
  return !!fn && fn.constructor && fn.constructor.name === 'AsyncFunction'
}

function safeValues(form) {
  try {
    return form.value()
  } catch {
    return {}
  }
}

module.exports = { attachValidators }
