// The face with its hover card: a role's face opens the role card, a
// character's face opens the session card. `onPick` (the character picker)
// is only offered for characters; a role's identity is edited on the role.
import type { MouseEvent, ReactNode } from "react";
import { sessionIdentity, usePersonifyAll, type IdentityRow } from "../../lib/sessionIdentity";
import { RoleHoverCard } from "./RoleHoverCard";
import { SessionFace } from "./SessionFace";
import { SessionHoverCard } from "./SessionHoverCard";

type Side = "top" | "bottom" | "left" | "right";
type Align = "start" | "center" | "end";

export function IdentityFace({ row, size = 18, className, hover = true, onPick, side = "bottom", align = "start", badge }: {
  row: IdentityRow & Record<string, unknown>;
  size?: number;
  className?: string;
  hover?: boolean;
  /** Opens the character picker; the face becomes a button. */
  onPick?: (e: MouseEvent) => void;
  side?: Side;
  align?: Align;
  /** Corner glyph riding the face (the agent brand); forwarded to SessionFace. */
  badge?: ReactNode;
}) {
  const id = sessionIdentity(row, usePersonifyAll());
  // Not personified: the caller draws whatever it drew before (the agent icon),
  // so opting out costs the row nothing.
  if (id.kind === "plain") return null;
  const pickable = !!onPick && id.kind === "character";
  const face = pickable ? (
    <button
      type="button"
      aria-label={`Change character (${id.name})`}
      onClick={(e) => { e.stopPropagation(); e.preventDefault(); onPick?.(e); }}
      className={`rounded-full flex-shrink-0 leading-none transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sol-cyan ${className ?? ""}`}
      style={{ width: size, height: size }}
    >
      <SessionFace row={row} size={size} badge={badge} />
    </button>
  ) : (
    <SessionFace row={row} size={size} className={className} badge={badge} />
  );
  if (!hover) return face;
  if (id.kind === "role") return <RoleHoverCard role={id.role} side={side} align={align}>{face}</RoleHoverCard>;
  return <SessionHoverCard row={row} side={side} align={align}>{face}</SessionHoverCard>;
}
