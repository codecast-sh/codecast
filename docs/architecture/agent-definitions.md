# Agent definitions and chains

A definition is one named object that binds a client, a model, an effort, a
tool policy and a system prompt. Every launch surface resolves it by name, so
"run this as reviewer" replaces the flag triple that each surface used to take
on its own. A chain is definitions in order; each step's output feeds the next
step's prompt. Sections are numbered so code can cite them.

## D1. The row

`agent_definitions` (`convex/agentSchema.ts`):

```
name              [a-z0-9-]{1,40}, unique inside the workspace; the --as value
description       one line a picker shows
agent?            registry client id (claude, codex, pi, ...); absent = the caller's
model?            picker key or raw id for that client
effort?           the client's effort stop (pi's --thinking levels ride this slot)
tools?            allowlist by native tool name (claude --allowedTools, pi --tools)
disallowed_tools? denylist (claude --disallowedTools)
system_prompt?    the file body
prompt_mode       append (default) | replace
mode              apply (default) | propose (read only)
isolated?         start in its own git worktree
```

`agent_chains` carries `name`, `description` and `steps: [{ agent, prompt }]`,
where `agent` is a definition name and `prompt` a template with `{task}` (the
chain's input) and `{previous}` (the prior step's output). A template with
neither placeholder gets the previous output appended, so a step never drops
what came before.

Both tables carry the envelope every workspace row carries: `workspace` is the
ACCESS key (one equality per read), `team_id` is routing, `short_id` is
`ad-<ts>` / `ac-<ts>`, `client_key` makes a create idempotent. Neither rides
the sync log; the web feeds from a snapshot query per table.

## D2. Resolution

`resolveAgentLaunch(def, overrides, fallbackAgent)` in
`@codecast/shared/contracts/agentDefinitions.ts` is the one rule every surface
uses: an explicit flag wins over the definition, the definition wins over the
surface default. A model the forced client cannot run is dropped and named in
`dropped`; so is an effort the client has no flag for. The result is the
client, model, effort, tool lists, the prompt in its mode, `mode` and
`isolated`.

`definitionLaunchFlags` (`packages/cli/src/agentLaunch.ts`) turns that into
per client argv. Tool policy is honest per client: claude takes both lists, pi
takes the allowlist, every other client drops the policy and says so. A
`propose` definition adds the safe mode fence the trigger scheduler already
uses (write tools removed, mutating shell commands denied, mandate appended),
so read only means one thing everywhere.

Name lookup (`agentDefinitions.resolveDefinitionFor`) walks the viewer's held
keys with the personal workspace first, so a person can shadow a shared
definition without editing it.

## D3. Surfaces

| Surface | How the definition arrives | Where its flags land |
|---|---|---|
| `cast exec --as` | `/cli/agents/resolve` | `buildPrintArgs` (`extraArgs`, `appendSystemPrompt`) |
| `cast exec --chain` | `/cli/chains/resolve` | one print run per step, stdout captured and handed on |
| `cast exec -j N a b c` | same `--as` | N print runs, `countingSemaphore(N)` |
| `cast spawn --as` | `/cli/spawn { definition }` → `resolveSpawnDefinition` | `enqueueStartSession({ definition })` → daemon |
| web compose "as" pill | `createSession { agent_definition }` → same server helper | same daemon path |
| `cast trigger add --as` | `agent_tasks.agent_definition` | `buildRunLaunch(task, config, definition)` in the scheduler |
| workflow node `definition=` | `/cli/agents/resolve` (builtin) or `/cli/spawn { definition }` (session) | as above |

The daemon's argv allowlist (`SAFE_ARG_RE`) drops any arg with quotes, parens
or newlines, so tool deny rules and the prompt cannot ride `buildLaunchArgs`.
`definitionLaunchFragment` appends them to the typed command after the
allowlist: tool flags shell escaped, the prompt written to a 0600 file under
`~/.codecast/agent-prompts/` and read with `$(cat …)`. That is the door grok's
stable rules already use. A client with no system prompt flag (codex, cursor,
gemini, opencode, grok) gets the prompt prefixed to the seeded first turn by
`resolveSpawnDefinition` instead; a web compose create has no seeded turn, so
the prompt is dropped with a daemon log line.

## D4. The file form

A definition travels as markdown with frontmatter, the shape pi's subagent
extension and Claude Code's `~/.claude/agents/*.md` both read. `cast agent
import` accepts either as is: `disallowedTools`, `isolation: worktree`,
`model: id:effort` and `tools: a, b` all map. `cast agent show` and `export`
print the same form. A chain file is a frontmatter with name and description
and one `## <definition>` section per step. Parsers live in
`@codecast/shared/agents`; the YAML subset and the frontmatter splitter are
the vault's.

## D5. Chains vs workflows

A chain is linear and prompt only, edited in the settings library, and runs
headless through `cast exec`. A DOT workflow is a graph with gates and
conditions and runs sessions. The runner gained three things so the two
compose: a node may name `definition=<name>`; a prompt may read another node's
result as `$<id>.output`; a `component` shaped fanout runs every branch
concurrently (four at once) and continues at the `tripleoctagon` fanin, whose
`$<fanin>.output` is every branch's output under a heading.
