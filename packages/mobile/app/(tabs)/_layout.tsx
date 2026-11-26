import React, { useMemo } from 'react';
import { Tabs, usePathname } from 'expo-router';
import { SlideOutDrawer } from '@/components/inbox/SlideOutDrawer';
import { TabBarIcon, useTabSignals } from '@/components/nav/TabBarIcon';
import { AppMenu } from '@/components/nav/AppMenu';
import { MenuButton } from '@/components/nav/MenuButton';
import { setAppMenuOpen, useAppMenuOpen } from '@/lib/appMenu';
import { TAB_BAR_HEIGHT, useAppearanceKey, useTheme } from '@/constants/Theme';
import { TYPE_SCALE } from '@codecast/shared/render/typeScale';
import { Mono, useMonoFace } from '@/constants/fonts';
import { useTextSize } from '@/hooks/useTextSize';
import { sizeStyle } from '@/lib/textSize';
import {
  MOBILE_HEADER_STYLE,
  MOBILE_HEADER_TITLE_STYLE,
  MOBILE_TAB,
  MOBILE_TABS,
  MOBILE_TAB_BAR_STYLE,
  MOBILE_TAB_LABEL_STYLE,
} from '@codecast/shared/render/mobileTabsStyle';

export default function TabLayout() {
  const Theme = useTheme();
  // The palette is one object repainted in place, so the memo below keys on
  // the look and scheme themselves.
  const appearance = useAppearanceKey();
  const labelFace = useMonoFace(Mono.medium);
  const titleFace = useMonoFace(Mono.semiBold);
  // React Navigation draws the labels and titles, so the Themed Text never
  // sizes them: they follow the phone's text size here.
  const textSize = useTextSize();
  const { unreadCount, chatMentions, anyLive } = useTabSignals();
  // The app menu slides out from behind every tab; a screen pushed over the
  // tabs (a conversation, a call) has its own, so the drag is live only on a
  // tab's root.
  const onTab = TAB_PATHS.has(usePathname());
  const menuOpen = useAppMenuOpen();

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
        tabBarLabelStyle: sizeStyle({
          ...MOBILE_TAB_LABEL_STYLE,
          // Modern holds words to the type scale's 12pt floor; React
          // Navigation draws the label, so the Text resolver never sees it.
          ...(appearance.startsWith('modern') ? { fontSize: TYPE_SCALE.meta.size } : null),
          fontFamily: labelFace,
        }, textSize),
        headerStyle: {
          ...MOBILE_HEADER_STYLE,
          backgroundColor: Theme.bgAlt,
          borderBottomColor: Theme.borderLight,
          shadowOpacity: 0,
          elevation: 0,
        },
        headerTitleStyle: sizeStyle({
          ...MOBILE_HEADER_TITLE_STYLE,
          color: Theme.text,
          fontFamily: titleFace,
        }, textSize),
        headerTintColor: Theme.text,
        // The tabs that draw their header through the navigator get the
        // same ☰ the others draw in their own.
        headerLeft: menuButton,
        headerLeftContainerStyle: { paddingLeft: 20 },
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
  ), [Theme, appearance, labelFace, titleFace, textSize, unreadCount, chatMentions, anyLive]);

  return (
    <SlideOutDrawer enabled={onTab} open={menuOpen} setOpen={setAppMenuOpen} drawer={menuPanel}>
      {tabs}
    </SlideOutDrawer>
  );
}

const menuPanel = <AppMenu />;
const menuButton = () => <MenuButton />;
const TAB_PATHS = new Set(MOBILE_TABS.map((t) => `/${t.name}`));
