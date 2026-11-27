import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseDeployTargets } from "@codecast/shared/contracts/deployTargets";
import { commitsSince, planRelease, runRelease, type PlanStep, type ReleaseIO, type ServerTarget } from "./deployRelease";

// A release (deploys.md DP15): which targets it sends, waits for and leaves
// alone, and the order it sends them in. Synthetic targets and fakes only.

const declared = parseDeployTargets({
  target: [
    { name: "mobile", run: "ota.sh $sha", policy: "release", after: "backend", when: "app/**" },
    { name: "backend", run: "deploy.sh", policy: "release", when: "api/**" },
    { name: "web", runs: "push", when: "web/**" },
    { name: "desktop", run: "release.sh", when: "desktop/**" },
    { name: "worker", run: "w.sh", policy: "auto", when: "worker/**" },
  ],
}, []);

const live = (sha: string) => ({ short_id: `dp-${sha}`, status: "live", sha, created_at: 1 });
const server: ServerTarget[] = ["mobile", "backend", "web", "desktop", "worker"].map((name) => ({ name, live: live("old"), device_id: "this", root: "/repo" }));

const plan = (over: Partial<Parameters<typeof planRelease>[0]> = {}) =>
  planRelease({ declared, server, sha: "new", commitsSince: async () => 3, carries: async (d) => d === "new", ...over });

describe("what a release does with each target", () => {
  test("sends release targets, waits on push targets, leaves press and auto ones, in the order they wait on each other", async () => {
    const p = await plan();
    expect(p.map((s) => [s.target, s.action])).toEqual([["backend", "send"], ["mobile", "send"], ["web", "wait"], ["desktop", "skip"], ["worker", "skip"]]);
    expect(p.find((s) => s.target === "mobile")!.after).toEqual(["backend"]);
    expect(p.find((s) => s.target === "desktop")!.why).toBe("goes out on a press: cast deploy desktop");
  });

  test("a named target goes whatever its policy; the rest are left", async () => {
    const p = await plan({ named: ["desktop"] });
    expect(p.filter((s) => s.action !== "skip").map((s) => s.target)).toEqual(["desktop"]);
    await expect(plan({ named: ["nope"] })).rejects.toThrow("No target nope");
  });

  test("a target already live at the sha, or with nothing waiting, is left; an after it does not need is dropped", async () => {
    const p = await plan({ server: server.map((t) => (t.name === "backend" ? { ...t, live: live("new") } : t)), commitsSince: async (_f, paths) => (paths[0] === "web/**" ? 0 : 2) });
    expect(p.find((s) => s.target === "backend")!.why).toBe("already live (dp-new)");
    expect(p.find((s) => s.target === "web")!.action).toBe("skip");
    expect(p.find((s) => s.target === "mobile")!).toMatchObject({ action: "send", after: [], commits: 2 });
  });

  test("a change's files narrow it to the targets they touch, and except leaves one out", async () => {
    const p = await plan({ files: ["app/screen.tsx", "web/page.tsx"], except: ["web"] });
    expect(p.filter((s) => s.action !== "skip").map((s) => s.target)).toEqual(["mobile"]);
    expect(p.find((s) => s.target === "web")!.why).toBe("left out on purpose");
  });

  test("a change of only what a target exempts leaves it, and its exempt commits wait on nothing", async () => {
    const exempting = parseDeployTargets({ target: [{ name: "mobile", run: "ota.sh $sha", policy: "release", when: "app/**", unless: "**/*.test.ts" }] }, []);
    const p = await plan({ declared: exempting, files: ["app/screen.test.ts"] });
    expect(p).toMatchObject([{ target: "mobile", action: "skip", why: "the change touches none of its paths, past what it exempts (tests)" }]);
    const counted: string[][] = [];
    await plan({ declared: exempting, commitsSince: async (_f, _p, unless) => (counted.push(unless), 0) });
    expect(counted).toEqual([["**/*.test.ts"]]);
  });

  test("commits since a live deploy count only those touching a target's paths past what it exempts", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "release-since-"));
    const git = (...args: string[]) => spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf-8" }).stdout.trim();
    const commit = (file: string) => { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), file); git("add", "."); git("commit", "-qm", file); return git("rev-parse", "HEAD"); };
    try {
      git("init", "-q");
      const from = commit("README.md");
      commit("app/a.test.ts");
      commit("app/lib/b.test.ts");
      const head = commit("web/c.ts");
      expect(await commitsSince(repo, from, head, ["app/**"], ["**/*.test.ts"])).toBe(0);
      expect(await commitsSince(repo, from, head, ["app/**"], [])).toBe(2);
      expect(await commitsSince(repo, from, head, [], ["**/*.test.ts"])).toBe(1);
      const shipped = commit("app/d.ts");
      expect(await commitsSince(repo, from, shipped, ["app/**"], ["**/*.test.ts"])).toBe(1);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

function fakeIO(over: Partial<ReleaseIO> = {}): ReleaseIO & { events: string[]; rows: Map<string, any> } {
  const events: string[] = [];
  const rows = new Map<string, any>();
  let n = 0;
  return {
    events,
    rows,
    request: async (target, here) => { const id = `dp-${++n}`; rows.set(id, { status: "requested", target }); events.push(`request ${target}${here ? "" : " (queued)"}`); return { short_id: id }; },
    run: async (deploy, target) => { events.push(`run ${target}`); rows.set(deploy, { status: "live", sha: "new", target }); return 0; },
    read: async (deploy) => rows.get(deploy) ?? null,
    targets: async () => server,
    carries: async (d) => d === "new",
    publishedHere: () => true,
    log: () => {},
    sleep: async () => {},
    pollMs: 1,
    waitMs: 50,
    ...over,
  };
}

const step = (target: string, action: PlanStep["action"], after: string[] = []): PlanStep => ({ target, action, after, why: "", commits: 1 });

describe("carrying out a release", () => {
  test("a target is sent only once everything it goes after is live", async () => {
    const io = fakeIO();
    const results = await runRelease([step("backend", "send"), step("mobile", "send", ["backend"])], io);
    expect(io.events).toEqual(["request backend", "run backend", "request mobile", "run mobile"]);
    expect(results.map((r) => [r.target, r.status, r.deploy])).toEqual([["backend", "live", "dp-1"], ["mobile", "live", "dp-2"]]);
  });

  test("when what it goes after fails, it is not sent", async () => {
    const io = fakeIO({ run: async (deploy, target) => { io.rows.set(deploy, { status: target === "backend" ? "failed" : "live", note: "red" }); return 1; } });
    const results = await runRelease([step("backend", "send"), step("mobile", "send", ["backend"])], io);
    expect(results[1]).toMatchObject({ status: "failed", note: "not sent: backend did not go live" });
    expect(io.events).not.toContain("request mobile");
  });

  test("a deploy already going out is waited on, and is enough when it carries the sha", async () => {
    let asks = 0;
    const io = fakeIO({
      targets: async () => [{ name: "cli", open: { short_id: "dp-9", status: "running" } }],
      request: async () => { asks++; throw new Error("dp-9 is already going out"); },
    });
    io.rows.set("dp-9", { status: "live", sha: "new" });
    const [r] = await runRelease([step("cli", "send")], io);
    expect(r).toMatchObject({ status: "live", deploy: "dp-9" });
    expect(asks).toBe(1);
  });

  test("a target another machine publishes is asked of that machine and waited on", async () => {
    const io = fakeIO({ publishedHere: () => false, targets: async () => [{ name: "cli" }], sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
    const pending = runRelease([step("cli", "send")], io);
    setTimeout(() => io.rows.set("dp-1", { status: "live", sha: "new" }), 5);
    const [r] = await pending;
    expect(io.events).toEqual(["request cli (queued)"]);
    expect(r).toMatchObject({ status: "live", deploy: "dp-1" });
  });

  test("a push target is waited on until a live deploy holds the sha", async () => {
    let reads = 0;
    const io = fakeIO({ targets: async () => [{ name: "web", live: live(++reads > 2 ? "new" : "old") }] });
    const [r] = await runRelease([step("web", "wait")], io);
    expect(r).toMatchObject({ status: "live", deploy: "dp-new" });
  });
});
