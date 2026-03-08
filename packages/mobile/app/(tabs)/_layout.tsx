import React from 'react';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Tabs } from 'expo-router';
import { useQuery } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import { View as RNView, Text as RNText, StyleSheet } from 'react-native';
import { Theme } from '@/constants/Theme';

function TabBarIcon(props: {
  name: React.ComponentProps<typeof FontAwesome>['name'];
  color: string;
  badge?: number;
}) {
  const { badge, ...iconProps } = props;
  return (
    <RNView style={{ position: 'relative' }}>
      <FontAwesome size={22} style={{ marginBottom: -2 }} {...iconProps} />
      {badge !== undefined && badge > 0 && (
        <RNView style={badgeStyles.badge}>
          <RNText style={badgeStyles.badgeText}>
            {badge > 99 ? '99+' : badge}
          </RNText>
        </RNView>
      )}
    </RNView>
  );
}

const badgeStyles = StyleSheet.create({
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
});

export default function TabLayout() {
  const unreadCount = useQuery(api.notifications.getUnreadCount);

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: Theme.text,
        tabBarInactiveTintColor: Theme.textMuted0,
        tabBarStyle: {
          backgroundColor: Theme.bgAlt,
          borderTopColor: Theme.borderLight,
          borderTopWidth: 1,
          height: 84,
          paddingTop: 8,
          paddingBottom: 28,
        },
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '500',
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
          fontSize: 17,
          fontWeight: '600',
        },
        headerTintColor: Theme.text,
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Inbox',
          headerShown: false,
          tabBarIcon: ({ color }) => <TabBarIcon name="inbox" color={color} />,
        }}
      />
      <Tabs.Screen
        name="sessions"
        options={{
          title: 'Sessions',
          headerShown: false,
          tabBarIcon: ({ color }) => <TabBarIcon name="list" color={color} />,
        }}
      />
      <Tabs.Screen
        name="team"
        options={{
          title: 'Team',
          headerShown: false,
          tabBarIcon: ({ color }) => <TabBarIcon name="users" color={color} />,
        }}
      />
      <Tabs.Screen
        name="notifications"
        options={{
          title: 'Notifications',
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
  );
}
