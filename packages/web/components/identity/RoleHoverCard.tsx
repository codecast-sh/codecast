// Who a role is and what it does (session-characters.md S4), one hover away
// from every place a role is named. The card paints at once from whatever the
// caller already has (the row's role snapshot: face, name, handle, status),
// then fills in from org.roleCard: the charter's first paragraph, the scope,
// who it reports to, trust, today's use. A missing answer leaves a face and a
// name, never an error (useQueryNoThrow).
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { RoleAvatar } from "../org/avatars";
import { HoverCard } from "../ui/HoverCard";
import { roleRingStyle } from "./SessionFace";
import { isAvatarKey, defaultAvatarFor } from "@codecast/shared/contracts/orgAvatars";
import { relativeTime } from "../../lib/entityDisplay";
import type { SessionRoleSnapshot } from "../../store/inboxStore";

export type RoleRef = Pick<SessionRoleSnapshot, "short_id" | "name" | "handle"> & Partial<SessionRoleSnapshot>;

const TRUST_WORD: Record<string, string> = { understand: "reads and reports", decide: "decides in scope", direct: "directs its hands" };

export function RoleHoverContent({ role }: { role: RoleRef }) {
  // Enrichment, never the whole surface: if the answer never arrives the card
  // still shows the face, the name and the handle the caller already had.
  const { data: card } = useQueryNoThrow(api.org.roleCard, { role_id: role.short_id });
  const r = card ?? role;
  const avatar = isAvatarKey(r.avatar) ? r.avatar : defaultAvatarFor(r.handle);
  const tenure = card?.tenure ?? (role.tenure_kind ? { kind: role.tenure_kind } : null);
  const scope = card?.scope;
  const wholeWorkspace = scope && scope.projects.length === 0 && scope.plans.length === 0;
  const caps = card?.caps, counters = card?.counters;
  return (
    <div className="p-3 space-y-2.5 text-xs">
      <div className="flex items-start gap-2.5">
        <span className="inline-block rounded-full flex-shrink-0 mt-0.5" style={{ width: 36, height: 36, lineHeight: 0, ...roleRingStyle(36) }}>
          <RoleAvatar avatar={avatar} size={36} title={r.name} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5 min-w-0">
            <span className="font-medium text-sol-text truncate">{r.name}</span>
            <span className="font-mono text-[10px] text-sol-text-dim flex-shrink-0">@{r.handle}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[10px]">
            <span className="text-sol-violet font-medium">role</span>
            {r.status && r.status !== "active" && <span className="text-sol-yellow">{r.status}</span>}
            {tenure && <span className="text-sol-text-dim">{tenure.kind === "program" ? "program seat" : "standing seat"}</span>}
            {card?.trust && <span className="text-sol-text-dim">· {TRUST_WORD[card.trust] ?? card.trust}</span>}
          </div>
        </div>
      </div>
      {card?.charter ? (
        <p className="text-sol-text-secondary leading-snug">{card.charter}</p>
      ) : card ? (
        <p className="text-sol-text-dim italic">No charter written yet.</p>
      ) : null}
      {scope && (
        <div className="flex flex-wrap gap-1">
          {wholeWorkspace && <span className="px-1.5 py-0.5 rounded bg-sol-bg-highlight text-sol-text-muted text-[10px]">whole workspace</span>}
          {scope.projects.map((p: { id: string; title: string; short_id: string | null }) => <span key={p.id} className="px-1.5 py-0.5 rounded bg-sol-bg-highlight text-sol-text-secondary text-[10px] truncate max-w-[12rem]">{p.title}</span>)}
          {scope.plans.map((p: { id: string; title: string; short_id: string }) => <span key={p.id} className="px-1.5 py-0.5 rounded bg-sol-bg-highlight text-sol-text-secondary text-[10px] truncate max-w-[12rem]">{p.short_id ?? p.title}</span>)}
        </div>
      )}
      {(card?.reports_to || (caps && counters)) && (
        <div className="flex items-center gap-3 text-[10px] text-sol-text-dim">
          {card?.reports_to && <span>reports to <span className="text-sol-text-muted">{card.reports_to.name}</span></span>}
          {caps && counters && (
            <span>today {counters.wakes}/{caps.wakes_per_day} wakes · {counters.hands}/{caps.hands_per_day} hands</span>
          )}
        </div>
      )}
      <div className="flex items-center justify-between pt-1.5 border-t border-sol-border/30 text-[10px] text-sol-text-dim">
        <span className="font-mono">{r.short_id}{card?.last_wake_at ? ` · woke ${relativeTime(card.last_wake_at)}` : ""}</span>
        <Link href={`/org/${r.short_id}`} className="inline-flex items-center gap-0.5 text-sol-text-muted hover:text-sol-text no-underline">
          Open role <ArrowUpRight className="w-2.5 h-2.5" />
        </Link>
      </div>
    </div>
  );
}

/** Wraps anything that names a role; the card opens on hover. */
export function RoleHoverCard({ role, children, side, align, disabled, triggerClassName }: { role: RoleRef; children: React.ReactNode; side?: "top" | "bottom" | "left" | "right"; align?: "start" | "center" | "end"; disabled?: boolean; triggerClassName?: string }) {
  return (
    <HoverCard card={<RoleHoverContent role={role} />} side={side} align={align} disabled={disabled} className="w-80" triggerClassName={triggerClassName}>
      {children}
    </HoverCard>
  );
}
