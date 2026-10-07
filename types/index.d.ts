export type DeckTab = 'changes' | 'agents' | 'plan' | 'global'

export type DeckPlanItem = {
  id: string
  title: string
  active?: string
  status: 'pending' | 'in_progress' | 'completed'
}

export type DeckCat = { name: string; tokens: number; kind: string }

export type DeckSource = { kind: string; name: string; detail: string; tokens: number }

export type DeckCtx = {
  percent: number
  tokens: number
  window: number
  cats: DeckCat[]
  threshold?: number
  autoCompact: boolean
  heavy: DeckSource[]
  cacheHit?: number
}

// One point per finished main turn: percent of the window and tokens used.
export type DeckPoint = { pct: number; tokens: number }

export type DeckHistory = { points: DeckPoint[]; peak: number; compactions: number }

export type DeckActKind = 'idle' | 'think' | 'read' | 'edit' | 'shell' | 'agent' | 'web' | 'error' | 'done' | 'pass' | 'fail'

export type DeckAct = { kind: DeckActKind; label: string; at: number }

export type DeckLimit = { kind: string; percentUsed: number; resetsAt?: string }

export type DeckUsage = { limits: DeckLimit[]; costUsd?: number }

export type DeckFeedItem = { kind: DeckActKind; text: string; at: number; ok?: boolean }

// The turn in progress (startedAt set) or the last one: how long, how many tool calls, and a loop if one showed.
export type DeckTurn = { startedAt?: number; tools: number; lastMs?: number; lastTools?: number; loop?: string }

// A Claude Code background session, as `claude agents --json --all` lists it, with what it waits for.
export type DeckSession = {
  id: string
  sessionId: string
  // a process of its own runs it now: open it in a new window, never resume it here
  live: boolean
  name: string
  state: string
  needs?: string
  cwd: string
  at: number
}

// Where ← back returns to after jumping into another session here.
export type DeckBack = { sessionId: string; name: string }

export type DeckInfo = { model?: string; branch?: string; dirty?: number }

export type DeckFile = { path: string; edits: number; isNew: boolean; at: number }

export type DeckAgent = {
  id: string
  agentId?: string
  type: string
  description: string
  status: 'running' | 'done' | 'failed'
  startedAt: number
  endedAt?: number
  tokens?: number
  tool?: string
}

declare module 'claude-code' {
  interface PluginState {
    deck: {
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
      sessions: DeckSession[]
      back: DeckBack | null
      turn: DeckTurn
    }
  }
}
