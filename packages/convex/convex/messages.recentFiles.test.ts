import { describe, expect, test } from "bun:test";
import { mergeRecentFiles } from "./messages";

const edit = (filePath: string, changeType = "edit") => ({ filePath, changeType });

describe("mergeRecentFiles", () => {
  test("newest edit ranks first; existing entries follow, deduped", () => {
    const next = mergeRecentFiles(["/repo/a.ts", "/repo/b.ts"], [edit("/repo/b.ts"), edit("/repo/c.ts")]);
    // c.ts was the message's LAST edit → newest overall; b.ts moves up; a.ts keeps its slot.
    expect(next).toEqual(["/repo/c.ts", "/repo/b.ts", "/repo/a.ts"]);
  });

  test("caps at 8 and drops the oldest", () => {
    const existing = Array.from({ length: 8 }, (_, i) => `/repo/old${i}.ts`);
    const next = mergeRecentFiles(existing, [edit("/repo/new.ts")]);
    expect(next).toHaveLength(8);
    expect(next![0]).toBe("/repo/new.ts");
    expect(next).not.toContain("/repo/old7.ts");
  });

  test("returns null when nothing changes", () => {
    expect(mergeRecentFiles(["/repo/a.ts"], [edit("/repo/a.ts")])).toBeNull();
    expect(mergeRecentFiles(["/repo/a.ts"], [])).toBeNull();
  });

  test("ignores commit pseudo-changes and blank paths", () => {
    expect(mergeRecentFiles(undefined, [edit("", "write"), edit("/repo/x.ts", "commit")])).toBeNull();
    const next = mergeRecentFiles(undefined, [edit("/repo/x.ts", "commit"), edit("/repo/y.ts", "write")]);
    expect(next).toEqual(["/repo/y.ts"]);
  });

  test("worktree paths survive verbatim — they are the location signal", () => {
    const wt = "/Users/x/src/app/.codecast/worktrees/fix-auth/src/db/schema.ts";
    expect(mergeRecentFiles(undefined, [edit(wt)])).toEqual([wt]);
  });
});
