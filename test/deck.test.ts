import { expect, test } from 'claude-code/testing'
import { brailleChart, hearts, planOrder, stackBar, turnsLeft } from '../hooks/model.ts'
import { petCells } from '../hooks/pet.ts'

const PANE = { title: 'deck', isFocused: false, bodyColumns: 44, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 60 }, view: {} }

test('the context bar fills exactly its width', async () => {
  const { slices, free } = stackBar([
    { name: 'Messages', tokens: 76_000, kind: 'used' },
    { name: 'System tools', tokens: 18_000, kind: 'used' },
    { name: 'MCP tools', tokens: 12_000, kind: 'used' },
    { name: 'Free space', tokens: 94_000, kind: 'free' },
  ], 200_000, 40)
  expect(slices.map(s => s.label)).toEqual(['messages', 'tools', 'mcp'])
  expect(slices.reduce((n, s) => n + s.cells, 0) + free).toBe(40)
  expect(slices[0]!.pct).toBe(38)
})

test('the chart is as wide and tall as asked', async () => {
  const lines = brailleChart([10, 20, 40, 60, 80, 30], 8, 2)
  expect(lines.length).toBe(2)
  expect(lines.every(l => l.length === 8)).toBe(true)
})

test('auto-compact turns and hearts', async () => {
  expect(turnsLeft(116_000, 172_000, 14_000)).toBe(4)
  expect(hearts([{ kind: 'five_hour', percentUsed: 30 }, { kind: 'seven_day', percentUsed: 10 }])).toEqual({ full: 4, label: '5h limit 70% left' })
})

test('the plan shows the step in progress first', async () => {
  const { items } = planOrder([
    { id: '1', title: 'Read the styles', status: 'completed' },
    { id: '2', title: 'Run the tests', status: 'pending' },
    { id: '3', title: 'Wire it in', status: 'in_progress' },
  ])
  expect(items.map(i => i.id)).toEqual(['3', '2', '1'])
})

test('the robot packs into whole cells', async () => {
  const pet = petCells('work', 3, 1)
  expect(pet.columns).toBe(15)
  expect(pet.rows).toBe(8)
  expect(atob(pet.cells).length).toBe(15 * 8 * 12)
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the pane draws its tabs and switches them on ${surface}`, async $ => {
    const pane = await $.ui.mount({ plugin: 'deck', surface, component: 'Pane', requestId: 'deck', props: PANE })
    expect(await pane.find({ text: /CONTEXT/ })).toBeDefined()
    await pane.press({ key: 'tab-changes' })
    expect(await pane.find({ text: /No files changed yet/ })).toBeDefined()
    await pane.press({ key: 'tab-agents' })
    expect(await pane.find({ text: /No subagents/ })).toBeDefined()
  })
}
