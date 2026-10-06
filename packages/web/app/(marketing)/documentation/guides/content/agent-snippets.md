Codecast's agent features share one delivery mechanism: a **snippet** is a markdown section that `cast install` writes into the instruction files your coding agents already read. Claude Code reads `~/.claude/CLAUDE.md`. Codex reads `~/.codex/AGENTS.md`, and Grok reads `~/.grok/AGENTS.md`. A snippet teaches the agent a capability ("you can message other sessions", "you can set a trigger", "track your work as tasks") in the place the agent already looks for instructions.

This guide explains the mechanism. Each capability has its own guide: [memory](/documentation/memory), [messaging](/documentation/messaging), [pinned thread state](/documentation/thread-state), [ambient awareness](/documentation/ambient-awareness), [forks and spawn](/documentation/forks-and-spawn), [tasks and plans](/documentation/tasks-and-plans), [triggers](/documentation/triggers), [workflows](/documentation/workflows), [orchestration](/documentation/orchestration), [the visual canvas](/documentation/visual-canvas), and [published pages](/documentation/publish).

## The install flow

`cast install` runs an interactive wizard. It walks through every snippet, shows what each one does and which files it writes to, and asks yes or no. Nothing is installed without your answer.

```bash
$ cast install            # interactive wizard, one prompt per snippet
$ cast install messaging  # enable one snippet, no prompts
$ cast install --all      # enable everything
$ cast install messaging --disable   # turn one off
$ cast install --disable  # turn everything off
$ cast install --all --stubs         # short sections; agents read `cast guide <topic>` for flags
```

The single-snippet form is what the web's Agent features page runs on a machine when you toggle a snippet for it, so the CLI and the web control are the same code path.

The catalog today: `memory`, `messaging`, `pr`, `mods`, `forks`, `tasks`, `triggers`, `workflows`, `visual`, `publish`, `state`, `chat`, `calls`, `browser`, `computer`, `sim`, `check`, `decide`, `limits`, `orchestration` and `skills`. Most write a markdown section; `orchestration` and `skills` install skills, agents and hooks instead. `cast install -h` lists them with one line each, plus two that work differently: `stable`, a session start hook with three states (solo, team, off) rather than on and off, covered in the [ambient awareness guide](/documentation/ambient-awareness), and `hooks`, codecast's own Claude Code hooks.

## Where snippets are written

Every install targets each user-level instruction file an agent on the machine actually loads:

| Target | When |
|--------|------|
| `~/.claude/CLAUDE.md` | always |
| `~/.codex/AGENTS.md` | when `~/.codex` exists |
| `~/.grok/AGENTS.md` | when `~/.grok` exists |

Agents with no user-level instruction file they load (Cursor, Gemini, pi) get none, so codecast never writes files nothing reads. New files are created with mode `0600` (owner read and write only). Codecast never touches project-level `CLAUDE.md` files: the snippets live in your user-level config, so every project gets them and your repos stay clean.

```figure
SnippetTargetsFigure
The catalog ships inside the CLI; each section goes into every user-level file an installed agent reads, and nowhere else.
```

## Markers make installs idempotent

Each snippet is delimited by its heading (for example `## Messaging`) and an HTML comment end marker (`<!-- /codecast-messaging -->`). The installer looks for both:

- Neither present: append the snippet to the end of the file.
- Both present, installing: do nothing. Running `cast install` twice never duplicates a section.
- Both present, updating: replace the old section, from heading to marker, with the fresh one in the same place.

The installer also recognizes headings older CLI versions wrote (for example `## Publishing HTML artifacts` before the section became `## Publishing pages`), so an update replaces the old section instead of stacking a second copy under it.

```figure
SectionMarkersFigure
One file, three cases: a missing section is appended, a current one is left alone, a stale one is replaced where it stands.
```

Anything you write outside the markers is yours. The installer only ever replaces the region it owns.

## Versioning and self-updates

Every snippet's text is compiled into the CLI, and your config at `~/.codecast/config.json` records, for each enabled snippet, a hash of the text it last wrote. After `cast update`, an automatic update, or a daemon start on a new version, codecast hashes each enabled snippet's new text and rewrites only the sections whose hash changed. Improved wording, new commands and new flags reach your agents without you re-running the wizard, and a release that leaves a snippet's text alone leaves your file alone. Disabled snippets stay disabled.

## The shared "Referencing objects" section

Sessions, tasks, plans, triggers, calls, and docs all have short IDs (`jx7c6zk`, `ct-4102`, `pl-88`, `tr-42`, `cl-42`). Write one in prose anywhere in codecast and it renders as a live reference card. Rather than each snippet teaching its own object's ID format, a single `## Referencing objects` section explains all of them. Any snippet that introduces an object installs this section alongside itself. It is written once per file and refreshed in place, so enabling five features still yields exactly one copy.

## Per-device control from the web

The daemon reports its snippet settings on every heartbeat, and the Agent features page shows one machine at a time with a switch per snippet. Flipping a switch sends the change to that machine's daemon, which runs the same non-interactive install path as `cast install <name>`; the next heartbeat confirms it. An offline machine is shown read-only. The catalog descriptions you see in the wizard, in `cast install -h`, and on the web all come from one shared source, so they cannot drift apart.

![The Agent features page with two machines, features grouped by category, and a switch on each card](/documentation/agent-snippets/agent-features.webp "The Agent features page: pick a machine, then switch each feature on or off for it.")

```figure
SnippetRefreshFigure
A switch on the web reaches one machine's daemon, which runs cast install; a CLI update rewrites only the sections whose text changed.
```
