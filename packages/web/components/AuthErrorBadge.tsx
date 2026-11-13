import type { ReactNode } from "react";
import { apiErrorBadge, type ApiErrorBadgeKind } from "../lib/apiErrorBadge";
// Badge for a session parked on an unresolved Claude Code auth/API-error banner
// (signed out / rate-limited / connection dropped mid-turn). A distinct amber
// pill — "login" with a key glyph for auth banners, "limit" with an hourglass
// for usage-limit banners, "dropped" with a bolt for connection drops — set
// apart from the plain status dots so a stuck session reads at a glance.
// Shared by both SessionCard variants.
const ICONS: Record<ApiErrorBadgeKind, ReactNode> = {
  context: <path d="M4 6h16M4 12h16M4 18h10" strokeLinecap="round" />,
  safety: null,
  throttle: (<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" /></>),
  fatal: (<><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 15.5v.5" strokeLinecap="round" /></>),
  connection: <path d="M13 2L3 14h7l-1 8 10-12h-7l1-8" strokeLinecap="round" strokeLinejoin="round" />,
  limit: <path d="M6 3h12M6 21h12M8 3v3.5c0 2 4 4 4 5.5s-4 3.5-4 5.5V21M16 3v3.5c0 2-4 4-4 5.5s4 3.5 4 5.5V21" strokeLinecap="round" strokeLinejoin="round" />,
  auth: (<><circle cx="7.5" cy="15.5" r="3.5" /><path d="M10 13L20 3M17 6l2 2M14 9l2 2" strokeLinecap="round" strokeLinejoin="round" /></>),
};

export function AuthErrorBadge({ kind, agentType }: { kind?: string | null; agentType?: string | null }) {
  // Only the parked-and-won't-heal kinds get a badge (lib/apiErrorBadge).
  const badge = apiErrorBadge(kind, agentType);
  if (!badge) return null;
  const icon = ICONS[badge.kind];
  return (
    <span
      className={`inline-flex items-center gap-0.5 px-1 py-0 rounded text-[9px] font-semibold bg-amber-500/10 ${badge.kind === "safety" ? "text-amber-700 dark:text-amber-500" : "text-amber-500"} border border-amber-500/30`}
      title={badge.title}
    >
      {icon && (
        <svg className="w-2 h-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          {icon}
        </svg>
      )}
      {badge.label}
    </span>
  );
}
