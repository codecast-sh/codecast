// The face a session wears (session-characters.md S3): its character's
// avatar, or its role's when the row is a role's standing session; with the
// viewer's characters off, a role's icon tile and no face for anything else.
// The art lives in org/avatars and RoleIconTile; this is the one place a
// SESSION ROW turns into a face.
import type { ReactNode } from "react";
import { RoleAvatar } from "../org/avatars";
import { avatarLength } from "../../lib/orgAvatars";
import { faceBadgeSize, viewerFace, type IdentityRow } from "../../lib/sessionIdentity";
import { useLiveIdentityRow } from "../../hooks/useLiveIdentityRow";
import { useIdentityPrefs } from "../../hooks/useIdentityPrefs";
import { RoleIconTile } from "./RoleIconTile";

export function SessionFace({ row: rawRow, size = 18, className, title, badge }: {
  row: IdentityRow;
  /** Pixels, or any CSS length: a face in a sentence draws at "1em" so it
   *  rides the prose it sits in. */
  size?: number | string;
  className?: string;
  title?: string;
  /** A small mark on the face's lower right — the agent brand, where the
   *  surface used to show it on its own. Skipped under 16 px, where it would
   *  be a smudge. */
  badge?: ReactNode;
}) {
  // Draws a face even for a row nobody personified: the picker and the hover
  // cards preview the face a session WOULD wear. IdentityFace is the one that
  // decides whether a face appears on a card at all. With characters off only
  // a role has a face; any other row draws its badge (the agent mark) alone.
  const id = viewerFace(useLiveIdentityRow(rawRow), useIdentityPrefs());
  const badgeSize = typeof size === "number" ? faceBadgeSize(size) : 0;
  const showBadge = badge && badgeSize > 0;
  const box = avatarLength(size);
  if (id.kind === "none") {
    return badge ? <span className={`inline-flex items-center justify-center flex-shrink-0 text-sol-text-muted ${className ?? ""}`} style={{ width: box, height: box, lineHeight: 0 }} data-identity="plain">{badge}</span> : null;
  }
  return (
    <span className={`relative inline-block flex-shrink-0 ${className ?? ""}`} style={{ width: box, height: box, lineHeight: 0 }}>
      {id.kind === "tile" ? (
        <span className="block" style={{ width: box, height: box, lineHeight: 0 }} data-identity="role">
          <RoleIconTile tile={id.tile} size={size} title={title ?? id.name} block />
        </span>
      ) : (
        <span
          className="block rounded-full"
          style={{ width: box, height: box, lineHeight: 0,  }}
          data-identity={id.role ? "role" : "character"}
        >
          <RoleAvatar avatar={id.avatar} size={size} title={title ?? id.name} />
        </span>
      )}
      {showBadge && (
        <span
          aria-hidden
          data-face-badge
          className="absolute rounded-full bg-sol-card flex items-center justify-center text-sol-text-muted"
          style={{ width: badgeSize, height: badgeSize, right: -1, bottom: -1, boxShadow: "0 0 0 1px var(--sol-bg)" }}
        >
          {badge}
        </span>
      )}
    </span>
  );
}
