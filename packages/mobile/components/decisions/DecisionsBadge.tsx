import { StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { Text } from '@/components/Themed';
import { useTheme, CHROME_FONT_CAP } from '@/constants/Theme';
import { useDecisionQueue } from '@codecast/web/hooks/useDecisionQueue';
import { waitingOnPerson } from '@codecast/web/lib/decisionQueue';
import { useModeWords } from '@codecast/web/lib/surfaces';

// The decisions waiting on you, beside the inbox title: the same count web's
// sidebar shows (rows a lead holds left out), in the mode's words so it
// matches the inbox section it counts. Nothing renders at zero.
export function DecisionsBadge() {
  const Theme = useTheme();
  const router = useRouter();
  const words = useModeWords();
  const count = waitingOnPerson(useDecisionQueue()).length;
  if (count === 0) return null;
  return (
    <TouchableOpacity
      onPress={() => router.push('/decisions')}
      hitSlop={8}
      accessibilityLabel={`${count} ${words.decisionsBadge}`}
      style={[styles.badge, { borderColor: Theme.orange + '66', backgroundColor: Theme.orange + '1a' }]}
    >
      <Text style={[styles.text, { color: Theme.orange }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>
        {count} {words.decisionsBadge}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  badge: { borderRadius: 10, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 2 },
  text: { fontSize: 12, fontWeight: '600' },
});
