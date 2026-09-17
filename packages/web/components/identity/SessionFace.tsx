// The face a session wears (session-characters.md S3): its character's
// avatar, or its role's when the row is a role's standing session. A role's
// face carries the org page's violet as a thin ring so a role reads as a role
// at every size; a character has no ring. Sizing and the art live in
// org/avatars; this is the one place a SESSION ROW turns into a face.
import type { CSSProperties, ReactNode } from "react";
import { RoleAvatar } from "../org/avatars";
import { characterFor, sessionIdentity, type IdentityRow } from "../../lib/sessionIdentity";

export function roleRingStyle(size: number): CSSProperties {
  // A 1 px ring under 20 px, a gapped 1.5 px ring above, both in the role violet.
  return size < 20
    ? { boxShadow: "0 0 0 1px var(--sol-violet)" }
    : { boxShadow: "0 0 0 1px var(--sol-card), 0 0 0 2.5px var(--sol-violet)" };
}

export function SessionFace({ row, size = 18, className, title, badge }: {
  row: IdentityRow;
  size?: number;
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
  const resolved = sessionIdentity(row, true);
  const id = resolved.kind === "plain" ? { kind: "character" as const, avatar: characterFor(row).avatar } : resolved;
  const showBadge = badge && size >= 16;
  const badgeSize = Math.round(size * 0.46);
  return (
    <span className={`relative inline-block flex-shrink-0 ${className ?? ""}`} style={{ width: size, height: size, lineHeight: 0 }}>
      <span
        className="block rounded-full"
        style={{ width: size, height: size, lineHeight: 0, ...(id.kind === "role" ? roleRingStyle(size) : null) }}
        data-identity={id.kind}
      >
        <RoleAvatar avatar={id.avatar} size={size} title={title ?? ("name" in id ? id.name : undefined)} />
      </span>
      {showBadge && (
        <span
          aria-hidden
          className="absolute rounded-full bg-sol-card flex items-center justify-center text-sol-text-muted"
          style={{ width: badgeSize, height: badgeSize, right: -1, bottom: -1, boxShadow: "0 0 0 1px var(--sol-bg)" }}
        >
          {badge}
        </span>
      )}
    </span>
  );
}
