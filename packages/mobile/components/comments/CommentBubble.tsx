// A message's comments drawn in place: a tinted bubble under the block they
// are on, its tail pointing up at it, in the text's own column. The text stays
// full width and is never covered; tapping a comment opens it to read the
// whole quote, change the words or remove it.
import { createContext, memo } from 'react';
import { Pressable, StyleSheet, View as RNView } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import type { PendingComment } from '@codecast/web/lib/quoteFormat';
import { Text as RNText } from '@/components/Themed';
import { mixColor } from '@/lib/solColor';
import { themedStyles, useTheme } from '@/constants/Theme';
import { excerpt, quotesWholeUnit } from '@/lib/messageComments';
import { openCommentEditor } from './CommentEditor';

/** The message a markdown body belongs to, when comments can be made on it. */
export type CommentAnchor = { conversationId: string; messageId: string };
export const CommentAnchorContext = createContext<CommentAnchor | null>(null);

export const CommentBubble = memo(function CommentBubble({ conversationId, comments, unitText }: {
  conversationId: string;
  comments: readonly PendingComment[];
  unitText: string;
}) {
  const Theme = useTheme();
  const fill = mixColor(Theme.accent, 11, Theme.bg);
  const rule = mixColor(Theme.accent, 22, Theme.bg);
  return (
    <RNView style={styles.wrap}>
      <RNView style={[styles.tail, { borderBottomColor: fill }]} />
      <RNView style={[styles.bubble, { backgroundColor: fill }]}>
        {comments.map((c, i) => {
          const part = !quotesWholeUnit(c.quote, unitText);
          return (
            <Pressable
              key={c.id}
              onPress={() => openCommentEditor({ conversationId, id: c.id, isNew: false })}
              style={[styles.row, i > 0 && [styles.rowRule, { borderTopColor: rule }]]}
              accessibilityRole="button"
              accessibilityLabel={`Your comment${c.body ? `: ${c.body}` : ''}. Opens it to edit.`}
            >
              <Feather name="message-square" size={13} color={Theme.accent} style={styles.icon} />
              <RNView style={styles.words}>
                {part ? <RNText style={[styles.quote, { color: Theme.textMuted }]} numberOfLines={1}>“{excerpt(c.quote, 90)}”</RNText> : null}
                {c.body
                  ? <RNText style={[styles.body, { color: Theme.text }]}>{c.body}</RNText>
                  : <RNText style={[styles.body, styles.bare, { color: Theme.textMuted }]}>Quoted, no note</RNText>}
              </RNView>
            </Pressable>
          );
        })}
      </RNView>
    </RNView>
  );
});

const styles = themedStyles(() => StyleSheet.create({
  wrap: { marginTop: 2, marginBottom: 4 },
  tail: {
    marginLeft: 16,
    width: 0,
    height: 0,
    borderLeftWidth: 6,
    borderRightWidth: 6,
    borderBottomWidth: 6,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
  },
  bubble: { borderRadius: 10, paddingHorizontal: 11, paddingVertical: 2 },
  row: { flexDirection: 'row', gap: 8, paddingVertical: 6, minHeight: 32 },
  rowRule: { borderTopWidth: StyleSheet.hairlineWidth },
  icon: { marginTop: 3 },
  words: { flex: 1, gap: 1 },
  quote: { fontSize: 12, lineHeight: 17 },
  body: { fontSize: 14, lineHeight: 20 },
  bare: { fontStyle: 'italic' },
}));
