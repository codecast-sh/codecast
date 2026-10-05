import type { useConvex } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { guestIdentity, humanizeConvexError } from "@codecast/shared/contracts";
import { publicUrl } from "@codecast/shared/entities";
import { useInboxStore } from "../../store/inboxStore";
import { isRefusedDispatchError } from "../../store/mutativeMiddleware";

// The room's gestures on a guest (components/calls/GuestDoor draws them on
// the web, packages/mobile/components/calls/GuestDoor on a phone).
//
// Answering one (admit, deny, remove) is a store action: it paints in the
// frame it is pressed, on every surface of the window (the door, the knock's
// toast, the faces), and rides a dispatch to callGuests' mutation. A refusal
// puts the row back and is said through the caller's `onRefused`, in words
// about the guest: the web passes a toast, the phone an alert. Both surfaces
// answer through these, so which failures are spoken and what is put back
// stay one rule.
//
// A link is the one gesture that cannot paint first: its token is minted by
// the server, and the panel shows it in flight ("Making a link…").
//
// Read by Metro too: relative imports only, and nothing web-only (no toast
// library), as CLAUDE.md's mobile bundle section says.

export type Convex = ReturnType<typeof useConvex>;
export type OnRefused = (message: string) => void;

/** Say why an answer was refused. Only a refusal: an answer that is merely
 *  delayed (parked for the next dispatch binding, a transient failure the
 *  outbox drives again) is still on its way, and saying it failed would be
 *  false (a flaky cell link makes that common on a phone). */
function refused(fallback: string, onRefused: OnRefused, undo?: () => void) {
  return (err: unknown) => {
    if (!isRefusedDispatchError(err)) return;
    undo?.();
    onRefused(humanizeConvexError(err, fallback));
  };
}

/** Let a guest in, under the name the door showed whoever pressed. */
export function admitGuest(guestId: string, name: string, onRefused: OnRefused): Promise<void> {
  return useInboxStore.getState().admitGuestKnock(guestId, name).then(() => {}, refused("Could not let them in", onRefused));
}

/** Turn a guest away at the door, optionally closing the link they came on. */
export function denyGuest(guestId: string, revokeLink: boolean, onRefused: OnRefused): Promise<void> {
  return useInboxStore.getState().denyGuestKnock(guestId, revokeLink).then(() => {}, refused("Could not turn them away", onRefused));
}

/** Put a guest out of the call, optionally closing the link they came on.
 *  The store's action takes them off the faces and restores nothing itself
 *  (liveRooms is server truth, so it holds no lock to lift), so a refusal
 *  puts back the row this press took. */
export function removeGuest(roomKey: string, guestId: string, revokeLink: boolean, onRefused: OnRefused): Promise<void> {
  const st = useInboxStore.getState();
  const identity = guestIdentity(guestId);
  const was = (st.liveRooms ?? []).find((r: any) => r?.room_key === roomKey)?.guests?.find((g: any) => g.identity === identity);
  const snapshot = was ? JSON.parse(JSON.stringify(was)) : null;
  return st
    .removeCallGuest(roomKey, guestId, revokeLink)
    .then(
      () => {},
      refused("Could not remove them", onRefused, snapshot ? () => useInboxStore.getState().restoreCallGuest(roomKey, snapshot) : undefined),
    );
}

/** The room's link gestures, bound to a client: each one mutation, each with
 *  its own failure words, said through `onFailed`. */
export function guestDoorActions(convex: Convex, onFailed: OnRefused) {
  const attempt = async <T,>(fallback: string, run: () => Promise<T>): Promise<T | null> => {
    try {
      return await run();
    } catch (err) {
      onFailed(humanizeConvexError(err, fallback));
      return null;
    }
  };
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
  return publicUrl(path);
}
