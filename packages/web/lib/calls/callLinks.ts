import { callAnchorHref, callMomentHref, type CallAnchor } from "@codecast/shared/contracts";
import { copyText } from "../copyText";
import { sharePageUrl } from "../utils";

/** Copy the absolute link to a place in a call (or the whole call), and,
 *  with `atMs`, a moment of its video the page opens waiting at. */
export function copyCallLink(callId: string, anchor: CallAnchor | null, atMs?: number | null) {
  const path = atMs != null ? callMomentHref(callId, atMs, anchor) : callAnchorHref(callId, anchor);
  void copyText(sharePageUrl(path), "Link copied");
}
