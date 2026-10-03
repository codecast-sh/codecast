import type { useConvex } from "convex/react";
import { toast } from "sonner";
import { api } from "@codecast/convex/convex/_generated/api";
import { guestIdentity, humanizeConvexError } from "@codecast/shared/contracts";
import { useInboxStore } from "../../store/inboxStore";
import { isRefusedDispatchError } from "../../store/mutativeMiddleware";
import { sharePageUrl } from "../utils";

// The room's gestures on a guest (components/calls/GuestDoor draws them).
//
// Answering one (admit, deny, remove) is a store action: it paints in the
// frame it is pressed, on every surface of the window (the door, the knock's
// toast, the faces), and rides a dispatch to callGuests' mutation. A refusal
// puts the row back and is said here, in words about the guest.
//
// A link is the one gesture that cannot paint first: its token is minted by
// the server, and the panel shows it in flight ("Making a link…").

export type Convex = ReturnType<typeof useConvex>;

async function attempt<T>(fallback: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (err) {
    toast.error(humanizeConvexError(err, fallback));
    return null;
  }
}

/** Say why an answer was refused. Only a refusal: an answer that is merely
 *  delayed (parked for the next dispatch binding, a transient failure the
 *  outbox drives again) is still on its way. */
function refused(fallback: string, undo?: () => void) {
  return (err: unknown) => {
    if (!isRefusedDispatchError(err)) return;
    undo?.();
    toast.error(humanizeConvexError(err, fallback));
  };
}

/** Let a guest in, under the name the door showed whoever pressed. */
export function admitGuest(guestId: string, name: string): void {
  void useInboxStore.getState().admitGuestKnock(guestId, name).catch(refused("Could not let them in"));
}

/** Turn a guest away at the door, optionally closing the link they came on. */
export function denyGuest(guestId: string, opts?: { revokeLink?: boolean }): void {
  void useInboxStore.getState().denyGuestKnock(guestId, !!opts?.revokeLink).catch(refused("Could not turn them away"));
}

/** Put a guest out of the call, optionally closing the link they came on. */
export function removeGuest(roomKey: string, guestId: string, opts?: { revokeLink?: boolean }): void {
  const st = useInboxStore.getState();
  const identity = guestIdentity(guestId);
  const was = (st.liveRooms ?? []).find((r: any) => r?.room_key === roomKey)?.guests?.find((g: any) => g.identity === identity);
  const snapshot = was ? JSON.parse(JSON.stringify(was)) : null;
  void st
    .removeCallGuest(roomKey, guestId, !!opts?.revokeLink)
    .catch(refused("Could not remove them", snapshot ? () => useInboxStore.getState().restoreCallGuest(roomKey, snapshot) : undefined));
}

/** The room's link gestures, bound to a client: each one mutation, each with
 *  its own failure words. */
export function guestDoorActions(convex: Convex) {
  return {
    createLink: (roomKey: string, opts?: { ttlMs?: number; fresh?: boolean }) =>
      attempt("Could not make a guest link", () =>
        convex.mutation(api.callGuests.createGuestLink, {
          room_key: roomKey,
          ...(opts?.ttlMs !== undefined ? { ttl_ms: opts.ttlMs } : {}),
          ...(opts?.fresh ? { fresh: true } : {}),
        }),
      ),
    revokeLink: (linkId: string) =>
      attempt("Could not turn the link off", () => convex.mutation(api.callGuests.revokeGuestLink, { link_id: linkId as any })),
  };
}

/** The absolute address of a guest link: the public web, whichever window
 *  (a desktop pane, localhost) the link was made in. */
export function guestLinkUrl(path: string): string {
  return sharePageUrl(path);
}
