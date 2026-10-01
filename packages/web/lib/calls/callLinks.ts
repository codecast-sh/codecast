import { callAnchorHref, type CallAnchor } from "@codecast/shared/contracts";
import { copyText } from "../copyText";
import { sharePageUrl } from "../utils";

/** Copy the absolute link to a place in a call (or the whole call). */
export function copyCallLink(callId: string, anchor: CallAnchor | null) {
  void copyText(sharePageUrl(callAnchorHref(callId, anchor)), "Link copied");
}
