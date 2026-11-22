import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { CHECKOUT_PATHS_MAX, LEVEL_STUCK_FILE_MS, type CheckoutLevel } from "@codecast/shared/contracts/checkouts";
import { dirtyPaths, fileStuck, groupUncommitted, nextLevel, reportCheckouts, stuckWords } from "./checkoutReport.js";
import type { SessionEdits } from "./attribute.js";
import type { LevelResult } from "./level.js";

// What a machine reports of its checkouts, and the one ask for help a stuck level makes (ct-98780). Synthetic
// repositories and sessions only; the config dir is a temp one, so no real transcript is read.

const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
let configDir: string;
let savedDir: string | undefined;
beforeAll(() => { savedDir = process.env.CODECAST_DIR; configDir = tmp("checkout-config-"); process.env.CODECAST_DIR = configDir; });
afterAll(() => { if (savedDir === undefined) delete process.env.CODECAST_DIR; else process.env.CODECAST_DIR = savedDir; });

const MIN = 60_000;
const refused = (root: string, conflicts: string[], to = "a".repeat(40)): { root: string; result: LevelResult } => ({
  root, result: { ok: false, from: "f".repeat(40), to, written: [], deleted: [], absorbed: [], merged: [], kept: [], conflicts, reason: `${conflicts.length} file(s) changed here and in ${to.slice(0, 9)} without a clean merge` },
});
const levelled = (root: string): { root: string; result: LevelResult } => ({ root, result: { ...refused(root, []).result, ok: true, reason: undefined } });
const session = (id: string, over: Partial<SessionEdits> = {}): SessionEdits => ({ sessionId: id, conversationId: `conv_${id}`, client: "claude", transcript: `/t/${id}.jsonl`, edits: new Map(), lastText: null, lastActivity: 0, status: null, ...over });

describe("the level sweep's state on a checkout", () => {
  test("the same files refused again keep the episode they started, though main (and the reason's sha) moved", () => {
    const a = nextLevel({}, refused("/r", ["b.ts", "a.ts"]), 1_000);
    expect(a.level).toEqual({ state: "stuck", files: ["a.ts", "b.ts"], reason: expect.stringContaining("without a clean merge"), since: 1_000, filed: null });
    const filed = { at: 5_000, to: "finding" as const };
    const b = nextLevel({ ...a.state, stuck: { ...a.state.stuck!, filed } }, refused("/r", ["a.ts", "b.ts"], "c".repeat(40)), 9_000);
    expect(b.level).toMatchObject({ state: "stuck", since: 1_000, filed });
    // Other files: a new episode, asked about again in its own time.
    expect(nextLevel(b.state, refused("/r", ["c.ts"]), 10_000).level).toMatchObject({ since: 10_000, filed: null });
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

describe("a stuck level asks once, naming the conflict and the two ways out", () => {
  const level: Extract<CheckoutLevel, { state: "stuck" }> = { state: "stuck", files: ["src/remediation.test.ts"], reason: "1 file(s) changed here and in abc123456 without a clean merge", since: Date.UTC(2026, 10, 21, 8, 0), filed: null };
  const report = { path: "/work/app", upstream: "origin/main", behind: 159, repository: "acme/app", device_id: "dev-1" } as any;

  test("the words name the checkout, the file, how far behind, and both ways out", () => {
    const { title, body } = stuckWords(report, level, "laptop");
    expect(title).toBe("app on laptop cannot level to origin/main: src/remediation.test.ts");
    expect(body).toContain("since 2026-11-21 08:00 UTC (159 commits behind now)");
    expect(body).toContain("`src/remediation.test.ts` changed here, uncommitted, and on origin/main");
    expect(body).toContain("Rebase the edit onto main's version");
    expect(body).toContain("git -C /work/app diff -- 'src/remediation.test.ts' > /tmp/level-aside.patch && git -C /work/app checkout -- 'src/remediation.test.ts'");
  });

  test("to the session that last wrote the file; with none, a finding on the repo's project", async () => {
    const sent: Array<[string, any]> = [];
    const post = async (p: string, b: any) => { sent.push([p, structuredClone(b)]); return {}; };
    const writer = session("w");
    expect(await fileStuck(post, report, level, { owners: new Map([["src/remediation.test.ts", writer]]) }, { host: "laptop", now: 7 })).toEqual({ at: 7, to: "session", conversation_id: "conv_w" });
    expect(sent[0]).toEqual(["/cli/messages/send", { to: "conv_w", body: expect.stringContaining("cannot level"), intent: "request", wake: true }]);
    expect(await fileStuck(post, report, level, { owners: new Map() }, { host: "laptop", now: 8 })).toEqual({ at: 8, to: "finding" });
    expect(sent[1][0]).toBe("/cli/signal/add");
    expect(sent[1][1]).toMatchObject({ source: "level", kind: "bug", fingerprint: "level:dev-1:/work/app:src/remediation.test.ts", project_path: "/work/app", detail_md: expect.stringContaining("Two ways out") });
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
    const deps = { post, deviceId: "dev-1", repositoryOf: () => "Acme/App", stateFile: path.join(configDir, "state-1.json"), host: "laptop" };
    const t0 = 1_000_000;
    await reportCheckouts([refused(root, ["a.ts"])], { ...deps, now: t0 });
    const first = posts.filter(([p]) => p === "/cli/checkouts/report");
    expect(first).toHaveLength(1);
    const sentReport = first[0][1].reports[0];
    expect(sentReport).toMatchObject({ repository: "acme/app", device_id: "dev-1", path: root, branch: "main", upstream: "origin/main", ahead: 0, behind: 0, level: { state: "stuck", files: ["a.ts"], since: t0, filed: null } });
    expect(sentReport.uncommitted).toEqual({ total: 1, sessions: [], unattributed: ["a.ts"], unattributed_more: 0 });

    // The same state a minute later: nothing sent, nothing filed.
    await reportCheckouts([refused(root, ["a.ts"])], { ...deps, now: t0 + MIN });
    expect(posts).toHaveLength(1);

    // Past 30 minutes on the same file: one ask (no writer session here: a finding), and the report says it went.
    await reportCheckouts([refused(root, ["a.ts"], "b".repeat(40))], { ...deps, now: t0 + LEVEL_STUCK_FILE_MS + MIN });
    expect(posts.map(([p]) => p)).toEqual(["/cli/checkouts/report", "/cli/signal/add", "/cli/checkouts/report"]);
    expect(posts[2][1].reports[0].level).toMatchObject({ since: t0, filed: { at: t0 + LEVEL_STUCK_FILE_MS + MIN, to: "finding" } });
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
