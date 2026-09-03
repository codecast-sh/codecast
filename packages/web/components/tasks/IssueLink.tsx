import type { CSSProperties } from "react";
import { APP_LOOK, issueSyncTitle } from "../../lib/integrations";
import type { TaskExternal } from "../../store/inboxStore";

// The provider identity of a task backed by a Linear or GitHub issue
// (docs/architecture/issue-sync.md S1.1): glyph + identifier as an external
// link. It sits beside the short id on every task surface, so it keeps the
// visual weight of the parent chip and stops propagation, because most of
// those surfaces are themselves clickable rows or cards.
//
// It shows the identifier and nothing else. How fresh the mirror is belongs to
// the task page's property card, which has the room to say it once; repeating
// it here would print the same timestamp twice on the same screen. The hover
// title carries the provider, the sync time and the error for the surfaces
// that have no room at all.

export function IssueLink({
  external,
  size = "xs",
  className = "",
}: {
  external: TaskExternal;
  size?: "xs" | "sm";
  className?: string;
}) {
  const look = APP_LOOK[external.provider];
  const Icon = look.icon;
  const sm = size === "sm";
  return (
    <a
      href={external.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      title={issueSyncTitle(external)}
      className={`inline-flex items-center gap-1 font-mono rounded border border-sol-border/40 text-sol-text-dim hover:text-sol-text hover:border-[var(--issue-accent)] transition-colors flex-shrink-0 min-w-0 ${
        sm ? "text-xs px-1.5 py-0.5" : "text-[10px] px-1.5 py-0"
      } ${className}`}
      style={{ "--issue-accent": look.accent } as CSSProperties}
    >
      <Icon className={`${sm ? "w-3 h-3" : "w-2.5 h-2.5"} flex-shrink-0`} style={{ color: look.accent }} />
      <span className="truncate">{external.identifier}</span>
      {external.last_error && (
        <span className="w-1.5 h-1.5 rounded-full bg-sol-red flex-shrink-0" aria-label="Sync error" />
      )}
    </a>
  );
}
