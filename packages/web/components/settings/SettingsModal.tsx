import { lazy, Suspense, useCallback, useMemo, useRef, useState } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import {
  Terminal, Bot, RefreshCw, User, KeyRound, Users, Plug, Monitor, Bell, Laptop, UserCog, Blocks, X,
  Search, Volume2,
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
  sounds: lazy(() => import("../../app/settings/sounds/page")),
  team: lazy(() => import("../../app/settings/team/page")),
  sync: lazy(() => import("../../app/settings/sync/page")),
  integrations: lazy(() => import("../../app/settings/integrations/github-app/page")),
  agents: lazy(() => import("../../app/settings/agents/page")),
  "agent-features": lazy(() => import("../../app/settings/agent-features/page")),
  "provider-keys": lazy(() => import("../../app/settings/provider-keys/page")),
  "claude-accounts": lazy(() => import("../../app/settings/claude-accounts/page")),
  cli: lazy(() => import("../../app/settings/cli/page")),
  devices: lazy(() => import("../../app/settings/devices/page")),
  desktop: lazy(() => import("../../app/settings/desktop/page")),
};

interface SectionDef {
  id: SettingsSectionId;
  label: string;
  icon: LucideIcon;
  /** One line under the header title — what lives in this section. */
  desc: string;
  /** Extra words the nav search matches beyond the label. */
  keywords: string;
  desktopOnly?: boolean;
}

const GROUPS: { label: string; sections: SectionDef[] }[] = [
  {
    label: "Account",
    sections: [
      { id: "general", label: "General", icon: User, desc: "Your profile and how the app looks and behaves", keywords: "profile preferences appearance theme bio timezone username public simple view badges" },
      { id: "notifications", label: "Notifications", icon: Bell, desc: "What reaches you, and on which device", keywords: "push email digest mentions mute presence away" },
      { id: "sounds", label: "Sounds", icon: Volume2, desc: "What this machine says out loud, and how loudly", keywords: "audio volume mute chime cue walkie chat ring quiet" },
      { id: "accounts", label: "Accounts", icon: KeyRound, desc: "Sign-in identities linked to this account", keywords: "github oauth email login delete danger" },
    ],
  },
  {
    label: "Workspace",
    sections: [
      { id: "team", label: "Team", icon: Users, desc: "Members, identity and the features your team runs", keywords: "members invite roles icon org statuses" },
      { id: "sync", label: "Sync & Privacy", icon: RefreshCw, desc: "Which projects sync, and who can see them", keywords: "projects sharing visibility private workspace directories" },
      { id: "integrations", label: "Integrations", icon: Plug, desc: "GitHub app installs and connected services", keywords: "github app repositories install" },
    ],
  },
  {
    label: "Machines",
    sections: [
      { id: "agent-features", label: "Agent Features", icon: Blocks, desc: "Capabilities your agents pick up per device", keywords: "snippets skills capabilities device" },
      { id: "provider-keys", label: "Provider Keys", icon: KeyRound, desc: "Model provider credentials per device", keywords: "api key anthropic openai secret" },
      { id: "cli", label: "CLI", icon: Terminal, desc: "Install the cast CLI and sign a machine in", keywords: "install token terminal shell" },
      { id: "agents", label: "Agents", icon: Bot, desc: "Permission modes and default parameters", keywords: "permissions yolo model parameters defaults" },
      { id: "claude-accounts", label: "Claude Accounts", icon: UserCog, desc: "Saved Claude sign-ins and auto-switching", keywords: "usage limits switch profiles anthropic" },
      { id: "devices", label: "Devices", icon: Laptop, desc: "Every machine running the daemon", keywords: "machines daemon ssh checkouts online" },
      { id: "desktop", label: "Desktop", icon: Monitor, desc: "The desktop app: shortcuts and meeting detection", keywords: "shortcuts hotkeys meetings version updates", desktopOnly: true },
    ],
  },
];

const ALL_SECTIONS = GROUPS.flatMap((g) => g.sections);

export function SettingsModal() {
  const s = useTrackedStore([(s) => s.settingsModalSection]);
  const isDesktop = useIsDesktop();
  const backdropRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");

  const section = s.settingsModalSection;
  const close = useCallback(() => useInboxStore.getState().closeSettingsModal(), []);

  // Take focus on open and give it back on close. Without this, opening the
  // modal from the keyboard leaves focus in the background composer and every
  // typed character lands there, behind the dialog. Keyed on open-ness, not
  // section, so switching sections inside the modal doesn't re-steal focus.
  const open = !!section;
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  useWatchEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => {
      setQuery("");
      const prev = restoreFocusRef.current;
      if (prev && document.contains(prev)) prev.focus();
    };
  }, [open]);

  useEventListener(
    "keydown",
    useCallback((e: KeyboardEvent) => {
      if (section && e.key === "Escape") {
        // A nested dialog (a confirm dialog, the invite modal) owns this
        // Escape: Radix closes it in its capture-phase listener and the same
        // native event still bubbles here. Our own backdrop is one dialog, so
        // more than one means something is stacked on top.
        if (document.querySelectorAll('[role="dialog"], [role="alertdialog"]').length > 1) return;
        e.stopPropagation();
        close();
      }
    }, [section, close]),
    document,
  );

  // Keep Tab inside the dialog. The panel is not portaled, so without this a
  // keyboard user walks off the last control into the app behind the backdrop.
  const trapFocus = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusables = Array.from(
      panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => el.offsetParent !== null);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    // Nested portaled dialogs run their own focus scope; only wrap when focus
    // is actually on our edges.
    if (e.shiftKey) {
      if (active === first || active === panel) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last) {
      e.preventDefault();
      first.focus();
    }
  }, []);

  // The nav filter. Matching is deliberately loose — label, description,
  // keywords, group name — because "where does X live" is the question this
  // answers for a 14-section surface.
  const q = query.trim().toLowerCase();
  const visibleGroups = useMemo(() => {
    return GROUPS.map((group) => ({
      label: group.label,
      sections: group.sections.filter((d) => {
        if (d.desktopOnly && !isDesktop) return false;
        if (!q) return true;
        return `${d.label} ${d.desc} ${d.keywords} ${group.label}`.toLowerCase().includes(q);
      }),
    })).filter((g) => g.sections.length > 0);
  }, [q, isDesktop]);
  const firstMatch = visibleGroups[0]?.sections[0];

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
      <div
        ref={panelRef}
        tabIndex={-1}
        onKeyDown={trapFocus}
        className="w-full max-w-[1080px] h-[min(880px,94dvh)] bg-sol-bg border border-sol-border rounded-xl shadow-2xl flex overflow-hidden animate-fadeSlideIn outline-none"
      >
        <nav className="w-12 sm:w-56 shrink-0 border-r border-sol-border bg-sol-bg-alt/40 flex flex-col">
          <div className="hidden sm:block px-3 pt-3.5 pb-2">
            <div className="px-1.5 pb-2.5 text-sm font-semibold text-sol-text">Settings</div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-sol-text-dim" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  // Esc clears a live filter before it closes the modal; Enter
                  // jumps to the first hit so search is a keyboard path, not
                  // just a filter.
                  if (e.key === "Escape" && query) {
                    e.stopPropagation();
                    setQuery("");
                  } else if (e.key === "Enter" && firstMatch) {
                    useInboxStore.getState().openSettingsModal(firstMatch.id);
                    setQuery("");
                  }
                }}
                placeholder="Search settings"
                aria-label="Search settings sections"
                className="w-full rounded-md border border-sol-border/70 bg-sol-bg py-1.5 pl-7 pr-2 text-xs text-sol-text placeholder:text-sol-text-dim focus:border-sol-cyan/50 focus:outline-none"
              />
            </div>
          </div>
          <div className="scrollbar-auto flex-1 overflow-y-auto px-1.5 py-3 sm:px-2 sm:pt-0.5">
            {visibleGroups.map((group) => (
              <div key={group.label} className="mb-1">
                <div className="hidden sm:block px-3 pt-2.5 pb-1 text-[10px] font-medium uppercase tracking-wider text-sol-text-dim">
                  {group.label}
                </div>
                {group.sections.map((d) => {
                  const Icon = d.icon;
                  const isActive = d.id === active.id;
                  return (
                    <button
                      key={d.id}
                      onClick={() => useInboxStore.getState().openSettingsModal(d.id)}
                      title={d.label}
                      aria-label={d.label}
                      className={`w-full flex items-center justify-center sm:justify-start gap-2.5 px-2 sm:px-3 py-1.5 rounded-md text-sm transition-colors text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sol-cyan/40 ${
                        isActive
                          ? "bg-sol-cyan/15 text-sol-cyan font-medium"
                          : "text-sol-text-secondary hover:text-sol-text hover:bg-sol-bg-highlight/50"
                      }`}
                    >
                      <Icon className={`w-4 h-4 flex-shrink-0 ${isActive ? "" : "text-sol-text-dim"}`} />
                      <span className="hidden sm:inline truncate">{d.label}</span>
                    </button>
                  );
                })}
              </div>
            ))}
            {q && visibleGroups.length === 0 && (
              <p className="hidden sm:block px-3 pt-3 text-xs text-sol-text-dim">
                Nothing matches &ldquo;{query}&rdquo;
              </p>
            )}
          </div>
        </nav>

        <div className="flex-1 min-w-0 flex flex-col">
          <header className="flex items-center justify-between gap-4 pl-6 pr-3 py-3 border-b border-sol-border">
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-sol-text leading-tight">{active.label}</h2>
              <p className="truncate text-xs text-sol-text-muted">{active.desc}</p>
            </div>
            <button
              onClick={close}
              className="shrink-0 p-1.5 rounded-md text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-highlight/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sol-cyan/40"
              aria-label="Close settings"
            >
              <X className="w-[18px] h-[18px]" />
            </button>
          </header>
          <div key={active.id} className="scrollbar-auto flex-1 overflow-y-auto px-4 sm:px-6 py-5 animate-fadeSlideIn">
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
