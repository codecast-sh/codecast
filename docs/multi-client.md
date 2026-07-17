# Multi-client architecture

codecast drives six agent CLIs — Claude Code, Codex, Cursor, Gemini, OpenCode,
and pi — through one descriptor registry instead of per-client branching scattered
across the daemon. This note explains the registry, the one spelling seam, and how
to add a seventh client.

## The registry

`packages/shared/contracts/agentClients.ts` is the single source of truth. It is
pure isomorphic data, so the Convex runtime, the Node daemon, and the browser all
import it.

- `AgentClientId` — the one named union: `"claude" | "codex" | "cursor" | "gemini" | "opencode" | "pi"`. This is the daemon's internal spelling and the registry key.
- `AGENT_CLIENTS` — a `Record<AgentClientId, AgentClientDescriptor>`. Each descriptor holds every per-client fact the daemon used to hardcode: the binary, the resume command, the transcript roots, the watcher kind, the tmux prefix, the prompt-ready pattern, the model/effort config, and the opt-in capabilities.

Before the registry, the daemon repeated the inline union across roughly twenty
signatures and translated the Convex spelling at each boundary by hand. Every one
of those was a place a new client could be silently dropped — the exact bug this
structure removes.

## The spelling seam

Convex stores a slightly different spelling in `conversations.agent_type`: `claude`
is written `claude_code`, and the wire type carries a `cowork` value that has no
client of its own. The whole translation lives in two functions:

- `toConvexAgentType(id)` — client id to wire spelling (`claude` -> `claude_code`).
- `fromConvexAgentType(agentType)` — wire spelling to client id. It is deliberately permissive: `claude_code`, `cowork`, `undefined`, and anything unrecognized all normalize to `claude`.

Any code that needs to turn one spelling into the other routes through these — never
a hand-rolled `agent === "codex" ? "codex" : "claude"` ternary, which only ever
knew two clients and dropped the rest.

## Watchers, parsers, classifiers

Three per-client jobs dispatch off the client id rather than an if/else chain:

- **Watcher kind** (`descriptor.watcherKind`): `jsonl-dir` for clients that append line-delimited JSON under a home directory (Claude, Codex, Gemini, pi), and `sqlite` for clients that keep sessions in a database polled read-only (Cursor's workspace store, OpenCode's `opencode.db`). `json-store` is a reserved value with no current client.
- **Parser** (`parseTranscriptFor(clientId, content)` in `parser.ts`): a raw transcript blob to the daemon's `ParsedMessage[]`, one parser per client with Claude as the default.
- **Tail classifier** (`classifyTranscriptTailFor(agentType)` in `daemon.ts`): the transcript tail to a working/idle turn state. Claude, Codex, OpenCode, and pi have a classifier; **Cursor and Gemini return `undefined`** — an honest "this format isn't classified, defer" rather than a guess.

That deferral is the philosophy in one place: **a missing capability degrades, it
never breaks the session.** A Cursor or Gemini session with no tail classifier
still syncs, resumes, and receives messages; only its live working/idle badge falls
back to agent-agnostic safety nets — a heartbeat-liveness timeout (a dead daemon
reads as finished within about 90 seconds) and a one-hour trust window (a quiet
session that never cleared "working" reads as idle). It is never a stuck spinner.

## Capabilities and pickers

Two capability surfaces read straight off the registry:

- **Model / effort control**: `AGENT_MODEL_CONFIG` is derived from the descriptors that carry a `modelConfig` (Claude, Codex, OpenCode). The web pickers (`ModelEffortPicker`, `canControlModel`) render only when a config exists, so Cursor, Gemini, and pi have no picker at all — pi's model is tracked from the transcript, not driven.
- **Pane prompt monitoring** (`capabilities.panePromptMonitoring`): only Claude and Codex have their tmux pane watched for structured permission / question prompts.

The tmux name prefixes are registry-derived too: `resumeTmuxPrefix` reads
`descriptor.tmuxPrefix`, and `MANAGED_TMUX_PREFIXES` (in `resumeCommand.ts`) lists
every client prefix plus the non-client `ct-` task prefix, so the daemon's
tmux-name filters recognize a new client's panes without a literal edit.

## Adding client #7

Work through the registry outward:

1. **Descriptor** — add the id to `AgentClientId` and `ConvexAgentType`, a case to `fromConvexAgentType`, and a full `AGENT_CLIENTS` entry (binary, `resumeCmd`, `transcriptRoots`, `watcherKind`, `promptReadyPattern`, `tmuxPrefix`, `capabilities`, and `modelConfig` only if codecast can actually control the model).
2. **Watcher** — if the transcripts are a new JSONL layout, the generic `jsonl-dir` watcher may already cover it; a database-backed client needs its own SQLite-style watcher like Cursor's and OpenCode's.
3. **Parser** — add a `parseTranscriptFor` case that returns `ParsedMessage[]`.
4. **Classifier** — add a `classifyTranscriptTailFor` entry if the tail is classifiable. If it isn't, leave it out and let it defer — do not invent one.
5. **Pickers** — a `modelConfig` lights up the web model/effort control automatically; nothing else to wire.
6. **Validators / launch** — add launch args in `buildLaunchArgs` / `buildBlankLaunchArgs` and permission flags in `getPermissionFlags` only if the client has them.

Add only the cells the client truly supports. An honest gap in the README support
matrix is correct; a fabricated capability is the bug.
