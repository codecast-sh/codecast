// One trigger's own screen, the phone twin of the web's /triggers/<id>: what
// it does (title, briefing, the prompt each run receives), when it runs, every
// past run with its session one tap away, the session it lives in, and the
// verbs. Addressed by short id (tr-4898) or Convex id.
//
// Local-first as the web page is: the store's trigger roster (useTriggers)
// paints the first frame and every verb flips it before the server answers;
// webGet fills in the creator titles and is the only source for a trigger
// the phone's feed does not carry (a finished one outside the recent tail, or
// one owned by another account on a session the viewer can see).
import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';
import { api } from '@codecast/convex/convex/_generated/api';
import { isConvexId } from '@codecast/shared/entities';
import { Text as RNText } from '@/components/Themed';
import { CHROME_FONT_CAP, themedStyles, useTheme } from '@/constants/Theme';
import { Mono, uiFace } from '@/constants/fonts';
import { appAlert } from '@/lib/popups';
import { MarkdownContent } from '@/components/MarkdownRenderer';
import { CollapsibleBody } from '@/components/CollapsibleBody';
import { ActionButton, FactChip, ObjectHeader, ObjectMissing, SectionLabel, objectStyles } from '@/components/objects/ObjectParts';
import type FontAwesome from '@expo/vector-icons/FontAwesome';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { useCoarseNow } from '@codecast/web/hooks/useCoarseNow';
import { useQueryNoThrow } from '@codecast/web/hooks/useQueryNoThrow';
import { useTriggers, useTriggerRuns } from '@codecast/web/hooks/useSyncTriggers';
import { ARMED_STATUSES, isTriggerTerminal, taskDisplayTitle, triggerEndWords, type TaskRow } from '@codecast/web/components/triggerTasks';
import { describeTaskCadence, fmtClock, fmtDuration, readableTimes, triggerEventLabel } from '@codecast/web/components/triggerCadence';
import { triggerArmLedger, triggerRunNowLedger } from '@codecast/web/components/work/startLedgers';
import { ledgerLines } from '@codecast/web/components/consequential/roleOnline';
import { useRunCost } from '@codecast/web/components/consequential/useRunCost';

type Trigger = TaskRow & { requested_run_source?: string };
type Verb = 'pause' | 'resume' | 'runNow' | 'cancel' | 'reactivate';
// One row of agentTasks.webListRuns, as the store holds it (the fields this
// screen reads). `_id` is the run's conversation; a skipped run has none.
type TriggerRun = {
  _id: string;
  run_key: string;
  kind: 'spawn' | 'inject' | 'skipped_precheck';
  title: string;
  created_at: number;
  idle_summary?: string;
  trigger_message_id?: string;
};

const RUN_PAGE = 10;

export default function TriggerScreen() {
  const Theme = useTheme();
  const router = useRouter();
  const { id: rawId } = useLocalSearchParams<{ id: string }>();
  const id = rawId?.trim();
  const now = useCoarseNow(30_000);

  const { tasks, ready } = useTriggers();
  const storeRow = useMemo(() => {
    if (!id) return undefined;
    const lower = id.toLowerCase();
    return (tasks as Trigger[]).find((t) => t._id === id || t.short_id === lower);
  }, [tasks, id]);
  const { data: served, error } = useQueryNoThrow(
    (api as any).agentTasks.webGet,
    id ? (isConvexId(id) ? { id } : { short_id: id.toLowerCase() }) : 'skip',
  );
  // Store wins the fields a verb flips; the server's enrichment rides under it.
  const t: Trigger | null | undefined = storeRow
    ? { ...((served as Trigger | null) ?? {}), ...storeRow }
    : served !== undefined ? (served as Trigger | null) : error ? null : undefined;

  const runs = useTriggerRuns(t?._id ?? null) as TriggerRun[] | undefined;
  const runCost = useRunCost(null);

  if (!t) return <ObjectMissing what="Trigger" id={id} loading={!(t === null || (ready && served === null))} />;

  const title = taskDisplayTitle(t);
  const isArmed = ARMED_STATUSES.has(t.status);
  const isTerminal = isTriggerTerminal(t.status);
  const paused = t.status === 'paused';
  const msUntil = t.status === 'scheduled' && t.run_at !== undefined ? t.run_at - now : undefined;
  const cadence = describeTaskCadence(t);
  const eventLabel = t.schedule_type === 'event' && t.event_filter ? triggerEventLabel(t.event_filter) : null;
  const projectName = t.project_path?.split('/').filter(Boolean).pop();
  const sessionRuns = runs?.filter((r) => r.kind !== 'skipped_precheck');
  const totalRuns = Math.max(t.run_count ?? 0, sessionRuns?.length ?? 0);
  const brief = t.display_summary?.trim();
  const ending = triggerEndWords('cancel', 'Trigger');

  const act = (verb: Verb) => useInboxStore.getState().triggerAction(t._id, verb);
  // A start spends an agent run, so it asks first with the same ledger the
  // web's review draws (the phone's confirm: lines in an alert).
  const facts = {
    title,
    cadence,
    schedule: t.schedule_type,
    intervalMs: t.interval_ms ?? null,
    agent: t.agent_type ?? null,
    project: projectName ?? null,
    applies: t.mode === 'apply',
    hosted: t.hosted_home === true,
  };
  const confirmStart = (verb: 'runNow' | 'resume' | 'reactivate') => {
    const l = verb === 'runNow'
      ? triggerRunNowLedger(facts, runCost)
      : verb === 'resume'
        ? triggerArmLedger(facts, 'Paused', null, runCost)
        : triggerArmLedger(facts, 'Finished', t.schedule_type === 'recurring' && t.interval_ms ? now + t.interval_ms : null, runCost);
    appAlert(`${l.name}: ${l.subject}`, ledgerLines(l).join('\n'), [
      { text: l.keep ?? 'Not now', style: 'cancel' },
      { text: l.confirm, onPress: () => act(verb) },
    ]);
  };
  const confirmCancel = () => appAlert(ending.ask, title, [
    { text: 'Keep', style: 'cancel' },
    { text: ending.confirm, style: 'destructive', onPress: () => act('cancel') },
  ]);

  const openSession = (conversationId: string, messageId?: string) =>
    router.push((messageId ? `/session/${conversationId}?message=${messageId}` : `/session/${conversationId}`) as never);
  const outcome = t.last_run_failed
    ? { icon: 'x-circle' as const, color: Theme.red, word: 'failed' }
    : t.last_run_needs_attention
      ? { icon: 'alert-triangle' as const, color: Theme.orange, word: 'needs attention' }
      : { icon: 'check-circle' as const, color: Theme.green, word: 'ok' };

  const status = statusLook(t, Theme);
  const sessions = [
    { label: t.originating_conversation_id === t.created_by_conversation_id ? 'Runs in' : 'Created by', id: t.created_by_conversation_id, title: t.created_by_conversation_title },
    t.originating_conversation_id !== t.created_by_conversation_id
      ? { label: 'Runs inside', id: t.originating_conversation_id, title: t.originating_conversation_title }
      : null,
    t.last_run_conversation_id !== t.originating_conversation_id && t.last_run_conversation_id !== t.created_by_conversation_id
      ? { label: 'Last run', id: t.last_run_conversation_id, title: t.last_run_conversation_title }
      : null,
  ].flatMap((s) => (s?.id ? [{ label: s.label, id: s.id, title: s.title }] : []));

  return (
    <>
      <ObjectHeader type="trigger" shortId={t.short_id} title={title} />
      <ScrollView style={objectStyles.container} contentContainerStyle={objectStyles.content}>
        <RNText style={objectStyles.title}>{title}</RNText>

        <RNView style={styles.chipRow}>
          <FactChip icon={status.icon} label={status.label} color={status.color} />
          <FactChip icon={t.schedule_type === 'recurring' ? 'repeat' : t.schedule_type === 'event' ? 'bolt' : 'calendar-o'} label={t.schedule_type === 'once' ? 'Once' : cadence} color={Theme.textMuted} />
          {t.mode !== 'apply' && <FactChip icon="eye" label="Read-only" color={Theme.cyan} />}
          {t.is_own === false && <FactChip icon="user-o" label={`Runs as ${t.owner_name || 'another account'}`} color={Theme.violet} />}
        </RNView>

        {brief ? <RNText style={styles.brief}>{brief}</RNText> : null}

        {(isArmed || isTerminal) && (
          <RNView style={styles.verbs}>
            {isArmed && (
              <>
                <ActionButton icon="play" label="Run now" color={Theme.cyan} filled onPress={() => confirmStart('runNow')} />
                {paused
                  ? <ActionButton icon="play-circle" label="Resume" color={Theme.orange} onPress={() => confirmStart('resume')} />
                  : <ActionButton icon="pause" label="Pause" color={Theme.textMuted} onPress={() => act('pause')} />}
                <ActionButton icon="times" label="Cancel" color={Theme.textMuted} onPress={confirmCancel} />
              </>
            )}
            {isTerminal && <ActionButton icon="refresh" label="Reactivate" color={Theme.orange} onPress={() => confirmStart('reactivate')} />}
          </RNView>
        )}

        {(t.last_run_failed || t.last_run_needs_attention) && (
          <TouchableOpacity
            activeOpacity={t.last_run_conversation_id ? 0.7 : 1}
            disabled={!t.last_run_conversation_id}
            onPress={() => t.last_run_conversation_id && openSession(t.last_run_conversation_id)}
            style={[styles.banner, { borderColor: outcome.color + '44', borderLeftColor: outcome.color, backgroundColor: outcome.color + '10' }]}
          >
            <RNView style={styles.bannerHead}>
              <Feather name={outcome.icon} size={13} color={outcome.color} />
              <RNText style={[styles.bannerTitle, { color: outcome.color }]} numberOfLines={1}>Last run {outcome.word}</RNText>
              {t.last_run_at ? <RNText style={[styles.dim, styles.shrink]} numberOfLines={1}>{fmtDuration(Math.max(0, now - t.last_run_at))} ago</RNText> : null}
              <RNView style={{ flex: 1 }} />
              {t.last_run_conversation_id ? <Feather name="chevron-right" size={14} color={Theme.textMuted0} /> : null}
            </RNView>
            {t.last_run_summary ? <RNText style={styles.bannerBody} numberOfLines={4}>{readableTimes(t.last_run_summary, now)}</RNText> : null}
          </TouchableOpacity>
        )}

        <RNView style={styles.vitals}>
          <Vital label="Next run" sub={t.status === 'scheduled' && t.run_at !== undefined ? fmtClock(t.run_at) : undefined}>
            {t.status === 'scheduled' && msUntil !== undefined ? (
              <RNText style={[styles.vitalValue, { color: Theme.orange }]}>{msUntil > 0 ? `in ${fmtDuration(msUntil)}` : 'due now'}</RNText>
            ) : (
              <RNText style={[styles.vitalValue, t.status === 'running' && { color: Theme.green }]}>
                {t.status === 'running' ? 'running now' : paused ? 'paused' : eventLabel ? `on ${eventLabel}` : 'none'}
              </RNText>
            )}
          </Vital>
          <Vital label="Runs" sub={(t.retry_count ?? 0) > 0 ? `${t.retry_count} failed in a row` : undefined} subColor={Theme.red}>
            <RNText style={styles.vitalValue}>{totalRuns}</RNText>
          </Vital>
          <Vital label="Last run" sub={t.last_run_at ? new Date(t.last_run_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : undefined}>
            {t.last_run_at ? (
              <RNView style={styles.inline}>
                <Feather name={outcome.icon} size={13} color={outcome.color} />
                <RNText style={styles.vitalValue}>{fmtDuration(Math.max(0, now - t.last_run_at))} ago</RNText>
              </RNView>
            ) : <RNText style={styles.vitalValue}>never</RNText>}
          </Vital>
          <Vital label="Where" sub={t.agent_type ? `agent: ${t.agent_type}` : undefined}>
            <RNText style={[styles.vitalValue, projectName && styles.mono]} numberOfLines={1}>{projectName ?? (t.hosted_home ? 'Assistant' : 'none')}</RNText>
          </Vital>
        </RNView>

        {sessions.length > 0 && (
          <RNView style={styles.section}>
            <SectionLabel>Sessions</SectionLabel>
            <RNView style={styles.card}>
              {sessions.map((s, i) => (
                <TouchableOpacity key={s.label} style={[styles.linkRow, i > 0 && styles.rowRule]} onPress={() => openSession(s.id)} activeOpacity={0.6}>
                  <Feather name="message-square" size={13} color={Theme.cyan} />
                  <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.linkLabel}>{s.label}</RNText>
                  <RNText style={styles.linkTitle} numberOfLines={1}>{s.title || 'Untitled session'}</RNText>
                  <Feather name="chevron-right" size={14} color={Theme.textMuted0} />
                </TouchableOpacity>
              ))}
            </RNView>
          </RNView>
        )}

        <RNView style={styles.section}>
          <SectionLabel>{`Run history${runs && runs.length > 0 ? ` · ${runs.length}` : ''}`}</SectionLabel>
          <RNView style={styles.card}>
            {runs === undefined ? (
              <RNText style={styles.emptyRuns}>Loading runs…</RNText>
            ) : runs.length === 0 ? (
              <RNText style={styles.emptyRuns}>
                {msUntil !== undefined && msUntil > 0 ? `No runs yet. The first is in ${fmtDuration(msUntil)}.` : 'No runs yet.'}
              </RNText>
            ) : (
              <RunList runs={runs} now={now} triggerTitle={title} onOpen={(r) => openSession(r._id, r.trigger_message_id)} />
            )}
          </RNView>
        </RNView>

        <RNView style={styles.section}>
          <SectionLabel>Prompt</SectionLabel>
          <RNView style={[styles.card, styles.promptCard]}>
            <CollapsibleBody fadeColor={Theme.card} height={180}>
              <MarkdownContent text={t.prompt} baseStyle={styles.promptText} />
            </CollapsibleBody>
          </RNView>
        </RNView>

        {t.precheck ? (
          <RNView style={styles.section}>
            <SectionLabel>{`Precheck${t.schedule_type === 'event' ? ' · not run for events' : ''}`}</SectionLabel>
            <RNView style={[styles.card, styles.promptCard]}>
              <RNText style={[styles.mono, styles.precheck]} selectable>{t.precheck}</RNText>
              <RNText style={styles.dimSmall}>Exit 0 runs it · any other exit skips the run</RNText>
              {t.last_precheck_skip_at ? (
                <RNText style={[styles.dimSmall, { color: Theme.yellow }]}>
                  Last skipped {fmtDuration(Math.max(0, now - t.last_precheck_skip_at))} ago{t.last_precheck_skip_reason ? `: ${t.last_precheck_skip_reason}` : ''}
                </RNText>
              ) : null}
            </RNView>
          </RNView>
        ) : null}

        <RNView style={styles.footer}>
          <RNText style={styles.dimSmall}>Created {new Date(t.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</RNText>
          {t.max_runtime_ms !== undefined ? <RNText style={styles.dimSmall}>Max runtime {fmtDuration(t.max_runtime_ms)}</RNText> : null}
          {t.project_path ? <RNText style={[styles.dimSmall, styles.mono]} numberOfLines={1}>{t.project_path}</RNText> : null}
        </RNView>
      </ScrollView>
    </>
  );
}

function statusLook(t: Trigger, Theme: ReturnType<typeof useTheme>): { label: string; color: string; icon: React.ComponentProps<typeof FontAwesome>['name'] } {
  switch (t.status) {
    case 'running': return { label: 'Running', color: Theme.green, icon: 'circle' };
    case 'scheduled': return { label: 'Scheduled', color: Theme.orange, icon: 'clock-o' };
    case 'paused': return { label: 'Paused', color: Theme.textMuted, icon: 'pause' };
    case 'failed': return { label: 'Failed', color: Theme.red, icon: 'times-circle' };
    default: return { label: 'Done', color: Theme.textMuted, icon: 'check' };
  }
}

function Vital({ label, sub, subColor, children }: { label: string; sub?: string; subColor?: string; children: React.ReactNode }) {
  return (
    <RNView style={styles.vital}>
      <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.vitalLabel}>{label}</RNText>
      {children}
      {sub ? <RNText style={[styles.vitalSub, subColor && { color: subColor }]} numberOfLines={2}>{sub}</RNText> : null}
    </RNView>
  );
}

// Newest first. A spawned run is its own session, named by its summary (or its
// fire time when it only repeats the trigger's title); inject
// runs share the home session, so their fire time is the label. A firing the
// precheck refused has no session to open.
function RunList({ runs, now, triggerTitle, onOpen }: { runs: TriggerRun[]; now: number; triggerTitle: string; onOpen: (run: TriggerRun) => void }) {
  const Theme = useTheme();
  const [limit, setLimit] = useState(RUN_PAGE);
  const visible = runs.slice(0, limit);
  return (
    <>
      {visible.map((run, i) => {
        const num = runs.length - i;
        const skipped = run.kind === 'skipped_precheck';
        // A run named after the trigger says nothing new; its fire time does.
        const label = skipped ? run.title : run.kind === 'inject' ? fmtClock(run.created_at) : run.idle_summary || (run.title && run.title !== triggerTitle ? run.title : fmtClock(run.created_at));
        return (
          <TouchableOpacity
            key={run.run_key}
            disabled={skipped}
            activeOpacity={0.6}
            onPress={() => onOpen(run)}
            style={[styles.runRow, i > 0 && styles.rowRule]}
          >
            <RNView style={[styles.runDot, skipped ? styles.runDotHollow : i === 0 ? { backgroundColor: Theme.orange } : { backgroundColor: Theme.orange + '77' }]} />
            <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.runNum} numberOfLines={1}>#{num}</RNText>
            <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.runAge} numberOfLines={1}>{fmtDuration(Math.max(0, now - run.created_at)).split(' ')[0]} ago</RNText>
            {skipped && <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.skipTag}>skipped</RNText>}
            <RNText style={[styles.runLabel, i === 0 && !skipped && { color: Theme.text }, skipped && { color: Theme.textMuted0 }]} numberOfLines={1}>{label}</RNText>
            {!skipped && <Feather name="chevron-right" size={14} color={Theme.textMuted0} />}
          </TouchableOpacity>
        );
      })}
      {runs.length > limit && (
        <TouchableOpacity style={[styles.runRow, styles.rowRule]} onPress={() => setLimit(limit + RUN_PAGE)}>
          <RNText style={[styles.runLabel, { color: Theme.cyan }]}>Show {Math.min(RUN_PAGE, runs.length - limit)} more of {runs.length - limit} older</RNText>
        </TouchableOpacity>
      )}
    </>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  brief: { marginTop: 12, fontSize: 14, lineHeight: 21, color: Theme.textMuted },
  verbs: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 16 },
  banner: { marginTop: 16, borderWidth: 1, borderLeftWidth: 3, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 },
  bannerHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  bannerTitle: { fontSize: 13, fontWeight: '600', flexShrink: 1 },
  shrink: { flexShrink: 1 },
  bannerBody: { marginTop: 5, fontSize: 13, lineHeight: 19, color: Theme.textMuted },
  vitals: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 18 },
  vital: { flexBasis: '48%', flexGrow: 1, minWidth: 0, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.borderLight, backgroundColor: Theme.bgAlt, paddingHorizontal: 12, paddingVertical: 10 },
  vitalLabel: { fontSize: 10, fontWeight: '600', letterSpacing: 1, textTransform: 'uppercase', color: Theme.textMuted0, marginBottom: 4 },
  vitalValue: { fontSize: 15, fontWeight: '500', color: Theme.text, fontVariant: ['tabular-nums'] },
  vitalSub: { marginTop: 2, fontSize: 11, color: Theme.textMuted0 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  section: { marginTop: 22 },
  card: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.borderLight, backgroundColor: Theme.card, overflow: 'hidden' },
  promptCard: { paddingHorizontal: 14, paddingVertical: 12 },
  promptText: { fontSize: 14, lineHeight: 21, color: Theme.text },
  rowRule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Theme.borderLight },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 12 },
  linkLabel: { fontSize: 13, color: Theme.textMuted0 },
  linkTitle: { flex: 1, fontSize: 14, color: Theme.text },
  runRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 11 },
  runDot: { width: 8, height: 8, borderRadius: 4 },
  runDotHollow: { borderWidth: 1, borderColor: Theme.textMuted0 },
  runNum: { minWidth: 34, flexShrink: 0, fontSize: 12, fontFamily: uiFace(Mono.regular), color: Theme.textMuted0 },
  runAge: { minWidth: 56, flexShrink: 0, fontSize: 12, color: Theme.textMuted0, fontVariant: ['tabular-nums'] },
  runLabel: { flex: 1, fontSize: 14, color: Theme.textMuted },
  skipTag: { fontSize: 11, color: Theme.textMuted0, borderWidth: 1, borderColor: Theme.borderLight, borderRadius: 4, paddingHorizontal: 4 },
  emptyRuns: { paddingHorizontal: 12, paddingVertical: 14, fontSize: 13, color: Theme.textMuted0 },
  precheck: { fontSize: 13, lineHeight: 19, color: Theme.text },
  mono: { fontFamily: uiFace(Mono.regular) },
  dim: { fontSize: 12, color: Theme.textMuted0 },
  dimSmall: { marginTop: 4, fontSize: 12, color: Theme.textMuted0 },
  footer: { marginTop: 22, gap: 0 },
}));
