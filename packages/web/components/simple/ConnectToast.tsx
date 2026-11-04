// The outcome of a mail and calendar connect that landed back on the page it
// started from. /connect/whisk finishes the connection in the signed-in tab
// and sends the browser to that page (convex/whisk.ts WHISK_RETURN_PATHS)
// with `?whisk=connected` or `?whisk=error&reason=`, and the main shell has
// the connector-return hook toast it (useConnectorReturn).
import { useState } from "react";
import { useConnectorReturn } from "../../hooks/useConnectorReturn";
import { WHISK_RETURN_KEY, isReturnFrom } from "../../lib/connectorReturn";
import { LANE_COPY } from "./lane";

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
