// One group, centered on one event: the header with its state (regressed is
// its own, with the release it came back in), the occurrence chart with its
// deploys and transitions, then the selected sample driving the main column
// (its stack as frames, its tags, its replay at the moment it happened) with
// [ and ] stepping between samples. The sidebar leads with the fix chain:
// the problem task, the session working it, what shipped. Then the tag
// breakdown over kept samples, the release and commit, triggers, replays
// and the activity. Keys: j/k next issue, e resolve, i ignore, a assign,
// z undo, f fix, Esc back.
import { Fragment, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Copy, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { detailGone, groupSha, useOpsEvents, useOpsGroup, useOpsGroups, useOpsReplay, useOpsReplays, useOpsSamples, useOpsSources, useOpsWatches, useShaCommit, useSyncOpsEvents, useSyncOpsGroup, useSyncOpsGroupTransitions, useSyncOpsReplay, useSyncShaCommit } from "../../hooks/useSyncOps";
import { useTriggers } from "../../hooks/useSyncTriggers";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { hasOpenModal, isEditableTarget } from "../../shortcuts";
import { commitPath, filePath } from "../../lib/externalEvents";
import { formatRelative, relTimeShort } from "../../lib/utils";
import { formatReplayTime } from "@codecast/shared/replay";
import { replayRefId } from "@codecast/shared/contracts/replayPlayer";
import { kindTriggerEvents, type GroupStatus } from "@codecast/shared/contracts/ingest";
import { EntityIdPill } from "../EntityIdPill";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { foldRuns, replayPlace, topInAppFrame, triggersOnGroup } from "./opsModel";
import { opsHref } from "./opsPaths";
import { KindGlyph, OpsFeedError, SourceChip, useOpsFeed } from "./parts";
import { OpsNotFound } from "./OpsShellParts";
import { ReplayMomentEmbed } from "./ReplayMomentEmbed";
import { replayTotalText, useIssueReplayTotal } from "./useReplayTotals";
import { EpisodeCount, MetricIssueChart } from "./MetricIssueChart";
import { EscalationStrip, FixReview, FixStageGlyph, IssueStatePill } from "./issueParts";
import { OwnerControl } from "./issueOwner";
import { CommitMessage, SuspectCommit } from "./issueSuspect";
import { CheckCard, CommitFeeder, FixCard, HealthChart, MetricCard } from "./issueCards";
import { useIssueFix, useProblemTask, useResolverWords } from "./useIssueFix";
import { leaveOutOfWatch, triage, undoTriage } from "./issueUndo";
import { ContributorsCard, FailureSplitCard, ReadingsCard } from "./issueReadings";
import { CiRunCard } from "./issueCiRun";
import { envFailure } from "./ciRunModel";
import { useCiRun } from "./useCiRun";
import { durationShort } from "./metricModel";
import { ciFailureText } from "./ciRunModel";
import {
  CHART_RANGES,
  FLAP_DAYS,
  chartRangeFor,
  countWords,
  ciRuns,
  creditedTask,
  taskOwner,
  lastDayStart,
  usersOf,
  usersText,
  exceptionValue,
  failuresIn,
  fixActionLabel,
  fixClose,
  fixClosed,
  taskFixStage,
  issueActivity,
  escalation,
  isFlapping,
  isRegressed,
  layoutChart,
  lifeMarks,
  metricContributors,
  metricFailure,
  breakdownRows,
  type BreakdownRow,
  parseTags,
  regressedAt,
  regressedIn,
  replayOffset,
  resolverOf,
  sampleUsers,
  sampleFacets,
  sampleTag,
  stackRows,
  suspectSha,
  squashPr,
  yTicks,
  type ActivityItem,
  type FixStage,
  type ChartMark,
  type ChartRange,
  type StackFrameRow,
  knownRelease,
  FAILURE_KEY,
  jobFailureSplit,
  jobQuiet,
  type FailurePart,
  hogqlExclude,
  noiseOf,
} from "./issuesModel";
import { causeSearchHref, issueListBack, issueStep, rememberIssueFocus } from "./issueNav";
import { useMetricBreakdown } from "./useMetricBreakdown";
import type { OpsEvent, OpsGroup, OpsReplay, OpsSample, OpsSource } from "./opsTypes";
import "./issues.css";

const ref = (g: OpsGroup) => g.short_id || g._id;

export function IssuePage({ id }: { id: string }) {
  const feed = useSyncOpsGroup(id);
  const groupsFeed = useOpsFeed("groups");
  useSyncOpsEvents();
  const group = useOpsGroup(id);
  const sources = useOpsSources();
  const source = group ? sources.find((s) => s._id === group.source_id) : undefined;
  const samples = useOpsSamples(group?._id);
  const events = useOpsEvents();
  const now = useCoarseNow(60_000);

  // A group the server no longer has is gone even if this device cached it
  // (useSyncOpsGroup drops the row): its actions would fail on the server.
  if (detailGone(feed)) return <OpsNotFound id={id} kind="issue" />;
  if (!group) {
    if (feed.error) return <OpsFeedError what={id} retry={feed.retry} />;
    // The workspace's list has answered without it: say so now, while the one-row read may still find it elsewhere.
    if (groupsFeed?.ready) return <OpsNotFound id={id} kind="issue" checking={!feed.ready} />;
    // The page's own frame while the row is read: its header, chart and both columns of cards, so nothing jumps when it lands.
    return (
      <div className="ops-detail iss-page" aria-busy="true" data-ops-issue-loading={id}>
        <div className="iss-skel" style={{ width: 120 }} />
        <div className="iss-skel mt-4" style={{ width: "60%", height: 20 }} />
        <div className="iss-skel mt-3 mb-4" style={{ width: "40%" }} />
        <div className="iss-skel mb-4" style={{ width: "100%", height: 120 }} />
        <div className="ops-grid">
          <div className="min-w-0 ops-col"><SkeletonCard title="Event" /><SkeletonCard title="Stack" /></div>
          <aside className="min-w-0 ops-col"><SkeletonCard title="Fix" /><SkeletonCard title="Activity" /></aside>
        </div>
      </div>
    );
  }
  // The samples ride the group's own answer: until it lands, a group that holds samples is still reading them.
  const samplesState: SamplesState = samples.length ? "ready" : feed.error ? "error" : !feed.ready && (group.sample_count ?? 1) > 0 ? "loading" : "none";
  return <IssueBody key={group._id} group={group} source={source} samples={samples} samplesState={samplesState} retry={feed.retry} events={events} now={now} />;
}

type SamplesState = "loading" | "ready" | "none" | "error";

function IssueBody({ group, source, samples, samplesState, retry, events, now }: { group: OpsGroup; source?: OpsSource; samples: OpsSample[]; samplesState: SamplesState; retry?: () => void; events: OpsEvent[]; now: number }) {
  const router = useRouter();
  const allGroups = useOpsGroups();
  const sources = useOpsSources();
  const [filter, setFilter] = useState<{ key: string; value: string } | null>(null);
  const shown = useMemo(() => (filter ? samples.filter((s) => sampleTag(s, filter.key) === filter.value) : samples), [samples, filter]);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const index = Math.max(0, pickedId ? shown.findIndex((s) => s._id === pickedId) : 0);
  const sample = shown[index];
  const [fixing, setFixing] = useState(false);
  const flaps = useMemo(() => failuresIn(group, events, now), [group, events, now]);
  // A flapper reads as one whatever it reads now: a monitor that recovers on its own is resolved between flips.
  const flapping = isFlapping(group, flaps);
  const [assigning, setAssigning] = useState(false);
  const regressed = isRegressed(group) && !flapping;
  const backRelease = regressed && group.kind !== "check" && group.kind !== "metric" ? regressedIn(group, events) : null;
  // A metric's value now is its Metric card's (the watch's last read): its newest kept reading under the title would be a second, older number.
  const exception = (sample ?? samples[0]) && !(group.kind === "metric" && group.meta?.metric_watch_id) ? exceptionValue(sample ?? samples[0], group.title) : null;
  // Where the group counts nobody, the people its kept samples name are a floor.
  // Where every occurrence is kept, the people they name are the exact count (the Tags card reads the same samples).
  const keptAll = samples.length > 0 && samples.length >= group.count;
  const seenUsers = group.users && !keptAll ? 0 : sampleUsers(samples);
  // One count in the header, written the way the list and Overview write it.
  const heldUsers = keptAll && seenUsers ? { n: seenUsers, floor: false } : usersOf(group) ?? (seenUsers ? { n: seenUsers, floor: true } : null);
  const problem = useProblemTask(group.signal_task_id);
  // The fix chain reads the task only when it was filed for this issue: one verdict for every card.
  const credited = creditedTask(group, problem);
  const stage = taskFixStage(group, problem ?? undefined);
  const fix = useIssueFix(group, stage, now);
  const chartFix = useMemo(() => fixMark(group, credited, stage), [group, credited, stage]);
  const fixLive = fix.plan.primary === "open" && !!fix.plan.live;
  // A metric alert's fix goes first to the error with the biggest share of its window, when one stands out and nothing works on it yet.
  const top = useMemo(() => (group.kind === "metric" ? metricContributors(group, allGroups, lastDayStart(now), now).rows[0] ?? null : null), [group, allGroups, now]);
  const topTask = useProblemTask(top?.group.signal_task_id);
  const topStage = top ? taskFixStage(top.group, topTask ?? undefined) : null;
  const [leadFixing, setLeadFixing] = useState(false);
  // The group's transitions and its source's deploys over 90 days: the state strip, the check card and the chart's marks.
  useSyncOpsGroupTransitions(ref(group), 90);
  const watches = useOpsWatches();
  const watch = group.meta?.metric_watch_id ? watches.find((w) => w._id === group.meta!.metric_watch_id) ?? null : null;
  // What the metric counted, split by its own source: past half of it, that part is the cause the fix goes to first.
  const split = useMetricBreakdown(group.kind === "metric" ? watch ?? undefined : undefined, source);
  const parts = useMemo(() => (split.state === "rows" ? breakdownRows(split.results, allGroups) : []), [split, allGroups]);
  const cause = parts[0] && parts[0].share > 0.5 && !parts[0].group?.fix_conversation_id ? parts[0] : null;
  const [partFixing, setPartFixing] = useState<BreakdownRow | null>(null);
  const fixPart = (p: BreakdownRow) => (p.group ? setLeadFixing(true) : setPartFixing(p));
  // Known noise behind the number (a browser warning, an extension, a stale chunk) is cured by leaving it out of the watch's query, so that leads.
  const lead = cause
    ? {
        title: cause.key,
        ref: cause.group ? ref(cause.group) : null,
        href: cause.group ? opsHref.issue(ref(cause.group)) : causeSearchHref(cause.key),
        share: cause.share,
        onStart: () => fixPart(cause),
        noise: noiseOf(cause.key),
        leaveOut: watch && noiseOf(cause.key) && hogqlExclude(watch.query, cause.key) ? () => void leaveOutOfWatch(watch, cause.key) : undefined,
      }
    : top && top.share >= 0.3 && topStage !== "fixing" && !top.group.fix_conversation_id
      ? { title: top.group.title, ref: ref(top.group), href: opsHref.issue(ref(top.group)), share: top.share, onStart: () => setLeadFixing(true), noise: noiseOf(top.group.title) }
      : null;
  const leadGroup = cause ? cause.group : top?.group ?? null;
  const healthKind = group.kind === "check" || group.kind === "metric";
  const stackOf = sample?.stack ? sample : samples.find((s) => s.stack);
  // A CI check's runs: the page shows one as GitHub tells it (the newest failed, or the one picked in Readings).
  const runs = useMemo(() => (group.kind === "check" ? ciRuns(samples).filter((r) => r.run_id) : []), [group.kind, samples]);
  const [pickedRun, setPickedRun] = useState<string | null>(null);
  const runRow = runs.find((r) => r.run_id === pickedRun) ?? runs.find((r) => !r.ok) ?? runs[0] ?? null;
  const ci = useCiRun(ref(group), runRow?.run_id ?? null);
  const repository = useMemo(() => {
    for (const s of samples) {
      const r = parseTags(s.context_json)?.repository;
      if (typeof r === "string") return r;
    }
    return null;
  }, [samples]);
  // One job name holds many causes: its failures split by what each said, each with its own fix.
  const failSplit = useMemo(() => jobFailureSplit(group, samples), [group, samples]);
  const splitShown = failSplit && failSplit.rows.length > 1 ? failSplit : null;
  const [failFixing, setFailFixing] = useState<FailurePart | null>(null);
  const jobIsQuiet = group.status === "open" && jobQuiet(group, now);

  const backHref = issueListBack() ?? opsHref.tab("issues");
  const fallbackOrder = useMemo(() => allGroups.filter((g) => g.status === group.status).map(ref), [allGroups, group.status]);
  const step = (dir: 1 | -1) => {
    const next = issueStep(ref(group), dir, fallbackOrder);
    if (!next) return;
    // Going back to the list lands on the last issue viewed, not the one the walk began at.
    rememberIssueFocus(next);
    router.push(opsHref.issue(next));
  };
  const setStatus = (status: GroupStatus) => triage([group], status);
  const leading = !!lead && (fix.plan.primary === "start" || fix.plan.primary === "refile" || fix.plan.primary === "followup");
  const startOrOpenFix = () => (fixLive ? router.push(`/conversation/${fix.plan.live}`) : leading ? setLeadFixing(true) : setFixing(true));
  // What f does, in the Fix card's words: the phone shows it under the title, where the card itself is a long scroll away.
  const fKey = fixLive ? fixActionLabel("open", null, false) : leading && lead ? (lead.ref ? `Start fix on ${lead.ref}` : "Start fix on the cause") : fix.plan.primary === "start" || fix.plan.primary === "refile" || fix.plan.primary === "followup" ? fixActionLabel(fix.plan.primary, problem?.short_id, !!problem && !credited) : null;
  const go = (i: number) => {
    const s = shown[Math.max(0, Math.min(shown.length - 1, i))];
    if (s) setPickedId(s._id);
  };

  useWatchEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isEditableTarget(e.target) || hasOpenModal()) return;
      if (e.key === "Escape" || e.key === "Backspace") router.push(backHref);
      else if (e.key === "j") step(1);
      else if (e.key === "k") step(-1);
      else if (e.key === "e" && group.status !== "resolved") setStatus("resolved");
      else if (e.key === "i" && group.status === "open") setStatus("ignored");
      else if (e.key === "f") startOrOpenFix();
      else if (e.key === "a") setAssigning(true);
      else if (e.key === "z") undoTriage();
      else if (e.key === "u" && group.status !== "open") setStatus("open");
      else if (e.key === "]") go(index + 1);
      else if (e.key === "[") go(index - 1);
      else return;
      e.preventDefault();
    };
    // Capture, so the page's Escape (back to the list it came from) runs before
    // the shell's go-up-a-level, which steps aside for a handled key.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [group, index, shown, backHref, fixLive, fix.plan.live, fallbackOrder, leading]);

  return (
    <div className="ops-detail iss-page">
      {/* The crumbs and the k/j stepper are the shell's one row (OpsShell, IssueStepper). */}
      <div className="iss-headrow">
        <div className="mt-2.5"><KindGlyph kind={group.kind} /></div>
        <div className="min-w-0">
          <IssueTitle title={group.title} />
          {exception && <ExceptionLine text={exception} settledAt={group.status !== "open" || (healthKind && group.meta?.ok === true) || jobIsQuiet ? group.last_seen : null} now={now} of={splitShown && !filter && index === 0 ? splitShown.rows.length : undefined} />}
          <div className="iss-meta">
            <IssueStatePill group={group} release={backRelease} now={now} flaps={flapping ? flaps : undefined} />
            {group.status === "open" && !healthKind && <EscalationStrip group={group} now={now} />}
            <span className="ops-num"><b>{group.count.toLocaleString()}</b> {countWords(group.kind, group.count).long}</span>
            {group.kind === "metric" && <EpisodeCount group={group} watch={watch} now={now} />}
            {heldUsers && (
              <span className="ops-num" title={group.users_since && heldUsers.floor ? `counted since ${new Date(group.users_since).toLocaleString()}` : !group.users ? (keptAll ? "every occurrence is kept" : "named by the kept samples; this source does not count people") : undefined}>
                {usersText(heldUsers)}
              </span>
            )}
            <span title={new Date(group.first_seen).toLocaleString()}>first {formatRelative(group.first_seen, now)}</span>
            <span title={new Date(group.last_seen).toLocaleString()}>last {formatRelative(group.last_seen, now)}</span>
            {source && <SourceChip source={source} href={opsHref.tab("issues", { source: source.name })} />}
            {/* A replay issue's level is its type (request, rage click): named with its kind, the words the list's Kind and Type facets use. */}
            {group.level && <span className="ops-mono">{group.kind === "replay_issue" ? `replay issue · ${group.level.replace(/_/g, " ")}` : group.level}</span>}
            {group.culprit && <span className="ops-mono text-sol-text truncate max-w-[360px]" title={group.culprit}>{group.culprit}</span>}
            {group.external?.url && (
              <a href={group.external.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-sol-text">
                {group.external.provider} <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </div>
        </div>
        <div className="iss-actions">
          {/* Triage and ownership only: the fix has one home, the Fix card (f). */}
          <OwnerControl group={group} source={source} assignee={taskOwner(group, problem)} open={assigning} setOpen={setAssigning} />
          {group.status === "open" ? (
            <>
              <button type="button" className="ops-btn" onClick={() => setStatus("ignored")} title="Stop counting this as open; new occurrences do not reopen it">Ignore <KeyCap size="xs">i</KeyCap></button>
              <button type="button" className="ops-btn" data-tone="primary" onClick={() => setStatus("resolved")} title="Resolve; an occurrence from a newer release reopens it as a regression">Resolve <KeyCap size="xs" tone="onAccent">e</KeyCap></button>
            </>
          ) : (
            <button type="button" className="ops-btn" onClick={() => setStatus("open")}>Reopen <KeyCap size="xs">u</KeyCap></button>
          )}
        </div>
      </div>

      <div className="iss-phone-fix">
        {stage !== "none" && <a href="#iss-fix" className="iss-phone-fix-stage" title="The Fix card"><FixStageGlyph stage={stage} word /></a>}
        {fKey && <button type="button" className="ops-btn" data-tone="primary" onClick={startOrOpenFix}>{fKey}</button>}
      </div>

      {regressed && <RegressedBanner group={group} release={backRelease} task={credited ?? null} events={events} now={now} />}
      {group.status !== "open" && <SettledBanner group={group} task={credited ?? null} events={events} now={now} />}
      {flapping && (
        <div className="iss-banner" role="status" data-tone="flapping">
          <b>Flapping</b>
          <span><span className="ops-num">{flaps}</span> failures in {FLAP_DAYS} days, {group.meta?.ok === true || group.status === "resolved" ? "passing now" : "failing now"}</span>
          <span className="iss-banner-acts">
            {watch && <Link className="ops-btn" href={opsHref.metric(watch.short_id)} title="Move the line so ordinary noise stays inside it">Raise the line</Link>}
            <button type="button" className="ops-btn" onClick={() => setStatus("muted")} title="Keeps counting, stops announcing and filing; z undoes it">Mute</button>
          </span>
        </div>
      )}

      {healthKind ? <HealthChart group={group} events={events} now={now} /> : <OccurrenceChart group={group} events={events} now={now} fix={chartFix} />}

      <div className="ops-grid">
        <div className="min-w-0 ops-col">
          {(group.kind === "check" || group.kind === "job") && <CheckCard group={group} events={events} now={now} runUrl={samples[0]?.url} samples={samples} env={runRow && !runRow.ok && ci.run ? envFailure(ci.run) : null} envPending={!!runRow && !runRow.ok && ci.reading} />}
          {runRow && <CiRunCard row={runRow} state={ci} repository={repository} now={now} newest={runRow === runs[0]} />}
          {group.kind === "metric" && <MetricCard group={group} watch={watch} now={now} />}
          {group.kind === "metric" && group.meta?.metric_watch_id && <MetricIssueChart watchId={group.meta.metric_watch_id} since={group.first_seen} />}
          {group.kind === "metric" && <ContributorsCard group={group} watch={watch} now={now} split={split} parts={parts} onFixPart={setPartFixing} />}
          {splitShown && <FailureSplitCard split={splitShown} now={now} picked={filter?.key === FAILURE_KEY ? filter.value : null} onPick={(key) => { setFilter(key ? { key: FAILURE_KEY, value: key } : null); setPickedId(null); }} onFix={setFailFixing} />}
          {healthKind ? (
            samplesState === "loading" ? <SkeletonCard title="Readings" /> : <ReadingsCard group={group} samples={samples} watch={watch} now={now} source={source} pickedRun={runs.length ? runRow?.run_id ?? null : null} onPickRun={runs.length ? setPickedRun : undefined} />
          ) : (
            <EventCard group={group} samples={shown} all={samples.length} index={index} state={samplesState} retry={retry} go={go} filter={filter} clearFilter={() => setFilter(null)} now={now} />
          )}
          {stackOf?.stack ? <StackCard stack={stackOf.stack} other={stackOf !== sample} group={group} now={now} at={stackOf.at} /> : samplesState === "loading" ? <SkeletonCard title="Stack" /> : null}
          {sample && !healthKind && <DetailsCard sample={sample} />}
          {samples.length > 1 && !healthKind && <SamplesIndex samples={shown} title={group.title} current={sample?._id ?? null} pick={setPickedId} now={now} />}
        </div>
        <aside className="min-w-0 ops-col">
          {credited?.landed?.sha && <CommitFeeder sha={credited.landed.sha} />}
          <FixCard group={group} stage={stage} task={fix.task} sessions={fix.sessions} plan={fix.plan} now={now} onStart={() => setFixing(true)} events={events} lead={lead} />
          {!healthKind && <TagsCard now={now} samples={samples} of={group.count} life={group.last_seen - group.first_seen} filter={filter} setFilter={(f) => { setFilter(f); setPickedId(null); }} />}
          {(knownRelease(group.last_release) || knownRelease(group.first_release) || group.resolved_in || groupSha(group)) && <ReleaseCard group={group} now={now} />}
          <TriggersCard group={group} sourceName={source?.name ?? null} />
          <ReplaysCard group={group} samples={samples} />
          <ActivityCard group={group} events={events} task={credited ?? null} now={now} />
        </aside>
      </div>

      {leadFixing && leadGroup && <FixReview groups={[leadGroup]} source={sources.find((x) => x._id === leadGroup.source_id)} onClose={() => setLeadFixing(false)} />}
      {partFixing && (
        <FixReview
          groups={[group]}
          source={source}
          facts={{ title: partFixing.key, failure: `${partFixing.n.toLocaleString()} of the events ${watch?.name ?? "the metric"} counted (${Math.round(partFixing.share * 100)}%) are this one exception. ${samples[0]?.message ?? ""}`.trim() }}
          onClose={() => setPartFixing(null)}
        />
      )}
      {failFixing && (
        <FixReview
          groups={[group]}
          source={source}
          facts={{ title: `${group.title}: ${failFixing.label}`, failure: `${failFixing.n.toLocaleString()} of ${splitShown?.total.toLocaleString() ?? failFixing.n} ${splitShown?.from === "kept" ? "kept runs" : "failed runs"} (${Math.round(failFixing.share * 100)}%) said: ${failFixing.key}. Fix this cause only; the job's other failures are other causes.` }}
          onClose={() => setFailFixing(null)}
        />
      )}
      {fixing && (
        <FixReview
          groups={[group]}
          source={source}
          facts={{ frame: topInAppFrame(stackOf?.stack), url: runRow?.url ?? sample?.url ?? samples[0]?.url, failure: ci.run ? ciFailureText(ci.run) : group.kind === "metric" ? metricFailure(samples[0]?.message, parts) : splitShown ? `The job failed with ${splitShown.rows.length} different messages:\n${splitShown.rows.slice(0, 6).map((r) => `${Math.round(r.share * 100)}% (${r.n}) ${r.key}`).join("\n")}` : undefined }}
          onClose={() => setFixing(false)}
        />
      )}
    </div>
  );
}

/** What a closed fix puts on the chart: a mark at the commit that landed it (or the close), so the bars after it are the verdict. */
function fixMark(group: OpsGroup, task: Parameters<typeof fixClose>[1], stage: FixStage): { at: number; label: string } | null {
  if (!fixClosed(stage)) return null;
  const close = fixClose(group, task);
  if (!close || close.at === null) return null;
  return { at: close.at, label: close.how === "landed" ? `fix ${close.sha.slice(0, 7)}` : close.how === "resolved" ? "resolved" : "fix closed" };
}

/**
 * A fix that did not hold, said in one line: what put it to rest (the commit
 * that landed, the release, a recovery or a resolve) and when it came back.
 */
function RegressedBanner({ group, release, task, events, now }: { group: OpsGroup; release: string | null; task: ReturnType<typeof useProblemTask>; events: OpsEvent[]; now: number }) {
  const back = regressedAt(group);
  const state = group.kind === "check" || group.kind === "metric";
  const close = fixClose(group, task ?? undefined);
  const landed = close?.how === "landed" && group.resolved_at !== undefined && close.at <= (back ?? Infinity) ? close : null;
  const resolved = useResolverWords(resolverOf(group, events), group.external?.provider);
  return (
    <div className="iss-banner" role="status">
      <b>Regressed</b>
      <span>
        {landed ? <>fixed in <span className="ops-mono">{landed.sha.slice(0, 7)}</span>{task?.short_id ? <> ({task.short_id})</> : null}, </> : null}
        {resolved}
        {group.resolved_in ? <> in <span className="ops-mono">{group.resolved_in}</span></> : null}
        {group.resolved_at !== undefined ? <> {formatRelative(group.resolved_at, now)}</> : null}
        {", "}
        {state ? "failing again" : "back"}
        {release ? <> in <span className="ops-mono">{release}</span></> : null}
        {back ? <> {state ? `since ${formatRelative(back, now)}` : formatRelative(back, now)}</> : null}
      </span>
    </div>
  );
}

/**
 * A settled issue says how it was settled, the way a resolved header does:
 * who or what resolved it, when, in which release, and what reopens it. An
 * ignored or muted one says what that means for new occurrences.
 */
function SettledBanner({ group, task, events, now }: { group: OpsGroup; task: ReturnType<typeof useProblemTask>; events: OpsEvent[]; now: number }) {
  const resolver = resolverOf(group, events);
  const resolved = useResolverWords(resolver, group.external?.provider);
  const state = group.kind === "check" || group.kind === "metric";
  if (group.status === "ignored" || group.status === "muted") {
    return (
      <div className="iss-banner" role="status" data-tone="settled">
        <b>{group.status === "muted" ? "Muted" : "Ignored"}</b>
        <span>{group.status === "muted" ? "keeps counting, announces nothing" : "new events count and never reopen it"}</span>
      </div>
    );
  }
  const close = fixClose(group, task ?? undefined);
  const landed = close?.how === "landed" && group.resolved_at !== undefined && Math.abs(close.at - group.resolved_at) < 14 * 24 * 3600_000 ? close : null;
  const vendor = !!group.external && !group.resolved_via;
  return (
    <div className="iss-banner" role="status" data-tone="resolved">
      <b>{resolver.via === "recovered" ? "Recovered" : "Resolved"}</b>
      <span>
        {resolver.via === "recovered" ? "on its own" : resolved.replace(/^resolved ?/, "") || null}
        {group.resolved_at !== undefined ? <> {formatRelative(group.resolved_at, now)}</> : null}
        {group.resolved_in ? <> in <span className="ops-mono">{group.resolved_in}</span></> : null}
        {landed ? <> · fixed in <span className="ops-mono">{landed.sha.slice(0, 7)}</span>{task?.short_id ? <> ({task.short_id})</> : null}</> : null}
      </span>
      <span className="ops-dim">{state ? "its next failure reopens it" : vendor ? `reopens when ${group.external!.provider} does` : "an event from a newer release reopens it"}</span>
    </div>
  );
}

/**
 * What went wrong, under the title the way an exception's value sits under
 * its type: clamped, whole on a press. On a settled issue (or a check now
 * passing) it is the last failure, drawn muted with its age.
 */
function ExceptionLine({ text, settledAt, now, of }: { text: string; settledAt: number | null; now: number; /** The job said this and other things: how many, so the line reads as the newest of them, not the whole count's cause. */ of?: number }) {
  const [whole, setWhole] = useState(false);
  const long = text.length > 240 || text.split("\n").length > 3;
  return (
    <>
      <div className="iss-exc ops-mono" data-settled={settledAt !== null ? "true" : undefined} data-whole={whole ? "true" : undefined} title={long && !whole ? text : undefined}>
        {settledAt !== null && <span className="iss-exc-last" title={new Date(settledAt).toLocaleString()}>last failure {relTimeShort(settledAt, now)} ago · </span>}
        {of !== undefined && <span className="iss-exc-last">newest of {of} · </span>}
        {text}
      </div>
      {long && <button type="button" className="iss-more" onClick={() => setWhole((v) => !v)}>{whole ? "Less" : "Whole message"}</button>}
    </>
  );
}

/** A long title clamps to three lines with a way to open it whole. */
function IssueTitle({ title }: { title: string }) {
  const [whole, setWhole] = useState(false);
  const long = title.length > 180;
  return (
    <>
      <h1 className="ops-h1 iss-h1" data-clamp={long && !whole ? "true" : undefined} title={long ? title : undefined}>{title}</h1>
      {long && <button type="button" className="iss-more" onClick={() => setWhole((v) => !v)}>{whole ? "Less" : "Whole title"}</button>}
    </>
  );
}

const MARK_INK: Record<ChartMark["tone"], string> = { release: "var(--sol-green)", resolved: "var(--sol-green)", regressed: "var(--sol-orange)", new: "var(--sol-red)", fix: "var(--sol-violet)", other: "var(--sol-text-muted)" };

/**
 * Occurrences over a window: hourly bars over a day, daily bars past it. It
 * opens on the narrowest window that holds the last occurrence; one that
 * holds none folds to a line saying how long it has been quiet.
 */
function OccurrenceChart({ group, events, now, fix }: { group: OpsGroup; events: OpsEvent[]; now: number; fix: { at: number; label: string } | null }) {
  const [range, setRange] = useState<ChartRange>(() => chartRangeFor(group, now));
  const hours = CHART_RANGES.find((r) => r.key === range)?.hours ?? 24;
  const [hover, setHover] = useState<number | null>(null);
  const l = useMemo(() => layoutChart(group, events, now, hours, fix), [group, events, now, hours, fix]);
  const y = yTicks(l.max);
  const top = y.top;
  const daily = l.step > 3600_000;
  const tone = isRegressed(group) ? "var(--sol-orange)" : group.status === "open" ? "var(--sol-red)" : "var(--sol-text-muted)";
  // Daily counts are kept per UTC day, so a daily bar and its date label both read in UTC: a local label would sit a day off the bar it names.
  const dayZone = daily ? { timeZone: "UTC" } : {};
  const fmtTick = (at: number) => (hours <= 24 ? new Date(at).toLocaleTimeString(undefined, { hour: "numeric" }) : new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", ...dayZone }));
  const fmtBar = (at: number) => (daily ? `${new Date(at).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })} UTC` : new Date(at).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }));
  const read = hover !== null ? l.bars[hover] : null;
  const sinceDeploy = l.lastDeploy !== null ? 1 - (l.lastDeploy - l.start) / (l.bars.length * l.step) : null;
  const unknown = l.bars.some((b) => b.unknown);
  // An escalating issue draws the rate it had before, per bar, so the jump reads against it.
  // A spike, going on or passed, draws the rate it had before, per bar, so the jump (and the fall back) reads against it.
  const baseline = group.status === "open" && group.kind !== "check" && group.kind !== "metric" && escalation(group, now).spiked ? escalation(group, now).baseline / (daily ? 1 : 24) : null;
  const seg = (
    <div className="ops-seg" role="group" aria-label="Chart window">
      {CHART_RANGES.map((r) => (
        <button key={r.key} type="button" data-on={range === r.key ? "true" : undefined} aria-pressed={range === r.key} onClick={() => setRange(r.key)}>{r.key}</button>
      ))}
    </div>
  );
  const quiet = l.total === 0;
  // Days before the counts reach back are not zero, they are unknown: the total is a floor, and a window of only those is never a confident 0.
  const since = unknown ? l.bars.find((b) => !b.unknown)?.at ?? null : null;
  const plot = !quiet || unknown;
  return (
    <div className="ops-card iss-chart" data-quiet={quiet ? "true" : undefined} style={{ ["--tone" as string]: tone }}>
      <div className="iss-chart-head">
        <span className="font-semibold iss-chart-title">{group.kind === "job" ? "Failed runs" : "Events"}</span>
        <span className="ops-num iss-chart-total" title={since !== null ? `counted from ${new Date(since).toLocaleString()}; days before that are not counted` : undefined}>
          <b>{unknown && !l.exact ? "≥" : ""}{l.total.toLocaleString()}</b> <span className="ops-dim">{countWords(group.kind, l.total).long} in {range}</span>
        </span>
        {baseline !== null && baseline > 0 && baseline < top && <span className="iss-chart-key ops-num" title="the mean of the two days before the last one"><i />usually {Math.round(baseline).toLocaleString()}/{daily ? "day" : "h"}</span>}
        {seg}
        {plot && (read || !quiet) && (
          <span className="iss-chart-read">
            {read ? (read.unknown ? `${fmtBar(read.at)}: not counted` : `${read.count.toLocaleString()} · ${fmtBar(read.at)}`) : `peak ${l.max.toLocaleString()}/${daily ? "day" : "h"}`}
          </span>
        )}
      </div>
      {quiet && (
        <div className="iss-chart-quiet">
          <span>quiet for <b className="ops-num">{formatRelative(group.last_seen, now).replace(/ ago$/, "")}</b></span>
          <span className="ops-dim">last {new Date(group.last_seen).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}{knownRelease(group.last_release) ? <> in <span className="ops-mono">{knownRelease(group.last_release)}</span></> : null}</span>
          <span className="ops-dim ops-num">{group.count.toLocaleString()} since {new Date(group.first_seen).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
        </div>
      )}
      {plot && (
        <>
          <div className="iss-chart-plot" onMouseLeave={() => setHover(null)}>
            {y.ticks.map((t) => (
              <Fragment key={t.value}>
                <span className="iss-chart-y ops-num" style={{ top: `${t.y * 100}%` }}>{t.value.toLocaleString()}</span>
                {t.value > 0 && <span className="iss-chart-grid" style={{ top: `${t.y * 100}%` }} />}
              </Fragment>
            ))}
            {sinceDeploy !== null && sinceDeploy > 0 && <span className="iss-chart-since" style={{ width: `${sinceDeploy * 100}%` }} title="since the last deploy" />}
            {baseline !== null && baseline > 0 && baseline < top && <span className="iss-chart-base" style={{ bottom: `${(baseline / top) * 100}%` }} title={`usually ${Math.round(baseline).toLocaleString()}/${daily ? "day" : "h"}`} />}
            <div className="iss-chart-bars" data-daily={daily ? "true" : undefined} role="img" aria-label={`${group.short_id}: ${l.total} events over ${range}`}>
              {l.bars.map((b, i) => (
                <span key={b.at} className="iss-chart-bar" data-hot={b.count > 0 ? "true" : undefined} data-unknown={b.unknown ? "true" : undefined} data-on={hover === i ? "true" : undefined} onMouseEnter={() => setHover(i)} title={b.unknown ? `${fmtBar(b.at)}: not counted` : `${b.count} · ${fmtBar(b.at)}`}>
                  <i style={{ height: b.unknown ? "100%" : b.count ? `${Math.max(4, (b.count / top) * 100)}%` : "1px", opacity: b.count || b.unknown ? 1 : 0.4 }} />
                </span>
              ))}
            </div>
            {l.marks.map((m, i) => (
              <span key={i} className="iss-chart-mark" data-tone={m.tone} data-edge={m.x > 0.85 ? "end" : undefined} style={{ left: `${m.x * 100}%`, ["--ink" as string]: MARK_INK[m.tone] }} title={`${m.label || (m.tone === "release" ? "deploy" : "")} · ${new Date(m.at).toLocaleString()}`}>
                {m.label && <span>{m.label}</span>}
              </span>
            ))}
          </div>
          <div className="iss-chart-x" data-deploys={l.deployTicks.length ? "true" : undefined}>
            {l.deployTicks.map((d) => (
              <i key={`d${d.at}`} className="iss-chart-deploy" data-n={d.n > 1 ? "true" : undefined} style={{ left: `${d.x * 100}%` }} title={`${d.n > 1 ? `${d.n} deploys, last ` : "deploy "}${d.label} · ${new Date(d.at).toLocaleString()}`}>
                {d.n > 1 && <b>{d.n}</b>}
              </i>
            ))}
            {l.ticks.map((t) => <span key={t.at} style={{ left: `${t.x * 100}%` }}>{fmtTick(t.at)}</span>)}
          </div>
          {unknown && <div className="iss-chart-note ops-dim"><i /> not counted this far back</div>}
        </>
      )}
      <IssueLife group={group} events={events} now={now} />
    </div>
  );
}

/** The issue's life under the hourly chart: first seen (and in which release), each deploy, resolve and regression since. */
function IssueLife({ group, events, now }: { group: OpsGroup; events: OpsEvent[]; now: number }) {
  const life = useMemo(() => lifeMarks(group, events, now), [group, events, now]);
  const deploys = life.marks.filter((m) => m.tone === "release");
  const rest = life.marks.filter((m) => m.tone !== "release");
  return (
    <div className="iss-life" aria-label="Since first seen">
      <span className="iss-life-k ops-dim" title={new Date(life.start).toLocaleString()}>{life.clipped ? "90d" : formatRelative(group.first_seen, now)}</span>
      <div className="iss-life-axis">
        {deploys.map((m, i) => <span key={`d${i}`} className="iss-life-deploy" style={{ left: `${m.x * 100}%` }} title={`${m.label} · ${new Date(m.at).toLocaleString()}`} />)}
        {rest.map((m, i) => (
          <span key={`m${i}`} className="iss-life-mark" data-first={i === 0 ? "true" : undefined} style={{ left: `${m.x * 100}%`, ["--ink" as string]: MARK_INK[m.tone] }} title={`${m.label} · ${new Date(m.at).toLocaleString()}`}>
            {i === 0 && <span>{m.label}</span>}
          </span>
        ))}
      </div>
      <span className="iss-life-k ops-dim">now</span>
    </div>
  );
}

function SkeletonCard({ title }: { title: string }) {
  return (
    <div className="ops-card" aria-busy="true">
      <div className="ops-card-head">{title}</div>
      <div className="ops-card-body flex flex-col gap-2">
        <div className="iss-skel" style={{ width: "70%" }} />
        <div className="iss-skel" style={{ width: "55%" }} />
        <div className="iss-skel" style={{ width: "62%" }} />
      </div>
    </div>
  );
}

/** The event the page is on: which of the kept samples, when, where, who, and its replay at that moment. */
function EventCard({ group, samples, all, index, state, retry, go, filter, clearFilter, now }: {
  group: OpsGroup;
  samples: OpsSample[];
  all: number;
  index: number;
  state: SamplesState;
  retry?: () => void;
  go: (i: number) => void;
  filter: { key: string; value: string } | null;
  clearFilter: () => void;
  now: number;
}) {
  if (state === "loading") return <SkeletonCard title="Event" />;
  if (state === "error") {
    return (
      <div className="ops-card">
        <div className="ops-card-head">Event</div>
        <div className="ops-card-body ops-dim">Samples did not load. {retry && <button type="button" className="text-sol-link hover:underline" onClick={retry}>Try again</button>}</div>
      </div>
    );
  }
  const s = samples[index];
  const head = (
    <div className="ops-card-head">
      <span className="inline-flex items-center gap-2 whitespace-nowrap">
        Event
        {s && <span className="ops-dim ops-num font-normal">{index + 1} of {samples.length}{filter ? ` of ${all}` : ""}</span>}
        {filter && <button type="button" className="ops-pill" style={{ color: "var(--sol-blue)", background: "color-mix(in srgb, var(--sol-blue) 12%, transparent)" }} onClick={clearFilter}>{filter.key}: {filter.value} ×</button>}
      </span>
      {samples.length > 1 && (
        <span className="iss-event-nav" aria-label="Move between events">
          <button type="button" disabled={index === 0} onClick={() => go(0)} title="Newest event"><ChevronsLeft className="w-3 h-3" /><span className="iss-event-word">Newest</span></button>
          <button type="button" disabled={index === 0} onClick={() => go(index - 1)} title="Newer event"><ChevronLeft className="w-3 h-3" /><KeyCap size="xs">[</KeyCap></button>
          <button type="button" disabled={index >= samples.length - 1} onClick={() => go(index + 1)} title="Older event"><KeyCap size="xs">]</KeyCap><ChevronRight className="w-3 h-3" /></button>
          <button type="button" disabled={index >= samples.length - 1} onClick={() => go(samples.length - 1)} title="Oldest event"><span className="iss-event-word">Oldest</span><ChevronsRight className="w-3 h-3" /></button>
        </span>
      )}
    </div>
  );
  if (!s) {
    return (
      <div className="ops-card">
        {head}
        <div className="ops-card-body ops-dim">{filter ? "No kept sample has that value." : group.kind === "check" || group.kind === "metric" ? "Checks and metrics keep readings, not samples." : "No samples kept for this group."}</div>
      </div>
    );
  }
  const who = s.user?.email ?? s.user?.name ?? s.user?.id ?? null;
  // A job's sample is one failed run: its run id leads, so the run can be found in the app's own logs.
  const ctxTags = group.kind === "job" ? parseTags(s.context_json) : null;
  const runId = ctxTags ? [ctxTags.run_id, ctxTags.job_id, ctxTags.id].find((v) => typeof v === "string" || typeof v === "number") : undefined;
  return (
    <div className="ops-card">
      {head}
      <div className="iss-event">
        <span className="ops-num text-sol-text" title={new Date(s.at).toLocaleString()}>{new Date(s.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" })}</span>
        <span className="ops-dim">{relTimeShort(s.at, now)} ago</span>
        {runId !== undefined && <span className="ops-mono text-sol-text" title={`run ${runId}`}>run {String(runId).slice(0, 8)}</span>}
        {s.level && <span className="ops-mono ops-quiet">{s.level}</span>}
        {s.release && <span className="ops-mono ops-quiet">{s.release}</span>}
        {s.environment && <span className="ops-quiet">{s.environment}</span>}
        {who && <span className="text-sol-text truncate max-w-[240px]" title={who}>{who}</span>}
        <span className="ops-mono ops-dim text-[10.5px] ml-auto" title="sample id">{s._id.slice(-8)}</span>
      </div>
      {s.message && s.message !== group.title && s.message.trim() !== exceptionValue(s, group.title) ? <div className="px-3 pb-2 text-[12.5px] text-sol-text break-words">{s.message}</div> : group.kind === "job" ? <div className="px-3 pb-2 text-[12px] ops-dim">{source?.name ?? "The source"} sent no error message with this run</div> : null}
      {s.url && <div className="px-3 pb-2 text-[11.5px] ops-mono ops-quiet break-all">{s.url}</div>}
      {s.replay_id && <SampleReplay sample={s} />}
    </div>
  );
}

/** The sample's replay, opened at the moment the sample happened. */
function SampleReplay({ sample }: { sample: OpsSample }) {
  // The replay may be past the window the replays list holds: read its own row.
  useSyncOpsReplay(sample.replay_id ?? null);
  const replay = useOpsReplay(sample.replay_id ?? null);
  const t = replayOffset(sample.at, replay);
  const id = replay?.short_id || sample.replay_id!;
  return (
    <div className="px-3 pb-3 flex flex-col gap-2">
      <Link className="text-sol-link hover:underline text-[12px] inline-flex items-center gap-1" href={opsHref.replay(id, t)}>
        {replay?.short_id ?? "Replay"}{t !== null ? ` at ${formatReplayTime(t)}` : ""} <ChevronRight className="w-3 h-3" />
      </Link>
      {replay && replay.short_id && <ReplayMomentEmbed rawId={replayRefId(replay.short_id, t)} entity={replay} served href={opsHref.replay(id, t)} />}
    </div>
  );
}

function DetailsCard({ sample: s }: { sample: OpsSample }) {
  const tags = parseTags(s.tags_json);
  const context = parseTags(s.context_json);
  if (!tags && !context && !s.user) return null;
  return (
    <div className="ops-card">
      <div className="ops-card-head">Tags and context</div>
      <div className="ops-card-body">
        <dl className="ops-kv">
          {s.user && (<><dt>person</dt><dd>{[s.user.email, s.user.name, s.user.id].filter(Boolean).join(" · ")}</dd></>)}
          {tags && Object.entries(tags).map(([k, v]) => (<Fragment key={k}><dt className="ops-mono">{k}</dt><dd className="ops-mono">{String(v)}</dd></Fragment>))}
          {context && (<><dt>context</dt><dd><pre className="ops-code">{JSON.stringify(context, null, 2)}</pre></dd></>)}
        </dl>
      </div>
    </div>
  );
}

/** The repo path a deployed file most likely is: the build's own prefix dropped. */
function repoPath(file: string): string {
  return file.replace(/^[a-z]+:\/\/[^/]*\//i, "").replace(/^\/+/, "").replace(/^(app|var\/task|usr\/src\/app|srv|workspace)\//, "");
}

function StackCard({ stack, other, group, now, at }: { stack: string; other: boolean; group: OpsGroup; now: number; at: number }) {
  const rows = useMemo(() => stackRows(stack), [stack]);
  const [raw, setRaw] = useState(false);
  const [libs, setLibs] = useState<Set<number>>(new Set());
  const sha = groupSha(group);
  const commit = useShaCommit(sha);
  // A frame is one line: until source context is kept, opening it would only repeat it.
  // An unminified frame of the product links to its file at the release's commit.
  const frameRow = (f: StackFrameRow) => {
    const href = f.in_app && !f.minified && commit?.repository && commit?.sha ? filePath({ repository: commit.repository, ref: commit.sha, path: repoPath(f.file), line: f.line ?? undefined } as any) : null;
    return (
      <div key={f.i} className="iss-frame" data-inapp={f.in_app ? "true" : "false"}>
        <div className="iss-frame-line ops-mono">
          <span />
          <span className="iss-frame-fn">{f.fn}</span>
          {href ? (
            <Link href={href} className="iss-frame-file hover:underline" title={`Open at ${commit.sha.slice(0, 7)}`}><bdi>{f.file}{f.line ? `:${f.line}${f.col ? `:${f.col}` : ""}` : ""}</bdi></Link>
          ) : (
            <span className="iss-frame-file" title={f.raw}><bdi>{f.file}{f.line ? `:${f.line}${f.col ? `:${f.col}` : ""}` : ""}</bdi></span>
          )}
          <span className="inline-flex gap-1">
            {f.in_app && <span className="ops-pill" style={{ color: "var(--sol-red)", background: "color-mix(in srgb, var(--sol-red) 12%, transparent)" }}>app</span>}
            {f.minified && <span className="ops-pill" style={{ color: "var(--sol-text-muted)", background: "color-mix(in srgb, var(--sol-text-muted) 12%, transparent)" }} title="no source map">minified</span>}
          </span>
        </div>
      </div>
    );
  };
  return (
    <div className="ops-card">
      <div className="ops-card-head">
        <span className="inline-flex items-center gap-2">Stack {other && <span className="ops-dim font-normal text-[11px]">from {relTimeShort(at, now)} ago</span>}</span>
        <span className="inline-flex items-center gap-2">
          <div className="ops-seg" role="group" aria-label="Stack view">
            <button type="button" data-on={!raw ? "true" : undefined} aria-pressed={!raw} onClick={() => setRaw(false)}>Frames</button>
            <button type="button" data-on={raw ? "true" : undefined} aria-pressed={raw} onClick={() => setRaw(true)}>Raw</button>
          </div>
          <button type="button" className="ops-btn" style={{ height: 22 }} onClick={() => copy(stack, "Stack copied")}><Copy className="w-3 h-3" /> Copy</button>
        </span>
      </div>
      {raw ? (
        <pre className="iss-raw ops-mono">{stack}</pre>
      ) : (
        <div className="iss-frames">
          {rows.map((r, i) =>
            r.type === "message" ? (
              <div key={`m${i}`} className="iss-msg ops-mono">{r.text}</div>
            ) : r.type === "frame" ? (
              frameRow(r)
            ) : (
              <div key={`l${i}`} className="iss-lib">
                <button type="button" className="iss-lib-toggle" onClick={() => setLibs((p) => { const n = new Set(p); n.has(i) ? n.delete(i) : n.add(i); return n; })} aria-expanded={libs.has(i)}>
                  <ChevronDown className="w-3 h-3" style={{ transform: libs.has(i) ? undefined : "rotate(-90deg)" }} />
                  +{r.frames.length} library frames
                </button>
                {libs.has(i) && r.frames.map(frameRow)}
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function copy(text: string, done: string) {
  void navigator.clipboard?.writeText(text).then(() => toast.success(done), () => toast.error("Could not copy"));
}

/** Every kept sample as a compact index: alike runs fold, and any one opens as the page's event. */
function SamplesIndex({ samples, title, current, pick, now }: { samples: OpsSample[]; title: string; current: string | null; pick: (id: string) => void; now: number }) {
  const [openRun, setOpenRun] = useState<string | null>(null);
  const runs = useMemo(() => {
    const line = (s: OpsSample) => (s.message && s.message !== title ? s.message : replayPlace(s.url) ?? s.message ?? "occurrence");
    const folded = foldRuns(samples, (s) => [line(s), s.user?.email ?? s.user?.id ?? "", s.release, s.environment, s.replay_id].join("|"));
    let at = 0;
    return folded.map((r) => {
      const members = samples.slice(at, at + r.count);
      at += r.count;
      return { ...r, members, line: line(r.row) };
    });
  }, [samples, title]);
  return (
    <div className="ops-card">
      <div className="ops-card-head"><span>Samples <span className="ops-dim ops-num">{samples.length}</span></span></div>
      {runs.map((r) => {
        const on = r.members.some((m) => m._id === current);
        const who = r.row.user?.email ?? r.row.user?.name ?? r.row.user?.id ?? "";
        return (
          <div key={r.row._id} className="iss-index-group">
            <button type="button" className="iss-index-row" data-on={on && r.count === 1 ? "true" : undefined} onClick={() => (r.count > 1 ? setOpenRun(openRun === r.row._id ? null : r.row._id) : pick(r.row._id))}>
              <span className="ops-num ops-dim">{relTimeShort(r.row.at, now)}</span>
              <span className="truncate ops-mono text-sol-text" title={r.row.url ?? undefined}>{r.line}</span>
              <span className="inline-flex items-center gap-2 text-[11px]">
                {r.count > 1 && <span className="ops-pill ops-num" style={{ color: "var(--sol-text-muted)", background: "color-mix(in srgb, var(--sol-text-muted) 12%, transparent)" }}>{r.count} alike</span>}
                {who && <span className="ops-quiet truncate max-w-[160px]">{who}</span>}
                {r.row.release && <span className="ops-mono ops-dim">{r.row.release}</span>}
              </span>
            </button>
            {r.count > 1 && openRun === r.row._id && r.members.map((m) => (
              <button key={m._id} type="button" className="iss-index-row" data-member="true" data-on={m._id === current ? "true" : undefined} onClick={() => pick(m._id)}>
                <span className="ops-num ops-dim">{relTimeShort(m.at, now)}</span>
                <span className="truncate ops-quiet">{new Date(m.at).toLocaleString()}</span>
                <span className="ops-mono ops-dim text-[10.5px]">{m._id.slice(-8)}</span>
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** Each tag's top values across the kept samples; a value narrows the events to it. */
/** Below this share of an issue's life, kept samples are a sliver of it: the Tags card gives counts, not shares. */
const TAGS_SHARE_MIN = 0.05;

function TagsCard({ samples, of, life, filter, setFilter, now }: { samples: OpsSample[]; /** The issue's whole count, which the kept samples are a part of. */ of: number; /** How long the issue has been happening, first to last occurrence. */ life: number; filter: { key: string; value: string } | null; setFilter: (f: { key: string; value: string } | null) => void; now: number }) {
  const facets = useMemo(() => sampleFacets(samples), [samples]);
  // A key where every sample differs says nothing by its top values; a card of only those is noise.
  if (!facets.length || facets.every((f) => f.spread)) return null;
  const covered = Math.max(60_000, samples[0].at - samples[samples.length - 1].at);
  // Kept samples that cover a sliver of the issue's life say what that sliver held, not how the issue splits: counts, never shares.
  const sliver = samples.length < of && covered < life * TAGS_SHARE_MIN;
  return (
    <div className="ops-card">
      {/* The shares are of the kept samples, so the head names them and the stretch they cover, never the issue's whole count. */}
      <div className="ops-card-head">
        <span>Tags</span>
        <span className="ops-dim ops-num font-normal text-[11px]" title={`${new Date(samples[samples.length - 1].at).toLocaleString()} to ${new Date(samples[0].at).toLocaleString()}`}>
          {sliver ? <>last {durationShort(covered)} only · {samples.length} of {of.toLocaleString()}</> : <>{samples.length < of ? `${samples.length} kept of ${of.toLocaleString()}` : `all ${samples.length}`} · over {durationShort(covered)}, last {relTimeShort(samples[0].at, now)} ago</>}
        </span>
      </div>
      <div className="ops-card-body">
        {facets.map((f) => (
          <div key={f.key} className="iss-tag" data-spread={f.spread ? "true" : undefined}>
            <div className="iss-tag-key"><span className="ops-mono">{f.key}</span><span className="ops-num" title={`${f.total} of the kept samples carry it`}>{f.spread ? `${f.distinct} distinct` : `${f.total} kept`}</span></div>
            {!f.spread && f.values.map((v) => {
              const on = filter?.key === f.key && filter.value === v.value;
              return (
                <button key={v.value} type="button" className="iss-tag-val" data-on={on ? "true" : undefined} onClick={() => setFilter(on ? null : { key: f.key, value: v.value })} title={`${v.count} of ${f.total}`}>
                  {!sliver && <i style={{ width: `${Math.round(v.share * 100)}%` }} />}
                  <span className="ops-mono">{v.value}</span>
                  <span className="ops-num ops-quiet">{sliver ? `${v.count} of ${f.total}` : `${Math.round(v.share * 100)}%`}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/** A release, linked to its commit's page when the release is a commit codecast holds. */
function ReleaseRef({ release }: { release: string }) {
  const sha = groupSha({ last_release: release });
  useSyncShaCommit(sha);
  const commit = useShaCommit(sha);
  const href = commit?.repository && commit?.sha ? commitPath({ repository: commit.repository, sha: commit.sha }) : null;
  return href ? <Link href={href} className="ops-mono hover:underline">{release}</Link> : <span className="ops-mono">{release}</span>;
}

/**
 * The release and commit the issue sits in: the suspect commit first (the
 * release it came back in, else the one it was first seen in) with the
 * session, task and pull request behind it, then where it was last and first
 * seen, each release linked to its commit.
 */
function ReleaseCard({ group, now }: { group: OpsGroup; now: number }) {
  const sha = groupSha(group);
  useSyncShaCommit(sha);
  const commit = useShaCommit(sha);
  const href = commit?.repository && commit?.sha ? commitPath({ repository: commit.repository, sha: commit.sha }) : null;
  const suspect = suspectSha(group);
  const commitPr = commit ? commit.pr_number ?? squashPr(commit.message) : null;
  return (
    <div className="ops-card">
      <div className="ops-card-head">Release</div>
      <div className="ops-card-body flex flex-col gap-3">
        {suspect && <SuspectCommit sha={suspect.sha} label={suspect.why === "regressed" ? "Suspect" : "Release"} why={suspect.why === "regressed" ? "it came back in this release" : "first seen running this build"} now={now} />}
        <dl className="ops-kv">
          <dt>last in</dt>
          <dd>{group.last_release ? <ReleaseRef release={group.last_release} /> : <span className="ops-dim">none sent</span>}</dd>
          {group.first_release && group.first_release !== group.last_release && (<><dt>first in</dt><dd><ReleaseRef release={group.first_release} /></dd></>)}
          {group.resolved_in && (<><dt>resolved in</dt><dd className="ops-mono">{group.resolved_in}</dd></>)}
          <dt>commit</dt>
          <dd>
            {commit ? (
              <span>
                {href ? <Link href={href} className="ops-mono hover:underline">{commit.sha.slice(0, 7)}</Link> : <span className="ops-mono">{commit.sha.slice(0, 7)}</span>}{" "}
                <span className="ops-quiet"><CommitMessage message={commit.message} repository={commit.repository} /></span>
              </span>
            ) : sha ? <span className="ops-mono ops-dim">{sha.slice(0, 7)}, not seen</span> : <span className="ops-dim">no sha</span>}
          </dd>
          {/* The pull request on its own row, so the subject's own parentheses never wrap its pill. */}
          {commitPr && commit?.repository ? (<><dt>pull request</dt><dd><EntityIdPill type="pr" id={`${commit.repository}#${commitPr}`} certain compact /></dd></>) : null}
          {commit?.conversation_id && (<><dt>session</dt><dd><EntityIdPill type="session" id={commit.conversation_id} /></dd></>)}
        </dl>
      </div>
    </div>
  );
}

function TriggersCard({ group, sourceName }: { group: OpsGroup; sourceName: string | null }) {
  const { tasks } = useTriggers();
  const hits = useMemo(() => triggersOnGroup(tasks, group, sourceName), [tasks, group, sourceName]);
  // The event to suggest is the contract's, the same list triggersOnGroup matches.
  const wakeEvent = kindTriggerEvents(group.kind)[0];
  if (!wakeEvent) return null;
  const add = `/triggers?new=1&on=${encodeURIComponent(wakeEvent)}${sourceName ? `&source=${encodeURIComponent(sourceName)}` : ""}`;
  return (
    <div className="ops-card">
      <div className="ops-card-head">
        <span>Triggers <span className="ops-dim ops-num">{hits.length}</span></span>
        <Link href={add} className="ops-dim text-[11px] font-normal hover:text-sol-text">Add trigger</Link>
      </div>
      {hits.length > 0 && (
        <div className="ops-card-body flex flex-col gap-1.5">
          {hits.map(({ trigger, event, waiting }) => (
            <Link key={trigger._id} href={`/triggers/${trigger._id}`} className="flex items-baseline gap-2 text-[12px] hover:underline">
              <span className="truncate flex-1 text-sol-text">{trigger.display_title ?? trigger.title ?? trigger.prompt?.slice(0, 60)}</span>
              <span className="ops-mono ops-dim text-[11px]">{event}</span>
              {waiting && <span className="ops-pill" style={{ color: "var(--sol-amber)", background: "color-mix(in srgb, var(--sol-amber) 14%, transparent)" }}>fired</span>}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function ReplaysCard({ group, samples }: { group: OpsGroup; samples: OpsSample[] }) {
  const replays = useOpsReplays();
  const linked = useMemo(() => {
    // The newest sample inside each replay places the replay at the error.
    const atIn = new Map<string, number>();
    for (const s of samples) if (s.replay_id && !atIn.has(s.replay_id)) atIn.set(s.replay_id, s.at);
    return replays
      .filter((r) => r.group_ids.includes(group._id) || atIn.has(r._id))
      .map((r) => ({ r, t: atIn.has(r._id) ? replayOffset(atIn.get(r._id)!, r) : null }));
  }, [replays, samples, group._id]);
  // The count is the Replays list's under this issue (useReplayTotals), so the card and the list it opens agree.
  const total = useIssueReplayTotal(group._id);
  if (linked.length === 0 && !total?.total) return null;
  return (
    <div className="ops-card">
      <div className="ops-card-head">
        <span>Replays <span className="ops-dim ops-num" data-provisional={total ? undefined : "true"}>{total ? replayTotalText(total) : linked.length}</span></span>
        <Link className="text-sol-link hover:underline text-[11.5px] font-normal" href={`${opsHref.tab("replays")}?issue=${encodeURIComponent(group.short_id)}`}>All</Link>
      </div>
      <div className="ops-card-body flex flex-col gap-1.5">
        {linked.slice(0, 8).map(({ r, t }: { r: OpsReplay; t: number | null }) => (
          <Link key={r._id} href={opsHref.replay(r.short_id || r._id, t)} className="flex items-baseline gap-2 text-[12px] hover:underline">
            <span className="ops-mono">{r.short_id}</span>
            <span className="ops-quiet truncate flex-1">{r.user?.email ?? r.user?.name ?? replayPlace(r.url) ?? ""}</span>
            <span className="ops-num text-[11px]" style={{ color: t !== null ? "var(--sol-red)" : "var(--sol-text-dim)" }}>
              {t !== null ? `error at ${formatReplayTime(t)}` : r.duration_ms ? formatReplayTime(r.duration_ms) : ""}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}

/** A resolve's line in the activity, naming who or what resolved it. */
function ResolverWhat({ resolver, provider }: { resolver: NonNullable<ActivityItem["resolver"]>; provider?: string }) {
  return <span className="text-sol-text">{useResolverWords(resolver, provider)}</span>;
}

const ACTIVITY_INK: Record<ActivityItem["tone"], string> = { bad: "var(--sol-red)", good: "var(--sol-green)", fix: "var(--sol-violet)", quiet: "var(--sol-text-dim)" };

/** Every flip and every step of the fix, newest first, each with what it names: a release, a commit, the session or the task. */
function ActivityCard({ group, events, task, now }: { group: OpsGroup; events: OpsEvent[]; task: ReturnType<typeof useProblemTask>; now: number }) {
  const items = useMemo(() => issueActivity(group, events, task), [group, events, task]);
  const [all, setAll] = useState(false);
  if (items.length === 0) return null;
  const shown = all ? items : items.slice(0, 10);
  return (
    <div className="ops-card">
      <div className="ops-card-head"><span>Activity <span className="ops-dim ops-num">{items.length}</span></span></div>
      <ol className="iss-activity">
        {shown.map((a, i) => (
          <li key={`${a.at}-${i}`} style={{ ["--ink" as string]: ACTIVITY_INK[a.tone] }}>
            <i />
            {a.resolver ? <ResolverWhat resolver={a.resolver} provider={group.external?.provider} /> : <span className="text-sol-text">{a.what}</span>}
            {a.n && a.n > 1 ? <span className="ops-num ops-dim">×{a.n}</span> : null}
            {a.release && <span className="ops-mono ops-dim">{a.release}</span>}
            {a.sha && <span className="ops-mono ops-dim">{a.sha.slice(0, 7)}</span>}
            {a.task && <span className="ops-mono ops-dim">{a.task}</span>}
            {a.session && <EntityIdPill type="session" id={a.session} compact />}
            <span className="ops-dim ops-num ml-auto" title={new Date(a.at).toLocaleString()}>{relTimeShort(a.at, now)}</span>
          </li>
        ))}
      </ol>
      {items.length > 10 && <button type="button" className="iss-more px-3 pb-2" onClick={() => setAll((v) => !v)}>{all ? "Fewer" : `All ${items.length}`}</button>}
    </div>
  );
}
