"use client";
// Runs (line-workspace.md LW1): every run of the process in view, one row a
// problem, newest first: its attempts as a strip of dots colored by how each
// ended, and the newest one's status, the step it stopped at and why (a red
// chip). Above the rows, how the problems' newest runs stand, as totals that
// each filter the list (waiting on you, failed, judge wrong, duplicate, ...),
// so "a third of runs end as the judge's mistake" is a number on the page.
// A problem tried more than once opens to its attempts. j and k move,
// Enter opens the newest, o opens the attempts; a run (`run` in the URL) opens
// its detail, the Replay (ReplayView): the run played step by step.
import { Fragment, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { useEventListener } from "../../../../hooks/useEventListener";
import { useTabActive } from "../../../../hooks/usePagePresence";
import { hasOpenModal } from "../../../../shortcuts";
import { keyBelongsElsewhere } from "../../../../shortcuts/keyOwnership";
import { ageShort } from "../../../../lib/lineFlow";
import { parkedWhy, reranAfterClose, runEndTone, runEndWords, runStop } from "../../../../lib/line/replay";
import { lineVisitOutput, visitOutputWords } from "../../../../lib/line/visitOutput";
import { failCause, type FailCause } from "../../../../lib/line/runReport";
import { sourceChipWords } from "../../../../lib/line/stepRuns";
import { closeOutcome, closeOutcomeWord } from "../../../../lib/line/scriptReport";
import { dayWords, durationWords, NavLink } from "../../widgets";
import { ReplayView } from "./ReplayView";
import { LineDecision } from "../../widgets/LineDecision";
import { TrialWait, useLiveTrialDecisionStatus, useWaitingTrialCards } from "./trialCards";
import { trialCardAnswerable } from "../../../../lib/line/lineInbox";
import type { LineViewProps } from "./types";

export function RunsView(props: LineViewProps) {
  const { selection, select } = props;
  // The decision a run waits on opens here, over the run or the list it was opened from: closing it (or Back) returns there.
  if (selection.decision) {
    const src = selection.case ? props.workspace.sources.get(selection.case) : undefined;
    return (
      <div className="lw-run-decision" data-line-run-decision={selection.decision}>
        <LineDecision key={selection.decision} id={selection.decision} source={src ? sourceChipWords(src) : null} onClose={() => select({ decision: null })}
          onProblem={(taskId) => select({ view: "problems", case: taskId, run: null })}
          onRun={(runId, taskId) => select({ run: runId, decision: null }, taskId)} />
      </div>
    );
  }
  if (selection.run) return <ReplayView {...props} />;
  return <RunList {...props} />;
}

/** How many of the totals the header shows before folding the rest. */
const TOTALS_SHOWN = 6;

type Run = LineViewProps["model"]["runs"][number];
/** One problem's runs, newest last: the list's row, its attempts the strip of dots and, opened, its rows. */
type RunGroup = { key: string; runs: Run[]; newest: Run };

/** What a run that ended "done" decided last, in words: the end step it reached ("dropped"), else its last step's own
 *  outcome ("judge defect"). A step before the end only says what led there: a Proposal's "proposed" is stale once the
 *  run went on to Dropped. */
function lastOutcome(r: Run): string | null {
  const last = r.visits[r.visits.length - 1];
  if (last && last.kind === "end" && last.status === "done" && last.label) return last.label.toLowerCase();
  for (let i = r.visits.length - 1; i >= 0; i--) {
    const o = r.visits[i].decided.outcome;
    // A gate's answer is an option key ("d"), not an outcome a person reads: the run's end words say it instead.
    if (!r.visits[i].inferred && r.visits[i].kind !== "end" && o && o.length > 2 && !/^(success|failure)$/.test(o)) return closeOutcomeWord(o);
  }
  return null;
}

function RunList({ model, workspace, select, href, drawerOpen }: LineViewProps) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const active = useTabActive();
  const sources = workspace.sources;
  const trialWaits = useWaitingTrialCards();
  const liveTrial = useLiveTrialDecisionStatus();
  const [only, setOnly] = useState<string | null>(null);
  // The header names the few ways most runs stand; the rare ones wait behind one chip.
  const [allTotals, setAllTotals] = useState(false);
  const projectOf = useMemo(() => {
    const titles = new Map(workspace.projects.map((p) => [p._id, p.title]));
    return new Map(workspace.rows.tasks.map((t) => [t._id, (t as { project_id?: string | null }).project_id ? titles.get((t as { project_id: string }).project_id) ?? "" : ""]));
  }, [workspace.projects, workspace.rows.tasks]);
  const rawById = useMemo(() => new Map(workspace.rows.runs.map((r) => [r._id, r])), [workspace.rows.runs]);
  const runs = model.runs;
  // The same problem tried again is the pattern to see: one row a problem, newest problem first, its attempts oldest first.
  const allGroups = useMemo<RunGroup[]>(() => {
    const by = new Map<string, Run[]>();
    // Runs on a duplicate problem (overlap) fold behind the oldest problem of its set: one thing, worked once.
    for (const r of runs) {
      const k = r.caseId ? workspace.overlaps.get(r.caseId)?.primary ?? r.caseId : `run:${r.id}`;
      by.set(k, [...(by.get(k) ?? []), r]);
    }
    return [...by].map(([key, list]) => {
      const sorted = [...list].sort((a, b) => a.at - b.at);
      return { key, runs: sorted, newest: sorted[sorted.length - 1] };
    }).sort((a, b) => b.newest.at - a.newest.at);
  }, [runs, workspace.overlaps]);
  /** Why a run ended, short (failCause), for a run that failed or stuck. */
  const reasonOf = (r: Run): FailCause | null => {
    const end = runEndWords(r);
    const raw = rawById.get(r.id);
    return (end === "failed" || end === "stuck") && raw ? failCause(raw as unknown as Parameters<typeof failCause>[0]) : null;
  };
  /** How a run stands, read once for its row and for the totals: its end, the trial card it waits on, why it failed,
   *  how it closed its problem without a change, and the one word all of that comes to. */
  const standOf = (r: Run) => {
    const end = runEndWords(r);
    const trial = trialWaits.get(r.id);
    const why = reasonOf(r);
    // A run that closed its problem without a change reads by how, as its status ("duplicate", "already fixed", "judge wrong"),
    // and what that points at in place of the step.
    const closed = !trial && !why && (end === "dissolved" || end === "done") ? closeOutcome(r.visits) ?? (end === "done" && lastOutcome(r) ? { word: lastOutcome(r)!, into: null } : null) : null;
    const parked = end === "parked" ? parkedWhy(r.outcome.text) : null;
    const word = trial ? (trialCardAnswerable(trial, trial.decision ? liveTrial.get(trial.decision._id) : null) ? "waiting on you" : "needs a re-ask") : closed?.word ?? (parked ? `parked: ${parked}` : end);
    return { end, trial, why, closed, parked, word };
  };
  // The totals: each problem's newest run by how it stands, most first; what waits on you leads.
  const totals = useMemo(() => {
    const by = new Map<string, { n: number; tone: string }>();
    for (const g of allGroups) {
      const st = standOf(g.newest);
      const key = st.parked ? "parked" : st.word;
      const tone = st.trial ? (key === "waiting on you" ? "person" : "warn") : st.closed?.word === "judge wrong" ? "warn" : runEndTone(st.end);
      by.set(key, { n: (by.get(key)?.n ?? 0) + 1, tone });
    }
    return [...by].map(([word, v]) => ({ word, ...v })).sort((a, b) => Number(b.word === "waiting on you") - Number(a.word === "waiting on you") || b.n - a.n || a.word.localeCompare(b.word));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- standOf reads these
  }, [allGroups, trialWaits, liveTrial, rawById]);
  // Unfiltered, the runs that wait on you lead, newest first within each part: what he must act on is never below the fold.
  const groups = useMemo(() => (only ? allGroups.filter((g) => { const st = standOf(g.newest); return (st.parked ? "parked" : st.word) === only; })
    : [...allGroups].sort((a, b) => Number(standOf(b.newest).word === "waiting on you") - Number(standOf(a.newest).word === "waiting on you"))),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- standOf reads these
    [allGroups, only, trialWaits, liveTrial, rawById]);
  /** The duplicate problems a row's runs also cover, beside its own. */
  const dupRefs = (g: RunGroup) => [...new Set(g.runs.filter((x) => x.caseId && x.caseId !== g.key).map((x) => x.caseRef ?? ""))].filter(Boolean);
  const toggle = (k: string) => setOpened((was) => { const next = new Set(was); if (!next.delete(k)) next.add(k); return next; });
  const at = cursor ? groups.findIndex((g) => g.key === cursor) : -1;
  const open = (id: string, caseId: string | null) => select({ run: id }, caseId);

  useEventListener("keydown", (e: KeyboardEvent) => {
    if (!active || drawerOpen || !groups.length || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || hasOpenModal() || keyBelongsElsewhere(e.target)) return;
    const move = (to: number) => {
      const g = groups[Math.max(0, Math.min(groups.length - 1, to))];
      e.preventDefault();
      setCursor(g.key);
      document.querySelector(`[data-line-run-group="${g.key}"]`)?.scrollIntoView({ block: "nearest" });
    };
    if (e.key === "j" || e.key === "ArrowDown") move(at + 1);
    else if (e.key === "k" || e.key === "ArrowUp") move(at - 1);
    else if (e.key === "Enter" && at >= 0) { e.preventDefault(); open(groups[at].newest.id, groups[at].newest.caseId); }
    else if ((e.key === "o" || e.key === "ArrowRight" || e.key === "ArrowLeft") && at >= 0 && groups[at].runs.length > 1) { e.preventDefault(); toggle(groups[at].key); }
  });

  if (!runs.length) return <div className="lw-empty" data-line-runs="empty"><b>No runs</b>Nothing has run on this process yet.</div>;
  const showProject = !workspace.project;

  /** How a run ended and where: its status, the step, and why (a red chip) when it failed. */
  const endCells = (r: Run) => {
    const { end, trial, why, closed, word } = standOf(r);
    const stop = runStop(model, r);
    const said = stop.visit ? visitOutputWords(lineVisitOutput(stop.visit, r)) : null;
    return (
      <>
        <td title={trial || r.verdict ? undefined : r.outcome.text}>{trial ? <TrialWait card={trial} graph={model.graphKey} onOpen={(card) => select({ view: "inbox", card, graph: model.graphKey })} onDecide={(decision) => select({ run: r.id, decision }, r.caseId)} /> : <span className="lw-oc" data-tone={closed?.word === "judge wrong" ? "warn" : runEndTone(end)} data-line-run-status={word}>{word}</span>}</td>
        <td className="lw-list-dim lw-atstep" title={why?.raw ?? said ?? undefined}>
          {closed ? <span className="lw-atstep-in">{closed.into ? <span className="lw-why" data-line-run-close={closed.into}>{/^[0-9a-f]{7,40}$/.test(closed.into) ? "fixed by " : "into "}<span className="lw-mono">{closed.into}</span></span> : <span className="lw-atstep-step">{stop.label}</span>}</span>
          : stop.label && <span className="lw-atstep-in">
            <span className="lw-atstep-step">{stop.label}</span>
            {why && <span className="lw-why" data-tone="bad">{why.label}</span>}
            {why?.check?.preExisting && !why.label.includes("not in diff") && <span className="lw-why" data-tone="warn" title={why.check.files.join(", ")}>pre-existing</span>}
          </span>}
        </td>
      </>
    );
  };

  return (
    <div className="lw-list-wrap" data-line-runs={runs.length} data-line-run-groups={groups.length}>
      <div className="lw-run-totals" role="group" aria-label="Problems by how their newest run stands" data-line-run-totals={allGroups.length}>
        <button type="button" className="lw-run-total" aria-pressed={!only} onClick={() => setOnly(null)} data-line-run-total="all">
          <b className="lw-num">{allGroups.length}</b><span>problems run</span>
        </button>
        {(allTotals ? totals : totals.filter((t, i) => i < TOTALS_SHOWN || t.word === only)).map((t) => (
          <button key={t.word} type="button" className="lw-run-total" data-tone={t.tone} aria-pressed={only === t.word} onClick={() => setOnly(only === t.word ? null : t.word)} title={`${t.n} of ${allGroups.length} problems: their newest run reads "${t.word}"`} data-line-run-total={t.word}>
            <b className="lw-num">{t.n}</b><span>{t.word}</span>
          </button>
        ))}
        {totals.length > TOTALS_SHOWN && (
          <button type="button" className="lw-run-total" data-more="" aria-expanded={allTotals} onClick={() => setAllTotals(!allTotals)} title={allTotals ? "Show the main ones" : totals.slice(TOTALS_SHOWN).map((t) => `${t.n} ${t.word}`).join("\n")} data-line-run-total-more={totals.length - TOTALS_SHOWN}>
            <b className="lw-num">{allTotals ? "" : totals.slice(TOTALS_SHOWN).reduce((n, t) => n + t.n, 0)}</b><span>{allTotals ? "fewer" : `in ${totals.length - TOTALS_SHOWN} more`}</span>
          </button>
        )}
      </div>
      <table className="lw-list lw-runs">
        <thead>
          <tr>
            <th>Problem</th><th>Title</th><th>Source</th>{showProject && <th>Project</th>}<th>Attempts</th><th>Status</th><th>At step</th>
            <th className="lw-r">Steps</th><th className="lw-r">Took</th><th className="lw-r">Started</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => {
            const r = g.newest;
            const src = r.caseId ? sources.get(r.caseId) : undefined;
            const runHref = href({ run: r.id, view: "runs" }, r.caseId);
            const many = g.runs.length > 1;
            const isOpen = many && opened.has(g.key);
            return (
              <Fragment key={g.key}>
                <tr onClick={(e) => { if (!e.metaKey && !e.ctrlKey && !e.shiftKey) open(r.id, r.caseId); }} onMouseEnter={() => setCursor(g.key)} data-cursor={g.key === cursor ? "" : undefined} aria-selected={g.key === cursor} data-line-run={r.id} data-line-run-group={g.key}>
                  <td className="lw-mono" title={dupRefs(g).length ? `Also on ${dupRefs(g).join(", ")}, the same problem` : undefined}>
                    {many
                      ? <button type="button" className="lw-run-caret" aria-expanded={isOpen} aria-label={isOpen ? "Hide attempts" : "Show attempts"} onClick={(e) => { e.stopPropagation(); toggle(g.key); }}><ChevronRight aria-hidden /></button>
                      : <span className="lw-run-caret" aria-hidden />}
                    {workspace.overlaps.get(g.key)?.primaryRef ?? r.caseRef ?? ""}
                    {dupRefs(g).length > 0 && <span className="lwp-dup lw-run-dup">+{dupRefs(g).length} dup</span>}
                  </td>
                  <td className="lw-list-text">
                    <NavLink className="lw-rowlink" href={runHref} onOpen={() => {}} title={r.caseTitle}>{r.caseTitle}</NavLink>
                  </td>
                  <td>{src ? <span className="lw-srcchip">{sourceChipWords(src)}</span> : null}</td>
                  {showProject && <td className="lw-list-dim">{r.caseId ? projectOf.get(r.caseId) ?? "" : ""}</td>}
                  <td>
                    <span className="lw-attempts" aria-label={`${g.runs.length} attempts`}>
                      {g.runs.map((x, i) => {
                        const end = runEndWords(x);
                        const rerun = reranAfterClose(g.runs[i - 1]);
                        return <button key={x.id} type="button" className="lw-attempt-dot" data-tone={runEndTone(end)} data-rerun={rerun ? "" : undefined} title={`#${i + 1} ${end}${reasonOf(x) ? `: ${reasonOf(x)!.label}` : ""}${rerun ? " (re-ran after a close)" : ""}`} onClick={(e) => { e.stopPropagation(); open(x.id, x.caseId); }} data-line-attempt={`${i + 1}`} />;
                      })}
                      {many && <span className="lw-num lw-attempt-n">{g.runs.length}</span>}
                    </span>
                  </td>
                  {endCells(r)}
                  <td className="lw-r lw-num">{r.visits.length}</td>
                  <td className="lw-r lw-num">{r.durationMs != null ? durationWords(r.durationMs) : ""}</td>
                  <td className="lw-r lw-num">{ageShort(workspace.now - r.at)}</td>
                </tr>
                {isOpen && [...g.runs].reverse().map((x) => (
                  <tr key={x.id} className="lw-run-attempt" onClick={(e) => { if (!e.metaKey && !e.ctrlKey && !e.shiftKey) open(x.id, x.caseId); }} data-line-run={x.id}>
                    <td className="lw-mono lw-list-dim"><span className="lw-run-caret" aria-hidden />#{g.runs.indexOf(x) + 1}</td>
                    <td className="lw-list-text lw-list-dim" title={`${dayWords(x.at)}: ${x.outcome.text}`}>
                      {reranAfterClose(g.runs[g.runs.indexOf(x) - 1]) && <span className="lw-why" data-tone="bad" data-line-rerun="">re-ran after close</span>}
                      <span className="lw-attempt-said">{x.verdict?.word && x.verdict.word !== runEndWords(x) ? x.verdict.word : x.outcome.text}</span>
                    </td>
                    <td />
                    {showProject && <td />}
                    <td />
                    {endCells(x)}
                    <td className="lw-r lw-num">{x.visits.length}</td>
                    <td className="lw-r lw-num">{x.durationMs != null ? durationWords(x.durationMs) : ""}</td>
                    <td className="lw-r lw-num">{ageShort(workspace.now - x.at)}</td>
                  </tr>
                ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
