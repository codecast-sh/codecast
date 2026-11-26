// The sections of the agent instructions (snippets.ts) that take a change
// through its gates: workflows and flows, and the typecheck a flow's "check"
// segment runs. In their own module so snippets.ts stays under its line pin;
// snippets.ts re-exports them.

export const WORKFLOW_SNIPPET_END = "<!-- /codecast-workflows -->";
export const WORKFLOW_SNIPPET = `
## Workflows

Workflows are DOT graphs with loops, conditions and approval gates, bound to a task or plan (\`cast workflow run flow.cast --task ct-N\`). Flows are the team's library of them: whole flows that take a change to done, and segments (check, review, eval, decide, ship). Run a library flow that fits; extend one and fill its slots when a step needs this change's own work; write a whole flow only when nothing fits.

\`\`\`bash
cast flow ls                        # the library, the workspace's default flow marked
cast flow run                       # this session's own edits through the default flow
cast flow run change                # or through a library flow by name
cast flow run - <<'EOF' … EOF       # a flow written here (extends a backbone, or whole)
\`\`\`

To add a check to the project's pipeline or tweak a station's prompt (Review's, say), run \`cast flow edit\` (\`cast flow edit change add lint --after pr --fix brief --run "bun run lint"\`), never a rewrite of the flow file.

\`cast guide workflows\` shows the graph syntax, segments, slots, import and every \`cast flow edit\`.
${WORKFLOW_SNIPPET_END}
`;

/** What `cast guide workflow` prints after the body: the detail an install leaves out of CLAUDE.md. */
export const WORKFLOW_REFERENCE = `
\`\`\`bash
cast workflow run flow.cast --task ct-N     # or --plan pl-N; the dashboard shows progress and gate buttons
cast workflow list                          # available templates
cast workflow push                          # push a workflow to the web UI
cast workflow runs [--task ct-N|--plan pl-N] # status, task, current node, gate, a failed run's reason (-l: machine, run id)
cast workflow show ct-N                     # one run: each station's status, time, outcome and session
cast workflow cancel ct-N                   # stop a run
cast workflow resume ct-N --at verify       # a failed run again from a station (id or label)
cast role line @handle [--set <slug>]       # read or set the workflow a role's tasks run on (default: line)
cast flow profile                           # this repo's flow: commands, finders, limits, where each value comes from
cast flow set <key> <value> | unset <key>   # edit .codecast/line.toml in place: checked, then published to the app
cast flow finder set <id> --source … | rm <id>   # the sources that file signals into the flow
\`\`\`

\`\`\`dot
digraph my_flow {
  graph [goal="$task_title"]
  start [shape=Mdiamond]
  implement [label="Implement", backend=claude, prompt="..."]
  verify [label="Verify", shape=parallelogram, script="npx tsc --noEmit"]
  review [label="Review", shape=hexagon]
  exit [shape=Msquare]
  start -> implement -> verify
  verify -> review [condition="outcome = success"]
  verify -> implement [condition="outcome = failure"]
  review -> exit [label="[A] Approve"]
  review -> implement [label="[R] Revise"]
}
\`\`\`

A node with \`flow="<slug>"\` runs that segment in place: its steps join the graph under the node's name, its plain ends go on by the node's own edges, and \`<node>.exit\` in their conditions names which end it reached. A segment's stop ends the run in its words, unless the node routes \`outcome = failure\`. A flow says what it is on its graph line (\`graph [kind="segment", label="Review", description="...", takes="task,branch"]\`); a graph that declares a kind joins the pool, and the repo's own flows live in \`.codecast/flows/<slug>.cast\`.

\`\`\`bash
cast flow show <flow>               # its steps, who does each, where each sends the work, and its slots
cast flow validate <flow|file|->    # read it with its segments and slots expanded and name what is missing
cast flow run [flow] --task ct-N    # a task's change (or --branch, --pr); no flow: the workspace's default; no change: this session's own edits
cast flow import <wf_id>            # a Workflow-tool run becomes a flow: your draft until you make it general, then cast flow publish
cast flow publish <flow>            # a repo flow into the team's pool, on the Line page's Flows view
\`\`\`

A prompt or script can live in its own file: \`prompt="@flow/implement.md"\`, relative to the graph. Flows that share most of their steps share them rather than copy them: a variant names its base with \`extends\` and writes only how it differs. A node it writes overrides the attributes it names, \`[removed]\` takes one out, and a node it gives edges keeps exactly those, so each node's routing is read in one file. A station's prompt takes in a shared part at a line that is only \`@include <file>\`. An edit to the base or a part reaches every line on it; \`cast workflow validate <file>\` prints what a variant changes, adds, removes and routes.

\`\`\`dot
digraph trial {
  graph [extends="live.cast"]
  review [prompt="@trial/review.md"]      // its own prompt; every other station is live's
  push [removed]
  review -> card [condition="outcome = success"]
  review -> build
  card [shape=hexagon]
  card -> exit
}
\`\`\`

A finished change goes through a flow before it ships, its run drawn live in the conversation. Asked to change the project's pipeline (add a lint check, tell Review about a house rule, skip a step, run e2e only when some paths change), make the edit with \`cast flow edit\`, never by rewriting the flow: it writes one line in \`.codecast/flows/<flow>.cast\`, validates it, and prints the edit for the conversation. It commits nothing; the edit ships through the pipeline like any change.

\`\`\`bash
cast flow edit change add lint --after pr --fix brief --run "bun run lint"   # red goes back to the session; or --agent, --person; --when "<globs>"
cast flow edit change guide review "Also check the migrations"      # appended to the inherited prompt (prompt replaces it)
cast flow edit change run lint "bun run lint --changed"
cast flow edit change skip decide | when e2e "landing/**" | undo review
\`\`\`

Each line desugars into the edges you would write by hand (the graph hashes the same), and \`cast flow show <flow>\` prints them in words:

\`\`\`dot
digraph change {
  graph [extends="change"]
  lint   [after="pr", fix="brief", label="Lint", shape=parallelogram, script="bun run lint"]  // pr -> lint -> checks; red goes back to the session
  review [guide="@change/review.md"]          // appended to Review's inherited prompt; review__review [...] edits a segment's station
  e2e    [after="pr", fix="brief", when="landing/**", shape=parallelogram, script="bun e2e"]  // runs only when $change_files touches it
  decide [skip=true]                          // ci_card -> merge; what only Decide reached goes too
}
\`\`\`

A backbone leaves part of itself to the flow that extends it: a node marked \`slot="<what it must do>"\`, with \`flow=\` for the steps it runs when nothing fills it. A flow naming it by \`extends="<flow>"\` fills the slot with \`subgraph <slot> { ... }\`, whose steps run in its place as a segment's would: written as a chain they start at the first and leave by the slot's own routes after the last, or they name their own start and exit. A subgraph fills only a slot or a node of its own flow, so the backbone's other stations stay as the team keeps them, and a backbone with an empty slot does not run. \`cast flow run -\` and \`cast flow validate -\` read the graph from stdin, keep it in \`.codecast/session-flows/\` (outside git) as this session's draft, and check it, slots included, before anything starts. A flow written for one change extends a library flow that leaves no slot the same way, placing its own steps with \`after=\`:

\`\`\`dot
digraph flaky_fix {
  graph [extends="change", label="Ship, flaky test"]
  reproduce [after="pr", prompt="Run the flaky test until it fails and name the race"]
  prove     [after="reproduce", shape=parallelogram, script="bun test --rerun-each 20"]
}
\`\`\`
`;

export const CHECK_SNIPPET_END = "<!-- /codecast-check -->";
export const CHECK_SNIPPET = `
## Typechecking

Typecheck TypeScript with \`cast check\`, never \`tsc --noEmit\`. One \`tsc --watch\` per tree and project rechecks only changed files, so answers take seconds and ten sessions asking cost the same as one; fresh \`tsc\` runs rebuild everything and push the machine into swap.

\`\`\`bash
cast check            # the projects your changes reach (--all: every one in .codecast/check.toml)
cast check web        # one project by name, or any directory or tsconfig path
cast check --fresh    # restart a watcher that lost track, then ask
\`\`\`

If a pass is running or queued, wait on it rather than run your own \`tsc\`. A worktree holds a program of its own (gigabytes per project), so give worktrees only to the agents whose edits would collide. When a check is red with errors nobody wrote, suspect the \`.codecast/check.toml\` entry before the code. \`cast guide check\` covers that file.
${CHECK_SNIPPET_END}
`;

/** What `cast guide check` prints after the body: the detail an install leaves out of CLAUDE.md. */
export const CHECK_REFERENCE = `
\`\`\`bash
cast check --json          # { project, errors, diagnostics } for each project
cast check-status          # the watchers on this machine, their memory and learned sizes (--stop stops them all)
\`\`\`

The exit code says whether the code or the tool failed. 0 is clean and 1 is type errors. 70, 75 and 124 mean the tool failed and the code has no verdict yet: a watcher died, ran out of memory or did not start (70); the queue stayed full or the watcher's answer was stale (75); the pass outlived the wait and keeps running (124). Whenever a failure has a next action, the last stderr line is \`cast: hint: <next action>\`. Do that, rather than reading the code for errors that are not there.

A tree lists its programs in \`.codecast/check.toml\` as a \`[projects]\` table of \`name = "path/to/tsconfig.json"\`. Commit it so every worktree inherits it (if the repo ignores \`.codecast/\`, add \`!.codecast/check.toml\`). A repo with more than one program needs it; without it only the tsconfig nearest your directory is checked, which may not be the program your change reaches.

A top-level \`checker = "bun"\` (above \`[projects]\`) runs one \`bun check\` per ask instead of a watcher; it needs bun 1.4.4+ (\`CAST_CHECK_BUN\` names one), else 70. An ask shares a run in flight on an unchanged tree; \`--fresh\` never shares. Runs wait for a few slots (\`CAST_CHECK_BUN_RUNS\`) and free memory, and never stop a watcher.

Point each entry at the tsconfig the package's own \`typecheck\` script runs, not necessarily the plain \`tsconfig.json\`: a build that narrows \`rootDir\` often keeps a widened \`tsconfig.typecheck.json\`, and checking the build config reports hundreds of files-outside-root errors.

Sessions in one checkout share a watcher. A worktree's first pass starts from the main checkout's last one and rechecks only what differs. Work in the shared checkout unless parallel edits would collide, and never give every agent of a fan-out a worktree by default. A new watcher starts while the memory its project has been measured to need fits in what the machine has free now, and none beyond the first while the machine is under memory pressure; first builds run a few at a time (\`cast check-status\` shows both). Past that an ask waits in a queue for up to three minutes, then exits 75: ask again, it keeps its place. A watcher asked in the last 15 minutes is stopped for another only once the ask first in line has been queued 90 seconds (counted from when it joined the queue), a pass nobody waits on gives its room up, and a watcher stops after 45 idle minutes.
`;
