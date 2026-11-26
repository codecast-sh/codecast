import { describe, expect, test } from "bun:test";
import { journeyOf } from "../journey";
import { changeHeadline, changeLinks, changePr, changeStations, deployLine, shortWhy } from "../changePage";
import { UNION_CHANGE_FLOW } from "../journeyFixtures";
import { pushedFlow } from "../../line/flowPool";
// The library change flow, parsed with its segments expanded (bun packages/cli/scripts/gen-change-graph-fixture.ts).
import graph from "./changeGraph.fixture.json";

// Node statuses as the runner reports them (runner.ts), as in journey.test.ts.
const change = graph as any;
// Union's Change: PR, CI, review and merge inside its Land segment (land__pr, land__ci, …), then a Deploy segment.
const union = pushedFlow({ _id: "wf_union", ...UNION_CHANGE_FLOW } as any) as any;
const ME = "u1";
const run = (over: Record<string, unknown>) => ({ status: "running", workspace: "team:t1", node_statuses: [], ...over }) as any;
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

describe("changeStations", () => {
  test("CI, Review and Deploy by what they are, at the top level or inside a segment", () => {
    const top = changeStations(change);
    expect([...top.ci]).toEqual(["ci"]);
    expect([...top.review]).toEqual(["review"]);
    expect(top.deploy.has("deploy__wait")).toBe(true);
    const nested = changeStations(union);
    // Union's CI alone (a round with no review) is CI under the same name.
    expect([...nested.ci].sort()).toEqual(["land__ci", "land__ci_alone"]);
    expect([...nested.review]).toEqual(["land__review"]);
    expect(nested.deploy.has("deploy__wait")).toBe(true);
  });
});

describe("changeHeadline", () => {
  const head = (r: any, viewer: any = null, g: any = change) => changeHeadline(journeyOf(g, r, [], viewer), r, g);

  test("a live change names the targets that carry it, and waits on nothing", () => {
    expect(head(liveRun)).toEqual({ words: "Live on web, cli and mobile", waits: null, href: null, tone: "ok" });
  });

  test("CI red sent back to the session: the finding, then the fix it waits on with its round", () => {
    const r = run({ current_node_id: "brief", ci_verdict: { green: false }, review_verdict: { verdict: "ship" }, waiting_on_session: { node_id: "brief", conversation_id: "c1", since: 30, note: "fix CI" }, node_statuses: [...ROUND, verdicts("brief", "red", "ship"), st("brief", "running", 20, { visits: 2 })] });
    expect(head(r)).toEqual({ words: "CI red", waits: "Waiting on its session's fix, round 2 of 3", href: "/conversation/c1", tone: "bad" });
    const both = { ...r, review_verdict: { verdict: "changes" } };
    expect(head(both).words).toBe("CI red, review asked for changes");
  });

  test("Union's review asks for changes inside Land: the way out it took names the finding, and the fix waits on its session", () => {
    const r = run({ current_node_id: "fix", spawner_conversation_id: "subj", node_statuses: [...U_ROUND, st("land__brief", "completed", 7, { result_preview: "## The reviewer asked for changes - medium x" }), st("land__changes", "failed", 8, { result_preview: '{"exit": "changes"}' }), st("fix", "running", 9)] });
    expect(head(r, null, union)).toMatchObject({ words: "Changes asked", waits: "Waiting on its session's fix", href: "/conversation/subj" });
  });

  test("the viewer's own card: waiting on your decision (the card under it asks); someone else's names its question", () => {
    const r = run({ status: "paused", user_id: ME, current_node_id: "decide__decide", gate_node_id: "decide__decide", gate_decision_id: "d1", gate_prompt: "Ship ct-1? It edits CI.\nmore", gate_decision_status: "pending", node_statuses: [...ROUND, verdicts("decide", "green", "ship"), st("decide__decide", "running", 15)] });
    const viewer = { id: ME, decision: { user_id: ME, holder: { kind: "user", id: ME }, asked_user_ids: [ME] } };
    expect(head(r, viewer)).toEqual({ words: "Waiting on your decision", waits: null, href: null, tone: "you" });
    expect(head({ ...r, gate_decision_short_id: "sd-9" }, { id: "u2", decision: viewer.decision })).toMatchObject({ words: "Waiting for approval", waits: "Ship ct-1? It edits CI.", href: "/decisions/sd-9" });
  });

  test("the session asks the viewer: waiting on your answer, with the question", () => {
    const r = run({ current_node_id: "brief", waiting_on_session: { node_id: "brief", conversation_id: "c1", since: 30, note: "keep the old flag?", blocked: true }, node_statuses: [...ROUND, verdicts("brief", "green", "changes"), st("brief", "running", 20, { visits: 1 })] });
    const ask = { id: "d1", short_id: "sd-7", question: "Keep the old flag?", mine: true, open: true };
    // The viewer's own card is answered on the page (the bar under the head); someone else's opens.
    expect(head(r, { id: ME, ask })).toMatchObject({ words: "Waiting on your answer", waits: "Keep the old flag?", href: null });
    expect(head(r, { id: ME, ask: { ...ask, mine: false } })).toMatchObject({ words: "Waiting for a person", waits: "Keep the old flag?", href: "/decisions/sd-7" });
    // An ask in words only: its session.
    expect(head(r, { id: ME, ask: null })).toMatchObject({ waits: "keep the old flag?", href: "/conversation/c1" });
  });

  test("merged and held at Deploy: the sha, then what Deploy waits on", () => {
    const r = run({ current_node_id: "deploy__wait", merge: { sha: "31ccbb83b1", at: 9 }, node_statuses: [...MERGED, st("deploy__wait", "running", 16, { result_preview: "web: waiting on main CI at 31ccbb8 (running)" })] });
    expect(head(r)).toMatchObject({ words: "Merged 31ccbb8", waits: "Waiting on main CI", href: "/deploys?team=t1&sha=31ccbb83b1" });
  });

  test("a stop names the station it stopped at and a short reason; the raw error stays out of the head", () => {
    // ct-98570's sibling: Merge's rebase failed with git's whole output.
    const raw = "Stopped: git rebase failed: packages/cli/src/a.md | packages/cli/src/b.md | Please move or remove them before you switch branches. | Aborting | error: could not detach HEAD";
    const r = run({ status: "failed", current_node_id: "unshipped", fail_reason: raw, node_statuses: [...ROUND, verdicts("merge", "green", "ship"), st("merge", "failed", 14, { result_preview: "git rebase failed: packages/cli/src/a.md | Aborting" }), st("unshipped", "failed", 15)] });
    expect(head(r)).toMatchObject({ words: "Stopped at Merge", waits: "git rebase failed", tone: "bad" });
    // A Deploy stop opens Deploys.
    const d = run({ status: "failed", current_node_id: "deploy__failed", merge: { sha: "31ccbb83b1" }, fail_reason: "Stopped: Deploy stuck: cli is not live with 31ccbb8 after 45m.", node_statuses: [...MERGED, st("deploy__wait", "failed", 16)] });
    expect(head(d)).toMatchObject({ words: "Stopped at Go live", waits: "Deploy stuck", tone: "bad" });
    expect(head(d).href).toStartWith("/deploys?team=t1");
  });

  test("Union's stops inside Land name the station, never the segment", () => {
    // ct-102041's sibling: the PR could not be opened.
    const pr = run({ status: "failed", current_node_id: "stopped", fail_reason: "Stopped: The pull request could not be opened: line: origin's branch holds commits this checkout never had; send it again", node_statuses: [st("start", "completed", 1), st("land", "completed", 2), st("land__pr", "failed", 3, { result_preview: "line: origin's branch holds commits" }), st("land__unpushed", "failed", 4, { result_preview: '{"exit": "unpushed"}' }), st("stopped", "failed", 5)] });
    expect(head(pr, null, union)).toMatchObject({ words: "Stopped at PR", waits: "The pull request could not be opened" });
    // Only the way out failed (CI could not be read): its name says the outcome.
    const unread = run({ status: "failed", current_node_id: "stopped", fail_reason: "Stopped: GitHub's CI could not be read, so the change is not judged: required check test was cancelled again on f6b21d25dd", node_statuses: [...U_ROUND, st("land__unread", "failed", 8, { result_preview: '{"exit": "unread"}' }), st("stopped", "failed", 9)] });
    expect(head(unread, null, union)).toMatchObject({ words: "Stopped: CI unread", waits: "GitHub's CI could not be read, so the change is not judged" });
    // A way out its graph already names as an end reads whole, never "Stopped: not merged: …".
    const named = { ...union, nodes: union.nodes.map((n: any) => (n.id === "land__unread" ? { ...n, label: "Not merged: CI unread" } : n)) };
    expect(head(unread, null, named).words).toBe("Not merged: CI unread");
  });

  test("an earlier round's failure is not this stop", () => {
    const r = run({ status: "failed", current_node_id: "stopped", fail_reason: "Stopped: The pull request could not be opened: x", node_statuses: [...U_ROUND, st("land__changes", "failed", 7, { result_preview: '{"exit": "changes"}' }), st("fix", "completed", 8), st("land__pr", "failed", 10, { result_preview: "push refused" }), st("land__unpushed", "failed", 11, { result_preview: '{"exit": "unpushed"}' }), st("stopped", "failed", 12)] });
    expect(head(r, null, union).words).toBe("Stopped at PR");
  });

  test("CI and review under way: the stage, nothing named past it", () => {
    const r = run({ current_node_id: "ci", node_statuses: [PR, st("checks", "completed", 2), st("ci", "running", 3), st("review", "running", 3)] });
    expect(head(r).words).toBe("In CI and review");
  });
});

describe("shortWhy", () => {
  test("the clause before the detail, never a joined log", () => {
    expect(shortWhy("Stopped: git rebase failed: a.md | b.md | Aborting")).toBe("git rebase failed");
    expect(shortWhy("CI is red on main.")).toBe("CI is red on main");
    expect(shortWhy(null)).toBeNull();
    expect(shortWhy("x".repeat(30) + " " + "word ".repeat(40))!.length).toBeLessThanOrEqual(101);
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

  test("Union's nested stations: the PR, CI and review inside Land, and the deploy line inside its Deploy segment", () => {
    const r = run({ status: "completed", current_node_id: "exit", merge: { sha: "5caaa346ac" }, node_statuses: [...U_ROUND, st("land__merge", "completed", 7, { result_preview: '{"sha":"5caaa346ac","pr":5016}' }), st("land__landed", "completed", 8), st("deploy", "completed", 9), st("deploy__wait", "completed", 10, { result_preview: "Live: 5caaa34 on backend dp-12." }), st("deploy__live", "completed", 11, { result_preview: '{"exit": "live"}' })] });
    expect(changeLinks(r, union).map((l) => `${l.kind}:${l.label}`)).toEqual(["pr:PR #5016", "ci:CI", "review:Review", "merged:Merged 5caaa34", "deploy:backend dp-12"]);
    const running = run({ node_statuses: [U_PR, st("land__checks", "completed", 4), st("land__ci", "running", 5), st("land__review", "running", 5, { session: { _id: "convUR" } })] });
    expect(changeLinks(running, union).map((l) => `${l.kind}:${l.label}`)).toEqual(["pr:PR #5016", "ci:CI running", "review:In review"]);
  });

  test("CI green on a change that edits CI is shown, but not as a pass", () => {
    const r = run({ ci_verdict: { green: true, ci_changed: true }, review_verdict: { verdict: "ship" }, node_statuses: ROUND });
    expect(changeLinks(r, change).find((l) => l.kind === "ci")).toMatchObject({ label: "CI green, not counted", tone: "default", title: "This change edits CI, so CI can't vouch for it" });
    // Read from the verdicts step when the row carries no verdict.
    const said = run({ node_statuses: [...ROUND, verdicts("decide", "green", "ship", 13, { ci_result: { green: true, ci_changed: true } })] });
    expect(changeLinks(said, change).find((l) => l.kind === "ci")!.label).toBe("CI green, not counted");
  });

  test("the deploy records win over the station's line; a waiting target opens Deploys at the change", () => {
    const links = changeLinks(liveRun, change, [{ name: "web", state: "live", deploy: "dp-9" }, { name: "backend", state: "waiting" }]);
    expect(links.filter((l) => l.kind === "deploy").map((l) => [l.label, l.tone])).toEqual([["web dp-9", "ok"], ["backend waiting", "default"]]);
    expect(links.find((l) => l.label === "backend waiting")!.href).toBe("/deploys?team=t1&target=backend&sha=31ccbb83b1");
  });

  test("before anything merges: the PR from the station's report, CI and review as they stand, no merge or deploys", () => {
    const r = run({ current_node_id: "ci", node_statuses: [PR, st("checks", "completed", 2), st("ci", "running", 3), st("review", "running", 3, { session: { _id: "convR" } })] });
    expect(changeLinks(r, change).map((l) => `${l.kind}:${l.label}`)).toEqual(["pr:PR #217", "ci:CI running", "review:In review"]);
  });

  test("CI red and review asking for changes read as their verdicts", () => {
    const r = run({ ci_verdict: { green: false }, review_verdict: { verdict: "changes" }, node_statuses: ROUND });
    expect(changeLinks(r, change).map((l) => `${l.label}:${l.tone}`)).toEqual(["PR #217:default", "CI red:bad", "Review asked for changes:wait"]);
  });

  test("no review session, no review link: a label with nowhere to go is not drawn", () => {
    const r = run({ node_statuses: [PR, st("review", "completed", 3)] });
    expect(changeLinks(r, change).some((l) => l.kind === "review")).toBe(false);
  });
});

describe("changePr / deployLine", () => {
  test("the PR from the row, else the newest step that reported one, else the merge's link", () => {
    expect(changePr(liveRun)).toEqual({ repository: "acme/app", number: 217 });
    expect(changePr(run({ node_statuses: [PR] }))).toEqual({ repository: "acme/app", number: 217 });
    expect(changePr(run({ node_statuses: [U_PR] }))).toEqual({ repository: "Union-AI/union-mobile", number: 5016 });
    expect(changePr(run({ merge: { sha: "x", pr_url: "https://github.com/acme/app/pull/9" } }))).toEqual({ repository: "acme/app", number: 9 });
    expect(changePr(run({}))).toBeNull();
  });
  test("the Deploy line that names targets, never its exit's JSON", () => {
    expect(deployLine(liveRun, changeStations(change))).toBe(LIVE_LINE);
  });
});
