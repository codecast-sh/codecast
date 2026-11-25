// The render gallery's flows (lib/renderGallery.ts): a flow a session defined on a backbone with its live run, a
// finished run of a library flow, the session's change runs at each place a person meets one, and the run that
// carried a pipeline edit out (pipeline.md PL5). Ids are lowercase so a run id reads as one in `cast flow run` output.
// Pure and free of the `@/` alias: the phone's bundle and tests import it through the gallery.
import { readEdit } from "./line/flowEditFence";
import { EDIT_SKIP } from "./renderGalleryPipeline.generated";
import { BRANCHING_FLOW, FANOUT_FLOW, LAND_FLOW } from "./ship/journeyFixtures";

// The flow object (ct-69934): their runs, graph and session-flow row are store records the gallery's loader seeds
// (renderGalleryRecords).
export const GALLERY_FLOW = {
  slug: "gallery-flaky-fix",
  graphId: "galleryflowgraph00000001",
  liveRun: "galleryflowrunlive000001",
  libraryRun: "galleryflowrunlibrary001",
  sessionFlow: "galleryflowsession000001",
  hash: "galleryflowhash1",
  // A session's change on its way to live (components/ship/Journey): sent back to the session, at Decide, waiting on a deploy, live.
  shipBack: "galleryshiprunback000001",
  shipDecide: "galleryshiprundecide0001",
  shipDeploy: "galleryshiprundeploy0001",
  shipLive: "galleryshiprunlive000001",
  // At Deploy with no merged sha; a branching flow routed to a person by its gate script; a fan-out flow waiting on CI,
  // waiting on main's CI that another change turned red, and stopped by a merge refusal (lib/ship/journeyFixtures).
  shipUnlanded: "galleryshiprununlanded01",
  shipBranching: "galleryshiprunbranching1",
  shipCiWait: "galleryshipruncwait00001",
  shipMainRed: "galleryshiprunmainred001",
  shipRefused: "galleryshiprunrefused001",
  // The branching flow finished through its cleared route: the stations it never entered read skipped.
  shipCleared: "galleryshiprunclearedrt1",
  // Merged and held on main's red CI; a change that edits CI, at the person's card off the main path.
  shipHeld: "galleryshiprunheldmain01",
  shipCiCard: "galleryshipruncicard0001",
  // A flow that is one segment, Land: its findings sent back to the session, and a change at the person's card inside it.
  shipLandBack: "galleryshiprunlandback01",
  shipLandCard: "galleryshiprunlandcard01",
  branchingGraph: "galleryflowbranching0001",
  fanoutGraph: "galleryflowfanout0000001",
  landGraph: "galleryflowland000000001",
  // The pipeline's inline objects (pipeline.md PL5, PL6): the change run that carried the skip edit out, and the repo's pipeline.
  editLive: "galleryeditrunlive000001",
  pipeline: "gallerypipeline000000001",
} as const;

/** The skip edit's fence body, as `cast flow edit` printed it: an agent quoting it in prose draws the same card. */
export const EDIT_SKIP_FENCE = EDIT_SKIP.output.match(/```flow\n(.*)\n```/)![1];

export const FLOW_SOURCE = `digraph gallery_flaky_fix {
  graph [extends="spine", label="Spine, flaky test"]
  subgraph implement {
    reproduce [label="Reproduce", prompt="Reproduce the flake 20 times."]
    patch [label="Patch the race", prompt="Patch the race the investigation found."]
    prove [label="Prove 20 runs", shape=parallelogram, script="bun test --rerun-each 20"]
    reproduce -> patch -> prove
  }
}`;

// The graph as the parser expands it (a backbone's slot filled in place), as a run's push stores it.
export const FLOW_NODES = [
  { id: "start", label: "start", type: "start", shape: "Mdiamond" },
  { id: "exit", label: "Merged", type: "exit", shape: "Msquare" },
  { id: "investigate", label: "Investigate", type: "agent", shape: "box" },
  { id: "review", label: "Review", type: "agent", shape: "box" },
  { id: "implement__reproduce", label: "Reproduce", type: "agent", shape: "box" },
  { id: "implement__patch", label: "Patch the race", type: "agent", shape: "box" },
  { id: "implement__prove", label: "Prove 20 runs", type: "command", shape: "parallelogram" },
  { id: "implement__exit", label: "exit", type: "command", shape: "parallelogram" },
  { id: "implement", label: "Implement", type: "conditional", shape: "diamond" },
];
export const FLOW_EDGES = [
  { from: "start", to: "investigate" },
  { from: "investigate", to: "implement" },
  { from: "review", to: "exit", condition: "outcome = success" },
  { from: "review", to: "implement", label: "Changes asked" },
  { from: "implement__exit", to: "review", condition: "outcome = success" },
  { from: "implement", to: "implement__reproduce" },
  { from: "implement__reproduce", to: "implement__patch" },
  { from: "implement__patch", to: "implement__prove" },
  { from: "implement__prove", to: "implement__exit" },
];

/** Runs of a change flow from this session, one at each place a person meets it, on the two hand-written graphs
 *  (lib/ship/journeyFixtures) so they keep their meaning whatever the library's flow becomes. Node statuses are shaped
 *  the way the runner reports them (runner.ts): one entry per node (its latest visit); a fan-out branch's report carries
 *  no output, so CI keeps its last progress line; Verdicts reports the round's verdicts as its output; a failed run's
 *  current node is the exit it stopped at. */
export function shipRuns(now: number, viewerId: string, workspace: string, conversationId: string, status: (id: string, s: "completed" | "running") => object, refs: { decision: string; decisionShort: string; liveDeploy: string }) {
  const base = { user_id: viewerId, workspace, spawner_conversation_id: conversationId, task_short_id: "ct-4110", task_title: "Rename the inbox divider", created_at: now - 900_000, updated_at: now };
  const through = (...ids: string[]) => ids.map((id) => status(id, "completed"));
  const said = (id: string, result_preview: string, s: "completed" | "running" = "completed") => ({ ...status(id, s), result_preview });
  const failed = (id: string) => ({ ...status(id, "completed"), status: "failed" });
  const fan = { ...base, workflow_id: GALLERY_FLOW.fanoutGraph, workflow_slug: FANOUT_FLOW.slug, workflow_name: FANOUT_FLOW.name };
  const branching = { ...base, workflow_id: GALLERY_FLOW.branchingGraph, workflow_slug: BRANCHING_FLOW.slug, workflow_name: BRANCHING_FLOW.name };
  const land = { ...base, workflow_id: GALLERY_FLOW.landGraph, workflow_slug: LAND_FLOW.slug, workflow_name: LAND_FLOW.name };
  const landRound = [...through("land__pr", "land__checks"), said("land__ci", "Waiting on CI for #12 at abc1234: 14 of 14 jobs done, 11m"), ...through("land__review", "land__read")];
  const merge = (at: number) => ({ sha: "4a6e413b2c", branch: "codecast/change-ct-4110", into: "main", at });
  // The round: PR, then CI and Review side by side; CI's last progress line stays on its node, Review reports nothing.
  const round = [...through("pr", "checks"), said("ci", "Waiting on CI for #12 at abc1234: a second look before calling it green, 9m"), status("review", "completed"), status("joined", "completed")];
  const verdicts = (next: string, ci: string, review: string, why: string) => said("verdicts", JSON.stringify({ next, ci, review, why }));
  const green = [...round, verdicts("merge", "green", "ship", "CI is green and the reviewer said ship")];
  const merged = [...green, said("merge", '{"sha": "4a6e413b2c", "pr": 12}'), said("landed", "4a6e413b2c")];
  // Through the intent read, its script exiting non-zero to route the change to a person: a route, then the card.
  const routed = [...through("check__verify", "review__review", "intent"), failed("intent_gate"), status("ask", "completed")];
  const card = { gate_prompt: "Ship the inbox divider rename?", gate_node_id: "decide__decide", current_node_id: "decide__decide", status: "paused" };
  return [
    // CI went red and the reviewer asked for changes: Verdicts sent both back, and the session fixes them.
    { ...fan, _id: GALLERY_FLOW.shipBack, status: "running", current_node_id: "brief",
      waiting_on_session: { node_id: "brief", conversation_id: conversationId, since: now - 240_000, note: "CI red on #12: 2 failures in test-web. The reviewer asked for changes: the divider's label repeats the bucket name; say how many sessions are below it instead." },
      node_statuses: [...round, verdicts("brief", "red", "changes", "CI is red: 2 failures this change causes; the reviewer asked for changes"), { ...status("brief", "running"), visits: 2 }] },
    // Another person's card: the viewer reads who it waits on, never "You".
    { ...branching, ...card, _id: GALLERY_FLOW.shipDecide, user_id: "galleryuser0000000000002", gate_decision_id: "gallerydecision000000009", gate_decision_short_id: "sd-90009",
      node_statuses: [...routed, { ...status("decide__decide", "running"), started_at: now - 20_000 }] },
    { ...fan, _id: GALLERY_FLOW.shipDeploy, status: "running", current_node_id: "deploy__wait", merge: merge(now - 300_000),
      node_statuses: [...merged, { ...said("deploy__wait", "web: live in dp-12; backend: dp-13 sending 4a6e413 (6m of 45m)", "running"), started_at: now - 6 * 60_000 }] },
    { ...fan, _id: GALLERY_FLOW.shipHeld, status: "running", current_node_id: "deploy__wait", merge: merge(now - 1_500_000),
      node_statuses: [...merged, { ...said("deploy__wait", "web: live in dp-12; backend: waiting on main CI at 9f8e7d6 (red since 1a2b3c4: test-web; held 22m, then 45m)", "running"), started_at: now - 22 * 60_000 }] },
    { ...fan, _id: GALLERY_FLOW.shipLive, status: "completed", current_node_id: "exit", merge: merge(now - 600_000),
      node_statuses: [...merged, said("deploy__wait", "Live: 4a6e413b2c on backend dp-13, web dp-12."), status("deploy__live", "completed")] },
    // Land reported success with nothing merged: Deploy waits on a commit that never reached main.
    { ...branching, _id: GALLERY_FLOW.shipUnlanded, status: "running", current_node_id: "deploy__wait",
      node_statuses: [...routed, ...through("decide__decide", "ship__ship", "ship__shipped"), { ...said("deploy__wait", "Waiting for codecast/change-ct-4110 to land on main.", "running"), started_at: now - 32 * 60_000 }] },
    { ...branching, ...card, _id: GALLERY_FLOW.shipBranching, gate_decision_id: refs.decision, gate_decision_short_id: refs.decisionShort,
      node_statuses: [...routed, { ...status("decide__decide", "running"), started_at: now - 20_000 }] },
    // The intent read cleared it: Land with no card, so "Why a person" and Decide were never entered.
    { ...branching, _id: GALLERY_FLOW.shipCleared, status: "completed", current_node_id: "exit", merge: merge(now - 500_000),
      node_statuses: [...through("check__verify", "review__review", "intent", "intent_gate", "cleared", "ship__ship", "ship__shipped"), said("deploy__wait", "Live: 4a6e413b2c on web dp-12."), status("deploy__live", "completed")] },
    // A change that edits CI: Verdicts sends it to a person's card off the main path.
    { ...fan, _id: GALLERY_FLOW.shipCiCard, status: "paused", current_node_id: "decide__decide", gate_node_id: "decide__decide", gate_prompt: "Ship ct-4110? It edits CI, so CI can't vouch for it.", gate_decision_id: "gallerydecision000000010", gate_decision_short_id: "sd-90010",
      node_statuses: [...round, verdicts("decide", "green", "ship", "This change edits CI, so CI can't vouch for it"), said("ci_card", "This change edits CI, so CI can't vouch for it"), status("decide", "completed"), { ...status("decide__decide", "running"), started_at: now - 30_000 }] },
    { ...fan, _id: GALLERY_FLOW.shipCiWait, status: "running", current_node_id: "checks",
      node_statuses: [...through("pr"), status("checks", "running"), { ...status("review", "running") }, { ...said("ci", "Waiting on CI for #12 at abc1234: 9 of 14 jobs done, 7m", "running"), started_at: now - 7 * 60_000 }] },
    // Every failure is also red on main: Verdicts waits for main, and the change goes on once main is green.
    { ...fan, _id: GALLERY_FLOW.shipMainRed, status: "running", current_node_id: "wait_main",
      node_statuses: [...round, verdicts("wait_main", "blocked_by_main", "ship", "every failure is also red on main at 9f8e7d6"), { ...said("wait_main", "Main CI is red at 9f8e7d6 (red since 1a2b3c4, ct-4121): test-web; looking again in 60s", "running"), started_at: now - 18 * 60_000 }] },
    // The change run that carried the skip edit out (it ran the graph the edit built), live in refs.liveDeploy.
    { ...base, workflow_slug: "change", workflow_name: "change", _id: GALLERY_FLOW.editLive, graph_hash: readEdit(EDIT_SKIP_FENCE)!.graph_hash, task_short_id: "ct-4111", task_title: "Skip Decide on this repo's changes", status: "completed", current_node_id: "exit", merge: merge(now - 700_000),
      node_statuses: [...through("pr", "lint"), ...merged.slice(1), said("deploy__wait", `Live: 4a6e413b2c on web ${refs.liveDeploy}.`), status("deploy__live", "completed")] },
    // Land's Read found something: its Brief went back to the session through the segment's Changes asked.
    { ...land, _id: GALLERY_FLOW.shipLandBack, status: "running", current_node_id: "fix",
      waiting_on_session: { node_id: "fix", conversation_id: conversationId, since: now - 180_000, note: "CI red on #12: 1 failure in test-web (inboxDivider.test.ts: the count reads 0 with sessions below it)." },
      node_statuses: [...landRound, ...through("land__brief", "land__changes"), { ...status("fix", "running"), visits: 1 }] },
    // Merge stopped on exit 6, the change edits what judges it: the card inside Land waits on the viewer.
    { ...land, _id: GALLERY_FLOW.shipLandCard, status: "paused", current_node_id: "land__card__decide", gate_node_id: "land__card__decide", gate_prompt: "Ship ct-4110? It edits CI, so CI can't vouch for it.", gate_decision_id: refs.decision, gate_decision_short_id: refs.decisionShort,
      node_statuses: [...landRound, failed("land__merge"), ...through("land__why_card", "land__card"), { ...status("land__card__decide", "running"), started_at: now - 40_000 }] },
    // Merge refused: the runner reports the exit it stopped at.
    { ...fan, _id: GALLERY_FLOW.shipRefused, status: "failed", current_node_id: "unshipped",
      fail_reason: "Stopped: The merge guard refused: the branch would undo changes main made to packages/web/lib/inboxDivider.ts since 4a6e413.",
      node_statuses: [...green, failed("merge"), failed("unshipped")] },
  ];
}

/** The pushed graphs the branching and fan-out run cards draw from. */
export const shipGraphs = (now: number, viewerId: string, workspace: string) => ([[BRANCHING_FLOW, GALLERY_FLOW.branchingGraph], [FANOUT_FLOW, GALLERY_FLOW.fanoutGraph], [LAND_FLOW, GALLERY_FLOW.landGraph]] as const).map(([f, _id]) => ({
  ...f, _id, user_id: viewerId, workspace, created_at: now, updated_at: now,
}));
