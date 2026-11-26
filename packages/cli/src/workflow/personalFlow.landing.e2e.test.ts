// End to end (flows.md FL4): the personal flow's Land when origin, the push or its own station misbehaves: a push whose
// answer is lost, origin that cannot be read, a Land cut off mid-push or mid-catch-up, and resuming each. The harness
// is personalFlow.testkit.ts.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { ENV, FAILED, FOUND, LIVE, SHIP, expectLanded, git, resumeAt, run, server, usePersonalSandbox, world } from "./personalFlow.testkit";

usePersonalSandbox();

describe("the personal flow's Land, when origin, the push or the station misbehaves", () => {
  test("Main keeps moving counts only the moves since the last landing", async () => {
    const w = world({ find: FOUND, review: Array(6).fill(SHIP), deploy: [FAILED, LIVE] });
    let pushes = 0;
    w.onReview = (n) => { if ([1, 3, 4, 5].includes(n)) w.pushElsewhere("b.txt", `theirs ${++pushes}\n`); };
    w.fix = () => w.commit("deploy.sh", "#!/bin/sh\nexit 0\n", "fix the deploy");
    const s = server(w);
    expect(await run(w)).toBe("completed");
    // Six visits to Land, four of them moves: one before the first landing, three after it.
    expect(s.ran("land")).toBe(6);
    expect(w.onMain("deploy.sh")).toBe("#!/bin/sh\nexit 0\n");
    expect(s.sent().at(-1).body).toContain("is over: Live.");
  }, 240_000);

  test("a Land run again on a head it set out to push, which origin already holds, goes straight to recording", async () => {
    const w = world({ find: FOUND, review: [SHIP] });
    // As a Land cut off after its push leaves it: origin at the round's head, and the pushing marker naming it.
    w.onReview = () => {
      git(w.wt, "push", "-q", "origin", "HEAD:main");
      fs.writeFileSync(path.join(w.runDir, "land-pushing-run-9"), `${git(w.wt, "rev-parse", "HEAD")}\n`);
    };
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.ran("land")).toBe(1);
    expect(s.ran("round")).toBe(1);
    expect(JSON.parse(s.result("land")!)).toMatchObject({ outcome: "landed", sha: w.originMain() });
    expectLanded(w);
  }, 120_000);

  test("regression H1: a push that lands on origin but loses its answer is a landing, recorded and deployed", async () => {
    const w = world({ find: FOUND, review: [SHIP] });
    // origin commits the ref, then the connection drops before the client hears it.
    const flag = path.join(w.origin, "hung-once");
    fs.writeFileSync(path.join(w.origin, "hooks", "reference-transaction"), `#!/bin/sh\n[ "$1" = committed ] || exit 0\n[ -e "${flag}" ] && exit 0\ngrep -q refs/heads/main || exit 0\ntouch "${flag}"\nkill -9 $PPID\nexit 0\n`, { mode: 0o755 });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(fs.existsSync(flag)).toBe(true);
    expect(s.ran("land")).toBe(1);
    expect(fs.readFileSync(path.join(w.runDir, "land-pushed-run-9"), "utf-8").trim()).toBe(w.originMain());
    expect(s.sent().at(-1).body).toContain("is over: Live.");
    expectLanded(w);
  }, 120_000);

  test("a newer commit landed on top before the first Deploy stops at Main moved, deploying nothing", async () => {
    const w = world({ find: FOUND, review: [SHIP] });
    const other = path.join(w.root, "..", "late");
    fs.writeFileSync(path.join(process.env.FAKE_STATE!, "after-land.sh"), `#!/bin/sh\nset -e\ngit clone -q "${w.origin}" "${other}"\ncd "${other}"\necho late > late.txt\ngit add late.txt\ngit -c user.name=t -c user.email=t@t commit -qm late\ngit push -q origin HEAD:main\n`, { mode: 0o755 });
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(s.spawned("deploy")).toHaveLength(0);
    expect(w.onMain("late.txt")).toBe("late\n");
    const end = s.sent().at(-1).body;
    const landed = JSON.parse(s.result("land")!).sha;
    expect(end).toEndWith(`stopped at Main moved: A newer commit landed on top of ${landed.slice(0, 10)}, so this run deploys nothing rather than an older commit over it. Deploy the newest main the way the project deploys, or ship your next change, and its deploy will carry this one.`);
  }, 120_000);

  test("r7 #3: a push whose answer is lost while origin cannot be read stops at Landing unknown, never Not landed", async () => {
    const w = world({ find: FOUND, review: [SHIP] });
    const flag = path.join(w.origin, "hung-once");
    fs.writeFileSync(path.join(w.origin, "hooks", "reference-transaction"), `#!/bin/sh\n[ "$1" = committed ] || exit 0\n[ -e "${flag}" ] && exit 0\ngrep -q refs/heads/main || exit 0\ntouch "${flag}"\ntouch "${process.env.FAKE_STATE}/fetch-fails"\nkill -9 $PPID\nexit 0\n`, { mode: 0o755 });
    const s = server(w);
    try {
      expect(await run(w)).toBe("failed");
    } finally {
      fs.rmSync(path.join(process.env.FAKE_STATE!, "fetch-fails"), { force: true });
    }
    const head = JSON.parse(fs.readFileSync(path.join(w.runDir, "round.json"), "utf-8")).head_sha;
    expect(w.originMain()).toBe(head);
    expect(s.spawned("deploy")).toHaveLength(0);
    // The marker stays, so a resume of this run takes the landing as its own.
    expect(fs.readFileSync(path.join(w.runDir, "land-pushing-run-9"), "utf-8").trim()).toBe(head);
    const end = s.sent().at(-1).body;
    expect(end).toContain(`stopped at Landing unknown: It is not known whether this run landed: the push of ${head.slice(0, 10)} to origin/main may have landed: its answer was lost (`);
    expect(end).toEndWith(`and origin could not be read to check. Check origin's main (\`git ls-remote origin main\`) once origin can be reached, then resume this run (\`cast workflow resume ct-9 --at land\`): it records the landing and carries on if ${head} landed, and pushes it again if not. Don't start a new Ship.`);
    expect(end).not.toContain("not landed");
    // The advice works: resumed at land, the run takes the landing as its own, records it, deploys it and ends Live.
    const s2 = server(w);
    expect(await resumeAt(w, "land")).toBe("completed");
    expect(s2.ran("round")).toBe(0);
    expect(JSON.parse(s2.result("land")!)).toMatchObject({ outcome: "landed", sha: head });
    expect(s2.spawned("deploy")[0].prompt).toContain(`The landed commit: ${head}`);
    expect(s2.sent().at(-1).body).toContain("is over: Live.");
    expectLanded(w);
  }, 180_000);

  test("r8 #1: a resumed Land that set out to push the head and still cannot read origin says Landing unknown again, never Not landed", async () => {
    const w = world({ find: FOUND, review: [SHIP] });
    const flag = path.join(w.origin, "hung-once");
    fs.writeFileSync(path.join(w.origin, "hooks", "reference-transaction"), `#!/bin/sh\n[ "$1" = committed ] || exit 0\n[ -e "${flag}" ] && exit 0\ngrep -q refs/heads/main || exit 0\ntouch "${flag}"\ntouch "${process.env.FAKE_STATE}/fetch-fails"\nkill -9 $PPID\nexit 0\n`, { mode: 0o755 });
    server(w);
    try {
      expect(await run(w)).toBe("failed");
      // Resumed while origin still cannot be read: it still cannot tell.
      const s2 = server(w);
      expect(await resumeAt(w, "land")).toBe("failed");
      const end = s2.sent().at(-1).body;
      expect(end).toContain("stopped at Landing unknown: It is not known whether this run landed: the push of ");
      expect(end).toContain("may have landed, and origin could not be read to check: fatal: unable to access origin");
      expect(end).not.toContain("Not landed");
      expect(JSON.parse(s2.result("land")!)).toMatchObject({ outcome: "unknown" });
    } finally {
      fs.rmSync(path.join(process.env.FAKE_STATE!, "fetch-fails"), { force: true });
    }
    // Once origin can be read, the same resume lands it.
    const s3 = server(w);
    expect(await resumeAt(w, "land")).toBe("completed");
    expect(s3.sent().at(-1).body).toContain("is over: Live.");
  }, 240_000);

  test("r7 #3: when the lost push never reached origin, resuming at land pushes it and lands", async () => {
    const w = world({ find: FOUND, review: [SHIP] });
    // origin refuses the ref before committing it and the connection drops; origin cannot be read either.
    const flag = path.join(w.origin, "dropped-once");
    fs.writeFileSync(path.join(w.origin, "hooks", "pre-receive"), `#!/bin/sh\n[ -e "${flag}" ] && exit 0\ntouch "${flag}"\ntouch "${process.env.FAKE_STATE}/fetch-fails"\nkill -9 $PPID\nexit 1\n`, { mode: 0o755 });
    const s = server(w);
    const main = w.originMain();
    try {
      expect(await run(w)).toBe("failed");
    } finally {
      fs.rmSync(path.join(process.env.FAKE_STATE!, "fetch-fails"), { force: true });
    }
    expect(w.originMain()).toBe(main);
    expect(s.sent().at(-1).body).toContain("stopped at Landing unknown");
    const head = JSON.parse(fs.readFileSync(path.join(w.runDir, "round.json"), "utf-8")).head_sha;
    const s2 = server(w);
    expect(await resumeAt(w, "land")).toBe("completed");
    expect(w.originMain()).toBe(head);
    expect(JSON.parse(s2.result("land")!)).toMatchObject({ outcome: "landed", sha: head });
    expect(s2.sent().at(-1).body).toContain("is over: Live.");
    expectLanded(w);
  }, 180_000);

  test("r6 #2: origin that cannot be read before Deploy stops the run, never deploying an older commit over a newer one", async () => {
    const w = world({ find: FOUND, review: [SHIP] });
    const other = path.join(w.root, "..", "late");
    fs.writeFileSync(path.join(process.env.FAKE_STATE!, "after-land.sh"), `#!/bin/sh\nset -e\ngit clone -q "${w.origin}" "${other}"\ncd "${other}"\necho late > late.txt\ngit add late.txt\ngit -c user.name=t -c user.email=t@t commit -qm late\ngit push -q origin HEAD:main\ntouch "$FAKE_STATE/fetch-fails"\n`, { mode: 0o755 });
    const s = server(w);
    try {
      expect(await run(w)).toBe("failed");
    } finally {
      fs.rmSync(path.join(process.env.FAKE_STATE!, "fetch-fails"), { force: true });
    }
    expect(s.spawned("deploy")).toHaveLength(0);
    const landed = JSON.parse(s.result("land")!).sha;
    expect(s.sent().at(-1).body).toEndWith(`stopped at Main unchecked: This run landed ${landed}, but could not check that origin/main still has it on top (git fetch origin main failed: fatal: unable to access origin), so it deploys nothing rather than risk an older commit over a newer one. Deploy the newest main the way the project deploys, or ship your next change, and its deploy will carry this one.`);
  }, 120_000);

  test("r6 #2: a Landed step that times out stops the run, never sending Deploy an empty sha", async () => {
    const w = world({ find: FOUND, review: [SHIP] });
    fs.writeFileSync(path.join(process.env.FAKE_STATE!, "after-land.sh"), `#!/bin/sh\ntouch "$FAKE_STATE/fetch-hangs"\n`, { mode: 0o755 });
    const s = server(w);
    try {
      expect(await run(w, (g) => { g.nodes.get("landed")!.timeout = 3; })).toBe("failed");
    } finally {
      fs.rmSync(path.join(process.env.FAKE_STATE!, "fetch-hangs"), { force: true });
    }
    expect(s.spawned("deploy")).toHaveLength(0);
    expect(s.sent().at(-1).body).toContain("stopped at Main unchecked: This run landed ");
  }, 120_000);

  test("r6 #1: a slow catch-up of the person's checkout is never cut off", async () => {
    const w = world({ find: FOUND, review: [SHIP] });
    fs.writeFileSync(path.join(process.env.FAKE_STATE!, "level-slow"), "");
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(JSON.parse(s.result("land")!).note).toContain("caught up");
    expectLanded(w);
  }, 180_000);

  test("r8f: a catch-up that fails gives level's own reason and the one command that finishes it, once that is dealt with", async () => {
    const w = world({ find: FOUND, review: [SHIP] });
    // The person edited a file the landing changes, in a way that does not merge: level refuses and writes nothing.
    fs.writeFileSync(path.join(w.root, "a.txt"), "mine\n");
    fs.writeFileSync(path.join(w.root, "staged.txt"), "staged\n");
    git(w.root, "add", "staged.txt");
    const s = server(w);
    expect(await run(w)).toBe("completed");
    const preview = s.result("land")!;
    const note = JSON.parse(preview).note as string;
    const sha = w.originMain();
    expect(preview.length).toBeLessThan(760);
    const command = /^Run `([^`]+)` to finish catching up the checkout once what level said is dealt with; it keeps every edit of yours\. /.exec(note)![1];
    expect(command).toBe(`cd ${w.root} && cast land level --checkout . --to ${sha.slice(0, 12)} --ref-last`);
    expect(note).toContain("was not caught up: Did not level ");
    expect(note).toContain("1 file(s) changed here and in");
    expect(note).toContain("without a clean merge a.txt");
    // HEAD never moved: nothing reads as undoing the landing.
    expect(git(w.root, "rev-parse", "HEAD")).not.toBe(sha);
    // Once the person deals with it (here, drops their edit), the command finishes it and keeps the rest of their work.
    git(w.root, "checkout", "--", "a.txt");
    execFileSync("bash", ["-c", command], { env: { ...process.env, ...ENV }, cwd: w.root });
    expect(git(w.root, "rev-parse", "HEAD")).toBe(sha);
    expect(fs.readFileSync(path.join(w.root, "a.txt"), "utf-8")).toBe("good\n");
    expect(execFileSync("git", ["-C", w.root, "status", "--porcelain"], { encoding: "utf-8" })).toBe("A  staged.txt\n");
  }, 120_000);

  test("r8f: a Land its station cuts off during the catch-up says the change landed, and resuming it finishes and deploys", async () => {
    const w = world({ find: FOUND, review: [SHIP] });
    fs.writeFileSync(path.join(process.env.FAKE_STATE!, "level-slow"), "");
    const s = server(w);
    try {
      expect(await run(w, (g) => { g.nodes.get("land")!.timeout = 8; })).toBe("failed");
    } finally {
      fs.rmSync(path.join(process.env.FAKE_STATE!, "level-slow"), { force: true });
    }
    const head = JSON.parse(fs.readFileSync(path.join(w.runDir, "round.json"), "utf-8")).head_sha;
    expect(w.originMain()).toBe(head);
    const end = s.sent().at(-1).body;
    expect(end).toContain(`stopped at Land cut off: Land was cut off after it pushed ${head} to origin/main, so the change landed, but`);
    expect(end).not.toContain("may have landed");
    const s2 = server(w);
    expect(await resumeAt(w, "land")).toBe("completed");
    expect(JSON.parse(s2.result("land")!).note).toContain("caught up");
    expect(s2.sent().at(-1).body).toContain("is over: Live.");
    expectLanded(w);
  }, 180_000);

  test("r8f: a push cut off keeps the pushing marker and says Landing unknown, never Not landed", async () => {
    const w = world({ find: FOUND, review: [SHIP] });
    fs.writeFileSync(path.join(process.env.FAKE_STATE!, "push-cut"), "");
    const s = server(w);
    try {
      expect(await run(w)).toBe("failed");
    } finally {
      fs.rmSync(path.join(process.env.FAKE_STATE!, "push-cut"), { force: true });
    }
    const head = JSON.parse(fs.readFileSync(path.join(w.runDir, "round.json"), "utf-8")).head_sha;
    expect(fs.readFileSync(path.join(w.runDir, "land-pushing-run-9"), "utf-8").trim()).toBe(head);
    const end = s.sent().at(-1).body;
    // Decided on its exit code: "did not finish" shows, whatever it printed.
    expect(end).toContain(`stopped at Landing unknown: It is not known whether this run landed: the push of ${head.slice(0, 10)} to origin/main was cut off (it did not finish in 180s) and is not on origin yet, but may still land.`);
    expect(end).not.toContain("Not landed");
  }, 120_000);

  test("a push cut off that lands late, then a resume at Round, says the run's own push may have landed it, never that it landed nothing", async () => {
    const w = world({ find: FOUND, review: [SHIP] });
    fs.writeFileSync(path.join(process.env.FAKE_STATE!, "push-cut"), "");
    const s = server(w);
    try {
      expect(await run(w)).toBe("failed");
    } finally {
      fs.rmSync(path.join(process.env.FAKE_STATE!, "push-cut"), { force: true });
    }
    expect(s.sent().at(-1).body).toContain("stopped at Landing unknown");
    const head = JSON.parse(fs.readFileSync(path.join(w.runDir, "round.json"), "utf-8")).head_sha;
    // The push the run gave up on reaches origin after all.
    git(w.root, "push", "-q", "origin", `${head}:refs/heads/main`);
    const s2 = server(w);
    expect(await resumeAt(w, "round")).toBe("failed");
    const end = s2.sent().at(-1).body;
    expect(end).toContain(`stopped at Left the run: The change left the run: nothing of it is above origin/main any more. This run set out to push ${head} there and never heard back, so that push may be what landed it; the run recorded no landing and deployed nothing.`);
    expect(s2.spawned("deploy")).toEqual([]);
  }, 180_000);

  test("r8c #3: a Land its station cuts off after it set out to push ends Landing unknown, never Not landed", async () => {
    const w = world({ find: FOUND, review: [SHIP] });
    fs.writeFileSync(path.join(process.env.FAKE_STATE!, "push-hangs"), "");
    const s = server(w);
    try {
      expect(await run(w, (g) => { g.nodes.get("land")!.timeout = 4; })).toBe("failed");
    } finally {
      fs.rmSync(path.join(process.env.FAKE_STATE!, "push-hangs"), { force: true });
    }
    const head = JSON.parse(fs.readFileSync(path.join(w.runDir, "round.json"), "utf-8")).head_sha;
    const end = s.sent().at(-1).body;
    expect(end).toContain(`stopped at Landing unknown: It is not known whether this run landed: Land was cut off after it set out to push ${head} to origin/main, so the push may have landed.`);
    expect(end).not.toContain("Not landed");
  }, 120_000);

  test("r8c #4: a resumed Land that finds no worktree says so as the reason it cannot tell", async () => {
    const w = world({ find: FOUND, review: [SHIP] });
    const flag = path.join(w.origin, "hung-once");
    fs.writeFileSync(path.join(w.origin, "hooks", "reference-transaction"), `#!/bin/sh\n[ "$1" = committed ] || exit 0\n[ -e "${flag}" ] && exit 0\ngrep -q refs/heads/main || exit 0\ntouch "${flag}"\ntouch "${process.env.FAKE_STATE}/fetch-fails"\nkill -9 $PPID\nexit 0\n`, { mode: 0o755 });
    server(w);
    try {
      expect(await run(w)).toBe("failed");
    } finally {
      fs.rmSync(path.join(process.env.FAKE_STATE!, "fetch-fails"), { force: true });
    }
    fs.writeFileSync(path.join(process.env.FAKE_STATE!, "ws-gone"), "");
    const s2 = server(w);
    try {
      expect(await resumeAt(w, "land")).toBe("failed");
    } finally {
      fs.rmSync(path.join(process.env.FAKE_STATE!, "ws-gone"), { force: true });
    }
    const end = s2.sent().at(-1).body;
    expect(end).toContain("stopped at Landing unknown: It is not known whether this run landed: the push of ");
    expect(end).toContain("may have landed, and the run's worktree change-ct-9 is not on this machine to check.");
    expect(end).not.toContain("its answer was lost");
  }, 180_000);
});
