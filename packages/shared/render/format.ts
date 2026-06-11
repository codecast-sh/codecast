// Pure string formatters shared by every client renderer. Previously these were
// hand-copied byte-for-byte into both ConversationView.tsx and the mobile
// session screen. PURE — no React, no DOM, no Node (URL is a web standard /
// Hermes global) — so it imports cleanly into the browser and the Expo/Hermes
// bundle alike.

// Truncate with an ellipsis past `max` chars.
export function truncateStr(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}

// Collapse a URL to `host[/path…]`, dropping a leading `www.` and clipping a
// long path. Falls back to a plain truncation when the input isn't a valid URL.
export function shortenUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    const path = parsed.pathname;
    if (path === "/" || path === "") return host;
    return host + (path.length > 25 ? path.slice(0, 22) + "..." : path);
  } catch {
    return truncateStr(url, 40);
  }
}

// Turn an absolute filesystem path into a workspace-relative one for display.
// Strips the common `/Users/<me>/src/` and `/home/<me>/{src,projects,code}/`
// prefixes; otherwise falls back to the last three path components.
export function getRelativePath(fullPath: string): string {
  const patterns = [
    /\/Users\/[^/]+\/src\/(.+)$/,
    /\/Users\/[^/]+\/(.+)$/,
    /\/home\/[^/]+\/(?:src|projects|code)\/(.+)$/,
    /\/home\/[^/]+\/(.+)$/,
  ];
  for (const pattern of patterns) {
    const match = fullPath.match(pattern);
    if (match) return match[1];
  }
  const parts = fullPath.split("/").filter(Boolean);
  return parts.slice(-3).join("/");
}

// Strip Claude Code's Read line-number gutter ("   42→content" or "42→content").
export function stripLineNumbers(content: string): string {
  return content
    .split("\n")
    .map((line) => line.replace(/^\s*\d+→/, ""))
    .join("\n");
}
