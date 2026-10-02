"use client";

// The record-this-meeting offer, as one face shared by both places it appears:
// the desktop shell's /meeting-offer corner window and, for shells that predate
// that window, an in-app toast (lib/calls/meetingOffers decides which).
//
// It starts as a one-line capsule and expands on a click of its body. Left
// alone it goes away on its own: a hairline drains under it for OFFER_LINGER_MS
// (paused while the pointer rests on it) and the capsule fades out. Any answer
// or interaction (expanding, starting, an error to read) stops the drain, so a
// card somebody is engaging with never leaves under them.
//
// NOTHING STARTS WITHOUT AN ANSWER. In ask mode the microphone is opened by the
// Record button and by nothing else, which is the same rule the /calls button
// follows. Auto mode is the person having answered in advance, in the setting.
import { useState } from "react";
import { Ban, Mic, X } from "lucide-react";
import { getRecorderStatus, startRecording } from "../../lib/calls/recorder";
import { getMeetingDetect, setMeetingDetect, type MeetingOffer } from "../../lib/desktopMeetings";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import "./recorder.css";

export const OFFER_LINGER_MS = 15_000;

export function MeetingOfferFace({
  offer,
  onClose,
  onStarted,
  autoStart = false,
}: {
  offer: MeetingOffer;
  onClose: () => void;
  /** The recording is running; the host decides what replaces the offer. */
  onStarted?: () => void;
  autoStart?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const touched = expanded || starting || !!error;

  const record = async () => {
    setStarting(true);
    setError(null);
    const id = await startRecording();
    setStarting(false);
    if (id) {
      onStarted?.();
      return;
    }
    // startRecording puts the honest reason on its status: a refused
    // microphone, a recognizer that would not start. Expand so the sentence
    // has room, and stay up: the answer to most of them is to try again.
    setError(getRecorderStatus().error ?? "Could not start the recording.");
    setExpanded(true);
  };

  // Read the never list before adding to it: the shell owns it, and another
  // window may have answered "never" for something else since this appeared.
  const never = async () => {
    onClose();
    const current = await getMeetingDetect();
    const list = current?.never ?? [];
    if (!list.includes(offer.app)) await setMeetingDetect({ never: [...list, offer.app] });
  };

  useWatchEffect(() => {
    if (autoStart) void record();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shell = {
    role: "status",
    onAnimationEnd: (e: React.AnimationEvent) => {
      if (e.animationName === "rec-win-out") onClose();
    },
  } as const;
  const leave = leaving ? " rec-win-leaving" : "";
  const drain = !touched && !leaving && (
    <span
      className="rec-drain"
      aria-hidden="true"
      style={{ animationDuration: `${OFFER_LINGER_MS}ms` }}
      onAnimationEnd={(e) => {
        e.stopPropagation();
        setLeaving(true);
      }}
    />
  );

  if (!expanded) {
    return (
      <div {...shell} className={`rec-win${leave}`}>
        <button type="button" className="rec-win-expand" title="More choices" onClick={() => setExpanded(true)}>
          <span className="rec-win-mark" aria-hidden="true">
            <Mic className="h-2.5 w-2.5" />
          </span>
          <span className="rec-win-name">{offer.name}</span>
          <span className="rec-win-dim">meeting?</span>
        </button>
        <button type="button" className="rec-win-go" onClick={record} disabled={starting}>
          {starting ? "Mic…" : "Record"}
        </button>
        <button type="button" className="rec-win-ghost" title="Not now" aria-label="Not now" onClick={onClose}>
          <X className="h-3 w-3" />
        </button>
        {drain}
      </div>
    );
  }

  return (
    <div {...shell} className={`rec-win rec-win-card${leave}`}>
      <button type="button" className="rec-win-expand" title="Shrink" onClick={() => setExpanded(false)}>
        <span className="rec-win-mark" aria-hidden="true">
          <Mic className="h-2.5 w-2.5" />
        </span>
        <span className="rec-win-name">Record {offer.name}?</span>
      </button>
      <p className="rec-win-copy">
        Transcribed live from your mic and summarized when you stop. Only you can see it.
      </p>
      {error && <p className="rec-win-error">{error}</p>}
      <div className="rec-win-actions">
        <button type="button" className="rec-win-go" onClick={record} disabled={starting}>
          {starting ? "Waiting for the mic…" : error ? "Try again" : "Record"}
        </button>
        <button type="button" className="rec-win-quiet" onClick={onClose}>
          Not now
        </button>
        <button type="button" className="rec-win-quiet" onClick={never}>
          <Ban className="h-3 w-3" />
          Never for {offer.name}
        </button>
      </div>
    </div>
  );
}

/** Auto mode's note: the recording is already running, so this reports rather
 *  than asks. The pill carries the stop. */
export function MeetingRecordingNote({ offer }: { offer: MeetingOffer }) {
  return (
    <div className="rec-win" role="status">
      <span className="rec-pill-dot" aria-hidden="true" />
      <span className="rec-win-name">Recording {offer.name}</span>
      <span className="rec-win-dim pr-1">stop it from the pill</span>
    </div>
  );
}

/** When a start fails (a refused microphone is the common one), the engine's
 *  own sentence is what the person reads. */
export function MeetingRecordFailed({ offer, message }: { offer: MeetingOffer; message: string }) {
  return (
    <div className="rec-win rec-win-card" role="status">
      <span className="rec-win-name">{offer.name} was not recorded</span>
      <p className="rec-win-error">{message}</p>
    </div>
  );
}
