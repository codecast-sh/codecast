// The face a role wears (docs/architecture/org-staffing.md S13). A role sits
// beside human photographs on the chart, the scope header, the chat pill and
// the wake card, so it needs a face of its own. This is the one place that
// turns a ROLE ROW into a face, and it picks which of the role's two faces
// the viewer sees (show_characters, roleIcon.ts): its animal (the avatar it
// chose, else the stable default for its handle) or its drawn icon tile. The
// art lives in avatars/RoleAvatar and identity/RoleIconTile.
import { useMemo } from "react";
import { avatarOf } from "@codecast/shared/contracts/orgAvatars";
import { RoleAvatar } from "./avatars";
import { RoleIconTile } from "../identity/RoleIconTile";
import { useInboxStore } from "../../store/inboxStore";
import { useIdentityPrefs } from "../../hooks/useIdentityPrefs";
import { roleIconSig, roleTile, type IdentityPrefs } from "../../lib/sessionIdentity";
import type { RoleIcon } from "@codecast/shared/contracts/roleIcon";

export type RoleLike = { _id?: string; short_id?: string; avatar?: string | null; handle: string; name?: string; icon?: RoleIcon | null };

type RoleRowLike = { _id: string; short_id: string; handle: string; name: string; icon?: RoleIcon | null };

/** The live role row a caller's partial role names, by id, short id or handle. */
function findRole(roles: readonly RoleRowLike[] | undefined, role: RoleLike): RoleRowLike | null {
  if (!roles) return null;
  return roles.find((r) => (role._id && r._id === role._id) || (role.short_id && r.short_id === role.short_id))
    ?? roles.find((r) => r.handle === role.handle) ?? null;
}

/** The tile a role wears with characters off. The caller's role may be a
 *  partial (a chat seat, an assignee chip): the icon and title are read from
 *  the role rows (org.roles), their one home, and the caller's fields only
 *  fill in for a role the rows do not hold. Subscribes only while it draws a
 *  tile, to a signature of that role's title and icon. */
function useRoleTile(role: RoleLike, active: boolean) {
  const sig = useInboxStore((s) => {
    if (!active) return "";
    const r = findRole(s.orgTree?.roles as RoleRowLike[] | undefined, role);
    return r ? `${r._id}|${r.name}|${roleIconSig(r.icon)}` : "";
  });
  return useMemo(() => {
    const live = active ? findRole(useInboxStore.getState().orgTree?.roles as RoleRowLike[] | undefined, role) : null;
    return roleTile({ handle: role.handle, name: live?.name ?? role.name ?? role.handle, icon: role.icon !== undefined ? role.icon : live?.icon });
  }, [sig, active, role.handle, role.name, role.icon]); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * A role's face of `size` px: its animal in a circle, or, for a viewer with
 * characters off, its icon tile. The title (and so the alt text) is the role's
 * name when it has one, else its handle, so a screen reader hears the role
 * rather than the animal.
 */
export function RoleFace({ role, size = 24, className, title, prefs: prefsProp }: { role: RoleLike; size?: number | string; className?: string; title?: string; prefs?: IdentityPrefs }) {
  const prefs = useIdentityPrefs(prefsProp);
  const tile = useRoleTile(role, !prefs.characters);
  if (!prefs.characters) return <RoleIconTile tile={tile} size={size} className={className} title={title ?? tile.title} />;
  return (
    <RoleAvatar
      avatar={avatarOf(role)}
      size={size}
      className={className}
      title={title ?? role.name ?? `@${role.handle}`}
    />
  );
}
