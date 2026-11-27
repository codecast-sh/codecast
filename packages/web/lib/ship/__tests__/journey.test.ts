import { describe, expect, test } from "bun:test";
import { canAnswer, deployHold, insideWords, journeyOf, journeyStages, targetsFromLine, verdictsOf } from "../journey";
import { gateWaitWords, whoWords, journeyWords, readableWhy, sentBackWords, waitWords } from "../journeyWords";
import { approvalOf, approvalWords, shipConfirms } from "../approval";
import { landedSha } from "../runRecord";
import { sessionAskOf } from "../sessionAsk";
import { BRANCHING_FLOW, FANOUT_FLOW, LAND_ASKS, LAND_FLOW, LAND_REPO_FLOW, UNION_CHANGE_FLOW, UNION_FLAT_RUN, UNION_FLAT_SHA } from "../journeyFixtures";
import { appPool, flowBySlug, pushedFlow } from "../../line/flowPool";
import { SHIPPED_FLOWS } from "../../line/shippedFlows.generated";
import { GALLERY_FLOW, renderGalleryRecords } from "../../renderGallery";
// The library change flow, parsed with its segments expanded (bun packages/cli/scripts/gen-change-graph-fixture.ts).
import graph from "./changeGraph.fixture.json";

// Node statuses as the runner reports them (runner.ts): one entry per node, its latest visit, entered at `t`. A fan-out
// branch's own report carries no output, so CI keeps the last progress line the CI station posted and Review keeps
// nothing; Verdicts reports the round's verdicts as its output; a stopped run's current node is the exit it stopped at.
const change = graph as any;
const branching = pushedFlow({ _id: "wf_branching", ...BRANCHING_FLOW });
const run = (over: Record<string, unknown>) => ({ status: "running", node_statuses: [], ...over }) as any;
const st = (node_id: string, status: string, t = 1, extra: Record<string, unknown> = {}) => ({ node_id, status, started_at: t, ...extra });
const done = (...ids: string[]) => ids.map((id) => st(id, "completed"));
const age = (ms: number) => `${Math.round(ms / 60_000)}m`;
const ME = "u1";
const card = (over: Record<string, unknown> = {}) => ({ user_id: ME, holder: { kind: "user" as const, id: ME }, asked_user_ids: [ME], ...over });
const CI_LAST = "Waiting on CI for #12 at abc1234: a second look before calling it green, 9m";
const ROUND = [st("pr", "completed", 1, { visits: 1 }), st("checks", "completed", 2), st("ci", "completed", 2, { result_preview: CI_LAST }), st("review", "completed", 10), st("joined", "completed", 12)];
const verdicts = (next: string, ci: string, review: string, t = 13) => st("verdicts", "completed", t, { visits: 1, result_preview: JSON.stringify({ next, ci, review, why: "x" }) });
const GREEN = [...ROUND, verdicts("merge", "green", "ship")];
const MERGED = [...GREEN, st("merge", "completed", 14, { result_preview: '{"sha":"4a6e413b2c","pr":12}' }), st("landed", "completed", 15, { result_preview: "4a6e413b2c" }), st("deploy", "completed", 15)];
const states = (j: { stages: Array<{ label: string; state: string }> }) => j.stages.map((s) => `${s.label}:${s.state}`);

/** The change graph a run carries in a repository that ships straight to main: its start decided (cli startFacts.ts),
 *  so only what the direct edge reaches. */
function directCut(g: { nodes: Array<{ id: string }>; edges: Array<{ from: string; to: string; condition?: string }> }) {
  const edges = g.edges.filter((e) => e.from !== "start" || e.to === "direct_check");
  const kept = new Set(["start"]);
  for (let f = ["start"]; f.length; ) {
    f = edges.filter((e) => f.includes(e.from) && !kept.has(e.to)).map((e) => e.to);
    f.forEach((id) => kept.add(id));
  }
  return { ...g, nodes: g.nodes.filter((n) => kept.has(n.id)), edges: edges.filter((e) => kept.has(e.from) && kept.has(e.to)) };
}

describe("journeyStages", () => {
  test("a direct repository's change reads check, review, land, deploy: no PR, no CI, no Merge, and no card", () => {
    const s = journeyStages(directCut(change) as any);
    expect(s.map((x) => x.label)).toEqual(["Check", "Review", "Land", "Deploy", "Live"]);
    expect(s.map((x) => x.role)).toEqual(["step", "step", "land", "deploy", "live"]);
    expect(s.map((x) => x.who)).toEqual(["auto", "agent", "auto", "auto", "auto"]);
    expect(s[0].loops.map((l) => l.id)).toEqual(["direct_fix"]);
    expect(s[1].loops.map((l) => l.id)).toEqual(["direct_revise"]);
    expect(s[2].loops.map((l) => l.id)).toEqual(["direct_conflict", "direct_ci_red"]);
    expect(approvalOf(directCut(change) as any).kind).toBe("never");
  });

  test("the change flow reads in execution order, its fan-out one stage holding CI and Review", () => {
    const s = journeyStages(change);
    // Verdicts and Merged are bookkeeping (scripts bounded to a minute): CI + Review holds its verdicts, Merge the sha it merged.
    expect(s.map((x) => x.label)).toEqual(["PR", "CI + Review", "Merge", "Deploy", "Live"]);
    expect(s.map((x) => x.role)).toEqual(["step", "parallel", "land", "deploy", "live"]);
    expect(s.map((x) => x.who)).toEqual(["auto", "agent", "auto", "auto", "auto"]);
    expect(s[1].branches!.map((b) => [b.label, b.who])).toEqual([["CI", "auto"], ["Review", "agent"]]);
    expect(s[1].loops).toEqual([{ id: "ci_conflict", label: "Resolve conflict", max: 3 }, { id: "brief", label: "Fix findings", max: 3 }]);
    expect(s[2].loops.map((l) => l.id)).toEqual(["fix_conflict"]);
    expect(approvalOf(change)).toEqual({ kind: "if", when: "it edits CI" });
  });
  test("a branching flow reads in the order a passing run takes it, Decide before Land", () => {
    const s = journeyStages(branching);
    expect(s.map((x) => x.label)).toEqual(["Check", "Review", "Founder intent", "Land without asking?", "Why a person", "Decide", "Land", "Deploy", "Live"]);
    expect(s.find((x) => x.id === "ship")!.role).toBe("land");
    expect(approvalOf(branching)).toEqual({ kind: "always" });
  });
  test("the hand-written fan-out flow the gallery draws reads as the library's does", () => {
    expect(journeyStages(pushedFlow({ _id: "wf_fan", ...FANOUT_FLOW })).map((x) => [x.label, x.role, x.who])).toEqual(journeyStages(change).map((x) => [x.label, x.role, x.who]));
  });
  test("with no landing step and no Deploy, no stage claims to land and the flow ends where it ends", () => {
    const g = {
      nodes: [{ id: "start", label: "start", type: "start" }, { id: "check", label: "Check", type: "command" }, { id: "fix", label: "Fix", type: "agent", backend: "subject" }, { id: "build", label: "Build", type: "command" }, { id: "publish", label: "Publish", type: "command" }, { id: "gone", label: "Failed", type: "exit", stop: "x" }, { id: "exit", label: "Done", type: "exit" }],
      edges: [{ from: "start", to: "check" }, { from: "check", to: "build", condition: "outcome = success" }, { from: "check", to: "fix", condition: "outcome = failure" }, { from: "fix", to: "check" }, { from: "build", to: "publish" }, { from: "publish", to: "exit", condition: "outcome = success" }, { from: "publish", to: "gone", condition: "outcome = failure" }],
    } as any;
    expect(journeyStages(g).map((x) => [x.label, x.role])).toEqual([["Check", "step"], ["Build", "step"], ["Publish", "step"]]);
    expect(journeyWords(journeyOf(g, run({ current_node_id: "publish", node_statuses: [...done("check", "build"), st("publish", "running", 3)] }))).words).toBe("Publish");
    // A finished run of a flow that lands nothing is done, never "Not merged".
    expect(journeyWords(journeyOf(g, run({ status: "completed", current_node_id: "exit", node_statuses: done("check", "build", "publish") })))).toEqual({ words: "Done", tone: "ok" });
  });
  test("a fan-out branch longer than one station keeps every station, and Merge and Deploy after the join", () => {
    const g = {
      nodes: [
        { id: "start", label: "start", type: "start" }, { id: "fan", label: "Checks", type: "parallel_fanout" },
        { id: "build", label: "Build", type: "command" }, { id: "test", label: "Test", type: "command" }, { id: "lint", label: "Lint", type: "command" }, { id: "docs", label: "Docs", type: "command" },
        { id: "join", label: "Join", type: "parallel_fanin" }, { id: "merge", label: "Merge", type: "command" }, { id: "landed", label: "Merged", type: "command" },
        { id: "deploy", label: "Deploy", type: "conditional", segment_flow: "deploy", segment_entry: true }, { id: "deploy__wait", label: "Go live", type: "command", segment: "deploy" }, { id: "exit", label: "Live", type: "exit" },
      ],
      edges: [{ from: "start", to: "fan" }, { from: "fan", to: "build" }, { from: "fan", to: "lint" }, { from: "build", to: "test" }, { from: "test", to: "join" }, { from: "lint", to: "docs" }, { from: "docs", to: "join" }, { from: "join", to: "merge" }, { from: "merge", to: "landed" }, { from: "landed", to: "deploy" }, { from: "deploy", to: "deploy__wait" }, { from: "deploy__wait", to: "exit" }],
    } as any;
    const s = journeyStages(g);
    expect(s.map((x) => x.label)).toEqual(["Build → Test + Lint → Docs", "Merge", "Merged", "Deploy", "Live"]);
    expect(s[0].branches!.map((b) => b.label)).toEqual(["Build → Test", "Lint → Docs"]);
    const j = journeyOf(g, run({ current_node_id: "test", node_statuses: [...done("fan", "build", "lint", "docs"), st("test", "running", 3)] }));
    expect(j.stages[0].branches!.map((b) => b.state)).toEqual(["active", "idle"]);
  });
  test("a way back to the session through a side step on no stage is the loop of the stage it leaves", () => {
    const g = {
      nodes: [
        { id: "start", label: "start", type: "start" }, { id: "pr", label: "PR", type: "command" }, { id: "checks", label: "Checks", type: "parallel_fanout" },
        { id: "ci", label: "CI", type: "command" }, { id: "review", label: "Review", type: "agent", backend: "session" }, { id: "joined", label: "Both done", type: "parallel_fanin" },
        { id: "brief", label: "Brief", type: "command" }, { id: "fix", label: "Fix findings", type: "agent", backend: "subject", max_visits: 3 },
        { id: "merge", label: "Merge", type: "command" }, { id: "deploy", label: "Deploy", type: "command" }, { id: "exit", label: "Live", type: "exit" },
      ],
      edges: [
        { from: "start", to: "pr" }, { from: "pr", to: "checks" }, { from: "checks", to: "ci" }, { from: "checks", to: "review" }, { from: "ci", to: "joined" }, { from: "review", to: "joined" },
        { from: "joined", to: "merge", condition: "outcome = success" }, { from: "joined", to: "brief", condition: "outcome = failure" }, { from: "brief", to: "fix" }, { from: "fix", to: "pr" },
        { from: "merge", to: "deploy" }, { from: "deploy", to: "exit" },
      ],
    } as any;
    const s = journeyStages(g);
    expect(s.map((x) => x.label)).toEqual(["PR", "CI + Review", "Merge", "Deploy", "Live"]);
    expect(s[1].loops).toEqual([{ id: "fix", label: "Fix findings", max: 3 }]);
    expect(s.filter((x) => x.loops.length).map((x) => x.label)).toEqual(["CI + Review"]);
    const j = journeyOf(g, run({ current_node_id: "fix", waiting_on_session: { node_id: "fix", since: 20, note: "CI red" }, node_statuses: [...done("pr", "checks", "ci", "review", "joined", "brief"), st("fix", "running", 20, { visits: 2 })] }));
    expect(j.stages[1].state).toBe("back");
    expect(j.now).toMatchObject({ kind: "session", stage: "CI + Review", round: 2, max: 3 });
    expect(journeyWords(j).words).toBe("Fixing");
    // The session pinned blocked at that station: the run waits for a person, its pin the note.
    const asks = journeyOf(g, run({ current_node_id: "fix", waiting_on_session: { node_id: "fix", since: 30, note: "CI cannot start: GitHub billing stopped the runners", blocked: true }, node_statuses: [...done("pr", "checks", "ci", "review", "joined", "brief"), st("fix", "running", 20, { visits: 2 })] }));
    expect(asks.now).toMatchObject({ kind: "session", blocked: true, note: "CI cannot start: GitHub billing stopped the runners", since: 30 });
    expect(journeyWords(asks)).toEqual({ words: "Waiting for a person", tone: "wait" });
    expect(sentBackWords(asks.now as any)).toBe("Waiting for a person");
  });
  test("a session that asks a person with a card: the run waits on that card, the viewer's own reads Waiting on you (ct-99051)", () => {
    const g = change;
    const asking = (over: Record<string, unknown> = {}) => run({ current_node_id: "brief", waiting_on_session: { node_id: "brief", conversation_id: "conv1", since: 30, note: "Waiting for Jason: keep the old flag?", blocked: true }, node_statuses: [...ROUND, verdicts("brief", "green", "changes"), st("brief", "running", 20, { visits: 1 })], ...over });
    const ask = { id: "d1", short_id: "sd-7", question: "Keep the old flag?", mine: true, open: true };
    // The viewer may answer it: "Waiting on you", the question, the card to answer; never a stop and never Ship again.
    const mine = journeyOf(g, asking(), [], { id: ME, ask });
    expect(mine.now).toMatchObject({ kind: "session", blocked: true, ask, conversation: "conv1" });
    expect(journeyWords(mine)).toEqual({ words: "Waiting on you", tone: "you" });
    expect(sentBackWords(mine.now as any)).toBe("Waiting on you");
    // Somebody else answers it: the run waits for a person, the card still named.
    const theirs = journeyOf(g, asking(), [], { id: "u2", ask: { ...ask, mine: false } });
    expect(journeyWords(theirs)).toEqual({ words: "Waiting for a person", tone: "wait" });
    expect((theirs.now as any).ask).toMatchObject({ id: "d1", mine: false });
    // Answered: nobody waits on a person any more; the session goes on with the fix until its turn ends.
    const answered = journeyOf(g, asking(), [], { id: ME, ask: { ...ask, open: false } });
    expect(answered.now).toMatchObject({ kind: "session", blocked: false, ask: null });
    expect(journeyWords(answered)).toEqual({ words: "Fixing", tone: "session" });
    // The session is back at work (the runner clears `blocked`): an old answered card says nothing.
    const working = journeyOf(g, asking({ waiting_on_session: { node_id: "brief", conversation_id: "conv1", since: 30, note: "x" } }), [], { id: ME, ask });
    expect(working.now).toMatchObject({ kind: "session", blocked: false, ask: null });
    // A dismissed card is no answer (sessionAsk reads none): the run still waits for a person, its pin the note.
    const dismissed = journeyOf(g, asking(), [], { id: ME, ask: null });
    expect(dismissed.now).toMatchObject({ kind: "session", blocked: true, ask: null, note: "Waiting for Jason: keep the old flag?" });
    expect(journeyWords(dismissed)).toEqual({ words: "Waiting for a person", tone: "wait" });
    // A killed session's blocked pin ends the run: said in the past tense, by no station id, as is an older row's.
    const killed = journeyOf(g, asking({ status: "failed", fail_reason: "brief stopped: its session was killed while it waited on a person", waiting_on_session: null }));
    expect(killed.now).toMatchObject({ kind: "failed", why: "Its session was killed while it waited on a person" });
    const older = journeyOf(g, asking({ status: "failed", fail_reason: "fix_check is waiting on a person", waiting_on_session: null }));
    expect((older.now as any).why).toBe("Its session asked a person, and the run stopped");
    // Once the run ends, nothing claims an open wait, whatever the row still carries.
    for (const status of ["completed", "failed"]) {
      const ended = journeyOf(g, asking({ status, fail_reason: status === "failed" ? "Cancelled" : undefined }), [], { id: ME, ask });
      expect(ended.now.kind).not.toBe("session");
      expect(journeyWords(ended).words).not.toMatch(/Waiting/);
    }
  });
  test("among the shipped flows only change and personal go back to the session, from the stages they always did", () => {
    const read = (f: (typeof SHIPPED_FLOWS)[number]) => journeyStages(f as any).map((x) => (x.loops.length ? `${x.label} ↺ ${x.loops.map((l) => l.id).join(",")}` : x.label));
    const looping = SHIPPED_FLOWS.filter((f) => journeyStages(f as any).some((x) => x.loops.length));
    expect(Object.fromEntries(looping.map((f) => [f.slug, read(f)]))).toEqual({
      change: ["PR", "CI + Review ↺ ci_conflict,brief", "Merge ↺ fix_conflict", "Deploy", "Live"],
      personal: ["Check + Review ↺ fix_conflict,brief", "Land", "Deploy ↺ deploy_fix", "Live"],
    });
  });
});

describe("the fan-out and its verdicts", () => {
  test("CI and Review side by side: running branches wait, with CI's progress line, its age and deadline", () => {
    const j = journeyOf(change, run({ current_node_id: "checks", node_statuses: [st("pr", "completed", 1), st("checks", "running", 2), st("ci", "running", 1_000, { result_preview: "Waiting on CI for #12 at abc1234: 9 of 14 jobs done, 7m" }), st("review", "running", 2)] }));
    expect(j.stages[1].branches!.map((b) => [b.label, b.state])).toEqual([["CI", "active"], ["Review", "active"]]);
    expect(journeyWords(j)).toEqual({ words: "In CI and review", tone: "agent" });
    const ci = (j.now as any).waits[0];
    expect(ci).toMatchObject({ on: "CI", since: 1_000, deadline: 1_000 + 5_400_000 });
    expect(waitWords(ci, 1_000 + 7 * 60_000, age)).toBe("CI · Waiting on CI for #12 at abc1234: 9 of 14 jobs done, 7m · 7m · due in 83m");
  });
  test("a branch that finished reads no check until Verdicts has spoken this round", () => {
    const j = journeyOf(change, run({ current_node_id: "checks", node_statuses: [st("pr", "completed", 1), st("checks", "running", 2), st("ci", "completed", 2, { result_preview: CI_LAST }), st("review", "running", 2)] }));
    expect(j.stages[1].branches!.map((b) => b.state)).toEqual(["idle", "active"]);
    expect(journeyWords(j).words).toBe("In review");
  });
  test("a red CI and changes asked are send-backs, from Verdicts' output, not the branches' exits", () => {
    const j = journeyOf(change, run({ current_node_id: "brief", waiting_on_session: { node_id: "brief", since: 20, note: "CI red; changes asked" }, node_statuses: [...ROUND, verdicts("brief", "red", "changes"), st("brief", "running", 20, { visits: 1 })] }));
    expect(j.stages[1].branches!.map((b) => [b.label, b.state])).toEqual([["CI", "back"], ["Review", "back"]]);
    expect(j.stages[1].state).toBe("back");
    expect(j.now).toMatchObject({ kind: "session", stage: "CI + Review", round: 1, max: 3 });
    expect(journeyWords(j).words).toBe("Fixing");
    // Only CI red: the reviewer's ship is a check.
    const ciOnly = journeyOf(change, run({ current_node_id: "brief", waiting_on_session: { node_id: "brief", since: 20, note: "CI red" }, node_statuses: [...ROUND, verdicts("brief", "red", "ship"), st("brief", "running", 20)] }));
    expect(ciOnly.stages[1].branches!.map((b) => b.state)).toEqual(["back", "done"]);
  });
  test("the round the card shows is the one the cap counts: a brief that asks for no code change leaves it where it was", () => {
    // The runner reports Fix findings' visits without the free ones (change.cast free_visit), as the cap counts them.
    const at = (visits: number) => journeyOf(change, run({ current_node_id: "brief", waiting_on_session: { node_id: "brief", since: 20, note: "no verdict" }, node_statuses: [...ROUND, verdicts("brief", "green", "missing"), st("brief", "running", 20, { visits })] })).now;
    expect(at(0)).toMatchObject({ kind: "session", round: null, max: 3 });
    expect(at(1)).toMatchObject({ kind: "session", round: 1, max: 3 });
  });
  test("a round that kept the reviewer's ship shows Review passed while CI runs, not a reviewer yet to start", () => {
    // Round 1 reviewed and went back; round 2's PR carried the ship (pr.json `reviewed`), so only CI runs.
    const kept = '{"url":"u","number":12,"head_sha":"abc1234","branch":"feat","round":"r2","reviewed":{"verdict":"ship","head_sha":"abc1234"}}';
    const round2 = [st("pr", "completed", 30, { visits: 2, result_preview: kept }), st("checks", "running", 31), st("ci", "running", 31, { result_preview: CI_LAST }), st("review", "completed", 10), st("joined", "completed", 12), verdicts("brief", "red", "ship")];
    const j = journeyOf(change, run({ current_node_id: "checks", node_statuses: round2 }));
    expect(j.stages[1].branches!.map((b) => [b.label, b.state])).toEqual([["CI", "active"], ["Review", "done"]]);
    // Without the carried ship the same statuses read as a review not yet run this round.
    const fresh = round2.map((n) => (n.node_id === "pr" ? { ...n, result_preview: kept.replace(/,"reviewed".*\}$/, "}") } : n));
    expect(journeyOf(change, run({ current_node_id: "checks", node_statuses: fresh })).stages[1].branches![1].state).toBe("idle");
  });
  test("a CI held by main's red waits for main, and the run reads as its wait", () => {
    const j = journeyOf(change, run({ current_node_id: "wait_main", node_statuses: [...ROUND, verdicts("wait_main", "blocked_by_main", "ship"), st("wait_main", "running", 22, { visits: 1, result_preview: "Main CI is red at 9f8e7d6 (red since 1a2b3c4): test-web; looking again in 60s" })] }));
    expect(j.stages[1].branches!.map((b) => [b.label, b.state])).toEqual([["CI", "waiting"], ["Review", "done"]]);
    expect(j.stages[1].state).toBe("active");
    expect(journeyWords(j).words).toBe("Wait for green main");
    expect(j.now).toMatchObject({ kind: "working", stage: "Wait for green main", waits: [{ on: "Wait for green main", since: 22, deadline: 22 + 15_000_000 }] });
  });
  test("round 2 at PR shows nothing after it from round 1", () => {
    const j = journeyOf(change, run({ current_node_id: "pr", node_statuses: [...ROUND.slice(1), verdicts("brief", "red", "changes"), st("brief", "completed", 20), st("pr", "running", 40, { visits: 2 })] }));
    expect(states(j)).toEqual(["PR:active", "CI + Review:idle", "Merge:idle", "Deploy:idle", "Live:idle"]);
  });
  test("a run at Verdicts reads as CI + Review, and one at Merged as Merge", () => {
    const atVerdicts = journeyOf(change, run({ current_node_id: "verdicts", node_statuses: [...ROUND, st("verdicts", "running", 13)] }));
    expect(states(atVerdicts)).toEqual(["PR:done", "CI + Review:active", "Merge:idle", "Deploy:idle", "Live:idle"]);
    expect(atVerdicts.now).toMatchObject({ kind: "working", stage: "CI + Review", waits: [{ on: "CI", since: 13 }, { on: "Review", since: 13 }] });
    expect(journeyWords(atVerdicts)).toEqual({ words: "In CI and review", tone: "agent" });
    // Paused there, it waits, as any other stage does.
    const paused = journeyOf(change, run({ status: "paused", current_node_id: "verdicts", node_statuses: [...ROUND, st("verdicts", "running", 13)] }));
    expect(states(paused)).toEqual(["PR:done", "CI + Review:waiting", "Merge:idle", "Deploy:idle", "Live:idle"]);
    const atMerged = journeyOf(change, run({ current_node_id: "landed", merge: { sha: "4a6e413b2c" }, node_statuses: [...GREEN, st("merge", "completed", 14), st("landed", "running", 15)] }));
    expect(states(atMerged)).toEqual(["PR:done", "CI + Review:done", "Merge:active", "Deploy:idle", "Live:idle"]);
    expect(atMerged.now).toMatchObject({ kind: "working", stage: "Merge", verb: "Merging" });
  });
  test("a stop at Merged after the merge was recorded: Merge landed, and the stop is before Deploy", () => {
    const j = journeyOf(change, run({ status: "failed", current_node_id: "landed", merge: { sha: "4a6e413b2c" }, fail_reason: "Stopped: the runner died", node_statuses: [...GREEN, st("merge", "completed", 14), st("landed", "failed", 15)] }));
    expect(states(j)).toEqual(["PR:done", "CI + Review:done", "Merge:done", "Deploy:stopped", "Live:idle"]);
    expect(j.now).toMatchObject({ kind: "stopped", stage: "Deploy", fix: "deploy" });
    // With no merge recorded, the stop is Merge's.
    const unmerged = journeyOf(change, run({ status: "failed", current_node_id: "landed", fail_reason: "Stopped: the runner died", node_statuses: [...GREEN, st("merge", "completed", 14), st("landed", "failed", 15)] }));
    expect(states(unmerged)).toEqual(["PR:done", "CI + Review:done", "Merge:stopped", "Deploy:idle", "Live:idle"]);
  });
  test("round 2 in the fan-out ignores round 1's verdicts", () => {
    const j = journeyOf(change, run({ current_node_id: "checks", node_statuses: [verdicts("brief", "red", "changes"), st("brief", "completed", 20), st("pr", "completed", 40, { visits: 2 }), st("checks", "running", 41), st("ci", "running", 41, { result_preview: "Waiting on CI for #12 at def5678: 1 of 9 jobs done, 1m" }), st("review", "completed", 10)] }));
    expect(j.stages[1].branches!.map((b) => b.state)).toEqual(["active", "idle"]);
  });
  test("a review pinned for an older head is a send-back on Review", () => {
    const j = journeyOf(change, run({ current_node_id: "brief", waiting_on_session: { node_id: "brief", since: 20, note: "review was for an older head" }, node_statuses: [...ROUND, verdicts("brief", "green", "stale"), st("brief", "running", 20)] }));
    expect(j.stages[1].branches!.map((b) => b.state)).toEqual(["done", "back"]);
  });
  test("verdictsOf reads the words and the older objects, defensively", () => {
    expect(verdictsOf('{"next":"brief","ci":"red","review":"changes","why":"x"}')).toEqual({ ci: "red", review: "changes" });
    expect(verdictsOf('{"next":"wait_main","why":"x","ci":{"green":false,"blocked_by_main":true},"review":{"verdict":"ship"}}')).toEqual({ ci: "blocked_by_main", review: "ship" });
    expect(verdictsOf('{"next":"merge","ci":{"green":true},"review":{"verdict":"ship","findings":[')).toEqual({ ci: "green", review: "ship" });
    expect(verdictsOf('{"green": false}')).toBeNull();
    expect(verdictsOf(CI_LAST)).toBeNull();
  });
});

describe("words for each station", () => {
  test("Opening PR, Merging, and an off-path station reads as itself inside the stage it came from", () => {
    expect(journeyWords(journeyOf(change, run({ current_node_id: "pr", node_statuses: [st("pr", "running")] }))).words).toBe("Opening PR");
    expect(journeyWords(journeyOf(change, run({ current_node_id: "merge", node_statuses: [...GREEN, st("merge", "running", 14)] }))).words).toBe("Merging");
    const retest = journeyOf(change, run({ current_node_id: "retest", node_statuses: [...GREEN, st("merge", "failed", 14), st("retest", "running", 15)] }));
    expect(journeyWords(retest).words).toBe("Retest");
    expect(retest.stages.find((s) => s.label === "Merge")!.state).toBe("active");
  });
});

describe("gates", () => {
  const gated = (graph: any, statuses: unknown[], node: string, decision: unknown) => journeyOf(graph, run({ status: "paused", user_id: ME, current_node_id: node, gate_node_id: node, gate_decision_id: "d1", gate_prompt: "Ship ct-1? It edits CI.\nmore", gate_decision_status: "pending", node_statuses: statuses }), [], { id: ME, decision: decision as any });
  const CI_CARD = [...ROUND, verdicts("decide", "green", "ship"), st("ci_card", "completed", 14, { result_preview: "This change edits CI, so CI can't vouch for it" }), st("decide", "completed", 15), st("decide__decide", "running", 15)];
  test("a card off the main path is a gate: on the stage the walk back finds, named by its own step", () => {
    const mine = gated(change, CI_CARD, "decide__decide", card());
    expect(mine.now).toMatchObject({ kind: "gate", stage: "Decide", mine: true, decisionId: "d1", prompt: "Ship ct-1? It edits CI.", since: 15 });
    // The stage that holds it (CI + Review, whose verdicts sent the run there) is named after the route into the card.
    expect(mine.stages[1]).toMatchObject({ id: "checks", label: "It edits CI", state: "waiting", who: "you" });
    expect(journeyWords(mine)).toEqual({ words: "Your call", tone: "you" });
    const theirs = gated(change, CI_CARD, "decide__decide", card({ holder: { kind: "user", id: "u2" }, asked_user_ids: ["u2"] }));
    expect(theirs.stages[1]).toMatchObject({ label: "It edits CI", who: "person" });
    expect(journeyWords(theirs)).toEqual({ words: "Waiting for approval", tone: "wait" });
    expect(journeyWords(gated(change, CI_CARD, "decide__decide", null)).words).toBe("Waiting for approval");
  });
  test("a Revise from that card was sent back by the person, not by Verdicts", () => {
    const j = journeyOf(change, run({ current_node_id: "brief", waiting_on_session: { node_id: "brief", since: 20, note: "Revise: say why CI changed" }, node_statuses: [...CI_CARD.slice(0, -1), st("decide__decide", "completed", 15), st("decide__revise", "completed", 18), st("brief", "running", 20)] }));
    expect(j.now).toMatchObject({ kind: "session", by: "the person" });
    expect(sentBackWords(j.now as any)).toBe("Sent back by the person");
    const verdictsSent = journeyOf(change, run({ current_node_id: "brief", waiting_on_session: { node_id: "brief", since: 20, note: "CI red" }, node_statuses: [...ROUND, verdicts("brief", "red", "ship"), st("brief", "running", 20)] }));
    expect(sentBackWords(verdictsSent.now as any)).toBe("CI + Review sent it back");
  });
  test("a card no stage holds still asks in the bar", () => {
    const g = { nodes: [{ id: "start", label: "start", type: "start" }, { id: "ask", label: "Ask Jason", type: "human" }, { id: "exit", label: "Done", type: "exit" }], edges: [{ from: "start", to: "ask" }, { from: "ask", to: "exit" }] } as any;
    const j = journeyOf(g, run({ status: "paused", current_node_id: "elsewhere", gate_node_id: "elsewhere", gate_decision_id: "d9" }), [], { id: ME, decision: card() });
    expect(j.now).toMatchObject({ kind: "gate", mine: true, decisionId: "d9" });
  });
  describe("on a branching flow's main path", () => {
    const paused = (decision: unknown) => gated(branching, [...done("check__verify", "review__review", "intent"), st("intent_gate", "failed", 2), st("ask", "completed", 3), st("decide__decide", "running", 4)], "decide__decide", decision);
    test("a script that exits non-zero to ask a person is a route, never a red stop", () => {
      expect(states(paused(card()))).toEqual(["Check:done", "Review:done", "Founder intent:done", "Land without asking?:routed", "Why a person:done", "Decide:waiting", "Land:idle", "Deploy:idle", "Live:idle"]);
    });
    test("You only when the viewer may answer the card", () => {
      expect(paused(card()).stages[5]).toMatchObject({ state: "waiting", who: "you" });
      expect(journeyWords(paused(card({ holder: { kind: "user", id: "u0" }, asked_user_ids: ["u0", ME] }))).words).toBe("Your call");
      expect(journeyWords(paused(card({ holder: { kind: "role", id: "r1" } })))).toEqual({ words: "Waiting for approval", tone: "wait" });
      expect(journeyWords(paused(card({ passed_to: { kind: "user", id: "u2" } }))).words).toBe("Waiting for approval");
      expect(paused(null).stages.some((s) => s.who === "you")).toBe(false);
    });
  });
  test("canAnswer follows holder, asked people and a pass", () => {
    expect(canAnswer(card(), ME)).toBe(true);
    expect(canAnswer({ user_id: ME }, ME)).toBe(true);
    expect(canAnswer({ user_id: "u0", asked_user_ids: ["u0"] }, ME)).toBe(false);
    expect(canAnswer(card({ holder: { kind: "role", id: "r1" } }), ME)).toBe(false);
    expect(canAnswer(card({ passed_to: { kind: "user", id: ME } }), ME)).toBe(true);
    expect(canAnswer(card(), null)).toBe(false);
  });
});

describe("stops", () => {
  const stop = (graph: any, exit: string, fail_reason: string, statuses: unknown[]) => journeyOf(graph, run({ status: "failed", current_node_id: exit, fail_reason, spawner_conversation_id: "c1", node_statuses: [...statuses, st(exit, "failed", 99)] }));
  // An exit straight off a stage reads as that stage; one reached through steps off the main path reads as itself.
  test.each([
    ["unshipped", "Stopped: gh pr merge refused: required status check 'test-web' is failing", [...GREEN, st("merge", "failed", 14)], "Merge", "run", "Stopped at Merge"],
    ["moving", "Stopped: Main keeps moving under this change", [...GREEN, st("merge", "failed", 14)], "Merge", "run", "Stopped at Merge"],
    ["lost", "Stopped: the pull request is gone", [...GREEN, st("merge", "failed", 14), st("retest", "failed", 15)], "Merge", "run", "Stopped: pull request lost"],
    ["mainred", "Stopped: Main CI stayed red for 4h (red since 1a2b3c4), at 9f8e7d6: test-web.", [...ROUND, verdicts("wait_main", "blocked_by_main", "ship"), st("wait_main", "failed", 22)], "CI + Review", "run", "Stopped: main stayed red"],
    ["unrebased", "Stopped: the branch does not rebase onto main", [...ROUND, verdicts("wait_main", "blocked_by_main", "ship"), st("wait_main", "completed", 22), st("onto_main", "failed", 30)], "CI + Review", "run", "Stopped: not onto main"],
    ["dropped", "Stopped: Dropped at the gate.", [...ROUND, verdicts("decide", "green", "ship"), st("ci_card", "completed", 14), st("decide", "completed", 15), st("decide__decide", "completed", 15), st("decide__revise", "failed", 16)], "CI + Review", "run", "Stopped: dropped"],
    ["rejected", "Stopped: The reviewer rejected the change: wrong approach", [...ROUND, verdicts("rejected", "green", "rejected")], "CI + Review", "run", "Stopped at CI + Review"],
    ["mainred_again", "Stopped: Main CI went red under this change again", [...ROUND, verdicts("wait_main", "blocked_by_main", "ship")], "CI + Review", "run", "Stopped at CI + Review"],
    ["nobody", "Stopped: This change edits CI, and no session is behind the run", [...ROUND, verdicts("decide", "green", "ship")], "CI + Review", "run", "Stopped at CI + Review"],
    ["found", "Stopped: CI or the reviewer found work, and no session made this change", [...ROUND, verdicts("brief", "red", "ship")], "CI + Review", "run", "Stopped at CI + Review"],
    ["nopr", "Stopped: gh pr create failed", [st("pr", "failed", 1)], "PR", "run", "Stopped at PR"],
    ["noci", "Stopped: CI never reported on the pushed head", [...ROUND, verdicts("no_ci", "green", "ship")], "CI + Review", "again", "Stopped at CI + Review"],
  ] as const)("the %s exit stops at its stage with the action that can work", (exit, why, statuses, stage, fix, words) => {
    const j = stop(change, exit, why, [...statuses]);
    expect(j.now).toMatchObject({ kind: "stopped", stage, fix });
    expect(j.stages.find((s) => s.label === stage)!.state).toBe("stopped");
    expect(journeyWords(j).words).toBe(words);
  });
  test("a merge refusal draws Merge stopped and nothing else red", () => {
    const j = stop(change, "unshipped", "Stopped: merge guard refused", [...GREEN, st("merge", "failed", 14)]);
    expect(states(j)).toEqual(["PR:done", "CI + Review:done", "Merge:stopped", "Deploy:idle", "Live:idle"]);
  });
  test("main stayed red: CI + Review stops, and nothing went back to the session", () => {
    const j = stop(change, "mainred", "Stopped: Main CI stayed red for 4h", [...ROUND, verdicts("wait_main", "blocked_by_main", "ship"), st("wait_main", "failed", 22)]);
    expect(j.stages.find((s) => s.label === "CI + Review")!.who).not.toBe("session");
    expect(j.stages.some((s) => s.state === "back")).toBe(false);
  });
  test("Land's refusal two steps off the main path stops at Land and opens the run", () => {
    const j = stop(branching, "unshipped", "Stopped: The change was not shipped. merge guard refused: would undo main's changes", [...done("check__verify", "review__review", "intent", "intent_gate", "cleared"), st("ship__ship", "failed", 11), st("ship__unshipped", "completed", 12), st("unmerged", "failed", 13)]);
    expect(j.now).toMatchObject({ kind: "stopped", stage: "Land", fix: "run" });
    expect(j.stages.find((s) => s.id === "ship")!.state).toBe("stopped");
  });
  test("a session out of rounds stops at the stage that sent it back, and says when the brief went", () => {
    const j = journeyOf(change, run({ status: "failed", current_node_id: "brief", spawner_conversation_id: "c1", fail_reason: "Stopped: Verdicts sent the change back 3 times", node_statuses: [...ROUND, verdicts("brief", "red", "changes"), st("brief", "failed", 90, { visits: 4 })] }));
    expect(j.now).toMatchObject({ kind: "stopped", stage: "CI + Review", fix: "session", session: "c1", briefAt: 90 });
  });
  // ct-102369: the session, `cast workflow show` and this page each named a different restart for CI never reported.
  test("a stop that names its resume offers that resume, the restart the session and the CLI name too", () => {
    const why = "Stopped: CI never reported on the pushed head, also after running it again. The change is not at fault: resume this run at CI (`cast workflow resume ct-9 --at ci`) once GitHub runs CI on the pull request. What CI said: x";
    const j = journeyOf(change, run({ status: "failed", current_node_id: "noci", spawner_conversation_id: "c1", fail_reason: why, node_statuses: [...ROUND, verdicts("no_ci", "timed_out", "ship"), st("noci", "failed", 20)] }));
    expect(j.now).toMatchObject({ kind: "stopped", resume: { at: "ci", label: "CI" } });
  });
  test("a deploy that missed its deadline opens the deploy; a runner crash runs again", () => {
    expect(journeyOf(change, run({ status: "failed", current_node_id: "deploy__failed", merge: { sha: "4a6e413b2c" }, fail_reason: "Stopped: Deploy stuck: cli is not live with 4a6e413 after 45m.", node_statuses: [...MERGED, st("deploy__wait", "failed", 16)] })).now).toMatchObject({ stage: "Deploy", fix: "deploy" });
    expect(journeyOf(change, run({ status: "failed", current_node_id: "checks", fail_reason: "the runner was stopped (SIGINT) at checks", node_statuses: [st("pr", "completed", 1), st("checks", "failed", 2), st("ci", "running", 2), st("review", "running", 2)] })).now).toMatchObject({ kind: "failed", stage: "CI + Review", fix: "again" });
  });
});

describe("landed and deploying", () => {
  const atDeploy = (line: string, merge: unknown = { sha: "4a6e413b2c", at: 9 }) => journeyOf(change, run({ current_node_id: "deploy__wait", merge, node_statuses: [...MERGED, st("deploy__wait", "running", 16, { result_preview: line })] }));
  test("landed is a merge recorded on the run, else the sha a passing merge step reported, unless Deploy found it not on main", () => {
    expect(landedSha({ merge: { sha: "4a6e413b2c" } })).toBe("4a6e413b2c");
    expect(landedSha({ merge: null })).toBeNull();
    // No merge recorded (merged by its own script, an older CLI): the merge step's own report is the landing, as await-deploy reads it.
    expect(landedSha({ merge: null, node_statuses: MERGED })).toBe("4a6e413b2c");
    // Only a step that passed, and only its own "sha" (never the PR's head_sha).
    expect(landedSha({ node_statuses: [st("merge", "failed", 14, { result_preview: '{"sha":"4a6e413b2c"}' })] })).toBeNull();
    expect(landedSha({ node_statuses: [st("pr", "completed", 1, { result_preview: '{"pr":12,"head_sha":"361c9c1107"}' })] })).toBeNull();
    // Deploy then said the commit is not on main: the step's word is not the landing.
    expect(landedSha({ current_node_id: "deploy__unmerged", node_statuses: MERGED })).toBeNull();
    const printed = atDeploy("Waiting for change-x to land on main", null);
    expect(printed.now).toMatchObject({ kind: "landed", sha: "4a6e413b2c" });
    expect(printed.stages.find((s) => s.role === "land")!.state).toBe("done");
    // At Deploy with no sha anywhere: the wait, claiming neither way.
    const NO_SHA = [...GREEN, st("merge", "completed", 14), st("landed", "completed", 15), st("deploy", "completed", 15)];
    const silent = journeyOf(change, run({ current_node_id: "deploy__wait", node_statuses: [...NO_SHA, st("deploy__wait", "running", 16, { result_preview: "Waiting for change-x to land on main" })] }));
    expect(silent.now).toMatchObject({ kind: "working", stage: "Deploy", role: "deploy" });
    expect(silent.stages.find((s) => s.role === "land")!.state).toBe("routed");
    expect(journeyWords(silent)).toEqual({ words: "Deploy", tone: "working" });
    // Ended at Deploy with no merge on it: Not merged. Ended at an earlier stage: stopped there, as before.
    const unmerged = journeyOf(change, run({ status: "failed", current_node_id: "deploy__unmerged", fail_reason: "Stopped: Nothing was merged: the run has no merged commit, so nothing goes out.", node_statuses: [...MERGED, st("deploy__wait", "failed", 16)] }));
    expect(unmerged.now).toMatchObject({ kind: "unlanded" });
    expect(journeyWords(unmerged)).toEqual({ words: "Not merged", tone: "bad" });
    // Finished with no merge on it: done, never Not merged.
    expect(journeyOf(change, run({ status: "completed", current_node_id: "merge", node_statuses: NO_SHA })).now.kind).toBe("passed");
    // A run that completed at its end with nothing merged (its change already upstream) is Done, never Live.
    const upstream = journeyOf(change, run({ status: "completed", current_node_id: "exit", merge: null }));
    expect(upstream.now.kind).toBe("passed");
    expect(journeyWords(upstream)).toEqual({ words: "Done", tone: "ok" });
  });
  test("Deploying only while a deploy carries it; held on main CI or waiting for a person otherwise", () => {
    expect(journeyWords(atDeploy("backend: live in dp-12; cli: dp-13 sending 4a6e413 (6m of 60m); web: waiting for its push deploy to carry 4a6e413 (2m of 30m)"))).toEqual({ words: "Deploying", tone: "working" });
    // Held only when the line says main's CI is red; running, not there yet, or the auto target's ordinary wait is a wait.
    const held = atDeploy("web: live in dp-12; backend: waiting on main CI at 9f8e7d6 (red since 1a2b3c4: test-web; held 22m, then 45m)");
    expect(held.now).toMatchObject({ kind: "landed", hold: { kind: "red" }, waits: [{ on: "Deploy", since: 16, deadline: 16 + 90_900_000 }] });
    expect(journeyWords(held)).toEqual({ words: "Waiting for green main", tone: "wait" });
    expect(journeyWords(atDeploy("backend: waiting on main CI at 9f8e7d6 (running; held 2m, then 45m)"))).toEqual({ words: "Waiting on main CI", tone: "wait" });
    expect(journeyWords(atDeploy("backend: waiting on main CI at 9f8e7d6 (no CI yet; held 1m, then 45m)"))).toEqual({ words: "Waiting on main CI", tone: "wait" });
    expect(journeyWords(atDeploy("web: waiting for the server to send 4a6e413 once main CI is green (held 3m, then 30m)"))).toEqual({ words: "Waiting on main CI", tone: "wait" });
    // A named role says who it waits for; a press or a person says so plainly.
    expect(journeyWords(atDeploy("web: waiting for Release Captain to send it (held 3m, then 1d)"))).toEqual({ words: "Waiting for Release Captain to deploy", tone: "wait" });
    expect(journeyWords(atDeploy("web: waiting for @release-captain to send it (held 3m, then 1d)"))).toEqual({ words: "Waiting for @release-captain to deploy", tone: "wait" });
    expect(journeyWords(atDeploy("backend: waiting for a press on the Deploys page; web: waiting for its push deploy"))).toEqual({ words: "Waiting for a person to deploy", tone: "wait" });
    expect(journeyWords(atDeploy("web: waiting for its push deploy to carry 4a6e413 (2m of 30m)"))).toEqual({ words: "Waiting to deploy", tone: "wait" });
    expect(deployHold("4a6e413b2c landed; live on web dp-12, waiting for backend (going out in dp-13).").kind).toBe("out");
  });
  test("a run that ended at Live is live", () => {
    const j = journeyOf(change, run({ status: "completed", current_node_id: "exit", merge: { sha: "4a6e413b2c" }, node_statuses: [...MERGED, st("deploy__wait", "completed", 16, { result_preview: "Live: 4a6e413b2c on backend dp-12, web dp-14." }), st("deploy__live", "completed", 40)] }));
    expect(j.stages.every((s) => s.state === "done")).toBe(true);
    expect(j.now).toMatchObject({ kind: "live", line: "Live: 4a6e413b2c on backend dp-12, web dp-14." });
  });
  test("a flow with no Deploy of its own: a merged, finished run reads Merged, done", () => {
    const g = { nodes: [{ id: "start", label: "start", type: "start" }, { id: "check", label: "Check", type: "command" }, { id: "landed", label: "Land", type: "command" }, { id: "exit", label: "Done", type: "exit" }], edges: [{ from: "start", to: "check" }, { from: "check", to: "landed" }, { from: "landed", to: "exit" }] } as any;
    const j = journeyOf(g, run({ status: "completed", current_node_id: "exit", merge: { sha: "4a6e413b2c" }, node_statuses: done("check", "landed") }));
    expect(states(j)).toEqual(["Check:done", "Land:done"]);
    expect(j.now).toMatchObject({ kind: "merged", sha: "4a6e413b2c" });
    expect(journeyWords(j)).toEqual({ words: "Merged", tone: "ok" });
  });
  test("a finished run shows the stations it never entered as skipped", () => {
    const j = journeyOf(branching, run({ status: "completed", current_node_id: "exit", merge: { sha: "4a6e413b2c" }, node_statuses: done("check__verify", "review__review", "intent", "intent_gate", "cleared", "ship__ship", "ship__shipped", "deploy__wait", "deploy__live") }));
    expect(states(j)).toEqual(["Check:done", "Review:done", "Founder intent:done", "Land without asking?:done", "Why a person:skipped", "Decide:skipped", "Land:done", "Deploy:done", "Live:done"]);
  });
});

test("the shipped flows carry their stations' timeouts, so a library flow's waits have deadlines", () => {
  expect(SHIPPED_FLOWS.find((f) => f.slug === "change")!.nodes.some((n) => typeof n.timeout === "number")).toBe(true);
});

test("the render gallery's run cards read as the states they stand for", () => {
  const records = renderGalleryRecords(1_790_000_000_000, ME, "team:t1");
  const read = (id: string, decision: unknown = null) => {
    const r: any = records.workflowRuns.find((x: any) => x._id === id)!;
    const j = journeyOf(pushedFlow(records.workflows.find((w: any) => w._id === r.workflow_id) as any), r, [], { id: ME, decision: decision as any });
    return { kind: j.now.kind, words: journeyWords(j).words, states: j.stages.map((s) => s.state), branches: j.stages.find((s) => s.branches)?.branches?.map((b) => b.state) };
  };
  expect(read(GALLERY_FLOW.shipBack)).toMatchObject({ kind: "session", words: "Fixing", branches: ["back", "back"] });
  // The session asks the viewer with the gallery's open card in this conversation: the run waits on that answer.
  const asks: any = records.workflowRuns.find((x: any) => x._id === GALLERY_FLOW.shipAsks)!;
  const ask = sessionAskOf(records.sessionDecisions as any, asks.waiting_on_session, ME);
  expect(ask).toMatchObject({ question: "Ship the mobile renderer behind a flag?", mine: true, open: true });
  expect(journeyWords(journeyOf(pushedFlow(records.workflows.find((w: any) => w._id === asks.workflow_id) as any), asks, [], { id: ME, ask }))).toEqual({ words: "Waiting on you", tone: "you" });
  expect(read(GALLERY_FLOW.shipDecide, { user_id: "galleryuser0000000000002" })).toMatchObject({ kind: "gate", words: "Waiting for approval" });
  expect(read(GALLERY_FLOW.shipDeploy)).toMatchObject({ kind: "deploying", words: "Deploying" });
  expect(read(GALLERY_FLOW.shipHeld)).toMatchObject({ kind: "landed", words: "Waiting for green main" });
  expect(read(GALLERY_FLOW.shipLive)).toMatchObject({ kind: "live", words: "Live" });
  expect(read(GALLERY_FLOW.shipUnlanded)).toMatchObject({ kind: "working", words: "Deploy" });
  expect(read(GALLERY_FLOW.shipBranching, { user_id: ME })).toMatchObject({ kind: "gate", words: "Your call" });
  expect(read(GALLERY_FLOW.shipCleared)).toMatchObject({ kind: "live", states: ["done", "done", "done", "done", "skipped", "skipped", "done", "done", "done"] });
  expect(read(GALLERY_FLOW.shipCiCard, { user_id: ME })).toMatchObject({ kind: "gate", words: "Your call" });
  expect(read(GALLERY_FLOW.shipCiWait)).toMatchObject({ kind: "working", words: "In CI and review", branches: ["active", "active"] });
  expect(read(GALLERY_FLOW.shipMainRed)).toMatchObject({ kind: "working", words: "Wait for green main", branches: ["waiting", "done"] });
  expect(read(GALLERY_FLOW.shipRefused)).toMatchObject({ kind: "stopped", words: "Stopped at Merge", states: ["done", "done", "stopped", "idle", "idle"] });
});

test("targetsFromLine reads the Deploy stage's line, old and new", () => {
  expect(targetsFromLine("web: live in dp-12; backend: dp-13 sending 4a6e413 (6m of 60m); cli: waiting on main CI at 9f8e7d6 (red: test-cli; 6m of 45m)")).toEqual([
    { name: "web", state: "live", deploy: "dp-12" },
    { name: "backend", state: "deploying", deploy: "dp-13" },
    { name: "cli", state: "waiting" },
  ]);
  expect(targetsFromLine("scratch-e2e: waiting for its push deploy to carry 86402bc (2m of 30m)")).toEqual([{ name: "scratch-e2e", state: "waiting" }]);
  expect(targetsFromLine("Live: 4a6e413 on backend dp-13, web dp-12. desktop goes out on a press.")).toEqual([{ name: "backend", state: "live", deploy: "dp-13" }, { name: "web", state: "live", deploy: "dp-12" }]);
  expect(targetsFromLine("Sending backend, cli for 4a6e413.")).toEqual([]);
  expect(targetsFromLine("Deploy stuck: cli is not live with 4a6e413 after 45m (last: dp-13 sending 4a6e413).")).toEqual([]);
  expect(targetsFromLine("4a6e413b2c landed; live on web dp-12, waiting for backend, cli (going out in dp-13).")).toEqual([
    { name: "web", state: "live", deploy: "dp-12" },
    { name: "backend", state: "deploying", deploy: "dp-13" },
    { name: "cli", state: "deploying", deploy: "dp-13" },
  ]);
  expect(targetsFromLine("Waiting for codecast/change-ct-1 to land on main.")).toEqual([]);
});

test("readableWhy cuts long reasons at a word", () => {
  expect(readableWhy("a ".repeat(200))!.endsWith("…")).toBe(true);
});

describe("approvalOf", () => {
  test("each shipped line says from its graph whether a person approves", () => {
    const lines = SHIPPED_FLOWS.filter((f) => f.kind === "line").map((f) => [f.slug, approvalWords(approvalOf(f as any))]);
    expect(lines).toEqual([["line", "Asks you every time"], ["change", "Asks you if it edits CI"], ["personal", "No approval"], ["climb", "Sometimes asks you"]]);
  });
  test("a gate on a side route asks only on that route; one reached only past landing asks nobody", () => {
    const g = (turn: { label?: string }, gateAfterLand = false, asks_if?: string) => ({
      nodes: [{ id: "start", label: "start", type: "start" }, { id: "check", label: "Check", type: "command" }, { id: "why", label: "Why", type: "command" }, { id: "ask", label: "Ask", type: "human", ...(asks_if ? { asks_if } : {}) }, { id: "landed", label: "Merged", type: "command" }, { id: "exit", label: "Live", type: "exit" }],
      edges: gateAfterLand
        ? [{ from: "start", to: "check" }, { from: "check", to: "landed" }, { from: "landed", to: "exit", condition: "outcome = success" }, { from: "landed", to: "ask", condition: "outcome = failure", ...turn }, { from: "ask", to: "exit" }]
        : [{ from: "start", to: "check" }, { from: "check", to: "landed", condition: "outcome = success" }, { from: "check", to: "why", condition: "outcome = failure", ...turn }, { from: "why", to: "ask" }, { from: "ask", to: "landed" }, { from: "landed", to: "exit" }],
    }) as any;
    // The gate says what makes a run ask; the route's own label never stands in for it.
    expect(approvalOf(g({ label: "risky" }, false, "it touches billing"))).toEqual({ kind: "if", when: "it touches billing" });
    expect(approvalWords(approvalOf(g({ label: "risky" }, false, "it touches billing")))).toBe("Asks you if it touches billing");
    expect(approvalWords(approvalOf(g({ label: "risky" })))).toBe("Sometimes asks you");
    expect(approvalOf(g({ label: "risky" }, true))).toEqual({ kind: "never" });
  });
  // A change that lands through one segment: a card inside Land on a side route its merge turns onto, its route a plain
  // name with no asks_if, and a later deploy only when the deploy failed.
  const landsThroughSegment = () => {
    const seg = (id: string, label: string, type = "command") => ({ id: `land__${id}`, label, type, segment: "land" });
    return {
      nodes: [
        { id: "start", label: "start", type: "start" },
        { id: "land", label: "Land", type: "command", segment_entry: true, segment_flow: "land" }, seg("merge", "Merge"), seg("why", "Why a person"), seg("card", "Card", "human"), seg("landed", "Merged"),
        { id: "deploy", label: "Deploy", type: "conditional", segment_entry: true, segment_flow: "deploy" }, { id: "deploy__wait", label: "Go live", type: "command", segment: "deploy" },
        { id: "redeploy", label: "Wait for a later deploy", type: "command" },
        { id: "exit", label: "Live", type: "exit" }, { id: "never_live", label: "Never live", type: "exit", stop: "x" },
      ],
      edges: [
        { from: "start", to: "land" }, { from: "land", to: "land__merge" },
        { from: "land__merge", to: "land__landed", condition: "outcome = success" },
        { from: "land__merge", to: "land__why", condition: "merge.exit_code = 6", label: "needs a person" },
        { from: "land__why", to: "land__card" }, { from: "land__card", to: "land__merge" },
        { from: "land__landed", to: "deploy" }, { from: "deploy", to: "deploy__wait" },
        { from: "deploy__wait", to: "exit", condition: "outcome = success" },
        { from: "deploy__wait", to: "redeploy", condition: "outcome = failure", label: "deploy failed" },
        { from: "redeploy", to: "exit", condition: "outcome = success", label: "a later deploy" },
        { from: "redeploy", to: "never_live", condition: "outcome = failure" },
      ],
    } as any;
  };
  test("a card a segment reaches only on a side route makes its stage no person's, and never reads its route's label as a reason", () => {
    const g = landsThroughSegment();
    expect(journeyStages(g).map((s) => [s.label, s.who])).toEqual([["Land", "auto"], ["Deploy", "auto"], ["Live", "auto"]]);
    // Its route's label names the route, not what makes a run ask: with no asks_if the chip says only that it sometimes asks.
    expect(approvalOf(g)).toEqual({ kind: "if", when: null });
    expect(approvalWords(approvalOf(g))).toBe("Sometimes asks you");
  });
  test("a station only a failure reaches is no stage of the passing run", () => {
    expect(journeyStages(landsThroughSegment()).map((s) => s.label)).not.toContain("Wait for a later deploy");
  });
  test("a person asked on every run inside the landing segment approves, as the stage says", () => {
    const seg = (id: string, label: string, type = "command") => ({ id: `land__${id}`, label, type, segment: "land" });
    const g = {
      nodes: [{ id: "start", label: "start", type: "start" }, { id: "check", label: "Check", type: "command" }, { id: "land", label: "Land", type: "command", segment_entry: true, segment_flow: "land" }, seg("approve", "Approve", "human"), seg("landed", "Merged"), { id: "exit", label: "Live", type: "exit" }],
      edges: [{ from: "start", to: "check" }, { from: "check", to: "land", condition: "outcome = success" }, { from: "land", to: "land__approve" }, { from: "land__approve", to: "land__landed" }, { from: "land__landed", to: "exit" }],
    } as any;
    expect(journeyStages(g).find((s) => s.role === "land")).toMatchObject({ label: "Land", who: "person" });
    expect(approvalWords(approvalOf(g))).toBe("Asks you every time");
  });
});

// Union's change: one segment, Land, as Union's checkout reports it (the card's gate holds land.cast's asks_if).
describe("a segment's inside", () => {
  // As the Ship picker reads it in Union's checkout: the repository's own flow, folded into the pool.
  const land = flowBySlug(appPool([], [LAND_REPO_FLOW]), "change")!;
  const ASKS = LAND_ASKS;
  const stage = () => journeyStages(land)[0];
  test("the stage holds its passing path, read from the graph: PR, CI beside Review, Merge, then the segment's end", () => {
    const s = stage();
    expect(journeyStages(land).map((x) => [x.label, x.who])).toEqual([["Land", "agent"]]);
    expect(s.inside!.path.map((p) => [p.id, p.label, p.branches?.map((b) => b.label) ?? null])).toEqual([
      ["land__pr", "PR", null], ["land__checks", "CI + Review", ["CI", "Review"]], ["land__merge", "Merge", null],
    ]);
    expect(insideWords(s.inside!)).toBe("PR · CI + Review · Merge");
    expect(s.inside!.end).toBe("Merged");
  });
  test("each side route leaves the step it turns off, by its edge's label, and says where it goes back to", () => {
    const routes = stage().inside!.routes.map((r) => [r.from, r.label, r.steps.map((x) => x.label).join(" → "), r.to.kind === "step" ? r.to.label : r.to.kind]);
    expect(routes).toEqual([
      ["land__checks", "findings", "Brief", "session"],
      ["land__checks", "main is red", "Wait for green main → CI again, main moved", "Merge"],
      ["land__merge", "main moved", "CI again, main moved", "Merge"],
      ["land__merge", "conflict", "Does not fit main", "session"],
      ["land__merge", "head moved", "", "PR"],
      ["land__merge", "edits what judges it", "Why a person → Decide → Person said Ship", "Merge"],
    ]);
    // A route whose condition the parser decided false (the review left on) is no route.
    expect(routes.some(([, label]) => label === "review off")).toBe(false);
  });
  test("the person's card is a route of its own that asks only then, in its card's words; the chip says so and the stage is no person's", () => {
    const card = stage().inside!.routes.find((r) => r.asks)!;
    expect(card.steps.map((x) => [x.label, x.who])).toEqual([["Why a person", "auto"], ["Decide", "person"], ["Person said Ship", "auto"]]);
    expect(card.asks).toEqual({ when: ASKS });
    expect(stage().inside!.routes.filter((r) => r.asks)).toHaveLength(1);
    expect(approvalOf(land)).toEqual({ kind: "if", when: ASKS });
    expect(approvalWords(approvalOf(land))).toBe(`Asks you if ${ASKS}`);
  });
  test("asks_if is read from the gate, else the segment holding it, out to the flow's own segment node", () => {
    const at = (id: string | null) => ({ ...land, nodes: land.nodes.map(({ asks_if: _a, ...n }) => (n.id === id ? { ...n, asks_if: "it is Tuesday" } : n)) });
    expect(approvalOf(at("land__card"))).toEqual({ kind: "if", when: "it is Tuesday" });
    expect(approvalOf(at("land"))).toEqual({ kind: "if", when: "it is Tuesday" });
    expect(approvalOf(at(null))).toEqual({ kind: "if", when: null });
    // A pushed row stores no asks_if, and its source (change.cast) does not name the card: it can only say "sometimes".
    expect(approvalWords(approvalOf(pushedFlow({ _id: "wf_land", ...LAND_FLOW })))).toBe("Sometimes asks you");
  });
  test("who sent it back: Land's own findings are not the card's, though both sit in Land; a Revise at the card is the person's", () => {
    let t = 1000;
    const at = (id: string, status = "completed") => st(id, status, (t += 10));
    const upTo = [at("land"), at("land__pr"), at("land__checks"), at("land__ci"), at("land__review"), at("land__read")];
    const back = (node: string, steps: any[]) => journeyOf(land, run({ current_node_id: node, waiting_on_session: { node_id: node, since: t, note: "" }, node_statuses: [...steps, at(node, "running")] })).now;
    expect(back("fix", [...upTo, at("land__brief"), at("land__changes", "failed")])).toMatchObject({ kind: "session", by: null });
    expect(back("revise", [...upTo, at("land__merge", "failed"), at("land__why_card"), at("land__card"), at("land__card__decide"), at("land__card__revise", "failed"), at("land__revise", "failed")])).toMatchObject({ kind: "session", by: "the person" });
  });
  test("round 2 back at PR: nothing inside reads as last round's", () => {
    let t = 1000;
    const at = (id: string, status = "completed", visits = 1) => st(id, status, (t += 10), { visits });
    const round1 = [at("land"), at("land__pr"), at("land__checks"), at("land__ci"), at("land__review"), at("land__read"), at("land__merge", "failed"), at("land__retest"), at("land__brief"), at("land__changes", "failed"), at("fix")];
    const j = journeyOf(land, run({ current_node_id: "land__pr", node_statuses: [...round1, at("land__pr", "running", 2)] }), [], { id: ME, decision: null });
    expect([j.stages[0].state, j.stages[0].round]).toEqual(["active", 2]);
    expect(j.stages[0].inside!.path.map((p) => p.state)).toEqual(["active", "idle", "idle"]);
    expect(j.stages[0].inside!.routes.every((r) => r.state === "idle" && r.steps.every((s) => s.state === "idle"))).toBe(true);
  });
  test("a segment whose inside is one step, nothing off it, draws none", () => {
    expect(journeyStages(branching).some((s) => s.inside)).toBe(false);
    expect(journeyStages(change).some((s) => s.inside)).toBe(false);
  });
  test("on a run: the route that sent the work back reads back; the card a person must answer waits, theirs to answer", () => {
    const records = renderGalleryRecords(1_790_000_000_000, ME, "team:t1");
    const read = (id: string, decision: unknown = null) => {
      const r: any = records.workflowRuns.find((x: any) => x._id === id)!;
      return journeyOf(land, r, [], { id: ME, decision: decision as any });
    };
    const back = read(GALLERY_FLOW.shipLandBack);
    expect(back.stages[0].state).toBe("back");
    expect(back.stages[0].inside!.path.map((p) => p.state)).toEqual(["done", "done", "idle"]);
    expect(back.stages[0].inside!.routes.map((r) => r.state)).toEqual(["back", "idle", "idle", "idle", "idle", "idle"]);
    const atCard = read(GALLERY_FLOW.shipLandCard, card());
    expect(journeyWords(atCard).words).toBe("Your call");
    expect(atCard.stages[0].inside!.path.map((p) => p.state)).toEqual(["done", "done", "routed"]);
    const route = atCard.stages[0].inside!.routes.find((r) => r.asks)!;
    expect(route.state).toBe("waiting");
    expect(route.steps.map((x) => [x.label, x.state, x.who])).toEqual([["Why a person", "done", "auto"], ["Decide", "waiting", "you"], ["Person said Ship", "idle", "auto"]]);
  });
});

describe("a finished run drawn on a newer version of its flow", () => {
  // Union's change as it stands, and a finished run of its older version, its steps recorded flat (journeyFixtures).
  const segmented = pushedFlow({ _id: "wf_union_change", ...UNION_CHANGE_FLOW });
  const SHA = UNION_FLAT_SHA;
  const FLAT = UNION_FLAT_RUN.node_statuses;
  const finished = run(UNION_FLAT_RUN);

  test("every stage it passed is done, its merged sha read from the merge step, and it ends Live", () => {
    expect(landedSha(finished)).toBe(SHA);
    const j = journeyOf(segmented, finished);
    expect(states(j)).toEqual(["Land:done", "Deploy:done", "Live:done"]);
    expect(j.now.kind).toBe("live");
    expect(journeyWords(j)).toEqual({ words: "Live", tone: "ok" });
    // Land's inside reads the flat steps as its own.
    expect(j.stages[0].inside!.path.map((p) => `${p.label}:${p.state}`)).toEqual(["PR:done", "CI + Review:done", "Merge:done"]);
  });

  test("a flat step goes into a segment only when the run entered that segment at its start", () => {
    // The library change flow today holds a Decide segment (decide__ship, decide__revise); a run of its older version
    // stopped at its own Checks (check__failed) after the session's Revise, and never reached Decide.
    const shipped = flowBySlug(appPool([]), "change")!;
    const old = journeyOf(shipped, run({ status: "failed", current_node_id: "check__failed", fail_reason: "Stopped: Checks failed", node_statuses: [st("pr", "completed", 1), st("revise", "completed", 2), st("ship", "completed", 3), st("ship__ship", "completed", 3), st("check__failed", "completed", 4)] }));
    expect(old.stages.find((s) => s.id === "decide")?.state ?? "none").not.toBe("done");
    expect(old.stages.find((s) => s.role === "deploy")!.state).not.toBe("stopped");
    expect(old.now.kind).not.toBe("unlanded");
  });
  test("while it runs, the flat step it stands at is Land's", () => {
    const j = journeyOf(segmented, run({ status: "running", current_node_id: "merge", node_statuses: [...FLAT.slice(0, 6), st("merge", "running", 12)] }));
    expect(j.now).toMatchObject({ kind: "working", stage: "Land" });
    expect(states(j)).toEqual(["Land:active", "Deploy:idle", "Live:idle"]);
  });
});

describe("Ship in one click (pl-1075)", () => {
  test("a flow that may ask later starts in one click; one that asks every run, a risky checkout or several runs confirm", () => {
    expect(shipConfirms(approvalOf(change))).toBe(false);
    expect(shipConfirms(approvalOf(flowBySlug(appPool([], [LAND_REPO_FLOW]), "change")!))).toBe(false);
    expect(shipConfirms(approvalOf(branching))).toBe(true);
    expect(shipConfirms({ kind: "never" }, { from: "box, 364 behind main" })).toBe(true);
    expect(shipConfirms({ kind: "if", when: null }, { runs: 3 })).toBe(true);
  });
  test("a run waiting on its card says who answers, and the Release Captain by its title", () => {
    expect(gateWaitWords("person", "Jason")).toBe("Waiting for approval from Jason");
    expect(gateWaitWords("person")).toBe("Waiting for approval");
    expect(whoWords("@release")).toBe("Release Captain");
    expect(whoWords("@release", [{ handle: "release", name: "Release lead" }])).toBe("Release lead");
    expect(whoWords("@growth", [{ handle: "growth", name: "Head of Growth" }])).toBe("Head of Growth");
    const ci = [...ROUND, verdicts("decide", "green", "ship"), st("ci_card", "completed", 14), st("decide", "completed", 15), st("decide__decide", "running", 15)];
    const r = run({ status: "paused", user_id: ME, current_node_id: "decide__decide", gate_node_id: "decide__decide", gate_decision_id: "d1", gate_prompt: "Ship?", gate_decision_status: "pending", node_statuses: ci });
    const at = journeyOf(change, r, [], { id: ME, decision: card({ holder: { kind: "user", id: "u2" }, asked_user_ids: ["u2"] }) as any, holder_name: "Ashot" });
    expect(at.now).toMatchObject({ kind: "gate", mine: false, who: "Ashot" });
    expect(journeyWords(at)).toEqual({ words: "Waiting for approval from Ashot", tone: "wait" });
  });
});

// A station's result JSON (stationResult.ts) changes nothing for a flow whose stations report none. The personal Ship,
// whose stations do, is tested on the real runner's replayed reports (personalReplay.test.ts).
describe("station results", () => {
  test("a flow whose stations report no result reads as it did", () => {
    const j = journeyOf(change, run({ status: "completed", current_node_id: "exit", merge: { sha: "4a6e413b2c" }, node_statuses: [...MERGED, st("deploy__wait", "completed", 16, { result_preview: "Live: 4a6e413b2c on web dp-12." }), st("deploy__live", "completed", 17, { result_preview: '{"exit": "live"}' })] }));
    expect(j.stages.every((s) => s.state === "done" && !s.note && !s.left)).toBe(true);
  });
});
