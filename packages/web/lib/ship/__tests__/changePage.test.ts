import { describe, expect, test } from "bun:test";
import { onPrHead } from "@codecast/shared/contracts/deployTargets";
import { journeyOf } from "../journey";
import { stopTitle } from "../journeyWords";
import { changeAction, changeHeadline, changeJourney, changeLinks, changePr, changeReachRef, changeStations, currentHead, deployLine, endedStages, handedTo, mergeHolder, mergeIsOff, newerMergedRun, reviewEarlier, reviewOnHead, shipsChange } from "../changePage";
import { deploysHref } from "../../deploys/focus";
import { BRANCHING_FLOW, UNION_CHANGE_FLOW } from "../journeyFixtures";
import { appPool, flowBySlug, pushedFlow } from "../../line/flowPool";
import { replay, end, scenarios } from "./replayReports";
// The library change flow, parsed with its segments expanded (bun packages/cli/scripts/gen-change-graph-fixture.ts).
import graph from "./changeGraph.fixture.json";

// Node statuses as the runner reports them (runner.ts), as in journey.test.ts.
const change = { ...(graph as any), kind: "line", takes: ["task", "branch"] };
// Union's Change: PR, CI, review and merge inside its Land segment (land__pr, land__ci, …), then a Deploy segment.
const union = pushedFlow({ _id: "wf_union", ...UNION_CHANGE_FLOW } as any) as any;
const personal = flowBySlug(appPool(), "personal") as any;
const ME = "u1";
const run = (over: Record<string, unknown>) => ({ status: "running", workspace: "team:t1", spawner_conversation_id: "subj", node_statuses: [], ...over }) as any;
const st = (node_id: string, status: string, t = 1, extra: Record<string, unknown> = {}) => ({ node_id, status, started_at: t, ...extra });
const PR = st("pr", "completed", 1, { result_preview: '{"url":"https://github.com/acme/app/pull/217","number":217,"head_sha":"c0cac27575"}' });
const ROUND = [PR, st("checks", "completed", 2), st("ci", "completed", 2, { result_preview: "Waiting on CI for #217 at c0cac27: 9m" }), st("review", "completed", 10, { session: { _id: "convReview", title: "Review ct-1" } }), st("joined", "completed", 12)];
const verdicts = (next: string, ci: string, review: string, t = 13, extra: Record<string, unknown> = {}) => st("verdicts", "completed", t, { visits: 1, result_preview: JSON.stringify({ next, ci, review, why: "x", ...extra }) });
const MERGED = [...ROUND, verdicts("merge", "green", "ship"), st("merge", "completed", 14, { result_preview: '{"sha":"31ccbb83b1","pr":217}' }), st("landed", "completed", 15, { result_preview: "31ccbb83b1" }), st("deploy", "completed", 15)];
const LIVE_LINE = "Live: 31ccbb8 on web dp-3237, cli dp-3247, mobile dp-3238.";
// The shape a finished change run has on the server (ct-99051's run): PR, verdicts and merge recorded on the row.
const liveRun = run({
  status: "completed", current_node_id: "exit",
  pr: { number: 217, repository: "acme/app", head_sha: "c0cac27575" },
  ci_verdict: { green: true, head_sha: "c0cac27575" },
  review_verdict: { verdict: "ship", head_sha: "c0cac27575" },
  merge: { sha: "31ccbb83b1", pr_url: "https://github.com/acme/app/pull/217" },
  node_statuses: [...MERGED, st("deploy__wait", "completed", 16, { result_preview: LIVE_LINE }), st("deploy__live", "completed", 40, { result_preview: '{"exit": "live"}' })],
});
// Union's Land, as its runs report it (ct-102041): no verdicts on the row, the stations nested in the segment.
const U_PR = st("land__pr", "completed", 3, { result_preview: '{"pr":5016,"url":"https://github.com/Union-AI/union-mobile/pull/5016","head_sha":"11e526ca86"}' });
const U_ROUND = [st("start", "completed", 1), st("land", "completed", 2), U_PR, st("land__checks", "completed", 4), st("land__review", "completed", 5, { session: { _id: "convUR", title: "Review" } }), st("land__ci", "completed", 5), st("land__read", "completed", 6)];
const head = (r: any, viewer: any = null, g: any = change) => changeHeadline(journeyOf(g, r, [], viewer), r, g);
const act = (r: any, g: any = change, ctx: any = {}, viewer: any = null) => changeAction(journeyOf(g, r, [], viewer), r, g, ctx);

describe("A: which runs are the change's", () => {
  test("whole flows that land a session's change; segments and flows that land nothing keep the run report", () => {
    const pool = appPool() as any[];
    const of = (slug: string) => shipsChange(pool.find((f) => f.slug === slug));
    expect(["change", "personal"].map(of)).toEqual([true, true]);
    // Segments that take a branch (check, review, judge, intent, eval, ship, deploy) are not.
    expect(["check", "review", "judge", "intent", "eval", "ship", "deploy", "decide", "line", "climb"].map(of)).toEqual(Array(10).fill(false));
    // A repo's own Change (Union's, Land and Deploy segments), and an older flow composed of segments, are.
    expect(shipsChange(union)).toBe(true);
    expect(shipsChange(pushedFlow({ _id: "wf_b", ...BRANCHING_FLOW } as any) as any)).toBe(true);
    // Codecast's own Change only extends the library's: the run it pinned is a change run, its takes the library's.
    const variant = pushedFlow({ _id: "wf_cc", slug: "change", name: "change", nodes: change.nodes, edges: change.edges, source: 'digraph change {\n  graph [extends="change"]\n  local_ci [before="pr", label="Local CI", shape=parallelogram, script="bun run ci"]\n}' } as any) as any;
    expect(variant.takes).toEqual(["task", "branch"]);
    expect(shipsChange(variant)).toBe(true);
  });
});

describe("changeStations", () => {
  test("CI, Review and Deploy by what they are, at the top level or inside a segment", () => {
    const top = changeStations(change);
    expect([...top.ci]).toEqual(["ci"]);
    expect([...top.review]).toEqual(["review"]);
    expect(top.deploy.has("deploy__wait")).toBe(true);
    const nested = changeStations(union);
    expect([...nested.ci].sort()).toEqual(["land__ci", "land__ci_alone"]);
    expect([...nested.review]).toEqual(["land__review"]);
    expect(nested.deploy.has("deploy__wait")).toBe(true);
  });

  test("7: by the station's mark, never the fan-out's shape: a Lint beside CI is not CI, a second agent is not Review", () => {
    const lint = {
      ...change,
      nodes: [...change.nodes, { id: "lint", label: "Lint", type: "command" }, { id: "docs", label: "Docs", type: "agent" }],
      edges: [...change.edges, { from: "checks", to: "lint" }, { from: "checks", to: "docs" }],
    };
    const s = changeStations(lint);
    expect([...s.ci]).toEqual(["ci"]);
    expect([...s.review]).toEqual(["review"]);
    const r = run({ pr: { number: 217, repository: "acme/app", head_sha: "c0cac27575" }, node_statuses: [PR, st("checks", "completed", 2), st("ci", "completed", 2), st("lint", "running", 9)] });
    expect(changeLinks(r, lint).find((l) => l.kind === "ci")!.label).toBe("CI");
  });
});

describe("B: the head is structure, never a station's free text", () => {
  test("a live change names the targets that carry it, and waits on nothing", () => {
    expect(head(liveRun)).toEqual({ words: "Live on web, cli and mobile", waits: null, tone: "ok" });
  });

  test("a stop's words are the bar's own (one source), and its detail only labels the graph gives", () => {
    // Merge's rebase failed with git's whole output; the run ended at the exit Not merged.
    const raw = "Stopped: git rebase failed: packages/cli/src/a.md | Aborting | error: could not detach HEAD";
    const r = run({ status: "failed", current_node_id: "unshipped", fail_reason: raw, node_statuses: [...ROUND, verdicts("merge", "green", "ship"), st("merge", "failed", 14, { result_preview: "git rebase failed: a.md | Aborting" }), st("unshipped", "failed", 15)] });
    const j = journeyOf(change, r, [], null);
    const h = changeHeadline(j, r, change);
    expect(h.words).toBe(stopTitle(j.now as any));
    expect(h).toMatchObject({ words: "Stopped at Merge", waits: "Not merged", tone: "bad" });
  });

  test("no reason text reaches the head, whatever a station wrote", () => {
    // Reasons the verifier found in the head: a success-sounding rebase, a wait on a stopped run, a CLI command, ids, a server error.
    for (const why of [
      "Stopped: rebased pl1077/x onto main at 4a6e413b2c",
      "Stopped: waiting for the merge already running in this checkout (pid 80797) to finish",
      "Stopped: merge is off for this flow; a person turns it on with cast role line --merge on",
      "Stopped: hand jx73x07 killed before it reported",
      "Error: Too many writes in a single function execution",
    ]) {
      const r = run({ status: "failed", current_node_id: "unshipped", fail_reason: why, node_statuses: [...ROUND, verdicts("merge", "green", "ship"), st("merge", "failed", 14, { result_preview: why }), st("unshipped", "failed", 15)] });
      const h = head(r);
      const said = `${h.words} ${h.waits ?? ""}`;
      expect(said).not.toContain("cast ");
      expect(said).not.toMatch(/jx7|pid|rebased|waiting for|Too many|4a6e413/);
    }
  });

  test("Union's stops name Land as the bar does, then the step inside it and the way out it took", () => {
    const pr = run({ status: "failed", current_node_id: "stopped", fail_reason: "Stopped: The pull request could not be opened: line: origin's branch holds commits; send it again", node_statuses: [st("start", "completed", 1), st("land", "completed", 2), st("land__pr", "failed", 3, { result_preview: "line: origin's branch holds commits" }), st("land__unpushed", "failed", 4, { result_preview: '{"exit": "unpushed"}' }), st("stopped", "failed", 5)] });
    const j = journeyOf(union, pr, [], null);
    expect(head(pr, null, union)).toMatchObject({ words: stopTitle(j.now as any), waits: "PR · no pull request" });
    expect(head(pr, null, union).words).toBe("Stopped at Land");
    // Only the way out failed (CI could not be read): its name is the outcome.
    const unread = run({ status: "failed", current_node_id: "stopped", fail_reason: "Stopped: GitHub's CI could not be read, so the change is not judged: required check test was cancelled", node_statuses: [...U_ROUND, st("land__unread", "failed", 8, { result_preview: '{"exit": "unread"}' }), st("stopped", "failed", 9)] });
    expect(head(unread, null, union)).toMatchObject({ words: "Stopped at Land", waits: "CI unread" });
  });

  // ct-102100: Union's pushed change.cast only extends outreach/line/change.cast, so the app reads no `stop` on its exit;
  // the stop said to level the branch with origin first, yet the run page offered Ship again, which stops the same way.
  test("a stop at an exit whose words live in an extended file is deliberate: its session, never Ship again", () => {
    const extending = pushedFlow({ _id: "wf_union_ext", ...UNION_CHANGE_FLOW, source: 'digraph change {\n  graph [extends="../../outreach/line/change.cast", kind="line", takes="task,branch"]\n}' } as any) as any;
    expect(extending.nodes.find((n: any) => n.id === "stopped").stop).toBeUndefined();
    const r = run({ status: "failed", current_node_id: "stopped", fail_reason: "Stopped: The pull request could not be opened: line: origin's line-builder-mechanism (abb5c695d0) holds commits this checkout never had, and this checkout holds commits origin lacks; bring the change level with origin and send it again", node_statuses: [st("start", "completed", 1), st("land", "completed", 2), st("land__pr", "failed", 3, { result_preview: "line: origin's line-builder-mechanism (abb5c695d0) holds commits" }), st("land__unpushed", "failed", 4, { result_preview: '{"exit": "unpushed"}' }), st("stopped", "failed", 5)] });
    expect(journeyOf(extending, r, [], null).now).toMatchObject({ kind: "stopped", fix: "run" });
    expect(act(r, extending)).toEqual({ kind: "session", label: "Open session", href: "/conversation/subj" });
    // A failure at that exit the runner did not call a stop still runs again.
    const crashed = run({ ...r, fail_reason: "runner crashed" });
    expect(act(crashed, extending)).toMatchObject({ kind: "again" });
  });

  // ct-102369: CI never reported offered Ship again here, a resume in `cast workflow show`, and a fresh run to the session.
  test("a stop that names its resume never offers Ship again beside the bar's Resume", () => {
    const noci = run({ status: "failed", current_node_id: "noci", fail_reason: "Stopped: CI never reported on the pushed head, also after running it again. The change is not at fault: resume this run at PR (`cast workflow resume ct-1 --at pr`) to run CI and a fresh review on the same change once GitHub runs CI on pull requests again. What CI said: x", node_statuses: [...ROUND, verdicts("no_ci", "timed_out", "ship"), st("noci", "failed", 20)] });
    expect(journeyOf(change, noci, [], null).now).toMatchObject({ kind: "stopped", resume: { at: "pr", label: "PR" } });
    expect(act(noci)).toEqual({ kind: "session", label: "Open session", href: "/conversation/subj" });
    // A variant that extends the library flow (codecast's own adds local_ci) keeps the library's stop nodes, whose
    // words its pushed source does not carry: it names the same resume. Its own node at that id names none.
    const variant = (relabel: boolean) => pushedFlow({ _id: "wf_cc", ...change, slug: "change", name: "change", source: 'digraph change {\n  graph [extends="change"]\n  local_ci [after="pr", label="Local CI", shape=parallelogram, script="bun run ci"]\n}',
      nodes: [...change.nodes.map(({ stop: _s, ...n }: any) => (relabel && n.id === "noci" ? { ...n, label: "Our CI gave up" } : n)), { id: "local_ci", label: "Local CI", type: "command", shape: "parallelogram" }] } as any) as any;
    expect((journeyOf(variant(false), noci, [], null).now as any).resume).toEqual({ at: "pr", label: "PR" });
    expect((journeyOf(variant(true), noci, [], null).now as any).resume).toBeUndefined();
    // A runner that crashed at a station whose words name no resume runs again.
    expect(act({ ...noci, current_node_id: "checks", fail_reason: "runner crashed", node_statuses: [st("pr", "completed", 1), st("checks", "failed", 2)] })).toMatchObject({ kind: "again" });
  });

  // ct-102477: the same unplanned failure whose runner words name its one restart (a worktree something moved) offers
  // no Ship again: that rebuilds the branch the restart would ship.
  test("a failure whose words name its one restart never offers Ship again", () => {
    const why = "Could not freeze the checkout's change again: Something reset or rebased the run's worktree to d87da407ea, off the change as last frozen (61d7c6b4cb), so the run left it as it is. To ship that worktree's branch as it stands now, run it again on this task: `cast flow run change --task ct-1 --branch codecast/change-ct-1`.";
    const moved = run({ status: "failed", current_node_id: "checks", fail_reason: why, node_statuses: [st("pr", "completed", 1), st("checks", "failed", 2)] });
    expect(journeyOf(change, moved, [], null).now).toMatchObject({ fix: "again", whole: true });
    expect(act(moved)).not.toMatchObject({ kind: "again" });
  });

  test("an earlier round's failure is not this stop", () => {
    const r = run({ status: "failed", current_node_id: "stopped", fail_reason: "Stopped: x", node_statuses: [...U_ROUND, st("land__changes", "failed", 7, { result_preview: '{"exit": "changes"}' }), st("fix", "completed", 8), st("land__pr", "failed", 10, { result_preview: "push refused" }), st("land__unpushed", "failed", 11, { result_preview: '{"exit": "unpushed"}' }), st("stopped", "failed", 12)] });
    // The run recorded its PR in an earlier round, so its way out is not said as No pull request.
    expect(head(r, null, union).waits).toBe("PR");
  });

  test("CI red sent back to the session: the finding, then the fix it waits on, its round as the bar says it", () => {
    const r = run({ current_node_id: "brief", pr: { number: 217, repository: "acme/app", head_sha: "c0cac27575" }, ci_verdict: { green: false, head_sha: "c0cac27575" }, review_verdict: { verdict: "ship", head_sha: "c0cac27575" }, waiting_on_session: { node_id: "brief", conversation_id: "c1", since: 30, note: "fix CI" }, node_statuses: [...ROUND, verdicts("brief", "red", "ship"), st("brief", "running", 20, { visits: 2 })] });
    expect(head(r)).toEqual({ words: "CI red", waits: "Its session is fixing it · round 2 of 3", tone: "bad" });
    // The session is the bar's one action; the head only says the state.
    expect(act(r)).toEqual({ kind: "session", label: "Open session", href: "/conversation/c1" });
  });

  test("Union's review asks for changes inside Land: the way out it took names the finding", () => {
    const r = run({ current_node_id: "fix", node_statuses: [...U_ROUND, st("land__brief", "completed", 7, { result_preview: "## The reviewer asked for changes - medium x" }), st("land__changes", "failed", 8, { result_preview: '{"exit": "changes"}' }), st("fix", "running", 9)] });
    expect(head(r, null, union)).toMatchObject({ words: "Changes asked", waits: "Its session is fixing it" });
    expect(act(r, union)).toMatchObject({ kind: "session", href: "/conversation/subj" });
  });

  test("3: a card is said once: the head says whose, the bar opens it (no question, no repeat)", () => {
    const r = run({ status: "paused", user_id: ME, current_node_id: "decide__decide", gate_node_id: "decide__decide", gate_decision_id: "d1", gate_decision_short_id: "sd-9", gate_prompt: "Ship ct-1? It edits CI.\nmore", gate_decision_status: "pending", node_statuses: [...ROUND, verdicts("decide", "green", "ship"), st("decide__decide", "running", 15)] });
    const decision = { user_id: ME, holder: { kind: "user", id: ME }, asked_user_ids: [ME] };
    expect(head(r, { id: ME, decision })).toEqual({ words: "Waiting on your decision", waits: null, tone: "you" });
    // The viewer's own card is answered in the bar: no link to it.
    expect(act(r, change, {}, { id: ME, decision })).toBeNull();
    const theirs = head(r, { id: "u2", decision, holder_name: "Ashot" });
    expect(theirs).toEqual({ words: "Waiting for approval from Ashot", waits: null, tone: "wait" });
    expect(act(r, change, {}, { id: "u2", decision, holder_name: "Ashot" })).toEqual({ kind: "card", label: "Open the card", href: "/decisions/sd-9" });
  });

  test("3: a session that asks: the head says who it waits on, the bar opens the card or the session", () => {
    const r = run({ current_node_id: "brief", waiting_on_session: { node_id: "brief", conversation_id: "c1", since: 30, note: "keep the old flag?", blocked: true }, node_statuses: [...ROUND, verdicts("brief", "green", "changes"), st("brief", "running", 20, { visits: 1 })] });
    const ask = { id: "d1", short_id: "sd-7", question: "Keep the old flag?", mine: true, open: true };
    expect(head(r, { id: ME, ask })).toMatchObject({ words: "Waiting on your answer", waits: null });
    expect(act(r, change, {}, { id: ME, ask })).toBeNull();
    expect(head(r, { id: ME, ask: { ...ask, mine: false } })).toMatchObject({ words: "Waiting for a person", waits: null });
    expect(act(r, change, {}, { id: ME, ask: { ...ask, mine: false } })).toMatchObject({ kind: "card", href: "/decisions/sd-7" });
    expect(act(r, change, {}, { id: ME, ask: null })).toMatchObject({ kind: "session", href: "/conversation/c1" });
  });

  test("3: merged and held at Deploy: the head says Merged and the wait once (the chip has the sha), the bar opens Deploys", () => {
    const r = run({ current_node_id: "deploy__wait", merge: { sha: "31ccbb83b1", at: 9 }, node_statuses: [...MERGED, st("deploy__wait", "running", 16, { result_preview: "web: waiting on main CI at 31ccbb8 (running)" })] });
    expect(head(r)).toEqual({ words: "Merged", waits: "Waiting on main CI", tone: "wait" });
    expect(act(r)).toMatchObject({ kind: "deploys", href: "/deploys?team=t1&target=web&sha=31ccbb83b1" });
  });

  test("4: a wait opens the target still waiting, never the live deploy the line names first", () => {
    const line = "backend: live in dp-3302; cli: waiting on main CI at a8ccc22 (running; 32m of 60m)";
    expect(deploysHref({ workspace: "team:t1", merge: { sha: "acbd8d27a8" } }, line)).toBe("/deploys?team=t1&target=cli&sha=acbd8d27a8");
    // A target going out opens its own deploy.
    expect(deploysHref({ workspace: "team:t1" }, "backend: live in dp-1; cli: dp-2 sending a8ccc22")).toBe("/deploys?team=t1&target=cli&deploy=dp-2");
    // A run that landed a commit opens at that commit, its deploy open beside it.
    expect(deploysHref({ workspace: "team:t1", merge: { sha: "acbd8d27a8" } }, "backend: live in dp-1; cli: dp-2 sending a8ccc22")).toBe("/deploys?team=t1&target=cli&sha=acbd8d27a8&deploy=dp-2");
    // A line with one named deploy and no per-target form is read as before.
    expect(deploysHref({ workspace: "team:t1" }, "Deploy stuck: web dp-12 failed")).toBe("/deploys?team=t1&target=web&deploy=dp-12");
  });

  test("CI and review under way: the stage, nothing named past it", () => {
    const r = run({ current_node_id: "ci", node_statuses: [PR, st("checks", "completed", 2), st("ci", "running", 3), st("review", "running", 3)] });
    expect(head(r).words).toBe("In CI and review");
  });
});

describe("C: truth", () => {
  test("a finished run says the exit it reached, even where an older flow's journey reads Live", () => {
    // A personal Ship's pushed row from before own_results (#226): its journey reads the Landed end as Live.
    const old = { ...personal, own_results: undefined, source: null };
    const r = run({ status: "completed", workspace: "user:u1", current_node_id: "nodeploy", merge: { sha: "c2cb58d24c" }, node_statuses: [st("start", "completed", 1), st("round", "completed", 2), st("checks", "completed", 3), st("review", "completed", 4), st("check", "completed", 4), st("joined", "completed", 5), st("verdicts", "completed", 6), st("land", "completed", 7), st("landed", "completed", 8, { result_preview: "c2cb58d24c" }), st("deploy", "completed", 9), st("nodeploy", "completed", 10)] });
    expect(journeyOf(old, r, [], null).now.kind).toBe("live");
    expect(head(r, null, old)).toMatchObject({ words: "Landed", tone: "ok" });
    // 6: the track agrees: it never deployed and never reached Live.
    const states = Object.fromEntries(endedStages(journeyOf(old, r, [], null), r, old).map((s) => [s.role, s.state]));
    expect(states).toMatchObject({ land: "done", deploy: "nothing", live: "skipped" });
    // A run that reached its Live exit reads Live, never Merged.
    expect(head({ ...r, current_node_id: "exit" }, null, old).words).toBe("Live");
  });

  test("verdicts count only for the head the run is on now", () => {
    // Round 1 edited CI; the fix round dropped that edit and CI is green on the new head.
    const r1 = run({ pr: { number: 217, repository: "acme/app", head_sha: "bbb" }, ci_verdict: { green: true, ci_changed: false, head_sha: "bbb" }, node_statuses: [st("pr", "completed", 1), verdicts("brief", "green", "changes", 5, { ci_result: { green: true, ci_changed: true } }), st("pr", "completed", 10), st("ci", "completed", 11), st("review", "running", 11, { session: { _id: "r" } })] });
    expect(changeLinks(r1, change).map((l) => l.label)).toEqual(["PR #217", "CI green", "In review"]);
    // A new round: the PR is on ccc, CI has not run on it; the last verdicts were on bbb.
    const r2 = run({ pr: { number: 217, repository: "acme/app", head_sha: "ccc" }, ci_verdict: { green: false, head_sha: "bbb" }, review_verdict: { verdict: "changes", head_sha: "bbb" }, node_statuses: [st("pr", "completed", 1), st("ci", "completed", 2), st("review", "completed", 2, { session: { _id: "r" } }), st("pr", "completed", 20), st("checks", "running", 21)] });
    expect(changeLinks(r2, change).map((l) => l.label)).toEqual(["PR #217", "CI", "Review"]);
    // CI green on a change that edits CI, current: shown, but not as a pass.
    const r3 = run({ pr: { number: 217, repository: "acme/app", head_sha: "bbb" }, ci_verdict: { green: true, ci_changed: true, head_sha: "bbb" }, node_statuses: ROUND });
    expect(changeLinks(r3, change).find((l) => l.kind === "ci")).toMatchObject({ label: "CI green · edits CI", tone: "default", title: expect.stringContaining("a person approves") });
    // Resolve conflict force-pushed ddd, which GitHub has and the run has not recorded: judged on the PR's real head, the
    // run's verdicts on bbb say nothing, as the PR's header says nobody has reviewed it.
    const r4 = run({ pr: { number: 217, repository: "acme/app", head_sha: "bbb" }, ci_verdict: { green: true, ci_changed: true, head_sha: "bbb" }, review_verdict: { verdict: "ship", head_sha: "bbb" }, node_statuses: [st("pr", "completed", 1), st("ci", "completed", 2), st("review", "completed", 2, { session: { _id: "r" } }), st("merge", "failed", 3), st("fix_conflict", "completed", 4)] });
    expect(changeLinks(r4, change).map((l) => l.label)).toEqual(["PR #217", "CI green · edits CI", "Review passed"]);
    expect(changeLinks(onPrHead(r4, "ddd"), change).map((l) => l.label)).toEqual(["PR #217", "CI", "Review"]);
  });

  test("Union's runs record no verdicts: CI and Review are plain links, no state", () => {
    const r = run({ status: "failed", current_node_id: "stopped", node_statuses: [...U_ROUND, st("land__unread", "failed", 8, { result_preview: '{"exit": "unread"}' })] });
    expect(changeLinks(r, union).map((l) => `${l.kind}:${l.label}:${l.tone}`)).toEqual(["pr:PR #5016:default", "ci:CI:default", "review:Review:default"]);
  });

  test("current head: the run's record, else the newest step that reported the PR", () => {
    expect(currentHead(run({ pr: { number: 1, repository: "a/b", head_sha: "abc1234" } }))).toBe("abc1234");
    expect(currentHead(run({ node_statuses: [PR] }))).toBe("c0cac27575");
  });
});

describe("D: a stop always has one way on, and never one that cannot help", () => {
  const stopped = (over: Record<string, unknown> = {}) => run({ status: "failed", current_node_id: "unshipped", fail_reason: "Stopped: boom", node_statuses: [...ROUND, verdicts("merge", "green", "ship"), st("merge", "failed", 14), st("unshipped", "failed", 15)], ...over });

  test("a newer run on the task is where the change went", () => {
    expect(act(stopped(), change, { newer: "run2" })).toEqual({ kind: "newer", label: "Open the newer run", href: "/workflows/runs/run2" });
  });

  test("5: merge switched off opens the role that holds the switch; with no role known it says Merge is off and opens the session", () => {
    const off = stopped({ fail_reason: "Stopped: merge is off for this flow; a person turns it on with cast role line --merge on" });
    expect(act(off, change, { mergeRole: "or-12" })).toEqual({ kind: "merge_switch", label: "Turn merge on", href: "/org/or-12" });
    expect(act(off)).toMatchObject({ kind: "session", href: "/conversation/subj" });
    expect(head(off)).toMatchObject({ words: "Stopped at Merge", waits: "Merge is off" });
    // The CLI's own words for it read the same.
    const left = stopped({ fail_reason: "Stopped: merge left to a person: merge is off for this flow; a person turns it on" });
    expect(act(left, change, { mergeRole: "or-12" })?.kind).toBe("merge_switch");
    expect(head(left).waits).toBe("Merge is off");
    // Once GitHub merged the PR, the switch would change nothing.
    const pr = { merged: true, merge_sha: "e582239aa1" };
    expect(act(off, change, { pr, mergeRole: "or-12" })?.kind).toBe("session");
    // Read as the change: someone else merged it, so it is landed, not stopped (landedOutside).
    const j = changeJourney(change, off, [], null, { pr });
    expect(changeHeadline(j, off, change, { pr })).toMatchObject({ words: "Merged by someone else", waits: "Nothing to deploy" });
  });

  test("2: a run that recorded its PR never reads No pull request", () => {
    // ct-101858's shape: PR #2 recorded with CI green and review ship on its head, then a later create failed into nopr.
    const r = run({ status: "failed", current_node_id: "nopr", fail_reason: "Stopped: gh pr create failed", pr: { number: 2, repository: "acme/app", head_sha: "3a9ba96" }, ci_verdict: { green: true, head_sha: "3a9ba96" }, review_verdict: { verdict: "ship", head_sha: "3a9ba96" }, node_statuses: [st("start", "completed", 1), st("checks", "completed", 3), st("verdicts", "completed", 5), st("merge", "failed", 8), st("fix_conflict", "completed", 9), st("pr", "failed", 12), st("nopr", "failed", 13)] });
    const h = head(r);
    expect(h.words).toBe("Stopped at PR");
    expect(h.waits ?? "").not.toMatch(/pull request/i);
    // With no PR on record the exit says it.
    expect(head({ ...r, pr: null }).waits).toBe("No pull request");
  });

  test("1: a change a landing step put on main reads landed at its Deploy stop, never Not merged, and opens Deploys", () => {
    // ct-92246's ship-now run: ship__shipped passed with no sha, then Deploy failed.
    const shipNow = pushedFlow({ _id: "wf_shipnow", ...BRANCHING_FLOW } as any) as any;
    const r = run({ status: "failed", current_node_id: "deploy__failed", merge: null, fail_reason: "Stopped: Error: Too many writes per second.", node_statuses: [st("start", "completed", 1), st("check__verify", "completed", 2), st("review__review", "completed", 3), st("intent", "completed", 4), st("intent_gate", "completed", 5), st("cleared", "completed", 6), st("ship__ship", "completed", 7, { result_preview: "rebased onto origin/main (4 new commit(s))" }), st("ship__shipped", "completed", 8, { result_preview: '{"exit": "shipped"}' }), st("deploy", "completed", 9), st("deploy__wait", "failed", 10, { result_preview: "Error: Too many writes" }), st("deploy__failed", "failed", 11)] });
    const j = journeyOf(shipNow, r, [], null);
    expect(j.now).toMatchObject({ kind: "stopped", stage: "Deploy", fix: "deploy", landed: true });
    expect(head(r, null, shipNow)).toMatchObject({ words: "Stopped at Deploy" });
    expect(head(r, null, shipNow).waits).toMatch(/^Landed/);
    expect(act(r, shipNow)?.kind).toBe("deploys");
    // F1: the track says Land landed too, never "went another way".
    expect(j.stages.find((s) => s.role === "land")!.state).toBe("done");
  });

  // ct-102256: landed, then the desktop deploy carrying it failed; the head said "Landed · go live · deploy failed".
  test("a change on main whose deploy failed says which, and that the target's next deploy takes it live", () => {
    const r = run({ status: "failed", current_node_id: "deploy__failed", merge: { sha: "929c5d8d44", pr_url: "https://github.com/acme/app/pull/270" }, fail_reason: "Stopped: The deploy that carried 929c5d8 failed: desktop dp-3559 (Stopped at Send.).", node_statuses: [...MERGED, st("deploy__wait", "failed", 16, { result_preview: "The deploy that carried 929c5d8 failed: desktop dp-3559 (Stopped at Send.)." }), st("deploy__failed", "failed", 17)] });
    expect(head(r)).toEqual({ words: "Stopped at Deploy", waits: "Landed · desktop dp-3559 failed · goes live with the next desktop deploy", tone: expect.any(String) });
    expect(act(r)?.kind).toBe("deploys");
    const two = run({ ...r, fail_reason: "Stopped: The deploy that carried 929c5d8 failed: desktop dp-3559 (Stopped at Send.), web dp-12. A later deploy that takes it live ends this run at Live." });
    expect(head(two).waits).toBe("Landed · desktop dp-3559, web dp-12 failed · goes live with the next desktop and web deploys");
    // The deploy records say where it is now: a later deploy took it live or is sending it, so no next deploy is promised.
    const words = (targets: any[]) => changeHeadline(journeyOf(change, two, [], null), two, change, { targets }).waits;
    expect(words([{ name: "desktop", state: "live", deploy: "dp-3601" }, { name: "web", state: "deploying", deploy: "dp-14" }])).toBe("Landed · live on desktop dp-3601 · going out to web in dp-14");
    expect(words([{ name: "desktop", state: "live", deploy: "dp-3601" }, { name: "web", state: "failed" }])).toBe("Landed · live on desktop dp-3601 · web dp-12 failed · goes live with the next web deploy");
  });

  // pl-1077 polish 4: mobile dp-3857 failed, dp-3858 took it live, and cli was still going out; the head named only mobile,
  // and before reach answered it said mobile failed from what an earlier visit had cached.
  test("a stop at Deploy names a target still sending the change, and says it is reading until reach answers", () => {
    const r = run({ status: "failed", current_node_id: "deploy__failed", merge: { sha: "65d54feb1c", pr_url: "https://github.com/acme/app/pull/333" }, fail_reason: "Stopped: The deploy that carried 65d54fe failed: mobile dp-3857 (Stopped at Send.).", node_statuses: [...MERGED, st("deploy__wait", "failed", 16), st("deploy__failed", "failed", 17)] });
    const said = (ctx: Record<string, unknown>) => changeHeadline(journeyOf(change, r, [], null), r, change, ctx as any);
    const targets = [{ name: "mobile", state: "live", deploy: "dp-3858" }, { name: "cli", state: "deploying", deploy: "dp-3856" }];
    expect(said({ targets })).toMatchObject({ words: "Stopped at Deploy", waits: "Landed · live on mobile dp-3858 · going out to cli in dp-3856" });
    expect(said({ targets: [{ name: "mobile", state: "failed", deploy: "dp-3857" }], reading: true }).waits).toBe("Landed · reading where it is live");
  });

  // ct-102396: dp-3789 stopped at Send on a refusal before anything went out; the head said "cli dp-3789 failed".
  test("a change whose deploy sent nothing reads Not sent, never failed", () => {
    const reason = "No deploy took f35e9c6 out: cli dp-3789 stopped at Send before sending anything (A cut-cli-release.yml run is already in flight: https://github.com/acme/app/actions/runs/9). A later deploy that takes it live ends this run at Live.";
    const r = run({ status: "failed", current_node_id: "deploy__failed", merge: { sha: "f35e9c6628", pr_url: "https://github.com/acme/app/pull/324" }, fail_reason: `Stopped: ${reason}`, node_statuses: [...MERGED, st("deploy__wait", "failed", 16, { result_preview: reason }), st("deploy__failed", "failed", 17)] });
    expect(head(r)).toEqual({ words: "Not sent", waits: "Landed · cli dp-3789 not sent · goes live with the next cli deploy", tone: expect.any(String) });
    const mixed = run({ ...r, fail_reason: "Stopped: The deploy that carried f35e9c6 failed: cli dp-3789 stopped at Send before sending anything (x), web dp-12 (Stopped at Live: down)." });
    expect(head(mixed)).toEqual({ words: "Stopped at Deploy", waits: "Landed · web dp-12 failed · cli dp-3789 not sent · goes live with the next cli and web deploys", tone: expect.any(String) });
    // A later deploy taking it live is said as such; it is no longer Not sent.
    expect(changeHeadline(journeyOf(change, r, [], null), r, change, { targets: [{ name: "cli", state: "live", deploy: "dp-3800" }] as any })).toMatchObject({ words: "Stopped at Deploy", waits: "Landed · live on cli dp-3800" });
  });

  // ct-102797's th76kej: the run could not send mobile from another person's machine; it ended completed at Deploy failed
  // (its runner lost the exit's stop) and read "Deploy failed" under a green dot, though nothing failed.
  test("a send left to another person's machine reads waiting for that machine, failed or ended completed, and Live once a deploy took it", () => {
    const reason = "This run could not send mobile: mobile is sent only from Jason Benn's machine (jb-m5-max), not from this machine. ac377bd is on main and goes out with mobile's next deploy.";
    const stopped = run({ status: "failed", current_node_id: "deploy__failed", merge: { sha: "ac377bd88f", pr_url: "https://github.com/acme/app/pull/347" }, fail_reason: `Stopped: ${reason}`, node_statuses: [...MERGED, st("deploy__wait", "failed", 16, { result_preview: reason }), st("deploy__failed", "failed", 17)] });
    const lost = run({ ...stopped, status: "completed", fail_reason: undefined, node_statuses: [...MERGED, st("deploy__wait", "failed", 16, { result_preview: reason }), st("deploy__failed", "completed", 17)] });
    for (const r of [stopped, lost]) {
      expect(head(r)).toEqual({ words: "Waiting for Jason Benn's machine (jb-m5-max) to send mobile", waits: "Landed · goes live with the next mobile deploy", tone: "wait" });
      const at = (targets: any[]) => changeHeadline(journeyOf(change, r, [], null), r, change, { targets });
      expect(at([{ name: "mobile", state: "deploying", deploy: "dp-3930" }])).toMatchObject({ words: "Deploying to mobile", tone: "wait" });
      expect(at([{ name: "mobile", state: "live", deploy: "dp-3939" }])).toEqual({ words: "Live on mobile", waits: "Landed · live on mobile dp-3939", tone: "ok" });
      expect(act(r)?.kind).toBe("deploys");
    }
    // Any other stop a runner ended completed reads as the stop, never under a green dot.
    const failedLost = run({ ...lost, node_statuses: [...MERGED, st("deploy__wait", "failed", 16, { result_preview: "The deploy that carried ac377bd failed: mobile dp-3857 (Stopped at Send.)." }), st("deploy__failed", "completed", 17)] });
    expect(head(failedLost)).toEqual({ words: "Deploy failed", waits: "Landed · mobile dp-3857 failed · goes live with the next mobile deploy", tone: "bad" });
  });

  test("F2: a flow's own top-level unmerged that loops back to landing is not Deploy finding the change off main", () => {
    // change-pg17's path: ship__unshipped → unmerged → decide → decide__ship → ship → ship__shipped → deploy, which then failed.
    const flow = pushedFlow({ _id: "wf_pg17", ...BRANCHING_FLOW } as any) as any;
    const r = run({ status: "failed", current_node_id: "deploy__failed", merge: null, fail_reason: "Stopped: Deploy failed", node_statuses: [st("start", "completed", 1), st("check__verify", "completed", 2), st("review__review", "completed", 3), st("intent", "completed", 4), st("intent_gate", "completed", 5), st("ask", "completed", 6), st("ship__ship", "failed", 7), st("ship__unshipped", "failed", 8, { result_preview: '{"exit": "unshipped"}' }), st("unmerged", "completed", 9), st("decide__decide", "completed", 10), st("decide__ship", "completed", 11), st("ship__ship", "completed", 12), st("ship__shipped", "completed", 13, { result_preview: '{"exit": "shipped"}' }), st("deploy", "completed", 14), st("deploy__wait", "failed", 15), st("deploy__failed", "failed", 16)] });
    const j = journeyOf(flow, r, [], null);
    expect(j.now).toMatchObject({ kind: "stopped", stage: "Deploy", landed: true });
    expect(j.stages.find((s) => s.role === "land")!.state).toBe("done");
    expect(act(r, flow)?.kind).toBe("deploys");
    // Deploy's own unmerged, after the landing, still says the change is not on main.
    const off = run({ ...r, current_node_id: "deploy__unmerged", node_statuses: [...r.node_statuses.slice(0, -2), st("deploy__unmerged", "failed", 15)] });
    expect(journeyOf(change, { ...off, node_statuses: [...MERGED.filter((n) => n.node_id !== "merge" && n.node_id !== "landed"), st("landed", "completed", 15), st("deploy", "completed", 16), st("deploy__unmerged", "failed", 17)] }, [], null).now.kind).toBe("unlanded");
  });

  test("F4: a shipped step a merge still follows (Union's one-session fix flow) is not a landing", () => {
    const g = pushedFlow({
      _id: "wf_onefix", slug: "onefix", name: "onefix", kind: "line", source: 'digraph f { graph [kind="line", takes="task,branch"] }',
      nodes: [{ id: "start", label: "start", type: "start" }, { id: "decide", label: "Decide", type: "human" }, { id: "shipped", label: "Ship", type: "command" }, { id: "build", label: "Build", type: "agent" }, { id: "merge", label: "Merge", type: "command" }, { id: "landed", label: "Merged", type: "command" }, { id: "deploy", label: "Deploy", type: "conditional" }, { id: "deploy__wait", label: "Go live", type: "command" }, { id: "deploy__failed", label: "Deploy failed", type: "exit" }, { id: "exit", label: "Live", type: "exit" }],
      edges: [{ from: "start", to: "decide" }, { from: "decide", to: "shipped" }, { from: "shipped", to: "build" }, { from: "build", to: "merge" }, { from: "merge", to: "landed" }, { from: "landed", to: "deploy" }, { from: "deploy", to: "deploy__wait" }, { from: "deploy__wait", to: "exit" }, { from: "deploy__wait", to: "deploy__failed", condition: "outcome = failure" }],
    } as any) as any;
    // shipped passed; the merge never ran; the run stopped at Deploy's failure: nothing says it landed.
    const r = run({ status: "failed", current_node_id: "deploy__failed", fail_reason: "Stopped: x", node_statuses: [st("start", "completed", 1), st("decide", "completed", 2), st("shipped", "completed", 3), st("deploy__wait", "failed", 4), st("deploy__failed", "failed", 5)] });
    expect((journeyOf(g, r, [], null).now as any).landed).toBeUndefined();
  });

  test("F3: Open Deploys opens the target a stopped deploy is stuck on, from the deploy records first", () => {
    // th77se1j's stop: cli stuck, backend live.
    const why = "Stopped: Deploy stuck: cli is not live with acbd8d2 after 60m (last: waiting on main CI at c6c7a32 (running)). Live: backend dp-3302.";
    const r = run({ status: "failed", current_node_id: "deploy__stuck", merge: { sha: "acbd8d27a8" }, fail_reason: why, node_statuses: [...MERGED, st("deploy__wait", "failed", 16, { result_preview: why.replace("Stopped: ", "") })] });
    expect(deploysHref(r, why)).toBe("/deploys?team=t1&target=cli&sha=acbd8d27a8");
    expect(act(r)).toMatchObject({ kind: "deploys", href: "/deploys?team=t1&target=cli&sha=acbd8d27a8" });
    // The deploy records name the target and its deploy: they win over any words, and that deploy opens beside the change.
    expect(act(r, change, { targets: [{ name: "backend", state: "live", deploy: "dp-3302" }, { name: "cli", state: "deploying", deploy: "dp-3313" }] })!.href).toBe("/deploys?team=t1&target=cli&sha=acbd8d27a8&deploy=dp-3313");
  });

  test("F5: a pushed flow keeps the stored node's backend where its source names none", () => {
    const f = pushedFlow({ _id: "wf_u", slug: "fixflow", name: "fixflow", kind: "line", source: 'digraph f { graph [kind="line"] }', nodes: [{ id: "start", label: "start", type: "start" }, { id: "fix", label: "Fix findings", type: "agent", backend: "subject" }], edges: [{ from: "start", to: "fix" }] } as any) as any;
    expect(f.nodes.find((n: any) => n.id === "fix").backend).toBe("subject");
  });

  test("a PR GitHub already merged: never Ship again, and the Merged chip shows", () => {
    const r = run({ status: "failed", current_node_id: "nopr", fail_reason: "Stopped: gh pr create failed", pr: { number: 2, repository: "acme/app", head_sha: "3a9ba96" }, node_statuses: [st("pr", "failed", 1), st("merge", "failed", 8), st("fix_conflict", "completed", 9), st("nopr", "failed", 10)] });
    const pr = { merged: true, merge_sha: "f00dbabe12" };
    expect(act(r, change, { pr })?.kind).not.toBe("again");
    expect(changeLinks(r, change, [], pr).find((l) => l.kind === "merged")).toMatchObject({ label: "Merged f00dbab", href: "/commit/acme/app/f00dbabe12" });
  });

  test("a stop at Deploy opens Deploys", () => {
    const r = run({ status: "failed", current_node_id: "deploy__failed", merge: { sha: "31ccbb83b1" }, fail_reason: "Stopped: Deploy stuck", node_statuses: [...MERGED, st("deploy__wait", "failed", 16)] });
    expect(act(r)?.kind).toBe("deploys");
  });

  test("every recorded personal stop offers one way on, and none offers Ship again once the change is on main", () => {
    let stops = 0;
    for (const name of scenarios()) {
      let r: any;
      try { r = { workspace: "user:u1", spawner_conversation_id: "subj", ...end(replay(name)) }; } catch { continue; }
      if (r.status !== "failed") continue;
      stops++;
      const j = journeyOf(personal, r, [], null);
      const a = changeAction(j, r, personal, {});
      expect(a, name).not.toBeNull();
      const n = j.now as any;
      if (n.landed || n.mayHaveLanded || r.merge?.sha) expect(a!.kind, name).not.toBe("again");
      if (n.fix === "run") expect(a!.kind, name).not.toBe("again");
    }
    expect(stops).toBeGreaterThan(10);
  });

  test("with no session, the card the run asked", () => {
    expect(act(stopped({ spawner_conversation_id: null, gate_decision_short_id: "sd-3" }))).toMatchObject({ kind: "card", href: "/decisions/sd-3" });
  });
});

describe("changeLinks", () => {
  test("a live change links its PR, CI, review, merged commit and every deploy", () => {
    expect(changeLinks(liveRun, change).map((l) => [l.kind, l.label, l.href, l.tone])).toEqual([
      ["pr", "PR #217", "/pr/acme/app/217", "default"],
      ["ci", "CI green", "https://github.com/acme/app/pull/217/checks", "ok"],
      ["review", "Review passed", "/conversation/convReview", "ok"],
      ["merged", "Merged 31ccbb8", "/commit/acme/app/31ccbb83b1", "ok"],
      ["deploy", "web dp-3237", expect.stringContaining("dp-3237"), "ok"],
      ["deploy", "cli dp-3247", expect.stringContaining("dp-3247"), "ok"],
      ["deploy", "mobile dp-3238", expect.stringContaining("dp-3238"), "ok"],
    ]);
  });

  test("Union's nested stations, and the deploy line inside its Deploy segment", () => {
    const r = run({ status: "completed", current_node_id: "exit", merge: { sha: "5caaa346ac" }, node_statuses: [...U_ROUND, st("land__merge", "completed", 7, { result_preview: '{"sha":"5caaa346ac","pr":5016}' }), st("land__landed", "completed", 8), st("deploy", "completed", 9), st("deploy__wait", "completed", 10, { result_preview: "Live: 5caaa34 on backend dp-12." }), st("deploy__live", "completed", 11, { result_preview: '{"exit": "live"}' })] });
    expect(changeLinks(r, union).map((l) => `${l.kind}:${l.label}`)).toEqual(["pr:PR #5016", "ci:CI", "review:Review", "merged:Merged 5caaa34", "deploy:backend dp-12"]);
  });

  test("a run reads the reach its merged PR's page reads, else its landed commit's", () => {
    const pr = { repository: "Acme/App", number: 217 };
    expect(changeReachRef(pr, true, "31ccbb83b1")).toBe("acme/app#217");
    expect(changeReachRef(pr, false, "31ccbb83b1")).toBe("acme/app@31ccbb83b1");
    expect(changeReachRef(pr, true, null)).toBeNull();
    expect(changeReachRef(null, false, "31ccbb83b1")).toBeNull();
  });

  test("the deploy records say each target's state; a waiting target opens Deploys at the change", () => {
    const links = changeLinks(liveRun, change, [{ name: "web", state: "live" }, { name: "backend", state: "waiting" }]);
    expect(links.filter((l) => l.kind === "deploy").map((l) => [l.label, l.tone])).toEqual([["web dp-3237", "ok"], ["backend waiting", "default"]]);
    expect(links.find((l) => l.label === "backend waiting")!.href).toBe("/deploys?team=t1&target=backend&sha=31ccbb83b1");
    // A deploy's chip opens the change on that target with the deploy open beside it (the phone reads it as that deploy).
    expect(links.find((l) => l.label === "web dp-3237")!.href).toBe("/deploys?team=t1&target=web&sha=31ccbb83b1&deploy=dp-3237");
  });

  test("a live chip names reach's deploy (the first live one holding the change, or the redeploy after a rollback); the run's line fills only one reach leaves unnamed", () => {
    const r = { ...liveRun, node_statuses: [...MERGED, st("deploy__wait", "completed", 16, { result_preview: "Live: 08c639d on web dp-3447, cli dp-3456, mobile dp-3448." })] };
    // A rollback then a redeploy: reach names the deploy live now, not the one the run saw.
    const reach = [{ name: "web", state: "live" as const, deploy: "dp-3510" }, { name: "mobile", state: "live" as const }, { name: "api", state: "live" as const, deploy: "dp-3500" }];
    expect(changeLinks(r, change, reach).filter((l) => l.kind === "deploy").map((l) => l.label)).toEqual(["web dp-3510", "mobile dp-3448", "api dp-3500"]);
    // A target reach no longer finds live (rolled back, failed) keeps reach's word: the run's line is history, not the state.
    expect(changeLinks(r, change, [{ name: "web", state: "failed", deploy: "dp-3460" }]).filter((l) => l.kind === "deploy").map((l) => [l.label, l.tone])).toEqual([["web dp-3460", "bad"]]);
  });

  test("the PR page's review: the run's verdict on the PR's head, or on the head Merge only rebased to make it", () => {
    const r = { review_verdict: { verdict: "ship", head_sha: "f081d05" }, station_rebases: [{ from: "f081d05", to: "9a9a9a9" }] };
    expect(reviewOnHead(r, "f081d05")).toEqual({ label: "Review passed", tone: "ok" });
    expect(reviewOnHead(r, "9a9a9a9")).toEqual({ label: "Review passed", tone: "ok" });
    // A head pushed after the review (a fix) is not judged yet; no verdict, no head, or an unknown verdict says nothing.
    expect(reviewOnHead(r, "1234567")).toBeNull();
    expect(reviewOnHead({ review_verdict: { verdict: "changes", head_sha: "abc" } }, "abc")).toEqual({ label: "Review asked for changes", tone: "wait" });
    expect(reviewOnHead({ review_verdict: { verdict: "huh", head_sha: "abc" } }, "abc")).toBeNull();
    expect(reviewOnHead(null, "abc")).toBeNull();
    expect(reviewOnHead(r, null)).toBeNull();
  });

  test("no review session, no review link: a label with nowhere to go is not drawn", () => {
    expect(changeLinks(run({ node_statuses: [PR, st("review", "completed", 3)] }), change).some((l) => l.kind === "review")).toBe(false);
  });
});

describe("changePr / deployLine", () => {
  test("the PR from the row, else the newest step that reported one, else the merge's link", () => {
    expect(changePr(liveRun)).toEqual({ repository: "acme/app", number: 217 });
    expect(changePr(run({ node_statuses: [U_PR] }))).toEqual({ repository: "Union-AI/union-mobile", number: 5016 });
    expect(changePr(run({ merge: { sha: "x", pr_url: "https://github.com/acme/app/pull/9" } }))).toEqual({ repository: "acme/app", number: 9 });
    expect(changePr(run({}))).toBeNull();
  });
  test("the Deploy line that names targets, never its exit's JSON", () => {
    expect(deployLine(liveRun, changeStations(change))).toBe(LIVE_LINE);
  });
});

test("a review the run gave on a head Merge only rebased still reads on the rebased head", () => {
  const r = run({ pr: { number: 217, repository: "acme/app", head_sha: "bbbbbbb" }, review_verdict: { verdict: "ship", head_sha: "aaaaaaa" }, station_rebases: [{ from: "aaaaaaa", to: "bbbbbbb" }], node_statuses: ROUND });
  const review = (x: any) => changeLinks(x, change).find((l) => l.kind === "review")?.label;
  expect(review(r)).toBe(changeLinks(run({ ...r, pr: { ...r.pr, head_sha: "aaaaaaa" }, station_rebases: [] }), change).find((l) => l.kind === "review")?.label);
  expect(review(r)).not.toBe("Review");
  expect(review({ ...r, station_rebases: [] })).toBe("Review");
});

describe("pl-1077 polish 3: a run back at an earlier stage says why; a stage it went past unentered is skipped", () => {
  // Codecast's Change: Local CI before PR, and the session's conflict fix sends the change back through it.
  const withLocal = {
    ...change,
    nodes: [...change.nodes, { id: "local_ci", label: "Local CI", type: "command", shape: "parallelogram" }],
    edges: [...change.edges.filter((e: any) => !(e.from === "start" && e.to === "pr") && !(e.from === "fix_conflict" && e.to === "pr")), { from: "start", to: "local_ci" }, { from: "local_ci", to: "pr" }, { from: "fix_conflict", to: "local_ci" }],
  };
  const conflicted = [st("start", "completed", 0), st("local_ci", "running", 20), ...ROUND, verdicts("merge", "green", "ship"), st("merge", "failed", 14, { result_preview: "conflicts with main in a.ts" }), st("fix_conflict", "completed", 15)];

  test("Local CI again after Merge's conflict was fixed: the headline names the fix that sent it back", () => {
    const r = run({ current_node_id: "local_ci", node_statuses: conflicted });
    const h = head(r, null, withLocal);
    expect(h.words).toBe("Local CI");
    expect(h.waits).toBe("Checking again after the session's fix (Resolve conflict)");
  });

  test("PR again after the session fixed what the review found", () => {
    const r = run({ current_node_id: "pr", node_statuses: [st("start", "completed", 0), st("pr", "running", 20), ...ROUND.slice(1), verdicts("brief", "green", "changes"), st("brief", "completed", 15)] });
    expect(head(r).waits).toBe("Checking again after the session's fix (Fix findings)");
  });

  test("a first pass says nothing more than where it is", () => {
    expect(head(run({ current_node_id: "local_ci", node_statuses: [st("start", "completed", 0), st("local_ci", "running", 1)] }), null, withLocal).waits).toBeNull();
    expect(head(run({ current_node_id: "merge", node_statuses: [...ROUND, verdicts("merge", "green", "ship"), st("merge", "running", 14)] })).waits).toBeNull();
  });

  test("a run that started past Local CI (it predates the station) reads it skipped, never ahead", () => {
    const r = run({ status: "failed", current_node_id: "deploy__failed", fail_reason: "Stopped: The deploy that carried 31ccbb8 failed: cli dp-9 (Stopped at Send.).", node_statuses: [st("start", "completed", 0), ...MERGED, st("deploy__wait", "failed", 16), st("deploy__failed", "failed", 17)] });
    const stages = journeyOf(withLocal as any, r).stages;
    expect(stages.find((s) => s.id === "local_ci")?.state).toBe("skipped");
    expect(stages.find((s) => s.id === "pr")?.state).toBe("done");
    // One that has not reached it yet still reads it ahead.
    expect(journeyOf(withLocal as any, run({ current_node_id: "local_ci", node_statuses: [st("start", "completed", 0), st("local_ci", "running", 1)] })).stages.find((s) => s.id === "pr")?.state).toBe("idle");
  });
});

describe("pl-1077 polish 6: a change someone else merged reads landed; a merge handed to its role; carried; earlier reviews", () => {
  // ct-102786's shape: CI green and review ship, Merge refused (merge off), the run ended at Not merged, and a person
  // merged PR #349 on GitHub.
  const offReason = "Stopped: merge is off for this flow; a person turns it on with cast role line --merge on";
  const stopped = run({ status: "failed", current_node_id: "unshipped", fail_reason: offReason, pr: { number: 349, repository: "acme/app", head_sha: "98faff16d9" }, ci_verdict: { green: true, head_sha: "98faff16d9" }, review_verdict: { verdict: "ship", head_sha: "98faff16d9" }, node_statuses: [...ROUND, verdicts("merge", "green", "ship"), st("merge", "failed", 14, { result_preview: "merge is off for this flow" }), st("unshipped", "failed", 15)] });
  const pr = { merged: true, merge_sha: "fec4c95767" };
  const live = [{ name: "cli", state: "live", deploy: "dp-3934" }, { name: "mobile", state: "live", deploy: "dp-3939" }, { name: "web", state: "live", deploy: "dp-3933" }] as any;
  const states = (j: any) => Object.fromEntries(j.stages.map((x: any) => [x.id, x.state]));

  test("H1: PR merged on GitHub: Merged by someone else, live where reach says, no red stop, and the strip from the facts", () => {
    const j = changeJourney(change, stopped, live, null, { pr });
    expect(j.outside).toEqual({ sha: "fec4c95767" });
    expect(changeHeadline(j, stopped, change, { pr, targets: live })).toEqual({ words: "Merged by someone else", waits: "Live on cli, mobile and web", tone: "ok" });
    const s = states(j);
    expect(Object.values(s)).not.toContain("stopped");
    expect([s.merge, s.deploy, s.live]).toEqual(["done", "done", "done"]);
    expect(j.now.kind).toBe("live");
    expect(endedStages(j, stopped, change)).toBe(j.stages);
    expect(changeAction(j, stopped, change, { pr, targets: live })).toBeNull();
  });

  test("H1: going out and waiting targets read per target; the bar opens Deploys at the one not live", () => {
    const some = [{ name: "web", state: "live", deploy: "dp-3933" }, { name: "cli", state: "deploying", deploy: "dp-3934" }, { name: "mobile", state: "waiting" }] as any;
    const j = changeJourney(change, stopped, some, null, { pr });
    expect(changeHeadline(j, stopped, change, { pr, targets: some }).waits).toBe("Live on web · going out to cli in dp-3934 · waiting to deploy to mobile");
    expect(states(j).deploy).toBe("active");
    expect(states(j).live).toBe("idle");
    expect(changeAction(j, stopped, change, { pr, targets: some })?.kind).toBe("deploys");
    // Reach not answered and nothing cached: it says it is reading, never a guess; a cached answer paints at once.
    const reading = changeJourney(change, stopped, [], null, { pr, reading: true });
    expect(changeHeadline(reading, stopped, change, { pr, targets: [], reading: true }).waits).toBe("Reading where it is live");
    expect(changeHeadline(j, stopped, change, { pr, targets: some, reading: true }).waits).toMatch(/^Live on web/);
  });

  test("H1: the server's healed record reads the same, naming who merged it; Live once completed at Live", () => {
    const healed = { ...stopped, merge: { sha: "fec4c95767", outside: true, by: "ashot" }, fail_reason: "Merged by someone else: #349 merged as fec4c95 by ashot; going live." };
    const j = changeJourney(change, healed, live, null, {});
    expect(changeHeadline(j, healed, change, { targets: live })).toMatchObject({ words: "Merged by ashot", waits: "Live on cli, mobile and web" });
    expect(Object.values(states(j))).not.toContain("stopped");
    const done = { ...healed, status: "completed", current_node_id: "exit", fail_reason: null, node_statuses: [...healed.node_statuses, st("deploy__wait", "completed", 20, { result_preview: "Live: fec4c95 on cli dp-3934." }), st("deploy__live", "completed", 21, { result_preview: '{"exit": "live"}' })] };
    const jd = changeJourney(change, done, live, null, {});
    expect(jd.outside).toBeUndefined();
    expect(changeHeadline(jd, done, change, { targets: live }).words).toMatch(/^Live on/);
  });

  test("H1: a run that landed its own change and then stopped keeps its own reading", () => {
    const own = run({ status: "failed", current_node_id: "deploy__failed", merge: { sha: "31ccbb83b1" }, fail_reason: "Stopped: Deploy stuck", node_statuses: [...MERGED, st("deploy__wait", "failed", 16)] });
    expect(changeJourney(change, own, [], null, { pr: { merged: true, merge_sha: "31ccbb83b1" } }).outside).toBeUndefined();
  });

  test("H1: a newer run on the task that merged the same PR keeps Open the newer run and says so, never someone else", () => {
    const older = { ...stopped, _id: "run1", created_at: 1 };
    const newerRun = run({ _id: "run2", created_at: 2, status: "completed", current_node_id: "exit", pr: { number: 349, repository: "acme/app" }, merge: { sha: "fec4c95767" } });
    const otherPr = run({ _id: "run3", created_at: 3, status: "completed", pr: { number: 400, repository: "acme/app" }, merge: { sha: "abc" } });
    const unmerged = run({ _id: "run4", created_at: 4, status: "failed", pr: { number: 349, repository: "acme/app" } });
    expect(newerMergedRun(older, [newerRun, otherPr, unmerged])).toBe("run2");
    expect(newerMergedRun(older, [otherPr, unmerged])).toBeNull();
    // An earlier run that merged it is not a newer one.
    expect(newerMergedRun({ ...older, created_at: 9 }, [newerRun])).toBeNull();
    const j = changeJourney(change, older, live, null, { pr, newerMerged: "run2" });
    expect(j.outside).toBeUndefined();
    expect(changeHeadline(j, older, change, { pr, targets: live, newerMerged: "run2" })).toEqual({ words: "A newer run merged it", waits: null, tone: "ok" });
    expect(changeAction(j, older, change, { pr, newer: "run2", targets: live })).toEqual({ kind: "newer", label: "Open the newer run", href: "/workflows/runs/run2" });
    // With no newer run that merged it, the same stop reads as someone else's merge.
    expect(changeJourney(change, older, live, null, { pr, newerMerged: null }).outside).toEqual({ sha: "fec4c95767" });
  });

  test("H3: a merge handed to its role reads neutral, names the role and opens it; its merge-off words name it too", () => {
    const handed = run({ status: "completed", current_node_id: "handed", pr: { number: 9, repository: "acme/app", head_sha: "abc1234" }, node_statuses: [...ROUND, verdicts("merge", "green", "ship"), st("merge", "completed", 14, { result_preview: "Merge is @release's: handed to it." }), st("handed", "completed", 15)] });
    expect(handedTo(handed)).toBe("release");
    expect(mergeHolder(handed)).toBe("release");
    expect(changeHeadline(journeyOf(change, handed), handed, change)).toEqual({ words: "Handed to @release", waits: "Waiting for @release to merge it", tone: "idle" });
    expect(changeAction(journeyOf(change, handed), handed, change, { mergeRole: "or-7" })).toEqual({ kind: "merge_switch", label: "Open @release", href: "/org/or-7" });
    // Once the role merged it, the run is the merge's, not the hand-off's.
    expect(handedTo({ ...handed, merge: { sha: "f00d", outside: true } })).toBeNull();
    // GitHub merged the handed PR before the server's heal: it reads landed, not still waiting on the role.
    const ghMerged = changeJourney(change, handed, live, null, { pr: { merged: true, merge_sha: "f00dbabe12" } });
    expect(ghMerged.outside).toEqual({ sha: "f00dbabe12" });
    expect(changeHeadline(ghMerged, handed, change, { targets: live })).toMatchObject({ words: "Merged by someone else", waits: "Live on cli, mobile and web" });
    expect(changeAction(ghMerged, handed, change, { mergeRole: "or-7", targets: live })).toBeNull();
    expect(endedStages(ghMerged, handed, change)).toBe(ghMerged.stages);
    const refused = run({ ...stopped, fail_reason: "Stopped: @release's merge is off: `cast role line @release --merge on` lets its hands merge" });
    expect(mergeIsOff(refused)).toBe(true);
    expect(mergeHolder(refused)).toBe("release");
    expect(changeHeadline(journeyOf(change, refused), refused, change).waits).toBe("@release's merge is off");
    // The line flow's merge says it after "merge left to a person: ", and an older CLI's stop carried the old words:
    // both read as merge off from the one matcher every reader shares (contracts/mergeOff.ts).
    const left = run({ ...stopped, fail_reason: "Stopped: merge left to a person: @release's merge is off: `cast role line @release --merge on` lets its hands merge" });
    expect(mergeIsOff(left)).toBe(true);
    expect(mergeHolder(left)).toBe("release");
    expect(changeAction(journeyOf(change, left), left, change, { mergeRole: "or-7", targets: live })).toMatchObject({ kind: "merge_switch", label: "Turn merge on" });
    const older = run({ ...stopped, fail_reason: "Stopped: merge left to a person: merge is off for this flow; a person turns it on with cast role line --merge on" });
    expect(mergeIsOff(older)).toBe(true);
    expect(mergeHolder(older)).toBeNull();
  });

  test("M1: Local CI red that the run carried past reads amber, never done", () => {
    const withLocal = {
      ...change,
      nodes: [...change.nodes, { id: "local_ci", label: "Local CI", type: "command", shape: "parallelogram" }],
      edges: [...change.edges.filter((e: any) => !(e.from === "start" && e.to === "pr")), { from: "start", to: "local_ci" }, { from: "local_ci", to: "pr" }],
    };
    const r = run({ current_node_id: "checks", node_statuses: [st("start", "completed", 0), st("local_ci", "completed", 1, { outcome: "carried", result_preview: "red in 921s\nStill red: the pull request opens" }), PR, st("checks", "running", 2)] });
    const j = journeyOf(withLocal as any, r);
    const local = j.stages.find((x) => x.id === "local_ci")!;
    expect(local.state).toBe("carried");
    expect(local.steps?.find((x) => x.id === "local_ci")?.carried).toBe(true);
    // A green Local CI stays done.
    const green = run({ current_node_id: "checks", node_statuses: [st("start", "completed", 0), st("local_ci", "completed", 1, { outcome: "success" }), PR, st("checks", "running", 2)] });
    expect(journeyOf(withLocal as any, green).stages.find((x) => x.id === "local_ci")!.state).toBe("done");
  });

  test("M3: a review on a head the PR moved past says which head, with the reviewer's session", () => {
    const r = { review_verdict: { verdict: "ship", head_sha: "a5a6b73ab9" }, node_statuses: [st("review", "completed", 3, { session: { _id: "jx71qnd" } })] };
    expect(reviewEarlier(r, "6f6af8889a")).toEqual({ label: "Reviewed an earlier head (a5a6b73)", sha: "a5a6b73", session: "jx71qnd" });
    expect(reviewEarlier(r, "a5a6b73ab9")).toBeNull();
    // A rebase Merge made carries the verdict over: it is this head's review.
    expect(reviewEarlier({ ...r, station_rebases: [{ from: "a5a6b73ab9", to: "6f6af8889a" }] }, "6f6af8889a")).toBeNull();
    expect(reviewEarlier({ node_statuses: [] }, "6f6af8889a")).toBeNull();
  });
});
