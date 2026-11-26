// Three change flows as their pushed workflows rows (nodes, edges, and the source
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
// - LAND_FLOW: Union's change (outreach/line/change.cast and land.cast, Nov 23):
//   one segment, Land (PR, CI beside Review joined at Read, Merge), whose side
//   routes send findings back to the session, run CI again when main moved,
//   wait for a green main, or ask a person's card on Merge's exit 6. As a
//   pushed row it has no `asks_if`: land.cast writes it on the card, and a row
//   stores neither land.cast's source nor that attribute. LAND_REPO_FLOW is
//   the same graph as Union's checkout reports it (repoFlows, parsed), which
//   the Ship picker reads there: the card's gate carries it.
//
// Hand-written, so a flow rewritten in the library does not move what they show. PERSONAL_FLOW is the one
// exception: the shipped personal Ship's own graph as a pushed row, so the gallery draws what the template runs.
// Pure and free of the `@/` alias: the phone's bundle imports the gallery.

import { SHIPPED_FLOWS } from "../line/shippedFlows.generated";

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
  decide [asks_if="it edits CI"]
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
    node("wait_main", "Wait for green main", "command", { timeout: 15_000 }),
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
    { from: "verdicts", to: "ci_card", label: "it edits CI", condition: "verdicts.json.next = decide and change_conversation" },
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
    node("unshipped", "Not merged", "exit"),
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

// Land's stations as the parser names them inside the flow that uses it (land__<station>), its card's decide segment
// one level further in (land__card__<station>).
const inLand = (id: string, label: string, type: string, extra: Partial<Node> = {}) => node(`land__${id}`, label, type, extra);
// Land's stops, each routed by the composing flow to the session's fix for it, or to its own stop.
const LAND_STOPS: Array<[string, string]> = [
  ["changes", "Changes asked"], ["conflict", "Conflict"], ["revise", "Revise"], ["dropped", "Dropped"], ["unpushed", "No pull request"],
  ["unread", "CI unread"], ["unreviewed", "No review"], ["rejected", "Rejected"], ["unmerged", "Not merged"], ["red_main", "Not rebased"],
];

export const LAND_FLOW: FixtureFlowRow = {
  slug: "gallery-change-land",
  name: "gallery-change-land",
  label: "Change",
  kind: "line",
  source: `digraph change {
  graph [kind="line", label="Change", takes="task,branch"]
  land [flow="land"]
  fix [label="Fix findings", backend=subject, max_visits=3]
  fix_conflict [label="Resolve conflict", backend=subject, max_visits=3]
  revise [label="Revise", backend=subject, max_visits=3]
  stopped [shape=Msquare, label="Not merged", stop="$stop_reason"]
}`,
  nodes: [
    node("start", "start", "start"),
    node("fix", "Fix findings", "agent"),
    node("fix_conflict", "Resolve conflict", "agent"),
    node("revise", "Revise", "agent"),
    node("exit", "Merged", "exit"),
    node("stopped", "Not merged", "exit"),
    inLand("pr", "PR", "command", { timeout: 600 }),
    inLand("checks", "CI and review", "parallel_fanout"),
    inLand("ci", "CI", "command", { timeout: 3_600 }),
    inLand("review", "Review", "agent", { timeout: 5_400 }),
    inLand("read", "Read", "parallel_fanin"),
    inLand("ci_alone", "CI", "command", { timeout: 3_600 }),
    inLand("brief", "Brief", "command", { timeout: 300 }),
    inLand("merge", "Merge", "command", { timeout: 1_800 }),
    inLand("retest", "CI again, main moved", "command", { timeout: 3_600 }),
    inLand("wait_main", "Wait for green main", "command", { timeout: 90_000 }),
    inLand("why_card", "Why a person", "command", { timeout: 120 }),
    inLand("approved", "Person said Ship", "command", { timeout: 60 }),
    inLand("landed", "Merged", "command"),
    inLand("conflicted", "Does not fit main", "command", { timeout: 60 }),
    ...LAND_STOPS.map(([id, label]) => inLand(id, label, "command")),
    inLand("card__decide", "Decide", "human"),
    inLand("card__ship", "Ship", "command"),
    inLand("card__revise", "Revise", "command"),
    inLand("card__dropped", "Dropped", "command"),
    inLand("card", "Decide", "conditional"),
    node("land", "Land", "conditional"),
  ],
  edges: [
    { from: "start", to: "land" },
    { from: "fix", to: "land" },
    { from: "fix_conflict", to: "land" },
    { from: "revise", to: "land" },
    { from: "land__landed", to: "exit", condition: "outcome = success" },
    ...LAND_STOPS.flatMap(([id]) => [
      { from: `land__${id}`, to: "fix", label: "changes asked", condition: `outcome = failure and land__${id}.json.exit = changes` },
      { from: `land__${id}`, to: "fix_conflict", label: "conflict", condition: `outcome = failure and land__${id}.json.exit = conflict` },
      { from: `land__${id}`, to: "revise", label: "revise", condition: `outcome = failure and land__${id}.json.exit = revise` },
      { from: `land__${id}`, to: "stopped", condition: "outcome = failure" },
    ]),
    { from: "land", to: "land__pr" },
    { from: "land__pr", to: "land__checks", condition: `outcome = success and "on" != "off"` },
    { from: "land__pr", to: "land__ci_alone", label: "review off", condition: `outcome = success and "on" = "off"` },
    { from: "land__pr", to: "land__unpushed" },
    { from: "land__checks", to: "land__ci" },
    { from: "land__checks", to: "land__review" },
    { from: "land__ci", to: "land__read" },
    { from: "land__review", to: "land__read" },
    { from: "land__read", to: "land__unread", label: "CI unread", condition: "land__ci.json.error" },
    { from: "land__read", to: "land__unreviewed", label: "no verdict", condition: "land__review.json.verdict != ship and land__review.json.verdict != changes and land__review.json.verdict != rejected" },
    { from: "land__read", to: "land__rejected", label: "rejected", condition: "land__review.json.verdict = rejected" },
    { from: "land__read", to: "land__brief", label: "findings", condition: "land__review.json.verdict = changes or (land__ci.json.green != true and land__ci.json.blocked_by_main != true)" },
    { from: "land__read", to: "land__wait_main", label: "main is red", condition: "land__ci.json.blocked_by_main = true" },
    { from: "land__read", to: "land__merge", label: "green, approved", condition: "land__ci.json.green = true" },
    { from: "land__read", to: "land__unreviewed" },
    { from: "land__ci_alone", to: "land__unread", label: "CI unread", condition: "land__ci_alone.json.error" },
    { from: "land__ci_alone", to: "land__wait_main", label: "main is red", condition: "land__ci_alone.json.blocked_by_main = true" },
    { from: "land__ci_alone", to: "land__merge", label: "green", condition: "land__ci_alone.json.green = true" },
    { from: "land__ci_alone", to: "land__brief" },
    { from: "land__brief", to: "land__merge", label: "nothing to fix", condition: "land__brief.exit_code = 10" },
    { from: "land__brief", to: "land__changes" },
    { from: "land__why_card", to: "land__card" },
    { from: "land__approved", to: "land__merge" },
    { from: "land__merge", to: "land__landed", condition: "outcome = success" },
    { from: "land__merge", to: "land__retest", label: "main moved", condition: "land__merge.exit_code = 3" },
    { from: "land__merge", to: "land__conflicted", label: "conflict", condition: "land__merge.exit_code = 4" },
    { from: "land__merge", to: "land__pr", label: "head moved", condition: "land__merge.exit_code = 5" },
    { from: "land__merge", to: "land__why_card", label: "edits what judges it", condition: "land__merge.exit_code = 6" },
    { from: "land__merge", to: "land__unmerged" },
    { from: "land__retest", to: "land__unread", label: "CI unread", condition: "land__retest.json.error" },
    { from: "land__retest", to: "land__wait_main", label: "main is red", condition: "land__retest.json.blocked_by_main = true" },
    { from: "land__retest", to: "land__merge", label: "green", condition: "land__retest.json.green = true" },
    { from: "land__retest", to: "land__brief" },
    { from: "land__wait_main", to: "land__retest", condition: "outcome = success" },
    { from: "land__wait_main", to: "land__conflicted", label: "conflict", condition: "land__wait_main.exit_code = 4" },
    { from: "land__conflicted", to: "land__conflict" },
    { from: "land__wait_main", to: "land__red_main" },
    { from: "land__card__ship", to: "land__approved" },
    { from: "land__card__revise", to: "land__revise", label: "revise", condition: "outcome = failure and land__card__revise.json.exit = revise" },
    { from: "land__card__revise", to: "land__dropped", label: "dropped", condition: "outcome = failure and land__card__revise.json.exit = dropped" },
    { from: "land__card__dropped", to: "land__revise", label: "revise", condition: "outcome = failure and land__card__dropped.json.exit = revise" },
    { from: "land__card__dropped", to: "land__dropped", label: "dropped", condition: "outcome = failure and land__card__dropped.json.exit = dropped" },
    { from: "land__card", to: "land__card__decide" },
    { from: "land__card__decide", to: "land__card__ship", label: "[S] Ship :: Lands it on the main branch" },
    { from: "land__card__decide", to: "land__card__revise", label: "[R] Revise :: Your note goes to the session that made it; the change comes back through review" },
    { from: "land__card__decide", to: "land__card__dropped", label: "[D] Drop :: Closes it without merging; the session hears your reason" },
  ],
};

/** The personal Ship as the gallery's pushed row: the shipped template's own graph (templates/personal.cast, through
 *  shippedFlows.generated), never a hand-written copy, with a source that carries its stations' settings as a pushed
 *  row's does (pushedFlow reads backends, visit limits, folds and stops from it). */
const SHIPPED_PERSONAL = SHIPPED_FLOWS.find((f) => f.slug === "personal")!;
const settingsOf = (n: (typeof SHIPPED_PERSONAL.nodes)[number]) => [
  n.backend ? `backend=${n.backend}` : null, n.max_visits ? `max_visits=${n.max_visits}` : null, n.fold ? "fold=true" : null,
  n.machine ? "machine=true" : null, n.stop ? `stop="${n.stop.replace(/"/g, "'")}"` : null,
].filter(Boolean).join(", ");
export const PERSONAL_FLOW: FixtureFlowRow = {
  slug: "gallery-personal",
  name: "gallery-personal",
  label: SHIPPED_PERSONAL.label,
  kind: "line",
  source: `digraph personal {\n  graph [kind="line", label="${SHIPPED_PERSONAL.label}", takes="task,branch", own_results=true]\n${SHIPPED_PERSONAL.nodes.filter((n) => settingsOf(n)).map((n) => `  ${n.id} [${settingsOf(n)}]`).join("\n")}\n}`,
  nodes: SHIPPED_PERSONAL.nodes.map((n) => node(n.id, n.label, n.type, n.timeout ? { timeout: n.timeout } : {})),
  edges: SHIPPED_PERSONAL.edges.map((e) => ({ from: e.from, to: e.to, ...(e.label ? { label: e.label } : {}), ...(e.condition ? { condition: e.condition } : {}) })),
};

/** What makes Union's Land ask a person: the `asks_if` on its card (land.cast). */
export const LAND_ASKS = "it edits CI or the flow, or touches consent, bulk sends or bulk changes to people's records";

/** LAND_FLOW as Union's checkout reports it (cli repoFlowsReport, parsed): the session's fix stations its own, Land's
 *  steps marked as the segment's, and the card's gate holding the `asks_if` the parser copies onto it. */
export const LAND_REPO_FLOW = {
  slug: "change", name: "change", kind: "line" as const, label: "Change", description: null, takes: ["task", "branch"],
  nodes: LAND_FLOW.nodes.map((n) => ({
    ...n,
    ...(["fix", "fix_conflict", "revise"].includes(n.id) ? { backend: "subject", max_visits: 3 } : {}),
    ...(n.id === "land" ? { segment: "land", segment_entry: true, segment_flow: "land" } : n.id.startsWith("land__") ? { segment: "land" } : {}),
    ...(n.id === "land__card__decide" ? { asks_if: LAND_ASKS } : {}),
  })),
  edges: LAND_FLOW.edges,
};

/** Union's change as it stands (Nov 23): Land, then the Deploy segment that waits for the change to go live. */
export const UNION_CHANGE_FLOW: FixtureFlowRow = {
  ...LAND_FLOW,
  slug: "gallery-change-union",
  name: "gallery-change-union",
  nodes: [...LAND_FLOW.nodes.map((n) => (n.id === "exit" ? { ...n, label: "Live" } : n)), ...d.nodes],
  edges: [...LAND_FLOW.edges.filter((e) => !(e.from === "land__landed" && e.to === "exit")), { from: "land__landed", to: "deploy" }, ...d.edges],
};

const at = (node_id: string, t: number, result_preview?: string) => ({ node_id, status: "completed", started_at: t, completed_at: t, ...(result_preview ? { result_preview } : {}) });
export const UNION_FLAT_SHA = "5caaa346ac7a76979e522a9031a01e968b28f086";
/** A finished run of UNION_CHANGE_FLOW's older version (ct-98800, Nov 21): its steps recorded flat, before Land was a
 *  segment (`merge`, not `land__merge`), no version pinned, and no merge recorded on it: only its merge step's sha. */
export const UNION_FLAT_RUN = {
  _id: "run_union_flat",
  status: "completed",
  current_node_id: "exit",
  created_at: 1,
  node_statuses: [
    at("start", 1), at("pr", 2, '{"pr":4486,"head_sha":"361c9c110713cde8ebe2a097401824df594c3530","created":true}'),
    at("checks", 3), at("review", 3), at("ci", 10), at("read", 11), at("merge", 12, JSON.stringify({ pr: 4486, sha: UNION_FLAT_SHA })),
    at("deploy", 13), at("deploy__wait", 14, "5caaa346ac is on main; no deploy target ships these files, so nothing waits on a deploy."),
    at("deploy__live", 15, '{"exit": "live"}'), at("exit", 16),
  ],
};
