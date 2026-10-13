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
// Our tooling also holds the trial's open expectation proposals, drawn with
// the Expectations page's own Proposal: a trial asks nobody in their queue.
import { findingConversation } from "@codecast/shared/contracts/judges";
import { useMemo, useState } from "react";
import Link from "next/link";
import { ExternalLink, RotateCcw } from "lucide-react";
import { SupersededNote } from "../SupersededNote";
import { useSyncTrial, useSyncTrialSpend, useTrialCards, useTrialProjects, useTrialRuns, useTrialSpend, type TrialCardRow, type TrialRunRow, type TrialSpendRow } from "../../hooks/useSyncTrial";
import { useInboxStore } from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { formatTimeAgo } from "../../lib/messageNavigator";
import { cn } from "../../lib/utils";
import { useSyncSignals, useWorkspaceSignals } from "../../hooks/useSyncSignals";
import { useSearchParams } from "next/navigation";
import { WorkspaceScopeProvider } from "../../hooks/useWorkspaceScope";
import { ownWorkspace, trialAddress } from "../../lib/trialHref";
import { activeWorkspaceKeyOf, workspaceDisplayName } from "../../lib/workspaceScope";
import { TrialCardBody, answerTone, answererWords, trialRecord } from "./TrialCardBody";
import { cardFailing, evalsOwed, verdictLabel, verdictOfOption } from "@codecast/shared/contracts/changeCard";
import { cardAsRead, emptyWords, evidenceGone, proposalUnfounded, trialHold, trialLane } from "../../lib/trialEvidence";
import { PROPOSAL_VERDICT_TONE, PROPOSAL_VERDICT_WORD } from "../decisions/ProposalCardDecision";
import { useProjectExpectations, useSyncProjectExpectations, type ExpectationProposalView, type ProjectExpectationsRow } from "../../hooks/useSyncProjectExpectations";
import { openProposals } from "../../lib/expectations/view";
import { Proposal } from "../expectations/ExpectationsDocument";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { problemListName } from "../../lib/line/problemTable";
import { outcomeLineInWords } from "../../lib/line/stepWork";
import { useSyncTaskEvidence, useTaskEvidenceByShortId } from "../../hooks/useSyncTaskEvidence";

type Filter = "waiting" | "tooling" | "held" | "running" | "empty" | "failed" | "stopped" | "answered" | "all" | "superseded";

const FILTERS: Filter[] = ["waiting", "tooling", "held", "running", "empty", "failed", "stopped", "answered", "all", "superseded"];
const isFilter = (v: string | null): v is Filter => !!v && (FILTERS as string[]).includes(v);

const FILTER_LABEL: Record<Filter, string> = { waiting: "Waiting", tooling: "Our tooling", held: "Held", running: "Running", empty: "Nothing left", failed: "Failed", stopped: "Stopped", answered: "Answered", all: "All", superseded: "Superseded" };

/** Run lists: failed runs, and runs that gave up at a failure station with the problem still open. */
const RUN_FILTERS = new Set<Filter>(["failed", "stopped"]);
/** An open expectation proposal's row id in the Our tooling list. */
const xpId = (p: ExpectationProposalView) => `xp:${p.short_id}`;
/** The lanes a waiting card can sit in (trialLane): the executive's queue, our review tooling, held by the pipeline, nothing left. */
const LANES = new Set<Filter>(["waiting", "tooling", "held", "running", "empty"]);

/** A card still waiting on a person whose problem has nothing behind it (no finding left, or no case and no proof): Drop is its only sensible answer, so it is not a decision to make. */
const nothingLeft = (c: TrialCardRow) => trialLane(c) === "empty";

/** A failed run, and its rerun until that one settles: the Failed list. */
const inFailedList = (r: TrialRunRow) => r.status === "failed" || (r.fresh_branch && (r.status === "pending" || r.status === "running"));

const stationName = (id: string | null) => (id ? id.replace(/_/g, " ").replace(/^\w/, (ch) => ch.toUpperCase()) : "Start");

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

const usd = (n: number) => (n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`);

const STATE_TONE: Record<TrialCardRow["status"], string> = { waiting: "bg-sol-yellow", answered: "bg-sol-green", closed: "bg-sol-text-dim/40" };

/** /trial in the workspace its address names (trialHref `ws`), when the viewer is in it: a Trial tag on a team's
 *  decision opens that team's trial whatever workspace the app sits on. */
export function TrialReviewPage() {
  const address = trialAddress(useSearchParams());
  const viewerId = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  const teamIds = useInboxStore((s) => ((s.teams ?? []) as Array<{ _id?: string } | null>).map((t) => String(t?._id ?? "")).join(","));
  const scope = ownWorkspace(address.ws, viewerId, teamIds ? teamIds.split(",") : []);
  return (
    <WorkspaceScopeProvider value={scope}>
      <TrialReview askedProject={address.project} />
    </WorkspaceScopeProvider>
  );
}

function TrialReview({ askedProject }: { askedProject: string | null }) {
  const { ready } = useSyncTrial();
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
    if (!ws || ws === appWorkspace) return null;
    const [kind, id] = [ws.slice(0, ws.indexOf(":")), ws.slice(ws.indexOf(":") + 1)];
    return kind === "user" && id === viewerId ? "Personal" : kind === "team" || kind === "user" ? workspaceDisplayName({ kind, id }, teams, viewerId) : null;
  }, [project?.workspace, appWorkspace, teams, viewerId]);
  useSyncTrialSpend(project?._id ?? null);
  const spend = useTrialSpend(project?._id ?? null);
  const now = useCoarseNow(30_000);

  const inProject = useMemo(() => (project ? cards.filter((c) => c.project_id === project._id) : cards), [cards, project]);
  const replaced = useMemo(() => every.filter((c) => c.superseded && (!project || c.project_id === project._id)), [every, project]);
  const failedRuns = useMemo(() => runs.filter((r) => (!project || r.project_id === project._id) && inFailedList(r)), [runs, project]);
  // Stopped: most findings left first; one with none left is last, since nothing stands behind a rerun.
  const stoppedRuns = useMemo(() => runs.filter((r) => (!project || r.project_id === project._id) && r.stopped).sort((a, b) => (b.stopped!.findings - a.stopped!.findings) || b.updated_at - a.updated_at), [runs, project]);
  useSyncProjectExpectations(project?._id ?? null);
  const expectations = useProjectExpectations(project?._id ?? null);
  const proposals = useMemo(() => openProposals(expectations).filter((p) => p.short_id), [expectations]);
  const failedByTask = useMemo(() => new Map(runs.filter((r) => r.status === "failed").map((r) => [r.task_short_id, r])), [runs]);
  const counts = useMemo(() => ({
    failed: failedRuns.filter((r) => r.status === "failed").length,
    stopped: stoppedRuns.length,
    waiting: inProject.filter((c) => trialLane(c) === "waiting").length,
    tooling: inProject.filter((c) => trialLane(c) === "tooling").length + proposals.length,
    held: inProject.filter((c) => trialLane(c) === "held").length,
    running: inProject.filter((c) => trialLane(c) === "running").length,
    empty: inProject.filter(nothingLeft).length,
    answered: inProject.filter((c) => c.status === "answered").length,
    all: inProject.length,
    superseded: replaced.length,
  }), [inProject, replaced, failedRuns, stoppedRuns, proposals]);
  // A problem page links straight to its card (/trial?card=tc-N).
  const linked = useSearchParams()?.get("card") ?? null;
  const linkedRow = linked ? inProject.find((c) => c.short_id === linked) ?? every.find((c) => c.short_id === linked) ?? null : null;
  // The tab is in the address (`tab`), so a list can be linked and reloaded; without one, the linked card's own lane, else Waiting.
  const askedTab = useSearchParams()?.get("tab") ?? null;
  const [chosen, setChosen] = useState<Filter | null>(isFilter(askedTab) ? askedTab : null);
  const filter: Filter = chosen ?? (linkedRow ? (linkedRow.superseded ? "superseded" : trialLane(linkedRow) ?? "all") : "waiting");
  const setFilter = (f: Filter) => {
    setChosen(f);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", f);
    window.history.replaceState(window.history.state, "", url);
  };
  const shown = useMemo(() => (filter === "superseded" ? replaced : filter === "all" ? inProject : RUN_FILTERS.has(filter) ? [] : LANES.has(filter) ? inProject.filter((c) => trialLane(c) === filter) : inProject.filter((c) => c.status === filter)), [inProject, replaced, filter]);
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
  const owed = inProject.some((c) => c.status === "waiting" && c.card && !evidenceGone(c.evidence) && evalsOwed(c.card));
  const runList = filter === "failed" ? failedRuns : filter === "stopped" ? stoppedRuns : [];
  const shownProposals = filter === "tooling" ? proposals : [];
  const selectedProposal = shownProposals.find((p) => xpId(p) === selectedId) ?? (selectedId === null && !shown.length ? shownProposals[0] : null) ?? null;
  // A card answered or moved elsewhere while open stays open, with what happened to it, instead of the list swapping it out.
  const selected = RUN_FILTERS.has(filter) || selectedProposal ? null : shown.find((c) => c._id === selectedId) ?? (selectedId ? inProject.find((c) => c._id === selectedId) ?? replaced.find((c) => c._id === selectedId) : null) ?? (selectedId === null ? linkedRow : null) ?? shown[0] ?? null;
  const selectedLeft = !!selected && !shown.some((c) => c._id === selected._id);
  const selectedRun = RUN_FILTERS.has(filter) ? runList.find((r) => r._id === selectedId) ?? runList[0] ?? null : null;

  return (
    <div className="flex h-full min-h-0 flex-col" data-trial-page>
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-sol-border/40 px-5 py-3">
        <div className="flex items-baseline gap-2">
          <h1 className="text-[15px] font-semibold text-sol-text">Trial</h1>
          {projects.length > 1 ? (
            <select value={project?._id ?? ""} onChange={(e) => { setProjectId(e.target.value); openCard(null); }} className="rounded border border-sol-border/50 bg-transparent px-1.5 py-0.5 text-[12px] text-sol-text" data-trial-project>
              {projects.map((p) => <option key={p._id} value={p._id}>{p.title}</option>)}
            </select>
          ) : project ? <span className="text-[12px] text-sol-text-muted" data-trial-project>{project.title}</span> : null}
          {/* A trial read outside the app's workspace names whose it is. */}
          {elsewhere && <span className="text-[12px] text-sol-text-dim" data-trial-workspace>{elsewhere}</span>}
        </div>
        {owed && <span className="rounded border border-sol-yellow/40 px-1.5 py-0.5 text-[11px] text-sol-yellow" title="The trial never runs a change's evals: they write to the database they point at. A card whose fix works says Ship after evals." data-trial-evals>Evals not run in the trial</span>}
        {spend && <SpendStrip spend={spend} />}
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[20rem] shrink-0 flex-col border-r border-sol-border/40" data-trial-list>
          <div className="flex flex-wrap gap-1 px-3 py-2" role="tablist">
            {/* Held is always counted: whether the pipeline holds anything back is a question the page answers, zero included. */}
            {FILTERS.filter((f) => !(f === "empty" || f === "tooling" || f === "running" || f === "stopped" || f === "superseded") || counts[f] > 0 || filter === f).map((f) => (
              <button
                key={f}
                type="button"
                role="tab"
                aria-selected={filter === f}
                onClick={() => { setFilter(f); openCard(null); }}
                className={cn("rounded px-2 py-1 text-[12px] tabular-nums transition-colors", filter === f ? "bg-sol-bg-alt text-sol-text" : "text-sol-text-dim hover:text-sol-text")}
                data-trial-filter={f}
              >
                {FILTER_LABEL[f]} <span className={cn("ml-0.5", f === "waiting" && counts.waiting ? "text-sol-yellow" : f === "failed" && counts.failed ? "text-sol-red" : f === "stopped" && counts.stopped ? "text-sol-orange" : f === "running" && counts.running ? "text-sol-blue" : "opacity-60")}>{counts[f]}</span>
              </button>
            ))}
          </div>
          {filter === "empty" && shown.length > 0 && <DropAll cards={shown} />}
          <ul className="min-h-0 flex-1 overflow-y-auto">
            {runList.map((r) => <FailedRunRow key={r._id} run={r} selected={selectedRun?._id === r._id} now={now} onSelect={() => setSelectedId(r._id)} />)}
            {shownProposals.map((p) => <ProposalRow key={xpId(p)} p={p} selected={selectedProposal?.short_id === p.short_id} now={now} onSelect={() => setSelectedId(xpId(p))} />)}
            {shown.map((c) => (
              <li key={c._id}>
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
                      {!c.superseded && <RowVerdict card={c} />}
                      {!c.superseded && <RowSize card={c} counted={sizes.get(c.task_id)?.size ?? 0} />}
                      {c.answer && <span className={answerTone(c)}>{c.answer.label}</span>}
                      {c.answer && <span className="truncate" data-trial-answerer>{answererWords(c)}</span>}
                      {c.superseded && <SupersededNote superseded={c.superseded} />}
                      {c.status === "closed" && !c.rebuilding && !c.superseded && <span>{c.superseded_by ? `→ ${c.superseded_by.card ?? c.superseded_by.task}` : "closed"}</span>}
                    </span>
                  </span>
                  <span className="text-[11px] tabular-nums text-sol-text-dim">{formatTimeAgo(c.created_at, now)}</span>
                </button>
              </li>
            ))}
            {(RUN_FILTERS.has(filter) ? runList.length === 0 : shown.length + shownProposals.length === 0) && (
              <li className="px-4 py-6 text-[12px] text-sol-text-dim">
                {!ready && cards.length === 0 ? "Reading the trial's cards…" : filter === "waiting" ? "Nothing waits on you." : filter === "empty" ? "Every waiting card still has evidence." : filter === "failed" ? "No failed runs." : filter === "stopped" ? "No stopped runs." : filter === "held" ? "Nothing held." : filter === "running" ? "No rebuild running." : filter === "tooling" ? "No review-tooling changes." : filter === "superseded" ? "Nothing superseded." : "No cards yet."}
              </li>
            )}
          </ul>
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto" data-main-scroll>
          {selectedProposal && expectations && project ? <ExpectationProposalPane key={xpId(selectedProposal)} projectId={project._id} row={expectations} p={selectedProposal} /> : selectedRun ? <FailedRunPane key={selectedRun._id} run={selectedRun} cards={inProject.filter((c) => c.task_short_id === selectedRun.task_short_id)} now={now} onOpenCard={(id) => { setFilter("all"); openCard(inProject.find((c) => c._id === id) ?? null); }} /> : selected ? <TrialCardPane key={selected._id} card={selected} now={now} left={selectedLeft ? { lane: trialLane(selected), next: inProject.find((x) => x.run_id === selected.run_id && x.created_at > selected.created_at && x._id !== selected._id) ?? null, onOpen: (x) => { setFilter(trialLane(x) ?? "all"); openCard(x); } } : null} /> : (
            <div className="px-8 py-10 text-[12.5px] text-sol-text-dim">{projects.length ? "Pick a card." : "No trial project in this workspace."}</div>
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

/** What the giving-up station's session reported when it stopped: its handoff on the problem, whole (task evidence). */
function StationReport({ task, fallback }: { task: string; fallback: string }) {
  useSyncTaskEvidence(task);
  const ev = useTaskEvidenceByShortId(task);
  const report = ev?.verification_evidence?.trim() || null;
  if (!report) return <div className="mt-0.5 text-[12px] text-sol-text-muted">{ev ? fallback : "Reading its report…"}</div>;
  return <div className="mt-3 border-t border-sol-orange/20 pt-3 text-[13px]" data-trial-station-report><MarkdownRenderer content={outcomeLineInWords(report)} /></div>;
}

/** A stopped run's line: the station that gave up and the findings still on the problem. */
const stopWords = (r: TrialRunRow) => (r.stopped ? `${stationName(r.stopped.station)} · ${r.stopped.findings ? `${r.stopped.findings} ${r.stopped.findings === 1 ? "finding" : "findings"} left` : "nothing left"}` : "");

function FailedRunRow({ run: r, selected, now, onSelect }: { run: TrialRunRow; selected: boolean; now: number; onSelect: () => void }) {
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
            <span className="truncate">{failed ? failWords(r.fail_reason, r.lost_at_gate) : stopped ? stopWords(r) : stationName(r.node_id)}</span>
          </span>
        </span>
        <span className="text-[11px] tabular-nums text-sol-text-dim">{formatTimeAgo(r.updated_at, now)}</span>
      </button>
    </li>
  );
}

/** A failed run: where it stopped, why, the cards it left, and the rerun (lineTrial.rerun, from a fresh branch). */
function FailedRunPane({ run: r, cards, now, onOpenCard }: { run: TrialRunRow; cards: TrialCardRow[]; now: number; onOpenCard: (id: string) => void }) {
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
      {stop && (
        <section className="mt-5 rounded-md border border-sol-orange/30 bg-sol-orange/5 px-4 py-3" data-trial-stopped={r.task_short_id}>
          <div className="flex flex-wrap items-center gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2 text-[13px] font-medium text-sol-text">
                {stationName(stop.station)} gave up
                <span className={cn("text-[12px] font-normal tabular-nums", stop.findings ? "text-sol-orange" : "text-sol-text-dim")}>{stop.findings ? `${stop.findings} ${stop.findings === 1 ? "finding" : "findings"} still on it` : "no finding left"}</span>
              </div>
              {stop.words && !sessionStateOnly(stop.words) && <div className="mt-0.5 text-[12px] text-sol-text-muted">{stop.words}</div>}
            </div>
            <button
              type="button"
              onClick={() => trialRerun(r._id)}
              title="A new run from origin/main: it investigates and proposes again, and its card comes back here"
              className="inline-flex items-center gap-1.5 rounded-md bg-sol-blue px-3 py-1.5 text-[12.5px] font-medium text-sol-bg transition-opacity hover:opacity-90"
              data-trial-rerun={r.task_short_id}
            >
              <RotateCcw className="h-3.5 w-3.5" /> Rerun from main
            </button>
          </div>
          {(!stop.words || sessionStateOnly(stop.words)) && <StationReport task={r.task_short_id} fallback={stop.words ? stopText(stop.words) : "It said nothing"} />}
        </section>
      )}
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
      <span className={cn("font-medium", VERDICT_INK[v] ?? "")} data-row-verdict={v}>{gone ? "Drop: evidence gone" : v === "ship" && evalsOwed(card) ? "Ship after evals" : verdictLabel(v)}</span>
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

/** What the trial has cost: the model budget (judging, grouping) against its cap, and the line runs' sessions. */
function SpendStrip({ spend }: { spend: TrialSpendRow }) {
  const b = spend.budget;
  const model = b.spent_usd + b.earlier_months_usd;
  const pct = b.cap_usd > 0 ? Math.min(100, (b.spent_usd / b.cap_usd) * 100) : 0;
  return (
    <div className="ml-auto flex items-center gap-5 text-[11.5px] tabular-nums text-sol-text-dim" data-trial-spend>
      <span title={`Judging ${usd(b.by_purpose.judge)} · grouping ${usd(b.by_purpose.grouping)} · calls ${usd(b.by_purpose.call)}${b.refused ? ` · ${b.refused} calls refused at the cap` : ""}`} className="flex items-center gap-2">
        Model
        <span className="relative h-1.5 w-24 overflow-hidden rounded-full bg-sol-border/40">
          <span className={cn("absolute inset-y-0 left-0 rounded-full", pct > 85 ? "bg-sol-red" : pct > 60 ? "bg-sol-yellow" : "bg-sol-blue")} style={{ width: `${pct}%` }} />
        </span>
        <span className="text-sol-text">{usd(b.spent_usd)}</span>/{usd(b.cap_usd)} {b.month}
      </span>
      <span title={`${spend.sessions} sessions${spend.unpriced_tokens ? `, ${Math.round(spend.unpriced_tokens / 1000)}k tokens on unpriced models` : ""}`}>
        Runs <span className="text-sol-text">{spend.runs}</span> · <span className="text-sol-text">{usd(spend.session_usd)}</span>
      </span>
      {!!spend.outside_usd && (
        <span title={(spend.outside ?? []).map((o) => `${usd(o.usd)} ${o.what}`).join("\n")} data-trial-outside>
          Outside <span className="text-sol-text">{usd(spend.outside_usd)}</span>
        </span>
      )}
      <span>Total <span className="font-semibold text-sol-text">{usd(spend.total_usd ?? model + spend.session_usd)}</span></span>
    </div>
  );
}

/** A waiting card's state in the pane's header, by lane. */
const PANE_STATE: Record<"waiting" | "tooling" | "held" | "running" | "empty", (c: TrialCardRow) => string> = {
  waiting: () => "Waiting on you",
  tooling: (c) => `Our review tooling: the ${c.tooling === "extractor" ? "extractor" : "judge"}, not the product`,
  held: (c) => `Held by the pipeline · ${trialHold(c)?.words ?? ""}`,
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
