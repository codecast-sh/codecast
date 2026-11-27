// Calls in the Personal workspace: whether huddles show at all, which calls
// and live rooms Personal lists, and where a call's tasks are filed.
import { describe, expect, test } from "bun:test";
import { callsAvailableIn } from "../teamFeatures";
import { callIsPrivate, callOnlyMine, liveRoomOnlyMine } from "../calls/personalCalls";
import { roomIsOwnerOnly, roomIsPrivate } from "../faces/faceRowSigs";
import { ownRouteHeldFrom } from "../calls/ownRoute";

const ME = "u-me";
const ANN = "u-ann";

describe("useCallsAvailable", () => {
  // The hook is useInboxStore(callsAvailableIn): the rule, read off a state.
  const read = (teams: any[], activeTeamId: string | null, enabled = true) =>
    callsAvailableIn({ teams, callConfig: { enabled }, clientState: { ui: { active_team_id: activeTeamId } } });
  const on = { _id: "t-on", features: { calls: true } };
  const off = { _id: "t-off", features: { calls: false } };

  test("Personal borrows calls from any team that has them on", () => {
    expect(read([off, on], null)).toBe(true);
  });
  test("Personal has no calls when none of the viewer's teams does", () => {
    expect(read([off], null)).toBe(false);
    expect(read([], null)).toBe(false);
  });
  test("a team workspace reads its own flag only", () => {
    expect(read([off, on], "t-off")).toBe(false);
    expect(read([off, on], "t-on")).toBe(true);
  });
  test("a deployment with no calls behind it has none anywhere", () => {
    expect(read([on], null, false)).toBe(false);
  });
  test("a team whose calls vendor is not covered lends Personal nothing", () => {
    const clinic = { _id: "t-reg", name: "Clinic", features: { calls: true }, policy: { regulated_data: true } };
    expect(read([clinic], "t-reg")).toBe(false);
    expect(read([clinic], null)).toBe(false);
    expect(read([clinic, on], null)).toBe(true);
  });
});

describe("the calls only the viewer can read", () => {
  const row = (over: Record<string, unknown>) => ({ room_key: "", started_by: ME, rec_shared: false, participants: [], ...over });

  test("a room of one is yours alone", () => {
    expect(callOnlyMine(row({ room_key: `dm:${ME}` }), ME)).toBe(true);
    expect(callIsPrivate(row({ room_key: `dm:${ME}` }), ME)).toBe(true);
  });
  test("your own recording until you share it into a team", () => {
    expect(callOnlyMine(row({ room_key: "rec:abcdef12" }), ME)).toBe(true);
    expect(callOnlyMine(row({ room_key: "rec:abcdef12", rec_shared: true }), ME)).toBe(false);
    expect(callOnlyMine(row({ room_key: "rec:abcdef12", started_by: ANN }), ME)).toBe(false);
  });
  test("a private session huddle with nobody else in it", () => {
    const solo = row({ room_key: "session:c1", private: true, participants: [{ id: ME }] });
    expect(callOnlyMine(solo, ME)).toBe(true);
    expect(callOnlyMine({ ...solo, participants: [{ id: ME }, { id: ANN }] }, ME)).toBe(false);
    expect(callOnlyMine({ ...solo, private: false }, ME)).toBe(false);
    // The session's agent speaking in it keeps it yours.
    expect(callOnlyMine({ ...solo, participants: [{ id: ME }, { id: "agent:c1" }] }, ME)).toBe(true);
  });
  test("team calls and people rooms with somebody else are not Personal's", () => {
    expect(callOnlyMine(row({ room_key: "channel:ch1" }), ME)).toBe(false);
    expect(callOnlyMine(row({ room_key: `dm:${ANN}:${ME}`, private: true }), ME)).toBe(false);
    expect(callOnlyMine(row({ room_key: "session:c1", participants: [{ id: ME }] }), ME)).toBe(false);
  });
  test("a private call with others still files its tasks in Personal; a team call does not", () => {
    expect(callIsPrivate(row({ room_key: `dm:${ANN}:${ME}`, private: true }), ME)).toBe(true);
    expect(callIsPrivate(row({ room_key: "channel:ch1" }), ME)).toBe(false);
    expect(callIsPrivate(row({ room_key: `dm:${ME}` }), "")).toBe(false);
  });
});

describe("Personal's Live now", () => {
  const room = (over: Record<string, unknown>) => ({ roomKey: "", private: false, members: [{ user_id: ME }], ...over });
  test("your room of one and a private room you sit in alone", () => {
    expect(liveRoomOnlyMine(room({ roomKey: `dm:${ME}` }), ME)).toBe(true);
    expect(liveRoomOnlyMine(room({ roomKey: "session:c1", private: true }), ME)).toBe(true);
  });
  test("not a team room, nor a private room with somebody else in it", () => {
    expect(liveRoomOnlyMine(room({ roomKey: "session:c1" }), ME)).toBe(false);
    expect(liveRoomOnlyMine(room({ roomKey: "session:c1", private: true, members: [{ user_id: ME }, { user_id: ANN }] }), ME)).toBe(false);
  });
});

describe("a room only its owner may enter", () => {
  const SOLO = "session:c1";
  // getLiveRooms' flags, as applyLiveRoomsPush files them in callRooms.
  const st = (over: Record<string, unknown> = {}) => ({
    currentUser: { _id: ME },
    callRooms: { [SOLO]: { private: true, locked: false } },
    sessions: { c1: { _id: "c1", user_id: ME } },
    ...over,
  });

  test("private with no lock: only its owner's, and its door is fixed", () => {
    expect(roomIsOwnerOnly(st(), SOLO)).toBe(true);
    expect(roomIsPrivate(st(), SOLO)).toBe(true);
  });
  test("a huddle started private is locked, so never owner-only; opened, it is ordinary", () => {
    expect(roomIsOwnerOnly(st({ callRooms: { [SOLO]: { private: true, locked: true } } }), SOLO)).toBe(false);
    expect(roomIsPrivate(st({ callRooms: { [SOLO]: { private: true, locked: true } } }), SOLO)).toBe(true);
    expect(roomIsPrivate(st({ callRooms: { [SOLO]: { private: false, locked: false } } }), SOLO)).toBe(false);
  });
  test("the session's own route is held from everyone but its owner", () => {
    expect(ownRouteHeldFrom(st(), SOLO)).toBeNull();
    expect(ownRouteHeldFrom(st({ currentUser: { _id: ANN } }), SOLO)).toBe("c1");
    // Somebody rung in who cannot read the session has no row for it.
    expect(ownRouteHeldFrom(st({ currentUser: { _id: ANN }, sessions: {} }), SOLO)).toBe("c1");
    // A team-visible session's room holds nothing back.
    expect(ownRouteHeldFrom(st({ currentUser: { _id: ANN }, callRooms: {} }), SOLO)).toBeNull();
  });
});
