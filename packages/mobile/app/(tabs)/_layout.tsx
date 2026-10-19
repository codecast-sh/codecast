import React, { useMemo } from 'react';
import { Tabs, usePathname } from 'expo-router';
import { SlideOutDrawer } from '@/components/inbox/SlideOutDrawer';
import { TabBarIcon, useTabSignals } from '@/components/nav/TabBarIcon';
import { InboxDrawer } from '@/components/inbox/InboxDrawer';
import { setInboxDrawerOpen, useInboxDrawerOpen } from '@/lib/inboxDrawer';
import { TAB_BAR_HEIGHT, useActiveLook, useActiveScheme, useTheme } from '@/constants/Theme';
import { Mono, Serif, pageTitleFace, useMonoFace } from '@/constants/fonts';
import { useHostedMode, useModeWords } from '@codecast/web/lib/surfaces';
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
  // the appearance itself.
  const scheme = useActiveScheme();
  const look = useActiveLook();
  const labelFace = useMonoFace(Mono.medium);
  const titleFace = useMonoFace(Mono.semiBold);
  const hosted = useHostedMode();
  const words = useModeWords();
  const { unreadCount, chatMentions, anyLive, chatHidden } = useTabSignals();
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
        // Hosted mode titles a page as the Inbox and To-dos tabs do: on the
        // left, in the reading face (pageTitleFace), so every tab opens on
        // the same frame.
        headerTitleAlign: hosted ? 'left' : undefined,
        headerTitleStyle: hosted ? {
          fontFamily: Serif.regular,
          fontSize: pageTitleFace('family').fontSize,
          color: Theme.text,
        } : {
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
          href: chatHidden ? null : undefined,
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
          // The tab opens on the To-dos list, named by mode as its page is.
          title: hosted ? words.tasksPage : MOBILE_TAB.tasks.title,
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
          // Five developer tabs need the short "Alerts"; hosted mode's four
          // have room for the page's own name, the one Settings uses too.
          tabBarLabel: hosted ? MOBILE_TAB.notifications.title : MOBILE_TAB.notifications.label,
          tabBarIcon: ({ color }) => (
            <TabBarIcon name={MOBILE_TAB.notifications.icon} color={color} badge={hosted ? 0 : unreadCount ?? 0} dot={hosted && unreadCount > 0} />
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
  ), [Theme, scheme, look, labelFace, titleFace, hosted, words, unreadCount, chatMentions, anyLive, chatHidden]);

  return (
    <SlideOutDrawer enabled={onInbox} open={drawerOpen} setOpen={setInboxDrawerOpen} drawer={drawerPanel}>
      {tabs}
    </SlideOutDrawer>
  );
}

const drawerPanel = <InboxDrawer />;
