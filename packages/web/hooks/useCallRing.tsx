import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useInboxStore, useTrackedStore } from "../store/inboxStore";
import { soundCallRing, soundCallDeclined } from "../lib/sounds";
import { notifyNative, getDesktopWindowRole } from "../lib/desktop";
import { acceptInvite, declineInvite } from "../lib/calls/callManager";
import { CALL_INVITE_TTL_MS, CALL_KNOCK_TTL_MS, CALL_RING_PERIOD_MS } from "@codecast/shared/contracts";

// Incoming huddle rings → toast + sound + native banner; outgoing declines →
// a quiet settle. Mounted once app-wide beside useChatToasts — a ring must
// reach someone who is NOT looking at the team strip.
//
// The ring is sync-driven: myCalls.incoming holds the live ringing invites and
// this hook diffs arrivals/departures against what it already reacted to. The
// ring SOUND loops here (one cycle per interval) so dismissing the invite —
// answered anywhere, cancelled by the caller, or expired server-side — stops
// it on the next sync with no teardown protocol.

export function useCallRing(): void {
  const s = useTrackedStore([
    (st: any) => st.myCalls.incoming.map((i: any) => i._id).join("|"),
    (st: any) =>
      st.myCalls.outgoing.map((i: any) => `${i._id}:${i.status}`).join("|"),
  ]);
  const ringTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const seenInvites = useRef<Set<string>>(new Set());
  const seenDeclines = useRef<Set<string>>(new Set());
  // Rings we answered ourselves (a door we knocked on): they stay in `incoming`
  // until the server marks them accepted, and must not ring meanwhile.
  const autoAccepted = useRef<Set<string>>(new Set());

  const incoming: any[] = s.myCalls.incoming;
  const outgoing: any[] = s.myCalls.outgoing;

  useEffect(() => {
    const me = useInboxStore.getState().currentUser;
    // Manual "busy" is the closed door: the toast still appears (a silent,
    // dismissable card), but no sound and no native banner.
    const quiet = me?.status === "busy";
    // "In a call" is app-wide on the desktop: the media plane lives in ONE
    // window, and a second window must not ring over a huddle it cannot see.
    const inCall =
      useInboxStore.getState().call.phase === "connected" || getDesktopWindowRole().anyInCall;

    const knocked: Record<string, number> = useInboxStore.getState().callKnocked ?? {};
    for (const invite of incoming) {
      if (seenInvites.current.has(String(invite._id))) continue;
      seenInvites.current.add(String(invite._id));
      // A ring into a room I just knocked at IS the door opening, so it opens:
      // making someone answer a ring for a door they knocked on would be a
      // second question they already answered. The knock's own TTL bounds it,
      // so a much later ring from that room still rings normally.
      const at = knocked[invite.room_key];
      if (at !== undefined && Date.now() - at < CALL_KNOCK_TTL_MS) {
        useInboxStore.getState().clearKnock(invite.room_key);
        autoAccepted.current.add(String(invite._id));
        void acceptInvite(String(invite._id), invite.room_key);
        continue;
      }
      const answer = () => {
        toast.dismiss(`ring:${invite._id}`);
        void acceptInvite(String(invite._id), invite.room_key);
      };
      const decline = () => {
        toast.dismiss(`ring:${invite._id}`);
        void declineInvite(String(invite._id));
      };
      toast.custom(
        () => (
          <div className="flex items-center gap-3 rounded-lg border border-sol-border bg-sol-bg-alt px-4 py-3 shadow-lg">
            {invite.from_image ? (
              <img
                src={invite.from_image}
                alt=""
                className="h-9 w-9 rounded-full object-cover ring-2 ring-sol-cyan/60"
              />
            ) : (
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-sol-base02 text-sm text-sol-text-muted">
                {(invite.from_name || "?").charAt(0).toUpperCase()}
              </div>
            )}
            <div className="min-w-0">
              <div className="text-sm font-medium text-sol-text">
                {invite.from_name} wants to huddle
              </div>
              {invite.anchor_title && (
                <div className="truncate text-xs text-sol-text-muted">
                  {invite.anchor_title}
                </div>
              )}
            </div>
            <div className="ml-2 flex shrink-0 gap-2">
              <button
                onClick={answer}
                className="rounded bg-sol-green/20 px-3 py-1.5 text-xs font-medium text-sol-green transition-colors hover:bg-sol-green/30"
              >
                Join
              </button>
              <button
                onClick={decline}
                className="rounded bg-sol-base02 px-3 py-1.5 text-xs text-sol-text-muted transition-colors hover:text-sol-text"
              >
                Decline
              </button>
            </div>
          </div>
        ),
        { id: `ring:${invite._id}`, duration: CALL_INVITE_TTL_MS },
      );
      if (!quiet && !inCall) {
        // `key` collapses the ring reported by every desktop window into one
        // banner; `kind` sends its click to the window with the call UI.
        void notifyNative(
          `${invite.from_name} wants to huddle`,
          invite.anchor_title || "Tap to join",
          { key: `ring:${invite._id}`, kind: "call" },
        );
      }
    }

    // Prune reactions for invites that stopped ringing so the same pair can
    // ring again later, and drop their toasts.
    const liveIds = new Set(incoming.map((i: any) => String(i._id)));
    for (const id of [...seenInvites.current]) {
      if (!liveIds.has(id)) {
        seenInvites.current.delete(id);
        autoAccepted.current.delete(id);
        toast.dismiss(`ring:${id}`);
      }
    }

    // The loop: one ring cycle per period while anything is ringing and we're
    // not the quiet door.
    const shouldRing =
      incoming.some((i: any) => !autoAccepted.current.has(String(i._id))) && !quiet && !inCall;
    if (shouldRing && !ringTimer.current) {
      soundCallRing();
      ringTimer.current = setInterval(soundCallRing, CALL_RING_PERIOD_MS);
    } else if (!shouldRing && ringTimer.current) {
      clearInterval(ringTimer.current);
      ringTimer.current = null;
    }
  }, [incoming, outgoing]);

  // Outgoing ring settled as a decline → one soft note, once per invite.
  useEffect(() => {
    for (const inv of outgoing) {
      if (inv.status === "declined" && !seenDeclines.current.has(String(inv._id))) {
        seenDeclines.current.add(String(inv._id));
        soundCallDeclined();
      }
    }
  }, [outgoing]);

  useEffect(
    () => () => {
      if (ringTimer.current) clearInterval(ringTimer.current);
    },
    [],
  );
}
