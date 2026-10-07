import type { DeckActKind, DeckFeedItem, DeckLimit, DeckPoint } from '../types'

// ---- tests ---------------------------------------------------------------

const TEST_CMD = /(^|[\s;&|(])(npm (run )?test|npm t|pnpm (run )?test|yarn test|bun test|npx (jest|vitest)|jest|vitest|pytest|go test|cargo test|swift test|xcodebuild[^|;&]*\btest\b|mvn test|gradle(w)? test|rspec|phpunit|deno test|claude plugin test)(\b|$)/
const FAILED_COUNT = /\b([1-9]\d*) (failed|failing|failures?|errors?)\b|AssertionError|panicked at/i
const FAILED_MARK = /\bFAIL(ED)?\b|^\s*[✗✘]/m

export const isTestCommand = (cmd: string) => TEST_CMD.test(cmd)

export function testOutcome(isError: boolean, text: string): 'pass' | 'fail' {
  if (isError) return 'fail'
  return FAILED_COUNT.test(text) || FAILED_MARK.test(text) ? 'fail' : 'pass'
}

// ---- loops ---------------------------------------------------------------

// The same call three times in the last six is a loop worth a look.
export function loopOf(recent: string[], sig: string): boolean {
  const last = [...recent.slice(-5), sig]
  return last.filter(s => s === sig).length >= 3
}

export function callSig(tool: string, input: Record<string, unknown>): string {
  const { tool: _t, tool_use_id: _i, agentId: _a, consent: _c, description: _d, ...args } = input
  return `${tool}:${JSON.stringify(args).slice(0, 300)}`
}

// ---- feed ----------------------------------------------------------------

export function feedItem(kind: DeckActKind, text: string, at: number, ok?: boolean): DeckFeedItem {
  return { kind, text, at, ...(ok === undefined ? {} : { ok }) }
}

export const pushFeed = (list: DeckFeedItem[], item: DeckFeedItem, max = 40) => [...list, item].slice(-max)

// ---- context pulse -------------------------------------------------------

const BLOCKS = '▁▂▃▄▅▆▇█'

// One block per turn: how many tokens that turn added, scaled to the largest.
export function deltaBars(points: DeckPoint[], n: number): { bars: string; last?: number; max: number } {
  const deltas: number[] = []
  for (let i = 1; i < points.length; i++) deltas.push(Math.max(0, points[i]!.tokens - points[i - 1]!.tokens))
  const shown = deltas.slice(-n)
  const max = Math.max(1, ...shown)
  const bars = shown.map(d => (d <= 0 ? ' ' : BLOCKS[Math.min(7, Math.floor(d / max * 7.999))]!)).join('')
  return { bars, last: deltas[deltas.length - 1], max }
}

// ---- limits --------------------------------------------------------------

export function tightest(limits: DeckLimit[]): { kind: string; left: number } | undefined {
  const pick = limits.slice().sort((a, b) => b.percentUsed - a.percentUsed)[0]
  return pick ? { kind: pick.kind, left: Math.max(0, 100 - pick.percentUsed) } : undefined
}

export const ALARM_LEFT = 15

// ---- robot talk ----------------------------------------------------------

export type Mood = 'idle' | 'work' | 'think' | 'error' | 'done' | 'dance' | 'sad' | 'sleep'

const LINES: Record<Mood, string[]> = {
  idle: ['ready when you are', 'what are we building?', 'standing by', 'hm, quiet in here'],
  work: ['on it', 'beep boop, working', 'crunching', 'almost there…'],
  think: ['thinking…', 'let me see', 'pondering', 'hmm'],
  error: ['ouch', 'that broke', 'well, that failed', 'retrying in my head'],
  done: ['done!', 'shipped it', 'all yours', 'nailed it'],
  dance: ['tests green!', 'all passing ♪', 'green across the board', 'woo!'],
  sad: ['tests failed…', 'red again', 'something broke', 'let us fix it'],
  sleep: ['zZz', 'zz… wake me up', 'dreaming of diffs', 'zZz…'],
}

export const SLEEP_AFTER_MS = 120_000

export function phrase(mood: Mood, at: number): string {
  const list = LINES[mood]
  return list[Math.floor(at / 1000) % list.length]!
}

// ---- diff page -----------------------------------------------------------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// A git diff (or a whole new file) as a dark HTML page the browser opens.
export function diffHtml(title: string, diff: string, isWholeFile: boolean): string {
  const rows = diff.split('\n').map(line => {
    const cls = isWholeFile ? 'add' : line.startsWith('+++') || line.startsWith('---') ? 'meta' : line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('diff ') || line.startsWith('index ') ? 'meta' : ''
    return `<div class="${cls}">${esc(line) || '&nbsp;'}</div>`
  }).join('')
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>
<style>
body{margin:0;background:#1e1e24;color:#d8d8de;font:13px/1.45 ui-monospace,Menlo,monospace}
h1{font:600 14px system-ui;margin:0;padding:10px 14px;background:#2a2a33;color:#e8875b;position:sticky;top:0}
pre{margin:0;padding:6px 0}div{padding:0 14px;white-space:pre-wrap;word-break:break-all}
.add{background:#1f3a24;color:#a6e3a1}.del{background:#3d1f22;color:#f38ba8}.hunk{color:#8cc8e8;background:#22303a}.meta{color:#8a8a96}
</style><h1>${esc(title)}${isWholeFile ? ' · new file' : ''}</h1><pre>${rows}</pre>`
}
