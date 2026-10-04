"use client";

// Review before anything moves, built for sending a batch off in one click:
// every session that can move is ticked, one destination covers the batch,
// and each row shows only what decides it (title, what it uses, why it can't
// move). The planner's reasoning sits behind a row's disclosure. Checks no
// machine can prove are listed once in the footer and confirmed by pressing
// Move; the confirmation is recorded per session as such, never as a passed
// check. Blockers cannot be overridden.
import React from "react";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Cloud, Laptop, RotateCcw, X } from "lucide-react";
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
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function destIcon(d: OffloadDestination, size = "h-3 w-3") {
  return d.role === "local" ? <Laptop className={size} /> : <Cloud className={size} />;
}

function Disclosure({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="inline-flex items-center gap-1 text-[11px] text-sol-text-dim hover:text-sol-text">
        <ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} />{label}
      </button>
      {open && <div className="mt-2 space-y-3 pl-4 text-[11px] text-sol-text-muted">{children}</div>}
    </div>
  );
}

/** `destinationId` is set only when the user sent this one session somewhere other than the batch. */
type Choice = { checked: boolean; destinationId?: string };

function CandidateRow({ c, title, checked, elsewhere, onCheck }: { c: OffloadCandidate; title: string; checked: boolean; elsewhere?: OffloadDestination; onCheck: (checked: boolean) => void }) {
  return (
    <label className={cn("flex cursor-pointer items-center gap-3 px-3.5 py-2.5 transition-colors hover:bg-sol-bg-highlight/40", !checked && "opacity-55")} data-candidate={c.sessionId}>
      <input
        type="checkbox"
        aria-label={`Move ${title}`}
        className="h-4 w-4 shrink-0 accent-[var(--sol-cyan,#2aa198)]"
        checked={checked}
        onChange={(e) => onCheck(e.target.checked)}
      />
      <span className="min-w-0 flex-1 truncate text-[13px] text-sol-text">{title}</span>
      {c.disruption === "mid_turn" && <span className="shrink-0 text-[10px] text-sol-yellow">working</span>}
      {elsewhere && <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-sol-text-muted">{destIcon(elsewhere)}{elsewhere.name}</span>}
      <span className="shrink-0 text-[11px] tabular-nums text-sol-text-dim">
        {[c.relief.cpu !== undefined ? fmtCpu(c.relief.cpu) : undefined, c.relief.rssHigh !== undefined ? fmtBytes(c.relief.rssHigh) : undefined].filter(Boolean).join(" · ")}
      </span>
    </label>
  );
}

function CandidateDetail({ c, session, plan, destinationId, onDestination }: {
  c: OffloadCandidate; session?: ResourceSession; plan: OffloadPlan; destinationId?: string; onDestination: (id: string) => void;
}) {
  const dest = destinationId ? c.perDestination[destinationId] : undefined;
  return (
    <div className="space-y-1">
      <div className="text-sol-text-secondary">{session?.title ?? c.sessionId}</div>
      <div>{[session?.shortId, projectName(session?.projectPath), c.reason].filter(Boolean).join(" · ")}</div>
      {dest?.notes?.map((n) => <div key={n} className="text-sol-text-dim">{n}</div>)}
      {dest?.passed && dest.passed.length > 0 && (
        <div className="flex gap-1.5"><Check className="mt-px h-3 w-3 shrink-0 text-sol-green" />Checked: {dest.passed.join("; ")}</div>
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
                  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] disabled:cursor-not-allowed disabled:opacity-40",
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
  const destOf = (c: OffloadCandidate) => resolved.get(c.sessionId)!.destinationId!;
  const canMove = plan.candidates.filter((c) => movable(c.perDestination[resolved.get(c.sessionId)!.destinationId ?? ""]));
  const blocked = plan.candidates.filter((c) => !canMove.includes(c));
  const picked = canMove.filter((c) => resolved.get(c.sessionId)!.checked);
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
  const titleOf = (id: string) => byId.get(id)?.title ?? id;
  const stayCount = blocked.length + plan.notOffered.length + unevaluated.length;

  const off = actionsDisabledReason;
  const moveBlocked = !actions?.onStartOffload ? (off ?? "Moving is not available here") : picked.length === 0 ? "Select at least one session" : undefined;
  const targetDest = plan.destinations.find((d) => d.deviceId === target);
  const tight = targetDest?.headroom?.memoryAvailable !== undefined && rss > targetDest.headroom.memoryAvailable;
  const relief = [cpu !== undefined ? `${fmtCpu(cpu)} CPU` : undefined, rss > 0 ? `${reliefText(0, rss)} memory` : undefined].filter(Boolean).join(", ");

  return (
    <section aria-label="Review offload" className="flex h-full min-h-0 flex-col bg-sol-bg">
      <header className="flex items-start gap-3 px-5 pb-3 pt-5">
        <div className="min-w-0 flex-1">
          <h2 className="text-[17px] font-semibold tracking-tight text-sol-text">Free up {sourceName}</h2>
          <p className="mt-1 flex items-center gap-1.5 truncate text-[12px] text-sol-text-muted" title={plan.incident.reason}>
            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", plan.incident.level === "critical" ? "bg-sol-red" : "bg-sol-yellow")} />
            {plan.incident.reason} for {fmtAgo(plan.incident.since, now).replace(/ ago$/, "")}
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close review" className="-mr-1 rounded-full p-1.5 text-sol-text-dim hover:bg-sol-bg-highlight hover:text-sol-text"><X className="h-4 w-4" /></button>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 pb-4">
        {plan.destinations.length === 0 ? (
          <div className="rounded-xl bg-sol-bg-alt px-4 py-3 text-[12px] text-sol-text-secondary">
            No cloud host is set up yet. Add one in Settings → Devices.
          </div>
        ) : (
          <>
            {targetDest && (
              <label className="relative flex items-center gap-3 rounded-xl bg-sol-bg-alt px-3.5 py-2.5">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-sol-cyan/15 text-sol-cyan">{destIcon(targetDest, "h-3.5 w-3.5")}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[10px] uppercase tracking-wide text-sol-text-dim">Move to</span>
                  <span className="block truncate text-[13px] font-medium text-sol-text">
                    {targetDest.name}{targetDest.asleep ? " (asleep)" : !targetDest.online ? " (offline)" : ""}
                  </span>
                </span>
                {tight && <span className="shrink-0 text-[11px] text-sol-yellow">may not fit</span>}
                {plan.destinations.length > 1 && (
                  <>
                    <ChevronDown className="h-3.5 w-3.5 shrink-0 text-sol-text-dim" />
                    <select aria-label="Destination" value={target} onChange={(e) => setBatchDest(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0">
                      {plan.destinations.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.name}{d.asleep ? " (asleep)" : !d.online ? " (offline)" : ""}</option>)}
                    </select>
                  </>
                )}
              </label>
            )}

            {canMove.length > 0 && (
              <div>
                <div className="mb-1.5 flex items-baseline px-1 text-[11px] text-sol-text-dim">
                  <span>{plural(canMove.length, "session")}</span>
                  {canMove.length > 1 && (
                    <button type="button" className="ml-auto hover:text-sol-text" onClick={() => setAll(!allChecked)}>{allChecked ? "Select none" : "Select all"}</button>
                  )}
                </div>
                <div className="divide-y divide-sol-border/15 overflow-hidden rounded-xl bg-sol-bg-alt">
                  {canMove.map((c) => (
                    <CandidateRow
                      key={c.sessionId}
                      c={c}
                      title={titleOf(c.sessionId)}
                      checked={resolved.get(c.sessionId)!.checked}
                      elsewhere={resolved.get(c.sessionId)!.overridden ? plan.destinations.find((d) => d.deviceId === destOf(c)) : undefined}
                      onCheck={(checked) => setChoices((s) => ({ ...s, [c.sessionId]: { ...s[c.sessionId], checked } }))}
                    />
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-2 px-1">
              {stayCount > 0 && (
                <Disclosure label={`${stayCount} stay${stayCount === 1 ? "s" : ""} here`}>
                  {blocked.map((c) => (
                    <div key={c.sessionId} data-candidate={c.sessionId}>
                      <div className="text-sol-text-secondary">{titleOf(c.sessionId)}</div>
                      {(c.perDestination[destOf(c) ?? ""]?.blockers ?? []).map((b) => (
                        <div key={b} className="flex gap-1.5 text-sol-red"><X className="mt-px h-3 w-3 shrink-0" />{b}</div>
                      ))}
                    </div>
                  ))}
                  {plan.notOffered.map((n) => (
                    <div key={n.sessionId}><div className="text-sol-text-secondary">{titleOf(n.sessionId)}</div><div className="text-sol-text-dim">{n.reason}</div></div>
                  ))}
                  {unevaluated.map((id) => (
                    <div key={id}><div className="text-sol-text-secondary">{titleOf(id)}</div><div className="text-sol-text-dim">Not part of this suggestion yet</div></div>
                  ))}
                </Disclosure>
              )}
              {canMove.length > 0 && (
                <Disclosure label="Details">
                  {targetDest && (targetDest.headroom?.memoryAvailable !== undefined || targetDest.costPerHour !== undefined) && (
                    <div className={cn(tight && "text-sol-yellow")}>
                      {targetDest.name}: {[targetDest.headroom?.memoryAvailable !== undefined ? `${fmtBytes(targetDest.headroom.memoryAvailable)} free${tight ? ", may not fit" : ""}` : undefined,
                        targetDest.costPerHour !== undefined ? `$${targetDest.costPerHour.toFixed(2)}/h` : undefined].filter(Boolean).join(" · ")}
                    </div>
                  )}
                  {midTurn && (
                    <label className="flex items-center gap-1.5">
                      Working sessions move after their turn; wait up to
                      <select value={wait} onChange={(e) => setWait(Number(e.target.value))} className="rounded border border-sol-border/40 bg-sol-bg px-1 py-0.5 text-[11px] text-sol-text">
                        {SAFE_WAITS.map((p) => <option key={p.value} value={p.value}>{p.label.toLowerCase().replace(/^wait up to /, "")}</option>)}
                      </select>
                    </label>
                  )}
                  {canMove.map((c) => (
                    <CandidateDetail
                      key={c.sessionId}
                      c={c}
                      session={byId.get(c.sessionId)}
                      plan={plan}
                      destinationId={resolved.get(c.sessionId)!.destinationId}
                      onDestination={(destinationId) => setChoices((s) => ({ ...s, [c.sessionId]: { checked: true, destinationId } }))}
                    />
                  ))}
                </Disclosure>
              )}
            </div>
          </>
        )}
      </div>

      {plan.destinations.length > 0 && (
        <footer className="space-y-2.5 border-t border-sol-border/20 px-5 pb-5 pt-3.5">
          <div className="text-center text-[11px] text-sol-text-muted">
            {picked.length > 0 && relief ? <>Frees about <span className="tabular-nums text-sol-text-secondary">{relief}</span>. Nothing is interrupted.</> : "Nothing is interrupted."}
          </div>
          {toConfirm.length > 0 && picked.length > 0 && (
            <details className="text-[11px] text-sol-text-muted">
              <summary className="cursor-pointer select-none text-center hover:text-sol-text">You confirm {plural(toConfirm.length, "item")} not checked automatically</summary>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">{toConfirm.map((p) => <li key={p}>{p}</li>)}</ul>
            </details>
          )}
          <button
            type="button"
            disabled={!!moveBlocked}
            title={moveBlocked}
            onClick={() => { actions?.onStartOffload?.(selections, { waitForTurnMs: wait }); onClose(); }}
            className="w-full rounded-xl bg-sol-cyan px-4 py-2.5 text-[14px] font-semibold text-sol-bg transition-opacity hover:opacity-90 active:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {toConfirm.length > 0 && picked.length > 0 ? "Confirm and move" : "Move"} {picked.length > 0 ? plural(picked.length, "session") : "sessions"}
          </button>
          {moveBlocked && off && <div className="text-center text-[10px] text-sol-text-dim">{off}</div>}
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
