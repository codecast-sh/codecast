// A `cast decide` drawn where it is named: alone on its line (`sd-N`), or
// docked above the composer of the session that asked it while it waits. The
// web draws the same card in both places (DecisionCompactCard,
// SessionDecisionCard): the question, who is asking, the reasoning, the
// report, and the answers right there, or the answer once it is settled.
// Answering is the store's answerDecision, so the card flips the moment it
// is pressed and the asking session wakes with the answer.
import { RUN_OPTION, SKIP_OPTION, approvesPersonsAct } from '@codecast/shared/contracts/commandRun';
import { approvalButtonLabel } from '@codecast/shared/contracts/assistant';
import { useCallback, useRef } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import Feather from '@expo/vector-icons/Feather';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Text, TextInput } from '@/components/Themed';
import { themedStyles, useTheme } from '@/constants/Theme';
import { MarkdownContent } from '@/components/MarkdownRenderer';
import { CollapsibleBody } from '@/components/CollapsibleBody';
import { QueueChip, askingSessionLine } from '@/components/decisions/QueueMeta';
import { AnswerButton, AnswerControls, appAnswerLook } from '@/components/decisions/AnswerControls';
import { openLink } from '@/lib/links';
import { confirmPresence } from '@/lib/presence';
import { useInboxStore, type DecisionAnswerInput, type SessionDecisionItem } from '@codecast/web/store/inboxStore';
import { decisionQueueItems } from '@codecast/web/lib/decisionQueue';
import { useDecisionDraft } from '@codecast/web/hooks/useDecisionDraft';
import { useSyncDecisionDetail, useDecisionDetail } from '@codecast/web/hooks/useSyncDecisionDetail';
import { useCoarseNow } from '@codecast/web/hooks/useCoarseNow';
import type { AnswerDraft } from '@codecast/web/lib/decisionAnswer';
import { decisionAnswerLabel } from '@codecast/shared/contracts';
import { appAlert } from '@/lib/popups';


/** How a decision that no longer waits reads, or null while it waits. */
function settledOf(row: SessionDecisionItem): string | null {
  return row.status === 'answered' ? `Answered: ${decisionAnswerLabel(row, row) ?? ''}`
    : row.status === 'withdrawn' ? 'Withdrawn by the agent'
    : row.status === 'dismissed' ? 'Dismissed'
    : null;
}

export const reportUrl = (slug: string) => `https://codecast.sh/a/${slug}`;

/**
 * The answer press for one decision: approving an Ask first read takes Touch
 * ID first (lib/presence), one confirmation at a time; then the store's
 * answer (which adopts a row read by id from outside the viewer's queue).
 * `after` runs once the answer is in.
 */
export function useDecisionAnswer(source: Parameters<typeof approvesPersonsAct>[0] | undefined, decisionId: string, after?: () => void) {
  const confirming = useRef(false);
  return useCallback(async (input: DecisionAnswerInput) => {
    if (source && 'index' in input && input.index !== undefined && approvesPersonsAct(source, input.index)) {
      if (confirming.current) return;
      confirming.current = true;
      try {
        const presence = await confirmPresence('approve', decisionId);
        if (!presence) return;
        input = { ...input, presence };
      } catch (e) {
        appAlert('Touch ID', (e as Error).message);
        return;
      } finally {
        confirming.current = false;
      }
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    useInboxStore.getState().answerDecision(decisionId, input);
    after?.();
  }, [source, decisionId, after]);
}

/** The decision a reference names, from the store first, then its detail feed. */
function useDecisionRow(ref: string): SessionDecisionItem | undefined {
  useSyncDecisionDetail(ref);
  const detail = useDecisionDetail(ref);
  return useInboxStore((s) => s.sessionDecisions[ref] ?? Object.values(s.sessionDecisions).find((d) => d.short_id === ref)) ?? detail?.decision;
}

export function DecisionCard({ decisionRef, docked = false }: { decisionRef: string; docked?: boolean }) {
  const Theme = useTheme();
  const router = useRouter();
  const now = useCoarseNow(60_000);
  const row = useDecisionRow(decisionRef);
  const session = useInboxStore((s) => (row ? s.sessions[row.conversation_id] : undefined));
  const item = row?.status === 'pending' ? decisionQueueItems({ [row._id]: row }, session ? { [row.conversation_id]: session } : {})[0] : undefined;
  const decisionId = row?._id ?? decisionRef;
  const [draft, patchDraft] = useDecisionDraft<AnswerDraft>(decisionId);
  const answer = useDecisionAnswer(row, decisionId);
  const look = appAnswerLook(Theme);
  const fade = docked ? Theme.bgAlt : Theme.card;

  if (!row) {
    return (
      <View style={styles.card}>
        <Text style={styles.muted}>{`Loading ${decisionRef}…`}</Text>
      </View>
    );
  }

  const open = () => router.push(`/decisions/${row._id}` as never);
  const options = row.options ?? [];
  // Docked above the composer, the card keeps the transcript in view: the
  // question and one-line answers; the reasoning and every other kind of
  // answer are a tap away on the decision's screen.
  // A permission ask (`cast decide --run`): the question and Yes / Not now,
  // Yes marked with the fingerprint it confirms with, as on the web
  // (components/conversation/PermissionAsk). Nothing else to read or open.
  if (docked && row.run && !settledOf(row)) {
    const yes = options.findIndex((o) => o.label === RUN_OPTION);
    const no = options.findIndex((o) => o.label === SKIP_OPTION);
    return (
      <View style={[styles.card, styles.docked, styles.permission]} accessibilityLabel={`Permission: ${row.question}`}>
        <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
          <View style={styles.permissionTile}><Feather name="shield" size={16} color={Theme.yellow} /></View>
          <Text style={[styles.question, { flex: 1, marginTop: 4 }]}>{row.question}</Text>
        </View>
        <View style={[styles.compactRow, { paddingLeft: 44 }]}>
          {yes >= 0 ? (
            <Pressable accessibilityRole="button" accessibilityHint="Confirms with Touch ID" onPress={() => answer({ index: yes })} style={[styles.compact, styles.permissionYes]}>
              <Ionicons name="finger-print" size={15} color={Theme.bg} />
              <Text style={[styles.compactText, { color: Theme.bg }]}>{approvalButtonLabel(RUN_OPTION)}</Text>
            </Pressable>
          ) : null}
          {no >= 0 ? (
            <Pressable accessibilityRole="button" onPress={() => answer({ index: no })} style={styles.compact}>
              <Text style={styles.compactText}>{approvalButtonLabel(SKIP_OPTION)}</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    );
  }
  if (docked && !settledOf(row)) {
    const inline = (row.kind ?? 'single') === 'single' && options.length > 0 && options.length <= 4;
    return (
      <View style={[styles.card, styles.docked]} accessibilityLabel={`Decision: ${row.question}`}>
        <Pressable onPress={open} accessibilityRole="button" accessibilityHint="Opens the decision">
          {item ? <QueueChip item={item} now={now} /> : null}
          <Text style={styles.question} numberOfLines={3}>{row.question}</Text>
        </Pressable>
        <View style={styles.compactRow}>
          {inline ? options.map((o, i) => (
            <Pressable
              key={`${i}-${o.label}`}
              accessibilityRole="button"
              accessibilityHint={o.description}
              onPress={() => answer({ index: i })}
              style={[styles.compact, i === (row.blocking ? -1 : row.default_option) && { borderColor: Theme.text }]}
            >
              {approvesPersonsAct(row, i) ? <Feather name="lock" size={11} color={Theme.textMuted} /> : null}
              <Text style={styles.compactText} numberOfLines={1}>{o.label}</Text>
            </Pressable>
          )) : (
            <Pressable accessibilityRole="button" onPress={open} style={styles.compact}>
              <Text style={styles.compactText}>Answer ›</Text>
            </Pressable>
          )}
        </View>
        <View style={styles.footer}>
          <Pressable onPress={() => answer({ dismiss: true })} hitSlop={8}>
            <Text style={styles.footerText}>Dismiss</Text>
          </Pressable>
          <Pressable onPress={open} hitSlop={8}>
            <Text style={styles.footerText}>{row.context_md?.trim() || row.report_slug ? 'Why ›' : 'More ›'}</Text>
          </Pressable>
        </View>
      </View>
    );
  }
  const kind = row.kind ?? 'single';
  const otherText = draft.otherText ?? '';
  const writing = !!draft.otherOpen || !!otherText;
  const settled = settledOf(row);

  return (
    <View style={[styles.card, docked && styles.docked]} accessibilityLabel={`Decision: ${row.question}`}>
      <Pressable onPress={open} accessibilityRole="button" accessibilityHint="Opens the decision">
        {item ? <QueueChip item={item} now={now} /> : null}
        <Text style={styles.question}>{row.question}</Text>
        {item && askingSessionLine(item) && !docked ? <Text style={styles.session} numberOfLines={1}>{askingSessionLine(item)}</Text> : null}
      </Pressable>
      {settled ? (
        <View style={styles.settled}>
          <Feather name={row.status === 'answered' ? 'check' : 'minus'} size={13} color={row.status === 'answered' ? Theme.green : Theme.textDim} />
          <Text style={styles.muted}>{settled}</Text>
        </View>
      ) : (
        <>
          {row.context_md?.trim() ? (
            <CollapsibleBody fadeColor={fade} height={docked ? 72 : 110}>
              <MarkdownContent text={row.context_md} baseStyle={styles.context} />
            </CollapsibleBody>
          ) : null}
          {row.report_slug ? (
            <Pressable onPress={() => openLink(reportUrl(row.report_slug!))} hitSlop={6}>
              <Text style={styles.link}>Open the report ↗</Text>
            </Pressable>
          ) : null}
          <AnswerControls
            decisionId={decisionId}
            decision={{ options, form: row.form, kind }}
            onAnswer={answer}
            look={look}
            proceedingWith={row.blocking ? undefined : row.default_option}
            guarded={(i) => approvesPersonsAct(row, i)}
          />
          {kind === 'single' && writing ? (
            <View style={{ gap: 8 }}>
              <TextInput
                style={styles.input}
                value={otherText}
                onChangeText={(t) => patchDraft({ otherText: t })}
                placeholder="Your answer"
                placeholderTextColor={Theme.inputPlaceholder}
                autoFocus
                multiline
              />
              {otherText.trim() ? <AnswerButton look={look} label="Send" onPress={() => answer({ text: otherText.trim() })} /> : null}
            </View>
          ) : null}
          <View style={styles.footer}>
            {kind === 'single' && !writing ? (
              <Pressable onPress={() => patchDraft({ otherOpen: true })} hitSlop={8}>
                <Text style={styles.footerText}>Own words</Text>
              </Pressable>
            ) : <View />}
            <View style={styles.footerRight}>
              <Pressable onPress={() => answer({ dismiss: true })} hitSlop={8}>
                <Text style={styles.footerText}>Dismiss</Text>
              </Pressable>
              <Pressable onPress={open} hitSlop={8}>
                <Text style={styles.footerText}>More ›</Text>
              </Pressable>
            </View>
          </View>
        </>
      )}
    </View>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  card: {
    gap: 8,
    backgroundColor: Theme.card,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
    borderLeftWidth: 2,
    borderLeftColor: Theme.yellow,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  docked: { backgroundColor: Theme.bgAlt, borderRadius: 12, marginHorizontal: 8, marginBottom: 6 },
  question: { fontSize: 15, lineHeight: 21, fontWeight: '600', color: Theme.text, marginTop: 2 },
  session: { fontSize: 12, color: Theme.textMuted0, marginTop: 3 },
  context: { fontSize: 13.5, lineHeight: 20, color: Theme.textSecondary },
  muted: { fontSize: 13, color: Theme.textMuted },
  link: { fontSize: 13, color: Theme.blue },
  settled: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  input: {
    minHeight: 48,
    fontSize: 14,
    color: Theme.text,
    borderWidth: 1,
    borderColor: Theme.borderLight,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    textAlignVertical: 'top',
  },
  compactRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  compact: { flexDirection: 'row', alignItems: 'center', gap: 5, maxWidth: '100%', borderWidth: 1, borderColor: Theme.borderLight, backgroundColor: Theme.card, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  compactText: { fontSize: 14, fontWeight: '500', color: Theme.text },
  permission: { borderWidth: 1, borderColor: Theme.yellow + '55', gap: 12 },
  permissionTile: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: Theme.yellow + '22' },
  permissionYes: { backgroundColor: Theme.yellow, borderColor: Theme.yellow },
  footer: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 },
  footerRight: { flexDirection: 'row', gap: 18 },
  footerText: { fontSize: 13, color: Theme.textMuted },
}));
