"use client";

// The flow around anything a run made (lib/flowContext): the flow's name, every
// station in order with its state, where the run stands, which station the
// viewer is on, and arrows that step to the station before or after. Mounted on
// a station's session, a gate's decision, a task and a run's card, so the whole
// flow is in view wherever a person meets one of its pieces.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLayoutEffect, useMemo, useRef } from "react";
import { CheckCircle2, ChevronLeft, ChevronRight, Circle, CircleDot, GitBranch, Loader2, Pause, XCircle } from "lucide-react";
import { flowName } from "@codecast/shared/contracts/flowPool";
import { useRunGraph, useSessionRun, useWorkflowRun } from "../hooks/useSyncWorkflows";
import { flowContext, runStanding, stepTarget, type FlowFocus, type FlowStation, type StationState } from "../lib/flowContext";
import { runHref } from "../lib/decisionLinks";

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
export function FlowContextOf({ run, focus, className }: { run: any; focus?: FlowFocus; className?: string }) {
  const router = useRouter();
  const graph = useRunGraph(run._id, run.workflow_id);
  const ctx = useMemo(() => flowContext(run, graph, focus), [run, graph, focus?.conversationId, focus?.decisionId, focus?.nodeId]);
  if (!ctx.stations.length) return null;
  const name = flowName({ label: graph?.label ?? run.workflow_label, name: graph?.name ?? run.workflow_name }) || "Flow";
  const prev = stepTarget(ctx, ctx.focus, -1);
  const next = stepTarget(ctx, ctx.focus, 1);
  const go = (i: number) => { const h = ctx.stations[i]?.href; if (h) router.push(h); };
  const standing = runStanding(run, ctx);
  // The viewer's station is in view however narrow the pane: the row scrolls itself, never the page.
  const rowRef = useRef<HTMLOListElement>(null);
  useLayoutEffect(() => {
    const row = rowRef.current;
    const chip = row?.querySelector<HTMLElement>("[data-focus]");
    if (!row || !chip) return;
    const left = chip.offsetLeft;
    if (left < row.scrollLeft || left + chip.offsetWidth > row.scrollLeft + row.clientWidth) row.scrollLeft = left - (row.clientWidth - chip.offsetWidth) / 2;
  }, [ctx.focus, ctx.stations.length]);

  return (
    <nav
      className={`rounded-lg border border-sol-border/40 bg-sol-bg-alt/30 text-meta ${className ?? ""}`}
      aria-label={`${name} flow`}
      data-flow-context={run._id}
    >
      <div className="flex items-center gap-2 px-2 pt-1.5">
        <GitBranch className="w-3.5 h-3.5 shrink-0 text-sol-violet" />
        <Link href={runHref(run._id)} className="font-medium text-sol-violet hover:underline truncate" title="Open the run">{name}</Link>
        <span className={MARK[standing.state].color}>{standing.words}</span>
        {ctx.lineChanged && (
          <span className="px-1.5 py-px rounded border border-sol-orange/40 text-sol-orange" title="The flow was republished without the station this run stands at" data-line-changed>
            flow changed
          </span>
        )}
        <span className="ml-auto flex items-center gap-0.5 shrink-0">
          <span className="tabular-nums text-sol-text-dim mr-1">{ctx.focus + 1}/{ctx.stations.length}</span>
          <StepButton dir="prev" target={ctx.stations[prev]} onClick={() => go(prev)} />
          <StepButton dir="next" target={ctx.stations[next]} onClick={() => go(next)} />
        </span>
      </div>
      <ol ref={rowRef} className="relative flex items-center gap-0 px-2 pt-1 pb-1.5 overflow-x-auto [scrollbar-width:thin]">
        {ctx.stations.map((s, i) => (
          <li key={`${s.id}:${i}`} className="flex items-center shrink-0" data-station={s.id} data-focus={i === ctx.focus || undefined}>
            {i > 0 && <span className={`w-2.5 h-px shrink-0 ${s.state === "next" ? "bg-sol-border/40" : "bg-sol-border"}`} aria-hidden />}
            <StationChip s={s} focused={i === ctx.focus} />
          </li>
        ))}
      </ol>
    </nav>
  );
}

function StationChip({ s, focused }: { s: FlowStation; focused: boolean }) {
  const m = MARK[s.state];
  const Icon = s.current && s.state !== "waiting" ? CircleDot : m.icon;
  const tone = focused ? `${m.ring} text-sol-text font-medium` : "border-transparent text-sol-text-muted";
  const title = [s.segment && s.segment !== s.label ? `${s.segment} · ${s.label}` : s.label, s.current ? "the run is here" : null, s.href ? (s.href.startsWith("/decisions") ? "open the decision" : "open its session") : null].filter(Boolean).join(" · ");
  const body = (
    <>
      <Icon className={`w-3.5 h-3.5 shrink-0 ${m.color}`} />
      {s.label}
    </>
  );
  const cls = `inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border whitespace-nowrap ${tone}`;
  return s.href ? (
    <Link href={s.href} className={`${cls} hover:bg-sol-bg-alt hover:text-sol-text`} title={title} aria-current={focused ? "step" : undefined}>{body}</Link>
  ) : (
    <span className={cls} title={title} aria-current={focused ? "step" : undefined}>{body}</span>
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
