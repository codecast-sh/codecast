"use client";
// Decisions (line-journeys.md LJ8.1): the flows' decisions, the landing page.
// It is the Decisions page's Team list (components/decisions/DecisionList)
// with its rows narrowed to the decisions the team's flows ask, so the two
// lists name the same owner, group, order and actions for every one: tabs,
// filters, a grouping and a second one, a sort, a selection the palette
// assigns, answers or dismisses. Opening a decision puts the list beside the
// reader: the decision whole (LineDecision), its problem one link away. When
// the open decision leaves the list (answered here or elsewhere) the next one
// opens. A need the address names that is not in the list is said to be so,
// never swapped for another.
//
// `process` in the address (the Line page's "N waiting on you") narrows the
// list to that line, and to the project picked there; `flow` (a flow's
// owner) to that flow's projects; the chip over the list lifts either. The
// open one is `need`, and an older link's `decision` or `card` settles on it.
import { useMemo, useRef } from "react";
import Link from "next/link";
import { ArrowUpRight, ChevronLeft, ChevronRight, X } from "lucide-react";
import { useWatchEffect } from "../../../../hooks/useWatchEffect";
import { useInboxStore, type SessionDecisionItem } from "../../../../store/inboxStore";
import { processName } from "../../../../lib/line/lineGraphs";
import { needForRef, needsOfLine, type LineNeed } from "../../../../lib/line/lineNeeds";
import { problemHeadName } from "../../../../lib/line/problemTable";
import { leftWhy } from "../../../../lib/line/leftList";
import { lineRefHref } from "../../../../lib/line/lineWorkspaceUrl";
import { taskByRef } from "../../../../lib/taskRef";
import { LineDecision, LineDecisionPrefetch } from "../../widgets/LineDecision";
import { WaitingItem } from "../../widgets/WaitingItem";
import { OriginTrail } from "../../widgets/OriginTrail";
import { useAllProblems } from "./ProblemPointers";
import type { LineViewProps } from "./types";
import { useOwnedFlows } from "../../../../hooks/useOwnedFlows";
import { flowNeeds, flowOf } from "../../../../lib/line/ownedFlows";
import { useCollectionRows } from "../../../../hooks/useCollectionRows";
import { decisionRowSig } from "../../../../hooks/useDecisionRows";
import { useDecisionView } from "../../../../hooks/useDecisionView";
import { DecisionList } from "../../../decisions/DecisionList";
import { arrangeDecisions, decisionView, viewFields, type DecisionAxis, type DecisionView } from "../../../../lib/decisions/decisionRows";
import "./foryou.css";

const FLOW_TABS = ["team", "mine", "unassigned", "escalated"] as const;
const NO_LABEL = () => "";

/** The view an older For you address names (`who`, `group`), as the list's own: who holds it is the owner. */
function seedView(sel: LineViewProps["selection"], pinned: boolean): Partial<DecisionView> {
  const group: Record<string, DecisionAxis> = { area: "area", kind: "kind", who: "owner" };
  const who = sel.who ?? "";
  return {
    tab: who === "me" ? "mine" : who === "none" ? "unassigned" : "team",
    owner: who && who !== "me" && who !== "none" && who !== "all" ? `user:${who}` : "",
    area: sel.area ?? "",
    group: sel.group === "none" ? "none" : group[sel.group ?? ""] ?? (pinned ? "kind" : "area"),
    sort: sel.order === "severity" || sel.order === "age" || sel.order === "findings" ? sel.order : "impact",
  };
}

export function ForYouView({ model, workspace, selection, select, href, pinned }: LineViewProps) {
  const { now, ready } = workspace;
  const line = selection.process;
  const lineProject = line ? selection.project : null;
  const flow = flowOf(useOwnedFlows(workspace), selection.flow);
  // Only the decisions (lineNeeds COUNTED): the rest is the line's, on Problems, and an address naming one says so.
  const needs = useMemo(() => {
    const all = needsOfLine(workspace.needs.filter((n) => n.counted), line, lineProject);
    return flow ? flowNeeds(all, flow) : all;
  }, [workspace.needs, line, lineProject, flow]);
  const processTitle = useMemo(() => new Map(workspace.processes.map((g) => [g.key, processName(g.key, g.title, g.label).title])), [workspace.processes]);
  const projectTitle = useMemo(() => new Map(workspace.projects.map((p) => [p._id, p.title])), [workspace.projects]);

  // The list's rows: the decision rows these needs stand on, read from the one decision collection.
  const needByDecision = useMemo(() => new Map(needs.filter((n) => n.decisionId).map((n) => [n.decisionId!, n])), [needs]);
  const where = useMemo(() => (d: SessionDecisionItem) => needByDecision.has(d._id), [needByDecision]);
  const rows = useCollectionRows<SessionDecisionItem>("sessionDecisions", { where, sig: decisionRowSig });
  const listRows = useMemo(() => ({ mine: rows, workspace: rows }), [rows]);
  const seed = seedView(selection, !!pinned);
  const state = useDecisionView({ scoped: seed });
  // A link that names another who or grouping while the list is open (the Line page's counts) re-seeds it.
  const seedKey = [selection.who, selection.area, selection.group, selection.order].join("|");
  const seeded = useRef(seedKey);
  useWatchEffect(() => {
    if (seeded.current === seedKey) return;
    seeded.current = seedKey;
    state.replace(viewFields(decisionView(seed)));
  }, [seedKey]);
  const me = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  // The list top to bottom, as it draws it: what the reader pages through and hands on to.
  const order = useMemo(
    () => arrangeDecisions(rows, state.view, { me, now, label: NO_LABEL }).items.map((d) => needByDecision.get(d._id)).filter((n): n is LineNeed => !!n),
    [rows, state.view, me, now, needByDecision],
  );

  // The open item: the one the address names (an older link names its decision or card). Nothing named, nothing is open.
  const asked = selection.need ?? selection.decision ?? selection.card;
  const named = needForRef(needs, asked);
  // Every item this page has listed: one that leaves the list (answered here, or elsewhere) hands its place to the
  // next; one the address named that was never listed is not in the list, and the reader says so.
  const listed = useRef(new Set<string>());
  for (const n of order) listed.current.add(n.ref);
  const gone = !named && !!asked && listed.current.has(asked);
  const lastAt = useRef(0);
  // A decision the address names that waits on nobody any more (answered, withdrawn) still opens, read as it stands.
  const orphan = !named && !gone ? selection.decision ?? (selection.need?.startsWith("sd-") ? selection.need : null) : null;
  const missing = !named && !gone && !orphan && ready ? selection.need : null;
  const current = named ?? (gone ? order[Math.min(lastAt.current, order.length - 1)] ?? null : null);
  const at = current ? order.indexOf(current) : -1;
  if (at >= 0) lastAt.current = at;
  const pos = at >= 0 ? `${at + 1} of ${order.length}` : null;
  const reading = !!current || !!orphan || !!missing;

  // The address settles on `need`: an older link's key, or the item that took an answered one's place (none left: the table).
  const settle = named && !selection.need ? named.ref
    : orphan && !selection.need && orphan.startsWith("sd-") ? orphan
    : gone && ready ? current?.ref ?? ""
    : null;
  useWatchEffect(() => { if (settle != null) select({ need: settle || null, decision: null, card: null }, undefined, { replace: true }); }, [settle, select]);

  const open = (n: LineNeed, replace?: boolean) => select({ need: n.ref, decision: null, card: null }, undefined, replace ? { replace: true } : undefined);
  const close = () => select({ need: null, decision: null, card: null });
  const move = (dir: 1 | -1) => { const to = order[Math.max(0, Math.min(order.length - 1, at + dir))]; if (to && to !== current) open(to, true); };

  const prefetch = useMemo(() => order.filter((n) => n.decisionId).map((n) => n.decisionId!), [order]);
  // The decisions a step away: their pages load ahead, so stepping shows each at once.
  const warm = useMemo(() => [order[at + 1], order[at - 1]].filter((n) => n?.decisionId).map((n) => n!.decisionId!), [order, at]);
  const toProblem = (n: LineNeed | null) => (taskId: string) => select({ view: "problems", case: taskId, run: null, graph: n?.process ?? selection.graph });
  const toRun = (n: LineNeed | null) => (runId: string, taskId: string | null, step?: string) => select({ view: "problems", run: runId, graph: n?.process ?? selection.graph, ...(step ? { step } : {}) }, taskId);
  // Only a problem the address names that is not in the list reads its row.
  const allProblems = useAllProblems({ model, workspace, selection, process: line, read: !!missing });
  // A problem the address names that is not in the list: its name, where it stands, and what moved it.
  const left = useMemo(() => {
    if (!missing) return null;
    const issue = workspace.problems.find((i) => i.ref === missing || i.id === missing);
    if (!issue) return null;
    const row = allProblems.all.find((r) => r.id === issue.id) ?? null;
    return { issue, phrase: row?.stand.phrase ?? null, ...leftWhy(issue.history, workspace.names, now) };
  }, [missing, workspace.problems, workspace.names, allProblems.all, now]);
  // A decision about a task no finding raised (filed by hand, then run on the line) has no problem page: its link opens
  // the task itself, whole, never a page that says it is not there.
  const plainTask = useInboxStore((s) => {
    const ref = current?.caseId ?? current?.problemRef;
    const t = ref ? taskByRef((s.tasks ?? {}) as unknown as Record<string, { _id: string; cause?: unknown; short_id?: string }>, ref) : null;
    return t && !t.cause ? t.short_id ?? t._id : null;
  });

  const scope = line ? (
    <button type="button" className="fy-scope" aria-pressed onClick={() => select({ process: null, need: null }, undefined, { replace: true })} aria-label="Show the decisions of every flow" data-line-foryou-process={line}>
      {[processTitle.get(line) ?? line, lineProject ? projectTitle.get(lineProject) : null].filter(Boolean).join(" · ")}<X aria-hidden />
    </button>
  ) : flow ? (
    <button type="button" className="fy-scope" aria-pressed onClick={() => select({ flow: null, need: null }, undefined, { replace: true })} aria-label="Show the decisions of every flow" data-line-foryou-flow={flow.owner.handle}>
      {flow.owner.name}<X aria-hidden />
    </button>
  ) : null;

  return (
    <div className="fy" data-line-foryou={order.length} data-line-foryou-open={current?.ref ?? orphan ?? undefined} data-mode={reading ? "read" : "table"}>
      <LineDecisionPrefetch ids={prefetch} warm={warm} />
      <div className="fy-pane" data-settling={ready ? undefined : ""}>
        <DecisionList
          title="Decisions"
          state={state}
          rows={listRows}
          tabs={FLOW_TABS}
          hideAxes={pinned ? ["area"] : []}
          routeOf={(d) => href({ need: d.short_id ?? d._id, decision: null, card: null })}
          activeItemId={current?.decisionId ?? undefined}
          headerExtra={scope}
          compact={reading}
          emptyMessage={needs.length === 0 ? "No open decisions" : "None match"}
        />
      </div>
      {reading && (
        <div className="fy-reader" data-line-foryou-reader={current?.kind ?? (orphan ? "decision" : missing ? "missing" : "empty")}>
          {current ? (
            <>
              <div className="fy-reader-h" data-line-foryou-head>
                <button type="button" className="lw-iconbtn" onClick={close} aria-label="Back to every decision" title="Back to every decision"><X className="w-4 h-4" /></button>
                {/* A problem outside this line's view (its project runs no line here) opens by its ref, wherever it lives. */}
                {plainTask ? (
                  <Link className="fy-problem" href={`/tasks/${plainTask}`} title={problemHeadName(current)} data-line-foryou-task={plainTask}>Open the problem<ArrowUpRight className="w-3.5 h-3.5" aria-hidden /></Link>
                ) : (current.caseId || current.problemRef) && (
                  <Link className="fy-problem" href={current.caseId ? href({ view: "problems", case: current.caseId, run: null, graph: current.process ?? selection.graph }) : lineRefHref(current.problemRef!)} title={[current.problemRef, problemHeadName(current)].filter(Boolean).join(" ")} data-line-foryou-problem={current.problemRef ?? current.caseId}>
                    Open the problem<ArrowUpRight className="w-3.5 h-3.5" aria-hidden />
                  </Link>
                )}
                {order.length > 1 && <span className="fy-pager">
                  <span className="fy-pos lw-num">{pos}</span>
                  <button type="button" className="lw-iconbtn" disabled={at <= 0} onClick={() => move(-1)} aria-label="Previous"><ChevronLeft className="w-4 h-4" /></button>
                  <button type="button" className="lw-iconbtn" disabled={at < 0 || at >= order.length - 1} onClick={() => move(1)} aria-label="Next"><ChevronRight className="w-4 h-4" /></button>
                </span>}
              </div>
              {/* Keyed by the item: the body is the decision's scroll, so the next one opens at its top. */}
              <div className="fy-reader-b" key={current.key} data-flow={current.kind === "decision" && (current.decisionId || current.decisionRef) ? "" : undefined}>
                {(current.decisionId || current.caseId) && <div className="fy-origin" data-line-foryou-origin><OriginTrail key={current.key} decision={current.decisionId ?? null} task={current.decisionId ? null : current.caseId ?? null} folded /></div>}
                {current.kind === "decision" && (current.decisionId || current.decisionRef)
                  ? <LineDecision key={current.key} id={current.decisionId ?? current.decisionRef!} head={false} quiet inline onProblem={toProblem(current)} onRun={toRun(current)} />
                  : <WaitingItem key={current.key} need={current} now={now} onProblem={toProblem(current)} onRun={toRun(current)} head={false} asked={false} />}
              </div>
            </>
          ) : orphan ? (
            <>
              <div className="fy-reader-h"><button type="button" className="lw-iconbtn" onClick={close} aria-label="Back to every decision"><X className="w-4 h-4" /></button><span className="fy-process">Not open</span></div>
              <div className="fy-reader-b"><LineDecision key={orphan} id={orphan} head={false} quiet /></div>
            </>
          ) : missing && left ? (
            <LeftItem left={left} next={order[0] ?? null} onNext={() => open(order[0])}
              problemHref={href({ view: "problems", case: left.issue.id, run: null, need: null, graph: left.issue.process })}
              runHref={left.runId ? href({ view: "problems", run: left.runId, need: null, graph: left.issue.process }) : null} />
          ) : (
            <div className="fy-clear" data-line-foryou-missing={missing ?? undefined}>
              <div className="fy-missing">
                <b className="lw-num">{missing}</b>
                <span>Not an open decision</span>
                {missing?.startsWith("ct-") && <Link className="lw-act" href={href({ view: "problems", case: missing, need: null })}>Open the problem</Link>}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The reader for a problem the address names that is not an open decision: its name whole, where it stands now, what
 *  moved it, and the first open decision as the primary act, so the person keeps working through the list. */
function LeftItem({ left, next, onNext, problemHref, runHref }: {
  left: { issue: { id: string; ref: string | null; title: string; name?: string | null }; phrase: string | null; moved: string | null };
  next: LineNeed | null; onNext: () => void; problemHref: string; runHref: string | null;
}) {
  const go = useRef<HTMLButtonElement>(null);
  useWatchEffect(() => { if (document.activeElement === document.body || !document.activeElement) go.current?.focus({ preventScroll: true }); }, []);
  return (
    <div className="fy-left" data-line-foryou-missing={left.issue.ref ?? left.issue.id} data-line-foryou-left="">
      <div className="fy-reader-h">
        <Link className="fy-head" href={problemHref}>
          {left.issue.ref && <span className="fy-ref">{left.issue.ref}</span>}
          <span className="fy-title">{problemHeadName(left.issue)}</span>
        </Link>
      </div>
      <div className="fy-left-b">
        <dl className="fy-left-facts">
          <div><dt>Decision</dt><dd>None open</dd></div>
          {left.moved && <div data-line-foryou-moved=""><dt>What moved it</dt><dd>{left.moved}</dd></div>}
          {left.phrase && <div><dt>Now</dt><dd>{left.phrase}</dd></div>}
        </dl>
        <div className="fy-left-acts">
          {next && <button ref={go} type="button" className="lw-act" data-primary="" onClick={onNext} data-line-foryou-next="">Next decision</button>}
          {runHref && <Link className="lw-act" href={runHref}>Open the run</Link>}
          <Link className="lw-act" href={problemHref} data-primary={next ? undefined : ""}>Open the problem</Link>
        </div>
      </div>
    </div>
  );
}
