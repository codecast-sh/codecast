import React from 'react';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import {
  Tabs } from 'expo-router';
import { useQuery } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import { View as RNView,
  StyleSheet,
} from 'react-native';
import { Text as RNText } from '@/components/Themed';
import { Theme, TAB_BAR_HEIGHT, themedStyles, useTheme } from '@/constants/Theme';
import { Mono } from '@/constants/fonts';
import { StoreSyncBridge } from '@/components/StoreSyncBridge';
import { useActiveTeamFeature } from '@/lib/teamFeatures';
import { useChatRail } from '@/components/chat/ChannelList';
import type { Id } from '@codecast/convex/convex/_generated/dataModel';

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
      <FontAwesome size={22} style={{ marginBottom: -2 }} {...iconProps} />
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
    position: 'absolute',
    top: -4,
    right: -8,
    backgroundColor: Theme.red,
    borderRadius: 8,
    minWidth: 16,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  badgeText: {
    color: '#fff',
    fontSize: 9,
    fontWeight: '700',
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
  const unreadCount = useQuery(api.notifications.getUnreadCount);
  // The Chat tab's signal: mentions of you get a number; a live huddle
  // anywhere in your teams gets a dot. Both subscriptions are the ones the
  // tab itself holds, so the bar adds no traffic.
  const currentUser = useQuery(api.users.getCurrentUser);
  const activeTeamId = (currentUser?.active_team_id || currentUser?.team_id) as Id<'teams'> | undefined;
  const chatOn = useActiveTeamFeature('chat') === true;
  const chatRail = useChatRail(activeTeamId, chatOn);
  const callConfig = useQuery(api.calls.getCallConfig);
  const liveRooms = useQuery(api.calls.getLiveRooms, callConfig?.enabled ? {} : 'skip');

  return (
    <>
    <StoreSyncBridge />
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: Theme.text,
        tabBarInactiveTintColor: Theme.textMuted0,
        tabBarStyle: {
          backgroundColor: Theme.bgAlt,
          borderTopColor: Theme.borderLight,
          borderTopWidth: 1,
          height: TAB_BAR_HEIGHT,
          paddingTop: 8,
          paddingBottom: 28,
        },
        tabBarLabelStyle: {
          fontSize: 10,
          fontFamily: Mono.medium,
        },
        headerStyle: {
          backgroundColor: Theme.bgAlt,
          borderBottomWidth: 1,
          borderBottomColor: Theme.borderLight,
          shadowOpacity: 0,
          elevation: 0,
        },
        headerTitleStyle: {
          color: Theme.text,
          fontSize: 16,
          fontFamily: Mono.semiBold,
        },
        headerTintColor: Theme.text,
      }}>
      <Tabs.Screen
        name="inbox"
        options={{
          title: 'Inbox',
          headerShown: false,
          tabBarIcon: ({ color }) => <TabBarIcon name="inbox" color={color} />,
        }}
      />
      <Tabs.Screen
        name="chat"
        options={{
          title: 'Chat',
          headerShown: false,
          tabBarIcon: ({ color }) => (
            <TabBarIcon
              name="comments"
              color={color}
              badge={chatRail?.mentionTotal ?? 0}
              live={(liveRooms?.length ?? 0) > 0}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="tasks"
        options={{
          title: 'Tasks',
          headerShown: false,
          tabBarIcon: ({ color }) => <TabBarIcon name="check-square-o" color={color} />,
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
          title: 'Notifications',
          // "Notifications" doesn't fit a 5-tab bar in mono — short label,
          // full title stays on the screen header.
          tabBarLabel: 'Alerts',
          tabBarIcon: ({ color }) => (
            <TabBarIcon name="bell" color={color} badge={unreadCount ?? 0} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color }) => <TabBarIcon name="cog" color={color} />,
        }}
      />
    </Tabs>
    </>
  );
}
