"use client";
// The small pieces every initiative surface draws the same way
// (docs/architecture/initiatives-projects-role-page.md I1): its status, its
// health with the date it was said, its progress, its owner and its target.
// Health owns green, yellow and red, so the initiative's own accent is magenta
// and no chip that is not health ever wears a health colour.
import { CheckCircle2, Circle, CircleDashed, CircleDot, XCircle, type LucideIcon } from "lucide-react";
import { INITIATIVE_HEALTH_LABEL, INITIATIVE_STATUS_LABEL, type InitiativeHealth, type InitiativeOwner, type InitiativeStatus } from "@codecast/shared/contracts/initiative";
import { useTrackedStore } from "../../store/inboxStore";
import { useOrgRoles } from "../../hooks/useOrgRoles";
import { useTeamRosterIdentity } from "../../hooks/useTeamRoster";
import { resolveAssigneeInfo } from "../../lib/liveEntities";
import { ownerId, progressPercent, type Progress } from "../../lib/initiatives";
import { cn } from "../../lib/utils";
import { AssigneeFace } from "../identity/AssigneeFace";

export const INITIATIVE_ACCENT = "var(--sol-magenta)";

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

export const HEALTH_COLOR: Record<InitiativeHealth, string> = {
  none: "var(--sol-text-dim)",
  on_track: "var(--sol-green)",
  at_risk: "var(--sol-yellow)",
  off_track: "var(--sol-red)",
};

const shortDate = (ts: number, now: number) =>
  new Date(ts).toLocaleDateString("en-US", new Date(ts).getFullYear() === new Date(now).getFullYear() ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });

/** Health is whatever the owner said last, with the date it was said. */
export function HealthChip({ health, at, now, className }: { health: InitiativeHealth; at?: number; now: number; className?: string }) {
  const color = HEALTH_COLOR[health];
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[11.5px] whitespace-nowrap", className)} style={{ color: health === "none" ? color : "var(--sol-text-secondary)" }} data-initiative-health={health}>
      <span className="w-[7px] h-[7px] rounded-full shrink-0" style={health === "none" ? { border: `1px solid ${color}` } : { background: color }} aria-hidden />
      {INITIATIVE_HEALTH_LABEL[health]}
      {health !== "none" && at ? <span style={{ color: "var(--sol-text-dim)" }}>{shortDate(at, now)}</span> : null}
    </span>
  );
}

/** Tasks done over tasks, as one thin bar: done solid, in progress behind it. */
export function ProgressBar({ progress, className }: { progress: Progress; className?: string }) {
  const pct = progressPercent(progress);
  const moving = progress.total === 0 ? 0 : Math.round(((progress.done + progress.in_progress) / progress.total) * 100);
  return (
    <span className={cn("inline-flex items-center gap-2 min-w-0", className)} data-initiative-progress={`${progress.done}/${progress.total}`} title={progress.total === 0 ? "No tasks yet" : `${progress.done} of ${progress.total} tasks done, ${progress.in_progress} in progress`}>
      <span className="relative flex-1 min-w-[48px] h-[4px] rounded-full overflow-hidden" style={{ background: "color-mix(in srgb, var(--sol-border) 35%, transparent)" }} aria-hidden>
        <span className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-300" style={{ width: `${moving}%`, background: `color-mix(in srgb, ${INITIATIVE_ACCENT} 30%, transparent)` }} />
        <span className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-300" style={{ width: `${pct}%`, background: INITIATIVE_ACCENT }} />
      </span>
      <span className="shrink-0 text-[11px] tabular-nums" style={{ color: "var(--sol-text-dim)" }}>{progress.total === 0 ? "no tasks" : `${progress.done}/${progress.total}`}</span>
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
