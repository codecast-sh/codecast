// The outcome of a mail and calendar connect that landed back on a lane page.
// /connect/whisk finishes the connection in the signed-in tab and sends the
// browser to the page the connect started from (convex/whisk.ts
// WHISK_RETURN_PATHS) with `?whisk=connected` or `?whisk=error&reason=`;
// mounting this one component is how a lane page says how it went.
import { useState } from "react";
import { CircleAlert, CircleCheck } from "lucide-react";
import { parseWhiskReturn, strippedUrl } from "../../lib/connectorReturn";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { LANE_COPY } from "./lane";

/** The return, read once on mount and then cleared from the address bar, so
 *  a reload or a shared link does not say it again. */
function useWhiskReturn() {
  const [notice, setNotice] = useState<ReturnType<typeof parseWhiskReturn>>(null);
  useWatchEffect(() => {
    const hit = parseWhiskReturn(window.location.search);
    if (!hit) return;
    window.history.replaceState(null, "", strippedUrl(window.location.pathname, window.location.search, window.location.hash));
    setNotice(hit);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one read of the landing URL
  }, []);
  return notice;
}

export function ConnectNotice({ success }: { success: string }) {
  const notice = useWhiskReturn();
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
