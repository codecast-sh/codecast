"use client";

// One Ship control (docs/architecture/ship.md): the same button on a task's
// review station, a session's header and a pull request's page. The popover
// says exactly what a press does (the plan the server resolves, the same one
// `cast ship run --dry-run` prints), and the line under the button follows
// the ship session from the store: working, checks running, PR opened,
// merged, or failed with the failing check named.
import { useCallback, useState } from "react";
import Link from "next/link";
import { Rocket, GitBranch, ArrowRight } from "lucide-react";
import { shipProgress, type ShipPhase, type ShipProgress } from "@codecast/shared/contracts/shipPlan";
import { useInboxStore } from "../store/inboxStore";
import { useShipTarget, type ShipTargetRef, type ShipTargetRow } from "../hooks/useShipTarget";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { KeyCap } from "./KeyboardShortcutsHelp";

const PHASE_TONE: Record<ShipPhase, string> = {
  starting: "var(--sol-text-dim)",
  working: "var(--sol-blue)",
  checks: "var(--sol-yellow)",
  pr_open: "var(--sol-cyan)",
  merged: "var(--sol-magenta)",
  failed: "var(--sol-red)",
  done: "var(--sol-green)",
};
const LIVE: ReadonlySet<ShipPhase> = new Set(["starting", "working", "checks"]);

/** Where the latest run stands, read off the store rows its progress lives in. */
function useRunProgress(row: ShipTargetRow | undefined): ShipProgress | null {
  return useInboxStore((s) => {
    const run = row?.run;
    if (!run) return null;
    if (run.procedure === "line_gate" || run.decision_id) {
      const ship = row?.line?.ship;
      if (row?.line?.merge) return { phase: "merged", text: `Merged ${row.line.merge.branch} into ${row.line.merge.into}`, pr: null };
      if (!ship || ship.status === "pending") return { phase: "starting", text: "Answered Ship on the card; the line's ship station is next", pr: null };
      if (ship.status === "running") return { phase: "working", text: "The line's ship station is running", pr: null };
      if (ship.status === "failed" || ship.outcome === "failure") return { phase: "failed", text: `Failed: ${ship.preview ?? row?.line?.fail_reason ?? "the ship station"}`, pr: null };
      return { phase: "done", text: ship.preview ?? "Shipped", pr: null };
    }
    const session = run.conversation_id ? (s as any).sessions?.[run.conversation_id] ?? null : null;
    const prId = row?.pr_id ?? session?.pr_status?.pr_id;
    const pr = prId ? (s as any).pullRequests?.[prId] ?? null : null;
    return shipProgress({ session, pr });
  }, (a, b) => a?.phase === b?.phase && a?.text === b?.text && a?.pr?.number === b?.pr?.number);
}

export function ShipControl({ target, size = "full" }: { target: ShipTargetRef; size?: "full" | "compact" }) {
  const row = useShipTarget(target);
  const progress = useRunProgress(row);
  const startShip = useInboxStore((s) => s.startShip);
  const [open, setOpen] = useState(false);
  const plan = row?.plan ?? null;
  const live = !!progress && LIVE.has(progress.phase);
  const press = useCallback(() => {
    if (!plan || plan.blocked) return;
    startShip(target, `ship-${Date.now().toString(36)}`, plan.decisionId ?? undefined);
    setOpen(false);
  }, [plan, startShip, target]);

  return (
    <div className={size === "compact" ? "flex min-w-0 items-center gap-2" : "flex flex-col items-start gap-1"} data-ship-control={target.kind}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={live}
            data-ship-button
            className={`inline-flex items-center gap-1.5 rounded border border-sol-green/50 bg-sol-green/10 font-medium text-sol-green transition-colors hover:bg-sol-green/20 disabled:cursor-default disabled:opacity-60 ${size === "compact" ? "h-6 px-2 text-xs" : "h-7 px-3 text-sm"}`}
            title={live ? "Shipping now" : "What Ship will do"}
          >
            <Rocket className={size === "compact" ? "h-3 w-3" : "h-3.5 w-3.5"} />
            {live ? "Shipping" : "Ship"}
          </button>
        </PopoverTrigger>
        <PopoverContent
          align={size === "compact" ? "end" : "start"}
          className="w-[23rem] border-sol-border bg-sol-bg p-0 text-sol-text"
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); press(); } }}
          data-ship-popover
        >
          <ShipPlanView row={row} onShip={press} onCancel={() => setOpen(false)} />
        </PopoverContent>
      </Popover>
      {progress && <ShipStatusLine progress={progress} run={row?.run ?? null} />}
    </div>
  );
}

function ShipPlanView({ row, onShip, onCancel }: { row: ShipTargetRow | undefined; onShip: () => void; onCancel: () => void }) {
  const plan = row?.plan;
  if (!plan) return <p className="p-4 text-sm text-sol-text-dim">Reading what Ship would do here…</p>;
  return (
    <div className="flex flex-col">
      <div className="border-b border-sol-border px-4 py-3">
        <div className="text-[13px] font-semibold leading-snug">Ship {plan.label}</div>
        {plan.branch && (
          <div className="mt-1.5 inline-flex items-center gap-1.5 font-mono text-[11px] text-sol-text-muted" data-ship-branch>
            <GitBranch className="h-3 w-3" />
            {plan.branch}
            <ArrowRight className="h-3 w-3 text-sol-text-dim" />
            {plan.base}
            {plan.newBranch && <span className="text-sol-text-dim">(new branch)</span>}
          </div>
        )}
      </div>
      <ol className="flex flex-col gap-1.5 px-4 py-3 text-[12.5px] leading-snug" data-ship-steps>
        {plan.steps.map((step, i) => (
          <li key={i} className="flex gap-2">
            <span className="mt-px w-4 shrink-0 text-right font-mono text-[11px] text-sol-text-dim">{i + 1}</span>
            <span>{renderCode(step)}</span>
          </li>
        ))}
      </ol>
      <div
        className="mx-4 mb-3 rounded border px-2.5 py-2 text-[12px] leading-snug"
        style={{
          borderColor: `color-mix(in srgb, ${plan.merge.will ? "var(--sol-magenta)" : "var(--sol-cyan)"} 40%, transparent)`,
          background: `color-mix(in srgb, ${plan.merge.will ? "var(--sol-magenta)" : "var(--sol-cyan)"} 8%, transparent)`,
        }}
        data-ship-merge={plan.merge.will ? "merges" : "no-merge"}
      >
        <span className="font-semibold">{plan.merge.will ? `Merges (${plan.merge.method}).` : "Does not merge."}</span> {plan.merge.why}
      </div>
      {plan.blocked && <p className="mx-4 mb-3 text-[12px] text-sol-red" data-ship-blocked>{plan.blocked}</p>}
      <div className="flex items-center justify-end gap-2 border-t border-sol-border px-4 py-2.5">
        <button type="button" onClick={onCancel} className="h-7 rounded px-2.5 text-xs text-sol-text-muted hover:bg-sol-bg-alt">
          Cancel <KeyCap size="xs">Esc</KeyCap>
        </button>
        <button
          type="button"
          onClick={onShip}
          disabled={!!plan.blocked}
          data-ship-confirm
          className="inline-flex h-7 items-center gap-1.5 rounded bg-sol-green px-3 text-xs font-semibold text-sol-bg hover:opacity-90 disabled:opacity-40"
        >
          Ship it <KeyCap size="xs">Enter</KeyCap>
        </button>
      </div>
    </div>
  );
}

function ShipStatusLine({ progress, run }: { progress: ShipProgress; run: ShipTargetRow["run"] }) {
  const tone = PHASE_TONE[progress.phase];
  return (
    <div className="flex max-w-full items-center gap-1.5 text-[11.5px] text-sol-text-muted" data-ship-phase={progress.phase}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${LIVE.has(progress.phase) ? "animate-pulse" : ""}`} style={{ background: tone }} />
      <span className="truncate" style={{ color: progress.phase === "failed" ? tone : undefined }} title={progress.text}>{progress.text}</span>
      {progress.pr && (
        <Link href={`/pr/${progress.pr.repository}/${progress.pr.number}`} className="shrink-0 text-sol-blue hover:underline">
          #{progress.pr.number}
        </Link>
      )}
      {run?.conversation_id && (
        <Link href={`/conversation/${run.conversation_id}`} className="shrink-0 text-sol-text-dim hover:text-sol-text hover:underline">
          ship session
        </Link>
      )}
    </div>
  );
}

/** `code` spans in a plan step render as code. */
function renderCode(text: string) {
  return text.split(/(`[^`]+`)/g).map((part, i) =>
    part.startsWith("`") && part.endsWith("`")
      ? <code key={i} className="rounded bg-sol-bg-alt px-1 font-mono text-[11px]">{part.slice(1, -1)}</code>
      : part,
  );
}

/**
 * The task page's review station: Ship once the task is in review, and the
 * run's progress for as long as there is one (it outlives the review).
 */
export function TaskShipStation({ task }: { task: { _id: string; status?: string } }) {
  const hasRun = useInboxStore((s) => !!(s as any).shipTargets?.[`task:${task._id}`]?.run);
  if (task.status !== "in_review" && !hasRun) return null;
  return (
    <section className="mb-6 flex flex-col gap-2" data-task-ship>
      <h3 className="text-xs font-medium uppercase tracking-wide text-sol-text-dim">Ship</h3>
      <ShipControl target={{ kind: "task", id: task._id }} />
    </section>
  );
}
