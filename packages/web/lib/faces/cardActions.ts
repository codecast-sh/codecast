import type { FaceCard } from "./faceRow";
import { acceptInvite, cancelOutgoing, declineInvite, leaveCall, setCamera, setMuted } from "../calls/callManager";
import { endWalkie, getWalkieStatus, joinWalkieLive, shutWalkieDoor } from "../calls/walkie";
import { useInboxStore } from "../../store/inboxStore";
export type Incoming = Extract<FaceCard, { kind: "incoming" }>;
export type Live = Extract<FaceCard, { kind: "live" | "joined-notice" }>;
export type RingIn = Extract<FaceCard, { kind: "ring-in" }>;
export type RingOut = Extract<FaceCard, { kind: "ring-out" }>;

/** What each button asks for. The engine's answers are `ENGINE_CARD_ACTIONS`;
 *  a test hands in its own and reads what was pressed. */
export type CardActions = {
  join: (card: Incoming) => void;
  snooze: (card: Incoming) => void;
  end: (card: Live) => void;
  /** Toggles: the card says whether it is muted now. */
  mute: (card: Live) => void;
  /** Toggles: the card says whether the camera is on now. */
  camera: (card: Live) => void;
  answer: (card: RingIn) => void;
  decline: (card: RingIn) => void;
  cancel: (card: RingOut) => void;
};

/** An hour: the walkie's snooze, the same number the strip's Snooze wrote. */
export const WALKIE_SNOOZE_MS = 60 * 60 * 1000;

/** The buttons, wired to the engine. A ring's invite row is looked up by the
 *  room and the person the model named, because the model carries no ids. */
export const ENGINE_CARD_ACTIONS: CardActions = {
  join: (c) => void joinWalkieLive(c.roomKey, { name: c.name }),
  // SNOOZE: the mic closes, the seat goes back (which is what stops the
  // voice), and the hour is written so the door stays shut everywhere.
  snooze: () => {
    useInboxStore.getState().snoozeWalkie(Date.now() + WALKIE_SNOOZE_MS);
    void setMuted(true, { remember: false });
    shutWalkieDoor();
  },
  // END: the walkie's own End while it holds the room (no linger after a hang
  // up); an ordinary leave for a huddle.
  end: (c) => {
    if (getWalkieStatus().liveRoom?.key === c.roomKey) void endWalkie();
    else void leaveCall(c.roomKey);
  },
  mute: (c) => void setMuted(!c.muted),
  camera: (c) => void setCamera(!c.cameraOn),
  answer: (c) => {
    const inv = inviteIn(c);
    if (inv) void acceptInvite(String(inv._id), c.roomKey);
  },
  decline: (c) => {
    const inv = inviteIn(c);
    if (inv) void declineInvite(String(inv._id));
  },
  cancel: (c) => {
    const inv = inviteOut(c);
    if (inv) void cancelOutgoing(String(inv._id));
  },
};

function inviteIn(c: RingIn): { _id: unknown } | undefined {
  const rows: any[] = useInboxStore.getState().myCalls?.incoming ?? [];
  return rows.find((r) => r.room_key === c.roomKey && String(r.from_user) === c.from);
}

function inviteOut(c: RingOut): { _id: unknown } | undefined {
  const rows: any[] = useInboxStore.getState().myCalls?.outgoing ?? [];
  return rows.find((r) => r.room_key === c.roomKey && String(r.to_user) === c.to);
}

export function sentence(badge: string): string {
  const low = badge.toLowerCase();
  return low.charAt(0).toUpperCase() + low.slice(1);
}
