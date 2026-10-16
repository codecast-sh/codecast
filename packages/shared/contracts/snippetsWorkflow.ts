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

\`cast guide workflows\` shows the graph syntax and the line commands.
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
`;
