// The face a session wears, on the phone (docs/architecture/session-characters.md
// S3). The same 24 painted portraits the web draws, from the same files, picked
// by the same resolver: only the drawing is React Native. A role's face carries
// the role violet as a ring; a character has none.
//
// The art is a plain Image of a WebP file. Nothing here draws through
// react-native-svg, so a face adds no native library to the bundle.
import type { ReactNode } from 'react';
import { Image, View, type ImageSourcePropType, type StyleProp, type ViewStyle } from 'react-native';
import { AVATAR_LABELS, AVATAR_URLS } from '@codecast/web/lib/orgAvatars';
import type { AvatarKey } from '@codecast/shared/contracts/orgAvatars';
import { faceBadgeSize, faceIdentity, type IdentityRow } from '@codecast/web/lib/sessionIdentity';
import { useTheme } from '@/constants/Theme';

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
  const id = faceIdentity(row);
  const badgeSize = faceBadgeSize(size);
  // A 1 px ring under 20 px, a gapped ring above, both in the role violet.
  const ring = id.kind !== 'role' ? 0 : size < 20 ? 1 : 1.5;
  const gap = ring && size >= 20 ? 1 : 0;
  const outer = size + 2 * (ring + gap);
  return (
    <View
      style={[{ width: size, height: size, flexShrink: 0, alignItems: 'center', justifyContent: 'center' }, style]}
      accessibilityRole="image"
      accessibilityLabel={id.name ?? AVATAR_LABELS[id.avatar]}
      testID={`session-face-${id.kind}-${id.avatar}`}
    >
      {ring > 0 && (
        <View
          pointerEvents="none"
          style={{ position: 'absolute', width: outer, height: outer, borderRadius: outer / 2, borderWidth: ring, borderColor: Theme.violet }}
        />
      )}
      <Image source={AVATAR_SOURCES[id.avatar]} style={{ width: size, height: size, borderRadius: size / 2 }} />
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
