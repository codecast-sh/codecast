// The outcome of a Google connect that landed on a lane page. Every page on
// googleOAuth.ts GOOGLE_RETURN_PATHS must finish the pending connection
// (useConnectorReturn spends the confirm token in this signed-in tab), so
// mounting this one component is how a lane page becomes a return page: it
// runs the confirm step and says how it went.
import { CircleAlert, CircleCheck } from "lucide-react";
import { useConnectorReturn } from "../../hooks/useConnectorReturn";
import { plainConnectError } from "./lane";

export function ConnectNotice({ success }: { success: string }) {
  const notice = useConnectorReturn();
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
        <span>{plainConnectError(notice.reason) ?? "Google didn't connect. Try again."}</span>
      </div>
    );
  }
  return null;
}
