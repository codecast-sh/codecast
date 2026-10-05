"use client";
// The small pieces every initiative surface draws the same way
// (docs/architecture/initiatives-projects-role-page.md I1): its status, its
// health with the date it was said, its progress, its owner and its target.
// Health owns green, yellow and red, so the initiative's own accent is magenta
// and no chip that is not health ever wears a health colour.
import { useCallback } from "react";
import Link from "next/link";
import { ArrowDownRight, ArrowUpRight, CheckCircle2, Circle, CircleDashed, CircleDot, Flag, Minus, XCircle, type LucideIcon } from "lucide-react";
import { INITIATIVE_HEALTH_LABEL, INITIATIVE_STATUS_LABEL, formatMetricNumber, intentSourceLabel, metricAgainst, metricLine, metricNumber, metricReaches, trendWords, type InitiativeHealth, type InitiativeMilestone, type InitiativeOwner, type InitiativeStatus, type InitiativeUpdateHealth, type IntentSource, type MetricReading, type MetricStanding, type MetricTrend } from "@codecast/shared/contracts/initiative";
import { memberHandle } from "@codecast/shared/chat";
import { stripMachineText, stripMarkdown } from "@codecast/shared/contracts/plainText";
import { formatShortDate, formatTargetDay, targetDayPassed } from "@codecast/shared/time";
import { intentSourceHref } from "../../lib/intentSources";
import { SparkLine } from "../Spark";
import { useTrackedStore } from "../../store/inboxStore";
import { useOrgRoles } from "../../hooks/useOrgRoles";
import { useTeamRosterIdentity } from "../../hooks/useTeamRoster";
import { memberDisplayName, resolveAssigneeInfo } from "../../lib/liveEntities";
import { ownerId, progressPercent, type Progress } from "../../lib/initiatives";
import { compactAge } from "../../lib/threadState";
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

/** A moment (when something was said, read or reached) as a short date where
 *  the viewer is. A stored day (a target, a milestone's day) is not a moment:
 *  it reads through formatTargetDay, so every timezone names the same day. */
export const shortDate: (ts: number, now: number) => string = formatShortDate;

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
export function ProgressBar({ progress, partial, bare, className }: { progress: Progress; partial?: boolean; /** The bar alone, for a card that prints its own counts. */ bare?: boolean; className?: string }) {
  const pct = progressPercent(progress);
  const moving = progress.total === 0 ? 0 : Math.round(((progress.done + progress.in_progress) / progress.total) * 100);
  const title = partial ? "Counting: the task cache is still filling" : progress.total === 0 ? "No tasks yet" : `${progress.done} of ${progress.total} tasks done, ${progress.in_progress} in progress`;
  return (
    <span className={cn("inline-flex items-center gap-2 min-w-0", className)} data-initiative-progress={partial ? "counting" : `${progress.done}/${progress.total}`} title={title}>
      <span className={cn("relative flex-1 min-w-[48px] h-[4px] rounded-full overflow-hidden", partial && "opacity-40")} style={{ background: "color-mix(in srgb, var(--sol-border) 35%, transparent)" }} aria-hidden>
        <span className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-300" style={{ width: `${moving}%`, background: `color-mix(in srgb, ${INITIATIVE_ACCENT} 30%, transparent)` }} />
        <span className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-300" style={{ width: `${pct}%`, background: INITIATIVE_ACCENT }} />
      </span>
      {!bare && <span className={cn("shrink-0 text-[11px] tabular-nums", partial && "italic")} style={{ color: "var(--sol-text-dim)" }}>{partial ? "counting" : progress.total === 0 ? "no tasks" : `${progress.done}/${progress.total}`}</span>}
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

/** A target day, red once it has passed. A goal's is a stored day
 *  (shared/time targetDayStamp), the same day for every viewer and late only
 *  when their own calendar is past it. `local` is for a stamp that is the end
 *  of the viewer's own day instead (a project's deadline). */
export function TargetDate({ ts, now, done, local, className }: { ts?: number; now: number; done?: boolean; local?: boolean; className?: string }) {
  if (!ts) return null;
  const late = !done && (local ? ts < now : targetDayPassed(ts, now));
  return (
    <span className={cn("text-[11.5px] tabular-nums whitespace-nowrap", className)} style={{ color: late ? "var(--sol-red)" : "var(--sol-text-dim)" }} title={late ? "Past its target" : "Target"} data-initiative-target={late ? "late" : "ahead"}>
      {local ? shortDate(ts, now) : formatTargetDay(ts, now)}
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

/** A metric as one row where the caller holds no history: MetricTile's line, which draws the bar toward a reach target in the sparkline's place. */
export function MetricReadingLine({ reading, now, className }: { reading: MetricReading; now: number; className?: string }) {
  return <MetricTile size="line" reading={reading} now={now} className={className} />;
}

/** Which way the number moved, as one glyph: up, down, flat, or nothing before two reports. Green when toward the target, yellow when away. */
export function TrendGlyph({ trend, className }: { trend: MetricTrend; className?: string }) {
  if (trend.direction === "unknown") return null;
  const Icon = trend.direction === "up" ? ArrowUpRight : trend.direction === "down" ? ArrowDownRight : Minus;
  const color = trend.toward === null ? "var(--sol-text-dim)" : trend.toward ? HEALTH_COLOR.on_track : HEALTH_COLOR.at_risk;
  // The contract's words, so the direction and the number it names are read over the same span.
  const words = trendWords(trend);
  const title = words.charAt(0).toUpperCase() + words.slice(1);
  return <Icon className={cn("w-3 h-3 shrink-0", className)} style={{ color }} aria-label={title} data-metric-trend={trend.direction} data-metric-toward={trend.toward === null ? "none" : trend.toward ? "yes" : "no"}><title>{title}</title></Icon>;
}

/** How far toward a reach target, as a thin bar. */
function MetricBar({ reading, className }: { reading: MetricReading; className?: string }) {
  if (reading.progress === null) return null;
  return (
    <span className={cn("h-[4px] rounded-full overflow-hidden", className)} style={{ background: "color-mix(in srgb, var(--sol-border) 40%, transparent)" }} aria-hidden data-metric-bar>
      <span className="block h-full rounded-full" style={{ width: `${Math.round(reading.progress * 100)}%`, background: reading.standing === "met" ? HEALTH_COLOR.on_track : INITIATIVE_ACCENT }} />
    </span>
  );
}

/**
 * A metric the way every surface shows one (I5): the name, now against the
 * target, the trend and when it was last read. `size` picks the form: `tile`
 * is the page's block with a big number and a sparkline; `line` is one row
 * for a list or a card, with the bar toward the target until two reports
 * make a sparkline; `chip` is the name and the number for a crowded row
 * (`named={false}` where a column heading already names it). The words are
 * the contract's (metricAgainst): a value reads "of" a number to reach, and
 * a number to stay under or a target that is not a number is named as the
 * target.
 */
export function MetricTile({ reading, trend, now, size = "tile", named = true, className }: { reading: MetricReading; trend?: MetricTrend; now: number; size?: "tile" | "line" | "chip"; named?: boolean; className?: string }) {
  const standingColor = reading.standing === "met" ? HEALTH_COLOR.on_track : reading.standing === "behind" ? HEALTH_COLOR.at_risk : "var(--sol-text-dim)";
  const unreported = reading.value === null;
  const reaches = metricReaches(reading.target);
  const series = trend?.series.map((p) => p.n) ?? [];
  if (size === "chip") {
    return (
      <span className={cn("inline-flex items-center gap-1 min-w-0 max-w-full text-[11.5px] tabular-nums whitespace-nowrap", className)} title={metricLine(reading, now)} data-metric={reading.key} data-metric-size="chip">
        <MetricStandingDot standing={reading.standing} />
        {named && <span className="truncate max-w-[18ch]" style={{ color: "var(--sol-text-muted)" }} data-metric-name>{reading.name}</span>}
        {unreported
          ? <span style={{ color: "var(--sol-text-dim)" }}>{metricAgainst(reading)}</span>
          : <><span style={{ color: "var(--sol-text)" }}>{reading.value}</span><span style={{ color: "var(--sol-text-dim)" }}>{reaches ? "/" : "·"} {reading.target}</span></>}
        {trend && <TrendGlyph trend={trend} />}
      </span>
    );
  }
  if (size === "line") {
    return (
      <span className={cn("inline-flex items-center gap-2 min-w-0 text-[12px]", className)} data-metric={reading.key} data-metric-size="line">
        <MetricStandingDot standing={reading.standing} />
        <span className="truncate" style={{ color: "var(--sol-text)" }}>{reading.name}</span>
        <span className="tabular-nums whitespace-nowrap" style={{ color: unreported ? "var(--sol-text-dim)" : "var(--sol-text-secondary)" }}>{metricAgainst(reading)}</span>
        {trend && <TrendGlyph trend={trend} />}
        {series.length >= 2
          ? <SparkLine values={series} target={metricNumber(reading.target)} width={48} height={14} tone={standingColor} className="text-sol-text-dim" />
          : <MetricBar reading={reading} className="w-[56px] shrink-0" />}
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
        <span className="text-[22px] leading-none font-semibold tabular-nums tracking-tight" style={{ color: unreported ? "var(--sol-text-dim)" : "var(--sol-text)" }} data-metric-now>{unreported ? "not reported" : reading.value}</span>
        <span className="text-[12px] pb-[2px] tabular-nums whitespace-nowrap" style={{ color: "var(--sol-text-dim)" }} data-metric-target>{!unreported && reaches ? "of" : "target"} {reading.target}</span>
        {trend && <TrendGlyph trend={trend} className="mb-[3px]" />}
        <span className="flex-1" />
        {series.length >= 2 && <SparkLine values={series} target={metricNumber(reading.target)} width={72} height={20} tone={standingColor} className="text-sol-text-dim" />}
      </div>
      <MetricBar reading={reading} className="mt-2 block w-full" />
      <div className="mt-1.5 text-[11px] flex items-center gap-2" style={{ color: "var(--sol-text-dim)" }}>
        <span>{reading.standing === "met" ? "Met" : reading.standing === "behind" ? "Behind" : unreported ? "Not reported yet" : metricNumber(reading.value) === null ? "Not a number" : "No number in the target"}</span>
        {reading.observed_at ? <span>read {shortDate(reading.observed_at, now)}</span> : null}
        {trend?.delta !== null && trend?.delta !== undefined && trend.direction !== "flat" && <span className="tabular-nums">{trend.delta > 0 ? "+" : ""}{formatMetricNumber(trend.delta)} since last</span>}
      </div>
    </div>
  );
}

/** The next milestone and its day: red when its day has passed and it is not reached; "no milestone" when none is set. */
export function NextMilestoneChip({ milestone, now, counts, className }: { milestone: InitiativeMilestone | null; now: number; counts?: { done: number; total: number }; className?: string }) {
  if (!milestone) {
    return counts?.total ? <span className={cn("text-[11.5px]", className)} style={{ color: "var(--sol-text-dim)" }} data-initiative-milestone="all-reached">{counts.total === 1 ? "Its milestone is reached" : `All ${counts.total} milestones reached`}</span> : null;
  }
  const late = !!milestone.date && targetDayPassed(milestone.date, now);
  return (
    <span className={cn("inline-flex items-center gap-1.5 min-w-0 text-[11.5px]", className)} title={`Next milestone${counts ? `, ${counts.done} of ${counts.total} reached` : ""}`} data-initiative-milestone={late ? "late" : "next"}>
      <Flag className="w-3 h-3 shrink-0" style={{ color: late ? HEALTH_COLOR.off_track : INITIATIVE_ACCENT }} />
      <span className="truncate" style={{ color: "var(--sol-text-secondary)" }}>{milestone.title}</span>
      {milestone.date ? <span className="tabular-nums whitespace-nowrap" style={{ color: late ? HEALTH_COLOR.off_track : "var(--sol-text-dim)" }}>{formatTargetDay(milestone.date, now)}</span> : null}
    </span>
  );
}

/** Who asked, decided or said it, read off the roster: the face when `by`
 *  names a person or a role here (an @handle, or a name), null when not. */
export function useWho(): (by: string | undefined) => ReturnType<typeof resolveAssigneeInfo> {
  const { roles } = useOrgRoles();
  const roster = useTeamRosterIdentity();
  const s = useTrackedStore([(st) => st.currentUser?._id]);
  return useCallback((by) => {
    const text = (by ?? "").trim();
    if (!text) return null;
    const handle = text.startsWith("@") ? text.slice(1).toLowerCase() : null;
    const name = text.toLowerCase();
    const person = roster.find((m) => (handle ? memberHandle(m) === handle : memberDisplayName(m, "").toLowerCase() === name));
    const role = person ? undefined : roles.find((r) => (handle ? r.handle === handle : r.name.toLowerCase() === name));
    const id = person?._id ?? role?._id;
    return id ? resolveAssigneeInfo(String(id), undefined, roster as any, s.currentUser as any, roles as any) : null;
  }, [roles, roster, s.currentUser]);
}

/** `by` as a face and a name when the roster knows it, and the words as written when not. */
export function ByChip({ by, className }: { by?: string; className?: string }) {
  const who = useWho();
  if (!by) return null;
  const info = who(by);
  return (
    <span className={cn("inline-flex items-center gap-1 min-w-0", className)} style={{ color: "var(--sol-text-muted)" }} data-initiative-by={info ? "face" : "text"}>
      {info && <AssigneeFace info={info} size={13} />}
      <span className="truncate">{info?.name ?? by}</span>
    </span>
  );
}

/** Where something was said: a small link that opens the call, chat, doc,
 *  session, task or plan, then who said it and when. A note has no address,
 *  so it shows its words. `bare` is the address alone, for a row that prints
 *  who and when itself. */
export function SourceLink({ source, now, bare, className }: { source: IntentSource; now: number; bare?: boolean; className?: string }) {
  const href = intentSourceHref(source);
  const words = source.kind === "note" ? source.quote : undefined;
  const body = (
    <span className={cn("inline-flex items-center gap-1.5 min-w-0 max-w-full text-[11px]", className)} style={{ color: "var(--sol-text-dim)" }} data-intent-source={source.kind}>
      <span className={cn(words ? "truncate max-w-[40ch]" : "shrink-0", href && "underline decoration-dotted underline-offset-2")} title={href ? undefined : source.quote} data-intent-source-label>{words ?? intentSourceLabel(source)}</span>
      {!bare && <ByChip by={source.by} />}
      {!bare && source.at ? <span className="tabular-nums whitespace-nowrap">{shortDate(source.at, now)}</span> : null}
    </span>
  );
  if (!href) return body;
  return /^https?:/.test(href)
    ? <a href={href} target="_blank" rel="noreferrer" className="no-underline hover:text-sol-text" title={source.quote}>{body}</a>
    : <Link href={href} className="no-underline hover:text-sol-text" title={source.quote}>{body}</Link>;
}

/** The latest update as one line: the health it said, how long ago, and its first words. Nothing before an update exists. */
export function UpdateLine({ update, now, className }: { update: { health: InitiativeUpdateHealth; at: number; body: string } | null | undefined; now: number; className?: string }) {
  if (!update) return null;
  const first = stripMachineText(update.body).split("\n").map((l) => stripMarkdown(l)).find(Boolean) ?? "";
  return (
    <span className={cn("inline-flex items-center gap-1.5 min-w-0 text-[11.5px]", className)} title={first} data-initiative-update-line={update.health}>
      <span className="w-[7px] h-[7px] rounded-full shrink-0" style={{ background: HEALTH_COLOR[update.health] }} aria-hidden />
      <span className="whitespace-nowrap" style={{ color: "var(--sol-text-secondary)" }}>{INITIATIVE_HEALTH_LABEL[update.health]}</span>
      <span className="tabular-nums whitespace-nowrap" style={{ color: "var(--sol-text-dim)" }}>{compactAge(Math.max(0, now - update.at))}</span>
      <span className="truncate" style={{ color: "var(--sol-text-muted)" }}>{first}</span>
    </span>
  );
}
