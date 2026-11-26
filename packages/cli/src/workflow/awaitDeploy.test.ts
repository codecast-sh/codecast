// The Deploy stage (awaitDeploy.ts): it starts only from a commit Merge put on
// main, owns the targets the change touches by their policy, and ends live,
// failed or stuck at a deadline, never waiting out a week. Real git for the
// merged commit; a fake server, CI and clock for the wait.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEPLOY_WAIT_CAP_MS, parseDeployTargets } from "@codecast/shared/contracts/deployTargets";
import type { MainRedPayload } from "@codecast/shared/contracts/mainRed";
import { parseWorkflowSource } from "./parser";
import { RESUME_ENV } from "./stationReexec";
import { awaitDeploy, ciGateOf, deployDuties, holds, landedDuties, lineHeld, mainCiAt, mergedCommit, mergedSha, recordMergedSha, redSinceWords, runAwaitDeploy, targetState, targetTouches, type DeployClock, type DeployTargetRow, type DeployWaitIO, type DeployWaitPlace, type MainCi } from "./awaitDeploy";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" };
let dir = "";
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", env: ENV }).trim();
const write = (cwd: string, f: string, t: string) => { fs.mkdirSync(path.dirname(path.join(cwd, f)), { recursive: true }); fs.writeFileSync(path.join(cwd, f), t); };

let remote = "", work = "";
beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cast-await-deploy-")));
  remote = path.join(dir, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote], { env: ENV });
  work = path.join(dir, "work");
  execFileSync("git", ["clone", "-q", remote, work], { env: ENV, stdio: "ignore" });
  write(work, "api/a.ts", "a1\n");
  write(work, "web/w.ts", "w1\n");
  git(work, "add", "-A");
  git(work, "commit", "-qm", "base");
  git(work, "push", "-q", "origin", "HEAD:main");
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("mergedCommit", () => {
  test("no merged sha, or one that is not on origin's main, merged nothing; a merged one carries its own files", async () => {
    expect(await mergedCommit(work, undefined, "main")).toEqual({ error: "Nothing was merged: the run has no merged commit, so nothing goes out." });
    expect(await mergedCommit(work, " ", "main")).toMatchObject({ error: expect.stringContaining("Nothing was merged") });

    // Land never committed: the change sits on its branch and main never moves (ct-98322, Nov 21).
    git(work, "checkout", "-q", "-b", "change");
    write(work, "api/a.ts", "a2\n");
    git(work, "commit", "-qam", "change");
    const unmerged = git(work, "rev-parse", "HEAD");
    expect(await mergedCommit(work, unmerged, "main")).toEqual({ error: `Nothing was merged: ${unmerged.slice(0, 10)} is not on origin/main, so nothing goes out.` });
    expect(await mergedCommit(work, "f".repeat(40), "main")).toMatchObject({ error: expect.stringContaining("is not on origin/main") });

    git(work, "push", "-q", "origin", "HEAD:main");
    expect(await mergedCommit(work, unmerged.slice(0, 12), "main")).toEqual({ sha: unmerged, files: ["api/a.ts"] });
    expect(await mergedCommit(work, unmerged, "main", ["api/a.ts", "web/w.ts"])).toEqual({ sha: unmerged, files: ["api/a.ts", "web/w.ts"] });
  });

  test("a fetch that keeps failing is asked again, then said as unread, never as nothing merged", async () => {
    const lost = path.join(dir, "lost");
    execFileSync("git", ["clone", "-q", remote, lost], { env: ENV, stdio: "ignore" });
    const merged = git(lost, "rev-parse", "HEAD");
    git(lost, "remote", "set-url", "origin", path.join(dir, "gone.git"));
    const read = await mergedCommit(lost, merged, "main", undefined, { tries: 2, delayMs: 0 });
    expect(read).toMatchObject({ unread: true, error: expect.stringContaining("git fetch failed 2 times") });
    expect(JSON.stringify(read)).not.toContain("Nothing was merged");
  });
});

describe("targetState", () => {
  test("the first live deploy that holds the commit took it live; a failed newest one with none live since failed it", async () => {
    const landed = git(work, "rev-parse", "HEAD");
    const before = git(work, "rev-parse", "HEAD~1");
    const t = (history: DeployTargetRow["history"]): DeployTargetRow => ({ name: "web", paths: ["web/**"], history });
    const carries = (sha: string) => holds(work, landed, sha);
    expect(await targetState(t([{ short_id: "dp-1", status: "live", sha: before, created_at: 1 }]), carries)).toEqual({ target: "web", state: "waiting" });
    expect((await targetState(t([{ short_id: "dp-2", status: "running", sha: landed, created_at: 2 }]), carries)).state).toBe("deploying");
    expect(await targetState(t([{ short_id: "dp-3", status: "failed", sha: landed, created_at: 3, note: "exit 1" }]), carries)).toMatchObject({ state: "failed", deploy: { short_id: "dp-3" } });
    const live = await targetState(t([{ short_id: "dp-5", status: "live", sha: landed, created_at: 5, live_at: 5 }, { short_id: "dp-4", status: "live", sha: landed, created_at: 4, live_at: 4 }, { short_id: "dp-3", status: "failed", sha: landed, created_at: 3 }]), carries);
    expect(live).toMatchObject({ state: "live", deploy: { short_id: "dp-4" } });
    // A sha this checkout has never seen holds nothing.
    expect(await holds(work, landed, "f".repeat(40))).toBe(false);
  });

  test("which targets a change touches", () => {
    expect(targetTouches(["web/**"], ["api/a.ts"])).toBe(false);
    expect(targetTouches(["web/**", "shared/**"], ["web/w.ts"])).toBe(true);
    expect(targetTouches([], ["anything"])).toBe(true);
  });
});

// Every policy side by side: a release pair ordered by after, a CLI release with a CI gate and its own deadline, a
// push target, an auto one, a press one, the line's role-triggered one and one no file touches.
const declared = parseDeployTargets({
  target: [
    { name: "mobile", run: "ota.sh $sha", policy: "release", after: "backend", when: "app/**" },
    { name: "backend", run: "deploy.sh", policy: "release", when: "api/**" },
    { name: "cli", run: "cut.sh", policy: "release", ci: "cast line deploy ci", deadline: "45m", when: "cli/**" },
    { name: "web", runs: "push", when: "web/**" },
    { name: "worker", run: "w.sh", policy: "auto", when: "worker/**" },
    { name: "desktop", run: "release.sh", when: "desktop/**" },
    { name: "production", run: "prod.sh", policy: "release", when: "prod/**" },
    { name: "docs", runs: "push", when: "docs/**" },
  ],
}, []);
const files = ["app/a.tsx", "api/b.ts", "cli/c.ts", "web/d.tsx", "worker/e.ts", "desktop/f.ts", "prod/g.ts"];
const held = lineHeld({ target: "production", trigger: "role", role: "release", command: "prod.sh" });

describe("deployDuties", () => {
  test("sends release targets, waits on every other touched target, and never sends press or role-triggered ones", () => {
    const { duties, left } = deployDuties(declared, files, { held });
    expect(duties.map((d) => [d.target, d.action, d.how, d.by ?? null, d.deadlineMs / 60_000])).toEqual([
      ["backend", "send", "release", null, 60], ["mobile", "send", "release", null, 60], ["cli", "send", "release", null, 45], ["web", "wait", "push", null, 30], ["worker", "wait", "auto", null, 30],
      // A person or a role sends these: the run waits a day for them, and Live means they carry the change too.
      ["desktop", "wait", "others", "a person", 24 * 60], ["production", "wait", "others", "@release", 24 * 60],
    ]);
    expect(duties.find((d) => d.target === "mobile")!.after).toEqual(["backend"]);
    expect(duties.filter((d) => d.ci).map((d) => d.target)).toEqual(["cli", "worker"]);
    expect(left).toEqual([]);
  });

  test("with send off it only waits on release targets; the line profile's person-sent target is waited on, never sent", () => {
    const person = lineHeld({ target: "production", trigger: "person", command: "prod.sh" });
    const { duties, left } = deployDuties(declared, ["api/b.ts", "prod/g.ts"], { held: person, send: false });
    expect(duties.map((d) => [d.target, d.action, d.by ?? null])).toEqual([["backend", "wait", null], ["production", "wait", "a person"]]);
    expect(left).toEqual([]);
    expect(lineHeld({ command: null, target: null, trigger: "person" })).toEqual({});
    expect(ciGateOf("cast line deploy ci --workflow ci.yml")).toEqual({ workflow: "ci.yml" });
    expect(ciGateOf("./scripts/ci-green.sh")).toEqual({});
  });

  test("an after the change does not touch is not waited on, and except holds a target back", () => {
    const { duties, left } = deployDuties(declared, ["app/a.tsx", "web/d.tsx"], { except: ["web"] });
    expect(duties).toMatchObject([{ target: "mobile", after: [] }]);
    expect(left).toEqual(["web is held back"]);
  });

  test("a target held back with except still holds the targets that go after it", () => {
    const { duties, left } = deployDuties(declared, ["app/a.tsx", "api/b.ts"], { except: ["backend"] });
    expect(duties).toMatchObject([{ target: "mobile", action: "send", after: ["backend"] }]);
    expect(left).toEqual(["backend is held back"]);
  });

  test("a deadline over a day, or one that is no duration, refuses the file", () => {
    expect(() => parseDeployTargets({ target: [{ name: "x", runs: "push", deadline: "25h" }] }, [])).toThrow("over 24h");
    expect(deployDuties(parseDeployTargets({ target: [{ name: "x", run: "x.sh", deadline: "3h", when: "x/**" }] }, []), ["x/a"]).duties[0].deadlineMs).toBe(3 * 60 * MIN);
    expect(() => parseDeployTargets({ target: [{ name: "x", runs: "push", deadline: "soon" }] }, [])).toThrow("is not a duration");
  });
});

const MIN = 60_000;
const SHA = "1a2b3c4d5e6f7a8b9c0d";
const HEAD = "9f8e7d6c5b4a39281706";
const HEAD2 = "4b3a2918f7e6d5c4b3a2";
const dp = (short_id: string, status: string, sha = HEAD) => ({ short_id, status, sha, created_at: 1, live_at: status === "live" ? 1 : null });

/** A fake server and clock: `rows(tick)` is what the targets read says on each look, `ci(tick)` main CI on its head. */
function fake(rows: (tick: number) => DeployTargetRow[] | null, over: Partial<DeployWaitIO> & { ci?: (tick: number, sha: string) => MainCi; head?: (tick: number) => string; clock0?: DeployClock } = {}) {
  let now = 0;
  let tick = 0;
  let saved: DeployClock | null = over.clock0 ?? null;
  const lines: string[] = [];
  const blocks: string[] = [];
  const sends: Array<{ targets: string[]; tick: number }> = [];
  const { ci, head, clock0: _c, ...rest } = over;
  const io: DeployWaitIO = {
    now: () => now,
    sleep: async (ms) => { now += ms; tick++; },
    mainHead: async () => head?.(tick) ?? HEAD,
    targets: async () => rows(tick),
    carries: async (deployed) => deployed === HEAD || deployed === HEAD2 || deployed === SHA,
    mainCi: async (sha) => ci?.(tick, sha) ?? { state: "passed", red: [] },
    redSince: async () => "5e4d3c2",
    clock: { load: () => saved, save: (c) => { saved = structuredClone(c); } },
    send: async (targets) => { sends.push({ targets, tick }); return new Promise(() => {}); },
    progress: (l) => lines.push(l),
    block: async (t) => { blocks.push(t); },
    ...rest,
  };
  return { io, lines, blocks, sends, at: () => now, clock: () => saved };
}

const RED: MainCi = { state: "failed", red: ["test-cli"] };
const RUNNING: MainCi = { state: "running", red: [] };
const GREEN: MainCi = { state: "passed", red: [] };

// The release, push and auto targets; the waits on press and role targets have tests of their own.
const plan = deployDuties(declared, files.filter((f) => !/^(desktop|prod)\//.test(f)), { held });

describe("awaitDeploy", () => {
  test("a change no target ships passes at once, naming any held back", async () => {
    const f = fake(() => { throw new Error("never read"); });
    expect(await awaitDeploy({ sha: SHA, base: "main", plan: deployDuties(declared, ["README.md"]), intervalMs: MIN }, f.io)).toEqual({ code: 0, line: "1a2b3c4 is on main; nothing this run deploys ships its files." });
    expect(await awaitDeploy({ sha: SHA, base: "main", plan: deployDuties(declared, ["web/d.tsx"], { except: ["web"] }), intervalMs: MIN }, f.io)).toEqual({ code: 0, line: "1a2b3c4 is on main; nothing this run deploys ships its files. web is held back." });
  });

  // The run only waits on what a person or a role sends: Live means every touched target carries the change.
  test("a press target and the line profile's own are waited on for a day, never sent, and live counts them", async () => {
    const f = fake((tick) => [
      { name: "desktop", history: tick >= 2 ? [dp("dp-6", "live")] : [] },
      { name: "production", history: tick >= 120 ? [dp("dp-7", "live")] : [] },
    ]);
    const r = await awaitDeploy({ sha: SHA, base: "main", plan: deployDuties(declared, ["desktop/f.ts", "prod/g.ts"], { held }), intervalMs: MIN }, f.io);
    expect(f.sends).toEqual([]);
    expect(f.lines[0]).toBe("desktop: waiting for a person to send it (0m of 24h); production: waiting for @release to send it (0m of 24h)");
    expect(f.lines).toContain("desktop: live in dp-6; production: waiting for @release to send it (119m of 24h)");
    expect(r).toEqual({ code: 0, line: "Live: 1a2b3c4 on desktop dp-6, production dp-7." });
  });

  test("a person who never sends it ends the wait at Deploy stuck after a day, with one blocker", async () => {
    const f = fake(() => [{ name: "production", history: [] }]);
    const r = await awaitDeploy({ sha: SHA, base: "main", plan: deployDuties(declared, ["prod/g.ts"], { held: lineHeld({ target: "production", trigger: "person", command: "p" }) }), intervalMs: 30 * MIN }, f.io);
    expect(r).toEqual({ code: 5, line: "Deploy stuck: production is not live with 1a2b3c4 after 24h (last: waiting for a person to send it)." });
    expect(f.blocks).toHaveLength(1);
    expect(f.lines).toContain("production: waiting for a person to send it (2h of 24h)");
  });

  test("sends only the release targets, waits until every owned target is live, and names each dp-N", async () => {
    const f = fake((tick) => [
      { name: "backend", history: tick >= 1 ? [dp("dp-1", "live")] : [] },
      { name: "mobile", history: tick >= 2 ? [dp("dp-2", "live")] : [] },
      { name: "cli", history: tick >= 1 ? [dp("dp-3", tick >= 3 ? "live" : "running")] : [] },
      { name: "web", history: [dp("dp-4", "live")] },
      { name: "worker", history: tick >= 1 ? [dp("dp-5", "live")] : [] },
    ]);
    const r = await awaitDeploy({ sha: SHA, base: "main", plan, intervalMs: MIN }, f.io);
    // On green main every release target goes in one `cast deploy`, which orders mobile after backend.
    expect(f.sends).toEqual([{ targets: ["backend", "mobile", "cli"], tick: 0 }]);
    expect(r).toEqual({ code: 0, line: "Live: 1a2b3c4 on backend dp-1, mobile dp-2, cli dp-3, web dp-4, worker dp-5." });
    // Every wait names its target, what it waits for, how long it has waited and its deadline.
    expect(f.lines[0]).toBe("Sending backend, mobile, cli for 1a2b3c4.");
    expect(f.lines[1]).toBe("backend: asking for a deploy of 1a2b3c4 (0m of 60m); mobile: waiting for backend to go live first (held 0m, then 60m); cli: asking for a deploy of 1a2b3c4 (0m of 45m); web: live in dp-4; worker: waiting for the server to send 1a2b3c4 once main CI is green (0m of 30m)");
    expect(f.lines[2]).toBe("backend: live in dp-1; mobile: asking for a deploy of 1a2b3c4 (0m of 60m); cli: dp-3 sending 1a2b3c4 (1m of 45m); web: live in dp-4; worker: live in dp-5");
    expect(f.blocks).toEqual([]);
  });

  // Red main holds a release; it does not fail it. The moment a fix or revert turns main's head green, it goes out.
  test("red main holds a gated release, naming where main went red, and sends it once main's head is green", async () => {
    const f = fake((tick) => [{ name: "cli", history: tick >= 4 ? [dp("dp-3", "live")] : tick >= 3 ? [dp("dp-3", "running")] : [] }], { ci: (tick) => (tick < 2 ? RED : GREEN) });
    const r = await awaitDeploy({ sha: SHA, base: "main", plan: deployDuties(declared, ["cli/c.ts"]), intervalMs: MIN }, f.io);
    expect(f.sends).toEqual([{ targets: ["cli"], tick: 2 }]);
    expect(f.lines).toEqual([
      "cli: waiting on main CI at 9f8e7d6 (red since 5e4d3c2: test-cli; held 0m, then 45m)",
      "cli: waiting on main CI at 9f8e7d6 (red since 5e4d3c2: test-cli; held 1m, then 45m)",
      "Sending cli for 1a2b3c4.",
      // Its own deadline starts only now, when it can go out.
      "cli: asking for a deploy of 1a2b3c4 (0m of 45m)",
      "cli: dp-3 sending 1a2b3c4 (1m of 45m)",
    ]);
    expect(r).toEqual({ code: 0, line: "Live: 1a2b3c4 on cli dp-3." });
  });

  test("main CI running holds a gated release the same way, and an ungated one goes out at once", async () => {
    const f = fake((tick) => [{ name: "cli", history: tick >= 3 ? [dp("dp-3", "live")] : [] }, { name: "backend", history: tick >= 1 ? [dp("dp-1", "live")] : [] }], { ci: (tick) => (tick < 2 ? RUNNING : GREEN) });
    const r = await awaitDeploy({ sha: SHA, base: "main", plan: deployDuties(declared, ["cli/c.ts", "api/b.ts"]), intervalMs: MIN }, f.io);
    expect(f.sends).toEqual([{ targets: ["backend"], tick: 0 }, { targets: ["cli"], tick: 2 }]);
    expect(f.lines[1]).toBe("backend: asking for a deploy of 1a2b3c4 (0m of 60m); cli: waiting on main CI at 9f8e7d6 (running; held 0m, then 45m)");
    expect(r.code).toBe(0);
  });

  test("main red until the wait's cap ends stuck, with main's red state as the reason, having sent nothing", async () => {
    const f = fake(() => [{ name: "cli", history: [] }], { ci: () => RED });
    const r = await awaitDeploy({ sha: SHA, base: "main", plan: deployDuties(declared, ["cli/c.ts"]), intervalMs: 30 * MIN }, f.io);
    expect(f.sends).toEqual([]);
    expect(r).toEqual({ code: 5, line: "Deploy stuck: cli is not live with 1a2b3c4 after 25h, the longest a run waits (last: waiting on main CI at 9f8e7d6 (red since 5e4d3c2: test-cli))." });
    expect(f.blocks).toHaveLength(1);
  });

  test("main CI red holds an auto target, named with its failing jobs, until it goes green", async () => {
    const ci: MainCi[] = [{ state: "failed", red: ["test-cli", "lint"] }, RUNNING, GREEN];
    let asked = 0;
    const only = deployDuties(declared, ["worker/e.ts"]);
    const f = fake((tick) => [{ name: "worker", history: tick >= 4 ? [dp("dp-9", "live")] : [] }], { mainCi: async () => ci[Math.min(asked++, 2)], redSince: async () => null });
    const r = await awaitDeploy({ sha: SHA, base: "main", plan: only, intervalMs: MIN }, f.io);
    expect(f.lines).toEqual([
      "worker: waiting on main CI at 9f8e7d6 (red: test-cli, lint; held 0m, then 30m)",
      "worker: waiting on main CI at 9f8e7d6 (running; held 1m, then 30m)",
      "worker: waiting for the server to send 1a2b3c4 once main CI is green (0m of 30m)",
      "worker: waiting for the server to send 1a2b3c4 once main CI is green (1m of 30m)",
    ]);
    expect(r).toEqual({ code: 0, line: "Live: 1a2b3c4 on worker dp-9." });
  });

  test("a missed deadline posts one blocker naming the target, the sha and its last state, and ends stuck", async () => {
    const f = fake(() => [{ name: "cli", history: [dp("dp-3", "running")] }, { name: "web", history: [dp("dp-4", "live")] }]);
    const r = await awaitDeploy({ sha: SHA, base: "main", plan: deployDuties(declared, ["cli/c.ts", "web/d.tsx"]), intervalMs: MIN }, f.io);
    expect(r).toEqual({ code: 5, line: "Deploy stuck: cli is not live with 1a2b3c4 after 45m (last: dp-3 sending 1a2b3c4). Live: web dp-4." });
    expect(f.blocks).toEqual(["Deploy stuck: cli is not live with 1a2b3c4 after 45m (last: dp-3 sending 1a2b3c4). Live: web dp-4. Send it again from the Deploys page or with `cast deploy cli`."]);
    // It stopped at the first look past the deadline, not at the station's timeout.
    expect(f.at()).toBe(46 * MIN);
  });

  test("a deadline still ends the wait while the server cannot be read, with the last state it saw", async () => {
    const f = fake((tick) => (tick === 0 ? [{ name: "web", history: [] }] : null));
    const r = await awaitDeploy({ sha: SHA, base: "main", plan: deployDuties(declared, ["web/d.tsx"]), intervalMs: 10 * MIN }, f.io);
    expect(r.code).toBe(5);
    expect(r.line).toBe("Deploy stuck: web is not live with 1a2b3c4 after 30m (last: waiting for its push deploy to carry 1a2b3c4).");
    expect(f.lines[1]).toBe("Cannot read the deploy targets (cast line deploy targets --json, from the server) for web; trying again (10m in).");
  });

  test("a failed deploy that would carry it ends the wait at once", async () => {
    const f = fake(() => [{ name: "backend", history: [{ ...dp("dp-7", "failed"), note: "convex push refused\nmore" }] }]);
    expect(await awaitDeploy({ sha: SHA, base: "main", plan: deployDuties(declared, ["api/b.ts"]), intervalMs: MIN }, f.io)).toEqual({ code: 1, line: "The deploy that carried 1a2b3c4 failed: backend dp-7 (convex push refused)." });
  });

  test("a release that ended without sending a target fails it rather than wait for its deadline", async () => {
    // The live deploy from before the wait carries nothing of this change and is not what the release sent.
    const f = fake(() => [{ name: "backend", live: { ...dp("dp-1", "live", "old"), created_at: -5 } }], { send: async () => ({ code: 1, last: "not published: cast line deploy targets --publish" }) });
    expect(await awaitDeploy({ sha: SHA, base: "main", plan: deployDuties(declared, ["api/b.ts"]), intervalMs: MIN }, f.io)).toEqual({ code: 1, line: "No deploy carries 1a2b3c4: cast deploy sent no deploy of backend (not published: cast line deploy targets --publish)." });
    expect(f.at()).toBe(MIN);
  });

  test("a deploy that went out without the commit names the sha it sent and the checkout that may be behind", async () => {
    const f = fake(() => [{ name: "backend", history: [{ ...dp("dp-8", "live", "0ld5ha1234"), created_at: 1 }] }], { send: async () => ({ code: 0, last: "live  backend  dp-8 0ld5ha1234" }) });
    expect(await awaitDeploy({ sha: SHA, base: "main", plan: deployDuties(declared, ["api/b.ts"]), intervalMs: MIN }, f.io)).toEqual({ code: 1, line: "No deploy carries 1a2b3c4: backend dp-8 sent 0ld5ha1, so the checkout that publishes it may be behind origin/main." });
  });

  // Main moved between the gate and the send (a deploy sends main's head, DP13): the head it sent was still running
  // CI, so its own CI step failed it. Red main holds a release: it goes back to waiting and is sent again at green.
  test("a gated send that failed at a head main had not passed is held and sent again once the head is green", async () => {
    const at = (history: ReturnType<typeof dp>[]) => history.map((d, i) => ({ ...d, created_at: 10 - i }));
    const f = fake((tick) => [{ name: "cli", history: at(tick >= 3 ? [dp("dp-4", "live", HEAD2), dp("dp-3", "failed", HEAD2)] : tick >= 1 ? [dp("dp-3", "failed", HEAD2)] : []) }], {
      head: (tick) => (tick >= 1 ? HEAD2 : HEAD),
      ci: (tick, sha) => (sha === HEAD2 && tick < 2 ? RUNNING : GREEN),
      send: async (targets) => ({ code: 1, last: `FAIL  ${targets[0]}  dp-3` }),
    });
    const r = await awaitDeploy({ sha: SHA, base: "main", plan: deployDuties(declared, ["cli/c.ts"]), intervalMs: MIN }, f.io);
    expect(f.lines).toContain("cli: waiting on main CI at 4b3a291 (running; 1m of 45m)");
    expect(f.lines.filter((l) => l.startsWith("Sending cli"))).toHaveLength(2);
    expect(r).toEqual({ code: 0, line: "Live: 1a2b3c4 on cli dp-4." });
  });

  test("a gated send that failed at a green head is a real failure", async () => {
    const f = fake((tick) => [{ name: "cli", history: tick >= 1 ? [{ ...dp("dp-3", "failed"), note: "cut failed" }] : [] }], { send: async () => ({ code: 1, last: "FAIL" }) });
    expect(await awaitDeploy({ sha: SHA, base: "main", plan: deployDuties(declared, ["cli/c.ts"]), intervalMs: MIN }, f.io)).toEqual({ code: 1, line: "The deploy that carried 1a2b3c4 failed: cli dp-3 (cut failed)." });
  });

  test("a target held by its after target starts its own deadline only once that one is live", async () => {
    // backend takes 50 minutes; mobile's hour starts then, so it is not stuck at 61.
    const f = fake((tick) => [
      { name: "backend", history: tick >= 50 ? [dp("dp-1", "live")] : tick >= 1 ? [dp("dp-1", "running")] : [] },
      { name: "mobile", history: tick >= 100 ? [dp("dp-2", "live")] : tick >= 51 ? [dp("dp-2", "running")] : [] },
    ]);
    const r = await awaitDeploy({ sha: SHA, base: "main", plan: deployDuties(declared, ["api/b.ts", "app/a.tsx"]), intervalMs: MIN }, f.io);
    expect(r).toEqual({ code: 0, line: "Live: 1a2b3c4 on backend dp-1, mobile dp-2." });
    expect(f.clock()!.since).toEqual({ backend: 0, mobile: 50 * MIN });
  });

  test("a station re-run mid-wait keeps the clock for its commit; a resume after Deploy stuck, or another commit, starts fresh", async () => {
    const cliOnly = deployDuties(declared, ["cli/c.ts"]);
    const clock0: DeployClock = { sha: SHA, start: -(DEPLOY_WAIT_CAP_MS - 2 * MIN), since: {} };
    const first = fake(() => [{ name: "cli", history: [] }], { ci: () => RED, clock0 });
    expect((await awaitDeploy({ sha: SHA, base: "main", plan: cliOnly, intervalMs: MIN }, first.io)).code).toBe(5);
    expect(first.at()).toBe(3 * MIN);
    expect(first.blocks).toHaveLength(1);
    expect(first.clock()).toMatchObject({ sha: SHA, stuck: true });
    // A person resumed the stuck run: another try, with a whole wait of its own.
    const again = fake(() => [{ name: "cli", history: [] }], { ci: () => RED, clock0: first.clock()! });
    expect((await awaitDeploy({ sha: SHA, base: "main", plan: cliOnly, intervalMs: MIN }, again.io)).code).toBe(5);
    expect(again.at()).toBe(DEPLOY_WAIT_CAP_MS + MIN);
    expect(again.blocks).toHaveLength(1);
    // A clock left from another commit's wait says nothing about this one.
    const other = fake((tick) => [{ name: "cli", history: tick >= 1 ? [dp("dp-3", "live")] : [] }], { clock0: { sha: "f".repeat(40), start: -10 * DEPLOY_WAIT_CAP_MS, since: {} } });
    expect((await awaitDeploy({ sha: SHA, base: "main", plan: cliOnly, intervalMs: MIN }, other.io)).code).toBe(0);
  });

  // A newer CLI takes the wait over between polls (stationReexec.ts), handed the clock, but never one with a deploy out.
  test("between polls the wait may move to a newer CLI with its clock, until it has sent a deploy", async () => {
    const handed: DeployWaitPlace[] = [];
    const between = async (p: DeployWaitPlace) => { handed.push(structuredClone(p)); };
    const press = fake((tick) => [{ name: "desktop", history: tick >= 3 ? [dp("dp-6", "live")] : [] }], { between });
    expect((await awaitDeploy({ sha: SHA, base: "main", plan: deployDuties(declared, ["desktop/f.ts"], { held }), intervalMs: MIN }, press.io)).code).toBe(0);
    expect(handed).toEqual([0, 1, 2].map(() => ({ clock: { sha: SHA, start: 0, since: { desktop: 0 } }, held: [] })));
    handed.length = 0;
    const sends = fake((tick) => [{ name: "cli", history: tick >= 1 ? [dp("dp-3", tick >= 3 ? "live" : "running")] : [] }], { between });
    expect((await awaitDeploy({ sha: SHA, base: "main", plan: deployDuties(declared, ["cli/c.ts"]), intervalMs: MIN }, sends.io)).code).toBe(0);
    expect(sends.sends).toHaveLength(1);
    expect(handed).toEqual([]);
  });

  // A send that failed at a head main had not passed is held, not failed. The release has ended, so nothing is out and
  // the wait may move; the newer CLI must still hold that deploy once the head goes green, and send again.
  test("a deploy held on its own CI step is still held after the wait moves to a newer CLI", async () => {
    class Moved extends Error { constructor(readonly place: DeployWaitPlace) { super("moved"); } }
    const older = fake((tick) => [{ name: "cli", history: tick >= 1 ? [dp("dp-3", "failed", HEAD2)] : [] }], {
      head: (tick) => (tick >= 1 ? HEAD2 : HEAD),
      ci: (_tick, sha) => (sha === HEAD2 ? RUNNING : GREEN),
      send: async () => ({ code: 1, last: "FAIL  cli  dp-3" }),
      between: async (p) => { if (p.held.length) throw new Moved(structuredClone(p)); },
    });
    const moved = await awaitDeploy({ sha: SHA, base: "main", plan: deployDuties(declared, ["cli/c.ts"]), intervalMs: MIN }, older.io).catch((e) => e);
    expect(moved).toBeInstanceOf(Moved);
    const { place } = moved as Moved;
    expect(place.held).toEqual(["dp-3"]);
    // On the newer CLI the head is green now.
    const newer = (held?: string[]) => {
      const f = fake((tick) => [{ name: "cli", history: tick >= 1 ? [{ ...dp("dp-4", "live", HEAD2), created_at: 2 }, dp("dp-3", "failed", HEAD2)] : [dp("dp-3", "failed", HEAD2)] }], { head: () => HEAD2, clock0: place.clock });
      return { f, run: awaitDeploy({ sha: SHA, base: "main", plan: deployDuties(declared, ["cli/c.ts"]), intervalMs: MIN, held }, f.io) };
    };
    const resumed = newer(place.held);
    expect(await resumed.run).toEqual({ code: 0, line: "Live: 1a2b3c4 on cli dp-4." });
    expect(resumed.f.sends).toHaveLength(1);
    // Without the holds it was handed, that deploy reads as a failure of this change.
    expect((await newer().run).code).toBe(1);
  });

  test("an after target someone else sends holds its dependent unsent until it is live with the commit", async () => {
    // backend goes out on a press here: mobile waits for it, and the run never sends backend itself.
    const pressed = parseDeployTargets({ target: [
      { name: "backend", run: "deploy.sh", when: "api/**" },
      { name: "mobile", run: "ota.sh $sha", policy: "release", after: "backend", when: ["app/**", "api/**"] },
    ] }, []);
    const plan2 = deployDuties(pressed, ["api/b.ts"]);
    expect(plan2).toEqual({ duties: [expect.objectContaining({ target: "backend", action: "wait", how: "others" }), expect.objectContaining({ target: "mobile", action: "send", after: ["backend"] })], left: [] });
    const f = fake((tick) => [
      { name: "backend", history: tick >= 3 ? [dp("dp-1", "live", SHA)] : [] },
      { name: "mobile", history: tick >= 5 ? [dp("dp-2", "live")] : [] },
    ]);
    const r = await awaitDeploy({ sha: SHA, base: "main", plan: plan2, intervalMs: MIN }, f.io);
    expect(f.lines[0]).toBe("backend: waiting for a person to send it (0m of 24h); mobile: held until backend is live with 1a2b3c4 (held 0m, then 60m)");
    expect(f.sends).toEqual([{ targets: ["mobile"], tick: 3 }]);
    expect(r).toEqual({ code: 0, line: "Live: 1a2b3c4 on backend dp-1, mobile dp-2." });
  });

  // The dependent's hour starts only once the person has sent its after target: it never spends that person's day.
  test("an after target a person never sends ends the wait at that target's own day, its dependent never sent", async () => {
    const pressed = parseDeployTargets({ target: [
      { name: "backend", run: "deploy.sh", when: "api/**" },
      { name: "mobile", run: "ota.sh $sha", policy: "release", after: "backend", when: "api/**" },
    ] }, []);
    const f = fake(() => [{ name: "backend", history: [] }, { name: "mobile", history: [] }]);
    const r = await awaitDeploy({ sha: SHA, base: "main", plan: deployDuties(pressed, ["api/b.ts"]), intervalMs: MIN }, f.io);
    expect(f.lines).toContain("backend: waiting for a person to send it (61m of 24h); mobile: held until backend is live with 1a2b3c4 (held 61m, then 60m)");
    expect(r).toEqual({ code: 5, line: "Deploy stuck: backend is not live with 1a2b3c4 after 24h (last: waiting for a person to send it)." });
    expect(f.sends).toEqual([]);
  });

  test("with send off it sends nothing and waits for a deploy someone else sends", async () => {
    const f = fake((tick) => [{ name: "backend", history: tick >= 2 ? [dp("dp-1", "live")] : [] }]);
    const r = await awaitDeploy({ sha: SHA, base: "main", plan: deployDuties(declared, ["api/b.ts"], { send: false }), intervalMs: MIN }, f.io);
    expect(f.sends).toEqual([]);
    expect(f.lines[0]).toBe("backend: waiting for a deploy that carries 1a2b3c4 (0m of 60m)");
    expect(r.code).toBe(0);
  });
});

// ct-98114, Nov 20: union-mobile dropped aivery-operator from deploy.toml, and a change landed on top of that removal
// still waited 23h for it, because the wait read its targets from somewhere other than the commit it landed.
describe("a target the landed commit no longer declares", () => {
  const PROD = `[[target]]\nname = "production"\nwhen = ["outreach/backend/**"]\nrun = "./deploy.sh"\nlive = "json:https://api.example.com/health#gitSha"\n`;
  const AIVERY = `[[target]]\nname = "aivery-operator"\nwhen = ["outreach/backend/**"]\nrun = "./deploy.sh --components aivery"\nlive = "json:https://aivery.example.com/health#gitSha"\n`;

  test("the wait's duties come from the landed commit, not a shared checkout's working tree", async () => {
    const repo = path.join(dir, "shared");
    execFileSync("git", ["init", "-q", "-b", "main", repo], { env: ENV });
    write(repo, ".codecast/deploy.toml", PROD + AIVERY);
    write(repo, "outreach/backend/a.ts", "a1\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "both targets");
    write(repo, ".codecast/deploy.toml", PROD);
    git(repo, "commit", "-qam", "remove aivery-operator");
    write(repo, "outreach/backend/a.ts", "a2\n");
    git(repo, "commit", "-qam", "the change");
    const landed = git(repo, "rev-parse", "HEAD");
    // The shared checkout's files read as they did before the removal (another session's tree, a ref moved under it).
    write(repo, ".codecast/deploy.toml", PROD + AIVERY);

    const plan = await landedDuties(repo, { sha: landed, files: ["outreach/backend/a.ts"] }, {});
    expect(plan.duties.map((d) => d.target)).toEqual(["production"]);
  });

  test("a target the server has no record of is named as unknown, never waited on", async () => {
    const both = deployDuties(parseDeployTargets({ target: [
      { name: "production", run: "p.sh", when: "api/**" },
      { name: "aivery-operator", run: "a.sh", when: "api/**" },
    ] }, []), ["api/b.ts"]);
    expect(both.duties.map((d) => [d.target, d.action])).toEqual([["production", "wait"], ["aivery-operator", "wait"]]);
    const f = fake((tick) => [{ name: "production", history: tick >= 1 ? [dp("dp-2148", "live")] : [] }]);
    const r = await awaitDeploy({ sha: SHA, base: "main", plan: both, intervalMs: MIN }, f.io);
    expect(r).toEqual({ code: 0, line: "Live: 1a2b3c4 on production dp-2148. aivery-operator has no record on the server, so nothing says when it is live; not waited on." });
    expect(f.blocks).toEqual([]);

  });

  test("with no target that can say it is live (an empty answer, every target unrecorded) it waits and ends stuck, never passes", async () => {
    const only = deployDuties(parseDeployTargets({ target: [{ name: "aivery-operator", run: "a.sh", when: "api/**" }] }, []), ["api/b.ts"]);
    for (const rows of [[], [{ name: "dashboard", history: [] }]]) {
      const f = fake(() => rows);
      const r = await awaitDeploy({ sha: SHA, base: "main", plan: only, intervalMs: 30 * MIN }, f.io);
      expect(r).toEqual({ code: 5, line: "Deploy stuck: aivery-operator is not live with 1a2b3c4 after 24h (last: no record on the server, so nothing says when it is live)." });
      expect(f.blocks).toHaveLength(1);
    }
  });

  test("a target published mid-wait is waited on again", async () => {
    const both = deployDuties(parseDeployTargets({ target: [
      { name: "production", run: "p.sh", when: "api/**" },
      { name: "worker", runs: "push", when: "api/**" },
    ] }, []), ["api/b.ts"]);
    const f = fake((tick) => [
      { name: "production", history: tick >= 3 ? [dp("dp-9", "live")] : [] },
      ...(tick >= 1 ? [{ name: "worker", history: tick >= 5 ? [dp("dp-10", "live")] : [] }] : []),
    ]);
    const r = await awaitDeploy({ sha: SHA, base: "main", plan: both, intervalMs: MIN }, f.io);
    expect(f.lines[0]).toContain("worker: no record on the server");
    expect(r).toEqual({ code: 0, line: "Live: 1a2b3c4 on production dp-9, worker dp-10." });
  });

  test("an unrecorded target another target goes after still holds it, and is never said to be skipped", async () => {
    const pair = deployDuties(parseDeployTargets({ target: [
      { name: "mobile", run: "ota.sh", policy: "release", after: "backend", when: "api/**" },
      { name: "backend", run: "b.sh", when: "api/**" },
    ] }, []), ["api/b.ts"]);
    const f = fake(() => [{ name: "mobile", history: [] }]);
    const r = await awaitDeploy({ sha: SHA, base: "main", plan: pair, intervalMs: 30 * MIN }, f.io);
    expect(f.sends).toEqual([]);
    expect(f.lines[0]).toContain("mobile: held until backend is live");
    expect(r.code).toBe(5);
    expect(r.line).not.toContain("not waited on");
  });
});

describe("redSinceWords", () => {
  const culprit = (sha: string, over: Partial<MainRedPayload> = {}): MainRedPayload => ({
    repo: "acme/app", branch: "main", culprit_sha: sha.repeat(40), culprit_exact: true, candidates: [sha.repeat(40)], culprit_subject: `Break ${sha}`,
    culprit_author: null, culprit_session: null, culprit_run: null, culprit_task: null, red_shas: [], first_red_at: 0, ci_run_url: null, reran: false, failing: [], ...over,
  });
  const walked: string[] = [];
  const walk = async () => { walked.push("walk"); return "5e4d3c2"; };

  test("names red main's open culprit, the oldest the commit's history holds on this branch", async () => {
    walked.length = 0;
    const open = async () => [culprit("a", { branch: "release" }), culprit("b"), culprit("c", { culprit_exact: false, candidates: ["c".repeat(40), "d".repeat(40)] })];
    expect(await redSinceWords({ base: "main", open, holds: async (s) => s !== "b".repeat(40), walk })).toBe("ccccccc Break c (2 commits)");
    expect(await redSinceWords({ base: "main", open, holds: async () => true, walk })).toBe("bbbbbbb Break b");
    expect(walked).toEqual([]);
  });

  test("walks main's CI when the server cannot answer or names no culprit that fits", async () => {
    walked.length = 0;
    expect(await redSinceWords({ base: "main", open: async () => null, holds: async () => true, walk })).toBe("5e4d3c2");
    expect(await redSinceWords({ base: "main", open: async () => { throw new Error("Unknown route"); }, holds: async () => true, walk })).toBe("5e4d3c2");
    expect(await redSinceWords({ base: "main", open: async () => [], holds: async () => true, walk })).toBe("5e4d3c2");
    expect(await redSinceWords({ base: "main", open: async () => [culprit("e")], holds: async () => false, walk })).toBe("5e4d3c2");
    expect(walked).toHaveLength(4);
  });
});

describe("mainCiAt", () => {
  const gh = (runs: object[], jobs: Record<string, string> = {}, flows: object[] = []) => async (args: string[]) =>
    args[0] === "workflow" ? { code: 0, out: JSON.stringify(flows) }
    : args[1] === "list" ? { code: 0, out: JSON.stringify(runs) } : { code: 0, out: jobs[args[2]] ?? "" };
  const run = (id: number, workflowName: string, status: string, conclusion: string | null, startedAt = "2026-11-21T10:00:00Z", workflowDatabaseId?: number) => ({ databaseId: id, workflowName, status, conclusion, startedAt, ...(workflowDatabaseId ? { workflowDatabaseId } : {}) });

  test("a gate over every workflow leaves out the deploy workflows targets name", async () => {
    const flows = [{ id: 11, path: ".github/workflows/ci.yml" }, { id: 22, path: ".github/workflows/deploy.yml" }];
    const runs = [run(1, "CI", "completed", "success", undefined, 11), run(2, "Deploy", "in_progress", null, undefined, 22)];
    expect(await mainCiAt("/", HEAD, { exclude: ["deploy.yml"] }, gh(runs, {}, flows))).toEqual({ state: "passed", red: [] });
    expect(await mainCiAt("/", HEAD, {}, gh(runs, {}, flows))).toEqual({ state: "running", red: [] });
    // deployDuties gives an auto target's gate every deploy workflow the targets name.
    const withDeploy = parseDeployTargets({ target: [{ name: "worker", run: "w.sh", policy: "auto", when: "worker/**" }, { name: "prod", run: "d.sh", workflow: "deploy.yml", when: "prod/**" }] }, []);
    expect(deployDuties(withDeploy, ["worker/e.ts"]).duties[0].ci).toEqual({ exclude: ["deploy.yml"] });
  });

  test("reads the workflow's conclusion, so an advisory job that failed holds nothing; a red run names its failed jobs", async () => {
    expect(await mainCiAt("/", HEAD, { workflow: "ci.yml" }, gh([run(1, "CI", "completed", "success")], { "1": "macOS advisory\n" }))).toEqual({ state: "passed", red: [] });
    expect(await mainCiAt("/", HEAD, { workflow: "ci.yml" }, gh([run(2, "CI", "completed", "failure")], { "2": "test-cli\nlint\n" }))).toEqual({ state: "failed", red: ["test-cli", "lint"] });
    expect(await mainCiAt("/", HEAD, {}, gh([run(3, "CI", "in_progress", null)]))).toEqual({ state: "running", red: [] });
    expect(await mainCiAt("/", HEAD, {}, gh([]))).toEqual({ state: "none", red: [] });
    // A workflow's newest run speaks: a rerun that passed clears the red one before it.
    expect(await mainCiAt("/", HEAD, {}, gh([run(4, "CI", "completed", "failure", "2026-11-21T10:00:00Z"), run(5, "CI", "completed", "success", "2026-11-21T10:30:00Z")]))).toEqual({ state: "passed", red: [] });
  });

  test("names the workflow it gates on", async () => {
    const asked: string[][] = [];
    await mainCiAt("/", HEAD, { workflow: "ci.yml" }, async (args) => { asked.push(args); return { code: 0, out: "[]" }; });
    expect(asked[0]).toContain("--workflow");
    expect(asked[0]).toContain("ci.yml");
  });
});

// A flow whose Merge station is `cast line merge`, which records the merge on the run and writes no merge.json, then
// composes Deploy (a watch flow: merge, then deploy, then watch).
describe("the merged commit with no merge.json", () => {
  const graph = parseWorkflowSource(`digraph watch {
    start [shape=Mdiamond]
    merge [label="Merge", shape=parallelogram, script="cast line merge --run $run_id --branch $branch"]
    deploy [flow="deploy"]
    watch [shape=Msquare]
    start -> merge -> deploy -> watch
  }`);

  test("Deploy reads the run's recorded merge when merge.json is missing, and only both missing is nothing merged", async () => {
    const script = graph.nodes.get("deploy__wait")!.script!;
    expect(script).toContain(`--merge "$run_dir/merge.json"`);
    expect(script).toContain("--run $run_id");
    const recorded = async () => ({ run: { merge: { sha: SHA } } });
    const none = async () => ({ run: {} });
    expect(await mergedSha({ run: "run1" }, null, recorded)).toBe(SHA);
    expect(await mergedSha({ run: "run1" }, { sha: HEAD }, recorded)).toBe(HEAD);
    expect(await mergedSha({ run: "run1" }, null, none)).toBeUndefined();
    expect(await mergedSha({ run: "run1" }, null, async () => { throw new Error("offline"); })).toBeUndefined();
    expect(await mergedSha({}, null, recorded)).toBeUndefined();
  });
});

describe("recordMergedSha", () => {
  // A change merged by its own script writes merge.json and never posts the record: the station puts the sha it found
  // on main on the run, observed, so the card reads it as landed.
  test("posts the found sha as an observed merge, once, and only inside a run", async () => {
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    const post = (merge: unknown) => async (p: string, body: Record<string, unknown>) => { posts.push({ path: p, body }); return p === "/cli/workflow-runs/get" ? { run: { merge } } : {}; };
    expect(await recordMergedSha({ run: "run1", branch: "codecast/change-x", base: "main" }, SHA, post(null), () => {})).toBe("recorded");
    expect(posts.at(-1)).toEqual({ path: "/cli/line/merge/record", body: { run_id: "run1", sha: SHA, branch: "codecast/change-x", into: "main", observed: true } });
    posts.length = 0;
    expect(await recordMergedSha({ run: "run1", branch: "codecast/change-x", base: "main" }, SHA, post({ sha: SHA }), () => {})).toBe("already");
    expect(posts.map((x) => x.path)).toEqual(["/cli/workflow-runs/get"]);
    posts.length = 0;
    expect(await recordMergedSha({ base: "main" }, SHA, post(null), () => {})).toBeNull();
    expect(posts).toEqual([]);
  });
});

// A Deploy station resumed on a newer CLI starts from the merged commit and duties it was handed: in a real run there is
// no --merge or --sha, and the reads the older CLI made at its start (the run on the server, origin) could fail now.
describe("runAwaitDeploy resumed on a newer CLI", () => {
  test("skips reading the merged commit and its duties, and waits on what it was handed", async () => {
    const env = { cwd: work, cast: async () => { throw new Error("no cast call"); }, post: async () => { throw new Error("the server is not reachable"); } };
    const opts = { base: "main", interval: "5" };
    const printed: string[] = [];
    const log = console.log;
    console.log = (l: string) => { printed.push(l); };
    try {
      // Fresh, with no merged sha anywhere it can read, nothing was merged.
      expect(await runAwaitDeploy(opts, env)).toBe(4);
      const ack = path.join(dir, "resume.ack");
      const merged = { sha: git(work, "rev-parse", "HEAD"), files: ["README.md"] };
      process.env[RESUME_ENV] = JSON.stringify({ args: process.argv.slice(process.argv[2] === "--" ? 3 : 2), parent: process.ppid, ack, hops: 1, place: { merged, plan: { duties: [], left: [] }, clock: { sha: merged.sha, start: 0, since: {} }, held: [] } });
      expect(await runAwaitDeploy(opts, env)).toBe(0);
      expect(fs.existsSync(ack)).toBe(true);
      expect(printed.at(-1)).toBe(`${merged.sha.slice(0, 7)} is on main; nothing this run deploys ships its files.`);
    } finally {
      console.log = log;
      delete process.env[RESUME_ENV];
    }
  });
});
