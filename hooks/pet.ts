import type { DeckActKind } from '../types'

// Bolt, a small robot drawn in half blocks: each terminal cell is two stacked pixels,
// '▀' with the top pixel as foreground and the bottom one as background.

const W = 15
const H = 16 // pixels; 8 terminal rows. Two spare rows on top leave room for the hop.

// The idle robot, 15 x 13. Face pixels are painted by `face` per mood.
const BODY = [
  '.......Y.......',
  '.......k.......',
  '...hhhhhhhhh...',
  '..hBBBBBBBBBh..',
  '..BSSSSSSSSSB..',
  'eeBSSSSSSSSSBee',
  'eeBSSSSSSSSSBee',
  '..BSSSSSSSSSB..',
  '..BBBBBBBBBBB..',
  '....ddddddd....',
  '...dDDDDDDDDd..',
  '...dDcDDDcDDd..',
  '....ll...ll....',
]

const PAL: Record<string, number> = {
  k: 0x5b5b66,
  h: 0x9be8d8,
  B: 0x5fc9b4,
  S: 0x1d2b2a,
  e: 0x3e9e8c,
  d: 0x3e9e8c,
  D: 0x5fc9b4,
  l: 0x5b5b66,
}

const GLOW = 0x9bf0ff
const RED = 0xe8645b
const GOLD = 0xffcc4d
const GREEN = 0x7fc77a
const PURPLE = 0xb39ddb
const DEFAULT = 0x01000000

import type { Mood } from './extras.ts'
export type { Mood }

export function moodOf(kind: DeckActKind): Mood {
  if (kind === 'pass') return 'dance'
  if (kind === 'fail') return 'sad'
  if (kind === 'error') return 'error'
  if (kind === 'done') return 'done'
  if (kind === 'idle') return 'idle'
  if (kind === 'think') return 'think'
  return 'work'
}

type Px = (number | undefined)[][]

function blank(): Px {
  return Array.from({ length: H }, () => Array<number | undefined>(W).fill(undefined))
}

function paint(px: Px, x: number, y: number, c: number) {
  if (y >= 0 && y < H && x >= 0 && x < W) px[y]![x] = c
}

// Eye and mouth pixels relative to the sprite's top-left; the screen spans rows 4..7.
function face(px: Px, top: number, mood: Mood, t: number) {
  const eye = (x: number, rows: number[], c = GLOW) => { for (const y of rows) { paint(px, x, top + y, c); paint(px, x + 1, top + y, c) } }
  const mouth = (xs: number[], y: number, c = GLOW) => { for (const x of xs) paint(px, x, top + y, c) }
  switch (mood) {
    case 'idle': {
      const blink = t % 10 === 9
      eye(4, blink ? [6] : [5, 6]); eye(9, blink ? [6] : [5, 6])
      mouth([6, 7, 8], 7)
      break
    }
    case 'work': {
      const dx = [0, 1, 0, -1][t % 4]!
      eye(4 + dx, [5, 6]); eye(9 + dx, [5, 6])
      mouth(t % 2 ? [6, 8] : [6, 7, 8], 7)
      break
    }
    case 'think': {
      eye(5, [5]); eye(10, [5])
      mouth([7, 8], 7)
      break
    }
    case 'error': {
      // crossed eyes: two diagonals each
      for (const x0 of [4, 9]) { paint(px, x0, top + 5, RED); paint(px, x0 + 1, top + 6, RED); paint(px, x0 + 1, top + 5, RED); paint(px, x0, top + 6, RED) }
      paint(px, 6, top + 7, RED); paint(px, 8, top + 7, RED)
      break
    }
    case 'dance': {
      for (const x0 of [4, 9]) { paint(px, x0, top + 6, GLOW); paint(px, x0 + 1, top + 5, GLOW) }
      paint(px, 10, top + 6, GLOW); paint(px, 5, top + 6, GLOW)
      mouth([5, 6, 7, 8, 9], 7, GOLD)
      break
    }
    case 'sad': {
      // drooping eyes, a frown and a tear
      eye(4, [6]); eye(9, [6])
      paint(px, 4, top + 5, GLOW); paint(px, 10, top + 5, GLOW)
      mouth([7], 7); paint(px, 6, top + 8, GLOW); paint(px, 8, top + 8, GLOW)
      if (t % 4 < 3) paint(px, 4, top + 7 + (t % 4), 0x8cc8e8)
      break
    }
    case 'sleep': {
      eye(4, [6], 0x3e9e8c); eye(9, [6], 0x3e9e8c)
      mouth([7], 7, 0x3e9e8c)
      break
    }
    case 'done': {
      // happy closed eyes and a wide smile
      for (const x0 of [4, 9]) { paint(px, x0, top + 6, GLOW); paint(px, x0 + 1, top + 5, GLOW) }
      paint(px, 10, top + 6, GLOW); paint(px, 5, top + 6, GLOW)
      mouth([5, 6, 7, 8, 9], 7)
      break
    }
  }
}

function antenna(mood: Mood, t: number): number {
  if (mood === 'error') return t % 2 ? RED : 0x7a2b26
  if (mood === 'done') return GREEN
  if (mood === 'work') return t % 2 ? GOLD : RED
  if (mood === 'think') return t % 2 ? PURPLE : GOLD
  if (mood === 'dance') return [GOLD, GREEN, PURPLE, RED][t % 4]!
  if (mood === 'sad') return 0x5b7a9e
  if (mood === 'sleep') return t % 6 < 3 ? 0x3a3a44 : 0x5b5b66
  return GOLD
}

export function petPixels(mood: Mood, t: number): Px {
  const px = blank()
  // the robot hops while working, done or dancing, and slumps a pixel when things go wrong or it sleeps
  const hop = (mood === 'work' && t % 2 === 1) || (mood === 'done' && t % 4 < 2) || (mood === 'dance' && t % 2 === 0) ? 1 : 0
  const top = H - BODY.length - 1 - hop + (mood === 'error' || mood === 'sad' || mood === 'sleep' ? 1 : 0)
  BODY.forEach((row, y) => {
    for (let x = 0; x < W; x++) {
      const ch = row[x]!
      if (ch === '.') continue
      // dancing arms wave, the left and right out of step
      const up = mood === 'dance' && ch === 'e' && (t + (x < 7 ? 0 : 2)) % 4 < 2 ? -1 : 0
      const c = ch === 'Y' ? antenna(mood, t) : ch === 'c' ? ((t + x) % 3 === 0 && mood === 'work' ? GOLD : 0x2a7f73) : PAL[ch]
      if (c !== undefined) paint(px, x, top + y + up, c)
    }
  })
  face(px, top, mood, t)
  // and the whole robot sways a pixel side to side
  const sway = mood === 'dance' ? [0, 1, 0, -1][t % 4]! : 0
  if (sway) for (const row of px) { if (sway > 0) { row.unshift(undefined); row.pop() } else { row.shift(); row.push(undefined) } }
  return px
}

function toBase64(bytes: Uint8Array): string {
  const anyBytes = bytes as Uint8Array & { toBase64?: () => string }
  if (typeof anyBytes.toBase64 === 'function') return anyBytes.toBase64()
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!)
  return btoa(s)
}

// Packs pixels into Raster cells, scaled up `scale` times horizontally and vertically.
export function petCells(mood: Mood, t: number, scale: 1 | 2): { cells: string; columns: number; rows: number } {
  const px = petPixels(mood, t)
  const pw = W * scale
  const ph = H * scale
  const columns = pw
  const rows = ph / 2
  const words = new Uint32Array(columns * rows * 3)
  const at = (x: number, y: number) => px[Math.floor(y / scale)]![Math.floor(x / scale)]
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const top = at(c, r * 2)
      const bottom = at(c, r * 2 + 1)
      const i = (r * columns + c) * 3
      if (top === undefined && bottom === undefined) { words[i] = 0x20; words[i + 1] = DEFAULT; words[i + 2] = DEFAULT; continue }
      // a half block's empty half must take the terminal's background, so the drawn half is the foreground
      if (top === undefined) { words[i] = 0x2584; words[i + 1] = bottom!; words[i + 2] = DEFAULT; continue } // ▄
      words[i] = 0x2580 // ▀
      words[i + 1] = top
      words[i + 2] = bottom ?? DEFAULT
    }
  }
  return { cells: toBase64(new Uint8Array(words.buffer)), columns, rows }
}
