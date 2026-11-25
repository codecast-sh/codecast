// The judged-diff key against real git (judgedDiff.vectors.json, cut by scripts/judgedDiffVectors.ts): what the
// server rebuilds from GitHub's per-file patches must hash to the patch id `git patch-id --stable` gave for the same
// pull request, which is what Union's bash computes.
import { describe, expect, test } from "bun:test";
import vectors from "./judgedDiff.vectors.json";
import { diffKey, gitDiffText, invertPathDiff, isJudged, judgedPaths, keyChanged, keyEntriesFor, mayBeJudged, ownerOf, parseJudges, parseOwners, patchIdStable, pathDiffsOf, pathsOf, requestedBy, revertedShas, type GitHubFile } from "./judgedDiff";

const entries = parseJudges(vectors.judges);

async function serverKey(files: GitHubFile[]): Promise<{ judged: string[]; key: string }> {
  const judged = judgedPaths(files.flatMap(pathsOf), entries);
  const rebuilt = pathDiffsOf(files, (p) => judged.includes(p));
  if ("unreadable" in rebuilt) throw new Error(`unreadable ${rebuilt.unreadable}`);
  return { judged, key: await diffKey(rebuilt.diffs) };
}

describe("judges file", () => {
  test("blank and comment lines say nothing; lines are trimmed; a trailing / covers a folder", () => {
    expect(entries).toEqual(["outreach/line/change/", "outreach/deploy.sh", "outreach/ci.sh"]);
    expect(isJudged("outreach/line/change/land.cast", entries)).toBe(true);
    expect(isJudged("outreach/line/changes.md", entries)).toBe(false);
    expect(isJudged("outreach/deploy.sh.bak", entries)).toBe(false);
  });
});

describe("golden vectors from git patch-id --stable", () => {
  for (const c of vectors.cases as any[]) {
    test(c.name, async () => {
      const got = await serverKey(c.files);
      expect(got.judged).toEqual(c.judged);
      expect(got.key).toBe(c.key);
    });
  }

  test("a true revert: the pull request's whole diff has the patch id of its commit's inverse", async () => {
    const c: any = (vectors.cases as any[]).find((x) => x.reverts);
    const whole = pathDiffsOf(c.files, () => true);
    const commit = pathDiffsOf(c.reverts.commit_files, () => true);
    if ("unreadable" in whole || "unreadable" in commit) throw new Error("unreadable");
    expect(await diffKey(whole.diffs)).toBe(c.reverts.whole_key);
    expect(await diffKey(commit.diffs.map(invertPathDiff))).toBe(c.reverts.whole_key);
    expect(await diffKey(commit.diffs)).not.toBe(c.reverts.whole_key);
  });
});

describe("what cannot be rebuilt exactly is never guessed", () => {
  const base = { base_mode: "100644", head_mode: "100644" };
  test("a modified judged file with no patch (binary, too large) is unreadable", () => {
    expect(pathDiffsOf([{ filename: "a/x", status: "modified", additions: 3, deletions: 1, ...base }], () => true)).toEqual({ unreadable: "a/x" });
    expect(pathDiffsOf([{ filename: "a/x", status: "modified", additions: 0, deletions: 0, ...base }], () => true)).toEqual({ unreadable: "a/x" });
  });
  test("a rename whose text was not read is unreadable; an unjudged file's missing patch is no matter", () => {
    expect(pathDiffsOf([{ filename: "a/new", previous_filename: "a/old", status: "renamed", ...base, base_text: null, head_text: "x\n" }], (p) => p === "a/old")).toEqual({ unreadable: "a/old" });
    expect(pathDiffsOf([{ filename: "docs/big", status: "modified", additions: 9, ...base }], (p) => p.startsWith("a/"))).toEqual({ diffs: [] });
  });
});

test("the patch-id port reads git's own diff text: hunk numbers and whitespace do not count", async () => {
  const a = await patchIdStable(gitDiffText({ path: "f", base_mode: "100644", head_mode: "100644", hunks: "@@ -1,2 +1,2 @@\n a\n-b\n+c" }));
  const b = await patchIdStable(gitDiffText({ path: "f", base_mode: "100644", head_mode: "100644", hunks: "@@ -40,2 +41,2 @@ context\n  a\n-b \n+c\t" }));
  expect(a).toBe(b);
  expect(await patchIdStable("")).toBeNull();
  expect(await diffKey([])).toBe("none");
});

test("revert lines name full shas only", () => {
  const sha = "a".repeat(40);
  expect(revertedShas(`Revert "x"\n\nThis reverts commit ${sha}.\nThis reverts commit abc.`)).toEqual([sha]);
});

describe("name#key entries, as gate.sh reads them", () => {
  const list = parseJudges("outreach/line/\npackage.json#scripts\n");
  test("a file of that name is judged only when the top-level key's value changed; missing reads null", () => {
    expect(isJudged("outreach/package.json", list)).toBe(false);
    expect(mayBeJudged("outreach/backend/package.json", list)).toBe(true);
    expect(keyEntriesFor("x/package.json", list)).toEqual([{ name: "package.json", key: "scripts" }]);
    const pkg = (scripts: unknown, deps = {}) => JSON.stringify({ name: "x", scripts, dependencies: deps });
    expect(keyChanged(pkg({ test: "bun test" }), pkg({ test: "bun test" }, { zod: "4" }), "scripts")).toBe(false);
    expect(keyChanged(pkg({ test: "bun test" }), pkg({ test: "true" }), "scripts")).toBe(true);
    expect(keyChanged(null, JSON.stringify({ name: "x" }), "scripts")).toBe(false);
    expect(keyChanged(null, pkg({ a: "b" }), "scripts")).toBe(true);
    expect(keyChanged(pkg({}), "{ not json", "scripts")).toBe(true);
    expect(judgedPaths(["a/package.json", "b/package.json", "outreach/line/x"], list, ["b/package.json"])).toEqual(["b/package.json", "outreach/line/x"]);
  });
});

test("the owners file names the area's person by its longest prefix; Requested-by comes from the newest commit", () => {
  const owners = parseOwners("# area  person\noutreach/  Ashot\noutreach/line/  Jason\n\nbad-line\n");
  expect(ownerOf(["outreach/line/change/land.cast"], owners)).toBe("Jason");
  expect(ownerOf(["outreach/backend/x.ts"], owners)).toBe("Ashot");
  expect(ownerOf(["docs/x"], owners)).toBeNull();
  expect(requestedBy(["a\n\nRequested-by: Samvit", "b\n\nRequested-by: Jason", "c"])).toBe("Jason");
  expect(requestedBy(["no trailer"])).toBeNull();
});
