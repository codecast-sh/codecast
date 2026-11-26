"use client";

// The flow around anything a run made (lib/flowContext): the flow's name, every
// station in order with its state, where the run stands, which station the
// viewer is on, and arrows that step to the station before or after. Mounted on
// a station's session, a gate's decision, a task and a run's card, so the whole
// flow is in view wherever a person meets one of its pieces.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, ChevronLeft, ChevronRight, Circle, CircleDot, GitBranch, Loader2, Pause, X, XCircle } from "lucide-react";
import { flowName } from "@codecast/shared/contracts/flowPool";
import { useRunGraph, useSessionRun, useWorkflowRun } from "../hooks/useSyncWorkflows";
import { flowContext, flowOrigin, runStanding, stepTarget, type FlowFocus, type FlowOrigin, type FlowStation, type StationState } from "../lib/flowContext";
import { formatRunDuration } from "../lib/workflowRun";
import { useCoarseNow } from "../hooks/useCoarseNow";
import { useInboxStore } from "../store/inboxStore";
import { runHref } from "../lib/decisionLinks";
import { useTaskRuns } from "../hooks/useSyncRuns";

const MARK: Record<StationState, { icon: React.ComponentType<{ className?: string }>; color: string; ring: string }> = {
  done: { icon: CheckCircle2, color: "text-sol-green", ring: "border-sol-green/40 bg-sol-green/10" },
  failed: { icon: XCircle, color: "text-sol-red", ring: "border-sol-red/40 bg-sol-red/10" },
  live: { icon: Loader2, color: "text-sol-cyan", ring: "border-sol-cyan/40 bg-sol-cyan/10" },
  waiting: { icon: Pause, color: "text-sol-orange", ring: "border-sol-orange/40 bg-sol-orange/10" },
  next: { icon: Circle, color: "text-sol-text-dim/60", ring: "border-sol-border bg-sol-bg-alt" },
};

/** The strip for a run by id: reads the run and the graph it ran from the store. Renders nothing for no run. */
export function FlowContext({ runId, focus, className }: { runId: string | null | undefined; focus?: FlowFocus; className?: string }) {
  const run = useWorkflowRun(runId);
  if (!run) return null;
  return <FlowContextOf run={run} focus={focus} className={className} />;
}

/** The strip for a run row the caller already holds. */
export function FlowContextOf({ run: given, focus: givenFocus, className }: { run: any; focus?: FlowFocus; className?: string }) {
  const router = useRouter();
  // Every run on the same task, oldest first: the strip flips between them in place, so an earlier attempt and the
  // one running now are each a click from the other.
  const taskRuns = useTaskRuns(given.task_id ?? null);
  const runs = useMemo(() => {
    const all = taskRuns.some((r: any) => r._id === given._id) ? taskRuns : [given, ...taskRuns];
    return [...all].sort((a: any, b: any) => (a.created_at ?? 0) - (b.created_at ?? 0));
  }, [taskRuns, given]);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const run: any = runs.find((r: any) => r._id === pickedId) ?? given;
  const runIndex = runs.findIndex((r: any) => r._id === run._id);
  const focus = run._id === given._id ? givenFocus : undefined;
  const graph = useRunGraph(run._id, run.workflow_id);
  const ctx = useMemo(() => flowContext(run, graph, focus), [run, graph, focus?.conversationId, focus?.decisionId, focus?.nodeId]);
  const originId: string | undefined = run.task_origin_conversation_id;
  const originTitle = useInboxStore((s) => (originId ? ((s.sessions as any)[originId]?.title ?? (s.conversations as any)[originId]?.title) : undefined) as string | undefined);
  const origin = useMemo(() => flowOrigin(run, originTitle), [run.task_short_id, run.task_title, originId, originTitle]);
  // A station that ran no session (a command, a check) opens here, under the strip; one that did opens its page.
  const [peek, setPeek] = useState<number | null>(null);
  const [showAhead, setShowAhead] = useState(false);
  const pickRun = (i: number) => { const r: any = runs[i]; if (r) { setPeek(null); setPickedId(r._id === given._id ? null : r._id); } };
  const here = peek ?? ctx.focus;
  // The station in view is in view however narrow the pane: the row scrolls itself, never the page.
  const rowRef = useRef<HTMLOListElement>(null);
  useLayoutEffect(() => {
    const row = rowRef.current;
    const chip = row?.querySelector<HTMLElement>("[data-here]");
    if (!row || !chip) return;
    const left = chip.offsetLeft;
    if (left < row.scrollLeft || left + chip.offsetWidth > row.scrollLeft + row.clientWidth) row.scrollLeft = left - (row.clientWidth - chip.offsetWidth) / 2;
  }, [here, ctx.stations.length]);
  if (!ctx.stations.length) return null;
  const name = flowName({ label: graph?.label ?? run.workflow_label, name: graph?.name ?? run.workflow_name }) || "Flow";
  const prev = stepTarget(ctx, here, -1);
  const next = stepTarget(ctx, here, 1);
  // Your own station closes what is open; another one with a page opens it; one without opens here.
  const go = (i: number) => {
    const h = ctx.stations[i]?.href;
    if (i === ctx.focus && h) setPeek(null);
    else if (h) { setPeek(null); router.push(h); }
    else setPeek(i);
  };
  const standing = runStanding(run, ctx);
  const open = peek != null ? ctx.stations[peek] : null;

  return (
    <nav
      className={`rounded-lg border border-sol-border/40 bg-sol-bg-alt/30 text-meta ${className ?? ""}`}
      aria-label={`${name} flow`}
      data-flow-context={run._id}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft" && prev >= 0) { e.preventDefault(); go(prev); }
        else if (e.key === "ArrowRight" && next >= 0) { e.preventDefault(); go(next); }
        else if (e.key === "Escape" && open) { e.stopPropagation(); setPeek(null); }
      }}
    >
      <div className="flex items-center gap-2 px-2 pt-1.5">
        <GitBranch className="w-3.5 h-3.5 shrink-0 text-sol-violet" />
        <Link href={runHref(run._id)} className="font-medium text-sol-violet hover:underline truncate" title="Open the run">{name}</Link>
        <span className={MARK[standing.state].color}>{standing.words}</span>
        {runs.length > 1 && (
          <span className="flex items-center gap-0.5 shrink-0 text-sol-text-dim" data-flow-runs>
            <button type="button" onClick={() => pickRun(runIndex - 1)} disabled={runIndex <= 0} className="p-0.5 rounded hover:text-sol-text hover:bg-sol-bg-alt disabled:opacity-30" aria-label="Earlier run" title="Earlier run"><ChevronLeft className="w-3 h-3" /></button>
            <span className="tabular-nums">run {runIndex + 1}/{runs.length}</span>
            <button type="button" onClick={() => pickRun(runIndex + 1)} disabled={runIndex >= runs.length - 1} className="p-0.5 rounded hover:text-sol-text hover:bg-sol-bg-alt disabled:opacity-30" aria-label="Later run" title="Later run"><ChevronRight className="w-3 h-3" /></button>
          </span>
        )}
        {ctx.lineChanged && (
          <span className="px-1.5 py-px rounded border border-sol-orange/40 text-sol-orange" title="This run ran an earlier version of the flow; its stations are the ones it ran" data-line-changed>
            flow changed
          </span>
        )}
        <span className="ml-auto flex items-center gap-0.5 shrink-0">
          <span className="tabular-nums text-sol-text-dim mr-1">{here + 1}/{ctx.stations.length}</span>
          <StepButton dir="prev" target={ctx.stations[prev]} onClick={() => go(prev)} />
          <StepButton dir="next" target={ctx.stations[next]} onClick={() => go(next)} />
        </span>
      </div>
      <ol ref={rowRef} className="relative flex items-center gap-0 px-2 pt-1 pb-1.5 overflow-x-auto [scrollbar-width:thin]">
        {origin.map((o) => (
          <li key={o.key} className="flex items-center shrink-0" data-flow-origin={o.key}>
            <OriginChip o={o} />
            <span className="w-2.5 h-px shrink-0 bg-sol-border/60" aria-hidden />
          </li>
        ))}
        {ctx.stations.map((s, i) => (
          <li key={`${s.id}:${i}`} className="flex items-center shrink-0" data-station={s.id} data-focus={i === ctx.focus || undefined} data-here={i === here || undefined}>
            {i > 0 && <span className={`w-2.5 h-px shrink-0 ${s.state === "next" ? "bg-sol-border/40" : "bg-sol-border"}`} aria-hidden />}
            <StationChip s={s} here={i === here} onPeek={() => setPeek(peek === i ? null : i)} />
          </li>
        ))}
        {ctx.ahead.length > 0 && (
          <li className="flex items-center shrink-0" data-flow-ahead={ctx.ahead.length}>
            <span className="w-2.5 h-px shrink-0 bg-sol-border/40" aria-hidden />
            {showAhead && ctx.ahead.map((s, i) => (
              <span key={`${s.id}:ahead:${i}`} className="flex items-center shrink-0">
                {i > 0 && <span className="w-2.5 h-px shrink-0 bg-sol-border/30" aria-hidden />}
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 whitespace-nowrap text-sol-text-dim/70" title={`${s.label} · not reached yet`}>
                  <Circle className="w-3 h-3 shrink-0" />{s.label}
                </span>
              </span>
            ))}
            <button type="button" onClick={() => setShowAhead((v) => !v)} className="ml-1 px-1.5 py-0.5 rounded-md text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt whitespace-nowrap tabular-nums" aria-expanded={showAhead}>
              {showAhead ? "hide ahead" : `${ctx.ahead.length} ahead`}
            </button>
          </li>
        )}
      </ol>
      {open && <StationPeek s={open} onClose={() => setPeek(null)} />}
    </nav>
  );
}

function OriginChip({ o }: { o: FlowOrigin }) {
  return (
    <Link href={o.href} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border border-dashed border-sol-border/60 whitespace-nowrap text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt max-w-[14rem]" title={o.key === "session" ? `Where it started: ${o.label}` : `${o.ref}: ${o.label}`}>
      {o.ref ? <span className="font-mono text-sol-text-dim">{o.ref}</span> : <span className="truncate">{o.label}</span>}
    </Link>
  );
}

function StationChip({ s, here, onPeek }: { s: FlowStation; here: boolean; onPeek: () => void }) {
  const m = MARK[s.state];
  const Icon = s.current && s.state !== "waiting" ? CircleDot : m.icon;
  const tone = here ? `${m.ring} text-sol-text font-medium` : "border-transparent text-sol-text-muted";
  const title = [s.segment && s.segment !== s.label ? `${s.segment} · ${s.label}` : s.label, s.current ? "the run is here" : null, s.href ? (s.href.startsWith("/decisions") ? "open the decision" : "open its session") : "show what it did"].filter(Boolean).join(" · ");
  const body = (
    <>
      <Icon className={`w-3.5 h-3.5 shrink-0 ${m.color}`} />
      {s.label}
    </>
  );
  const cls = `inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border whitespace-nowrap hover:bg-sol-bg-alt hover:text-sol-text ${tone}`;
  return s.href ? (
    <Link href={s.href} className={cls} title={title} aria-current={here ? "step" : undefined}>{body}</Link>
  ) : (
    <button type="button" onClick={onPeek} className={cls} title={title} aria-current={here ? "step" : undefined} aria-expanded={here}>{body}</button>
  );
}

/** A station that ran no session, read in place: when, how long, its verdict and what it printed. */
function StationPeek({ s, onClose }: { s: FlowStation; onClose: () => void }) {
  const now = useCoarseNow(30_000);
  const took = s.started_at ? formatRunDuration(s.started_at, s.completed_at, now) : null;
  return (
    <div className="mx-2 mb-2 rounded-md border border-sol-border/50 bg-sol-bg" data-station-peek={s.id}>
      <div className="flex items-center gap-2 px-2 py-1">
        <span className={`font-medium ${MARK[s.state].color}`}>{s.label}</span>
        {s.segment && s.segment !== s.label && <span className="text-sol-text-dim">{s.segment}</span>}
        {s.outcome && <span className="px-1 rounded bg-sol-bg-alt text-sol-text-muted">{s.outcome}</span>}
        {took && <span className="tabular-nums text-sol-text-dim">{took}</span>}
        {s.started_at && <span className="tabular-nums text-sol-text-dim">{new Date(s.started_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>}
        <button type="button" onClick={onClose} className="ml-auto p-0.5 rounded text-sol-text-dim hover:text-sol-text" aria-label="Close"><X className="w-3 h-3" /></button>
      </div>
      {s.output
        ? <pre className="max-h-60 overflow-auto px-2 pb-2 whitespace-pre-wrap break-words font-mono text-[11.5px] leading-snug text-sol-text-muted">{s.output}</pre>
        : <div className="px-2 pb-2 text-sol-text-dim">{s.state === "next" ? "Not reached yet" : "Printed nothing"}</div>}
    </div>
  );
}

function StepButton({ dir, target, onClick }: { dir: "prev" | "next"; target?: FlowStation; onClick: () => void }) {
  const Icon = dir === "prev" ? ChevronLeft : ChevronRight;
  const label = target ? `${dir === "prev" ? "Previous" : "Next"} station: ${target.label}` : dir === "prev" ? "No earlier station to open" : "No later station to open";
  return (
    <button type="button" onClick={onClick} disabled={!target} className="p-0.5 rounded text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt disabled:opacity-30 disabled:hover:bg-transparent" title={label} aria-label={label}>
      <Icon className="w-3.5 h-3.5" />
    </button>
  );
}

/** The strip on a session's own page: the run it works in, as its own run, or as a station of its parent log's run.
 *  Asks the server only for a session that can be in one (it points at a run, or a parent spawned it). */
export function SessionFlowContext({ conversationId, ownRunId, parentId, className }: { conversationId: string; ownRunId?: string | null; parentId?: string | null; className?: string }) {
  const run = useSessionRun(ownRunId || parentId ? conversationId : null, ownRunId);
  if (!run) return null;
  return <FlowContextOf run={run} focus={{ conversationId }} className={className} />;
}
