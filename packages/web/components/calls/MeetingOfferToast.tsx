"use client";

// The cards the desktop's meeting detector puts on screen. What SHOWS them —
// and what decides whether to show anything at all — is lib/calls/meetingOffers.
//
// The offer is a question, not an announcement, so it never times out and never
// answers itself: only Record, Not now, or Never for this app clears it. The
// shell has already decided WHETHER to ask (the off / ask / auto setting, and
// the per-app never list); everything here is what the person sees and what
// their answer does.
//
// NOTHING STARTS WITHOUT AN ANSWER. In ask mode the microphone is opened by the
// Record button and by nothing else, which is the same rule the /calls button
// follows. Auto mode is the person having answered in advance, in the setting,
// once — and the note says so out loud when it fires.
import { useState } from "react";
import { toast } from "sonner";
import { Mic, Ban } from "lucide-react";
import { getRecorderStatus, startRecording } from "../../lib/calls/recorder";
import { getMeetingDetect, setMeetingDetect, type MeetingOffer } from "../../lib/desktop";
import "./recorder.css";

/** The offer's one paragraph, shared with the /meeting-offer window so the
 *  question reads identically wherever it is asked. */
export const RECORD_OFFER_COPY =
  "Record it? Codecast listens through your microphone, writes the transcript live, and summarizes it when you stop. The recording is yours alone.";

export function MeetingOfferCard({
  toastId,
  offer,
}: {
  toastId: string | number;
  offer: MeetingOffer;
}) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const record = async () => {
    setStarting(true);
    setError(null);
    const id = await startRecording();
    setStarting(false);
    if (id) {
      toast.dismiss(toastId);
      return;
    }
    // startRecording puts the honest reason on its status — a refused
    // microphone, a recognizer that would not start. The card keeps its place
    // and says it, because the answer to most of them is to try again.
    setError(getRecorderStatus().error ?? "Could not start the recording.");
  };

  // Read the list before adding to it: the shell owns it, and another window
  // may have answered "never" for something else since this card was drawn.
  const never = async () => {
    toast.dismiss(toastId);
    const current = await getMeetingDetect();
    const list = current?.never ?? [];
    if (!list.includes(offer.app)) await setMeetingDetect({ never: [...list, offer.app] });
  };

  return (
    <div className="rec-offer">
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
          <button type="button" className="rec-offer-action" onClick={() => toast.dismiss(toastId)}>
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

/** Auto mode's quiet note: the recording is already running, so this reports
 *  rather than asks. The pill carries the stop. */
export function MeetingRecordingNote({ offer }: { offer: MeetingOffer }) {
  return (
    <div className="rec-offer rec-offer-quiet">
      <span className="rec-offer-dot" aria-hidden="true" />
      <div className="rec-offer-body">
        <div className="rec-offer-title">Recording {offer.name}</div>
        <p className="rec-offer-copy">
          Started on its own because you asked for that. Stop it any time from the recording pill.
        </p>
      </div>
    </div>
  );
}

/** When a start fails — a refused microphone is the common one — the engine's
 *  own sentence is what the person reads. */
export function MeetingRecordFailed({ offer, message }: { offer: MeetingOffer; message: string }) {
  return (
    <div className="rec-offer rec-offer-failed">
      <div className="rec-offer-body">
        <div className="rec-offer-title">{offer.name} was not recorded</div>
        <p className="rec-offer-copy">{message}</p>
      </div>
    </div>
  );
}
