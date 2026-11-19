import { useCallback, useEffect, useRef, useState } from 'react';
import {
  StyleSheet, TouchableOpacity, View as RNView, ScrollView, Platform, Keyboard,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text as RNText } from '@/components/Themed';
import Feather from '@expo/vector-icons/Feather';
import * as Haptics from 'expo-haptics';
import { useTypingReporter } from '@codecast/web/hooks/useChatTyping';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { Theme, Spacing, themedStyles, useTheme } from '@/constants/Theme';
import { MentionStrip, type MentionCandidate } from './MentionStrip';
import { composerAttachments, type ChatAttachmentArg } from './chatUpload';
import { useComposerField, nativeComposerText } from '@/lib/composerField';
import { MessageComposer, ComposerTool, useComposerImages } from '@/components/session/MessageComposer';

// The one chat composer on mobile — channel floor and thread alike. It draws
// the session screen's composer card (MessageComposer), as web chat draws the
// session's MessageInput, with chat's own tools in the bottom row: mention,
// emoji, and in a thread whether the reply also goes to its channel.
//
// It owns the draft, the attachment strip, the typing report and the edit
// banner, and hands the parent a finished (content, attachments) pair. The
// parent owns what a send MEANS (optimistic row, thread scope): the composer
// never talks to chat.sendMessage itself.
//
// Typing is web's own useTypingReporter: a throttled chatTyping.set while
// composing, a clear on send / empty / scope change / unmount.
//
// `draftKey` keeps the draft in the store's drafts (the web composer's key for
// the same box), so it survives leaving the screen and follows to the web.

/** Whether the keyboard is up (iOS reports it before it moves, so the bar's
 *  padding changes with the slide instead of after it). */
function useKeyboardUp(enabled: boolean): boolean {
  const [up, setUp] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const a = Keyboard.addListener(showEvt, () => setUp(true));
    const b = Keyboard.addListener(hideEvt, () => setUp(false));
    return () => { a.remove(); b.remove(); };
  }, [enabled]);
  return up;
}

export type ComposerEdit = { messageId: string; content: string };

// The emoji strip's picks: the common ones, in Slack's frequently-used order.
const QUICK_EMOJI = ['👍', '🙏', '🎉', '✅', '👀', '❤️', '😂', '🔥', '🚀', '💯', '🤔', '😅', '👏', '🙌', '😊', '😢', '⚠️', '❌'];

export function ChatComposerBar({
  channelId,
  threadRootId,
  placeholder,
  placeholderTint,
  mentionCandidates,
  editing,
  onCancelEdit,
  onSubmitEdit,
  onSend,
  draftKey,
  broadcastTo,
  atScreenBottom,
}: {
  channelId: string | undefined;
  threadRootId?: string;
  placeholder: string;
  /** The armed-anchor violet, when a plain reply wakes the agent. */
  placeholderTint?: string;
  mentionCandidates: MentionCandidate[];
  /** Present while editing an existing message: prefills the box, shows the
   *  banner, and routes submit to onSubmitEdit. */
  editing?: ComposerEdit | null;
  onCancelEdit?: () => void;
  onSubmitEdit?: (messageId: string, content: string) => void;
  onSend: (content: string, attachments: ChatAttachmentArg[], opts?: { broadcast?: boolean }) => void;
  draftKey?: string;
  /** A thread reply can also go to its channel (`#eng`): the composer offers
   *  the choice per message, and it resets after each send. */
  broadcastTo?: string;
  /** The bar is the screen's bottom edge: it clears the home indicator while
   *  the keyboard is down, and sits on the keyboard when it is up. */
  atScreenBottom?: boolean;
}) {
  const Theme = useTheme();
  const [storedDraft] = useState(() => (draftKey ? String(useInboxStore.getState().drafts[draftKey]?.draft_message ?? '') : ''));
  const field = useComposerField(storedDraft);
  const { value: draft, setValue: setDraft, onChangeText: applyChange, inputRef, clearAfterSend } = field;
  const images = useComposerImages(setDraft, { placeholders: false });
  const [broadcast, setBroadcast] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const insets = useSafeAreaInsets();
  const keyboardUp = useKeyboardUp(!!atScreenBottom);
  const bottomPad = atScreenBottom && !keyboardUp ? Math.max(8, insets.bottom) : 8;

  // ── Edit mode ─────────────────────────────────────────────────────────────
  // Entering an edit REPLACES the box (the previous draft is small on mobile
  // and restored on cancel); leaving restores it.
  const stashedDraftRef = useRef<string | null>(null);
  const editingId = editing?.messageId;
  useEffect(() => {
    if (editingId && editing) {
      stashedDraftRef.current = stashedDraftRef.current ?? draft;
      setDraft(editing.content);
    } else if (stashedDraftRef.current !== null) {
      setDraft(stashedDraftRef.current);
      stashedDraftRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId]);

  // ── Typing report ─────────────────────────────────────────────────────────
  const { onTyping: reportTyping, stop: stopTyping } = useTypingReporter(channelId, threadRootId);

  // The stored draft follows the box on a debounce, never per keystroke.
  const draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const keepDraft = useCallback((text: string) => {
    if (!draftKey) return;
    clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      const st = useInboxStore.getState();
      if (text.trim()) st.setDraft(draftKey, { draft_message: text });
      else st.clearDraft(draftKey);
    }, 400);
  }, [draftKey]);
  useEffect(() => () => clearTimeout(draftTimer.current), []);

  const onChangeText = useCallback((text: string) => {
    applyChange(text);
    if (!editing) keepDraft(text);
    if (text.trim()) reportTyping();
    else stopTyping();
  }, [applyChange, reportTyping, stopTyping, keepDraft, editing]);

  // ── Tools ─────────────────────────────────────────────────────────────────
  // Mention and emoji write at the end of the box, where the mention strip
  // reads its query, and go through onChangeText so the draft and typing
  // report follow, as a keystroke would.
  const append = useCallback((text: string) => {
    onChangeText(draft + (draft && !/\s$/.test(draft) ? ' ' : '') + text);
    inputRef.current?.focus();
  }, [draft, onChangeText, inputRef]);
  const pickMention = useCallback((next: string) => {
    onChangeText(next);
    inputRef.current?.focus();
  }, [onChangeText, inputRef]);

  // ── Send ──────────────────────────────────────────────────────────────────
  const canSend = draft.trim().length > 0 || images.selectedImages.length > 0;
  const submit = useCallback(() => {
    const content = nativeComposerText(
      inputRef.current as { _lastNativeText?: unknown } | null,
      draft,
    ).trim();
    if (editing && onSubmitEdit) {
      if (!content) return;
      onSubmitEdit(editing.messageId, content);
      setDraft('');
      onCancelEdit?.();
      return;
    }
    const attachments = composerAttachments(images.selectedImages);
    if (!content && attachments.length === 0) return;
    // Clear the box and hand the send over NOW: the row paints in this tick,
    // with any image still uploading shown from its local file, and the store
    // delivers once the bytes land. Remount the native field so iOS cannot
    // restore the just-sent buffer.
    clearAfterSend(content);
    images.clearImages();
    setEmojiOpen(false);
    if (draftKey) { clearTimeout(draftTimer.current); useInboxStore.getState().clearDraft(draftKey); }
    stopTyping();
    if (Platform.OS === 'ios') void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onSend(content, attachments, broadcastTo && broadcast ? { broadcast: true } : undefined);
    setBroadcast(false);
  }, [draft, images, editing, onSubmitEdit, onCancelEdit, onSend, stopTyping, clearAfterSend, inputRef, draftKey, broadcastTo, broadcast, setDraft]);

  const above = (
    <>
      <MentionStrip draft={draft} members={mentionCandidates} onPick={pickMention} />
      {emojiOpen && !editing && (
        <ScrollView
          horizontal
          keyboardShouldPersistTaps="always"
          showsHorizontalScrollIndicator={false}
          style={styles.emojiStrip}
          contentContainerStyle={styles.emojiStripContent}
        >
          {QUICK_EMOJI.map((e) => (
            <TouchableOpacity key={e} style={styles.emoji} onPress={() => append(e)} accessibilityLabel={`Insert ${e}`}>
              <RNText style={styles.emojiText}>{e}</RNText>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
      {editing && (
        <RNView style={styles.editBanner}>
          <Feather name="edit-2" size={11} color={Theme.accent} />
          <RNText style={styles.editText}>Editing message</RNText>
          <TouchableOpacity onPress={onCancelEdit} hitSlop={8}>
            <RNText style={styles.editCancel}>Cancel</RNText>
          </TouchableOpacity>
        </RNView>
      )}
    </>
  );

  const tools = editing ? null : (
    <>
      <ComposerTool icon="at-sign" label="Mention someone" onPress={() => append('@')} />
      <ComposerTool icon="smile" label="Emoji" on={emojiOpen} onPress={() => setEmojiOpen((o) => !o)} />
      {!!broadcastTo && (
        <TouchableOpacity
          style={[styles.broadcast, broadcast && styles.broadcastOn]}
          onPress={() => { void Haptics.selectionAsync(); setBroadcast((b) => !b); }}
          activeOpacity={0.6}
          hitSlop={{ top: 8, bottom: 8 }}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: broadcast }}
          accessibilityLabel={`Also send to ${broadcastTo}`}
        >
          <Feather name={broadcast ? 'check-square' : 'square'} size={13} color={broadcast ? Theme.text : Theme.textMuted} />
          <RNText style={[styles.broadcastText, broadcast && styles.broadcastTextOn]} numberOfLines={1}>
            Also to {broadcastTo}
          </RNText>
        </TouchableOpacity>
      )}
    </>
  );

  return (
    <RNView style={[styles.bar, { paddingBottom: bottomPad }]}>
      <MessageComposer
        field={{ ...field, onChangeText }}
        images={images}
        placeholder={placeholder}
        placeholderColor={placeholderTint}
        canSend={canSend}
        onSend={submit}
        sendIcon={editing ? 'check' : 'arrow-up'}
        attach={!editing}
        tools={tools}
        above={above}
      />
    </RNView>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  bar: {
    backgroundColor: Theme.bgAlt,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Theme.borderLight,
  },
  editBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginHorizontal: 10,
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 10,
    backgroundColor: Theme.accent + '14',
  },
  editText: { flex: 1, fontSize: 12, fontWeight: '600', color: Theme.accent },
  editCancel: { fontSize: 12, fontWeight: '600', color: Theme.textMuted },
  emojiStrip: { flexGrow: 0, marginTop: 6 },
  emojiStripContent: { paddingHorizontal: 10, gap: 2 },
  emoji: { width: 40, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  emojiText: { fontSize: 24 },
  broadcast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 32,
    marginLeft: 6,
    paddingHorizontal: 10,
    borderRadius: 16,
    flexShrink: 1,
  },
  broadcastOn: { backgroundColor: Theme.bgHighlight },
  broadcastText: { fontSize: 13, color: Theme.textMuted, flexShrink: 1 },
  broadcastTextOn: { color: Theme.text, fontWeight: '600' },
}));
