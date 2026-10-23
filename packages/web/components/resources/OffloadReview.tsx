"use client";

// Review before anything moves, built for sending a batch off in one click:
// every session that can move is ticked, and the panel leads with what the
// move does to load: this machine's CPU and memory before and after, and the
// same for every host receiving sessions. Destinations default to spreading
// across hosts (lib/resourceOffload assignDestinations). The planner's
// reasoning sits behind disclosures, and sessions that stay are grouped by
// reason. Checks no machine can prove are confirmed by pressing Move; the
// confirmation is recorded per session as such, never as a passed check.
// Blockers cannot be overridden. The review holds the plan it opened on, so a
// new sample never reorders or re-picks what the person is looking at. Once
// Move is pressed the panel follows that launch (OffloadProgress).
import React from "react";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Cloud, Laptop, RotateCcw, X } from "lucide-react";
import { cn } from "../../lib/utils";
import { WAIT_PRESETS, isRowActive, isRowTerminal } from "../../lib/migrationPlan";
import { MigrationStatusPill } from "../MigrationStatusPill";
import { fmtAgo, fmtBytes, fmtCpu, memoryUsed, namedStops, projectName } from "./resourceModel";
import type { OffloadCandidate, OffloadDestination, OffloadPlan, OffloadRehearsal, OffloadRun, OffloadSelection, ResourceActions, ResourceSession, StayingSession } from "./types";
import { bringsByDefault, rehearsalPending, type MoveRehearsal } from "@codecast/shared/contracts/moveRehearsal";
import { SPREAD_CEILING, assignDestinations, holdPlan, loadShareOf, loadShift, sliceForPercent } from "../../lib/resourceOffload";
import { Button } from "../ui/button";

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

function groupBy(rows: Array<{ id: string; reason: string }>): Array<[string, string[]]> {
  const m = new Map<string, string[]>();
  for (const r of rows) m.set(r.reason, [...(m.get(r.reason) ?? []), r.id]);
  return [...m].sort((a, b) => b[1].length - a[1].length);
}

function StayGroup({ reason, titles }: { reason: string; titles: string[] }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 text-left hover:text-sol-text">
        <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
        <span className="flex-1 truncate text-sol-text-secondary">{reason}</span>
        <span className="tabular-nums text-sol-text-dim">{titles.length}</span>
      </button>
      {open && <div className="mt-1 space-y-0.5 pl-5">{titles.map((t, i) => <div key={i} className="truncate">{t}</div>)}</div>}
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
type Choice = { checked: boolean; destinationId?: string; /** Paths the person turned on or off, over the defaults. */ bring?: Record<string, boolean> };

/** The paths a move brings for this rehearsal: the defaults, then the person's own picks. */
function bringFor(r: MoveRehearsal | undefined, picks: Record<string, boolean> | undefined): string[] {
  return (r?.missing ?? []).filter((m) => picks?.[m.path] ?? bringsByDefault(m)).map((m) => m.path);
}

const homeShort = (p: string) => p.replace(/^\/(Users|home)\/[^/]+/, "~");

const movableHere = (plan: OffloadPlan) => plan.candidates.filter((c) => plan.destinations.some((d) => movable(c.perDestination[d.deviceId])));
const round5 = (n: number) => Math.round(n / 5) * 5;

/**
 * Where the dial starts. Under pressure: enough of the movable load to bring
 * the hottest measure back to about 70%, all of it when that is not enough.
 * Otherwise half.
 */
function startingPercent(plan: OffloadPlan): number {
  const sample = plan.sourceSample;
  const peak = Math.max(sample.cpuPercent ?? 0, memoryUsed(sample) / Math.max(sample.memoryTotal, 1) * 100);
  if (!plan.incident || peak <= 70) return 50;
  const movableShare = movableHere(plan).reduce((n, c) => n + loadShareOf(c, sample), 0);
  if (movableShare <= 0) return 100;
  return Math.min(100, Math.max(10, Math.ceil((((peak - 70) / peak) / movableShare) * 20) * 5));
}

/** The dial: how much of the load the movable sessions carry to move off, and what that frees. */
function LoadDial({ value, count, freed, onChange }: { value: number; count: number; freed: { cpu?: number; rss: number }; onChange: (n: number) => void }) {
  const fill = { background: `linear-gradient(to right, var(--sol-cyan) ${value}%, color-mix(in srgb, var(--sol-border) 25%, transparent) ${value}%)` };
  return (
    <div className="space-y-2 rounded-xl bg-sol-bg-alt px-3.5 py-3" data-dial>
      <div className="flex items-baseline gap-2 text-[11px]">
        <span className="text-sol-text-dim">Move off</span>
        <span className="text-[20px] font-semibold tabular-nums leading-none text-sol-text">{value}%</span>
        <span className="text-sol-text-dim">of session load</span>
        <span className="ml-auto tabular-nums text-sol-text-muted">
          {count === 0 ? "nothing" : [plural(count, "session"), freed.cpu !== undefined ? fmtCpu(freed.cpu) : undefined, fmtBytes(freed.rss)].filter(Boolean).join(" · ")}
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={value}
        aria-label="Share of session load to move off"
        aria-valuetext={`${value}%, ${plural(count, "session")}`}
        onChange={(e) => onChange(Number(e.target.value))}
        style={fill}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-sol-bg [&::-moz-range-thumb]:bg-sol-cyan [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-sol-bg [&::-webkit-slider-thumb]:bg-sol-cyan"
      />
      <div className="flex justify-between text-[10px] tabular-nums text-sol-text-dim">
        {[0, 25, 50, 75, 100].map((n) => (
          <button key={n} type="button" onClick={() => onChange(n)} className={cn("hover:text-sol-text", n === value && "text-sol-text")}>{n}%</button>
        ))}
      </div>
    </div>
  );
}

/**
 * What the source machine's dry run found for one move, on the session's row:
 * each repository or folder the host lacks as a toggle that brings it along,
 * then what stays behind or differs. A pressed path crosses with the move.
 */
function RehearsalLine({ rehearsal, bring, onBring, disabled }: { rehearsal?: OffloadRehearsal; bring: string[]; onBring: (path: string, on: boolean) => void; disabled?: boolean }) {
  if (!rehearsal) return null;
  if (rehearsal.status === "pending") return <div className="pb-2 pl-10 pr-3.5 text-[10px] text-sol-text-dim" data-rehearsal="pending">checking the move on this machine</div>;
  if (rehearsal.status === "failed") return <div className="truncate pb-2 pl-10 pr-3.5 text-[10px] text-sol-text-dim" title={rehearsal.error} data-rehearsal="failed">not checked: {rehearsal.error}</div>;
  const r = rehearsal.result;
  const running = r.services.filter((sv) => sv.running);
  const lacks = r.tools.missing.filter((t) => !r.tools.installs.includes(t));
  if (!r.missing.length && !running.length && !lacks.length && !r.tools.installs.length && !r.machine.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1 pb-2 pl-10 pr-3.5 text-[10px]" data-rehearsal="done">
      {r.missing.map((m) => {
        const on = bring.includes(m.path);
        return (
          <button
            key={m.path}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            title={`${m.path}: ${m.kind === "repo" ? "repository" : "folder"} the host lacks; ${m.writes ? `${m.writes} files written` : `used ${m.uses} times`}`}
            onClick={() => onBring(m.path, !on)}
            className={cn(
              "inline-flex max-w-[14rem] items-center gap-1 rounded-full border px-2 py-0.5 tabular-nums transition-colors disabled:cursor-not-allowed disabled:opacity-40",
              on ? "border-sol-cyan/60 bg-sol-cyan/10 text-sol-text" : "border-sol-orange/50 text-sol-orange",
            )}
          >
            {on ? <Check className="h-3 w-3 shrink-0 text-sol-cyan" /> : null}
            <span className={cn("truncate", !on && "line-through decoration-sol-orange/60")}>{homeShort(m.path)}</span>
            {m.bytes !== undefined && <span className="shrink-0 text-sol-text-dim">{fmtBytes(m.bytes)}</span>}
          </button>
        );
      })}
      {running.map((sv) => <span key={sv.label} className="rounded-full border border-sol-orange/40 px-2 py-0.5 text-sol-orange" title="A launchd service from this session's work: it keeps running on this machine">{sv.label} stays here</span>)}
      {r.tools.installs.length > 0 && <span className="px-1 text-sol-text-dim" title="The host lacks these and installs them on the move">installs {r.tools.installs.join(", ")}</span>}
      {lacks.length > 0 && <span className="px-1 text-sol-orange" title="Commands this session ran that the host lacks and cannot install">lacks {lacks.join(", ")}</span>}
      {r.machine.map((m) => <span key={m} className="px-1 text-sol-orange">{m.replace(" here, ", " → ").replace(" on the host", "")}</span>)}
    </div>
  );
}

function CandidateRow({ c, title, checked, elsewhere, onCheck, rehearsal, bring, onBring, disabled }: {
  c: OffloadCandidate; title: string; checked: boolean; elsewhere?: OffloadDestination; onCheck: (checked: boolean) => void;
  rehearsal?: OffloadRehearsal; bring: string[]; onBring: (path: string, on: boolean) => void; disabled?: boolean;
}) {
  const outside = c.stops.filter((p) => p.detached);
  return (
    <div className={cn(!checked && "opacity-55")}>
    <label className="flex cursor-pointer items-center gap-3 px-3.5 py-2.5 transition-colors hover:bg-sol-bg-highlight/40" data-candidate={c.sessionId}>
      <input
        type="checkbox"
        aria-label={`Move ${title}`}
        className="h-4 w-4 shrink-0 accent-[var(--sol-cyan,#2aa198)]"
        checked={checked}
        onChange={(e) => onCheck(e.target.checked)}
      />
      <span className="min-w-[6rem] flex-1">
        <span className="block truncate text-[13px] text-sol-text">{title}</span>
        {outside.length > 0 && (
          <span className="block truncate text-[10px] text-sol-orange" title={`Also stops what it left running outside its process tree: ${namedStops(outside, 20)}`}>
            also stops {outside.length} outside its tree
          </span>
        )}
      </span>
      {c.disruption === "mid_turn" && <span className="shrink-0 text-[10px] text-sol-yellow">working</span>}
      {elsewhere && <span className="inline-flex min-w-0 max-w-[7rem] shrink items-center gap-1 text-[10px] text-sol-text-muted" title={elsewhere.name}>{destIcon(elsewhere)}<span className="truncate">{elsewhere.name}</span></span>}
      <span className="shrink-0 text-[11px] tabular-nums text-sol-text-dim">
        {[c.relief.cpu !== undefined ? fmtCpu(c.relief.cpu) : undefined, c.relief.rssHigh !== undefined ? fmtBytes(c.relief.rssHigh) : undefined].filter(Boolean).join(" · ")}
      </span>
    </label>
    <RehearsalLine rehearsal={rehearsal} bring={bring} onBring={onBring} disabled={disabled || !checked} />
    </div>
  );
}

/** A session doing real work that cannot move: what it costs here, why it stays, and background priority to make it give way. */
function StayingRow({ s, title, disabled, onBackground }: { s: StayingSession; title: string; disabled?: string; onBackground?: (on: boolean) => void }) {
  const applied = s.background && s.lowered > 0;
  return (
    <div className="flex items-center gap-3 px-3.5 py-2.5" data-staying={s.sessionId}>
      <span className="min-w-[6rem] flex-1">
        <span className="block truncate text-[13px] text-sol-text">{title}</span>
        <span className="block truncate text-[10px] text-sol-text-dim" title={s.reason}>{s.reason}</span>
      </span>
      <span className="shrink-0 text-[11px] tabular-nums text-sol-text-dim">{fmtCpu(s.cpu)} · {fmtBytes(s.rss)}</span>
      <button
        type="button"
        aria-pressed={s.background}
        disabled={!onBackground}
        title={disabled ?? (s.background ? (applied ? `${s.lowered} of ${s.processCount} processes at background priority` : "Waiting for the machine to apply it") : "Run at background priority: it gives way to everything else")}
        onClick={() => onBackground?.(!s.background)}
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] transition-colors disabled:cursor-not-allowed disabled:opacity-40",
          s.background ? "border-sol-cyan/60 bg-sol-cyan/10 text-sol-text" : "border-sol-border/40 text-sol-text-muted hover:text-sol-text",
        )}
      >
        {applied && <Check className="h-3 w-3 text-sol-cyan" />}Background
      </button>
    </div>
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
      {c.stops.length > 0 && <div>Stops here: {namedStops(c.stops, 8)}</div>}
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
  /** Move was pressed and the launch started; the panel follows it from here. */
  onStarted: (clientBatchId: string) => void;
};

export function OffloadReview({ plan: livePlan, sessions, sourceName, now, initialSelected, actions, actionsDisabledReason, onClose, onStarted }: OffloadReviewProps) {
  const [held] = React.useState(livePlan);
  const plan = React.useMemo(() => holdPlan(held, livePlan), [held, livePlan]);
  const byId = React.useMemo(() => new Map(sessions.map((s) => [s.sessionId, s])), [sessions]);
  const preselect = initialSelected?.length ? new Set(initialSelected) : undefined;
  // The dial picks the sessions; ticking a box by hand takes over until the dial moves again (null).
  // Undefined is the starting position, worked out once the movable sessions are known.
  const [dial, setDial] = React.useState<number | null | undefined>(preselect ? null : undefined);
  // Choices survive new samples: the plan is rebuilt every sample, the user's review is not.
  const [edited, setChoices] = React.useState<Record<string, Choice>>({});
  const [chosenMode, setMode] = React.useState<string>(AUTO);
  const [wait, setWait] = React.useState(SAFE_WAITS[1]?.value ?? SAFE_WAITS[0].value);

  // A host no session can move to (offline for good, blocked for all) is not a choice.
  const reachable = plan.destinations.filter((d) => plan.candidates.some((c) => movable(c.perDestination[d.deviceId])));
  const mode = chosenMode === AUTO || reachable.some((d) => d.deviceId === chosenMode) ? chosenMode : AUTO;
  const pinned = (c: OffloadCandidate) => { const id = edited[c.sessionId]?.destinationId; return id && movable(c.perDestination[id]) ? id : undefined; };
  const canMove = movableHere(plan);
  // The slice is redone when the dial moves or the set of movable sessions changes, never on a mere new sample.
  const movableKey = canMove.map((c) => c.sessionId).join(",");
  const slice = React.useMemo(() => {
    if (dial === null) return null;
    const pct = dial ?? startingPercent(plan);
    return { pct, ids: new Set(sliceForPercent(canMove, plan.sourceSample, pct).ids) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dial, movableKey]);
  const blocked = plan.candidates.filter((c) => !canMove.includes(c));
  const isChecked = (c: OffloadCandidate) => slice ? slice.ids.has(c.sessionId) : edited[c.sessionId]?.checked ?? (preselect ? preselect.has(c.sessionId) : false);
  /** Hand edits start from what is ticked now, so taking over from the dial keeps its picks. */
  const handEdit = (change: (s: Record<string, Choice>) => Record<string, Choice>) => {
    setChoices((s) => change(Object.fromEntries(plan.candidates.map((c) => [c.sessionId, { ...s[c.sessionId], checked: isChecked(c) }]))));
    setDial(null);
  };
  const picked = canMove.filter(isChecked);
  const auto = assignDestinations(plan, picked.filter((c) => !pinned(c)), mode);
  const destOf = (c: OffloadCandidate) => pinned(c) ?? auto.get(c.sessionId) ?? c.suggestedDestinationId ?? plan.destinations.find((d) => movable(c.perDestination[d.deviceId]))?.deviceId ?? "";
  const going = picked.filter((c) => movable(c.perDestination[destOf(c)]));
  const rehearsalOf = (c: OffloadCandidate) => c.perDestination[destOf(c)]?.rehearsal;
  const resultOf = (c: OffloadCandidate) => { const r = rehearsalOf(c); return r?.status === "done" ? r.result : undefined; };
  const bringOf = (c: OffloadCandidate) => bringFor(resultOf(c), edited[c.sessionId]?.bring);
  // Pressing Move confirms the items no check can prove, and what the rehearsal shows on each row: the paths left behind, services staying here, missing commands.
  const selections: OffloadSelection[] = going.map((c) => {
    const result = resultOf(c);
    const bring = bringOf(c);
    return { sessionId: c.sessionId, destinationId: destOf(c), attested: [...new Set([...c.perDestination[destOf(c)].pending, ...(result ? rehearsalPending(result, bring) : [])])], ...(bring.length ? { bring } : {}) };
  });

  // The server's dry run runs once on open, so its blockers show before anyone presses Move.
  const preflight = actions?.onPreflight;
  const firstCheck = React.useRef(true);
  React.useEffect(() => {
    if (!firstCheck.current || !preflight || canMove.length === 0) return;
    firstCheck.current = false;
    preflight(canMove.map((c) => ({ sessionId: c.sessionId, destinationId: destOf(c), attested: [] })));
  });

  // Each ticked session's move is rehearsed once per destination per review, when it is first ticked there; one that failed is asked again by the next review.
  const rehearse = actions?.onRehearse;
  const asked = React.useRef(new Set<string>());
  const toRehearse = going.filter((c) => { const r = rehearsalOf(c); return (!r || r.status === "failed") && !asked.current.has(`${c.sessionId}:${destOf(c)}`); });
  const rehearseKey = toRehearse.map((c) => `${c.sessionId}:${destOf(c)}`).join(",");
  React.useEffect(() => {
    if (!rehearse || !rehearseKey) return;
    const t = setTimeout(() => {
      for (const c of toRehearse) asked.current.add(`${c.sessionId}:${destOf(c)}`);
      rehearse(toRehearse.map((c) => ({ sessionId: c.sessionId, destinationId: destOf(c), attested: [] })));
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rehearseKey]);

  const sumOf = (cs: OffloadCandidate[]) => ({
    cpu: cs.some((c) => c.relief.cpu === undefined) ? undefined : cs.reduce((a, c) => a + (c.relief.cpu ?? 0), 0),
    rss: cs.reduce((a, c) => a + (c.relief.rssHigh ?? 0), 0),
  });
  const leaving = sumOf(going);
  const poolShare = canMove.reduce((n, c) => n + loadShareOf(c, plan.sourceSample), 0);
  const achieved = poolShare > 0 ? round5(going.reduce((n, c) => n + loadShareOf(c, plan.sourceSample), 0) / poolShare * 100) : 0;
  const source = loadShift(plan.sourceSample, leaving, -1);
  const receiving = plan.destinations
    .map((d) => ({ d, cs: going.filter((c) => destOf(c) === d.deviceId) }))
    .filter(({ d, cs }) => cs.length > 0 || (mode === d.deviceId));
  const hostsUsed = receiving.filter((r) => r.cs.length > 0).length;
  const unevaluated = (initialSelected ?? []).filter((id) => !plan.candidates.some((c) => c.sessionId === id) && !plan.notOffered.some((n) => n.sessionId === id));
  const midTurn = going.some((c) => c.disruption === "mid_turn");
  const allChecked = canMove.length > 0 && picked.length === canMove.length;
  const setAll = (checked: boolean) => handEdit((s) => Object.fromEntries(plan.candidates.map((c) => [c.sessionId, { ...s[c.sessionId], checked }])));
  const titleOf = (id: string) => byId.get(id)?.title ?? id;
  // Grouped by reason, largest first: a count per reason reads at a glance where a line per session does not.
  // Busy ones are listed above with their load and controls; the rest group by reason.
  const busy = new Set(plan.staying.map((st) => st.sessionId));
  const stayGroups = groupBy([
    ...blocked.map((c) => ({ id: c.sessionId, reason: Object.values(c.perDestination).flatMap((r) => r.blockers)[0] ?? "Blocked" })),
    ...plan.notOffered.map((n) => ({ id: n.sessionId, reason: n.reason })),
    ...unevaluated.map((id) => ({ id, reason: "Not checked yet" })),
  ].filter((r) => !busy.has(r.id)));
  const stayCount = stayGroups.reduce((n, [, ids]) => n + ids.length, 0);

  const stopping = going.flatMap((c) => c.stops);
  const stoppingOutside = stopping.filter((p) => p.detached).length;
  const off = actionsDisabledReason;
  const moveBlocked = !actions?.onStartOffload ? (off ?? "Moving is not available here") : going.length === 0 ? "Select at least one session" : undefined;

  return (
    <section aria-label="Review offload" className="flex h-full min-h-0 flex-col bg-sol-bg">
      <header className="flex items-start gap-3 px-5 pb-3 pt-5">
        <div className="min-w-0 flex-1">
          <h2 className="text-[17px] font-semibold tracking-tight text-sol-text">Free up {sourceName}</h2>
          {plan.incident ? (
            <p className="mt-1 flex items-center gap-1.5 truncate text-[12px] text-sol-text-muted" title={plan.incident.reason}>
              <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", plan.incident.level === "critical" ? "bg-sol-red" : "bg-sol-yellow")} />
              {plan.incident.reason} for {fmtAgo(plan.incident.since, now).replace(/ ago$/, "")}
            </p>
          ) : (
            <p className="mt-1 flex items-center gap-1.5 text-[12px] text-sol-text-muted">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-sol-green" />No sustained pressure
            </p>
          )}
        </div>
        <button type="button" onClick={onClose} aria-label="Close review" className="-mr-1 rounded-full p-1.5 text-sol-text-dim hover:bg-sol-bg-highlight hover:text-sol-text"><X className="h-4 w-4" /></button>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 pb-4">
        <div className="space-y-1.5 rounded-xl bg-sol-bg-alt px-3.5 py-3" data-load="source">
          <div className="flex items-center gap-2 text-[11px] text-sol-text-dim">
            <Laptop className="h-3.5 w-3.5" /><span className="truncate">{sourceName}</span>
            {going.length > 0 && (
              <span className="ml-auto tabular-nums" title={namedStops(stopping, 20)}>
                {stopping.length} {stopping.length === 1 ? "process stops" : "processes stop"}{stoppingOutside ? <span className="text-sol-orange"> ({stoppingOutside} outside agents)</span> : null}
              </span>
            )}
          </div>
          <LoadBar label="CPU" before={source.before.cpu} after={going.length ? source.after.cpu : undefined} />
          <LoadBar label="Memory" before={source.before.memory} after={going.length ? source.after.memory : undefined} />
        </div>

        {plan.destinations.length > 0 && canMove.length > 0 && (
          <LoadDial value={slice?.pct ?? achieved} count={going.length} freed={leaving} onChange={setDial} />
        )}

        {plan.destinations.length === 0 ? (
          <div className="rounded-xl bg-sol-bg-alt px-4 py-3 text-[12px] text-sol-text-secondary">
            No cloud host is set up yet. Add one in Settings → Devices.
          </div>
        ) : (
          <>
            <div>
              <div className="mb-1.5 flex items-center px-1 text-[11px] text-sol-text-dim">
                <span>Move to</span>
                {reachable.length > 1 && (
                  <label className="relative ml-auto inline-flex items-center gap-1 text-sol-text-secondary hover:text-sol-text">
                    {mode === AUTO ? `Spread automatically${hostsUsed > 1 ? ` · ${hostsUsed} hosts` : ""}` : plan.destinations.find((d) => d.deviceId === mode)?.name}
                    <ChevronDown className="h-3 w-3" />
                    <select aria-label="Destination" value={mode} onChange={(e) => setMode(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0">
                      <option value={AUTO}>Spread automatically</option>
                      {reachable.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.name}{d.asleep ? " (asleep)" : ""}</option>)}
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

            {plan.staying.length > 0 && (
              <div>
                <div className="mb-1.5 flex items-baseline px-1 text-[11px] text-sol-text-dim">
                  <span>{plural(plan.staying.length, "busy session")} staying here</span>
                  <span className="ml-auto tabular-nums">{fmtCpu(plan.staying.reduce((n, s) => n + s.cpu, 0))}</span>
                </div>
                <div className="divide-y divide-sol-border/15 overflow-hidden rounded-xl bg-sol-bg-alt">
                  {plan.staying.map((st) => (
                    <StayingRow
                      key={st.sessionId}
                      s={st}
                      title={titleOf(st.sessionId)}
                      disabled={actionsDisabledReason}
                      onBackground={actions?.onSetBackground && !actionsDisabledReason ? (on) => actions.onSetBackground!(plan.deviceId, st.sessionId, on) : undefined}
                    />
                  ))}
                </div>
              </div>
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
                        onCheck={(v) => handEdit((s) => ({ ...s, [c.sessionId]: { ...s[c.sessionId], checked: v } }))}
                        rehearsal={rehearsalOf(c)}
                        bring={bringOf(c)}
                        disabled={!!actionsDisabledReason}
                        onBring={(path, on) => setChoices((s) => ({ ...s, [c.sessionId]: { ...s[c.sessionId], checked: s[c.sessionId]?.checked ?? isChecked(c), bring: { ...s[c.sessionId]?.bring, [path]: on } } }))}
                      />
                    );
                  })}
                </div>
              </div>
            )}

            <div className="space-y-2 px-1">
              {stayCount > 0 && (
                <Disclosure label={`${stayCount}${busy.size ? " more" : ""} stay${stayCount === 1 && !busy.size ? "s" : ""} here`}>
                  {stayGroups.map(([reason, ids]) => <StayGroup key={reason} reason={reason} titles={ids.map(titleOf)} />)}
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
                      onDestination={(destinationId) => handEdit((s) => ({ ...s, [c.sessionId]: { checked: true, destinationId } }))}
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
          <Button
            type="button"
            variant="cyan"
            size="lg"
            disabled={!!moveBlocked}
            title={moveBlocked}
            onClick={() => { const id = actions?.onStartOffload?.(selections, { waitForTurnMs: wait }); if (id) onStarted(id); }}
            className="w-full rounded-lg disabled:pointer-events-auto disabled:cursor-not-allowed"
          >
            Move {going.length > 0 ? plural(going.length, "session") : "sessions"}
          </Button>
          {moveBlocked && off && <div className="text-center text-[10px] text-sol-text-dim">{off}</div>}
        </footer>
      )}
    </section>
  );
}

type RunProps = { byId: Map<string, ResourceSession>; destinations: Map<string, string>; actions?: ResourceActions; actionsDisabledReason?: string };

const runActive = (run: OffloadRun) => run.rows.some((r) => isRowActive(r.status) || r.status === "queued");

/** One line per session in a run: where it goes, where it is, and Retry when it failed. */
function RunRows({ run, byId, destinations, actions, actionsDisabledReason, stacked }: RunProps & { run: OffloadRun; stacked?: boolean }) {
  return (
    <>
      {run.rows.map((r) => (
        <div key={r.sessionId} className={cn("grid items-start gap-x-3 text-[11px]", stacked ? "grid-cols-[minmax(0,1fr)_auto_auto]" : "grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,1fr)_9rem_auto_4.5rem]")} data-run-row={r.sessionId}>
          {stacked ? (
            <span className="min-w-0">
              <span className="block truncate text-[13px] text-sol-text">{byId.get(r.sessionId)?.title ?? r.sessionId}</span>
              <span className="block truncate text-[10px] text-sol-text-dim">→ {destinations.get(r.destinationId) ?? r.destinationId}</span>
            </span>
          ) : (
            <>
              <span className="truncate text-sol-text-secondary">{byId.get(r.sessionId)?.title ?? r.sessionId}</span>
              <span className="hidden truncate text-sol-text-muted sm:block">→ {destinations.get(r.destinationId) ?? r.destinationId}</span>
            </>
          )}
          <MigrationStatusPill status={r.status} />
          <span className={cn("text-right", stacked ? "min-w-[3.5rem]" : "hidden sm:block")}>
            {r.status === "failed" && (actions?.onRetry
              ? <button type="button" className="inline-flex items-center gap-1 text-sol-cyan hover:underline" onClick={() => actions.onRetry!(run.batchId, r.sessionId)}><RotateCcw className="h-3 w-3" />Retry</button>
              : <span className="text-sol-text-dim" title={actionsDisabledReason}>Retry</span>)}
          </span>
          {r.error && <span className="col-span-full flex gap-1 pl-2 text-[10px] text-sol-red/90"><AlertTriangle className="mt-px h-3 w-3 shrink-0" />{r.error}</span>}
        </div>
      ))}
    </>
  );
}

/** What the source machine measured before and after, once every session has finished moving. */
function RunRelief({ run }: { run: OffloadRun }) {
  const b = run.measured?.before; const a = run.measured?.after;
  if (!b) return null;
  return (
    <div className="text-[10px] text-sol-text-muted">
      {a && run.finishedAt !== undefined && a.at > run.finishedAt && run.rows.every((r) => isRowTerminal(r.status))
        ? <>Measured on this machine: memory in use {fmtBytes(memoryUsed(b))} → {fmtBytes(memoryUsed(a))} ({memoryUsed(b) - memoryUsed(a) >= 0 ? "−" : "+"}{fmtBytes(Math.abs(memoryUsed(b) - memoryUsed(a)))}), CPU {b.cpuPercent?.toFixed(0) ?? "n/a"}% → {a.cpuPercent?.toFixed(0) ?? "n/a"}%. Other work on the machine moves these numbers too.</>
        : <>Relief is measured from the first sample after every session has finished moving.</>}
    </div>
  );
}

const STAGE_TONE = { done: "bg-sol-green", failed: "bg-sol-red", moving: "bg-sol-cyan/45", queued: "bg-sol-text-dim/40", cancelled: "bg-sol-text-dim/20" } as const;

/** The panel after Move: one launch (a run per destination) followed to the end, from the store's batches. */
export function OffloadProgress({ runs, sourceName, onClose, ...rowProps }: RunProps & { runs: OffloadRun[]; sourceName: string; onClose: () => void }) {
  const rows = runs.flatMap((r) => r.rows);
  const count = (f: (s: OffloadRun["rows"][number]["status"]) => boolean) => rows.filter((r) => f(r.status)).length;
  const stages = {
    done: count((s) => s === "done"),
    moving: count(isRowActive),
    queued: count((s) => s === "queued"),
    failed: count((s) => s === "failed"),
    cancelled: count((s) => s === "cancelled"),
  };
  const active = runs.some(runActive);
  const cancellable = runs.filter((r) => runActive(r) && !r.cancelUnavailable);
  const { actions } = rowProps;
  return (
    <section aria-label="Offload progress" className="flex h-full min-h-0 flex-col bg-sol-bg">
      <header className="flex items-start gap-3 px-5 pb-3 pt-5">
        <div className="min-w-0 flex-1">
          <h2 className="text-[17px] font-semibold tracking-tight text-sol-text">{active || !rows.length ? "Moving" : "Moved"} off {sourceName}</h2>
          <p className="mt-1 flex items-center gap-1.5 text-[12px] text-sol-text-muted">
            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", active || !rows.length ? "animate-pulse bg-sol-cyan" : stages.failed ? "bg-sol-red" : "bg-sol-green")} />
            {!rows.length ? "Starting" : active ? "In progress, never interrupts a turn" : stages.failed ? `${stages.failed} failed` : "Finished"}
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="-mr-1 rounded-full p-1.5 text-sol-text-dim hover:bg-sol-bg-highlight hover:text-sol-text"><X className="h-4 w-4" /></button>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 pb-4">
        <div className="space-y-2 rounded-xl bg-sol-bg-alt px-3.5 py-3" data-progress>
          <div className="flex items-baseline gap-2 text-[11px]">
            <span className="text-[20px] font-semibold tabular-nums leading-none text-sol-text">{stages.done}<span className="text-sol-text-dim">/{rows.length}</span></span>
            <span className="text-sol-text-dim">moved</span>
            <span className="ml-auto flex gap-3 tabular-nums text-sol-text-muted">
              {stages.moving > 0 && <span>{stages.moving} moving</span>}
              {stages.queued > 0 && <span>{stages.queued} queued</span>}
              {stages.failed > 0 && <span className="text-sol-red">{stages.failed} failed</span>}
              {stages.cancelled > 0 && <span>{stages.cancelled} cancelled</span>}
            </span>
          </div>
          <div className="flex h-1.5 overflow-hidden rounded-full bg-sol-border/25">
            {(Object.keys(STAGE_TONE) as Array<keyof typeof STAGE_TONE>).map((k) => stages[k] > 0 && (
              <span key={k} className={cn("h-full transition-[width] duration-300", STAGE_TONE[k])} style={{ width: `${stages[k] / rows.length * 100}%` }} />
            ))}
          </div>
        </div>

        {runs.map((run) => (
          <div key={run.batchId} className="space-y-2.5 rounded-xl bg-sol-bg-alt px-3.5 py-3" data-run={run.batchId}>
            <RunRows run={run} stacked {...rowProps} />
            <RunRelief run={run} />
          </div>
        ))}
      </div>

      <footer className="flex gap-2 border-t border-sol-border/20 px-5 pb-5 pt-3.5">
        {active && (
          <Button
            type="button"
            variant="outline"
            size="lg"
            disabled={!actions?.onCancel || !cancellable.length}
            title={!actions?.onCancel ? rowProps.actionsDisabledReason : runs.find((r) => r.cancelUnavailable)?.cancelUnavailable}
            onClick={() => cancellable.forEach((r) => actions!.onCancel!(r.batchId))}
            className="flex-1 rounded-lg disabled:pointer-events-auto disabled:cursor-not-allowed"
          >
            Cancel remaining
          </Button>
        )}
        <Button type="button" variant={active ? "secondary" : "cyan"} size="lg" onClick={onClose} className="flex-1 rounded-lg">
          {active ? "Hide" : "Done"}
        </Button>
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
        const active = runActive(run);
        const done = run.rows.filter((r) => r.status === "done").length;
        const failed = run.rows.filter((r) => r.status === "failed").length;
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
              <RunRows run={run} byId={byId} destinations={destinations} actions={actions} actionsDisabledReason={actionsDisabledReason} />
            </div>
            <div className="mt-1.5"><RunRelief run={run} /></div>
          </div>
        );
      })}
    </div>
  );
}
