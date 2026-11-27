// The call screen's Board button (pl-1145): opens the call's board on its
// own native screen (app/call-board), over the call, which keeps running.
import { Pressable, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/components/Themed';
// The call stage is always dark (app/call.tsx pins the same palette).
import { SolarizedLight as Theme } from '@/constants/Theme';
import { callBoardRoute } from '@/lib/calls/callBoardRoute';

export function CallBoardButton({ roomKey }: { roomKey: string | null }) {
  const router = useRouter();
  if (!roomKey) return null;
  return (
    <Pressable
      onPress={() => router.push(callBoardRoute(roomKey) as any)}
      hitSlop={6}
      style={({ pressed }) => [styles.btn, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel="Open the call's board"
    >
      <Ionicons name="easel-outline" size={15} color={Theme.bgAlt} />
      <Text style={styles.text}>board</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 44, paddingHorizontal: 8, opacity: 0.8 },
  text: { fontSize: 12, color: Theme.bgAlt },
  pressed: { opacity: 0.6 },
});
