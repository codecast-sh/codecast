import { useRef } from "react";
import { toast } from "sonner";
import { useInboxStore, useTrackedStore } from "../store/inboxStore";
import { soundCallRing, soundCallDeclined } from "../lib/sounds";
import {
  notifyNative,
  getDesktopWindowRole,
  canRingInWindow,
  isCallRingWindow,
  openCallRingWindow,
} from "../lib/desktop";
import { acceptInvite, declineInvite } from "../lib/calls/callManager";
import { CALL_INVITE_TTL_MS, CALL_KNOCK_TTL_MS, CALL_RING_PERIOD_MS } from "@codecast/shared/contracts";

import { useMountEffect } from "./useMountEffect";
import { useWatchEffect } from "./useWatchEffect";
// THE RING HAS A WINDOW OF ITS OWN (route /call-ring, main.js
// createCallRingWindow), and it is the ring on every build that has one.
// A ring arrives unannounced, usually while the person is in another app
// entirely, so a card clipped to an app window is a phone ringing in a drawer.
// This hook keeps the SOUND and the native banner — both app-wide facts, not
// surfaces — and draws the in-app toast only where no ring window exists: a
// browser, or a desktop build that predates it. `canRingInWindow` is the test.
//
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

  useWatchEffect(() => {
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
      // The ring window is drawing this same card, over every app, and two
      // cards for one ring is one card too many. Only the TOAST stands down:
      // the native banner below is a fact about the machine, not a surface,
      // and it is what reaches somebody whose screen this window is not on.
      const inWindow = canRingInWindow();
      // The ring window is built on the first ring rather than at launch, so
      // this is where it comes into being: the app saw the invite, and the
      // shell cannot. Idempotent — a second ring finds the window already up.
      // Never from inside the ring window itself, which would be it asking
      // for itself.
      if (inWindow && !isCallRingWindow()) void openCallRingWindow();
      if (!inWindow) {
        toast.custom(
        () => (
          // ONE layout, and stacked, at every width — because the width that
          // matters is the CARD's, not the window's. Sonner caps a toast at
          // 356px, so putting the buttons beside the sentence leaves it about
          // 137px however wide the screen is: at 320px it broke "Jordan Lee
          // wants to huddle" over five lines, and at 1200px over three. The
          // buttons take a row of their own and the sentence gets the card.
          //
          // Equal halves, 128x34 each. The two answers to a ringing phone are
          // the same weight, and this card's usual home is a 320px window you
          // are reaching across the desk to hit.
          <div className="flex flex-col gap-2.5 rounded-lg border border-sol-border bg-sol-bg-alt px-3 py-2.5 shadow-lg">
            <div className="flex min-w-0 items-center gap-2.5">
              {invite.from_image ? (
                <img
                  src={invite.from_image}
                  alt=""
                  className="h-9 w-9 shrink-0 rounded-full object-cover ring-2 ring-sol-cyan/60"
                />
              ) : (
                // bg-sol-bg-highlight, matching MemberFace's fallback disc —
                // the one initial-avatar treatment in the app, and a themed
                // token. `sol-base02` is a Tailwind literal that never flips:
                // in dark it is byte-identical to this card and the disc
                // vanished, in light it was a black hole in a cream toast.
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-sol-bg-highlight text-sm text-sol-text-muted">
                  {(invite.from_name || "?").charAt(0).toUpperCase()}
                </div>
              )}
              <div className="min-w-0">
                <div className="text-sm font-medium leading-snug text-sol-text">
                  {invite.from_name} wants to huddle
                </div>
                {invite.anchor_title && (
                  <div className="truncate text-xs text-sol-text-muted">
                    {invite.anchor_title}
                  </div>
                )}
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={answer}
                // Filled, like every answer-the-call button ever made. The
                // tinted `bg-sol-green/20` it replaces put Solarized green
                // text on a green wash over a dark card and measured 3.13:1 —
                // under AA, on the one control the ring exists for. `sol-base03`
                // is a fixed literal on purpose here: the fill it sits on is a
                // fixed accent, so the pair must not drift with the theme.
                className="flex-1 rounded border border-sol-green bg-sol-green px-3 py-2 text-xs font-semibold text-sol-base03 transition-colors hover:bg-sol-green/90"
              >
                Join
              </button>
              <button
                onClick={decline}
                // The quiet half of the pair: no fill at rest, so "Join" is
                // the one filled thing on the card and the eye goes there. The
                // border keeps it a legible target at 320px, and Join carries
                // a matching one so the two boxes stay the same size.
                //
                // Full text colour, not muted. Hierarchy is carried by the
                // fill and the weight; dimming the LABEL of a button put it at
                // 4.39:1 on the light card, under AA for 12px, and "hard to
                // read" is not a way to say "secondary".
                className="flex-1 rounded border border-sol-border/60 px-3 py-2 text-xs text-sol-text transition-colors hover:bg-sol-bg-highlight"
              >
                Decline
              </button>
            </div>
          </div>
        ),
          { id: `ring:${invite._id}`, duration: CALL_INVITE_TTL_MS },
        );
      }
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
    // The ring window rings for itself — it is the surface showing the ring,
    // and a sound from every app window on top of it would be one phone
    // ringing four times.
    const shouldRing =
      !canRingInWindow() &&
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
  useWatchEffect(() => {
    for (const inv of outgoing) {
      if (inv.status === "declined" && !seenDeclines.current.has(String(inv._id))) {
        seenDeclines.current.add(String(inv._id));
        soundCallDeclined();
      }
    }
  }, [outgoing]);

  useMountEffect(
    () => () => {
      if (ringTimer.current) clearInterval(ringTimer.current);
    },
    []);
}
