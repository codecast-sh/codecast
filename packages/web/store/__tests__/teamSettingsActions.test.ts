import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { performUndo, _resetUndoStacks } from "@platform/engine";
import { useInboxStore } from "../inboxStore";

// Team settings and membership go through store actions (they used to be
// direct teams.* mutations from the settings pages): each paints the teams
// or teamMembers row in the same tick, dispatches under its own name, and the
// reversible ones undo by sending the value the row held before.

const serverId = (seed: string) => seed.padEnd(32, "0").slice(0, 32);
const TEAM = serverId("teamsettings");
const ADA = serverId("userada");

describe("team settings store actions", () => {
  const owner = {};
  let calls: Array<{ action: string; args: any[] }>;

  beforeEach(() => {
    _resetUndoStacks();
    calls = [];
    useInboxStore.setState({
      teams: [{ _id: TEAM, name: "Old name", icon: "bolt", icon_color: "blue", role: "admin" }],
      teamMembers: [{ _id: ADA, name: "Ada", role: "member" }],
      clientState: { ui: { active_team_id: TEAM } },
      pending: {},
    } as any);
    useInboxStore.getState()._setDispatch(async (action: string, args: any[]) => {
      calls.push({ action, args });
      return { success: true };
    }, { owner });
  });

  afterEach(() => {
    useInboxStore.getState()._clearDispatch(owner);
  });

  it("rename, icon and role paint at once and dispatch under their own names", async () => {
    const s = useInboxStore.getState();
    const renamed = s.renameTeam(TEAM, "New name");
    const iconed = s.updateTeamIcon(TEAM, { icon_color: "green" });
    const roled = s.setTeamMemberRole(TEAM, ADA, "admin");
    const now = useInboxStore.getState();
    expect(now.teams[0].name).toBe("New name");
    expect(now.teams[0].icon_color).toBe("green");
    expect(now.teams[0].icon).toBe("bolt");
    expect(now.teamMembers[0].role).toBe("admin");
    await Promise.all([renamed, iconed, roled]);
    expect(calls.map((c) => c.action)).toEqual(["renameTeam", "updateTeamIcon", "setTeamMemberRole"]);
    expect(calls[0].args).toEqual([TEAM, "New name"]);
  });

  it("removing a member drops the roster row", async () => {
    await useInboxStore.getState().removeTeamMember(TEAM, ADA);
    expect(useInboxStore.getState().teamMembers).toEqual([]);
    expect(calls[0]).toEqual({ action: "removeTeamMember", args: [TEAM, ADA] });
  });

  it("a rename undoes by sending the old name", async () => {
    await useInboxStore.getState().renameTeam(TEAM, "New name");
    calls = [];
    expect(performUndo()).toBeTruthy();
    expect(useInboxStore.getState().teams[0].name).toBe("Old name");
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.some((c) => c.action === "renameTeam" && c.args[1] === "Old name")).toBe(true);
  });
});
