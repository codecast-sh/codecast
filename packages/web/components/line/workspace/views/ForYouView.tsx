"use client";
// For you (line-journeys.md LJ8.1): the landing page. Its job is to clear what
// waits on the viewer, so it is a list with a reader beside it from the first
// paint: the first item is open on arrival, it is read and answered in the
// reader (WaitingItem), and when it leaves the list the next one opens. No row
// carries a button: every act is in the reader, next to the whole text. While
// an item is open the session rail stays folded to a strip (LineWorkspace
// claims the tab's width), so nothing unrelated sits beside a decision.
//
// The list is what a line puts in front of a person, and nothing else: the
// decision a session presents at the end of its run, one per problem, across
// every process, and a trial's practice decisions apart, last. Everything else
// a problem waits on (a fix to land, a fact for the lead, a run to ask again)
// is the line's, filed on Problems and the line's own page, never here. The
// nav's count, the list and the reader's "N of M" are the same rows. A row is
// what is asked (the decision's question), in the words the reader opens on;
// the head holds only its product, its age, a link to what it is about (the
// problem, or the task itself when it is not a problem on the line) and the
// pager (when there is more than one). The open item is `need` in the URL; an older link's `decision` or
// `card` settles on it. A need the address names that is not in the list is
// said to be so, never swapped for another item. J and K walk the list while
// focus is in it; nothing here moves focus into the reader, where a decision
// takes keys.
import { useMemo, useRef } from "react";
import Link from "next/link";
import { ArrowUpRight, ChevronLeft, ChevronRight, X } from "lucide-react";
import { useWatchEffect } from "../../../../hooks/useWatchEffect";
import { useInboxStore } from "../../../../store/inboxStore";
import { ageShort } from "../../../../lib/lineFlow";
import { processName } from "../../../../lib/line/lineGraphs";
import { isPractice, needForRef, needGroups, needOrder, needsOfLine, type LineNeed } from "../../../../lib/line/lineNeeds";
import { problemHeadName, problemListName } from "../../../../lib/line/problemTable";
import { leftWhy } from "../../../../lib/line/leftList";
import { lineRefHref } from "../../../../lib/line/lineWorkspaceUrl";
import { taskByRef } from "../../../../lib/taskRef";
import { KeyCap } from "../../../KeyCap";
import { LineDecisionPrefetch } from "../../widgets/LineDecision";
import { DecisionSession } from "../../widgets/DecisionSession";
import { WaitingItem } from "../../widgets/WaitingItem";
import { useTrialHref } from "../../../../hooks/useSyncTrial";
import { useAllProblems } from "./ProblemPointers";
import type { LineViewProps } from "./types";
import "./foryou.css";

const SCROLL_KEY = "line:foryou:scroll";

export function ForYouView({ model, workspace, selection, select, href, pinned }: LineViewProps) {
  const { now, ready } = workspace;
  // Only the decisions (lineNeeds COUNTED): the rest is the line's, on Problems, and an address naming one says so.
  // `process` in the address (the Line page's "N waiting on you") narrows the list to that line, and to the project
  // picked there; the chip over the list lifts it.
  const line = selection.process;
  const lineProject = line ? selection.project : null;
  const needs = useMemo(() => needsOfLine(workspace.needs.filter((n) => n.counted), line, lineProject), [workspace.needs, line, lineProject]);
  const groups = useMemo(() => needGroups(needs), [needs]);
  const order = useMemo(() => needOrder(groups), [groups]);
  const processTitle = useMemo(() => new Map(workspace.processes.map((g) => [g.key, processName(g.key, g.title).title])), [workspace.processes]);
  // A row's product by name. For you lists decisions from every workspace, and the page's projects are its own
  // workspace's: another's are named from the store.
  const projectIds = useMemo(() => [...new Set(needs.map((n) => n.projectId).filter((p): p is string => !!p))], [needs]);
  const storeTitles = useInboxStore((s) => projectIds.map((id) => (s.projects as Record<string, { title?: string } | undefined> | undefined)?.[id]?.title ?? "").join("\u0001"));
  const projectTitle = useMemo(() => {
    const m = new Map(workspace.projects.map((p) => [p._id, p.title]));
    storeTitles.split("\u0001").forEach((t, i) => { if (t && !m.get(projectIds[i])) m.set(projectIds[i], t); });
    return m;
  }, [workspace.projects, storeTitles, projectIds]);

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
    // With nothing open (the named item left), the next is the first.
    const to = order[Math.max(0, Math.min(order.length - 1, (at < 0 ? -1 : at) + dir))];
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
  const allProblems = useAllProblems({ model, workspace, selection, process: line });
  // A problem the address names that waits on the viewer no more: its name, where it stands, and what moved it.
  const left = useMemo(() => {
    if (!missing) return null;
    const issue = workspace.problems.find((i) => i.ref === missing || i.id === missing);
    if (!issue) return null;
    const row = allProblems.all.find((r) => r.id === issue.id) ?? null;
    return { issue, phrase: row?.stand.phrase ?? null, ...leftWhy(issue.history, workspace.names, now) };
  }, [missing, workspace.problems, workspace.names, allProblems.all, now]);
  // One item: the reader takes the whole width, and the head has no pager.
  const single = order.length === 1 && !!current;
  // A decision about a task no finding raised (filed by hand, then run on the line) has no problem page: its link opens
  // the task itself, whole, never a page that says it is not there.
  const plainTask = useInboxStore((s) => {
    const ref = current?.caseId ?? current?.problemRef;
    const t = ref ? taskByRef((s.tasks ?? {}) as unknown as Record<string, { _id: string; cause?: unknown; short_id?: string }>, ref) : null;
    return t && !t.cause ? t.short_id ?? t._id : null;
  });

  return (
    <div className="fy" data-line-foryou={real} data-line-foryou-open={current?.ref ?? orphan ?? undefined} data-single={single ? "" : undefined}>
      <LineDecisionPrefetch ids={prefetch} />
      <div className="fy-list" ref={list} role="navigation" aria-label="What waits on you" data-settling={ready ? undefined : ""}
        onKeyDown={(e) => {
          if (e.metaKey || e.ctrlKey || e.altKey) return;
          if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); move(1); }
          else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); move(-1); }
        }}>
        {line && (
          <button type="button" className="fy-scope" aria-pressed onClick={() => select({ process: null, need: null }, undefined, { replace: true })} aria-label="Show what waits on you in every line" data-line-foryou-process={line}>
            {[processTitle.get(line) ?? line, lineProject ? projectTitle.get(lineProject) : null].filter(Boolean).join(" · ")}<X aria-hidden />
          </button>
        )}
        {order.length === 0 && <p className="fy-none" data-line-foryou-empty>Nothing waits on you</p>}
        {groups.filter((g) => g.needs.length > 0).map((g) => (
          <section key={g.key} className="fy-group" data-line-need-group={g.key}>
            <h2 className="fy-group-h">{g.label}<span className="lw-num">{g.needs.length}</span></h2>
            <ul className="fy-rows">
              {g.needs.map((n) => {
                // The row is what is asked, as the reader opens on it; a need with no question of its own reads by the problem's name.
                // Under it, the product it is about: which line runs it is the line's business, not the reader's.
                const meta = [pinned ? null : n.projectId ? projectTitle.get(n.projectId) : null, n.dups?.length ? `also ${n.dups.map((d) => d.ref).filter(Boolean).join(", ")}` : n.dupOf?.ref ? `same as ${n.dupOf.ref}` : null, n.since ? `waiting ${ageShort(now - n.since)}` : null].filter(Boolean);
                return (
                  <li key={n.key}>
                    <button type="button" className="fy-row" aria-current={n === current ? "true" : undefined} onClick={() => open(n)} data-need-key={n.key} data-line-need-row={n.kind} data-line-need-ref={n.ref} title={n.problemRef ?? undefined}>
                      <span className="fy-ask">{n.line && n.line !== n.title ? n.line : problemListName(n)}</span>
                      {/* The ref is the row's hover and the page's search, never its words: a person reads the name. */}
                      <span className="fy-meta">{meta.map((m, i) => <span key={i}>{m}</span>)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        {order.length > 1 && <p className="fy-keys" aria-hidden><KeyCap size="xs">J</KeyCap><KeyCap size="xs">K</KeyCap></p>}
      </div>

      <div className="fy-reader" data-line-foryou-reader={current?.kind ?? (orphan ? "decision" : missing ? "missing" : "empty")}>
        {current ? (
          <>
            <div className="fy-reader-h" data-line-foryou-head>
              {/* The decision's own question names what it is about, so the head carries no second name: the product it
                  is for, how long it has waited, the problem to open, and the pager while there is more than one. */}
              <span className="fy-head">
                {!pinned && current.projectId && projectTitle.get(current.projectId) && <span className="fy-proj">{projectTitle.get(current.projectId)}</span>}
                {current.since && <span className="fy-age lw-num" title={`Waiting since ${new Date(current.since).toLocaleString()}`}>waiting {ageShort(now - current.since)}</span>}
                {current.trial && <TrialTag projectId={current.projectId ?? null} card={current.cardRef ?? null} />}
              </span>
              {/* A problem outside this line's view (its project runs no line here) opens by its ref, wherever it lives. */}
              {plainTask ? (
                <Link className="fy-problem" href={`/tasks/${plainTask}`} title={problemHeadName(current)} data-line-foryou-task={plainTask}>Open the task<ArrowUpRight className="w-3.5 h-3.5" aria-hidden /></Link>
              ) : (current.caseId || current.problemRef) && (
                <Link className="fy-problem" href={current.caseId ? href({ view: "problems", case: current.caseId, run: null, graph: current.process ?? selection.graph }) : lineRefHref(current.problemRef!)} title={[current.problemRef, problemHeadName(current)].filter(Boolean).join(" ")} data-line-foryou-problem={current.problemRef ?? current.caseId}>
                  Open the problem<ArrowUpRight className="w-3.5 h-3.5" aria-hidden />
                </Link>
              )}
              {order.length > 1 && <>
                <span className="fy-pos lw-num">{pos}</span>
                <button type="button" className="lw-iconbtn" disabled={at <= 0} onClick={() => move(-1, false)} aria-label="Previous"><ChevronLeft className="w-4 h-4" /></button>
                <button type="button" className="lw-iconbtn" disabled={at >= order.length - 1} onClick={() => move(1, false)} aria-label="Next"><ChevronRight className="w-4 h-4" /></button>
              </>}
            </div>
            <div className="fy-reader-b">
              {current.kind === "decision" && current.decisionRef
                ? <DecisionSession key={current.key} id={current.decisionRef} position={at + 1} total={order.length} onSkip={() => move(1, false)} />
                : <WaitingItem key={current.key} need={current} now={now} onProblem={toProblem(current)} onRun={toRun(current)} head={false} asked={false} />}
            </div>
          </>
        ) : orphan ? (
          <>
            <div className="fy-reader-h"><span className="fy-process">Not in your list</span></div>
            <div className="fy-reader-b"><DecisionSession key={orphan} id={orphan} /></div>
          </>
        ) : missing && left ? (
          <LeftItem left={left} next={order[0] ?? null} onNext={() => move(1)}
            problemHref={href({ view: "problems", case: left.issue.id, run: null, need: null, graph: left.issue.process })}
            runHref={left.runId ? href({ view: "problems", run: left.runId, need: null, graph: left.issue.process }) : null} />
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

/** The reader for a problem that waits on the viewer no more: its name whole, where it stands now, what moved it, and
 *  the next waiting item as the primary act, so the person keeps working through the list. */
function LeftItem({ left, next, onNext, problemHref, runHref }: {
  left: { issue: { id: string; ref: string | null; title: string; name?: string | null }; phrase: string | null; moved: string | null };
  next: LineNeed | null; onNext: () => void; problemHref: string; runHref: string | null;
}) {
  const go = useRef<HTMLButtonElement>(null);
  // Arriving here, the keys are the pane's: J takes the next waiting item.
  useWatchEffect(() => { if (document.activeElement === document.body || !document.activeElement) go.current?.focus({ preventScroll: true }); }, []);
  return (
    <div className="fy-left" data-line-foryou-missing={left.issue.ref ?? left.issue.id} data-line-foryou-left=""
      onKeyDown={(e) => { if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === "j" || e.key === "ArrowDown") && next) { e.preventDefault(); onNext(); } }}>
      <div className="fy-reader-h">
        <Link className="fy-head" href={problemHref}>
          {left.issue.ref && <span className="fy-ref">{left.issue.ref}</span>}
          <span className="fy-title">{problemHeadName(left.issue)}</span>
        </Link>
      </div>
      <div className="fy-left-b">
        <dl className="fy-left-facts">
          <div><dt>For you</dt><dd>Not waiting on you</dd></div>
          {left.moved && <div data-line-foryou-moved=""><dt>What moved it</dt><dd>{left.moved}</dd></div>}
          {left.phrase && <div><dt>Now</dt><dd>{left.phrase}</dd></div>}
        </dl>
        <div className="fy-left-acts">
          {next && <button ref={go} type="button" className="lw-act" data-primary="" onClick={onNext} data-line-foryou-next="">Next waiting<KeyCap size="xs">J</KeyCap></button>}
          {runHref && <Link className="lw-act" href={runHref}>Open the run</Link>}
          <Link className="lw-act" href={problemHref} data-primary={next ? undefined : ""}>Open the problem</Link>
        </div>
      </div>
    </div>
  );
}

/** A trial row's tag: opens that project's trial on this row's own card, in the workspace it lives in. */
function TrialTag({ projectId, card }: { projectId: string | null; card: string | null }) {
  return <Link className="fy-trial" href={useTrialHref(projectId, card)} title="A trial run: answering records what you would do and ships nothing" data-line-foryou-trial>Trial</Link>;
}
