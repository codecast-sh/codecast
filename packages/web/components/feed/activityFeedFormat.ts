// Pure helpers for the activity feed (components/ActivityFeed.tsx): workspace
// names, dates and durations, the heat scale, and the avatar/project palettes.
import type { Conversation } from "../ConversationList";

const JUNK_WORKSPACES = new Set(["unknown", "src", "home", "tmp", "var", "users", "opt", "usr", "app", "root"]);

export function extractWorkspace(projectPath: string | undefined | null): string | undefined {
  if (!projectPath) return undefined;
  const parts = projectPath.split("/").filter(Boolean);
  if (parts.length < 3) return undefined;
  const name = parts[parts.length - 1];
  if (!name || JUNK_WORKSPACES.has(name.toLowerCase())) return undefined;
  // Worktree/agent/session dirs (e.g. "agent-ac5c…", "session-1ntsja") aren't workspaces.
  if (/^(agent|session)-[0-9a-z]{5,}$/i.test(name)) return undefined;
  if (name.length < 2 || name.length > 40) return undefined;
  if (!/[-_a-zA-Z]/.test(name[0])) return undefined;
  return name;
}

export function formatDate(dateStr: string): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  const yesterday = new Date(Date.now() - 86400000).toLocaleDateString("en-CA", { timeZone: tz });
  if (dateStr === today) return "Today";
  if (dateStr === yesterday) return "Yesterday";
  const d = new Date(dateStr + "T12:00:00");
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (diffDays < 7) return d.toLocaleDateString("en-US", { weekday: "long" });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function formatMsgCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

export function relTime(ts: number): string {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function shortDuration(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// Heat scale: bigger / longer sessions get a warmer color (color only — same
// size and weight as the rest of the meta row). Tier 0 = quiet (matches the dim
// row), climbing cyan → green → yellow → orange → red. Kept subdued on purpose.
export const HEAT_COLOR = [
  "text-sol-text-dim/45", "text-sol-cyan/60", "text-sol-green/65",
  "text-sol-yellow/70", "text-sol-orange/70", "text-sol-red/70",
];
export const MSG_BREAKS = [25, 75, 150, 350, 700];
export const DUR_MIN_BREAKS = [10, 30, 90, 240, 600];

export function heatTier(value: number, breaks: number[]): number {
  let t = 0;
  for (const b of breaks) { if (value >= b) t++; else break; }
  return t;
}

// The pregenerated summary the Raw feed shows by default — subtitle first, then
// the activity line, then a cleaned first reply as a last resort.
export function cardSummary(conv: Conversation): string | null {
  if (conv.subtitle && conv.visibility_mode !== "minimal") return conv.subtitle.trim();
  if (conv.activity_summary) return conv.activity_summary.trim();
  const fa = conv.first_assistant_message;
  if (fa) return fa.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 240) || null;
  return null;
}

export const AVATAR_BG = [
  "bg-sol-yellow/20 text-sol-yellow", "bg-sol-cyan/20 text-sol-cyan", "bg-sol-violet/20 text-sol-violet",
  "bg-sol-green/20 text-sol-green", "bg-sol-blue/20 text-sol-blue", "bg-sol-red/20 text-sol-red", "bg-sol-orange/20 text-sol-orange",
];
export const AVATAR_RING = [
  "ring-sol-yellow/70", "ring-sol-cyan/70", "ring-sol-violet/70", "ring-sol-green/70", "ring-sol-blue/70", "ring-sol-red/70", "ring-sol-orange/70",
];
export function hashIndex(key: string, mod: number): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  return Math.abs(hash) % mod;
}

export const PROJECT_PALETTE = [
  "bg-sol-cyan/12 text-sol-cyan/70", "bg-sol-yellow/12 text-sol-yellow/70", "bg-sol-violet/12 text-sol-violet/70",
  "bg-sol-green/12 text-sol-green/70", "bg-sol-orange/12 text-sol-orange/70", "bg-sol-blue/12 text-sol-blue/70", "bg-sol-red/12 text-sol-red/70",
];
