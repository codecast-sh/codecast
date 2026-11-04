import React, { useMemo } from 'react';
import { Tabs, usePathname } from 'expo-router';
import { SlideOutDrawer } from '@/components/inbox/SlideOutDrawer';
import { TabBarIcon, useTabSignals } from '@/components/nav/TabBarIcon';
import { InboxDrawer } from '@/components/inbox/InboxDrawer';
import { setInboxDrawerOpen, useInboxDrawerOpen } from '@/lib/inboxDrawer';
import { TAB_BAR_HEIGHT, useActiveScheme, useTheme } from '@/constants/Theme';
import { Mono, useMonoFace } from '@/constants/fonts';
import {
  MOBILE_HEADER_STYLE,
  MOBILE_HEADER_TITLE_STYLE,
  MOBILE_TAB,
  MOBILE_TAB_BAR_STYLE,
  MOBILE_TAB_LABEL_STYLE,
} from '@codecast/shared/render/mobileTabsStyle';

export default function TabLayout() {
  const Theme = useTheme();
  // The palette is one object repainted in place, so the memo below keys on
  // the scheme itself.
  const scheme = useActiveScheme();
  const labelFace = useMonoFace(Mono.medium);
  const titleFace = useMonoFace(Mono.semiBold);
  const { unreadCount, chatMentions, anyLive } = useTabSignals();
  // The slide-out panel belongs to the inbox: its drag is live only there.
  const onInbox = usePathname() === '/inbox';
  const drawerOpen = useInboxDrawerOpen();

  // The tabs are memoized on what they read: the pathname changes on every
  // tab press, and rebuilding the navigator then re-rendered every tab.
  const tabs = useMemo(() => (
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
          fontFamily: titleFace,
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
  ), [Theme, scheme, labelFace, titleFace, unreadCount, chatMentions, anyLive]);

  return (
    <SlideOutDrawer enabled={onInbox} open={drawerOpen} setOpen={setInboxDrawerOpen} drawer={drawerPanel}>
      {tabs}
    </SlideOutDrawer>
  );
}

const drawerPanel = <InboxDrawer />;
