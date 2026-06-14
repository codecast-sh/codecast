import { useState, useRef, useCallback } from "react";
import { useMountEffect } from "../hooks/useMountEffect";
import { useEventListener } from "../hooks/useEventListener";
import { useAuthActions } from "@convex-dev/auth/react";
import { useRouter } from "next/navigation";
import { useInboxStore } from "../store/inboxStore";
import { copyToClipboard } from "../lib/utils";
import { useCurrentUser } from "../hooks/useCurrentUser";
import { MenuKeyCaps } from "./KeyboardShortcutsHelp";
import {
  Settings, Keyboard, SlidersHorizontal, CircleUser, History, Rss, ListChecks,
  FileText, FolderGit2, CalendarClock, ArrowLeftRight, ScrollText, Globe, LogOut,
  BookOpen, ExternalLink,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

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
  const { signOut } = useAuthActions();
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
  const isAdmin = user?.role === "admin";
  const isLocal = typeof window !== "undefined" && window.location.hostname.includes("local.");

  const go = (path: string) => { setOpen(false); router.push(path); };

  const handleEnvSwitch = () => {
    const { pathname, search, hash } = window.location;
    const target = isLocal
      ? `https://codecast.sh${pathname}${search}${hash}`
      : `http://local.codecast.sh${pathname}${search}${hash}`;
    window.location.href = target;
  };

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setOpen(!open)}
        className="w-8 h-8 rounded-full flex items-center justify-center text-sol-text-muted hover:text-sol-text transition-colors"
        aria-label="User menu"
      >
        <svg className={`w-5 h-5 ${isLocal ? "text-sol-green" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      </button>
      {urlBarOpen && <UrlBarModal onClose={() => setUrlBarOpen(false)} />}
      {open && (
        <div className="absolute right-0 mt-2 w-60 bg-sol-bg border border-sol-border rounded-lg shadow-lg py-1 z-50">
          <button
            onClick={() => go(`/team/${user?.github_username || user?._id || ""}`)}
            className="w-full px-3 py-2.5 border-b border-sol-border text-left hover:bg-sol-bg-alt transition-colors"
          >
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium text-sol-text">{displayName}</p>
              {isAdmin && (
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
            <MenuItem icon={SlidersHorizontal} label="Agent Config" onClick={() => go("/config")} />
            <MenuItem
              icon={BookOpen}
              label="Documentation"
              onClick={() => { setOpen(false); window.open("/documentation", "_blank", "noopener"); }}
              trailing={<ExternalLink className="w-3.5 h-3.5 text-sol-text-dim" />}
            />
          </div>

          <div className="border-t border-sol-border py-1">
            <MenuItem icon={CircleUser} label="Profile" onClick={() => go(`/team/${user?.github_username || user?._id || ""}`)} />
            <MenuItem icon={History} label="Timeline" onClick={() => go("/timeline")} />
            <MenuItem icon={Rss} label="Feed" onClick={() => go("/feed")} />
            <MenuItem icon={ListChecks} label="Tasks" onClick={() => go("/tasks")} />
            <MenuItem icon={FileText} label="Documents" onClick={() => go("/docs")} />
            <MenuItem icon={FolderGit2} label="Projects" onClick={() => go("/projects")} />
            <MenuItem icon={CalendarClock} label="Routines" onClick={() => go("/routines")} />
          </div>

          {isAdmin && (
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
