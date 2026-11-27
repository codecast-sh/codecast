// End to end (flows.md FL4): the shipped `change` flow, PR → CI ‖ Review →
// Verdicts → Merge → Deploy, run by the real runner on a real git branch. Its
// stations' commands are a fake `cast` on PATH: CI and Merge answer from a
// script of answers, PR does what the real station does to the run's files,
// and Verdicts is the real one. The server is a fake that plays the reviewer,
// which pins its verdict with the round's nonce as the real prompt asks, and
// the session the change came from, which commits its fix to the branch when a
// brief reaches it. The harness is changeFlow.testkit.ts.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { graphHash, parseWorkflowFile, parseWorkflowSource } from "./parser";
import { BUILTIN_WORKFLOW_TEMPLATES } from "./templates";
import { CHANGES, GREEN, RED, REJECTED, SHIP, SILENT, STATION, count, git, run, server, useChangeFlowSandbox, world } from "./changeFlow.testkit";

useChangeFlowSandbox();

describe("the shipped change flow", () => {
  test("the builtin reads the same as the template run from disk", () => {
    const onDisk = parseWorkflowFile(path.join(import.meta.dir, "templates", "change.cast"));
    expect(graphHash(onDisk)).toBe(graphHash(parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.change)));
  });

  test("green CI and a ship verdict merge, and Deploy goes out from the merged sha", async () => {
    const w = world({ ci: [GREEN], review: [SHIP], merge: ["merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    const calls = w.calls();
    expect(calls).toEqual(["flow pr", "flow ci", "flow verdicts", "flow merge", "flow await-deploy"]);
    expect(JSON.parse(fs.readFileSync(path.join(w.runDir, "merge.json"), "utf-8")).sha).toBe("5ca1ab1e00000000000000000000000000000000");
    expect(s.spawned).toHaveLength(1);
    // The reviewer is told the round's nonce to pin with its verdict.
    const round = JSON.parse(fs.readFileSync(path.join(w.runDir, "pr.json"), "utf-8")).round;
    expect(s.spawned[0].prompt).toContain(`"round": "${round}"`);
    // And to record its verdict with `cast flow review-verdict` (flowStations.ts), naming that head and round.
    const head = JSON.parse(fs.readFileSync(path.join(w.runDir, "pr.json"), "utf-8")).head_sha;
    expect(s.spawned[0].prompt).toContain(`cast flow review-verdict --verdict changes --head "${head}" --round "${round}"`);
    // CI posts its verdict to the run's own CI station, and waits for the head PR pushed.
    const ciCall = fs.readFileSync(path.join(process.env.FAKE_STATE!, "calls.log"), "utf-8").split("\n").find((l) => l.startsWith("flow ci "))!;
    const pushed = JSON.parse(fs.readFileSync(path.join(w.runDir, "pr.json"), "utf-8")).head_sha;
    expect(ciCall).toContain("--run run-9 --node ci");
    // It judges the head pr.json holds on disk, read as JSON (a retest moves it), and that is the head ci.json names.
    expect(ciCall).toContain("--pushed");
    expect(JSON.parse(fs.readFileSync(path.join(w.runDir, "ci.json"), "utf-8")).head_sha).toBe(pushed);
    expect(s.briefs()).toEqual([]);
    expect(s.sent().at(-1).body).toContain("The Ship run on ct-9 is over: Live.");
  }, 120_000);

  test("red CI goes back to the session as one brief with each failure's file, line and excerpt; the fix goes up as the PR again", async () => {
    const w = world({ ci: [RED, GREEN], review: [SHIP, SHIP], merge: ["merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    const [brief, ...more] = s.briefs();
    expect(more).toEqual([]);
    expect(brief).toContain("https://github.com/acme/app/pull/7");
    expect(brief).toContain("CI is red: 1 failure this change causes");
    expect(brief).toContain('"file":"src/a.test.ts","line":12');
    expect(brief).toContain("expect(a).toBe('good')");
    expect(brief).toContain("under `preexisting` also fails on the default branch");
    expect(count(w.calls(), "flow pr")).toBe(2);
    expect(count(w.calls(), "flow ci")).toBe(2);
    expect(s.spawned).toHaveLength(2);
    // The second PR push carries the session's fix.
    expect(JSON.parse(fs.readFileSync(path.join(w.runDir, "pr.json"), "utf-8")).head_sha).toBe(git(w.root, "rev-parse", "feat"));
    expect(git(w.root, "show", "feat:a.txt")).toBe("fix 1");
  }, 120_000);

  test("a changes verdict goes back with the reviewer's findings, even with CI green", async () => {
    const w = world({ ci: [GREEN, GREEN], review: [CHANGES, SHIP], merge: ["merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    const [brief, ...more] = s.briefs();
    expect(more).toEqual([]);
    expect(brief).toContain("the reviewer asked for changes: high a.txt:1 says bad where the task asks for good, P2");
    expect(count(w.calls(), "flow pr")).toBe(2);
  }, 120_000);

  test("a reviewer that pins nothing is asked once more, with CI left alone, then the session is briefed", async () => {
    const w = world({ ci: [GREEN, GREEN], review: ["none", "none", SHIP], merge: ["merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.spawned).toHaveLength(3);
    expect(count(w.calls(), "flow ci")).toBe(2);
    expect(s.briefs()).toHaveLength(1);
    expect(s.briefs()[0]).toContain("the reviewer pinned no verdict");
    expect(count(w.calls(), "flow merge")).toBe(1);
  }, 120_000);

  test("a verdict word outside ship, changes and rejected is asked once more, then briefed; approve is never read as ship", async () => {
    const approve = { verdict: "approve", findings: [] };
    const w = world({ ci: [GREEN, GREEN], review: [approve, approve, SHIP], merge: ["merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.spawned).toHaveLength(3);
    expect(s.briefs()).toHaveLength(1);
    expect(s.briefs()[0]).toContain(`the reviewer's verdict "approve" is not ship, changes or rejected`);
    expect(count(w.calls().slice(0, w.calls().indexOf("flow merge")), "flow pr")).toBe(2);
  }, 120_000);

  test("a pin from an earlier round, which the fan-out keeps when a reviewer pins words that are not JSON, never merges", async () => {
    // Round 2's reviewer pins words: the runner keeps round 1's ship pin in its place, with round 1's nonce.
    const w = world({ ci: [RED, GREEN, GREEN], review: [SHIP, "garbage", "garbage", SHIP], merge: ["merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    const calls = w.calls();
    expect(count(calls, "flow merge")).toBe(1);
    expect(s.spawned).toHaveLength(4);
    expect(count(calls.slice(0, calls.indexOf("flow merge")), "flow pr")).toBe(3);
    expect(s.briefs()).toHaveLength(2);
  }, 120_000);

  test("a pin carrying another round's nonce does not count", async () => {
    const w = world({ ci: [GREEN, GREEN], review: ["stale", "stale", SHIP], merge: ["merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.spawned).toHaveLength(3);
    expect(s.briefs()[0]).toContain("the reviewer's verdict is not this round's");
  }, 120_000);

  test("a review.json written by anything but the reviewer's pin, with this round's nonce, is ignored and replaced", async () => {
    const w = world({ ci: [GREEN, GREEN], review: ["forged", "forged", SHIP], merge: ["merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    // Both forged ships were ignored: the merge waited for the third reviewer's own pin.
    expect(s.spawned).toHaveLength(3);
    expect(s.briefs()).toHaveLength(1);
    expect(count(w.calls(), "flow merge")).toBe(1);
    // What Merge read is the accepted pin, with this round's nonce.
    const round = JSON.parse(fs.readFileSync(path.join(w.runDir, "pr.json"), "utf-8")).round;
    expect(JSON.parse(fs.readFileSync(path.join(w.runDir, "review.json"), "utf-8"))).toMatchObject({ verdict: "ship", findings: [], round });
  }, 120_000);

  test("CI that judged another head than the pushed one runs again, never briefing the session", async () => {
    const w = world({ ci: [{ ...GREEN, head_sha: "0ddba11" }, GREEN], review: [SHIP], merge: ["merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.briefs()).toEqual([]);
    expect(count(w.calls(), "flow ci")).toBe(2);
    expect(count(w.calls(), "flow merge")).toBe(1);
  }, 120_000);

  test("CI's one extra run is each round's: a second round gets its own", async () => {
    const w = world({ ci: [SILENT, GREEN, SILENT, GREEN], review: [CHANGES, SHIP], merge: ["merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.briefs()).toHaveLength(1);
    expect(count(w.calls(), "flow ci")).toBe(4);
  }, 120_000);

  test("CI that never reports runs once more, with nothing sent to the session, then stops at CI never reported", async () => {
    const w = world({ ci: [SILENT, SILENT], review: [SHIP] });
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(count(w.calls(), "flow ci")).toBe(2);
    expect(w.calls()).not.toContain("flow merge");
    expect(s.briefs()).toEqual([]);
    expect(s.sent().at(-1).body).toContain("stopped at CI never reported");
    expect(s.sent().at(-1).body).toContain("CI did not finish: test-cli still running");
  }, 120_000);

  // ct-102369: a resume is a new attempt, and Merge clears only on CI and a review the server holds for it.
  test("CI never reported names a resume at PR, which runs CI and a fresh review again on the same change, to Live", async () => {
    const w = world({ ci: [SILENT, SILENT, GREEN], review: [SHIP, SHIP], merge: ["merged"] });
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(s.failReason()).toContain("(`cast workflow resume ct-9 --at pr`)");
    fs.rmSync(path.join(process.env.FAKE_STATE!, "proof.json")); // the new attempt holds no review from the last one
    expect(await run(w, true, "pr")).toBe("completed");
    expect([count(w.calls(), "flow pr"), count(w.calls(), "flow ci"), s.spawned.length]).toEqual([2, 3, 2]);
  }, 120_000);

  test("CI that reports on its second try merges", async () => {
    const w = world({ ci: [SILENT, GREEN], review: [SHIP], merge: ["merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.briefs()).toEqual([]);
    expect(count(w.calls(), "flow ci")).toBe(2);
  }, 120_000);

  test("a merge conflict goes back to the session with what Merge said, then the change goes up as the PR again", async () => {
    const w = world({ ci: [GREEN, GREEN], review: [SHIP, SHIP], merge: ["conflict", "merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    const [brief, ...more] = s.briefs();
    expect(more).toEqual([]);
    expect(brief).toContain("Merge could not put this session's change (ct-9)");
    expect(brief).toContain("feat conflicts with main in a.txt");
    expect(count(w.calls(), "flow pr")).toBe(2);
    expect(count(w.calls(), "flow merge")).toBe(2);
  }, 120_000);

  test("a merge that crashes is no conflict: it stops at Not merged with the crash, and the session is not briefed", async () => {
    const w = world({ ci: [GREEN], review: [SHIP], merge: ["crashed"] });
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(s.briefs()).toEqual([]);
    expect(s.sent().at(-1).body).toContain("stopped at Not merged");
    expect(s.sent().at(-1).body).toContain("TypeError: undefined is not an object");
  }, 120_000);

  test("a merge that needs a retest takes origin's rebased head and runs CI on it again, with no new review and no new push", async () => {
    const w = world({ ci: [GREEN, GREEN], review: [SHIP], merge: ["retest", "merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.briefs()).toEqual([]);
    expect(count(w.calls(), "flow ci")).toBe(2);
    expect(count(w.calls(), "flow pr")).toBe(1);
    expect(count(w.calls(), "flow pr --refresh")).toBe(1);
    expect(s.spawned).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(w.runDir, "pr.json"), "utf-8")).head_sha).toMatch(/^rebased/);
  }, 120_000);

  test("a merge still in line after its wait runs again in its place, with nothing else asked again; past three it stops not merged", async () => {
    const w = world({ ci: [GREEN], review: [SHIP], merge: ["inline", "inline", "merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(w.calls()).toEqual(["flow pr", "flow ci", "flow verdicts", "flow merge", "flow merge", "flow merge", "flow await-deploy"]);
    expect(s.briefs()).toEqual([]);
    const long = world({ ci: [GREEN], review: [SHIP], merge: ["inline", "inline", "inline", "inline"] });
    const s2 = server(long);
    expect(await run(long)).toBe("failed");
    expect(count(long.calls(), "flow merge")).toBe(4);
    expect(s2.sent().at(-1).body).toContain("stopped at Not merged");
    expect(s2.sent().at(-1).body).toContain("still waiting for the lease after 40m");
  }, 120_000);

  test("main that keeps moving is retested three times, then the run stops and says why", async () => {
    const w = world({ ci: [GREEN, GREEN, GREEN, GREEN], review: [SHIP], merge: ["retest", "retest", "retest", "retest"] });
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(count(w.calls(), "flow merge")).toBe(4);
    expect(count(w.calls(), "flow ci")).toBe(4);
    expect(w.calls()).not.toContain("flow await-deploy");
    expect(s.sent().at(-1).body).toContain("stopped at Main keeps moving");
    expect(s.sent().at(-1).body).toContain("CI ran again 3 times");
  }, 120_000);

  test("a rejection ends the run at Rejected with the reviewer's reasons, and nothing merges", async () => {
    const w = world({ ci: [GREEN], review: [REJECTED] });
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(w.calls()).not.toContain("flow merge");
    expect(s.sent().at(-1).body).toContain("stopped at Rejected");
    expect(s.sent().at(-1).body).toContain("the task should not be done at all");
  }, 120_000);

  test("Deploy is reached only through a merge with a sha: a refusal, and a success that wrote no merge.json, stop at Not merged", async () => {
    for (const answer of ["refused", "nojson"]) {
      const w = world({ ci: [GREEN], review: [SHIP], merge: [answer] });
      const s = server(w);
      expect(await run(w)).toBe("failed");
      expect(w.calls()).not.toContain("flow await-deploy");
      expect(s.sent().at(-1).body).toContain("stopped at Not merged");
    }
  }, 240_000);

  test("Deploy sends and waits from the run's checkout when Merge took the run's worktree and branch away", async () => {
    const w = world({ ci: [GREEN], review: [SHIP], merge: ["merged-gone"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(fs.existsSync(path.join(process.env.FAKE_STATE!, "ws-gone"))).toBe(true);
    expect(w.calls()).toEqual(["flow pr", "flow ci", "flow verdicts", "flow merge", "flow await-deploy"]);
    expect(fs.readFileSync(path.join(process.env.FAKE_STATE!, "deploy-cwd"), "utf-8").trim()).toBe(w.root);
    const deploy = fs.readFileSync(path.join(process.env.FAKE_STATE!, "calls.log"), "utf-8").split("\n").find((l) => l.startsWith("flow await-deploy "))!;
    expect(deploy).toContain(`--merge ${w.runDir}/merge.json`);
    expect(s.sent().at(-1).body).toContain("The Ship run on ct-9 is over: Live.");
  }, 120_000);

  test("a deploy that fails after the merge tells the session its change landed but did not go live", async () => {
    const w = world({ ci: [GREEN], review: [SHIP], merge: ["merged"] });
    fs.writeFileSync(path.join(process.env.FAKE_STATE!, "deploy-fails"), "");
    const s = server(w);
    expect(await run(w)).toBe("failed");
    const end = s.sent().at(-1).body;
    expect(end).toContain("stopped at Deploy failed");
    expect(end).toContain("The change is on the default branch; nothing after this stage ran.");
    expect(end).not.toContain("was not merged");
  }, 120_000);

  test("a session whose fix never turns CI green is briefed three times, then the run stops and says why", async () => {
    const w = world({ ci: [RED, RED, RED, RED], review: [SHIP, SHIP, SHIP, SHIP] });
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(s.briefs()).toHaveLength(3);
    expect(w.calls()).not.toContain("flow merge");
    expect(s.sent().at(-1).body).toContain("sent the change back 3 times");
  }, 120_000);

  test("a rerun on an unchanged head keeps the reviewer's ship: no reviewer, CI on the one pushed head, the round counter still", async () => {
    // Red CI the session leaves as it was (it is not the change's, it says): the next round is that head again.
    const w = world({ ci: [RED, GREEN], review: [SHIP], merge: ["merged"], fixes: [false] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.spawned).toHaveLength(1);
    expect(w.calls()).toEqual(["flow pr", "flow ci", "flow verdicts", "flow pr", "flow ci", "flow verdicts", "flow merge", "flow await-deploy"]);
    expect(s.briefRounds()).toEqual([1]);
    const head = git(w.root, "rev-parse", "feat");
    // pr.json as the real station writes it, its kept ship naming the head too; CI judged that one head.
    const onDisk = fs.readFileSync(path.join(w.runDir, "pr.json"), "utf-8");
    expect(onDisk).toContain('\n  "reviewed": {');
    expect(JSON.parse(onDisk).reviewed).toEqual({ verdict: "ship", head_sha: head });
    expect(JSON.parse(fs.readFileSync(path.join(w.runDir, "ci.json"), "utf-8")).head_sha).toBe(head);
    expect(JSON.parse(fs.readFileSync(path.join(w.runDir, "review.json"), "utf-8"))).toEqual({ verdict: "ship", findings: [], head_sha: head, reused: true });
  }, 120_000);

  test("a kept ship goes on through a retest: CI judges the rebased head, and the same ship merges it", async () => {
    const w = world({ ci: [RED, GREEN, GREEN], review: [SHIP], merge: ["retest", "merged"], fixes: [false] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.spawned).toHaveLength(1);
    expect(count(w.calls(), "flow pr --refresh")).toBe(1);
    expect(count(w.calls(), "flow ci")).toBe(3);
    expect(JSON.parse(fs.readFileSync(path.join(w.runDir, "ci.json"), "utf-8")).head_sha).toMatch(/^rebased/);
  }, 120_000);

  test("a changes verdict on an unchanged head is never kept: a fresh reviewer reads it, and that review is a round", async () => {
    const w = world({ ci: [GREEN, GREEN, GREEN], review: [CHANGES, CHANGES, SHIP], merge: ["merged"], fixes: [false, true] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.spawned).toHaveLength(3);
    expect(s.briefs().some((b) => b.includes('"reused"'))).toBe(false);
    expect(s.briefRounds()).toEqual([1, 2]);
    expect(JSON.parse(fs.readFileSync(path.join(w.runDir, "review.json"), "utf-8"))).toMatchObject({ verdict: "ship", head_sha: git(w.root, "rev-parse", "feat") });
  }, 120_000);

  test("only a brief asking for a code change spends a round: a review that never came does not", async () => {
    // A round with no review, then three red CIs: four briefs, three of them rounds; a fourth round would stop the run.
    const w = world({ ci: [GREEN, RED, RED, RED, GREEN], review: ["none", "none", SHIP, SHIP, SHIP, SHIP], merge: ["merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.briefs()).toHaveLength(4);
    expect(s.briefRounds()).toEqual([0, 1, 2, 3]);
  }, 120_000);

  test("with no session behind the run, the first finding stops it, saying what CI and the reviewer found", async () => {
    const w = world({ ci: [RED], review: [CHANGES] });
    const s = server(w);
    expect(await run(w, false)).toBe("failed");
    expect(s.sent()).toEqual([]);
    expect(s.failReason()).toContain("no session made this change to fix it");
    expect(s.failReason()).toContain("CI is red: 1 failure this change causes");
    expect(s.failReason()).toContain("high a.txt:1 says bad");
  }, 120_000);
});

const BLOCKED = { ...RED, blocked_by_main: true };
const CI_CHANGED = { ...GREEN, ci_changed: true };

describe("when main is red under the change", () => {
  test("it waits for main, puts the change onto the new main and runs CI again, briefing nobody", async () => {
    const w = world({ ci: [BLOCKED, GREEN], review: [SHIP], wait: ["green"], merge: ["merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    const calls = w.calls();
    expect(calls.indexOf("flow wait-main")).toBeGreaterThan(calls.indexOf("flow verdicts"));
    expect(calls.indexOf("flow pr --rebase")).toBeGreaterThan(calls.indexOf("flow wait-main"));
    // The rebase is recorded on the run, so Merge's check and the server's both find it.
    expect(fs.readFileSync(path.join(process.env.FAKE_STATE!, "calls.log"), "utf-8")).toMatch(/^flow pr --rebase .* --run run-9$/m);
    expect(count(calls, "flow ci")).toBe(2);
    expect(s.briefs()).toEqual([]);
    expect(s.spawned).toHaveLength(1);
    // CI ran on the head put onto main, which is what pr.json names now, under the review of the head before it.
    expect(JSON.parse(fs.readFileSync(path.join(w.runDir, "pr.json"), "utf-8")).head_sha).toMatch(/^onmain/);
  }, 120_000);

  test("main that stays red past the wait's deadline stops the run naming main's red jobs, briefing nobody", async () => {
    const w = world({ ci: [BLOCKED], review: [SHIP], wait: ["red"] });
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(s.briefs()).toEqual([]);
    expect(w.calls()).not.toContain("flow merge");
    expect(s.sent().at(-1).body).toContain("stopped at Main stayed red");
    expect(s.sent().at(-1).body).toContain("CI: test-cli");
  }, 120_000);

  test("the run waits for main at most twice", async () => {
    const w = world({ ci: [BLOCKED, BLOCKED, BLOCKED], review: [SHIP], wait: ["green", "green"] });
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(count(w.calls(), "flow wait-main")).toBe(2);
    expect(s.sent().at(-1).body).toContain("stopped at Main stayed red");
    expect(s.sent().at(-1).body).toContain("after two waits");
  }, 120_000);
});

describe("a change that edits CI", () => {
  test("goes to a person's approval card once the reviewer says ship, with why on the task, and merges on Ship", async () => {
    const w = world({ ci: [CI_CHANGED], review: [SHIP], gate: "S", merge: ["merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(w.calls()).toContain("task comment");
    expect(w.calls().indexOf("flow merge")).toBeGreaterThan(w.calls().indexOf("task comment"));
    expect(s.briefs()).toEqual([]);
  }, 120_000);

  test("Revise briefs the session with the person's note, and the next round goes on as usual", async () => {
    const w = world({ ci: [CI_CHANGED, GREEN], review: [SHIP, SHIP], gate: "R: Keep the old job name", merge: ["merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    const [brief, ...more] = s.briefs();
    expect(more).toEqual([]);
    expect(brief).toContain("This change edits CI, so CI can't vouch for it");
    expect(brief).toContain("Keep the old job name");
    expect(count(w.calls(), "flow pr")).toBe(2);
  }, 120_000);

  test("a question typed at the approval card goes to the reviewer, and the card asks again", async () => {
    const w = world({ ci: [CI_CHANGED], review: [SHIP, SHIP], gate: ["does this rename the deploy job?", "S"], merge: ["merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    // The reviewer's session hears the question, not the subject session, and no brief goes out.
    expect(s.sent().filter((m) => String(m.body).includes("does this rename the deploy job?"))).toEqual([]);
    const asked = s.spawned.filter((x) => String(x.prompt).includes("does this rename the deploy job?"));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ title: "Review · ct-9", review_for_task: "ct-9" });
    expect(asked[0].prompt).toContain("The person's question at the card");
    expect(s.briefs()).toEqual([]);
    expect(w.calls()).toContain("flow merge");
  }, 120_000);

  test("Drop ends the run unmerged", async () => {
    const w = world({ ci: [CI_CHANGED], review: [SHIP], gate: "D: Not now" });
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(w.calls()).not.toContain("flow merge");
    expect(s.sent().at(-1).body).toContain("stopped at Dropped");
  }, 120_000);

  test("with no session behind the run it stops, since there is nobody to take it to a person", async () => {
    const w = world({ ci: [CI_CHANGED], review: [SHIP], gate: "S" });
    const s = server(w);
    expect(await run(w, false)).toBe("failed");
    expect(w.calls()).not.toContain("flow merge");
    expect(s.failReason()).toContain("This change edits CI, so CI can't vouch for it");
  }, 120_000);

  test("one that CI finds red goes back to the session like any red, with no approval card", async () => {
    const w = world({ ci: [{ ...CI_CHANGED, green: false, failing: RED.failing }, GREEN], review: [SHIP, SHIP], gate: "S", merge: ["merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.briefs()).toHaveLength(1);
    expect(s.briefs()[0]).toContain("CI is red: 1 failure this change causes");
    expect(w.calls()).not.toContain("task comment");
  }, 120_000);
});

describe("what only the machine can fix never reaches the session", () => {
  test("a push to the branch after the review needs a new review before anything merges", async () => {
    const w = world({ ci: [GREEN, GREEN], review: [SHIP, SHIP], merge: ["retest-pushed", "merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    const calls = w.calls();
    expect(count(calls, "flow pr --refresh")).toBe(1);
    expect(count(calls, "flow pr")).toBe(2);
    expect(s.spawned).toHaveLength(2);
    expect(count(calls.slice(calls.indexOf("flow pr --refresh")), "flow merge")).toBe(1);
    expect(s.briefs()).toEqual([]);
  }, 120_000);

  test("a reviewer whose session dies in the fan-out is asked once more on its own", async () => {
    const w = world({ ci: [GREEN], review: ["dead", SHIP], merge: ["merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.spawned).toHaveLength(2);
    expect(count(w.calls(), "flow ci")).toBe(1);
    expect(s.briefs()).toEqual([]);
  }, 120_000);

  test("a reviewer that dies again stops the run at Review never finished, briefing nobody", async () => {
    const w = world({ ci: [GREEN], review: ["dead", "dead"] });
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(s.briefs()).toEqual([]);
    expect(s.sent().at(-1).body).toContain("stopped at Review never finished");
  }, 120_000);

  test("a Verdicts station that fails stops at a machine end, briefing nobody", async () => {
    const w = world({ ci: [RED], review: [CHANGES] });
    fs.writeFileSync(path.join(process.env.FAKE_STATE!, "verdicts-crash"), "");
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(s.briefs()).toEqual([]);
    expect(s.sent().at(-1).body).toContain("stopped at No verdicts");
  }, 120_000);

  test("the CI station's own failure beside real ones runs CI again, then briefs only the real ones", async () => {
    const mixed = { ...RED, timed_out: true, failing: [STATION, ...RED.failing] };
    const w = world({ ci: [mixed, mixed, GREEN], review: [SHIP, SHIP], merge: ["merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(count(w.calls(), "flow ci")).toBe(3);
    expect(s.briefs()).toHaveLength(1);
    expect(s.briefs()[0]).toContain("CI is red: 1 failure this change causes");
    expect(s.briefs()[0]).not.toContain("ci-station");
  }, 120_000);

  test("Merge's word that the change would set back main is a conflict the session rebuilds", async () => {
    const w = world({ ci: [GREEN, GREEN], review: [SHIP, SHIP], merge: ["stale", "merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.briefs()).toHaveLength(1);
    expect(s.briefs()[0]).toContain("rebuild the change on main");
  }, 120_000);

  test("a pull request CI reports as conflicting with main goes to the session to bring up to date", async () => {
    const conflicting = { ...GREEN, green: false, failing: [{ ...STATION, excerpt: "#7 has a merge conflict with main, so GitHub runs no CI on it. Rebase it and push." }] };
    const w = world({ ci: [conflicting, GREEN], review: [SHIP, SHIP], merge: ["merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(count(w.calls(), "flow ci")).toBe(2);
    expect(s.briefs()).toHaveLength(1);
    expect(s.briefs()[0]).toContain("conflicts with the default branch, so GitHub runs no CI on it");
    expect(s.briefs()[0]).toContain("has a merge conflict with main");
  }, 120_000);

  test("a push to the branch while CI waits starts a new round, so the new head is reviewed", async () => {
    const w = world({ ci: ["pushed", GREEN], review: [SHIP, SHIP], merge: ["merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(count(w.calls(), "flow pr")).toBe(2);
    expect(s.spawned).toHaveLength(2);
    expect(s.briefs()).toEqual([]);
  }, 120_000);

  test("a branch someone pushes to during every round's CI gets three new rounds, then the run stops and names the head", async () => {
    const w = world({ ci: ["pushed", "pushed", "pushed", "pushed"], review: [SHIP, SHIP, SHIP, SHIP] });
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(count(w.calls(), "flow pr")).toBe(4);
    expect(w.calls()).not.toContain("flow merge");
    expect(s.briefs()).toEqual([]);
    const end = s.sent().at(-1).body;
    expect(end).toContain("stopped at Branch keeps moving");
    expect(end).toContain("the branch moved to stranger");
  }, 120_000);

  test("a second retest in the round keeps the review: each station rebase is of the head the reviewer read", async () => {
    const w = world({ ci: [GREEN, GREEN, GREEN], review: [SHIP], merge: ["retest", "retest", "merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(count(w.calls(), "flow pr --refresh")).toBe(2);
    expect(count(w.calls(), "flow pr")).toBe(1);
    expect(s.spawned).toHaveLength(1);
  }, 120_000);

  test("a red CI too big to print in full still briefs the session, from a short list and the whole ci.json", async () => {
    const failures = Array.from({ length: 20 }, (_, i) => ({ job: "test-cli", test: `t${i}`, assertion: "expected good", file: `src/t${i}.test.ts`, line: i + 1, excerpt: "x".repeat(4096) }));
    const w = world({ ci: [{ ...GREEN, green: false, failing: failures }, GREEN], review: [SHIP, SHIP], merge: ["merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    const [brief] = s.briefs();
    expect(brief).toContain("CI is red: 20 failures this change causes");
    expect(brief).toContain('"failing_count":20');
    expect(brief).toContain(`${w.runDir}/ci.json`);
    expect(brief.length).toBeLessThan(64_000);
  }, 120_000);
});
