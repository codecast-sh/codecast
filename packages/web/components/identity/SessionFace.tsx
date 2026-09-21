// The face a session wears (session-characters.md S3): its character's
// avatar, or its role's when the row is a role's standing session. A role's
// face carries the org page's violet as a thin ring so a role reads as a role
// at every size; a character has no ring. Sizing and the art live in
// org/avatars; this is the one place a SESSION ROW turns into a face.
import type { ReactNode } from "react";
import { RoleAvatar } from "../org/avatars";
import { avatarLength } from "../../lib/orgAvatars";
import { faceBadgeSize, faceIdentity, type IdentityRow } from "../../lib/sessionIdentity";
import { roleRingStyle } from "../../lib/roleRingStyle";

export function SessionFace({ row, size = 18, className, title, badge }: {
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
  // Always draws a face, even for a row nobody personified: the picker and the
  // hover cards preview the face a session WOULD wear. IdentityFace is the one
  // that decides whether a face appears on a card at all.
  const id = faceIdentity(row);
  const badgeSize = typeof size === "number" ? faceBadgeSize(size) : 0;
  const showBadge = badge && badgeSize > 0;
  const box = avatarLength(size);
  return (
    <span className={`relative inline-block flex-shrink-0 ${className ?? ""}`} style={{ width: box, height: box, lineHeight: 0 }}>
      <span
        className="block rounded-full"
        style={{ width: box, height: box, lineHeight: 0, ...(id.kind === "role" ? roleRingStyle(size) : null) }}
        data-identity={id.kind}
      >
        <RoleAvatar avatar={id.avatar} size={size} title={title ?? ("name" in id ? id.name : undefined)} />
      </span>
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
