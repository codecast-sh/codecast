import { describe, test, expect } from "bun:test";
import type { VaultInfo } from "@codecast/shared/contracts";
import {
  groupVaultChoices,
  isProjectVault,
  shortenVaultRoot,
  vaultLandingPath,
} from "../projectVault";

function project(over: Partial<VaultInfo> = {}): VaultInfo {
  return {
    id: "p1",
    root: "/Users/ada/src/engine",
    name: "engine",
    added_at: 0,
    kind: "project",
    ...over,
  };
}

function vault(over: Partial<VaultInfo> = {}): VaultInfo {
  return { id: "v1", root: "/Users/ada/notes", name: "notes", added_at: 1, ...over };
}

describe("isProjectVault", () => {
  test("separates a discovered project from a registered folder", () => {
    expect(isProjectVault(project())).toBe(true);
    expect(isProjectVault(vault())).toBe(false);
    expect(isProjectVault(null)).toBe(false);
  });
});

describe("shortenVaultRoot", () => {
  test("collapses a home directory to ~ on both platform layouts", () => {
    expect(shortenVaultRoot("/Users/ada/src/engine")).toBe("~/src/engine");
    expect(shortenVaultRoot("/home/ada/src/engine")).toBe("~/src/engine");
    expect(shortenVaultRoot("/Users/ada")).toBe("~");
  });

  test("leaves a path outside any home directory alone", () => {
    expect(shortenVaultRoot("/opt/wiki")).toBe("/opt/wiki");
    // "/Users" alone is not somebody's home, and must not become "~".
    expect(shortenVaultRoot("/Usersomething/x")).toBe("/Usersomething/x");
  });
});

describe("vaultLandingPath", () => {
  const repo = ["README.md", "src/lib.ts", "docs/setup.md", "docs/index.md", "docs/api/auth.md"];

  test("prefers the home directory over the repo root", () => {
    // The whole point of the rule: a repo root is mostly source directories,
    // so docs/ wins even though a perfectly good README sits at the root.
    expect(vaultLandingPath(project({ home: "docs" }), repo)).toBe("docs/index.md");
  });

  test("index beats README, README beats the first note alphabetically", () => {
    expect(vaultLandingPath(project({ home: "docs" }), ["docs/index.md", "docs/README.md", "docs/a.md"]))
      .toBe("docs/index.md");
    expect(vaultLandingPath(project({ home: "docs" }), ["docs/README.md", "docs/a.md"]))
      .toBe("docs/README.md");
    expect(vaultLandingPath(project({ home: "docs" }), ["docs/b.md", "docs/a.md"]))
      .toBe("docs/a.md");
  });

  test("README matches whatever case the repo wrote it in", () => {
    expect(vaultLandingPath(project({ home: "docs" }), ["docs/z.md", "docs/readme.md"]))
      .toBe("docs/readme.md");
  });

  test("a note directly in the home directory beats one nested below it", () => {
    expect(vaultLandingPath(project({ home: "docs" }), ["docs/api/auth.md", "docs/zzz.md"]))
      .toBe("docs/zzz.md");
  });

  test("falls back to a nested note when the home directory has none of its own", () => {
    expect(vaultLandingPath(project({ home: "docs" }), ["docs/api/auth.md"])).toBe("docs/api/auth.md");
  });

  test("falls back to the root when the home directory turns out to be empty", () => {
    expect(vaultLandingPath(project({ home: "docs" }), ["README.md", "src/lib.ts"])).toBe("README.md");
  });

  test("a project with no home directory lands on the root README", () => {
    expect(vaultLandingPath(project(), ["notes.md", "README.md"])).toBe("README.md");
  });

  test("never lands anywhere when the project holds no markdown", () => {
    expect(vaultLandingPath(project({ home: "docs" }), ["src/lib.ts"])).toBeNull();
  });

  test("a registered vault gets no landing note at all", () => {
    // Opening straight into a note would change what `cast vault add` has
    // always done; only project vaults opt in.
    expect(vaultLandingPath(vault(), ["README.md", "index.md"])).toBeNull();
  });

  test("does not mistake a sibling directory for the home directory", () => {
    // "docs" must not match "docs-old/": the prefix test is on a path segment.
    expect(vaultLandingPath(project({ home: "docs" }), ["docs-old/a.md", "README.md"]))
      .toBe("README.md");
  });
});

describe("groupVaultChoices", () => {
  test("registered vaults, then projects, then mirrors", () => {
    const groups = groupVaultChoices(
      [project(), vault()],
      [{ id: "r1", name: "desk notes", note_count: 4 }],
    );
    expect(groups.map((g) => g.kind)).toEqual(["vault", "project", "remote"]);
    expect(groups[0].items.map((i) => i.name)).toEqual(["notes"]);
    expect(groups[1].items.map((i) => i.name)).toEqual(["engine"]);
    expect(groups[2].items[0].noteCount).toBe(4);
  });

  test("drops empty groups rather than showing a bare heading", () => {
    const groups = groupVaultChoices([project()], []);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe("project");
    expect(groups[0].label).toBe("Projects");
  });

  test("hides a remote mirror of a vault that is also here locally", () => {
    // Same files, and the local one is writable.
    const groups = groupVaultChoices([vault({ id: "same" })], [{ id: "same", name: "notes" }]);
    expect(groups.map((g) => g.kind)).toEqual(["vault"]);
  });

  test("carries the root through for local entries and omits it for a mirror", () => {
    const groups = groupVaultChoices([project()], [{ id: "r1", name: "desk" }]);
    expect(groups[0].items[0].root).toBe("/Users/ada/src/engine");
    expect(groups[1].items[0].root).toBeUndefined();
  });

  test("a discovered project reports no note count until it has been scanned", () => {
    const groups = groupVaultChoices([project()], []);
    expect(groups[0].items[0].noteCount).toBeUndefined();
    const scanned = groupVaultChoices([project({ note_count: 12 })], []);
    expect(scanned[0].items[0].noteCount).toBe(12);
  });
});
