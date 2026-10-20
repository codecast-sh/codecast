"use client";
// Decisions (line-journeys.md LJ8.1): the team's decision inbox, the landing
// page. Every open decision the team's lines ask is listed for every member,
// whoever it was asked of or assigned to, so a few hundred can be worked
// through together. With nothing open the list takes the whole width as a
// table, one decision a row and one fact a column (severity, kind, people
// reached, findings, area, assignee, age), each column's head ordering it,
// so a long list is scanned down a column. Opening a decision puts the list
// beside the reader: the decision whole (LineDecision), drawn from its row at
// once, its page and the session's words filling in. When the open decision
// leaves the list (answered here or elsewhere) the next one opens.
//
// The list narrows by who holds it, its kind and its area, orders by impact
// or a column, and groups; every choice is in the address (`who`, `kind`,
// `area`, `order`, `group`), the open one is `need`, and an older link's
// `decision` or `card` settles on it. A need the address names that is not
// in the list is said to be so, never swapped for another. Rows can be
// selected and assigned together. Keys: J and K walk, Enter opens (and, with
// one open, hands the keys to the reader, where a digit answers), X selects,
// A assigns, Esc steps back out.
import { useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowDownWideNarrow, ArrowUpRight, Check, ChevronLeft, ChevronRight, Layers, Rows3, Shapes, SquareStack, UserRound, Users, X } from "lucide-react";
import { useWatchEffect } from "../../../../hooks/useWatchEffect";
import { useInboxStore } from "../../../../store/inboxStore";
import { ageShort } from "../../../../lib/lineFlow";
import { processName } from "../../../../lib/line/lineGraphs";
import { needForRef, needsOfLine, type LineNeed } from "../../../../lib/line/lineNeeds";
import { arrangeInbox, inboxView, INBOX_GROUP_LABEL, INBOX_GROUPS, INBOX_ORDER_LABEL, type InboxOrder, type InboxView } from "../../../../lib/line/decisionInbox";
import { DECISION_CHANGE_LABEL, DECISION_CHANGES, severityBand } from "../../../../lib/line/decisionFacts";
import { problemHeadName, problemListName } from "../../../../lib/line/problemTable";
import { leftWhy } from "../../../../lib/line/leftList";
import { lineRefHref } from "../../../../lib/line/lineWorkspaceUrl";
import { taskByRef } from "../../../../lib/taskRef";
import { KeyCap } from "../../../KeyCap";
import { FilterDropdown, type FilterOption } from "../../../FilterDropdown";
import { useTeamRosterIdentity } from "../../../../hooks/useTeamRoster";
import { useRolesAndPeopleOptions, type AssigneeOption } from "../../../../hooks/useRolesAndPeopleOptions";
import { LineDecision, LineDecisionPrefetch } from "../../widgets/LineDecision";
import { WaitingItem } from "../../widgets/WaitingItem";
import { useAllProblems } from "./ProblemPointers";
import { AssignDecision } from "./AssignDecision";
import type { LineViewProps } from "./types";
import "./foryou.css";

const SCROLL_KEY = "line:foryou:scroll";
type ViewPatch = Partial<Record<"who" | "kind" | "area" | "order" | "group", string | null>>;

export function ForYouView({ model, workspace, selection, select, href, pinned }: LineViewProps) {
  const { now, ready } = workspace;
  // Only the decisions (lineNeeds COUNTED): the rest is the line's, on Problems, and an address naming one says so.
  // `process` in the address (the Line page's "N waiting on you") narrows the list to that line, and to the project
  // picked there; the chip over the list lifts it.
  const line = selection.process;
  const lineProject = line ? selection.project : null;
  const needs = useMemo(() => needsOfLine(workspace.needs.filter((n) => n.counted), line, lineProject), [workspace.needs, line, lineProject]);
  const processTitle = useMemo(() => new Map(workspace.processes.map((g) => [g.key, processName(g.key, g.title).title])), [workspace.processes]);
  // A row's product by name. The list holds decisions from every workspace, and the page's projects are its own
  // workspace's: another's are named from the store.
  const projectIds = useMemo(() => [...new Set(needs.map((n) => n.projectId).filter((p): p is string => !!p))], [needs]);
  const storeTitles = useInboxStore((s) => projectIds.map((id) => (s.projects as Record<string, { title?: string } | undefined> | undefined)?.[id]?.title ?? "").join("\u0001"));
  const projectTitle = useMemo(() => {
    const m = new Map(workspace.projects.map((p) => [p._id, p.title]));
    storeTitles.split("\u0001").forEach((t, i) => { if (t && !m.get(projectIds[i])) m.set(projectIds[i], t); });
    return m;
  }, [workspace.projects, storeTitles, projectIds]);

  // Filtered, ordered and grouped as the address says. Pinned to one product, it groups by kind unless told otherwise.
  const view = useMemo(() => {
    const v = inboxView(selection);
    return pinned && v.group === "area" ? { ...v, group: "kind" as const } : v;
  }, [selection.who, selection.kind, selection.area, selection.order, selection.group, pinned]); // eslint-disable-line react-hooks/exhaustive-deps
  const viewer = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  const roster = useTeamRosterIdentity();
  const { people } = useRolesAndPeopleOptions(roster);
  const personName = useMemo(() => {
    const m = new Map(people.map((p) => [p.key, p.label]));
    return (id: string) => m.get(id) ?? workspace.names.get(id) ?? "Someone";
  }, [people, workspace.names]);
  const areaName = useMemo(() => (p: string | null) => (p ? projectTitle.get(p) ?? "Another product" : "No product"), [projectTitle]);
  const arranged = useMemo(() => arrangeInbox(needs, view, { viewer, areaName, personName }), [needs, view, viewer, areaName, personName]);
  const order = arranged.order;
  const pick = (patch: ViewPatch) => select(patch, undefined, { replace: true });

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

  // Several rows at once: picked by X or a row's box, assigned together. Picks that left the list drop out.
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const pickedNeeds = useMemo(() => order.filter((n) => picked.has(n.key)), [order, picked]);
  const togglePick = (n: LineNeed) => setPicked((p) => { const q = new Set(p); if (q.has(n.key)) q.delete(n.key); else q.add(n.key); return q; });
  const pickAll = () => setPicked((p) => (order.length > 0 && order.every((n) => p.has(n.key)) ? new Set() : new Set(order.map((n) => n.key))));
  // The row the keys stand on in the table, where nothing is open.
  const [cursor, setCursor] = useState<string | null>(null);
  const cursorAt = Math.max(0, order.findIndex((n) => n.key === cursor));
  // Which assign picker a key opened: the open decision's (or the table cursor's), or the selection's.
  const [assigning, setAssigning] = useState<"row" | "picked" | null>(null);

  const list = useRef<HTMLDivElement>(null);
  const reader = useRef<HTMLDivElement>(null);
  const focusRow = (key: string) => list.current?.querySelector<HTMLElement>(`[data-need-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: false });
  const move = (dir: 1 | -1, focus = true) => {
    if (!reading) {
      const to = order[Math.max(0, Math.min(order.length - 1, (cursor ? cursorAt : -1) + dir))];
      if (!to) return;
      setCursor(to.key);
      focusRow(to.key);
      return;
    }
    // With nothing open (the named item left), the next is the first.
    const to = order[Math.max(0, Math.min(order.length - 1, (at < 0 ? -1 : at) + dir))];
    if (!to || to === current) return;
    open(to, true);
    if (focus) focusRow(to.key);
  };
  const keyTarget = reading ? current : order[cursorAt] ?? null;
  const onKeys = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const el = e.target as HTMLElement;
    if (el.closest("input, textarea, select, [contenteditable], .fy-assign-menu")) return;
    // In the reader the decision takes the keys; Esc hands them back to the list.
    if (reader.current?.contains(el)) {
      if (e.key === "Escape" && current) { e.preventDefault(); focusRow(current.key); }
      return;
    }
    const k = e.key.toLowerCase();
    if (k === "j" || e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (k === "k" || e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Enter" && keyTarget) {
      e.preventDefault();
      if (!reading || keyTarget !== current) open(keyTarget);
      else reader.current?.querySelector<HTMLElement>("[data-line-decision]")?.focus({ preventScroll: true });
    }
    else if (k === "x" && keyTarget) { e.preventDefault(); togglePick(keyTarget); }
    else if (k === "a" && (picked.size || keyTarget?.decisionId)) { e.preventDefault(); setAssigning(picked.size ? "picked" : "row"); }
    else if (e.key === "Escape") {
      if (picked.size) { e.preventDefault(); setPicked(new Set()); }
      else if (reading) { e.preventDefault(); close(); }
    }
  };
  // The list takes the keys on arrival, so J and K walk it at once and no key lands in the decision by accident.
  const landed = useRef(false);
  useWatchEffect(() => {
    if (landed.current || order.length === 0) return;
    landed.current = true;
    if (document.activeElement === document.body || !document.activeElement) list.current?.querySelector<HTMLElement>(current ? '[aria-current="true"]' : "[data-need-key]")?.focus({ preventScroll: true });
  }, [order.length]);
  // The open item can change without the list's keys (the reader's arrows, a link, an answered item handing over): focus
  // left on another row would read as a second selection, so it follows to the open row.
  useWatchEffect(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!current || !el?.dataset.needKey || el.dataset.needKey === current.key || !list.current?.contains(el)) return;
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
  }, [reading]);

  const prefetch = useMemo(() => order.filter((n) => n.decisionId).map((n) => n.decisionId!), [order]);
  // The decisions a step away (j and k): their pages load ahead, so stepping shows each at once.
  // A row under the pointer is about to be clicked: its page loads too.
  const [hovered, setHovered] = useState<string | null>(null);
  const warm = useMemo(() => [order[at + 1], order[at - 1], order.find((n) => n.key === hovered)].filter((n) => n?.decisionId).map((n) => n!.decisionId!), [order, at, hovered]);
  const toProblem = (n: LineNeed | null) => (taskId: string) => select({ view: "problems", case: taskId, run: null, graph: n?.process ?? selection.graph });
  const toRun = (n: LineNeed | null) => (runId: string, taskId: string | null, step?: string) => select({ view: "problems", run: runId, graph: n?.process ?? selection.graph, ...(step ? { step } : {}) }, taskId);
  const allProblems = useAllProblems({ model, workspace, selection, process: line });
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

  const ctx: RowCtx = { view, pinned: !!pinned, projectTitle, people, now, current, picked, cursor: reading ? null : order[cursorAt]?.key ?? null, onOpen: open, onPick: togglePick, onHover: setHovered, assigning, setAssigning };
  const scope = line ? (
    <button type="button" className="fy-scope" aria-pressed onClick={() => select({ process: null, need: null }, undefined, { replace: true })} aria-label="Show the decisions of every line" data-line-foryou-process={line}>
      {[processTitle.get(line) ?? line, lineProject ? projectTitle.get(lineProject) : null].filter(Boolean).join(" · ")}<X aria-hidden />
    </button>
  ) : null;
  const bar = (
    <InboxBar view={view} arranged={arranged} people={people} viewer={viewer} projectTitle={projectTitle} pinned={!!pinned} shown={order.length} onPick={pick}
      picked={pickedNeeds} onClear={() => setPicked(new Set())} assigningPicked={assigning === "picked"} setAssigningPicked={(o) => setAssigning(o ? "picked" : null)} scope={scope} />
  );
  const empty = needs.length === 0 ? <p className="fy-none" data-line-foryou-empty>No open decisions</p> : order.length === 0 ? <p className="fy-none" data-line-foryou-filtered>None match</p> : null;
  const keys = order.length > 0 && <KeyLegend reading={reading} picked={picked.size > 0} />;

  return (
    <div className="fy" data-line-foryou={order.length} data-line-foryou-open={current?.ref ?? orphan ?? undefined} data-mode={reading ? "read" : "table"} onKeyDown={onKeys}>
      <LineDecisionPrefetch ids={prefetch} warm={warm} />
      {!reading ? (
        <div className="fy-list fy-wide" ref={list} data-settling={ready ? undefined : ""}>
          {bar}
          {empty}
          {order.length > 0 && <DecisionTable arranged={arranged} ctx={ctx} onOrder={(o) => pick({ order: o === "impact" ? null : o })} onPickAll={pickAll} />}
          {keys}
        </div>
      ) : (
        <>
          <div className="fy-list" ref={list} role="navigation" aria-label="Decisions" data-settling={ready ? undefined : ""}>
            {bar}
            {empty}
            {arranged.sections.map((g) => (
              <section key={g.key} className="fy-group" data-line-need-group={g.key}>
                {view.group !== "none" && <h2 className="fy-group-h">{view.group === "who" && g.key !== "none" && <Face people={people} id={g.key} />}<span className="fy-group-name">{g.label}</span><span className="lw-num">{g.needs.length}</span></h2>}
                <ul className="fy-rows">{g.needs.map((n) => <ListRow key={n.key} n={n} ctx={ctx} />)}</ul>
              </section>
            ))}
            {keys}
          </div>

          <div className="fy-reader" ref={reader} data-line-foryou-reader={current?.kind ?? (orphan ? "decision" : missing ? "missing" : "empty")}>
            {current ? (
              <>
                <div className="fy-reader-h" data-line-foryou-head>
                  <button type="button" className="lw-iconbtn" onClick={close} aria-label="Back to every decision" title="Back to every decision"><X className="w-4 h-4" /></button>
                  {current.decisionId && <AssignDecision key={current.decisionId} ids={[current.decisionId]} assignee={current.assignee ?? null} people={people} variant="named" keyHint="A"
                    open={assigning === "row"} onOpenChange={(o) => setAssigning(o ? "row" : null)} />}
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
                    <button type="button" className="lw-iconbtn" disabled={at <= 0} onClick={() => move(-1, false)} aria-label="Previous"><ChevronLeft className="w-4 h-4" /></button>
                    <button type="button" className="lw-iconbtn" disabled={at < 0 || at >= order.length - 1} onClick={() => move(1, false)} aria-label="Next"><ChevronRight className="w-4 h-4" /></button>
                  </span>}
                </div>
                <div className="fy-reader-b">
                  {current.kind === "decision" && (current.decisionId || current.decisionRef)
                    ? <LineDecision key={current.key} id={current.decisionId ?? current.decisionRef!} head={false} quiet onProblem={toProblem(current)} onRun={toRun(current)} />
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
        </>
      )}
    </div>
  );
}

type RowCtx = {
  view: InboxView; pinned: boolean; projectTitle: Map<string, string>; people: ReadonlyArray<AssigneeOption>; now: number;
  current: LineNeed | null; picked: ReadonlySet<string>; cursor: string | null;
  onOpen: (n: LineNeed) => void; onPick: (n: LineNeed) => void; onHover: (key: string | null) => void;
  assigning: "row" | "picked" | null; setAssigning: (a: "row" | "picked" | null) => void;
};

/** What a row is asked: the decision's question, as the reader opens on it. */
const askOf = (n: LineNeed) => (n.line && n.line !== n.title ? n.line : problemListName(n));

/** What a run recommends, as the tone its word is drawn in: go (ship it), change (build or revise first), stop (drop, wait or no measured gain). */
function recTone(v: string): "go" | "change" | "stop" {
  return /^(ship|better|apply|publish|keep)/i.test(v) ? "go" : /^(revise|build|narrow)/i.test(v) ? "change" : "stop";
}
/** The recommendation in a word or two: "not_separated" reads "no gain". */
const recWord = (v: string): string => (v === "not_separated" ? "no gain" : v.replace(/_/g, " "));
const Rec = ({ v }: { v: string | null | undefined }) => (v ? <span className="fy-rec" data-rec={recTone(v)} title="What the run recommends">{recWord(v)}</span> : null);

/** One decision beside the reader: its question, its facts under it, its box and its holder. */
function ListRow({ n, ctx }: { n: LineNeed; ctx: RowCtx }) {
  const band = severityBand(n.severity);
  // The area is the group's name when grouped by it, the filter's when narrowed to one, and the page's when pinned.
  const area = ctx.pinned || ctx.view.group === "area" || ctx.view.area ? null : n.projectId ? ctx.projectTitle.get(n.projectId) : null;
  const [assignOpen, setAssignOpen] = useState(false);
  return (
    <li className="fy-li" data-picked={ctx.picked.has(n.key) ? "" : undefined}>
      <PickBox picked={ctx.picked.has(n.key)} onPick={() => ctx.onPick(n)} />
      <button type="button" className="fy-row" aria-current={n === ctx.current ? "true" : undefined} onClick={() => ctx.onOpen(n)} onPointerEnter={() => ctx.onHover(n.key)} data-need-key={n.key} data-line-need-row={n.kind} data-line-need-ref={n.ref} title={n.problemRef ?? undefined}>
        <span className="fy-ask">{askOf(n)}</span>
        <span className="fy-facts">
          {band && <span className="fy-sev lw-num" data-sev={band} title={`Worst finding: severity ${n.severity} of 10`}>{n.severity}</span>}
          {ctx.view.group !== "kind" && <span className="fy-kind" data-kind={n.change ?? "other"}>{DECISION_CHANGE_LABEL[n.change ?? "other"]}</span>}
          {!!n.reach && <span className="fy-n" title={`${n.reach} ${n.reach === 1 ? "person" : "people"} reached`}><Users aria-hidden /><span className="lw-num">{n.reach}</span></span>}
          {!!n.findings && <span className="fy-n" title={`${n.findings} ${n.findings === 1 ? "finding" : "findings"}`}><SquareStack aria-hidden /><span className="lw-num">{n.findings}</span></span>}
          <Rec v={n.recommend} />
          {area && <span className="fy-area">{area}</span>}
          {n.since && <span className="fy-wait lw-num" title={`Waiting since ${new Date(n.since).toLocaleString()}`}>{ageShort(ctx.now - n.since)}</span>}
        </span>
      </button>
      {n.decisionId && <AssignDecision ids={[n.decisionId]} assignee={n.assignee ?? null} people={ctx.people} open={assignOpen} onOpenChange={setAssignOpen} />}
    </li>
  );
}

/** A row's box: picked for assigning several at once. */
function PickBox({ picked, onPick, label = "Select" }: { picked: boolean; onPick: () => void; label?: string }) {
  return (
    <button type="button" role="checkbox" aria-checked={picked} aria-label={label} className="fy-pick" data-picked={picked ? "" : undefined} onClick={(e) => { e.stopPropagation(); onPick(); }}>
      {picked && <Check aria-hidden />}
    </button>
  );
}

/** The table's columns, and the order each head picks (none for the question itself). */
const COLUMNS: ReadonlyArray<{ key: string; label: string; order: InboxOrder | null; tip?: string; num?: boolean }> = [
  { key: "ask", label: "Decision", order: null },
  { key: "sev", label: "Sev", order: "severity", tip: "Worst finding's severity, 1 to 10", num: true },
  { key: "kind", label: "Kind", order: "kind" },
  { key: "people", label: "People", order: "impact", tip: "People reached", num: true },
  { key: "findings", label: "Findings", order: "findings", num: true },
  { key: "area", label: "Area", order: "area" },
  { key: "who", label: "Assignee", order: "assignee" },
  { key: "age", label: "Waiting", order: "age", num: true },
];

/** Every decision as a table across the page, one fact a column, each head ordering the list by it; groups as row bands. */
function DecisionTable({ arranged, ctx, onOrder, onPickAll }: { arranged: ReturnType<typeof arrangeInbox<LineNeed>>; ctx: RowCtx; onOrder: (o: InboxOrder) => void; onPickAll: () => void }) {
  const all = arranged.order.length > 0 && arranged.order.every((n) => ctx.picked.has(n.key));
  // A column every row of a group shares says nothing (the group's band names it), and a count no row has is not drawn.
  const has = { sev: arranged.order.some((n) => n.severity != null), people: arranged.order.some((n) => !!n.reach), findings: arranged.order.some((n) => !!n.findings) } as Record<string, boolean>;
  const cols = COLUMNS.filter((c) => !(c.key === "area" && (ctx.pinned || ctx.view.area || ctx.view.group === "area")) && !(c.key === "kind" && (ctx.view.kind || ctx.view.group === "kind")) && !(c.key === "who" && ctx.view.group === "who") && has[c.key] !== false);
  return (
    <table className="fy-table" data-line-foryou-table="">
      <thead>
        <tr>
          <th className="fy-tpick"><PickBox picked={all} onPick={onPickAll} label="Select every decision shown" /></th>
          {cols.map((c) => (
            <th key={c.key} className={`fy-t-${c.key}`} data-num={c.num ? "" : undefined} aria-sort={c.order && ctx.view.order === c.order ? (["area", "assignee", "kind", "age"].includes(c.order) ? "ascending" : "descending") : undefined}>
              {c.order ? <button type="button" className="fy-th" onClick={() => onOrder(c.order!)} title={c.tip ?? `Order by ${c.label.toLowerCase()}`} data-on={ctx.view.order === c.order ? "" : undefined}>{c.label}{ctx.view.order === c.order && <ArrowDownWideNarrow aria-hidden />}</button> : c.label}
            </th>
          ))}
        </tr>
      </thead>
      {arranged.sections.map((g) => (
        <tbody key={g.key} data-line-need-group={g.key}>
          {ctx.view.group !== "none" && <tr className="fy-tgroup"><th colSpan={cols.length + 1}>{ctx.view.group === "who" && g.key !== "none" && <Face people={ctx.people} id={g.key} />}<span>{g.label}</span><span className="lw-num">{g.needs.length}</span></th></tr>}
          {g.needs.map((n) => <TableRow key={n.key} n={n} ctx={ctx} cols={cols} />)}
        </tbody>
      ))}
    </table>
  );
}

function TableRow({ n, ctx, cols }: { n: LineNeed; ctx: RowCtx; cols: typeof COLUMNS }) {
  const band = severityBand(n.severity);
  const [assignOpen, setAssignOpen] = useState(false);
  const open = assignOpen || (ctx.assigning === "row" && ctx.cursor === n.key);
  const cell: Record<string, ReactNode> = {
    ask: <><span className="fy-ask">{askOf(n)}</span><Rec v={n.recommend} /></>,
    sev: band ? <span className="fy-sev lw-num" data-sev={band}>{n.severity}</span> : null,
    kind: <span className="fy-kind" data-kind={n.change ?? "other"}>{DECISION_CHANGE_LABEL[n.change ?? "other"]}</span>,
    people: n.reach ? <span className="lw-num">{n.reach}</span> : null,
    findings: n.findings ? <span className="lw-num">{n.findings}</span> : null,
    area: n.projectId ? <span className="fy-area">{ctx.projectTitle.get(n.projectId) ?? ""}</span> : null,
    who: n.decisionId ? <AssignDecision ids={[n.decisionId]} assignee={n.assignee ?? null} people={ctx.people} variant="cell" open={open} onOpenChange={(o) => { setAssignOpen(o); if (!o) ctx.setAssigning(null); }} /> : null,
    age: n.since ? <span className="lw-num" title={`Waiting since ${new Date(n.since).toLocaleString()}`}>{ageShort(ctx.now - n.since)}</span> : null,
  };
  return (
    <tr className="fy-tr" tabIndex={0} data-need-key={n.key} data-line-need-ref={n.ref} data-picked={ctx.picked.has(n.key) ? "" : undefined} aria-current={ctx.cursor === n.key ? "true" : undefined}
      onClick={() => ctx.onOpen(n)} onPointerEnter={() => ctx.onHover(n.key)} onKeyDown={(e) => { if (e.key === " ") { e.preventDefault(); ctx.onPick(n); } }}>
      <td className="fy-tpick" onClick={(e) => e.stopPropagation()}><PickBox picked={ctx.picked.has(n.key)} onPick={() => ctx.onPick(n)} /></td>
      {cols.map((c) => <td key={c.key} className={`fy-t-${c.key}`} data-num={c.num ? "" : undefined} onClick={c.key === "who" ? (e) => e.stopPropagation() : undefined}>{cell[c.key]}</td>)}
    </tr>
  );
}

/** The keys the list takes, drawn as keys. */
function KeyLegend({ reading, picked }: { reading: boolean; picked: boolean }) {
  const item = (k: ReactNode, what: string) => <span className="fy-key">{k}<span>{what}</span></span>;
  return (
    <p className="fy-keys" data-line-foryou-keys="">
      {item(<><KeyCap size="xs">J</KeyCap><KeyCap size="xs">K</KeyCap></>, "move")}
      {item(<KeyCap size="xs">↵</KeyCap>, reading ? "answer" : "open")}
      {reading && item(<><KeyCap size="xs">1</KeyCap><KeyCap size="xs">2</KeyCap></>, "pick an answer")}
      {item(<KeyCap size="xs">X</KeyCap>, "select")}
      {item(<KeyCap size="xs">A</KeyCap>, "assign")}
      {(reading || picked) && item(<KeyCap size="xs">Esc</KeyCap>, picked ? "clear" : "back")}
    </p>
  );
}

/** A teammate's face, from the picker's people. */
function Face({ people, id }: { people: ReadonlyArray<AssigneeOption>; id: string }) {
  const p = people.find((x) => x.key === id);
  return p ? <span className="fy-face">{p.face}</span> : null;
}

/** The list's controls: who holds it, what it changes and its area narrow it; the order and the grouping arrange it.
 *  Each filter's counts say what picking it would show. Every choice lives in the address. With rows selected, the bar
 *  is the selection's: how many, assign them, clear. */
function InboxBar({ view, arranged, people, viewer, projectTitle, pinned, shown, onPick, picked, onClear, assigningPicked, setAssigningPicked, scope }: {
  view: InboxView;
  arranged: ReturnType<typeof arrangeInbox<LineNeed>>;
  people: ReadonlyArray<AssigneeOption>;
  viewer: string | null;
  projectTitle: Map<string, string>;
  pinned: boolean;
  shown: number;
  onPick: (patch: ViewPatch) => void;
  picked: ReadonlyArray<LineNeed>;
  onClear: () => void;
  assigningPicked: boolean;
  setAssigningPicked: (open: boolean) => void;
  scope: ReactNode;
}) {
  if (arranged.total === 0) return <>{scope}</>;
  if (picked.length > 0) {
    const ids = picked.map((n) => n.decisionId).filter((x): x is string => !!x);
    const holders = new Set(picked.map((n) => n.assignee ?? ""));
    return (
      <div className="fy-bar" data-line-foryou-bar="" data-picking="">
        <span className="fy-shown lw-num">{picked.length}</span><span className="fy-bar-word">selected</span>
        <AssignDecision ids={ids} assignee={holders.size === 1 ? [...holders][0] || null : null} people={people} variant="button" keyHint="A" open={assigningPicked} onOpenChange={setAssigningPicked} onDone={onClear} />
        <span className="fy-bar-gap" />
        <button type="button" className="fy-bar-btn" onClick={onClear}>Clear<KeyCap size="xs">Esc</KeyCap></button>
      </div>
    );
  }
  const { who, kind, area } = arranged.counts;
  const whoOptions: FilterOption[] = [
    { key: "", label: "Everyone", count: who.get("all") ?? 0 },
    ...(viewer ? [{ key: "me", label: "Mine", count: who.get("me") ?? 0 }] : []),
    { key: "none", label: "Unassigned", count: who.get("none") ?? 0 },
    ...people.filter((p) => p.key !== viewer).map((p) => ({ key: p.key, label: p.label, face: p.face, count: who.get(p.key) ?? 0, section: "People" })),
  ];
  const kindOptions: FilterOption[] = [{ key: "", label: "Every kind" }, ...DECISION_CHANGES.filter((k) => kind.get(k) || view.kind === k).map((k) => ({ key: k, label: DECISION_CHANGE_LABEL[k], count: kind.get(k) ?? 0 }))];
  const areaOptions: FilterOption[] = [{ key: "", label: "Every area" }, ...[...area].sort((a, b) => b[1] - a[1]).map(([p, n]) => ({ key: p, label: projectTitle.get(p) ?? "Another product", count: n }))];
  const orderOptions: FilterOption[] = (["impact", "severity", "age", "findings"] as const).map((o) => ({ key: o === "impact" ? "" : o, label: INBOX_ORDER_LABEL[o] }));
  // The default grouping is the empty key, so the pill reads as unset until another is picked.
  const byDefault = pinned ? "kind" : "area";
  const groupOptions: FilterOption[] = INBOX_GROUPS.filter((g) => !(pinned && g === "area")).map((g) => ({ key: g === byDefault ? "" : g, label: INBOX_GROUP_LABEL[g] }));
  return (
    <div className="fy-bar" data-line-foryou-bar="">
      {scope}
      <span className="fy-shown lw-num" title={shown === arranged.total ? `${shown} open decisions` : `${shown} of ${arranged.total} open decisions`}>{shown}</span>
      <FilterDropdown label="Everyone" icon={<UserRound className="w-3.5 h-3.5" />} value={view.who === "all" ? "" : view.who} options={whoOptions} onChange={(v) => onPick({ who: v || null })} />
      <FilterDropdown label="Kind" icon={<Shapes className="w-3.5 h-3.5" />} value={view.kind ?? ""} options={kindOptions} onChange={(v) => onPick({ kind: v || null })} />
      {!pinned && <FilterDropdown label="Area" icon={<Layers className="w-3.5 h-3.5" />} value={view.area ?? ""} options={areaOptions} onChange={(v) => onPick({ area: v || null })} />}
      <span className="fy-bar-gap" />
      <FilterDropdown label={INBOX_ORDER_LABEL[view.order]} icon={<ArrowDownWideNarrow className="w-3.5 h-3.5" />} value={view.order === "impact" ? "" : view.order} options={orderOptions} onChange={(v) => onPick({ order: v || null })} />
      <FilterDropdown label={INBOX_GROUP_LABEL[byDefault]} icon={<Rows3 className="w-3.5 h-3.5" />} value={view.group === byDefault ? "" : view.group} options={groupOptions} onChange={(v) => onPick({ group: v || null })} />
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
