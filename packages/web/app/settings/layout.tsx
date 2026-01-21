"use client";

import { usePathname, useRouter } from "next/navigation";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { Button } from "../../components/ui/button";

const tabs = [
  { name: "CLI Setup", path: "/settings/cli" },
  { name: "Sync", path: "/settings/sync" },
  { name: "Profile", path: "/settings/profile" },
  { name: "Accounts", path: "/settings/accounts" },
  { name: "Team", path: "/settings/team" },
  { name: "Integrations", path: "/settings/integrations/github-app" },
  { name: "Privacy", path: "/settings/privacy" },
];

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();

  return (
    <AuthGuard>
      <DashboardLayout>
        <div className="max-w-3xl mx-auto space-y-6">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-semibold text-sol-text">Settings</h1>
            <Button
              variant="ghost"
              onClick={() => router.push("/dashboard")}
              className="text-sol-base1"
            >
              Back to Dashboard
            </Button>
          </div>

          <div className="flex gap-2 border-b border-sol-border">
            {tabs.map((tab) => {
              const isActive = pathname === tab.path || pathname?.startsWith(tab.path + "/") ||
                (tab.path.includes("/integrations") && pathname?.startsWith("/settings/integrations"));
              return (
                <button
                  key={tab.path}
                  onClick={() => router.push(tab.path)}
                  className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 ${
                    isActive
                      ? "border-sol-cyan text-sol-cyan"
                      : "border-transparent text-sol-base1 hover:text-sol-text"
                  }`}
                >
                  {tab.name}
                </button>
              );
            })}
          </div>

          {children}
        </div>
      </DashboardLayout>
    </AuthGuard>
  );
}
