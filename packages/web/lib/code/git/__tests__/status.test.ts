import { describe, expect, it } from "bun:test";
import { explorerGitDecorations, foldStatus, NO_GIT_DECORATIONS } from "../status";

describe("explorer decorations", () => {
  it("colors files and rolls the strongest state up every folder", () => {
    const d = explorerGitDecorations({
      "src/app/main.ts": "modified",
      "src/app/new.ts": "untracked",
      "src/lib/x.ts": "added",
      "docs/old.md": "deleted",
      "README.md": "conflicted",
    });
    expect(d.files.get("src/app/main.ts")).toBe("modified");
    expect(d.files.get("README.md")).toBe("conflicted");
    expect(d.dirs.get("src/app")).toBe("modified");
    expect(d.dirs.get("src/lib")).toBe("added");
    expect(d.dirs.get("src")).toBe("modified");
    expect(d.dirs.get("docs")).toBe("deleted");
    // The vault root is the tree itself, not a row.
    expect(d.dirs.has("")).toBe(false);
    expect(d.deleted).toEqual(["docs/old.md"]);
  });

  it("marks a whole untracked folder", () => {
    const d = explorerGitDecorations({ "scratch/": "untracked" });
    expect(d.dirs.get("scratch")).toBe("untracked");
    expect(d.files.size).toBe(0);
  });

  it("reads vault-relative paths, so a vault inside a repo rolls up from its own root", () => {
    // The daemon strips the vault's prefix (packages/web/) before sending.
    const d = explorerGitDecorations({ "lib/a.ts": "modified", "b.ts": "untracked" });
    expect([...d.dirs.keys()]).toEqual(["lib"]);
    expect(d.files.get("b.ts")).toBe("untracked");
  });

  it("is the shared empty value for a clean tree", () => {
    expect(explorerGitDecorations({})).toBe(NO_GIT_DECORATIONS);
    expect(explorerGitDecorations(undefined)).toBe(NO_GIT_DECORATIONS);
  });
});

describe("foldStatus", () => {
  const res = { repo: true, branch: "main", head: "abc", ahead: 1, behind: 0, files: { "a.ts": "modified" as const } };

  it("keeps the previous object when nothing changed", () => {
    const first = foldStatus(undefined, res);
    expect(foldStatus(first, { ...res, files: { ...res.files } })).toBe(first);
  });

  it("keeps the file map when only the branch facts move", () => {
    const first = foldStatus(undefined, res);
    const next = foldStatus(first, { ...res, head: "def", files: { ...res.files } });
    expect(next).not.toBe(first);
    expect(next.files).toBe(first.files);
    expect(next.upstream).toBe(true);
  });

  it("knows a branch without an upstream", () => {
    expect(foldStatus(undefined, { repo: true, branch: "x", head: null, files: {} }).upstream).toBe(false);
  });
});
