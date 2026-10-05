import React from 'react';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import {
  Tabs } from 'expo-router';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { View as RNView,
  StyleSheet,
} from 'react-native';
import { Text as RNText } from '@/components/Themed';
import { Theme, TAB_BAR_HEIGHT, themedStyles, useTheme } from '@/constants/Theme';
import { Mono, useMonoFace } from '@/constants/fonts';
import { useChatUnread } from '@codecast/web/hooks/useChatSync';
import {
  MOBILE_HEADER_STYLE,
  MOBILE_HEADER_TITLE_STYLE,
  MOBILE_TAB,
  MOBILE_TAB_BADGE_STYLE,
  MOBILE_TAB_BADGE_TEXT_STYLE,
  MOBILE_TAB_BAR_STYLE,
  MOBILE_TAB_ICON_SIZE,
  MOBILE_TAB_LABEL_STYLE,
} from '@codecast/shared/render/mobileTabsStyle';

function TabBarIcon(props: {
  name: React.ComponentProps<typeof FontAwesome>['name'];
  color: string;
  badge?: number;
  /** Something is happening there right now (a live huddle): a quiet green
   *  dot, never a number — a count is reserved for things addressed to you. */
  live?: boolean;
}) {
  const Theme = useTheme();
  const { badge, live, ...iconProps } = props;
  return (
    <RNView style={{ position: 'relative' }}>
      <FontAwesome size={MOBILE_TAB_ICON_SIZE} style={{ marginBottom: -2 }} {...iconProps} />
      {badge !== undefined && badge > 0 ? (
        <RNView style={badgeStyles.badge}>
          <RNText style={badgeStyles.badgeText}>
            {badge > 99 ? '99+' : badge}
          </RNText>
        </RNView>
      ) : live ? (
        <RNView style={badgeStyles.liveDot} />
      ) : null}
    </RNView>
  );
}

const badgeStyles = themedStyles((Theme) => StyleSheet.create({
  badge: {
    ...MOBILE_TAB_BADGE_STYLE,
    backgroundColor: Theme.red,
  },
  badgeText: {
    ...MOBILE_TAB_BADGE_TEXT_STYLE,
    fontVariant: ['tabular-nums'],
  },
  liveDot: {
    position: 'absolute',
    top: -3,
    right: -5,
    width: 9,
    height: 9,
    borderRadius: 4.5,
    backgroundColor: Theme.greenBright,
    borderWidth: 1.5,
    borderColor: Theme.bgAlt,
  },
}));

export default function TabLayout() {
  const Theme = useTheme();
  const labelFace = useMonoFace(Mono.medium);
  // The badge counts unread rows in the persisted store list, so it paints at
  // boot and clears in the same tick as a mark-read (web NotificationBell).
  const unreadCount = useInboxStore((s) => {
    let n = 0;
    for (const row of Object.values(s.notifications) as any[]) if (!row.read) n++;
    return n;
  });
  // The Chat tab's signal: mentions of you get a number; a live huddle
  // anywhere in your teams gets a dot. Both subscriptions are the ones the
  // tab itself holds, so the bar adds no traffic.
  // Both read the store the sync bridge feeds: the shared rail's mention
  // count (empty when chat is off for the team) and the live rooms.
  const { mentions: chatMentions } = useChatUnread();
  const anyLive = useInboxStore((s) => (s.liveRooms?.length ?? 0) > 0);

  return (
    <>
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: Theme.text,
        tabBarInactiveTintColor: Theme.textMuted0,
        tabBarStyle: {
          ...MOBILE_TAB_BAR_STYLE,
          backgroundColor: Theme.bgAlt,
          borderTopColor: Theme.borderLight,
          height: TAB_BAR_HEIGHT,
        },
        tabBarLabelStyle: {
          ...MOBILE_TAB_LABEL_STYLE,
          fontFamily: labelFace,
        },
        headerStyle: {
          ...MOBILE_HEADER_STYLE,
          backgroundColor: Theme.bgAlt,
          borderBottomColor: Theme.borderLight,
          shadowOpacity: 0,
          elevation: 0,
        },
        headerTitleStyle: {
          ...MOBILE_HEADER_TITLE_STYLE,
          color: Theme.text,
          fontFamily: Mono.semiBold,
        },
        headerTintColor: Theme.text,
      }}>
      <Tabs.Screen
        name="inbox"
        options={{
          title: MOBILE_TAB.inbox.title,
          headerShown: false,
          tabBarIcon: ({ color }) => <TabBarIcon name={MOBILE_TAB.inbox.icon} color={color} />,
        }}
      />
      <Tabs.Screen
        name="chat"
        options={{
          title: MOBILE_TAB.chat.title,
          headerShown: false,
          tabBarIcon: ({ color }) => (
            <TabBarIcon
              name={MOBILE_TAB.chat.icon}
              color={color}
              badge={chatMentions}
              live={anyLive}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="tasks"
        options={{
          title: MOBILE_TAB.tasks.title,
          headerShown: false,
          tabBarIcon: ({ color }) => <TabBarIcon name={MOBILE_TAB.tasks.icon} color={color} />,
        }}
      />
      <Tabs.Screen
        name="index"
        options={{
          href: null,
        }}
      />
      <Tabs.Screen
        name="notifications"
        options={{
          title: MOBILE_TAB.notifications.title,
          tabBarLabel: MOBILE_TAB.notifications.label,
          tabBarIcon: ({ color }) => (
            <TabBarIcon name={MOBILE_TAB.notifications.icon} color={color} badge={unreadCount ?? 0} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: MOBILE_TAB.settings.title,
          tabBarIcon: ({ color }) => <TabBarIcon name={MOBILE_TAB.settings.icon} color={color} />,
        }}
      />
    </Tabs>
    </>
  );
}
