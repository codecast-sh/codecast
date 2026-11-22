import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { CHECKOUT_PATHS_MAX, LEVEL_STUCK_FILE_MS, type CheckoutLevel, type CheckoutTold } from "@codecast/shared/contracts/checkouts";
import { conflictGroups, dirtyPaths, groupUncommitted, nextLevel, reportCheckouts, tellWriters } from "./checkoutReport.js";
import type { SessionEdits } from "./attribute.js";
import type { LevelResult } from "./level.js";
import { updateSyncRecord } from "../syncLedger.js";

// What a machine reports of its checkouts, and the one ask for help a stuck level makes (ct-98780). Synthetic
// repositories and sessions only; the config dir is a temp one, so no real transcript is read.

const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
let configDir: string;
let savedDir: string | undefined;
beforeAll(() => { savedDir = process.env.CODECAST_DIR; configDir = tmp("checkout-config-"); process.env.CODECAST_DIR = configDir; });
afterAll(() => { if (savedDir === undefined) delete process.env.CODECAST_DIR; else process.env.CODECAST_DIR = savedDir; });

const MIN = 60_000;
const refused = (root: string, conflicts: string[], to = "a".repeat(40)): { root: string; gitDir: string; result: LevelResult } => ({
  root, gitDir: `${root}/.git`, result: { ok: false, from: "f".repeat(40), to, written: [], deleted: [], absorbed: [], merged: [], kept: [], conflicts, reason: `${conflicts.length} file(s) changed here and in ${to.slice(0, 9)} without a clean merge` },
});
const levelled = (root: string): { root: string; gitDir: string; result: LevelResult } => ({ root, gitDir: `${root}/.git`, result: { ...refused(root, []).result, ok: true, reason: undefined } });
const session = (id: string, over: Partial<SessionEdits> = {}): SessionEdits => ({ sessionId: id, conversationId: `conv_${id}`, client: "claude", transcript: `/t/${id}.jsonl`, edits: new Map(), lastText: null, lastActivity: 0, status: null, ...over });

describe("the level sweep's state on a checkout", () => {
  test("the same files refused again keep the episode they started, though main (and the reason's sha) moved", () => {
    const a = nextLevel({}, refused("/r", ["b.ts", "a.ts"]), 1_000);
    expect(a.level).toEqual({ state: "stuck", files: ["a.ts", "b.ts"], reason: expect.stringContaining("without a clean merge"), since: 1_000, told: [] });
    const told: CheckoutTold[] = [{ at: 5_000, files: 2, to: "finding" }];
    const b = nextLevel({ ...a.state, stuck: { ...a.state.stuck!, told } }, refused("/r", ["a.ts", "b.ts"], "c".repeat(40)), 9_000);
    expect(b.level).toMatchObject({ state: "stuck", since: 1_000, told });
    // Other files: a new episode, asked about again in its own time.
    expect(nextLevel(b.state, refused("/r", ["c.ts"]), 10_000).level).toMatchObject({ since: 10_000, told: [] });
  });

  test("a level ends the episode and says when; a skip says why; at upstream reads level", () => {
    const stuck = nextLevel({}, refused("/r", ["a.ts"]), 1_000).state;
    const done = nextLevel(stuck, levelled("/r"), 2_000);
    expect(done.level).toEqual({ state: "level", levelled_at: 2_000 });
    expect(done.state.stuck).toBeUndefined();
    expect(nextLevel(done.state, { root: "/r", skipped: "level" }, 3_000).level).toEqual({ state: "level", levelled_at: 2_000 });
    expect(nextLevel(done.state, { root: "/r", skipped: "holds commits upstream lacks" }, 3_000).level).toEqual({ state: "off", reason: "holds commits upstream lacks" });
  });
});

describe("uncommitted work by the session that wrote it", () => {
  test("grouped by writer, newest write first, with live state; the rest unattributed; lists capped", () => {
    const now = 100 * MIN;
    const working = session("w", { status: "working", lastActivity: now - MIN, edits: new Map([["a.ts", 5], ["b.ts", 9]]) });
    const idle = session("i", { lastActivity: now - 10 * MIN, edits: new Map([["c.ts", 1]]) });
    const done = session("d", { lastActivity: now - 90 * MIN, edits: new Map(Array.from({ length: 30 }, (_, i) => [`many/${i}.ts`, i] as [string, number])) });
    const owners = new Map<string, SessionEdits>([["a.ts", working], ["b.ts", working], ["c.ts", idle], ...[...done.edits.keys()].map((p) => [p, done] as [string, SessionEdits])]);
    const paths = ["a.ts", "b.ts", "c.ts", ...done.edits.keys(), "person-wrote.md"];
    const u = groupUncommitted(paths, { owners }, now);
    expect(u.total).toBe(34);
    expect(u.sessions.map((s) => [s.session_id, s.state])).toEqual([["w", "working"], ["i", "idle"], ["d", "finished"]]);
    expect(u.sessions[0].paths).toEqual(["b.ts", "a.ts"]);
    expect(u.sessions[2]).toMatchObject({ conversation_id: "conv_d", more: 30 - CHECKOUT_PATHS_MAX });
    expect(u.sessions[2].paths).toHaveLength(CHECKOUT_PATHS_MAX);
    expect(u.unattributed).toEqual(["person-wrote.md"]);
  });
});

describe("a stuck level tells each writer about its own files, once", () => {
  const files = Array.from({ length: 123 }, (_, i) => `pkg/f${String(i).padStart(3, "0")}.ts`);
  const level = (told: CheckoutTold[] = []): Extract<CheckoutLevel, { state: "stuck" }> => ({ state: "stuck", files, reason: "123 file(s) changed here and in abc123456 without a clean merge", since: Date.UTC(2026, 10, 22, 4, 27), told });
  const report = { path: "/work/app", upstream: "origin/main", behind: 828, repository: "acme/app", device_id: "dev-1" } as any;
  // A wrote 100 of the files, B 20, and 3 have no session.
  const a = session("a");
  const b = session("b");
  const owners = new Map<string, SessionEdits>([...files.slice(0, 100).map((f) => [f, a] as [string, SessionEdits]), ...files.slice(100, 120).map((f) => [f, b] as [string, SessionEdits])]);

  test("the files are grouped by the session that last wrote each; the rest have nobody", () => {
    const g = conflictGroups(files, { owners });
    expect([...g.writers].map(([c, f]) => [c, f.length])).toEqual([["conv_a", 100], ["conv_b", 20]]);
    expect(g.nobody).toEqual(files.slice(120));
  });

  test("each writer hears only of its files, briefly, with ways out over a list of exactly them; the rest go to one finding", async () => {
    const dir = tmp("level-asks-");
    const sent: Array<[string, any]> = [];
    const post = async (p: string, x: any) => { sent.push([p, structuredClone(x)]); return {}; };
    const told = await tellWriters(post, report, level(), { owners }, { host: "laptop", now: 7, dir });
    expect(told).toEqual([{ at: 7, files: 100, to: "session", conversation_id: "conv_a" }, { at: 7, files: 20, to: "session", conversation_id: "conv_b" }, { at: 7, files: 3, to: "finding" }]);
    expect(sent.map(([p, x]) => [p, x.to ?? null])).toEqual([["/cli/messages/send", "conv_a"], ["/cli/messages/send", "conv_b"], ["/cli/signal/add", null]]);
    const toA: string = sent[0][1].body;
    expect(toA.split("\n")[0]).toBe("app on laptop: 100 of your files conflict with origin/main");
    expect(toA).toContain("+92 more");
    expect(toA).toContain("The other 23 conflicting files belong to other sessions, which are told separately: leave them alone.");
    // Short: eight paths inline, never one of B's or the unwritten ones, never the whole list.
    expect(toA.length).toBeLessThan(2_000);
    expect(files.filter((f) => toA.includes(f))).toEqual(files.slice(0, 8));
    const list = toA.match(/The full list: (\S+)/)![1];
    expect(fs.readFileSync(list, "utf-8").trim().split("\n")).toEqual(files.slice(0, 100));
    expect(toA).toContain(`checkout --pathspec-from-file=${list}`);
    expect(sent[1][1].body).toContain("20 of your files");
    expect(sent[2][1]).toMatchObject({ source: "level", project_path: "/work/app", title: "app on laptop: 3 files no session wrote conflict with origin/main" });
  });

  test("once per episode per writer: a writer already told, by this daemon or an earlier one, hears nothing again", async () => {
    const dir = tmp("level-asks-");
    const sent: string[] = [];
    const post = async (_p: string, x: any) => { sent.push(x.to ?? "finding"); return {}; };
    expect(await tellWriters(post, report, level([{ at: 1, files: 100, to: "session", conversation_id: "conv_a" }]), { owners }, { dir })).toHaveLength(2);
    expect(sent).toEqual(["conv_b", "finding"]);
    sent.length = 0;
    const all: CheckoutTold[] = [{ at: 1, files: 100, to: "session", conversation_id: "conv_a" }, { at: 1, files: 20, to: "session", conversation_id: "conv_b" }, { at: 1, files: 3, to: "finding" }];
    expect(await tellWriters(post, report, level(all), { owners }, { dir })).toEqual([]);
    expect(sent).toEqual([]);
    // An earlier daemon's single ask (`filed`) counts as that writer told.
    const legacy = nextLevel({ stuck: { key: [...files].sort().join("\n"), files, reason: "r", since: 1, filed: { at: 1, to: "session", conversation_id: "conv_a" } } as any }, refused("/r", files), 2);
    expect(legacy.level).toMatchObject({ state: "stuck", since: 1, told: [{ to: "session", conversation_id: "conv_a", files: 0 }] });
  });

  test("the set-aside command in the ask sets aside exactly that writer's files, and leaves the others' edits", async () => {
    const origin = tmp("level-origin-");
    spawnSync("git", ["init", "-q", "--bare", "-b", "main"], { cwd: origin });
    const root = fs.realpathSync(tmp("level-repo-"));
    const git = (...args: string[]) => spawnSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], { cwd: root, encoding: "utf-8" });
    git("init", "-q", "-b", "main");
    // Brackets as in a route file: a pathspec would read them as a glob.
    const names = ["mine/[id].tsx", "mine/b.ts", "theirs/c.ts"];
    for (const f of names) { fs.mkdirSync(path.join(root, path.dirname(f)), { recursive: true }); fs.writeFileSync(path.join(root, f), "base\n"); }
    git("add", ".");
    git("commit", "-q", "-m", "base");
    for (const f of names) fs.writeFileSync(path.join(root, f), "edited\n");
    const sent: any[] = [];
    const mineOwners = new Map<string, SessionEdits>([["mine/[id].tsx", a], ["mine/b.ts", a], ["theirs/c.ts", b]]);
    const stuck: Extract<CheckoutLevel, { state: "stuck" }> = { state: "stuck", files: names, reason: "r", since: 0, told: [] };
    await tellWriters(async (_p, x) => { sent.push(x); return {}; }, { ...report, path: root, upstream: "HEAD" }, stuck, { owners: mineOwners }, { dir: tmp("level-asks-") });
    const aside = sent[0].body.match(/2\. Set them aside as a patch, then restore main's: `([^`]+)`/)![1];
    expect(spawnSync("sh", ["-c", aside], { encoding: "utf-8" }).status).toBe(0);
    expect(fs.readFileSync(path.join(root, "mine/[id].tsx"), "utf-8")).toBe("base\n");
    expect(fs.readFileSync(path.join(root, "mine/b.ts"), "utf-8")).toBe("base\n");
    expect(fs.readFileSync(path.join(root, "theirs/c.ts"), "utf-8")).toBe("edited\n");
    const patch = fs.readFileSync(sent[0].body.match(/> (\S+\.patch)/)![1], "utf-8");
    expect(patch).toContain("mine/[id].tsx");
    expect(patch).not.toContain("theirs/c.ts");
  });
});

describe("reporting a machine's checkouts", () => {
  const sh = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], { cwd, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const repo = () => {
    const origin = tmp("checkout-origin-");
    sh(origin, "init", "-q", "--bare", "-b", "main");
    const root = fs.realpathSync(tmp("checkout-clone-"));
    sh(root, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(root, "a.ts"), "one\n");
    sh(root, "add", ".");
    sh(root, "commit", "-q", "-m", "init");
    sh(root, "remote", "add", "origin", origin);
    sh(root, "push", "-q", "origin", "main");
    sh(root, "fetch", "-q", "origin");
    sh(root, "remote", "set-head", "origin", "main");
    return root;
  };

  test("a checkout is sent when it changes, not every pass; the stuck ask goes once past 30 minutes; a removed checkout is gone", async () => {
    const root = repo();
    fs.writeFileSync(path.join(root, "a.ts"), "edited\n");
    const posts: Array<[string, any]> = [];
    const post = async (p: string, b: any) => { posts.push([p, structuredClone(b)]); return {}; };
    const deps = { post, deviceId: "dev-1", repositoryOf: () => "Acme/App", stateFile: path.join(configDir, "state-1.json"), host: "laptop", askDir: configDir };
    const t0 = 1_000_000;
    await reportCheckouts([refused(root, ["a.ts"])], { ...deps, now: t0 });
    const first = posts.filter(([p]) => p === "/cli/checkouts/report");
    expect(first).toHaveLength(1);
    const sentReport = first[0][1].reports[0];
    expect(sentReport).toMatchObject({ repository: "acme/app", device_id: "dev-1", path: root, branch: "main", upstream: "origin/main", ahead: 0, behind: 0, level: { state: "stuck", files: ["a.ts"], since: t0, told: [] } });
    expect(sentReport.uncommitted).toEqual({ total: 1, sessions: [], unattributed: ["a.ts"], unattributed_more: 0 });

    // The same state a minute later: nothing sent, nothing filed.
    await reportCheckouts([refused(root, ["a.ts"])], { ...deps, now: t0 + MIN });
    expect(posts).toHaveLength(1);

    // Past 30 minutes on the same file: one ask (no writer session here: a finding), and the report says it went.
    await reportCheckouts([refused(root, ["a.ts"], "b".repeat(40))], { ...deps, now: t0 + LEVEL_STUCK_FILE_MS + MIN });
    expect(posts.map(([p]) => p)).toEqual(["/cli/checkouts/report", "/cli/signal/add", "/cli/checkouts/report"]);
    expect(posts[2][1].reports[0].level).toMatchObject({ since: t0, told: [{ at: t0 + LEVEL_STUCK_FILE_MS + MIN, files: 1, to: "finding" }] });
    await reportCheckouts([refused(root, ["a.ts"])], { ...deps, now: t0 + 2 * LEVEL_STUCK_FILE_MS });
    expect(posts.filter(([p]) => p === "/cli/signal/add")).toHaveLength(1);

    fs.rmSync(root, { recursive: true, force: true });
    await reportCheckouts([], { ...deps, now: t0 + 3 * LEVEL_STUCK_FILE_MS });
    expect(posts[posts.length - 1]).toEqual(["/cli/checkouts/report", { device_id: "dev-1", reports: [], gone: [root] }]);
  });

  test("dirty paths read every status: a modified first file, a rename by its new name, an untracked file", async () => {
    const root = repo();
    fs.writeFileSync(path.join(root, "a.ts"), "edited\n");
    fs.writeFileSync(path.join(root, "b.ts"), "two\n");
    sh(root, "add", "b.ts");
    sh(root, "commit", "-q", "-m", "b");
    sh(root, "mv", "b.ts", "c.ts");
    fs.writeFileSync(path.join(root, "new.md"), "x\n");
    expect((await dirtyPaths(root)).sort()).toEqual(["a.ts", "c.ts", "new.md"]);
  });

  test("while its transcripts are still being read, a checkout names no writer and asks nobody; read through, it names and asks the writer", async () => {
    const root = repo();
    fs.writeFileSync(path.join(root, "a.ts"), "edited\n");
    const transcript = path.join(configDir, "writer.jsonl");
    fs.writeFileSync(transcript, JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), cwd: root, message: { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: { file_path: path.join(root, "a.ts") } }] } }) + "\n");
    updateSyncRecord(transcript, { conversationId: "conv_writer" });
    const posts: Array<[string, any]> = [];
    const post = async (p: string, b: any) => { posts.push([p, structuredClone(b)]); return {}; };
    const deps = { post, deviceId: "dev-3", repositoryOf: () => "acme/app", stateFile: path.join(configDir, "state-3.json"), host: "laptop", askDir: configDir };
    const t0 = Date.now() - LEVEL_STUCK_FILE_MS - 2 * MIN;
    await reportCheckouts([refused(root, ["a.ts"])], { ...deps, now: t0, budgetMs: 0 });
    // Past the grace with no budget left this pass: the report says it is still reading, and nobody is asked.
    await reportCheckouts([refused(root, ["a.ts"])], { ...deps, now: Date.now(), budgetMs: 0 });
    const reading = posts.filter(([p]) => p === "/cli/checkouts/report").pop()![1].reports[0];
    expect(reading.uncommitted).toMatchObject({ attributing: true, sessions: [], unattributed: ["a.ts"] });
    expect(posts.some(([p]) => p === "/cli/messages/send" || p === "/cli/signal/add")).toBe(false);
    await reportCheckouts([refused(root, ["a.ts"])], { ...deps, now: Date.now() });
    const read = posts.filter(([p]) => p === "/cli/checkouts/report").pop()![1].reports[0];
    expect(read.uncommitted.attributing).toBeUndefined();
    expect(read.uncommitted.sessions.map((x: any) => x.conversation_id)).toEqual(["conv_writer"]);
    expect(posts.filter(([p]) => p === "/cli/messages/send").map(([, b]) => b.to)).toEqual(["conv_writer"]);
    expect(read.level.told).toEqual([expect.objectContaining({ to: "session", conversation_id: "conv_writer", files: 1 })]);
  });

  test("a cold attribution over a large fixture never holds the event loop more than a few hundred ms at a time", async () => {
    const root = repo();
    fs.writeFileSync(path.join(root, "a.ts"), "edited\n");
    const now = Date.now();
    const turn = (n: number) => JSON.stringify({ type: "user", message: { role: "user", content: "x".repeat(n) } });
    // Commands naming other volumes and remote hosts' paths: resolving one on disk once blocked for minutes.
    const elsewhere = JSON.stringify({ type: "assistant", cwd: "/", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "cd \"/Volumes/Archive/Photos\" && find originals -type f > /private/tmp/oa.txt; cat x > /home/ubuntu/work/app/out.txt" } }] } });
    // 120 transcripts of 2 MB each, the last of them holding the write: more than one pass reads.
    for (let i = 0; i < 120; i++) {
      const lines = [...Array.from({ length: 8 }, () => turn(256 * 1024)), elsewhere];
      if (i === 119) lines.push(JSON.stringify({ type: "assistant", timestamp: new Date(now - 1000).toISOString(), cwd: root, message: { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: { file_path: path.join(root, "a.ts") } }] } }));
      const file = path.join(configDir, `big-${i}.jsonl`);
      fs.writeFileSync(file, lines.join("\n") + "\n");
      updateSyncRecord(file, { conversationId: `conv_big_${i}` });
    }
    const deps = { post: async () => ({}), deviceId: "dev-4", repositoryOf: () => "acme/app", stateFile: path.join(configDir, "state-4.json") };
    let worst = 0;
    let last = Date.now();
    const timer = setInterval(() => { const t = Date.now(); worst = Math.max(worst, t - last); last = t; }, 5);
    let report: any = null;
    let firstPartial: boolean | null = null;
    let passes = 0;
    try {
      for (; passes < 400; passes++) {
        const posts: any[] = [];
        await reportCheckouts([{ root, skipped: "level" }], { ...deps, post: async (p: string, b: any) => { posts.push([p, b]); return {}; }, budgetMs: 20 });
        report = posts.find(([p]) => p === "/cli/checkouts/report")?.[1].reports[0] ?? report;
        firstPartial ??= !!report?.uncommitted.attributing;
        if (report && !report.uncommitted.attributing) break;
      }
    } finally {
      clearInterval(timer);
    }
    expect(report.uncommitted.attributing).toBeUndefined();
    expect(report.uncommitted.sessions.map((x: any) => x.conversation_id)).toEqual(["conv_big_119"]);
    expect(firstPartial).toBe(true);
    expect(passes).toBeGreaterThan(0);
    expect(worst).toBeLessThan(400);
  }, 120_000);

  test("a report the server did not take is sent again next pass", async () => {
    const root = repo();
    let fail = true;
    const posts: string[] = [];
    const post = async (p: string) => { posts.push(p); if (fail) throw new Error("offline"); return {}; };
    const deps = { post, deviceId: "dev-2", repositoryOf: () => "acme/app", stateFile: path.join(configDir, "state-2.json") };
    await reportCheckouts([{ root, skipped: "level" }], { ...deps, now: 1 });
    fail = false;
    await reportCheckouts([{ root, skipped: "level" }], { ...deps, now: 2 });
    expect(posts).toEqual(["/cli/checkouts/report", "/cli/checkouts/report"]);
  });
});
