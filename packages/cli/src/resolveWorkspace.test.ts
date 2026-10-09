import { describe, expect, test, beforeEach } from "bun:test";
import {
  filedElsewhereLine,
  loadWorkspaceRoster,
  clearWorkspaceCache,
  scopeFlagFor,
  teamFlagFor,
  workspaceFromKey,
  workspaceOfScope,
  matchTeam,
  resolveWorkspaceForRead,
  resolveWorkspaceForWrite,
  workspaceArgs,
  workspaceLabel,
  WorkspaceUnresolved,
  unknownTeamMessage,
  WORKSPACE_TTL_MS,
  type WorkspaceRoster, workspaceScope } from "./resolveWorkspace";

// The CLI used to answer "which workspace" in two places at once: pass --team
// through if given, else send nothing and let the server read
// users.active_team_id. The two disagreed — `cast chat new` with no --team put
// a channel in team Union while the shell said codecast. One resolver, one
// canonical pointer, and a WRITE that refuses to guess.

const UNION = "t_union";
const CODECAST = "t_codecast";

const roster = (over: Partial<WorkspaceRoster> = {}): WorkspaceRoster => ({
  teams: [
    { _id: UNION, name: "Union" },
    { _id: CODECAST, name: "Codecast Labs" },
  ],
  activeTeamId: CODECAST,
  ...over,
});

beforeEach(clearWorkspaceCache);

describe("roster loading", () => {
  test("carries the canonical pointer, and an absent one means personal", async () => {
    const a = await loadWorkspaceRoster(async () => ({
      teams: [{ _id: UNION, name: "Union" }], active_team_id: UNION,
    }));
    expect(a.activeTeamId).toBe(UNION);
    clearWorkspaceCache();
    const b = await loadWorkspaceRoster(async () => ({ teams: [], active_team_id: null }));
    expect(b.activeTeamId).toBeNull();
    expect(resolveWorkspaceForRead(b)).toEqual({ kind: "personal" });
  });

  test("one fetch per TTL, then refetched — a team switch in the web app must land", async () => {
    let calls = 0;
    const fetcher = async () => { calls++; return { teams: [], active_team_id: UNION }; };
    await loadWorkspaceRoster(fetcher, 1_000);
    await loadWorkspaceRoster(fetcher, 1_000 + WORKSPACE_TTL_MS - 1);
    expect(calls).toBe(1);
    await loadWorkspaceRoster(fetcher, 1_000 + WORKSPACE_TTL_MS + 1);
    expect(calls).toBe(2);
  });
});

describe("--team matching", () => {
  test("resolves by id, exact name, or the name as typed", () => {
    expect(matchTeam(roster(), UNION)?._id).toBe(UNION);
    expect(matchTeam(roster(), "Union")?._id).toBe(UNION);
    expect(matchTeam(roster(), "union")?._id).toBe(UNION);
    expect(matchTeam(roster(), "codecast-labs")?._id).toBe(CODECAST);
    expect(matchTeam(roster(), "Codecast  Labs")?._id).toBe(CODECAST);
    expect(matchTeam(roster(), "nope")).toBeNull();
  });
});

describe("READS may default", () => {
  test("no --team follows the canonical pointer, not the first team", () => {
    // teams[0] is Union; the pointer says Codecast. The old CLI default was
    // teams[0], which is exactly the disagreement this replaces.
    expect(resolveWorkspaceForRead(roster())).toEqual({
      kind: "team", teamId: CODECAST, name: "Codecast Labs",
    });
  });

  test("an explicit --team wins over the pointer", () => {
    const ws = resolveWorkspaceForRead(roster(), "Union");
    expect(ws.kind === "team" && ws.teamId).toBe(UNION);
  });

  test("no pointer at all reads the personal workspace, and sends no team", () => {
    const ws = resolveWorkspaceForRead(roster({ activeTeamId: null }));
    expect(ws).toEqual({ kind: "personal" });
    expect(workspaceArgs(ws)).toEqual({});
    expect(workspaceLabel(ws)).toBe("personal");
  });

  test("a read never throws on an unknown team — it costs a re-run, not a misplaced row", () => {
    expect(() => resolveWorkspaceForRead(roster(), "ghost")).not.toThrow();
  });
});

describe("WRITES must be explicit", () => {
  test("resolves the pointer and names the landing team", () => {
    const ws = resolveWorkspaceForWrite(roster(), undefined, { teamRequired: true });
    expect(ws).toEqual({ kind: "team", teamId: CODECAST, name: "Codecast Labs" });
    expect(workspaceArgs(ws)).toEqual({ team_id: CODECAST });
  });

  test("an unknown --team FAILS with the real choices instead of falling back", () => {
    try {
      resolveWorkspaceForWrite(roster(), "ghost", { teamRequired: true });
      throw new Error("should have thrown");
    } catch (e: any) {
      expect(e).toBeInstanceOf(WorkspaceUnresolved);
      expect(e.message).toContain("ghost");
      expect(e.message).toContain("Union");
      expect(e.message).toContain("Codecast Labs");
    }
  });

  test("no team and no pointer FAILS for a team-only write, listing the teams", () => {
    try {
      resolveWorkspaceForWrite(roster({ activeTeamId: null }), undefined, { teamRequired: true });
      throw new Error("should have thrown");
    } catch (e: any) {
      expect(e).toBeInstanceOf(WorkspaceUnresolved);
      expect(e.message).toContain("--team");
      expect(e.message).toContain(UNION);
    }
  });

  test("a STALE pointer (membership lapsed) fails rather than writing into a team you left", () => {
    const stale = roster({ activeTeamId: "t_departed" });
    expect(() => resolveWorkspaceForWrite(stale, undefined, { teamRequired: true }))
      .toThrow(WorkspaceUnresolved);
  });

  test("a write that tolerates the personal workspace gets it when no team is active", () => {
    expect(resolveWorkspaceForWrite(roster({ activeTeamId: null }), undefined))
      .toEqual({ kind: "personal" });
  });

  test("with no teams at all the message says so instead of listing nothing", () => {
    try {
      resolveWorkspaceForWrite({ teams: [], activeTeamId: null }, undefined, { teamRequired: true });
      throw new Error("should have thrown");
    } catch (e: any) {
      expect(e.message).toContain("not a member of any team");
    }
  });
});

describe("--team personal", () => {
  test("a read names the personal workspace while the pointer is a team, and sends no team", () => {
    for (const word of ["personal", "me", "Personal"]) {
      const ws = resolveWorkspaceForRead(roster(), word);
      expect(ws).toEqual({ kind: "personal" });
      expect(workspaceArgs(ws)).toEqual({});
    }
  });

  test("a real team named personal still wins", () => {
    const r = roster();
    r.teams.push({ _id: "teams_personal", name: "Personal" });
    expect(resolveWorkspaceForRead(r, "personal")).toEqual({ kind: "team", teamId: "teams_personal", name: "Personal" });
  });

  test("a write that tolerates the personal workspace gets it; a team-only write fails and lists the teams", () => {
    expect(resolveWorkspaceForWrite(roster(), "personal")).toEqual({ kind: "personal" });
    expect(() => resolveWorkspaceForWrite(roster(), "personal", { teamRequired: true })).toThrow(WorkspaceUnresolved);
  });

  test("the work routes get the workspace as a positive value", () => {
    expect(workspaceScope(resolveWorkspaceForRead(roster(), "personal"))).toEqual({ workspace: "personal" });
    const team = resolveWorkspaceForRead(roster(), roster().teams[0].name);
    expect(workspaceScope(team)).toEqual({ workspace: "team", team_id: roster().teams[0]._id });
  });

  test("an unknown team's message offers personal as a choice", () => {
    expect(unknownTeamMessage(roster(), "ghost")).toContain("personal  your own workspace");
  });
});

// A write takes an explicit workspace or the session's team; a read defaults
// to the directory's mapping. On a checkout mapped elsewhere the two differ,
// and a next step printed by the write ("cast task ready --plan pl-857") then
// reads the wrong workspace and answers nothing, which is read as "no work".
describe("naming the workspace a row was filed in", () => {
  const personal = { kind: "personal" } as const;
  const codecast = { kind: "team", teamId: CODECAST, name: "Codecast Labs" } as const;

  test("a stored access key becomes a workspace, named from the roster", () => {
    expect(workspaceFromKey(roster(), `team:${UNION}`)).toEqual({ kind: "team", teamId: UNION, name: "Union" });
    expect(workspaceFromKey(roster(), "user:u1")).toEqual({ kind: "personal" });
    // A team outside the roster keeps its id; an unreadable key names nothing.
    expect(workspaceFromKey(roster(), "team:t_ghost")).toEqual({ kind: "team", teamId: "t_ghost" });
    expect(workspaceFromKey(roster(), "restricted:x")).toBeNull();
    expect(workspaceFromKey(roster(), undefined)).toBeNull();
  });

  test("one wording for every printed --team, whatever command prints it", () => {
    expect(teamFlagFor(personal)).toBe(" --team personal");
    expect(teamFlagFor(codecast)).toBe(" --team 'Codecast Labs'");
    expect(teamFlagFor({ kind: "team", teamId: "t_ghost" })).toBe(" --team t_ghost");
    expect(teamFlagFor(null)).toBe("");
    // A printed create keeps the flag wherever the next shell would file: a
    // write names its workspace (workspaceOfScope reads a create's own args).
    expect(teamFlagFor(workspaceOfScope({ workspace: "team", team_id: "t_a" }))).toBe(" --team t_a");
    expect(teamFlagFor(workspaceOfScope({ workspace: "personal" }))).toBe(" --team personal");
    expect(workspaceOfScope({ project_path: "/x" } as any)).toBeNull();
    expect(workspaceOfScope(null)).toBeNull();
  });

  test("the flag is empty when the read already lands there, and names the gap when it does not", () => {
    expect(scopeFlagFor(personal, personal)).toBe("");
    expect(scopeFlagFor(codecast, { kind: "team", teamId: CODECAST })).toBe("");
    expect(scopeFlagFor(personal, codecast)).toBe(" --team personal");
    expect(scopeFlagFor(codecast, personal)).toBe(" --team 'Codecast Labs'");
    expect(scopeFlagFor({ kind: "team", teamId: UNION, name: "Union" }, codecast)).toBe(" --team Union");
    // A team the roster does not hold falls back to its id, which needs no quoting.
    expect(scopeFlagFor({ kind: "team", teamId: "t_ghost" }, personal)).toBe(" --team t_ghost");
    // Nothing known about the workspace: no flag beats a wrong one.
    expect(scopeFlagFor(null, personal)).toBe("");
    // A read whose own workspace is not known yet keeps the flag: naming the
    // workspace outright reads right from anywhere.
    expect(scopeFlagFor(codecast, null)).toBe(" --team 'Codecast Labs'");
    expect(scopeFlagFor(personal, null)).toBe(" --team personal");
  });

  test("an empty answer says the plan is read elsewhere, and stays quiet when it is not", () => {
    expect(filedElsewhereLine("pl-857", codecast, personal)).toBe(
      "pl-857 is in the Codecast Labs workspace, and this directory reads personal: add --team 'Codecast Labs' to read it.",
    );
    expect(filedElsewhereLine("pl-857", personal, personal)).toBeNull();
    expect(filedElsewhereLine("pl-857", null, personal)).toBeNull();
  });
});
