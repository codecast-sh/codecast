import { useCallback, useMemo } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Text, TextInput } from '@/components/Themed';
import { Spacing, BorderRadius, themedStyles, useTheme } from '@/constants/Theme';
import { MarkdownContent } from '@/components/MarkdownRenderer';
import { QueueChip, askingSessionLine } from '@/components/decisions/QueueMeta';
import { openLink } from '@/lib/links';
import { useInboxStore, type DecisionAnswerInput, type SessionDecisionItem } from '@codecast/web/store/inboxStore';
import { useDecisionQueue } from '@codecast/web/hooks/useDecisionQueue';
import { decisionQueueItems } from '@codecast/web/lib/decisionQueue';
import { useDecisionDraft } from '@codecast/web/hooks/useDecisionDraft';
import { useSyncDecisionDetail, useDecisionDetail } from '@codecast/web/hooks/useSyncDecisionDetail';
import { useCoarseNow } from '@codecast/web/hooks/useCoarseNow';
import type { AnswerDraft } from '@codecast/web/lib/decisionAnswer';
import { AnswerButton, AnswerControls, appAnswerLook } from '@/components/decisions/AnswerControls';
import { decisionAnswerLabel } from '@codecast/shared/contracts';

const pageUrl = (slug: string) => `https://codecast.sh/a/${slug}`;

// One `cast decide` at a time. The queue (useDecisionQueue) is the same model
// web's stepper walks; this screen shows the decision named in the route and,
// once it is answered, skipped or dismissed, replaces itself with the next one
// in queue order. Answering is the store's answerDecision: the row flips
// locally and the answer is delivered into the asking session.
export default function DecisionScreen() {
  const Theme = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const now = useCoarseNow(60_000);

  const queue = useDecisionQueue();
  const decideQueue = useMemo(() => queue.filter((i) => i.source === 'decide'), [queue]);
  const position = decideQueue.findIndex((i) => i.decisionId === id || i.shortId === id);
  const queued = position >= 0 ? decideQueue[position] : undefined;

  // The document body, the asking people and an answered row all come from
  // the detail feed; the queue item paints first from the store.
  useSyncDecisionDetail(id);
  const detail = useDecisionDetail(id);
  const row: SessionDecisionItem | undefined = useInboxStore((s) => {
    if (!id) return undefined;
    return s.sessionDecisions[id] ?? Object.values(s.sessionDecisions).find((d) => d.short_id === id);
  }) ?? detail?.decision;
  // An advisory ask sits outside the stacked queue (isStackedAsk) but is still
  // answerable when a link opens it; read it as a queue item from its row.
  const session = useInboxStore((s) => (row ? s.sessions[row.conversation_id] : undefined));
  const item = queued ?? (row?.status === 'pending' ? decisionQueueItems({ [row._id]: row }, session ? { [row.conversation_id]: session } : {})[0] : undefined);
  const decisionId = item?.decisionId ?? row?._id ?? id ?? '';

  const [draft, patchDraft] = useDecisionDraft<AnswerDraft>(decisionId);
  const answerDecision = useInboxStore((s) => s.answerDecision);
  const look = appAnswerLook(Theme);

  // The next decision after this one, wrapping, never this one.
  const nextId = useMemo(() => {
    const rest = decideQueue.filter((i) => i.decisionId !== decisionId);
    if (rest.length === 0) return null;
    const after = position >= 0 ? decideQueue.slice(position + 1).find((i) => i.decisionId !== decisionId) : undefined;
    return (after ?? rest[0]).decisionId ?? null;
  }, [decideQueue, decisionId, position]);

  const goNext = useCallback(() => {
    if (nextId) router.replace(`/decisions/${nextId}`);
    else router.back();
  }, [nextId, router]);

  const answer = useCallback((input: DecisionAnswerInput) => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    answerDecision(decisionId, input);
    goNext();
  }, [answerDecision, decisionId, goNext]);

  const source = item ?? row;
  if (!source) {
    return (
      <>
        <Stack.Screen options={{ title: 'Decision' }} />
        <View style={[styles.center, { backgroundColor: Theme.bg }]}>
          <Text style={styles.muted}>{detail === undefined ? 'Loading…' : 'This decision is gone.'}</Text>
        </View>
      </>
    );
  }

  const options = source.options ?? [];
  const kind = source.kind ?? 'single';
  const blocking = item ? item.blocking : !!row?.blocking;
  const defaultOption = item ? item.defaultOption : row?.default_option;
  const contextMd = item ? item.contextMd : row?.context_md;
  const reportSlug = item ? item.reportSlug : row?.report_slug;
  const docBody = detail?.doc?.content?.trim();
  const otherText = draft.otherText ?? '';

  const title = queued ? `${position + 1} of ${decideQueue.length}` : 'Decision';

  // Settled: say how, and move on.
  if (!item) {
    const settled = row && row.status !== 'pending'
      ? row.status === 'answered' ? `Answered: ${decisionAnswerLabel(row, row) ?? ''}` : row.status === 'withdrawn' ? 'The agent withdrew this question.' : 'Dismissed.'
      : 'This decision is no longer in your queue.';
    return (
      <>
        <Stack.Screen options={{ title, headerBackTitle: 'Back' }} />
        <ScrollView style={{ backgroundColor: Theme.bg }} contentContainerStyle={styles.body}>
          <Text style={styles.question}>{source.question}</Text>
          <Text style={styles.muted}>{settled}</Text>
          {nextId ? <AnswerButton look={look} label="Next decision" onPress={goNext} /> : null}
        </ScrollView>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title, headerBackTitle: 'Back' }} />
      <KeyboardAvoidingView style={{ flex: 1, backgroundColor: Theme.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <QueueChip item={item} now={now} />
          <Text style={styles.question} selectable>{item.question}</Text>
          {askingSessionLine(item) ? (
            <TouchableOpacity onPress={() => router.push(`/session/${item.conversationId}`)} hitSlop={8}>
              <Text style={styles.session} numberOfLines={1}>{askingSessionLine(item)} ›</Text>
            </TouchableOpacity>
          ) : null}

          {/* The reasoning folds, so the answers stay in reach without scrolling. */}
          {contextMd || (docBody && docBody !== contextMd?.trim()) ? (
            <CollapsibleBody fadeColor={Theme.bg} height={150}>
              {contextMd ? <MarkdownContent text={contextMd} baseStyle={styles.context} /> : null}
              {docBody && docBody !== contextMd?.trim() ? <MarkdownContent text={docBody} baseStyle={styles.context} /> : null}
            </CollapsibleBody>
          ) : null}
          {reportSlug ? <LinkRow label="Open the report" onPress={() => openLink(pageUrl(reportSlug))} /> : null}

          <AnswerControls decisionId={decisionId} decision={{ options, form: source.form, kind }} onAnswer={answer} look={look} proceedingWith={blocking ? undefined : defaultOption} />

          {kind === 'single' && !writing ? (
            <TouchableOpacity onPress={() => setWriting(true)} hitSlop={8}>
              <Text style={styles.footerText}>Answer in your own words</Text>
            </TouchableOpacity>
          ) : null}
          {kind === 'single' && writing ? (
            <View style={styles.other}>
              <TextInput
                style={[styles.input, styles.otherInput]}
                value={otherText}
                onChangeText={(t) => patchDraft({ otherText: t })}
                placeholder="Your answer"
                autoFocus
                placeholderTextColor={Theme.inputPlaceholder}
                multiline
              />
              {otherText.trim() ? <AnswerButton look={look} label="Send" onPress={() => answer({ text: otherText.trim() })} /> : null}
            </View>
          ) : null}

          <View style={styles.footer}>
            <TouchableOpacity onPress={() => answer({ dismiss: true })} hitSlop={8}>
              <Text style={styles.footerText}>Dismiss</Text>
            </TouchableOpacity>
            {nextId ? (
              <TouchableOpacity onPress={goNext} hitSlop={8}>
                <Text style={styles.footerText}>Skip ›</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </>
  );
}

function LinkRow({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <TouchableOpacity onPress={onPress} hitSlop={6}>
      <Text style={styles.link}>{label} ↗</Text>
    </TouchableOpacity>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  body: { padding: Spacing.lg, gap: Spacing.md, paddingBottom: Spacing.xxxl * 2 },
  question: { fontSize: 19, lineHeight: 26, color: Theme.text, fontWeight: '600' },
  session: { fontSize: 12, color: Theme.textMuted0 },
  context: { fontSize: 14, lineHeight: 21, color: Theme.textSecondary },
  muted: { fontSize: 13, color: Theme.textMuted },
  link: { fontSize: 13, color: Theme.blue },
  input: {
    fontSize: 15,
    color: Theme.text,
    backgroundColor: Theme.card,
    borderWidth: 1,
    borderColor: Theme.borderLight,
    borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
  },
  other: { gap: Spacing.sm, marginTop: Spacing.sm },
  otherInput: { minHeight: 48, textAlignVertical: 'top' },
  footer: { flexDirection: 'row', justifyContent: 'space-between', marginTop: Spacing.lg },
  footerText: { fontSize: 14, color: Theme.textMuted },
}));
