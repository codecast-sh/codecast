"use client";

// The anchor's face and name, and — always beside them — WHICH anchor it is.
// A person can have several (a personal one, one per team), and every surface
// that shows an anchor must make the scope legible at a glance: the drawer
// header, the /anchor page, an inbox row, a chat DM. One component set so the
// glyph, the avatar and the scope pill cannot drift between surfaces.

import { AvatarImg } from "../../lib/avatarCache";
import { anchorScopeLabel, type AnchorRow } from "../../hooks/useSyncAnchors";

/** The anchor mark. Custom (not lucide's boat anchor): a head over a keel —
 *  a standing member, not a nautical object. */
export function AnchorGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="5" r="2.5" strokeWidth={1.5} />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 7.5V21M5 12H3a9 9 0 0018 0h-2" />
    </svg>
  );
}

type Identity = Pick<AnchorRow, "bot_name" | "bot_avatar" | "scope_type" | "team_name">;

/** Avatar (or the glyph on a tinted tile). Same shape at every size. */
export function AnchorAvatar({ anchor, size = 28, className = "" }: { anchor: Identity | null | undefined; size?: number; className?: string }) {
  const name = anchor?.bot_name || "Anchor";
  const style = { width: size, height: size };
  const radius = size >= 32 ? "rounded-lg" : "rounded-md";
  return (
    <AvatarImg
      src={anchor?.bot_avatar ?? null}
      alt={name}
      className={`${radius} object-cover ${className}`}
      style={style}
      fallback={
        <span
          className={`${radius} bg-sol-cyan/15 text-sol-cyan flex items-center justify-center flex-shrink-0 ${className}`}
          style={style}
        >
          <AnchorGlyph className="w-[62%] h-[62%]" />
        </span>
      }
    />
  );
}

/** "Personal" or the team's name — the pill that answers "which one am I
 *  talking to". Team scope carries a small people mark so the two kinds read
 *  differently even before the words do. */
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
      title={team ? `Team anchor for ${anchor.team_name ?? "this team"}` : "Your personal anchor — private to you"}
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

/** Face + name + scope pill in one line. `size` scales the avatar; the pill
 *  and name stay legible at every size. */
export function AnchorIdentityLine({
  anchor, size = 28, subtitle, className = "",
}: { anchor: Identity | null | undefined; size?: number; subtitle?: React.ReactNode; className?: string }) {
  return (
    <div className={`flex items-center gap-2.5 min-w-0 ${className}`}>
      <AnchorAvatar anchor={anchor} size={size} />
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="font-semibold truncate">{anchor?.bot_name || "Anchor"}</span>
          <AnchorScopePill anchor={anchor} />
        </div>
        {subtitle && <div className="text-xs text-sol-text-muted truncate">{subtitle}</div>}
      </div>
    </div>
  );
}
