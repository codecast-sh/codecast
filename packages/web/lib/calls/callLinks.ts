import { callAnchorHref, callFrameHref, callMomentHref, type CallAnchor, type CallRecordingKind } from "@codecast/shared/contracts";
import { copyText } from "../copyText";
import { sharePageUrl } from "../utils";

/** Copy the absolute link to a place in a call (or the whole call), and,
 *  with `atMs`, a moment of its video the page opens waiting at. */
export function copyCallLink(callId: string, anchor: CallAnchor | null, atMs?: number | null) {
  const path = atMs != null ? callMomentHref(callId, atMs, anchor) : callAnchorHref(callId, anchor);
  void copyText(sharePageUrl(path), "Link copied");
}

/** Copy the link to the frame being watched: that moment, on the file
 *  showing it (a screen opens on that sharer's screen, the room on the
 *  room), built by the one rule every frame link takes (callFrameHref). */
export function copyCallFrameLink(callId: string, atMs: number, shown: { kind: CallRecordingKind; participant_identity?: string | null }) {
  void copyText(sharePageUrl(callFrameHref(callId, atMs, shown)), "Link copied");
}
