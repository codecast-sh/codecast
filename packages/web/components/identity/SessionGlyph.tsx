// The one-glyph rule for a session row (docs/architecture/session-characters.md
// S3). A personified row wears its face — its character, or its role's when it
// is a role's standing session; a row nobody personified keeps whatever mark
// the surface drew before it (an agent brand, a session icon, a star). Every
// list that shows sessions calls this rather than deciding for itself, so the
// same session looks the same in the palette, the search page, the sidebar and
// a task's linked sessions.
import type { ReactNode } from "react";
import { sessionIdentity, type IdentityRow } from "../../lib/sessionIdentity";
import { useIdentityPrefs } from "../../hooks/useIdentityPrefs";
import { SessionFace } from "./SessionFace";
import { useLiveIdentityRow } from "../../hooks/useLiveIdentityRow";

export function SessionGlyph({ row: rawRow, size = 16, className, fallback = null, badge }: {
  row: IdentityRow | null | undefined;
  size?: number | string;
  className?: string;
  /** What this surface drew before characters existed. */
  fallback?: ReactNode;
  badge?: ReactNode;
}) {
  const prefs = useIdentityPrefs();
  const row = useLiveIdentityRow(rawRow ?? null);
  if (!row) return <>{fallback}</>;
  if (sessionIdentity(row, prefs).kind === "plain") return <>{fallback}</>;
  return <SessionFace row={row} size={size} className={className} badge={badge} />;
}
