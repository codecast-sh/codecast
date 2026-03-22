import { useState, useCallback, useMemo, useRef } from "react";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useShortcutAction } from "../shortcuts";
import { useRouter, usePathname } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Command as CommandPrimitive } from "cmdk";
import { cleanTitle } from "../lib/conversationProcessor";
import { useInboxStore, InboxSession } from "../store/inboxStore";
import { isElectron } from "../lib/desktop";
import { isInboxRoute } from "../lib/inboxRouting";
import { AgentTypeIcon } from "./AgentTypeIcon";

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
      limit: 50,
      include_message_previews: false,
    }) ?? { conversations: [] };

  const isSearching = query.trim().length >= 2;
  const searchResults = useQuery(
    api.conversations.paletteSearch,
    isSearching ? { query: query.trim(), limit: 30 } : "skip"
  );
  const searchLoading = isSearching && searchResults === undefined;

  const displayConversations = isSearching
    ? searchResults ?? []
    : recentConversations;

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

  const [composeMode, setComposeMode] = useState(false);
  const [composeMsg, setComposeMsg] = useState("");
  const [composeAgent, setComposeAgent] = useState("claude_code");
  const [composeProject, setComposeProject] = useState<string | null>(null);
  const composeRef = useRef<HTMLTextAreaElement>(null);

  const COMPOSE_AGENTS = [
    { type: "claude_code", label: "Claude" },
    { type: "codex", label: "Codex" },
    { type: "cursor", label: "Cursor" },
    { type: "gemini", label: "Gemini" },
  ];

  const enterComposeMode = useCallback((initialMsg: string) => {
    setComposeMode(true);
    setComposeMsg(initialMsg);
    setComposeAgent("claude_code");
    setComposeProject(projects[0] || null);
    setTimeout(() => composeRef.current?.focus(), 50);
  }, [projects]);

  const exitComposeMode = useCallback(() => {
    setComposeMode(false);
    setComposeMsg("");
  }, []);

  const handleComposeSubmit = useCallback(() => {
    const msg = composeMsg.trim();
    if (!msg) return;
    if (standalone && isElectron()) {
      window.__CODECAST_ELECTRON__!.paletteStartSession({
        message: msg,
        agentType: composeAgent,
        projectPath: composeProject || projects[0] || undefined,
      });
    } else {
      setOpen(false);
      useInboxStore.getState().openComposePalette(msg);
    }
    setComposeMode(false);
    setComposeMsg("");
  }, [composeMsg, composeAgent, composeProject, projects, standalone]);

  useShortcutAction('palette.toggle', useCallback(() => {
    if (standalone) return;
    setOpen((prev) => !prev);
  }, [standalone]));

  useWatchEffect(() => {
    if (standalone) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [open, standalone]);

  useWatchEffect(() => {
    if (!standalone) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (composeMode) {
          exitComposeMode();
        } else if (isElectron()) {
          window.__CODECAST_ELECTRON__!.paletteHide();
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [standalone, composeMode, exitComposeMode]);

  useWatchEffect(() => {
    if (!open && !standalone) {
      setQuery("");
    }
  }, [open, standalone]);

  useWatchEffect(() => {
    if (!standalone || !isElectron()) return;
    const unsub = window.__CODECAST_ELECTRON__!.onPaletteShow(() => {
      setQuery("");
      setComposeMode(false);
      setComposeMsg("");
      setTimeout(() => {
        const input = document.querySelector<HTMLInputElement>("[cmdk-input]");
        input?.focus();
      }, 50);
    });
    return unsub;
  }, [standalone]);

  useWatchEffect(() => {
    if (!standalone || !isElectron()) return;
    const unsub = window.__CODECAST_ELECTRON__!.onComposeShow(() => {
      setQuery("");
      enterComposeMode("");
    });
    return unsub;
  }, [standalone, enterComposeMode]);

  const navigate = useCallback(
    (path: string) => {
      if (standalone && isElectron()) {
        window.__CODECAST_ELECTRON__!.paletteNavigate(path);
        return;
      }
      router.push(path);
      setOpen(false);
    },
    [router, standalone]
  );

  const navigateToSession = useCallback(
    (conv: { _id: string; session_id?: string; title?: string; updated_at: number; project_path?: string; git_root?: string; agent_type?: string; message_count?: number; is_idle?: boolean }) => {
      const conversationPath = `/conversation/${conv._id}`;
      if (standalone && isElectron()) {
        window.__CODECAST_ELECTRON__!.paletteNavigate(conversationPath);
        return;
      }
      const store = useInboxStore.getState();
      if (!store.sessions[conv._id]) {
        store.injectSession({
          _id: conv._id,
          session_id: conv.session_id || conv._id,
          title: conv.title,
          updated_at: conv.updated_at,
          project_path: conv.project_path,
          git_root: conv.git_root,
          agent_type: conv.agent_type || "claude_code",
          message_count: conv.message_count || 0,
          is_idle: conv.is_idle ?? true,
          has_pending: false,
        } as InboxSession);
      } else {
        store.navigateToSession(conv._id);
      }
      if (isInboxRoute(pathname) || pathname?.startsWith("/conversation/")) {
        window.history.pushState({ inboxId: conv._id }, "", conversationPath);
      } else {
        router.push(conversationPath);
      }
      setOpen(false);
    },
    [router, pathname, standalone]
  );

  const showFavorites = favorites && favorites.length > 0;
  const showBookmarks = bookmarks && bookmarks.length > 0;
  const showProjects = projects.length > 0;
  const showRecent = displayConversations && displayConversations.length > 0;

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
        {!query.trim() && (
          <CommandPrimitive.Empty className="py-6 text-center text-sm text-sol-text-dim">
            No results found.
          </CommandPrimitive.Empty>
        )}

        {showFavorites && (
          <CommandPrimitive.Group heading="Favorites" className={groupClass}>
            {(query ? favorites! : favorites!.slice(0, 5)).map((fav: any) => (
              <CommandPrimitive.Item
                key={`fav-${fav._id}`}
                value={`favorite ${cleanTitle(fav.title || fav.session_id || "")}|||${fav._id}`}
                onSelect={() => navigateToSession(fav)}
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
            {(query ? bookmarks! : bookmarks!.slice(0, 6)).map((bm: any) => (
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

        {searchLoading && (
          <div className="flex items-center justify-center gap-2 py-6 text-xs text-sol-text-dim">
            <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Searching...
          </div>
        )}

        {!searchLoading && showRecent && (
          <CommandPrimitive.Group heading={isSearching ? "Search Results" : "Recent Sessions"} className={groupClass}>
            {(isSearching ? displayConversations! : displayConversations!.slice(0, 30)).map((conv: any) => (
              <CommandPrimitive.Item
                key={`recent-${conv._id}`}
                value={`session ${cleanTitle(conv.title || "")} ${conv.project_path || ""}|||${conv._id}`}
                onSelect={() => navigateToSession(conv)}
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

        <CommandPrimitive.Group forceMount className={groupClass}>
          {query.trim() && (
            <CommandPrimitive.Item
              value={`__compose__ ${query}`}
              onSelect={() => {
                if (standalone && isElectron()) {
                  enterComposeMode(query.trim());
                } else {
                  setOpen(false);
                  useInboxStore.getState().openComposePalette(query.trim());
                }
              }}
              className={itemClass}
            >
              <span className="text-sol-yellow flex-shrink-0">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
                </svg>
              </span>
              <span className="truncate">New session: &ldquo;{query.trim().length > 40 ? query.trim().slice(0, 40) + "..." : query.trim()}&rdquo;</span>
            </CommandPrimitive.Item>
          )}
        </CommandPrimitive.Group>
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

  if (standalone && composeMode) {
    return (
      <div className="w-[580px] rounded-xl border border-sol-border/80 bg-sol-bg shadow-2xl shadow-black/40 overflow-hidden flex flex-col animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 duration-150">
        <div className="flex items-center gap-3 px-4 py-3 border-b border-sol-border/60">
          <button
            onClick={exitComposeMode}
            className="text-sol-text-dim hover:text-sol-text transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 19l-7-7 7-7" /></svg>
          </button>
          <span className="text-[13px] font-medium text-sol-text-muted tracking-wide">New Session</span>
          <div className="flex-1" />
          <kbd className="px-1.5 py-0.5 text-[10px] font-medium text-sol-text-dim bg-sol-bg-alt rounded border border-sol-border/80 tracking-wide">ESC</kbd>
        </div>

        {projects.length > 0 && (
          <div className="px-4 py-2.5 border-b border-sol-border/40 flex flex-wrap gap-1.5">
            {projects.map((dir) => (
              <button
                key={dir}
                onClick={() => setComposeProject(dir)}
                className={`px-2.5 py-1 text-[11px] rounded-lg border transition-colors ${
                  composeProject === dir
                    ? "bg-sol-cyan/15 text-sol-cyan border-sol-cyan/40"
                    : "bg-sol-bg-alt text-sol-text-dim border-sol-border/60 hover:text-sol-text-muted hover:border-sol-border"
                }`}
              >
                {getShortPath(dir)}
              </button>
            ))}
          </div>
        )}

        <div className="px-4 py-2.5 border-b border-sol-border/40 flex items-center gap-1.5">
          {COMPOSE_AGENTS.map((a) => (
            <button
              key={a.type}
              onClick={() => setComposeAgent(a.type)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] rounded-md border transition-colors ${
                composeAgent === a.type
                  ? "bg-sol-yellow/15 text-sol-yellow border-sol-yellow/40"
                  : "bg-transparent text-sol-text-dim border-transparent hover:text-sol-text-muted"
              }`}
            >
              <AgentTypeIcon agentType={a.type} className="w-3 h-3" />
              {a.label}
            </button>
          ))}
        </div>

        <div className="flex-1 px-4 py-3 min-h-[120px]">
          <textarea
            ref={composeRef}
            value={composeMsg}
            onChange={(e) => setComposeMsg(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleComposeSubmit();
              }
            }}
            placeholder="Send a message..."
            className="w-full h-full min-h-[100px] bg-transparent text-sm text-sol-text placeholder:text-sol-text-dim/60 outline-none resize-none"
            autoFocus
          />
        </div>

        <div className="px-3 py-2 border-t border-sol-border/60 flex items-center justify-between text-[10px] text-sol-text-dim bg-sol-bg-alt/40">
          <span className="flex items-center gap-1">
            <kbd className="px-1.5 py-0.5 bg-sol-bg rounded border border-sol-border/80 text-sol-text-secondary">&#9166;</kbd>
            start session
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1.5 py-0.5 bg-sol-bg rounded border border-sol-border/80 text-sol-text-secondary">ESC</kbd>
            back
          </span>
        </div>
      </div>
    );
  }

  if (standalone) {
    return paletteContent;
  }

  if (!open) return null;

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
