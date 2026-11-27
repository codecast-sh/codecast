import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { changeVerdicts } from "./changeVerdicts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cast-verdicts-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

let n = 0;
/** A run directory holding these files; a string is written as it is, anything else as JSON. */
function dir(files: Record<string, unknown>): string {
  const d = path.join(root, String(++n));
  fs.mkdirSync(d);
  for (const [name, v] of Object.entries(files)) fs.writeFileSync(path.join(d, name), typeof v === "string" ? v : JSON.stringify(v));
  return d;
}
const read = (d: string, f: string) => (fs.existsSync(path.join(d, f)) ? JSON.parse(fs.readFileSync(path.join(d, f), "utf-8")) : null);

const PR = { url: "u", number: 7, head_sha: "abc", branch: "feat", round: "r2" };
const GREEN = { green: true, head_sha: "abc", failing: [], preexisting: [], timed_out: false, pending: [], blocked_by_main: false, ci_changed: false };
const FAILURE = { job: "test-cli", test: "a", assertion: "expected good", file: "a.ts", line: 1, excerpt: "x" };
// As the CI station writes its own entry: the reason is the excerpt.
const STATION = { job: "ci-station", test: null, assertion: null, file: null, line: null, excerpt: "CI did not finish within 60m: test-web still running." };
const RED = { ...GREEN, green: false, failing: [FAILURE] };
const pin = (v: object) => JSON.stringify({ round: "r2", head_sha: "abc", findings: [], ...v });
const SHIP = pin({ verdict: "ship" });
// null: the reviewer pinned nothing.
const verdicts = (files: Record<string, unknown>, review: string | null = SHIP) => changeVerdicts(dir({ "pr.json": PR, ...files }), review ?? undefined);

describe("changeVerdicts", () => {
  test("only green CI on the pushed head and this round's ship merge, and review.json then holds that pin", () => {
    const d = dir({ "pr.json": PR, "ci.json": GREEN });
    expect(changeVerdicts(d, SHIP)).toMatchObject({ ci: "green", review: "ship", next: "merge" });
    expect(read(d, "review.json")).toEqual({ verdict: "ship", findings: [], round: "r2", head_sha: "abc" });
  });

  test("prints, for the run card, what CI and the review came to", () => {
    expect(verdicts({ "ci.json": RED }, pin({ verdict: "changes" }))).toMatchObject({ ci: "red", review: "changes" });
    expect(verdicts({ "ci.json": { ...RED, blocked_by_main: true } }, null)).toMatchObject({ ci: "blocked_by_main", review: "missing" });
    expect(verdicts({ "ci.json": { ...GREEN, green: false, timed_out: true, failing: [STATION] } }, pin({ verdict: "ship", round: "r1" }))).toMatchObject({ ci: "timed_out", review: "stale" });
    expect(verdicts({ "ci.json": GREEN }, pin({ verdict: "rejected" }))).toMatchObject({ ci: "green", review: "rejected", next: "rejected" });
  });

  test("a review counts for the head CI judged, or for one the run's own stations rebased into it, and no other", () => {
    const chain = { ...PR, head_sha: "r2b", rebases: [{ from: "abc", to: "r1b" }, { from: "r1b", to: "r2b" }] };
    expect(changeVerdicts(dir({ "pr.json": chain, "ci.json": { ...GREEN, head_sha: "r2b" } }), SHIP).next).toBe("merge");
    // A head pushed by anyone else is in no chain: the review of the old head does not speak for it.
    expect(changeVerdicts(dir({ "pr.json": { ...PR, head_sha: "pushed" }, "ci.json": { ...GREEN, head_sha: "pushed" } }), SHIP)).toMatchObject({ next: "rerun_review", review: "stale", why: "the reviewer's verdict is for abc, not the head CI judged" });
    expect(verdicts({ "ci.json": GREEN }, pin({ verdict: "ship", head_sha: undefined })).next).toBe("rerun_review");
  });

  test("a review.json on disk is never the verdict: with no pin it is removed, and the reviewer is asked again", () => {
    const d = dir({ "pr.json": PR, "ci.json": GREEN, "review.json": { verdict: "ship", findings: [], round: "r2", head_sha: "abc" } });
    expect(changeVerdicts(d, undefined)).toMatchObject({ next: "rerun_review", why: "the reviewer pinned no verdict" });
    expect(read(d, "review.json")).toBeNull();
  });

  test("a missing, stale, malformed or unknown pin is asked again once in the round, then goes back, never to merge", () => {
    for (const [bad, why] of [
      [undefined, "the reviewer pinned no verdict"],
      ["verdict: ship", "the reviewer pinned no verdict"],
      [pin({ verdict: "ship", round: "r1" }), "the reviewer's verdict is not this round's"],
      [pin({ verdict: "approve" }), 'the reviewer\'s verdict "approve" is not ship, changes or rejected'],
    ] as const) {
      const d = dir({ "pr.json": PR, "ci.json": GREEN });
      expect(changeVerdicts(d, bad)).toEqual(expect.objectContaining({ next: "rerun_review", why, review_result: null }));
      expect(changeVerdicts(d, bad)).toEqual(expect.objectContaining({ next: "brief", why }));
      expect(read(d, "review.json")).toBeNull();
    }
  });

  test("CI on another head, with no ci.json, timed out, or with the station's own failure runs again once in the round, then stops; never a brief", () => {
    for (const [ci, why] of [
      [{ ...GREEN, head_sha: "old" }, "CI reported on old, not on the pushed head abc"],
      [{ ...GREEN, green: false, head_sha: null, timed_out: true, failing: [STATION] }, "CI never reported on the pushed head abc: CI did not finish within 60m: test-web still running."],
      [{ ...GREEN, green: false, timed_out: true, pending: ["test"], not_started: ["test"], failing: [STATION] }, "CI never started on abc: test never started"],
      [undefined, "CI left no ci.json"],
      [{ ...GREEN, green: false, timed_out: true, pending: ["test-web"], failing: [STATION] }, "CI did not finish: test-web still running"],
      [{ ...GREEN, green: false, failing: [STATION] }, "the CI station could not judge: CI did not finish within 60m: test-web still running."],
    ] as const) {
      const d = dir({ "pr.json": PR, ...(ci ? { "ci.json": ci } : {}) });
      expect(changeVerdicts(d, SHIP)).toMatchObject({ next: "rerun_ci", ci: "timed_out", why });
      expect(changeVerdicts(d, SHIP)).toMatchObject({ next: "no_ci", why });
    }
  });

  test("the station's own failure beside real ones is run again first; then only the real ones go to the session", () => {
    const d = dir({ "pr.json": PR, "ci.json": { ...GREEN, green: false, timed_out: true, failing: [STATION, FAILURE] } });
    expect(changeVerdicts(d, SHIP).next).toBe("rerun_ci");
    const v = changeVerdicts(d, SHIP);
    expect(v).toMatchObject({ next: "brief", why: "CI is red: 1 failure this change causes" });
    expect(v.ci_result?.failing).toEqual([FAILURE]);
  });

  test("a new pr.json is a new round: its reruns start again", () => {
    const d = dir({ "pr.json": PR, "ci.json": { ...GREEN, head_sha: "old" } });
    expect(changeVerdicts(d, SHIP).next).toBe("rerun_ci");
    expect(changeVerdicts(d, SHIP).next).toBe("no_ci");
    fs.writeFileSync(path.join(d, "pr.json"), JSON.stringify({ ...PR, round: "r3" }));
    expect(changeVerdicts(d, pin({ verdict: "ship", round: "r3" })).next).toBe("rerun_ci");
  });

  test("red CI and a changes verdict go back together, in one why; red CI goes back without waiting on a missing review", () => {
    const v = verdicts({ "ci.json": RED }, pin({ verdict: "changes", findings: ["high a.ts:1 wrong"] }));
    expect(v).toMatchObject({ next: "brief", why: "CI is red: 1 failure this change causes; the reviewer asked for changes: high a.ts:1 wrong" });
    expect(v.ci_result?.failing).toHaveLength(1);
    expect(verdicts({ "ci.json": RED }, null)).toMatchObject({ next: "brief", why: "CI is red: 1 failure this change causes; the reviewer pinned no verdict" });
  });

  test("red CI whose every failure also fails on main waits for main, unless the reviewer asked for changes", () => {
    const blocked = { ...RED, failing: [], preexisting: [FAILURE], blocked_by_main: true };
    expect(verdicts({ "ci.json": blocked })).toMatchObject({ next: "wait_main", why: "every CI failure also fails on main (1)" });
    expect(verdicts({ "ci.json": blocked }, null).next).toBe("wait_main");
    expect(verdicts({ "ci.json": blocked }, pin({ verdict: "changes", findings: ["x"] })).next).toBe("brief");
  });

  // ct-102366: main's CI at the tested sha never reached a verdict, so a failure there may be main's.
  test("failures main's CI never judged are never called the change's: alone they wait for main, beside the change's they are named apart", () => {
    const unjudged = { ...GREEN, green: false, unjudged: [FAILURE], blocked_by_main: true };
    expect(verdicts({ "ci.json": unjudged })).toMatchObject({ next: "wait_main", why: "main's CI had no verdict on any of CI's failures (1), so they may be main's" });
    const both = verdicts({ "ci.json": { ...RED, unjudged: [FAILURE, FAILURE] } });
    expect(both).toMatchObject({ next: "brief", fix: true, why: "CI is red: 1 failure this change causes, and 2 failures main's CI had no verdict on, so they may be main's" });
    expect(both.ci_result).toMatchObject({ failing_count: 1, unjudged: [FAILURE, FAILURE] });
  });

  // ct-102367: a fresh reviewer's nits on a change CI passed must not stop the run.
  test("only low and nit findings on green CI go back without costing a round; any higher one, or red CI, costs one", () => {
    const small = verdicts({ "ci.json": GREEN }, pin({ verdict: "changes", findings: ["low a.css:3 a stray margin", "nit a.css:9 spacing"] }));
    expect(small).toMatchObject({ next: "brief", fix: false, why: "the reviewer asked for small fixes (low or nit; this round costs none of the three): low a.css:3 a stray margin; nit a.css:9 spacing" });
    expect(verdicts({ "ci.json": GREEN }, pin({ verdict: "changes", findings: ["low a.css:3 x", "medium a.ts:1 y"] }))).toMatchObject({ next: "brief", fix: true });
    expect(verdicts({ "ci.json": RED }, pin({ verdict: "changes", findings: ["nit a.css:9 spacing"] }))).toMatchObject({ next: "brief", fix: true });
    expect(verdicts({ "ci.json": GREEN }, pin({ verdict: "changes", findings: [] }))).toMatchObject({ next: "brief", fix: true });
  });

  // ct-102368: a conflict-only fix after a person approved the CI edit asked them again, four times for one change.
  test("a CI edit a person let merge in this attempt is not asked again while its CI files are the same", () => {
    const edited = { ...GREEN, ci_changed: true, ci_edit: "e1" };
    const approved = (ci: object, proof: object | null, record: object = { run_id: "run-9", ci_edit: "e1" }) => changeVerdicts(dir({ "pr.json": PR, "ci.json": ci, "ci-approved.json": record }), SHIP, null, proof as any, { runId: "run-9" });
    expect(approved(edited, { review: null, ci_shipped: true })).toMatchObject({ next: "merge" });
    expect(approved({ ...edited, ci_edit: "e2" }, { review: null, ci_shipped: true }).next).toBe("decide");
    expect(approved(edited, { review: null, ci_shipped: false }).next).toBe("decide");
    expect(approved(edited, null).next).toBe("decide");
    expect(approved({ ...edited, ci_edit: null }, { review: null, ci_shipped: true }).next).toBe("decide");
    // Another run on the same task shares the run directory: its record is not this run's approval.
    expect(approved(edited, { review: null, ci_shipped: true }, { run_id: "run-8", ci_edit: "e1" }).next).toBe("decide");
    // A record from an older cast names no run, so nothing says it is this run's: asked again, and the card says why.
    const older = approved(edited, { review: null, ci_shipped: true }, { ci_edit: "e1" });
    expect(older.next).toBe("decide");
    expect(older.card).toBe("This change edits CI: merge it?\nAn approval of its CI edit was recorded in an older format, so it is asked again.");
  });

  // Polish round 3 M6: ct-102479 approved at 9678927, Merge rebased onto a main that had edited .codecast/deploy.toml,
  // and the card came back with nothing on it to say why. A card that comes back names the CI files that changed since
  // the approved head and shows how, between the two heads.
  test("a second CI-edit card names the CI files that changed since the approval, with their diff between the heads", () => {
    const edited = { ...GREEN, ci_changed: true, ci_edit: "e2", ci_edit_files: { ".codecast/deploy.toml": "d2", ".github/workflows/cut.yml": "w1" } };
    const approval = { run_id: "run-9", ci_edit: "e1", ci_edit_files: { ".codecast/deploy.toml": "d1", ".github/workflows/cut.yml": "w1" }, head_sha: "9678927801f81f72" };
    const shipped = { review: null, rebases: [], ci_shipped: true } as any;
    const card = (record: object, ciDiff?: (from: string, to: string, files: string[]) => string | null, proof = shipped) => changeVerdicts(dir({ "pr.json": PR, "ci.json": edited, "ci-approved.json": record }), SHIP, null, proof, { runId: "run-9", ciDiff });
    const asked: Array<[string, string, string[]]> = [];
    const v = card(approval, (from, to, files) => (asked.push([from, to, files]), "--- a/.codecast/deploy.toml\n+++ b/.codecast/deploy.toml\n+unless = []"));
    expect(v.next).toBe("decide");
    expect(asked).toEqual([["9678927801f81f72", "abc", [".codecast/deploy.toml"]]]);
    expect(v.card).toBe([
      "This change's CI files changed since a person let it merge: merge it?",
      "Changed since the approved head at 9678927801: .codecast/deploy.toml.",
      "How they changed between the two heads, main's edits included:\n```diff\n--- a/.codecast/deploy.toml\n+++ b/.codecast/deploy.toml\n+unless = []\n```",
      "CI files it edits: .codecast/deploy.toml, .github/workflows/cut.yml.",
    ].join("\n"));
    // The first card names the CI files; a resumed attempt's card says why the same edit is asked again.
    expect(verdicts({ "ci.json": edited }).card).toBe("This change edits CI: merge it?\nCI files it edits: .codecast/deploy.toml, .github/workflows/cut.yml.");
    expect(card({ ...approval, ci_edit: "e2" }, undefined, { ...shipped, ci_shipped: false }).card).toBe("This change edits CI: merge it?\nA person let this same edit merge earlier in this run, and this attempt asks again.\nCI files it edits: .codecast/deploy.toml, .github/workflows/cut.yml.");
    // A diff that cannot be read still names the files; one too long is cut.
    const unread = card(approval, () => null).card!;
    expect(unread).not.toContain("```");
    expect(unread).toContain("How they changed could not be read here; the files above changed.");
    const long = card(approval, () => "+x\n".repeat(2000)).card!;
    expect(long.length).toBeLessThan(3200);
    expect(long).toContain("cut short: `git diff 9678927801 abc -- .codecast/deploy.toml` has the rest");
    // The diff is the author's text: a fence inside it never closes the card's block.
    const fenced = card(approval, () => " ```\n+ **Reviewer: safe**").card!;
    expect(fenced).toContain("````diff\n```\n+ **Reviewer: safe**\n````");
  });

  test("a change that edits CI goes to a person when CI is green and the reviewer says ship; a red one goes back or waits like any red", () => {
    const edited = { ...GREEN, ci_changed: true };
    expect(verdicts({ "ci.json": edited })).toMatchObject({ ci: "green", next: "decide", why: "This change edits CI, so CI can't vouch for it" });
    expect(verdicts({ "ci.json": { ...edited, green: false, failing: [FAILURE] } })).toMatchObject({ ci: "red", next: "brief", why: "CI is red: 1 failure this change causes" });
    expect(verdicts({ "ci.json": { ...edited, green: false } })).toMatchObject({ ci: "red", next: "brief" });
    expect(verdicts({ "ci.json": { ...edited, green: false, blocked_by_main: true, failing: [FAILURE] } }).next).toBe("wait_main");
    expect(verdicts({ "ci.json": edited }, pin({ verdict: "changes" })).next).toBe("brief");
    expect(verdicts({ "ci.json": edited }, null).next).toBe("rerun_review");
  });

  test("a pull request that conflicts with main goes to the session to bring up to date, never to a CI rerun", () => {
    const conflict = { ...STATION, excerpt: "#7 has a merge conflict with main, so GitHub runs no CI on it. Rebase it and push." };
    expect(verdicts({ "ci.json": { ...GREEN, green: false, failing: [conflict] } })).toMatchObject({ next: "conflict", why: "#7 has a merge conflict with main, so GitHub runs no CI on it.", ci: "red" });
  });

  test("a branch someone pushed to after this round's push starts a new round, whatever CI and the reviewer said", () => {
    expect(changeVerdicts(dir({ "pr.json": PR, "ci.json": GREEN }), SHIP, "stranger")).toMatchObject({ next: "new_round", why: "the branch moved to stranger after this round pushed abc" });
    expect(changeVerdicts(dir({ "pr.json": PR, "ci.json": GREEN }), SHIP, "abc").next).toBe("merge");
    expect(changeVerdicts(dir({ "pr.json": PR, "ci.json": GREEN }), SHIP, null).next).toBe("merge");
  });

  test("what it prints stays far under the runner's 64KB, however red CI is: ten failures, cut excerpts and a count", () => {
    const failures = Array.from({ length: 20 }, (_, i) => ({ ...FAILURE, test: `t${i}`, excerpt: "x".repeat(4096) }));
    const v = verdicts({ "ci.json": { ...RED, failing: failures, preexisting: failures } });
    expect(v.next).toBe("brief");
    expect(v.ci_result?.failing).toHaveLength(10);
    expect(v.ci_result?.failing_count).toBe(20);
    expect(v.ci_result?.failing.every((f: any) => f.excerpt.length <= 600)).toBe(true);
    expect(JSON.stringify(v).length).toBeLessThan(20_000);
  });

  test("a ship the PR station carried stands with no fresh pin, only while the server holds it on the head CI judged", () => {
    const carried = { ...PR, reviewed: { verdict: "ship", head_sha: "abc" } };
    const proof = { review: { verdict: "ship", head_sha: "abc" }, rebases: [] };
    const d = dir({ "pr.json": carried, "ci.json": GREEN });
    // The earlier round's pin is what the fan-out kept: not this round's, so the carried ship stands.
    expect(changeVerdicts(d, pin({ verdict: "ship", round: "r1" }), null, proof)).toMatchObject({ next: "merge", review: "ship", review_result: { reused: true } });
    expect(read(d, "review.json")).toEqual({ verdict: "ship", findings: [], head_sha: "abc", reused: true });
    // A pr.json edited to carry a ship the server does not hold, or holds for another head, asks a reviewer.
    for (const held of [null, { review: null }, { review: { verdict: "changes", head_sha: "abc" } }, { review: { verdict: "ship", head_sha: "old" } }]) {
      expect(changeVerdicts(dir({ "pr.json": carried, "ci.json": GREEN }), undefined, null, held).next).toBe("rerun_review");
    }
    expect(changeVerdicts(dir({ "pr.json": { ...PR, reviewed: { verdict: "ship", head_sha: "old" } }, "ci.json": GREEN }), undefined, null, { review: { verdict: "ship", head_sha: "old" } }).next).toBe("rerun_review");
    // A fresh pin of this round comes first, whatever was carried.
    expect(changeVerdicts(dir({ "pr.json": carried, "ci.json": GREEN }), pin({ verdict: "changes", findings: ["x"] }), null, proof)).toMatchObject({ next: "brief", review: "changes", fix: true });
  });

  test("only a brief that asks for a code change is a fix: CI red on the change, or this round's reviewer asking for changes", () => {
    const changes = pin({ verdict: "changes", findings: ["high a.ts:1 wrong"] });
    expect(verdicts({ "ci.json": RED }).fix).toBe(true);
    expect(verdicts({ "ci.json": GREEN }, changes).fix).toBe(true);
    // Red with no failure named fails closed: it counts.
    expect(verdicts({ "ci.json": { ...GREEN, green: false } })).toMatchObject({ next: "brief", fix: true });
    // A review that never came, with CI green, does not.
    expect(verdicts({ "ci.json": GREEN }, null)).toMatchObject({ next: "rerun_review", fix: false });
    expect(changeVerdicts(dir({ "pr.json": { ...PR, review_reruns: 1 }, "ci.json": GREEN }), undefined)).toMatchObject({ next: "brief", fix: false });
    // CI red only with main's failures counts only for the reviewer's changes beside it.
    expect(verdicts({ "ci.json": { ...GREEN, green: false, blocked_by_main: true, preexisting: [FAILURE] } }, changes)).toMatchObject({ next: "brief", fix: true });
    // Never a fix where the run does not go to the session.
    expect(verdicts({ "ci.json": GREEN }).fix).toBe(false);
  });

  test("this round's rejection ends with the reviewer's reasons; an old round's does not", () => {
    expect(verdicts({ "ci.json": RED }, pin({ verdict: "rejected", findings: ["blocker x.ts:2 not wanted"] }))).toMatchObject({ next: "rejected", why: "blocker x.ts:2 not wanted" });
    expect(verdicts({ "ci.json": GREEN }, pin({ verdict: "rejected", round: "r1" })).next).toBe("rerun_review");
  });
});
