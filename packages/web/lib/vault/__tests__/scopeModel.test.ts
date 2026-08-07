import { describe, test, expect } from "bun:test";
import {
  PRESENCE_LABELS,
  deriveTeamForRoot,
  describeVaultScope,
  findDocForFile,
  teamScopeLabel,
  teamScopeWords,
  vaultPresence,
  type ScopeEvidence,
  type VaultTeamScope,
} from "../scopeModel";

const TEAMS = { t1: "Acme", t2: "Widgets" };

function session(path: string, over: Partial<ScopeEvidence> = {}): ScopeEvidence {
  return { path, teamId: null, isPrivate: true, ...over };
}

const shared = (path: string, teamId: string, weight = 1) =>
  session(path, { teamId, isPrivate: false, weight });
const privately = (path: string, teamId: string | null = null, weight = 1) =>
  session(path, { teamId, isPrivate: true, weight });

describe("deriveTeamForRoot", () => {
  test("no evidence is personal — an unsynced folder really is", () => {
    expect(deriveTeamForRoot("/Users/ada/notes", [], TEAMS)).toEqual({ kind: "personal" });
  });

  test("a shared directory names its team", () => {
    expect(deriveTeamForRoot("/w/api", [shared("/w/api", "t1")], TEAMS)).toEqual({
      kind: "team",
      teamId: "t1",
      teamName: "Acme",
      shared: true,
    });
  });

  test("a team that routes but does not auto-share is not shared", () => {
    const scope = deriveTeamForRoot("/w/api", [privately("/w/api", "t1")], TEAMS);
    expect(scope).toMatchObject({ kind: "team", teamName: "Acme", shared: false });
  });

  test("sessions carrying no team leave the scope personal", () => {
    expect(deriveTeamForRoot("/w/api", [privately("/w/api")], TEAMS)).toEqual({ kind: "personal" });
  });

  // The rule that matters: a mapping deeper in the tree governs its own subtree,
  // not the root. Only the shallowest evidence speaks for the root.
  test("a deeper session does not speak for the root", () => {
    const evidence = [privately("/w/api", "t1"), shared("/w/api/vendor/docs", "t2")];
    expect(deriveTeamForRoot("/w/api", evidence, TEAMS)).toMatchObject({
      teamName: "Acme",
      shared: false,
    });
  });

  test("but deeper evidence is used when there is nothing closer", () => {
    const evidence = [shared("/w/api/services/auth", "t2")];
    expect(deriveTeamForRoot("/w/api", evidence, TEAMS)).toMatchObject({
      teamName: "Widgets",
      shared: true,
    });
  });

  // Closeness is directory depth, not string length: /w/api/a/b sits deeper
  // than /w/api/vendor even though it is the shorter path.
  test("a shallower directory wins even when its path is the longer string", () => {
    const evidence = [shared("/w/api/a/b", "t2"), privately("/w/api/vendor", "t1")];
    expect(deriveTeamForRoot("/w/api", evidence, TEAMS)).toMatchObject({
      teamName: "Acme",
      shared: false,
    });
  });

  test("a sibling directory sharing a name prefix is not evidence", () => {
    const evidence = [shared("/w/api-gateway", "t1")];
    expect(deriveTeamForRoot("/w/api", evidence, TEAMS)).toEqual({ kind: "personal" });
  });

  test("trailing slashes do not break the exact match", () => {
    expect(deriveTeamForRoot("/w/api/", [shared("/w/api", "t1")], TEAMS)).toMatchObject({
      teamName: "Acme",
    });
    expect(deriveTeamForRoot("/w/api", [shared("/w/api/", "t1")], TEAMS)).toMatchObject({
      teamName: "Acme",
    });
  });

  test("one hand-shared session does not relabel a private folder as shared", () => {
    const evidence = [privately("/w/api", "t1", 9), shared("/w/api", "t1", 1)];
    expect(deriveTeamForRoot("/w/api", evidence, TEAMS)).toMatchObject({ shared: false });
  });

  test("weights aggregate, so a deduped cohort votes the same as a flat one", () => {
    const flat = [shared("/w/api", "t1"), shared("/w/api", "t1"), privately("/w/api", "t1")];
    const weighted = [shared("/w/api", "t1", 2), privately("/w/api", "t1", 1)];
    expect(deriveTeamForRoot("/w/api", flat, TEAMS)).toEqual(
      deriveTeamForRoot("/w/api", weighted, TEAMS),
    );
  });

  test("an even split counts as shared — the sharing fact is the one worth stating", () => {
    const evidence = [shared("/w/api", "t1"), privately("/w/api", "t1")];
    expect(deriveTeamForRoot("/w/api", evidence, TEAMS)).toMatchObject({ shared: true });
  });

  test("a team missing from the roster is still reported as a team", () => {
    expect(deriveTeamForRoot("/w/api", [shared("/w/api", "t9")], TEAMS)).toMatchObject({
      kind: "team",
      teamId: "t9",
      teamName: "your team",
    });
  });

  test("sessions with no path are ignored", () => {
    expect(deriveTeamForRoot("/w/api", [shared("", "t1")], TEAMS)).toEqual({ kind: "personal" });
  });
});

describe("vaultPresence", () => {
  test("local, mirrored and remote are three distinct answers", () => {
    expect(vaultPresence({ remote: false })).toBe("this-machine");
    expect(vaultPresence({ remote: false, mirror: true })).toBe("both");
    expect(vaultPresence({ remote: true })).toBe("other-machine");
  });

  test("a remote scope is elsewhere even though it is mirrored", () => {
    expect(vaultPresence({ remote: true, mirror: true })).toBe("other-machine");
  });

  test("every presence has a badge label", () => {
    expect(Object.values(PRESENCE_LABELS).every((l) => l.length > 0)).toBe(true);
  });
});

describe("wording", () => {
  const team: VaultTeamScope = { kind: "team", teamId: "t1", teamName: "Acme", shared: true };
  const routed: VaultTeamScope = { ...team, shared: false };

  test("the label is the team name, or Personal", () => {
    expect(teamScopeLabel(team)).toBe("Acme");
    expect(teamScopeLabel({ kind: "personal" })).toBe("Personal");
  });

  test("the words separate sharing from merely being filed under a team", () => {
    expect(teamScopeWords(team)).toBe("shared with Acme");
    expect(teamScopeWords(routed)).toBe("private, filed under Acme");
    expect(teamScopeWords({ kind: "personal" })).toBe("personal");
  });

  // The clause shares a 180px rail with the directory path, so it has to stay
  // short enough to survive there — that is why it is one clause, not a lesson.
  test("the words stay short enough for a narrow rail", () => {
    for (const scope of [team, routed, { kind: "personal" } as const]) {
      expect(teamScopeWords(scope).length).toBeLessThanOrEqual(30);
    }
  });

  test("the sentence answers both questions and names the directory", () => {
    const sentence = describeVaultScope({
      root: "/Users/ada/src/api",
      presence: "both",
      team,
    });
    expect(sentence).toBe(
      "/Users/ada/src/api — on this machine, synced to codecast, shared with Acme",
    );
  });

  test("a scope with no local path still gets a sentence", () => {
    expect(describeVaultScope({ presence: "other-machine", team: { kind: "personal" } })).toBe(
      "on another machine, read only, personal",
    );
  });
});

describe("findDocForFile", () => {
  const docs = {
    d1: { _id: "d1", source_file: "/w/api/docs/design.md" },
    d2: { _id: "d2", source_file: null },
  };

  test("joins a vault-relative path to a doc's absolute source_file", () => {
    expect(findDocForFile("/w/api", "docs/design.md", docs)?._id).toBe("d1");
  });

  test("a trailing slash on the root still joins", () => {
    expect(findDocForFile("/w/api/", "docs/design.md", docs)?._id).toBe("d1");
  });

  test("a file with no doc twin returns null", () => {
    expect(findDocForFile("/w/api", "docs/other.md", docs)).toBeNull();
    expect(findDocForFile("/w/api", null, docs)).toBeNull();
    expect(findDocForFile(undefined, "docs/design.md", docs)).toBeNull();
  });

  test("a doc for the same relative path in another vault does not match", () => {
    expect(findDocForFile("/w/web", "docs/design.md", docs)).toBeNull();
  });
});
