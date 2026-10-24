"use client";

// /call-ring — an incoming huddle as a window of its own.
//
// A ring is the one huddle surface that arrives UNANNOUNCED, so it was the
// last one still drawn inside the app: a sonner toast in whichever window
// happened to be open, clipped to that window's edges and invisible when the
// person was in another app entirely. A ringing phone you have to go and find
// is not a ringing phone.
//
// The shell gives this route the same kind of window the record-this-meeting
// offer gets (main.js createCallRingWindow): small, frameless, always on top,
// over a fullscreen app, and revealed with showInactive so it NEVER takes the
// keyboard. The card sizes the window around itself (callRingSize), which is
// also the reveal signal — a ring landing in a still-booting window shows
// exactly when there is something to answer.
//
// ANSWERING DOES NOT HAPPEN HERE. `acceptInvite` joins the media in whichever
// renderer calls it, and the media plane is a per-renderer singleton — so
// answering in this 340px card would put the huddle in a corner window with no
// stage, no roster and no controls. Join hands the invite to the call window
// (callRingAnswer), which is where every other huddle surface already lives.
// Decline is the one verb this window owns outright: it ends the ring and
// nothing has to move.
//
// Join first grows the card into the camera and microphone check (unless the
// person turned it off, lib/calls/joinPrefs): the ring goes quiet, the card
// shows their camera, a mic meter and the devices, and the check's own Join is
// the hand-off. Device picks write the person's prefs, which is what the call
// window opens. The preview closes before the hand-off, so the call window
// opens the devices fresh. The moment the hand-off goes, this window stops
// showing the ring (settleRing) rather than waiting for the server.
//
// The root carries the `dark` class: this floats over the desktop, and theme
// tokens on dark glass invert to navy-on-navy in light mode (the call stage
// learned this the loud way).
import { forwardRef, useRef, useState } from "react";
import { AuthGuard } from "../../components/AuthGuard";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { useEnsureDispatch } from "../../hooks/useEnsureDispatch";
import { useCallSync } from "../../hooks/useCallSync";
import { useSyncTeams } from "../../hooks/useSyncTeams";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { declineInvite, settleRing } from "../../lib/calls/callManager";
import { readJoinPrefs, rememberDeviceCheck } from "../../lib/calls/joinPrefs";
import { PreviewBody } from "../../components/calls/HuddleStartDialog";
import { usePreview } from "../../hooks/useGuestPreview";
import { voiceHostShowsRing } from "../../lib/calls/walkie";
import { useWalkieStatus } from "../../hooks/useWalkie";
import { useDesktopWindowRole } from "../../hooks/useDesktopWindowRole";
import { callRingAnswer, callRingHide, callRingSize } from "../../lib/desktop";
import { soundCallRing } from "../../lib/sounds";
import { RingCard, type RingInvite } from "../../components/calls/RingCard";
import { CALL_RING_PERIOD_MS } from "@codecast/shared/contracts";

export default function CallRingPage() {
  return (
    <AuthGuard>
      {/* Each half behind its own boundary: a Convex query that throws here
          must degrade to "no ring", never to a dead always-on-top window
          sitting over somebody's screen. */}
      <ErrorBoundary name="Call ring sync" level="inline" fallback={null}>
        <CallRingSync />
      </ErrorBoundary>
      <ErrorBoundary name="Call ring" level="inline" fallback={null}>
        <div className="dark h-screen w-screen text-sol-text">
          <CallRingRoot />
        </div>
      </ErrorBoundary>
    </AuthGuard>
  );
}

// The short pump list, the same reasoning as the call panel's: this window is
// not the app. It needs the call plane (which is what fills myCalls) and the
// teams collection that gates every call affordance, and nothing else.
function CallRingSync() {
  useEnsureDispatch();
  useSyncTeams();
  useCallSync();
  return null;
}

function CallRingRoot() {
  const s = useTrackedStore([
    (st: any) => st.myCalls.incoming.map((i: any) => i._id).join("|"),
  ]);
  const incoming: any[] = s.myCalls?.incoming ?? [];
  // Subscribed for their changes: both feed voiceHostShowsRing below, and a
  // window that only re-rendered on the invite would keep drawing a card the
  // host took over, or miss one it stood down from.
  useWalkieStatus();
  useDesktopWindowRole();
  // The oldest live ring: two people calling at once is rare, and a stack of
  // cards in a 340px window is worse than answering them one at a time.
  //
  // Only when no voice host is showing it. This window is built on the first
  // ring and lives on, so from then on it sees every invite — and on a shell
  // with a voice host, that host draws the ring itself whenever the person is
  // not in a call of their own. Two cards for one ring is one too many, so
  // this window is the ring exactly when the host's stage is up.
  const invite = voiceHostShowsRing() ? null : (incoming[0] ?? null);

  // The window is exactly as big as the card, and the report is what reveals
  // it. Measured rather than assumed: an avatar that fails to load and a long
  // name change the height, and a card clipped by its own window would hide
  // the two buttons this surface exists for.
  const cardRef = useRef<HTMLDivElement | null>(null);
  useWatchEffect(() => {
    const el = cardRef.current;
    if (!el || !invite) return;
    const report = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) callRingSize({ width: r.width, height: r.height });
    };
    report();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [invite]);

  // Nothing ringing: hide the window rather than leave an empty pane of glass
  // floating over the work. The shell keeps the window alive, so the next ring
  // shows without paying for a page load.
  useWatchEffect(() => {
    if (!invite) callRingHide();
  }, [invite]);

  // The ring sound belongs to whichever surface is showing the ring, and this
  // window is it. One cycle per period, stopped by the invite going away —
  // answered anywhere, cancelled by the caller, or expired server-side — so
  // there is no teardown protocol to get wrong.
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const checking = !!invite && checkingId === String(invite._id);
  const quiet = useInboxStore((st) => st.currentUser?.status === "busy") || checking;
  useWatchEffect(() => {
    if (!invite || quiet) return;
    let cycle = 0;
    soundCallRing(cycle, String(invite._id));
    const t = setInterval(() => soundCallRing(++cycle, String(invite._id)), CALL_RING_PERIOD_MS);
    return () => clearInterval(t);
  }, [invite?._id, quiet]);

  if (!invite) return null;
  const answer = () => {
    callRingAnswer(String(invite._id), String(invite.room_key));
    settleRing(String(invite._id));
  };
  const decline = () => void declineInvite(String(invite._id));
  if (checking) return <RingCheck ref={cardRef} invite={invite} onAnswer={answer} onDecline={decline} />;
  return (
    <RingCard
      ref={cardRef}
      invite={invite}
      onAnswer={() => (readJoinPrefs().deviceCheck ? setCheckingId(String(invite._id)) : answer())}
      onDecline={decline}
    />
  );
}

// The check, inside the ring card. One preview for as long as it is up: the
// caller hanging up takes the card down, and the preview with it.
const RingCheck = forwardRef<HTMLDivElement, { invite: RingInvite; onAnswer: () => void; onDecline: () => void }>(
  function RingCheck({ invite, onAnswer, onDecline }, ref) {
    const preview = usePreview();
    const [skipNext, setSkipNext] = useState(false);
    const join = () => {
      preview?.dispose();
      if (skipNext) rememberDeviceCheck(false);
      onAnswer();
    };
    return (
      <RingCard ref={ref} invite={invite} onAnswer={join} onDecline={onDecline}>
        {preview && <PreviewBody preview={preview} flush />}
        <label className="flex cursor-pointer select-none items-center gap-2 text-xs text-sol-text-muted hover:text-sol-text">
          <input
            type="checkbox"
            checked={skipNext}
            onChange={(e) => setSkipNext(e.target.checked)}
            className="h-3.5 w-3.5 cursor-pointer rounded border-sol-border bg-sol-bg accent-sol-violet"
          />
          Skip this check next time
        </label>
      </RingCard>
    );
  },
);
