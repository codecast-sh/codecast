import { useCallback, useEffect, useRef, useState } from 'react';
import {
  StyleSheet, TouchableOpacity, View as RNView, Image, ActivityIndicator, Platform,
} from 'react-native';
import { Text as RNText, TextInput as ThemedTextInput } from '@/components/Themed';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import * as Haptics from 'expo-haptics';
import { useConvex, useMutation } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import type { Id } from '@codecast/convex/convex/_generated/dataModel';
import { Theme, Spacing } from '@/constants/Theme';
import { MentionStrip, type MentionCandidate } from './MentionStrip';
import {
  pickImages, startUpload, settleAttachments,
  type ChatAttachmentArg, type PickedImage,
} from './chatUpload';

// The one chat composer on mobile — channel floor and thread alike.
//
// It owns the draft, the attachment strip, the typing report and the edit
// banner, and hands the parent a finished (content, attachments) pair. The
// parent owns what a send MEANS (optimistic row, thread scope): the composer
// never talks to chat.sendMessage itself.
//
// Typing mirrors web's useTypingReporter: a throttled chatTyping.set while
// composing, a clear on send / empty / unmount. The throttle interval stays
// under the server's freshness window so a steadily-typing person never
// flickers off.

const TYPING_THROTTLE_MS = 2_500;

export type ComposerEdit = { messageId: string; content: string };

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
  onSend: (content: string, attachments: ChatAttachmentArg[]) => void;
}) {
  const convex = useConvex();
  const [draft, setDraft] = useState('');
  const [images, setImages] = useState<PickedImage[]>([]);
  const [sending, setSending] = useState(false);

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
  const setTyping = useMutation(api.chatTyping.set);
  const clearTyping = useMutation(api.chatTyping.clear);
  const lastTypingRef = useRef(0);
  const typingArmedRef = useRef(false);
  const reportTyping = useCallback(() => {
    if (!channelId) return;
    const now = Date.now();
    if (now - lastTypingRef.current < TYPING_THROTTLE_MS) return;
    lastTypingRef.current = now;
    typingArmedRef.current = true;
    void setTyping({
      channel_id: channelId as Id<'chat_channels'>,
      ...(threadRootId ? { thread_root_id: threadRootId as Id<'chat_messages'> } : {}),
    }).catch(() => {});
  }, [channelId, threadRootId, setTyping]);
  const stopTyping = useCallback(() => {
    if (!channelId || !typingArmedRef.current) return;
    typingArmedRef.current = false;
    lastTypingRef.current = 0;
    void clearTyping({ channel_id: channelId as Id<'chat_channels'> }).catch(() => {});
  }, [channelId, clearTyping]);
  useEffect(() => stopTyping, [stopTyping]);

  const onChangeText = useCallback((text: string) => {
    setDraft(text);
    if (text.trim()) reportTyping();
    else stopTyping();
  }, [reportTyping, stopTyping]);

  // ── Attachments ───────────────────────────────────────────────────────────
  const onAttach = useCallback(async () => {
    const picked = await pickImages();
    if (picked.length === 0) return;
    setImages((prev) => [...prev, ...picked]);
    // Upload immediately; the strip's spinner clears as each one lands.
    for (const img of picked) {
      void startUpload(convex, img).then((storageId) => {
        setImages((prev) =>
          prev.map((p) => (p.uri === img.uri ? { ...p, storageId: storageId ?? undefined, failed: !storageId } : p)),
        );
      });
    }
  }, [convex]);

  const removeImage = useCallback((uri: string) => {
    setImages((prev) => prev.filter((p) => p.uri !== uri));
  }, []);

  // ── Send ──────────────────────────────────────────────────────────────────
  const canSend = (draft.trim().length > 0 || images.some((i) => !i.failed)) && !sending;
  const submit = useCallback(async () => {
    const content = draft.trim();
    if (editing && onSubmitEdit) {
      if (!content) return;
      onSubmitEdit(editing.messageId, content);
      setDraft('');
      onCancelEdit?.();
      return;
    }
    const live = images.filter((i) => !i.failed);
    if (!content && live.length === 0) return;
    // Clear the box NOW (send must never feel laggy); await only the uploads.
    setDraft('');
    setImages([]);
    stopTyping();
    if (Platform.OS === 'ios') void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (live.some((i) => !i.storageId)) setSending(true);
    try {
      const attachments = await settleAttachments(live);
      if (!content && attachments.length === 0) return; // every upload failed; tiles already said so
      onSend(content, attachments);
    } finally {
      setSending(false);
    }
  }, [draft, images, editing, onSubmitEdit, onCancelEdit, onSend, stopTyping]);

  return (
    <RNView>
      <MentionStrip draft={draft} members={mentionCandidates} onPick={setDraft} />

      {editing && (
        <RNView style={styles.editBanner}>
          <FontAwesome name="pencil" size={10} color={Theme.accent} />
          <RNText style={styles.editText}>Editing message</RNText>
          <TouchableOpacity onPress={onCancelEdit} hitSlop={8}>
            <RNText style={styles.editCancel}>Cancel</RNText>
          </TouchableOpacity>
        </RNView>
      )}

      {images.length > 0 && (
        <RNView style={styles.thumbRow}>
          {images.map((img) => (
            <RNView key={img.uri} style={[styles.thumb, img.failed && styles.thumbFailed]}>
              <Image source={{ uri: img.uri }} style={styles.thumbImg} />
              {!img.storageId && !img.failed && (
                <RNView style={styles.thumbBusy}>
                  <ActivityIndicator size="small" color="#fff" />
                </RNView>
              )}
              {img.failed && (
                <RNView style={styles.thumbBusy}>
                  <FontAwesome name="exclamation" size={12} color={Theme.red} />
                </RNView>
              )}
              <TouchableOpacity style={styles.thumbRemove} onPress={() => removeImage(img.uri)} hitSlop={6}>
                <FontAwesome name="close" size={9} color="#fff" />
              </TouchableOpacity>
            </RNView>
          ))}
        </RNView>
      )}

      <RNView style={styles.composer}>
        {!editing && (
          <TouchableOpacity style={styles.attach} onPress={onAttach} hitSlop={8}>
            <FontAwesome name="image" size={16} color={Theme.textMuted0} />
          </TouchableOpacity>
        )}
        <ThemedTextInput
          style={styles.input}
          placeholder={placeholder}
          placeholderTextColor={placeholderTint ?? Theme.textMuted0}
          value={draft}
          onChangeText={onChangeText}
          multiline
          submitBehavior="newline"
        />
        <TouchableOpacity
          style={[styles.send, !canSend && styles.sendDisabled, editing && styles.sendEdit]}
          onPress={submit}
          disabled={!canSend}
          hitSlop={8}
        >
          {sending ? (
            <ActivityIndicator size="small" color={Theme.bg} />
          ) : (
            <FontAwesome name={editing ? 'check' : 'arrow-up'} size={14} color={canSend ? Theme.bg : Theme.textMuted0} />
          )}
        </TouchableOpacity>
      </RNView>
    </RNView>
  );
}

const styles = StyleSheet.create({
  editBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: Spacing.md,
    paddingVertical: 5,
    backgroundColor: Theme.accent + '14',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Theme.accent + '44',
  },
  editText: { flex: 1, fontSize: 11, fontWeight: '600', color: Theme.accent },
  editCancel: { fontSize: 11, fontWeight: '600', color: Theme.textMuted },
  thumbRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingHorizontal: Spacing.md,
    paddingTop: 6,
  },
  thumb: {
    width: 52,
    height: 52,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#00000022',
  },
  thumbFailed: { borderWidth: 1, borderColor: Theme.red },
  thumbImg: { width: '100%', height: '100%' },
  thumbBusy: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#00000055',
  },
  thumbRemove: {
    position: 'absolute',
    top: 2,
    right: 2,
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#000000AA',
    alignItems: 'center',
    justifyContent: 'center',
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: Spacing.md,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Theme.border + '55',
  },
  attach: {
    width: 32,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 1,
  },
  input: {
    flex: 1,
    minHeight: 36,
    maxHeight: 120,
    borderWidth: 1,
    borderColor: Theme.border + '66',
    borderRadius: 9,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13.5,
    color: Theme.text,
    backgroundColor: Theme.bgAlt + '55',
  },
  send: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: Theme.blue,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  sendEdit: { backgroundColor: Theme.accent },
  sendDisabled: { backgroundColor: Theme.bgHighlight },
});
