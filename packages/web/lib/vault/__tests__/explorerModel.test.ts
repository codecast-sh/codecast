import { describe, test, expect } from "bun:test";
import type { VaultFileEntry } from "@codecast/shared/contracts";
import { buildVaultTree, visibleVaultFiles } from "../explorerModel";

function table(entries: VaultFileEntry[]): Record<string, VaultFileEntry> {
  const out: Record<string, VaultFileEntry> = {};
  for (const e of entries) out[e.path] = e;
  return out;
}

describe("buildVaultTree with ignored entries", () => {
  const files = table([
    { path: "docs", mtime: 1, size: 0, dir: true },
    { path: "docs/guide.md", mtime: 2, size: 5 },
    { path: "dist", mtime: 3, size: 0, dir: true, ignored: true },
    { path: "dist/bundle.md", mtime: 4, size: 9, ignored: true },
    { path: "dist/app.js", mtime: 5, size: 9, ignored: true },
  ]);

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
