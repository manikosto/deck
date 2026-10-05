import type { ModelUsage, SessionContextBreakdown } from 'claude-code'
import type { DeckAct, DeckActKind, DeckCat, DeckLimit, DeckPlanItem, DeckPoint, DeckSource } from '../types'

export const COLORS = {
  accent: '#e8875b',
  text: '#d8d8de',
  faint: '#5b5b66',
  dim: '#8a8a96',
  good: '#7fc77a',
  warn: '#e8c15b',
  bad: '#e8645b',
  heart: '#e8645b',
  free: '#2c2c33',
}

// Segment colors in reading order: messages, tools, mcp, memory, system, then the rest.
const SEG: Record<string, string> = {
  messages: '#8cc8e8',
  tools: '#b39ddb',
  mcp: '#7fc77a',
  memory: '#e8c15b',
  system: '#e8875b',
  skills: '#e88cb4',
  agents: '#6fd3c6',
  other: '#8a8a96',
}

const SHORT: [RegExp, string][] = [
  [/system prompt/i, 'system'],
  [/system tools/i, 'tools'],
  [/mcp/i, 'mcp'],
  [/memory/i, 'memory'],
  [/messages?/i, 'messages'],
  [/skills?/i, 'skills'],
  [/agents?/i, 'agents'],
]

export const shortName = (name: string) => SHORT.find(([re]) => re.test(name))?.[1] ?? name.toLowerCase().slice(0, 9)

export const fmtK = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  : n >= 10_000 ? `${Math.round(n / 1000)}k`
  : n >= 1000 ? `${(n / 1000).toFixed(1)}k`
  : String(Math.round(n))

export type Slice = { label: string; pct: number; color: string; cells: number }

const MAX_SLICES = 6

// One bar of exactly `width` cells: each used category's share of the window, then free space.
// Largest-remainder rounding keeps the cells summing to the width.
export function stackBar(cats: DeckCat[], window: number, width: number): { slices: Slice[]; free: number } {
  const used = cats.filter(c => c.kind === 'used' && c.tokens > 0).sort((a, b) => b.tokens - a.tokens)
  if (!used.length || window <= 0 || width <= 0) return { slices: [], free: Math.max(0, width) }
  const merged = new Map<string, number>()
  for (const c of used) merged.set(shortName(c.name), (merged.get(shortName(c.name)) ?? 0) + c.tokens)
  let parts = [...merged].map(([label, tokens]) => ({ label, share: tokens / window })).sort((a, b) => b.share - a.share)
  if (parts.length > MAX_SLICES) {
    const rest = parts.slice(MAX_SLICES - 1).reduce((n, p) => n + p.share, 0)
    parts = [...parts.slice(0, MAX_SLICES - 1), { label: 'other', share: rest }]
  }
  const total = parts.reduce((n, p) => n + p.share, 0)
  if (total > 1) parts = parts.map(p => ({ ...p, share: p.share / total }))
  const shares = [...parts.map(p => p.share), Math.max(0, 1 - Math.min(1, total))]
  const exact = shares.map(s => s * width)
  const cells = exact.map(Math.floor)
  let left = width - cells.reduce((a, b) => a + b, 0)
  const order = exact.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0])
  for (const [, i] of order) { if (left <= 0) break; cells[i]!++; left-- }
  const slices = parts.map((p, i) => ({ label: p.label, pct: Math.round(p.share * 100), color: SEG[p.label] ?? SEG.other!, cells: cells[i]! }))
  return { slices, free: cells[cells.length - 1]! }
}

// Braille area chart: one data point per dot column, two per cell, `rows` cells tall (4 dots each).
// Values are 0..100. The newest points sit at the right edge.
const LEFT = [0x40, 0x04, 0x02, 0x01]
const RIGHT = [0x80, 0x20, 0x10, 0x08]

export function brailleChart(values: number[], cols: number, rows: number): string[] {
  const pts = values.slice(-(cols * 2))
  const pad = cols * 2 - pts.length
  const dots = rows * 4
  const heights = [...Array<number>(pad).fill(-1), ...pts.map(v => Math.max(1, Math.round(Math.min(100, Math.max(0, v)) / 100 * dots)))]
  const lines: string[] = []
  for (let r = 0; r < rows; r++) {
    // r = 0 is the top row; its dots cover heights from dots - 4r - 3 .. dots - 4r
    const base = (rows - 1 - r) * 4
    let line = ''
    for (let c = 0; c < cols; c++) {
      let bits = 0
      for (const [side, map] of [[0, LEFT], [1, RIGHT]] as const) {
        const h = heights[c * 2 + side]!
        if (h < 0) continue
        for (let d = 0; d < 4; d++) if (h > base + d) bits |= map[d]!
      }
      line += bits ? String.fromCharCode(0x2800 + bits) : ' '
    }
    lines.push(line)
  }
  return lines
}

// Average growth over the last few turns, ignoring the drop a compaction makes.
export function growthPerTurn(points: DeckPoint[]): number | undefined {
  const deltas: number[] = []
  for (let i = Math.max(1, points.length - 4); i < points.length; i++) {
    const d = points[i]!.tokens - points[i - 1]!.tokens
    if (d > 0) deltas.push(d)
  }
  if (!deltas.length) return undefined
  return deltas.reduce((a, b) => a + b, 0) / deltas.length
}

export function turnsLeft(tokens: number, threshold: number | undefined, growth: number | undefined): number | undefined {
  if (!threshold || !growth || growth <= 0) return undefined
  return Math.max(0, Math.ceil((threshold - tokens) / growth))
}

// The three biggest things in the window that the person can actually trim.
export function heaviest(b: SessionContextBreakdown, n = 3): DeckSource[] {
  const out: DeckSource[] = []
  const servers = new Map<string, { tokens: number; tools: number }>()
  for (const t of b.mcpTools) {
    if (!t.isLoaded) continue
    const s = servers.get(t.serverName) ?? { tokens: 0, tools: 0 }
    servers.set(t.serverName, { tokens: s.tokens + t.tokens, tools: s.tools + 1 })
  }
  for (const [name, s] of servers) out.push({ kind: 'mcp', name: name.replace(/^claude\.ai /, ''), detail: `${s.tools} tools`, tokens: s.tokens })
  for (const f of b.memoryFiles) out.push({ kind: 'memory', name: f.path.split('/').pop() ?? f.path, detail: f.type.toLowerCase(), tokens: f.tokens })
  if (b.skills && b.skills.tokens > 0) out.push({ kind: 'skills', name: `${b.skills.includedSkills} listed`, detail: '', tokens: b.skills.tokens })
  const agentTokens = b.agents.reduce((s, a) => s + a.tokens, 0)
  if (agentTokens > 0) out.push({ kind: 'agents', name: `${b.agents.length} custom`, detail: '', tokens: agentTokens })
  return out.sort((a, b) => b.tokens - a.tokens).slice(0, n)
}

export function cacheHit(u: ModelUsage | null | undefined): number | undefined {
  if (!u) return undefined
  const read = u.cache_read_input_tokens ?? 0
  const all = (u.input_tokens ?? 0) + read + (u.cache_creation_input_tokens ?? 0)
  return all > 0 ? Math.round(read / all * 100) : undefined
}

// The tighter of the 5-hour and weekly windows, as five hearts of 20% each.
export function hearts(limits: DeckLimit[]): { full: number; label: string } | undefined {
  const known = limits.filter(l => /five|5h|seven|7d|week/i.test(l.kind))
  const pick = (known.length ? known : limits).slice().sort((a, b) => b.percentUsed - a.percentUsed)[0]
  if (!pick) return undefined
  const left = Math.max(0, Math.min(100, 100 - pick.percentUsed))
  const name = /five|5h/i.test(pick.kind) ? '5h limit' : /seven|7d|week/i.test(pick.kind) ? 'weekly limit' : pick.kind.replace(/_/g, ' ')
  return { full: Math.ceil(left / 20 - 0.001), label: `${name} ${Math.round(left)}% left` }
}

const base = (p: unknown) => (typeof p === 'string' ? p.split('/').pop() || p : '')
const clip = (s: string, n = 40) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

// What the status box says while a tool runs.
export function actOf(tool: string, input: Record<string, unknown>, at: number): DeckAct {
  const k = (kind: DeckActKind, label: string): DeckAct => ({ kind, label, at })
  switch (tool) {
    case 'Read': return k('read', `Reading ${base(input.file_path)}`)
    case 'Edit': case 'MultiEdit': return k('edit', `Editing ${base(input.file_path)}`)
    case 'Write': return k('edit', `Writing ${base(input.file_path)}`)
    case 'NotebookEdit': return k('edit', `Editing ${base(input.notebook_path)}`)
    case 'Bash': return k('shell', clip(typeof input.description === 'string' && input.description ? input.description : `$ ${String(input.command ?? '')}`))
    case 'Grep': case 'Glob': return k('read', clip(`Searching ${String(input.pattern ?? '')}`))
    case 'Agent': case 'Task': return k('agent', clip(`Agent: ${String(input.description ?? 'subagent')}`))
    case 'WebFetch': case 'WebSearch': return k('web', clip(`Browsing ${String(input.url ?? input.query ?? '')}`))
    case 'TaskCreate': case 'TaskUpdate': case 'TodoWrite': return k('think', 'Updating the plan')
    default:
      if (tool.startsWith('mcp__')) return k('web', clip(`${tool.split('__')[1] ?? 'mcp'}: ${tool.split('__')[2] ?? ''}`))
      return k('think', clip(tool))
  }
}

export const ACT_ICON: Record<DeckActKind, string> = {
  idle: '·', think: '✻', read: '◎', edit: '✎', shell: '❯', agent: '◆', web: '⌁', error: '✗', done: '✓', pass: '✓', fail: '✗',
}

export const ACT_COLOR: Record<DeckActKind, string> = {
  idle: COLORS.dim, think: COLORS.accent, read: '#8cc8e8', edit: COLORS.warn, shell: '#b39ddb',
  agent: '#6fd3c6', web: '#8cc8e8', error: COLORS.bad, done: COLORS.good, pass: COLORS.good, fail: COLORS.bad,
}

// The plan: in progress first, then pending, then the last few done.
export function planOrder(plan: DeckPlanItem[], doneShown = 3): { items: DeckPlanItem[]; hiddenDone: number } {
  const by = (s: DeckPlanItem['status']) => plan.filter(p => p.status === s)
  const done = by('completed')
  return { items: [...by('in_progress'), ...by('pending'), ...done.slice(-doneShown)], hiddenDone: Math.max(0, done.length - doneShown) }
}

export function applyTaskUpdate(plan: DeckPlanItem[], input: Record<string, unknown>): DeckPlanItem[] {
  const id = String(input.taskId ?? '')
  if (input.status === 'deleted') return plan.filter(p => p.id !== id)
  return plan.map(p => p.id !== id ? p : {
    ...p,
    ...(typeof input.subject === 'string' ? { title: input.subject } : {}),
    ...(typeof input.activeForm === 'string' ? { active: input.activeForm } : {}),
    ...(input.status === 'pending' || input.status === 'in_progress' || input.status === 'completed' ? { status: input.status } : {}),
  })
}

export function planFromTodos(input: Record<string, unknown>): DeckPlanItem[] {
  const todos = Array.isArray(input.todos) ? input.todos as { content?: unknown; status?: unknown; activeForm?: unknown }[] : []
  return todos.map((t, i) => ({
    id: `todo-${i}`,
    title: String(t.content ?? ''),
    ...(typeof t.activeForm === 'string' ? { active: t.activeForm } : {}),
    status: t.status === 'in_progress' || t.status === 'completed' ? t.status : 'pending',
  }))
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, '0')}`
}

// claude-opus-5-5[1m] -> Opus 5.5 · 1M; a name that is already pretty is kept.
export function prettyModel(id: string): string {
  const big = /\[1m\]|-1m\b|\b1m context/i.test(id) ? ' · 1M' : ''
  const m = /(opus|sonnet|haiku|fable)[-\s]?(\d+)(?:[-.](\d+))?/i.exec(id)
  if (!m) return id.replace(/\[.*?\]/, '') + big
  const name = m[1]![0]!.toUpperCase() + m[1]!.slice(1).toLowerCase()
  return `${name} ${m[2]}${m[3] && m[3].length <= 2 ? '.' + m[3] : ''}${big}`
}

// Each known window with what is left and when it resets: 5h 79% · 1h12m
export function limitRows(limits: DeckLimit[], now: number): { label: string; left: number; resets?: string }[] {
  const name = (k: string) => (/five|5h/i.test(k) ? '5h' : /seven|7d|week/i.test(k) ? '7d' : k.replace(/_/g, ' '))
  return limits.map(l => {
    const at = l.resetsAt ? Date.parse(l.resetsAt) : NaN
    const ms = at - now
    const resets = Number.isFinite(ms) && ms > 0
      ? ms >= 86_400_000 ? `${Math.round(ms / 86_400_000)}d` : ms >= 3_600_000 ? `${Math.floor(ms / 3_600_000)}h${String(Math.floor(ms / 60_000) % 60).padStart(2, '0')}m` : `${Math.ceil(ms / 60_000)}m`
      : undefined
    return { label: name(l.kind), left: Math.max(0, Math.round(100 - l.percentUsed)), ...(resets ? { resets } : {}) }
  })
}
