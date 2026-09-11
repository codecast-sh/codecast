import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";

// Deleting a team is local-first: the row leaves the list and the workspace
// pointer moves to the caller's oldest remaining team in the same tick, the
// dispatch carries the typed name to the server, and a refusal puts the row
// and the pointer back.

const serverId = (seed: string) => seed.padEnd(32, "0").slice(0, 32);
const DOOMED = serverId("teamdoomed");
const OLDER = serverId("teamolder");
const NEWER = serverId("teamnewer");

type DispatchCall = { action: string; args: any[] };

describe("deleteTeam local-first", () => {
  const owner = {};
  let calls: DispatchCall[];
  let answer: () => Promise<any>;

  beforeEach(() => {
    calls = [];
    answer = async () => ({ deleted: true, active_team_id: OLDER });
    useInboxStore.setState({
      teams: [
        { _id: DOOMED, name: "Doomed", role: "admin", joined_at: 30 },
        { _id: NEWER, name: "Newer", role: "member", joined_at: 20 },
        { _id: OLDER, name: "Older", role: "admin", joined_at: 10 },
        { _id: "team-stub-inflight", name: "Stub", role: "admin", joined_at: 0 },
      ],
      clientState: { ui: { active_team_id: DOOMED } },
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

  it("drops the row and moves the pointer to the oldest remaining real team in the same tick", async () => {
    const promise = useInboxStore.getState().deleteTeam(DOOMED, "Doomed");
    const s = useInboxStore.getState();
    expect(s.teams.map((t: any) => t._id)).toEqual([NEWER, OLDER, "team-stub-inflight"]);
    expect(s.clientState.ui?.active_team_id).toBe(OLDER);
    expect(calls[0].action).toBe("dispatchDeleteTeam");
    expect(calls[0].args).toEqual([DOOMED, "Doomed", OLDER]);
    await promise;
  });

  it("keeps a pointer that named another team", async () => {
    useInboxStore.setState({ clientState: { ui: { active_team_id: NEWER } } } as any);
    await useInboxStore.getState().deleteTeam(DOOMED, "Doomed");
    expect(useInboxStore.getState().clientState.ui?.active_team_id).toBe(NEWER);
  });

  it("clears the pointer when no other team remains", async () => {
    useInboxStore.setState({ teams: [{ _id: DOOMED, name: "Doomed", role: "admin", joined_at: 30 }] } as any);
    await useInboxStore.getState().deleteTeam(DOOMED, "Doomed");
    const s = useInboxStore.getState();
    expect(s.teams).toEqual([]);
    expect(s.clientState.ui?.active_team_id).toBeUndefined();
  });

  it("a refusal restores the row and the pointer", async () => {
    // A thrown application error reaches the client as "Uncaught Error: ...";
    // anything else is treated as transient and retried.
    answer = async () => { throw new Error("Server Error Uncaught Error: Type the team name exactly to confirm"); };
    await expect(useInboxStore.getState().deleteTeam(DOOMED, "Doomd")).rejects.toThrow(/exactly/);
    const s = useInboxStore.getState();
    expect(s.teams.map((t: any) => t._id).sort()).toEqual([DOOMED, NEWER, OLDER, "team-stub-inflight"].sort());
    expect(s.clientState.ui?.active_team_id).toBe(DOOMED);
  });

  it("refuses a team the store does not hold", async () => {
    await expect(useInboxStore.getState().deleteTeam(serverId("nope"), "Nope")).rejects.toThrow(/Team not found/);
    expect(calls).toEqual([]);
  });
});
