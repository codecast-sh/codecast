// The outcome of a mail and calendar connect that landed back on a lane page.
// /connect/whisk finishes the connection in the signed-in tab and sends the
// browser to the page the connect started from (convex/whisk.ts
// WHISK_RETURN_PATHS) with `?whisk=connected` or `?whisk=error&reason=`;
// mounting this one component is how a lane page says how it went. It reads
// the return through the one connector-return hook (useConnectorReturn).
import { CircleAlert, CircleCheck } from "lucide-react";
import { useConnectorReturn } from "../../hooks/useConnectorReturn";
import { WHISK_RETURN_KEY } from "../../lib/connectorReturn";
import { LANE_COPY } from "./lane";

/** The lane reads only the mail connect's return, and says it in place. */
const WHISK_ONLY = { extra: [WHISK_RETURN_KEY], quiet: true } as const;

export function ConnectNotice({ success }: { success: string }) {
  const read = useConnectorReturn(WHISK_ONLY);
  // Every connector return is read once and cleared; only Whisk's speaks here.
  const notice = read && read.kind !== "confirm" && read.provider === WHISK_RETURN_KEY ? read : null;
  if (notice?.kind === "success") {
    return (
      <div className="sl-callout sl-rise" style={{ marginBottom: "0.9rem" }}>
        <CircleCheck size={18} />
        <span>{success}</span>
      </div>
    );
  }
  if (notice?.kind === "error") {
    return (
      <div className="sl-callout is-sun sl-rise" style={{ marginBottom: "0.9rem" }}>
        <CircleAlert size={18} />
        <span>{notice.reason || LANE_COPY.connections.failed}</span>
      </div>
    );
  }
  return null;
}
