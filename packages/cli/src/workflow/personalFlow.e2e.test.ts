// End to end (flows.md FL4): the shipped `personal` flow, Round → Find check →
// Check ‖ Review → Verdicts → Land → Deploy, run by the real runner on real
// git, with a local bare repository as origin. Its stations' commands are a
// fake `cast` on PATH that runs the real pieces: Check runs the commands Find
// check pinned (personalCheck.ts), Land's record is the real `cast flow landed`
// and the checkout catches up through the real `cast land level`. The server
// is a fake that plays Find check, the reviewer (pinning the round's nonce as
// its prompt asks), Deploy, and the session the change came from, which commits
// its fix to the branch when a brief reaches it. A fake `gh` records any call:
// nothing in this flow may open a pull request.
// The harness is personalFlow.testkit.ts; Land's races are in personalFlow.landing.e2e.test.ts, and the Check and the
// person's checkout in personalFlow.checkout.e2e.test.ts. Every test the web replays (RECORD_PERSONAL_REPORTS) is here.
import { describe, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { graphHash, parseWorkflowFile, parseWorkflowSource } from "./parser";
import { landedExitOf, subjectKept } from "./runner";
import { BUILTIN_WORKFLOW_TEMPLATES } from "./templates";
import { evalCondition } from "./condition";
import {
  CHECK, ENV, FAILED, FOUND, GONE, LIVE, NOTHING, REJECTED, SHIP, STALE, expectLanded, git, gitOld, readJson, run, server, test, usePersonalSandbox, world,
} from "./personalFlow.testkit";

usePersonalSandbox();

describe("the shipped personal flow", () => {
  test("the builtin reads the same as the template run from disk", () => {
    const onDisk = parseWorkflowFile(path.join(import.meta.dir, "templates", "personal.cast"));
    expect(graphHash(onDisk)).toBe(graphHash(parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.personal)));
  });

  test("a passing check and a ship verdict land on origin's main, with no pull request, and deploy from the landed sha", async () => {
    const w = world({ find: FOUND, review: [SHIP], deploy: [LIVE] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expectLanded(w);
    expect(s.briefs()).toEqual([]);
    expect(s.spawned("find")).toHaveLength(1);
    // The reviewer is told the round's nonce and the head it judges, which Land pushed.
    const round = readJson(path.join(w.runDir, "round.json"));
    expect(s.spawned("review")[0].prompt).toContain(`"round": "${round.round}"`);
    // Its node shows the verdict it pinned (output="json"), before Verdicts runs.
    expect(JSON.parse(s.result("review")!)).toEqual({ verdict: "ship", findings: [], round: round.round, head_sha: round.head_sha });
    expect(round.head_sha).toBe(w.originMain());
    // Check ran the documented command in the change's tree and recorded it.
    const check = readJson(path.join(w.runDir, "check.json"));
    expect(check).toMatchObject({ outcome: "pass", results: [{ run: CHECK, cwd: ".", source: "README.md:3", exit: 0 }] });
    // Land says what it did, and Deploy is told the landed sha.
    expect(JSON.parse(s.result("land")!)).toMatchObject({ outcome: "landed", sha: w.originMain() });
    expect(JSON.parse(s.result("land")!).note).toContain("caught up");
    // The checkout it catches up is named, as `cast land level --checkout` takes it.
    expect(fs.readFileSync(path.join(process.env.FAKE_STATE!, "calls.log"), "utf-8")).toContain(`land level --checkout ${w.root} --to ${w.originMain()}`);
    expect(s.spawned("deploy")[0].prompt).toContain(`The landed commit: ${w.originMain()}`);
    expect(s.sent().at(-1).body).toMatch(/The Ship run on ct-9 is over: Live[.:] /);
  }, 120_000);

  test("a red check goes back to the session as one brief; its fix comes round again and lands", async () => {
    const w = world({ find: FOUND, review: [SHIP, SHIP], content: "bad\n" });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    const [brief, ...more] = s.briefs();
    expect(more).toEqual([]);
    expect(brief).toContain("check fail, review ship");
    expect(brief).toContain('"exit":1');
    expect(brief).toContain("README.md:3");
    expect(brief).toContain("a.txt says bad, expected good");
    expect(s.ran("round")).toBe(2);
    // The docs are read once a run; the second round runs the same check on the fix.
    expect(s.spawned("find")).toHaveLength(1);
    expect(s.spawned("review")).toHaveLength(2);
    expect(readJson(path.join(w.runDir, "check.json")).outcome).toBe("pass");
    expectLanded(w);
  }, 120_000);

  test("a check the docs do not name is Skipped with its note, and the change lands on the review alone", async () => {
    const w = world({ find: NOTHING, review: [SHIP] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    // Both Find check and Check show Skipped with the note, as the run view reads a station's result.
    expect(JSON.parse(s.result("find_check")!)).toMatchObject({ outcome: "skipped", note: NOTHING.note });
    expect(JSON.parse(s.result("check")!)).toEqual({ outcome: "skipped", note: NOTHING.note, results: [] });
    expect(s.briefs()).toEqual([]);
    expectLanded(w);
  }, 120_000);

  test("a failed deploy goes back to the session to fix the script, and the fix lands and deploys", async () => {
    const w = world({ find: FOUND, review: [SHIP, SHIP], deploy: [FAILED, LIVE] });
    w.fix = (brief) => {
      expect(brief).toContain("./deploy.sh exited 1: no such host");
      expect(brief).toContain("Work in your own checkout. Anything you leave in the run's worktree is carried into the change and lands on main.");
      w.commit("deploy.sh", "#!/bin/sh\nexit 0\n", "fix the deploy");
    };
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.briefs()).toHaveLength(1);
    expect(s.briefs()[0]).toContain("documented deploy failed");
    expect(s.ran("round")).toBe(2);
    expect(s.spawned("deploy")).toHaveLength(2);
    expect(w.onMain("deploy.sh")).toBe("#!/bin/sh\nexit 0\n");
    // The second deploy goes out from the fix's landed sha.
    expect(s.spawned("deploy")[1].prompt).toContain(`The landed commit: ${w.originMain()}`);
    expectLanded(w);
  }, 120_000);

  test("a deploy fix that leaves nothing new to land sends the run straight back to Deploy, which goes live", async () => {
    const w = world({ find: FOUND, review: [SHIP], deploy: [FAILED, LIVE] });
    // The session fixes what broke outside the repository: nothing on its branch changes.
    w.fix = (brief) => { expect(brief).toContain("documented deploy failed"); };
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.briefs()).toHaveLength(1);
    expect(s.spawned("deploy")).toHaveLength(2);
    // No new round: the same landed commit deploys again.
    expect(s.ran("round")).toBe(1);
    expect(s.ran("land")).toBe(1);
    expect(s.spawned("review")).toHaveLength(1);
    expect(s.spawned("deploy")[1].prompt).toContain(`The landed commit: ${w.originMain()}`);
    expect(s.sent().at(-1).body).toMatch(/is over: Live[.:] /);
    expectLanded(w);
  }, 120_000);

  test("a deploy that still fails after three fixes outside the repository stops the run failed, never Live", async () => {
    const w = world({ find: FOUND, review: [SHIP], deploy: [FAILED, FAILED, FAILED, FAILED] });
    w.fix = () => {};
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(s.briefs()).toHaveLength(3);
    expect(s.spawned("deploy")).toHaveLength(4);
    const end = s.sent().at(-1).body;
    expect(end).not.toContain("is over: Live");
    expect(end).toContain("stopped at");
    expect(end).toContain("sent the change back 3 times");
    expect(end).toContain("The change is on the default branch");
  }, 120_000);

  test("a briefed session that puts its change on main itself stops the run: it landed and deployed nothing", async () => {
    const w = world({ find: FOUND, review: [SHIP], content: "bad\n" });
    w.fix = () => { w.commit("a.txt", "good\n", "make a.txt good"); w.pushMain(); };
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(s.briefs()).toHaveLength(1);
    expect(s.ran("round")).toBe(2);
    expect(s.ran("land")).toBe(0);
    expect(s.spawned("deploy")).toHaveLength(0);
    expect(s.sent().at(-1).body).toContain(`stopped at Left the run: ${GONE}`);
  }, 120_000);

  test("a deploy fix the session puts on main itself stops the run: the fix was not landed or deployed by it", async () => {
    const w = world({ find: FOUND, review: [SHIP], deploy: [FAILED, LIVE] });
    w.fix = () => { w.commit("deploy.sh", "#!/bin/sh\nexit 0\n", "fix the deploy"); w.pushMain(); };
    const s = server(w);
    expect(await run(w)).toBe("failed");
    const landed = /The landed commit: ([0-9a-f]{40})/.exec(s.spawned("deploy")[0].prompt)![1];
    expect(s.spawned("deploy")).toHaveLength(1);
    expect(s.ran("land")).toBe(1);
    const end = s.sent().at(-1).body;
    // The stop's words stand alone: nothing appended after them.
    expect(end).toEndWith(`stopped at Left the run: The fix left the run: nothing of it is above origin/main any more. This run landed ${landed} earlier and deployed nothing after it.`);
  }, 120_000);

  test("only a deploy that saw the landed sha running ends Live: the rest end Deployed, unverified or Landed", async () => {
    const ends: Array<[object, string]> = [
      [{ ...LIVE, outcome: "unverified", seen_live: null, note: "no version endpoint" }, "is over: Deployed, unverified."],
      [{ ...LIVE, sha: "0123456789abcdef0123456789abcdef01234567" }, "is over: Deployed, unverified."],
      [{ ...LIVE, seen_live: null }, "is over: Deployed, unverified."],
      [{ ...LIVE, outcome: "skipped", seen_live: null, commands: [], note: "No deploy documented: looked at README.md." }, "is over: Landed."],
    ];
    for (const [answer, end] of ends) {
      const w = world({ find: FOUND, review: [SHIP], deploy: [answer] });
      const s = server(w);
      expect(await run(w)).toBe("completed");
      expect(s.sent().at(-1).body).toContain(end);
      expectLanded(w);
    }
  }, 480_000);

  test("a session that drops its change when briefed stops the run: old main is never deployed", async () => {
    const w = world({ find: FOUND, review: [SHIP, SHIP], content: "bad\n" });
    // It resets its branch to main: nothing of the change is left anywhere.
    w.fix = () => { git(w.root, "fetch", "-q", "origin"); git(w.root, "update-ref", "refs/heads/feat", git(w.root, "rev-parse", "origin/main")); };
    const s = server(w);
    const main = w.originMain();
    expect(await run(w)).toBe("failed");
    expect(s.spawned("deploy")).toHaveLength(0);
    expect(w.originMain()).toBe(main);
    const end = s.sent().at(-1).body;
    // Its own words stand: no "not landed, run it again" after them.
    expect(end).toEndWith(`stopped at Left the run: ${GONE}`);
  }, 120_000);

  test("regression P1: a session that drops its change while someone else lands the same file stops, deploying nothing", async () => {
    const w = world({ find: FOUND, review: [SHIP, SHIP], content: "bad\n" });
    w.fix = () => { w.pushElsewhere("a.txt", "someone else's\n"); git(w.root, "fetch", "-q", "origin"); git(w.root, "update-ref", "refs/heads/feat", git(w.root, "rev-parse", "origin/main")); };
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(s.spawned("deploy")).toHaveLength(0);
    expect(s.ran("land")).toBe(0);
    expect(s.sent().at(-1).body).toContain(`stopped at Left the run: ${GONE}`);
  }, 120_000);

  test("regression P2: a deploy fix committed in the repository comes round and lands while main moves elsewhere", async () => {
    const w = world({ find: FOUND, review: [SHIP, SHIP], deploy: [FAILED, LIVE] });
    w.fix = () => { w.pushElsewhere("b.txt", "x\n"); w.commit("deploy.sh", "#!/bin/sh\nexit 0\n", "fix the deploy"); };
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.ran("round")).toBe(2);
    expect(s.ran("land")).toBe(2);
    expect(s.spawned("review")).toHaveLength(2);
    expect(w.onMain("deploy.sh")).toBe("#!/bin/sh\nexit 0\n");
    expect(w.onMain("b.txt")).toBe("x\n");
    expect(s.spawned("deploy")[1].prompt).toContain(`The landed commit: ${w.originMain()}`);
    expect(s.sent().at(-1).body).toMatch(/is over: Live[.:] /);
  }, 120_000);

  test("regression P3: a session that lands a reworked change itself, in another file, stops: the run deployed nothing", async () => {
    const w = world({ find: FOUND, review: [SHIP, SHIP], content: "bad\n" });
    w.fix = () => { w.commit("a.txt", "base\n", "drop a.txt"); w.commit("c.txt", "the real change\n", "do it in c.txt"); w.pushMain(); };
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(w.onMain("c.txt")).toBe("the real change\n");
    expect(s.spawned("deploy")).toHaveLength(0);
    expect(s.ran("land")).toBe(0);
    expect(s.sent().at(-1).body).toContain(`stopped at Left the run: ${GONE}`);
  }, 120_000);

  test("a deploy fix outside the repository deploys the run's own landing again, with its own note, after main moved", async () => {
    const w = world({ find: FOUND, review: [SHIP], deploy: [FAILED, LIVE] });
    w.pushElsewhere();
    w.fix = () => {};
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.ran("round")).toBe(1);
    expect(s.spawned("review")).toHaveLength(1);
    const [first, second] = s.spawned("deploy").map((d) => /The landed commit: ([0-9a-f]{40})/.exec(d.prompt)![1]);
    expect(second).toBe(first);
    expect(first).toBe(w.originMain());
    expect(JSON.parse(s.result("landed")!).note).toContain("pushed main");
    expect(JSON.parse(s.result("after_fix")!)).toMatchObject({ next: "deploy" });
    expect(s.sent().at(-1).body).toMatch(/is over: Live[.:] /);
    expectLanded(w);
  }, 120_000);

  test("a remote that refuses the push (a protected branch) stops at Not landed at once, never as main moving", async () => {
    const w = world({ find: FOUND, review: [SHIP] });
    fs.writeFileSync(path.join(w.origin, "hooks", "pre-receive"), "#!/bin/sh\necho protected branch >&2\nexit 1\n", { mode: 0o755 });
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(s.ran("land")).toBe(1);
    expect(s.ran("round")).toBe(1);
    const end = s.sent().at(-1).body;
    // Land's own words, never its raw JSON.
    expect(end).toContain("stopped at Not landed: git push origin main failed:");
    expect(end).not.toContain('{"outcome"');
    expect(end).toContain("git push origin main failed");
    expect(end).toContain("remote rejected");
    // The push definitely failed: no marker says this run set out to push that head any more.
    expect(fs.existsSync(path.join(w.runDir, "land-pushing-run-9"))).toBe(false);
    // The personal Ship lands, and runs as change.
    expect(end).toContain("The change was not landed. Run it again with `cast flow run change` once it is ready.");
  }, 120_000);

  test("a push whose landing could not be recorded stops saying the push succeeded, never that nothing landed", async () => {
    const w = world({ find: FOUND, review: [SHIP] });
    fs.writeFileSync(path.join(process.env.FAKE_STATE!, "landed-fails"), "");
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(s.spawned("deploy")).toHaveLength(0);
    expect(w.onMain("a.txt")).toBe("good\n");
    const end = s.sent().at(-1).body;
    expect(end).toContain(`stopped at Landing not recorded: the push to origin/main succeeded at ${w.originMain().slice(0, 10)}, but recording it on the run failed: the server did not answer`);
    expect(end).toContain("The change is on the default branch");
    expect(end).not.toContain("not landed");
  }, 120_000);

  test("regression A: an own-edits deploy fix the session commits and pushes itself stops at Main moved, deploying nothing more", async () => {
    const w = world({ find: FOUND, review: [SHIP, SHIP], deploy: [FAILED, LIVE], own: true });
    w.fix = () => { w.edit("deploy.sh", "#!/bin/sh\nexit 0\n"); w.pushMain(); };
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(s.spawned("deploy")).toHaveLength(1);
    expect(s.ran("land")).toBe(1);
    expect(JSON.parse(s.result("after_fix")!).next).toBe("moved");
    const end = s.sent().at(-1).body;
    const landed = /The landed commit: ([0-9a-f]{40})/.exec(s.spawned("deploy")[0].prompt)![1];
    expect(end).toEndWith(`stopped at Main moved: A newer commit landed on top of ${landed.slice(0, 10)}, so this run deploys nothing rather than an older commit over it. Deploy the newest main the way the project deploys, or ship your next change, and its deploy will carry this one.`);
  }, 120_000);

  test("regression P: an own-edits deploy fix committed in the checkout but not pushed stops and says so, never dropped", async () => {
    const w = world({ find: FOUND, review: [SHIP, SHIP], deploy: [FAILED, LIVE], own: true });
    w.fix = () => { w.edit("deploy.sh", "#!/bin/sh\nexit 0\n"); git(w.root, "commit", "-qam", "fix deploy locally"); };
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(s.spawned("deploy")).toHaveLength(1);
    expect(JSON.parse(s.result("after_fix")!).next).toBe("unpushed");
    const end = s.sent().at(-1).body;
    expect(end).toContain("stopped at Fix not shipped");
    // The reset goes back to where the session's commit starts: the landing the checkout caught up to.
    expect(end).toEndWith(`stopped at Fix not shipped: 1 commit(s) made in your checkout since this run began that origin/main lacks. This run ships uncommitted edits only, so it can't take them, and it deployed nothing more. To ship them, turn them back into uncommitted edits (\`git reset --soft ${git(w.root, "rev-parse", "HEAD~1").slice(0, 12)}\`) and Ship again.`);
    expect(end).toContain("Ship again");
  }, 120_000);

  test("regression S: an own-edits session that commits its fix after a red check stops at Fix not shipped, saying so plainly", async () => {
    const w = world({ find: FOUND, review: [SHIP, SHIP], own: true, content: "bad\n" });
    w.fix = (brief) => {
      // The brief tells it to leave the fix uncommitted; this one commits anyway, as a global rule might tell it to.
      expect(brief).toContain("Leave the fix as uncommitted edits in this checkout, and do not commit or push it");
      w.edit("a.txt", "good\n");
      git(w.root, "commit", "-qam", "fix locally");
    };
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(s.spawned("deploy")).toHaveLength(0);
    expect(s.ran("land")).toBe(0);
    expect(JSON.parse(s.result("committed")!).next).toBe("unpushed");
    const end = s.sent().at(-1).body;
    // The reset goes back to the run's baseline: the checkout as the run began.
    expect(end).toEndWith(`stopped at Fix not shipped: 1 commit(s) made in your checkout since this run began that origin/main lacks. This run ships uncommitted edits only, so it can't take them, and it landed and deployed nothing of them. To ship them, turn them back into uncommitted edits (\`git reset --soft ${fs.readFileSync(path.join(w.runDir, "checkout-run-9"), "utf-8").trim().slice(0, 12)}\`) and Ship again.`);
    expect(end).not.toContain("Could not freeze");
  }, 120_000);

  test("regression U2: Deploy runs in a worktree at the landed commit with nothing the Check left in it", async () => {
    const w = world({ find: { ...FOUND, commands: [{ run: "./check.sh && echo formatted >> README.md && echo junk > stray.txt", cwd: ".", source: "README.md:3" }] }, review: [SHIP] });
    const seen: string[] = [];
    w.onDeploy = () => seen.push(`${git(w.wt, "rev-parse", "HEAD")} ${git(w.wt, "status", "--porcelain")}`.trim());
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(seen).toEqual([w.originMain()]);
    expect(s.sent().at(-1).body).toMatch(/is over: Live[.:] /);
  }, 120_000);

  test("regression U3b: own edits rebased under Land, then a deploy fix outside the repository, deploys again by tree", async () => {
    const w = world({ find: FOUND, review: [SHIP, SHIP, SHIP], deploy: [FAILED, LIVE], own: true });
    // m.txt joins main and origin; the session's edits (a.txt, and m.txt's line 2) stay uncommitted.
    fs.writeFileSync(path.join(w.root, "m.txt"), "1\n2\n3\n4\n5\n6\n7\n");
    gitOld(w.root, "add", "m.txt");
    gitOld(w.root, "commit", "-qm", "m");
    git(w.root, "push", "-q", "origin", "main");
    w.edit("m.txt", "1\nTWO\n3\n4\n5\n6\n7\n");
    // Main changes line 5 under Land: a clean rebase, a different patch.
    w.onReview = (n) => { if (n === 1) w.pushElsewhere("m.txt", "1\n2\n3\n4\nFIVE\n6\n7\n"); };
    w.fix = () => {};
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(JSON.parse(s.result("after_fix")!).next).toBe("deploy");
    const [first, second] = s.spawned("deploy").map((d) => /The landed commit: ([0-9a-f]{40})/.exec(d.prompt)![1]);
    expect(second).toBe(first);
    expect(w.onMain("m.txt")).toBe("1\nTWO\n3\n4\nFIVE\n6\n7\n");
    expect(s.sent().at(-1).body).toMatch(/is over: Live[.:] /);
  }, 180_000);

  test("regression U5: the person's own earlier unpushed commit is not taken for the session's fix", async () => {
    const w = world({ find: FOUND, review: [SHIP, SHIP], deploy: [FAILED, LIVE], own: true });
    fs.writeFileSync(path.join(w.root, "z.txt"), "mine\n");
    gitOld(w.root, "add", "z.txt");
    gitOld(w.root, "commit", "-qm", "local unpushed");
    w.pushElsewhere();
    w.fix = () => {};
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(JSON.parse(s.result("after_fix")!).next).toBe("deploy");
    expect(s.spawned("deploy")).toHaveLength(2);
    expect(s.sent().at(-1).body).toMatch(/is over: Live[.:] /);
  }, 180_000);

  test("main that moves under Land four times in a row stops at Main keeps moving", async () => {
    const w = world({ find: FOUND, review: Array(4).fill(SHIP) });
    let pushes = 0;
    w.onReview = () => w.pushElsewhere("b.txt", `theirs ${++pushes}\n`);
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(s.ran("land")).toBe(4);
    expect(JSON.parse(s.result("land")!).moves).toBe(4);
    expect(s.sent().at(-1).body).toContain("stopped at Main keeps moving");
  }, 240_000);

  test("r6 #3: a change the session pushes itself during Check and Review left the run; it is never the run's landing", async () => {
    const w = world({ find: FOUND, review: [SHIP], deploy: [LIVE] });
    w.onReview = () => w.pushMain();
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(s.spawned("deploy")).toHaveLength(0);
    expect(JSON.parse(s.result("land")!)).toMatchObject({ outcome: "left" });
    expect(s.sent().at(-1).body).toEndWith(`stopped at Left the run: ${GONE}`);
  }, 120_000);

  test("the session the change came from is retired only from Live: never Deployed, unverified, Landed, or with a step left", async () => {
    const stays = /the session the change came from stays: the run ended at (.*)/;
    const ends: Array<[object, string | null]> = [
      [LIVE, null],
      [{ ...LIVE, outcome: "unverified", seen_live: null }, "the run ended at Deployed, unverified, which leaves something for a person"],
      [{ ...LIVE, outcome: "skipped", seen_live: null, commands: [] }, "the run ended at Landed, which leaves something for a person"],
      [{ ...LIVE, left_for_you: "Reload the extension." }, "the run ended at Live, past Left for you, which leaves something for a person"],
    ];
    for (const [answer, kept] of ends) {
      const w = world({ find: FOUND, review: [SHIP], deploy: [answer] });
      server(w);
      expect(await run(w)).toBe("completed");
      const said = w.log.find((l) => stays.test(l));
      if (kept) {
        expect(said).toContain(kept);
        expect(w.log.some((l) => /jx7ssss stays: /.test(l))).toBe(false);
      }
      else {
        expect(said).toBeUndefined();
        // From Live the runner goes on to ask whether it may retire it (here the harness's session stays, for its own reason).
        expect(w.log.some((l) => /jx7ssss stays: /.test(l))).toBe(true);
      }
    }
  }, 480_000);

  test("a deploy with one step left for the person ends Live, with that step on the task", async () => {
    const step = "Reload the extension at chrome://extensions.";
    const w = world({ find: FOUND, review: [SHIP], deploy: [{ ...LIVE, left_for_you: step }] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.sent().at(-1).body).toMatch(/is over: Live[.:] /);
    const log = fs.readFileSync(path.join(process.env.FAKE_STATE!, "calls.log"), "utf-8");
    expect(log).toContain(`task comment ct-9 One step left for you: ${step} -t review`);
    expect(JSON.parse(s.result("deploy")!)).toMatchObject({ outcome: "live", left_for_you: step });
    expectLanded(w);
  }, 120_000);

  test("main that moves under Land sends the change back to Round once, then it lands on the new main", async () => {
    const w = world({ find: FOUND, review: [SHIP, SHIP] });
    w.onReview = (n) => { if (n === 1) w.pushElsewhere(); };
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.ran("round")).toBe(2);
    expect(s.ran("land")).toBe(2);
    expect(s.briefs()).toEqual([]);
    // What landed sits on the commit someone else pushed.
    expect(w.onMain("b.txt")).toBe("theirs\n");
    expectLanded(w);
  }, 120_000);

  test("a pin with another round's nonce asks the reviewer once more in that round, a second round included", async () => {
    const w = world({ find: FOUND, review: [SHIP, STALE, SHIP], content: "bad\n" });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.briefs()).toHaveLength(1);
    expect(s.spawned("review")).toHaveLength(3);
    expectLanded(w);
  }, 120_000);

  test("a reviewer that pins no verdict for the round twice stops the run, briefing nobody and landing nothing", async () => {
    const w = world({ find: FOUND, review: [STALE, STALE] });
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(s.briefs()).toEqual([]);
    expect(s.sent().at(-1).body).toContain("stopped at Review never finished");
    expect(w.originMain()).toBe(git(w.root, "rev-parse", "main"));
    expect(s.ran("land")).toBe(0);
  }, 120_000);

  test("a rejection ends the run at Rejected with the reviewer's reasons, and nothing lands", async () => {
    const w = world({ find: FOUND, review: [REJECTED] });
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(s.ran("land")).toBe(0);
    expect(s.sent().at(-1).body).toContain("stopped at Rejected");
    expect(s.sent().at(-1).body).toContain("the task should not be done at all");
  }, 120_000);

  test("changes asked beside a passing check go back to the session as one brief, and its fix lands on a fresh review", async () => {
    const changes = { verdict: "changes", findings: ["medium a.txt:1 the change has no note of why, P3"] };
    const w = world({ find: FOUND, review: [changes, SHIP] });
    w.fix = (brief) => w.commit("why.txt", "because\n", `answer: ${brief.includes("the change has no note of why") ? "noted" : "missed"}`);
    const s = server(w);
    expect(await run(w)).toBe("completed");
    const [brief, ...more] = s.briefs();
    expect(more).toEqual([]);
    expect(brief).toContain("check pass, review changes");
    expect(brief).toContain("the change has no note of why");
    expect(s.ran("round")).toBe(2);
    expect(s.spawned("review")).toHaveLength(2);
    expect(w.onMain("why.txt")).toBe("because\n");
    expect(git(w.root, "log", "-1", "--format=%s", "origin/main")).toBe("answer: noted");
    expectLanded(w);
  }, 120_000);

  test("with no session behind the change, each stop that would brief one ends the run, saying so", async () => {
    const reason = (s: ReturnType<typeof server>) => [...s.calls].reverse().find((c) => c.route === "/cli/workflow-runs/progress" && c.body.fail_reason)?.body.fail_reason as string;
    const conflict = world({ find: FOUND, review: [SHIP], nobody: true });
    conflict.pushElsewhere("a.txt", "theirs\n");
    let s = server(conflict);
    expect(await run(conflict)).toBe("failed");
    expect(s.briefs()).toEqual([]);
    expect(reason(s)).toContain("The change conflicts with the default branch, and no session made it to fix it: Rebasing the change onto origin/main");
    const red = world({ find: FOUND, review: [SHIP], content: "bad\n", nobody: true });
    s = server(red);
    expect(await run(red)).toBe("failed");
    expect(s.briefs()).toEqual([]);
    expect(reason(s)).toContain("The check or the reviewer found work, and no session made this change to fix it: check fail, review ship");
    const failed = world({ find: FOUND, review: [SHIP], deploy: [FAILED], nobody: true });
    s = server(failed);
    expect(await run(failed)).toBe("failed");
    expect(s.briefs()).toEqual([]);
    expect(reason(s)).toContain("The documented deploy failed, and no session made this change to fix it: ./deploy.sh exited 1: no such host");
  }, 240_000);

  test("a change that conflicts with main goes back to the session to resolve, then lands on the new main", async () => {
    const w = world({ find: FOUND, review: [SHIP] });
    w.pushElsewhere("a.txt", "theirs\n");
    // The session brings its change up to date: the change rebuilt on origin's main, keeping main's README.
    w.fix = (brief) => {
      expect(brief).toContain("conflicted in: a.txt");
      git(w.root, "fetch", "-q", "origin");
      const env = { ...process.env, ...ENV, GIT_INDEX_FILE: path.join(process.env.FAKE_STATE!, "index") };
      execFileSync("git", ["-C", w.root, "read-tree", "origin/main"], { env });
      const blob = execFileSync("git", ["-C", w.root, "hash-object", "-w", "--stdin"], { input: "good\n", encoding: "utf-8" }).trim();
      execFileSync("git", ["-C", w.root, "update-index", "--cacheinfo", `100644,${blob},a.txt`], { env });
      const tree = execFileSync("git", ["-C", w.root, "write-tree"], { env, encoding: "utf-8" }).trim();
      git(w.root, "update-ref", "refs/heads/feat", git(w.root, "commit-tree", tree, "-p", "origin/main", "-m", "the change, on main"));
    };
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.briefs()).toHaveLength(1);
    expect(s.ran("round")).toBe(2);
    expect(s.spawned("review")).toHaveLength(1);
    expectLanded(w);
  }, 120_000);

  test("a rebase an earlier Round was cut off in is aborted first, so the round starts and the change lands", async () => {
    const w = world({ find: FOUND, review: [SHIP] });
    // A Round killed mid-rebase leaves the rebase in progress in the run's worktree: here, one stopped at a break.
    execFileSync("git", ["-C", w.wt, "rebase", "-q", "-i", "HEAD~1"], { env: { ...process.env, ...ENV, GIT_SEQUENCE_EDITOR: "sed -i.bak -e '1i\\\nbreak'" } });
    expect(fs.existsSync(git(w.wt, "rev-parse", "--git-path", "rebase-merge"))).toBe(true);
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.sent().at(-1).body).toMatch(/is over: Live[.:] /);
    expectLanded(w);
  }, 120_000);

  test("a change to .codecast and .github lands with no card and no merge authority asked", async () => {
    const w = world({ find: FOUND, review: [SHIP], extra: { ".codecast/notes.md": "notes\n", ".github/workflows/ci.yml": "on: push\n" } });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.calls.filter((c) => /gate|decide|approval/.test(c.route))).toEqual([]);
    expect(w.onMain(".github/workflows/ci.yml")).toBe("on: push\n");
    expect(w.onMain(".codecast/notes.md")).toBe("notes\n");
    expectLanded(w);
  }, 120_000);
});

describe("which ends keep the session the change came from", () => {
  const graph = parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.personal);
  const node = (id: string) => graph.nodes.get(id)!;
  test("Live keeps nothing; Deployed, unverified, Landed and a step left for the person keep it", () => {
    expect(subjectKept(graph, ["land", "landed", "deploy"], node("exit"))).toBeNull();
    expect(subjectKept(graph, ["land", "landed", "deploy"], node("unverified"))?.id).toBe("unverified");
    expect(subjectKept(graph, ["land", "landed", "deploy"], node("nodeploy"))?.id).toBe("nodeploy");
    expect(subjectKept(graph, ["land", "landed", "deploy", "left"], node("exit"))?.id).toBe("left");
    const change = parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.change);
    expect(subjectKept(change, ["merge", "landed"], change.nodes.get("exit")!)).toBeNull();
  });
});

describe("a session that lands its change itself", () => {
  const graph = parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.personal);
  /** Where the runner goes from a station: the first conditional edge that holds, else its unconditional one. */
  const next = (from: string, context: Record<string, string>) => {
    const out = graph.edges.filter((e) => e.from === from);
    return (out.find((e) => e.condition && evalCondition(e.condition, context)) ?? out.find((e) => !e.condition))?.to;
  };
  test("a brief whose change left the run stops there; a deploy fix goes to After the fix; the runner never ends the run done", () => {
    for (const id of ["brief", "fix_conflict", "deploy_fix"]) expect(landedExitOf(graph, graph.nodes.get(id)!, { change_landed: "abc1234567" })).toBeNull();
    for (const id of ["brief", "fix_conflict"]) {
      expect(next(id, { change_landed: "abc1234567" })).toBe("leftrun");
      expect(next(id, {})).toBe("round");
    }
    expect(next("deploy_fix", { change_landed: "abc1234567" })).toBe("after_fix");
    expect(next("deploy_fix", {})).toBe("after_fix");
    expect(next("after_fix", { outcome: "success", "after_fix.json": '{"next":"deploy"}' })).toBe("deploy");
    expect(next("after_fix", { outcome: "success", "after_fix.json": '{"next":"round"}' })).toBe("round");
    // A reviewer asked again is bounded by verdicts_at, which a resume (Verdicts' visits start again) never strands.
    const noPin = { "check.json": '{"outcome":"pass"}', "round.json": '{"round":"r1","verdicts_at":5}', "review.json": '{"verdict":"ship","round":"r0"}' };
    expect(next("verdicts", { ...noPin, "verdicts.visits": "1" })).toBe("review");
    expect(next("verdicts", { ...noPin, "verdicts.visits": "6" })).toBe("unreviewed");
  });
  test("a flow whose fix station does not route it still ends done there", () => {
    const change = parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.change);
    expect(landedExitOf(change, change.nodes.get("brief")!, { change_landed: "abc1234567" })?.label).toBe("Live");
  });
});
