// Two change flows as their pushed workflows rows (nodes, edges, and the source
// pushedFlow reads backends, visit limits, stops and graph attributes from), for
// the journey presenter's tests and the render gallery's run cards:
//
// - FANOUT_FLOW: the library change flow's shape (__tests__/changeGraph.fixture.json
//   is the real one): PR, then CI and Review side by side, a join, Verdicts that
//   routes on both, one brief back to the session, Merge, Merged, Deploy, Live.
// - BRANCHING_FLOW: Check and Review, a founder-intent read whose script exits
//   non-zero to ask a person (the ask route) or clears the change to Land with
//   no card (the cleared route), Decide, Land (whose refusal goes through a
//   script off the main path before it stops), Deploy.
//
// Hand-written, so a flow rewritten in the library does not move what they show.
// Pure and free of the `@/` alias: the phone's bundle imports the gallery.

type Node = { id: string; label: string; type: string; shape: string; timeout?: number };
type Edge = { from: string; to: string; label?: string; condition?: string };

const SHAPE: Record<string, string> = {
  start: "Mdiamond", exit: "Msquare", command: "parallelogram", agent: "box", human: "hexagon",
  conditional: "diamond", parallel_fanout: "component", parallel_fanin: "tripleoctagon",
};
const node = (id: string, label: string, type: string, extra: Partial<Node> = {}): Node => ({ id, label, type, shape: SHAPE[type], ...extra });

/** A segment as the parser expands it: its entry, its steps in a row, a done exit and a stop exit. */
function segment(id: string, label: string, steps: Node[], done: string, stop: string): { nodes: Node[]; edges: Edge[] } {
  const nodes = [...steps, node(`${id}__${done}`, done, "command"), node(`${id}__${stop}`, stop, "command"), node(id, label, "conditional")];
  const edges: Edge[] = [{ from: id, to: steps[0].id }];
  steps.forEach((s, i) => edges.push({ from: s.id, to: steps[i + 1]?.id ?? `${id}__${done}`, condition: "outcome = success" }));
  edges.push({ from: steps[steps.length - 1].id, to: `${id}__${stop}`, condition: "outcome = failure" });
  return { nodes, edges };
}

const deploy = () => {
  const nodes = [node("deploy__wait", "Go live", "command", { timeout: 2_700 }), node("deploy__live", "Live", "command"), node("deploy__failed", "Deploy failed", "exit"), node("deploy", "Deploy", "conditional")];
  const edges: Edge[] = [
    { from: "deploy", to: "deploy__wait" },
    { from: "deploy__wait", to: "deploy__live", condition: "outcome = success" },
    { from: "deploy__wait", to: "deploy__failed", condition: "outcome = failure" },
    { from: "deploy__live", to: "exit" },
  ];
  return { nodes, edges };
};

export type FixtureFlowRow = { slug: string; name: string; label: string; kind: "line"; source: string; nodes: Node[]; edges: Edge[] };

const d = deploy();
// The person's card a change that edits CI goes to, off the main path.
const ciDecide = segment("decide", "Decide", [node("decide__decide", "Decide", "human")], "ship", "revise");

export const FANOUT_FLOW: FixtureFlowRow = {
  slug: "gallery-change-fanout",
  name: "gallery-change-fanout",
  label: "Change",
  kind: "line",
  source: `digraph change {
  graph [kind="line", label="Change", takes="task,branch"]
  review [backend=session]
  verdicts [fold=true]
  landed [fold=true]
  brief [backend=subject, max_visits=3]
  fix_conflict [backend=subject, max_visits=3]
  nopr [stop="$pr.output"]
  rejected [stop="The reviewer rejected the change: $verdicts.json.why"]
  noci [machine=true, stop="CI never reported on the pull request: $verdicts.json.why"]
  mainred [stop="$wait_main.output"]
  unrebased [stop="$rebase.output"]
  dropped [stop="$stop_reason"]
  unshipped [stop="$merge.output"]
}`,
  nodes: [
    node("start", "start", "start"),
    node("pr", "PR", "command", { timeout: 600 }),
    node("checks", "CI and review", "parallel_fanout"),
    node("ci", "CI", "command", { timeout: 5_400 }),
    node("review", "Review", "agent"),
    node("joined", "Both done", "parallel_fanin"),
    node("verdicts", "Verdicts", "command", { timeout: 60 }),
    node("rerun_ci", "Run CI again", "command", { timeout: 60 }),
    node("merge", "Merge", "command", { timeout: 3_600 }),
    node("retest", "Retest", "command", { timeout: 120 }),
    node("wait_main", "Wait for main", "command", { timeout: 15_000 }),
    node("rebase", "Onto main", "command", { timeout: 600 }),
    node("ci_card", "Why a person", "command", { timeout: 120 }),
    ...ciDecide.nodes,
    node("landed", "Merged", "command", { timeout: 60 }),
    ...d.nodes,
    node("brief", "Fix findings", "agent"),
    node("fix_conflict", "Resolve conflict", "agent"),
    node("exit", "Live", "exit"),
    node("nopr", "No pull request", "exit"),
    node("rejected", "Rejected", "exit"),
    node("noci", "CI never reported", "exit"),
    node("mainred", "Main stayed red", "exit"),
    node("unrebased", "Not onto main", "exit"),
    node("dropped", "Dropped", "exit"),
    node("unshipped", "Not merged", "exit"),
  ],
  edges: [
    { from: "start", to: "pr" },
    { from: "pr", to: "checks", condition: "outcome = success" },
    { from: "pr", to: "nopr", label: "no pull request", condition: "outcome = failure" },
    { from: "checks", to: "ci" },
    { from: "checks", to: "review" },
    { from: "ci", to: "joined", condition: "outcome = success" },
    { from: "ci", to: "verdicts", condition: "outcome = failure" },
    { from: "review", to: "joined" },
    { from: "joined", to: "verdicts" },
    { from: "verdicts", to: "merge", condition: "verdicts.json.next = merge" },
    { from: "verdicts", to: "rejected", label: "rejected", condition: "verdicts.json.next = rejected" },
    { from: "verdicts", to: "rerun_ci", label: "CI never reported", condition: "verdicts.json.next = rerun_ci and rerun_ci.visits < 1" },
    { from: "verdicts", to: "noci", label: "CI never reported again", condition: "verdicts.json.next = rerun_ci" },
    { from: "verdicts", to: "wait_main", label: "every failure is main's", condition: "verdicts.json.next = wait_main and wait_main.visits < 2" },
    { from: "verdicts", to: "ci_card", label: "CI changes", condition: "verdicts.json.next = decide and change_conversation" },
    { from: "wait_main", to: "rebase", condition: "outcome = success" },
    { from: "wait_main", to: "mainred", label: "main stayed red", condition: "outcome = failure" },
    { from: "rebase", to: "ci", condition: "outcome = success" },
    { from: "rebase", to: "unrebased", label: "not onto main", condition: "outcome = failure" },
    { from: "ci_card", to: "decide" },
    ...ciDecide.edges,
    { from: "decide__ship", to: "merge" },
    { from: "decide__revise", to: "brief", label: "revise", condition: "outcome = failure and decide.exit = revise" },
    { from: "decide__revise", to: "dropped", label: "dropped", condition: "outcome = failure and decide.exit = dropped" },
    { from: "verdicts", to: "brief", label: "CI red, changes asked or no verdict" },
    { from: "rerun_ci", to: "ci" },
    { from: "merge", to: "landed", condition: "outcome = success and merge.json.sha" },
    { from: "merge", to: "fix_conflict", label: "conflict", condition: "outcome = failure and merge.exit_code = 1" },
    { from: "merge", to: "retest", label: "retest", condition: "outcome = failure and merge.exit_code = 3 and retest.visits < 3" },
    { from: "merge", to: "unshipped", label: "not merged" },
    { from: "retest", to: "ci", condition: "outcome = success" },
    { from: "landed", to: "deploy" },
    { from: "brief", to: "pr" },
    { from: "fix_conflict", to: "pr" },
    ...d.edges,
  ],
};

const check = segment("check", "Check", [node("check__verify", "Verify", "command")], "passed", "failed");
const review = segment("review", "Review", [node("review__review", "Review", "agent")], "approved", "changes");
const decide = segment("decide", "Decide", [node("decide__decide", "Decide", "human")], "ship", "revise");
const land = segment("ship", "Land", [node("ship__ship", "Land", "command")], "shipped", "unshipped");

export const BRANCHING_FLOW: FixtureFlowRow = {
  slug: "gallery-change-branching",
  name: "gallery-change-branching",
  label: "Change with an intent read",
  kind: "line",
  source: `digraph change {
  graph [kind="line", label="Change with an intent read", takes="task,branch"]
  review__review [backend=session]
  intent [backend=session]
  fix_check [backend=subject, max_visits=3]
  fix_review [backend=subject, max_visits=3]
  revise [backend=subject, max_visits=3]
  fix_conflict [backend=subject, max_visits=3]
  dropped [stop="$stop_reason"]
  unshipped [stop="$stop_reason"]
}`,
  nodes: [
    node("start", "start", "start"),
    ...check.nodes,
    ...review.nodes,
    node("intent", "Founder intent", "agent"),
    node("intent_gate", "Land without asking?", "command", { timeout: 120 }),
    node("cleared", "Cleared", "command"),
    node("ask", "Why a person", "command"),
    node("unmerged", "Ask at the card?", "command"),
    ...decide.nodes,
    ...land.nodes,
    ...d.nodes,
    node("fix_check", "Fix check", "agent"),
    node("fix_review", "Address review", "agent"),
    node("revise", "Revise", "agent"),
    node("fix_conflict", "Resolve conflict", "agent"),
    node("exit", "Live", "exit"),
    node("dropped", "Dropped", "exit"),
    node("unshipped", "Not shipped", "exit"),
  ],
  edges: [
    { from: "start", to: "check" },
    ...check.edges,
    { from: "check__passed", to: "review" },
    { from: "check__failed", to: "fix_check", label: "check failed", condition: "outcome = failure" },
    ...review.edges,
    { from: "review__approved", to: "intent" },
    { from: "review__changes", to: "fix_review", label: "changes asked", condition: "outcome = failure" },
    { from: "intent", to: "intent_gate" },
    { from: "intent_gate", to: "cleared", label: "cleared", condition: "outcome = success and intent_gate.json.next = land" },
    { from: "cleared", to: "ship", condition: "outcome = success" },
    { from: "cleared", to: "decide" },
    { from: "intent_gate", to: "ask" },
    { from: "ask", to: "decide" },
    ...decide.edges,
    { from: "decide__ship", to: "ship" },
    { from: "decide__revise", to: "revise", label: "revise", condition: "outcome = failure" },
    ...land.edges,
    { from: "ship__shipped", to: "deploy" },
    { from: "ship__unshipped", to: "fix_conflict", label: "conflict", condition: "outcome = failure and ship.exit = conflict" },
    { from: "ship__unshipped", to: "unmerged", label: "not merged", condition: "outcome = failure and ship.exit = unshipped" },
    { from: "unmerged", to: "decide", label: "ask", condition: "outcome = success" },
    { from: "unmerged", to: "unshipped" },
    ...d.edges,
    { from: "fix_conflict", to: "check" },
    { from: "fix_check", to: "check" },
    { from: "fix_review", to: "check" },
    { from: "revise", to: "check" },
  ],
};
