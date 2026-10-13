"use client";
// For you (line-journeys.md LJ8.1): the landing page. Its job is to clear what
// waits on the viewer, so it is a list with a reader beside it from the first
// paint: the first item is open on arrival, it is read and answered in the
// reader (WaitingItem), and when it leaves the list the next one opens. No row
// carries a button: every act is in the reader, next to the whole text.
//
// The list is what the viewer can answer now, and nothing else: fixes to
// decide, questions, new problems to confirm, and runs that finished a step and wait
// on a yes to go on, across every process. The nav's
// count, the list and the reader's "N of M" are the same rows. What no answer
// can reach (a run that must ask again, a problem behind a line that is off)
// lives on Problems; under the list one quiet line each points there, counted
// by the Problems list itself so the two numbers cannot differ. A row is the
// problem's title; the reader's head names the problem once (ref, title, age)
// and the body opens on what is asked. The open item is `need` in the URL; an older link's `decision` or
// `card` settles on it. A need the address names that is not in the list is
// said to be so, never swapped for another item. J and K walk the list while
// focus is in it; nothing here moves focus into the reader, where a decision
// takes keys.
import { useMemo, useRef } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useWatchEffect } from "../../../../hooks/useWatchEffect";
import { ageShort } from "../../../../lib/lineFlow";
import { processName } from "../../../../lib/line/lineGraphs";
import { isPractice, needForRef, needGroups, needOrder, type LineNeed } from "../../../../lib/line/lineNeeds";
import { problemListName } from "../../../../lib/line/problemTable";
import { type StatusKey } from "../../../../lib/line/problemStatus";
import { KeyCap } from "../../../KeyCap";
import { LineDecision, LineDecisionPrefetch } from "../../widgets/LineDecision";
import { WaitingItem } from "../../widgets/WaitingItem";
import { useTrialHref } from "../../../../hooks/useSyncTrial";
import { ProblemPointers, useProblemCounts } from "./ProblemPointers";
import type { LineViewProps } from "./types";
import "./foryou.css";

/** The Problems chips For you points at, under its list: what waits on a new run or on a line that is off. */
const ELSEWHERE: ReadonlyArray<StatusKey> = ["newask", "notstarted"];

const SCROLL_KEY = "line:foryou:scroll";

export function ForYouView({ model, workspace, selection, select, href, pinned }: LineViewProps) {
  const { now, ready } = workspace;
  // Only what an answer can reach; the rest is Problems' (the pointers below the list).
  const needs = useMemo(() => workspace.needs.filter((n) => n.counted), [workspace.needs]);
  const groups = useMemo(() => needGroups(needs), [needs]);
  const order = useMemo(() => needOrder(groups), [groups]);
  const processTitle = useMemo(() => new Map(workspace.processes.map((g) => [g.key, processName(g.key, g.title).title])), [workspace.processes]);
  const projectTitle = useMemo(() => new Map(workspace.projects.map((p) => [p._id, p.title])), [workspace.projects]);

  // The open item: the one the address names (an older link names its decision or card), else the first.
  const asked = selection.need ?? selection.decision ?? selection.card;
  const named = needForRef(needs, asked);
  // Every item this page has listed: one that leaves the list (answered here, or elsewhere) hands its place to the
  // next; one the address named that was never listed is not waiting on the viewer, and the reader says so.
  const listed = useRef(new Set<string>());
  for (const n of order) listed.current.add(n.ref);
  const gone = !named && !!asked && listed.current.has(asked);
  const lastAt = useRef(0);
  // A decision the address names that waits on nobody any more (answered, withdrawn) still opens, read as it stands.
  const orphan = !named && !gone ? selection.decision ?? (selection.need?.startsWith("sd-") ? selection.need : null) : null;
  const missing = !named && !gone && !orphan && ready ? selection.need : null;
  // A need named and not found opens nothing else, even while the feeds settle: only an item that left takes the next.
  const current = named ?? (orphan || (selection.need && !gone) ? null : order[Math.min(lastAt.current, order.length - 1)] ?? null);
  const at = current ? order.indexOf(current) : -1;
  if (at >= 0) lastAt.current = at;
  // A trial's practice answers are listed last and counted apart: the main "N of M" is the nav's count.
  const practice = useMemo(() => order.filter(isPractice), [order]);
  const real = order.length - practice.length;
  const pos = !current ? null : isPractice(current) ? `Trial ${practice.indexOf(current) + 1} of ${practice.length}` : `${at + 1} of ${real}`;

  // The address settles on `need`: an older link's key, or the item that took an answered one's place.
  // Landing with nothing named, the first item is named too, so the address is always the page as drawn.
  const settle = named && !selection.need ? named.ref
    : orphan && !selection.need && orphan.startsWith("sd-") ? orphan
    : !named && !asked && current ? current.ref
    : gone && ready ? current?.ref ?? ""
    : null;
  useWatchEffect(() => { if (settle != null) select({ need: settle || null, decision: null, card: null }, undefined, { replace: true }); }, [settle, select]);

  const open = (n: LineNeed, replace?: boolean) => select({ need: n.ref, decision: null, card: null }, undefined, replace ? { replace: true } : undefined);
  const list = useRef<HTMLDivElement>(null);
  const focusRow = (key: string) => list.current?.querySelector<HTMLElement>(`[data-need-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: false });
  const move = (dir: 1 | -1, focus = true) => {
    const to = order[Math.max(0, Math.min(order.length - 1, (at < 0 ? 0 : at) + dir))];
    if (!to || to === current) return;
    open(to, true);
    if (focus) focusRow(to.key);
  };
  // The list takes the keys on arrival, so J and K walk it at once and no key lands in the decision by accident.
  const landed = useRef(false);
  useWatchEffect(() => {
    if (landed.current || !current) return;
    landed.current = true;
    if (document.activeElement === document.body || !document.activeElement) list.current?.querySelector<HTMLElement>('[aria-current="true"]')?.focus({ preventScroll: true });
  }, [current]);
  // The open item can change without the list's keys (the reader's arrows, a link, an answered item handing over): focus
  // left on another row would read as a second selection, so it follows to the open row.
  useWatchEffect(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!current || !el?.classList.contains("fy-row") || el.dataset.needKey === current.key || !list.current?.contains(el)) return;
    focusRow(current.key);
  }, [current?.key]);
  // Back returns to the same place in the list.
  useWatchEffect(() => {
    const el = list.current;
    if (!el) return;
    const store = typeof window !== "undefined" ? window.sessionStorage : undefined;
    const saved = Number(store?.getItem(SCROLL_KEY) ?? 0);
    if (saved > 0) el.scrollTop = saved;
    const onScroll = () => store?.setItem(SCROLL_KEY, String(el.scrollTop));
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const prefetch = useMemo(() => order.filter((n) => n.kind === "decision" && n.decisionRef).map((n) => n.decisionRef!), [order]);
  const toProblem = (n: LineNeed | null) => (taskId: string) => select({ view: "problems", case: taskId, run: null, graph: n?.process ?? selection.graph });
  const toRun = (n: LineNeed | null) => (runId: string, taskId: string | null, step?: string) => select({ view: "problems", run: runId, graph: n?.process ?? selection.graph, ...(step ? { step } : {}) }, taskId);
  // `status` is the Problems page's own key: it rides on the address the selection writes.
  const problemsHref = href({ view: "problems", need: null, decision: null, card: null });
  // The pointers' counts are the Problems list's own (every process, no chip or search), so its chips say the same.
  const problemCounts = useProblemCounts({ model, workspace, selection });
  const elsewhere = ELSEWHERE.filter((k) => problemCounts[k] > 0);
  // One item and nothing else to list: the reader takes the whole width (its header still says 1 of 1).
  const single = order.length === 1 && !!current && elsewhere.length === 0;

  return (
    <div className="fy" data-line-foryou={real} data-line-foryou-open={current?.ref ?? orphan ?? undefined} data-single={single ? "" : undefined}>
      <LineDecisionPrefetch ids={prefetch} />
      <div className="fy-list" ref={list} role="navigation" aria-label="What waits on you" data-settling={ready ? undefined : ""}
        onKeyDown={(e) => {
          if (e.metaKey || e.ctrlKey || e.altKey) return;
          if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); move(1); }
          else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); move(-1); }
        }}>
        {order.length === 0 && <p className="fy-none" data-line-foryou-empty>Nothing waits on you</p>}
        {groups.filter((g) => g.needs.length > 0).map((g) => (
          <section key={g.key} className="fy-group" data-line-need-group={g.key}>
            <h2 className="fy-group-h">{g.label}<span className="lw-num">{g.needs.length}</span></h2>
            <ul className="fy-rows">
              {g.needs.map((n) => {
                // The row is what the item is about (the problem, by the one name every list gives it); what is asked is the reader's.
                const meta = [n.process ? processTitle.get(n.process) : null, pinned ? null : n.projectId ? projectTitle.get(n.projectId) : null, n.dups?.length ? `also ${n.dups.map((d) => d.ref).filter(Boolean).join(", ")}` : n.dupOf?.ref ? `same as ${n.dupOf.ref}` : null, n.since ? `waiting ${ageShort(now - n.since)}` : null].filter(Boolean);
                return (
                  <li key={n.key}>
                    <button type="button" className="fy-row" aria-current={n === current ? "true" : undefined} onClick={() => open(n)} data-need-key={n.key} data-line-need-row={n.kind} data-line-need-ref={n.ref}>
                      <span className="fy-ask">{problemListName(n)}</span>
                      {/* Its ref leads the line under the name, so a person told "ct-58683" finds the row without opening each. */}
                      <span className="fy-meta">{n.problemRef && <span className="fy-ref">{n.problemRef}</span>}{meta.map((m, i) => <span key={i}>{m}</span>)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        <ProblemPointers keys={ELSEWHERE} counts={problemCounts} href={href} className="fy-elsewhere" label="On Problems" />
        {order.length > 1 && <p className="fy-keys" aria-hidden><KeyCap size="xs">J</KeyCap><KeyCap size="xs">K</KeyCap></p>}
      </div>

      <div className="fy-reader" data-line-foryou-reader={current?.kind ?? (orphan ? "decision" : missing ? "missing" : "empty")}>
        {current ? (
          <>
            <div className="fy-reader-h" data-line-foryou-head>
              {current.caseId ? (
                <Link className="fy-head" href={href({ view: "problems", case: current.caseId, run: null, graph: current.process ?? selection.graph })} data-line-foryou-problem={current.problemRef ?? current.caseId}>
                  {current.problemRef && <span className="fy-ref">{current.problemRef}</span>}
                  <span className="fy-title">{problemListName(current)}</span>
                </Link>
              ) : <span className="fy-head"><span className="fy-title">{problemListName(current)}</span></span>}
              {current.since && <span className="fy-age lw-num" title={`Waiting since ${new Date(current.since).toLocaleString()}`}>waiting {ageShort(now - current.since)}</span>}
              {current.trial && <TrialTag projectId={current.projectId ?? null} card={current.cardRef ?? null} />}
              <span className="fy-pos lw-num">{pos}</span>
              <button type="button" className="lw-iconbtn" disabled={at <= 0} onClick={() => move(-1, false)} aria-label="Previous"><ChevronLeft className="w-4 h-4" /></button>
              <button type="button" className="lw-iconbtn" disabled={at >= order.length - 1} onClick={() => move(1, false)} aria-label="Next"><ChevronRight className="w-4 h-4" /></button>
            </div>
            <div className="fy-reader-b">
              <WaitingItem key={current.key} need={current} now={now} onProblem={toProblem(current)} onRun={toRun(current)} head={false} asked={false} />
            </div>
          </>
        ) : orphan ? (
          <>
            <div className="fy-reader-h"><span className="fy-process">Not in your list</span></div>
            <div className="fy-reader-b"><LineDecision key={orphan} id={orphan} onProblem={toProblem(null)} onRun={toRun(null)} /></div>
          </>
        ) : missing ? (
          <div className="fy-clear" data-line-foryou-missing={missing}>
            <div className="fy-missing">
              <b className="lw-num">{missing}</b>
              <span>Not waiting on you</span>
              {missing.startsWith("ct-") && <Link className="lw-act" href={href({ view: "problems", case: missing, need: null })}>Open the problem</Link>}
            </div>
          </div>
        ) : (
          <div className="fy-clear" data-line-foryou-clear>
            <Link className="fy-figure" href={problemsHref}>
              <b className="lw-num">{workspace.open}</b>
              <span>open {workspace.open === 1 ? "problem" : "problems"}</span>
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

/** A trial row's tag: opens that project's trial on this row's own card, in the workspace it lives in. */
function TrialTag({ projectId, card }: { projectId: string | null; card: string | null }) {
  return <Link className="fy-trial" href={useTrialHref(projectId, card)} title="A trial run: answering records what you would do and ships nothing" data-line-foryou-trial>Trial</Link>;
}
