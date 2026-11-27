// What the phone's Priorities list (app/priorities.tsx) and a priority's
// screen (app/priority/[id].tsx) both draw: the ten-day strip, a priority's
// milestones (each with its state mark, then DONE n and POLISH x/y), and an
// open milestone's connected list, grouped by kind. The words and choices
// are lib/prioritiesList's; every press opens a native screen or runs web's
// write (lib/priorityWrites).
import { useState, type ReactNode } from 'react';
import { StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import { useRouter } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import * as Haptics from 'expo-haptics';
import { Text as RNText } from '@/components/Themed';
import { CHROME_FONT_CAP, themedStyles, useTheme } from '@/constants/Theme';
import { codeFont } from '@/constants/fonts';
import { CODECAST_BASE_URL } from '@codecast/shared/entities';
import type { PriorityPlanRef, PriorityRow, PriorityStep } from '@codecast/shared/contracts/priorities';
import { sessionRowMark, type MilestoneModel, type PriorityModel, type SessionLine } from '@codecast/web/lib/priorityList';
import { SESSION_STATUS } from '@codecast/web/lib/sessionStatus';
import { priorityHref } from '@codecast/web/lib/priorities';
import { priorityWrites } from '@codecast/web/lib/priorityWrites';
import { branchesOf, type LinkLookups } from '@codecast/web/hooks/usePriorityModels';
import { lookup } from '@codecast/web/lib/liveEntities';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { STATUS_CONFIG } from '@/components/TaskItem';
import { SessionStatusMark } from '@/components/SessionStatusMark';
import { MilestoneMark, usePriorityActs } from '@/components/priorities/MilestoneMark';
import { mobileEntityRoute } from '@/lib/linkRoutes';
import { appAlert, appPrompt, showActionSheet } from '@/lib/popups';
import { copyToClipboard } from '@/lib/clipboard';
import {
  age, connectedOf, dayBar, dayLabel, milestoneMenu, milestoneSections, moveToItems, priorityMenu, sectionRuns, sessionLabel, sessionMenu, sessionTargets,
  workflowRef, type MenuUi, type SectionKind,
} from '@/lib/prioritiesList';

/** The owner's writes; a refusal puts the paint back and says the server's reason. */
const writes = priorityWrites((message) => appAlert("Couldn't save that", message));

/** The glyphs of what an open milestone lists, here and in the legend. A workflow run is not the merge glyph a merged pull request wears. */
export const KIND_ICON = { workflow: 'share-2', branch: 'git-branch', plan: 'map', deploy: 'upload-cloud' } as const;

/** The owner's other active priorities in the same workspace, in order: where a move, a merge or a session can go. */
export type OwnOf = (row: PriorityRow) => PriorityRow[];

// ── Ten days ────────────────────────────────────────────────────────────

/**
 * Ten days of typing as bars shaded by how much was typed, on one scale
 * (`peak`), today outlined. A list row's are thin; `page` spreads them across
 * the screen with the day under each.
 */
export function DayStrip({ counts, days, todayIndex, peak, page }: { counts: number[]; days: readonly string[]; todayIndex: number; peak: number; page?: boolean }) {
  const Theme = useTheme();
  const max = page ? 48 : 20;
  const total = counts.reduce((a, b) => a + b, 0);
  return (
    <RNView style={page ? styles.pageStrip : styles.listStrip} accessible accessibilityLabel={`${counts[todayIndex] ?? 0} messages today, ${total} in ${counts.length} days`} testID={page ? 'priority-days' : undefined}>
      {counts.map((c, i) => {
        const { height, opacity } = dayBar(c, peak, max);
        const today = i === todayIndex;
        const bar = (
          <RNView style={[styles.bar, { height, opacity }, { backgroundColor: c > 0 ? Theme.green : Theme.borderLight }, today && { borderWidth: 1, borderColor: Theme.green }]} />
        );
        if (!page) return <RNView key={days[i] ?? i} style={[styles.listDay, { height: max }]}>{bar}</RNView>;
        return (
          <RNView key={days[i] ?? i} style={styles.pageDay}>
            <RNView style={[styles.pageBarBox, { height: max }]}>{bar}</RNView>
            <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} numberOfLines={1} style={[styles.dayText, today && { color: Theme.text, fontWeight: '600' }]}>
              {dayLabel(days[i] ?? '', today)}
            </RNText>
          </RNView>
        );
      })}
    </RNView>
  );
}

// ── Menus ───────────────────────────────────────────────────────────────

/** A ⋯ button, 44pt, always shown: a finger has no hover to reveal it. */
export function More({ label, onPress, testID }: { label: string; onPress: () => void; testID: string }) {
  const Theme = useTheme();
  return (
    <TouchableOpacity onPress={onPress} style={styles.more} accessibilityRole="button" accessibilityLabel={label} testID={testID}>
      <Feather name="more-horizontal" size={16} color={Theme.textDim} />
    </TouchableOpacity>
  );
}

const correctPrompt = (subject: string, save: (text: string) => void) => appPrompt('Correct', {
  message: `${subject}\nThe next pass keeps this.`,
  placeholder: 'What did it get wrong?',
  confirm: 'Save',
  accepts: (t) => t.trim().length > 0,
  onSubmit: (t) => { if (t.trim()) save(t.trim()); },
});

const renamePrompt = (title: string, what: string, save: (next: string) => void) => appPrompt(`Rename ${what}`, {
  defaultValue: title,
  confirm: 'Rename',
  accepts: (t) => !!t.trim() && t.trim() !== title,
  onSubmit: (t) => { const next = t.trim(); if (next && next !== title) save(next); },
});

/** The sessions a milestone (or the whole priority) links, each once, plus the ones the rows count but do not carry. */
function linkedCount(row: Pick<PriorityRow, 'links'>, stepKey?: string): number {
  const links = (row.links ?? []).filter((l) => stepKey == null || l.key === stepKey);
  return new Set(links.flatMap((l) => l.sessions.map((s) => s.conversation_id))).size + links.reduce((n, l) => n + l.sessions_more, 0);
}

/** The priority's ⋯ as a sheet (lib/prioritiesList priorityMenu), each row's follow-up wired: `open` is left out on the priority's own screen. */
export function priorityMenuSheet(row: PriorityRow, own: OwnOf, open?: () => void): { title: string; items: ReturnType<typeof priorityMenu>['items'] } {
  const ownRows = own(row);
  const ui: MenuUi = {
    open,
    rename: () => renamePrompt(row.title, 'priority', (next) => writes.renamePriority(row.short_id, next)),
    moveTo: () => showActionSheet('Move to', moveToItems(row, ownRows, writes)),
    mergeInto: () => showActionSheet('Merge into', ownRows.filter((r) => r.short_id !== row.short_id).map((into) => ({
      label: `${into.rank ?? ''} ${into.title}`.trim(),
      onPress: () => {
        const n = row.steps.length;
        const s = linkedCount(row);
        appAlert('Merge priority?', `${row.title} ends and its ${n} ${n === 1 ? 'milestone' : 'milestones'} and ${s} ${s === 1 ? 'session' : 'sessions'} move into ${into.title}. There is no undo.`, [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Merge', style: 'destructive', onPress: () => writes.merge(row.short_id, into.short_id) },
        ]);
      },
    }))),
    correct: () => correctPrompt(row.title, (text) => writes.correct(row.short_id, text, null)),
    copyLink: () => { void copyToClipboard(CODECAST_BASE_URL + priorityHref(row.short_id)); void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); },
  };
  return priorityMenu(row, ownRows, writes, ui);
}

/** "correction pending": the person's correction waits for the next pass. */
export function PendingMark() {
  return <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.pending}>correction pending</RNText>;
}

// ── Milestones ──────────────────────────────────────────────────────────

/**
 * A priority's milestones: its open critical ones, then DONE n and POLISH
 * x/y. A closed section is its head, sharing one line with the next closed
 * one; an open one is its head over its milestones. `expand` opens every
 * open milestone (the priority's screen), whose connected list then leaves
 * out the priority's plan (the screen shows it once above).
 */
export function Milestones({ model, now, lookups, own, expand = false }: { model: PriorityModel; now: number; lookups: LinkLookups; own: OwnOf; expand?: boolean }) {
  const [openSections, setOpenSections] = useState<ReadonlySet<SectionKind>>(new Set());
  const { open, sections } = milestoneSections(model);
  const line = (m: MilestoneModel) => <MilestoneLine key={m.key} model={model} m={m} now={now} lookups={lookups} own={own} defaultOpen={expand && !m.done} priorityPlan={expand ? null : model.plan} />;
  const toggle = (kind: SectionKind) => setOpenSections((s) => {
    const next = new Set(s);
    if (!next.delete(kind)) next.add(kind);
    return next;
  });
  return (
    <RNView testID={`priorities-milestones-${model.row.short_id}`}>
      {open.map(line)}
      {sectionRuns(sections, openSections).map((run) => (
        <RNView key={run.sections[0].kind}>
          <RNView style={styles.sectionLine}>
            {run.sections.map((x) => (
              <TouchableOpacity
                key={x.kind}
                onPress={() => toggle(x.kind)}
                style={styles.sectionHead}
                accessibilityRole="button"
                accessibilityState={{ expanded: run.open }}
                testID={`priorities-section-${x.kind}-${model.row.short_id}`}
              >
                <SectionWords label={x.label} count={x.count} open={run.open} />
              </TouchableOpacity>
            ))}
          </RNView>
          {run.open && run.sections[0].rows.map(line)}
        </RNView>
      ))}
    </RNView>
  );
}

function SectionWords({ label, count, open }: { label: string; count: string; open: boolean }) {
  const Theme = useTheme();
  return (
    <>
      <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.label}>{label.toUpperCase()}</RNText>
      <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={[styles.label, styles.labelCount]}>{count}</RNText>
      <Feather name={open ? 'chevron-down' : 'chevron-right'} size={12} color={Theme.textDim} />
    </>
  );
}

function MilestoneLine({ model, m, now, lookups, own, defaultOpen, priorityPlan }: {
  model: PriorityModel;
  m: MilestoneModel;
  now: number;
  lookups: LinkLookups;
  own: OwnOf;
  defaultOpen: boolean;
  priorityPlan: PriorityPlanRef | null;
}) {
  const Theme = useTheme();
  const { row } = model;
  const { step } = m;
  const [open, setOpen] = useState(defaultOpen);
  const menu = () => showActionSheet(step.title, milestoneMenu(row, step, writes, {
    rename: () => renamePrompt(step.title, 'milestone', (next) => writes.renameStep(row.short_id, step.key, next)),
    drop: () => {
      const s = linkedCount(row, step.key);
      appAlert('Drop milestone?', `${step.title} leaves ${row.title}. Its ${s} linked ${s === 1 ? 'session stays' : 'sessions stay'} on the priority, and the pass never proposes it again. There is no undo.`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Drop', style: 'destructive', onPress: () => writes.dropStep(row.short_id, step.key) },
      ]);
    },
    correct: () => correctPrompt(step.title, (text) => writes.correct(row.short_id, text, step.key)),
  }));

  return (
    <RNView testID={`priorities-milestone-${row.short_id}-${m.key}`}>
      {/* Each control is its own element (a pressable row would fold them into one for VoiceOver): the mark, the title (which opens the line), Looks done?, the ⋯. */}
      <RNView style={[styles.line, open && { backgroundColor: Theme.bgAlt }]}>
        <MilestoneMark row={row} m={m} />
        <TouchableOpacity
          onPress={() => setOpen((o) => !o)}
          activeOpacity={0.6}
          style={styles.lineOpener}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          testID={`priorities-line-${row.short_id}-${m.key}`}
        >
          <RNText
            style={[styles.lineTitle, step.done ? styles.lineDone : m.tier === 'polish' && { color: Theme.textMuted }]}
            numberOfLines={open ? undefined : 2}
          >
            {step.title}
          </RNText>
        </TouchableOpacity>
        {(m.looksDone || m.correctionPending) && (
          <RNView style={styles.marks}>
            {m.looksDone && row.mine && (
              <TouchableOpacity onPress={() => writes.setStepDone(row.short_id, step.key, true)} style={styles.looksDone} accessibilityRole="button" testID={`priorities-looks-done-${m.key}`}>
                <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.looksDoneText}>Looks done?</RNText>
              </TouchableOpacity>
            )}
            {m.correctionPending && <PendingMark />}
          </RNView>
        )}
        {row.mine && <More label={`More for ${step.title}`} onPress={menu} testID={`priorities-milestone-menu-${m.key}`} />}
      </RNView>
      {open && <Connected model={model} m={m} now={now} lookups={lookups} own={own} priorityPlan={priorityPlan} />}
    </RNView>
  );
}

// ── An open milestone ───────────────────────────────────────────────────

/**
 * Everything an open milestone is connected to, grouped by kind under a
 * labelled count: Sessions (sorted the way the sidebar files them, closed
 * ones folded), Tasks, Pull requests, Branches, Plans, Deploys. Each row
 * opens its native screen; the owner fixes a session's link from its ⋯.
 */
function Connected({ model, m, now, lookups, own, priorityPlan }: {
  model: PriorityModel;
  m: MilestoneModel;
  now: number;
  lookups: LinkLookups;
  own: OwnOf;
  priorityPlan: PriorityPlanRef | null;
}) {
  const Theme = useTheme();
  const router = useRouter();
  const { openSession } = usePriorityActs();
  const [closedOpen, setClosedOpen] = useState(false);
  const { row } = model;
  const c = connectedOf(m, priorityPlan);
  const branches = branchesOf(m, lookups);
  const deploys = lookups.deploysOf(m, row.workspace);
  const nSessions = c.live.length + c.closed.length + c.more;
  const empty = nSessions + c.tasks.length + c.prs.length + branches.length + c.plans.length + deploys.length === 0;
  const sessionActions = (s: SessionLine) => showActionSheet(sessionLabel(s), sessionMenu(row, s, m.key, writes, {
    moveTo: () => {
      const targets = sessionTargets(row, own(row), m.key);
      if (targets.length === 0) return appAlert('No other milestone', 'None of your active priorities has another open milestone to move it to.');
      showActionSheet('Move to', targets.map(({ priority, step }: { priority: PriorityRow; step: PriorityStep }) => ({
        label: step.title,
        detail: priority.short_id === row.short_id ? undefined : `${priority.rank != null ? `#${priority.rank} ` : ''}${priority.title}`,
        onPress: () => writes.moveSession(s.short_id, row.short_id, priority.short_id, step.key),
      })));
    },
  }));
  const session = (s: SessionLine) => (
    <SessionRow key={s.conversation_id} s={s} now={now} onPress={() => openSession(s)} menu={row.mine && s.mine ? () => sessionActions(s) : undefined} />
  );
  return (
    <RNView style={styles.connected} testID={`priorities-connected-${m.key}`}>
      <Group label="Sessions" n={nSessions} kind="sessions">
        {c.live.map(session)}
        {c.closed.length > 0 && (
          <TouchableOpacity onPress={() => setClosedOpen((o) => !o)} style={styles.item} accessibilityRole="button" accessibilityState={{ expanded: closedOpen }} testID={`priorities-closed-${m.key}`}>
            <Feather name={closedOpen ? 'chevron-down' : 'chevron-right'} size={12} color={Theme.textDim} />
            <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.meta}>{c.closed.length} closed</RNText>
          </TouchableOpacity>
        )}
        {closedOpen && c.closed.map(session)}
        {c.more > 0 && (
          <RNView style={styles.item}>
            <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.meta}>+{c.more} older {c.more === 1 ? 'session' : 'sessions'}</RNText>
          </RNView>
        )}
      </Group>
      <Group label="Tasks" n={c.tasks.length} kind="tasks">{c.tasks.map((id) => <TaskRow key={id} id={id} />)}</Group>
      <Group label="Pull requests" n={c.prs.length} kind="prs">{c.prs.map((ref) => <PrRow key={ref} pr={ref} state={lookups.prState(ref)} />)}</Group>
      <Group label="Branches" n={branches.length} kind="branches">
        {branches.map((b) => (
          <Item key={b} icon={<Feather name={KIND_ICON.branch} size={13} color={Theme.textDim} />} title={<RNText style={[styles.itemTitle, codeFont, styles.branch]} numberOfLines={1}>{b}</RNText>} />
        ))}
      </Group>
      <Group label="Plans" n={c.plans.length} kind="plans">
        {c.plans.map(({ plan, partOf }) => (
          <Item
            key={plan.short_id}
            icon={<Feather name={KIND_ICON.plan} size={13} color={Theme.textDim} />}
            title={plan.title}
            meta={`${partOf ? 'part of · ' : ''}${plan.done}/${plan.total}`}
            onPress={() => router.push(`/plan/${plan.short_id}` as never)}
          />
        ))}
      </Group>
      <Group label="Deploys" n={deploys.length} kind="deploys">
        {deploys.map((d) => <DeployRow key={d.id} d={d} now={now} />)}
      </Group>
      {empty && <RNText style={[styles.meta, styles.nothing]}>Nothing connected yet</RNText>}
    </RNView>
  );
}

/** A group: its label and count, then its rows; nothing when it has none. */
function Group({ label, n, kind, children }: { label: string; n: number; kind: string; children: ReactNode }) {
  if (!n) return null;
  return (
    <RNView style={styles.group} testID={`priorities-group-${kind}`}>
      <RNView style={styles.groupHead}>
        <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.label}>{label.toUpperCase()}</RNText>
        <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={[styles.label, styles.labelCount]}>{n}</RNText>
      </RNView>
      {children}
    </RNView>
  );
}

/** A connected row, 44pt: its icon, its title (two lines at most) with what it is in a word under it, and the owner's ⋯ beside it. */
function Item({ icon, title, meta, onPress, menu, testID }: { icon: ReactNode; title: ReactNode; meta?: ReactNode; onPress?: () => void; menu?: ReactNode; testID?: string }) {
  const body = (
    <>
      <RNView style={styles.itemIcon}>{icon}</RNView>
      {/* A phone gives the title the row's width: its state and age go under it. */}
      <RNView style={styles.itemText}>
        {typeof title === 'string' ? <RNText style={styles.itemTitle} numberOfLines={2}>{title}</RNText> : title}
        {meta != null && <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.meta} numberOfLines={1}>{meta}</RNText>}
      </RNView>
    </>
  );
  return (
    <RNView style={styles.itemRow} testID={testID}>
      {onPress ? <TouchableOpacity style={styles.item} onPress={onPress} activeOpacity={0.6} accessibilityRole="link">{body}</TouchableOpacity> : <RNView style={styles.item}>{body}</RNView>}
      {menu}
    </RNView>
  );
}


function SessionRow({ s, now, onPress, menu }: { s: SessionLine; now: number; onPress: () => void; menu?: () => void }) {
  const Theme = useTheme();
  // A workflow step's title names its task or plan by id: read the store's title for it.
  const ref = workflowRef(s.title);
  const refTitle = useInboxStore((st) => (ref ? (lookup(ref.startsWith('pl-') ? (st as any).plans : st.tasks, ref)?.title as string | undefined) ?? '' : ''));
  const mark = sessionRowMark(s);
  const asks = mark === 'needs_you';
  const icon = s.workflow && !asks ? <Feather name={KIND_ICON.workflow} size={13} color={Theme.textDim} accessibilityLabel="Workflow run" /> : <SessionStatusMark status={mark} size={12} />;
  return (
    <Item
      testID={`priorities-session-${s.short_id}`}
      icon={icon}
      title={sessionLabel(s, () => refTitle || undefined)}
      meta={<><RNText style={asks ? { color: Theme.yellow, fontWeight: '600' } : undefined}>{SESSION_STATUS[mark].word}</RNText> · {age(s.last_active_at, now)}</>}
      onPress={onPress}
      menu={menu ? <More label={`Fix the link to ${sessionLabel(s)}`} onPress={menu} testID={`priorities-session-menu-${s.short_id}`} /> : undefined}
    />
  );
}

/** A task in the app's task-status icons (components/TaskItem); dropped is struck through. */
function TaskRow({ id }: { id: string }) {
  const Theme = useTheme();
  const router = useRouter();
  const t = useInboxStore((st) => {
    const row = lookup(st.tasks, id);
    return row ? `${row.status ?? 'open'}\u0000${row.title ?? ''}` : '';
  });
  const [status, title] = t ? t.split('\u0000') : ['open', ''];
  const look = STATUS_CONFIG[status as keyof typeof STATUS_CONFIG] ?? STATUS_CONFIG.open;
  const closed = status === 'done' || status === 'dropped';
  return (
    <Item
      testID={`priorities-task-${id}`}
      icon={<FontAwesome name={look.icon} size={13} color={look.color} accessibilityLabel={look.label} />}
      title={<RNText style={[styles.itemTitle, closed && { color: Theme.textDim }, status === 'dropped' && styles.struck]} numberOfLines={2}>{title || id}</RNText>}
      onPress={() => router.push(`/task/${id}` as never)}
    />
  );
}

/** A pull request's glyph and colour by state, here and in the legend. */
export const PR_LOOK = { open: { icon: 'git-pull-request', color: 'green' }, merged: { icon: 'git-merge', color: 'violet' }, closed: { icon: 'x-circle', color: 'red' } } as const;

/** A pull request: its number, its repository and state; it opens the phone's PR screen. */
function PrRow({ pr, state }: { pr: string; state?: string }) {
  const Theme = useTheme();
  const router = useRouter();
  const [repo, n] = pr.split('#');
  const st = state === 'merged' || state === 'closed' ? state : 'open';
  const route = mobileEntityRoute('pr', pr);
  return (
    <Item
      testID={`priorities-pr-${pr}`}
      icon={<Feather name={PR_LOOK[st].icon} size={13} color={Theme[PR_LOOK[st].color]} />}
      title={`#${n}`}
      meta={`${repo.split('/')[1] ?? repo} · ${st}`}
      onPress={route ? () => router.push(route as never) : undefined}
    />
  );
}

/** A deploy that shipped the milestone's work; it opens the phone's deploy screen. */
function DeployRow({ d, now }: { d: ReturnType<LinkLookups['deploysOf']>[number]; now: number }) {
  const Theme = useTheme();
  const router = useRouter();
  const color = d.status === 'live' ? Theme.green : d.status === 'failed' ? Theme.red : Theme.textDim;
  return (
    <Item
      icon={<Feather name={KIND_ICON.deploy} size={13} color={color} />}
      title={d.target}
      meta={`${d.status} · ${age(d.at, now)}`}
      onPress={() => router.push(`/deploy/${d.short_id}` as never)}
    />
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  listStrip: { flexDirection: 'row', alignItems: 'flex-end', gap: 2 },
  listDay: { width: 6, justifyContent: 'flex-end' },
  pageStrip: { flexDirection: 'row', alignItems: 'flex-end', gap: 4 },
  pageDay: { flex: 1, alignItems: 'center', gap: 4 },
  pageBarBox: { alignSelf: 'stretch', justifyContent: 'flex-end' },
  bar: { borderRadius: 2, alignSelf: 'stretch' },
  // Wider than its column, centred on it, so "Today" stays on one line.
  dayText: { width: 44, textAlign: 'center', fontSize: 10, color: Theme.textDim, fontVariant: ['tabular-nums'] },

  more: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  pending: { fontSize: 11.5, color: Theme.textDim },
  label: { fontSize: 11, fontWeight: '600', color: Theme.textDim, letterSpacing: 0.5, fontVariant: ['tabular-nums'] },
  labelCount: { fontWeight: '400' },

  sectionLine: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 20, paddingLeft: 44 },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 44 },

  line: { flexDirection: 'row', alignItems: 'center', minHeight: 48, borderRadius: 8 },
  lineOpener: { flex: 1, minWidth: 0, minHeight: 44, justifyContent: 'center', paddingVertical: 4 },
  lineTitle: { fontSize: 14, color: Theme.text, lineHeight: 19 },
  lineDone: { color: Theme.textDim },
  marks: { flexDirection: 'column', alignItems: 'flex-end' },
  looksDone: { minHeight: 44, minWidth: 44, justifyContent: 'center' },
  looksDoneText: { fontSize: 11.5, color: Theme.textMuted, borderWidth: 1, borderColor: Theme.borderLight, borderRadius: 10, paddingHorizontal: 6, paddingVertical: 1, overflow: 'hidden' },

  connected: { marginLeft: 21, marginBottom: 8, paddingLeft: 14, borderLeftWidth: 1, borderLeftColor: Theme.borderLight },
  group: { paddingTop: 6 },
  groupHead: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 24 },
  itemRow: { flexDirection: 'row', alignItems: 'center' },
  item: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingVertical: 3 },
  itemIcon: { width: 16, alignItems: 'center' },
  itemText: { flex: 1, minWidth: 0, gap: 1 },
  itemTitle: { fontSize: 13.5, color: Theme.text, lineHeight: 18 },
  branch: { fontSize: 12.5 },
  struck: { textDecorationLine: 'line-through' },
  meta: { fontSize: 12, color: Theme.textMuted, fontVariant: ['tabular-nums'] },
  nothing: { paddingVertical: 10 },
}));
