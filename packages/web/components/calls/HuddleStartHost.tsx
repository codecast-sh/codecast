import { Suspense, lazy } from "react";
import { useHuddleStartRequest } from "../../lib/calls/huddleStart";

// The dialog's code (the preview, the device pickers, the call manager behind
// them) loads only when somebody asks to start a huddle.
const HuddleStartDialog = lazy(() => import("./HuddleStartDialog"));

export function HuddleStartHost() {
  const req = useHuddleStartRequest();
  if (!req) return null;
  return (
    <Suspense fallback={null}>
      <HuddleStartDialog req={req} />
    </Suspense>
  );
}
