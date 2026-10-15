import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Text } from '@/components/Themed';
import { themedStyles, useTheme } from '@/constants/Theme';
import { Mono, useMonoFace } from '@/constants/fonts';
import { TabBarIcon, useTabSignals } from '@/components/nav/TabBarIcon';
import { useHostedMode, useModeWords } from '@codecast/web/lib/surfaces';
import { MOBILE_TABS, MOBILE_TAB_BAR_STYLE, MOBILE_TAB_LABEL_STYLE } from '@codecast/shared/render/mobileTabsStyle';

/** The app's areas at the foot of a conversation's slide-out, drawn as the
 *  tab bar draws them (same icons, labels and badges), so the panel is the
 *  way out of a conversation to anywhere else. */
export function AreaBar({ onLeave }: { onLeave?: () => void }) {
  const Theme = useTheme();
  const router = useRouter();
  const hosted = useHostedMode();
  const words = useModeWords();
  const labelFace = useMonoFace(Mono.medium);
  const { unreadCount, chatMentions, anyLive, chatHidden } = useTabSignals();

  return (
    <View style={styles.bar}>
      {MOBILE_TABS.filter((t) => !(t.name === 'chat' && chatHidden)).map((t) => {
        const label = t.name === 'tasks' && hosted ? words.tasksPage
          : t.name === 'notifications' && hosted ? t.title
          : t.label;
        return (
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
              badge={t.name === 'chat' ? chatMentions : t.name === 'notifications' && !hosted ? unreadCount : undefined}
              live={t.name === 'chat' ? anyLive : undefined}
              dot={t.name === 'notifications' && hosted && unreadCount > 0}
            />
            <Text style={[styles.label, { fontFamily: labelFace }]} numberOfLines={1}>{label}</Text>
          </TouchableOpacity>
        );
      })}
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
