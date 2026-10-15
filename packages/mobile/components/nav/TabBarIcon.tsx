import React from 'react';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { View as RNView, StyleSheet } from 'react-native';
import { Text as RNText } from '@/components/Themed';
import { themedStyles, useTheme } from '@/constants/Theme';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { useChatUnread } from '@codecast/web/hooks/useChatSync';
import { useHostedMode } from '@codecast/web/lib/surfaces';
import { useActiveTeamId } from '@/hooks/useWorkspaceArgs';
import { MOBILE_TAB_BADGE_STYLE, MOBILE_TAB_BADGE_TEXT_STYLE, MOBILE_TAB_ICON_SIZE } from '@codecast/shared/render/mobileTabsStyle';

/** What the app's areas have waiting, as the tab bar and a conversation's
 *  slide-out show it: unread alerts, chat mentions, a live huddle, and
 *  whether Chat exists at all for this workspace. */
export function useTabSignals() {
  const hosted = useHostedMode();
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
// Chat and huddles are a team's rooms. In hosted mode the personal
// workspace has none, so the tab steps out rather than opening on an empty
// "No team yet"; picking a team brings it back.
const activeTeamId = useActiveTeamId();
const chatHidden = hosted && !activeTeamId;
  return { unreadCount, chatMentions, anyLive, chatHidden };
}

export function TabBarIcon(props: {
  name: React.ComponentProps<typeof FontAwesome>['name'];
  color: string;
  badge?: number;
  /** Something is happening there right now (a live huddle): a quiet green
   *  dot, never a number — a count is reserved for things addressed to you. */
  live?: boolean;
  /** Unread without a count: hosted mode's quiet accent dot, as the web's
   *  bell shows in hosted mode. */
  dot?: boolean;
}) {
  const Theme = useTheme();
  const { badge, live, dot, ...iconProps } = props;
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
      ) : dot ? (
        <RNView style={badgeStyles.unreadDot} />
      ) : null}
    </RNView>
  );
}

const badgeStyles = themedStyles((Theme, look) => StyleSheet.create({
  // The family look has one accent, so a count wears it rather than red.
  badge: {
    ...MOBILE_TAB_BADGE_STYLE,
    backgroundColor: look === 'family' ? Theme.orange : Theme.red,
  },
  badgeText: {
    ...MOBILE_TAB_BADGE_TEXT_STYLE,
    fontVariant: ['tabular-nums'],
  },
  unreadDot: {
    position: 'absolute',
    top: -2,
    right: -4,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Theme.orange,
    borderWidth: 1.5,
    borderColor: Theme.bgAlt,
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

