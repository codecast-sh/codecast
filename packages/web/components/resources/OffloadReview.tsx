"use client";

// Review before anything moves, built for sending a batch off in one click:
// every session that can move is ticked, one destination covers the batch,
// and each row shows only what decides it (title, what it uses, why it can't
// move). The planner's reasoning sits behind a row's disclosure. Checks no
// machine can prove are listed once in the footer and confirmed by pressing
// Move; the confirmation is recorded per session as such, never as a passed
// check. Blockers cannot be overridden.
import React from "react";
import { AlertTriangle, Check, ChevronRight, Cloud, Laptop, RotateCcw, X } from "lucide-react";
import { cn } from "../../lib/utils";
import { WAIT_PRESETS, isRowActive, isRowTerminal } from "../../lib/migrationPlan";
import { MigrationStatusPill } from "../MigrationStatusPill";
import { fmtAgo, fmtBytes, fmtCpu, fmtRange, memoryUsed, projectName } from "./resourceModel";
import type { OffloadCandidate, OffloadDestination, OffloadPlan, OffloadRun, OffloadSelection, ResourceActions, ResourceSession } from "./types";

const movable = (r: OffloadCandidate["perDestination"][string] | undefined) => r?.readiness === "ready" || r?.readiness === "preflight_required";

/** What a move could free: an upper bound from resident memory, a range only when the planner measured one. */
function reliefText(lo: number | undefined, hi: number | undefined): string {
  if (hi === undefined) return "unknown";
  return lo ? fmtRange(lo, hi, fmtBytes) : `up to ${fmtBytes(hi)}`;
}

const SAFE_WAITS = WAIT_PRESETS.filter((p) => p.value > 0);

function destIcon(d: OffloadDestination) {
  return d.role === "local" ? <Laptop className="h-3 w-3" /> : <Cloud className="h-3 w-3" />;
}

/** `destinationId` is set only when the user sent this one session somewhere other than the batch. */
type Choice = { checked: boolean; destinationId?: string };

function CandidateRow({ c, session, plan, destinationId, checked, overridden, onCheck, onDestination }: {
  c: OffloadCandidate; session?: ResourceSession; plan: OffloadPlan; destinationId?: string; checked: boolean; overridden: boolean;
  onCheck: (checked: boolean) => void; onDestination: (id: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const dest = destinationId ? c.perDestination[destinationId] : undefined;
  const ok = movable(dest);
  const title = session?.title ?? c.sessionId;
  const elsewhere = overridden ? plan.destinations.find((d) => d.deviceId === destinationId) : undefined;
  return (
    <div className={cn("border-b border-sol-border/15", checked && ok && "bg-sol-cyan/[0.04]")} data-candidate={c.sessionId}>
      <div className="flex items-center gap-2.5 px-4 py-2">
        <input
          type="checkbox"
          aria-label={`Move ${title}`}
          className="h-3.5 w-3.5 shrink-0 accent-[var(--sol-cyan,#2aa198)] disabled:opacity-30"
          disabled={!ok}
          checked={checked && ok}
          onChange={(e) => onCheck(e.target.checked)}
        />
        <button type="button" onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-expanded={open}>
          <ChevronRight className={cn("h-3 w-3 shrink-0 text-sol-text-dim transition-transform", open && "rotate-90")} />
          <span className={cn("truncate text-[12px]", ok ? "text-sol-text" : "text-sol-text-muted")}>{title}</span>
          {c.disruption === "mid_turn" && <span className="shrink-0 rounded bg-sol-yellow/10 px-1 text-[10px] text-sol-yellow">working</span>}
          {elsewhere && <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-sol-text-muted">{destIcon(elsewhere)}{elsewhere.name}</span>}
          <span className="ml-auto shrink-0 text-right text-[10px] tabular-nums">
            {ok
              ? <><span className="text-sol-blue">{fmtCpu(c.relief.cpu)}</span><span className="text-sol-text-dim"> · </span><span className="text-sol-violet">{c.relief.rssHigh !== undefined ? fmtBytes(c.relief.rssHigh) : "?"}</span></>
              : <span className="text-sol-red/80" title={dest?.blockers.join("\n")}>can't move</span>}
          </span>
        </button>
      </div>
      {open && (
        <div className="space-y-1.5 pb-3 pl-[3.25rem] pr-4 text-[11px] text-sol-text-muted">
          <div>{[session?.shortId, projectName(session?.projectPath)].filter(Boolean).join(" · ")}{session?.shortId ? " · " : ""}{c.reason}</div>
          {dest?.blockers.map((b) => (
            <div key={b} className="flex gap-1.5 text-sol-red"><X className="mt-px h-3 w-3 shrink-0" />{b}</div>
          ))}
          {dest?.notes?.map((n) => <div key={n} className="text-sol-text-dim">{n}</div>)}
          {dest?.passed && dest.passed.length > 0 && (
            <div className="flex gap-1.5"><Check className="mt-px h-3 w-3 shrink-0 text-sol-green" />{dest.passed.join("; ")}</div>
          )}
          {c.staysLocal.length > 0 && <div>Stays here: {c.staysLocal.map((s) => s.label).join(", ")}</div>}
          {plan.destinations.length > 1 && (
            <div className="flex flex-wrap gap-1 pt-0.5" role="radiogroup" aria-label="Destination">
              {plan.destinations.map((d) => {
                const r = c.perDestination[d.deviceId];
                const picked = destinationId === d.deviceId;
                return (
                  <button
                    key={d.deviceId}
                    type="button"
                    role="radio"
                    aria-checked={picked}
                    disabled={!movable(r)}
                    title={!movable(r) ? r?.blockers.join("\n") : undefined}
                    onClick={() => onDestination(d.deviceId)}
                    className={cn(
                      "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] disabled:cursor-not-allowed disabled:opacity-40",
                      picked ? "border-sol-cyan/60 bg-sol-cyan/10 text-sol-text" : "border-sol-border/40 hover:text-sol-text",
                    )}
                  >
                    {destIcon(d)}{d.name}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export type OffloadReviewProps = {
  plan: OffloadPlan;
  sessions: ResourceSession[];
  sourceName: string;
  now: number;
  /** Sessions ticked in the table before opening review; without them every movable session starts ticked. */
  initialSelected?: string[];
  actions?: ResourceActions;
  actionsDisabledReason?: string;
  onClose: () => void;
};

export function OffloadReview({ plan, sessions, sourceName, now, initialSelected, actions, actionsDisabledReason, onClose }: OffloadReviewProps) {
  const byId = React.useMemo(() => new Map(sessions.map((s) => [s.sessionId, s])), [sessions]);
  // Choices survive new samples: the plan is rebuilt every sample, the user's review is not.
  const [edited, setChoices] = React.useState<Record<string, Choice>>({});
  const [batchDest, setBatchDest] = React.useState<string | undefined>();
  const [wait, setWait] = React.useState(SAFE_WAITS[1]?.value ?? SAFE_WAITS[0].value);
  const [showNotOffered, setShowNotOffered] = React.useState(false);

  // The batch goes where most sessions can go; a session that can't go there falls back to its own suggestion.
  const viableCount = (id: string) => plan.candidates.filter((c) => movable(c.perDestination[id])).length;
  const defaultDest = [...plan.destinations].sort((a, b) => viableCount(b.deviceId) - viableCount(a.deviceId))[0]?.deviceId;
  const target = batchDest && plan.destinations.some((d) => d.deviceId === batchDest) ? batchDest : defaultDest;
  const preselect = initialSelected?.length ? new Set(initialSelected) : undefined;
  const resolve = (c: OffloadCandidate) => {
    const own = edited[c.sessionId];
    const destinationId = own?.destinationId && c.perDestination[own.destinationId] ? own.destinationId
      : target && movable(c.perDestination[target]) ? target : c.suggestedDestinationId ?? target;
    const checked = own ? own.checked : preselect ? preselect.has(c.sessionId) : true;
    return { destinationId, checked: checked && !!destinationId && movable(c.perDestination[destinationId]), overridden: !!destinationId && destinationId !== target };
  };
  const resolved = new Map(plan.candidates.map((c) => [c.sessionId, resolve(c)]));
  const ordered = [...plan.candidates].sort((a, b) => Number(movable(b.perDestination[resolved.get(b.sessionId)!.destinationId ?? ""])) - Number(movable(a.perDestination[resolved.get(a.sessionId)!.destinationId ?? ""])));
  const canMove = plan.candidates.filter((c) => movable(c.perDestination[resolved.get(c.sessionId)!.destinationId ?? ""]));
  const picked = canMove.filter((c) => resolved.get(c.sessionId)!.checked);
  const destOf = (c: OffloadCandidate) => resolved.get(c.sessionId)!.destinationId!;
  // Pressing Move confirms the items no check can prove, shown once below for the whole batch.
  const selections: OffloadSelection[] = picked.map((c) => ({ sessionId: c.sessionId, destinationId: destOf(c), attested: [...c.perDestination[destOf(c)].pending] }));
  const toConfirm = [...new Set(picked.flatMap((c) => c.perDestination[destOf(c)].pending))];

  // The server's dry run runs once on open, so its blockers show before anyone presses Move.
  const preflight = actions?.onPreflight;
  const firstCheck = React.useRef(true);
  React.useEffect(() => {
    if (!firstCheck.current || !preflight || canMove.length === 0) return;
    firstCheck.current = false;
    preflight(canMove.map((c) => ({ sessionId: c.sessionId, destinationId: destOf(c), attested: [] })));
  });

  const cpu = picked.some((c) => c.relief.cpu === undefined) ? undefined : picked.reduce((a, c) => a + (c.relief.cpu ?? 0), 0);
  const rss = picked.reduce((a, c) => a + (c.relief.rssHigh ?? 0), 0);
  const unevaluated = (initialSelected ?? []).filter((id) => !plan.candidates.some((c) => c.sessionId === id) && !plan.notOffered.some((n) => n.sessionId === id));
  const midTurn = picked.some((c) => c.disruption === "mid_turn");
  const allChecked = canMove.length > 0 && picked.length === canMove.length;
  const setAll = (checked: boolean) => setChoices((s) => Object.fromEntries(plan.candidates.map((c) => [c.sessionId, { ...s[c.sessionId], checked }])));

  const off = actionsDisabledReason;
  const moveBlocked = !actions?.onStartOffload ? (off ?? "Moving is not available here") : picked.length === 0 ? "Select at least one session" : undefined;
  const targetDest = plan.destinations.find((d) => d.deviceId === target);
  const tight = targetDest?.headroom?.memoryAvailable !== undefined && rss > targetDest.headroom.memoryAvailable;

  return (
    <section aria-label="Review offload" className="flex h-full min-h-0 flex-col bg-sol-bg">
      <header className="flex items-center gap-3 border-b border-sol-border/30 px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-semibold text-sol-text">Move work off {sourceName}</h2>
          <p className={cn("mt-0.5 truncate text-[11px]", plan.incident.level === "critical" ? "text-sol-red" : "text-sol-yellow")} title={plan.incident.reason}>
            {plan.incident.reason} for {fmtAgo(plan.incident.since, now).replace(/ ago$/, "")}
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close review" className="rounded p-1 text-sol-text-dim hover:bg-sol-bg-highlight hover:text-sol-text"><X className="h-4 w-4" /></button>
      </header>

      {plan.destinations.length === 0 ? (
        <div className="border-b border-sol-border/20 bg-sol-bg-alt/60 px-4 py-3 text-[11px] text-sol-text-secondary">
          No cloud host is set up, so nothing can move yet. Add one in Settings → Devices.
        </div>
      ) : (
        <div className="flex items-center gap-2.5 border-b border-sol-border/30 px-4 py-2 text-[11px] text-sol-text-muted">
          <input
            type="checkbox"
            aria-label="Select every session that can move"
            className="h-3.5 w-3.5 accent-[var(--sol-cyan,#2aa198)] disabled:opacity-30"
            disabled={canMove.length === 0}
            checked={allChecked}
            onChange={(e) => setAll(e.target.checked)}
          />
          <span>{canMove.length} of {plan.candidates.length} can move</span>
          <span className="ml-auto text-[10px] text-sol-text-dim">CPU · memory</span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {ordered.map((c) => {
          const r = resolved.get(c.sessionId)!;
          return (
            <CandidateRow
              key={c.sessionId}
              c={c}
              session={byId.get(c.sessionId)}
              plan={plan}
              destinationId={r.destinationId}
              checked={r.checked}
              overridden={r.overridden}
              onCheck={(checked) => setChoices((s) => ({ ...s, [c.sessionId]: { ...s[c.sessionId], checked } }))}
              onDestination={(destinationId) => setChoices((s) => ({ ...s, [c.sessionId]: { checked: true, destinationId } }))}
            />
          );
        })}
        {unevaluated.length > 0 && (
          <div className="border-b border-sol-border/15 px-4 py-2 text-[11px] text-sol-text-muted">
            Not part of this suggestion yet: {unevaluated.map((id) => byId.get(id)?.title ?? id).join(", ")}.
          </div>
        )}
        {plan.notOffered.length > 0 && (
          <div className="px-4 py-2 text-[11px]">
            <button type="button" className="inline-flex items-center gap-1 text-sol-text-dim hover:text-sol-text" onClick={() => setShowNotOffered(!showNotOffered)}>
              <ChevronRight className={cn("h-3 w-3 transition-transform", showNotOffered && "rotate-90")} />
              {plan.notOffered.length} more stay here
            </button>
            {showNotOffered && plan.notOffered.map((n) => (
              <div key={n.sessionId} className="mt-1 flex gap-2 pl-4 text-sol-text-muted">
                <span className="truncate text-sol-text-secondary">{byId.get(n.sessionId)?.title ?? n.sessionId}</span>
                <span className="ml-auto shrink-0 text-sol-text-dim">{n.reason}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {plan.destinations.length > 0 && (
        <footer className="space-y-2 border-t border-sol-border/30 bg-sol-bg-alt/50 px-4 py-3 text-[11px]">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <label className="flex items-center gap-1.5 text-sol-text-muted">
              Send to
              <select value={target} onChange={(e) => setBatchDest(e.target.value)} className="rounded border border-sol-border/40 bg-sol-bg px-1 py-0.5 text-[11px] text-sol-text">
                {plan.destinations.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.name}{d.asleep ? " (asleep)" : !d.online ? " (offline)" : ""}</option>)}
              </select>
            </label>
            {targetDest && (
              <span className={cn("text-sol-text-dim", tight && "text-sol-yellow")}>
                {[targetDest.headroom?.memoryAvailable !== undefined ? `${fmtBytes(targetDest.headroom.memoryAvailable)} free${tight ? ", may not fit" : ""}` : undefined,
                  targetDest.costPerHour !== undefined ? `$${targetDest.costPerHour.toFixed(2)}/h` : undefined].filter(Boolean).join(" · ")}
              </span>
            )}
            {midTurn && (
              <label className="ml-auto flex items-center gap-1.5 text-sol-text-muted" title="A working session moves when its turn ends; if it is still running after this wait, it stays here.">
                Wait for working sessions
                <select value={wait} onChange={(e) => setWait(Number(e.target.value))} className="rounded border border-sol-border/40 bg-sol-bg px-1 py-0.5 text-[11px] text-sol-text">
                  {SAFE_WAITS.map((p) => <option key={p.value} value={p.value}>{p.label.toLowerCase().replace(/^wait /, "")}</option>)}
                </select>
              </label>
            )}
          </div>
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1 text-[10px] leading-snug text-sol-text-dim">
              {picked.length > 0 && <div>Frees about <span className="tabular-nums text-sol-blue">{fmtCpu(cpu)}</span> CPU and <span className="tabular-nums text-sol-violet">{reliefText(0, rss)}</span> here. Nothing is interrupted.</div>}
              {toConfirm.length > 0 && (
                <details>
                  <summary className="cursor-pointer select-none hover:text-sol-text">Moving confirms {toConfirm.length} thing{toConfirm.length === 1 ? "" : "s"} no check can prove</summary>
                  <ul className="mt-0.5 list-disc pl-4">{toConfirm.map((p) => <li key={p}>{p}</li>)}</ul>
                </details>
              )}
              {moveBlocked && off && <div>{off}</div>}
            </div>
            <button
              type="button"
              disabled={!!moveBlocked}
              title={moveBlocked}
              onClick={() => { actions?.onStartOffload?.(selections, { waitForTurnMs: wait }); onClose(); }}
              className="shrink-0 rounded bg-sol-cyan px-3 py-1.5 text-[12px] font-semibold text-sol-bg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Move {picked.length || ""} session{picked.length === 1 ? "" : "s"}
            </button>
          </div>
        </footer>
      )}
    </section>
  );
}

export function OffloadRuns({ runs, sessions, destinations, now, actions, actionsDisabledReason }: {
  runs: OffloadRun[]; sessions: ResourceSession[]; destinations: Map<string, string>; now: number; actions?: ResourceActions; actionsDisabledReason?: string;
}) {
  if (runs.length === 0) return null;
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));
  return (
    <div className="border-b border-sol-border/30">
      {runs.map((run) => {
        const active = run.rows.some((r) => isRowActive(r.status) || r.status === "queued");
        const done = run.rows.filter((r) => r.status === "done").length;
        const failed = run.rows.filter((r) => r.status === "failed").length;
        const b = run.measured?.before; const a = run.measured?.after;
        return (
          <div key={run.batchId} className="px-4 py-2.5" data-run={run.batchId}>
            <div className="flex flex-wrap items-center gap-x-3 text-[11px]">
              <span className="font-medium text-sol-text">Offload {active ? "in progress" : "finished"}</span>
              <span className="text-sol-text-muted">{done}/{run.rows.length} moved{failed ? `, ${failed} failed` : ""} · started {fmtAgo(run.createdAt, now)} · waits up to {Math.round(run.waitForTurnMs / 60_000)} min per turn, never interrupts</span>
              {active && (actions?.onCancel && !run.cancelUnavailable
                ? <button type="button" className="ml-auto text-sol-text-muted hover:text-sol-red" onClick={() => actions.onCancel!(run.batchId)}>Cancel remaining</button>
                : <span className="ml-auto cursor-not-allowed text-sol-text-dim" title={run.cancelUnavailable ?? actionsDisabledReason}>Cancel remaining</span>)}
            </div>
            <div className="mt-1.5 space-y-1">
              {run.rows.map((r) => (
                <div key={r.sessionId} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 text-[11px] sm:grid-cols-[minmax(0,1fr)_9rem_auto_4.5rem]">
                  <span className="truncate text-sol-text-secondary">{byId.get(r.sessionId)?.title ?? r.sessionId}</span>
                  <span className="hidden truncate text-sol-text-muted sm:block">→ {destinations.get(r.destinationId) ?? r.destinationId}</span>
                  <MigrationStatusPill status={r.status} />
                  <span className="hidden text-right sm:block">
                    {r.status === "failed" && (actions?.onRetry
                      ? <button type="button" className="inline-flex items-center gap-1 text-sol-cyan hover:underline" onClick={() => actions.onRetry!(run.batchId, r.sessionId)}><RotateCcw className="h-3 w-3" />Retry</button>
                      : <span className="text-sol-text-dim" title={actionsDisabledReason}>Retry</span>)}
                  </span>
                  {r.error && <span className="col-span-full flex gap-1 pl-2 text-[10px] text-sol-red/90"><AlertTriangle className="mt-px h-3 w-3 shrink-0" />{r.error}</span>}
                </div>
              ))}
            </div>
            {b && (
              <div className="mt-1.5 text-[10px] text-sol-text-muted">
                {a && run.finishedAt !== undefined && a.at > run.finishedAt && run.rows.every((r) => isRowTerminal(r.status))
                  ? <>Measured on this machine: memory in use {fmtBytes(memoryUsed(b))} → {fmtBytes(memoryUsed(a))} ({memoryUsed(b) - memoryUsed(a) >= 0 ? "−" : "+"}{fmtBytes(Math.abs(memoryUsed(b) - memoryUsed(a)))}), CPU {b.cpuPercent?.toFixed(0) ?? "n/a"}% → {a.cpuPercent?.toFixed(0) ?? "n/a"}%. Other work on the machine moves these numbers too.</>
                  : <>Relief is measured from the first sample after every session has finished moving.</>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
