// Every huddle START passes through one confirm step: the person sees their
// camera, hears their microphone move a meter, picks devices, and only then
// rings anyone. A join into a room that is already live stays one press; the
// people in it are waiting.
//
// The request is a plain subscribe/snapshot value, not store state: it is a
// window's open dialog, nothing any other window or the server should know.
import { useSyncExternalStore } from "react";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useInboxStore } from "../../store/inboxStore";
import { joinCall, startHuddle } from "./actions";

export type HuddleStartRequest = {
  roomKey: string;
  /** People rung the moment the room opens. */
  toUserIds?: string[];
  /** The ring toast's "about:" line, and the dialog's name for the room. */
  anchorTitle?: string;
  /** Buzz everyone in the channel. */
  ringChannel?: boolean;
  /** For a channel: how many members the buzz reaches. */
  channelMemberCount?: number;
  /** What this room's huddle is for, when it is more than "talk here". */
  hint?: string;
};

let pending: HuddleStartRequest | null = null;
// Windows that draw the dialog (the dashboard, the people window). A window
// without one, like the see-through faces float, starts at once rather than
// queueing a dialog nobody can see.
let hosts = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

export function requestHuddleStart(req: HuddleStartRequest): void {
  const ringing = !!req.toUserIds?.length || !!req.ringChannel;
  if (!ringing && (useInboxStore.getState().callOccupancy[req.roomKey]?.length ?? 0) > 0) {
    void joinCall(req.roomKey, { intent: "deliberate" });
    return;
  }
  if (hosts === 0) return runHuddleStart(req);
  pending = req;
  emit();
}

export function closeHuddleStart(): void {
  pending = null;
  emit();
}

/** The confirm was pressed: start what was asked for. */
export function runHuddleStart(req: HuddleStartRequest): void {
  closeHuddleStart();
  if (req.toUserIds?.length || req.ringChannel) {
    void startHuddle({ roomKey: req.roomKey, toUserIds: req.toUserIds ?? [], anchorTitle: req.anchorTitle, ringChannel: req.ringChannel });
  } else {
    void joinCall(req.roomKey, { intent: "deliberate" });
  }
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
const snapshot = () => pending;

/** For the one component per window that draws the dialog. */
export function useHuddleStartRequest(): HuddleStartRequest | null {
  useMountEffect(() => {
    hosts++;
    return () => {
      hosts--;
    };
  });
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
