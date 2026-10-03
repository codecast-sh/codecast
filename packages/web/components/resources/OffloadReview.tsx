"use client";

// Review before anything moves: each suggested session with the reason it was
// picked, what moving it would roughly free, what stays behind, and where it
// can go. Readiness comes from the planner. Checks nobody can automate stay
// pending until the user confirms them for that session, and a confirmation
// is recorded as such, never as a passed check. Blockers cannot be overridden.
import React from "react";
import { AlertTriangle, Check, CircleDashed, Cloud, Laptop, RotateCcw, X } from "lucide-react";
import { cn } from "../../lib/utils";
import { WAIT_PRESETS, isRowActive, isRowTerminal } from "../../lib/migrationPlan";
import { MigrationStatusPill } from "../MigrationStatusPill";
import { fmtAgo, fmtBytes, fmtCpu, fmtRange, memoryUsed, projectName } from "./resourceModel";
import type { OffloadCandidate, OffloadDestination, OffloadPlan, OffloadReadiness, OffloadRun, OffloadSelection, ResourceActions, ResourceSession } from "./types";

const READINESS: Record<OffloadReadiness, { label: string; tone: string }> = {
  ready: { label: "checks passed", tone: "text-sol-green" },
  preflight_required: { label: "needs confirmation", tone: "text-sol-yellow" },
  blocked: { label: "blocked", tone: "text-sol-red" },
  unsupported: { label: "unsupported", tone: "text-sol-text-dim" },
};

const DISRUPTION: Record<OffloadCandidate["disruption"], string> = {
  idle: "idle, moves at once",
  between_turns: "between turns",
  mid_turn: "mid-turn, waits for the turn to end",
};

/** `attested` holds the pending items the user confirmed, verbatim, at the moment they ticked. */
type Choice = { checked: boolean; destinationId?: string; attested: string[] };

/** Pending items the user has not confirmed yet; new or reworded ones count as unconfirmed. */
const unconfirmedOf = (pending: string[], ch: Choice) => pending.filter((p) => !ch.attested.includes(p));

/** What a move could free: an upper bound from resident memory, a range only when the planner measured one. */
function reliefText(lo: number | undefined, hi: number | undefined): string {
  if (hi === undefined) return "unknown";
  return lo ? fmtRange(lo, hi, fmtBytes) : `up to ${fmtBytes(hi)}`;
}

const SAFE_WAITS = WAIT_PRESETS.filter((p) => p.value > 0);

function destIcon(d: OffloadDestination) {
  return d.role === "local" ? <Laptop className="h-3 w-3" /> : <Cloud className="h-3 w-3" />;
}

function CandidateRow({ c, session, plan, choice, onChange }: {
  c: OffloadCandidate; session?: ResourceSession; plan: OffloadPlan; choice: Choice; onChange: (c: Choice) => void;
}) {
  const dest = choice.destinationId ? c.perDestination[choice.destinationId] : undefined;
  const selectable = !!dest && (dest.readiness === "ready" || dest.readiness === "preflight_required");
  const [showPassed, setShowPassed] = React.useState(false);
  return (
    <div className={cn("border-b border-sol-border/20 px-4 py-3", choice.checked && "bg-sol-cyan/[0.05]")} data-candidate={c.sessionId}>
      <div className="flex items-start gap-2.5">
        <input
          type="checkbox"
          aria-label={`Move ${session?.title ?? c.sessionId}`}
          className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--sol-cyan,#2aa198)] disabled:opacity-40"
          disabled={!selectable}
          checked={choice.checked && selectable}
          onChange={(e) => onChange({ ...choice, checked: e.target.checked })}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="truncate text-[12px] font-medium text-sol-text">{session?.title ?? c.sessionId}</span>
            <span className="text-[10px] text-sol-text-dim">{[session?.shortId, projectName(session?.projectPath)].filter(Boolean).join(" · ")}</span>
          </div>
          <div className="mt-0.5 text-[11px] text-sol-text-secondary">{c.reason}</div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-sol-text-muted">
            <span>its own processes: <span className="tabular-nums text-sol-blue">{fmtCpu(c.relief.cpu)}</span> CPU, <span className="tabular-nums text-sol-violet">{reliefText(c.relief.rssLow, c.relief.rssHigh)}</span> resident</span>
            <span>{c.confidence} confidence</span>
            <span>{DISRUPTION[c.disruption]}</span>
          </div>
          {c.staysLocal.length > 0 && (
            <div className="mt-1 text-[10px] text-sol-text-muted">
              Stays here: {c.staysLocal.map((s) => `${s.label} (${[s.cpu !== undefined ? fmtCpu(s.cpu) : undefined, s.rss !== undefined ? fmtBytes(s.rss) : undefined].filter(Boolean).join(", ")}; ${s.why.charAt(0).toLowerCase()}${s.why.slice(1)})`).join("; ")}
            </div>
          )}

          {plan.destinations.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1" role="radiogroup" aria-label="Destination">
              {plan.destinations.map((d) => {
                const r = c.perDestination[d.deviceId];
                const picked = choice.destinationId === d.deviceId;
                return (
                  <button
                    key={d.deviceId}
                    type="button"
                    role="radio"
                    aria-checked={picked}
                    onClick={() => onChange(picked ? choice : { checked: r?.readiness === "ready", destinationId: d.deviceId, attested: [] })}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-[11px]",
                      picked ? "border-sol-cyan/60 bg-sol-cyan/10 text-sol-text" : "border-sol-border/40 text-sol-text-muted hover:border-sol-border/70 hover:text-sol-text",
                    )}
                  >
                    {destIcon(d)}
                    {d.name}
                    <span className={cn("text-[10px]", READINESS[r?.readiness ?? "unsupported"].tone)}>{READINESS[r?.readiness ?? "unsupported"].label}</span>
                  </button>
                );
              })}
            </div>
          )}

          {dest && (
            <div className="mt-2 space-y-1 text-[11px]">
              {c.requiresMac && <div className="text-sol-text-muted">Observed: {c.requiresMac}.</div>}
              {dest.fit && <div className="text-sol-text-secondary">{dest.fit}</div>}
              {dest.blockers.map((b) => (
                <div key={b} className="flex gap-1.5 text-sol-red"><X className="mt-px h-3 w-3 shrink-0" />{b}</div>
              ))}
              {dest.passed && dest.passed.length > 0 && (
                <div className="text-sol-text-muted">
                  <button type="button" className="inline-flex items-center gap-1 hover:text-sol-text" onClick={() => setShowPassed(!showPassed)}>
                    <Check className="h-3 w-3 text-sol-green" /> {dest.passed.length} checks passed {showPassed ? "▾" : "▸"}
                  </button>
                  {showPassed && <ul className="ml-4 mt-0.5 list-none space-y-0.5">{dest.passed.map((p) => <li key={p}>{p}</li>)}</ul>}
                </div>
              )}
              {dest.pending.length > 0 && dest.blockers.length === 0 && (
                <div className="rounded border border-sol-yellow/30 bg-sol-yellow/[0.06] px-2 py-1.5">
                  <div className="mb-1 text-[10px] uppercase tracking-wide text-sol-yellow">Not checkable automatically</div>
                  {dest.pending.map((p) => (
                    <div key={p} className="flex gap-1.5 text-sol-text-secondary"><CircleDashed className="mt-px h-3 w-3 shrink-0 text-sol-yellow" />{p}</div>
                  ))}
                  <label className="mt-1.5 flex cursor-pointer items-start gap-1.5 text-sol-text">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-3 w-3 accent-[var(--sol-yellow,#b58900)]"
                      checked={unconfirmedOf(dest.pending, choice).length === 0}
                      onChange={(e) => onChange(e.target.checked ? { ...choice, attested: [...dest.pending], checked: true } : { ...choice, attested: [] })}
                    />
                    <span>I have checked these requirements for this session</span>
                  </label>
                  {choice.attested.length > 0 && unconfirmedOf(dest.pending, choice).length > 0 && (
                    <div className="mt-1 text-[10px] text-sol-yellow">The requirements changed since you confirmed them; confirm the new list.</div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export type OffloadReviewProps = {
  plan: OffloadPlan;
  sessions: ResourceSession[];
  sourceName: string;
  now: number;
  /** Sessions ticked in the table before opening review. */
  initialSelected?: string[];
  actions?: ResourceActions;
  actionsDisabledReason?: string;
  onClose: () => void;
};

export function OffloadReview({ plan, sessions, sourceName, now, initialSelected, actions, actionsDisabledReason, onClose }: OffloadReviewProps) {
  const byId = React.useMemo(() => new Map(sessions.map((s) => [s.sessionId, s])), [sessions]);
  // Choices survive new samples: the plan is rebuilt every sample, the user's review is not.
  const [edited, setChoices] = React.useState<Record<string, Choice>>({});
  const choiceFor = (c: OffloadCandidate): Choice => {
    const own = edited[c.sessionId];
    if (own && own.destinationId && c.perDestination[own.destinationId]) return own;
    const destinationId = c.suggestedDestinationId ?? plan.destinations[0]?.deviceId;
    const selectable = destinationId ? ["ready", "preflight_required"].includes(c.perDestination[destinationId]?.readiness ?? "") : false;
    return { destinationId, attested: [], checked: !!initialSelected?.includes(c.sessionId) && selectable };
  };
  const choices = Object.fromEntries(plan.candidates.map((c) => [c.sessionId, choiceFor(c)]));
  const [wait, setWait] = React.useState(SAFE_WAITS[1]?.value ?? SAFE_WAITS[0].value);
  const [showNotOffered, setShowNotOffered] = React.useState(false);

  const picked = plan.candidates.filter((c) => {
    const ch = choices[c.sessionId];
    const r = ch?.destinationId ? c.perDestination[ch.destinationId] : undefined;
    return ch?.checked && r && (r.readiness === "ready" || r.readiness === "preflight_required");
  });
  const unconfirmed = picked.filter((c) => {
    const ch = choices[c.sessionId]; const r = c.perDestination[ch.destinationId!];
    return unconfirmedOf(r.pending, ch).length > 0;
  });
  const needsPreflight = picked.filter((c) => c.perDestination[choices[c.sessionId].destinationId!].readiness === "preflight_required");
  const selections: OffloadSelection[] = picked.map((c) => {
    const ch = choices[c.sessionId];
    return { sessionId: c.sessionId, destinationId: ch.destinationId!, attested: c.perDestination[ch.destinationId!].pending.filter((p) => ch.attested.includes(p)) };
  });

  const sum = (f: (c: OffloadCandidate) => number | undefined) => picked.some((c) => f(c) === undefined) ? undefined : picked.reduce((a, c) => a + (f(c) ?? 0), 0);
  const stays = new Map<string, OffloadCandidate["staysLocal"][number]>();
  for (const c of picked) for (const s of c.staysLocal) stays.set(`${s.label}:${s.pid ?? ""}`, s);
  const unevaluated = (initialSelected ?? []).filter((id) => !plan.candidates.some((c) => c.sessionId === id) && !plan.notOffered.some((n) => n.sessionId === id));

  const off = actionsDisabledReason;
  const moveBlocked = !actions?.onStartOffload ? (off ?? "Moving is not available here")
    : picked.length === 0 ? "Select at least one session"
    : unconfirmed.length > 0 ? `Confirm the requirements for ${unconfirmed.length} session${unconfirmed.length === 1 ? "" : "s"} first`
    : undefined;

  return (
    <section aria-label="Review offload" className="flex h-full min-h-0 flex-col bg-sol-bg">
      <header className="flex items-start gap-3 border-b border-sol-border/30 px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-semibold text-sol-text">Move work off {sourceName}</h2>
          <p className={cn("mt-0.5 text-[11px]", plan.incident.level === "critical" ? "text-sol-red" : "text-sol-yellow")}>
            {plan.incident.reason} since {fmtAgo(plan.incident.since, now)}
          </p>
          <p className="mt-0.5 text-[10px] text-sol-text-dim">Suggested {fmtAgo(plan.generatedAt, now)}. Checked again against the server before anything moves.</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close review" className="rounded p-1 text-sol-text-dim hover:bg-sol-bg-highlight hover:text-sol-text"><X className="h-4 w-4" /></button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {plan.destinations.length === 0 && (
          <div className="border-b border-sol-border/20 bg-sol-bg-alt/60 px-4 py-3 text-[11px] text-sol-text-secondary">
            No cloud host is set up, so nothing can move yet. The sessions below are what would help most; add a host in Settings → Devices to move them.
          </div>
        )}
        {plan.candidates.map((c) => (
          <CandidateRow
            key={c.sessionId}
            c={c}
            session={byId.get(c.sessionId)}
            plan={plan}
            choice={choices[c.sessionId]}
            onChange={(ch) => setChoices((s) => ({ ...s, [c.sessionId]: ch }))}
          />
        ))}
        {unevaluated.length > 0 && (
          <div className="border-b border-sol-border/20 px-4 py-2 text-[11px] text-sol-text-muted">
            {unevaluated.length} selected session{unevaluated.length === 1 ? " was" : "s were"} not part of this suggestion and {unevaluated.length === 1 ? "has" : "have"} no readiness yet: {unevaluated.map((id) => byId.get(id)?.title ?? id).join(", ")}.
          </div>
        )}
        {plan.notOffered.length > 0 && (
          <div className="px-4 py-2 text-[11px]">
            <button type="button" className="text-sol-text-muted hover:text-sol-text" onClick={() => setShowNotOffered(!showNotOffered)}>
              {plan.notOffered.length} session{plan.notOffered.length === 1 ? "" : "s"} not offered {showNotOffered ? "▾" : "▸"}
            </button>
            {showNotOffered && plan.notOffered.map((n) => (
              <div key={n.sessionId} className="mt-1 flex gap-2 text-sol-text-muted">
                <span className="truncate text-sol-text-secondary">{byId.get(n.sessionId)?.title ?? n.sessionId}</span>
                <span className="shrink-0">{n.reason}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <footer className="border-t border-sol-border/30 bg-sol-bg-alt/50 px-4 py-3 text-[11px]">
        {picked.length > 0 && (
          <div className="mb-2 space-y-1">
            {plan.destinations.map((d) => {
              const going = picked.filter((c) => choices[c.sessionId].destinationId === d.deviceId);
              if (going.length === 0) return null;
              const hi = going.reduce((a, c) => a + (c.relief.rssHigh ?? 0), 0);
              const tight = d.headroom?.memoryAvailable !== undefined && hi > d.headroom.memoryAvailable;
              return (
                <div key={d.deviceId} className="flex flex-wrap items-center gap-x-2 text-sol-text-secondary">
                  <span className="inline-flex items-center gap-1 text-sol-text">{destIcon(d)}{d.name}</span>
                  <span>{going.length} session{going.length === 1 ? "" : "s"}</span>
                  <span className="text-sol-text-muted">· {d.asleep ? "asleep, boots on move" : d.online ? "online" : "offline"}</span>
                  <span className={cn("text-sol-text-muted", tight && "text-sol-yellow")}>
                    · {d.headroom?.memoryAvailable !== undefined ? `${fmtBytes(d.headroom.memoryAvailable)} free` : "free memory unknown"}{tight ? ", may not fit" : ""}
                  </span>
                  <span className="text-sol-text-muted">· cost {d.costPerHour !== undefined ? `$${d.costPerHour.toFixed(2)}/h` : "unknown"}</span>
                </div>
              );
            })}
            <div className="text-sol-text-muted">
              These sessions' own processes use <span className="text-sol-blue tabular-nums">{fmtCpu(sum((c) => c.relief.cpu))}</span> CPU and <span className="text-sol-violet tabular-nums">{reliefText(sum((c) => c.relief.rssLow), sum((c) => c.relief.rssHigh))}</span> resident here.
              {" "}Shared pages may stay in use, so the memory actually freed can be less; it is measured after the move.
            </div>
            {stays.size > 0 && (
              <div className="text-sol-text-muted">Stays here: {[...stays.values()].map((s) => s.label).join(", ")}.</div>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-sol-text-muted">
            Mid-turn sessions
            <select value={wait} onChange={(e) => setWait(Number(e.target.value))} className="rounded border border-sol-border/40 bg-sol-bg px-1 py-0.5 text-[11px] text-sol-text">
              {SAFE_WAITS.map((p) => <option key={p.value} value={p.value}>{p.label.toLowerCase()}</option>)}
            </select>
          </label>
          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              disabled={!actions?.onPreflight || needsPreflight.length === 0}
              title={!actions?.onPreflight ? (off ?? "Preflight is not available here") : needsPreflight.length === 0 ? "Nothing selected needs preflight" : undefined}
              onClick={() => actions?.onPreflight?.(selections.filter((s) => needsPreflight.some((c) => c.sessionId === s.sessionId)))}
              className="rounded border border-sol-border/50 px-2 py-1 text-sol-text hover:bg-sol-bg-highlight disabled:cursor-not-allowed disabled:opacity-40"
            >
              Run preflight{needsPreflight.length ? ` (${needsPreflight.length})` : ""}
            </button>
            <button
              type="button"
              disabled={!!moveBlocked}
              title={moveBlocked}
              onClick={() => actions?.onStartOffload?.(selections, { waitForTurnMs: wait })}
              className="rounded bg-sol-cyan px-2.5 py-1 font-semibold text-sol-bg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Move {picked.length || ""} session{picked.length === 1 ? "" : "s"}
            </button>
          </div>
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-sol-text-dim">
          Nothing is interrupted. A session mid-turn moves when its turn ends; if the turn is still running when the wait runs out, it stays here and is reported as left running.
          {moveBlocked && actions?.onStartOffload ? "" : off ? ` ${off}` : ""}
        </p>
      </footer>
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
              {active && (actions?.onCancel
                ? <button type="button" className="ml-auto text-sol-text-muted hover:text-sol-red" onClick={() => actions.onCancel!(run.batchId)}>Cancel remaining</button>
                : <span className="ml-auto text-sol-text-dim" title={actionsDisabledReason}>Cancel remaining</span>)}
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
