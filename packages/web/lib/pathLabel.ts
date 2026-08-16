// Default tab title for a dashboard path. Lives here — NOT in TabBar.tsx —
// because the routing layer (src/compat/tabRouting, lib/recentVisits) needs it
// too, and importing it from the component module tied the router compat layer
// into a circular import (TabBar → shortcuts → next/navigation compat →
// tabRouting → TabBar) that made vite full-reload every window instead of hot
// updating whenever anything in that loop changed.
export function pathLabel(path: string): string {
  // Label by the ROUTE, never the query string. A stamped inbox deep link
  // (/inbox?s=<id>) must label as "Inbox" — before this, the raw
  // "inbox?s=jx7…" leaked into tab titles. The /files branch below still reads
  // the original path because its label lives IN the query (?f=<file>).
  const clean = path.split("?")[0].split("#")[0];
  if (clean.startsWith("/conversation/")) return "Conversation";
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
  const segments: Record<string, string> = {
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
