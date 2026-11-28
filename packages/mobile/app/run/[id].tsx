// One workflow run on the phone, the twin of the web's run report
// (/workflows/runs/<id>): what the run did in one line in its tone, the gate it
// waits on (answered right here, or on its decision's screen), its path step by
// step with each step opening the session or decision behind it, what landed
// (the merge, its pull request, the change's size), the verbs the web gives a
// run (stop, resume, rebase and land), and the other runs on the same task.
//
// Store-fed like the web page: useWorkflowRun feeds and reads the run,
// useWorkflow its graph, useSyncDecisionDetail its card, useTaskRuns the
// task's other runs. Every verb is a store action, so the run repaints on the press.
import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { flowName } from '@codecast/shared/contracts/flowPool';
import { costParts, costUsd, isLineRun } from '@codecast/shared/contracts/changeCard';
import { publicUrl } from '@codecast/shared/entities';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { useCoarseNow } from '@codecast/web/hooks/useCoarseNow';
import { useRunWorkflow, useWorkflowRun } from '@codecast/web/hooks/useSyncWorkflows';
import { useTaskRuns } from '@codecast/web/hooks/useSyncRuns';
import { useDecisionDetail, useSyncDecisionDetail } from '@codecast/web/hooks/useSyncDecisionDetail';
import { useJourneyViewer } from '@codecast/web/hooks/useJourneyViewer';
import { answererNameOf } from '@codecast/web/lib/decisionLinks';
import { formatRunDuration, runNodeCounts, runNodeRows, wfFmtTokens } from '@codecast/web/lib/workflowRun';
import {
  LANDING_STATIONS, behindBase, cardName, choiceWords, runOutcome, runPath, shortDay,
  type OutcomeTone, type ReportPhase, type ReportRun, type ReportStep, type ReportTask, type StepState,
} from '@codecast/web/lib/line/runReport';
import { landingOf } from '@codecast/web/lib/line/personalReport';
import { resumeOf } from '@codecast/web/lib/ship/resumeAt';
import type { TargetState } from '@codecast/web/lib/ship/journey';
import { changeAction, changeHeadline, changeJourney, changeLinks, changePr, mergeHolder, mergeIsOff, newerMergedRun, shipsChange, type ChangeAction, type ChangeLink } from '@codecast/web/lib/ship/changePage';
import { roleRowsOf } from '@codecast/web/lib/roleRows';
import { usePullRequestMerge } from '@codecast/web/hooks/useSyncTimeline';
import { onPrHead } from '@codecast/shared/contracts/deployTargets';
import { useShipAgain } from '@codecast/web/hooks/useShipAgain';
import { judgedFileWords } from '@codecast/web/lib/ship/judgedEdits';
import { approvalOf, shipConfirms } from '@codecast/web/lib/ship/approval';
import { landedSha } from '@codecast/web/lib/ship/runRecord';
import { reachTargets } from '@codecast/web/lib/ship/sessionShip';
import { useDeployReachRead } from '@codecast/web/hooks/useDeployReach';
import { useRunFlow } from '@codecast/web/hooks/useFlowObject';
import type { JourneyTone } from '@codecast/web/lib/ship/journeyWords';
import { ResumeAtAction } from '@/components/session/ResumeAtAction';
import { compactAge } from '@codecast/web/lib/threadState';
import { Text as RNText, TextInput } from '@/components/Themed';
import { optionIsShip } from '@codecast/shared/contracts/shipAnswer';
import { Spacing, themedStyles, useTheme, type Palette } from '@/constants/Theme';
import { codeFont } from '@/constants/fonts';
import { copyToClipboard } from '@/lib/clipboard';
import { appAlert } from '@/lib/popups';
import { mobileRouteForUrl } from '@/lib/linkRoutes';
import { openAppRoute, openLink } from '@/lib/links';
import { ActionButton, FactChip, FactRow, Facts, LinkRow, MoreToggle, ObjectHeader, ObjectMissing, SectionLabel, objectStyles } from '@/components/objects/ObjectParts';

type IconName = React.ComponentProps<typeof FontAwesome>['name'];

type Run = ReportRun & {
  workflow_id?: string;
  workflow_slug?: string;
  workflow_label?: string;
  primary_session_id?: string;
  primary_conversation_id?: string;
  spawner_conversation_id?: string;
  org_role_id?: string;
  goal_override?: string;
  gate_prompt?: string;
  gate_decision_id?: string;
  task_title?: string;
  merge?: { sha: string; branch: string; into: string; at: number; pr_url?: string };
};

const OTHER_RUNS_SHOWN = 5;
const short = (sha: string) => sha.slice(0, 7);
const PR_URL = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

function outcomeColor(tone: OutcomeTone, t: Palette): string {
  switch (tone) {
    case 'shipped': return t.green;
    case 'live': return t.cyan;
    case 'waiting': return t.yellow;
    case 'stuck': return t.orange;
    case 'failed': return t.red;
    case 'closed': return t.textMuted;
    default: return t.text;
  }
}

function statusVisual(status: string, t: Palette): { icon: IconName; label: string; color: string } {
  switch (status) {
    case 'running': return { icon: 'circle-o-notch', label: 'Running', color: t.cyan };
    case 'paused': return { icon: 'pause-circle', label: 'Waiting for approval', color: t.yellow };
    case 'completed': return { icon: 'check-circle', label: 'Done', color: t.green };
    case 'failed': return { icon: 'times-circle', label: 'Stopped', color: t.red };
    default: return { icon: 'clock-o', label: 'Queued', color: t.textMuted };
  }
}

const STEP_MARK: Record<StepState, { icon: IconName; tone: keyof Palette }> = {
  done: { icon: 'check', tone: 'green' },
  failed: { icon: 'times', tone: 'red' },
  live: { icon: 'circle-o-notch', tone: 'cyan' },
  waiting: { icon: 'pause', tone: 'yellow' },
  noted: { icon: 'hand-paper-o', tone: 'textDim' },
  nothing: { icon: 'minus', tone: 'textMuted' },
  unknown: { icon: 'question', tone: 'textMuted' },
};

/** A change run's head and link tones (lib/ship/changePage.ts), as the web's run page colors them. */
function toneColor(tone: JourneyTone | ChangeLink['tone'], t: Palette): string {
  switch (tone) {
    case 'ok': return t.green;
    case 'bad': return t.red;
    case 'wait': return t.yellow;
    case 'you': case 'working': return t.blue;
    case 'agent': return t.orange;
    case 'session': return t.violet;
    default: return t.textMuted;
  }
}

const ACT_ICON: Record<ChangeAction['kind'], IconName> = { newer: 'arrow-right', merge_switch: 'toggle-on', deploys: 'cloud-upload', session: 'comments-o', agent: 'comments-o', again: 'rocket', card: 'question-circle' };

const answerColor = (answer: string | null, t: Palette) =>
  optionIsShip(answer) ? t.green : /^drop\b/i.test(answer ?? '') ? t.red : /^revise\b/i.test(answer ?? '') ? t.yellow : t.textMuted;

export default function RunScreen() {
  const Theme = useTheme();
  const router = useRouter();
  const { id: rawId } = useLocalSearchParams<{ id: string }>();
  const runId = (rawId ?? '').trim();
  const now = useCoarseNow(30_000);
  const go = (route: string) => router.push(route as never);
  const goHref = (href: string) => { const r = mobileRouteForUrl(href); if (r) openAppRoute(router, r); };

  const run = useWorkflowRun(runId || null) as Run | null | undefined;
  const workflow = useRunWorkflow(run) as { nodes?: Array<{ id: string; label?: string; type?: string }>; label?: string; name?: string; slug?: string } | null | undefined;
  const task = useInboxStore((s) => (run?.task_id ? (s.tasks as Record<string, any>)[run.task_id] : undefined)) as (ReportTask & { title?: string }) | undefined;
  const decisionRef = run?.gate_decision_short_id ?? run?.gate_decision_id;
  useSyncDecisionDetail(decisionRef);
  const detail = useDecisionDetail(decisionRef);
  const meId = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  const hostTitle = useInboxStore((s) => {
    const cid = run?.primary_conversation_id;
    return cid ? ((s.conversations as Record<string, { title?: string }>)[cid]?.title ?? (s.sessions as Record<string, { title?: string }>)[cid]?.title ?? null) : null;
  });

  // Every other run on the same task, newest first.
  const taskRuns = useTaskRuns<Run>(run?.task_id);
  const others = useMemo(() => taskRuns.filter((r) => r._id !== run?._id), [taskRuns, run?._id]);
  const [allOthers, setAllOthers] = useState(false);

  const answeredBy = detail?.decision?.status === 'answered' ? answererNameOf(detail, meId) : null;
  const phases = useMemo(() => (run ? runPath(run, workflow, task, { answeredBy }) : []), [run, workflow, task, answeredBy]);

  const [gateText, setGateText] = useState('');
  const respondToGate = useInboxStore((s) => s.respondToGate);
  // The session the run waits on asks a person: its card, answered on the decision's own screen.
  const viewer = useJourneyViewer(run as any);
  const ask = viewer.ask ?? null;
  // A change run (a whole flow that lands a session's change): its head says where the change stands, with its PR, CI,
  // review, merge and deploys as links and a stop's one way on, as the web's run page says it (ChangeRunHead).
  const { flow: runFlow } = useRunFlow(run as any);
  const changeFlow = runFlow && shipsChange(runFlow) ? runFlow : null;
  const changePrRef = run && changeFlow ? changePr(run as any) : null;
  const prMerge = usePullRequestMerge(changePrRef) ?? null;
  // Its verdicts judged on the head GitHub has the PR on, as the PR's header judges them.
  const changeRun = useMemo(() => (run ? onPrHead(run as any, prMerge?.head_sha) : run), [run, prMerge?.head_sha]);
  const mergedSha = changeRun && changeFlow ? landedSha(changeRun as any) ?? (prMerge?.merged ? prMerge.merge_sha : null) : null;
  const { reach, ready: reachRead } = useDeployReachRead(mergedSha && changePrRef ? `${changePrRef.repository}@${mergedSha}` : null);
  const targets = useMemo<TargetState[]>(() => reachTargets(reach), [reach]);
  // A later run on the task that merged this run's pull request: the change went on there.
  const newerMerged = useMemo(() => (run ? newerMergedRun(run as any, others as any) : null), [run, others]);
  const journey = useMemo(() => (changeRun && changeFlow ? changeJourney(changeFlow, changeRun as any, targets, viewer, { pr: prMerge, reading: !reachRead, newerMerged }) : null), [changeRun, changeFlow, targets, viewer, prMerge, reachRead, newerMerged]);
  const head = journey && changeRun && changeFlow ? changeHeadline(journey, changeRun as any, changeFlow, { pr: prMerge, targets, reading: !reachRead, newerMerged }) : null;
  const links = journey && changeRun && changeFlow ? changeLinks(changeRun as any, changeFlow, targets, prMerge) : [];
  const newer = run ? [...others].filter((r) => r.created_at > run.created_at).sort((a, b) => b.created_at - a.created_at)[0]?._id ?? null : null;
  // The role whose line started the run holds its merge switch: its page, read only when merge was off.
  const holder = run ? mergeHolder(run as any) : null;
  const mergeRole = useInboxStore((s) => (run && (holder || (run.org_role_id && mergeIsOff(run as any))) ? roleRowsOf(s as any).roles.find((r) => (holder ? r.handle?.replace(/^@/, '') === holder : r._id === run.org_role_id))?.short_id ?? null : null));
  const act = journey && changeRun && changeFlow ? changeAction(journey, changeRun as any, changeFlow, { newer, pr: prMerge, mergeRole, targets }) : null;
  // Ship again through the web's own press path (hooks/useShipAgain): one press in flight, and the confirm's judged files
  // recorded as the person's approval.
  const [confirmingAgain, setConfirmingAgain] = useState(false);
  const again = useShipAgain(changeFlow, run?.spawner_conversation_id ?? null, confirmingAgain);

  // The run row paints alone; its graph (step labels) fills in when the workflow arrives.
  if (!run) return <ObjectMissing what="Run" loading={run === undefined} />;

  const line = isLineRun(run as any);
  const live = run.status === 'running' || run.status === 'paused' || run.status === 'pending';
  const ended = run.status === 'completed' || run.status === 'failed';
  const outcome = runOutcome(run, task, now, false, { graph: workflow as any, ask });
  // A personal Ship lands, maybe twice: its latest landing, as its journey shows it.
  const landing = landingOf(run, workflow as any);
  // A stop that says to resume the run (a personal Ship's Landing unknown, a change run's CI never reported) offers that
  // press, as its card and the web's run page do. Its words are the run's flow's (a stored row keeps no `stop`).
  const resumeAt = resumeOf(run, (runFlow as any)?.nodes ?? (workflow as any)?.nodes, (runFlow as any)?.slug);
  // The session the run waits on asks a person: whom it waits on and what, as the run's card says it.
  const asking = live && run.waiting_on_session?.blocked && ask?.open !== false
    ? { head: ask?.mine ? 'Waiting on you' : 'Waiting for a person', body: [ask?.question, run.waiting_on_session.note].filter(Boolean).join('\n') }
    : null;
  const st = statusVisual(run.status, Theme);
  const flow = flowName({ label: workflow?.label ?? run.workflow_label, name: workflow?.name ?? run.workflow_name });
  const title = run.task_title ?? task?.title ?? flow;
  const taskRef = task?.short_id ?? run.task_short_id;
  const flowSlug = workflow?.slug ?? run.workflow_slug;
  const hostId = run.primary_conversation_id ?? run.primary_session_id;

  const decision = detail?.decision;
  const card = decision?.card ?? null;
  const answer = run.gate_answer ? choiceWords(run.gate_answer) : null;
  const waitingOnCard = run.status === 'paused' && !!run.gate_decision_id;
  const cardChip = run.gate_decision_short_id ? cardName(answer, card, run.status === 'paused') : null;
  const prUrl = run.merge?.pr_url ?? card?.diff.pr ?? null;
  const pr = prUrl ? PR_URL.exec(prUrl) : null;
  const cost = card ? costParts(card.cost) : run.card_billed_usd != null ? { billed_usd: run.card_billed_usd, list_usd: run.card_list_usd ?? 0 } : null;
  const counts = line ? null : runNodeCounts(runNodeRows(run, workflow));
  const duration = card?.cost.minutes != null && !live ? `${card.cost.minutes} agent min` : formatRunDuration(run.created_at, live ? undefined : run.updated_at, now);

  // Approved to ship but its landing step refused a branch behind its base: the line's Rebase step lands it.
  const landingOut = (run.node_statuses ?? []).filter((n) => LANDING_STATIONS.has(n.node_id)).map((n) => n.result_preview).find((t) => behindBase(t));
  const behind = !run.merge && optionIsShip(answer) && run.status === 'failed' ? behindBase(landingOut) : null;

  const stop = () => appAlert('Stop this run?', 'It ends now, and its task reads stopped.', [
    { text: 'Keep running', style: 'cancel' },
    { text: 'Stop', style: 'destructive', onPress: () => { void useInboxStore.getState().stopLineRun(run._id).catch((e: Error) => appAlert('Could not stop', e.message)); } },
  ]);
  const resume = () => { void useInboxStore.getState().resumeLineRun(run._id).catch((e: Error) => appAlert('Could not resume', e.message)); };
  const land = () => appAlert(`Rebase and land on ${behind}?`, `The Rebase step puts the branch on ${behind}, checks it, and ships it.`, [
    { text: 'Not now', style: 'cancel' },
    { text: 'Rebase and land', onPress: () => { void useInboxStore.getState().landLineRun(run._id).catch((e: Error) => appAlert('Could not land', e.message)); } },
  ]);
  const answerGate = (text: string) => { const t = text.trim(); if (!t) return; respondToGate(run._id, t); setGateText(''); };
  // Ship again: the session that made the change sends it through the same flow, as the web's Ship again does; a flow
  // that asks before it lands (shipConfirms) is confirmed first, with the judged files the press approves.
  const shipAgain = () => {
    if (again.sent || !changeFlow) return;
    if (shipConfirms(approvalOf(changeFlow))) setConfirmingAgain(true);
    else again.send();
  };

  const othersShown = allOthers ? others : others.slice(0, OTHER_RUNS_SHOWN);

  return (
    <>
      <ObjectHeader
        type={null}
        title="Run"
        link={publicUrl(`/workflows/runs/${run._id}`)}
        menu={[
          ...(live && run.status !== 'pending' ? [{ label: 'Resume on its machine', onPress: resume }] : []),
          { label: 'Copy run id', onPress: () => { void copyToClipboard(run._id); } },
        ]}
      />
      <ScrollView style={objectStyles.container} contentContainerStyle={objectStyles.content} testID="run-screen">
        <TouchableOpacity disabled={!flowSlug} onPress={() => go(`/flow/${flowSlug}`)} activeOpacity={0.6} testID="run-flow">
          <RNText style={[styles.flow, flowSlug ? { color: Theme.blue } : null]} numberOfLines={1}>{flow}</RNText>
        </TouchableOpacity>
        <RNText style={objectStyles.title}>{title}</RNText>
        <RNView style={objectStyles.chips}>
          {/* A change run says its state in its head below, as the web's run page does. */}
          {head ? null : <FactChip icon={st.icon} label={st.label} color={st.color} testID={`run-status-${run.status}`} />}
          {taskRef ? <FactChip icon="circle-o" label={taskRef} color={Theme.violet} onPress={() => go(`/task/${taskRef}`)} link testID="run-task" /> : null}
          {cardChip && !(head && waitingOnCard) ? <FactChip icon="question-circle" label={cardChip} color={waitingOnCard ? Theme.yellow : answerColor(answer, Theme)} onPress={() => go(`/decisions/${run.gate_decision_short_id}`)} link testID="run-card" /> : null}
        </RNView>

        {head ? (
          <RNView style={styles.changeHead} testID="run-change-head">
            <RNView style={styles.changeWordsRow}>
              <RNView style={[styles.changeDot, { backgroundColor: toneColor(head.tone, Theme) }]} />
              <RNText style={styles.changeWords} testID="run-change-words">{head.words}</RNText>
            </RNView>
            {head.waits ? <RNText style={styles.changeWaits} numberOfLines={3} testID="run-change-waits">{head.waits}</RNText> : null}
            {/* A stop whose words name its one restart (a worktree something moved) shows them whole, as the web's bar does. */}
            {journey && (journey.now.kind === 'stopped' || journey.now.kind === 'failed') && journey.now.whole && journey.now.why ? <RNText style={styles.changeWaits} testID="run-change-why">{journey.now.why}</RNText> : null}
            {links.length ? (
              <RNView style={objectStyles.chips}>
                {links.map((l) => <FactChip key={`${l.kind}:${l.label}`} label={l.label} color={toneColor(l.tone, Theme)} onPress={() => void openLink(l.href)} link testID={`run-change-${l.kind}`} />)}
              </RNView>
            ) : null}
          </RNView>
        ) : <RNText style={[styles.outcome, { color: outcomeColor(outcome.tone, Theme) }]} testID="run-outcome">{outcome.text}</RNText>}
        {/* A change run's one action, as the web's run page offers it (changePage changeAction); a card the verbs below
            already open or answer is not offered twice. */}
        {act && !(act.kind === 'card' && (waitingOnCard || ask?.open)) ? (
          <RNView style={objectStyles.verbs}>
            <ActionButton icon={ACT_ICON[act.kind]} label={act.kind === 'again' && again.sent ? 'Starting…' : act.label} color={Theme.blue} filled disabled={act.kind === 'again' && again.sent} onPress={act.kind === 'again' ? shipAgain : () => act.href && void openLink(act.href)} testID={`run-change-act-${act.kind}`} />
          </RNView>
        ) : null}
        {act?.kind === 'again' && confirmingAgain && changeFlow ? (
          <RNView style={[styles.gate, { borderColor: Theme.blue + '55', backgroundColor: Theme.blue + '10' }]} testID="run-ship-again-confirm">
            <RNText style={[styles.gatePrompt, { fontWeight: '600' }]}>{`Ship again through ${changeFlow.label}`}</RNText>
            {(again.files ?? []).map((f) => <RNText key={f.path} style={styles.gatePrompt}>{judgedFileWords(f)}</RNText>)}
            <RNView style={styles.gateChoices}>
              <ActionButton icon="rocket" label="Ship again" color={Theme.blue} filled onPress={() => { setConfirmingAgain(false); again.send(); }} testID="run-ship-again-confirm-send" />
              <ActionButton icon="times" label="Not now" color={Theme.textMuted} onPress={() => setConfirmingAgain(false)} testID="run-ship-again-confirm-cancel" />
            </RNView>
          </RNView>
        ) : null}
        {asking && !head ? (
          <RNView style={[styles.gate, { borderColor: Theme.yellow + '55', backgroundColor: Theme.yellow + '10' }]} testID="run-session-asks">
            <RNText style={[styles.gatePrompt, { fontWeight: '600' }]}>{asking.head}</RNText>
            {asking.body ? <RNText style={styles.gatePrompt}>{asking.body}</RNText> : null}
          </RNView>
        ) : null}


        {run.status === 'paused' && run.gate_prompt && !run.gate_decision_id ? (
          <RNView style={[styles.gate, { borderColor: Theme.magenta + '55', backgroundColor: Theme.magenta + '10' }]} testID="run-gate">
            <RNText style={styles.gatePrompt}>{run.gate_prompt}</RNText>
            {run.gate_choices?.length ? (
              <RNView style={styles.gateChoices}>
                {run.gate_choices.map((c) => (
                  <ActionButton key={c.key} icon="angle-right" label={c.label.replace(/^\[.\]\s*/, '')} color={Theme.magenta} onPress={() => answerGate(c.key)} testID={`run-gate-${c.key}`} />
                ))}
              </RNView>
            ) : null}
            <RNView style={styles.gateReply}>
              <TextInput
                value={gateText}
                onChangeText={setGateText}
                placeholder="Reply"
                placeholderTextColor={Theme.textDim}
                multiline
                style={[styles.gateInput, { borderColor: Theme.border, color: Theme.text }]}
                testID="run-gate-input"
              />
              <TouchableOpacity disabled={!gateText.trim()} onPress={() => answerGate(gateText)} style={[styles.send, { opacity: gateText.trim() ? 1 : 0.4, backgroundColor: Theme.magenta }]} testID="run-gate-send">
                <FontAwesome name="arrow-up" size={14} color={Theme.bg} />
              </TouchableOpacity>
            </RNView>
          </RNView>
        ) : null}

        {live || behind ? (
          <RNView style={objectStyles.verbs}>
            {waitingOnCard ? <ActionButton icon="question-circle" label="Answer it" color={Theme.yellow} filled onPress={() => go(`/decisions/${run.gate_decision_short_id ?? run.gate_decision_id}`)} testID="run-answer" /> : null}
            {ask?.open ? <ActionButton icon="question-circle" label={ask.mine ? 'Answer it' : 'Open card'} color={Theme.yellow} filled={ask.mine} onPress={() => go(`/decisions/${ask.id}`)} testID="run-session-ask" /> : null}
            {behind ? <ActionButton icon="code-fork" label={`Rebase and land on ${behind}`} color={Theme.green} filled onPress={land} testID="run-land" /> : null}
            {live ? <ActionButton icon="stop" label="Stop the run" color={Theme.red} onPress={stop} testID="run-stop" /> : null}
          </RNView>
        ) : null}
        {resumeAt ? <ResumeAtAction runId={run._id} resume={resumeAt} /> : null}

        <Facts>
          {hostId ? <FactRow label="Ran in" icon="comments-o" tone={Theme.blue} onPress={() => go(`/session/${hostId}`)} testID="run-session">{hostTitle ?? 'Its session'}</FactRow> : null}
          <FactRow label="Started">
            <RNText style={styles.factValue}>
              {shortDay(run.created_at)}
              <RNText style={styles.factDim}>{`  ${compactAge(Math.max(0, now - run.created_at))}${compactAge(Math.max(0, now - run.created_at)) === 'just now' ? '' : ' ago'}`}</RNText>
            </RNText>
          </FactRow>
          <FactRow label={live ? 'Running for' : 'Took'}>{duration}</FactRow>
          {counts && counts.sessions > 0 ? <FactRow label="Sessions">{String(counts.sessions)}</FactRow> : null}
          {!line && run.total_tokens ? <FactRow label="Tokens">{wfFmtTokens(run.total_tokens)}</FactRow> : null}
          {cost && (cost.billed_usd > 0 || cost.list_usd > 0) ? <FactRow label="Cost">{`${costUsd(cost.billed_usd)} billed · ${costUsd(cost.list_usd)} list`}</FactRow> : null}
          {run.goal_override && !run.task_title ? <FactRow label="Goal">{run.goal_override}</FactRow> : null}
        </Facts>

        {/* A change run's head links its PR and merged commit already: here only the card's facts. */}
        {(landing && !head) || card ? (
          <RNView style={objectStyles.section}>
            <SectionLabel>{landing?.word ?? 'Merged'}</SectionLabel>
            <Facts testID="run-landed">
              {landing && !head ? (
                <FactRow label={landing.word} icon="code-fork" tone={Theme.green}>
                  <RNView style={styles.shas}>
                    {pr ? (
                      <TouchableOpacity onPress={() => go(`/commit/${pr[1]}/${pr[2]}/${landing.sha}`)} activeOpacity={0.6} testID="run-merge-sha">
                        <RNText style={styles.shaLink}>{short(landing.sha)}</RNText>
                      </TouchableOpacity>
                    ) : <RNText style={styles.sha}>{short(landing.sha)}</RNText>}
                    {run.merge ? <RNText style={styles.factDim}>{`${run.merge.branch} → ${run.merge.into}`}</RNText> : null}
                  </RNView>
                </FactRow>
              ) : null}
              {card ? <FactRow label="Change">{`+${card.diff.added} −${card.diff.removed} in ${card.diff.files} ${card.diff.files === 1 ? 'file' : 'files'}`}</FactRow> : null}
              {pr && !head ? <FactRow label="Pull request" icon="github" onPress={() => go(`/pr/${pr[1]}/${pr[2]}/${pr[3]}`)} testID="run-pr">{`${pr[2]}#${pr[3]}`}</FactRow> : null}
              {card?.headline ? <FactRow label="Card" onPress={() => go(`/decisions/${run.gate_decision_short_id ?? run.gate_decision_id}`)}>{card.headline}</FactRow> : null}
            </Facts>
          </RNView>
        ) : null}

        <RNView style={objectStyles.section}>
          <SectionLabel>Steps</SectionLabel>
          <PathView phases={phases} ended={ended} onOpen={goHref} />
        </RNView>

        {others.length > 0 ? (
          <RNView style={objectStyles.section}>
            <SectionLabel>{`${others.some((r) => r.created_at > run.created_at) ? 'Other' : 'Earlier'} runs on ${taskRef ?? 'this task'} · ${others.length}`}</SectionLabel>
            <RNView style={objectStyles.list}>
              {othersShown.map((r) => {
                // A run of the same flow reads by the same graph (a personal Ship's says so).
                const o = runOutcome(r, task, now, true, { graph: r.workflow_id && r.workflow_id === run.workflow_id ? (workflow as any) : null });
                return (
                  <TouchableOpacity key={r._id} style={styles.other} onPress={() => go(`/run/${r._id}`)} activeOpacity={0.6} testID={`run-other-${r._id}`}>
                    <RNView style={[styles.dot, { backgroundColor: outcomeColor(o.tone, Theme) }]} />
                    <RNText style={styles.otherText} numberOfLines={1}>{o.text}</RNText>
                    <RNText style={styles.otherAge}>{compactAge(Math.max(0, now - r.created_at))}</RNText>
                    <FontAwesome name="angle-right" size={14} color={Theme.textDim} />
                  </TouchableOpacity>
                );
              })}
            </RNView>
            <MoreToggle hidden={others.length - OTHER_RUNS_SHOWN} open={allOthers} onPress={() => setAllOthers((v) => !v)} />
          </RNView>
        ) : null}

        {hostId && line ? (
          <RNView style={objectStyles.list}>
            <LinkRow icon="comments-o" color={Theme.blue} title={hostTitle ?? 'Primary session'} onPress={() => go(`/session/${hostId}`)} />
          </RNView>
        ) : null}
      </ScrollView>
    </>
  );
}

/** The run's path, phase by phase (web RunPathView): each step's result, opening the session or decision behind it;
 *  steps not reached and routine passes fold under their phase. */
function PathView({ phases, ended, onOpen }: { phases: ReportPhase[]; ended: boolean; onOpen: (href: string) => void }) {
  const bare = phases.length === 1 && phases[0].key === 'steps';
  return (
    <RNView style={objectStyles.list} testID="run-path">
      {phases.map((p, i) => <PhaseRow key={p.key} phase={p} ended={ended} bare={bare} first={i === 0} onOpen={onOpen} />)}
    </RNView>
  );
}

function PhaseRow({ phase, ended, bare, first, onOpen }: { phase: ReportPhase; ended: boolean; bare: boolean; first: boolean; onOpen: (href: string) => void }) {
  const Theme = useTheme();
  const [open, setOpen] = useState(false);
  const skipped = phase.steps.length === 0;
  const notReached = ended ? 'skipped' : 'not reached yet';
  const tone = skipped ? Theme.textDim : phase.state === 'failed' ? Theme.red : phase.state === 'waiting' ? Theme.yellow : phase.state === 'live' ? Theme.cyan : Theme.textMuted;
  const foldWords = [
    phase.routine.length ? `${phase.routine.length} routine ${phase.routine.length === 1 ? 'step' : 'steps'}` : '',
    phase.folded.length ? `${phase.folded.length} ${notReached}${open ? `: ${phase.folded.map((f) => f.label).join(', ')}` : ''}` : '',
  ].filter(Boolean).join(' · ');
  return (
    <RNView style={[styles.phase, !first && styles.rule]} testID={`run-phase-${phase.key}`}>
      {!bare ? (
        <RNView style={styles.phaseHead}>
          <RNText style={[styles.phaseLabel, { color: tone }]}>{phase.label}</RNText>
          {skipped ? <RNText style={styles.phaseDim}>{notReached}</RNText> : null}
        </RNView>
      ) : null}
      {phase.steps.map((s, i) => <StepRow key={`${s.id}-${i}`} step={s} onOpen={onOpen} />)}
      {open ? phase.routine.map((s, i) => <StepRow key={`r-${s.id}-${i}`} step={s} onOpen={onOpen} dim />) : null}
      {!skipped && foldWords ? (
        <TouchableOpacity onPress={() => setOpen((o) => !o)} style={styles.fold} activeOpacity={0.6}>
          <FontAwesome name={open ? 'angle-down' : 'angle-right'} size={12} color={Theme.textDim} />
          <RNText style={styles.phaseDim}>{foldWords}</RNText>
        </TouchableOpacity>
      ) : null}
    </RNView>
  );
}

function StepRow({ step: s, onOpen, dim }: { step: ReportStep; onOpen: (href: string) => void; dim?: boolean }) {
  const Theme = useTheme();
  const mark = STEP_MARK[s.state];
  const color = Theme[mark.tone] as string;
  const route = s.href ? mobileRouteForUrl(s.href) : null;
  const resultColor = s.state === 'failed' ? Theme.red : s.state === 'waiting' ? Theme.yellow : s.state === 'noted' ? Theme.textMuted : Theme.text;
  const body = (
    <>
      <FontAwesome name={mark.icon} size={11} color={color} style={styles.stepIcon} />
      <RNView style={{ flex: 1, minWidth: 0 }}>
        <RNText style={styles.stepLabel} numberOfLines={1}>{s.visits ? `${s.label} · ${s.visits} visits` : s.label}</RNText>
        <RNText style={[styles.stepResult, { color: resultColor }]} numberOfLines={3}>{s.result}</RNText>
        {s.note ? <RNText style={styles.stepNote} numberOfLines={2}>{s.note}</RNText> : null}
      </RNView>
      {route ? <FontAwesome name="angle-right" size={14} color={Theme.textDim} /> : null}
    </>
  );
  return route ? (
    <TouchableOpacity style={[styles.step, dim && { opacity: 0.7 }]} onPress={() => onOpen(s.href!)} activeOpacity={0.6} testID={`run-step-${s.id}`}>{body}</TouchableOpacity>
  ) : (
    <RNView style={[styles.step, dim && { opacity: 0.7 }]} testID={`run-step-${s.id}`}>{body}</RNView>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  flow: { ...codeFont, fontSize: 12, color: Theme.textMuted, marginBottom: 6 },
  outcome: { fontSize: 16, lineHeight: 22, fontWeight: '600', marginBottom: Spacing.lg },
  changeHead: { marginBottom: Spacing.lg, gap: 6 },
  changeWordsRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  changeDot: { width: 9, height: 9, borderRadius: 5 },
  changeWords: { flex: 1, fontSize: 18, lineHeight: 24, fontWeight: '600', color: Theme.text },
  changeWaits: { marginLeft: 17, fontSize: 14, lineHeight: 20, color: Theme.textMuted },
  gate: { borderWidth: 1, borderRadius: 10, padding: Spacing.md, marginBottom: Spacing.lg, gap: Spacing.sm },
  gatePrompt: { fontSize: 14, lineHeight: 20, color: Theme.text },
  gateChoices: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  gateReply: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  gateInput: { flex: 1, minHeight: 40, maxHeight: 120, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14 },
  send: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  factValue: { fontSize: 14, color: Theme.text },
  factDim: { fontSize: 12.5, color: Theme.textMuted },
  shas: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', columnGap: 8, rowGap: 2 },
  sha: { ...codeFont, fontSize: 13.5, color: Theme.text },
  shaLink: { ...codeFont, fontSize: 13.5, color: Theme.blue },
  phase: { paddingVertical: 6 },
  rule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Theme.bgHighlight },
  phaseHead: { flexDirection: 'row', alignItems: 'baseline', gap: 8, paddingHorizontal: Spacing.md, paddingTop: 6, paddingBottom: 2 },
  phaseLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase' },
  phaseDim: { fontSize: 12, color: Theme.textDim },
  fold: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: Spacing.md, paddingVertical: 6, paddingLeft: Spacing.md + 26 },
  step: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingHorizontal: Spacing.md, paddingVertical: 7 },
  stepIcon: { width: 16, textAlign: 'center', marginTop: 3 },
  stepLabel: { fontSize: 11.5, color: Theme.textMuted0 },
  stepResult: { fontSize: 13.5, lineHeight: 19, marginTop: 1 },
  stepNote: { fontSize: 12, lineHeight: 17, color: Theme.textMuted, marginTop: 2 },
  other: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: Spacing.md, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Theme.bgHighlight },
  dot: { width: 8, height: 8, borderRadius: 4 },
  otherText: { flex: 1, fontSize: 13.5, color: Theme.text },
  otherAge: { fontSize: 12, color: Theme.textMuted0, fontVariant: ['tabular-nums'] },
}));
