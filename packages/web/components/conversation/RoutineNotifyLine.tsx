// Where a routine's runs reach the person, said for THIS device. A routine
// that fires into an inbox nobody is looking at never reminds, so while
// notifications are not on here the line says so plainly and offers the one
// tap that asks the browser (or the desktop app) for them. Nothing shows once
// they are on, or where this device cannot say.
import { useState } from "react";
import { useOsPermission } from "../../hooks/useOsPermissions";
import { isPermissionActionable, requestOsPermission } from "../../lib/osPermissions";
import { ROUTINE_NOTIFY_OFF } from "../../lib/hostedApproval";

export function RoutineNotifyLine({ className = "" }: { className?: string }) {
  const { readiness, refresh } = useOsPermission("notifications");
  const [asking, setAsking] = useState(false);
  if (readiness !== "ask" && readiness !== "off") return null;
  const actionable = isPermissionActionable(readiness);
  const turnOn = async () => {
    setAsking(true);
    try {
      await requestOsPermission("notifications", readiness);
    } finally {
      setAsking(false);
      void refresh();
    }
  };
  return (
    <p data-routine-notify={readiness} className={`text-[12.5px] leading-snug text-sol-text-muted ${className}`}>
      {ROUTINE_NOTIFY_OFF[readiness]}
      {actionable ? (
        <>
          {" "}
          <button type="button" onClick={turnOn} disabled={asking} className="text-sol-text underline underline-offset-2 hover:no-underline disabled:opacity-60">
            Turn on notifications
          </button>
        </>
      ) : (
        " Allow them in this site's settings, next to the address bar."
      )}
    </p>
  );
}
