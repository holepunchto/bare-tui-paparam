// GroupedList — the command menu, sectioned into dev-defined groups.
//
// Mirrors bare-tui's `list` (same selected/offset/height/width/filtering fields,
// selectedItem/update/view) so MenuApp can drive either one. The difference: the
// rows are group HEADERS plus their COMMANDS, and headers are navigable — the
// cursor stops on them so a group can be collapsed/expanded (enter, ←/→) or its
// help opened (the host's help keys). Collapsed groups hide their commands.
//
// While a filter is active, collapse is ignored: every group with a matching
// command shows (header + matches), and the cursor skips the headers.
//
//   groups: [{ title, description?, help?, collapsed?, commands: ['launch', 'cargo load'] }]
//
// Commands are matched by their menu label. Any command no group claims lands in
// a trailing "Other" group so nothing disappears from the menu.
const { key, style, textinput } = require('bare-tui')

const dim = (s) => style().faint(true).render(s)
const headStyle = (s) => style().bold(true).foreground('#5BC8FF').render(s)

const keys = {
  up: ['up', 'k'],
  down: ['down', 'j'],
  pageUp: ['pageup'],
  pageDown: ['pagedown'],
  collapse: ['left'],
  expand: ['right'],
  filter: ['/'],
  accept: ['enter'],
  cancel: ['esc']
}

// Resolve the dev's group specs against the runnable command items.
function buildGroups(specs, commands) {
  const byLabel = new Map(commands.map((c) => [c.label, c]))
  const claimed = new Set()
  const groups = []
  for (const spec of specs || []) {
    if (!spec || typeof spec !== 'object') continue
    const items = []
    for (const label of spec.commands || []) {
      const item = byLabel.get(label)
      if (!item || claimed.has(label)) continue
      claimed.add(label)
      items.push(item)
    }
    groups.push({
      title: String(spec.title || 'Commands'),
      description: spec.description ? String(spec.description) : '',
      help: spec.help ? String(spec.help) : '',
      collapsed: !!spec.collapsed,
      items
    })
  }
  const rest = commands.filter((c) => !claimed.has(c.label))
  if (rest.length) {
    groups.push({ title: 'Other', description: '', help: '', collapsed: false, items: rest })
  }
  return groups
}

class GroupedList {
  constructor(opts = {}) {
    this.groups = buildGroups(opts.groups, opts.items || [])
    this.height = opts.height || 10
    this.width = opts.width || 0

    this.input = textinput.create({ prompt: '' })
    this.filter = ''
    this.filtering = false

    this.rows = [] // { type: 'header', group } | { type: 'item', group, item }
    this.selected = 0
    this.offset = 0
    this._rebuild()
  }

  // { type: 'header', group } for a header, else the command item (like list).
  selectedRow() {
    return this.rows[this.selected] || null
  }

  selectedItem() {
    const row = this.selectedRow()
    if (!row) return null
    return row.type === 'item' ? row.item : null
  }

  selectedGroup() {
    const row = this.selectedRow()
    return row && row.type === 'header' ? row.group : null
  }

  toggle(group) {
    if (!group || this.filter) return
    group.collapsed = !group.collapsed
    this._rebuild(group)
  }

  update(msg) {
    if (!msg || msg.type !== 'key') return [this, null]

    if (this.filtering) {
      if (key.matches(msg, ...keys.cancel)) {
        this.filtering = false
        this._setFilter('')
        this.input.reset().blur()
        return [this, null]
      }
      if (key.matches(msg, ...keys.accept)) {
        this.filtering = false
        this.input.blur()
        return [this, null]
      }
      const [input, cmd] = this.input.update(msg)
      this.input = input
      this._setFilter(this.input.value)
      return [this, cmd]
    }

    if (key.matches(msg, ...keys.filter)) {
      this.filtering = true
      this.input.focus()
      return [this, null]
    }
    if (key.matches(msg, ...keys.cancel) && this.filter) {
      this.input.reset()
      this._setFilter('')
      return [this, null]
    }

    const row = this.selectedRow()
    if (key.matches(msg, ...keys.collapse) && row && !this.filter) {
      // ← on a header collapses it; on a command, jumps up to its header.
      if (row.type === 'header') {
        if (!row.group.collapsed) this.toggle(row.group)
      } else {
        this._select(this.rows.findIndex((r) => r.type === 'header' && r.group === row.group))
      }
      return [this, null]
    }
    if (key.matches(msg, ...keys.expand) && row && row.type === 'header') {
      if (row.group.collapsed) this.toggle(row.group)
      return [this, null]
    }

    if (key.matches(msg, ...keys.up)) this._move(-1)
    else if (key.matches(msg, ...keys.down)) this._move(1)
    else if (key.matches(msg, ...keys.pageUp)) this._move(-this.height)
    else if (key.matches(msg, ...keys.pageDown)) this._move(this.height)
    return [this, null]
  }

  view() {
    const lines = []
    if (this.filtering || this.filter) {
      lines.push('/' + (this.filtering ? this.input.view() : this.filter))
    }
    const rows = []
    if (!this.rows.length) {
      rows.push(dim('  no matches'))
    } else {
      const end = Math.min(this.offset + this.height, this.rows.length)
      for (let p = this.offset; p < end; p++) rows.push(this._renderRow(this.rows[p], p))
    }
    while (rows.length < this.height) rows.push('')
    lines.push(...rows)
    return lines.join('\n')
  }

  // ── internals ──────────────────────────────────────────────────────────

  _setFilter(value) {
    this.filter = value
    this._rebuild()
    this.selected = 0
    this.offset = 0
    if (!this._selectable(this.rows[0])) this._move(1)
  }

  // Recompute the visible rows; keep the cursor on `keep` (a group header) or the
  // previously selected row when it's still visible.
  _rebuild(keep) {
    const prev = this.rows[this.selected]
    const q = this.filter.trim().toLowerCase()
    const rows = []
    for (const group of this.groups) {
      const items = q
        ? group.items.filter((it) => (it.filterValue || it.title).toLowerCase().includes(q))
        : group.items
      if (q && !items.length) continue
      rows.push({ type: 'header', group })
      if (q || !group.collapsed) for (const item of items) rows.push({ type: 'item', group, item })
    }
    this.rows = rows

    let idx = -1
    if (keep) idx = rows.findIndex((r) => r.type === 'header' && r.group === keep)
    else if (prev) {
      idx = rows.findIndex(
        (r) => r.type === prev.type && r.group === prev.group && r.item === prev.item
      )
    }
    this._select(idx < 0 ? 0 : idx)
  }

  // Headers are selectable except while filtering (then they're just labels).
  _selectable(row) {
    return !!row && (row.type === 'item' || !this.filter)
  }

  _move(delta) {
    if (!this.rows.length) return
    const last = this.rows.length - 1
    const step = delta < 0 ? -1 : 1
    let p = Math.max(0, Math.min(this.selected + delta, last))
    // Skip unselectable rows in the direction of travel, then back the other way.
    while (p >= 0 && p <= last && !this._selectable(this.rows[p])) p += step
    if (p < 0 || p > last) {
      p = Math.max(0, Math.min(this.selected, last))
      while (p >= 0 && p <= last && !this._selectable(this.rows[p])) p -= step
      if (p < 0 || p > last) return
    }
    this._select(p)
  }

  _select(p) {
    this.selected = Math.max(0, Math.min(p, this.rows.length - 1))
    if (this.selected < this.offset) this.offset = this.selected
    else if (this.selected >= this.offset + this.height) {
      this.offset = this.selected - this.height + 1
    }
    // Keep a group's header in view when its first command is selected at the top.
    const above = this.rows[this.selected - 1]
    if (this.offset === this.selected && above && above.type === 'header') this.offset--
    // Never leave blank rows below the list while rows are scrolled off the top
    // (e.g. after collapsing a group near the end of a long menu).
    this.offset = Math.max(0, Math.min(this.offset, this.rows.length - this.height))
  }

  _renderRow(row, p) {
    const selected = p === this.selected
    const w = this.width > 0 ? this.width : Infinity
    if (row.type === 'header') {
      const g = row.group
      const arrow = this.filter ? ' ' : g.collapsed ? '▸' : '▾'
      const count = g.collapsed && !this.filter ? ` (${g.items.length})` : ''
      const desc = g.description ? ' — ' + g.description : ''
      const head = `${selected ? '›' : ' '} ${arrow} ${g.title}`
      if (selected) {
        const line = truncate(head + count + desc, w)
        return style()
          .reverse(true)
          .render(Number.isFinite(w) ? line.padEnd(w) : line)
      }
      return truncate(headStyle(head) + dim(count + desc), w)
    }
    const line = truncate(`${selected ? '›' : ' '}   ${row.item.title}`, w)
    if (!selected) return line
    return style()
      .reverse(true)
      .render(Number.isFinite(w) ? line.padEnd(w) : line)
  }
}

// Cut a (possibly styled) line to `w` visible columns.
function truncate(s, w) {
  return Number.isFinite(w) && style.width(s) > w ? style.truncate(s, w) : s
}

function create(opts) {
  return new GroupedList(opts)
}

module.exports = { create, GroupedList, buildGroups }
