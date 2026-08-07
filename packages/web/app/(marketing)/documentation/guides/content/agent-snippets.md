Codecast's agent features share one delivery mechanism: a **snippet** is a markdown section that `cast install` writes into the instruction files your coding agents already read. Claude Code reads `~/.claude/CLAUDE.md`. Codex reads `~/.codex/AGENTS.md`. Cursor reads rules files under `~/.cursor/rules/`. A snippet teaches the agent a capability — "you can message other sessions", "you can set a trigger", "track your work as tasks" — in the place the agent already looks for instructions.

This guide explains the mechanism. Each capability has its own guide: [memory](/documentation/memory), [messaging](/documentation/messaging), [ambient awareness](/documentation/ambient-awareness), [forks and spawn](/documentation/forks-and-spawn), [tasks and plans](/documentation/tasks-and-plans), [triggers](/documentation/triggers), [workflows](/documentation/workflows), [orchestration](/documentation/orchestration), [the visual canvas](/documentation/visual-canvas), and [published pages](/documentation/publish).

## The install flow

`cast install` runs an interactive wizard. It walks through every snippet, shows what each one does and which files it writes to, and asks yes or no. Nothing is installed without your answer.

```bash
$ cast install            # interactive wizard, one prompt per snippet
$ cast install messaging  # enable one snippet, no prompts
$ cast install --all      # enable everything
$ cast install messaging --disable   # turn one off
$ cast install --disable  # turn everything off
```

The single-snippet form is what the web Settings page shells out to when you toggle a snippet for a device, so the CLI and the web control are the same code path.

The catalog today: `memory`, `messaging`, `forks`, `tasks`, `triggers`, `workflows`, `visual`, `publish`, `orchestration`, plus `stable`. Stable is the odd one out — it is a session start hook rather than a markdown section, and it has three states (solo, team, off) instead of on and off. The [ambient awareness guide](/documentation/ambient-awareness) covers it.

## Where snippets are written

Every install targets each agent config present on the machine:

| Target | When |
|--------|------|
| `~/.claude/CLAUDE.md` | always |
| `~/.codex/AGENTS.md` | when `~/.codex` exists |
| `~/.cursor/rules/codecast.mdc` | when `~/.cursor` exists |

Files are written with mode `0600` (owner read and write only). Codecast never touches project-level `CLAUDE.md` files — the snippets live in your user-level config, so every project gets them and your repos stay clean.

## Markers make installs idempotent

Each snippet is delimited by its heading (for example `## Messaging`) and an HTML comment end marker (`<!-- /codecast-messaging -->`). The installer looks for both:

- Neither present: append the snippet to the end of the file.
- Both present, installing: do nothing. Running `cast install` twice never duplicates a section.
- Both present, updating: cut the old section from heading to marker and append the fresh one.

The installer also recognizes headings older CLI versions wrote (for example `## Publishing HTML artifacts` before the section became `## Publishing pages`), so an update replaces the old section instead of stacking a second copy under it.

Anything you write outside the markers is yours. The installer only ever replaces the region it owns.

## Versioning and self-updates

Every snippet has a version number compiled into the CLI. Your config at `~/.codecast` records which version of each enabled snippet is installed. When the CLI updates and a snippet's version bumped, the next `cast` run rewrites the enabled sections in place — so improved wording, new commands, and new flags reach your agents without you re-running the wizard.

One snippet goes further: messaging is on by default for anyone with memory enabled, and the daemon installs it on its own at startup after a self-update — no `cast` command involved. An explicit opt-out (`cast install messaging --disable`) is always respected.

## The shared "Referencing objects" section

Sessions, tasks, plans, triggers, and docs all have short IDs (`jx7c6zk`, `ct-4102`, `pl-88`, `tr-42`). Write one in prose anywhere in codecast and it renders as a live reference card. Rather than each snippet teaching its own object's ID format, a single `## Referencing objects` section explains all of them. Any snippet that introduces an object installs this section alongside itself. It is written once per file and refreshed in place, so enabling five features still yields exactly one copy.

## Per-device control from the web

The daemon reports its snippet settings on every heartbeat, and the Settings page renders a toggle per snippet per device. Flipping a toggle sends the change to that machine's daemon, which runs the same non-interactive install path as `cast install <name>`. The catalog descriptions you see in the wizard, in `cast install -h`, and on the web all come from one shared source, so they cannot drift apart.
