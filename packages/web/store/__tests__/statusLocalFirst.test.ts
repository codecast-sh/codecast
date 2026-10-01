import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";

// The manual status flip (available/busy/away in the avatar-bar hover card)
// must be local-first: setMyStatus updates the roster row synchronously, and a
// wholesale getTeamMembers re-push computed before the updateProfile mutation
// committed must not flap the pill back. teamMembers is a localFirst list, so
// the engine's field lock (teamMembers:<id>:status) holds the flip, the echo
// retires it, and a refused write puts the old status back.
const ME = "user_aaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "user_bbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function member(id: string, status?: string) {
  return { _id: id, name: id === ME ? "Me" : "Them", status };
}

function myStatus(): string | undefined {
  const s = useInboxStore.getState();
  return (s.teamMembers as any[]).find((m) => m._id === ME)?.status;
}

const lock = () => (useInboxStore.getState().pending as any)[`teamMembers:${ME}:status`];

describe("manual status local-first", () => {
  const owner = {};
  let refuse = false;
  beforeEach(() => {
    refuse = false;
    useInboxStore.setState({
      currentUser: { _id: ME } as any,
      teamMembers: [member(ME, "available"), member(OTHER, "available")],
      pending: {},
    });
    useInboxStore.getState()._setDispatch(async () => {
      if (refuse) throw new Error("Uncaught Error: no");
      return null;
    }, { owner });
  });
  afterEach(() => useInboxStore.getState()._clearDispatch(owner));

  it("flips the roster row synchronously and records the pending intent", () => {
    useInboxStore.getState().setMyStatus("away");
    expect(myStatus()).toBe("away");
    expect(lock()).toMatchObject({ type: "field", value: "away" });
  });

  it("keeps the flip when a stale roster push arrives before the mutation commits", () => {
    useInboxStore.getState().setMyStatus("away");
    // Heartbeat re-push of getTeamMembers: server hasn't seen the write yet.
    useInboxStore.getState().syncTable("teamMembers", [member(ME, "available"), member(OTHER, "busy")]);
    expect(myStatus()).toBe("away");
    // The rest of the push still lands.
    const other = (useInboxStore.getState().teamMembers as any[]).find((m) => m._id === OTHER);
    expect(other.status).toBe("busy");
    expect(lock()).toBeDefined();
  });

  it("stops protecting once the server reflects the status", () => {
    useInboxStore.getState().setMyStatus("away");
    useInboxStore.getState().syncTable("teamMembers", [member(ME, "away"), member(OTHER, "available")]);
    expect(myStatus()).toBe("away");
    expect(lock()).toBeUndefined();
  });

  it("puts the old status back when the server refuses, so a failed write cannot pin a lie", async () => {
    refuse = true;
    useInboxStore.getState().setMyStatus("away");
    expect(myStatus()).toBe("away");
    for (let i = 0; i < 100 && lock(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(myStatus()).toBe("available");
    useInboxStore.getState().syncTable("teamMembers", [member(ME, "busy"), member(OTHER, "available")]);
    expect(myStatus()).toBe("busy");
  });

  it("leaves an untouched roster alone when nothing is pending", () => {
    const roster = [member(ME, "busy"), member(OTHER, "available")];
    useInboxStore.getState().syncTable("teamMembers", roster);
    expect(myStatus()).toBe("busy");
  });
});
