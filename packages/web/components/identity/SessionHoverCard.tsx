// A session's hover card (session-characters.md S4): who is speaking and what
// they are on. Leads with the face at 36 px and the character's name, the
// title dimmed under it, then the agent and model, the owner, the pinned line
// or last activity, and for a hand under a role, who it reports to. Wraps the
// existing SessionHoverContent body so the reference pill and every other
// surface show one card.
import { SessionHoverContent } from "../SessionHoverContent";
import { HoverCard } from "../ui/HoverCard";
import { SessionFace } from "./SessionFace";
import { RoleAvatar } from "../org/avatars";
import { sessionIdentity, type IdentityRow } from "../../lib/sessionIdentity";
import { isAvatarKey, defaultAvatarFor } from "@codecast/shared/contracts/orgAvatars";

type HoverRow = IdentityRow & Record<string, any>;

export function SessionIdentityHeader({ row, size = 36 }: { row: HoverRow; size?: number }) {
  // Resolved as personified: this header sits under a face (the card opens
  // off one, the picker previews one), so it names the character that face
  // belongs to even when the row itself has not opted in.
  const id = sessionIdentity(row, true) as Exclude<ReturnType<typeof sessionIdentity>, { kind: "plain" }>;
  const title = (row.title ?? "").trim();
  const showTitle = title && !(id.kind === "role" && title === id.name);
  return (
    <div className="flex items-start gap-2.5">
      <SessionFace row={row} size={size} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5 min-w-0">
          <span className="text-xs font-medium text-sol-text truncate">{id.name}</span>
          {id.kind === "role" && <span className="font-mono text-[10px] text-sol-text-dim flex-shrink-0">@{id.handle}</span>}
          {id.kind === "character" && !id.chosen && <span className="text-[10px] text-sol-text-dim flex-shrink-0">default</span>}
        </div>
        {showTitle && <div className="text-[11px] text-sol-text-secondary leading-snug line-clamp-2">{title}</div>}
        {id.kind === "character" && id.reportsTo && (
          <div className="mt-1 flex items-center gap-1 text-[10px] text-sol-text-dim">
            reports to
            <RoleAvatar avatar={isAvatarKey(id.reportsTo.avatar) ? id.reportsTo.avatar : defaultAvatarFor(id.reportsTo.handle)} size={12} />
            <span className="text-sol-text-muted">{id.reportsTo.name}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function SessionHoverCardContent({ row }: { row: HoverRow }) {
  return (
    <div className="p-3 space-y-2">
      <SessionIdentityHeader row={row} />
      <SessionHoverContent session={row} identity={false} />
    </div>
  );
}

export function SessionHoverCard({ row, children, side, align, disabled, triggerClassName }: { row: HoverRow; children: React.ReactNode; side?: "top" | "bottom" | "left" | "right"; align?: "start" | "center" | "end"; disabled?: boolean; triggerClassName?: string }) {
  return (
    <HoverCard card={<SessionHoverCardContent row={row} />} side={side} align={align} disabled={disabled} className="w-80" triggerClassName={triggerClassName}>
      {children}
    </HoverCard>
  );
}
