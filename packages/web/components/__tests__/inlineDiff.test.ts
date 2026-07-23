import { describe, expect, test } from "bun:test";
import { parseCastDiff } from "../InlineDiff";

// Verbatim `git diff -U99999 main...branch` output: one new file + one modified
// file. Paths contain spaces, so git terminates the ---/+++ header paths with a
// trailing TAB — the parser must trim it. Full-context diffs arrive as a single
// hunk starting at line 1.
const FULL_CONTEXT_TWO_FILES = [
  "diff --git a/New note.md b/New note.md",
  "new file mode 100644",
  "index 0000000..21b48f4",
  "--- /dev/null",
  "+++ b/New note.md\t",
  "@@ -0,0 +1,3 @@",
  "+---",
  '+summary: "a new note"',
  "+---",
  "diff --git a/Tier-1 capital — humanoids only.md b/Tier-1 capital — humanoids only.md",
  "index 06743cb..0c2f463 100644",
  "--- a/Tier-1 capital — humanoids only.md\t",
  "+++ b/Tier-1 capital — humanoids only.md\t",
  "@@ -1,4 +1,6 @@",
  " Line one stays.",
  " Line two stays.",
  "-Line three goes.",
  "+Line three changed.",
  " Line four stays.",
  "+",
  "+Update: appended line.",
].join("\n");

describe("parseCastDiff", () => {
  test("splits a multi-file git diff into per-file sections", () => {
    const files = parseCastDiff(FULL_CONTEXT_TWO_FILES);
    expect(files.length).toBe(2);
    // Without the split, file 2's ---/+++ headers would leak into file 1's
    // hunk as phantom deletion/addition lines.
    expect(files[0].additions).toBe(3);
    expect(files[0].deletions).toBe(0);
  });

  test("trims the trailing tab git appends to paths containing spaces", () => {
    const files = parseCastDiff(FULL_CONTEXT_TWO_FILES);
    expect(files[0].path).toBe("New note.md");
    expect(files[1].path).toBe("Tier-1 capital — humanoids only.md");
  });

  test("classifies new files as added and never fullContext", () => {
    const [added, modified] = parseCastDiff(FULL_CONTEXT_TWO_FILES);
    expect(added.status).toBe("added");
    expect(added.fullContext).toBe(false);
    expect(modified.status).toBe("modified");
  });

  test("marks a single whole-file hunk as fullContext and reconstructs both sides", () => {
    const [, modified] = parseCastDiff(FULL_CONTEXT_TWO_FILES);
    expect(modified.fullContext).toBe(true);
    expect(modified.oldContent).toBe(
      ["Line one stays.", "Line two stays.", "Line three goes.", "Line four stays."].join("\n"),
    );
    expect(modified.newContent).toBe(
      ["Line one stays.", "Line two stays.", "Line three changed.", "Line four stays.", "", "Update: appended line."].join("\n"),
    );
    expect(modified.additions).toBe(3);
    expect(modified.deletions).toBe(1);
  });

  test("a plain -U3 diff with a mid-file hunk is not fullContext", () => {
    const partial = [
      "diff --git a/big.md b/big.md",
      "index 1111111..2222222 100644",
      "--- a/big.md",
      "+++ b/big.md",
      "@@ -40,7 +40,7 @@",
      " ctx",
      "-old",
      "+new",
      " ctx",
    ].join("\n");
    const files = parseCastDiff(partial);
    expect(files.length).toBe(1);
    expect(files[0].fullContext).toBe(false);
    expect(files[0].hunks[0].oldStart).toBe(40);
  });

  test("returns no sections for non-diff text", () => {
    expect(parseCastDiff("just some prose\nwith lines")).toEqual([]);
  });
});
