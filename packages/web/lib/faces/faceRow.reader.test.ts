// The face row's shared reader (readFaceRow) and its input signature, and the
// DM unread line a face carries. The model itself is tested in faceRow.test.ts.
import { beforeEach, describe, expect, test } from "bun:test";
import { useInboxStore } from "../../store/inboxStore";
import { dmUnreadOf } from "./faceDmUnread";
import { faceRowInputSig, isInCall, readFaceRow, resetFaceRow } from "./faceRow";
import { NOW, ME, ANN, BOB, DM_ANN, member, burstRoom, order, entry } from "./faceRowFixtures";

describe("the shared reader", () => {
  beforeEach(() => {
    resetFaceRow();
    useInboxStore.setState({
      currentUser: { _id: ME, name: "Me" },
      teamMembers: [member(ME, "Me"), member(ANN, "Ann"), member(BOB, "Bob")],
      callOccupancy: {},
      liveRooms: [],
      myCalls: { incoming: [], outgoing: [], membership: null },
      followLeaderId: null,
    } as any);
  });

  test("a roster push that changes nothing a face draws hands back the same row", () => {
    const first = readFaceRow();
    expect(order(first)).toEqual([ANN, BOB]);
    useInboxStore.setState({
      teamMembers: [member(ME, "Me"), member(ANN, "Ann", { presence_input_at: NOW } as any), member(BOB, "Bob")],
    } as any);
    expect(readFaceRow()).toBe(first);
  });

  test("a change a face draws hands back a new row derived against the last", () => {
    const first = readFaceRow();
    useInboxStore.setState({ followLeaderId: BOB } as any);
    const second = readFaceRow();
    expect(second).not.toBe(first);
    expect(entry(second, BOB).followed).toBe(true);
    expect(isInCall(BOB)).toBe(false);
  });

  test("the input signature moves on the walkie, and holds through fields no face draws", () => {
    const st = useInboxStore.getState();
    const idle = { sending: null, incoming: null, liveRoom: null, unavailable: null, canReply: false, asr: "live", error: null } as const;
    const a = faceRowInputSig(st, idle, null, [], NOW);
    expect(faceRowInputSig(st, { ...idle, asr: "unavailable", error: "x" }, null, [], NOW + 1_000)).toBe(a);
    expect(faceRowInputSig(st, { ...idle, liveRoom: burstRoom(DM_ANN) }, null, [], NOW)).not.toBe(a);
    expect(faceRowInputSig(st, idle, { roomKey: DM_ANN, text: "Ann joined", at: NOW }, [], NOW)).not.toBe(a);
    expect(faceRowInputSig(st, idle, null, [{ identity: ANN, isLocal: false, kind: "camera" }], NOW)).not.toBe(a);
  });
});

describe("dmUnreadOf", () => {
  const st = (last: any, unread = 2) => ({
    currentUser: { _id: "me" },
    chatChannels: { c1: { kind: "dm" } },
    chatRail: [{ channel_id: "c1", member_ids: ["me", "cam"], unread, last_message: last }],
  });

  test("their newest line rides with the count", () => {
    const d = dmUnreadOf(st({ user_id: "cam", preview: "can you look at this", created_at: 5 }), "cam");
    expect(d).toEqual({ channelId: "c1", unread: 2, preview: "can you look at this", at: 5 });
  });

  test("my own last line is not shown as theirs", () => {
    expect(dmUnreadOf(st({ user_id: "me", preview: "mine", created_at: 5 }), "cam")?.preview).toBe(null);
  });

  test("nothing unread, nothing to say", () => {
    expect(dmUnreadOf(st({ user_id: "cam", preview: "x", created_at: 5 }, 0), "cam")).toBe(null);
    expect(dmUnreadOf(st(null), "someone-else")).toBe(null);
  });
});
