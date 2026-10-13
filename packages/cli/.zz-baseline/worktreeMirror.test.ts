import { describe, expect, test } from "bun:test";
import { mergeWorktreesPayload, worktreeOfPath, type WorktreesPayload } from "@codecast/shared/contracts";
import { beforeEach } from "bun:test";
import { buildWorktreeMirror, mainRootFor, parseWorktreeList, resetWorktreeMirrorCache, worktreeFingerprint } from "./worktreeMirror";
import type { GitRunner } from "./repoMirror";

const ROOT = "/nonexistent/repo";
const WT = `${ROOT}/.codecast/worktrees/tips-modes`;
const AGENT = `${ROOT}/.claude/worktrees/agent-a1`;
const LAND = "/nonexistent/repo-land";

const LISTING = [
  `worktree ${ROOT}\nHEAD aaaa111\nbranch refs/heads/main`,
  `worktree ${WT}\nHEAD bbbb222\nbranch refs/heads/codecast/tips-modes`,
  `worktree ${AGENT}\nHEAD cccc333\ndetached\nlocked`,
  `worktree ${LAND}\nHEAD eeee555\nbranch refs/heads/land-all`,
  `worktree /tmp/gone\nHEAD dddd444\nbranch refs/heads/old\nprunable gitdir file points to non-existent location`,
].join("\n\n") + "\n";

/** A git that answers from a table; anything unlisted fails like a real refusal. */
function fakeGit(calls: string[] = []): GitRunner {
  return async (cwd, args) => {
    const key = args.join(" ");
    calls.push(`${cwd} :: ${key}`);
    if (key === "worktree list --porcelain") return LISTING;
    if (key === "remote get-url origin") return "git@github.com:union/union-mobile.git\n";
    if (key === "rev-parse --abbrev-ref HEAD") return "main\n";
    if (key === "symbolic-ref --short refs/remotes/origin/HEAD") return "origin/main\n";
    if (key.startsWith("status --porcelain")) return cwd === WT ? " M app.ts\n" : "";
    if (key === "rev-list --left-right --count main...bbbb222") return "68\t3\n";
    if (key === "rev-parse main") return "aaaa111\n";
    // Three commits ahead by hash; two already landed on main under new hashes.
    if (key === "cherry aaaa111 bbbb222") return "- 1111 landed\n- 2222 landed\n+ 3333 still only here\n";
    if (key.startsWith("log -1")) return "1789000000\u0000Add tip modes\n";
    if (key === "rev-parse --path-format=absolute --git-common-dir") return `${ROOT}/.git\n`;
    throw new Error(`unexpected git ${key}`);
  };
}

const payloadOf = (mirror: { rows: Array<{ content: string }> }) => JSON.parse(mirror.rows[0].content) as WorktreesPayload;

describe("parseWorktreeList", () => {
  test("reads each block, detached and flagged ones included", () => {
    expect(parseWorktreeList(LISTING)).toEqual([
      { path: ROOT, head_sha: "aaaa111", branch: "main" },
      { path: WT, head_sha: "bbbb222", branch: "codecast/tips-modes" },
      { path: AGENT, head_sha: "cccc333", locked: true },
      { path: LAND, head_sha: "eeee555", branch: "land-all" },
      { path: "/tmp/gone", head_sha: "dddd444", branch: "old", prunable: true },
    ]);
  });
});

describe("buildWorktreeMirror", () => {
  beforeEach(resetWorktreeMirrorCache);

  test("publishes one worktrees row under the repository's key", async () => {
    const mirror = (await buildWorktreeMirror(ROOT, { now: () => 5 }, fakeGit()))!;
    expect(mirror.repository).toBe("union/union-mobile");
    expect(mirror.default_branch).toBe("main");
    expect(mirror.head_sha).toBe("aaaa111");
    expect(mirror.commits).toEqual([]);
    expect(mirror.rows.map((r) => [r.kind, r.path])).toEqual([["worktrees", ROOT]]);
    const names = payloadOf(mirror).worktrees.map((w) => [w.name, w.manager, !!w.main]);
    expect(names).toEqual([["repo", "git", true], ["tips-modes", "codecast", false], ["agent-a1", "claude", false], ["repo-land", "git", false], ["gone", "git", false]]);
  });

  test("a session belongs to the deepest worktree holding its cwd", async () => {
    const mirror = (await buildWorktreeMirror(ROOT, {
      sessions: [
        { conversationId: "conv-main", cwd: `${ROOT}/packages/web` },
        { conversationId: "conv-wt", cwd: `${WT}/packages/web` },
      ],
    }, fakeGit()))!;
    const byName = Object.fromEntries(payloadOf(mirror).worktrees.map((w) => [w.name, w.sessions]));
    expect(byName).toEqual({ repo: ["conv-main"], "tips-modes": ["conv-wt"], "agent-a1": undefined, "repo-land": undefined, gone: undefined });
    expect(payloadOf(mirror).sessions_live).toBe(true);
  });

  test("git reads go to every worktree but an agent's own, unless a session is in it", async () => {
    const calls: string[] = [];
    const mirror = (await buildWorktreeMirror(ROOT, {}, fakeGit(calls)))!;
    const wt = payloadOf(mirror).worktrees.find((w) => w.name === "tips-modes")!;
    expect(wt).toMatchObject({ dirty: true, ahead: 1, behind: 68, subject: "Add tip modes", committed_at: 1789000000000 });
    expect(payloadOf(mirror).worktrees[0].dirty).toBe(false);
    expect(calls.filter((c) => c.includes("status --porcelain")).map((c) => c.split(" :: ")[0])).toEqual([ROOT, WT, LAND]);
    const occupied: string[] = [];
    await buildWorktreeMirror(ROOT, { sessions: [{ conversationId: "c", cwd: AGENT, dirty: true }] }, fakeGit(occupied));
    expect(occupied.filter((c) => c.includes("log -1")).map((c) => c.split(" ")[c.split(" ").length - 1])).toContain("cccc333");
  });

  test("ahead counts the patches main lacks, asked once for each pair of commits", async () => {
    const calls: string[] = [];
    await buildWorktreeMirror(ROOT, {}, fakeGit(calls));
    await buildWorktreeMirror(ROOT, {}, fakeGit(calls));
    expect(calls.filter((c) => c.includes(":: cherry ")).length).toBe(1);
  });

  test("an occupied worktree is inspected before an idle one", async () => {
    const calls: string[] = [];
    await buildWorktreeMirror(ROOT, { sessions: [{ conversationId: "c", cwd: LAND }] }, fakeGit(calls));
    const order = calls.filter((c) => c.includes("status --porcelain")).map((c) => c.split(" :: ")[0]);
    expect(order).toEqual([ROOT, LAND, WT]);
  });

  test("an occupied worktree takes the daemon's status read instead of making its own", async () => {
    const calls: string[] = [];
    const mirror = (await buildWorktreeMirror(ROOT, { sessions: [{ conversationId: "c", cwd: `${WT}/packages`, dirty: false }] }, fakeGit(calls)))!;
    expect(payloadOf(mirror).worktrees.find((w) => w.name === "tips-modes")!.dirty).toBe(false);
    expect(calls.filter((c) => c.includes("status --porcelain")).map((c) => c.split(" :: ")[0])).toEqual([ROOT, LAND]);
  });

  test("the fingerprint ignores when the row was read and moves when a worktree does", async () => {
    const at1 = (await buildWorktreeMirror(ROOT, { now: () => 1 }, fakeGit()))!;
    const at2 = (await buildWorktreeMirror(ROOT, { now: () => 2 }, fakeGit()))!;
    const occupied = (await buildWorktreeMirror(ROOT, { now: () => 2, sessions: [{ conversationId: "c", cwd: WT }] }, fakeGit()))!;
    expect(worktreeFingerprint(at1)).toBe(worktreeFingerprint(at2));
    expect(worktreeFingerprint(occupied)).not.toBe(worktreeFingerprint(at1));
  });

  test("the main checkout is found from inside a worktree", async () => {
    expect(await mainRootFor(WT, fakeGit())).toBe(ROOT);
  });
});

describe("mergeWorktreesPayload", () => {
  const base = (sessions_live: boolean, sessions: Record<string, string[] | undefined>): WorktreesPayload => ({
    root: ROOT, default_branch: "main", truncated: false, sessions_live, at: 1,
    worktrees: Object.entries(sessions).map(([name, s]) => ({ name, path: `${ROOT}/${name}`, head_sha: "x", manager: "git" as const, ...(s ? { sessions: s } : {}) })),
  });

  test("a publish that did not look for sessions keeps the ones the row held", () => {
    const merged = mergeWorktreesPayload(base(false, { a: undefined, b: ["acquired"] }), base(true, { a: ["live"], b: ["live-b"] }));
    expect(merged.worktrees.map((w) => w.sessions)).toEqual([["live"], ["acquired", "live-b"]]);
  });

  test("a publish that looked replaces them", () => {
    const merged = mergeWorktreesPayload(base(true, { a: undefined }), base(true, { a: ["gone"] }));
    expect(merged.worktrees[0].sessions).toBeUndefined();
  });
});

describe("worktreeOfPath", () => {
  test("names the repository root and worktree of any path inside one", () => {
    expect(worktreeOfPath(`${WT}/packages/web/app.ts`)).toEqual({ path: WT, root: ROOT, name: "tips-modes" });
    expect(worktreeOfPath(AGENT)).toEqual({ path: AGENT, root: ROOT, name: "agent-a1" });
    expect(worktreeOfPath(".codecast/worktrees/tips-modes/app.ts")).toEqual({ path: ".codecast/worktrees/tips-modes", root: "", name: "tips-modes" });
    expect(worktreeOfPath(`${AGENT}/.codecast/worktrees/inner`)).toEqual({ path: `${AGENT}/.codecast/worktrees/inner`, root: AGENT, name: "inner" });
    expect(worktreeOfPath(`${ROOT}/packages/web`)).toBeNull();
    expect(worktreeOfPath(`${ROOT}/.codecast/worktrees`)).toBeNull();
  });
});
