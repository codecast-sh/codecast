import { Outlet, useLocation } from "react-router";
import { AuthGuard } from "@/components/AuthGuard";
import { DashboardLayout } from "@/components/DashboardLayout";

/**
 * Shared layout route for the dashboard's tab-routable pages.
 *
 * Rendering ONE stable DashboardLayout as the parent (with the matched page as the
 * <Outlet/>) lets React Router keep the shell — sidebar, tab bar, and the mounted
 * TabContent panes — alive across navigations between these routes. Without it, each
 * route renders its own page component (each wrapping its own DashboardLayout), so a
 * back/forward popstate that re-matches a different route would unmount one shell and
 * mount another, remounting every pane and flashing the UI.
 *
 * When tabs are active DashboardLayout renders TabContent and ignores the Outlet, so
 * the child page never mounts twice; the page's own <DashboardLayout> wrapper is a
 * no-op here via DashboardNestCtx.
 */
export default function DashboardShell() {
  const location = useLocation();
  // Public share links land on conversation routes; that page resolves access
  // itself (guest read-only view / login redirect / denied). Everything else
  // in the shell is an authed surface and keeps the redirect-home guard.
  const guestOk = /^\/conversation\//.test(location.pathname);
  return (
    <AuthGuard guestOk={guestOk}>
      <DashboardLayout>
        <Outlet />
      </DashboardLayout>
    </AuthGuard>
  );
}
