"use client";
// For you (line-journeys.md LJ8.1): the landing page. Its job is to clear what
// waits on the viewer, so it is a list with a reader beside it from the first
// paint: the first item is open on arrival, it is read and answered in the
// reader (WaitingItem), and when it leaves the list the next one opens. No row
// carries a button: every act is in the reader, next to the whole text.
//
// The list covers every process (a row names its own), grouped by the act:
// fixes to decide, questions, new problems to confirm (the nav's count is
// exactly these rows), then "Needs a new ask", uncounted: things no answer can
// reach until a run asks again. The last row opens the problems held behind a
// line that is off. A row is the problem's title; the reader holds what is
// asked. The open item is `need` in the URL; an older link's `decision` or
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
import { needForRef, needGroups, needOrder, type LineNeed } from "../../../../lib/line/lineNeeds";
import { KeyCap } from "../../../KeyCap";
import { LineDecision, LineDecisionPrefetch } from "../../widgets/LineDecision";
import { WaitingItem } from "../../widgets/WaitingItem";
import { useTrialHref } from "../../../../hooks/useSyncTrial";
import type { LineViewProps } from "./types";
import "./foryou.css";

/** What a row under "Needs a new ask" adds to its meta line: why no answer can reach it yet. */
const NEWASK_WORD: Partial<Record<LineNeed["kind"], string>> = { lapsed: "asked, no answer", stopped: "stopped", reask: "paused" };

const SCROLL_KEY = "line:foryou:scroll";

export function ForYouView({ workspace, selection, select, href }: LineViewProps) {
  const { needs, notStarted, now, ready } = workspace;
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
  const toRun = (n: LineNeed | null) => (runId: string, taskId: string | null) => select({ view: "problems", run: runId, graph: n?.process ?? selection.graph }, taskId);
  // `status` is the Problems page's own key: it rides on the address the selection writes.
  const problemsHref = href({ view: "problems", need: null, decision: null, card: null });
  const notStartedHref = `${problemsHref}${problemsHref.includes("?") ? "&" : "?"}status=notstarted`;
  const counted = groups.filter((g) => g.counted).reduce((n, g) => n + g.needs.length, 0);
  // One item and nothing else to list: the reader takes the whole width (its header still says 1 of 1).
  const single = order.length === 1 && !!current && notStarted.lines === 0;

  return (
    <div className="fy" data-line-foryou={counted} data-line-foryou-open={current?.ref ?? orphan ?? undefined} data-single={single ? "" : undefined}>
      <LineDecisionPrefetch ids={prefetch} />
      <div className="fy-list" ref={list} role="navigation" aria-label="What waits on you" data-settling={ready ? undefined : ""}
        onKeyDown={(e) => {
          if (e.metaKey || e.ctrlKey || e.altKey) return;
          if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); move(1); }
          else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); move(-1); }
        }}>
        {order.length === 0 && <p className="fy-none" data-line-foryou-empty>Nothing waits on you</p>}
        {groups.map((g, gi) => (
          <section key={g.key} className="fy-group" data-counted={g.counted ? "" : undefined} data-first-uncounted={!g.counted && gi > 0 ? "" : undefined} data-line-need-group={g.key}>
            <h2 className="fy-group-h">{g.label}<span className="lw-num">{g.needs.length}</span></h2>
            <ul className="fy-rows">
              {g.needs.map((n) => {
                // The row is what the item is about (the problem's title, whole); what is asked is the reader's.
                const meta = [NEWASK_WORD[n.kind], n.process ? processTitle.get(n.process) : null, workspace.project ? null : n.projectId ? projectTitle.get(n.projectId) : null, n.since ? ageShort(now - n.since) : null].filter(Boolean);
                return (
                  <li key={n.key}>
                    <button type="button" className="fy-row" aria-current={n === current ? "true" : undefined} onClick={() => open(n)} data-need-key={n.key} data-line-need-row={n.kind} data-line-need-ref={n.ref}>
                      <span className="fy-ask">{n.title || n.line}</span>
                      <span className="fy-meta">{meta.map((m, i) => <span key={i}>{m}</span>)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        {notStarted.lines > 0 && (
          <Link className="fy-row fy-notstarted" href={notStartedHref} data-line-foryou-notstarted={notStarted.problems}>
            <span className="fy-ask">Not started<span className="lw-num">{notStarted.problems}</span><ChevronRight className="fy-go" aria-hidden /></span>
            <span className="fy-meta"><span>{notStarted.lines === 1 ? "1 line off" : `${notStarted.lines} lines off`}</span></span>
          </Link>
        )}
        {order.length > 1 && <p className="fy-keys" aria-hidden><KeyCap size="xs">J</KeyCap><KeyCap size="xs">K</KeyCap></p>}
      </div>

      <div className="fy-reader" data-line-foryou-reader={current?.kind ?? (orphan ? "decision" : missing ? "missing" : "empty")}>
        {current ? (
          <>
            <div className="fy-reader-h">
              <span className="fy-process">{current.process ? processTitle.get(current.process) ?? "" : ""}</span>
              {current.trial && <TrialTag projectId={current.projectId ?? null} />}
              <span className="fy-pos lw-num">{at + 1} of {order.length}</span>
              <button type="button" className="lw-iconbtn" disabled={at <= 0} onClick={() => move(-1, false)} aria-label="Previous"><ChevronLeft className="w-4 h-4" /></button>
              <button type="button" className="lw-iconbtn" disabled={at >= order.length - 1} onClick={() => move(1, false)} aria-label="Next"><ChevronRight className="w-4 h-4" /></button>
            </div>
            <div className="fy-reader-b">
              <WaitingItem key={current.key} need={current} now={now} onProblem={toProblem(current)} onRun={toRun(current)} />
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

/** A trial row's tag: opens that project's trial (its cards, runs and spend), in the workspace it lives in. */
function TrialTag({ projectId }: { projectId: string | null }) {
  return <Link className="fy-trial" href={useTrialHref(projectId)} title="A trial run: answering records what you would do and ships nothing" data-line-foryou-trial>Trial</Link>;
}
