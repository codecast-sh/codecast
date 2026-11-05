// Shared fixtures for the face row model tests (faceRow*.test.ts).
import { dmRoomKey } from "@codecast/shared/contracts";
import type { FaceMember, FaceRow, FaceRowInput } from "./faceRow";

export const NOW = 1_700_000_000_000;
export const ME = "u-me";
export const ANN = "u-ann";
export const BOB = "u-bob";
export const CY = "u-cy";
export const DM_ANN = dmRoomKey(ME, ANN);
export const DM_BOB = dmRoomKey(ME, BOB);

export function member(id: string, name: string, over: Partial<FaceMember> = {}): FaceMember {
  return { _id: id, name, presence_state: "active", ...over };
}

export function input(over: Partial<FaceRowInput> = {}): FaceRowInput {
  return {
    viewer: { id: ME, name: "Me" },
    roster: [member(ME, "Me"), member(ANN, "Ann"), member(BOB, "Bob"), member(CY, "Cy")],
    occupancy: {},
    liveRooms: [],
    walkie: { liveRoom: null, sending: null, incoming: null, canReply: false },
    call: { phase: "idle", roomKey: null, muted: true, micDenied: false, camera: false, speaking: [], cameras: [] },
    followLeaderId: null,
    rings: { incoming: [], outgoing: [] },
    announcement: null,
    unread: new Map(),
    now: NOW,
    ...over,
  };
}

export const seat = (id: string, over: Record<string, unknown> = {}) => ({ user_id: id, ...over });
export const walkie = (liveRoom: FaceRowInput["walkie"]["liveRoom"], over: Partial<FaceRowInput["walkie"]> = {}) => ({
  liveRoom,
  sending: null,
  incoming: null,
  canReply: false,
  ...over,
});
export const sendingTo = (roomKey: string, heardLive = true) => ({ roomKey, live: true, heardLive });
export const burstRoom = (key: string, mode: "burst" | "listen" | "call" = "burst") => ({ key, mode, since: NOW - 5_000 });
export const call = (roomKey: string, over: Partial<FaceRowInput["call"]> = {}) => ({
  phase: "connected",
  roomKey,
  muted: false,
  micDenied: false,
  camera: false,
  speaking: [],
  cameras: [],
  ...over,
});

export const states = (row: FaceRow) => Object.fromEntries(row.entries.map((e) => [e.id, e.state]));
export const order = (row: FaceRow) => row.entries.map((e) => e.id);
export const entry = (row: FaceRow, id: string) => row.entries.find((e) => e.id === id)!;
