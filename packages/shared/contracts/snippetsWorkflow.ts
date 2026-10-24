// The workflows section of the agent instructions (snippets.ts), in its own
// module so snippets.ts stays under its line pin; snippets.ts re-exports it.

export const WORKFLOW_SNIPPET_END = "<!-- /codecast-workflows -->";
export const WORKFLOW_SNIPPET = `
## Workflows

Workflows are DOT execution graphs with loops, conditions and human approval gates, bound to a task or plan. Nodes are agent sessions, shell commands, approval gates or conditionals; the dashboard shows progress and gate buttons.

\`\`\`bash
cast workflow run flow.cast --task ct-N     # or --plan pl-N
cast workflow list | runs | push
\`\`\`

Flows are the team's library of these graphs: lines that take a change to done, and segments (check, review, eval, decide, ship) that do one part of the path. A finished change goes through a flow before it ships; the run draws live in the conversation, and a flow written there can be saved to the library from it.

Choose by how well the library fits the work. A library flow that fits is run as it stands, since it carries what the team has learned. When one fits as a backbone but a step needs work particular to this change, extend it and fill its slots with steps you write, leaving the rest of it the team's. Write a whole flow only when nothing in the library has the shape of the work.

\`\`\`bash
cast flow ls                        # the library, each flow with its steps
cast flow run change                # this session's own edits through a library flow (or --task, --branch, --pr)
cast flow run - <<'EOF'             # a flow written here, checked before it starts
digraph <name> {
  graph [extends="<flow>"]          # a library flow as the backbone
  subgraph <slot> { a -> b -> c }   # the steps that fill one of its slots
}
EOF
cast flow import <wf_id>            # a Workflow-tool run becomes a flow: your draft until you make it general, then cast flow publish
\`\`\`

\`cast guide workflows\` shows the graph syntax, segments, slots and the line commands.
${WORKFLOW_SNIPPET_END}
`;

/** What `cast guide workflow` prints after the body: the detail an install leaves out of CLAUDE.md. */
export const WORKFLOW_REFERENCE = `
\`\`\`bash
cast workflow run flow.cast --task ct-N     # or --plan pl-N
cast workflow list                          # available templates
cast workflow push                          # push a workflow to the web UI
cast workflow runs [--task ct-N|--plan pl-N] # status, task, current node, gate
cast role line @handle [--set <slug>]       # read or set the workflow a role's tasks run on (default: line)
cast line profile                           # this repo's line: commands, finders, limits, where each value comes from
cast line set <key> <value> | unset <key>   # edit .codecast/line.toml in place: checked, then published to the app
cast line finder set <id> --source … | rm <id>   # the sources that file signals into the line
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
cast flow publish <flow>            # a repo flow into the team's pool, on the Line page's Flows view
\`\`\`

A prompt or script can live in its own file: \`prompt="@flow/implement.md"\`, relative to the graph. Lines that share most of a flow share it rather than copy it: a variant names its base with \`extends\` and writes only how it differs. A node it writes overrides the attributes it names, \`[removed]\` takes one out, and a node it gives edges keeps exactly those, so each node's routing is read in one file. A station's prompt takes in a shared part at a line that is only \`@include <file>\`. An edit to the base or a part reaches every line on it; \`cast workflow validate <file>\` prints what a variant changes, adds, removes and routes.

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

A backbone leaves part of itself to the flow that extends it: a node marked \`slot="<what it must do>"\`, with \`flow=\` for the steps it runs when nothing fills it. A flow naming it by \`extends="<flow>"\` fills the slot with \`subgraph <slot> { ... }\`, whose steps run in its place as a segment's would: written as a chain they start at the first and leave by the slot's own routes after the last, or they name their own start and exit. A subgraph fills only a slot or a node of its own flow, so the backbone's other stations stay as the team keeps them, and a backbone with an empty slot does not run. \`cast flow run -\` and \`cast flow validate -\` read the graph from stdin, keep it in \`.codecast/session-flows/\` (outside git) as this session's draft, and check it, slots included, before anything starts. \`change\` leaves its Check as a slot.

\`\`\`dot
digraph flaky_fix {
  graph [extends="change", label="Change, flaky test"]
  subgraph check {
    reproduce [prompt="Run the flaky test until it fails and name the race"]
    prove [shape=parallelogram, script="bun test --rerun-each 20"]
    reproduce -> prove
  }
}
\`\`\`
`;
