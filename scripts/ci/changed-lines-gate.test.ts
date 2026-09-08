// The gate's whole promise is which findings it drops: legacy debt never
// blocks, new debt always does. That promise lives in the diff parser and the
// overlap filter, so both are pure and tested here against the diff shapes that
// break naive versions — renames, deletions, findings on context lines and
// files with several hunks (ct-49564).
import { describe, expect, test } from "bun:test";

import {
  isAddedLine,
  parseAddedLines,
  parseEslintFindings,
  parseTscFindings,
  resolveDiffBase,
  selectNewFindings,
  CHECKS,
  type Finding,
} from "./changed-lines-gate";

const finding = (file: string | null, line: number): Finding => ({
  file,
  line,
  code: "rule",
  message: "m",
});

describe("parseAddedLines", () => {
  test("reads the post-image side of each hunk", () => {
    const diff = [
      "diff --git a/packages/web/a.ts b/packages/web/a.ts",
      "--- a/packages/web/a.ts",
      "+++ b/packages/web/a.ts",
      "@@ -10,0 +11,2 @@",
      "+one",
      "+two",
    ].join("\n");
    expect(parseAddedLines(diff).get("packages/web/a.ts")).toEqual([{ start: 11, end: 12 }]);
  });

  test("a hunk header without a count covers exactly one line", () => {
    const diff = ["--- a/a.ts", "+++ b/a.ts", "@@ -4 +4 @@", "-old", "+new"].join("\n");
    expect(parseAddedLines(diff).get("a.ts")).toEqual([{ start: 4, end: 4 }]);
  });

  test("keeps every hunk of a multi-hunk file", () => {
    const diff = [
      "--- a/packages/cli/src/x.ts",
      "+++ b/packages/cli/src/x.ts",
      "@@ -3,0 +4,1 @@",
      "+first",
      "@@ -40,2 +41,3 @@ function tail()",
      "+a",
      "+b",
      "+c",
    ].join("\n");
    expect(parseAddedLines(diff).get("packages/cli/src/x.ts")).toEqual([
      { start: 4, end: 4 },
      { start: 41, end: 43 },
    ]);
  });

  test("a deletion-only hunk adds nothing", () => {
    const diff = ["--- a/a.ts", "+++ b/a.ts", "@@ -8,3 +7,0 @@", "-gone", "-gone", "-gone"].join(
      "\n",
    );
    expect(parseAddedLines(diff).has("a.ts")).toBe(false);
  });

  test("a deleted file has no post-image to blame", () => {
    const diff = [
      "diff --git a/old.ts b/old.ts",
      "deleted file mode 100644",
      "--- a/old.ts",
      "+++ /dev/null",
      "@@ -1,3 +0,0 @@",
      "-a",
      "-b",
      "-c",
    ].join("\n");
    expect(parseAddedLines(diff).size).toBe(0);
  });

  test("a pure rename adds no lines, and an edited rename adds only the edit", () => {
    const diff = [
      "diff --git a/src/old.ts b/src/moved.ts",
      "similarity index 100%",
      "rename from src/old.ts",
      "rename to src/moved.ts",
      "diff --git a/src/second.ts b/src/renamed.ts",
      "similarity index 94%",
      "rename from src/second.ts",
      "rename to src/renamed.ts",
      "--- a/src/second.ts",
      "+++ b/src/renamed.ts",
      "@@ -12,0 +13,1 @@",
      "+touched",
    ].join("\n");
    const added = parseAddedLines(diff);
    // The 100% rename never reaches a `+++` line, so it cannot be reported.
    expect(added.has("src/moved.ts")).toBe(false);
    expect(added.has("src/old.ts")).toBe(false);
    // The edited rename is keyed by its NEW path, which is where a checker
    // reports the finding.
    expect([...added.keys()]).toEqual(["src/renamed.ts"]);
    expect(added.get("src/renamed.ts")).toEqual([{ start: 13, end: 13 }]);
  });

  test("reads a path with a space, which git terminates with a tab", () => {
    const diff = ["--- /dev/null", "+++ b/packages/web/a b.ts\t", "@@ -0,0 +1,1 @@", "+x"].join("\n");
    expect([...parseAddedLines(diff).keys()]).toEqual(["packages/web/a b.ts"]);
  });

  test("unquotes a path git C-quoted", () => {
    const diff = ['+++ "b/packages/web/a\\tb.ts"', "@@ -0,0 +1,1 @@", "+x"].join("\n");
    expect([...parseAddedLines(diff).keys()]).toEqual(["packages/web/a\tb.ts"]);
  });
});

describe("isAddedLine", () => {
  const ranges = [
    { start: 10, end: 12 },
    { start: 40, end: 40 },
  ];

  test("inside a range, and at either edge of one", () => {
    expect(isAddedLine(10, ranges)).toBe(true);
    expect(isAddedLine(11, ranges)).toBe(true);
    expect(isAddedLine(12, ranges)).toBe(true);
    expect(isAddedLine(40, ranges)).toBe(true);
  });

  test("a context line is not added", () => {
    // Lines 9 and 13 are the untouched lines either side of the hunk: the exact
    // case that must stay green, or every edit inherits its neighbours' debt.
    expect(isAddedLine(9, ranges)).toBe(false);
    expect(isAddedLine(13, ranges)).toBe(false);
    expect(isAddedLine(39, ranges)).toBe(false);
  });

  test("no added lines means no line is added", () => {
    expect(isAddedLine(5, [])).toBe(false);
  });
});

describe("selectNewFindings", () => {
  const added: Map<string, Array<{ start: number; end: number }>> = new Map([
    ["packages/web/a.tsx", [{ start: 20, end: 22 }]],
  ]);

  test("keeps a finding on an added line and drops one on untouched code", () => {
    expect(selectNewFindings([finding("packages/web/a.tsx", 21)], added)).toHaveLength(1);
    expect(selectNewFindings([finding("packages/web/a.tsx", 19)], added)).toHaveLength(0);
  });

  test("drops every finding in a file the change never touched", () => {
    expect(selectNewFindings([finding("packages/web/other.tsx", 21)], added)).toHaveLength(0);
  });

  test("keeps a finding with no file — no line can excuse it", () => {
    expect(selectNewFindings([finding(null, 1)], added)).toHaveLength(1);
  });

  test("a finding anchored above the hunk stays out, even though it spans into it", () => {
    // The legacy `useEffect` case: its call expression reaches over the added
    // line, but it starts on untouched code, so it is not this change's debt.
    expect(selectNewFindings([finding("packages/web/a.tsx", 18)], added)).toHaveLength(0);
  });
});

describe("parseEslintFindings", () => {
  const cwd = `${import.meta.dir}/../../packages/web`;

  test("keeps errors, drops warnings, and carries the rule id", () => {
    const stdout = JSON.stringify([
      {
        filePath: `${cwd}/components/A.tsx`,
        messages: [
          // endLine reaches past the construct; the gate anchors on `line`.
          { severity: 2, ruleId: "no-restricted-syntax", message: "no useEffect", line: 12, endLine: 40 },
          { severity: 1, ruleId: "no-unused-vars", message: "unused", line: 3 },
        ],
      },
    ]);
    expect(parseEslintFindings(stdout, cwd)).toEqual([
      {
        file: "packages/web/components/A.tsx",
        line: 12,
        code: "no-restricted-syntax",
        message: "no useEffect",
      },
    ]);
  });

  test("a parse error with no location reports as unattributable", () => {
    const stdout = JSON.stringify([
      {
        filePath: `${cwd}/components/B.tsx`,
        messages: [{ severity: 2, ruleId: null, message: "Parsing error", fatal: true }],
      },
    ]);
    expect(parseEslintFindings(stdout, cwd)[0]!.file).toBeNull();
  });
});

describe("parseTscFindings", () => {
  const cwd = `${import.meta.dir}/../../packages/cli`;

  test("reads located diagnostics and ignores their continuation lines", () => {
    const stdout = [
      "src/daemon.ts(1420,7): error TS2345: Argument of type 'X' is not assignable.",
      "  Type 'X' is missing the following properties from type 'Y'",
      "src/index.ts(9,1): error TS2304: Cannot find name 'foo'.",
    ].join("\n");
    expect(parseTscFindings(stdout, cwd)).toEqual([
      {
        file: "packages/cli/src/daemon.ts",
        line: 1420,
        code: "TS2345",
        message: "Argument of type 'X' is not assignable.",
      },
      {
        file: "packages/cli/src/index.ts",
        line: 9,
        code: "TS2304",
        message: "Cannot find name 'foo'.",
      },
    ]);
  });

  test("a whole-program error has no file, so it always blocks", () => {
    const found = parseTscFindings("error TS2688: Cannot find type definition file for 'bun'.", cwd);
    expect(found).toHaveLength(1);
    expect(found[0]!.file).toBeNull();
  });
});

describe("resolveDiffBase", () => {
  const refs = (known: string[]) => ({
    exists: (ref: string) => known.includes(ref),
    mergeBase: (base: string, head: string) => `mb(${base},${head})`,
  });

  test("a pull request measures from its base against the checked-out tree", () => {
    // Never against `head.sha`: the checkers read the tree on disk, so the diff
    // has to be numbered against that tree and no other.
    expect(resolveDiffBase({ BASE_SHA: "base1", HEAD_SHA: "head1" }, refs(["base1", "head1"]))).toBe(
      "mb(base1,HEAD)",
    );
  });

  test("outside a pull request it falls back to origin/main", () => {
    expect(resolveDiffBase({}, refs(["origin/main"]))).toBe("mb(origin/main,HEAD)");
    expect(resolveDiffBase({ CHANGED_LINES_BASE: "v1" }, refs(["v1", "origin/main"]))).toBe(
      "mb(v1,HEAD)",
    );
  });

  test("a base sha that is not in the checkout is an error, never a pass", () => {
    // Fail closed: a shallow clone that lost the base would otherwise report an
    // empty diff and wave every finding through.
    expect(() => resolveDiffBase({ BASE_SHA: "missing" }, refs([]))).toThrow("BASE_SHA missing");
  });

  test("a push build with nothing to diff against gates nothing", () => {
    expect(resolveDiffBase({ GITHUB_EVENT_NAME: "push" }, refs([]))).toBeNull();
  });

  test("a local run with no base says so instead of passing", () => {
    expect(() => resolveDiffBase({}, refs([]))).toThrow("No diff base");
  });
});

describe("checks", () => {
  test("each check has a unique id and a package scope that exists", () => {
    expect(CHECKS.map((check) => check.id)).toEqual(["eslint-web", "tsc-cli", "tsc-convex"]);
    for (const check of CHECKS) {
      expect(check.scope.endsWith("/"), `${check.id} scope is a directory prefix`).toBe(true);
    }
  });
});
