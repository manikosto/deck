# deck

A side pane for Claude Code, modelled on the pane in [glowup](https://github.com/NovusEdge/glowup) (MIT).

- **Plan & context**: the task list, then the context window split by what fills it, a chart of context use per turn with the auto-compact line, growth per turn and turns left, the three heaviest sources you can trim, and cache hit, peak and compactions.
- **Changes**: files Claude edited or created this session.
- **Agents**: subagents with elapsed time, tokens and the tool each one is running.
- **Recent**: a feed of what happened — files edited, commands run, tests passed or failed, subagents finished, turns done.
- **Turn timer**: elapsed time and tool calls of the turn in progress, a warning when the same call repeats three times (a loop).
- **Context pulse**: a bar per turn of how many tokens it added, and a warning (plus a toast) when auto-compact is three turns away.
- **Changes**: click a file to see its git diff (or the whole new file) in your browser.
- **Limit alarm**: under 15% of the tighter limit the hearts blink and a toast says so, once per window.
- **Status box**: the current action, hearts for the tighter of the 5-hour and weekly limits (or cost on an API key), and Bolt, a pixel robot with a speech bubble: he works, thinks, dances when tests pass, cries when they fail, and falls asleep after two quiet minutes. The status box also shows the model, git branch, both limits with their reset times, and the session's cost.

## Use

- `/deck` toggles the pane; `/deck plan|changes|agents` opens it on that tab. Keys `1` `2` `3` switch tabs while it has focus.
- The pane docks on its own at session start in a fullscreen terminal of 144 columns or more.
- Settings (in `/plugin`): `autoOpen`, `pet`.

## Install

```sh
claude plugin marketplace add manikosto/deck
claude plugin install deck@deck
```

Needs Claude Code 2.1.289 or later. Clicking a changed file opens its diff in your browser.

Checks: `claude plugin validate .` and `claude plugin test .`.

## License

MIT
