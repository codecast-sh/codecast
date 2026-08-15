import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import { useAction, useMutation, useQuery } from 'convex/react';
import * as Haptics from 'expo-haptics';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { api } from '@codecast/convex/convex/_generated/api';
import type { Id } from '@codecast/convex/convex/_generated/dataModel';
import { Text as RNText } from '@/components/Themed';
import { useInboxStore, isConvexId } from '@codecast/web/store/inboxStore';
import { Theme, CHROME_FONT_CAP } from '@/constants/Theme';

// Mobile twin of web's SuggestionPills (components/SuggestionPills.tsx): same
// server contract — stored suggestions render only while their anchor still
// matches the conversation tail, the agent spoke last, and the session waits
// on the user. Tap SENDS (the suggestion is press-send ready by contract);
// long-press fills the composer for editing instead of sending.

export function SuggestionPills({
  conversationId,
  idle,
  hidden,
  onSend,
  onEdit,
}: {
  conversationId: Id<'conversations'>;
  idle: boolean;
  hidden: boolean;
  onSend: (text: string) => void;
  onEdit: (text: string) => void;
}) {
  const isRealId = isConvexId(conversationId as string);

  // Same primitive tail signature as the web component, so unrelated store
  // churn on the messages array doesn't re-render the strip.
  const tailSig = useInboxStore((s) => {
    const msgs = s.messages[conversationId as string];
    if (!msgs?.length) return null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if ((m.role === 'user' || m.role === 'assistant') && m.content?.trim() && !m.tool_results?.length) {
        return `${m.role}|${m._isOptimistic ? 'opt' : m.message_uuid ?? m._id}`;
      }
    }
    return null;
  });
  const [tailRole, tailKey] = tailSig ? (tailSig.split('|') as [string, string]) : [null, null];

  const row = useQuery(
    api.composerSuggestions.getComposerSuggestions,
    isRealId ? { conversation_id: conversationId } : 'skip',
  );
  const generate = useAction(api.composerSuggestions.generateComposerSuggestions);
  const recordOutcome = useMutation(api.composerSuggestions.recordSuggestionOutcome);
  const attemptedRef = useRef<string | null>(null);
  const [dismissedAnchor, setDismissedAnchor] = useState<string | null>(null);

  const report = useCallback(
    (suggestion: string, outcome: 'sent' | 'edited' | 'dismissed') => {
      if (!row?.anchor_message_uuid) return;
      recordOutcome({
        conversation_id: conversationId,
        anchor_message_uuid: row.anchor_message_uuid,
        suggestion,
        outcome,
      }).catch(() => {});
    },
    [recordOutcome, conversationId, row?.anchor_message_uuid],
  );

  useEffect(() => {
    if (!isRealId || hidden || !idle) return;
    if (tailRole !== 'assistant' || !tailKey || tailKey === 'opt') return;
    if (row === undefined) return;
    if (row?.anchor_message_uuid === tailKey) return;
    if (attemptedRef.current === tailKey) return;
    const t = setTimeout(() => {
      attemptedRef.current = tailKey;
      generate({ conversation_id: conversationId }).catch(() => {});
    }, 1200);
    return () => clearTimeout(t);
  }, [isRealId, hidden, idle, tailRole, tailKey, row, generate, conversationId]);

  const visible =
    !hidden &&
    idle &&
    tailRole === 'assistant' &&
    !!row?.suggestions?.length &&
    row.anchor_message_uuid === tailKey &&
    dismissedAnchor !== row.anchor_message_uuid;
  if (!visible) return null;
  const suggestions = row!.suggestions;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.strip}
      contentContainerStyle={styles.stripContent}
      keyboardShouldPersistTaps="always"
    >
      {suggestions.map((text) => (
        <TouchableOpacity
          key={text}
          activeOpacity={0.7}
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            report(text, 'sent');
            onSend(text);
          }}
          onLongPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            report(text, 'edited');
            onEdit(text);
          }}
          style={styles.pill}
        >
          <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.pillText} numberOfLines={1}>
            {text}
          </RNText>
        </TouchableOpacity>
      ))}
      <TouchableOpacity
        activeOpacity={0.7}
        onPress={() => {
          suggestions.forEach((t) => report(t, 'dismissed'));
          setDismissedAnchor(row!.anchor_message_uuid);
        }}
        style={styles.dismiss}
      >
        <FontAwesome name="times" size={11} color={Theme.textMuted} />
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  strip: {
    flexGrow: 0,
    marginBottom: 6,
  },
  stripContent: {
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 2,
  },
  pill: {
    maxWidth: 300,
    borderWidth: 1,
    borderColor: Theme.border,
    backgroundColor: Theme.bgAlt,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  pillText: {
    fontSize: 12,
    color: Theme.textMuted,
  },
  dismiss: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
