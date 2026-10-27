// The face a role wears on the org surfaces (docs/architecture/org-staffing.md
// S13). A role row drawn through the session face, so the chart, the role page
// and a standing session's header resolve one role to one face: its animal, or
// its icon tile for a viewer with characters off.
import type { StyleProp, ViewStyle } from 'react-native';
import { MobileSessionFace } from '@/components/identity';
import { avatarOf } from '@codecast/shared/contracts/orgAvatars';
import type { RoleIcon } from '@codecast/shared/contracts/roleIcon';
import { useInboxStore } from '@codecast/web/store/inboxStore';

/** A whole role row (the org screens), or the partial one a transcript line
 *  carries (an escalation names a role by short id, handle and name). */
type RoleLike = {
  _id?: string; short_id: string; name: string; handle: string; avatar?: string | null;
  status?: string; tenure?: { kind: 'standing' | 'program' } | null; icon?: RoleIcon | null;
};

type FaceState = { viewerRoles?: Record<string, { _id: string; short_id: string }> | null; orgTree?: { roles: readonly { _id: string; handle: string }[] } | null };

/** The role's id in the viewer's role rows (viewerRoles), so the face reads
 *  its live fields there (MobileSessionFace, withLiveRole). A partial role
 *  names it by short id; a handle alone is unique only inside a workspace, so
 *  it is read as the active workspace's role of that handle. Web's RoleFace
 *  resolves the same way. */
function roleIdOf(s: FaceState, role: RoleLike): string | null {
  if (role._id) return role._id;
  for (const id in s.viewerRoles ?? {}) if (s.viewerRoles![id].short_id === role.short_id) return id;
  return s.orgTree?.roles.find((r) => r.handle === role.handle)?._id ?? null;
}

export function RoleFace({ role, size = 24, style }: { role: RoleLike; size?: number; style?: StyleProp<ViewStyle> }) {
  const id = useInboxStore((s) => roleIdOf(s as FaceState, role)) ?? role.short_id;
  return (
    <MobileSessionFace
      size={size}
      style={style}
      row={{
        _id: id,
        standing_role_id: id,
        role: { _id: id, short_id: role.short_id, name: role.name, handle: role.handle, avatar: avatarOf(role), status: role.status ?? 'active', tenure_kind: role.tenure?.kind ?? 'standing', icon: role.icon ?? null },
      }}
    />
  );
}
