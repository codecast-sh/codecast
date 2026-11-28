import { useEffect, useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, View as RNView } from 'react-native';
import * as Haptics from 'expo-haptics';
import Feather from '@expo/vector-icons/Feather';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { genCommentId } from '@codecast/web/lib/reviewActions';
import { openCommentEditor } from '@/components/comments/CommentEditor';
import type { CommentAnchor } from '@/components/comments/CommentBubble';
import { Text as RNText, TextInput } from '@/components/Themed';
import { themedStyles, useTheme } from '@/constants/Theme';
import { Mono } from '@/constants/fonts';
import { create } from 'zustand';
import { copyToClipboard } from '@/lib/clipboard';

const useSelectText = create<{ text: string | null; anchor: CommentAnchor | null }>(() => ({ text: null, anchor: null }));

/** Opens the app's one Select text page on this text (a message as it reads).
 *  With the message it came from, a selection can be commented on. */
export function openSelectText(text: string, anchor?: CommentAnchor) {
  // The menu that asked is still animating away; iOS will not present a page
  // over a sheet mid-dismissal, so open once it has gone.
  setTimeout(() => useSelectText.setState({ text, anchor: anchor ?? null }), 350);
}

/** Mounted once at the root: the page openSelectText shows. */
export function SelectTextHost() {
  const text = useSelectText((s) => s.text);
  const anchor = useSelectText((s) => s.anchor);
  return <SelectTextSheet text={text} anchor={anchor} onClose={() => useSelectText.setState({ text: null, anchor: null })} />;
}

/**
 * A page of text to pick a range out of, with the system's selection handles.
 * It is a read-only text view, not <Text selectable>: on iOS a selectable Text
 * offers only Copy for the whole block. Open with text; null closes it.
 */
export function SelectTextSheet({ text, anchor, onClose, textStyle }: {
  text: string | null;
  /** The message the text is: a selection can then be commented on. */
  anchor?: CommentAnchor | null;
  onClose: () => void;
  textStyle?: any;
}) {
  const Theme = useTheme();
  const [sel, setSel] = useState({ start: 0, end: 0 });
  // The page is mounted once at the root: a new text starts with nothing picked.
  useEffect(() => setSel({ start: 0, end: 0 }), [text]);
  // The page shows bullets and numbers the message draws; they are not its words.
  const picked = text && sel.end > sel.start
    ? text.slice(sel.start, sel.end).replace(/^[ \t]*(?:[•◦▪]|\d+\.)[ \t]+/gm, '').trim()
    : '';
  // The selected words join the batch as a quote, drawn on the message where
  // they fall; the editor opens once this page has gone.
  const comment = () => {
    if (!anchor || !picked) return;
    const id = genCommentId();
    useInboxStore.getState().addReviewComment(anchor.conversationId, {
      id, messageId: anchor.messageId, blockIndex: 0, quote: picked, body: '', createdAt: Date.now(),
    });
    setSel({ start: 0, end: 0 });
    onClose();
    openCommentEditor({ conversationId: anchor.conversationId, id, isNew: true }, 450);
  };
  return (
    <Modal visible={text !== null} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <RNView style={styles.sheet}>
        <RNView style={styles.header}>
          <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button">
            <RNText style={styles.action}>Done</RNText>
          </Pressable>
          <RNText style={styles.title}>Select text</RNText>
          <Pressable
            onPress={() => { if (text) { void copyToClipboard(text); void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); onClose(); } }}
            hitSlop={10}
            accessibilityRole="button"
          >
            <RNText style={[styles.action, styles.actionStrong]}>Copy all</RNText>
          </Pressable>
        </RNView>
        <TextInput
          value={text ?? ''}
          // Android selects nothing in a read-only field, so there it is
          // editable with no keyboard; the value is fixed, so a keystroke
          // changes nothing.
          editable={Platform.OS === 'android'}
          showSoftInputOnFocus={false}
          multiline
          scrollEnabled
          style={[styles.body, textStyle]}
          accessibilityLabel="Text to select"
          onSelectionChange={(e) => setSel(e.nativeEvent.selection)}
        />
        {anchor && picked ? (
          <RNView style={styles.pillRow} pointerEvents="box-none">
            <Pressable onPress={comment} style={[styles.pill, { backgroundColor: Theme.text }]} accessibilityRole="button">
              <Feather name="message-square" size={16} color={Theme.bg} />
              <RNText style={[styles.pillText, { color: Theme.bg }]}>Comment on selection</RNText>
            </Pressable>
          </RNView>
        ) : null}
      </RNView>
    </Modal>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  sheet: { flex: 1, backgroundColor: Theme.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, height: 52, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Theme.border },
  title: { fontSize: 15, fontFamily: Mono.semiBold, color: Theme.text },
  action: { fontSize: 15, color: Theme.textMuted },
  actionStrong: { color: Theme.accent ?? Theme.text, fontFamily: Mono.semiBold },
  body: { flex: 1, padding: 14, fontSize: 15, lineHeight: 24, color: Theme.text },
  pillRow: { position: 'absolute', left: 0, right: 0, bottom: 36, alignItems: 'center' },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 18, height: 44, borderRadius: 22, shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 6 },
  pillText: { fontSize: 15, fontWeight: '600' },
}));
