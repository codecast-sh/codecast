// The outcome of a mail and calendar connect that landed back on the page it
// started from. /connect/whisk finishes the connection in the signed-in tab
// and sends the browser to that page (convex/whisk.ts WHISK_RETURN_PATHS)
// with `?whisk=connected` or `?whisk=error&reason=`. A lane page says how it
// went in place (ConnectNotice); the main shell, whose inbox has no place
// for it, has the connector-return hook toast it (ConnectToast). Both read the
// return through that one hook (useConnectorReturn).
import { useState } from "react";
import { CircleAlert, CircleCheck } from "lucide-react";
import { useConnectorReturn } from "../../hooks/useConnectorReturn";
import { WHISK_RETURN_KEY, isReturnFrom } from "../../lib/connectorReturn";
import { LANE_COPY } from "./lane";

/** Only the mail connect's return, said by the caller rather than toasted. */
const WHISK_ONLY = { extra: [WHISK_RETURN_KEY], quiet: true } as const;

/** The mail connect's outcome on this page's address, read once and cleared:
 *  what to say, or null when the page was not a connect's return. */
function useWhiskReturn(success: string): { ok: boolean; text: string } | null {
  const read = useConnectorReturn(WHISK_ONLY);
  // Every connector return is read once and cleared; only Whisk's speaks here.
  const notice = read && read.kind !== "confirm" && read.provider === WHISK_RETURN_KEY ? read : null;
  if (notice?.kind === "success") return { ok: true, text: success };
  if (notice?.kind === "error") return { ok: false, text: notice.reason || LANE_COPY.connections.failed };
  return null;
}

export function ConnectNotice({ success }: { success: string }) {
  const notice = useWhiskReturn(success);
  if (!notice) return null;
  return (
    <div className={notice.ok ? "sl-callout sl-rise" : "sl-callout is-sun sl-rise"} style={{ marginBottom: "0.9rem" }}>
      {notice.ok ? <CircleCheck size={18} /> : <CircleAlert size={18} />}
      <span>{notice.text}</span>
    </div>
  );
}

/** Whisk's name in the connect toast: what it connects, as the lane says it. */
const WHISK_TOAST = { extra: [WHISK_RETURN_KEY], names: { [WHISK_RETURN_KEY]: LANE_COPY.connections.mail }, toastErrors: true } as const;

function ConnectToastReader() {
  useConnectorReturn(WHISK_TOAST);
  return null;
}

/** The main shell's reading of a connect that came back to it. It mounts only
 *  when the window opened on a Whisk return, so it never takes another
 *  connector's return from the address. */
export function ConnectToast() {
  const [returned] = useState(() => typeof window !== "undefined" && isReturnFrom(window.location.hash, window.location.search, WHISK_RETURN_KEY));
  return returned ? <ConnectToastReader /> : null;
}
