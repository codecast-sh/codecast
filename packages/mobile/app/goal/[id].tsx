// A goal on the phone, in the order the web's goal sheet reads: its status,
// health, owner and target day; why it matters; the numbers it is measured
// by; how much of its projects' work is done; the latest update (and posting
// one); what it serves and what feeds it; its projects, plans, open tasks and
// sessions as rows that open their own screens. Reads the store; the goals
// and their updates are fed here, the rest app-wide.
import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Text as RNText } from '@/components/Themed';
import { CHROME_FONT_CAP, Spacing, themedStyles, useTheme } from '@/constants/Theme';
import { useInboxStore, type ProjectItem } from '@codecast/web/store/inboxStore';
import { windowOrgTree } from '@codecast/web/store/orgSlice';
import { teamMembersOf } from '@codecast/web/lib/activeTeam';
import { useCoarseNow } from '@codecast/web/hooks/useCoarseNow';
import { useInitiatives, useInitiativeUpdates, useSyncInitiatives, useSyncInitiativeUpdates } from '@codecast/web/hooks/useInitiatives';
import { useMetricSeries, useSyncMetricSeries } from '@codecast/web/hooks/useMetricSeries';
import { goalScopeProjectIds, initiativeEnded, initiativeProgress, subInitiatives } from '@codecast/web/lib/initiatives';
import { sessionsUnder } from '@codecast/web/components/org/goalsLayout';
import type { OrgTree } from '@codecast/web/components/org/orgTypes';
import { agoOf } from '@codecast/web/lib/threadState';
import { mdeWords, standingWord } from '@codecast/shared/contracts/metricStanding';
import { INITIATIVE_STATUSES, INITIATIVE_UPDATE_HEALTHS, metricAgainst, metricReadings, type InitiativeRow, type InitiativeUpdateHealth } from '@codecast/shared/contracts/initiative';
import { isOnProjectBoard, projectTaskCounts } from '@codecast/shared/tasks';
import { TaskItemRow, showTaskActions } from '@/components/TaskItem';
import { PlanItemRow } from '@/components/PlanItem';
import { MarkdownContent } from '@/components/MarkdownRenderer';
import { CollapsibleBody } from '@/components/CollapsibleBody';
import { appPrompt, showActionSheet } from '@/lib/popups';
import { FactChip, LinkRow, MoreToggle, ObjectHeader, ObjectMissing, ProgressBlock, SectionLabel, SessionsBlock, objectStyles, targetChip } from '@/components/objects/ObjectParts';
import { goalStatusVisual, healthVisual, projectStatusVisual, sessionRowsFor } from '@/components/objects/objectStatus';

const TASKS_SHOWN = 8;

export default function GoalScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { ready } = useSyncInitiatives();
  const goals = useInitiatives();
  const ref = String(id ?? '').toLowerCase();
  const goal = goals.find((g) => g._id === id || g.short_id?.toLowerCase() === ref || g.client_key === id);
  if (!goal) return <ObjectMissing what="Goal" id={id} loading={!ready} />;
  return <GoalBody key={goal._id} goal={goal} goals={goals} />;
}

function GoalBody({ goal, goals }: { goal: InitiativeRow; goals: InitiativeRow[] }) {
  const Theme = useTheme();
  const router = useRouter();
  const now = useCoarseNow(60_000);
  useSyncInitiativeUpdates(goal._id);
  useSyncMetricSeries();
  const { lookup } = useMetricSeries();
  const updates = useInitiativeUpdates(goal._id);
  const tasks = useInboxStore((s) => s.tasks);
  const plans = useInboxStore((s) => s.plans);
  const projectRows = useInboxStore((s) => s.projects) as Record<string, ProjectItem>;
  const updateTask = useInboxStore((s) => s.updateTask);
  const tree = useInboxStore(windowOrgTree) as OrgTree | null;
  const members = useInboxStore(teamMembersOf) as any[];
  const meId = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  const [allTasks, setAllTasks] = useState(false);

  // The goal's work is its own projects' and its sub-goals' projects', as the web counts it.
  const scopeIds = useMemo(() => goalScopeProjectIds(goal, goals), [goal, goals]);
  const progress = useMemo(() => initiativeProgress({ project_ids: scopeIds }, Object.values(tasks) as any), [tasks, scopeIds]);
  const projects = goal.project_ids.map((pid) => projectRows[pid]).filter(Boolean) as ProjectItem[];
  const children = useMemo(() => subInitiatives(goals, goal._id), [goals, goal._id]);
  const parent = goal.parent_initiative_id ? goals.find((g) => g._id === goal.parent_initiative_id) : undefined;
  const readings = metricReadings(goal, lookup);
  const scopeSet = useMemo(() => new Set(scopeIds), [scopeIds]);
  const openTasks = useMemo(
    () => Object.values(tasks)
      .filter((t) => t.project_id && scopeSet.has(String(t.project_id)) && isOnProjectBoard(t as any) && t.status !== 'done')
      .sort((a, b) => (a.status === 'in_progress' ? 0 : 1) - (b.status === 'in_progress' ? 0 : 1) || (b.updated_at ?? 0) - (a.updated_at ?? 0)),
    [tasks, scopeSet],
  );
  const goalPlans = useMemo(
    () => Object.values(plans).filter((p) => p.project_id && scopeSet.has(String(p.project_id)) && (p.status === 'active' || p.status === 'draft' || p.status === 'paused')),
    [plans, scopeSet],
  );
  const sessionsSig = useInboxStore((s) => Object.values(s.sessions).filter((x) => x.project_id && scopeSet.has(String(x.project_id))).map((x) => `${x._id}:${x.updated_at}`).join(','));
  const sessions = useMemo(() => sessionRowsFor(useInboxStore.getState().sessions, scopeIds, tree ? sessionsUnder(tree, scopeIds) : []), [sessionsSig, tree, scopeIds]); // eslint-disable-line react-hooks/exhaustive-deps

  const status = goalStatusVisual(goal.status, Theme);
  const health = healthVisual(goal.health, Theme);
  const ended = initiativeEnded(goal.status);
  const target = goal.target_date ? targetChip(goal.target_date, now, ended, Theme) : null;
  const ownerRole = goal.owner?.kind === 'role' ? tree?.roles.find((r) => String(r._id) === String((goal.owner as any).role_id)) : undefined;
  const ownerUserId = goal.owner?.kind === 'user' ? goal.owner.user_id : null;
  const ownerName = ownerUserId ? (ownerUserId === meId ? 'You' : members.find((m) => String(m?._id ?? m?.user_id) === ownerUserId)?.name ?? 'Owner') : null;
  const why = (goal.why || goal.description || '').trim();

  const update = (fields: Record<string, unknown>) => useInboxStore.getState().updateInitiative(goal._id, fields as any);
  const pickStatus = () => showActionSheet('Status', INITIATIVE_STATUSES.map((s) => ({
    label: goalStatusVisual(s, Theme).label,
    selected: s === goal.status,
    destructive: s === 'cancelled',
    onPress: () => update({ status: s }),
  })));
  const postUpdate = () => showActionSheet('How is it going?', INITIATIVE_UPDATE_HEALTHS.map((h: InitiativeUpdateHealth) => ({
    label: healthVisual(h, Theme).label,
    onPress: () => appPrompt(`Update · ${healthVisual(h, Theme).label}`, {
      placeholder: 'What moved, what is next',
      confirm: 'Post',
      accepts: (t) => !!t.trim(),
      onSubmit: (body) => useInboxStore.getState().postInitiativeUpdate(goal._id, { client_key: `iu_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, body: body.trim(), health: h }),
    }),
  })));
  const rename = () => appPrompt('Rename goal', {
    defaultValue: goal.title,
    confirm: 'Save',
    accepts: (t) => !!t.trim() && t.trim() !== goal.title,
    onSubmit: (title) => update({ title: title.trim() }),
  });
  const latest = updates[0];

  return (
    <>
      <ObjectHeader type="initiative" shortId={goal.short_id} title={goal.title} menu={[{ label: 'Post an update', onPress: postUpdate }, { label: 'Rename', onPress: rename }, { label: 'Change status', onPress: pickStatus }]} />
      <ScrollView style={objectStyles.container} contentContainerStyle={objectStyles.content} testID={`goal-screen-${goal.short_id}`}>
        {parent && (
          <TouchableOpacity onPress={() => router.push(`/goal/${parent.short_id || parent._id}` as never)} activeOpacity={0.6} style={styles.crumb}>
            <FontAwesome name="flag-o" size={11} color={Theme.textMuted} />
            <RNText style={styles.crumbText} numberOfLines={1}>{parent.title}</RNText>
            <FontAwesome name="angle-right" size={12} color={Theme.textDim} />
          </TouchableOpacity>
        )}
        <RNText style={objectStyles.title}>{goal.title}</RNText>
        <RNView style={objectStyles.chips}>
          <FactChip icon={status.icon} label={status.label} color={status.color} onPress={pickStatus} testID="goal-status" />
          {goal.health !== 'none' && <FactChip icon={health.icon} label={health.label} color={health.color} />}
          {ownerRole && <FactChip icon="user-o" label={`@${ownerRole.handle}`} color={Theme.textSecondary} link onPress={() => router.push(`/org/${ownerRole.short_id}` as never)} />}
          {ownerName && <FactChip icon="user-o" label={ownerName} color={Theme.textSecondary} />}
          {target && <FactChip icon="calendar-o" label={target.label} color={target.color} />}
        </RNView>

        {why ? (
          <RNView style={objectStyles.section}>
            <CollapsibleBody fadeColor={Theme.bg} height={140}>
              <MarkdownContent text={why} baseStyle={objectStyles.body} />
            </CollapsibleBody>
          </RNView>
        ) : null}

        {readings.length > 0 && (
          <RNView style={objectStyles.section}>
            <SectionLabel>Measured by</SectionLabel>
            <RNView style={styles.metrics}>
              {readings.map((r) => {
                const color = r.standing === 'met' ? Theme.green : r.standing === 'behind' ? Theme.yellow : r.standing === 'within_noise' ? Theme.blue : Theme.textMuted;
                return (
                  <RNView key={r.key} style={styles.metric} testID={`goal-metric-${r.key}`}>
                    <RNText style={styles.metricName} numberOfLines={2}>{r.name}{r.guardrail ? ' · guardrail' : ''}</RNText>
                    <RNText style={[styles.metricValue, { color: r.value === null ? Theme.textDim : Theme.text }]} numberOfLines={1}>{r.value ?? '—'}</RNText>
                    <RNText style={[styles.metricTarget, { color }]} numberOfLines={1}>
                      {`${metricAgainst({ ...r, value: null })}${r.target_unread ? ` · unknown: ${r.target_unread}` : r.value !== null && r.standing !== 'unknown' ? ` · ${standingWord(r.standing, r.trajectory)}` : ''}${r.band?.mde ? ` · detects ${mdeWords(r.band.mde)} in 4 wk` : ''}`}
                    </RNText>
                    {r.progress !== null && (
                      <RNView style={styles.metricBar}><RNView style={[styles.metricFill, { width: `${Math.min(1, r.progress) * 100}%` as any, backgroundColor: color }]} /></RNView>
                    )}
                  </RNView>
                );
              })}
            </RNView>
          </RNView>
        )}

        <ProgressBlock progress={progress} />

        <RNView style={objectStyles.section}>
          <SectionLabel right={!ended ? (
            <TouchableOpacity onPress={postUpdate} hitSlop={8} testID="goal-post-update"><RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={objectStyles.ghostText}>Post an update</RNText></TouchableOpacity>
          ) : undefined}>Latest update</SectionLabel>
          {latest ? (
            <RNView style={[styles.update, { borderLeftColor: healthVisual(latest.health, Theme).color }]}>
              <RNText style={styles.updateMeta}>{healthVisual(latest.health, Theme).label} · {agoOf(now - latest.at)}</RNText>
              <MarkdownContent text={latest.body} baseStyle={objectStyles.body} />
            </RNView>
          ) : <RNText style={objectStyles.empty}>No update yet</RNText>}
        </RNView>

        {children.length > 0 && (
          <RNView style={objectStyles.section}>
            <SectionLabel>{`Fed by · ${children.length}`}</SectionLabel>
            <RNView style={objectStyles.list}>
              {children.map((g) => {
                const v = goalStatusVisual(g.status, Theme);
                return <LinkRow key={g._id} icon="flag-o" color={v.color} title={g.title} meta={v.label} onPress={() => router.push(`/goal/${g.short_id || g._id}` as never)} />;
              })}
            </RNView>
          </RNView>
        )}

        <RNView style={objectStyles.section}>
          <SectionLabel>{`Projects · ${projects.length}`}</SectionLabel>
          {projects.length > 0 ? (
            <RNView style={objectStyles.list}>
              {projects.map((p) => {
                const v = projectStatusVisual(p.status, Theme);
                const n = projectTaskCounts(Object.values(tasks) as any, [p._id]);
                return <LinkRow key={p._id} icon={v.icon} color={v.color} title={p.title} meta={n.total ? `${n.done}/${n.total}` : undefined} onPress={() => router.push(`/project/${p.short_id || p._id}` as never)} testID={`goal-project-${p.short_id}`} />;
              })}
            </RNView>
          ) : <RNText style={objectStyles.empty}>No project carries this goal yet</RNText>}
        </RNView>

        {goalPlans.length > 0 && (
          <RNView style={objectStyles.section}>
            <SectionLabel>{`Plans · ${goalPlans.length}`}</SectionLabel>
            <RNView style={objectStyles.list}>
              {goalPlans.map((p) => <PlanItemRow key={p._id} plan={p} onPress={() => router.push(`/plan/${p.short_id}` as never)} />)}
            </RNView>
          </RNView>
        )}

        {openTasks.length > 0 && (
          <RNView style={objectStyles.section}>
            <SectionLabel>{`Open tasks · ${openTasks.length}`}</SectionLabel>
            <RNView style={objectStyles.list}>
              {(allTasks ? openTasks : openTasks.slice(0, TASKS_SHOWN)).map((t) => (
                <TaskItemRow key={t._id} task={t} onPress={() => router.push(`/task/${t.short_id}` as never)} onLongPress={() => showTaskActions(t, updateTask)} />
              ))}
            </RNView>
            <MoreToggle hidden={openTasks.length - TASKS_SHOWN} open={allTasks} onPress={() => setAllTasks((v) => !v)} />
          </RNView>
        )}

        <SessionsBlock sessions={sessions} />
      </ScrollView>
    </>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  crumb: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6, alignSelf: 'flex-start', maxWidth: '100%' },
  crumbText: { fontSize: 12.5, color: Theme.textMuted, flexShrink: 1 },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  metric: { flexGrow: 1, flexBasis: '45%', minWidth: 140, padding: Spacing.md, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.borderLight, backgroundColor: Theme.bgAlt, gap: 2 },
  metricName: { fontSize: 11.5, fontWeight: '600', color: Theme.textMuted },
  metricValue: { fontSize: 22, fontWeight: '700', fontVariant: ['tabular-nums'] },
  metricTarget: { fontSize: 11.5, fontVariant: ['tabular-nums'] },
  metricBar: { height: 3, borderRadius: 2, backgroundColor: Theme.borderLight, marginTop: 6, overflow: 'hidden' },
  metricFill: { height: 3 },
  update: { borderLeftWidth: 2, paddingLeft: Spacing.md, gap: 4 },
  updateMeta: { fontSize: 11.5, fontWeight: '600', color: Theme.textMuted },
}));
