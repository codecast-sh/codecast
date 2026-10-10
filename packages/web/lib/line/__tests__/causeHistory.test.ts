// A cause's history (line-workspace.md LW1 Timeline, LW5) on Union's real
// AgentWatch run shapes: an attempt that stopped at Prove, a second that
// shipped, merged and was deployed, the problem coming back after the deploy,
// and a third attempt live on it.
import { describe, expect, test } from "bun:test";
import { CARD_GATE_NODE_ID } from "@codecast/shared/contracts/changeCard";
import { closesArgument, closesSummary, earlierFixes } from "../causeHistory";
import { cameBackCount, problemLine, problemState } from "../timeline";
import { buildLineModel, carryingDeploys, decisionSaid, findingNeverShipped, historyBrief, type DeployRow, type LineModelRows, type OccurrenceRow } from "../lineModel";
import type { MapDecision, MapRun } from "../lineMap";
import { agentwatchGraph } from "./agentwatchGraph.fixture";
import { union57382Run } from "./unionLineRuns.fixture";

const DAY = 86_400_000;
const HOUR = 3_600_000;
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
    expect(h.regressions[0].words).toMatch(/^Came back 2x after the deploy of /);
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
    expect(brief).toContain("Came back 2x after the deploy of");
    // One closing sentence: the attempt's own line says the fix did not hold, nothing repeats it.
    expect(brief).toMatch(/That fix did not hold\.$/);
    expect(brief).not.toContain("The newest fix did not hold");
    // What to do with it is the station prompt's to say; the brief is the record.
    expect(brief).not.toMatch(/do not propose/i);
  });

  test("the new attempt's card shows the earlier shipped fix and that it came back", () => {
    expect(earlierFixes(h)).toEqual([{
      attempt: 2, ref: "sd-9", change: "Pin the sender identity on the thread's first send", live: expect.stringMatching(/^Deployed to backend and to prod /),
      held: null, back: expect.stringMatching(/^Came back 2x after the deploy of /),
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

  test("a deploy to a machine's own local or a staging environment never puts a fix live", () => {
    // Union's api posts a deploy at every boot with errorLog's environment, a developer's laptop included.
    const merge = { sha: SHA, branch: "b", into: "main", at: shippedAt, prUrl: null, repository: "unionmatching/union" };
    const local = deploy({ _id: "local", at: shippedAt + HOUR, sha: SHA, environment: "local", source: "union", via: "source" });
    const staging = deploy({ _id: "stg", at: shippedAt + 2 * HOUR, sha: SHA, environment: "Staging", source: "union", via: "source" });
    const prod = deploy({ _id: "prod", at: shippedAt + DAY, sha: SHA, environment: "production", source: "union", via: "source" });
    expect(carryingDeploys(merge, [local, staging, prod], "r").map((d) => d.id)).toEqual(["prod"]);
  });
});

// ct-57367's shape: AgentWatch dissolved it three times as no fix needed
// (dissolve, then dissolved_at_dissolve) and it kept happening after each.
describe("a cause closed without a change that keeps coming back", () => {
  const dissolveRun = (id: string, at: number): MapRun => ({
    ...base, _id: id, status: "completed", created_at: at, updated_at: at + HOUR, current_node_id: "exit",
    node_statuses: [done("bind", at), done("dissolve", at + 60_000), done("dissolved_at_dissolve", at + 120_000), done("exit", at + 180_000)],
  } as unknown as MapRun);
  const runs = [dissolveRun("d3", T0 + 6 * DAY), dissolveRun("d2", T0 + 3 * DAY), dissolveRun("d1", T0)];
  const series: OccurrenceRow = { ...occurrences, observed: [T0 - DAY, T0 + DAY, T0 + 2 * DAY, T0 + 4 * DAY, T0 + 7 * DAY, T0 + 8 * DAY], reopened: [] };
  const m = buildLineModel(rows({ runs, decisions: [], occurrences: [series], deploys: [] }), "agentwatch");
  const h = m.issues.find((i) => i.id === "t1")!.history;

  test("each dissolve is a close; what happened after it, until the next close, came back after it", () => {
    expect(h.attempts.map((a) => [a.n, a.ended, a.endStep])).toEqual([[1, "dissolved", "dissolve"], [2, "dissolved", "dissolve"], [3, "dissolved", "dissolve"]]);
    expect(h.closes.map((c) => [c.n, c.kind])).toEqual([[1, "dissolved"], [2, "dissolved"], [3, "dissolved"]]);
    expect(h.recurrences.map((r) => [r.n, r.count])).toEqual([[1, 2], [2, 1], [3, 2]]);
    expect(h.recurrences[0].words).toBe("Came back 2x after attempt 1 dissolved it");
    expect(h.cameBack).toBe(true);
    expect(h.regressed).toBe(false);
  });

  test("the header and the Came back tile say one count: every occurrence after any close", () => {
    const issue = m.issues.find((i) => i.id === "t1")!;
    expect(cameBackCount(h)).toBe(5);
    expect(problemLine(issue)).toMatch(/, came back 5x after 3 closes$/);
  });

  test("the next attempt is told what came back after each dissolve, once, after the list", () => {
    const brief = historyBrief(h);
    expect(brief.split("\n")[0]).toBe("This cause has had 3 earlier attempts.");
    // What came back between one close and the next, said once per close and never inside the attempts' own lines.
    expect(brief).toContain("Came back 2x after attempt 1 dissolved it, on");
    expect(brief).toContain("Came back 1x after attempt 2 dissolved it, on");
    expect(brief.split("\n").filter((l) => l.startsWith("- ")).every((l) => !l.includes("Came back"))).toBe(true);
    expect(brief).toMatch(/Closing it without a change never held: the reasoning that closed it was wrong\.$/);
    expect(closesSummary(h)).toBe("Dissolved 3x as no fix needed; it came back after each one.");
  });

  test("every dissolve it came back after reads as a close that did not hold, on the decision and the graph", () => {
    const dissolves = m.steps.dissolve.decisions.filter((d) => d.caseId === "t1");
    expect(dissolves.map((d) => [d.runId, d.closed?.held, d.closed?.count])).toEqual([["d3", false, 2], ["d2", false, 3], ["d1", false, 5]]);
    expect(m.steps.dissolve.tally.rows.find((r) => r.n === 3)?.back).toBe(3);
    expect(m.graph.edges.find((e) => e.id === "dissolve->dissolved_at_dissolve")?.back).toBe(3);
  });

  test("each close is remembered by its argument, with when and what came back after it", () => {
    const evidence = "Graded against the fee rule the founders replaced Oct 6; the live policy allows the two-lane answer.";
    const argued = runs.map((r) => r._id !== "d3" ? r : {
      ...r,
      node_statuses: r.node_statuses!.map((n) => n.node_id !== "dissolve" ? n : {
        ...n, session_id: "s-d3",
        session: { _id: "s-d3", state: "```json\n" + JSON.stringify({ outcome: "dissolved", kind: "historical", evidence }) + "\n```" },
      }),
    } as MapRun);
    const signal = (at: number, quote: string) => ({ _id: `sig-${at}`, task_id: "t1", source: "agentwatch", title: "f", created_at: at, observed_at: at, detail_md: `Finding\n> "${quote}"` });
    const signals = [signal(T0 + 7 * DAY, "We take a five percent fee on every transaction."), signal(T0 + 8 * DAY, "Fees are zero for now.")];
    const hh = buildLineModel(rows({ runs: argued, decisions: [], occurrences: [series], deploys: [], signals: signals as unknown as LineModelRows["signals"] }), "agentwatch")
      .issues.find((i) => i.id === "t1")!.history;
    const brief = historyBrief(hh);
    // The argument, not the outcome's label: the next run can see which one was wrong.
    expect(brief).toContain(`Found: ${evidence}`);
    expect(brief).not.toContain("Found: Closed: no fix needed");
    // Two dates are joined with "and", and one occurrence after the close speaks for itself.
    // The quote ends its own sentence: no stray stop after it.
    expect(brief).toMatch(/Came back 2x after attempt 3 dissolved it, on \w+ \d+ and \w+ \d+; one said: "We take a five percent fee on every transaction\." Closing/);
    expect(brief).not.toContain('."."');
    expect(brief).not.toContain('.".');
    expect(brief).not.toMatch(/first on \w+ \d+, /);
  });

  test("a close that names an eval as its guard is told plainly that nothing shipped it", () => {
    const evidence = "Already fixed by the Oct 6 fee policy; resolved with a tracked replay eval as the guard.";
    const argued = runs.map((r) => r._id !== "d3" ? r : {
      ...r,
      node_statuses: r.node_statuses!.map((n) => n.node_id !== "dissolve" ? n : { ...n, session_id: "s-d3", session: { _id: "s-d3", state: "```json\n" + JSON.stringify({ outcome: "dissolved", evidence }) + "\n```" } }),
    } as MapRun);
    const hh = buildLineModel(rows({ runs: argued, decisions: [], occurrences: [series], deploys: [] }), "agentwatch").issues.find((i) => i.id === "t1")!.history;
    const brief = historyBrief(hh);
    expect(brief).toContain("any eval or guard it mentions was never shipped");
    expect(brief.match(/never shipped/g)).toHaveLength(1);
  });
});

// ct-58022's shape: the run went on past a card nobody answered, merged and
// started its watch. Nobody approved it, but the fix is live and watched.
describe("a fix that landed past an unanswered card", () => {
  const at = T0 + DAY;
  const landed = {
    ...base, _id: "u1", status: "completed", created_at: T0, updated_at: at + HOUR, current_node_id: "exit",
    node_statuses: [done("bind", T0), { ...done(CARD_GATE_NODE_ID, at - HOUR), outcome: "failure" }, done("ship", at), done("merge", at), done("watch", at + 1000)],
  } as unknown as MapRun;
  const watched = { ...task, status: "open", watch_until: NOW + 5 * DAY };
  const m = buildLineModel(rows({ runs: [landed], decisions: [], occurrences: [{ ...occurrences, observed: [T0 - DAY], reopened: [] }], deploys: [], tasks: [watched] as LineModelRows["tasks"] }), "agentwatch");
  const h = m.issues.find((i) => i.id === "t1")!.history;

  test("it is a ship, marked unapproved, and the watch after it runs", () => {
    expect(h.attempts[0]).toMatchObject({ ended: "shipped", unapproved: true });
    expect(h.ships[0].words).toMatch(/past a card nobody answered$/);
    expect(h.closes.map((c) => c.kind)).toEqual(["shipped"]);
    expect(h.watches[0].state).toBe("watching");
  });

  test("its line says what the state says, from the same close: live and watching, not 'not shipped'", () => {
    const issue = m.issues.find((i) => i.id === "t1")!;
    // The state says it shipped without approval; the line says how it landed and the watch, never "shipped" beside "nobody approved".
    expect(problemState(h, issue.status)).toBe("unapproved");
    expect(problemLine(issue, undefined, NOW)).toMatch(/^Shipped \w+ \d+ \(#1\) though its card was never answered; watching 5 more days, no recurrence yet$/);
  });
});

test("closesSummary counts a close as not holding only when the problem came back before the next close", () => {
  const close = (n: number, day = n) => ({ runId: `d${n}`, n, kind: "dissolved" as const, at: T0 + day * DAY, step: "dissolve", back: null });
  // What came back after a close, until the next close.
  const rec = (n: number, count: number) => ({ afterRunId: `d${n}`, n, kind: "dissolved" as const, closedAt: 0, at: 0, count, until: null, words: "", quote: null });
  const closes = [close(1), close(2), close(3)];
  expect(closesSummary({ closes, recurrences: [rec(3, 3)] })).toBe("Dissolved 3x as no fix needed; it came back 3x after the latest.");
  expect(closesSummary({ closes, recurrences: [rec(2, 1), rec(3, 3)] })).toBe("Dissolved 3x as no fix needed; it came back after 2 of them, 3x after the latest.");
  expect(closesSummary({ closes, recurrences: [rec(1, 1), rec(2, 1), rec(3, 3)] })).toBe("Dissolved 3x as no fix needed; it came back after each one.");
  expect(closesSummary({ closes, recurrences: [] })).toBe("Dissolved 3x as no fix needed; it has not come back since.");
  // Three dissolves within hours of each other are one day's closes, and only the latest came back.
  expect(closesSummary({ closes: [close(1, 0), close(2, 0.1), close(3, 0.2)], recurrences: [rec(3, 3)] })).toBe("Dissolved 3x as no fix needed, all on " + new Date(T0).toLocaleDateString("en-US", { month: "short", day: "numeric" }) + "; it came back 3x after the latest.");
  expect(closesSummary({ closes: [close(1)], recurrences: [rec(1, 2)] })).toBe("Dissolved once as no fix needed; it came back 2x.");
  expect(closesSummary({ closes: [], recurrences: [] })).toBeNull();
});

// ct-57367 as it happened: three dissolves within hours on one day, each
// arguing the fix was owned elsewhere (xp-12, then the Oct 6 policy), and the
// problem came back three times after the last of them.
describe("closes within hours that argued the same thing", () => {
  const report = (r: Record<string, unknown>, said: string) => "```json\n" + JSON.stringify(r) + "\n```\n" + said;
  const dissolveRun = (id: string, at: number, state: string): MapRun => ({
    ...base, _id: id, status: "completed", created_at: at, updated_at: at + HOUR, current_node_id: "exit",
    node_statuses: [done("bind", at), { ...done("dissolve", at + 60_000), session_id: `s-${id}`, session: { _id: `s-${id}`, state } }, done("dissolved_at_dissolve", at + 120_000), done("exit", at + 180_000)],
  } as unknown as MapRun);
  const runs = [
    dissolveRun("d3", T0 + 7 * HOUR, report({ outcome: "dissolved", kind: "already_fixed", into: "0284f66990" }, "Fee-answer cluster is already fixed by the Oct 6 fee policy; resolved with a tracked replay eval as the guard.")),
    dissolveRun("d2", T0 + 4 * HOUR, report({ outcome: "dissolved", kind: "in_flight", into: "xp-12 (card sd-421)" }, "The pending rule rewrite xp-12 already covers them.")),
    dissolveRun("d1", T0, report({ outcome: "dissolved", kind: "in_flight", into: "xp-12 (decision sd-421)" }, "The open rewrite xp-12 already owns the fix.")),
  ];
  const series: OccurrenceRow = { ...occurrences, observed: [T0 - DAY, T0 + DAY, T0 + DAY + HOUR, T0 + 2 * DAY], reopened: [] };
  const m = buildLineModel(rows({ runs, decisions: [], occurrences: [series], deploys: [] }), "agentwatch");
  const h = m.issues.find((i) => i.id === "t1")!.history;
  const brief = historyBrief(h);

  test("what came back is said once, for the run of closes, not once per attempt", () => {
    expect(brief.match(/Came back/g)).toHaveLength(1);
    expect(brief).toContain("Came back 3x after attempts 1 to 3 dissolved it, on");
    expect(closesSummary(h)).toMatch(/^Dissolved 3x as no fix needed, all on \w+ \d+; it came back 3x after the latest\.$/);
  });

  test("the argument every close made is named, with who it said owns the fix, and spent", () => {
    const line = "All 3 closes argued the fix is owned elsewhere (xp-12, the Oct 6 fee policy); it kept happening, so that argument is spent.";
    expect(closesArgument(h)).toBe(line);
    expect(brief.endsWith(line)).toBe(true);
  });

  test("the eval a close named as its guard reads as never shipped, on the brief and on the decision", () => {
    expect(brief).toContain("any eval or guard it mentions was never shipped");
    const d3 = m.steps.dissolve.decisions.find((d) => d.runId === "d3")!;
    expect(findingNeverShipped(d3, decisionSaid(d3))).toBe(true);
    const d1 = m.steps.dissolve.decisions.find((d) => d.runId === "d1")!;
    expect(findingNeverShipped(d1, decisionSaid(d1))).toBe(false);
  });
});
