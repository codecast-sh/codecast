// A cause's history (line-workspace.md LW1 Timeline, LW5) on Union's real
// AgentWatch run shapes: an attempt that stopped at Prove, a second that
// shipped, merged and was deployed, the problem coming back after the deploy,
// and a third attempt live on it.
import { describe, expect, test } from "bun:test";
import { CARD_GATE_NODE_ID } from "@codecast/shared/contracts/changeCard";
import { earlierFixes } from "../causeHistory";
import { buildLineModel, carryingDeploys, historyBrief, type DeployRow, type LineModelRows, type OccurrenceRow } from "../lineModel";
import type { MapDecision, MapRun } from "../lineMap";
import { agentwatchGraph } from "./agentwatchGraph.fixture";
import { union57382Run } from "./unionLineRuns.fixture";

const DAY = 86_400_000;
const T0 = union57382Run.created_at;
const NOW = T0 + 30 * DAY;
const SHA = "9f1c2ab3d4e5f60718293a4b5c6d7e8f90a1b2c3";

const base = { ...union57382Run, task_id: "t1", workflow_slug: "agentwatch", updated_at: union57382Run.updated_at ?? T0 } as unknown as MapRun;
const done = (node_id: string, at: number) => ({ node_id, status: "completed", outcome: "success", started_at: at, completed_at: at + 60_000 });

// Attempt 1: the real run, stopped at Prove.
const first = base;
// Attempt 2: the same path, then through the card, ship, merge and watch.
const shippedAt = T0 + 5 * DAY;
const second = {
  ...base,
  _id: "run-2",
  status: "completed",
  created_at: T0 + 4 * DAY,
  updated_at: shippedAt + DAY,
  node_statuses: [
    ...(base.node_statuses ?? []).filter((n) => n.node_id !== "prove" && n.node_id !== "refine").map((n) => ({ ...n, started_at: T0 + 4 * DAY, completed_at: T0 + 4 * DAY + 1 })),
    done(CARD_GATE_NODE_ID, shippedAt - DAY),
    done("ship", shippedAt),
    done("merge", shippedAt),
    done("watch", shippedAt + 1),
  ],
  merge: { sha: SHA, branch: "line/ct-57382", into: "main", at: shippedAt, pr_url: "https://github.com/unionmatching/union/pull/812" },
} as unknown as MapRun;
// Attempt 3: live after the comeback.
const third = { ...base, _id: "run-3", status: "running", current_node_id: "investigate", created_at: T0 + 20 * DAY, updated_at: T0 + 20 * DAY, node_statuses: [done("bind", T0 + 20 * DAY)] } as unknown as MapRun;

const card: MapDecision = {
  _id: "d-card", short_id: "sd-9", status: "answered", workflow_run_id: "run-2", task_id: "t1", gate_node_id: CARD_GATE_NODE_ID, created_at: shippedAt - 2 * DAY,
  options: [{ label: "[S] Ship" }, { label: "[R] Revise" }], answer_index: 0, answer_text: "Ship it, but watch Dana's threads", resolved_at: shippedAt - DAY,
  card: { headline: "Keep the sender fixed per thread", change: "Pin the sender identity on the thread's first send", recommend: { verdict: "ship", why: "The eval holds" }, diff: { files: 3, added: 42, removed: 7, pr: "https://github.com/unionmatching/union/pull/812" } } as MapDecision["card"],
};

const occurrences: OccurrenceRow = {
  _id: "t1", task_id: "t1", project_id: "p1", sources: ["agentwatch"], since: T0 - 60 * DAY, capped: false,
  // Before any fix, then twice after the deploy of the fix (the second reopening it).
  observed: [T0 - 3 * DAY, T0 - DAY, T0 + 2 * DAY, shippedAt + 3 * DAY, shippedAt + 4 * DAY],
  reopened: [shippedAt + 3 * DAY],
};

const deploy = (over: Partial<DeployRow>): DeployRow => ({
  _id: "dep", project_id: "p1", at: shippedAt + DAY, sha: null, repository: null, surface: null, environment: null, version: null, source: "codecast", via: "repository", title: "deploy", url: null, ...over,
});
const deploys: DeployRow[] = [
  // Before the merge: carries nothing.
  deploy({ _id: "dep-0", at: shippedAt - DAY, sha: "0000000aaaa", repository: "unionmatching/union", surface: "backend" }),
  // The merge's own commit, deployed to backend a day later.
  deploy({ _id: "dep-1", at: shippedAt + DAY, sha: SHA.slice(0, 12), repository: "unionmatching/union", surface: "backend" }),
  // A later backend deploy: the first per target counts.
  deploy({ _id: "dep-2", at: shippedAt + 2 * DAY, sha: "1111111bbbb", repository: "unionmatching/union", surface: "backend" }),
  // The workspace's source reported prod after the merge: assumed to carry it.
  deploy({ _id: "dep-3", at: shippedAt + 2 * DAY, sha: "2222222cccc", environment: "prod", source: "union", via: "source", version: "1.4.0" }),
  // Another repository's deploy is not this code.
  deploy({ _id: "dep-4", at: shippedAt + DAY, sha: "3333333dddd", repository: "acme/other", surface: "web" }),
];

const task = { _id: "t1", short_id: "ct-57382", title: "Sender identity re-derived per send", status: "in_progress", created_at: T0 - 5 * DAY, cause: { signal_count: 5, first_seen: T0 - 3 * DAY, last_seen: shippedAt + 4 * DAY, fingerprints: [] } };
const queued = { _id: "t9", short_id: "ct-9", title: "Nobody took this yet", status: "open", created_at: T0, cause: { signal_count: 1, first_seen: T0, last_seen: T0, fingerprints: [] } };

const rows = (over: Partial<LineModelRows> = {}): LineModelRows => ({
  runs: [third, second, first],
  tasks: [task, queued] as LineModelRows["tasks"],
  signals: [],
  decisions: [card],
  graph: agentwatchGraph,
  occurrences: [occurrences],
  deploys,
  watchDays: 7,
  now: NOW,
  ...over,
});

describe("a cause's history", () => {
  const m = buildLineModel(rows(), "agentwatch");
  const h = m.issues.find((i) => i.id === "t1")!.history;

  test("occurrences come from the full series, oldest first, reopenings marked", () => {
    expect(h.occurrencesFrom).toBe("history");
    expect(h.occurrences.map((o) => o.at)).toEqual(occurrences.observed);
    expect(h.occurrences.filter((o) => o.reopened).map((o) => o.at)).toEqual([shippedAt + 3 * DAY]);
  });

  test("every attempt, oldest first, with how it ended and what it said", () => {
    expect(h.attempts.map((a) => [a.n, a.runId, a.live])).toEqual([[1, first._id, false], [2, "run-2", false], [3, "run-3", true]]);
    expect(h.attempts[0].outcome.text).toMatch(/^Stopped at Prove/);
    expect(h.attempts[0].found).toBeTruthy();
    expect(h.attempts[1].ended).toBe("shipped");
    expect(h.attempts[1].card).toMatchObject({ ref: "sd-9", headline: "Keep the sender fixed per thread", answer: "Ship", note: "Ship it, but watch Dana's threads" });
    expect(h.attempts[1].proposed).toBe("Pin the sender identity on the thread's first send");
    expect(h.attempts[1].diff).toEqual({ files: 3, added: 42, removed: 7, pr: "https://github.com/unionmatching/union/pull/812" });
    expect(h.attempts[1].merge).toMatchObject({ sha: SHA, into: "main", repository: "unionmatching/union" });
    expect(h.attempts[2].end).toBeNull();
  });

  test("the deploys that carried the merge: first per target, and how each is known", () => {
    expect(h.deploys.map((d) => [d.id, d.target, d.how])).toEqual([["dep-1", "backend", "same commit"], ["dep-3", "prod", "deployed after the merge"]]);
    expect(h.ships).toHaveLength(1);
    expect(h.ships[0]).toMatchObject({ runId: "run-2", basis: "deploy", liveAt: shippedAt + DAY });
    expect(h.ships[0].words).toMatch(/^Deployed to backend and to prod /);
    expect(h.coverage).toMatchObject({ state: "known", targets: ["backend", "prod", "web"] });
  });

  test("occurrences after the deploy that carried the fix are a regression", () => {
    expect(h.regressions).toHaveLength(1);
    expect(h.regressions[0]).toMatchObject({ afterRunId: "run-2", at: shippedAt + 3 * DAY, count: 2, basis: "deploy" });
    expect(h.regressions[0].words).toMatch(/^Came back 2 times after the deploy of /);
    expect(h.regressed).toBe(true);
  });

  test("the watch after the ship reopened when the problem came back", () => {
    expect(h.watches).toEqual([{ runId: "run-2", start: shippedAt + 1 + 60_000, end: shippedAt + 3 * DAY, state: "reopened", reopenedAt: shippedAt + 3 * DAY }]);
  });

  test("the next attempt is handed what the earlier ones did and that the fix did not hold", () => {
    const brief = historyBrief(h);
    expect(brief).toMatch(/^This cause has had 2 earlier attempts\./);
    expect(brief).toContain("Proposed: Pin the sender identity on the thread's first send");
    expect(brief).toContain("Card answered Ship: \"Ship it, but watch Dana's threads\"");
    expect(brief).toContain("That fix did not hold.");
    expect(brief).toContain("Came back 2 times after the deploy of");
    expect(brief).toMatch(/The newest fix did not hold: the problem came back after it went live\.$/);
    // What to do with it is the station prompt's to say; the brief is the record.
    expect(brief).not.toMatch(/do not propose/i);
  });

  test("the new attempt's card shows the earlier shipped fix and that it came back", () => {
    expect(earlierFixes(h)).toEqual([{
      attempt: 2, ref: expect.anything(), change: "Pin the sender identity on the thread's first send.", live: expect.stringMatching(/^Deployed to backend and to prod /),
      held: null, back: expect.stringMatching(/^Came back 2 times after the deploy of /),
    }]);
    // The attempt a card is for is not its own earlier fix.
    expect(earlierFixes(h, "run-2")).toEqual([]);
  });

  test("a cause no run has taken is still a problem on the timeline; newest activity first", () => {
    expect(m.issues.map((i) => i.id)).toEqual(["t1", "t9"]);
    const q = m.issues.find((i) => i.id === "t9")!;
    expect(q.runs).toEqual([]);
    expect(q.history.attempts).toEqual([]);
    expect(historyBrief(q.history)).toBe("");
  });
});

describe("when a deploy cannot be known", () => {
  test("no deploys recorded: the fix is measured from the merge, and says so", () => {
    const h = buildLineModel(rows({ deploys: [] }), "agentwatch").issues.find((i) => i.id === "t1")!.history;
    expect(h.coverage.state).toBe("none");
    expect(h.ships[0]).toMatchObject({ basis: "merge", liveAt: shippedAt, deploys: [] });
    expect(h.ships[0].words).toMatch(/no deploy recorded since$/);
    expect(h.regressions[0].words).toMatch(/after the merge of .* \(no deploy recorded\)$/);
  });

  test("deploys not read yet: nothing is claimed about them", () => {
    const h = buildLineModel(rows({ deploys: undefined }), "agentwatch").issues.find((i) => i.id === "t1")!.history;
    expect(h.coverage.state).toBe("unread");
    expect(h.ships[0].words).not.toMatch(/no deploy/);
  });

  test("without the full series, the recent signals stand in", () => {
    const h = buildLineModel(rows({ occurrences: [], signals: [{ _id: "s1", task_id: "t1", source: "agentwatch", kind: "x", title: "x", observed_at: shippedAt + 3 * DAY, created_at: shippedAt + 3 * DAY, reopened: true }] as unknown as LineModelRows["signals"] }), "agentwatch").issues.find((i) => i.id === "t1")!.history;
    expect(h.occurrencesFrom).toBe("recent");
    expect(h.occurrences).toEqual([{ at: shippedAt + 3 * DAY, reopened: true }]);
    expect(h.regressed).toBe(true);
  });
});

describe("carryingDeploys", () => {
  test("a deploy before the merge never carries it, unless it is the same commit", () => {
    const merge = { sha: SHA, branch: "b", into: "main", at: shippedAt, prUrl: null, repository: "unionmatching/union" };
    expect(carryingDeploys(merge, [deploy({ _id: "x", at: shippedAt - DAY, sha: "abcdef0", surface: "backend" })], "r")).toEqual([]);
    expect(carryingDeploys(merge, [deploy({ _id: "y", at: shippedAt - 1, sha: SHA, surface: "backend" })], "r").map((d) => d.how)).toEqual(["same commit"]);
  });
});
