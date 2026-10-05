// A conversation in a list: a state dot, its name, one line of where it
// stands, and when it last moved (web components/simple/ConversationRow.tsx).
import { View } from 'react-native';
import { router } from 'expo-router';
import { Text } from '@/components/Themed';
import type { InboxSession } from '@codecast/web/store/inboxStore';
import { formatRelativeTime } from '@codecast/web/lib/conversationFormat';
import { conversationPath, conversationSubline, conversationTitle, type ConversationState } from '@codecast/web/components/simple/lane';
import { LaneRow, StateDot } from './LaneUI';
import { useLaneTheme } from './laneTheme';

export function ConversationRow({ row, state, now, first }: { row: InboxSession; state: ConversationState; now: number; first: boolean }) {
  const { s } = useLaneTheme();
  const sub = conversationSubline(row, state);
  const title = conversationTitle(row);
  return (
    <LaneRow first={first} label={title} onPress={() => router.push(conversationPath(String(row._id)) as never)}>
      <StateDot state={state} />
      <View style={s.rowMain}>
        <Text style={s.rowTitle} numberOfLines={1}>{title}</Text>
        {sub ? <Text style={s.rowSub} numberOfLines={1}>{sub}</Text> : null}
      </View>
      <Text style={s.rowAside}>{formatRelativeTime(row.updated_at, now)}</Text>
    </LaneRow>
  );
}
