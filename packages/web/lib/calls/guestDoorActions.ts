import type { useConvex } from "convex/react";
import { toast } from "sonner";
import { api } from "@codecast/convex/convex/_generated/api";
import { humanizeConvexError } from "@codecast/shared/contracts";
import { sharePageUrl } from "../utils";

// The room's gestures on a guest (components/calls/GuestDoor draws them):
// each one mutation, each with its own words when it fails. None paints
// before the server answers (GuestDoor says why), so a failure is a toast and
// the caller's own in-flight state, never a rollback.

export type Convex = ReturnType<typeof useConvex>;

async function attempt<T>(fallback: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (err) {
    toast.error(humanizeConvexError(err, fallback));
    return null;
  }
}

/** The room's answers to a guest, each with its own failure words. */
export function guestDoorActions(convex: Convex) {
  return {
    admit: (guestId: string, name: string) =>
      attempt("Could not let them in", () => convex.mutation(api.callGuests.admitGuest, { guest_id: guestId, name })),
    deny: (guestId: string, opts?: { revokeLink?: boolean }) =>
      attempt("Could not turn them away", () =>
        convex.mutation(api.callGuests.denyGuest, { guest_id: guestId, ...(opts?.revokeLink ? { revoke_link: true } : {}) }),
      ),
    remove: (guestId: string, opts?: { revokeLink?: boolean }) =>
      attempt("Could not remove them", () =>
        convex.mutation(api.callGuests.removeGuest, { guest_id: guestId, ...(opts?.revokeLink ? { revoke_link: true } : {}) }),
      ),
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
