import { beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";

// The manual status flip (available/busy/away in the avatar-bar hover card)
// must be local-first: setMyStatus updates the roster row synchronously, and a
// wholesale getTeamMembers re-push computed before the updateProfile mutation
// committed must not flap the pill back.
const ME = "user_aaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "user_bbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function member(id: string, status?: string) {
  return { _id: id, name: id === ME ? "Me" : "Them", status };
}

function myStatus(): string | undefined {
  const s = useInboxStore.getState();
  return (s.teamMembers as any[]).find((m) => m._id === ME)?.status;
}

describe("manual status local-first", () => {
  beforeEach(() => {
    useInboxStore.setState({
      currentUser: { _id: ME } as any,
      teamMembers: [member(ME, "available"), member(OTHER, "available")],
      myStatusPending: null,
    });
  });

  it("flips the roster row synchronously and records the pending intent", () => {
    useInboxStore.getState().setMyStatus("away");
    expect(myStatus()).toBe("away");
    expect(useInboxStore.getState().myStatusPending).toMatchObject({ userId: ME, status: "away" });
  });

  it("keeps the flip when a stale roster push arrives before the mutation commits", () => {
    useInboxStore.getState().setMyStatus("away");
    // Heartbeat re-push of getTeamMembers: server hasn't seen the write yet.
    useInboxStore.getState().syncTable("teamMembers", [member(ME, "available"), member(OTHER, "busy")]);
    expect(myStatus()).toBe("away");
    // The rest of the push still lands.
    const other = (useInboxStore.getState().teamMembers as any[]).find((m) => m._id === OTHER);
    expect(other.status).toBe("busy");
    expect(useInboxStore.getState().myStatusPending).not.toBeNull();
  });

  it("stops protecting once the server reflects the status", () => {
    useInboxStore.getState().setMyStatus("away");
    useInboxStore.getState().syncTable("teamMembers", [member(ME, "away"), member(OTHER, "available")]);
    expect(myStatus()).toBe("away");
    expect(useInboxStore.getState().myStatusPending).toBeNull();
  });

  it("expires the protection after the TTL so a failed dispatch cannot pin a lie", () => {
    useInboxStore.getState().setMyStatus("away");
    const pending = useInboxStore.getState().myStatusPending!;
    useInboxStore.setState({ myStatusPending: { ...pending, at: Date.now() - 60_000 } });
    useInboxStore.getState().syncTable("teamMembers", [member(ME, "available"), member(OTHER, "available")]);
    expect(myStatus()).toBe("available");
    expect(useInboxStore.getState().myStatusPending).toBeNull();
  });

  it("leaves an untouched roster alone when nothing is pending", () => {
    const roster = [member(ME, "busy"), member(OTHER, "available")];
    useInboxStore.getState().syncTable("teamMembers", roster);
    expect(myStatus()).toBe("busy");
  });
});
