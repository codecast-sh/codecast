"use client";
// The small pieces every initiative surface draws the same way
// (docs/architecture/initiatives-projects-role-page.md I1): its status, its
// health with the date it was said, its progress, its owner and its target.
// Health owns green, yellow and red, so the initiative's own accent is magenta
// and no chip that is not health ever wears a health colour.
import Link from "next/link";
import { ArrowDownRight, ArrowUpRight, CheckCircle2, Circle, CircleDashed, CircleDot, Flag, Minus, XCircle, type LucideIcon } from "lucide-react";
import { INITIATIVE_HEALTH_LABEL, INITIATIVE_STATUS_LABEL, formatMetricNumber, intentSourceLabel, metricNumber, type InitiativeHealth, type InitiativeMilestone, type InitiativeOwner, type InitiativeStatus, type IntentSource, type MetricReading, type MetricStanding, type MetricTrend } from "@codecast/shared/contracts/initiative";
import { intentSourceHref } from "../../lib/intentSources";
import { SparkLine } from "../Spark";
import { useTrackedStore } from "../../store/inboxStore";
import { useOrgRoles } from "../../hooks/useOrgRoles";
import { useTeamRosterIdentity } from "../../hooks/useTeamRoster";
import { resolveAssigneeInfo } from "../../lib/liveEntities";
import { ownerId, progressPercent, type Progress } from "../../lib/initiatives";
import { cn } from "../../lib/utils";
import { AssigneeFace } from "../identity/AssigneeFace";
import { INITIATIVE_ACCENT, HEALTH_COLOR } from "../../lib/initiativeColors";

const STATUS_VISUAL: Record<InitiativeStatus, { icon: LucideIcon; color: string }> = {
  proposed: { icon: CircleDashed, color: "var(--sol-text-dim)" },
  planned: { icon: Circle, color: "var(--sol-text-muted)" },
  active: { icon: CircleDot, color: INITIATIVE_ACCENT },
  completed: { icon: CheckCircle2, color: "var(--sol-text-muted)" },
  cancelled: { icon: XCircle, color: "var(--sol-text-dim)" },
};

export function StatusGlyph({ status, className }: { status: InitiativeStatus; className?: string }) {
  const v = STATUS_VISUAL[status];
  const Icon = v.icon;
  return <Icon className={cn("w-3.5 h-3.5 shrink-0", className)} style={{ color: v.color }} aria-label={INITIATIVE_STATUS_LABEL[status]} />;
}

export const shortDate = (ts: number, now: number) =>
  new Date(ts).toLocaleDateString("en-US", new Date(ts).getFullYear() === new Date(now).getFullYear() ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });

/** Health is whatever the owner said last, with the date it was said. */
export function HealthChip({ health, at, now, bare, className }: { health: InitiativeHealth; at?: number; now: number; /** The dot alone, its word as the title (a far card on the org chart). */ bare?: boolean; className?: string }) {
  const color = HEALTH_COLOR[health];
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[11.5px] whitespace-nowrap", className)} style={{ color: health === "none" ? color : "var(--sol-text-secondary)" }} title={bare ? INITIATIVE_HEALTH_LABEL[health] : undefined} data-initiative-health={health}>
      <span className="w-[7px] h-[7px] rounded-full shrink-0" style={health === "none" ? { border: `1px solid ${color}` } : { background: color }} aria-hidden />
      {!bare && INITIATIVE_HEALTH_LABEL[health]}
      {!bare && health !== "none" && at ? <span style={{ color: "var(--sol-text-dim)" }}>{shortDate(at, now)}</span> : null}
    </span>
  );
}

/** Tasks done over tasks, as one thin bar: done solid, in progress behind it.
 *  `partial` says the task store is still filling (useTasksBackfilled): the
 *  bar dims and "counting" stands where the number would, so a low count on a
 *  cold cache never reads as the truth. */
export function ProgressBar({ progress, partial, className }: { progress: Progress; partial?: boolean; className?: string }) {
  const pct = progressPercent(progress);
  const moving = progress.total === 0 ? 0 : Math.round(((progress.done + progress.in_progress) / progress.total) * 100);
  const title = partial ? "Counting: the task cache is still filling" : progress.total === 0 ? "No tasks yet" : `${progress.done} of ${progress.total} tasks done, ${progress.in_progress} in progress`;
  return (
    <span className={cn("inline-flex items-center gap-2 min-w-0", className)} data-initiative-progress={partial ? "counting" : `${progress.done}/${progress.total}`} title={title}>
      <span className={cn("relative flex-1 min-w-[48px] h-[4px] rounded-full overflow-hidden", partial && "opacity-40")} style={{ background: "color-mix(in srgb, var(--sol-border) 35%, transparent)" }} aria-hidden>
        <span className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-300" style={{ width: `${moving}%`, background: `color-mix(in srgb, ${INITIATIVE_ACCENT} 30%, transparent)` }} />
        <span className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-300" style={{ width: `${pct}%`, background: INITIATIVE_ACCENT }} />
      </span>
      <span className={cn("shrink-0 text-[11px] tabular-nums", partial && "italic")} style={{ color: "var(--sol-text-dim)" }}>{partial ? "counting" : progress.total === 0 ? "no tasks" : `${progress.done}/${progress.total}`}</span>
    </span>
  );
}

/** The owner's face and name, resolved at render from the roster and the org
 *  roles, so a rename or a new face shows at once. A role's face carries the
 *  role hover card. Nobody driving it is said in words. */
export function OwnerChip({ owner, size = 16, nameless, className }: { owner: InitiativeOwner | undefined; size?: number; nameless?: boolean; className?: string }) {
  const { roles } = useOrgRoles();
  const roster = useTeamRosterIdentity();
  const s = useTrackedStore([(st) => st.currentUser?._id]);
  const info = resolveAssigneeInfo(ownerId(owner), undefined, roster as any, s.currentUser as any, roles as any);
  if (!info) return <span className={cn("text-[11.5px] italic", className)} style={{ color: "var(--sol-text-dim)" }} data-initiative-owner="none">No owner</span>;
  return (
    <span className={cn("inline-flex items-center gap-1.5 min-w-0 text-[11.5px]", className)} style={{ color: "var(--sol-text-secondary)" }} data-initiative-owner={owner?.kind}>
      <AssigneeFace info={info} size={size} />
      {!nameless && <span className="truncate">{info.name}</span>}
    </span>
  );
}

export function TargetDate({ ts, now, done, className }: { ts?: number; now: number; done?: boolean; className?: string }) {
  if (!ts) return null;
  const late = !done && ts < now;
  return (
    <span className={cn("text-[11.5px] tabular-nums whitespace-nowrap", className)} style={{ color: late ? "var(--sol-red)" : "var(--sol-text-dim)" }} title={late ? "Past its target" : "Target"} data-initiative-target={late ? "late" : "ahead"}>
      {shortDate(ts, now)}
    </span>
  );
}

/** A metric read against its target (I4): one word in a health colour, met or
 *  behind, and a hollow dot while nobody has reported a value. Beside the
 *  owner's word so the two can disagree visibly. */
export function MetricStandingDot({ standing, className }: { standing: MetricStanding; className?: string }) {
  const color = standing === "met" ? HEALTH_COLOR.on_track : standing === "behind" ? HEALTH_COLOR.at_risk : "var(--sol-text-dim)";
  return <span className={cn("inline-block w-[7px] h-[7px] rounded-full shrink-0", className)} style={standing === "unknown" ? { border: `1px solid ${color}` } : { background: color }} aria-label={standing} data-metric-standing={standing} />;
}

/** "412 of 1,000, behind" with a bar toward a reach target. */
export function MetricReadingLine({ reading, now, className }: { reading: MetricReading; now: number; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 min-w-0 text-[12px]", className)} data-metric={reading.key}>
      <MetricStandingDot standing={reading.standing} />
      <span className="truncate" style={{ color: "var(--sol-text)" }}>{reading.name}</span>
      <span className="tabular-nums whitespace-nowrap" style={{ color: reading.value === null ? "var(--sol-text-dim)" : "var(--sol-text-secondary)" }}>
        {reading.value === null ? `target ${reading.target}` : `${reading.value} of ${reading.target}`}
      </span>
      {reading.progress !== null && (
        <span className="h-[4px] w-[56px] rounded-full overflow-hidden shrink-0" style={{ background: "color-mix(in srgb, var(--sol-border) 40%, transparent)" }} aria-hidden>
          <span className="block h-full rounded-full" style={{ width: `${Math.round(reading.progress * 100)}%`, background: reading.standing === "met" ? HEALTH_COLOR.on_track : INITIATIVE_ACCENT }} />
        </span>
      )}
      {reading.observed_at ? <span className="whitespace-nowrap text-[11px]" style={{ color: "var(--sol-text-dim)" }}>{shortDate(reading.observed_at, now)}</span> : null}
    </span>
  );
}

/** Which way the number moved, as one glyph: up, down, flat, or nothing before two reports. Green when toward the target, yellow when away. */
export function TrendGlyph({ trend, className }: { trend: MetricTrend; className?: string }) {
  if (trend.direction === "unknown") return null;
  const Icon = trend.direction === "up" ? ArrowUpRight : trend.direction === "down" ? ArrowDownRight : Minus;
  const color = trend.toward === null ? "var(--sol-text-dim)" : trend.toward ? HEALTH_COLOR.on_track : HEALTH_COLOR.at_risk;
  const title = trend.direction === "flat" ? "Flat since the first report" : `${trend.direction === "up" ? "Up" : "Down"}${trend.delta !== null ? ` ${formatMetricNumber(Math.abs(trend.delta))} since the last report` : ""}, ${trend.toward ? "toward" : "away from"} the target`;
  return <Icon className={cn("w-3 h-3 shrink-0", className)} style={{ color }} aria-label={title} data-metric-trend={trend.direction} data-metric-toward={trend.toward === null ? "none" : trend.toward ? "yes" : "no"}><title>{title}</title></Icon>;
}

/**
 * A metric the way every surface shows one (I5): the name, now against the
 * target, the trend and when it was last read. `size` picks the form: `tile`
 * is the page's block with a big number and a sparkline; `line` is one row
 * for a list or a card; `chip` is the number alone for a crowded row.
 */
export function MetricTile({ reading, trend, now, size = "tile", className }: { reading: MetricReading; trend?: MetricTrend; now: number; size?: "tile" | "line" | "chip"; className?: string }) {
  const standingColor = reading.standing === "met" ? HEALTH_COLOR.on_track : reading.standing === "behind" ? HEALTH_COLOR.at_risk : "var(--sol-text-dim)";
  const nowText = reading.value === null ? "not reported" : reading.value;
  const series = trend?.series.map((p) => p.n) ?? [];
  if (size === "chip") {
    return (
      <span className={cn("inline-flex items-center gap-1 text-[11.5px] tabular-nums whitespace-nowrap", className)} title={`${reading.name}: ${nowText}, target ${reading.target}`} data-metric={reading.key} data-metric-size="chip">
        <MetricStandingDot standing={reading.standing} />
        <span style={{ color: reading.value === null ? "var(--sol-text-dim)" : "var(--sol-text)" }}>{reading.value === null ? reading.target : reading.value}</span>
        {reading.value !== null && <span style={{ color: "var(--sol-text-dim)" }}>/ {reading.target}</span>}
        {trend && <TrendGlyph trend={trend} />}
      </span>
    );
  }
  if (size === "line") {
    return (
      <span className={cn("inline-flex items-center gap-2 min-w-0 text-[12px]", className)} data-metric={reading.key} data-metric-size="line">
        <MetricStandingDot standing={reading.standing} />
        <span className="truncate" style={{ color: "var(--sol-text)" }}>{reading.name}</span>
        <span className="tabular-nums whitespace-nowrap" style={{ color: reading.value === null ? "var(--sol-text-dim)" : "var(--sol-text-secondary)" }}>
          {reading.value === null ? `target ${reading.target}` : `${reading.value} of ${reading.target}`}
        </span>
        {trend && <TrendGlyph trend={trend} />}
        {series.length >= 2 && <SparkLine values={series} target={metricNumber(reading.target)} width={48} height={14} tone={standingColor} className="text-sol-text-dim" />}
        {reading.observed_at ? <span className="whitespace-nowrap text-[11px]" style={{ color: "var(--sol-text-dim)" }}>{shortDate(reading.observed_at, now)}</span> : null}
      </span>
    );
  }
  return (
    <div className={cn("min-w-0 rounded-xl border px-3 py-2.5", className)} style={{ borderColor: "color-mix(in srgb, var(--sol-border) 26%, transparent)" }} data-metric={reading.key} data-metric-size="tile" data-metric-standing={reading.standing}>
      <div className="flex items-center gap-1.5 text-[11px] min-w-0" style={{ color: "var(--sol-text-muted)" }}>
        <MetricStandingDot standing={reading.standing} />
        <span className="truncate">{reading.name}</span>
      </div>
      <div className="mt-1 flex items-end gap-2 min-w-0">
        <span className="text-[22px] leading-none font-semibold tabular-nums tracking-tight" style={{ color: reading.value === null ? "var(--sol-text-dim)" : "var(--sol-text)" }} data-metric-now>{nowText}</span>
        <span className="text-[12px] pb-[2px] tabular-nums whitespace-nowrap" style={{ color: "var(--sol-text-dim)" }}>of {reading.target}</span>
        {trend && <TrendGlyph trend={trend} className="mb-[3px]" />}
        <span className="flex-1" />
        {series.length >= 2 && <SparkLine values={series} target={metricNumber(reading.target)} width={72} height={20} tone={standingColor} className="text-sol-text-dim" />}
      </div>
      {reading.progress !== null && (
        <span className="mt-2 block h-[4px] w-full rounded-full overflow-hidden" style={{ background: "color-mix(in srgb, var(--sol-border) 40%, transparent)" }} aria-hidden>
          <span className="block h-full rounded-full" style={{ width: `${Math.round(reading.progress * 100)}%`, background: reading.standing === "met" ? HEALTH_COLOR.on_track : INITIATIVE_ACCENT }} />
        </span>
      )}
      <div className="mt-1.5 text-[11px] flex items-center gap-2" style={{ color: "var(--sol-text-dim)" }}>
        <span>{reading.standing === "met" ? "Met" : reading.standing === "behind" ? "Behind" : reading.value === null ? "Not reported yet" : "Not a number"}</span>
        {reading.observed_at ? <span>read {shortDate(reading.observed_at, now)}</span> : null}
        {trend?.delta !== null && trend?.delta !== undefined && trend.direction !== "flat" && <span className="tabular-nums">{trend.delta > 0 ? "+" : ""}{formatMetricNumber(trend.delta)} since last</span>}
      </div>
    </div>
  );
}

/** The next milestone and its day: red when its day has passed and it is not reached; "no milestone" when none is set. */
export function NextMilestoneChip({ milestone, now, counts, className }: { milestone: InitiativeMilestone | null; now: number; counts?: { done: number; total: number }; className?: string }) {
  if (!milestone) {
    return counts?.total ? <span className={cn("text-[11.5px]", className)} style={{ color: "var(--sol-text-dim)" }} data-initiative-milestone="all-reached">All {counts.total} milestones reached</span> : null;
  }
  const late = !!milestone.date && milestone.date < now;
  return (
    <span className={cn("inline-flex items-center gap-1.5 min-w-0 text-[11.5px]", className)} title={`Next milestone${counts ? `, ${counts.done} of ${counts.total} reached` : ""}`} data-initiative-milestone={late ? "late" : "next"}>
      <Flag className="w-3 h-3 shrink-0" style={{ color: late ? HEALTH_COLOR.off_track : INITIATIVE_ACCENT }} />
      <span className="truncate" style={{ color: "var(--sol-text-secondary)" }}>{milestone.title}</span>
      {milestone.date ? <span className="tabular-nums whitespace-nowrap" style={{ color: late ? HEALTH_COLOR.off_track : "var(--sol-text-dim)" }}>{shortDate(milestone.date, now)}</span> : null}
    </span>
  );
}

/** Where something was said: a small link that opens the call, chat, doc, session, task or plan; a note shows its words. */
export function SourceLink({ source, now, className }: { source: IntentSource; now: number; className?: string }) {
  const href = intentSourceHref(source);
  const label = intentSourceLabel(source);
  const body = (
    <span className={cn("inline-flex items-center gap-1 min-w-0 text-[11px]", className)} style={{ color: "var(--sol-text-dim)" }} data-intent-source={source.kind}>
      <span className={cn("shrink-0", href && "underline decoration-dotted underline-offset-2")}>{label}</span>
      {source.by ? <span className="truncate">{source.by}</span> : null}
      {source.at ? <span className="tabular-nums whitespace-nowrap">{shortDate(source.at, now)}</span> : null}
    </span>
  );
  if (!href) return body;
  return /^https?:/.test(href)
    ? <a href={href} target="_blank" rel="noreferrer" className="no-underline hover:text-sol-text" title={source.quote}>{body}</a>
    : <Link href={href} className="no-underline hover:text-sol-text" title={source.quote}>{body}</Link>;
}
