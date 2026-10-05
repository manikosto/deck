import type { DeckAct, DeckAgent, DeckCtx, DeckFeedItem, DeckFile, DeckHistory, DeckInfo, DeckPlanItem, DeckTab, DeckTurn, DeckUsage } from '../types'
import { deltaBars, phrase } from './extras.ts'
import { moodOf } from './pet.ts'
import {
  ACT_COLOR, ACT_ICON, COLORS, ago, brailleChart, fmtK, growthPerTurn, hearts, limitRows, planOrder, stackBar, turnsLeft,
} from './model.ts'

export type Els = { Box: any; Text: any; Button: any; Raster?: any }

export type DeckView = {
  tab: DeckTab
  plan: DeckPlanItem[]
  ctx: DeckCtx | null
  history: DeckHistory
  act: DeckAct
  usage: DeckUsage
  files: DeckFile[]
  agents: DeckAgent[]
  info: DeckInfo
  feed: DeckFeedItem[]
  turn: DeckTurn
  sleeping: boolean
  blink: boolean
  onFile: (path: string) => void
  now: number
  width: number
  pet?: { cells: string; columns: number; rows: number }
}

const TABS: [DeckTab, string][] = [['changes', 'Changes'], ['agents', 'Agents'], ['plan', 'Plan & context']]

const clip = (s: string, n: number) => (n <= 1 ? '' : s.length > n ? s.slice(0, n - 1) + '…' : s)

function Section(els: Els, key: string, title: string, meta: string, inner: number, children: any[]) {
  const { Box, Text } = els
  return (
    <Box key={key} flexDirection="column" borderStyle="round" borderColor={COLORS.faint} paddingX={1} marginTop={1} width={inner + 4}>
      <Box key="head" flexDirection="row" justifyContent="space-between">
        <Text bold color={COLORS.text}>{title}</Text>
        <Text color={COLORS.dim}>{meta}</Text>
      </Box>
      {children}
    </Box>
  )
}

function planSection(els: Els, plan: DeckPlanItem[], inner: number) {
  const { Text } = els
  const done = plan.filter(p => p.status === 'completed').length
  const { items, hiddenDone } = planOrder(plan)
  const rows = items.map(p => {
    if (p.status === 'in_progress') return <Text key={p.id} wrap="truncate"><Text color={COLORS.accent}>◉ </Text><Text bold color={COLORS.text}>{clip(p.active ?? p.title, inner - 2)}</Text></Text>
    if (p.status === 'pending') return <Text key={p.id} wrap="truncate"><Text color={COLORS.dim}>○ </Text><Text color={COLORS.text}>{clip(p.title, inner - 2)}</Text></Text>
    return <Text key={p.id} wrap="truncate"><Text color={COLORS.good}>✓ </Text><Text color={COLORS.dim}>{clip(p.title, inner - 2)}</Text></Text>
  })
  if (hiddenDone) rows.push(<Text key="more" color={COLORS.faint}>{`  +${hiddenDone} done`}</Text>)
  if (!plan.length) rows.push(<Text key="empty" color={COLORS.faint}>No plan yet.</Text>)
  return Section(els, 'plan', 'PLAN', plan.length ? `${done}/${plan.length}` : '', inner, rows)
}

function contextSection(els: Els, ctx: DeckCtx | null, history: DeckHistory, inner: number) {
  const { Box, Text } = els
  if (!ctx) return Section(els, 'ctx', 'CONTEXT', '', inner, [<Text key="wait" color={COLORS.faint}>Waits for the first response.</Text>])
  const rows: any[] = []
  const bar = stackBar(ctx.cats, ctx.window, inner)
  const markAt = ctx.autoCompact && ctx.threshold ? Math.min(inner - 1, Math.round(ctx.threshold / ctx.window * inner)) : -1
  // the bar, with the auto-compact point drawn as ┊ over the free part
  const segs: any[] = []
  let x = 0
  bar.slices.forEach((s, i) => { if (s.cells > 0) segs.push(<Text key={'s' + i} color={s.color}>{'█'.repeat(s.cells)}</Text>); x += s.cells })
  const freeCells = bar.slices.length ? bar.free : inner
  if (markAt >= x && markAt < x + freeCells) {
    segs.push(<Text key="f1" color={COLORS.free}>{'█'.repeat(markAt - x)}</Text>)
    segs.push(<Text key="mk" color={COLORS.text} backgroundColor={COLORS.free}>┊</Text>)
    segs.push(<Text key="f2" color={COLORS.free}>{'█'.repeat(Math.max(0, x + freeCells - markAt - 1))}</Text>)
  } else segs.push(<Text key="f" color={COLORS.free}>{'█'.repeat(freeCells)}</Text>)
  rows.push(<Text key="bar" wrap="truncate">{segs}</Text>)

  // the legend, wrapped to the width
  const legend = bar.slices.filter(s => s.pct > 0)
  let line: any[] = []
  let used = 0
  const lines: any[][] = []
  for (const s of legend) {
    const w = s.label.length + String(s.pct).length + 5
    if (used + w > inner && line.length) { lines.push(line); line = []; used = 0 }
    line.push(<Text key={s.label}><Text color={s.color}>● </Text><Text color={COLORS.dim}>{`${s.label} ${s.pct}%   `}</Text></Text>)
    used += w
  }
  if (line.length) lines.push(line)
  lines.forEach((l, i) => rows.push(<Text key={'lg' + i} wrap="truncate">{l}</Text>))

  // the history chart, with the auto-compact threshold as a dotted line on top
  const pts = history.points.map(p => p.pct)
  if (pts.length > 1) {
    const chartCols = Math.max(4, inner - 6)
    const thr = ctx.autoCompact && ctx.threshold ? Math.round(ctx.threshold / ctx.window * 100) : undefined
    rows.push(<Text key="sp" color={COLORS.faint}> </Text>)
    if (thr !== undefined) rows.push(<Text key="thr" wrap="truncate"><Text color={COLORS.accent}>{'·'.repeat(chartCols)}</Text><Text color={COLORS.dim}>{` ${thr}%`}</Text></Text>)
    brailleChart(pts, chartCols, 2).forEach((l, i) => rows.push(<Text key={'ch' + i} color={COLORS.accent}>{l}</Text>))
    const growth = growthPerTurn(history.points)
    const left = turnsLeft(ctx.tokens, ctx.threshold, growth)
    const parts = [growth ? `+${fmtK(growth)}/turn` : undefined, left !== undefined && ctx.autoCompact ? `auto-compact in ~${left} turn${left === 1 ? '' : 's'}` : undefined].filter(Boolean)
    const soon = left !== undefined && ctx.autoCompact && left <= 3
    if (parts.length) rows.push(<Text key="grow" color={soon ? COLORS.warn : COLORS.dim} bold={soon} wrap="truncate">{(soon ? '⚠ ' : '') + parts.join(' · ')}</Text>)
  }
  // the pulse: what each recent turn added to the window
  if (history.points.length > 2) {
    const pulse = deltaBars(history.points, Math.max(4, inner - 18))
    if (pulse.bars.trim()) {
      rows.push(
        <Text key="pulse" wrap="truncate"><Text color={COLORS.dim}>per turn </Text><Text color="#8cc8e8">{pulse.bars}</Text><Text color={COLORS.dim}>{pulse.last !== undefined ? ` +${fmtK(pulse.last)}` : ''}</Text></Text>,
      )
    }
  }

  // the heaviest sources the person can trim
  if (ctx.heavy.length) {
    rows.push(<Text key="sp2"> </Text>)
    const kindW = Math.max(...ctx.heavy.map(s => s.kind.length)) + 1
    for (const src of ctx.heavy) {
      const tok = fmtK(src.tokens)
      const nameW = Math.max(1, inner - kindW - tok.length - 1)
      const label = clip(src.detail ? `${src.name} ${src.detail}` : src.name, nameW)
      rows.push(
        <Box key={'h' + src.kind + src.name} flexDirection="row" justifyContent="space-between" width={inner}>
          <Text wrap="truncate"><Text color={COLORS.dim}>{src.kind.padEnd(kindW)}</Text><Text color={COLORS.text}>{label.slice(0, src.name.length)}</Text><Text color={COLORS.dim}>{label.slice(src.name.length)}</Text></Text>
          <Text color={COLORS.text}>{tok}</Text>
        </Box>,
      )
    }
  }
  const foot = [
    ctx.cacheHit !== undefined ? `cache hit ${ctx.cacheHit}%` : undefined,
    history.peak ? `peak ${history.peak}%` : undefined,
    history.compactions ? `compacted ${history.compactions}×` : undefined,
  ].filter(Boolean)
  if (foot.length) rows.push(<Text key="foot" color={COLORS.dim} wrap="truncate">{foot.join(' · ')}</Text>)
  return Section(els, 'ctx', 'CONTEXT', `${ctx.percent}% · ${fmtK(ctx.tokens)} / ${fmtK(ctx.window)}`, inner, rows)
}

function changesSection(els: Els, files: DeckFile[], inner: number, now: number, onFile: (path: string) => void) {
  const { Box, Text, Button } = els
  const rows = files.slice().sort((a, b) => b.at - a.at).slice(0, 14).map(f => {
    const tag = f.isNew ? 'new' : `${f.edits}×`
    const when = ago(now - f.at)
    const name = f.path.split('/').pop() ?? f.path
    const dir = f.path.split('/').slice(-2, -1)[0]
    return (
      <Box key={f.path} flexDirection="row" justifyContent="space-between" width={inner}>
        <Box flexDirection="row">
          <Text color={f.isNew ? COLORS.good : COLORS.warn}>{f.isNew ? '+ ' : '✎ '}</Text>
          <Button key={'file-' + f.path} label={clip(name, inner - 16)} plain onPress={() => onFile(f.path)} />
          <Text color={COLORS.faint} wrap="truncate">{dir ? `  ${clip(dir, 10)}` : ''}</Text>
        </Box>
        <Text color={COLORS.dim}>{`${tag} ${when}`}</Text>
      </Box>
    )
  })
  if (!files.length) rows.push(<Text key="none" color={COLORS.faint}>No files changed yet.</Text>)
  else rows.push(<Text key="hint" color={COLORS.faint}>click a file for its diff</Text>)
  return Section(els, 'changes', 'CHANGES', files.length ? `${files.length} file${files.length === 1 ? '' : 's'}` : '', inner, rows)
}

function agentsSection(els: Els, agents: DeckAgent[], inner: number, now: number) {
  const { Box, Text } = els
  const list = [...agents.filter(a => a.status === 'running'), ...agents.filter(a => a.status !== 'running').slice(-8).reverse()]
  const rows = list.map(a => {
    const icon = a.status === 'running' ? '◆' : a.status === 'done' ? '✓' : '✗'
    const color = a.status === 'running' ? ACT_COLOR.agent : a.status === 'done' ? COLORS.good : COLORS.bad
    const meta = [ago((a.endedAt ?? now) - a.startedAt), a.tokens ? `${fmtK(a.tokens)} tok` : undefined].filter(Boolean).join(' · ')
    return (
      <Box key={a.id} flexDirection="column" width={inner}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text wrap="truncate"><Text color={color}>{icon + ' '}</Text><Text bold={a.status === 'running'} color={COLORS.text}>{clip(a.type, 18)}</Text></Text>
          <Text color={COLORS.dim}>{meta}</Text>
        </Box>
        <Text color={COLORS.dim} wrap="truncate">{'  ' + clip(a.status === 'running' && a.tool ? `${a.description} · ${a.tool}` : a.description, inner - 2)}</Text>
      </Box>
    )
  })
  if (!agents.length) rows.push(<Text key="none" color={COLORS.faint}>No subagents this session.</Text>)
  const running = agents.filter(a => a.status === 'running').length
  return Section(els, 'agents', 'AGENTS', running ? `${running} running` : agents.length ? `${agents.length} total` : '', inner, rows)
}

function statusBox(els: Els, v: DeckView, inner: number) {
  const { Box, Text, Raster } = els
  const life = hearts(v.usage.limits)
  const act = v.act
  const rows: any[] = []
  if (v.info.model || v.info.branch) {
    rows.push(
      <Box key="who" flexDirection="row" justifyContent="space-between" width={inner}>
        <Text wrap="truncate"><Text color={COLORS.accent}>◆ </Text><Text bold color={COLORS.text}>{v.info.model ?? ''}</Text></Text>
        {v.info.branch ? <Text wrap="truncate"><Text color={COLORS.dim}>⎇ </Text><Text color="#8cc8e8">{clip(v.info.branch, 18)}</Text>{v.info.dirty ? <Text color={COLORS.warn}>{` ±${v.info.dirty}`}</Text> : null}</Text> : null}
      </Box>,
    )
  }
  rows.push(
    <Text key="act" wrap="truncate"><Text color={ACT_COLOR[act.kind]}>{ACT_ICON[act.kind] + ' '}</Text><Text color={ACT_COLOR[act.kind]} bold={act.kind !== 'idle'}>{clip(act.label, inner - 2)}</Text></Text>,
  )
  const tn = v.turn
  if (tn.startedAt) rows.push(<Text key="timer" color={COLORS.dim} wrap="truncate">{`⏱ ${ago(v.now - tn.startedAt)} · ${tn.tools} tool${tn.tools === 1 ? '' : 's'}`}</Text>)
  else if (tn.lastMs !== undefined) rows.push(<Text key="timer" color={COLORS.faint} wrap="truncate">{`last turn ${ago(tn.lastMs)} · ${tn.lastTools ?? 0} tools`}</Text>)
  if (tn.startedAt && tn.loop) rows.push(<Text key="loop" color={COLORS.warn} bold wrap="truncate">{`⟳ looping? ${clip(tn.loop, inner - 12)}`}</Text>)
  if (life) rows.push(<Text key="hearts" wrap="truncate"><Text color={v.blink ? COLORS.faint : COLORS.heart}>{'♥'.repeat(life.full)}</Text><Text color={COLORS.faint}>{'♡'.repeat(5 - life.full)}</Text><Text color={COLORS.dim}>{' ' + life.label}</Text></Text>)
  const windows = limitRows(v.usage.limits, v.now)
  if (windows.length) {
    rows.push(
      <Text key="limits" wrap="truncate" color={COLORS.dim}>
        {windows.map((w, i) => (
          <Text key={'w' + i}>{i ? '  ·  ' : ''}{w.label} <Text color={w.left <= 20 ? COLORS.bad : w.left <= 50 ? COLORS.warn : COLORS.good}>{`${w.left}%`}</Text>{w.resets ? ` ↻${w.resets}` : ''}</Text>
        ))}
      </Text>,
    )
  }
  if (v.usage.costUsd !== undefined && v.usage.costUsd > 0) rows.push(<Text key="cost" color={COLORS.dim}>{`$${v.usage.costUsd.toFixed(2)} this session${life ? ' (API-equivalent)' : ''}`}</Text>)
  const running = v.agents.filter(a => a.status === 'running').length
  if (running) rows.push(<Text key="ag" color={ACT_COLOR.agent}>{`◆ ${running} subagent${running === 1 ? '' : 's'} running`}</Text>)
  if (v.pet && Raster) {
    const mood = v.sleeping ? 'sleep' : moodOf(act.kind)
    rows.push(
      <Box key="say" flexDirection="row" justifyContent="center" width={inner} marginTop={1}>
        <Box borderStyle="round" borderColor={COLORS.faint} paddingX={1}><Text color={COLORS.text}>{phrase(mood, act.at + (mood === 'sleep' ? 7 : 0))}</Text></Box>
      </Box>,
    )
    rows.push(
      <Box key="pet" flexDirection="row" justifyContent="center" width={inner}>
        <Raster key="pet" columns={v.pet.columns} rows={v.pet.rows} cells={v.pet.cells} />
      </Box>,
    )
  }
  return (
    <Box key="status" flexDirection="column" borderStyle="round" borderColor={COLORS.faint} paddingX={1} marginTop={1} width={inner + 4}>
      {rows}
    </Box>
  )
}

function feedSection(els: Els, feed: DeckFeedItem[], inner: number, now: number) {
  const { Box, Text } = els
  if (!feed.length) return null
  const rows = feed.slice(-10).reverse().map((f, i) => (
    <Box key={'fd' + i + f.at} flexDirection="row" justifyContent="space-between" width={inner}>
      <Text wrap="truncate"><Text color={f.ok === false ? COLORS.bad : ACT_COLOR[f.kind]}>{(f.ok === false ? '✗' : ACT_ICON[f.kind]) + ' '}</Text><Text color={i === 0 ? COLORS.text : COLORS.dim}>{clip(f.text, inner - 9)}</Text></Text>
      <Text color={COLORS.faint}>{ago(now - f.at)}</Text>
    </Box>
  ))
  return Section(els, 'feed', 'RECENT', '', inner, rows)
}

export function renderDeck(els: Els, v: DeckView, onTab: (t: DeckTab) => void) {
  const { Box, Button } = els
  const inner = Math.max(10, v.width - 4)
  const body =
    v.tab === 'plan' ? [planSection(els, v.plan, inner), contextSection(els, v.ctx, v.history, inner)]
    : v.tab === 'agents' ? [agentsSection(els, v.agents, inner, v.now)]
    : [changesSection(els, v.files, inner, v.now, v.onFile)]
  return (
    <Box flexDirection="column" width={v.width}>
      <Box key="tabs" flexDirection="row" gap={1}>
        {TABS.map(([id, label], i) => (
          <Button key={'tab-' + id} label={label} hotkey={String(i + 1)} variant={v.tab === id ? 'primary' : undefined} dimColor={v.tab !== id} onPress={() => onTab(id)} />
        ))}
      </Box>
      {body}
      {statusBox(els, v, inner)}
      {feedSection(els, v.feed, inner, v.now)}
    </Box>
  )
}
