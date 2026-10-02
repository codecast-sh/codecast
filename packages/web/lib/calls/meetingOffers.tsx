// Answering the desktop shell when it notices a meeting starting.
//
// The shell has already applied the setting — off, ask or auto — and picked one
// window to talk to. What is left is the part only this side can know or do:
// whether a recording is already running, and the microphone itself. The cards
// live in components/calls/MeetingOfferToast; this decides which one appears.
import { toast } from "sonner";
import type { ReactNode } from "react";
import {
  MeetingOfferFace,
  MeetingRecordFailed,
  MeetingRecordingNote,
} from "../../components/calls/MeetingOfferToast";
import { canDetectMeetings, onMeetingDetected, type MeetingOffer } from "../desktopMeetings";
import { getRecorderStatus, startRecording } from "./recorder";

/** One card per app, so an app that starts twice replaces its card rather than
 *  stacking a second one. */
function offerToastId(app: string) {
  return `meeting-offer:${app}`;
}

/** The faces are dark glass in every theme, hugging the toaster's right edge
 *  the way the desktop window hugs the screen corner. */
function glass(face: ReactNode) {
  return <div className="dark flex w-full justify-end">{face}</div>;
}

/** The offer times itself out (MeetingOfferFace's drain, paused on hover and
 *  stopped by any interaction), so sonner's own timer stays out of it. */
export function showMeetingOffer(offer: MeetingOffer) {
  const id = offerToastId(offer.app);
  const close = () => toast.dismiss(id);
  toast.custom(() => glass(<MeetingOfferFace offer={offer} onClose={close} onStarted={close} />), {
    id,
    duration: Infinity,
  });
}

export function showAutoRecordNote(offer: MeetingOffer) {
  toast.custom(() => glass(<MeetingRecordingNote offer={offer} />), {
    id: `meeting-auto:${offer.app}`,
    duration: 5000,
  });
}

export function showRecordFailed(offer: MeetingOffer, message: string) {
  toast.custom(() => glass(<MeetingRecordFailed offer={offer} message={message} />), {
    id: `meeting-failed:${offer.app}`,
    duration: 10000,
  });
}

export async function handleMeetingOffer(offer: MeetingOffer): Promise<void> {
  // A recording already running is the one fact the shell cannot have: it
  // watches processes, not this app. Somebody who pressed record when the
  // meeting started should not be asked whether to record it, and auto mode
  // must not try to start a second one on top of the first.
  if (getRecorderStatus().phase !== "idle") return;

  if (offer.decision === "ask") {
    showMeetingOffer(offer);
    return;
  }

  const id = await startRecording();
  if (id) showAutoRecordNote(offer);
  else showRecordFailed(offer, getRecorderStatus().error ?? "Could not start the recording.");
}

// Subscribe this window to the shell's offers. Installed once from
// DesktopProvider, beside the other desktop trackers — the shell already chose
// ONE window to ask in, so there is nothing here to de-duplicate.
//
// A shell new enough to have the dedicated /meeting-offer window routes offers
// there and never here — this toast path survives for older shells. The offer
// window itself must not install it either: the preload's meeting-detected
// channel holds ONE handler, and this would displace the page's own.
let installed = false;
export function installMeetingOfferListener(): void {
  if (installed || !canDetectMeetings()) return;
  if (typeof window !== "undefined" && window.location.pathname === "/meeting-offer") return;
  installed = true;
  onMeetingDetected((offer) => {
    void handleMeetingOffer(offer);
  });
}

// Dev console hook, same convention as __showBrowserHandoffToast: the real
// trigger needs the desktop shell, so this is the only way to see the card in a
// browser — __showMeetingOffer("Zoom").
if (process.env.NODE_ENV !== "production" && typeof window !== "undefined")
  (window as any).__showMeetingOffer = (name = "Zoom", decision: "ask" | "auto" = "ask") =>
    showMeetingOffer({ app: name.toLowerCase(), name, decision, at: Date.now() });
