import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Text } from '@/components/Themed';
import { themedStyles, useTheme } from '@/constants/Theme';
import { Mono, useMonoFace } from '@/constants/fonts';
import { TabBarIcon, useTabSignals } from '@/components/nav/TabBarIcon';
import { MOBILE_TABS, MOBILE_TAB_BAR_STYLE, MOBILE_TAB_LABEL_STYLE } from '@codecast/shared/render/mobileTabsStyle';

/** The app's areas at the foot of a conversation's slide-out, drawn as the
 *  tab bar draws them (same icons, labels and badges), so the panel is the
 *  way out of a conversation to anywhere else. */
export function AreaBar({ onLeave }: { onLeave?: () => void }) {
  const Theme = useTheme();
  const router = useRouter();
  const labelFace = useMonoFace(Mono.medium);
  const { unreadCount, chatMentions, anyLive } = useTabSignals();

  return (
    <View style={styles.bar}>
      {MOBILE_TABS.map((t) => (
        <TouchableOpacity
          key={t.name}
          style={styles.item}
          onPress={() => {
            void Haptics.selectionAsync();
            onLeave?.();
            router.navigate(`/(tabs)/${t.name}` as never);
          }}
          activeOpacity={0.6}
          accessibilityRole="button"
          accessibilityLabel={t.title}
        >
          <TabBarIcon
            name={t.icon}
            color={Theme.textMuted}
            badge={t.name === 'chat' ? chatMentions : t.name === 'notifications' ? unreadCount : undefined}
            live={t.name === 'chat' ? anyLive : undefined}
          />
          <Text style={[styles.label, { fontFamily: labelFace }]} numberOfLines={1}>{t.label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  bar: {
    flexDirection: 'row',
    paddingTop: MOBILE_TAB_BAR_STYLE.paddingTop,
    paddingBottom: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Theme.borderLight,
    backgroundColor: Theme.bgAlt,
  },
  item: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
  },
  label: {
    ...MOBILE_TAB_LABEL_STYLE,
    color: Theme.textMuted,
  },
}));
