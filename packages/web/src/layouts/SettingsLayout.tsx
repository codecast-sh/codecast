import { Outlet } from "react-router";
import { usePathname, useRouter } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { DashboardLayout } from "@/components/DashboardLayout";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Button } from "@/components/ui/button";
import {
  Terminal, Bot, RefreshCw, User, KeyRound, Users, Plug, Monitor,
} from "lucide-react";
import { useIsDesktop } from "@/lib/desktop";

const baseTabs = [
  { name: "CLI", path: "/settings/cli", icon: Terminal },
  { name: "Agents", path: "/settings/agents", icon: Bot },
  { name: "Sync & Privacy", path: "/settings/sync", icon: RefreshCw },
  { name: "Profile", path: "/settings/profile", icon: User },
  { name: "Accounts", path: "/settings/accounts", icon: KeyRound },
  { name: "Team", path: "/settings/team", icon: Users },
  { name: "Integrations", path: "/settings/integrations/github-app", icon: Plug },
];

const desktopTab = { name: "Desktop", path: "/settings/desktop", icon: Monitor };

export function SettingsLayout() {
  const pathname = usePathname();
  const router = useRouter();
  const isDesktop = useIsDesktop();
  const tabs = isDesktop ? [...baseTabs, desktopTab] : baseTabs;

  return (
    <AuthGuard>
      <DashboardLayout>
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center justify-between mb-6">
            <h1 className="text-2xl font-semibold text-sol-text">Settings</h1>
            <Button
              variant="ghost"
              onClick={() => router.push("/dashboard")}
              className="text-sol-base1"
            >
              Back to Dashboard
            </Button>
          </div>

          <div className="flex gap-8">
            <div className="flex-1 min-w-0">
              <ErrorBoundary name="SettingsPage" level="panel">
                <Outlet />
              </ErrorBoundary>
            </div>

            <nav className="w-44 flex-shrink-0">
              <div className="sticky top-6 space-y-1">
                {tabs.map((tab) => {
                  const Icon = tab.icon;
                  const isActive = pathname === tab.path || pathname?.startsWith(tab.path + "/") ||
                    (tab.path.includes("/integrations") && pathname?.startsWith("/settings/integrations"));
                  return (
                    <button
                      key={tab.path}
                      onClick={() => router.push(tab.path)}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm font-medium transition-colors text-left ${
                        isActive
                          ? "bg-sol-cyan/15 text-sol-cyan"
                          : "text-sol-base1 hover:text-sol-text hover:bg-sol-base02/40"
                      }`}
                    >
                      <Icon className="w-4 h-4 flex-shrink-0" />
                      {tab.name}
                    </button>
                  );
                })}
              </div>
            </nav>
          </div>
        </div>
      </DashboardLayout>
    </AuthGuard>
  );
}
