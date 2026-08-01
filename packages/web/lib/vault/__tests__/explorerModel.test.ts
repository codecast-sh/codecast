// The explorer's naming and ordering rules. These are the parts that decide
// what a file operation actually does to disk — a wrong target path renames the
// wrong file — so they're tested apart from the component that renders them.

import { test, expect, describe } from "bun:test";
import type { VaultFileEntry } from "@codecast/shared/contracts";
import {
  buildVaultTree,
  flattenTree,
  nextUntitledName,
  renameError,
  renameMoves,
  siblingNames,
  splitEntryName,
} from "../explorerModel";

/** `path: mtime` (a trailing "/" marks a directory) → the store's file table. */
const table = (spec: Record<string, number>): Record<string, VaultFileEntry> => {
  const files: Record<string, VaultFileEntry> = {};
  for (const [raw, mtime] of Object.entries(spec)) {
    const dir = raw.endsWith("/");
    const path = dir ? raw.slice(0, -1) : raw;
    files[path] = dir ? { path, mtime, size: 0, dir: true } : { path, mtime, size: 1 };
  }
  return files;
};

const order = (files: Record<string, VaultFileEntry>, mode: Parameters<typeof buildVaultTree>[1]) =>
  flattenTree(buildVaultTree(files, mode), {}).map((r) => r.node.path);

describe("sort order", () => {
  const files = table({ "notes/": 10, "Zed.md": 300, "apple.md": 100, "beta.md": 200 });

  test("folders come before files in every mode", () => {
    for (const mode of ["name-asc", "name-desc", "mtime-asc", "mtime-desc"] as const) {
      expect(order(files, mode)[0]).toBe("notes");
    }
  });

  test("name sorts are case-insensitive and reversible", () => {
    expect(order(files, "name-asc")).toEqual(["notes", "apple.md", "beta.md", "Zed.md"]);
    expect(order(files, "name-desc")).toEqual(["notes", "Zed.md", "beta.md", "apple.md"]);
  });

  test("modified sorts run newest-first and oldest-first", () => {
    expect(order(files, "mtime-desc")).toEqual(["notes", "Zed.md", "beta.md", "apple.md"]);
    expect(order(files, "mtime-asc")).toEqual(["notes", "apple.md", "beta.md", "Zed.md"]);
  });

  test("a folder sorts by the newest thing inside it, not its own mtime", () => {
    const nested = table({ "old/": 1, "old/fresh.md": 900, "new/": 500, "new/stale.md": 2 });
    const tree = buildVaultTree(nested, "mtime-desc");
    expect(tree.children.map((c) => c.path)).toEqual(["old", "new"]);
  });
});

describe("nextUntitledName", () => {
  test("the first free name has no number", () => {
    expect(nextUntitledName([], "Untitled", ".md")).toBe("Untitled.md");
  });

  test("counts up past every taken name", () => {
    expect(nextUntitledName(["Untitled.md", "Untitled 2.md"], "Untitled", ".md")).toBe("Untitled 3.md");
  });

  test("a gap is filled rather than skipped", () => {
    expect(nextUntitledName(["Untitled.md", "Untitled 3.md"], "Untitled", ".md")).toBe("Untitled 2.md");
  });

  test("collision is case-insensitive — the FS on macOS is too", () => {
    expect(nextUntitledName(["untitled.MD"], "Untitled", ".md")).toBe("Untitled 2.md");
  });

  test("folders take no extension", () => {
    expect(nextUntitledName(["New folder"], "New folder")).toBe("New folder 2");
  });
});

describe("siblingNames", () => {
  const paths = ["a.md", "notes", "notes/b.md", "notes/deep", "notes/deep/c.md"];

  test("the vault root sees only root entries", () => {
    expect(siblingNames(paths, "").sort()).toEqual(["a.md", "notes"]);
  });

  test("a folder sees its direct children, not its grandchildren", () => {
    expect(siblingNames(paths, "notes").sort()).toEqual(["b.md", "deep"]);
  });
});

describe("splitEntryName", () => {
  test("a note is edited by its stem and gets its extension back", () => {
    expect(splitEntryName("notes/Ideas.md", false)).toEqual({ stem: "Ideas", suffix: ".md" });
  });

  test("an asset is edited whole, so typing can't change what it is", () => {
    expect(splitEntryName("img/shot.png", false)).toEqual({ stem: "shot.png", suffix: "" });
  });

  test("a folder is edited whole even when it looks like a note", () => {
    expect(splitEntryName("weird.md", true)).toEqual({ stem: "weird.md", suffix: "" });
  });
});

describe("renameError", () => {
  const siblings = ["Ideas.md", "Archive"];

  test("accepts a free name", () => {
    expect(renameError("Plans", ".md", siblings, "Ideas.md")).toBeNull();
  });

  test("rejects empty and whitespace-only names", () => {
    expect(renameError("", ".md", siblings, "Ideas.md")).toBeTruthy();
    expect(renameError("   ", ".md", siblings, "Ideas.md")).toBeTruthy();
  });

  test("rejects a name that would carry the entry into another folder", () => {
    expect(renameError("sub/Plans", ".md", siblings, "Ideas.md")).toBeTruthy();
    expect(renameError("sub\\Plans", ".md", siblings, "Ideas.md")).toBeTruthy();
  });

  test("rejects names the daemon refuses to serve", () => {
    expect(renameError(".obsidian", "", siblings, "Archive")).toBeTruthy();
    expect(renameError("..", "", siblings, "Archive")).toBeTruthy();
  });

  test("rejects a name already taken here, whatever its case", () => {
    expect(renameError("ideas", ".md", siblings, "Archive")).toBeTruthy();
  });

  test("a case-only rename isn't a collision with itself", () => {
    expect(renameError("IDEAS", ".md", siblings, "Ideas.md")).toBeNull();
  });
});

describe("renameMoves", () => {
  const paths = ["notes", "notes/a.md", "notes/deep/b.md", "notesy.md", "other.md"];

  test("a folder carries its whole subtree, and only its subtree", () => {
    expect(renameMoves(paths, "notes", "journal")).toEqual([
      ["notes", "journal"],
      ["notes/a.md", "journal/a.md"],
      ["notes/deep/b.md", "journal/deep/b.md"],
    ]);
  });

  test("a file moves alone", () => {
    expect(renameMoves(paths, "other.md", "misc.md")).toEqual([["other.md", "misc.md"]]);
  });
});
