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
// Three faces, one honest lifecycle:
//   pill       one line — "<App> looks like a meeting" — with the answer that
//              matters (Record) right on it, and a chime when it appears.
//   card       the pill, expanded: the full copy and all three answers
//              (Record / Not now / Never for this app). Errors land here too,
//              because the answer to most of them is to try again.
//   recording  the recording runs IN THIS WINDOW — the same per-window
//              recorder engine every surface uses — so the pill stays on
//              screen as the floating stop button, with the elapsed clock and
//              the last words heard as proof the microphone works.
//
// NOTHING STARTS WITHOUT AN ANSWER: in ask mode the microphone is opened by
// the Record button and by nothing else. An auto offer is the person having
// answered in advance, in the setting — it starts at once and this window
// says so instead of asking.
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
    <div className="h-screen w-screen">
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
    if (id) return; // the recording face takes over
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

  if (recording) return <RecordingFace bodyRef={bodyRef} name={offer?.name} />;
  if (!offer) return null;

  if (!expanded) {
    return (
      <div ref={bodyRef} className="rec-offer rec-offer-line" role="status">
        <span className="rec-offer-glyph" aria-hidden="true">
          <Mic className="w-3.5 h-3.5" />
        </span>
        <div className="rec-offer-title whitespace-nowrap">
          {offer.name} looks like a meeting
        </div>
        <button
          type="button"
          className="rec-offer-go whitespace-nowrap"
          onClick={record}
          disabled={starting}
        >
          {starting ? "Waiting for the microphone" : "Record"}
        </button>
        <button
          type="button"
          className="rec-offer-action"
          title="More choices"
          aria-label="More choices"
          onClick={() => setExpanded(true)}
        >
          <Maximize2 className="w-3 h-3" />
        </button>
        <button
          type="button"
          className="rec-offer-action"
          title="Not now"
          aria-label="Not now"
          onClick={hide}
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    );
  }

  return (
    <div ref={bodyRef} className="rec-offer">
      <span className="rec-offer-glyph" aria-hidden="true">
        <Mic className="w-3.5 h-3.5" />
      </span>
      <div className="rec-offer-body">
        <div className="rec-offer-title">{offer.name} looks like a meeting</div>
        <p className="rec-offer-copy">{RECORD_OFFER_COPY}</p>
        {error && <p className="rec-offer-error">{error}</p>}
        <div className="rec-offer-actions">
          <button type="button" className="rec-offer-go" onClick={record} disabled={starting}>
            {starting ? "Waiting for the microphone" : error ? "Try again" : "Record"}
          </button>
          <button type="button" className="rec-offer-action" onClick={hide}>
            Not now
          </button>
          <button type="button" className="rec-offer-action" onClick={never}>
            <Ban className="w-3 h-3" />
            Never for {offer.name}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The recording, as the window's whole face: the same pill RecordingPill
 *  draws in-app, minus the portal — here the window IS the pill. Stop is the
 *  only way it ends, and ending is what puts the window away. */
function RecordingFace({
  bodyRef,
  name,
}: {
  bodyRef: React.RefObject<HTMLDivElement | null>;
  name?: string;
}) {
  const status = useRecorderStatus();
  const now = useCoarseNow(1000);
  const running = status.phase === "recording";
  const stopping = status.phase === "stopping";
  const levelRef = useRecorderLevelVar<HTMLSpanElement>(running);
  const last = status.tail[status.tail.length - 1]?.text ?? "";

  return (
    <div ref={bodyRef} className="rec-pill rec-winpill">
      <span className="rec-pill-dot" aria-hidden="true" />
      <span ref={levelRef} className="rec-pill-level" aria-hidden="true">
        {[0.55, 1, 0.75, 0.4].map((b, i) => (
          <i key={i} style={{ ["--b" as string]: b }} />
        ))}
      </span>
      <div className="rec-pill-body">
        <div className="rec-pill-head">
          <span className="rec-pill-clock">
            {fmtClock(status.startedAt ? now - status.startedAt : 0)}
          </span>
          <span className="rec-pill-what">
            {stopping ? "finishing" : `recording${name ? ` ${name}` : " the room"}`}
          </span>
        </div>
        {last ? (
          <div className="rec-pill-tail" title={last}>
            {last}
          </div>
        ) : (
          <div className="rec-pill-quiet">
            {status.error ?? "listening — words appear as people speak"}
          </div>
        )}
      </div>
      {status.transcriptId && (
        <button
          type="button"
          className="rec-pill-open"
          title="Open the live transcript"
          aria-label="Open the live transcript"
          onClick={() => meetingOfferOpenCall(status.transcriptId!)}
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
      )}
      <button
        type="button"
        className="rec-pill-stop"
        disabled={stopping}
        onClick={() => void stopRecording()}
      >
        <Square className="h-3 w-3 fill-current" />
        {stopping ? "Saving" : "Stop"}
      </button>
    </div>
  );
}
