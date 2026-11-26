import { StyleSheet, TouchableOpacity, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import * as Haptics from 'expo-haptics';
import { themedStyles, useTheme } from '@/constants/Theme';
import { setAppMenuOpen } from '@/lib/appMenu';
import { useMenuSignals } from '@/components/nav/Places';

/** The ☰ at the top left of every tab and of a conversation's panel: it opens
 *  the app menu. A dot says something waits behind it, orange for decisions
 *  on you and green for a live huddle, so the menu has a reason to be opened
 *  before anyone knows what is in it; the numbers are on the rows inside.
 *  `onPress` replaces the default open where the menu lives elsewhere (a
 *  conversation's panel leaves for it). */
export function MenuButton({ onPress }: { onPress?: () => void }) {
  const Theme = useTheme();
  const { waiting, live } = useMenuSignals();
  const label = ['Menu', waiting ? `${waiting} to decide` : '', live ? 'a call is live' : ''].filter(Boolean).join(', ');
  return (
    <TouchableOpacity
      style={styles.button}
      onPress={() => {
        void Haptics.selectionAsync();
        if (onPress) onPress();
        else setAppMenuOpen(true);
      }}
      activeOpacity={0.6}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 4 }}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Feather name="menu" size={21} color={Theme.text} />
      {waiting > 0 && <View style={[styles.dot, styles.top, { backgroundColor: Theme.orange, borderColor: Theme.bg }]} />}
      {live && <View style={[styles.dot, styles.bottom, { backgroundColor: Theme.green, borderColor: Theme.bg }]} />}
    </TouchableOpacity>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  button: {
    width: 32,
    height: 32,
    marginLeft: -6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: {
    position: 'absolute',
    right: -2,
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 1.5,
  },
  top: { top: 3 },
  bottom: { bottom: 3 },
}));
