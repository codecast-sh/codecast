import { Outlet, useLocation } from "react-router";
import { AuthGuard } from "@/components/AuthGuard";
import { DashboardLayout } from "@/components/DashboardLayout";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { SettingsRedirect } from "@/components/settings/SettingsRedirect";
import { settingsSectionForPath } from "@/lib/settingsSections";

/**
 * Settings render in a modal (components/settings/SettingsModal.tsx), not as
 * pages. This layout keeps the legacy /settings/* URLs working for hard loads
 * (bookmarks, OAuth returns, plain <a href> links): section URLs bounce home
 * with the modal open; only the focused flow pages (team/create, team/join,
 * accounts/link-github) still render as full pages. In-app navigations never
 * get here — the router compat shim opens the modal in place.
 */
export function SettingsLayout() {
  // Real URL, not usePathname() — when tabs are active that compat hook
  // returns the active TAB's path, and /settings is outside the tab shell.
  const location = useLocation();
  const hit = settingsSectionForPath(location.pathname + location.search);

  if (hit) return <SettingsRedirect hit={hit} />;

  return (
    <AuthGuard>
      <DashboardLayout>
        <div className="max-w-2xl mx-auto px-4 pt-6 pb-8">
          <ErrorBoundary name="SettingsPage" level="panel">
            <Outlet />
          </ErrorBoundary>
        </div>
      </DashboardLayout>
    </AuthGuard>
  );
}
