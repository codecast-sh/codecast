import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";

// Creating a team is local-first: the stub row and the workspace switch land
// in the same tick, the caller gets the real id once the server answers, the
// echo of getUserTeams retires the stub, and a refusal puts everything back.
// While the stub id sits in the pointer, feeders that hand it to the server
// guard it with isConvexId (see activeTeamPointer.guard.test.ts).

const serverId = (seed: string) => seed.padEnd(32, "0").slice(0, 32);
const OLD_TEAM = serverId("teamold");
const NEW_TEAM = serverId("teamnew");

type DispatchCall = { action: string; args: any[] };

describe("createTeam local-first", () => {
  const owner = {};
  let calls: DispatchCall[];
  let answer: () => Promise<any>;

  beforeEach(() => {
    calls = [];
    answer = async () => NEW_TEAM;
    useInboxStore.setState({
      teams: [{ _id: OLD_TEAM, name: "Old", role: "member", memberCount: 3 }],
      clientState: { ui: { active_team_id: OLD_TEAM } },
      pending: {},
    } as any);
    useInboxStore.getState()._setDispatch(async (action: string, args: any[]) => {
      calls.push({ action, args });
      return answer();
    }, { owner });
  });

  afterEach(() => {
    useInboxStore.getState()._clearDispatch(owner);
  });

  it("inserts the stub and switches the active team in the same tick", async () => {
    const promise = useInboxStore.getState().createTeam({ name: "  Rocket ", icon: "rocket", icon_color: "#ff0000" });
    const s = useInboxStore.getState();
    const stub = s.teams.find((t: any) => String(t._id).startsWith("team-stub-"));
    expect(stub).toMatchObject({ name: "Rocket", icon: "rocket", icon_color: "#ff0000", role: "admin", memberCount: 1 });
    expect(typeof stub.created_at).toBe("number");
    expect(s.clientState.ui?.active_team_id).toBe(stub._id);
    expect(calls[0].action).toBe("dispatchCreateTeam");
    expect(calls[0].args[1]).toEqual({ name: "Rocket", icon: "rocket", icon_color: "#ff0000" });
    await promise;
  });

  it("resolves the real id, rekeys the stub, and lets the echo retire it", async () => {
    const teamId = await useInboxStore.getState().createTeam({ name: "Rocket" });
    expect(teamId).toBe(NEW_TEAM);
    let s = useInboxStore.getState();
    expect(s.teams.map((t: any) => t._id)).toEqual([OLD_TEAM, NEW_TEAM]);
    expect(s.clientState.ui?.active_team_id).toBe(NEW_TEAM);

    // getUserTeams echo: the list is replaced wholesale with the server rows.
    useInboxStore.getState().syncTable("teams", [
      { _id: OLD_TEAM, name: "Old", role: "member" },
      { _id: NEW_TEAM, name: "Rocket", role: "admin", icon: "rocket", icon_color: "#ff0000" },
    ]);
    s = useInboxStore.getState();
    expect(s.teams.some((t: any) => String(t._id).startsWith("team-stub-"))).toBe(false);
    expect(s.teams.find((t: any) => t._id === NEW_TEAM)?.icon).toBe("rocket");
    expect(s.clientState.ui?.active_team_id).toBe(NEW_TEAM);
  });

  it("rolls the stub and the active team back when the server refuses", async () => {
    // A thrown application error reaches the client as "Uncaught Error: ...",
    // which the outbox reads as permanent (no retry ladder, entry retired).
    answer = async () => { throw new Error("Server Error Uncaught Error: Name too long"); };
    await expect(useInboxStore.getState().createTeam({ name: "Rocket" })).rejects.toThrow("Name too long");
    const s = useInboxStore.getState();
    expect(s.teams.map((t: any) => t._id)).toEqual([OLD_TEAM]);
    expect(s.clientState.ui?.active_team_id).toBe(OLD_TEAM);
  });

  it("refuses an empty name without touching the store", async () => {
    await expect(useInboxStore.getState().createTeam({ name: "   " })).rejects.toThrow();
    const s = useInboxStore.getState();
    expect(s.teams.length).toBe(1);
    expect(calls).toEqual([]);
    expect(s.clientState.ui?.active_team_id).toBe(OLD_TEAM);
  });
});
