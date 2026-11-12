import { describe, expect, test } from "bun:test";
import {
  folderShortList,
  isScratchFolder,
  isUuidLikeFolder,
  looksPromptDerived,
  FOLDER_SHORT_LIST_SIZE,
  type FolderActivity,
} from "../railFolderFilter";

describe("scratch folder detection", () => {
  test("UUID and long-hex folders are scratch whatever their count", () => {
    expect(isUuidLikeFolder("a8c23c5c-46dd-4f1e-9a2b-3c4d5e6f7a8b")).toBe(true);
    expect(isUuidLikeFolder("a8c23c5c-46dd-4f1e-9a2b-3c4d5e6f7a8b-worktree")).toBe(true);
    expect(isUuidLikeFolder("0123456789abcdef0123")).toBe(true);
    expect(isScratchFolder("a8c23c5c-46dd-4f1e-9a2b-3c4d5e6f7a8b", 40)).toBe(true);
    expect(isUuidLikeFolder("littlebird")).toBe(false);
    expect(isUuidLikeFolder("cafe")).toBe(false);
  });

  test("prompt-named folders are scratch only while they held one session", () => {
    expect(looksPromptDerived("and-just-in-general-this-is")).toBe(true);
    expect(looksPromptDerived("yaml-create-a-github-file")).toBe(true);
    expect(isScratchFolder("yaml-create-a-github-file", 1)).toBe(true);
    expect(isScratchFolder("yaml-create-a-github-file", 3)).toBe(false);
    // Real repos: few words, or mixed case.
    expect(looksPromptDerived("codecast-impeccable")).toBe(false);
    expect(looksPromptDerived("my-Side-Project-Thing")).toBe(false);
    expect(isScratchFolder("codecast", 1)).toBe(false);
  });
});

describe("folderShortList", () => {
  const now = Date.now();
  const act = (recent: number, agoMs: number): FolderActivity => ({ recent, lastActive: now - agoMs });

  test("caps at five and leaves out UUID-named and one-off prompt folders", () => {
    const counts: Array<[string, number]> = [
      ["a8c23c5c-46dd-4f1e-9a2b-3c4d5e6f7a8b", 50],
      ["littlebird", 40],
      ["alexandergreen", 15],
      ["codecast", 12],
      ["and-just-in-general-this-is", 1],
      ["infra", 9],
      ["docs-site", 6],
      ["website", 4],
      ["yaml-create-a-github-file", 1],
    ];
    const activity: Record<string, FolderActivity> = Object.fromEntries(counts.map(([n, c]) => [n, act(c, 1000)]));
    const list = folderShortList(counts, activity);
    expect(list.length).toBe(FOLDER_SHORT_LIST_SIZE);
    expect(list).toEqual(["littlebird", "alexandergreen", "codecast", "infra", "docs-site"]);
    expect(list.some((n) => n.startsWith("a8c23c5c"))).toBe(false);
    expect(list).not.toContain("and-just-in-general-this-is");
  });

  test("ranks by sessions in the last 30 days, then by recency, over all-time count", () => {
    const counts: Array<[string, number]> = [["old-big", 90], ["fresh", 3], ["tied-older", 2], ["tied-newer", 2]];
    const list = folderShortList(counts, {
      "old-big": act(0, 90 * 864e5),
      fresh: act(3, 1000),
      "tied-older": act(2, 5 * 864e5),
      "tied-newer": act(2, 864e5),
    });
    // A folder with nothing in the window stays out while others qualify.
    expect(list).toEqual(["fresh", "tied-newer", "tied-older"]);
  });

  test("an account with nothing recent still gets its biggest folders", () => {
    const list = folderShortList([["a", 9], ["b", 3]], { a: act(0, 60 * 864e5), b: act(0, 50 * 864e5) });
    expect(list).toEqual(["b", "a"]);
    expect(folderShortList([["a", 9], ["b", 3]], undefined)).toEqual(["a", "b"]);
  });
});
