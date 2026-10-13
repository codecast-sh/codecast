import { TouchableOpacity } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@/constants/Theme';
import { useModeWords } from '@codecast/web/lib/surfaces';
import { openCompose } from '@/lib/compose';

/** The compose pencil a header carries: opens the new session sheet over
 *  whatever screen it sits on. In the app's action color, since it is the
 *  one thing on the header that makes something new. */
export function ComposeButton({ size = 19 }: { size?: number }) {
  const Theme = useTheme();
  const words = useModeWords();
  return (
    <TouchableOpacity
      onPress={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        openCompose();
      }}
      style={{ width: 36, height: 32, alignItems: 'center', justifyContent: 'center' }}
      hitSlop={{ top: 8, bottom: 8, left: 6, right: 8 }}
      activeOpacity={0.6}
      accessibilityRole="button"
      accessibilityLabel={words.newConversation}
    >
      <Feather name="edit" size={size} color={Theme.blue} />
    </TouchableOpacity>
  );
}
