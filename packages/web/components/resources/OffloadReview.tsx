"use client";

// Review before anything moves, built for sending a batch off in one click:
// every session that can move is ticked, and the panel leads with what the
// move does to load: this machine's CPU and memory before and after, and the
// same for every host receiving sessions. Destinations default to spreading
// across hosts (lib/resourceOffload assignDestinations). The planner's
// reasoning sits behind disclosures. Checks no machine can prove are listed
// once and confirmed by pressing Move; the confirmation is recorded per
// session as such, never as a passed check. Blockers cannot be overridden.
import React from "react";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Cloud, Laptop, RotateCcw, X } from "lucide-react";
import { cn } from "../../lib/utils";
import { WAIT_PRESETS, isRowActive, isRowTerminal } from "../../lib/migrationPlan";
import { MigrationStatusPill } from "../MigrationStatusPill";
import { fmtAgo, fmtBytes, fmtCpu, memoryUsed, projectName } from "./resourceModel";
import type { OffloadCandidate, OffloadDestination, OffloadPlan, OffloadRun, OffloadSelection, ResourceActions, ResourceSession } from "./types";
import { SPREAD_CEILING, assignDestinations, loadShift } from "../../lib/resourceOffload";

const movable = (r: OffloadCandidate["perDestination"][string] | undefined) => r?.readiness === "ready" || r?.readiness === "preflight_required";

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

const AUTO = "auto";
const pctText = (n: number | undefined) => n === undefined ? "?" : `${Math.round(n)}%`;

/** One measure before and after the move: the part that leaves is a ghost, the part that arrives is lit. */
function LoadBar({ label, before, after }: { label: string; before?: number; after?: number }) {
  if (before === undefined) return null;
  const clamp = (n: number) => Math.min(100, Math.max(0, n));
  const end = after ?? before;
  const lo = clamp(Math.min(before, end)), hi = clamp(Math.max(before, end));
  const rising = end > before;
  const tone = end > 100 ? "bg-sol-red" : end > SPREAD_CEILING ? "bg-sol-yellow" : "bg-sol-cyan";
  return (
    <div className="flex items-center gap-2.5 text-[11px]">
      <span className="w-12 shrink-0 text-sol-text-dim">{label}</span>
      <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-sol-border/25">
        <div className={cn("absolute inset-y-0 left-0 rounded-full transition-[width] duration-300", rising ? "bg-sol-text-dim/50" : tone)} style={{ width: `${lo}%` }} />
        {hi > lo && (
          <div
            className={cn("absolute inset-y-0 transition-all duration-300", rising ? tone : "bg-sol-text-dim/25")}
            style={{ left: `${lo}%`, width: `${hi - lo}%`, ...(rising ? {} : { backgroundImage: "repeating-linear-gradient(135deg, transparent 0 3px, color-mix(in srgb, currentColor 18%, transparent) 3px 5px)" }) }}
          />
        )}
      </div>
      <span className="w-[5.5rem] shrink-0 text-right tabular-nums text-sol-text-muted">
        {after === undefined || Math.round(after) === Math.round(before)
          ? pctText(before)
          : <>{pctText(before)} <span className="text-sol-text-dim">→</span> <span className={cn("font-medium", end > 100 ? "text-sol-red" : end > SPREAD_CEILING ? "text-sol-yellow" : "text-sol-text")}>{pctText(after)}</span></>}
      </span>
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
  const [chosenMode, setMode] = React.useState<string>(AUTO);
  const [wait, setWait] = React.useState(SAFE_WAITS[1]?.value ?? SAFE_WAITS[0].value);

  const mode = chosenMode === AUTO || plan.destinations.some((d) => d.deviceId === chosenMode) ? chosenMode : AUTO;
  const preselect = initialSelected?.length ? new Set(initialSelected) : undefined;
  const pinned = (c: OffloadCandidate) => { const id = edited[c.sessionId]?.destinationId; return id && movable(c.perDestination[id]) ? id : undefined; };
  const canMove = plan.candidates.filter((c) => plan.destinations.some((d) => movable(c.perDestination[d.deviceId])));
  const blocked = plan.candidates.filter((c) => !canMove.includes(c));
  const isChecked = (c: OffloadCandidate) => edited[c.sessionId]?.checked ?? (preselect ? preselect.has(c.sessionId) : true);
  const picked = canMove.filter(isChecked);
  const auto = assignDestinations(plan, picked.filter((c) => !pinned(c)), mode);
  const destOf = (c: OffloadCandidate) => pinned(c) ?? auto.get(c.sessionId) ?? c.suggestedDestinationId ?? plan.destinations.find((d) => movable(c.perDestination[d.deviceId]))?.deviceId ?? "";
  const going = picked.filter((c) => movable(c.perDestination[destOf(c)]));
  // Pressing Move confirms the items no check can prove, shown once below for the whole batch.
  const selections: OffloadSelection[] = going.map((c) => ({ sessionId: c.sessionId, destinationId: destOf(c), attested: [...c.perDestination[destOf(c)].pending] }));
  const toConfirm = [...new Set(going.flatMap((c) => c.perDestination[destOf(c)].pending))];

  // The server's dry run runs once on open, so its blockers show before anyone presses Move.
  const preflight = actions?.onPreflight;
  const firstCheck = React.useRef(true);
  React.useEffect(() => {
    if (!firstCheck.current || !preflight || canMove.length === 0) return;
    firstCheck.current = false;
    preflight(canMove.map((c) => ({ sessionId: c.sessionId, destinationId: destOf(c), attested: [] })));
  });

  const sumOf = (cs: OffloadCandidate[]) => ({
    cpu: cs.some((c) => c.relief.cpu === undefined) ? undefined : cs.reduce((a, c) => a + (c.relief.cpu ?? 0), 0),
    rss: cs.reduce((a, c) => a + (c.relief.rssHigh ?? 0), 0),
  });
  const leaving = sumOf(going);
  const source = loadShift(plan.sourceSample, leaving, -1);
  const receiving = plan.destinations
    .map((d) => ({ d, cs: going.filter((c) => destOf(c) === d.deviceId) }))
    .filter(({ d, cs }) => cs.length > 0 || (mode === d.deviceId));
  const hostsUsed = receiving.filter((r) => r.cs.length > 0).length;
  const unevaluated = (initialSelected ?? []).filter((id) => !plan.candidates.some((c) => c.sessionId === id) && !plan.notOffered.some((n) => n.sessionId === id));
  const midTurn = going.some((c) => c.disruption === "mid_turn");
  const allChecked = canMove.length > 0 && picked.length === canMove.length;
  const setAll = (checked: boolean) => setChoices((s) => Object.fromEntries(plan.candidates.map((c) => [c.sessionId, { ...s[c.sessionId], checked }])));
  const titleOf = (id: string) => byId.get(id)?.title ?? id;
  const stayCount = blocked.length + plan.notOffered.length + unevaluated.length;

  const off = actionsDisabledReason;
  const moveBlocked = !actions?.onStartOffload ? (off ?? "Moving is not available here") : going.length === 0 ? "Select at least one session" : undefined;

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
        <div className="space-y-1.5 rounded-xl bg-sol-bg-alt px-3.5 py-3" data-load="source">
          <div className="flex items-center gap-2 text-[11px] text-sol-text-dim">
            <Laptop className="h-3.5 w-3.5" /><span className="truncate">{sourceName}</span>
            {going.length > 0 && <span className="ml-auto tabular-nums">{fmtCpu(leaving.cpu)} · {fmtBytes(leaving.rss)} leave</span>}
          </div>
          <LoadBar label="CPU" before={source.before.cpu} after={going.length ? source.after.cpu : undefined} />
          <LoadBar label="Memory" before={source.before.memory} after={going.length ? source.after.memory : undefined} />
        </div>

        {plan.destinations.length === 0 ? (
          <div className="rounded-xl bg-sol-bg-alt px-4 py-3 text-[12px] text-sol-text-secondary">
            No cloud host is set up yet. Add one in Settings → Devices.
          </div>
        ) : (
          <>
            <div>
              <div className="mb-1.5 flex items-center px-1 text-[11px] text-sol-text-dim">
                <span>Move to</span>
                {plan.destinations.length > 1 && (
                  <label className="relative ml-auto inline-flex items-center gap-1 text-sol-text-secondary hover:text-sol-text">
                    {mode === AUTO ? `Spread automatically${hostsUsed > 1 ? ` · ${hostsUsed} hosts` : ""}` : plan.destinations.find((d) => d.deviceId === mode)?.name}
                    <ChevronDown className="h-3 w-3" />
                    <select aria-label="Destination" value={mode} onChange={(e) => setMode(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0">
                      <option value={AUTO}>Spread automatically</option>
                      {plan.destinations.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.name}{d.asleep ? " (asleep)" : !d.online ? " (offline)" : ""}</option>)}
                    </select>
                  </label>
                )}
              </div>
              <div className="space-y-1.5">
                {receiving.map(({ d, cs }) => {
                  const shift = d.sample ? loadShift(d.sample, sumOf(cs), 1) : undefined;
                  return (
                    <div key={d.deviceId} className="space-y-1.5 rounded-xl bg-sol-bg-alt px-3.5 py-3" data-load={d.deviceId}>
                      <div className="flex items-center gap-2 text-[11px]">
                        <span className="text-sol-cyan">{destIcon(d, "h-3.5 w-3.5")}</span>
                        <span className="truncate font-medium text-sol-text">{d.name}</span>
                        <span className="text-sol-text-dim">{d.asleep ? "asleep, wakes on move" : !d.online ? "offline" : ""}</span>
                        <span className="ml-auto shrink-0 tabular-nums text-sol-text-dim">
                          {[plural(cs.length, "session"), d.costPerHour !== undefined ? `$${d.costPerHour.toFixed(2)}/h` : undefined].filter(Boolean).join(" · ")}
                        </span>
                      </div>
                      {shift ? (
                        <>
                          <LoadBar label="CPU" before={shift.before.cpu} after={cs.length ? shift.after.cpu : undefined} />
                          <LoadBar label="Memory" before={shift.before.memory} after={cs.length ? shift.after.memory : undefined} />
                        </>
                      ) : <div className="text-[11px] text-sol-text-dim">Load not measured yet</div>}
                    </div>
                  );
                })}
              </div>
            </div>

            {canMove.length > 0 && (
              <div>
                <div className="mb-1.5 flex items-baseline px-1 text-[11px] text-sol-text-dim">
                  <span>{plural(canMove.length, "session")}</span>
                  {canMove.length > 1 && (
                    <button type="button" className="ml-auto hover:text-sol-text" onClick={() => setAll(!allChecked)}>{allChecked ? "Select none" : "Select all"}</button>
                  )}
                </div>
                <div className="divide-y divide-sol-border/15 overflow-hidden rounded-xl bg-sol-bg-alt">
                  {canMove.map((c) => {
                    const checked = picked.includes(c);
                    const host = plan.destinations.find((d) => d.deviceId === destOf(c));
                    return (
                      <CandidateRow
                        key={c.sessionId}
                        c={c}
                        title={titleOf(c.sessionId)}
                        checked={checked}
                        elsewhere={checked && host && (hostsUsed > 1 || !!pinned(c)) ? host : undefined}
                        onCheck={(v) => setChoices((s) => ({ ...s, [c.sessionId]: { ...s[c.sessionId], checked: v } }))}
                      />
                    );
                  })}
                </div>
              </div>
            )}

            <div className="space-y-2 px-1">
              {stayCount > 0 && (
                <Disclosure label={`${stayCount} stay${stayCount === 1 ? "s" : ""} here`}>
                  {blocked.map((c) => (
                    <div key={c.sessionId} data-candidate={c.sessionId}>
                      <div className="text-sol-text-secondary">{titleOf(c.sessionId)}</div>
                      {[...new Set(Object.values(c.perDestination).flatMap((r) => r.blockers))].map((b) => (
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
                  <div>Estimates from the last sample. Session CPU is spread over each machine's cores; memory freed can be less than shown, because processes share pages. Automatic spreading fills a host to {SPREAD_CEILING}% before using the next.</div>
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
                      destinationId={destOf(c)}
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
          <div className="text-center text-[11px] text-sol-text-muted">Nothing is interrupted.</div>
          {toConfirm.length > 0 && going.length > 0 && (
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
            {toConfirm.length > 0 && going.length > 0 ? "Confirm and move" : "Move"} {going.length > 0 ? plural(going.length, "session") : "sessions"}
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
