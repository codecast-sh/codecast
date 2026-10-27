// The face a role wears on the org surfaces (docs/architecture/org-staffing.md
// S13). A role row drawn through the session face, so the chart, the role page
// and a standing session's header resolve one role to one face: its animal, or
// its icon tile for a viewer with characters off.
import type { StyleProp, ViewStyle } from 'react-native';
import { MobileSessionFace } from '@/components/identity';
import { avatarOf } from '@codecast/shared/contracts/orgAvatars';
import type { RoleIcon } from '@codecast/shared/contracts/roleIcon';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { roleRowsOf } from '@codecast/web/lib/roleRows';

/** A whole role row (the org screens), or the partial one a transcript line
 *  carries (an escalation names a role by short id, handle and name). */
type RoleLike = {
  _id?: string; short_id: string; name: string; handle: string; avatar?: string | null;
  status?: string; tenure?: { kind: 'standing' | 'program' } | null; icon?: RoleIcon | null;
};

/** The role's id in the viewer's role rows (lib/roleRows), so the face reads
 *  its live fields there (MobileSessionFace, withLiveRole). Live fields win
 *  only for a role named by `_id` or `short_id`; anything else (a role the
 *  rows do not hold yet) draws from the caller's own snapshot. */
function roleIdOf(s: Parameters<typeof roleRowsOf>[0], role: RoleLike): string | null {
  if (role._id) return role._id;
  return roleRowsOf(s).roles.find((r) => r.short_id === role.short_id)?._id ?? null;
}

export function RoleFace({ role, size = 24, style }: { role: RoleLike; size?: number; style?: StyleProp<ViewStyle> }) {
  const id = useInboxStore((s) => roleIdOf(s as never, role)) ?? role.short_id;
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
