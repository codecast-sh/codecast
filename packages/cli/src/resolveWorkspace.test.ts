import { describe, expect, test, beforeEach } from "bun:test";
import {
  loadWorkspaceRoster,
  clearWorkspaceCache,
  matchTeam,
  resolveWorkspaceForRead,
  resolveWorkspaceForWrite,
  workspaceArgs,
  workspaceLabel,
  WorkspaceUnresolved,
  WORKSPACE_TTL_MS,
  type WorkspaceRoster,
} from "./resolveWorkspace";

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
