// The face a role wears on the org surfaces (docs/architecture/org-staffing.md
// S13). A role row drawn through the session face, so the chart, the role page
// and a standing session's header resolve one role to one face.
import type { StyleProp, ViewStyle } from 'react-native';
import { MobileSessionFace } from '@/components/identity';
import { avatarOf } from '@codecast/shared/contracts/orgAvatars';
import type { OrgRole } from '@codecast/web/components/org/orgTypes';

export function RoleFace({ role, size = 24, style }: { role: OrgRole; size?: number; style?: StyleProp<ViewStyle> }) {
  return (
    <MobileSessionFace
      size={size}
      style={style}
      row={{
        _id: role._id,
        standing_role_id: role._id,
        role: { _id: role._id, short_id: role.short_id, name: role.name, handle: role.handle, avatar: avatarOf(role), status: role.status, tenure_kind: role.tenure?.kind ?? 'standing' },
      }}
    />
  );
}
