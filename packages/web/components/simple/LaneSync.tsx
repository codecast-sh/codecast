// The store wiring every signed-in lane surface mounts: the same feeders and
// dispatch as the dashboard (DashboardSyncEffects), minus the full app's
// window effects (call rings, chat toasts, mods). SimpleShell mounts it for
// the lane, and /welcome mounts it once someone is signed in, so onboarding
// reads the same store and its writes (the lane choice, the first
// conversation) go out the same way.
import { DashboardSyncEffects } from "../DashboardLayout";
import { ErrorBoundary } from "../ErrorBoundary";

export function LaneSync() {
  return (
    <ErrorBoundary name="SimpleLaneSync" level="inline" fallback={null}>
      <DashboardSyncEffects windowEffects={false} />
    </ErrorBoundary>
  );
}
