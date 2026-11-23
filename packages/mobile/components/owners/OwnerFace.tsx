import { Image, StyleSheet, View } from 'react-native';
import { Text } from '@/components/Themed';
import { useTheme } from '@/constants/Theme';
import { RoleFace } from '@/components/org/RoleFace';

/** A person's face: their picture, else their initials on a quiet disc. */
export function PersonFace({ name, image, size = 18 }: { name: string; image?: string | null; size?: number }) {
  const Theme = useTheme();
  if (image) return <Image source={{ uri: image }} style={{ width: size, height: size, borderRadius: size / 2 }} />;
  const initials = name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return (
    <View
      style={{
        width: size, height: size, borderRadius: size / 2,
        backgroundColor: Theme.bgAlt, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.border,
        alignItems: 'center', justifyContent: 'center',
      }}
    >
      <Text style={{ fontSize: size * 0.42, fontWeight: '600', color: Theme.textMuted }}>{initials || '?'}</Text>
    </View>
  );
}

type FaceRole = { _id?: string; role_id?: string; short_id?: string; handle: string; name?: string | null; avatar?: string | null };

/**
 * One owner's face as the owners chip, the sheet, the composer line and an
 * inbox row draw it (the web's .own-paused): no face is ringed, and a paused
 * role wears a dashed ring and a fade, which reads without colour, on a
 * grayscale screen too.
 */
export function OwnerFace({ person, role, size = 18, paused = false }: {
  person?: { name: string; image?: string | null };
  role?: FaceRole | null;
  size?: number;
  paused?: boolean;
}) {
  const Theme = useTheme();
  return (
    <View
      style={[
        styles.ring,
        { borderRadius: size / 2 + 3, borderColor: paused ? Theme.textMuted : 'transparent' },
        paused && styles.paused,
      ]}
    >
      {role ? (
        <RoleFace
          size={size}
          role={{ _id: role._id ?? role.role_id, short_id: role.short_id ?? '', handle: role.handle, name: role.name || role.handle, avatar: role.avatar ?? null }}
        />
      ) : (
        <PersonFace name={person?.name ?? '?'} image={person?.image} size={size} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  ring: { borderWidth: 1.5, padding: 1 },
  paused: { opacity: 0.6, borderStyle: 'dashed' },
});
