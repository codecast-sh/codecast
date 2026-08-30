"use client";

// /meeting-offer — the meeting-detection offer as a window of its own.
//
// The desktop shell (main.js createMeetingOfferWindow) gives this route a
// small frameless always-on-top window in the top-right corner of the screen
// and sends it the offers the meeting poller raises. It is the palette's
// polite sibling: summoned by a machine rather than a keystroke, so it is
// revealed with showInactive and NEVER takes focus — the person it appears to
// is joining a meeting, and a card stealing their keystrokes is worse than no
// card at all. The window is exactly as big as its content: this page reports
// its size (meetingOfferSize) and the shell reshapes the window around it,
// which is also the reveal signal on first paint.
//
// Every face starts TINY — a one-line capsule, the size of a system
// notification — and expands on a click of its body:
//   offer     [mic] FaceTime  (Record) (x)   → the full question: copy, plus
//             Not now and Never for this app. A chime when it appears.
//   recording [dot] 12:04 ▮▮▮ (stop)         → the last words heard, the
//             open-transcript jump, proof the microphone works. The recording
//             runs IN THIS WINDOW (the same per-window recorder engine every
//             surface uses), so the capsule is the floating stop button.
//
// NOTHING STARTS WITHOUT AN ANSWER: in ask mode the microphone is opened by
// the Record button and by nothing else. An auto offer is the person having
// answered in advance, in the setting — it starts at once and this window
// says so instead of asking.
//
// The root carries the `dark` class: this surface floats over the desktop,
// and theme tokens on a dark glass invert to navy-on-navy in light mode (the
// call stage learned this the loud way).
//
// In-app toasts (MeetingOfferToast) remain the path for shells that predate
// this window: those route offers to an app window, never here.
import { useEffect, useRef, useState } from "react";
import { Ban, Maximize2, Mic, Square, X } from "lucide-react";
import {
  getMeetingDetect,
  isElectron,
  meetingOfferHide,
  meetingOfferOpenCall,
  meetingOfferSize,
  onMeetingDetected,
  setMeetingDetect,
  type MeetingOffer,
} from "../../lib/desktop";
import {
  getRecorderStatus,
  startRecording,
  stopRecording,
} from "../../lib/calls/recorder";
import {
  useRecorderLevelVar,
  useRecorderStatus,
  useRecorderSync,
} from "../../hooks/useRecorder";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { fmtClock } from "../../components/calls/speakers";
import { soundMeetingDetected } from "../../lib/sounds";
import { RECORD_OFFER_COPY } from "../../components/calls/MeetingOfferToast";
import "../../components/calls/recorder.css";

export default function MeetingOfferPage() {
  return (
    <div className="dark h-screen w-screen text-sol-text">
      <MeetingOfferRoot />
    </div>
  );
}

function MeetingOfferRoot() {
  useRecorderSync();
  const status = useRecorderStatus();
  const [offer, setOffer] = useState<MeetingOffer | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const recording = status.phase === "recording" || status.phase === "stopping";

  const reset = () => {
    setOffer(null);
    setExpanded(false);
    setError(null);
    setStarting(false);
  };

  const hide = () => {
    reset();
    meetingOfferHide();
  };

  const record = async () => {
    setStarting(true);
    setError(null);
    const id = await startRecording();
    setStarting(false);
    if (id) {
      // The recording face begins the way the offer did: tiny.
      setExpanded(false);
      return;
    }
    // The engine puts the honest reason on its status — a refused microphone,
    // a recognizer that would not start. Expand so the sentence has room, and
    // keep the card up: the answer to most of them is to try again.
    setError(getRecorderStatus().error ?? "Could not start the recording.");
    setExpanded(true);
  };

  // Read the never list before adding to it — the shell owns it, and an app
  // window may have answered "never" for something else since this appeared.
  const never = async () => {
    const app = offer?.app;
    hide();
    if (!app) return;
    const current = await getMeetingDetect();
    const list = current?.never ?? [];
    if (!list.includes(app)) await setMeetingDetect({ never: [...list, app] });
  };

  useWatchEffect(() => {
    const handle = (next: MeetingOffer) => {
      // A recording already running in this window answers the question — and
      // auto mode must not stack a second one on top of the first.
      if (getRecorderStatus().phase !== "idle") return;
      setOffer(next);
      setExpanded(false);
      setError(null);
      soundMeetingDetected();
      if (next.decision === "auto") void record();
    };
    if (isElectron()) onMeetingDetected(handle);
    // Browser dev hook — the real trigger needs the desktop shell, so this is
    // the only way to see the faces at /meeting-offer in a browser:
    // __meetingOffer("Zoom") / __meetingOffer("Zoom", "auto").
    if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
      (window as any).__meetingOffer = (name = "Zoom", decision: "ask" | "auto" = "ask") =>
        handle({ app: name.toLowerCase(), name, decision, at: Date.now() });
    }
  }, []);

  // A recording that ends — from the Stop here, or the engine settling after
  // a failure mid-run — leaves nothing to show: put the window away.
  const wasRecording = useRef(false);
  useEffect(() => {
    if (recording) wasRecording.current = true;
    else if (wasRecording.current) {
      wasRecording.current = false;
      hide();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);

  // The window is exactly as big as the content: report every size change to
  // the shell, which reshapes the window (and reveals it on the first report).
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const report = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0)
        meetingOfferSize({ width: Math.ceil(r.width), height: Math.ceil(r.height) });
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [offer, recording, expanded]);

  if (recording) {
    return (
      <RecordingFace
        bodyRef={bodyRef}
        name={offer?.name}
        expanded={expanded}
        onToggle={() => setExpanded((e) => !e)}
      />
    );
  }
  if (!offer) return null;

  if (!expanded) {
    return (
      <div ref={bodyRef} className="rec-win" role="status">
        <button
          type="button"
          className="rec-win-expand"
          title="More choices"
          onClick={() => setExpanded(true)}
        >
          <span className="rec-win-mark" aria-hidden="true">
            <Mic className="h-2.5 w-2.5" />
          </span>
          <span className="rec-win-name">{offer.name}</span>
          <span className="rec-win-dim">meeting?</span>
        </button>
        <button type="button" className="rec-win-go" onClick={record} disabled={starting}>
          {starting ? "Mic…" : "Record"}
        </button>
        <button
          type="button"
          className="rec-win-ghost"
          title="Not now"
          aria-label="Not now"
          onClick={hide}
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    );
  }

  return (
    <div ref={bodyRef} className="rec-win rec-win-card">
      <span className="rec-win-mark mt-0.5" aria-hidden="true">
        <Mic className="h-2.5 w-2.5" />
      </span>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          className="rec-win-expand w-full text-left"
          title="Shrink"
          onClick={() => setExpanded(false)}
        >
          <span className="rec-win-name">{offer.name} looks like a meeting</span>
        </button>
        <p className="mt-1 text-[11px] leading-relaxed text-sol-text-muted">
          {RECORD_OFFER_COPY}
        </p>
        {error && <p className="mt-1.5 text-[11px] leading-snug text-sol-red">{error}</p>}
        <div className="mt-2 flex items-center gap-1.5">
          <button type="button" className="rec-win-go" onClick={record} disabled={starting}>
            {starting ? "Waiting for the mic…" : error ? "Try again" : "Record"}
          </button>
          <button type="button" className="rec-win-quiet" onClick={hide}>
            Not now
          </button>
          <button type="button" className="rec-win-quiet" onClick={never}>
            <Ban className="h-3 w-3" />
            Never for {offer.name}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The recording as a tiny capsule: dot, clock, level, stop. Expanding shows
 *  the last words heard and the jump to the live transcript. Stop is the only
 *  way this ends, and it is visible in every state — the capsule IS the
 *  floating stop button. */
function RecordingFace({
  bodyRef,
  name,
  expanded,
  onToggle,
}: {
  bodyRef: React.RefObject<HTMLDivElement | null>;
  name?: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const status = useRecorderStatus();
  const now = useCoarseNow(1000);
  const running = status.phase === "recording";
  const stopping = status.phase === "stopping";
  const levelRef = useRecorderLevelVar<HTMLSpanElement>(running);
  const last = status.tail[status.tail.length - 1]?.text ?? "";

  const header = (
    <>
      <button type="button" className="rec-win-expand" title={expanded ? "Shrink" : "Details"} onClick={onToggle}>
        <span className="rec-pill-dot" aria-hidden="true" />
        <span className="rec-win-clock">
          {fmtClock(status.startedAt ? now - status.startedAt : 0)}
        </span>
        {expanded && (
          <span className="rec-win-dim">
            {stopping ? "finishing" : `recording${name ? ` ${name}` : ""}`}
          </span>
        )}
        <span ref={levelRef} className="rec-pill-level" aria-hidden="true">
          {[0.55, 1, 0.75, 0.4].map((b, i) => (
            <i key={i} style={{ ["--b" as string]: b }} />
          ))}
        </span>
      </button>
      {expanded && status.transcriptId && (
        <button
          type="button"
          className="rec-win-ghost"
          title="Open the live transcript"
          aria-label="Open the live transcript"
          onClick={() => meetingOfferOpenCall(status.transcriptId!)}
        >
          <Maximize2 className="h-3 w-3" />
        </button>
      )}
      <button
        type="button"
        className="rec-win-ghost rec-win-stop"
        title={stopping ? "Saving" : "Stop recording"}
        aria-label={stopping ? "Saving" : "Stop recording"}
        disabled={stopping}
        onClick={() => void stopRecording()}
      >
        <Square className="h-2.5 w-2.5 fill-current" />
      </button>
    </>
  );

  if (!expanded) {
    return (
      <div ref={bodyRef} className="rec-win" role="status">
        {header}
      </div>
    );
  }

  return (
    <div ref={bodyRef} className="rec-win rec-win-col">
      <div className="flex items-center gap-2">{header}</div>
      <div className="rec-win-tail">
        {last || status.error || "listening — words appear as people speak"}
      </div>
    </div>
  );
}
