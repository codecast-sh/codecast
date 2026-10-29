// The face a session wears, on the phone (docs/architecture/session-characters.md
// S3). The same 24 painted portraits the web draws, from the same files, picked
// by the same resolver: only the drawing is React Native. With the viewer's
// characters off, a role wears its icon tile (MobileRoleIconTile) and any
// other row has no face, only its badge.
//
// The art is a plain Image of a WebP file.
import type { ReactNode } from 'react';
import { Image, View, type ImageSourcePropType, type StyleProp, type ViewStyle } from 'react-native';
import { AVATAR_LABELS, AVATAR_URLS } from '@codecast/web/lib/orgAvatars';
import type { AvatarKey } from '@codecast/shared/contracts/orgAvatars';
import { faceBadgeSize, viewerFace, type IdentityRow } from '@codecast/web/lib/sessionIdentity';
import { useIdentityPrefs } from '@codecast/web/hooks/useIdentityPrefs';
import { useLiveIdentityRow } from '@codecast/web/hooks/useLiveIdentityRow';
import { useTheme } from '@/constants/Theme';
import { MobileRoleIconTile } from './MobileRoleIconTile';

// Vite hands the web a URL string for each file; Metro hands the phone an
// asset number for the same import.
const AVATAR_SOURCES = AVATAR_URLS as unknown as Record<AvatarKey, ImageSourcePropType>;

export function MobileSessionFace({ row, size = 18, style, badge }: {
  row: IdentityRow;
  size?: number;
  style?: StyleProp<ViewStyle>;
  /** A small mark on the face's lower right (the agent brand). Skipped under
   *  16 px, where it would be a smudge. */
  badge?: ReactNode;
}) {
  const Theme = useTheme();
  // The role read live from the role rows (lib/roleRows), so a row whose
  // cached role snapshot lacks a field (an icon) still draws it.
  const id = viewerFace(useLiveIdentityRow(row), useIdentityPrefs());
  const badgeSize = faceBadgeSize(size);
  if (id.kind === 'none') {
    return badge ? <View style={[{ width: size, height: size, flexShrink: 0, alignItems: 'center', justifyContent: 'center' }, style]} testID="session-face-plain">{badge}</View> : null;
  }
  return (
    <View
      style={[{ width: size, height: size, flexShrink: 0, alignItems: 'center', justifyContent: 'center' }, style]}
      accessibilityRole="image"
      accessibilityLabel={id.kind === 'tile' ? id.name : id.name ?? AVATAR_LABELS[id.avatar]}
      testID={id.kind === 'tile' ? `session-face-tile-${id.tile.icon?.concept ?? 'monogram'}` : `session-face-${id.role ? 'role' : 'character'}-${id.avatar}`}
    >
      {id.kind === 'tile'
        ? <MobileRoleIconTile tile={id.tile} size={size} label={id.name} />
        : <Image source={AVATAR_SOURCES[id.avatar]} style={{ width: size, height: size, borderRadius: size / 2 }} />}
      {!!badge && badgeSize > 0 && (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute', right: -1, bottom: -1, width: badgeSize, height: badgeSize, borderRadius: badgeSize / 2,
            backgroundColor: Theme.card, borderWidth: 1, borderColor: Theme.bg, alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
          }}
        >
          {badge}
        </View>
      )}
    </View>
  );
}
