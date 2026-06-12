import { lazy, Suspense, useCallback, useRef } from "react";
import {
  Terminal, Bot, RefreshCw, User, KeyRound, Users, Plug, Monitor, Bell, Laptop, UserCog, X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { useEventListener } from "../../hooks/useEventListener";
import { useIsDesktop } from "../../lib/desktop";
import { ErrorBoundary } from "../ErrorBoundary";
import { AppLoader } from "../AppLoader";
import type { SettingsSectionId } from "../../lib/settingsSections";

// Panels are the former /settings/* pages, loaded on demand — only the active
// section's chunk is fetched, and nothing mounts until the modal opens.
const PANELS: Record<SettingsSectionId, React.LazyExoticComponent<React.ComponentType>> = {
  general: lazy(() => import("../../app/settings/profile/page")),
  accounts: lazy(() => import("../../app/settings/accounts/page")),
  notifications: lazy(() => import("../../app/settings/notifications/page")),
  team: lazy(() => import("../../app/settings/team/page")),
  sync: lazy(() => import("../../app/settings/sync/page")),
  integrations: lazy(() => import("../../app/settings/integrations/github-app/page")),
  agents: lazy(() => import("../../app/settings/agents/page")),
  "claude-accounts": lazy(() => import("../../app/settings/claude-accounts/page")),
  cli: lazy(() => import("../../app/settings/cli/page")),
  devices: lazy(() => import("../../app/settings/devices/page")),
  desktop: lazy(() => import("../../app/settings/desktop/page")),
};

interface SectionDef {
  id: SettingsSectionId;
  label: string;
  icon: LucideIcon;
  desktopOnly?: boolean;
}

const GROUPS: { label: string; sections: SectionDef[] }[] = [
  {
    label: "Account",
    sections: [
      { id: "general", label: "General", icon: User },
      { id: "accounts", label: "Accounts", icon: KeyRound },
      { id: "notifications", label: "Notifications", icon: Bell },
    ],
  },
  {
    label: "Workspace",
    sections: [
      { id: "team", label: "Team", icon: Users },
      { id: "sync", label: "Sync & Privacy", icon: RefreshCw },
      { id: "integrations", label: "Integrations", icon: Plug },
    ],
  },
  {
    label: "Machines",
    sections: [
      { id: "cli", label: "CLI", icon: Terminal },
      { id: "agents", label: "Agents", icon: Bot },
      { id: "claude-accounts", label: "Claude Accounts", icon: UserCog },
      { id: "devices", label: "Devices", icon: Laptop },
      { id: "desktop", label: "Desktop", icon: Monitor, desktopOnly: true },
    ],
  },
];

const ALL_SECTIONS = GROUPS.flatMap((g) => g.sections);

export function SettingsModal() {
  const s = useTrackedStore([(s) => s.settingsModalSection]);
  const isDesktop = useIsDesktop();
  const backdropRef = useRef<HTMLDivElement>(null);

  const section = s.settingsModalSection;
  const close = useCallback(() => useInboxStore.getState().closeSettingsModal(), []);

  useEventListener(
    "keydown",
    useCallback((e: KeyboardEvent) => {
      if (section && e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    }, [section, close]),
    document,
  );

  if (!section) return null;

  const active = ALL_SECTIONS.find((d) => d.id === section) ?? ALL_SECTIONS[0];
  const Panel = PANELS[active.id];

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-[150] flex items-center justify-center p-3 sm:p-6 bg-black/40 backdrop-blur-[2px]"
      onMouseDown={(e) => { if (e.target === backdropRef.current) close(); }}
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
    >
      <div className="w-full max-w-[920px] h-[min(680px,92dvh)] bg-sol-bg border border-sol-border rounded-xl shadow-2xl flex overflow-hidden animate-fadeSlideIn">
        <nav className="w-12 sm:w-52 shrink-0 border-r border-sol-border bg-sol-bg-alt/40 py-3 px-1.5 sm:px-2 overflow-y-auto">
          <div className="hidden sm:block px-3 pb-2 text-sm font-semibold text-sol-text">Settings</div>
          {GROUPS.map((group) => {
            const sections = group.sections.filter((d) => !d.desktopOnly || isDesktop);
            if (sections.length === 0) return null;
            return (
              <div key={group.label} className="mb-1">
                <div className="hidden sm:block px-3 pt-2.5 pb-1 text-[10px] font-medium uppercase tracking-wider text-sol-text-dim">
                  {group.label}
                </div>
                {sections.map((d) => {
                  const Icon = d.icon;
                  const isActive = d.id === active.id;
                  return (
                    <button
                      key={d.id}
                      onClick={() => useInboxStore.getState().openSettingsModal(d.id)}
                      title={d.label}
                      className={`w-full flex items-center justify-center sm:justify-start gap-2.5 px-2 sm:px-3 py-1.5 rounded-md text-sm transition-colors text-left ${
                        isActive
                          ? "bg-sol-cyan/15 text-sol-cyan font-medium"
                          : "text-sol-base1 hover:text-sol-text hover:bg-sol-base02/40"
                      }`}
                    >
                      <Icon className="w-4 h-4 flex-shrink-0" />
                      <span className="hidden sm:inline truncate">{d.label}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </nav>

        <div className="flex-1 min-w-0 flex flex-col">
          <header className="flex items-center justify-between pl-6 pr-3 py-3 border-b border-sol-border">
            <h2 className="text-base font-semibold text-sol-text">{active.label}</h2>
            <button
              onClick={close}
              className="p-1.5 rounded-md text-sol-text-dim hover:text-sol-text hover:bg-sol-base02/40 transition-colors"
              aria-label="Close settings"
            >
              <X className="w-[18px] h-[18px]" />
            </button>
          </header>
          <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-5">
            <ErrorBoundary name="SettingsPanel" level="panel">
              <Suspense fallback={<AppLoader className="min-h-0 h-full bg-transparent" size={28} />}>
                <Panel />
              </Suspense>
            </ErrorBoundary>
          </div>
        </div>
      </div>
    </div>
  );
}
