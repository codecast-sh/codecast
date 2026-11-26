import { useState, useRef, useCallback } from "react";
import { useEventListener } from "../hooks/useEventListener";
import { useRouter } from "next/navigation";
import { useInboxStore } from "../store/inboxStore";
import { useCodecastSignOut } from "../hooks/useCodecastSignOut";
import { setAppAddressBarOpen } from "../lib/appAddress";
import { useCurrentUser } from "../hooks/useCurrentUser";
import { isDesktopShell } from "../lib/desktop";
import { MenuKeyCaps, ShortcutTooltip } from "./KeyboardShortcutsHelp";
import { TopbarButton } from "./TopbarButton";
import { useWorkspaceFeature } from "../lib/teamFeatures";
import { useTheme } from "./ThemeProvider";
import { useIsModernStyle } from "../hooks/useVisualStyle";
import {
  Settings, Keyboard, Compass, SlidersHorizontal, CircleUser, Rss, ListChecks,
  FileText, CalendarClock, ArrowLeftRight, ScrollText, Globe, LogOut, Waypoints,
  BookOpen, ExternalLink, Radio, Newspaper, Home, MonitorSmartphone,
  Blocks, Library, Sun, Moon, SquareTerminal, CalendarDays, MessageSquareText,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { objectHref, personRefOf } from "../lib/entityLinks";
import { weeklyCardAllowed } from "@codecast/shared/contracts/weeklyCard";

function MenuItem({
  icon: Icon,
  label,
  onClick,
  trailing,
  prominent,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  trailing?: React.ReactNode;
  prominent?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full px-3 py-1.5 flex items-center gap-2.5 text-sm text-left transition-colors hover:bg-sol-bg-alt ${
        prominent ? "text-sol-text font-medium" : "text-sol-text"
      }`}
    >
      <Icon className={`w-4 h-4 flex-shrink-0 ${prominent ? "text-sol-cyan" : "text-sol-text-dim"}`} />
      <span className="flex-1 truncate">{label}</span>
      {trailing}
    </button>
  );
}

export function UserMenu() {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const signOut = useCodecastSignOut();
  const router = useRouter();
  const { user } = useCurrentUser();
  const toggleShortcutsPanel = useInboxStore(s => s.toggleShortcutsPanel);

  useEventListener("mousedown", useCallback((e: MouseEvent) => {
    if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
      setOpen(false);
    }
  }, []), document);
  // Escape closes it, as it closes the New menu and the switcher beside it.
  useEventListener("keydown", useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") setOpen(false);
  }, []), open ? document : null);

  const handleLogout = async () => {
    await signOut();
    router.push("/");
  };

  const displayName = user?.name || user?.email?.split("@")[0] || "User";
  const isAdmin = user?.staff === true;
  const { theme, toggleTheme } = useTheme();
  const isLocal = typeof window !== "undefined" && window.location.hostname.includes("local.");

  const go = (path: string) => { setOpen(false); router.push(path); };
  const profileHref = user ? objectHref("person", personRefOf(user)) : "/org";
  // Flows is offered only where the workspace has it, as in the rail and the palette.
  const flowsOn = useWorkspaceFeature("line");
  const page = (icon: LucideIcon, label: string, path: string) =>
    <MenuItem key={path} icon={icon} label={label} onClick={() => go(path)} />;
  // Modern keeps this menu to account, settings, appearance and help: every
  // page it listed is a row of the Modern rail or its More level.
  const modern = useIsModernStyle();
  const pages = modern ? [
    <MenuItem key="profile" icon={CircleUser} label="Profile" onClick={() => go(profileHref)} />,
  ] : [
    <MenuItem key="profile" icon={CircleUser} label="Profile" onClick={() => go(profileHref)} />,
    // The page's own name: the rail's "Feed" is the team activity page.
    page(Rss, "Message Feed", "/feed"),
    page(Radio, "Crosstalk", "/crosstalk"),
    page(ListChecks, "Tasks", "/tasks"),
    page(FileText, "Docs", "/docs"),
    page(SquareTerminal, "Sessions", "/sessions"),
    page(MessageSquareText, "Prompts", "/prompts"),
    page(CalendarClock, "Workflows", "/routines"),
    flowsOn && page(Waypoints, "Flows", "/flows"),
  ].filter(Boolean);

  const handleEnvSwitch = () => {
    const { pathname, search, hash } = window.location;
    const target = isLocal
      ? `https://codecast.sh${pathname}${search}${hash}`
      : `http://local.codecast.sh${pathname}${search}${hash}`;
    window.location.href = target;
  };

  return (
    <div className="relative" ref={menuRef}>
      <ShortcutTooltip label="Account & settings">
      <TopbarButton
        onClick={() => setOpen(!open)}
        active={open}
        aria-label="User menu"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {/* Green marks the local dev server. */}
        <Settings className={isLocal ? "text-sol-green" : undefined} />
      </TopbarButton>
      </ShortcutTooltip>
      {open && (
        <div className="cc-topbar-menu absolute right-0 mt-2 w-60 max-h-[calc(100vh-4rem)] overflow-y-auto overscroll-contain bg-sol-bg border border-sol-border rounded-lg shadow-lg py-1 z-50">
          <button
            onClick={() => go(profileHref)}
            className="w-full px-3 py-2.5 border-b border-sol-border text-left hover:bg-sol-bg-alt transition-colors"
          >
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium text-sol-text">{displayName}</p>
              {isAdmin && (
                <span className="text-meta font-mono px-1.5 py-0.5 rounded bg-sol-yellow/20 text-sol-yellow">admin</span>
              )}
            </div>
            {user?.email && (
              <p className="text-xs text-sol-text-muted truncate">{user.email}</p>
            )}
          </button>

          <div className="py-1">
            <MenuItem
              icon={Settings}
              label="Settings"
              prominent
              onClick={() => { setOpen(false); useInboxStore.getState().openSettingsModal(); }}
              trailing={<MenuKeyCaps action="ui.openSettings" />}
            />
            <MenuItem
              icon={Keyboard}
              label="Keyboard shortcuts"
              onClick={() => { setOpen(false); toggleShortcutsPanel(); }}
              trailing={<MenuKeyCaps action="ui.toggleShortcutsHelp" />}
            />
            {/* The desktop app has no address bar of its own, so everyone gets
                this one there, on its key; on the web the browser's bar does
                the job and keeps Cmd+L, and admins keep this one for its
                in-app routing. */}
            {(isDesktopShell() || isAdmin) && (
              <MenuItem
                icon={Globe}
                label="Address bar"
                onClick={() => { setOpen(false); setAppAddressBarOpen(true); }}
                trailing={isDesktopShell() ? <MenuKeyCaps action="ui.addressBar" /> : undefined}
              />
            )}
            <MenuItem
              icon={theme === "dark" ? Sun : Moon}
              label={theme === "dark" ? "Light mode" : "Dark mode"}
              onClick={() => { setOpen(false); toggleTheme(); }}
            />
            <MenuItem icon={Compass} label="Tours" onClick={() => { setOpen(false); useInboxStore.getState().setToursPanelOpen(true); }} />
            {weeklyCardAllowed(user) && page(CalendarDays, "Your week", "/week")}
            {!modern && page(Blocks, "Agent features", "/agent-features")}
            {!modern && page(SlidersHorizontal, "Agent Config", "/config")}
            {!modern && page(Library, "Capabilities", "/capabilities")}
            <MenuItem
              icon={BookOpen}
              label="Documentation"
              onClick={() => { setOpen(false); window.open("/documentation", "_blank", "noopener"); }}
              trailing={<ExternalLink className="w-3.5 h-3.5 text-sol-text-dim" />}
            />
            <MenuItem
              icon={Newspaper}
              label="Changelog"
              onClick={() => { setOpen(false); window.open("/changelog", "_blank", "noopener"); }}
              trailing={<ExternalLink className="w-3.5 h-3.5 text-sol-text-dim" />}
            />
            <MenuItem
              icon={Home}
              label="Home page"
              onClick={() => { setOpen(false); window.open("/", "_blank", "noopener"); }}
              trailing={<ExternalLink className="w-3.5 h-3.5 text-sol-text-dim" />}
            />
            {/* Settings > Apps: the desktop and iOS apps, with the one that
                fits this device first. Shown inside the desktop app too, where
                the iOS app is still worth offering. */}
            <MenuItem
              icon={MonitorSmartphone}
              label={isDesktopShell() ? "iOS app" : "Desktop & iOS apps"}
              onClick={() => { setOpen(false); useInboxStore.getState().openSettingsModal("apps"); }}
            />
          </div>

          <div className="border-t border-sol-border py-1">{pages}</div>

          {isAdmin && (
            <div className="border-t border-sol-border py-1">
              <MenuItem
                icon={ArrowLeftRight}
                label={`Switch to ${isLocal ? "prod" : "local"}`}
                onClick={handleEnvSwitch}
                trailing={
                  <span className={`text-meta font-mono px-1.5 py-0.5 rounded ${isLocal ? "bg-sol-green/20 text-sol-green" : "bg-sol-red/20 text-sol-red"}`}>
                    {isLocal ? "local" : "prod"}
                  </span>
                }
              />
              <MenuItem icon={ScrollText} label="Daemon logs" onClick={() => go("/admin/daemon-logs")} />
            </div>
          )}


          <div className="border-t border-sol-border py-1">
            <MenuItem icon={LogOut} label="Sign out" onClick={handleLogout} />
          </div>
        </div>
      )}
    </div>
  );
}
