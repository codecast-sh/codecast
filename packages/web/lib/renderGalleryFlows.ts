// The render gallery's flows (lib/renderGallery.ts): a flow a session defined on a backbone with its live run, a
// finished run of a library flow, the session's change runs at each place a person meets one, and the run that
// carried a pipeline edit out (pipeline.md PL5). Ids are lowercase so a run id reads as one in `cast flow run` output.
// Pure and free of the `@/` alias: the phone's bundle and tests import it through the gallery.
import { readEdit } from "./line/flowEditFence";
import { EDIT_SKIP } from "./renderGalleryPipeline.generated";

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
  { id: "exit", label: "Shipped", type: "exit", shape: "Msquare" },
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

/** Runs of the shipped Change flow from this session, one at each place a person meets it. */
export function shipRuns(now: number, viewerId: string, workspace: string, conversationId: string, status: (id: string, s: "completed" | "running") => object, refs: { decision: string; decisionShort: string; liveDeploy: string }) {
  const base = { user_id: viewerId, workflow_slug: "change", workflow_name: "change", workspace, spawner_conversation_id: conversationId, task_short_id: "ct-4110", task_title: "Rename the inbox divider", created_at: now - 900_000, updated_at: now };
  const through = (...ids: string[]) => ids.map((id) => status(id, "completed"));
  return [
    { ...base, _id: GALLERY_FLOW.shipBack, status: "running", current_node_id: "fix_review",
      waiting_on_session: { node_id: "fix_review", conversation_id: conversationId, since: now - 240_000, note: "The reviewer asked for changes. The divider's label repeats the bucket name; say how many sessions are below it instead." },
      node_statuses: [...through("check__verify", "review__review"), { ...status("fix_review", "running"), visits: 2 }] },
    { ...base, _id: GALLERY_FLOW.shipDecide, status: "paused", current_node_id: "decide__decide", gate_prompt: "Ship the inbox divider rename?", gate_decision_id: refs.decision, gate_decision_short_id: refs.decisionShort,
      node_statuses: [...through("check__verify", "review__review"), status("decide__decide", "running")] },
    { ...base, _id: GALLERY_FLOW.shipDeploy, status: "running", current_node_id: "deploy__wait",
      node_statuses: [...through("check__verify", "review__review", "decide__decide", "ship__rebase", "ship__ship"), { ...status("deploy__wait", "running"), result_preview: "4a6e413b2c landed; live on web dp-12, waiting for backend." }] },
    // The run that carried the skip edit (it ran the graph the edit built), out in dp-90003.
    { ...base, _id: GALLERY_FLOW.editLive, graph_hash: readEdit(EDIT_SKIP_FENCE)!.graph_hash, task_short_id: "ct-4111", task_title: "Skip Decide on this repo's changes", status: "completed", current_node_id: "exit",
      node_statuses: [...through("check__verify", "review__review", "ship__rebase", "ship__ship"), { ...status("deploy__wait", "completed"), result_preview: `Live: 4a6e413b2c on web ${refs.liveDeploy}.` }] },
    { ...base, _id: GALLERY_FLOW.shipLive, status: "completed", current_node_id: "exit",
      node_statuses: [...through("check__verify", "review__review", "decide__decide", "ship__rebase", "ship__ship"), { ...status("deploy__wait", "completed"), result_preview: "Live: 4a6e413b2c on backend dp-13, web dp-12." }] },
  ];
}
