// The one place a comment's words are written on the phone. A comment is an
// item of the conversation's quote batch (store reviewComments); it rides the
// next message sent there as a quote with these words under it.
//
// Opened on a comment that already sits in the batch: a new one is added first
// (so its highlight and bubble show behind the sheet while you type) and is
// removed again if you cancel. The panel is a plain overlay so a full-screen
// viewer that is itself a modal (the image gallery) can draw it inside; the
// host mounted at the root wraps it in a modal for every other screen.
import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View as RNView } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import * as Haptics from 'expo-haptics';
import { create } from 'zustand';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import type { PendingComment } from '@codecast/web/lib/quoteFormat';
import { Text as RNText, TextInput } from '@/components/Themed';
import { themedStyles, useTheme } from '@/constants/Theme';

export type CommentEditorTarget = {
  conversationId: string;
  id: string;
  /** Made for this editor: Cancel takes it back out of the batch. */
  isNew: boolean;
  /** A viewer that draws the panel itself; the root host stays closed. */
  surface?: 'gallery';
};

export const useCommentEditor = create<{ open: CommentEditorTarget | null }>(() => ({ open: null }));

export function openCommentEditor(target: CommentEditorTarget, delayMs = 0) {
  const open = () => {
    // A new comment left with nothing written, whose editor this replaces,
    // was never said: it does not ride the next message.
    dropUnwritten(useCommentEditor.getState().open, target.id);
    useCommentEditor.setState({ open: target });
  };
  // A menu that asked is still animating away; iOS will not present over a
  // sheet mid-dismissal.
  if (delayMs) setTimeout(open, delayMs);
  else open();
}

function dropUnwritten(prev: CommentEditorTarget | null, keep?: string) {
  if (!prev?.isNew || prev.id === keep) return;
  const s = useInboxStore.getState();
  const c = s.reviewComments[prev.conversationId]?.find((x) => x.id === prev.id);
  if (c && !c.body.trim()) s.removeReviewComment(prev.conversationId, prev.id);
}

function closeEditor() {
  useCommentEditor.setState({ open: null });
}

// The open panel's own close (keep what was written, drop a new comment left
// empty), for the system's back and for a viewer closing under it.
let activeDismiss: (() => void) | null = null;

/** Close the editor as tapping away does. */
export function dismissCommentEditor() {
  if (activeDismiss) activeDismiss();
  else {
    dropUnwritten(useCommentEditor.getState().open);
    closeEditor();
  }
}

/** What the comment is on, in words, for the editor's head. */
function anchorWords(c: PendingComment): string {
  if (c.image) return c.image.point ? 'A spot on the picture' : 'The picture';
  if (c.page) return c.page.snippet ? c.page.snippet : 'A spot on the page';
  return c.quote;
}

export function CommentEditorPanel({ target }: { target: CommentEditorTarget }) {
  const Theme = useTheme();
  const comment = useInboxStore((s) => s.reviewComments[target.conversationId]?.find((c) => c.id === target.id));
  const [body, setBody] = useState(comment?.body ?? '');
  const bodyRef = useRef(body);
  bodyRef.current = body;
  const settled = useRef(false);

  // The comment went out with a send, or was removed elsewhere: nothing to edit.
  useEffect(() => {
    if (!comment) closeEditor();
  }, [comment]);

  const save = () => {
    if (settled.current) return;
    settled.current = true;
    const s = useInboxStore.getState();
    s.commitReviewComment(target.conversationId, target.id, bodyRef.current.trim());
    if (s.reviewEditingId === target.id) s.setReviewEditingId(null);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    closeEditor();
  };
  const remove = () => {
    if (settled.current) return;
    settled.current = true;
    useInboxStore.getState().removeReviewComment(target.conversationId, target.id);
    closeEditor();
  };
  // Tapping away keeps what was written, and drops a new comment left empty.
  const dismiss = () => (target.isNew && !bodyRef.current.trim() ? remove() : save());
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;
  useEffect(() => {
    const run = () => dismissRef.current();
    activeDismiss = run;
    return () => { if (activeDismiss === run) activeDismiss = null; };
  }, []);

  if (!comment) return null;
  const quote = anchorWords(comment);
  return (
    <RNView style={StyleSheet.absoluteFill}>
      <Pressable style={[StyleSheet.absoluteFill, styles.backdrop]} onPress={dismiss} accessibilityLabel="Close the comment" />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.avoid} pointerEvents="box-none">
        <RNView style={styles.card}>
          <RNView style={styles.head}>
            <Feather name="message-square" size={14} color={Theme.accent} />
            <RNText style={styles.headText}>Comment · goes with your next message</RNText>
          </RNView>
          {quote ? (
            <ScrollView style={styles.quoteBox} contentContainerStyle={styles.quoteInner}>
              <RNText style={styles.quote}>{quote}</RNText>
            </ScrollView>
          ) : null}
          <TextInput
            value={body}
            onChangeText={setBody}
            placeholder={comment.image || comment.page ? 'What about this spot?' : 'What about this?'}
            placeholderTextColor={Theme.textMuted0}
            multiline
            autoFocus
            style={styles.input}
            accessibilityLabel="Your comment"
          />
          <RNView style={styles.buttons}>
            <Pressable onPress={remove} hitSlop={10} accessibilityRole="button">
              <RNText style={target.isNew ? styles.cancel : styles.removeText}>{target.isNew ? 'Cancel' : 'Remove'}</RNText>
            </Pressable>
            <Pressable onPress={save} style={styles.save} accessibilityRole="button">
              <RNText style={styles.saveText}>Save</RNText>
            </Pressable>
          </RNView>
        </RNView>
      </KeyboardAvoidingView>
    </RNView>
  );
}

/** Mounted once at the root: the editor for every screen but a viewer that draws its own. */
export function CommentEditorHost() {
  const open = useCommentEditor((s) => s.open);
  const target = open && !open.surface ? open : null;
  return (
    <Modal visible={!!target} transparent animationType="fade" statusBarTranslucent onRequestClose={dismissCommentEditor}>
      {target ? <CommentEditorPanel key={target.id} target={target} /> : null}
    </Modal>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  backdrop: { backgroundColor: 'rgba(0,0,0,0.35)' },
  avoid: { flex: 1, justifyContent: 'flex-end' },
  card: {
    backgroundColor: Theme.card,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 18,
    gap: 10,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  headText: { fontSize: 13, color: Theme.textMuted, fontWeight: '600' },
  quoteBox: { maxHeight: 96, borderLeftWidth: 3, borderLeftColor: Theme.accent },
  quoteInner: { paddingHorizontal: 10, paddingVertical: 2 },
  quote: { fontSize: 14, lineHeight: 20, color: Theme.textMuted },
  input: {
    minHeight: 72,
    maxHeight: 180,
    borderWidth: 1,
    borderColor: Theme.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 10,
    fontSize: 16,
    lineHeight: 22,
    color: Theme.text,
    textAlignVertical: 'top',
  },
  buttons: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44 },
  cancel: { fontSize: 15, color: Theme.textMuted },
  removeText: { fontSize: 15, color: Theme.red },
  save: { backgroundColor: Theme.accent, borderRadius: 20, paddingHorizontal: 22, height: 40, justifyContent: 'center' },
  saveText: { color: Theme.bg, fontSize: 15, fontWeight: '600' },
}));
