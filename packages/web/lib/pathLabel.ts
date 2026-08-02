// Default tab title for a dashboard path. Lives here — NOT in TabBar.tsx —
// because the routing layer (src/compat/tabRouting, lib/recentVisits) needs it
// too, and importing it from the component module tied the router compat layer
// into a circular import (TabBar → shortcuts → next/navigation compat →
// tabRouting → TabBar) that made vite full-reload every window instead of hot
// updating whenever anything in that loop changed.
export function pathLabel(path: string): string {
  if (path.startsWith("/conversation/")) return "Conversation";
  if (path.startsWith("/tasks/")) return "Task";
  if (path.startsWith("/docs/")) return "Doc";
  if (path.startsWith("/plans/")) return "Plan";
  // A vault note tab is titled by the note, not the encoded query string.
  if (path.startsWith("/vault?") || path.startsWith("/vault/")) {
    try {
      const f = new URLSearchParams(path.split("?")[1] ?? "").get("f");
      if (f) {
        const base = decodeURIComponent(f).split("/").pop() ?? "";
        return base.replace(/\.(md|markdown)$/i, "") || "Vault";
      }
    } catch {}
    return "Vault";
  }
  if (path === "/steering" || path.startsWith("/steering/")) return "Steering";
  const segments: Record<string, string> = {
    "/tasks": "Tasks",
    "/docs": "Docs",
    "/vault": "Vault",
    "/pages": "Pages",
    "/artifacts": "Pages", // pre-rename alias — old saved tabs keep this path
    "/plans": "Plans",
    "/projects": "Projects",
    "/inbox": "Inbox",
    "/feed": "Feed",
    "/crosstalk": "Crosstalk",
    "/settings": "Settings",
    "/team/activity": "Activity",
  };
  return segments[path] || path.split("/").pop() || "Tab";
}
