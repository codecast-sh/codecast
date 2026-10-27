// The face a role wears (docs/architecture/org-staffing.md S13). A role sits
// beside human photographs on the chart, the scope header, the chat pill and
// the wake card, so it needs a face of its own. This is the one place that
// turns a ROLE ROW into a face, and it picks which of the role's two faces
// the viewer sees (show_characters, roleIcon.ts): its animal (the avatar it
// chose, else the stable default for its handle) or its drawn icon tile. The
// art lives in avatars/RoleAvatar and identity/RoleIconTile.
import { useMemo } from "react";
import { avatarOf, type AvatarKey } from "@codecast/shared/contracts/orgAvatars";
import { RoleAvatar } from "./avatars";
import { RoleIconTile } from "../identity/RoleIconTile";
import { useInboxStore } from "../../store/inboxStore";
import { useIdentityPrefs } from "../../hooks/useIdentityPrefs";
import { roleIconSig, roleTile, type IdentityPrefs, type RoleRows, type RoleTile } from "../../lib/sessionIdentity";
import { roleRowsOf } from "../../lib/roleRows";
import type { RoleIcon } from "@codecast/shared/contracts/roleIcon";

export type RoleLike = { _id?: string; short_id?: string; avatar?: string | null; handle: string; name?: string; icon?: RoleIcon | null };

type RoleRowLike = RoleRows["roles"][number];
type FaceState = Parameters<typeof roleRowsOf>[0] & { orgTree?: { roles?: readonly { _id: string; handle: string }[] } | null };

/** The live role row a caller's partial role names: by id or short id from
 *  the role rows (lib/roleRows: viewerRoles, their one home). A handle alone
 *  is only unique inside a workspace, so it is read as the active
 *  workspace's role of that handle (the org tree says which id that is). */
function findRole(s: FaceState, role: RoleLike): RoleRowLike | null {
  const roles = roleRowsOf(s).roles;
  if (role._id || role.short_id) return roles.find((r) => (role._id && r._id === role._id) || (role.short_id && r.short_id === role.short_id)) ?? null;
  const id = s.orgTree?.roles?.find((r) => r.handle === role.handle)?._id;
  return id ? roles.find((r) => r._id === id) ?? null : null;
}

/** The role's face as the viewer sees it: its animal, or with characters
 *  off its tile. A caller that names the role by id or short id may hold a
 *  partial or a stale snapshot (a chat seat, an assignee chip): the role
 *  rows' face fields win. A caller that names it by handle alone is drawing
 *  a role of its own making (a hire preview, a template, the intro card): its
 *  own avatar and icon win, and the rows only fill what it left out.
 *  Subscribes to a signature of that role's face fields alone. */
export function useRoleFace(role: RoleLike, characters: boolean): { kind: "animal"; avatar: AvatarKey } | { kind: "tile"; tile: RoleTile } {
  const sig = useInboxStore((s) => {
    const r = findRole(s as FaceState, role);
    return r ? `${r._id}|${r.name}|${r.avatar ?? ""}|${roleIconSig(r.icon)}` : "";
  });
  return useMemo(() => {
    const live = findRole(useInboxStore.getState() as FaceState, role);
    const named = !!(role._id || role.short_id);
    if (characters) return { kind: "animal", avatar: avatarOf({ handle: role.handle, avatar: named ? live?.avatar ?? role.avatar : role.avatar ?? live?.avatar }) };
    const name = (named ? live?.name ?? role.name : role.name ?? live?.name) ?? role.handle;
    const icon = named ? (live ? live.icon : role.icon) : role.icon !== undefined ? role.icon : live?.icon;
    return { kind: "tile", tile: roleTile({ handle: role.handle, name, icon }) };
  }, [sig, characters, role._id, role.short_id, role.handle, role.name, role.avatar, role.icon]); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * A role's face of `size` px: its animal in a circle, or, for a viewer with
 * characters off, its icon tile. The title (and so the alt text) is the role's
 * name when it has one, else its handle, so a screen reader hears the role
 * rather than the animal.
 */
export function RoleFace({ role, size = 24, className, title, prefs: prefsProp }: { role: RoleLike; size?: number | string; className?: string; title?: string; prefs?: IdentityPrefs }) {
  const prefs = useIdentityPrefs(prefsProp);
  const face = useRoleFace(role, prefs.characters);
  if (face.kind === "tile") return <RoleIconTile tile={face.tile} size={size} className={className} title={title ?? face.tile.title} />;
  return (
    <RoleAvatar
      avatar={face.avatar}
      size={size}
      className={className}
      title={title ?? role.name ?? `@${role.handle}`}
    />
  );
}
