// Default tab title for a dashboard path. Lives here — NOT in TabBar.tsx —
// because the routing layer (src/compat/tabRouting, lib/recentVisits) needs it
// too, and importing it from the component module tied the router compat layer
// into a circular import (TabBar → shortcuts → next/navigation compat →
// tabRouting → TabBar) that made vite full-reload every window instead of hot
// updating whenever anything in that loop changed.
export function pathLabel(path: string): string {
  if (path.startsWith("/conversation/")) return "Conversation";
  // A chat tab is titled by the surface, not the channel id — the id is opaque,
  // and the channel's own name is only knowable from the store.
  if (path.startsWith("/chat/")) return "Chat";
  if (path.startsWith("/tasks/")) return "Task";
  if (path.startsWith("/docs/")) return "Doc";
  if (path.startsWith("/plans/")) return "Plan";
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
    "/projects": "Projects",
    "/inbox": "Inbox",
    "/feed": "Feed",
    "/crosstalk": "Crosstalk",
    "/chat": "Chat",
    "/settings": "Settings",
    "/team/activity": "Activity",
  };
  return segments[path] || path.split("/").pop() || "Tab";
}
