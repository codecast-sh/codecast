import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ACTIVE_MS, STALE_MS, absorbedInto, fileVerdict, ownerIsLive, ownerOf, parseRawDiff, parseWorktreeList, scanRepo, treeVerdict,
  type RepoScan, type VerdictFacts,
} from "./scan.js";
import { pruneTargets, type LandScan } from "./cli.js";
import { ARCHIVE_REF_PREFIX, pruneTree, treePatch } from "./prune.js";

const NOW = 1_800_000_000_000;
const facts = (over: Partial<VerdictFacts>): VerdictFacts => ({
  primary: false, locked: false, liveOwner: false, processInside: false,
  lastActivity: NOW - 3 * 86_400_000, counts: { same: 0, absorbed: 0, only: 0, both: 0 }, now: NOW, ...over,
});

describe("treeVerdict", () => {
  test("in-use trees are live, whatever they hold", () => {
    expect(treeVerdict(facts({ liveOwner: true, counts: { same: 0, absorbed: 0, only: 3, both: 0 } })).verdict).toBe("live");
    expect(treeVerdict(facts({ processInside: true })).verdict).toBe("live");
    expect(treeVerdict(facts({ locked: true })).verdict).toBe("live");
    expect(treeVerdict(facts({ lastActivity: NOW - ACTIVE_MS + 60_000 })).verdict).toBe("live");
  });
  test("the main checkout is never a candidate", () => {
    expect(treeVerdict(facts({ primary: true, counts: { same: 0, absorbed: 0, only: 9, both: 0 } })).verdict).toBe("primary");
  });
  test("content decides between empty, landed, ready and review", () => {
    expect(treeVerdict(facts({})).verdict).toBe("empty");
    expect(treeVerdict(facts({ counts: { same: 4, absorbed: 0, only: 0, both: 0 } })).verdict).toBe("landed");
    expect(treeVerdict(facts({ counts: { same: 1, absorbed: 2, only: 0, both: 0 } })).verdict).toBe("landed");
    expect(treeVerdict(facts({ counts: { same: 0, absorbed: 0, only: 2, both: 1 } })).verdict).toBe("ready");
    expect(treeVerdict(facts({ counts: { same: 0, absorbed: 3, only: 0, both: 2 } })).verdict).toBe("review");
  });
  test("work untouched past the stale line is stale, not ready", () => {
    expect(treeVerdict(facts({ lastActivity: NOW - STALE_MS - 1, counts: { same: 0, absorbed: 0, only: 2, both: 0 } })).verdict).toBe("stale");
    // Nothing of its own left: it is landed however old.
    expect(treeVerdict(facts({ lastActivity: NOW - STALE_MS - 1, counts: { same: 2, absorbed: 0, only: 0, both: 0 } })).verdict).toBe("landed");
  });
});

describe("absorbedInto", () => {
  const base = "export const a = 1;\nexport const b = 2;\n}\n";
  test("main holding the tree's added lines, moved and among its own edits, absorbs it", () => {
    const tree = "export const a = 1;\nexport const b = 2;\nexport const added = 3;\n}\n";
    const main = "export const added = 3;\nexport const a = 10;\nexport const b = 2;\n}\n";
    expect(absorbedInto(base, tree, main)).toBe(true);
  });
  test("main lacking the tree's line does not", () => {
    const tree = "export const a = 1;\nexport const b = 2;\nexport const added = 3;\n";
    expect(absorbedInto(base, tree, "export const a = 10;\nexport const b = 2;\n")).toBe(false);
  });
  test("a removal is absorbed only when main dropped the line too", () => {
    const tree = "export const a = 1;\n";
    expect(absorbedInto(base, tree, "export const a = 5;\n")).toBe(true);
    expect(absorbedInto(base, tree, "export const a = 5;\nexport const b = 2;\n")).toBe(false);
  });
});

describe("fileVerdict", () => {
  const Z = "0".repeat(40);
  test("same, only and both by blob", () => {
    expect(fileVerdict("a", "b", "b")).toBe("same");
    expect(fileVerdict("a", "b", "a")).toBe("only");
    expect(fileVerdict("a", "b", "c")).toBe("both");
  });
  test("added and deleted files", () => {
    expect(fileVerdict(Z, "b", undefined)).toBe("only");
    expect(fileVerdict(Z, "b", "b")).toBe("same");
    expect(fileVerdict("a", Z, undefined)).toBe("same");
    expect(fileVerdict("a", Z, "a")).toBe("only");
  });
});

test("parseWorktreeList marks the first entry primary and drops prunable ones", () => {
  const out = "worktree /r\nHEAD aaa\nbranch refs/heads/main\n\nworktree /r/w1\nHEAD bbb\nbranch refs/heads/feat/x\nlocked\n\nworktree /gone\nHEAD ccc\ndetached\nprunable gitdir file points to non-existent location\n";
  expect(parseWorktreeList(out)).toEqual([
    { path: "/r", head: "aaa", branch: "main", locked: false, primary: true },
    { path: "/r/w1", head: "bbb", branch: "feat/x", locked: true, primary: false },
  ]);
});

test("parseRawDiff drops nested worktrees and node_modules symlinks", () => {
  const z = "0".repeat(40), b = "b".repeat(40);
  const out = `:000000 160000 ${z} ${b} A\t.codecast/worktrees/x\n:000000 120000 ${z} ${b} A\tnode_modules\n:000000 120000 ${z} ${b} A\tpackages/web/node_modules\n:000000 120000 ${z} ${b} A\tlink\n`;
  expect(parseRawDiff(out).map((r) => r.path)).toEqual(["link"]);
});

test("parseRawDiff reads blobs, status and paths with spaces", () => {
  const out = `:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} M\tsrc/a b.ts\n:000000 100644 ${"0".repeat(40)} ${"c".repeat(40)} A\tnew.ts\n`;
  expect(parseRawDiff(out)).toEqual([
    { src: "a".repeat(40), dst: "b".repeat(40), status: "M", path: "src/a b.ts" },
    { src: "0".repeat(40), dst: "c".repeat(40), status: "A", path: "new.ts" },
  ]);
});

test("ownerOf matches by path or codecast worktree name; ownerIsLive needs an active, recent row", () => {
  const roster = [
    { short_id: "a", project_path: "/r/.claude/worktrees/agent-1/sub", work_state: "working", updated_at: NOW },
    { short_id: "b", worktree_name: "fix-x", work_state: "done", updated_at: NOW },
  ];
  expect(ownerOf("/r/.claude/worktrees/agent-1", roster)?.short_id).toBe("a");
  expect(ownerOf("/r/.claude/worktrees/agent-10", roster)).toBeNull();
  expect(ownerOf("/r/.codecast/worktrees/fix-x", roster)?.short_id).toBe("b");
  expect(ownerIsLive(roster[0], NOW)).toBe(true);
  expect(ownerIsLive(roster[1], NOW)).toBe(false);
  expect(ownerIsLive({ ...roster[0], updated_at: NOW - 4 * 86_400_000 }, NOW)).toBe(false);
});

describe("against a real repo", () => {
  let dir: string;
  let root: string;
  // `when` (ms ago) dates the commit or reflog entry the command writes.
  const sh = (cwd: string, ...args: string[]) => shAt(0, cwd, ...args);
  const shAt = (when: number, cwd: string, ...args: string[]) => {
    const date = `${Math.floor((Date.now() - when) / 1000)} +0000`;
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } }).trim();
  };
  const write = (p: string, s: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
  const age = (tree: string, ms: number) => {
    const t = new Date(Date.now() - ms);
    for (const f of [sh(tree, "diff", "HEAD", "--name-only"), sh(tree, "ls-files", "-o", "--exclude-standard")].join("\n").split("\n").filter(Boolean)) fs.utimesSync(path.join(tree, f), t, t);
    fs.utimesSync(sh(tree, "rev-parse", "--path-format=absolute", "--git-path", "index"), t, t);
    // git stamps a worktree's creation reflog with the real clock whatever GIT_COMMITTER_DATE says.
    const log = sh(tree, "rev-parse", "--path-format=absolute", "--git-path", "logs/HEAD");
    const secs = Math.floor(t.getTime() / 1000);
    fs.writeFileSync(log, fs.readFileSync(log, "utf-8").replace(/> \d+ ([+-]\d{4}\t)/g, `> ${secs} $1`));
  };
  const day = 86_400_000;
  const wt = (name: string, when = 0) => { const p = path.join(root, ".claude", "worktrees", name); shAt(when, root, "worktree", "add", "-q", "-b", name, p); return p; };
  let scan: RepoScan;
  const tree = (name: string) => scan.trees.find((t) => t.path.endsWith(`/${name}`))!;

  beforeAll(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "land-test-")));
    sh(dir, "init", "-q", "--bare", "-b", "main", "origin.git");
    root = path.join(dir, "repo");
    sh(dir, "clone", "-q", path.join(dir, "origin.git"), "repo");
    write(path.join(root, "a.ts"), "a\n"); write(path.join(root, "b.ts"), "b\n");
    write(path.join(root, "c.ts"), "export const c = 1;\nexport const keep = true;\n");
    write(path.join(root, "d.ts"), "export const d = 1;\n");
    sh(root, "add", "-A"); sh(root, "commit", "-q", "-m", "init"); sh(root, "push", "-q", "origin", "HEAD:main");
    sh(root, "remote", "set-head", "origin", "main");

    const empty = wt("empty", 3 * day); age(empty, 3 * day);
    const ready = wt("ready", 1 * day);
    write(path.join(ready, "a.ts"), "a2\n"); write(path.join(ready, "new.ts"), "n\n");
    sh(ready, "add", "a.ts"); // staged: the scan must leave it staged
    age(ready, 1 * day);
    const landed = wt("landed", 2 * day); write(path.join(landed, "b.ts"), "b2\n"); age(landed, 2 * day);
    const absorbed = wt("absorbed", 5 * day);
    write(path.join(absorbed, "c.ts"), "export const c = 1;\nexport const keep = true;\nexport const added = 2;\n"); age(absorbed, 5 * day);
    const conflict = wt("conflict", 1 * day); write(path.join(conflict, "d.ts"), "export const d = 2;\n"); age(conflict, 1 * day);
    const stale = wt("stale", 10 * day); write(path.join(stale, "stale.ts"), "s\n"); age(stale, 10 * day);
    const live = wt("live"); write(path.join(live, "live.ts"), "l\n");
    // An empty tree nested inside the live one stays with it.
    const underLive = path.join(live, ".codecast", "worktrees", "under-live");
    shAt(3 * day, root, "worktree", "add", "-q", "-b", "under-live", underLive); age(underLive, 3 * day);
    // Nested: an outer empty tree holding an inner one with work, which must keep the outer.
    const outer = wt("outer", 3 * day); age(outer, 3 * day);
    const inner = path.join(outer, ".codecast", "worktrees", "inner");
    shAt(day, root, "worktree", "add", "-q", "-b", "inner", inner); write(path.join(inner, "inner.ts"), "i\n"); age(inner, 1 * day);

    // Main lands b.ts as is, lands c.ts's added line inside its own rework, and changes d.ts its own way.
    write(path.join(root, "b.ts"), "b2\n");
    write(path.join(root, "c.ts"), "export const c = 10;\nexport const keep = true;\nexport const added = 2;\n");
    write(path.join(root, "d.ts"), "export const d = 3;\n");
    sh(root, "commit", "-q", "-am", "main moves"); sh(root, "push", "-q", "origin", "HEAD:main");
    scan = await scanRepo(root, { roster: [], processCwds: [], fetch: true });
  }, 120_000);
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("every tree gets the verdict its content and age call for", () => {
    expect(tree("repo").verdict).toBe("primary");
    expect(tree("empty").verdict).toBe("empty");
    expect(tree("ready").verdict).toBe("ready");
    expect(tree("ready").counts).toEqual({ same: 0, absorbed: 0, only: 2, both: 0 });
    expect(tree("landed").verdict).toBe("landed");
    expect(tree("absorbed").verdict).toBe("landed");
    expect(tree("absorbed").counts).toEqual({ same: 0, absorbed: 1, only: 0, both: 0 });
    expect(tree("conflict").verdict).toBe("review");
    expect(tree("stale").verdict).toBe("stale");
    expect(tree("live").verdict).toBe("live");
    expect(tree("inner").verdict).toBe("ready");
  });

  test("a scan never touches a worktree's own index", () => {
    expect(sh(tree("ready").path, "diff", "--cached", "--name-only")).toBe("a.ts");
    expect(sh(tree("ready").path, "status", "--porcelain")).toContain("?? new.ts");
  });

  test("the only-files patch applies to main", async () => {
    const patch = await treePatch(tree("ready"), ["only"]);
    const p = path.join(dir, "ready.patch"); fs.writeFileSync(p, patch);
    sh(root, "apply", "--check", p);
  }, 60_000);

  test("prune keeps a tree whose nested worktree stays, and archives what it removes", async () => {
    const landScan: LandScan = { scannedAt: new Date().toISOString(), machine: "t", roster: "ok", repos: [scan] };
    const { go, held } = pruneTargets(landScan);
    expect(go.map((t) => path.basename(t.path)).sort()).toEqual(["absorbed", "empty", "landed", "stale"]);
    expect(held.map((h) => path.basename(h.tree.path)).sort()).toEqual(["outer", "under-live"]);
    expect(pruneTargets({ ...landScan, roster: "offline" }).go).toEqual([]);

    process.env.CODECAST_DIR = path.join(dir, "codecast-home");
    const r = await pruneTree(tree("stale"), root);
    expect(fs.existsSync(tree("stale").path)).toBe(false);
    expect(fs.readFileSync(r.archived!, "utf-8")).toContain("stale.ts");
    expect(sh(root, "rev-parse", `${ARCHIVE_REF_PREFIX}stale`)).toBe(tree("stale").head);
    expect(sh(root, "branch", "--list", "stale")).toBe("");
    expect(sh(root, "worktree", "list")).not.toContain("/stale ");
  }, 60_000);
});
