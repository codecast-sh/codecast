// THE JUDGED-DIFF KEY'S GOLDEN VECTORS, cut by real git (ct-100350).
//
// Builds a scratch repository, makes each case's main and head, and records two things per case: the key git itself
// gives (`git diff --no-renames <merge-base> <head> -- <judged> | git patch-id --stable`, what Union's bash runs) and
// what GitHub would say about the same pull request (its per-file status, patch, modes, and a rename's two texts).
// convex/lib/judgedDiff.test.ts feeds the GitHub side to the server's rebuild and requires git's key back, so the two
// implementations cannot drift apart without a red test.
//
// Usage: bun packages/convex/scripts/judgedDiffVectors.ts > packages/convex/convex/lib/judgedDiff.vectors.json
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "judged-diff-"));
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "v", GIT_AUTHOR_EMAIL: "v@x", GIT_COMMITTER_NAME: "v", GIT_COMMITTER_EMAIL: "v@x", GIT_AUTHOR_DATE: "2026-11-24T00:00:00Z", GIT_COMMITTER_DATE: "2026-11-24T00:00:00Z" };

function git(args: string[], input?: string): string {
  const r = Bun.spawnSync(["git", ...args], { cwd: dir, env, stdin: input === undefined ? undefined : new TextEncoder().encode(input) });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

type Files = Record<string, string | null | { text: string; mode: "100755" }>;
function write(files: Files) {
  for (const [path, body] of Object.entries(files)) {
    const at = join(dir, path);
    if (body === null) { unlinkSync(at); continue; }
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, typeof body === "string" ? body : body.text);
    if (typeof body !== "string") chmodSync(at, 0o755);
  }
  git(["add", "-A"]);
}
const commit = (msg: string) => { git(["commit", "-q", "--allow-empty", "-m", msg]); return git(["rev-parse", "HEAD"]).trim(); };

const JUDGES = "# What a person approves before it merges.\n\noutreach/line/change/\noutreach/deploy.sh\n  outreach/ci.sh  \n";
const lines = (n: number, tag = "") => Array.from({ length: n }, (_, i) => `line ${i + 1}${tag}`).join("\n") + "\n";
const LAND = lines(40);
const DIFF = ["-c", "diff.algorithm=myers", "diff", "--no-color", "--no-ext-diff"];

/** What GitHub's pull request files API says for mb...head: rename detection on, the patch from its first hunk. */
function githubFiles(mb: string, head: string) {
  const status = git([...DIFF, "-M", "--name-status", mb, head]).trim().split("\n").filter(Boolean);
  return status.map((row) => {
    const [code, a, b] = row.split("\t");
    const path = b ?? a;
    const raw = git([...DIFF, "-M", mb, head, "--", ...(b ? [a, b] : [a])]);
    const at = raw.indexOf("\n@@ ");
    const patch = at === -1 ? undefined : raw.slice(at + 1).replace(/\n$/, "");
    const mode = (sha: string, p: string) => git(["ls-tree", sha, "--", p]).split(" ")[0] || null;
    const kind = code.startsWith("R") ? "renamed" : code === "A" ? "added" : code === "D" ? "removed" : "modified";
    const [adds, dels] = git([...DIFF, "-M", "--numstat", mb, head, "--", ...(b ? [a, b] : [a])]).split("\t");
    return {
      filename: path,
      status: kind,
      ...(kind === "removed" ? {} : { sha: git(["rev-parse", `${head}:${path}`]).trim() }),
      additions: Number(adds) || 0,
      deletions: Number(dels) || 0,
      ...(b ? { previous_filename: a } : {}),
      ...(patch !== undefined ? { patch } : {}),
      base_mode: mode(mb, b ? a : path),
      head_mode: mode(head, path),
      ...(b ? { base_text: git(["show", `${mb}:${a}`]), head_text: git(["show", `${head}:${b}`]) } : {}),
    };
  });
}

function judgedOf(mb: string, head: string): string[] {
  const entries = JUDGES.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  return git([...DIFF, "--no-renames", "--name-only", mb, head]).trim().split("\n").filter((p) => p && entries.some((e) => (e.endsWith("/") ? p.startsWith(e) : p === e)));
}

function gitKey(mb: string, head: string, paths?: string[]): string {
  if (paths && !paths.length) return "none";
  const diff = git([...DIFF, "--no-renames", mb, head, ...(paths ? ["--", ...paths] : [])]);
  return git(["patch-id", "--stable"], diff).trim().split(" ")[0] || "none";
}

const cases: any[] = [];
function record(name: string, main: string, head: string, extra: Record<string, unknown> = {}) {
  const mb = git(["merge-base", main, head]).trim();
  const judged = judgedOf(mb, head);
  cases.push({ name, judged, key: gitKey(mb, head, judged), files: githubFiles(mb, head), ...extra });
}

git(["init", "-q", "-b", "main"]);
write({ "outreach/line/change/judges.txt": JUDGES, "outreach/line/change/land.cast": LAND, "outreach/deploy.sh": { text: "#!/bin/sh\necho deploy\n", mode: "100755" }, "docs/a.md": lines(5), "docs/b.md": lines(5), "README.md": "hi\n" });
const root = commit("root");

// 1. A branch edits a judged file and an unjudged one.
git(["checkout", "-q", "-b", "edit", root]);
write({ "outreach/line/change/land.cast": LAND.replace("line 20\n", "line 20 changed\n"), "docs/a.md": lines(5, "!") });
const edit = commit("edit land.cast");
record("edits a judged file", root, edit);

// 2. Main moves on with unrelated work (and a far-away edit of the same judged file); the branch is rebased onto it.
git(["checkout", "-q", "main"]);
write({ "docs/b.md": lines(7), "README.md": "hello\n", "outreach/line/change/land.cast": LAND.replace("line 2\n", "line 2 on main\n") });
const main2 = commit("unrelated work on main");
git(["checkout", "-q", "-b", "edit-rebased", edit]);
git(["rebase", "-q", main2]);
record("a rebase over unrelated main commits keeps the key", main2, git(["rev-parse", "HEAD"]).trim(), { same_key_as: "edits a judged file" });

// 3. The branch edits the judged file again: the key moves.
write({ "outreach/line/change/land.cast": LAND.replace("line 2\n", "line 2 on main\n").replace("line 20\n", "line 20 changed\n").replace("line 30\n", "line 30 too\n") });
record("editing a judged file again changes the key", main2, commit("edit again"), { differs_from: "edits a judged file" });

// 4. Only unjudged files.
git(["checkout", "-q", "-b", "docs", main2]);
write({ "docs/a.md": lines(6) });
record("no judged paths", main2, commit("docs"));

// 5. A judged file renamed (GitHub reports one rename; --no-renames sees a deletion and an addition).
git(["checkout", "-q", "-b", "rename", main2]);
git(["mv", "outreach/line/change/land.cast", "outreach/line/change/land2.cast"]);
record("a rename is two entries", main2, commit("rename"));

// 6. A judged file deleted, and a judged executable added.
git(["checkout", "-q", "-b", "delete-add", main2]);
write({ "outreach/line/change/judges.txt": null, "outreach/ci.sh": { text: "#!/bin/sh\nexit 0", mode: "100755" } });
record("a deletion and an executable added without a final newline", main2, commit("delete and add"));

// 7. A mode change alone, and an empty judged file added.
git(["checkout", "-q", "-b", "mode", main2]);
chmodSync(join(dir, "outreach/line/change/land.cast"), 0o755);
write({ "outreach/line/change/empty.cast": "" });
record("a mode change and an empty file", main2, commit("mode"));

const byName = new Map(cases.map((c) => [c.name, c]));
for (const c of cases) {
  if (c.same_key_as && byName.get(c.same_key_as).key !== c.key) throw new Error(`${c.name}: key should match ${c.same_key_as}`);
  if (c.differs_from && byName.get(c.differs_from).key === c.key) throw new Error(`${c.name}: key should differ from ${c.differs_from}`);
}

console.log(JSON.stringify({
  definition: "key = git patch-id --stable of `git -c diff.algorithm=myers diff --no-renames <merge-base(main, head)> <head> -- <judged paths>`, \"none\" when no path is judged. Judged: an entry of main's judges.txt names the path, or ends in / and prefixes it; blank and # lines skipped, lines trimmed.",
  git_version: git(["--version"]).trim(),
  judges: JUDGES,
  cases,
}, null, 2));
rmSync(dir, { recursive: true, force: true });
