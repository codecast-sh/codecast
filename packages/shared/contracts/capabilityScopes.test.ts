import { describe, expect, it } from "bun:test";
import {
  buildProjectScopeKey,
  compareScopeNarrowness,
  formatScopeString,
  normalizeGitOrigin,
  parseScopeString,
  SCOPE_KINDS,
  scopeKeyValidForTeam,
} from "./index";

describe("scope strings", () => {
  it("round-trips every kind, qualified and bare", () => {
    for (const value of ["user", "team", "device:76e7d3d6", "project:git:github.com/o/r", "session:jx7c6zk"]) {
      const parsed = parseScopeString(value);
      expect(parsed).not.toBeNull();
      expect(formatScopeString(parsed!)).toBe(value);
    }
  });

  it("rejects the shapes that would be silent misconfigurations", () => {
    // A device scope with no device, a user scope with a stray qualifier, an
    // unknown kind: each would bind to nothing while looking bound.
    for (const bad of ["device", "project", "session", "user:me", "team:t1", "global", "", "device:"]) {
      expect(parseScopeString(bad)).toBeNull();
    }
  });

  it("precedence is a total, deterministic order", () => {
    const sorted = [...SCOPE_KINDS].sort(compareScopeNarrowness);
    expect(sorted).toEqual(["session", "project", "device", "user", "team"]);
    // Total: no two kinds compare equal.
    for (const a of SCOPE_KINDS) for (const b of SCOPE_KINDS) {
      if (a !== b) expect(compareScopeNarrowness(a, b)).not.toBe(0);
    }
  });
});

describe("project scope keys", () => {
  it("ssh and https origins of one repo produce one key", () => {
    const forms = [
      "git@github.com:Owner/Repo.git",
      "ssh://git@github.com/Owner/Repo",
      "https://github.com/owner/repo.git",
      "https://user:tok@github.com/Owner/Repo/",
    ];
    const keys = new Set(forms.map((f) => buildProjectScopeKey({ originUrl: f })));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe("git:github.com/owner/repo");
  });

  it("a subpath rides after # and a local project is user-qualified", () => {
    expect(buildProjectScopeKey({ originUrl: "git@github.com:o/r.git", subpath: "/packages/web/" }))
      .toBe("git:github.com/o/r#packages/web");
    expect(buildProjectScopeKey({ path: "/Users/x/scratch", userId: "u_1" }))
      .toBe("local:u_1:/Users/x/scratch");
    // A path without a user is refused: a path means nothing without whose.
    expect(buildProjectScopeKey({ path: "/Users/x/scratch" })).toBeNull();
  });

  it("a local: key is never valid for a team binding", () => {
    expect(scopeKeyValidForTeam("local:u_1:/Users/x/api")).toBe(false);
    expect(scopeKeyValidForTeam("git:github.com/o/r")).toBe(true);
  });

  it("normalization refuses what it cannot honestly name", () => {
    expect(normalizeGitOrigin("")).toBeNull();
    expect(normalizeGitOrigin("not a url at all")).toBeNull();
  });
});
