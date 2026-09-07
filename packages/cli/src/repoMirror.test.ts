import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { answerLocalRead, buildRepoMirror, refsFingerprint, repositoryKeyFor } from "./repoMirror.js";

// The rows a checkout publishes must be the rows GitHub would have written:
// same keys, same payload fields. These tests build a real repository and
// check the shapes the repo pages read.

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=Tess Ter", ...args], { encoding: "utf-8" }).trim();
}

let dir: string;

function makeRepo(): string {
  const repo = path.join(dir, "demo");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "README.md"), "# Demo\n\nhello\n");
  fs.writeFileSync(path.join(repo, "src", "index.ts"), "export const x = 1;\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "first commit\n\nwith a body");
  fs.writeFileSync(path.join(repo, "src", "index.ts"), "export const x = 2;\nexport const y = 3;\n");
  git(repo, "commit", "-q", "-am", "second commit");
  git(repo, "tag", "-a", "v1", "-m", "release one");
  git(repo, "checkout", "-q", "-b", "feature");
  fs.writeFileSync(path.join(repo, "feature.txt"), "f\n");
  git(repo, "add", "feature.txt");
  git(repo, "commit", "-q", "-m", "feature work");
  git(repo, "remote", "add", "origin", "git@github.com:Acme/Demo.git");
  return repo;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "repomirror-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("repositoryKeyFor", () => {
  test("a GitHub origin is owner/name, canonical case", () => {
    expect(repositoryKeyFor("/x/demo", "git@github.com:Acme/Demo.git")).toBe("acme/demo");
    expect(repositoryKeyFor("/x/demo", "https://github.com/Acme/Demo")).toBe("acme/demo");
  });
  test("another host keeps its last two segments; no remote falls back to the folder", () => {
    expect(repositoryKeyFor("/x/demo", "https://gitlab.com/group/sub/thing.git")).toBe("sub/thing");
    expect(repositoryKeyFor("/x/MyRepo", undefined)).toBe("local/myrepo");
  });
});

describe("buildRepoMirror", () => {
  test("a non-repository is null", async () => {
    expect(await buildRepoMirror(dir)).toBeNull();
  });

  test("publishes every kind the pages read, keyed the way the cache expects", async () => {
    const repo = makeRepo();
    const mirror = await buildRepoMirror(repo);
    expect(mirror).not.toBeNull();
    expect(mirror!.repository).toBe("acme/demo");
    expect(mirror!.default_branch).toBe("main");
    expect(mirror!.head_sha).toBe(git(repo, "rev-parse", "HEAD"));

    const byKey = new Map(mirror!.rows.map((r) => [`${r.kind}|${r.ref}|${r.path}`, JSON.parse(r.content)]));

    const branches = byKey.get("branches|-|");
    expect(branches.default_branch).toBe("main");
    expect(branches.branches.map((b: any) => b.name).sort()).toEqual(["feature", "main"]);

    const details = byKey.get("branchdetails|-|");
    const feature = details.branches.find((b: any) => b.name === "feature");
    expect(feature).toMatchObject({ subject: "feature work", author_name: "Tess Ter", ahead_by: 1, behind_by: 0, open_pr: null });
    expect(feature.committed_at).toBeGreaterThan(1_600_000_000_000);

    const tags = byKey.get("tags|-|");
    expect(tags.tags[0]).toMatchObject({ name: "v1", sha: git(repo, "rev-parse", "v1^{commit}"), subject: "second commit" });

    const tree = byKey.get("tree|main|");
    expect(tree.sha).toBe(git(repo, "rev-parse", "main^{tree}"));
    expect(tree.entries.map((e: any) => `${e.type}:${e.path}`).sort()).toEqual(["blob:README.md", "tree:src"]);
    expect(tree.entries.find((e: any) => e.path === "README.md").size).toBe(14);
    // The same tree under its own sha, and the subdirectory under its sha, for the walk.
    expect(byKey.get(`tree|${tree.sha}|`)).toEqual(tree);
    const src = tree.entries.find((e: any) => e.path === "src");
    expect(byKey.get(`tree|${src.sha}|`).entries[0]).toMatchObject({ path: "index.ts", type: "blob" });

    expect(byKey.get("readme|main|")).toMatchObject({ found: true, path: "README.md", content: "# Demo\n\nhello\n" });

    const log = byKey.get("log|main|#1#");
    expect(log.commits.map((c: any) => c.message)).toEqual(["second commit", "first commit\n\nwith a body"]);
    expect(log.commits[0]).toMatchObject({ additions: 2, deletions: 1, changed_files: 1, author_name: "Tess Ter" });
    expect(log.commits[0].html_url).toBe(`https://github.com/acme/demo/commit/${log.commits[0].sha}`);
    // The checked-out branch gets its own page and tree.
    expect(byKey.get("log|feature|#1#").commits[0].message).toBe("feature work");
    expect(byKey.get("tree|feature|").entries.map((e: any) => e.path).sort()).toEqual(["README.md", "feature.txt", "src"]);

    const last = byKey.get("lastcommits|main|");
    expect(last["src"]).toMatchObject({ subject: "second commit", author_name: "Tess Ter" });
    expect(last["README.md"].subject).toBe("first commit");

    const meta = byKey.get("meta|-|");
    expect(meta).toMatchObject({ private: true, default_branch: "main", html_url: "https://github.com/acme/demo", source: "local" });
    expect(meta.languages).toEqual({ TypeScript: 40 });

    // The commits table rows: deduplicated across the two pages, with counts.
    expect(mirror!.commits.map((c) => c.message)).toEqual(["second commit", "first commit\n\nwith a body", "feature work"]);
    expect(mirror!.commits[1]).toMatchObject({ files_changed: 2, insertions: 4, deletions: 0, author_email: "t@t", branch: "main" });
  });

  test("every commit ahead of upstream is published, past the first page of history", async () => {
    const repo = makeRepo();
    const remote = path.join(dir, "remote.git");
    git(repo, "checkout", "-q", "main");
    execFileSync("git", ["init", "-q", "--bare", remote]);
    git(repo, "remote", "set-url", "origin", remote);
    git(repo, "push", "-q", "-u", "origin", "main");
    const pushed = git(repo, "rev-parse", "HEAD");
    for (let i = 0; i < 33; i++) {
      fs.writeFileSync(path.join(repo, "n.txt"), `${i}\n`);
      git(repo, "add", "n.txt");
      git(repo, "commit", "-q", "-m", `local ${i}`);
    }
    const mirror = await buildRepoMirror(repo);
    const local = mirror!.commits.filter((c) => c.message.startsWith("local "));
    expect(local).toHaveLength(33);
    expect(local.every((c) => c.branch === "main")).toBe(true);
    // One set: the first page (30) and the unpushed walk (33) overlap, and the
    // pushed tip sits past both, so the row list is exactly the local commits.
    expect(mirror!.commits).toHaveLength(33);
    expect(mirror!.commits.some((c) => c.sha === pushed)).toBe(false);
  }, 30_000);

  test("a repository with no readme says so, and the fingerprint moves with the refs", async () => {
    const repo = makeRepo();
    git(repo, "checkout", "-q", "main");
    git(repo, "rm", "-q", "README.md");
    git(repo, "commit", "-q", "-m", "drop readme");
    const before = await refsFingerprint(repo);
    const mirror = await buildRepoMirror(repo);
    const readme = mirror!.rows.find((r) => r.kind === "readme");
    expect(JSON.parse(readme!.content)).toEqual({ found: false });
    git(repo, "commit", "-q", "--allow-empty", "-m", "another");
    expect(await refsFingerprint(repo)).not.toBe(before);
  });
});

describe("answerLocalRead", () => {
  const ask = (root: string, kind: string, ref: string, path: string, params: Record<string, any> = {}) =>
    answerLocalRead({ _id: "r", repository: "acme/demo", root, kind, ref, path, params: { ref, path, ...params } });
  const payload = (answer: any) => JSON.parse(answer.row.content);

  test("a file at a ref, with its size and sha; a missing path is a reason, not a row", async () => {
    const repo = makeRepo();
    const blob = await ask(repo, "blob", "main", "src/index.ts");
    expect(payload(blob)).toMatchObject({ content: "export const x = 2;\nexport const y = 3;\n", size: 40, truncated: false });
    expect((blob as any).row).toMatchObject({ kind: "blob", ref: "main", path: "src/index.ts", size: 40 });
    expect(await ask(repo, "blob", "main", "nope.ts")).toEqual({ error: "nope.ts does not exist at main" });
  });

  test("a tree by branch or by tree sha, and recursively", async () => {
    const repo = makeRepo();
    const byBranch = payload(await ask(repo, "tree", "main", ""));
    expect(byBranch.entries.map((e: any) => e.path).sort()).toEqual(["README.md", "src"]);
    const src = byBranch.entries.find((e: any) => e.path === "src");
    expect(payload(await ask(repo, "tree", src.sha, "")).entries[0].path).toBe("index.ts");
    expect(payload(await ask(repo, "tree", "main", "**", { recursive: true })).entries.map((e: any) => e.path)).toContain("src/index.ts");
  });

  test("history pages, filtered by path and author, and a blame", async () => {
    const repo = makeRepo();
    const page2 = payload(await ask(repo, "log", "main", "#2#", { page: 2 }));
    expect(page2.commits).toEqual([]);
    const byPath = payload(await ask(repo, "log", "main", "README.md#1#", { path: "README.md", page: 1 }));
    expect(byPath.commits.map((c: any) => c.message)).toEqual(["first commit\n\nwith a body"]);
    expect(payload(await ask(repo, "log", "main", "#1#nobody", { author: "nobody", page: 1 })).commits).toEqual([]);
    const blame = payload(await ask(repo, "blame", "main", "src/index.ts"));
    expect(blame.ranges).toHaveLength(1);
    expect(blame.ranges[0]).toMatchObject({ start_line: 1, end_line: 2, message: "second commit", author_name: "Tess Ter" });
  });

  test("a compare between branches carries counts, commits and files with patches", async () => {
    const repo = makeRepo();
    const compare = payload(await ask(repo, "compare", "main", "feature", { base: "main", head: "feature" }));
    expect(compare).toMatchObject({ ahead_by: 1, behind_by: 0, total_commits: 1, status: "ahead" });
    expect(compare.commits[0].message).toBe("feature work");
    expect(compare.files[0]).toMatchObject({ filename: "feature.txt", status: "added", additions: 1, deletions: 0 });
    expect(compare.files[0].patch).toContain("+f");
  });

  test("a commit's diff for the commit row, and a stranger sha is a reason", async () => {
    const repo = makeRepo();
    const sha = git(repo, "rev-parse", "main");
    const answer = (await ask(repo, "commit", sha, "")) as any;
    expect(answer.commit).toMatchObject({ additions: 2, deletions: 1 });
    expect(answer.commit.files[0]).toMatchObject({ filename: "src/index.ts", status: "modified", additions: 2, deletions: 1, changes: 3 });
    expect(answer.commit.files[0].patch).toContain("-export const x = 1;");
    expect(await ask(repo, "commit", "e".repeat(40), "")).toEqual({ error: `${"e".repeat(40)} is not a commit in this checkout` });
  });
});
