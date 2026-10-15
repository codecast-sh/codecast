"use client";
// /trial: every trial card (convex lineTrial.ts). A trial project's line run
// goes through every station for real and stops at its gates without asking
// anyone; each gate is a card here. The list carries each card's problem,
// state and age; the pane draws the card with the queue's own components
// (ChangeCardHeadline, ChangeCardVerdictBar, DecisionAnswerControls,
// ChangeCardView), so what is read here is what a person will read in the
// queue. An answer is recorded as what they would have done: an earlier gate
// moves the run on, the change card ends it, and nothing ships. A run that
// failed before its card is a row of its own (Failed), with the station it
// stopped at and why, and a rerun from a fresh branch off origin/main; so is a
// run that gave up at a failure station and left its problem open (Stopped).
// Our tooling also holds the trial's open expectation proposals: one a run's
// station asked is its trial decision's card, and one no station asked is
// drawn with the Expectations page's own Proposal.
import { findingConversation } from "@codecast/shared/contracts/judges";
import { Fragment, useMemo, useState } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { formatCountdown, USAGE_WARN_PERCENT } from "@codecast/shared/contracts";
import Link from "next/link";
import { ArrowLeft, ExternalLink, RotateCcw } from "lucide-react";
import { SupersededNote } from "../SupersededNote";
import { useSyncTrial, useSyncTrialSpend, useTrialCards, useTrialProjects, useTrialRuns, useTrialSpend, type TrialCardRow, type TrialProjectRow, type TrialRunRow, type TrialSpendRow } from "../../hooks/useSyncTrial";
import { useInboxStore } from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { formatTimeAgo } from "../../lib/messageNavigator";
import { cn } from "../../lib/utils";
import { useSyncSignals, useWorkspaceSignals } from "../../hooks/useSyncSignals";
import { useSearchParams } from "next/navigation";
import { WorkspaceScopeProvider } from "../../hooks/useWorkspaceScope";
import { lineFromName, ownWorkspace, trialAddress } from "../../lib/trialHref";
import { useLineSpace } from "../../hooks/useLineSpace";
import { lineFilterParam, readLineSelection } from "../../lib/line/lineWorkspaceUrl";
import { trialHold as dispatchHold } from "../../lib/lineFlow";
import { activeWorkspaceKeyOf, workspaceDisplayName } from "../../lib/workspaceScope";
import { TrialCardBody, answerTone, answererWords, trialRecord } from "./TrialCardBody";
import { cardFailing, evalsOwed, verdictLabel, verdictOfOption } from "@codecast/shared/contracts/changeCard";
import { cardAsRead, cardsByProblem, emptyWords, evidenceGone, proposalUnfounded, trialCardTab, trialHold, trialLane } from "../../lib/trialEvidence";
import { PROPOSAL_VERDICT_TONE, PROPOSAL_VERDICT_WORD } from "../decisions/ProposalCardDecision";
import { useProjectExpectations, useSyncProjectExpectations, type ExpectationProposalView, type ProjectExpectationsRow } from "../../hooks/useSyncProjectExpectations";
import { openProposals } from "../../lib/expectations/view";
import { Proposal } from "../expectations/ExpectationsDocument";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { problemListName } from "../../lib/line/problemTable";
import { outcomeLineInWords } from "../../lib/line/stepWork";
import { overviewWindow } from "../../lib/line/problemsOverview";
import { RAISE_PICKS, limitsHit, raiseLimitsLedger, raisedLimits, trialRunLimit, trialStationName, type TrialLimits } from "../../lib/line/trialStopLedgers";
import { SwitchReview } from "../consequential/ConsequentialSwitch";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { TrialStopActs, approachFailed, useStationReport } from "./TrialStopActs";
import { TrialHeldLink } from "./TrialHeldLink";

type Filter = "waiting" | "tooling" | "held" | "running" | "empty" | "failed" | "stopped" | "answered" | "closed" | "all" | "superseded";

/** The card tabs: each card sits under exactly one (trialCardTab), so they add up to All. */
const CARD_TABS: Filter[] = ["waiting", "tooling", "held", "running", "empty", "answered", "closed", "all"];
/** Runs that ended without a card, and cards a newer line version replaced: outside All, in a row of their own. */
const OTHER_TABS: Filter[] = ["failed", "stopped", "superseded"];
const FILTERS: Filter[] = [...CARD_TABS, ...OTHER_TABS];
const isFilter = (v: string | null): v is Filter => !!v && (FILTERS as string[]).includes(v);

const FILTER_LABEL: Record<Filter, string> = { waiting: "Waiting", tooling: "Our tooling", held: "Not asked yet", running: "Running", empty: "Nothing left", failed: "Failed", stopped: "Stopped", answered: "Answered", closed: "Closed", all: "All", superseded: "Superseded" };

/** Run lists: failed runs, and runs that gave up at a failure station with the problem still open. */
const RUN_FILTERS = new Set<Filter>(["failed", "stopped"]);
/** An open expectation proposal's row id in the Our tooling list. */
const xpId = (p: ExpectationProposalView) => `xp:${p.short_id}`;
/** A failed run, and its rerun until that one settles: the Failed list. */
const inFailedList = (r: TrialRunRow) => r.status === "failed" || (r.fresh_branch && (r.status === "pending" || r.status === "running"));

const stationName = trialStationName;

/** Why a run stopped, in a station's words: "max_visits=2 exceeded on prove" reads "Prove: 2 rounds, still red". */
export function failWords(reason: string | null, lost?: TrialRunRow["lost_at_gate"]): string {
  if (lost) return `Lost its place at the ${lost.kind === "card" ? "change card" : "proposal"} (${lost.card})`;
  if (!reason) return "Stopped without a reason";
  const rounds = /max_visits=(\d+) exceeded on (\w+)/.exec(reason);
  if (rounds) return `${stationName(rounds[2])}: ${rounds[1]} rounds, never passed`;
  const killed = /killed after (\w+) at (\w+)/.exec(reason);
  if (killed) return `${stationName(killed[2])}: stopped after ${killed[1]}`;
  return reason;
}

const usd = (n: number) => (n >= 100 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(2)}`);

const STATE_TONE: Record<TrialCardRow["status"], string> = { waiting: "bg-sol-yellow", answered: "bg-sol-green", closed: "bg-sol-text-dim/40" };

/** /line with nothing named: the workspace /line itself reads (useLineSpace). */
const LINE_HOME = readLineSelection(null);

/** The workspace /trial reads: the one its address names (trialHref `ws`) when the viewer is in it, so a Trial tag on
 *  a team's decision opens that team's trial; else the one /line reads (useLineSpace: last picked, else busiest), and
 *  when that one holds no trial project, the next of the line's workspaces that does. A pick here is the line's pick. */
export function TrialReviewPage() {
  const address = trialAddress(useSearchParams());
  const viewerId = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  const teamIds = useInboxStore((s) => ((s.teams ?? []) as Array<{ _id?: string } | null>).map((t) => String(t?._id ?? "")).join(","));
  const asked = ownWorkspace(address.ws, viewerId, teamIds ? teamIds.split(",") : []);
  const space = useLineSpace(LINE_HOME);
  const [picked, setPicked] = useState<string | null>(null);
  // Line workspaces read and found holding no trial project: passed over while nobody chose one.
  const [noTrial, setNoTrial] = useState<string[]>([]);
  const auto = [space.key, ...space.spaces.map((x) => x.key)].find((k) => !!k && !noTrial.includes(k)) ?? space.key;
  const scope = picked ?? asked ?? auto;
  const pick = (key: string) => {
    space.pick(key);
    setPicked(key);
    const url = new URL(window.location.href);
    url.searchParams.set("ws", key);
    for (const k of ["project", "card", "tab"]) url.searchParams.delete(k);
    window.history.replaceState(window.history.state, "", url);
  };
  const searching = !picked && !asked && !!scope && !noTrial.includes(scope) ? () => setNoTrial((was) => (was.includes(scope) ? was : [...was, scope])) : undefined;
  return (
    <WorkspaceScopeProvider value={scope}>
      <TrialReview key={scope ?? ""} askedProject={address.project} from={address.from} spaces={space.spaces} scope={scope} onPick={pick} onNoTrial={searching} />
    </WorkspaceScopeProvider>
  );
}

type Spaces = ReturnType<typeof useLineSpace>["spaces"];

function TrialReview({ askedProject, from, spaces, scope, onPick, onNoTrial }: { askedProject: string | null; from: string | null; spaces: Spaces; scope: string | null; onPick: (key: string) => void; onNoTrial?: () => void }) {
  const { ready } = useSyncTrial();
  // This workspace's projects arrived and none is a trial: the page moves on to the next line workspace (TrialReviewPage).
  // The store is read here, after the feeder's own effect has synced the answer in.
  useWatchEffect(() => {
    if (!ready || !onNoTrial) return;
    const rows = Object.values(((useInboxStore.getState() as { trialProjects?: Record<string, { workspace?: string }> }).trialProjects) ?? {});
    if (!rows.some((p) => p?.workspace === scope)) onNoTrial();
  }, [ready, onNoTrial, scope]);
  // Superseded cards (line-versions.md LV1) leave every lane and count; their own tab brings them back.
  const every = useTrialCards({ all: true });
  const cards = useMemo(() => every.filter((c) => !c.superseded), [every]);
  const runs = useTrialRuns();
  const projects = useTrialProjects();
  // The project the address names (its row id or short id), else the first.
  const [projectId, setProjectId] = useState<string | null>(askedProject);
  const project = projects.find((p) => p._id === projectId || (!!p.short_id && p.short_id === projectId)) ?? projects[0] ?? null;
  const teams = useInboxStore((s) => s.teams);
  const viewerId = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  const appWorkspace = useInboxStore(activeWorkspaceKeyOf);
  const elsewhere = useMemo(() => {
    const ws = project?.workspace;
    if (!ws || ws === appWorkspace || spaces.some((x) => x.key === ws)) return null;
    const [kind, id] = [ws.slice(0, ws.indexOf(":")), ws.slice(ws.indexOf(":") + 1)];
    return kind === "user" && id === viewerId ? "Personal" : kind === "team" || kind === "user" ? workspaceDisplayName({ kind, id }, teams, viewerId) : null;
  }, [project?.workspace, appWorkspace, teams, viewerId, spaces]);
  useSyncTrialSpend(project?._id ?? null);
  const spend = useTrialSpend(project?._id ?? null);
  const now = useCoarseNow(30_000);
  // Its dispatcher holds (runs used, spend cap): the problems it would start wait under Problems › Not started.
  const dispatchHeld = project ? dispatchHold(project.dispatch) : null;
  // The limits that refuse a new run here too (lineTrial rerunRefusal): its runs used, its spend cap.
  const runLimit = trialRunLimit(project?.dispatch?.held);

  const inProject = useMemo(() => (project ? cards.filter((c) => c.project_id === project._id) : cards), [cards, project]);
  const replaced = useMemo(() => every.filter((c) => c.superseded && (!project || c.project_id === project._id)), [every, project]);
  const failedRuns = useMemo(() => runs.filter((r) => (!project || r.project_id === project._id) && inFailedList(r)), [runs, project]);
  // Stopped: most findings left first; one with none left is last, since nothing stands behind a rerun.
  const stoppedRuns = useMemo(() => runs.filter((r) => (!project || r.project_id === project._id) && r.stopped).sort((a, b) => (b.stopped!.findings - a.stopped!.findings) || b.updated_at - a.updated_at), [runs, project]);
  useSyncProjectExpectations(project?._id ?? null);
  const expectations = useProjectExpectations(project?._id ?? null);
  // A proposal a station asked as its trial decision is listed once, as that decision's card.
  const proposals = useMemo(() => {
    const carded = new Set(every.map((c) => c.decision?.short_id).filter(Boolean));
    return openProposals(expectations).filter((p) => p.short_id && !(p.card && carded.has(p.card)));
  }, [expectations, every]);
  const failedByTask = useMemo(() => new Map(runs.filter((r) => r.status === "failed").map((r) => [r.task_short_id, r])), [runs]);
  const counts = useMemo(() => ({
    failed: failedRuns.filter((r) => r.status === "failed").length,
    stopped: stoppedRuns.length,
    waiting: inProject.filter((c) => trialCardTab(c) === "waiting").length,
    tooling: inProject.filter((c) => trialCardTab(c) === "tooling").length + proposals.length,
    held: inProject.filter((c) => trialCardTab(c) === "held").length,
    running: inProject.filter((c) => trialCardTab(c) === "running").length,
    empty: inProject.filter((c) => trialCardTab(c) === "empty").length,
    answered: inProject.filter((c) => trialCardTab(c) === "answered").length,
    closed: inProject.filter((c) => trialCardTab(c) === "closed").length,
    all: inProject.length + proposals.length,
    superseded: replaced.length,
  }), [inProject, replaced, failedRuns, stoppedRuns, proposals]);
  // A problem page links straight to its card (/trial?card=tc-N).
  const linked = useSearchParams()?.get("card") ?? null;
  const linkedRow = linked ? inProject.find((c) => c.short_id === linked) ?? every.find((c) => c.short_id === linked) ?? null : null;
  // The tab is in the address (`tab`), so a list can be linked and reloaded; without one, the linked card's own lane, else Waiting.
  const askedTab = useSearchParams()?.get("tab") ?? null;
  const [chosen, setChosen] = useState<Filter | null>(isFilter(askedTab) ? askedTab : null);
  const filter: Filter = chosen ?? (linkedRow ? (linkedRow.superseded ? "superseded" : trialCardTab(linkedRow)) : "waiting");
  const setFilter = (f: Filter) => {
    setChosen(f);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", f);
    window.history.replaceState(window.history.state, "", url);
  };
  const shown = useMemo(() => (filter === "superseded" ? replaced : filter === "all" ? inProject : RUN_FILTERS.has(filter) ? [] : inProject.filter((c) => trialCardTab(c) === filter)), [inProject, replaced, filter]);
  // A problem's cards are one row: its newest leads, the earlier ones listed under it.
  const groups = useMemo(() => cardsByProblem(shown), [shown]);
  const [selectedId, setSelectedId] = useState<string | null>(linkedRow?._id ?? null);
  // The open card is in the address, so it can be linked, shared and reloaded.
  const openCard = (c: TrialCardRow | null) => {
    setSelectedId(c?._id ?? null);
    const url = new URL(window.location.href);
    if (c) url.searchParams.set("card", c.short_id);
    else url.searchParams.delete("card");
    window.history.replaceState(window.history.state, "", url);
  };
  // Conversations behind each card's problem, counted once per moment: the row's size.
  useSyncSignals(project?.workspace ?? null);
  const signals = useWorkspaceSignals(project?.workspace ?? null);
  const sizes = useMemo(() => {
    const by = new Map<string, Set<string>>();
    for (const sg of signals) if (sg.task_id) (by.get(sg.task_id) ?? by.set(sg.task_id, new Set()).get(sg.task_id)!).add(findingConversation(sg));
    return by;
  }, [signals]);
  // Findings each problem drew in the last 7d, on the window Problems' "Findings 7d" column reads (problemsOverview).
  const weekByTask = useMemo(() => {
    const from = overviewWindow("7d", now).d0;
    const by = new Map<string, number>();
    for (const sg of signals) if (sg.task_id && (sg.observed_at ?? sg.created_at) >= from) by.set(sg.task_id, (by.get(sg.task_id) ?? 0) + 1);
    return by;
  }, [signals, now]);
  const owed = inProject.some((c) => c.status === "waiting" && c.card && !evidenceGone(c.evidence) && evalsOwed(c.card));
  const runList = filter === "failed" ? failedRuns : filter === "stopped" ? stoppedRuns : [];
  const shownProposals = filter === "tooling" || filter === "all" ? proposals : [];
  const selectedProposal = shownProposals.find((p) => xpId(p) === selectedId) ?? (selectedId === null && !shown.length ? shownProposals[0] : null) ?? null;
  // A card answered or moved elsewhere while open stays open, with what happened to it, instead of the list swapping it out.
  const selected = RUN_FILTERS.has(filter) || selectedProposal ? null : shown.find((c) => c._id === selectedId) ?? (selectedId ? inProject.find((c) => c._id === selectedId) ?? replaced.find((c) => c._id === selectedId) : null) ?? (selectedId === null ? linkedRow : null) ?? shown[0] ?? null;
  const selectedLeft = !!selected && !shown.some((c) => c._id === selected._id);
  const selectedRun = RUN_FILTERS.has(filter) ? runList.find((r) => r._id === selectedId) ?? runList[0] ?? null : null;

  return (
    <div className="flex h-full min-h-0 flex-col" data-trial-page>
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-sol-border/40 px-5 py-3">
        <div className="flex items-baseline gap-2">
          {/* Opened from /line, the way back to the item it was opened on. */}
          {from && <Link href={from} className="mr-1 inline-flex items-center gap-1 self-center text-[12px] text-sol-text-muted hover:text-sol-text" data-trial-back><ArrowLeft className="h-3.5 w-3.5" />{lineFromName(from)}</Link>}
          <h1 className="text-[15px] font-semibold text-sol-text">Trial</h1>
          {/* The line's workspaces: the trial read is one of them, and any other is a pick away. */}
          {spaces.length > 1 ? (
            <select value={scope ?? ""} onChange={(e) => onPick(e.target.value)} className="rounded border border-sol-border/50 bg-transparent px-1.5 py-0.5 text-[12px] text-sol-text" aria-label="Workspace" data-trial-space>
              {!spaces.some((x) => x.key === scope) && <option value={scope ?? ""}>{elsewhere ?? "This workspace"}</option>}
              {spaces.map((x) => <option key={x.key} value={x.key}>{x.name}</option>)}
            </select>
          ) : spaces[0] && spaces[0].key === scope ? <span className="text-[12px] text-sol-text-muted" data-trial-space>{spaces[0].name}</span> : null}
          {projects.length > 1 ? (
            <select value={project?._id ?? ""} onChange={(e) => { setProjectId(e.target.value); openCard(null); }} className="rounded border border-sol-border/50 bg-transparent px-1.5 py-0.5 text-[12px] text-sol-text" data-trial-project>
              {projects.map((p) => <option key={p._id} value={p._id}>{p.title}</option>)}
            </select>
          ) : project ? <span className="text-[12px] text-sol-text-muted" data-trial-project>{project.title}</span> : null}
          {/* A trial read outside the app's workspace names whose it is. */}
          {elsewhere && spaces.length < 2 && <span className="text-[12px] text-sol-text-dim" data-trial-workspace>{elsewhere}</span>}
        </div>
        {owed && <span className="rounded border border-sol-yellow/40 px-1.5 py-0.5 text-[11px] text-sol-yellow" title="The trial never runs a change's evals: they write to the database they point at. A card that owes them says so beside its answer." data-trial-evals>Evals not run in the trial</span>}
        {/* Whether the dispatcher is held and by which limit, the act that lifts it, and the spend against its cap. */}
        <TrialLimitsBar spend={spend} project={project} held={dispatchHeld} heldHref={project ? `/line?view=problems&status=notstarted&project=${encodeURIComponent(lineFilterParam(project, projects))}` : null} />
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[20rem] shrink-0 flex-col border-r border-sol-border/40" data-trial-list>
          <div className="px-3 py-2" role="tablist">
            {/* Card tabs, which add up to All; then runs that ended with no card and replaced cards, which All does not hold. */}
            {[CARD_TABS, OTHER_TABS].map((tabs, i) => {
              const showing = tabs.filter((f) => f === "waiting" || f === "held" || f === "all" || counts[f] > 0 || filter === f);
              return showing.length > 0 && (
                <div key={i} className={cn("flex flex-wrap gap-1", i === 1 && "mt-1 border-t border-sol-border/30 pt-1")} data-trial-tabs={i === 0 ? "cards" : "other"}>
                  {showing.map((f) => (
                    <button
                      key={f}
                      type="button"
                      role="tab"
                      aria-selected={filter === f}
                      onClick={() => { setFilter(f); openCard(null); }}
                      className={cn("rounded px-2 py-1 text-[12px] tabular-nums transition-colors", filter === f ? "bg-sol-bg-alt text-sol-text" : "text-sol-text-dim hover:text-sol-text")}
                      data-trial-filter={f}
                    >
                      {f === "failed" || f === "stopped" ? `${FILTER_LABEL[f]} runs` : FILTER_LABEL[f]} <span className={cn("ml-0.5", f === "waiting" && counts.waiting ? "text-sol-yellow" : f === "failed" && counts.failed ? "text-sol-red" : f === "stopped" && counts.stopped ? "text-sol-orange" : f === "running" && counts.running ? "text-sol-blue" : "opacity-60")}>{counts[f]}</span>
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
          {filter === "empty" && shown.length > 0 && <DropAll cards={shown} />}
          <ul className="min-h-0 flex-1 overflow-y-auto">
            {runList.map((r) => <FailedRunRow key={r._id} run={r} week={weekByTask.get(r._id) ?? 0} selected={selectedRun?._id === r._id} now={now} onSelect={() => setSelectedId(r._id)} />)}
            {shownProposals.map((p) => <ProposalRow key={xpId(p)} p={p} selected={selectedProposal?.short_id === p.short_id} now={now} onSelect={() => setSelectedId(xpId(p))} />)}
            {groups.map(([c, ...earlier]) => (
              <li key={c._id} data-trial-group={c.task_short_id}>
                <button
                  type="button"
                  onClick={() => openCard(c)}
                  className={cn("grid w-full grid-cols-[0.5rem_1fr_auto] items-start gap-x-2.5 border-l-2 px-3 py-2.5 text-left transition-colors", c.superseded && "opacity-60", selected?._id === c._id ? "border-sol-blue bg-sol-bg-alt/60" : "border-transparent hover:bg-sol-bg-alt/30")}
                  data-trial-card={c.short_id}
                >
                  <span className={cn("mt-1.5 h-2 w-2 rounded-full", STATE_TONE[c.status])} />
                  <span className="min-w-0">
                    {/* The problem by the one name every list gives it (problemListName); the fix it proposes under it. */}
                    <span className="line-clamp-2 text-[12.5px] leading-snug text-sol-text" data-trial-problem>{problemListName({ title: c.task_title, name: c.task_name })}</span>
                    {(c.card?.headline || c.proposal?.question) && <span className="mt-0.5 block truncate text-[11.5px] text-sol-text-muted" data-trial-fix>{c.card?.headline || c.proposal?.question}</span>}
                    <span className="mt-1 flex items-center gap-1.5 text-[11px] text-sol-text-dim">
                      <span className="shrink-0 font-mono">{c.short_id}</span>
                      {!c.superseded && <RowVerdict card={c} />}
                      {!c.superseded && <RowSize card={c} counted={sizes.get(c.task_id)?.size ?? 0} />}
                      <RowState card={c} />
                    </span>
                  </span>
                  <span className="text-[11px] tabular-nums text-sol-text-dim">{formatTimeAgo(c.created_at, now)}</span>
                </button>
                {/* The same problem's earlier cards, newest first: each opens, and none reads as the current one. */}
                {earlier.length > 0 && (
                  <ul className="pb-1.5 pl-8 pr-3" data-trial-earlier>
                    {earlier.map((x) => (
                      <li key={x._id}>
                        <button type="button" onClick={() => openCard(x)} className={cn("flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-[11px] text-sol-text-dim hover:bg-sol-bg-alt/30 hover:text-sol-text", selected?._id === x._id && "bg-sol-bg-alt/60 text-sol-text")} data-trial-card={x.short_id}>
                          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATE_TONE[x.status])} />
                          <span className="shrink-0 font-mono">{x.short_id}</span>
                          <span className="shrink-0">{x.kind === "card" ? "Change" : "Proposal"}</span>
                          <RowState card={x} />
                          <span className="ml-auto shrink-0 tabular-nums">{formatTimeAgo(x.created_at, now)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
            {(RUN_FILTERS.has(filter) ? runList.length === 0 : shown.length + shownProposals.length === 0) && (
              <li className="px-4 py-6 text-[12px] text-sol-text-dim">
                {(!ready || (onNoTrial && !projects.length)) && cards.length === 0 ? "Reading the trial's cards…" : filter === "waiting" ? "Nothing waits on you." : filter === "empty" ? "Every waiting card still has evidence." : filter === "failed" ? "No failed runs." : filter === "stopped" ? "No stopped runs." : filter === "held" ? "Every card is asked." : filter === "running" ? "No rebuild running." : filter === "tooling" ? "No review-tooling changes." : filter === "superseded" ? "Nothing superseded." : filter === "closed" ? "No closed cards." : "No cards yet."}
              </li>
            )}
          </ul>
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto" data-main-scroll>
          {selectedProposal && expectations && project ? <ExpectationProposalPane key={xpId(selectedProposal)} projectId={project._id} row={expectations} p={selectedProposal} /> : selectedRun ? <FailedRunPane key={selectedRun._id} run={selectedRun} week={weekByTask.get(selectedRun._id) ?? 0} runLimit={runLimit} cards={inProject.filter((c) => c.task_short_id === selectedRun.task_short_id)} now={now} onOpenCard={(id) => { setFilter("all"); openCard(inProject.find((c) => c._id === id) ?? null); }} /> : selected ? <TrialCardPane key={selected._id} card={selected} now={now} left={selectedLeft ? { lane: trialLane(selected), next: inProject.find((x) => x.run_id === selected.run_id && x.created_at > selected.created_at && x._id !== selected._id) ?? null, onOpen: (x) => { setFilter(trialCardTab(x)); openCard(x); } } : null} /> : (
            <div className="px-8 py-10 text-[12.5px] text-sol-text-dim">{projects.length ? "Pick a card." : !ready || onNoTrial ? "Finding the trial…" : `No trial project in ${spaces.find((x) => x.key === scope)?.name ?? elsewhere ?? "this workspace"}.`}</div>
          )}
        </main>
      </div>
    </div>
  );
}

/** The cards whose problems have nothing left, dropped in one press; each records Drop with the reason. */
function DropAll({ cards }: { cards: TrialCardRow[] }) {
  const trialAnswer = useInboxStore((s) => s.trialAnswer);
  const drops = cards.flatMap((c) => {
    const o = c.options.find((x) => verdictOfOption(x.label) === "drop") ?? c.options.find((x) => x.key === "D");
    return o ? [{ c, key: o.key }] : [];
  });
  if (!drops.length) return null;
  return (
    <div className="flex items-center gap-2 border-b border-sol-border/30 px-3 pb-2 text-[11.5px] text-sol-text-dim" data-trial-drop-all>
      <span className="min-w-0 flex-1">No finding left behind {drops.length === 1 ? "this fix" : `these ${drops.length} fixes`}</span>
      <button
        type="button"
        onClick={() => { for (const d of drops) trialAnswer(d.c._id, d.key, "No current evidence"); }}
        className="shrink-0 rounded-md px-2.5 py-1 font-medium text-sol-red ring-1 ring-sol-red/40 transition-colors hover:bg-sol-red/10"
      >Drop all {drops.length}</button>
    </div>
  );
}

/** A station that ended with no words of its own leaves only its session's state (the failure station's comment,
 *  "work_state: needs_input"): its real account is the handoff its session filed on the problem (StationReport). */
const sessionStateOnly = (words: string) => /^work_state: \w+$/.test(words.trim());
const SESSION_END: Record<string, string> = { needs_input: "Its session stopped and filed no report", working: "Its session ended mid-work and filed no report" };
const stopText = (words: string) => SESSION_END[/^work_state: (\w+)$/.exec(words.trim())?.[1] ?? ""] ?? words;

/** What the giving-up station's session reported when it stopped: its handoff on the problem, whole. */
function StationReport({ report, fallback }: { report: string | null | undefined; fallback: string }) {
  if (!report) return <div className="mt-0.5 text-[12px] text-sol-text-muted">{report === null ? fallback : "Reading its report…"}</div>;
  return <div className="mt-3 border-t border-sol-orange/20 pt-3 text-[13px]" data-trial-station-report><MarkdownRenderer content={outcomeLineInWords(report)} /></div>;
}

/** The findings still on a stopped run's problem: all of them, and the last 7d as Problems' Findings 7d counts them. */
const findingsWords = (all: number, week: number) => (all ? `${all} ${all === 1 ? "finding" : "findings"} · ${week} in 7d` : "no finding left");

/** A stopped run's line: the station that gave up and the findings still on the problem. */
const stopWords = (r: TrialRunRow, week: number) => (r.stopped ? `${stationName(r.stopped.station)} · ${findingsWords(r.stopped.findings, week)}` : "");

function FailedRunRow({ run: r, week, selected, now, onSelect }: { run: TrialRunRow; week: number; selected: boolean; now: number; onSelect: () => void }) {
  const failed = r.status === "failed";
  const stopped = !!r.stopped;
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={cn("grid w-full grid-cols-[0.5rem_1fr_auto] items-start gap-x-2.5 border-l-2 px-3 py-2.5 text-left transition-colors", selected ? "border-sol-blue bg-sol-bg-alt/60" : "border-transparent hover:bg-sol-bg-alt/30")}
        data-trial-failed-run={r.task_short_id}
      >
        <span className={cn("mt-1.5 h-2 w-2 rounded-full", failed ? "bg-sol-red" : stopped ? "bg-sol-orange" : "animate-pulse bg-sol-blue")} />
        <span className="min-w-0">
          <span className="block truncate text-[12.5px] text-sol-text">{problemListName({ title: r.task_title, name: r.task_name })}</span>
          <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-sol-text-dim">
            <span className={cn("shrink-0 rounded px-1", failed ? "bg-sol-red/15 text-sol-red" : stopped ? "bg-sol-orange/15 text-sol-orange" : "bg-sol-blue/15 text-sol-blue")}>{failed ? "Failed" : stopped ? "Stopped" : "Rerunning"}</span>
            <span className="shrink-0 whitespace-nowrap font-mono">{r.task_short_id}</span>
            <span className="truncate">{failed ? failWords(r.fail_reason, r.lost_at_gate) : stopped ? stopWords(r, week) : stationName(r.node_id)}</span>
          </span>
        </span>
        <span className="text-[11px] tabular-nums text-sol-text-dim">{formatTimeAgo(r.updated_at, now)}</span>
      </button>
    </li>
  );
}

/** A failed run: where it stopped, why, the cards it left, and the rerun (lineTrial.rerun, from a fresh branch). */
function FailedRunPane({ run: r, week, runLimit, cards, now, onOpenCard }: { run: TrialRunRow; week: number; runLimit: string | null; cards: TrialCardRow[]; now: number; onOpenCard: (id: string) => void }) {
  const trialRerun = useInboxStore((s) => s.trialRerun);
  const failed = r.status === "failed";
  const stop = r.stopped;
  return (
    <article className="decision-doc mx-auto max-w-5xl px-6 pb-16 pt-5" data-trial-run-pane={r.task_short_id}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-sol-text-dim">
        <span className={failed ? "text-sol-red" : stop ? "text-sol-orange" : "text-sol-blue"}>{failed ? `Failed ${formatTimeAgo(r.updated_at, now)}` : stop ? `Stopped ${formatTimeAgo(r.updated_at, now)} · no card, problem still open` : `Rerunning · ${stationName(r.node_id)}`}</span>
        <Link href={`/tasks/${r.task_short_id}`} className="inline-flex items-center gap-1 hover:text-sol-text">the problem <ExternalLink className="h-3 w-3" /></Link>
        <Link href={`/workflows/runs/${r.run_id}`} className="ml-auto inline-flex items-center gap-1 opacity-70 hover:text-sol-text hover:opacity-100">the run <ExternalLink className="h-3 w-3" /></Link>
      </div>
      <h1 className="decision-question mt-3 text-sol-text">{problemListName({ title: r.task_title, name: r.task_name })}</h1>
      {failed && (
        <section className="mt-5 flex flex-wrap items-center gap-4 rounded-md border border-sol-red/30 bg-sol-red/5 px-4 py-3">
          <div className="min-w-0 flex-1" title={r.fail_reason ?? undefined}>
            <div className="text-[13px] font-medium text-sol-text">{failWords(r.fail_reason, r.lost_at_gate)}</div>
            {!r.lost_at_gate && r.fail_reason && failWords(r.fail_reason) !== r.fail_reason && <div className="mt-0.5 font-mono text-[11px] text-sol-text-dim">{r.fail_reason}</div>}
          </div>
          <button
            type="button"
            onClick={() => trialRerun(r._id)}
            className="inline-flex items-center gap-1.5 rounded-md bg-sol-blue px-3 py-1.5 text-[12.5px] font-medium text-sol-bg transition-opacity hover:opacity-90"
            data-trial-rerun={r.task_short_id}
          >
            <RotateCcw className="h-3.5 w-3.5" /> {r.lost_at_gate ? `Pick up at ${r.lost_at_gate.card}` : "Rerun from main"}
          </button>
        </section>
      )}
      {stop && <StoppedBand run={r} week={week} runLimit={runLimit} />}
      {cards.length > 0 && (
        <ul className="mt-6 divide-y divide-sol-border/30 border-y border-sol-border/30 text-[12px]">
          {cards.map((c) => (
            <li key={c._id} className="flex items-center gap-2 py-2">
              <span className={cn("rounded px-1 text-[11px]", c.kind === "card" ? "bg-sol-blue/15 text-sol-blue" : "bg-sol-violet/15 text-sol-violet")}>{c.kind === "card" ? "Change" : "Proposal"}</span>
              <button type="button" onClick={() => onOpenCard(c._id)} className="min-w-0 flex-1 truncate text-left text-sol-text hover:underline">{c.card?.headline || c.question}</button>
              {c.answer && <span className={answerTone(c)}>{c.answer.label} <span className="text-sol-text-dim">{answererWords(c)}</span></span>}
              <span className="tabular-nums text-sol-text-dim">{formatTimeAgo(c.created_at, now)}</span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

/** A run that stopped at a failure step: the station that gave up, the findings still on the problem, its report whole,
 *  and what a person does next. When the station says its approach did not work, a rerun of the same approach is not
 *  offered: the acts are a new approach (the report rides along) and closing the problem. */
function StoppedBand({ run: r, week, runLimit }: { run: TrialRunRow; week: number; runLimit: string | null }) {
  const stop = r.stopped!;
  const own = stop.words && !sessionStateOnly(stop.words) ? stop.words : null;
  const report = useStationReport(r.task_short_id);
  const failedApproach = approachFailed(report);
  const station = stationName(stop.station);
  return (
    <section className="mt-5 rounded-md border border-sol-orange/30 bg-sol-orange/5 px-4 py-3" data-trial-stopped={r.task_short_id} data-trial-stop-outcome={failedApproach ? "strategy_fails" : undefined}>
      <div className="flex flex-wrap items-center gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 text-[13px] font-medium text-sol-text">
            {failedApproach ? `${station}: the approach did not work` : `${station} gave up`}
            <span className={cn("text-[12px] font-normal tabular-nums", stop.findings ? "text-sol-orange" : "text-sol-text-dim")} title="Problems' Findings 7d counts the last 7d" data-trial-stop-findings>{findingsWords(stop.findings, week)}</span>
          </div>
          {own && <div className="mt-0.5 text-[12px] text-sol-text-muted">{own}</div>}
        </div>
        <div className="flex items-center gap-2"><TrialStopActs run={r} runLimit={runLimit} week={week} look="band" /></div>
      </div>
      {!own && <StationReport report={report} fallback={stop.words ? stopText(stop.words) : "It said nothing"} />}
    </section>
  );
}

/** What became of a card: its answer and who gave it, the line version that replaced it, or closed and where its run went. */
function RowState({ card: c }: { card: TrialCardRow }) {
  if (c.superseded) return <SupersededNote superseded={c.superseded} />;
  if (c.answer) return <><span className={answerTone(c)}>{c.answer.label}</span><span className="truncate" data-trial-answerer>{answererWords(c)}</span></>;
  if (c.status === "closed" && !c.rebuilding) return <span className="truncate">{c.superseded_by ? `closed → ${c.superseded_by.card ?? c.superseded_by.task}` : "closed"}</span>;
  return null;
}

const VERDICT_INK = { ship: "text-sol-green", revise: "text-sol-yellow", drop: "text-sol-red" } as const;

/** The conversations behind a card's problem now: the server's live count, else the store's. */
function RowSize({ card: c, counted }: { card: TrialCardRow; counted: number }) {
  const n = c.evidence ? c.evidence.conversations : counted;
  // An emptied problem's verdict already reads "Drop: evidence gone" in red.
  if (c.evidence && evidenceGone(c.evidence)) return null;
  return n ? <span className="tabular-nums" title="Conversations behind the problem now">{n} conv</span> : null;
}

/** A row's lead mark: a change card's recommended answer in its color with a red count when checks fail; a gate's kind. */
function RowVerdict({ card: row }: { card: TrialCardRow }) {
  const card = cardAsRead(row);
  // The lane decides the mark: a card with nothing left reads as its drop, never as a build or a hold it no longer has.
  if (trialLane(row) === "empty") return <span className="font-medium text-sol-red" data-row-verdict="drop">{emptyWords(row)}</span>;
  if (trialLane(row) === "running") return <span className="inline-flex items-center gap-1 font-medium text-sol-blue" data-row-hold="running"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sol-blue" />{trialHold(row)?.words}</span>;
  const hold = trialHold(row);
  if (hold) return <span className="font-medium text-sol-yellow" data-row-hold={hold.kind}>{hold.words}</span>;
  if (!card) {
    const unfounded = row.status === "waiting" ? proposalUnfounded(row) : null;
    if (unfounded) return <span className="font-medium text-sol-red" data-row-verdict="drop">{unfounded}</span>;
    const rec = row.proposal?.recommend;
    return (
      <>
        <span className={cn("rounded px-1", row.tooling ? "bg-sol-cyan/15 text-sol-cyan" : "bg-sol-violet/15 text-sol-violet")}>{row.tooling ? (row.tooling === "judge" ? "Judge" : "Extractor") : "Proposal"}</span>
        {rec && <span className={cn("font-medium", `text-sol-${PROPOSAL_VERDICT_TONE[rec.verdict]}`)} title={rec.why} data-row-verdict={rec.verdict}>{PROPOSAL_VERDICT_WORD[rec.verdict]}</span>}
      </>
    );
  }
  const v = card.recommend.verdict;
  const failing = cardFailing(card);
  const gone = evidenceGone(row.evidence);
  return (
    <>
      <span className={cn("font-medium", VERDICT_INK[v] ?? "")} data-row-verdict={v}>{gone ? "Drop: evidence gone" : verdictLabel(v)}</span>
      {/* The card's own word leads; the evals the trial never runs are a fact beside it, as the card's Checks count them. */}
      {!gone && v === "ship" && evalsOwed(card) && <span className="text-sol-yellow" title={(row.evals_owed ?? []).length ? `Evals owed, not run in the trial: ${row.evals_owed!.join(", ")}` : "Evals owed, not run in the trial"} data-row-evals>evals not run</span>}
      {failing > 0 && <span className="inline-flex items-center gap-1 text-sol-red" title={`${failing} failing ${failing === 1 ? "check" : "checks"}`} data-row-red><span className="h-1.5 w-1.5 rounded-full bg-sol-red" />{failing}</span>}
    </>
  );
}

/** An open expectation proposal in Our tooling: a change to the lines the judges grade against. */
function ProposalRow({ p, selected, now, onSelect }: { p: ExpectationProposalView; selected: boolean; now: number; onSelect: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={cn("grid w-full grid-cols-[0.5rem_1fr_auto] items-start gap-x-2.5 border-l-2 px-3 py-2.5 text-left transition-colors", selected ? "border-sol-blue bg-sol-bg-alt/60" : "border-transparent hover:bg-sol-bg-alt/30")}
        data-trial-proposal={p.short_id}
      >
        <span className="mt-1.5 h-2 w-2 rounded-full bg-sol-yellow" />
        <span className="min-w-0">
          <span className="line-clamp-2 text-[12.5px] leading-snug text-sol-text">{p.summary}</span>
          <span className="mt-1 flex items-center gap-1.5 text-[11px] text-sol-text-dim">
            <span className="rounded bg-sol-cyan/15 px-1 text-sol-cyan">Expectations</span>
            <span className="font-mono">{p.short_id}</span>
            <span className="tabular-nums">{p.changes} {p.changes === 1 ? "change" : "changes"}</span>
            {p.refused && <span className="text-sol-orange">cannot apply</span>}
          </span>
        </span>
        <span className="text-[11px] tabular-nums text-sol-text-dim">{formatTimeAgo(p.created_at, now)}</span>
      </button>
    </li>
  );
}

function ExpectationProposalPane({ projectId, row, p }: { projectId: string; row: ProjectExpectationsRow; p: ExpectationProposalView }) {
  const byId = useMemo(() => new Map((row.doc?.items ?? []).map((e) => [e.id, e])), [row.doc?.items]);
  return (
    <article className="decision-doc mx-auto max-w-5xl px-6 pb-16 pt-5" data-trial-proposal-pane={p.short_id}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-sol-text-dim">
        <span className="text-sol-text-muted">Our review tooling: the expectations judges grade against, version {row.current_version}</span>
        <Link href={`/projects/${projectId}?tab=expectations`} className="ml-auto inline-flex items-center gap-1 opacity-70 hover:text-sol-text hover:opacity-100">all expectations <ExternalLink className="h-3 w-3" /></Link>
      </div>
      <div className="mt-3">
        <Proposal projectId={projectId} row={row} p={p} byId={byId} />
      </div>
    </article>
  );
}

/** The trial's header: whether its dispatcher is held and by which limit (runs started, billed money, quota), the act
 *  that lifts the first two through the confirm flow, then billed money against the cap and subscription use with its
 *  accounts' quota, two kinds that never add, each a press away from its parts. */
function TrialLimitsBar({ spend, project, held, heldHref }: { spend: TrialSpendRow | null; project: TrialProjectRow | null; held: ReturnType<typeof dispatchHold>; heldHref: string | null }) {
  const raise = useInboxStore((s) => s.trialRaiseLimits);
  const [pick, setPick] = useState<string | null>(null);
  const d = project?.dispatch;
  const limits: TrialLimits | null = d && spend ? { runs: spend.runs, maxRuns: d.max_runs, spent: spend.billed.usd, cap: d.cap_usd, perRun: spend.runs ? spend.billed.run_sessions.usd / spend.runs : 0 } : null;
  const hit = limits ? limitsHit(limits) : null;
  return (
    <div className="ml-auto flex items-center gap-4 text-[12px] tabular-nums text-sol-text-dim" data-trial-limits>
      {/* The hold leads, and opens the problems it keeps waiting. */}
      {held && heldHref && project && (d ? <TrialHeldLink projectId={project._id} href={heldHref} why={held.why} /> : <Link href={heldHref} title={held.why} className="font-semibold text-sol-yellow hover:underline" data-trial-dispatch-held>{held.short}</Link>)}
      {limits?.maxRuns != null && (
        <span className={hit?.runs ? "text-sol-yellow" : undefined} data-trial-runs data-hit={hit?.runs ? "" : undefined}>
          Runs <b className="font-semibold text-sol-text">{limits.runs}</b> of {limits.maxRuns}
        </span>
      )}
      {spend && <BilledFold spend={spend} cap={limits?.cap ?? null} over={!!hit?.spend} />}
      {spend && <SubscriptionFold spend={spend} />}
      {limits && project && (hit?.runs || hit?.spend) && (
        <button type="button" onClick={() => setPick(RAISE_PICKS[0])} aria-haspopup="dialog" className="rounded-md bg-sol-blue px-2.5 py-1 text-[12px] font-medium text-sol-bg hover:opacity-90" data-trial-raise>Raise the limits…</button>
      )}
      {pick && limits && project && (
        <SwitchReview
          ledger={raiseLimitsLedger({ project: project.title, limits, pick })}
          onPick={setPick}
          onClose={() => setPick(null)}
          onConfirm={() => { const next = raisedLimits(limits, Number(pick)); setPick(null); raise(project._id, next.maxRuns, next.cap); }}
        />
      )}
    </div>
  );
}

const PART_ROWS = "[&_td]:px-3 [&_td]:py-2 [&_tr]:border-b [&_tr]:border-sol-border/40";
const monthShort = (month: string) => new Date(`${month}-15`).toLocaleString("en-US", { month: "short" });
const tokenCount = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(0)}M` : `${Math.round(n / 1000)}k`);

/** Money the trial was billed, against the dispatcher's cap; pressed, each thing that billed it. */
function BilledFold({ spend, cap, over }: { spend: TrialSpendRow; cap: number | null; over: boolean }) {
  const b = spend.billed;
  const m = b.model;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={cn("hover:text-sol-text", over && "text-sol-red")} data-trial-billed data-over={over ? "" : undefined}>
          Billed <b className={cn("font-semibold", over ? "text-sol-red" : "text-sol-text")}>{usd(b.usd)}</b>{cap != null && <> of {usd(cap)}</>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[26rem] border-sol-border bg-sol-bg p-0 text-[12px] text-sol-text" data-trial-billed-parts>
        <table className="w-full tabular-nums">
          <tbody className={PART_ROWS}>
            <tr data-trial-billed-part="model">
              <td>Model calls<div className="text-[11px] text-sol-text-dim">{m.calls.toLocaleString("en-US")} calls · judge {usd(m.by_purpose.judge)} · calls {usd(m.by_purpose.call)} · grouping {usd(m.by_purpose.grouping)}</div><div className="text-[11px] text-sol-text-dim">team budget {monthShort(m.team_budget.month)} {usd(m.team_budget.spent_usd)} of {usd(m.team_budget.cap_usd)}{m.team_budget.refused ? ` · ${m.team_budget.refused} refused` : ""}</div></td>
              <td className="text-right align-top">{usd(m.usd)}</td>
            </tr>
            {b.keys.map((k) => (
              <tr key={k.billed_by} data-trial-billed-part={k.billed_by}>
                <td>
                  {k.billed_by}
                  <details className="text-[11px] text-sol-text-dim">
                    <summary className="cursor-pointer hover:text-sol-text">{k.entries} {k.entries === 1 ? "entry" : "entries"}</summary>
                    <ul className="mt-1 max-h-48 space-y-1 overflow-y-auto pr-1">
                      {spend.outside.filter((o) => o.billed_by === k.billed_by).map((o) => <li key={o.at} className="flex gap-2"><span className="shrink-0 text-sol-text-muted">{usd(o.usd)}</span><span className="min-w-0">{o.what}</span></li>)}
                    </ul>
                  </details>
                </td>
                <td className="text-right align-top">{usd(k.usd)}</td>
              </tr>
            ))}
            {b.run_sessions.sessions > 0 && (
              <tr data-trial-billed-part="run-keys">
                <td>Run sessions on API keys<div className="text-[11px] text-sol-text-dim">{b.run_sessions.sessions} sessions · {tokenCount(b.run_sessions.tokens)} tokens</div></td>
                <td className="text-right align-top">{usd(b.run_sessions.usd)}</td>
              </tr>
            )}
            <tr className="font-semibold">
              <td>Billed{cap != null && <span className="font-normal text-sol-text-dim"> · cap {usd(cap)}</span>}</td>
              <td className={cn("text-right", over && "text-sol-red")}>{usd(b.usd)}</td>
            </tr>
          </tbody>
        </table>
      </PopoverContent>
    </Popover>
  );
}

const quotaTone = (p: number | null) => (p == null ? "text-sol-text-dim" : p >= 100 ? "text-sol-red" : p >= USAGE_WARN_PERCENT ? "text-sol-yellow" : "text-sol-text");
const quotaFill = (p: number) => (p >= 100 ? "bg-sol-red" : p >= USAGE_WARN_PERCENT ? "bg-sol-yellow" : "bg-sol-green");

/** The line runs' subscription use: the tightest account's quota and the sessions; pressed, each account's windows and
 *  the tokens, with their API list price as an equivalent that was never billed. */
function SubscriptionFold({ spend }: { spend: TrialSpendRow }) {
  const sub = spend.subscription;
  const quota = spend.quota ?? [];
  const worst = quota.reduce<number | null>((w, q) => (q.percent == null ? w : Math.max(w ?? 0, q.percent)), null);
  const now = spend.at;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="hover:text-sol-text" data-trial-subscription>
          Quota <b className={cn("font-semibold", quotaTone(worst))}>{worst == null ? "?" : `${Math.round(worst)}%`}</b> · {sub.sessions} sessions
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[26rem] border-sol-border bg-sol-bg p-0 text-[12px] text-sol-text" data-trial-subscription-parts>
        {quota.map((q) => (
          <div key={`${q.device}:${q.provider}:${q.account}`} className="border-b border-sol-border/40 px-3 py-2" data-trial-quota={q.account}>
            <div className="flex items-baseline gap-2">
              <span className="font-medium">{q.account}</span>
              <span className="text-[11px] text-sol-text-dim">{q.provider === "claude" ? "Claude" : "Codex"} · {q.device}</span>
              {q.fetched_at != null && <span className="ml-auto text-[11px] text-sol-text-dim">{formatTimeAgo(q.fetched_at, now)}</span>}
            </div>
            <div className="mt-1.5 grid grid-cols-[6.5rem_1fr_2.5rem_4rem] items-center gap-x-2 gap-y-1 text-[11px] tabular-nums">
              {q.windows.map((w) => (
                <Fragment key={w.label}>
                  <span className="text-sol-text-muted">{w.label}</span>
                  <span className="h-1.5 overflow-hidden rounded-full bg-sol-border/40"><span className={cn("block h-full", quotaFill(w.percent))} style={{ width: `${Math.min(100, w.percent)}%` }} /></span>
                  <span className={cn("text-right", quotaTone(w.percent))}>{Math.round(w.percent)}%</span>
                  <span className="text-right text-sol-text-dim">{w.resets_at && w.resets_at > now ? formatCountdown(w.resets_at - now) : ""}</span>
                </Fragment>
              ))}
            </div>
          </div>
        ))}
        <table className="w-full tabular-nums">
          <tbody className={PART_ROWS}>
            <tr><td>Sessions</td><td className="text-right">{sub.sessions} in {spend.runs} runs</td></tr>
            <tr><td>Tokens{sub.unpriced_tokens > 0 && <div className="text-[11px] text-sol-text-dim">{tokenCount(sub.unpriced_tokens)} on unpriced models</div>}</td><td className="text-right align-top">{tokenCount(sub.tokens)}</td></tr>
            <tr className="text-sol-text-dim" data-trial-list-equivalent><td>At API list price<div className="text-[11px]">equivalent, not billed</div></td><td className="text-right align-top">{usd(sub.list_usd)}</td></tr>
          </tbody>
        </table>
      </PopoverContent>
    </Popover>
  );
}

/** A waiting card's state in the pane's header, by lane. */
const PANE_STATE: Record<"waiting" | "tooling" | "held" | "running" | "empty", (c: TrialCardRow) => string> = {
  waiting: () => "Waiting on you",
  tooling: (c) => `Our review tooling: the ${c.tooling === "extractor" ? "extractor" : "judge"}, not the product`,
  held: (c) => `Not asked yet · ${trialHold(c)?.words ?? ""}`,
  running: (c) => `Running · ${trialHold(c)?.words ?? "Rebuilding on main"}`,
  empty: (c) => (proposalUnfounded(c) ? `Nothing left · ${proposalUnfounded(c)}` : "Nothing left to fix"),
};

/** Where an open card went when it left the lane it was opened from: the lane it reads in now, and the card its run asked next. */
type LeftLane = { lane: TrialLaneName | null; next: TrialCardRow | null; onOpen: (c: TrialCardRow) => void };
type TrialLaneName = ReturnType<typeof trialLane>;

function TrialCardPane({ card: c, now, left }: { card: TrialCardRow; now: number; left?: LeftLane | null }) {
  const waiting = c.status === "waiting";
  const record = trialRecord(c, now);

  return (
    <article className="decision-doc mx-auto max-w-5xl px-6 pb-16 pt-5" data-trial-pane={c.short_id}>
      {c.superseded ? <div className="mb-4 rounded-md border border-sol-border/40 bg-sol-bg-alt/50 px-3 py-2 text-[12px]" data-trial-replaced><SupersededNote superseded={c.superseded} /></div> : left && <LeftBanner card={c} left={left} now={now} />}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-sol-text-dim">
        <span className={waiting || c.rebuilding ? (trialLane(c) === "waiting" ? "text-sol-yellow" : "text-sol-text-muted") : c.status === "answered" ? answerTone(c) : ""}>{waiting || c.rebuilding ? PANE_STATE[trialLane(c) ?? "waiting"](c) : record}</span>
        <span className="font-mono text-sol-text-muted" data-trial-card-id>{c.short_id}</span>
        <span>asked {formatTimeAgo(c.created_at, now)}</span>
        <Link href={`/tasks/${c.task_short_id}`} className="inline-flex items-center gap-1 hover:text-sol-text" data-trial-problem>the problem <ExternalLink className="h-3 w-3" /></Link>
        {c.superseded_by?.card && <Link href={`/trial?card=${c.superseded_by.card}`} className="inline-flex items-center gap-1 text-sol-blue hover:underline" data-trial-superseded>{c.superseded_by.card}</Link>}
        <Link href={`/workflows/runs/${c.run_id}`} className="ml-auto inline-flex items-center gap-1 opacity-70 hover:text-sol-text hover:opacity-100" title={c.card ? `${c.short_id}: built in ${c.card.cost.minutes} agent min, +${c.card.diff.added} −${c.card.diff.removed} lines in ${c.card.diff.files} files (${c.run_status})` : `${c.short_id}: the run that built it (${c.run_status})`} data-trial-run>how it was built <ExternalLink className="h-3 w-3" /></Link>
      </div>
      <div className="mt-3">
        <TrialCardBody card={c} now={now} />
      </div>
    </article>
  );
}

/** The open card was answered, closed or moved while it was being read: say so, by whom, and where its run went next. */
function LeftBanner({ card: c, left, now }: { card: TrialCardRow; left: LeftLane; now: number }) {
  const what = c.answer
    ? <>Answered <span className={answerTone(c)}>{c.answer.label}</span> {answererWords(c)} · {formatTimeAgo(c.answer.at, now)}</>
    : c.status === "closed" ? <>Closed · {formatTimeAgo(c.updated_at, now)}</>
    : <>Moved to {left.lane ? FILTER_LABEL[left.lane] : "another lane"}</>;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-sol-border/40 bg-sol-bg-alt/50 px-3 py-2 text-[12px] text-sol-text-muted" data-trial-left>
      <span className="text-sol-text">{what}</span>
      {left.next && (
        <button type="button" onClick={() => left.onOpen(left.next!)} className="ml-auto text-sol-blue hover:underline" data-trial-left-next={left.next.short_id}>
          Asked again as {left.next.short_id}
        </button>
      )}
    </div>
  );
}
