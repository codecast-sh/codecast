// THE FACE ROW MODEL (pl-756 F1). Every state in the vocabulary, every link
// kind, the order rules, the seams where a face used to read off then on, the
// card for each engagement, the selectors, and the shared reader's memo.
import { beforeEach, describe, expect, test } from "bun:test";
import { dmRoomKey } from "@codecast/shared/contracts";
import { JOIN_TITLE_MS } from "../calls/joinAnnounce";
import { useInboxStore } from "../../store/inboxStore";
import {
  deriveFaceRow,
  engagementOf,
  faceRowInputSig,
  isInCall,
  isTalking,
  readFaceRow,
  resetFaceRow,
  type FaceMember,
  type FaceRow,
  type FaceRowInput,
  isInHuddle,
  roomHeldAsBurst,
} from "./faceRow";

const NOW = 1_700_000_000_000;
const ME = "u-me";
const ANN = "u-ann";
const BOB = "u-bob";
const CY = "u-cy";
const DM_ANN = dmRoomKey(ME, ANN);
const DM_BOB = dmRoomKey(ME, BOB);

function member(id: string, name: string, over: Partial<FaceMember> = {}): FaceMember {
  return { _id: id, name, presence_state: "active", ...over };
}

function input(over: Partial<FaceRowInput> = {}): FaceRowInput {
  return {
    viewer: { id: ME, name: "Me" },
    roster: [member(ME, "Me"), member(ANN, "Ann"), member(BOB, "Bob"), member(CY, "Cy")],
    occupancy: {},
    liveRooms: [],
    walkie: { liveRoom: null, sending: null, incoming: null, canReply: false },
    call: { phase: "idle", roomKey: null, muted: true, micDenied: false, camera: false, speaking: [] },
    tiles: [],
    followLeaderId: null,
    rings: { incoming: [], outgoing: [] },
    announcement: null,
    unread: new Map(),
    ask: new Map(),
    now: NOW,
    ...over,
  };
}

const seat = (id: string, over: Record<string, unknown> = {}) => ({ user_id: id, ...over });
const walkie = (liveRoom: FaceRowInput["walkie"]["liveRoom"], over: Partial<FaceRowInput["walkie"]> = {}) => ({
  liveRoom,
  sending: null,
  incoming: null,
  canReply: false,
  ...over,
});
const sendingTo = (roomKey: string, heardLive = true) => ({ roomKey, live: true, heardLive });
const burstRoom = (key: string, mode: "burst" | "listen" | "call" = "burst") => ({ key, mode, since: NOW - 5_000 });
const call = (roomKey: string, over: Partial<FaceRowInput["call"]> = {}) => ({
  phase: "connected",
  roomKey,
  muted: false,
  micDenied: false,
  camera: false,
  speaking: [],
  ...over,
});

const states = (row: FaceRow) => Object.fromEntries(row.entries.map((e) => [e.id, e.state]));
const order = (row: FaceRow) => row.entries.map((e) => e.id);
const entry = (row: FaceRow, id: string) => row.entries.find((e) => e.id === id)!;

// ── every state ─────────────────────────────────────────────────────────────

describe("every state in the vocabulary", () => {
  test("presence alone: online, idle, away, offline, busy; the viewer is absent", () => {
    const row = deriveFaceRow(
      input({
        roster: [
          member(ME, "Me"),
          member(ANN, "Ann"),
          member(BOB, "Bob", { presence_state: "idle" }),
          member(CY, "Cy", { presence_state: "away" }),
          member("u-di", "Di", { presence_state: "offline" }),
          member("u-ed", "Ed", { status: "busy" }),
        ],
      }),
      null,
    );
    expect(states(row)).toEqual({ [ANN]: "online", [BOB]: "idle", [CY]: "away", "u-di": "offline", "u-ed": "busy" });
    expect(row.me).toBeNull();
    expect(row.links).toEqual([]);
    expect(row.card).toEqual({ kind: "none" });
  });

  test("in-call: a seat in a room the viewer is not in, when the seat is a call", () => {
    const row = deriveFaceRow(
      input({
        roster: [member(ME, "Me"), member(ANN, "Ann", { in_huddle: true, in_room_key: "channel:c1", seat: "call" })],
      }),
      null,
    );
    expect(states(row)).toEqual({ [ANN]: "in-call" });
    expect(entry(row, ANN).tier).toBe("call");
    expect(isInCall(ANN, row)).toBe(true);
    expect(isTalking(ANN, row)).toBe(false);
  });

  test("a third party's walkie seat is presence, not a call (the seat class)", () => {
    const row = deriveFaceRow(
      input({
        roster: [member(ME, "Me"), member(ANN, "Ann", { in_huddle: true, in_room_key: dmRoomKey(ANN, BOB), seat: "walkie" })],
        liveRooms: [{ room_key: dmRoomKey(ANN, BOB), seat: "walkie", members: [seat(ANN), seat(BOB)] }],
      }),
      null,
    );
    expect(states(row)).toEqual({ [ANN]: "online" });
    expect(isInCall(ANN, row)).toBe(false);
  });

  test("a viewer the room does not admit sees the bare boolean as a call", () => {
    const row = deriveFaceRow(
      input({ roster: [member(ME, "Me"), member(ANN, "Ann", { in_huddle: true })] }),
      null,
    );
    expect(states(row)).toEqual({ [ANN]: "in-call" });
  });

  test("ringing-them and ringing-me, with ring links and the viewer at the head", () => {
    const row = deriveFaceRow(
      input({
        rings: {
          incoming: [{ from_user: BOB, room_key: DM_BOB, from_name: "Bob" }],
          outgoing: [{ to_user: ANN, room_key: DM_ANN, to_name: "Ann", status: "ringing" }],
        },
      }),
      null,
    );
    expect(states(row)).toEqual({ [ME]: "ringing-me", [ANN]: "ringing-them", [BOB]: "ringing-me", [CY]: "online" });
    expect(row.links).toEqual([
      { from: ME, to: ANN, kind: "ring" },
      { from: ME, to: BOB, kind: "ring" },
    ]);
    expect(row.card.kind).toBe("ring-in");
  });

  test("a settled outgoing ring (declined, no answer) is not ringing-them", () => {
    const row = deriveFaceRow(
      input({ rings: { incoming: [], outgoing: [{ to_user: ANN, room_key: DM_ANN, to_name: "Ann", status: "declined" }] } }),
      null,
    );
    expect(states(row)[ANN]).toBe("online");
    expect(row.card).toMatchObject({ kind: "ring-out", status: "declined" });
  });

  test("talking-to-me: their burst is playing here; a voice level drives their ring", () => {
    const row = deriveFaceRow(
      input({
        walkie: walkie(burstRoom(DM_ANN, "listen"), { incoming: { fromUserId: ANN, roomKey: DM_ANN } }),
        occupancy: { [DM_ANN]: [seat(ME), seat(ANN)] },
      }),
      null,
    );
    expect(states(row)).toMatchObject({ [ME]: "in-call", [ANN]: "talking-to-me" });
    expect(entry(row, ANN).level).toBe("voice");
    expect(row.links).toEqual([{ from: ME, to: ANN, kind: "rx" }]);
    expect(isTalking(ANN, row)).toBe(true);
    expect(isInCall(ANN, row)).toBe(true);
  });

  test("hearing-me: my burst is out and they are seated; the viewer is speaking on a mic level", () => {
    const row = deriveFaceRow(
      input({
        walkie: walkie(burstRoom(DM_ANN), { sending: sendingTo(DM_ANN) }),
        occupancy: { [DM_ANN]: [seat(ME), seat(ANN)] },
        call: call(DM_ANN),
      }),
      null,
    );
    expect(states(row)).toMatchObject({ [ME]: "speaking", [ANN]: "hearing-me" });
    expect(row.me).toMatchObject({ level: "mic", muted: false });
    expect(row.links).toEqual([{ from: ME, to: ANN, kind: "tx" }]);
    expect(isTalking(ME, row)).toBe(true);
  });

  test("my burst before their seat lands: linked (tx) but no claim they hear it", () => {
    const row = deriveFaceRow(
      input({ walkie: walkie(burstRoom(DM_ANN), { sending: sendingTo(DM_ANN, false) }) }),
      null,
    );
    expect(states(row)[ANN]).toBe("online");
    expect(entry(row, ANN).tier).toBe("linked");
    expect(row.links).toEqual([{ from: ME, to: ANN, kind: "tx" }]);
  });

  test("live-with-me: seated together in a call; speaking when their voice is active", () => {
    const base = input({
      walkie: walkie(burstRoom(DM_ANN, "call")),
      occupancy: { [DM_ANN]: [seat(ME), seat(ANN, { muted: true })] },
      call: call(DM_ANN),
    });
    const quiet = deriveFaceRow(base, null);
    expect(states(quiet)).toMatchObject({ [ME]: "in-call", [ANN]: "live-with-me" });
    expect(entry(quiet, ANN).muted).toBe(true);
    expect(quiet.links).toEqual([{ from: ME, to: ANN, kind: "call" }]);
    const loud = deriveFaceRow({ ...base, call: call(DM_ANN, { speaking: [ANN] }) }, quiet);
    expect(states(loud)[ANN]).toBe("speaking");
    expect(entry(loud, ANN).level).toBe("voice");
  });

  test("joining: they stepped in on purpose, for the notice's few seconds, then live-with-me", () => {
    const base = input({
      walkie: walkie(burstRoom(DM_ANN, "call")),
      occupancy: { [DM_ANN]: [seat(ME), seat(ANN, { walkie_joined_at: NOW - 2_000 })] },
      call: call(DM_ANN),
      announcement: { roomKey: DM_ANN, text: "Ann joined", at: NOW - 1_000 },
    });
    const fresh = deriveFaceRow(base, null);
    expect(states(fresh)[ANN]).toBe("joining");
    expect(entry(fresh, ANN).joinedAgo).toBe(2_000);
    expect(fresh.card).toMatchObject({ kind: "joined-notice", text: "Ann joined", end: true, mute: true });
    const later = deriveFaceRow({ ...base, now: NOW + JOIN_TITLE_MS }, fresh);
    expect(states(later)[ANN]).toBe("live-with-me");
    expect(later.card).toMatchObject({ kind: "live", roomKey: DM_ANN });
  });

  test("an ordinary huddle (no walkie) in a channel room: seated faces are live with me", () => {
    const row = deriveFaceRow(
      input({
        call: call("channel:c1"),
        occupancy: { "channel:c1": [seat(ME), seat(ANN), seat(BOB)] },
        roomLabel: "#design",
      }),
      null,
    );
    expect(states(row)).toMatchObject({ [ME]: "in-call", [ANN]: "live-with-me", [BOB]: "live-with-me", [CY]: "online" });
    expect(row.card).toMatchObject({ kind: "live", title: "#design", words: null, mute: true });
  });
});

// ── links ───────────────────────────────────────────────────────────────────

describe("every link kind", () => {
  test("both: two keys down in one room", () => {
    const row = deriveFaceRow(
      input({
        walkie: walkie(burstRoom(DM_ANN), { sending: sendingTo(DM_ANN), incoming: { fromUserId: ANN, roomKey: DM_ANN } }),
        occupancy: { [DM_ANN]: [seat(ME), seat(ANN)] },
        call: call(DM_ANN),
      }),
      null,
    );
    expect(row.links).toEqual([{ from: ME, to: ANN, kind: "both" }]);
    expect(states(row)[ANN]).toBe("talking-to-me");
  });

  test("a face never in my room and never named by it has no link", () => {
    const row = deriveFaceRow(
      input({ walkie: walkie(burstRoom(DM_ANN), { sending: sendingTo(DM_ANN) }), occupancy: { [DM_ANN]: [seat(ME), seat(ANN)] } }),
      null,
    );
    expect(row.links.map((l) => l.to)).toEqual([ANN]);
  });

  test("video: my camera makes my face self video; a remote camera track makes theirs remote", () => {
    const row = deriveFaceRow(
      input({
        call: call(DM_ANN, { camera: true }),
        occupancy: { [DM_ANN]: [seat(ME), seat(ANN)] },
        tiles: [
          { identity: ME, isLocal: true, kind: "camera" },
          { identity: ANN, isLocal: false, kind: "camera" },
          { identity: ANN, isLocal: false, kind: "screen" },
        ],
      }),
      null,
    );
    expect(row.me?.video).toBe("self");
    expect(entry(row, ANN).video).toBe("remote");
  });

  test("followed rides the follow leader; unread and ask ride their maps", () => {
    const row = deriveFaceRow(
      input({ followLeaderId: BOB, unread: new Map([[ANN, 3]]), ask: new Map([[CY, 2]]) }),
      null,
    );
    expect(entry(row, BOB).followed).toBe(true);
    expect(entry(row, ANN).unread).toBe(3);
    expect(entry(row, CY).ask).toBe(2);
  });
});

// ── order ───────────────────────────────────────────────────────────────────

describe("order", () => {
  const roster = [
    member(ME, "Me"),
    member(ANN, "Ann", { presence_state: "away" }),
    member(BOB, "Bob", { presence_state: "idle" }),
    member(CY, "Cy"),
    member("u-di", "Di", { presence_state: "offline" }),
    member("u-ed", "Ed", { in_huddle: true, in_room_key: "channel:c2", seat: "call" }),
  ];

  test("me, then linked faces, then calls, then presence bands by name", () => {
    const row = deriveFaceRow(
      input({ roster, walkie: walkie(burstRoom(DM_ANN), { sending: sendingTo(DM_ANN) }), occupancy: { [DM_ANN]: [seat(ME), seat(ANN)] } }),
      null,
    );
    expect(order(row)).toEqual([ME, ANN, "u-ed", CY, BOB, "u-di"]);
    expect(row.entries[0]).toBe(row.me!);
  });

  test("linked faces keep the order they were linked in; a new link goes after", () => {
    const first = deriveFaceRow(
      input({ roster, call: call("channel:c1"), occupancy: { "channel:c1": [seat(ME), seat(CY)] } }),
      null,
    );
    expect(order(first).slice(0, 2)).toEqual([ME, CY]);
    const second = deriveFaceRow(
      input({ roster, call: call("channel:c1"), occupancy: { "channel:c1": [seat(ME), seat(CY), seat(ANN)] } }),
      first,
    );
    // Ann sorts before Cy by name, and still lands after: order is by link.
    expect(order(second).slice(0, 3)).toEqual([ME, CY, ANN]);
  });

  test("a heartbeat, a mute, a level or a speaking change moves nobody", () => {
    const base = input({ roster, call: call("channel:c1"), occupancy: { "channel:c1": [seat(ME), seat(CY), seat(ANN)] } });
    const before = deriveFaceRow(base, null);
    const after = deriveFaceRow(
      {
        ...base,
        roster: roster.map((m) => ({ ...m, presence_input_at: NOW } as FaceMember)),
        occupancy: { "channel:c1": [seat(ME), seat(ANN, { muted: true }), seat(CY)] },
        call: call("channel:c1", { speaking: [ANN], muted: true }),
      },
      before,
    );
    expect(order(after)).toEqual(order(before));
    expect(states(after)[ANN]).toBe("speaking");
  });

  test("a tier change moves a face: a call ends and the face returns to its band", () => {
    const during = deriveFaceRow(input({ roster, call: call(DM_BOB), occupancy: { [DM_BOB]: [seat(ME), seat(BOB)] } }), null);
    expect(order(during).slice(0, 2)).toEqual([ME, BOB]);
    const after = deriveFaceRow(input({ roster }), during);
    expect(order(after)).toEqual(["u-ed", CY, BOB, ANN, "u-di"]);
  });
});

// ── the seams ───────────────────────────────────────────────────────────────

describe("hysteresis: the seams that read off then on", () => {
  test("(1) my linger after Stop keeps me on the row and the far side linked, never online", () => {
    const sending = deriveFaceRow(
      input({ walkie: walkie(burstRoom(DM_ANN), { sending: sendingTo(DM_ANN) }), occupancy: { [DM_ANN]: [seat(ME), seat(ANN)] }, call: call(DM_ANN) }),
      null,
    );
    expect(states(sending)[ANN]).toBe("hearing-me");
    // Key up: the walkie still holds the room, nobody is sending.
    const linger = deriveFaceRow(
      input({ walkie: walkie(burstRoom(DM_ANN)), occupancy: { [DM_ANN]: [seat(ME), seat(ANN)] }, call: call(DM_ANN) }),
      sending,
    );
    expect(linger.me).not.toBeNull();
    expect(states(linger)[ANN]).toBe("live-with-me");
    expect(linger.links).toEqual([{ from: ME, to: ANN, kind: "tx" }]);
    expect(linger.card.kind).toBe("live");
    // Their stamp lands: a call, with the join said for a moment.
    const joined = deriveFaceRow(
      input({
        walkie: walkie(burstRoom(DM_ANN, "call")),
        occupancy: { [DM_ANN]: [seat(ME), seat(ANN, { walkie_joined_at: NOW })] },
        call: call(DM_ANN),
        announcement: { roomKey: DM_ANN, text: "Ann joined", at: NOW },
      }),
      linger,
    );
    expect(states(joined)[ANN]).toBe("joining");
    expect(joined.links).toEqual([{ from: ME, to: ANN, kind: "call" }]);
    expect(order(joined)).toEqual(order(linger));
  });

  test("(1b) their seat lapses for a tick while the walkie holds the room: held, not online", () => {
    const seated = deriveFaceRow(
      input({ walkie: walkie(burstRoom(DM_ANN)), occupancy: { [DM_ANN]: [seat(ME), seat(ANN)] } }),
      null,
    );
    const gap = deriveFaceRow(input({ walkie: walkie(burstRoom(DM_ANN)), occupancy: { [DM_ANN]: [seat(ME)] } }), seated);
    expect(states(gap)[ANN]).toBe("live-with-me");
    expect(gap.links).toEqual([{ from: ME, to: ANN, kind: "tx" }]);
    // While my key is down again the held face hears me.
    const again = deriveFaceRow(
      input({ walkie: walkie(burstRoom(DM_ANN), { sending: sendingTo(DM_ANN) }), occupancy: { [DM_ANN]: [seat(ME)] } }),
      gap,
    );
    expect(states(again)[ANN]).toBe("hearing-me");
    // The walkie hands the room back: presence, at once.
    const done = deriveFaceRow(input({}), again);
    expect(states(done)[ANN]).toBe("online");
    expect(done.me).toBeNull();
  });

  test("(2) a LiveKit reconnect (phase connecting) keeps the call and the room", () => {
    const row = deriveFaceRow(
      input({ call: call("channel:c1", { phase: "connecting" }), occupancy: { "channel:c1": [seat(ME), seat(ANN)] } }),
      null,
    );
    expect(row.room).toBe("channel:c1");
    expect(row.me?.state).toBe("in-call");
    expect(states(row)[ANN]).toBe("live-with-me");
  });

  test("(3) the seat goes when the room does: no held state outlives the end of the engagement", () => {
    const during = deriveFaceRow(input({ call: call(DM_ANN), occupancy: { [DM_ANN]: [seat(ME), seat(ANN)] } }), null);
    const ended = deriveFaceRow(input({ occupancy: { [DM_ANN]: [seat(ANN)] } }), during);
    expect(ended.me).toBeNull();
    expect(ended.room).toBeNull();
    expect(states(ended)[ANN]).toBe("online");
  });

  test("(4) a seat the roster still reports in my room counts before the occupancy feed lands", () => {
    const row = deriveFaceRow(
      input({
        roster: [member(ME, "Me"), member(ANN, "Ann", { in_huddle: true, in_room_key: DM_ANN, seat: "call" })],
        walkie: walkie(burstRoom(DM_ANN, "call")),
        call: call(DM_ANN),
      }),
      null,
    );
    expect(states(row)[ANN]).toBe("live-with-me");
  });

  test("(5) a room the walkie holds is engaged even when the call plane went idle under it", () => {
    const row = deriveFaceRow(
      input({ walkie: walkie(burstRoom(DM_ANN), { sending: sendingTo(DM_ANN) }), call: { ...call(DM_ANN), phase: "idle", roomKey: null } }),
      null,
    );
    expect(row.room).toBe(DM_ANN);
    expect(row.me?.state).toBe("speaking");
    expect(row.card).toMatchObject({ kind: "live", words: { stage: "dropped" } });
  });

  test("(6) another window is the voice host: my seat in the live rooms list engages me", () => {
    const row = deriveFaceRow(
      input({ liveRooms: [{ room_key: DM_ANN, seat: "call", members: [seat(ME), seat(ANN)] }] }),
      null,
    );
    expect(row.room).toBe(DM_ANN);
    expect(states(row)).toMatchObject({ [ME]: "in-call", [ANN]: "live-with-me" });
  });
});

// ── cards ───────────────────────────────────────────────────────────────────

describe("the card", () => {
  test("incoming while their burst plays, then open with a reply once it stops", () => {
    const playing = deriveFaceRow(
      input({ walkie: walkie(burstRoom(DM_ANN, "listen"), { incoming: { fromUserId: ANN, roomKey: DM_ANN } }) }),
      null,
    );
    expect(playing.card).toMatchObject({ kind: "incoming", from: ANN, name: "Ann", reply: false, join: true, snooze: true, words: { stage: "incoming" } });
    const stopped = deriveFaceRow(input({ walkie: walkie(burstRoom(DM_ANN, "listen"), { canReply: true }) }), playing);
    expect(stopped.card).toMatchObject({ kind: "incoming", from: ANN, reply: true, words: { stage: "open" } });
  });

  test("live while I talk: the walkie's words and what the roster says about them", () => {
    const row = deriveFaceRow(
      input({
        roster: [member(ME, "Me"), member(ANN, "Ann", { status: "busy" })],
        walkie: walkie(burstRoom(DM_ANN), { sending: sendingTo(DM_ANN) }),
        call: call(DM_ANN),
      }),
      null,
    );
    expect(row.card).toMatchObject({
      kind: "live",
      title: "Ann",
      mute: false,
      words: { stage: "live", badge: "TALKING" },
      hearing: { state: "busy" },
    });
    const heard = deriveFaceRow(
      input({ walkie: walkie(burstRoom(DM_ANN), { sending: sendingTo(DM_ANN) }), occupancy: { [DM_ANN]: [seat(ME), seat(ANN)] }, call: call(DM_ANN) }),
      row,
    );
    expect(heard.card).toMatchObject({ hearing: { state: "hears", text: "Ann hears you" } });
  });

  test("a ring at me outranks everything; my own ring out shows only when nothing else does", () => {
    const busy = deriveFaceRow(
      input({
        call: call(DM_ANN),
        occupancy: { [DM_ANN]: [seat(ME), seat(ANN)] },
        rings: { incoming: [{ from_user: BOB, room_key: DM_BOB, from_name: "Bob" }], outgoing: [] },
      }),
      null,
    );
    expect(busy.card).toMatchObject({ kind: "ring-in", from: BOB, name: "Bob", answer: true, decline: true });
    const ringing = deriveFaceRow(
      input({ rings: { incoming: [], outgoing: [{ to_user: CY, room_key: dmRoomKey(ME, CY), to_name: "Cy", status: "ringing" }] } }),
      null,
    );
    expect(ringing.card).toMatchObject({ kind: "ring-out", to: CY, name: "Cy", cancel: true, status: "ringing" });
    expect(ringing.me?.state).toBe("ringing-them");
  });

  test("a locked walkie call carries the on the line words and a mute", () => {
    const row = deriveFaceRow(
      input({ walkie: walkie(burstRoom(DM_ANN, "call")), occupancy: { [DM_ANN]: [seat(ME), seat(ANN)] }, call: call(DM_ANN, { muted: true }) }),
      null,
    );
    expect(row.card).toMatchObject({ kind: "live", mute: true, muted: true, words: { stage: "locked", badge: "ON THE LINE · MUTED" } });
    expect(row.me).toMatchObject({ muted: true, level: null });
  });
});

// ── selectors and the shared reader ─────────────────────────────────────────

describe("selectors", () => {
  test("isInHuddle: a call anywhere, never a burst with me (memberInHuddle's rule, on the row)", () => {
    // A seat in a call elsewhere wears the chip.
    const elsewhere = deriveFaceRow(
      input({ roster: [member(ME, "Me"), member(ANN, "Ann", { in_huddle: true, in_room_key: "channel:c1", seat: "call" })] }),
      null,
    );
    expect(isInHuddle(ANN, elsewhere)).toBe(true);
    // Their burst playing here, or my burst reaching them: a link and a ring, no chip.
    const theirs = deriveFaceRow(
      input({ walkie: walkie(burstRoom(DM_ANN, "listen"), { incoming: { fromUserId: ANN, roomKey: DM_ANN } }) }),
      null,
    );
    expect(isInCall(ANN, theirs)).toBe(true);
    expect(isInHuddle(ANN, theirs)).toBe(false);
    const mine = deriveFaceRow(
      input({ walkie: walkie(burstRoom(DM_ANN), { sending: sendingTo(DM_ANN) }), occupancy: { [DM_ANN]: [seat(ME), seat(ANN)] } }),
      null,
    );
    expect(isInHuddle(ANN, mine)).toBe(false);
    // The moment the room is a call, the chip is true again.
    const joined = deriveFaceRow(
      input({ walkie: walkie(burstRoom(DM_ANN, "call")), occupancy: { [DM_ANN]: [seat(ME), seat(ANN)] }, call: call(DM_ANN) }),
      mine,
    );
    expect(isInHuddle(ANN, joined)).toBe(true);
    // A ring is not a call yet.
    const ringing = deriveFaceRow(input({ rings: { incoming: [], outgoing: [{ to_user: ANN, room_key: DM_ANN, status: "ringing" }] } }), null);
    expect(isInHuddle(ANN, ringing)).toBe(false);
  });

  test("roomHeldAsBurst: my room while the links are the walkie's, never once it is a call", () => {
    const listening = deriveFaceRow(
      input({ walkie: walkie(burstRoom(DM_ANN, "listen"), { incoming: { fromUserId: ANN, roomKey: DM_ANN } }) }),
      null,
    );
    expect(roomHeldAsBurst(DM_ANN, listening)).toBe(true);
    expect(roomHeldAsBurst("dm:u-bob:u-me", listening)).toBe(false);
    const talking = deriveFaceRow(input({ walkie: walkie(burstRoom(DM_ANN), { sending: sendingTo(DM_ANN) }) }), null);
    expect(roomHeldAsBurst(DM_ANN, talking)).toBe(true);
    const joined = deriveFaceRow(
      input({ walkie: walkie(burstRoom(DM_ANN, "call")), occupancy: { [DM_ANN]: [seat(ME), seat(ANN)] }, call: call(DM_ANN) }),
      talking,
    );
    expect(roomHeldAsBurst(DM_ANN, joined)).toBe(false);
    expect(roomHeldAsBurst(DM_ANN, deriveFaceRow(input(), null))).toBe(false);
  });

  test("engagementOf answers offline for a stranger", () => {
    const row = deriveFaceRow(input({}), null);
    expect(engagementOf("u-nobody", row)).toBe("offline");
    expect(engagementOf(ANN, row)).toBe("online");
  });
});

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
