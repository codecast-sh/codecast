// Fixture rows for the line map and trace tests: one project's line as the
// store holds it, shaped like the rows lineFlow and runReport tests use.
import type { LineFinderDecl } from "@codecast/shared/contracts/lineProfile";
import type { LineCauseTask } from "../../lineFlow";
import type { MapDecision, MapRun, MapRunNode, MapSignal } from "../lineMap";

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const NOW = 1_790_000_000_000;

/** A node status that started `at` and took `mins`. */
export const n = (node_id: string, at: number, mins = 5, status = "completed", extra: Partial<MapRunNode> = {}): MapRunNode => ({
  node_id, status, outcome: status === "completed" ? "success" : undefined, started_at: at, completed_at: status === "running" ? undefined : at + mins * MIN, ...extra,
});

export const finders: LineFinderDecl[] = [
  { id: "agentwatch-judge", source: "agentwatch", kind: ["prompt_miss"], fingerprint: "aw:{cluster}" },
  { id: "chat", source: "chat", kind: "any", fingerprint: "chat:{thread}" },
];

const sig = (o: Partial<MapSignal> & Pick<MapSignal, "_id" | "task_id" | "created_at">): MapSignal => ({
  short_id: o._id.replace("sig_", "sg-"), source: "agentwatch", kind: "prompt_miss", title: "Reply skipped the broker's question", observed_at: o.created_at - 5 * MIN, attach: "fingerprint", ...o,
});

// ── A: shipped after one revise round, watch ended quiet ──
const A0 = NOW - 5 * DAY;
export const causeA: LineCauseTask = {
  _id: "task_a", short_id: "ct-101", title: "Broker replies skip the question asked", status: "done", priority: "high", created_at: A0, closed_at: A0 + 40 * HOUR,
  cause: { signal_count: 3, first_seen: A0 - 10 * MIN, last_seen: A0 + 2 * HOUR, fingerprints: ["aw:c-42"] },
  goal_ref: "in-3", category: "prompt", risk: "review", readiness: "ready", readiness_note: "Three replies show it", watch_until: NOW - 6 * HOUR, resolved_at: NOW - 6 * HOUR, project_id: "proj",
};
export const signalsA: MapSignal[] = [
  sig({ _id: "sig_a1", task_id: "task_a", created_at: A0 - 5 * MIN, attach: "new", subject: "ex-union-3", fingerprint: "aw:c-42", evidence_url: "https://admin.example.com/agentwatch/clusters/c-42", detail_md: "## Finding\nThe agent answered a different question than the broker asked." }),
  sig({ _id: "sig_a2", task_id: "task_a", created_at: A0 + HOUR, fingerprint: "aw:c-42", subject: "ex-union-3" }),
  sig({ _id: "sig_a3", task_id: "task_a", created_at: A0 + 2 * HOUR, attach: "judge", source: "chat", kind: "bug", fingerprint: "chat:t-9", title: "Agent ignored my question again" }),
];
// The run row keeps each station's newest visit: the first round through
// implement..decide survives only as the reopen between red and implement.
const r = A0 + HOUR;
export const runA: MapRun = {
  _id: "run_a", status: "completed", task_id: "task_a", workflow_name: "line", current_node_id: "exit", graph_hash: "h1",
  gate_node_id: "decide", gate_response: "S", gate_answer: "Ship", gate_decision_short_id: "sd-2",
  gate_choices: [{ key: "S", label: "[S] Ship", target: "ship" }, { key: "R", label: "[R] Revise", target: "reopen" }, { key: "D", label: "[D] Drop", target: "drop" }],
  node_statuses: [
    n("start", r, 0), n("ground", r, 4, "completed", { session_id: "jx_ground" }), n("analyze", r + 5 * MIN), n("prove", r + 10 * MIN, 30), n("red", r + 45 * MIN),
    n("reopen", r + 20 * HOUR, 1), n("implement", r + 21 * HOUR, 40, "completed", { session_id: "jx_impl2" }), n("verify", r + 22 * HOUR), n("eval", r + 23 * HOUR, 20), n("review", r + 24 * HOUR),
    n("card_draft", r + 25 * HOUR, 1), n("card_write", r + 25 * HOUR + 2 * MIN, 3), n("card", r + 25 * HOUR + 6 * MIN, 1),
    n("decide", r + 26 * HOUR, 60, "failed", { outcome: "S" }), n("ship", r + 38 * HOUR, 2), n("merge", r + 38 * HOUR + 3 * MIN, 1), n("watch", r + 38 * HOUR + 5 * MIN, 1), n("exit", r + 38 * HOUR + 7 * MIN, 0),
  ],
  created_at: r, updated_at: r + 38 * HOUR + 7 * MIN,
};
export const decisionsA: MapDecision[] = [
  { _id: "dec_a1", short_id: "sd-1", status: "answered", blocking: true, task_id: "task_a", workflow_run_id: "run_a", gate_node_id: "decide", created_at: r + 4 * HOUR, resolved_at: r + 5 * HOUR, options: [{ label: "Ship" }, { label: "Revise" }, { label: "Drop" }], answer_index: 1, card: { headline: "Replies answer the question asked", recommend: { verdict: "ship", why: "every miss passes" } } },
  { _id: "dec_a2", short_id: "sd-2", status: "answered", blocking: true, task_id: "task_a", workflow_run_id: "run_a", gate_node_id: "decide", created_at: r + 26 * HOUR, resolved_at: r + 27 * HOUR, options: [{ label: "Ship" }, { label: "Revise" }, { label: "Drop" }], answer_index: 0, answered_by: { kind: "user", id: "u1" }, card: { headline: "Replies answer the question asked", recommend: { verdict: "ship", why: "every miss passes, guards hold" } } },
];

// ── B: dissolved at prove ──
const B0 = NOW - 2 * DAY;
export const causeB: LineCauseTask = { _id: "task_b", short_id: "ct-102", title: "Intro email sent twice", status: "done", created_at: B0, closed_at: B0 + 2 * HOUR, cause: { signal_count: 1, first_seen: B0, last_seen: B0, fingerprints: ["ci:intro"] }, goal_ref: "in-3", category: "code", risk: "low", readiness: "ready", project_id: "proj" };
export const signalsB: MapSignal[] = [sig({ _id: "sig_b1", task_id: "task_b", created_at: B0, source: "ci", kind: "bug", attach: "new", fingerprint: "ci:intro", title: "Intro email test flaked twice", evidence_url: "https://ci.example.com/runs/77" })];
export const runB: MapRun = {
  _id: "run_b", status: "completed", task_id: "task_b", workflow_name: "line", current_node_id: "exit",
  node_statuses: [n("ground", B0 + MIN, 3), n("analyze", B0 + 5 * MIN), n("prove", B0 + 10 * MIN, 50), n("dissolve", B0 + HOUR, 1)],
  created_at: B0 + MIN, updated_at: B0 + HOUR + MIN,
};

// ── C: building, stuck at implement for six hours (implement usually takes about 40m) ──
const C0 = NOW - 8 * HOUR;
export const causeC: LineCauseTask = { _id: "task_c", short_id: "ct-103", title: "Call summary drops the action items", status: "in_progress", created_at: C0, cause: { signal_count: 1, first_seen: C0, last_seen: C0, fingerprints: ["aw:c-7"] }, goal_ref: "in-3", category: "prompt", risk: "low", readiness: "ready", project_id: "proj" };
export const signalsC: MapSignal[] = [sig({ _id: "sig_c1", task_id: "task_c", created_at: C0, fingerprint: "aw:c-7", attach: "new", title: "Summary lost two action items" })];
export const runC: MapRun = {
  _id: "run_c", status: "running", task_id: "task_c", workflow_name: "line", current_node_id: "implement",
  node_statuses: [n("ground", C0 + MIN, 3), n("analyze", C0 + 5 * MIN), n("prove", C0 + 10 * MIN, 30), n("red", C0 + 45 * MIN), n("implement", C0 + 2 * HOUR, 0, "running")],
  created_at: C0 + MIN, updated_at: NOW - 10 * MIN,
};
// Two earlier implement visits that took 40m, so implement has a usual time.
export const pastRuns: MapRun[] = [1, 2].map((i) => ({
  _id: `run_p${i}`, status: "failed", task_id: "task_d", workflow_name: "line", current_node_id: "verify", fail_reason: "max_visits=3 exceeded on implement",
  node_statuses: [n("ground", NOW - 20 * DAY + i * HOUR, 3), n("analyze", NOW - 20 * DAY + i * HOUR + 4 * MIN), n("prove", NOW - 20 * DAY + i * HOUR + 10 * MIN, 20), n("red", NOW - 20 * DAY + i * HOUR + 31 * MIN), n("implement", NOW - 20 * DAY + i * HOUR + 35 * MIN, 40), n("verify", NOW - 20 * DAY + i * HOUR + 76 * MIN, 5, "failed")],
  created_at: NOW - 20 * DAY + i * HOUR, updated_at: NOW - 20 * DAY + i * HOUR + 81 * MIN,
}));
export const causeD: LineCauseTask = { _id: "task_d", short_id: "ct-104", title: "Old flaky checks", status: "open", created_at: NOW - 21 * DAY, cause: { signal_count: 1, first_seen: NOW - 21 * DAY, last_seen: NOW - 21 * DAY, fingerprints: ["ci:old"] }, goal_ref: "in-3", category: "code", risk: "low", readiness: "ready", project_id: "proj" };

// ── E: open, never run ──
export const causeE: LineCauseTask = { _id: "task_e", short_id: "ct-105", title: "Settings page loads slowly", status: "open", created_at: NOW - 3 * HOUR, cause: { signal_count: 1, first_seen: NOW - 3 * HOUR, last_seen: NOW - 3 * HOUR, fingerprints: ["chat:t-12"] }, project_id: "proj" };
export const signalsE: MapSignal[] = [sig({ _id: "sig_e1", task_id: "task_e", created_at: NOW - 3 * HOUR, source: "chat", kind: "ux", attach: "person", fingerprint: "chat:t-12", title: "Settings takes ten seconds to open" })];

// ── F: shipped, then its signal came back in the watch ──
const F0 = NOW - 4 * DAY;
export const causeF: LineCauseTask = { _id: "task_f", short_id: "ct-106", title: "Calendar invite has the wrong timezone", status: "open", created_at: F0, closed_at: F0 + 10 * HOUR, watch_until: NOW + 3 * DAY, cause: { signal_count: 2, first_seen: F0, last_seen: NOW - DAY, fingerprints: ["ci:tz"] }, goal_ref: "in-3", category: "code", risk: "low", readiness: "ready", project_id: "proj" };
export const signalsF: MapSignal[] = [
  sig({ _id: "sig_f1", task_id: "task_f", created_at: F0, source: "ci", kind: "bug", attach: "new", fingerprint: "ci:tz", title: "Timezone test fails in UTC+2" }),
  sig({ _id: "sig_f2", task_id: "task_f", created_at: NOW - DAY, source: "ci", kind: "regression", fingerprint: "ci:tz", title: "Timezone test fails again", reopened: true }),
];
export const runF: MapRun = {
  _id: "run_f", status: "completed", task_id: "task_f", workflow_name: "line", current_node_id: "exit", gate_node_id: "decide", gate_answer: "Ship",
  node_statuses: [
    n("ground", F0 + MIN, 3), n("analyze", F0 + 5 * MIN), n("prove", F0 + 10 * MIN, 20), n("red", F0 + 31 * MIN), n("implement", F0 + 35 * MIN, 40), n("verify", F0 + 76 * MIN),
    n("green", F0 + 82 * MIN), n("eval", F0 + 88 * MIN), n("review", F0 + 95 * MIN, 10), n("card_draft", F0 + 2 * HOUR, 1), n("card_write", F0 + 2 * HOUR + 2 * MIN), n("card", F0 + 2 * HOUR + 8 * MIN, 1),
    n("decide", F0 + 2 * HOUR + 10 * MIN, 120, "failed", { outcome: "S" }), n("ship", F0 + 10 * HOUR, 2), n("merge", F0 + 10 * HOUR + 3 * MIN, 1), n("watch", F0 + 10 * HOUR + 5 * MIN, 1),
  ],
  created_at: F0 + MIN, updated_at: F0 + 10 * HOUR + 7 * MIN,
};

export const rows = {
  signals: [...signalsA, ...signalsB, ...signalsC, ...signalsE, ...signalsF],
  tasks: [causeA, causeB, causeC, causeD, causeE, causeF],
  runs: [runA, runB, runC, ...pastRuns, runF],
  decisions: decisionsA,
};
