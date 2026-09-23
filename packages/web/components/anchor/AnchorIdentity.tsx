"use client";

// The workspace's agent: its face, its name, and beside them WHICH workspace
// it belongs to. A person can have several (their personal workspace's, one
// per team), and every surface that shows one must make the workspace legible
// at a glance: the drawer header, an inbox row, a chat DM. One component set
// so the face, the name and the workspace pill cannot drift between surfaces.
//
// The agent is the workspace's root role (org-staffing.md S22), so the face
// is the role's (S13) whenever the row carries one; the glyph on a tinted
// tile is the fallback for a row not yet seated.

import { AvatarImg } from "../../lib/avatarCache";
import { agentName, anchorScopeLabel, type AnchorRow } from "../../hooks/useSyncAnchors";
import { RoleFace } from "../org/RoleFace";
import { CHIEF_OF_STAFF_HANDLE, CHIEF_OF_STAFF_NAME } from "../org/orgStaffingTypes";

/** The standing agent mark. Custom (not lucide's boat anchor): a head over a
 *  keel — a standing member, not a nautical object. */
/** The root role's face before a workspace has one (org-staffing.md S22):
 *  the chief of staff's default face, the same one its page shows once hired,
 *  so nothing on the way in looks like a different thing from what arrives. */
export function ChiefOfStaffFace({ className, size = 16 }: { className?: string; size?: number }) {
  return <RoleFace role={{ handle: CHIEF_OF_STAFF_HANDLE, avatar: null, name: CHIEF_OF_STAFF_NAME }} size={size} className={className} />;
}

type Identity = Pick<AnchorRow, "bot_name" | "bot_avatar" | "scope_type" | "team_name"> & Partial<Pick<AnchorRow, "role" | "name">>;

/** The role's face when the row is a seat; else the avatar, else the glyph on
 *  a tinted tile. Same shape at every size. */
export function AnchorAvatar({ anchor, size = 28, className = "" }: { anchor: Identity | null | undefined; size?: number; className?: string }) {
  const name = agentName(anchor);
  if (anchor?.role) return <RoleFace role={anchor.role} size={size} className={`shrink-0 ${className}`} title={name} />;
  const style = { width: size, height: size };
  const radius = size >= 32 ? "rounded-lg" : "rounded-md";
  return (
    <AvatarImg
      src={anchor?.bot_avatar ?? null}
      alt={name}
      className={`${radius} object-cover ${className}`}
      style={style}
      fallback={<ChiefOfStaffFace size={size} className={`shrink-0 ${className}`} />}
    />
  );
}

/** "Personal" or the team's name — the pill that answers "which workspace's
 *  agent am I talking to". Team scope carries a small people mark so the two
 *  kinds read differently even before the words do. */
export function AnchorScopePill({ anchor, className = "" }: { anchor: Identity | null | undefined; className?: string }) {
  if (!anchor) return null;
  const team = anchor.scope_type === "team";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-1.5 py-[1px] text-[10px] font-medium leading-none tracking-wide uppercase ${
        team
          ? "bg-sol-blue/12 text-sol-blue border border-sol-blue/25"
          : "bg-sol-violet/12 text-sol-violet border border-sol-violet/25"
      } ${className}`}
      title={team ? `The agent of ${anchor.team_name ?? "this team"}'s workspace` : "The agent of your personal workspace, private to you"}
    >
      {team ? (
        <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      ) : (
        <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
        </svg>
      )}
      <span className="normal-case tracking-normal">{anchorScopeLabel(anchor)}</span>
    </span>
  );
}

/** Face + name + workspace pill in one line. `size` scales the face; the
 *  pill and name stay legible at every size. */
export function AnchorIdentityLine({
  anchor, size = 28, subtitle, className = "",
}: { anchor: Identity | null | undefined; size?: number; subtitle?: React.ReactNode; className?: string }) {
  return (
    <div className={`flex items-center gap-2.5 min-w-0 ${className}`}>
      <AnchorAvatar anchor={anchor} size={size} />
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="font-semibold truncate">{agentName(anchor)}</span>
          <AnchorScopePill anchor={anchor} />
        </div>
        {subtitle && <div className="text-xs text-sol-text-muted truncate">{subtitle}</div>}
      </div>
    </div>
  );
}
