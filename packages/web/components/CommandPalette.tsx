"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Command as CommandPrimitive } from "cmdk";
import { cleanTitle } from "../lib/conversationProcessor";
import { useInboxStore } from "../store/inboxStore";
import { isElectron } from "../lib/desktop";

const NAV_PAGES = [
  { label: "Dashboard", path: "/dashboard", icon: "grid", keywords: "home sessions main" },
  { label: "My Sessions", path: "/dashboard", icon: "user", keywords: "personal conversations" },
  { label: "Team Sessions", path: "/dashboard?filter=team", icon: "users", keywords: "team shared" },
  { label: "Inbox", path: "/inbox", icon: "inbox", keywords: "idle queue waiting" },
  { label: "Search", path: "/search", icon: "search", keywords: "find query" },
  { label: "Settings", path: "/settings", icon: "settings", keywords: "preferences config profile" },
  { label: "Settings: Profile", path: "/settings/profile", icon: "settings", keywords: "account name email" },
  { label: "Settings: CLI", path: "/settings/cli", icon: "terminal", keywords: "daemon install token" },
  { label: "Settings: Team", path: "/settings/team", icon: "users", keywords: "team manage members" },
  { label: "Notifications", path: "/notifications", icon: "bell", keywords: "alerts updates" },
] as const;

function NavIcon({ type, className }: { type: string; className?: string }) {
  const c = className || "w-4 h-4";
  switch (type) {
    case "grid":
      return <svg className={c} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" /></svg>;
    case "user":
      return <svg className={c} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>;
    case "users":
      return <svg className={c} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" /></svg>;
    case "inbox":
      return <svg className={c} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" /></svg>;
    case "search":
      return <svg className={c} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>;
    case "settings":
      return <svg className={c} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>;
    case "terminal":
      return <svg className={c} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>;
    case "bell":
      return <svg className={c} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" /></svg>;
    case "star":
      return <svg className={c} fill="currentColor" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" /></svg>;
    case "bookmark":
      return <svg className={c} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" /></svg>;
    case "session":
      return <svg className={c} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>;
    case "folder":
      return <svg className={c} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>;
    default:
      return <svg className={c} fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" strokeWidth={1.5} /></svg>;
  }
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}

function getShortPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

export function CommandPalette({ standalone = false }: { standalone?: boolean }) {
  const [open, setOpen] = useState(standalone);
  const [query, setQuery] = useState("");
  const router = useRouter();
  const pathname = usePathname();

  const favorites = useQuery(api.conversations.listFavorites);
  const bookmarks = useQuery(api.bookmarks.listBookmarks);
  const { conversations: recentConversations } =
    useQuery(api.conversations.listConversations, {
      filter: "my",
      limit: 200,
      include_message_previews: false,
    }) ?? { conversations: [] };

  const projects = useMemo(() => {
    const dirMap = new Map<string, number>();
    for (const c of recentConversations || []) {
      const dir = c.git_root || c.project_path;
      if (dir) {
        const existing = dirMap.get(dir) || 0;
        if (c.updated_at > existing) dirMap.set(dir, c.updated_at);
      }
    }
    return Array.from(dirMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([path]) => path);
  }, [recentConversations]);

  useEffect(() => {
    if (standalone) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
      if (e.key === "Escape" && open) {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [open, standalone]);

  useEffect(() => {
    if (!standalone) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (isElectron()) {
          window.__CODECAST_ELECTRON__!.paletteHide();
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [standalone]);

  useEffect(() => {
    if (!open && !standalone) {
      setQuery("");
    }
  }, [open, standalone]);

  useEffect(() => {
    if (!standalone || !isElectron()) return;
    const unsub = window.__CODECAST_ELECTRON__!.onPaletteShow(() => {
      setQuery("");
      setTimeout(() => {
        const input = document.querySelector<HTMLInputElement>("[cmdk-input]");
        input?.focus();
      }, 50);
    });
    return unsub;
  }, [standalone]);

  const navigate = useCallback(
    (path: string) => {
      if (standalone && isElectron()) {
        window.__CODECAST_ELECTRON__!.paletteNavigate(path);
        return;
      }
      const inboxMatch = path.match(/^\/inbox\?s=(.+)$/);
      if (inboxMatch && pathname === "/inbox") {
        const sessionId = inboxMatch[1];
        useInboxStore.getState().navigateToSession(sessionId);
        window.history.replaceState({ inboxId: sessionId }, "", path);
      } else {
        router.push(path);
      }
      setOpen(false);
    },
    [router, pathname, standalone]
  );

  const showFavorites = favorites && favorites.length > 0;
  const showBookmarks = bookmarks && bookmarks.length > 0;
  const showProjects = projects.length > 0;
  const showRecent = recentConversations && recentConversations.length > 0;

  if (!open && !standalone) return null;

  const groupClass = "px-1.5 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-widest [&_[cmdk-group-heading]]:text-sol-text-dim/70";
  const itemClass = "flex items-center gap-3 px-2.5 py-2 mx-1 rounded-lg text-sm text-sol-text-muted cursor-pointer transition-colors data-[selected=true]:bg-sol-cyan/10 data-[selected=true]:text-sol-text";

  const paletteContent = (
    <CommandPrimitive
      className="w-[580px] rounded-xl border border-sol-border/80 bg-sol-bg shadow-2xl shadow-black/40 overflow-hidden flex flex-col animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 duration-150"
      filter={(value, search) => {
        const idx = value.indexOf("|||");
        const searchable = idx >= 0 ? value.slice(0, idx) : value;
        return searchable.toLowerCase().includes(search.toLowerCase()) ? 1 : 0;
      }}
      loop
    >
      <div className="flex items-center gap-3 px-4 py-3 border-b border-sol-border/60">
        <div className="text-sol-text-dim">
          <NavIcon type="search" className="w-[18px] h-[18px]" />
        </div>
        <CommandPrimitive.Input
          value={query}
          onValueChange={setQuery}
          placeholder="Jump to..."
          className="flex-1 bg-transparent text-[15px] text-sol-text placeholder:text-sol-text-dim/60 outline-none"
          autoFocus
        />
        <kbd className="px-1.5 py-0.5 text-[10px] font-medium text-sol-text-dim bg-sol-bg-alt rounded border border-sol-border/80 tracking-wide">
          ESC
        </kbd>
      </div>

      <CommandPrimitive.List className="max-h-[min(60vh,480px)] overflow-y-auto overscroll-contain py-1.5 scroll-smooth">
        <CommandPrimitive.Empty className="py-10 text-center text-sm text-sol-text-dim">
          No results found.
        </CommandPrimitive.Empty>

        <CommandPrimitive.Group heading="Pages" className={groupClass}>
          {NAV_PAGES.map((page) => (
            <CommandPrimitive.Item
              key={page.path + page.label}
              value={`${page.label} ${page.keywords}`}
              onSelect={() => navigate(page.path)}
              className={itemClass}
            >
              <span className="text-sol-text-dim data-[selected=true]:text-sol-cyan flex-shrink-0">
                <NavIcon type={page.icon} />
              </span>
              <span className="truncate">{page.label}</span>
            </CommandPrimitive.Item>
          ))}
        </CommandPrimitive.Group>

        {showFavorites && (
          <CommandPrimitive.Group heading="Favorites" className={groupClass}>
            {(query ? favorites! : favorites!.slice(0, 5)).map((fav) => (
              <CommandPrimitive.Item
                key={`fav-${fav._id}`}
                value={`favorite ${cleanTitle(fav.title || fav.session_id || "")}|||${fav._id}`}
                onSelect={() => navigate(`/conversation/${fav._id}`)}
                className={itemClass}
              >
                <span className="text-amber-400 flex-shrink-0">
                  <NavIcon type="star" />
                </span>
                <span className="truncate flex-1">{cleanTitle(fav.title || "New Session")}</span>
                <span className="text-[10px] text-sol-text-dim tabular-nums flex-shrink-0">{fav.message_count} msgs</span>
              </CommandPrimitive.Item>
            ))}
          </CommandPrimitive.Group>
        )}

        {showBookmarks && (
          <CommandPrimitive.Group heading="Bookmarks" className={groupClass}>
            {(query ? bookmarks! : bookmarks!.slice(0, 6)).map((bm) => (
              <CommandPrimitive.Item
                key={`bm-${bm._id}`}
                value={`bookmark ${bm.message_preview || bm.conversation_title || ""}|||${bm._id}`}
                onSelect={() => navigate(`/conversation/${bm.conversation_id}#msg-${bm.message_id}`)}
                className={itemClass}
              >
                <span className="text-sol-cyan flex-shrink-0">
                  <NavIcon type="bookmark" />
                </span>
                <span className="truncate flex-1">{bm.message_preview || bm.conversation_title}</span>
              </CommandPrimitive.Item>
            ))}
          </CommandPrimitive.Group>
        )}

        {showProjects && (
          <CommandPrimitive.Group heading="Projects" className={groupClass}>
            {projects.map((dir) => (
              <CommandPrimitive.Item
                key={`proj-${dir}`}
                value={`project ${getShortPath(dir)} ${dir}`}
                onSelect={() => navigate(`/dashboard?dir=${encodeURIComponent(dir)}`)}
                className={itemClass}
              >
                <span className="text-sol-text-dim flex-shrink-0">
                  <NavIcon type="folder" />
                </span>
                <span className="truncate">{getShortPath(dir)}</span>
                <span className="text-[10px] text-sol-text-dim truncate ml-auto max-w-[200px]">{dir}</span>
              </CommandPrimitive.Item>
            ))}
          </CommandPrimitive.Group>
        )}

        {showRecent && (
          <CommandPrimitive.Group heading="Recent Sessions" className={groupClass}>
            {(query ? recentConversations! : recentConversations!.slice(0, 20)).map((conv) => (
              <CommandPrimitive.Item
                key={`recent-${conv._id}`}
                value={`session ${cleanTitle(conv.title || "")} ${conv.project_path || ""}|||${conv._id}`}
                onSelect={() => navigate(`/conversation/${conv._id}`)}
                className={`${itemClass} group`}
              >
                <span className="text-sol-text-dim flex-shrink-0">
                  <NavIcon type="session" />
                </span>
                <span className="truncate flex-1">{cleanTitle(conv.title || "Untitled")}</span>
                <span className="text-[10px] text-sol-text-dim tabular-nums flex-shrink-0">{timeAgo(conv.updated_at)}</span>
              </CommandPrimitive.Item>
            ))}
          </CommandPrimitive.Group>
        )}
      </CommandPrimitive.List>

      <div className="px-3 py-2 border-t border-sol-border/60 flex items-center justify-between text-[10px] text-sol-text-dim bg-sol-bg-alt/40">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 bg-sol-bg rounded border border-sol-border/80 text-sol-text-secondary">&#8593;</kbd>
            <kbd className="px-1 py-0.5 bg-sol-bg rounded border border-sol-border/80 text-sol-text-secondary">&#8595;</kbd>
            navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1.5 py-0.5 bg-sol-bg rounded border border-sol-border/80 text-sol-text-secondary">&#9166;</kbd>
            open
          </span>
        </div>
        <span className="flex items-center gap-1">
          <kbd className="inline-flex items-center gap-0.5 px-1 py-0.5 bg-sol-bg rounded border border-sol-border/80 text-sol-text-secondary">
            <span className="text-xs">&#8984;</span>K
          </kbd>
          toggle
        </span>
      </div>
    </CommandPrimitive>
  );

  if (standalone) {
    return paletteContent;
  }

  return (
    <div className="fixed inset-0 z-[9999]">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-[2px]"
        onClick={() => setOpen(false)}
      />
      <div className="absolute inset-0 flex items-start justify-center pt-[min(20vh,160px)]">
        {paletteContent}
      </div>
    </div>
  );
}
