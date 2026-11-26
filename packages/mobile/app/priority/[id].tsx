// A priority on the phone (`pri-N`), in the order the web's priority page
// reads: where it stands (rank and who placed it, the critical meter, owner,
// when it started), ten days of typing into it, the one next action, the
// other sessions asking the person, the AI's summary, the critical path and
// polish milestones, what it links to, and the owner's pending corrections.
// Store-fed: priorities.show feeds priorityDetails (web hooks/usePriorityDetail);
// the workspace list's row paints until the detail lands. Every model comes
// from web's lib/priorityList, so the next action and ordering match web.
// The owner's controls are web's writes (lib/priorityWrites, the same store
// actions and overrides): a milestone's box toggles Done, Move up and down
// step the rank, and Correct… writes a correction. Rename, drop, merge, set
// aside and a session's move are web-only for now.
import { useMemo, useRef, useState, type ComponentProps } from 'react';
import { ScrollView, StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';
import { Text as RNText, TextInput } from '@/components/Themed';
import { CHROME_FONT_CAP, Spacing, themedStyles, useTheme } from '@/constants/Theme';
import { api as _api } from '@codecast/convex/convex/_generated/api';
import { useQueryNoThrow } from '@codecast/web/hooks/useQueryNoThrow';
import { useCoarseNow } from '@codecast/web/hooks/useCoarseNow';
import { linkedSessionIds, usePriorityLiveStates } from '@codecast/web/hooks/usePriorityModels';
import { LIST_DAYS, STATE_WORD, ago, buildModels, lastDays, waitingOf, type MilestoneModel, type PriorityModel, type SessionLine } from '@codecast/web/lib/priorityList';
import { asksPerson, bestSession } from '@codecast/shared/contracts/priorityDerive';
import type { PriorityHistory, PriorityPlanRef } from '@codecast/shared/contracts/priorities';
import { ObjectHeader, ObjectMissing, SectionLabel, objectStyles } from '@/components/objects/ObjectParts';
import { usePriorityDetail, useSyncPriorityDetail } from '@codecast/web/hooks/usePriorityDetail';
import { correctionDraft, milestoneBox, nextWords, ownerWords, sessionLabel, standing } from '@/lib/priorityScreen';
import { AnswerOutline, PrimaryAction, usePriorityActs } from '@/components/priorities/PriorityButtons';
import { appAlert } from '@/lib/popups';
import { priorityWrites } from '@codecast/web/lib/priorityWrites';
import type { PriorityView } from '@codecast/web/lib/priorityDetail';

const api = _api as any;

/** The owner's writes; a refusal puts the paint back and says the server's reason. */
const writes = priorityWrites((message) => appAlert("Couldn't save that", message));

type Row = PriorityView;

const shortDate = (at: number) => new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export default function PriorityScreen() {
  const Theme = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const ref = String(id ?? '').toLowerCase();
  const feed = useSyncPriorityDetail(ref || null);
  const row = usePriorityDetail(ref || null);
  // A refusal wins over whatever the store held: merged, rewritten, or no longer the viewer's to read.
  if (feed.refused) return <ObjectMissing what="Priority" id={ref} loading={false} />;
  if (!row) {
    if (feed.error) {
      return (
        <>
          <ObjectHeader type="priority" shortId={ref} title={ref} />
          <RNView style={styles.center} testID="priority-error">
            <Feather name="alert-triangle" size={26} color={Theme.textMuted0} />
            <RNText style={styles.centerText}>This priority didn't load</RNText>
            <TouchableOpacity onPress={feed.retry} style={styles.retry} accessibilityRole="button">
              <RNText style={styles.retryText}>Try again</RNText>
            </TouchableOpacity>
          </RNView>
        </>
      );
    }
    return <ObjectMissing what="Priority" id={ref} loading={!feed.ready} />;
  }
  return <PriorityBody key={row._id} row={row} />;
}

function PriorityBody({ row }: { row: Row }) {
  const Theme = useTheme();
  const router = useRouter();
  const now = useCoarseNow(60_000);
  const days = useMemo(() => lastDays(LIST_DAYS, now), [now]);
  // Typing per day is computed on read (no table to mirror): an enrichment beside the row.
  const history = useQueryNoThrow(
    api.priorities.history,
    row.workspace ? { workspace: row.workspace, days: LIST_DAYS, tz_offset_minutes: new Date().getTimezoneOffset() } : 'skip',
    { remember: true },
  ).data as PriorityHistory | undefined;
  const ids = useMemo(() => linkedSessionIds([row]), [row]);
  const live = usePriorityLiveStates(ids, now);
  const model = useMemo(() => buildModels([row], history, live, days, now)[0], [row, history, live, days, now]);
  const [summaryOpen, setSummaryOpen] = useState(false);

  const { openSession, act } = usePriorityActs();
  const openMilestone = (m: MilestoneModel) => {
    if (m.tasks[0]) return router.push(`/task/${m.tasks[0]}` as never);
    const s = bestSession(m.sessions) ?? m.sessions[0];
    if (s) openSession(s);
  };

  const action = model.action;
  const waiting = waitingOf([model]).filter((w) => w.session.conversation_id !== action?.session?.conversation_id);
  const critical = model.milestones.filter((m) => m.tier === 'critical');
  const polish = model.milestones.filter((m) => m.tier === 'polish');
  const { critical_done: done, critical_total: total } = row.counts;
  const placed = standing(row);
  const owner = ownerWords(row);
  const next = action ? nextWords(action) : null;
  const corrections = row.corrections;
  const linked = useMemo(() => {
    const seen = new Set<string>();
    const out: SessionLine[] = [];
    for (const m of model.milestones) for (const s of m.sessions) if (!seen.has(s.conversation_id)) { seen.add(s.conversation_id); out.push(s); }
    return out.sort((a, b) => b.last_active_at - a.last_active_at);
  }, [model]);
  const plans = useMemo(() => {
    const out: PriorityPlanRef[] = model.plan ? [model.plan] : [];
    for (const m of model.milestones) for (const p of [m.plan, ...m.partOf]) if (p && !out.some((x) => x.short_id === p.short_id)) out.push(p);
    return out;
  }, [model]);

  return (
    <>
      <ObjectHeader type="priority" shortId={row.short_id} title={row.title} />
      <ScrollView style={objectStyles.container} contentContainerStyle={objectStyles.content} testID={`priority-screen-${row.short_id}`}>
        <RNView style={styles.titleRow}>
          <Feather name="target" size={18} color={Theme.orange} style={styles.titleIcon} />
          <RNText style={[objectStyles.title, styles.title]}>{row.title}</RNText>
        </RNView>
        <RNView style={styles.meta}>
          {placed && <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.metaText}>{placed}</RNText>}
          {total > 0 && (
            <RNView style={styles.meter} accessibilityLabel={`${done} of ${total} critical milestones done`}>
              {Array.from({ length: total }, (_, i) => (
                <RNView key={i} style={[styles.pip, { backgroundColor: i < done ? Theme.green : Theme.borderLight }]} />
              ))}
              <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.metaText}>{done}/{total}</RNText>
            </RNView>
          )}
          {owner && <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.metaText}>{owner}</RNText>}
          <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.metaText}>Started {shortDate(row.first_seen_at)}</RNText>
          <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.metaDim}>{row.short_id}</RNText>
        </RNView>

        {row.mine && <OwnerControls row={row} />}

        <DayStrip model={model} />

        {action && next && (
          <RNView style={objectStyles.section} testID="priority-next">
            <SectionLabel>Next</SectionLabel>
            <RNView style={styles.card}>
              <RNText style={styles.nextTitle}>{next.title}</RNText>
              <RNView style={styles.nextRow}>
                <PrimaryAction action={action} onPress={() => act(row, action)} />
                {next.session && <RNText style={styles.inSession} numberOfLines={2}>{next.session}</RNText>}
              </RNView>
            </RNView>
          </RNView>
        )}

        {waiting.length > 0 && (
          <RNView style={objectStyles.section} testID="priority-waiting">
            <SectionLabel>Also waiting on you</SectionLabel>
            <RNView style={objectStyles.list}>
              {waiting.map((w) => (
                <RNView key={w.key} style={styles.line}>
                  <AnswerOutline onPress={() => openSession(w.session)} />
                  <RNView style={styles.lineBody}>
                    <RNText style={styles.lineTitle} numberOfLines={2}>{sessionLabel(w.session)}</RNText>
                    <RNText style={styles.lineMeta} numberOfLines={1}>{w.milestone}</RNText>
                  </RNView>
                </RNView>
              ))}
            </RNView>
          </RNView>
        )}

        {row.summary ? (
          <RNView style={objectStyles.section}>
            <TouchableOpacity onPress={() => setSummaryOpen((o) => !o)} style={styles.disclosure} accessibilityRole="button" accessibilityState={{ expanded: summaryOpen }} testID="priority-summary-toggle">
              <Feather name={summaryOpen ? 'chevron-down' : 'chevron-right'} size={14} color={Theme.textMuted} />
              <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.disclosureText}>AI summary</RNText>
            </TouchableOpacity>
            {summaryOpen && <RNText style={objectStyles.body}>{row.summary}</RNText>}
          </RNView>
        ) : null}

        <Milestones label="Critical path" list={critical} model={model} onOpen={openMilestone} onSession={openSession} testID="priority-critical" />
        <Milestones label="Polish" list={polish} model={model} onOpen={openMilestone} onSession={openSession} testID="priority-polish" />

        {(linked.length > 0 || plans.length > 0) && (
          <RNView style={objectStyles.section} testID="priority-linked">
            <SectionLabel>Linked</SectionLabel>
            <RNView style={objectStyles.list}>
              {plans.map((p) => (
                <TouchableOpacity key={p.short_id} style={styles.line} onPress={() => router.push(`/plan/${p.short_id}` as never)} activeOpacity={0.6}>
                  <Feather name="target" size={14} color={Theme.cyan} style={styles.lineIcon} />
                  <RNText style={[styles.lineTitle, styles.flex]} numberOfLines={2}>{p.title}</RNText>
                  <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.lineMeta}>{p.done}/{p.total}</RNText>
                  <Feather name="chevron-right" size={14} color={Theme.textDim} />
                </TouchableOpacity>
              ))}
              {linked.map((s) => (
                <TouchableOpacity key={s.conversation_id} style={styles.line} onPress={() => openSession(s)} activeOpacity={0.6}>
                  <Feather name={s.workflow ? 'git-merge' : 'message-square'} size={14} color={Theme.blue} style={styles.lineIcon} />
                  <RNText style={[styles.lineTitle, styles.flex]} numberOfLines={2}>{sessionLabel(s)}</RNText>
                  <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={[styles.lineMeta, asksPerson(s) && { color: Theme.text }]}>
                    {STATE_WORD[s.state]} · {ago(s.last_active_at, now)}
                  </RNText>
                  <Feather name="chevron-right" size={14} color={Theme.textDim} />
                </TouchableOpacity>
              ))}
            </RNView>
          </RNView>
        )}

        {corrections.length > 0 && (
          <RNView style={objectStyles.section} testID="priority-corrections">
            <SectionLabel>Corrections</SectionLabel>
            <RNView style={objectStyles.list}>
              {corrections.map((c) => {
                const about = c.step_key ? row.steps.find((s) => s.key === c.step_key)?.title : null;
                return (
                  <RNView key={c._id} style={styles.line}>
                    <RNView style={styles.lineBody}>
                      <RNText style={styles.lineTitle}>{c.text}</RNText>
                      <RNText style={styles.lineMeta} numberOfLines={1}>
                        {c.status === 'pending' ? 'Waits for the next pass' : 'Applied'} · {shortDate(c.created_at)}{about ? ` · ${about}` : ''}
                      </RNText>
                    </RNView>
                  </RNView>
                );
              })}
            </RNView>
          </RNView>
        )}
      </ScrollView>
    </>
  );
}

/** Ten days as bars on this priority's own scale; today outlined; a tick over a day a critical milestone landed. */
function DayStrip({ model }: { model: PriorityModel }) {
  const Theme = useTheme();
  const peak = Math.max(1, ...model.counts);
  const todayIndex = model.counts.length - 1;
  const MAX = 28;
  return (
    <RNView style={objectStyles.section} testID="priority-days">
      <RNView style={styles.strip} accessibilityLabel={`${model.today} messages today, ${model.landed10} critical milestones landed in ${LIST_DAYS} days`}>
        {model.counts.map((c, i) => {
          const h = c <= 0 ? 2 : Math.max(3, Math.round((c / peak) * MAX));
          const today = i === todayIndex;
          return (
            <RNView key={i} style={styles.dayCol}>
              <RNView style={[styles.tick, { backgroundColor: model.landed[i] ? Theme.text : 'transparent' }]} />
              <RNView style={[
                styles.bar,
                { height: today ? Math.max(6, h) : h },
                today ? { borderWidth: 1.5, borderColor: Theme.green, backgroundColor: 'transparent' } : { backgroundColor: c > 0 ? Theme.green : Theme.borderLight },
              ]} />
            </RNView>
          );
        })}
      </RNView>
      <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.stripCaption}>
        {model.today} today · {model.landed10} landed in {LIST_DAYS} days
        {model.stalledDays != null ? ` · stalled ${model.stalledDays}d` : ''}
      </RNText>
    </RNView>
  );
}

/** The owner's row of controls: a step up or down in their order, and Correct…, which opens a box for what the pass got wrong. */
function OwnerControls({ row }: { row: Row }) {
  const Theme = useTheme();
  const [correcting, setCorrecting] = useState(false);
  // Uncontrolled: what was typed is read on Save, so typing re-renders nothing; Cancel empties it.
  const draft = useRef(correctionDraft()).current;
  const ranked = row.status === 'active' && row.rank != null;
  const close = () => {
    draft.cancel();
    setCorrecting(false);
  };
  const save = () => {
    const body = draft.take();
    if (!body) return;
    writes.correct(row.short_id, body, null);
    setCorrecting(false);
  };
  const chip = (label: string, icon: ComponentProps<typeof Feather>['name'], onPress: () => void, testID: string, disabled = false) => (
    <TouchableOpacity onPress={onPress} disabled={disabled} style={[styles.control, disabled && styles.disabled]} accessibilityRole="button" accessibilityLabel={label} testID={testID}>
      <Feather name={icon} size={14} color={Theme.textMuted} />
      <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.controlText}>{label}</RNText>
    </TouchableOpacity>
  );
  return (
    <RNView style={styles.controlsWrap}>
      <RNView style={styles.controls}>
        {ranked && chip('Move up', 'arrow-up', () => writes.move(row.short_id, 'up'), 'priority-move-up', row.rank === 1)}
        {ranked && chip('Move down', 'arrow-down', () => writes.move(row.short_id, 'down'), 'priority-move-down')}
        {chip('Correct…', 'edit-3', () => (correcting ? close() : setCorrecting(true)), 'priority-correct')}
      </RNView>
      {correcting && (
        <RNView style={styles.card} testID="priority-correct-box">
          <TextInput
            autoFocus
            multiline
            placeholder="What did it get wrong?"
            placeholderTextColor={Theme.textDim}
            onChangeText={draft.type}
            style={styles.correctInput}
            testID="priority-correct-text"
          />
          <RNText style={styles.lineMeta}>The next pass keeps this.</RNText>
          <RNView style={styles.controls}>
            <TouchableOpacity onPress={close} style={styles.control} accessibilityRole="button" testID="priority-correct-cancel">
              <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.controlText}>Cancel</RNText>
            </TouchableOpacity>
            <TouchableOpacity onPress={save} style={[styles.control, { backgroundColor: Theme.text }]} accessibilityRole="button" testID="priority-correct-save">
              <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={[styles.controlText, { color: Theme.bg, fontWeight: '600' }]}>Save</RNText>
            </TouchableOpacity>
          </RNView>
        </RNView>
      )}
    </RNView>
  );
}


function Milestones({ label, list, model, onOpen, onSession, testID }: {
  label: string;
  list: MilestoneModel[];
  model: PriorityModel;
  onOpen: (m: MilestoneModel) => void;
  onSession: (s: SessionLine) => void;
  testID: string;
}) {
  const Theme = useTheme();
  if (list.length === 0) return null;
  const doneCount = list.filter((m) => m.done).length;
  return (
    <RNView style={objectStyles.section} testID={testID}>
      <SectionLabel>{`${label} · ${doneCount}/${list.length}`}</SectionLabel>
      <RNView style={objectStyles.list}>
        {list.map((m) => {
          const asking = m.done ? undefined : m.sessions.find(asksPerson);
          const lead = m.done ? undefined : bestSession(m.sessions);
          const isAction = model.action?.milestone.key === m.key;
          const box = milestoneBox(model.row, m);
          return (
            <TouchableOpacity key={m.key} style={styles.line} onPress={() => onOpen(m)} activeOpacity={0.6} testID={`priority-step-${m.key}`}>
              {box.kind === 'toggle' ? (
                // The owner's box is its own 44px press: Done or not, never the line's open.
                <TouchableOpacity
                  onPress={() => writes.setStepDone(model.row.short_id, m.key, box.writes)}
                  style={styles.toggle}
                  hitSlop={{ top: 4, bottom: 4 }}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: m.done }}
                  accessibilityLabel={box.label}
                  testID={`priority-step-toggle-${m.key}`}
                >
                  <Feather name={m.done ? 'check-square' : 'square'} size={18} color={m.done ? Theme.green : Theme.textDim} />
                </TouchableOpacity>
              ) : (
                // A teammate's milestone: a status mark, not a box, since nothing here is theirs to press.
                <Feather name={m.done ? 'check' : 'circle'} size={m.done ? 16 : 10} color={m.done ? Theme.green : Theme.textDim} style={styles.lineIcon} accessibilityLabel={box.label} />
              )}
              <RNView style={styles.lineBody}>
                <RNText style={[styles.lineTitle, m.done && { color: Theme.textMuted }]} numberOfLines={3}>{m.step.title}</RNText>
                {m.done ? (
                  <RNText style={styles.lineMeta}>{m.step.done_at ? `Landed ${shortDate(m.step.done_at)}` : 'Landed'}</RNText>
                ) : lead && !asking ? (
                  <RNText style={styles.lineMeta} numberOfLines={1}>{STATE_WORD[lead.state]} · {sessionLabel(lead)}</RNText>
                ) : !asking ? (
                  <RNText style={styles.lineMeta}>{isAction ? 'Nothing started' : 'No session'}</RNText>
                ) : null}
                {(m.looksDone || m.correctionPending) && (
                  <RNText style={styles.lineMeta}>{[m.looksDone && 'Looks done?', m.correctionPending && 'correction pending'].filter(Boolean).join(' · ')}</RNText>
                )}
              </RNView>
              {asking && <AnswerOutline onPress={() => onSession(asking)} />}
            </TouchableOpacity>
          );
        })}
      </RNView>
    </RNView>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 10, backgroundColor: Theme.bg, padding: Spacing.xxl },
  centerText: { fontSize: 14, color: Theme.textMuted, textAlign: 'center' },
  retry: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 16, borderRadius: 8, backgroundColor: Theme.bgAlt, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.borderLight },
  retryText: { fontSize: 14, fontWeight: '500', color: Theme.accent },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  titleIcon: { marginTop: 4 },
  title: { flex: 1, marginBottom: 6 },
  meta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 12, rowGap: 4, marginBottom: Spacing.lg },
  metaText: { fontSize: 12.5, color: Theme.textMuted, fontVariant: ['tabular-nums'] },
  metaDim: { fontSize: 12.5, color: Theme.textDim },
  meter: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  pip: { width: 7, height: 7, borderRadius: 1.5, marginRight: 1 },
  strip: { flexDirection: 'row', alignItems: 'flex-end', gap: 4, height: 28 + 8 },
  dayCol: { flex: 1, alignItems: 'stretch', justifyContent: 'flex-end', gap: 3 },
  tick: { height: 4, width: 2, alignSelf: 'center' },
  bar: { borderRadius: 2 },
  stripCaption: { marginTop: 6, fontSize: 12, color: Theme.textMuted, fontVariant: ['tabular-nums'] },
  card: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.borderLight, backgroundColor: Theme.card, padding: Spacing.md, gap: 10 },
  nextTitle: { fontSize: 15, fontWeight: '600', color: Theme.text, lineHeight: 21 },
  nextRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  inSession: { flex: 1, fontSize: 12.5, color: Theme.textMuted },
  disclosure: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, alignSelf: 'flex-start' },
  disclosureText: { fontSize: 12, fontWeight: '600', color: Theme.textMuted0, textTransform: 'uppercase', letterSpacing: 0.5 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52, paddingHorizontal: Spacing.md, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Theme.bgHighlight },
  lineIcon: { width: 18, textAlign: 'center' },
  toggle: { width: 44, height: 44, marginLeft: -13, marginRight: -13, alignItems: 'center', justifyContent: 'center' },
  controlsWrap: { gap: 10, marginBottom: Spacing.lg },
  controls: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  control: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, paddingHorizontal: 14, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.borderLight, backgroundColor: Theme.bgAlt },
  controlText: { fontSize: 13.5, color: Theme.text },
  disabled: { opacity: 0.4 },
  correctInput: { minHeight: 88, fontSize: 16, color: Theme.text, textAlignVertical: 'top', padding: 10, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.borderLight, backgroundColor: Theme.bg },
  lineBody: { flex: 1, minWidth: 0, gap: 2 },
  lineTitle: { fontSize: 14.5, fontWeight: '500', color: Theme.text, lineHeight: 20 },
  lineMeta: { fontSize: 12, color: Theme.textMuted, fontVariant: ['tabular-nums'] },
}));
