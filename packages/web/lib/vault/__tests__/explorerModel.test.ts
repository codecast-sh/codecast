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
  visibleVaultFiles,
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

describe("visibleVaultFiles", () => {
  const mixed = table({
    "docs/": 1,
    "docs/guide.md": 2,
    "docs/diagram.png": 3,
    "src/": 4,
    "src/index.ts": 5,
    "bun.lock": 6,
    "empty/": 7,
  });

  test("show-all hands back the table untouched, with no copy", () => {
    // Identity matters: the explorer memoizes on this value, and a fresh object
    // every render would rebuild the tree on every watcher heartbeat.
    expect(visibleVaultFiles(mixed, true)).toBe(mixed);
  });

  test("off, it keeps notes and their attachments and drops the rest", () => {
    const visible = visibleVaultFiles(mixed, false);
    expect(Object.keys(visible).sort()).toEqual([
      "docs", "docs/diagram.png", "docs/guide.md", "empty", "src",
    ]);
    expect(visible["src/index.ts"]).toBeUndefined();
    expect(visible["bun.lock"]).toBeUndefined();
  });

  test("every directory survives the filter, including empty ones", () => {
    // Pruning empty folders would make "New folder" look like it silently
    // failed — a fresh folder is empty by definition. src/ stays for the same
    // reason even though everything inside it is hidden.
    const visible = visibleVaultFiles(mixed, false);
    expect(visible["empty"]?.dir).toBe(true);
    expect(visible["src"]?.dir).toBe(true);
  });

  test("the toggle only changes what is listed, never what a row means", () => {
    const shown = Object.keys(visibleVaultFiles(mixed, true));
    const hidden = Object.keys(visibleVaultFiles(mixed, false));
    expect(hidden.every((p) => shown.includes(p))).toBe(true);
  });
});

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

describe("ignored entries (show ignored files)", () => {
  // The daemon flags what the repo rules hide when asked to list it; the tree
  // must carry that through without letting it count as notes.
  const files: Record<string, VaultFileEntry> = {
    docs: { path: "docs", mtime: 1, size: 0, dir: true },
    "docs/guide.md": { path: "docs/guide.md", mtime: 2, size: 5 },
    dist: { path: "dist", mtime: 3, size: 0, dir: true, ignored: true },
    "dist/bundle.md": { path: "dist/bundle.md", mtime: 4, size: 9, ignored: true },
    "dist/app.js": { path: "dist/app.js", mtime: 5, size: 9, ignored: true },
  };

  test("the flag travels onto the node, folders included", () => {
    const root = buildVaultTree(files);
    const dist = root.children.find((n) => n.path === "dist");
    const docs = root.children.find((n) => n.path === "docs");
    expect(dist?.ignored).toBe(true);
    expect(dist?.children.every((c) => c.ignored)).toBe(true);
    expect(docs?.ignored).toBeUndefined();
    expect(docs?.children[0]?.ignored).toBeUndefined();
  });

  test("an ignored .md is not a note in the folder counts", () => {
    const root = buildVaultTree(files);
    expect(root.children.find((n) => n.path === "docs")?.noteCount).toBe(1);
    expect(root.children.find((n) => n.path === "dist")?.noteCount).toBe(0);
    expect(root.noteCount).toBe(1);
  });

  test("notes-only view still lists an ignored note when the scan supplied it", () => {
    const visible = visibleVaultFiles(files, false);
    expect(Object.keys(visible).sort()).toEqual(["dist", "dist/bundle.md", "docs", "docs/guide.md"]);
  });
});
