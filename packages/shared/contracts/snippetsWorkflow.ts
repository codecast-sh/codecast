// The sections of the agent instructions (snippets.ts) that take a change
// through its gates: workflows and flows, the typecheck a flow's "check"
// segment runs, the pull request a change is reviewed on, and the decision a
// person answers at an approval gate. In their own module so snippets.ts stays
// under its line pin; snippets.ts re-exports them.

import type { SectionSpec } from "./snippets";

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

A node with \`flow="<slug>"\` runs that segment in place: its steps join the graph under the node's name, its plain ends go on by the node's own edges, and \`<node>.exit\` in their conditions names which end it reached. A segment's stop ends the run in its words, unless the node routes \`outcome = failure\`. A flow says what it is on its graph line (\`graph [kind="segment", label="Review", description="...", takes="task,branch"]\`). The \`label\` is the flow's name wherever a person meets it, on the chip beside its sessions and decisions and on its runs: one or two plain words a teammate would say, such as "Change" or "Review", with what it does in \`description\`. A graph that declares a kind joins the pool, and the repo's own flows live in \`.codecast/flows/<slug>.cast\`.

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

A heavy command station takes a place in one of the machine's named slots before its script runs: \`local_ci [..., machine_slot="local_ci"]\`. It waits while the slot's places are all held (\`cast config local_ci.per_machine <n>\`, 2 unless set) or the machine is short of memory, up to its \`timeout\`, which starts counting only once it runs. A wait that runs out is the outcome \`no_slot\`, routed like any other: \`local_ci -> pr [condition="outcome = no_slot"]\` goes on without it, and a station placed with \`after=\` or \`before=\` may write that edge itself. \`cast slot ls\` lists each slot's holders and waiters, and \`cast slot run --name <slot> [--wait 15m] -- <cmd>\` runs any command in one (exit 75 when the wait runs out).

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

export const CHECK_SECTION: SectionSpec = {
  headings: ["## Typechecking"],
  endMarker: CHECK_SNIPPET_END,
};

export const PR_SNIPPET_END = "<!-- /codecast-pr -->";
export const PR_SNIPPET = `
## Pull requests (cast pr)

\`cast pr\` reads and steers a pull request from the shell: its checks, reviews, threads, and the session that owns it until it merges. Every verb takes a number, \`owner/repo#123\`, a URL, or nothing (the pull request this session is bound to, else the one for your branch).

**Review as a batch.** Hold a note on each line you have something to say about, then send them as one review with one verdict; nothing reaches GitHub or the author until you submit. A note names a file and line and says what should change or what you want to know; it never pastes the code. Use this rather than \`gh pr review\` or posting comments one at a time.

\`\`\`bash
cast pr show [ref]                                        # state, checks, reviews, open threads, owner
gh pr diff 123                                            # read the change
cast pr comment 123 --hold --file src/x.ts --line 42 "…"  # hold a note on a line
cast pr review 123 --request-changes -b "…"               # send the batch: --approve | --request-changes | --comment
cast pr threads [ref]; cast pr comment 123 --reply <thread> "…"; cast pr resolve <thread>
\`\`\`

The review goes out on GitHub as the human you run as, so the verdict is theirs. **Owning a pull request:** \`cast pr shepherd on [ref]\` binds this session to it, and you are woken when it moves: make each change, push to the same branch, reply to the notes you addressed, and resolve their threads. Do not merge unless a human asked you to. \`cast guide pr\` has the rest.
${PR_SNIPPET_END}
`;

/** What `cast guide pr` prints after the body: the detail an install leaves out of CLAUDE.md. */
export const PR_REFERENCE = `
\`\`\`bash
cast pr ls                                  # open pull requests across your teams (--repo, --mine, --shepherded, --state)
cast pr events [ref]                        # timeline: pushes, reviews, checks, merges
cast pr watch [ref]                         # one line per change; the first frame is silent
cast pr open [ref]                          # the page in codecast (--print for the URL only)
cast pr create -t "<title>" -b -            # open one with gh; the bound task's change guide becomes its walkthrough (--dry-run)
cast pr notes 123                           # what you are holding (--discard throws them away)
cast pr comment 123 "…"                     # say something on the conversation now, outside a review
cast pr resolve <thread> [ref]              # settle a thread you answered (unresolve reopens it)
\`\`\`

Every read takes \`--json\`. \`-\` reads a note's body from a heredoc. Read the change with \`gh pr diff\` or \`git diff main...<branch>\` in a checkout. GitHub refuses a verdict on the human's own pull request, and says so. If the pull request has an owning session, the whole review reaches it as one message the moment GitHub accepts it. \`cast pr shepherd on --for <session>\` binds another of your sessions; the /cast-ship skill does this when it opens one.
`;

export const PR_SECTION: SectionSpec = {
  headings: ["## Pull requests (cast pr)", "## Pull requests"],
  endMarker: PR_SNIPPET_END,
};

export const DECIDE_SNIPPET_END = "<!-- /codecast-decide -->";
export const DECIDE_SNIPPET = `
## Asking for a decision

\`cast decide\` queues a question, so unlike an inline ask it does not stop the human mid-thought. Each still costs an answer, so ask only when it is theirs: intent nothing written settles, a fact only they hold, money beyond the run's budget, or an irreversible change whose mistake hits many. Decide the rest and say what you chose. Never a card: what reading answers, a status update, a probe or test, or deleting disposable or rebuildable data.

Never re-ask what an earlier card (\`cast decide ls\`), ruling or project instruction answered. When the answer deploys, spends, changes access or messages outside the team, pass \`--category production|billing|data|access|external|product|limit\`: the card is then a person's alone, else (outside a run) \`review\`, open to a granted role.

\`\`\`bash
cast decide "<one question>" \\
  -o "First option :: what happens if chosen" \\
  -o "Second option :: what happens instead" \\
  --impact "<1-5> :: what waits on the answer" \\
  --context -  <<'EOF'
What you would pick and why, then what the choice turns on.
EOF
\`\`\`

**The card is the whole message, written for someone who was not here.** The person answering knows the product and its people but did not follow this session: they read the card once, in their queue or on their phone, with nothing else open, and answer without opening the session. Name things the way they would. The names this work coined, its shorthand, and ids or references only the session explains (a task, a trigger, a script, "the rule from earlier") mean nothing to them, and neither does a pointer back to something said earlier in the session, their own words included: say what the thing is instead. The question is the choice as they would put it to themselves. Each option says what happens to the product or the people it reaches, then \`::\` and the fact that sizes it. The context opens on what you would pick and why, then gives only what the choice turns on: the finding that forces it, what cuts against your pick, and what you do meanwhile. It reads in a minute, under 150 words; how you got there and the supporting detail go in \`--report report.html\`. Every number and claim on it is one the session established; an estimate says so. Before posting, read the card as that person: whatever they would have to ask you about, rewrite. After posting, don't repeat the options.

**A step only the person may take** (a grant, a spend, a pairing, an approval) is a permission ask, never a command to type: \`cast decide "<what Yes does, in plain words>?" --run "cast …"\` runs it as theirs on Yes (\`--on laptop\` from a cloud host). A refusal that posted an approval card has asked already: end your turn.

**Blocking is the default**: post, then end your turn; the answer arrives as a user message. \`--advisory --default <n>\` keeps you working on option n, but only when that default is cheap to undo. When facts change, \`cast decide edit\` rewrites your open decision in place and \`cast decide cancel\` withdraws one the work has moved past. \`cast guide decide\` has the rest.
${DECIDE_SNIPPET_END}
`;

/** What `cast guide decide` prints after the body: the detail an install leaves out of CLAUDE.md. */
export const DECIDE_REFERENCE = `
\`\`\`bash
cast decide "<q>" -o … -o … --option-page 2=alt.html   # an option with its own page (a file, a slug, or a url)
cast decide ls                                          # this session's decisions: id, answer, age, messages since (--mine: every pending one you hold)
cast stack remove ds-N sd-N | reorder ds-N sd-a,sd-b | policy ds-N --due tomorrow   # tend a stack; overdue sorts first
\`\`\`

A withdraw arrives after the human has read the ask, so get it right before posting. To see how a card renders, mount the component on a fixture row or open an answered one. The context renders as markdown, \`cast-canvas\` blocks included, and most decisions read faster as a picture; keep prose for the reasoning a picture cannot carry. An option chosen by looking carries its picture as a \`cast-canvas\` in its \`--option-body n=file.md\`, or they all sit side by side in a canvas after the context's opening; a card that points back to a picture in the session leaves them choosing blind. A bare question is useless: the queue shows nothing else unless they open the session.

\`cast decide edit\` and \`cast decide cancel\` act on this session's open decision and keep its spot in the queue. An answered decision cannot be edited; act on the answer. Before ending a long turn and whenever you post, cancel open asks the work has moved past: an answer to a question that stopped mattering costs attention and earns nothing. Answers often land an hour later and disagree, and everything built on an advisory default is then work to unwind; if reversing would cost more than waiting, block.

\`--run\` takes one cast command, exactly as you would have pasted it, for an act its help calls a person's. The card shows your question inline in the conversation with Yes and Not now, and the command only as a small terminal line at its foot, so the question says what Yes will do in their terms (who gets what, how much). Yes asks them for Touch ID and runs the command on this machine outside your session, and the answer arrives with its exit and output. Never run it yourself after posting; end your turn.

A decision is your human's to answer. When they tell you in this conversation to answer one ("approve sd-494", "go with option 2 on both"), \`cast decide answer sd-N <n> --for-human\` records it as their answer, carried by this session. Do it only on their explicit word or their explicit agreement to a choice you named, never on your own reading of what they would want, and never for a question you asked yourself.
`;

export const DECIDE_SECTION: SectionSpec = {
  headings: ["## Asking for a decision"],
  endMarker: DECIDE_SNIPPET_END,
};
