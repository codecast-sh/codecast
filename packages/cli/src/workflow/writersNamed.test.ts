// Which writers of a checkout change a finding names (flows.md FL4), read from
// the output real tools print: git's rebase, tsc and bun's test runner.
import { describe, expect, test } from "bun:test";
import { writersNamed } from "./subjectStation";

const A = { conversation: "jx7aaaaaaaaaaaaaaaaaaaaaaaaaaaa1", session: "jx7aaaa" };
const B = { conversation: "jx7bbbbbbbbbbbbbbbbbbbbbbbbbbbb2", session: "jx7bbbb" };

const change = (writers: Record<string, typeof A>, more: string[] = []) => ({ paths: [...Object.keys(writers), ...more].sort(), writers });
const named = (c: ReturnType<typeof change>, text: string, roots: string[] = []) => {
  const r = writersNamed(c, text, roots);
  return { writers: Object.fromEntries(r.writers.map((w) => [w.shortId, w.files])), unclaimed: r.unclaimed };
};

describe("writersNamed", () => {
  test("a rebase conflict names the conflicting file, not every file git auto-merged", () => {
    const c = change({ "src/a.ts": A, "src/b.ts": B });
    const out = [
      "Auto-merging src/a.ts",
      "Auto-merging src/b.ts",
      "CONFLICT (content): Merge conflict in src/b.ts",
      "error: could not apply 1a2b3c4... feat(src): make b good",
      "hint: Resolve all conflicts manually, mark them as resolved with",
      'hint: "git add/rm <conflicted_files>", then run "git rebase --continue".',
    ].join("\n");
    expect(named(c, out)).toEqual({ writers: { jx7bbbb: ["src/b.ts"] }, unclaimed: [] });
  });

  test("bun names the failing test file, not the header of a file whose tests passed", () => {
    const c = change({ "src/a.test.ts": A, "src/b.test.ts": B });
    const out = [
      "bun test v1.3.14 (0d9b296a)",
      "",
      "src/a.test.ts:",
      "(pass) a > returns the expected error when asked [1.20ms]",
      "(pass) a > works [0.40ms]",
      "",
      "src/b.test.ts:",
      "  7 | test(\"breaks\", () => {",
      "  8 |   expect(b()).toBe(2);",
      "                   ^",
      "error: expect(received).toBe(expected)",
      "",
      "Expected: 2",
      "Received: 1",
      "",
      "      at <anonymous> (/repo/.codecast/worktrees/change-ct-9/src/b.test.ts:8:15)",
      "(fail) b > breaks [3.00ms]",
      "",
      " 2 pass",
      " 1 fail",
      "Ran 3 tests across 2 files. [40.00ms]",
    ].join("\n");
    expect(named(c, out, ["/repo", "/repo/.codecast/worktrees/change-ct-9"])).toEqual({ writers: { jx7bbbb: ["src/b.test.ts"] }, unclaimed: [] });
  });

  test("a stack frame under the run's worktree names the file once that root is read off", () => {
    const c = change({ "src/b.ts": B });
    const out = "error: b is not a function\n      at run (/repo/.codecast/worktrees/change-ct-9/src/b.ts:3:9)";
    expect(named(c, out, ["/repo/.codecast/worktrees/change-ct-9"]).writers).toEqual({ jx7bbbb: ["src/b.ts"] });
    // Without it, an absolute path is some other tree's file, never the tail match it would otherwise be.
    expect(named(c, out).writers).toEqual({});
  });

  test("tsc names a file by its path, never as the tail of a longer path", () => {
    const c = change({ "src/a.ts": A, "src/b.ts": B });
    const out = [
      "src/a.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
      "packages/web/src/b.ts(3,1): error TS2304: Cannot find name 'x'.",
    ].join("\n");
    expect(named(c, out)).toEqual({ writers: { jx7aaaa: ["src/a.ts"] }, unclaimed: [] });
  });

  test("a basename names its file standing alone or as a location, never inside another package's path", () => {
    const c = change({ "src/index.ts": A, "src/b.ts": B });
    expect(named(c, "error: Cannot find module './gone' from node_modules/x/index.ts").writers).toEqual({});
    expect(named(c, "error: Cannot find module './gone' from node_modules\\x\\index.ts").writers).toEqual({});
    expect(named(c, "error: boom\n    at load (index.ts:3:9)").writers).toEqual({ jx7aaaa: ["src/index.ts"] });
    expect(named(c, "index.ts(4,2): error TS1005: ';' expected.").writers).toEqual({ jx7aaaa: ["src/index.ts"] });
    expect(named(c, "error: index.ts is not formatted").writers).toEqual({ jx7aaaa: ["src/index.ts"] });
    // b.ts in b.tsx, data.b.ts or b.ts.map is not b.ts.
    expect(named(c, "error: src/b.tsx and lib/data.b.ts and b.ts.map are wrong").writers).toEqual({});
  });

  test("lines that say something failed outweigh files a tool merely lists", () => {
    const c = change({ "src/a.ts": A, "src/b.ts": B });
    const out = [
      "Checking 2 projects",
      "  src/a.ts",
      "  src/b.ts",
      "cli: 214 files",
      "web: 1,022 files",
      "mobile: 640 files",
      "convex: 310 files",
      "evals: 18 files",
      "sim: 4 files",
      "",
      "src/b.ts(1,8): error TS1005: ',' expected.",
      "✗ cli: 1 error",
    ].join("\n");
    expect(named(c, out).writers).toEqual({ jx7bbbb: ["src/b.ts"] });
  });

  test("a finding with no failing line is read whole: a reviewer's note names its files", () => {
    const c = change({ "src/a.ts": A, "src/b.ts": B });
    expect(named(c, "src/a.ts: the new branch drops the retry the old one had.").writers).toEqual({ jx7aaaa: ["src/a.ts"] });
  });

  test("a named file no session wrote is unclaimed", () => {
    const c = change({ "src/a.ts": A }, ["notes.txt"]);
    expect(named(c, "error: notes.txt is not good\nerror: src/a.ts is not good")).toEqual({ writers: { jx7aaaa: ["src/a.ts"] }, unclaimed: ["notes.txt"] });
  });
});

// Paths as a tool run inside one package of the repo prints them, and the boundaries between one file's results and the next.
describe("writersNamed in a repo of packages", () => {
  const R = { conversation: "jx7rrrrrrrrrrrrrrrrrrrrrrrrrrrr3", session: "jx7rrrr" };
  const c = change({ "packages/cli/src/land/checkoutReport.test.ts": A, "packages/cli/src/workflow/runner.ts": B, "packages/web/lib/foo.ts": R });

  test("cast check's tsc lines, relative to the package, name the file by its one tail", () => {
    // Captured from `cast check cli` in this repo.
    const out = [
      "src/land/checkoutReport.test.ts(192,31): error TS2345: Argument of type '{ now: number; post: (p: string, b: any) => Promise<{}>; }' is not assignable to parameter of type '{ post: Post; sendBrief: SendBrief; }'.",
      "  Property 'sendBrief' is missing in type '{ now: number; post: (p: string, b: any) => Promise<{}>; }' but required in type '{ post: Post; sendBrief: SendBrief; }'.",
      "✗ cli: 1 error (pass 8s old, watcher started by this call)",
    ].join("\n");
    expect(named(c, out)).toEqual({ writers: { jx7aaaa: ["packages/cli/src/land/checkoutReport.test.ts"] }, unclaimed: [] });
    // tsc's pretty form.
    expect(named(c, "src/workflow/runner.ts:12:5 - error TS2322: Type 'string' is not assignable to type 'number'.").writers).toEqual({ jx7bbbb: ["packages/cli/src/workflow/runner.ts"] });
  });

  test("a tail two files of the change end with names neither", () => {
    const two = change({ "packages/cli/src/index.ts": A, "packages/web/src/index.ts": B });
    expect(named(two, "src/index.ts(1,1): error TS1005: ';' expected.").writers).toEqual({});
    expect(named(two, "cli/src/index.ts(1,1): error TS1005: ';' expected.").writers).toEqual({ jx7aaaa: ["packages/cli/src/index.ts"] });
  });

  test("bun run in a package names the failing files and not the one that passed", () => {
    const t = change({ "packages/cli/src/a.test.ts": A, "packages/cli/src/b.test.ts": B, "packages/cli/src/c.test.ts": R });
    // Captured from `bun test ./src` inside a package, not on a terminal: b.test.ts passed and prints nothing.
    const out = [
      "bun test v1.3.14 (0d9b296a)",
      "",
      "src/c.test.ts:",
      "1 | import { expect, test } from \"bun:test\";",
      "2 | test(\"c breaks\", () => { expect(\"x\").toBe(\"y\"); });",
      "                                         ^",
      "error: expect(received).toBe(expected)",
      "",
      "Expected: \"y\"",
      "Received: \"x\"",
      "",
      "      at <anonymous> (/repo/packages/cli/src/c.test.ts:2:38)",
      "(fail) c breaks [0.15ms]",
      "",
      "src/a.test.ts:",
      "1 | import { expect, test } from \"bun:test\";",
      "2 | test(\"a works\", () => { expect(1 + 1).toBe(3); });",
      "                                          ^",
      "error: expect(received).toBe(expected)",
      "",
      "Expected: 3",
      "Received: 2",
      "",
      "      at <anonymous> (/repo/packages/cli/src/a.test.ts:2:39)",
      "(fail) a works [0.07ms]",
      "",
      " 2 pass",
      " 2 fail",
      " 4 expect() calls",
      "Ran 4 tests across 3 files. [24.00ms]",
    ].join("\n");
    expect(named(t, out, ["/repo"])).toEqual({ writers: { jx7rrrr: ["packages/cli/src/c.test.ts"], jx7aaaa: ["packages/cli/src/a.test.ts"] }, unclaimed: [] });
  });

  test("bun's closing recap is its own section: the last passing file's header stays unnamed", () => {
    const t = change({ "packages/cli/src/a.test.ts": A, "packages/cli/src/b.test.ts": B });
    const out = [
      "packages/cli/src/a.test.ts:",
      "error: expect(received).toBe(expected)",
      "      at /repo/packages/cli/src/a.test.ts:5:3",
      "(fail) a > works [0.3ms]",
      "",
      "packages/cli/src/b.test.ts:",
      "(pass) b > ok [0.1ms]",
      "",
      "1 tests failed:",
      "(fail) a > works [0.3ms]",
      "",
      " 1 pass",
      " 1 fail",
    ].join("\n");
    expect(named(t, out, ["/repo"]).writers).toEqual({ jx7aaaa: ["packages/cli/src/a.test.ts"] });
  });

  test("eslint: a file with only warnings is not named by the next file's error", () => {
    const t = change({ "packages/cli/src/a.ts": A, "packages/cli/src/b.test.ts": B });
    const out = [
      "/repo/packages/cli/src/a.ts",
      "  3:1  warning  Unexpected console statement  no-console",
      "",
      "/repo/packages/cli/src/b.test.ts",
      "  4:7  error  'y' is assigned a value but never used  @typescript-eslint/no-unused-vars",
      "",
      "✖ 2 problems (1 error, 1 warning)",
    ].join("\n");
    expect(named(t, out, ["/repo"]).writers).toEqual({ jx7bbbb: ["packages/cli/src/b.test.ts"] });
  });

  test("a passed test whose name holds a file's name names nothing", () => {
    expect(named(c, "(pass) runner.ts does x\nerror: something in other.ts").writers).toEqual({});
  });
});
