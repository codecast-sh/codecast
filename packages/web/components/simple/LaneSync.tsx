// The store wiring /welcome mounts once someone is signed in: the same
// feeders and dispatch as the dashboard (DashboardSyncEffects), minus the
// full app's window effects (call rings, chat toasts, mods), so onboarding
// reads the same store and its writes (the mode choice, the first
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
