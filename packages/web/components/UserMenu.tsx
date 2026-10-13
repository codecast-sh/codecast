import { useState, useRef, useCallback } from "react";
import { useMountEffect } from "../hooks/useMountEffect";
import { useEventListener } from "../hooks/useEventListener";
import { useRouter } from "next/navigation";
import { useInboxStore } from "../store/inboxStore";
import { useCodecastSignOut } from "../hooks/useCodecastSignOut";
import { copyToClipboard } from "../lib/utils";
import { useCurrentUser } from "../hooks/useCurrentUser";
import { isDesktopShell } from "../lib/desktop";
import { MenuKeyCaps, ShortcutTooltip } from "./KeyboardShortcutsHelp";
import { TopbarButton } from "./TopbarButton";
import { useSurfaceMode } from "../lib/surfaces";
import { useTheme } from "./ThemeProvider";
import {
  Settings, Keyboard, Compass, SlidersHorizontal, CircleUser, Rss, ListChecks,
  FileText, CalendarClock, ArrowLeftRight, ScrollText, Globe, LogOut, Waypoints,
  BookOpen, ExternalLink, Radio, Newspaper, Home, MonitorSmartphone,
  Blocks, Library, Sun, Moon, SquareTerminal, Gauge,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { objectHref, personRefOf } from "../lib/entityLinks";

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

function UrlBarModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  useMountEffect(() => {
    setUrl(window.location.href);
    setTimeout(() => inputRef.current?.select(), 50);
  });

  const handleNavigate = useCallback(() => {
    try {
      const parsed = new URL(url, window.location.origin);
      if (parsed.origin === window.location.origin) {
        router.push(parsed.pathname + parsed.search + parsed.hash);
      } else {
        window.location.href = url;
      }
      onClose();
    } catch {
      if (url.startsWith("/")) {
        router.push(url);
        onClose();
      }
    }
  }, [url, router, onClose]);

  const handleCopy = useCallback(() => {
    copyToClipboard(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [url]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleNavigate();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }, [handleNavigate, onClose]);

  return (
    <div ref={backdropRef} className="fixed inset-0 z-[200] flex items-start justify-center pt-[20vh] bg-black/60 backdrop-blur-sm" onClick={(e) => { if (e.target === backdropRef.current) onClose(); }}>
      <div className="w-full max-w-lg bg-sol-bg border border-sol-border rounded-xl shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-sol-border flex items-center justify-between">
          <span className="text-xs font-mono uppercase tracking-wider text-sol-text-dim">URL Bar</span>
          <div className="flex items-center gap-1">
            <button onClick={() => { window.history.back(); setUrl(window.location.href); }} className="p-1.5 text-sol-text-dim hover:text-sol-text transition-colors rounded" title="Back">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
            </button>
            <button onClick={() => { window.history.forward(); setUrl(window.location.href); }} className="p-1.5 text-sol-text-dim hover:text-sol-text transition-colors rounded" title="Forward">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
            </button>
          </div>
        </div>
        <div className="p-4 flex items-center gap-2">
          <input
            ref={inputRef}
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 px-3 py-2 bg-sol-bg-alt border border-sol-border rounded-lg text-sm font-mono text-sol-text placeholder-sol-text-dim focus:outline-none focus:border-sol-cyan"
            placeholder="https://codecast.sh/..."
          />
          <button onClick={handleCopy} className="px-3 py-2 text-xs font-medium rounded-lg border border-sol-border text-sol-text-dim hover:text-sol-text hover:border-sol-cyan transition-colors whitespace-nowrap">
            {copied ? "Copied" : "Copy"}
          </button>
          <button onClick={handleNavigate} className="px-3 py-2 text-xs font-medium rounded-lg bg-sol-cyan/15 text-sol-cyan border border-sol-cyan/30 hover:bg-sol-cyan/25 transition-colors">
            Go
          </button>
        </div>
      </div>
    </div>
  );
}

export function UserMenu() {
  const [open, setOpen] = useState(false);
  const [urlBarOpen, setUrlBarOpen] = useState(false);
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
  // One rule with the palette and the rail: a page whose surface hosted mode
  // hides is not offered here either, and the developer-only verbs (tours of
  // the agent inbox, the changelog, admin tools) go with them.
  const mode = useSurfaceMode();
  const hosted = mode.hosted;
  const page = (icon: LucideIcon, label: string, path: string) =>
    mode.showsPage(path) ? <MenuItem key={path} icon={icon} label={label} onClick={() => go(path)} /> : null;
  // In hosted mode the rail already holds every page this group would repeat.
  const pages = hosted ? [] : [
    <MenuItem key="profile" icon={CircleUser} label="Profile" onClick={() => go(profileHref)} />,
    page(Rss, "Feed", "/feed"),
    page(Radio, "Crosstalk", "/crosstalk"),
    page(ListChecks, "Tasks", "/tasks"),
    page(FileText, "Documents", "/docs"),
    page(SquareTerminal, "Sessions", "/sessions"),
    page(CalendarClock, "Workflows", "/routines"),
    page(Waypoints, "Line", "/line"),
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
      >
        {/* Green marks the local dev server, a developer's cue; hosted mode
            keeps the gear in ink. */}
        <Settings className={isLocal && !hosted ? "text-sol-green" : undefined} />
      </TopbarButton>
      </ShortcutTooltip>
      {urlBarOpen && <UrlBarModal onClose={() => setUrlBarOpen(false)} />}
      {open && (
        <div className="cc-topbar-menu absolute right-0 mt-2 w-60 max-h-[calc(100vh-4rem)] overflow-y-auto overscroll-contain bg-sol-bg border border-sol-border rounded-lg shadow-lg py-1 z-50">
          <button
            onClick={() => go(profileHref)}
            className="w-full px-3 py-2.5 border-b border-sol-border text-left hover:bg-sol-bg-alt transition-colors"
          >
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium text-sol-text">{displayName}</p>
              {isAdmin && !hosted && (
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-sol-yellow/20 text-sol-yellow">admin</span>
              )}
            </div>
            {user?.email && (
              <p className="text-xs text-sol-base0 truncate">{user.email}</p>
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
            <MenuItem
              icon={theme === "dark" ? Sun : Moon}
              label={theme === "dark" ? "Light mode" : "Dark mode"}
              onClick={() => { setOpen(false); toggleTheme(); }}
            />
            {hosted && (
              <MenuItem icon={Gauge} label="Plan and usage" onClick={() => { setOpen(false); useInboxStore.getState().openSettingsModal("plan"); }} />
            )}
            {!hosted && <MenuItem icon={Compass} label="Tours" onClick={() => { setOpen(false); useInboxStore.getState().setToursPanelOpen(true); }} />}
            {page(Blocks, "Agent features", "/agent-features")}
            {page(SlidersHorizontal, "Agent Config", "/config")}
            {page(Library, "Capabilities", "/capabilities")}
            <MenuItem
              icon={BookOpen}
              label={hosted ? "Help" : "Documentation"}
              onClick={() => { setOpen(false); window.open("/documentation", "_blank", "noopener"); }}
              trailing={<ExternalLink className="w-3.5 h-3.5 text-sol-text-dim" />}
            />
            {!hosted && <MenuItem
              icon={Newspaper}
              label="Changelog"
              onClick={() => { setOpen(false); window.open("/changelog", "_blank", "noopener"); }}
              trailing={<ExternalLink className="w-3.5 h-3.5 text-sol-text-dim" />}
            />}
            {!hosted && <MenuItem
              icon={Home}
              label="Home page"
              onClick={() => { setOpen(false); window.open("/", "_blank", "noopener"); }}
              trailing={<ExternalLink className="w-3.5 h-3.5 text-sol-text-dim" />}
            />}
            {/* Settings > Apps: the desktop and iOS apps, with the one that
                fits this device first. Shown inside the desktop app too, where
                the iOS app is still worth offering. */}
            <MenuItem
              icon={MonitorSmartphone}
              label={isDesktopShell() ? "iOS app" : "Desktop & iOS apps"}
              onClick={() => { setOpen(false); useInboxStore.getState().openSettingsModal("apps"); }}
            />
          </div>

          {pages.length > 0 && <div className="border-t border-sol-border py-1">{pages}</div>}

          {isAdmin && !hosted && (
            <div className="border-t border-sol-border py-1">
              <MenuItem
                icon={ArrowLeftRight}
                label={`Switch to ${isLocal ? "prod" : "local"}`}
                onClick={handleEnvSwitch}
                trailing={
                  <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${isLocal ? "bg-sol-green/20 text-sol-green" : "bg-sol-red/20 text-sol-red"}`}>
                    {isLocal ? "local" : "prod"}
                  </span>
                }
              />
              <MenuItem icon={ScrollText} label="Daemon logs" onClick={() => go("/admin/daemon-logs")} />
              <MenuItem icon={Globe} label="URL bar" onClick={() => { setOpen(false); setUrlBarOpen(true); }} />
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
