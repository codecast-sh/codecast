import { useCallback, useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Text, TextInput } from '@/components/Themed';
import { Spacing, BorderRadius, themedStyles, useTheme } from '@/constants/Theme';
import { MarkdownContent } from '@/components/MarkdownRenderer';
import { QueueChip, askingSessionLine } from '@/components/decisions/QueueMeta';
import { openLink } from '@/lib/links';
import { useInboxStore, type DecisionAnswerInput, type SessionDecisionItem } from '@codecast/web/store/inboxStore';
import { useDecisionQueue } from '@codecast/web/hooks/useDecisionQueue';
import { useDecisionDraft } from '@codecast/web/hooks/useDecisionDraft';
import { useSyncDecisionDetail, useDecisionDetail } from '@codecast/web/hooks/useSyncDecisionDetail';
import { useCoarseNow } from '@codecast/web/hooks/useCoarseNow';
import { answerView, buildDecisionAnswer, moveInOrder, togglePicked, type AnswerDraft } from '@codecast/web/lib/decisionAnswer';
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
  const item = position >= 0 ? decideQueue[position] : undefined;

  // The document body, the asking people and an answered row all come from
  // the detail feed; the queue item paints first from the store.
  useSyncDecisionDetail(id);
  const detail = useDecisionDetail(id);
  const row: SessionDecisionItem | undefined = useInboxStore((s) => (id ? s.sessionDecisions[id] : undefined)) ?? detail?.decision;
  const decisionId = item?.decisionId ?? row?._id ?? id ?? '';

  const [draft, patchDraft] = useDecisionDraft<AnswerDraft>(decisionId);
  const [error, setError] = useState<string | null>(null);
  const answerDecision = useInboxStore((s) => s.answerDecision);

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
  const view = answerView({ options, form: source.form, kind }, draft);
  const otherText = draft.otherText ?? '';

  const submit = () => {
    const built = buildDecisionAnswer({ options, form: source.form, kind }, view);
    if (!built) return;
    if ('error' in built) return setError(built.error);
    answer(built.input);
  };

  const title = item ? `${position + 1} of ${decideQueue.length}` : 'Decision';

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
          {nextId ? <PrimaryButton label="Next decision" onPress={goNext} /> : null}
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

          {contextMd ? <MarkdownContent text={contextMd} baseStyle={styles.context} /> : null}
          {docBody && docBody !== contextMd?.trim() ? <MarkdownContent text={docBody} baseStyle={styles.context} /> : null}
          {reportSlug ? <LinkRow label="Open the report" onPress={() => openLink(pageUrl(reportSlug))} /> : null}

          <View style={styles.options}>
            {(kind === 'rank' ? view.order : options.map((_, i) => i)).map((i, pos) => {
              const o = options[i];
              if (!o) return null;
              const picked = kind === 'multi' && view.picked.includes(i);
              const onPress = kind === 'single' ? () => answer({ index: i })
                : kind === 'multi' ? () => { void Haptics.selectionAsync().catch(() => {}); setError(null); patchDraft((cur) => togglePicked(cur, i)); }
                : undefined;
              return (
                <TouchableOpacity
                  key={i}
                  activeOpacity={onPress ? 0.7 : 1}
                  disabled={!onPress}
                  onPress={onPress}
                  style={[styles.option, picked && { borderColor: Theme.green, backgroundColor: Theme.green + '14' }]}
                >
                  <View style={[styles.badge, { borderColor: picked ? Theme.green : Theme.borderLight }]}>
                    {kind === 'multi'
                      ? <FontAwesome name={picked ? 'check' : 'square-o'} size={13} color={picked ? Theme.green : Theme.textMuted0} />
                      : <Text style={styles.badgeText}>{kind === 'rank' ? pos + 1 : i + 1}</Text>}
                  </View>
                  <View style={styles.optionBody}>
                    <Text style={styles.optionLabel}>{o.label}</Text>
                    {o.description ? <Text style={styles.optionDesc}>{o.description}</Text> : null}
                    {defaultOption === i && !blocking ? <Text style={styles.tag}>proceeding with this</Text> : null}
                    {o.page_slug ? <LinkRow label="Open its page" onPress={() => openLink(pageUrl(o.page_slug!))} /> : null}
                  </View>
                  {kind === 'rank' ? (
                    <View style={styles.rankBtns}>
                      <RankButton icon="chevron-up" disabled={pos === 0} onPress={() => { const n = moveInOrder(view.order, pos, -1); if (n) patchDraft({ order: n }); }} />
                      <RankButton icon="chevron-down" disabled={pos === view.order.length - 1} onPress={() => { const n = moveInOrder(view.order, pos, 1); if (n) patchDraft({ order: n }); }} />
                    </View>
                  ) : null}
                </TouchableOpacity>
              );
            })}
          </View>

          {kind === 'form' ? (
            <View style={styles.options}>
              {(source.form?.fields ?? []).map((f) => (
                <View key={f.key} style={styles.field}>
                  <Text style={styles.fieldLabel}>{f.label}</Text>
                  {f.type === 'bool' ? (
                    <View style={styles.chips}>
                      {[true, false].map((v) => (
                        <Chip key={String(v)} label={v ? 'yes' : 'no'} on={view.values[f.key] === v} onPress={() => patchDraft((cur) => ({ values: { ...cur.values, [f.key]: v } }))} />
                      ))}
                    </View>
                  ) : f.type === 'select' ? (
                    <View style={styles.chips}>
                      {(f.options ?? []).map((v) => (
                        <Chip key={v} label={v} on={view.values[f.key] === v} onPress={() => patchDraft((cur) => ({ values: { ...cur.values, [f.key]: v } }))} />
                      ))}
                    </View>
                  ) : (
                    <TextInput
                      style={styles.input}
                      value={String(view.values[f.key] ?? '')}
                      keyboardType={f.type === 'number' ? 'numeric' : 'default'}
                      onChangeText={(v) => patchDraft((cur) => ({ values: { ...cur.values, [f.key]: v } }))}
                      placeholderTextColor={Theme.inputPlaceholder}
                    />
                  )}
                </View>
              ))}
            </View>
          ) : null}

          {kind !== 'single' ? <PrimaryButton label="Send this answer" onPress={submit} /> : null}
          {error ? <Text style={[styles.muted, { color: Theme.red }]}>{error}</Text> : null}

          {kind === 'single' ? (
            <View style={styles.other}>
              <TextInput
                style={[styles.input, styles.otherInput]}
                value={otherText}
                onChangeText={(t) => patchDraft({ otherText: t })}
                placeholder="Or answer in your own words"
                placeholderTextColor={Theme.inputPlaceholder}
                multiline
              />
              {otherText.trim() ? <PrimaryButton label="Send" onPress={() => answer({ text: otherText.trim() })} /> : null}
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

function PrimaryButton({ label, onPress }: { label: string; onPress: () => void }) {
  const Theme = useTheme();
  return (
    <TouchableOpacity style={[styles.primary, { backgroundColor: Theme.blue }]} activeOpacity={0.8} onPress={onPress}>
      <Text style={styles.primaryText}>{label}</Text>
    </TouchableOpacity>
  );
}

function LinkRow({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <TouchableOpacity onPress={onPress} hitSlop={6}>
      <Text style={styles.link}>{label} ↗</Text>
    </TouchableOpacity>
  );
}

function RankButton({ icon, disabled, onPress }: { icon: 'chevron-up' | 'chevron-down'; disabled: boolean; onPress: () => void }) {
  const Theme = useTheme();
  return (
    <TouchableOpacity onPress={onPress} disabled={disabled} hitSlop={6} style={[styles.rankBtn, disabled && { opacity: 0.3 }]}>
      <FontAwesome name={icon} size={12} color={Theme.textMuted} />
    </TouchableOpacity>
  );
}

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  const Theme = useTheme();
  return (
    <TouchableOpacity onPress={onPress} style={[styles.chip, on && { borderColor: Theme.blue, backgroundColor: Theme.blue + '18' }]}>
      <Text style={[styles.chipText, on && { color: Theme.blue }]}>{label}</Text>
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
  options: { gap: Spacing.sm, marginTop: Spacing.sm },
  option: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.md,
    minHeight: 56,
    paddingVertical: 14,
    paddingHorizontal: Spacing.lg,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Theme.borderLight,
    backgroundColor: Theme.card,
  },
  badge: { width: 24, height: 24, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  badgeText: { fontSize: 12, color: Theme.textMuted, fontWeight: '600' },
  optionBody: { flex: 1, gap: 4 },
  optionLabel: { fontSize: 16, lineHeight: 22, color: Theme.text, fontWeight: '600' },
  optionDesc: { fontSize: 13, lineHeight: 19, color: Theme.textMuted },
  tag: { fontSize: 11, color: Theme.textMuted0 },
  rankBtns: { gap: 6 },
  rankBtn: { padding: 6, borderRadius: BorderRadius.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.borderLight },
  field: { gap: 6 },
  fieldLabel: { fontSize: 12, color: Theme.textMuted },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  chip: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: BorderRadius.pill, borderWidth: 1, borderColor: Theme.borderLight, backgroundColor: Theme.card },
  chipText: { fontSize: 14, color: Theme.text },
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
  primary: { borderRadius: BorderRadius.lg, paddingVertical: 14, alignItems: 'center' },
  primaryText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  footer: { flexDirection: 'row', justifyContent: 'space-between', marginTop: Spacing.lg },
  footerText: { fontSize: 14, color: Theme.textMuted },
}));
