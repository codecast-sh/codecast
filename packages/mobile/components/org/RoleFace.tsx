// The face a role wears on the org surfaces (docs/architecture/org-staffing.md
// S13). A role row drawn through the session face, so the chart, the role page
// and a standing session's header resolve one role to one face: its animal, or
// its icon tile for a viewer with characters off.
import { useMemo } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { MobileSessionFace } from '@/components/identity';
import { avatarOf } from '@codecast/shared/contracts/orgAvatars';
import type { RoleIcon } from '@codecast/shared/contracts/roleIcon';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { useIdentityPrefs } from '@codecast/web/hooks/useIdentityPrefs';
import { roleIconSig } from '@codecast/web/lib/sessionIdentity';

/** A whole role row (the org screens), or the partial one a transcript line
 *  carries (an escalation names a role by short id, handle and name). */
type RoleLike = {
  _id?: string; short_id: string; name: string; handle: string; avatar?: string | null;
  status?: string; tenure?: { kind: 'standing' | 'program' } | null; icon?: RoleIcon | null;
};

type LiveRole = { _id: string; short_id: string; handle: string; icon?: RoleIcon | null };

function findRole(roles: readonly LiveRole[] | undefined, role: RoleLike): LiveRole | null {
  if (!roles) return null;
  return roles.find((r) => (role._id && r._id === role._id) || r.short_id === role.short_id)
    ?? roles.find((r) => r.handle === role.handle) ?? null;
}

/** The role's icon: the caller's, or for a partial role that carries none, the
 *  one on its row in the org tree, its one home. Subscribes only while the
 *  viewer sees tiles and the caller has no icon to hand. */
function useRoleIcon(role: RoleLike, active: boolean): RoleIcon | null {
  const live = active && role.icon === undefined;
  const sig = useInboxStore((s) => (live ? roleIconSig(findRole(s.orgTree?.roles as LiveRole[] | undefined, role)?.icon) : ''));
  return useMemo(
    () => (role.icon !== undefined ? role.icon : live ? findRole(useInboxStore.getState().orgTree?.roles as LiveRole[] | undefined, role)?.icon ?? null : null),
    [sig, live, role.icon, role._id, role.short_id, role.handle], // eslint-disable-line react-hooks/exhaustive-deps
  );
}

export function RoleFace({ role, size = 24, style }: { role: RoleLike; size?: number; style?: StyleProp<ViewStyle> }) {
  const icon = useRoleIcon(role, !useIdentityPrefs().characters);
  const id = role._id ?? role.short_id;
  return (
    <MobileSessionFace
      size={size}
      style={style}
      row={{
        _id: id,
        standing_role_id: id,
        role: { _id: id, short_id: role.short_id, name: role.name, handle: role.handle, avatar: avatarOf(role), status: role.status ?? 'active', tenure_kind: role.tenure?.kind ?? 'standing', icon },
      }}
    />
  );
}
