import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createGitCapabilityStore, isUnsupportedMergeTreeWriteTreeError } from "./gitCapability";

let dir: string;
let cachePath: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-caps-"));
  cachePath = path.join(dir, "git-capabilities.json");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test("only git's own rejection of the option counts as unsupported", () => {
  expect(isUnsupportedMergeTreeWriteTreeError({ stderr: "error: unknown option `write-tree'" })).toBe(true);
  expect(isUnsupportedMergeTreeWriteTreeError({ stderr: "fatal: Not a valid object name --write-tree" })).toBe(true);
  expect(
    isUnsupportedMergeTreeWriteTreeError({
      stderr: "usage: git merge-tree <base-tree> <branch1> <branch2>",
    }),
  ).toBe(true);
  // A conflict is an answer, not a missing capability.
  expect(isUnsupportedMergeTreeWriteTreeError({ stderr: "CONFLICT (content): Merge conflict in a.txt" })).toBe(false);
  expect(isUnsupportedMergeTreeWriteTreeError(new Error("fatal: not a git repository"))).toBe(false);
});

test("a rejected option is remembered for this git, and re-probed after an upgrade", async () => {
  let attempts = 0;
  const preferred = async (): Promise<string> => {
    attempts++;
    throw Object.assign(new Error("Command failed"), { stderr: "error: unknown option `write-tree'" });
  };
  const run = (store: ReturnType<typeof createGitCapabilityStore>) =>
    store.runWithFallback("merge-tree-write-tree", preferred, () => "fallback", isUnsupportedMergeTreeWriteTreeError);

  const store = createGitCapabilityStore({ cachePath, gitVersion: "git version 2.30.0" });
  expect(await run(store)).toBe("fallback");
  expect(await run(store)).toBe("fallback");
  expect(attempts).toBe(1);

  // A later process, same host: the cache file answers.
  expect(await run(createGitCapabilityStore({ cachePath, gitVersion: "git version 2.30.0" }))).toBe("fallback");
  expect(attempts).toBe(1);

  // Two probes at once share one cache read rather than racing.
  const upgraded = createGitCapabilityStore({ cachePath, gitVersion: "git version 2.49.0" });
  const both = await Promise.all([
    upgraded.runWithFallback("merge-tree-write-tree", async () => "preferred", () => "fallback", isUnsupportedMergeTreeWriteTreeError),
    upgraded.runWithFallback("merge-tree-write-tree", async () => "preferred", () => "fallback", isUnsupportedMergeTreeWriteTreeError),
  ]);
  expect(both).toEqual(["preferred", "preferred"]);
  expect(JSON.parse(fs.readFileSync(cachePath, "utf-8"))).toEqual({
    gitVersion: "git version 2.49.0",
    capabilities: { "merge-tree-write-tree": true },
  });
});

test("an error that is not about the option propagates", async () => {
  const store = createGitCapabilityStore({ cachePath, gitVersion: "git version 2.49.0" });
  await expect(
    store.runWithFallback(
      "merge-tree-write-tree",
      async () => {
        throw new Error("fatal: not a git repository");
      },
      () => "fallback",
      isUnsupportedMergeTreeWriteTreeError,
    ),
  ).rejects.toThrow("not a git repository");
  expect(fs.existsSync(cachePath)).toBe(false);
});
