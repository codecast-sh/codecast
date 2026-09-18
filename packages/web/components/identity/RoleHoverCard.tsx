// Who a role is and what it looks after, one hover away from every place a
// role is named (session-characters.md S4; org-roles-run-work.md R3). The card
// paints at once from whatever the caller already has (face, name, handle),
// then from the store: the org tree slice with the workspace's projects, plans
// and tasks, through RoleScopeView, the same rendering the role page opens on.
// `org.roleCard` is enrichment only: it fills the charter, the trust and the
// tenure, and stands in for the tree on a page that never loaded it. A missing
// answer leaves a face and a name, never an error (useQueryNoThrow).
//
// The whole card is one link: a click anywhere on it opens the role.
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useRoleScope } from "../../hooks/useRoleScope";
import { RoleAvatar } from "../org/avatars";
import { HoverCard } from "../ui/HoverCard";
import { roleRingStyle } from "./SessionFace";
import { RoleScopeView } from "./RoleScopeView";
import { isAvatarKey, defaultAvatarFor } from "@codecast/shared/contracts/orgAvatars";
import { relativeTime } from "../../lib/entityDisplay";
import type { RoleCardAnswer } from "../../lib/roleScope";
import type { SessionRoleSnapshot } from "../../store/inboxStore";

export type RoleRef = Pick<SessionRoleSnapshot, "short_id" | "name" | "handle"> & Partial<SessionRoleSnapshot>;

const TRUST_WORD: Record<string, string> = { understand: "reads and reports", decide: "decides in its area", direct: "starts sessions for the work" };

export function RoleHoverContent({ role }: { role: RoleRef }) {
  // Enrichment, never the whole surface: if the answer never arrives the card
  // still shows the face, the name, the handle and whatever the store holds.
  const { data: card } = useQueryNoThrow(api.org.roleCard, { role_id: role.short_id });
  const { model, role: treeRole, escalated } = useRoleScope(role.short_id, card as RoleCardAnswer | null | undefined);
  const r = treeRole ?? card ?? role;
  const avatar = isAvatarKey(r.avatar) ? r.avatar : defaultAvatarFor(r.handle);
  const tenureKind = treeRole?.tenure?.kind ?? card?.tenure?.kind ?? role.tenure_kind ?? null;
  const trust = treeRole?.trust ?? card?.trust ?? null;
  return (
    // A card floats over rows that are themselves clickable (an inbox card, a
    // menu item), and React bubbles a portal's click to them: the click stops
    // here so opening the role never also selects the row under it.
    <Link href={`/org/${r.short_id}`} onClick={(e) => e.stopPropagation()} className="block p-3 space-y-2.5 text-xs no-underline rounded-[inherit] hover:bg-sol-bg-highlight/30 transition-colors" data-role-card={r.short_id}>
      <div className="flex items-start gap-2.5">
        <span className="inline-block rounded-full flex-shrink-0 mt-0.5" style={{ width: 36, height: 36, lineHeight: 0, ...roleRingStyle(36) }}>
          <RoleAvatar avatar={avatar} size={36} title={r.name} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5 min-w-0">
            <span className="font-medium text-sol-text truncate">{r.name}</span>
            {r.handle && <span className="font-mono text-[10px] text-sol-text-dim flex-shrink-0">@{r.handle}</span>}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[10px]">
            <span className="text-sol-violet font-medium">role</span>
            {r.status && r.status !== "active" && <span className="text-sol-yellow">{r.status}</span>}
            {tenureKind && <span className="text-sol-text-dim">{tenureKind === "program" ? "program seat" : "standing seat"}</span>}
            {trust && <span className="text-sol-text-dim">· {TRUST_WORD[trust] ?? trust}</span>}
          </div>
        </div>
      </div>
      {model && <RoleScopeView model={model} escalated={escalated} density="card" />}
      <div className="flex items-center justify-between pt-1.5 border-t border-sol-border/30 text-[10px] text-sol-text-dim">
        <span className="font-mono">{r.short_id}{card?.last_wake_at ? ` · woke ${relativeTime(card.last_wake_at)}` : ""}</span>
        <span className="inline-flex items-center gap-0.5 text-sol-text-muted">Open role <ArrowUpRight className="w-2.5 h-2.5" /></span>
      </div>
    </Link>
  );
}

/** Wraps anything that names a role; the card opens on hover. */
export function RoleHoverCard({ role, children, side, align, disabled, triggerClassName }: { role: RoleRef; children: React.ReactNode; side?: "top" | "bottom" | "left" | "right"; align?: "start" | "center" | "end"; disabled?: boolean; triggerClassName?: string }) {
  return (
    <HoverCard card={<RoleHoverContent role={role} />} side={side} align={align} disabled={disabled} className="w-[22rem]" triggerClassName={triggerClassName}>
      {children}
    </HoverCard>
  );
}
