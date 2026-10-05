import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { guestIdentity } from "@codecast/shared/contracts";
import { useInboxStore } from "../inboxStore";

// The room's answers to a guest paint in the frame they are pressed: the
// knock leaves `roomKnocks` (a localFirst list keyed by from_user), a
// getRoomKnocks push computed before the answer landed cannot put it back,
// a refusal does, and a removed guest leaves the live room's faces.
const ROOM = "channel:c1";
const ada = { from_user: "guest:g1", from_name: "Ada", created_at: 10, kind: "guest", guest_id: "g1", can_answer: true };
const bo = { from_user: "u-bo", from_name: "Bo", created_at: 5, kind: "person", can_answer: true };
const knocks = () => ((useInboxStore.getState() as any).roomKnocks ?? []).map((k: any) => k.from_user);

describe("answering a guest, local-first", () => {
  const owner = {};
  let calls: Array<{ action: string; args: any[] }>;
  let refuse = false;

  beforeEach(() => {
    calls = [];
    refuse = false;
    useInboxStore.setState({ roomKnocks: [], liveRooms: [], pending: {} } as any);
    useInboxStore.getState()._setDispatch(async (action: string, args: any[]) => {
      calls.push({ action, args });
      // An application error reaches the client as "Uncaught Error: ...",
      // which the outbox reads as a refusal for good.
      if (refuse) throw new Error("Server Error Uncaught Error: Ada is no longer at the door");
      return null;
    }, { owner });
    useInboxStore.getState().syncTable("roomKnocks", [ada, bo]);
  });

  afterEach(() => {
    useInboxStore.getState()._clearDispatch(owner);
  });

  it("takes the knock off the door in the same tick, and rides the named side effect", async () => {
    const done = useInboxStore.getState().admitGuestKnock("g1", "Ada");
    expect(knocks()).toEqual(["u-bo"]);
    await done;
    expect(calls).toEqual([{ action: "admitGuestKnock", args: ["g1", "Ada"] }]);
  });

  it("holds the knock off through a push computed before the answer landed", () => {
    void useInboxStore.getState().denyGuestKnock("g1", true);
    useInboxStore.getState().syncTable("roomKnocks", [ada, bo]);
    expect(knocks()).toEqual(["u-bo"]);
    // The server agrees, and a later knock from the same row shows again.
    useInboxStore.getState().syncTable("roomKnocks", [bo]);
    useInboxStore.getState().syncTable("roomKnocks", [{ ...ada, created_at: 99 }, bo]);
    expect(knocks()).toEqual(["guest:g1", "u-bo"]);
  });

  it("puts a refused answer's knock back", async () => {
    refuse = true;
    let err: unknown = null;
    await useInboxStore.getState().admitGuestKnock("g1", "Ada").catch((e) => (err = e));
    expect(String(err)).toContain("no longer at the door");
    useInboxStore.getState().syncTable("roomKnocks", [ada, bo]);
    expect(knocks()).toContain("guest:g1");
  });

  it("a removed guest leaves the live room's faces, and a refusal can put them back", () => {
    // The room's guests carry the identity the server minted, through the
    // contract's one home for its format; the removal must match it.
    const cy = { identity: guestIdentity("g2"), name: "Cy" };
    useInboxStore.setState({ liveRooms: [{ room_key: ROOM, guests: [cy, { identity: guestIdentity("g3"), name: "Di" }] }] } as any);
    void useInboxStore.getState().removeCallGuest(ROOM, "g2", false);
    expect((useInboxStore.getState() as any).liveRooms[0].guests.map((g: any) => g.name)).toEqual(["Di"]);
    useInboxStore.getState().restoreCallGuest(ROOM, cy);
    expect((useInboxStore.getState() as any).liveRooms[0].guests.map((g: any) => g.name)).toEqual(["Di", "Cy"]);
  });
});
