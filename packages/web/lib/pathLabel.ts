// Default tab title for a dashboard path. Lives here — NOT in TabBar.tsx —
// because the routing layer (src/compat/tabRouting, lib/recentVisits) needs it
// too, and importing it from the component module tied the router compat layer
// into a circular import (TabBar → shortcuts → next/navigation compat →
// tabRouting → TabBar) that made vite full-reload every window instead of hot
// updating whenever anything in that loop changed.
const REPO_SECTION_LABEL: Record<string, string> = {
  commits: "Commits",
  compare: "Compare",
  branches: "Branches",
  tags: "Tags",
  pulls: "Pull requests",
  search: "Search",
};

export function pathLabel(path: string): string {
  // Label by the ROUTE, never the query string. A stamped inbox deep link
  // (/inbox?s=<id>) must label as "Inbox" — before this, the raw
  // "inbox?s=jx7…" leaked into tab titles. The /files branch below still reads
  // the original path because its label lives IN the query (?f=<file>).
  const clean = path.split("?")[0].split("#")[0];
  if (clean.startsWith("/conversation/")) return "Conversation";
  // /chat/threads is the pre-move alias of /threads — old saved tabs keep it.
  if (clean === "/chat/threads") return "Threads";
  // A chat tab is titled by the surface, not the channel id — the id is opaque,
  // and the channel's own name is only knowable from the store.
  if (clean.startsWith("/chat/")) return "Chat";
  if (clean.startsWith("/tasks/")) return "Task";
  if (clean.startsWith("/docs/")) return "Doc";
  if (clean.startsWith("/plans/")) return "Plan";
  // A Files tab is titled by the open file, not the encoded query string.
  // /vault is the permanent pre-rename alias, so both prefixes title the same.
  if (/^\/(files|vault)[?/]/.test(path)) {
    try {
      const f = new URLSearchParams(path.split("?")[1] ?? "").get("f");
      if (f) {
        const base = decodeURIComponent(f).split("/").pop() ?? "";
        return base.replace(/\.(md|markdown)$/i, "") || "Files";
      }
    } catch {}
    return "Files";
  }
  // Browsing a repository. The tab says what you are looking at, which for a
  // file or a directory lives in the query (`?path=`) exactly as it does for
  // /files above. Without this a blob tab reads "main" and a commit tab reads a
  // forty character sha.
  if (clean.startsWith("/repo/")) {
    const inPath = (() => {
      try {
        const p = new URLSearchParams(path.split("?")[1] ?? "").get("path");
        return p ? decodeURIComponent(p).split("/").filter(Boolean).pop() : null;
      } catch {
        return null;
      }
    })();
    // [_, "repo", owner, name, section, ...] — the file a tree, blob or file
    // history is showing wins, then the section, then the repository itself.
    const section = clean.split("/")[4];
    return inPath || REPO_SECTION_LABEL[section] || clean.split("/")[3] || "Repository";
  }
  if (clean.startsWith("/commit/")) {
    const sha = clean.split("/")[4] ?? "";
    return sha ? sha.slice(0, 7) : "Commit";
  }
  if (clean.startsWith("/pr/")) {
    const number = clean.split("/")[4] ?? "";
    return number ? `PR #${number}` : "Pull request";
  }

  const segments: Record<string, string> = {
    "/repo": "Repositories",
    "/tasks": "Tasks",
    "/docs": "Docs",
    "/files": "Files",
    "/vault": "Files", // pre-rename alias — old saved tabs keep this path
    "/pages": "Pages",
    "/artifacts": "Pages", // pre-rename alias — old saved tabs keep this path
    "/plans": "Plans",
    "/calls": "Calls",
    "/projects": "Projects",
    "/inbox": "Inbox",
    "/feed": "Feed",
    "/crosstalk": "Crosstalk",
    "/chat": "Chat",
    "/threads": "Threads",
    "/settings": "Settings",
    "/team/activity": "Activity",
  };
  return segments[clean] || clean.split("/").pop() || "Tab";
}

/** The session an /inbox?s=<id> tab is pinned to, if any. */
export function inboxTabSessionId(path: string): string | null {
  // Null-safe: a tab row with a missing path (bad caller, corrupted persist)
  // must degrade to "no session", not crash the whole TabBar.
  if (!path || !path.split("?")[0].startsWith("/inbox")) return null;
  try {
    return new URLSearchParams(path.split("?")[1] ?? "").get("s");
  } catch {
    return null;
  }
}

/** The path an in-app TAB holds for a conversation. Tabs never sit on
 *  /conversation/<id>: that route is a one-shot redirect into the inbox (see
 *  RedirectToInbox), and a hidden pane on it would fire the redirect against
 *  global view state. Everything else passes through unchanged. */
export function conversationTabPath(path: string): string {
  const conv = path.match(/^\/conversation\/([^/?#]+)$/);
  return conv ? `/inbox?s=${conv[1]}` : path;
}

/** The session id a live URL shows, in either spelling: the inbox canonical
 *  `/conversation/<id>` or the tab deep-link `/inbox?s=<id>`. Null when the
 *  URL shows no session (bare /inbox, any other route). */
export function urlSessionId(pathname: string, search: string): string | null {
  const conv = pathname.match(/^\/conversation\/([^/?#]+)$/);
  return conv ? conv[1] : inboxTabSessionId(pathname + search);
}

/** Whether an active tab must rewrite the address bar to its own stored path.
 *  False when the live URL is this tab's own content in the other spelling:
 *  the inbox canonicalizes its URL to `/conversation/<id>` while its tab keeps
 *  the equivalent `/inbox?s=<id>` (see stampedTabPath). Rewriting that URL
 *  back would clobber the `{ inboxId }` history entry the inbox pushed for
 *  the select — and with it browser back/forward across viewed sessions. */
export function tabNeedsUrlRestore(livePathname: string, tabPath: string): boolean {
  if (livePathname === tabPath.split("?")[0].split("#")[0]) return false;
  return conversationTabPath(livePathname) !== tabPath;
}
