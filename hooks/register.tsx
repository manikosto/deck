import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { DeckAct, DeckAgent, DeckCtx, DeckFeedItem, DeckFile, DeckHistory, DeckInfo, DeckPlanItem, DeckTab, DeckTurn, DeckUsage } from '../types'
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

// A file's changes as a page in the preview pane: its git diff, or the whole file when git has nothing to say.
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
  try {
    await $.command.run({ command: 'preview', args: out })
  } catch {
    await $.process.run(['open', out]).catch(() => undefined)
  }
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

const TAB_ARGS: Record<string, DeckTab> = { plan: 'plan', context: 'plan', changes: 'changes', files: 'changes', agents: 'agents' }

export const register: Register = (on, options) => {
  const showPet = options.pet !== false
  const pct = Number(options.widthPercent)
  share = Number.isFinite(pct) && pct >= 10 && pct <= 80 ? pct / 100 : 0.3

  on('session.start', async ($, e, next) => {
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
    void refreshContext($, false)
    void refreshInfo($)
    return next(e)
  })

  on('command.run', { command: 'deck' }, async ($, e) => {
    const term = e.presentation.columns
    lastTerm = term
    const want = TAB_ARGS[e.args.trim().toLowerCase()]
    if (want) {
      await update($, tab, () => want)
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
    const term = e.viewport?.columns
    if (term && body && term > body + 4 && term !== lastTerm) {
      lastTerm = term
      const want = Math.max(MIN_COLS, Math.round(term * share))
      if (Math.abs(want - body) > 2) $.clock.after(0, () => { void $.ui.open(openArgs(term)) })
    }
    const [t, p, c, hist, a, u, f, ag, inf, fd, tn] = await Promise.all([read($, tab), read($, plan), read($, ctx), read($, history), read($, act), read($, usage), read($, files), read($, agents), read($, info), read($, feed), read($, turn)])
    return renderDeck(els, {
      tab: t, plan: p, ctx: c, history: hist, act: a, usage: u, files: f, agents: ag, info: inf, feed: fd, turn: tn,
      sleeping, blink: alarm && frame % 4 < 2,
      onFile: path => { void openDiff($, path) },
      now: Date.now(), width,
      pet: showPet && e.surface === 'terminal' ? petCells(sleeping ? 'sleep' : moodOf(a.kind), frame, 1) : undefined,
    }, next => { void update($, tab, () => next) })
  })
}
