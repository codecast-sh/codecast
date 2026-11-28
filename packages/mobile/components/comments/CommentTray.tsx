// The comments waiting for the next message, above the composer: how many,
// and opened, each one with what it is on and what it says. A row opens that
// comment to edit; sending carries them all (attachReviewToMessage).
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View as RNView } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { sortPendingComments, type PendingComment } from '@codecast/web/lib/quoteFormat';
import { Text as RNText } from '@/components/Themed';
import { themedStyles, useTheme } from '@/constants/Theme';
import { appAlert } from '@/lib/popups';
import { excerpt } from '@/lib/messageComments';
import { openCommentEditor } from './CommentEditor';

type Row = Pick<PendingComment, 'id' | 'quote' | 'body' | 'messageId' | 'blockIndex' | 'createdAt'> & { on: 'text' | 'image' | 'page'; snippet?: string };

/** What a row says the comment is on. */
function onWords(r: Row): string {
  if (r.on === 'image') return 'Picture';
  if (r.on === 'page') return r.snippet ? `Page · “${excerpt(r.snippet, 40)}”` : 'Page';
  return `“${excerpt(r.quote, 44)}”`;
}

export function CommentTray({ conversationId }: { conversationId: string }) {
  const Theme = useTheme();
  const [open, setOpen] = useState(false);
  // A signature of the comments (proposal answers have their own card), so
  // the composer above which this sits re-renders only when they change.
  const sig = useInboxStore((s) => {
    const list = s.reviewComments[conversationId];
    if (!list?.length) return '';
    const rows: Row[] = sortPendingComments(list.filter((c) => !c.proposal)).map((c) => ({
      id: c.id, quote: c.quote, body: c.body, messageId: c.messageId, blockIndex: c.blockIndex, createdAt: c.createdAt,
      on: c.image ? 'image' : c.page ? 'page' : 'text', snippet: c.page?.snippet,
    }));
    return rows.length ? JSON.stringify(rows) : '';
  });
  const rows = useMemo(() => (sig ? (JSON.parse(sig) as Row[]) : []), [sig]);
  if (!rows.length) return null;

  const clear = () => appAlert(`Remove ${rows.length === 1 ? 'this comment' : `all ${rows.length} comments`}?`, 'They will not go with your next message.', [
    { text: 'Cancel', style: 'cancel' },
    {
      text: 'Remove',
      style: 'destructive',
      onPress: () => {
        const s = useInboxStore.getState();
        rows.forEach((r) => s.removeReviewComment(conversationId, r.id));
        setOpen(false);
      },
    },
  ]);

  return (
    <RNView style={styles.tray}>
      <Pressable onPress={() => setOpen((o) => !o)} style={styles.head} accessibilityRole="button" accessibilityState={{ expanded: open }}>
        <Feather name="message-square" size={15} color={Theme.accent} />
        <RNText style={[styles.count, { color: Theme.accent }]}>{rows.length === 1 ? '1 comment' : `${rows.length} comments`}</RNText>
        <RNText style={[styles.rides, { color: Theme.textMuted }]} numberOfLines={1}>{rows.length === 1 ? 'goes' : 'go'} with your next message</RNText>
        <RNView style={styles.spacer} />
        {open ? (
          <Pressable onPress={clear} hitSlop={8} accessibilityRole="button">
            <RNText style={[styles.clear, { color: Theme.textMuted }]}>Clear</RNText>
          </Pressable>
        ) : null}
        <Feather name={open ? 'chevron-down' : 'chevron-up'} size={16} color={Theme.textMuted} />
      </Pressable>
      {open ? rows.map((r) => (
        <Pressable
          key={r.id}
          onPress={() => openCommentEditor({ conversationId, id: r.id, isNew: false })}
          style={[styles.row, { borderTopColor: Theme.border }]}
          accessibilityRole="button"
        >
          <RNText style={[styles.on, { color: Theme.textMuted }]} numberOfLines={1}>{onWords(r)}</RNText>
          <RNText style={[styles.body, { color: r.body ? Theme.text : Theme.textMuted }, !r.body && styles.bare]} numberOfLines={2}>
            {r.body || 'Quoted, no note'}
          </RNText>
        </Pressable>
      )) : null}
    </RNView>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  tray: { marginHorizontal: 12, marginBottom: 6 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 7, minHeight: 36 },
  count: { fontSize: 14, fontWeight: '600' },
  rides: { fontSize: 14, flexShrink: 1 },
  spacer: { flex: 1 },
  clear: { fontSize: 14, marginRight: 10 },
  row: { flexDirection: 'row', gap: 10, paddingVertical: 9, borderTopWidth: StyleSheet.hairlineWidth, minHeight: 44, alignItems: 'flex-start' },
  on: { fontSize: 13, width: '38%', lineHeight: 19 },
  body: { flex: 1, fontSize: 14, lineHeight: 19 },
  bare: { fontStyle: 'italic' },
}));
