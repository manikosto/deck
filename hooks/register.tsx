import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { DeckAct, DeckAgent, DeckCtx, DeckFeedItem, DeckFile, DeckHistory, DeckInfo, DeckBack, DeckPlanItem, DeckSession, DeckTab, DeckTurn, DeckUsage } from '../types'
import { actOf, ago, applyTaskUpdate, cacheHit, fmtK, growthPerTurn, heaviest, planFromTodos, prettyModel, turnsLeft } from './model.ts'
import { ALARM_LEFT, SLEEP_AFTER_MS, callSig, diffHtml, feedItem, isTestCommand, loopOf, pushFeed, testOutcome, tightest } from './extras.ts'
import { moodOf, petCells } from './pet.ts'
import { renderDeck } from './view.tsx'

const PANE = 'deck'
const MIN_COLS = 34

// The dock is asked for a share of the terminal, not a fixed width; a width the person dragged still wins.
let share = 0.3
let lastTerm = 0
const openArgs = (term?: number) =>
  term && term > 0 ? { id: PANE, title: 'deck', columns: Math.max(MIN_COLS, Math.round(term * share)) } : { id: PANE, title: 'deck' }

const tab = atom({ plugin: 'deck', key: 'tab' } as const, 'plan' as DeckTab)
const plan = atom({ plugin: 'deck', key: 'plan' } as const, [] as DeckPlanItem[])
const ctx = atom({ plugin: 'deck', key: 'ctx' } as const, null as DeckCtx | null)
const history = atom({ plugin: 'deck', key: 'history' } as const, { points: [], peak: 0, compactions: 0 } as DeckHistory)
const act = atom({ plugin: 'deck', key: 'act' } as const, { kind: 'idle', label: 'Waiting for you', at: 0 } as DeckAct)
const usage = atom({ plugin: 'deck', key: 'usage' } as const, { limits: [] } as DeckUsage)
const files = atom({ plugin: 'deck', key: 'files' } as const, [] as DeckFile[])
const agents = atom({ plugin: 'deck', key: 'agents' } as const, [] as DeckAgent[])
const info = atom({ plugin: 'deck', key: 'info' } as const, {} as DeckInfo)
const feed = atom({ plugin: 'deck', key: 'feed' } as const, [] as DeckFeedItem[])
const turn = atom({ plugin: 'deck', key: 'turn' } as const, { tools: 0 } as DeckTurn)
const sessions = atom({ plugin: 'deck', key: 'sessions' } as const, [] as DeckSession[])
const back = atom({ plugin: 'deck', key: 'back' } as const, null as DeckBack | null)

type Engine = EngineInterface

// The pet's current mood and frame live in the module: a reload restarts the animation, nothing more.
let frame = 0
let mood = moodOf('idle')
let actKind: DeckAct['kind'] = 'idle'
let actAt = Date.now()
let sleeping = false
// What makes the pane tick between events: a turn's timer, running subagents, a blinking alarm.
let turnActive = false
let agentsActive = false
let alarm = false
let recentSigs: string[] = []
let loopWarned = false
let compactWarned = false
const limitWarned = new Set<string>()
let tmp = '/tmp'

async function setAct($: Engine, next: DeckAct) {
  mood = moodOf(next.kind)
  actKind = next.kind
  actAt = next.at || Date.now()
  sleeping = false
  await update($, act, () => next)
}

// ---- every Claude Code background session ----------------------------------

let home = ''
let termProgram = ''
let sessionsBusy = false

// `claude agents --json --all` is the list the agent view shows; each background session's job folder
// says what it waits for and when it last moved, and ~/.claude/sessions says which have a live process.
async function liveSessionIds($: Engine): Promise<Set<string>> {
  const dir = `${home}/.claude/sessions`
  const bySid = new Map<string, string>()
  try {
    for (const en of await $.fs.list(dir)) {
      if (!en.name.endsWith('.json')) continue
      try {
        const j = JSON.parse(await $.fs.read(`${dir}/${en.name}`)) as { pid?: unknown; sessionId?: unknown }
        if (typeof j.pid === 'number' && typeof j.sessionId === 'string') bySid.set(String(j.pid), j.sessionId)
      } catch {}
    }
    if (!bySid.size) return new Set()
    const r = await $.process.run(['ps', '-o', 'pid=', '-p', [...bySid.keys()].join(',')], { timeoutMs: 5000 })
    return new Set(r.stdout.split('\n').map(x => x.trim()).filter(Boolean).map(pid => bySid.get(pid)!).filter(Boolean))
  } catch {
    return new Set()
  }
}

async function refreshSessions($: Engine) {
  if (sessionsBusy) return
  sessionsBusy = true
  try {
    const [r, live, current] = await Promise.all([
      $.process.run(['claude', 'agents', '--json', '--all'], { timeoutMs: 15000 }),
      liveSessionIds($),
      $.session.id().catch(() => ''),
    ])
    if (r.exitCode !== 0) return
    const raw = JSON.parse(r.stdout) as { id?: string; sessionId?: string; name?: string; state?: string; kind?: string; cwd?: string; startedAt?: number }[]
    const bg = raw.filter(x => x.kind === 'background' && typeof x.id === 'string' && /^[0-9a-f]{6,16}$/.test(x.id) && x.sessionId !== current)
    const out: DeckSession[] = await Promise.all(bg.map(async x => {
      const dir = `${home}/.claude/jobs/${x.id}`
      let needs: string | undefined
      let at = x.startedAt ?? 0
      try {
        const st = JSON.parse(await $.fs.read(`${dir}/state.json`)) as { needs?: unknown; detail?: unknown }
        const text = typeof st.needs === 'string' && st.needs ? st.needs : typeof st.detail === 'string' ? st.detail : ''
        if (text) needs = text.replace(/\s+/g, ' ').trim()
      } catch {}
      try { at = Math.max(at, (await $.fs.stat(`${dir}/timeline.jsonl`)).mtimeMs) } catch {}
      const sessionId = x.sessionId ?? ''
      return { id: x.id!, sessionId, live: live.has(sessionId), name: x.name || x.id!, state: x.state ?? 'idle', cwd: x.cwd ?? '', at, ...(needs ? { needs } : {}) }
    }))
    out.sort((a, b) => b.at - a.at)
    await update($, sessions, () => out.slice(0, 60))
  } catch {} finally {
    sessionsBusy = false
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// A session with no process of its own opens right here (/resume), and ← back returns; one that runs
// elsewhere opens in a new terminal window (claude attach), since two processes must not share a session.
async function openSession($: Engine, s: DeckSession) {
  if (!/^[0-9a-f]{6,16}$/.test(s.id)) return
  if (!s.live && UUID.test(s.sessionId)) {
    const current = await $.session.id().catch(() => '')
    const name = 'previous session'
    if (current && current !== s.sessionId) {
      const b: DeckBack = { sessionId: current, name }
      await $.store.set('back', b)
      await update($, back, () => b)
    }
    try {
      await $.command.run({ command: 'resume', args: s.sessionId })
      return
    } catch (err) {
      $.ui.toast(`Could not switch here (${err instanceof Error ? err.message : String(err)}); opening a new window`)
    }
  }
  const cmd = `claude attach ${s.id}`
  try {
    if (/ghostty/i.test(termProgram)) await $.process.run(['open', '-na', 'Ghostty', '--args', '-e', 'claude', 'attach', s.id])
    else if (/iterm/i.test(termProgram)) await $.process.run(['osascript', '-e', `tell application "iTerm" to create window with default profile command ${JSON.stringify(cmd)}`])
    else await $.process.run(['osascript', '-e', 'tell application "Terminal"', '-e', 'activate', '-e', `do script ${JSON.stringify(cmd)}`, '-e', 'end tell'])
    $.ui.toast(`“${s.name.slice(0, 40)}” runs elsewhere: opened it in a new window`)
  } catch (err) {
    $.ui.toast(`Could not open it: ${err instanceof Error ? err.message : String(err)}. Run: ${cmd}`)
  }
}

async function goBack($: Engine) {
  const b = await read($, back)
  if (!b || !UUID.test(b.sessionId)) return
  await $.store.delete('back')
  await update($, back, () => null)
  try { await $.command.run({ command: 'resume', args: b.sessionId }) } catch (err) {
    $.ui.toast(`Could not go back: ${err instanceof Error ? err.message : String(err)}. Run: /resume ${b.sessionId}`)
  }
}

async function log($: Engine, item: DeckFeedItem) {
  await update($, feed, list => pushFeed(list, item))
}

async function checkLimits($: Engine, limits: DeckUsage['limits']) {
  const t = tightest(limits)
  alarm = !!t && t.left < ALARM_LEFT
  if (t && alarm && !limitWarned.has(t.kind)) {
    limitWarned.add(t.kind)
    const name = /five|5h/i.test(t.kind) ? '5-hour' : /seven|7d|week/i.test(t.kind) ? 'weekly' : t.kind
    $.ui.toast(`Only ${Math.round(t.left)}% of the ${name} limit left`)
  }
}

// A file's changes as a page in the browser: its git diff, or the whole file when git has nothing to say.
async function openDiff($: Engine, path: string) {
  const dir = path.slice(0, path.lastIndexOf('/')) || '/'
  const name = path.split('/').pop() ?? path
  let text = ''
  let whole = false
  const d = await $.process.run(['git', '-C', dir, 'diff', '--no-color', 'HEAD', '--', path], { timeoutMs: 5000 }).catch(() => undefined)
  if (d && d.exitCode === 0 && d.stdout.trim()) text = d.stdout
  else {
    text = await $.fs.read(path).catch(() => '')
    whole = true
  }
  const out = `${tmp}/deck-diff-${name.replace(/[^\w.-]/g, '_')}.html`
  await $.fs.write(out, diffHtml(path, text.slice(0, 400_000), whole))
  await $.process.run(['open', out]).catch(() => undefined)
}

async function refreshContext($: Engine, pushPoint: boolean) {
  try {
    const u = await $.session.usage({ breakdown: 'summary' })
    const limits = u.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt }))
    await update($, usage, () => ({ limits, costUsd: u.cost?.usd }))
    await checkLimits($, limits)
    const b = u.context.breakdown
    const tokens = u.context.tokens ?? b?.totalTokens ?? 0
    const window = b?.maxTokens ?? u.context.window
    const percent = u.context.percent ?? (window > 0 ? Math.round(tokens / window * 100) : 0)
    if (!tokens && !b) return
    await update($, ctx, () => ({
      percent, tokens, window,
      cats: b ? b.categories.map(c => ({ name: c.name, tokens: c.tokens, kind: c.kind })) : [],
      threshold: b?.autoCompactThreshold,
      autoCompact: b?.isAutoCompactEnabled ?? false,
      heavy: b ? heaviest(b) : [],
      cacheHit: cacheHit(b?.apiUsage),
    }))
    if (pushPoint) {
      const hs = await update($, history, hs => ({ ...hs, points: [...hs.points, { pct: percent, tokens }].slice(-120), peak: Math.max(hs.peak, percent) }))
      const left = b?.isAutoCompactEnabled ? turnsLeft(tokens, b.autoCompactThreshold, growthPerTurn(hs.points)) : undefined
      if (left !== undefined && left <= 3 && !compactWarned) {
        compactWarned = true
        $.ui.toast(`Context: auto-compact in ~${left} turn${left === 1 ? '' : 's'}`)
      }
      if (left === undefined || left > 3) compactWarned = false
    }
  } catch (err) {
    $.ui.log(`deck: context read failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
  }
}

async function refreshInfo($: Engine) {
  try {
    const [model, cwd] = await Promise.all([$.session.model().catch(() => ''), $.session.cwd().catch(() => '')])
    let branch: string | undefined
    let dirty: number | undefined
    if (cwd) {
      const r = await $.process.run(['git', '-C', cwd, 'status', '--porcelain=v1', '--branch'], { timeoutMs: 3000 }).catch(() => undefined)
      if (r && r.exitCode === 0) {
        const lines = r.stdout.split('\n').filter(Boolean)
        const head = lines[0] ?? ''
        branch = /^## (?:No commits yet on )?([^.\s]+)/.exec(head)?.[1]
        dirty = lines.length - 1
      }
    }
    await update($, info, () => ({ ...(model ? { model: prettyModel(model) } : {}), ...(branch ? { branch } : {}), ...(dirty !== undefined ? { dirty } : {}) }))
  } catch {}
}

async function togglePane($: Engine, term?: number): Promise<string> {
  const open = (await $.ui.panes()).find(p => p.id === PANE)
  if (open?.isShown) { await $.ui.close({ id: PANE }); return 'deck closed' }
  const r = await $.ui.open(openArgs(term))
  return r.isPlaced ? 'deck open' : `deck waits: ${r.reason ?? 'no room'}`
}

const TAB_ARGS: Record<string, DeckTab> = { plan: 'plan', context: 'plan', changes: 'changes', files: 'changes', agents: 'agents', subagents: 'agents', global: 'global', sessions: 'global', all: 'global' }

// The dock is shared by every pane in it, so a pane asks for its width again each time its tab comes to the
// front: switching tabs moves the dock between widths. A width the person drags still wins until then.
let termCols = 0
let wasShown = false
async function watchTab($: EngineInterface) {
  const me = (await $.ui.panes().catch(() => [])).find(p => p.id === PANE)
  const shownNow = !!me?.isShown
  if (shownNow && !wasShown && termCols > 0) void $.ui.open(openArgs(termCols))
  wasShown = shownNow
}

export const register: Register = (on, options) => {
  const showPet = options.pet !== false
  const pct = Number(options.widthPercent)
  share = Number.isFinite(pct) && pct >= 10 && pct <= 80 ? pct / 100 : 0.3

  on('session.start', async ($, e, next) => {
    $.clock.every(800, () => { void watchTab($) })
    await $.command.register({ name: 'deck', description: 'Toggle the deck pane: plan, context, changes, subagents', argumentHint: 'plan|changes|agents' })
    $.clock.every(350, () => {
      frame++
      // a long quiet spell puts the robot to sleep
      if (!sleeping && actKind === 'idle' && Date.now() - actAt > SLEEP_AFTER_MS) { sleeping = true; mood = 'sleep'; $.ui.invalidate('ui.render') }
      if (showPet) void $.ui.blit({ requestId: PANE, key: 'pet', ...petCells(mood, frame, 1) })
      // a turn's timer and subagents' elapsed times tick once a second; a limit alarm blinks twice as fast
      if ((frame % 3 === 0 && (turnActive || agentsActive)) || (alarm && frame % 2 === 0)) $.ui.invalidate('ui.render')
    })
    if (options.autoOpen !== false && e.isInteractive) void $.ui.open(openArgs())
    tmp = ((await $.env.get('TMPDIR')) || '/tmp').replace(/\/$/, '')
    home = (await $.env.get('HOME')) ?? ''
    const kept = await $.store.get('back').catch(() => undefined) as DeckBack | undefined
    if (kept && typeof kept.sessionId === 'string' && kept.sessionId !== (await $.session.id().catch(() => ''))) await update($, back, () => kept)
    termProgram = (await $.env.get('TERM_PROGRAM')) ?? ''
    // the session list: every 15s while its tab is open, every minute otherwise (for the count on the tab)
    void refreshSessions($)
    let ticks = 0
    $.clock.every(15000, () => {
      ticks++
      void read($, tab).then(t => { if (t === 'global' || ticks % 4 === 0) void refreshSessions($) })
    })
    void refreshContext($, false)
    void refreshInfo($)
    return next(e)
  })

  on('command.run', { command: 'deck' }, async ($, e) => {
    const term = e.presentation.columns
    lastTerm = term
    termCols = term
    const want = TAB_ARGS[e.args.trim().toLowerCase()]
    if (want) {
      await update($, tab, () => want)
      if (want === 'global') void refreshSessions($)
      await $.ui.open(openArgs(term))
      return { text: `deck: ${want}` }
    }
    return { text: await togglePane($, term) }
  })

  on('turn.start', async ($, e, next) => {
    turnActive = true
    recentSigs = []
    loopWarned = false
    await update($, turn, t => ({ ...t, startedAt: Date.now(), tools: 0, loop: undefined }))
    await setAct($, { kind: 'think', label: 'Thinking', at: Date.now() })
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const tool = String(e.tool)
    const now = Date.now()
    if (e.agentId) {
      await update($, agents, list => list.map(a => (a.agentId === e.agentId ? { ...a, tool: e.tool } : a)))
    } else {
      const sig = callSig(tool, input)
      const looping = loopOf(recentSigs, sig)
      recentSigs = [...recentSigs, sig].slice(-6)
      await update($, turn, t => ({ ...t, tools: t.tools + 1, ...(looping ? { loop: actOf(e.tool, input, now).label } : {}) }))
      if (looping && !loopWarned) {
        loopWarned = true
        $.ui.toast(`Looks like a loop: ${tool} with the same input 3 times`)
        await log($, feedItem('error', `Loop? ${actOf(e.tool, input, now).label}`, now, false))
      }
      await setAct($, actOf(e.tool, input, now))
      if (tool === 'Agent' || tool === 'Task') {
        const agent: DeckAgent = {
          id: e.tool_use_id, type: String(input.subagent_type ?? 'general-purpose'),
          description: String(input.description ?? ''), status: 'running', startedAt: now,
        }
        await update($, agents, list => [...list, agent].slice(-40))
        agentsActive = true
      }
    }

    const ran = await next(e)
    const ok = ran.deny === undefined && !ran.isError
    const result = (ok ? ran.result : undefined) as { task?: { id?: unknown }; type?: unknown; totalTokens?: unknown } | undefined

    if (ok && (e.tool === 'Edit' || e.tool === 'Write' || tool === 'MultiEdit' || e.tool === 'NotebookEdit')) {
      const path = String(input.file_path ?? input.notebook_path ?? '')
      if (path) {
        const isNew = e.tool === 'Write' && result?.type === 'create'
        await update($, files, list => {
          const old = list.find(f => f.path === path)
          const rest = list.filter(f => f.path !== path)
          return [...rest, { path, edits: (old?.edits ?? 0) + 1, isNew: old?.isNew || isNew, at: Date.now() }].slice(-100)
        })
      }
    }
    if (!e.agentId && ok) {
      if (e.tool === 'TaskCreate') {
        const id = result?.task?.id !== undefined ? String(result.task.id) : `t${now}`
        const item: DeckPlanItem = { id, title: String(input.subject ?? ''), status: 'pending', ...(typeof input.activeForm === 'string' ? { active: input.activeForm } : {}) }
        await update($, plan, p => [...p.filter(x => x.id !== id), item])
      }
      if (e.tool === 'TaskUpdate') await update($, plan, p => applyTaskUpdate(p, input))
      if (e.tool === 'TodoWrite') await update($, plan, () => planFromTodos(input))
    }
    if (!e.agentId && (tool === 'Agent' || tool === 'Task')) {
      // a foreground subagent is done when its call returns; a background one waits for its turn.complete
      const tokens = typeof result?.totalTokens === 'number' ? result.totalTokens : undefined
      if (tokens !== undefined || !ok) {
        await update($, agents, list => list.map(a => (a.id === e.tool_use_id ? { ...a, status: (ok ? 'done' : 'failed') as DeckAgent['status'], endedAt: Date.now(), tokens, tool: undefined } : a)))
      }
    }
    if (!e.agentId) {
      const label = actOf(e.tool, input, now).label
      const command = tool === 'Bash' ? String(input.command ?? '') : ''
      if (command && isTestCommand(command) && ran.deny === undefined) {
        const outcome = testOutcome(ran.isError === true, ran.text ?? '')
        await setAct($, { kind: outcome, label: outcome === 'pass' ? 'Tests passed' : 'Tests failed', at: Date.now() })
        await log($, feedItem(outcome, outcome === 'pass' ? 'Tests passed' : 'Tests failed', Date.now(), outcome === 'pass'))
      } else {
        if (!ok) await setAct($, { kind: 'error', label: `${e.tool} failed`, at: Date.now() })
        if (!(tool === 'TaskUpdate' || tool === 'TaskCreate' || tool === 'TodoWrite' || tool === 'TaskGet' || tool === 'TaskList')) {
          await log($, feedItem(actOf(e.tool, input, now).kind, label, Date.now(), ok))
        }
      }
      void refreshContext($, false)
    }
    return ran
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.agentId) await update($, agents, list => list.map(a => (a.id === e.tool_use_id ? { ...a, agentId: r.agentId } : a)))
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) {
      const u = e.usage
      const tokens = u ? u.input_tokens + u.output_tokens + (u.cache_creation_input_tokens ?? 0) : undefined
      const list = await update($, agents, list => list.map(a => (a.agentId === e.agentId && a.status === 'running' ? { ...a, status: 'done' as const, endedAt: Date.now(), tokens: a.tokens ?? tokens, tool: undefined } : a)))
      agentsActive = list.some(a => a.status === 'running')
      const done = list.find(a => a.agentId === e.agentId)
      if (done) await log($, feedItem('agent', `${done.type} done in ${ago((done.endedAt ?? Date.now()) - done.startedAt)}${done.tokens ? ` · ${fmtK(done.tokens)} tok` : ''}`, Date.now(), true))
      return r
    }
    turnActive = false
    const t = await update($, turn, t => ({ ...t, startedAt: undefined, lastMs: t.startedAt ? Date.now() - t.startedAt : undefined, lastTools: t.tools }))
    await log($, feedItem(e.isAborted ? 'idle' : e.reason === 'error' ? 'error' : 'done', `${e.isAborted ? 'Interrupted' : 'Turn done'}${t.lastMs ? ` in ${ago(t.lastMs)}` : ''} · ${t.lastTools ?? 0} tools`, Date.now(), !e.isAborted && e.reason !== 'error'))
    // a test verdict outlives the end of the turn a little longer, so the robot gets to react
    const verdict = actKind === 'pass' || actKind === 'fail'
    if (!verdict) await setAct($, e.isAborted ? { kind: 'idle', label: 'Interrupted', at: Date.now() } : e.reason === 'error' ? { kind: 'error', label: 'The turn hit an error', at: Date.now() } : { kind: 'done', label: 'Done', at: Date.now() })
    await refreshContext($, true)
    void refreshInfo($)
    // after a moment the robot settles back to idle
    $.clock.after(verdict ? 12000 : 6000, () => { void read($, act).then(a => { if (a.kind === 'done' || a.kind === 'pass' || a.kind === 'fail') void setAct($, { kind: 'idle', label: 'Waiting for you', at: Date.now() }) }) })
    return r
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId && !('skip' in r && r.skip)) {
      await update($, history, hs => ({ ...hs, compactions: hs.compactions + 1 }))
      void refreshContext($, true)
    }
    return r
  })

  on('session.measure', async ($, e, next) => {
    const limits = e.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt }))
    await update($, usage, () => ({ limits, costUsd: e.cost?.usd }))
    await checkLimits($, limits)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, plan, () => [])
      await update($, files, () => [])
      await update($, agents, () => [])
      await update($, ctx, () => null)
      await update($, history, () => ({ points: [], peak: 0, compactions: 0 }))
      await update($, feed, () => [])
      await update($, turn, () => ({ tools: 0 }))
      await setAct($, { kind: 'idle', label: 'Waiting for you', at: Date.now() })
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e) as any
    const body = (e.props as { bodyColumns?: number }).bodyColumns
    const width = Math.max(24, body ?? e.viewport?.columns ?? 40)
    // Opened at session start the dock takes its default share; once the terminal's width is known
    // (or changes), ask once for our share of it. The viewport is the whole terminal when wider than the body.
    const [t, p, c, hist, a, u, f, ag, inf, fd, tn, ss, bk] = await Promise.all([read($, tab), read($, plan), read($, ctx), read($, history), read($, act), read($, usage), read($, files), read($, agents), read($, info), read($, feed), read($, turn), read($, sessions), read($, back)])
    return renderDeck(els, {
      tab: t, plan: p, ctx: c, history: hist, act: a, usage: u, files: f, agents: ag, info: inf, feed: fd, turn: tn,
      sleeping, blink: alarm && frame % 4 < 2,
      onFile: path => { void openDiff($, path) },
      sessions: ss,
      onSession: sess => { void openSession($, sess) },
      back: bk,
      onBack: () => { void goBack($) },
      now: Date.now(), width,
      pet: showPet && e.surface === 'terminal' ? petCells(sleeping ? 'sleep' : moodOf(a.kind), frame, 1) : undefined,
    }, next => { void update($, tab, () => next); if (next === 'global') void refreshSessions($) })
  })
}
