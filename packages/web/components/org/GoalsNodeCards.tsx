"use client";
// The Goals lens' cards and edges (docs/architecture/org-staffing.md S36):
// the company, a goal, a project, and an owner. React Flow renderers in the
// chart's own frame, ghost chrome and chips (OrgNodeCards, ghostChrome), so a
// goal ghost reads the way a role ghost does.
import { memo } from "react";
import { BaseEdge, type Edge, type EdgeProps, type Node, type NodeProps } from "@xyflow/react";
import { AlertTriangle, Building2, Flag, FolderClosed } from "lucide-react";
import { cn } from "../../lib/utils";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { Avatar } from "../tasks/TaskCommentStream";
import { HealthChip, MetricStandingDot } from "../initiatives/InitiativeAtoms";
import { Frame, GhostActions, GhostChips, Ports, type GhostActionHandlers } from "./OrgNodeCards";
import { GhostTag } from "./ghostChrome";
import { RoleFace } from "./RoleFace";
import { CHANGE_KIND_WORD, CHIP_STATUS, GHOST } from "./orgMeta";
import { GOALS_SIZES, goalFocusedChange, type GoalGhost, type GoalOwner, type GoalsNode } from "./goalsLayout";
import type { MetricReading } from "@codecast/shared/contracts/initiative";

type Lit = { selected?: boolean; dim?: boolean };
type GhostFocus = { focusChangeId?: string | null; onFocusChange?: (id: string) => void } & Pick<GhostActionHandlers, "onDecideChange" | "onEditChange">;

/** A card's frame under a change: dashed violet while proposed, the accepted
 *  colour once accepted, a warning when nothing answers to what it names. */
function ghostFrame(ghost: GoalGhost | undefined): React.CSSProperties | undefined {
  if (!ghost) return undefined;
  if (ghost.unresolved) return { border: CHIP_STATUS.failed.border, background: GHOST.fill };
  return ghost.solid ? { border: CHIP_STATUS.accepted.border } : { border: CHIP_STATUS[ghost.status].border, background: GHOST.fill };
}
const ghostTagStatus = (g: GoalGhost) => (g.unresolved ? "failed" : g.status);
const proposed = (g: GoalGhost | undefined) => !!g && !g.solid;

export type CompanyNodeData = Lit & { name: string; goals: number; projects: number };
export const CompanyCard = memo(function CompanyCard({ data }: NodeProps<Node<CompanyNodeData>>) {
  return (
    <Frame selected={data.selected} className="px-3 flex items-center gap-2.5" kind="company" accent="var(--sol-cyan)">
      <Ports />
      <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg" style={{ background: "color-mix(in srgb, var(--sol-cyan) 14%, transparent)", color: "var(--sol-cyan)" }}><Building2 className="h-4 w-4" /></span>
      <div className="min-w-0">
        <div className="truncate text-[14px] font-semibold leading-tight tracking-tight" style={{ fontFamily: "var(--font-serif)", color: "var(--sol-text)" }}>{data.name}</div>
        <div className="mt-[2px] text-[10.5px] tabular-nums" style={{ color: "var(--sol-text-dim)" }} data-company-tally>
          {data.goals === 0 ? "No goals yet" : `${data.goals} ${data.goals === 1 ? "goal" : "goals"}, carried by ${data.projects} ${data.projects === 1 ? "project" : "projects"}`}
        </div>
      </div>
    </Frame>
  );
});

function MetricLine({ reading }: { reading: MetricReading }) {
  return (
    <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[10.5px]" style={{ color: "var(--sol-text-muted)", height: GOALS_SIZES.metricRow - 4 }} data-goal-metric={reading.key}>
      <MetricStandingDot standing={reading.standing} />
      <span className="truncate">{reading.name}</span>
      <span className="shrink-0 tabular-nums" style={{ color: "var(--sol-text-dim)" }}>{reading.value === null ? `target ${reading.target}` : `${reading.value} of ${reading.target}`}</span>
    </div>
  );
}

export type GoalNodeData = Lit & GhostFocus & Pick<Extract<GoalsNode, { kind: "goal" }>, "goal" | "metric">;
export const GoalCard = memo(function GoalCard({ data }: NodeProps<Node<GoalNodeData>>) {
  const { goal: g, metric } = data;
  const now = useCoarseNow(60_000);
  const ghost = proposed(g.ghost);
  // The Accept, Edit, Skip strip role ghosts wear, on the change in focus.
  const action = goalFocusedChange(data.focusChangeId, g.ghost, g.chips);
  return (
    <Frame selected={data.selected} className={cn("px-2.5 py-2 transition-opacity", data.dim && "opacity-45")} style={ghostFrame(g.ghost)} kind={g.ghost ? "goal-ghost" : "goal"} accent={g.ghost ? GHOST.color : "var(--sol-cyan)"}>
      <Ports />
      {action && <GhostActions meta={action} word={CHANGE_KIND_WORD[action.kind]} data={{ chips: g.chips, onDecideChange: data.onDecideChange, onEditChange: data.onEditChange }} below />}
      <div className="flex min-w-0 items-start gap-2" title={g.ghost?.line}>
        <span className="mt-[1px] inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md" style={{ background: ghost ? GHOST.fill : "color-mix(in srgb, var(--sol-cyan) 14%, transparent)", color: ghost ? GHOST.color : "var(--sol-cyan)" }}><Flag className="h-3 w-3" /></span>
        <div className="min-w-0 flex-1">
          <div className="line-clamp-3 text-[13px] font-semibold leading-[16px]" style={{ color: "var(--sol-text)", opacity: ghost ? 0.85 : 1 }} title={g.title} data-goal-title>{g.title}</div>
          <div className="mt-[3px] flex min-w-0 items-center gap-2 text-[10.5px]" style={{ color: "var(--sol-text-dim)" }}>
            {g.ghost?.tag && <GhostTag label={g.ghost.tag} status={ghostTagStatus(g.ghost)} className="shrink-0" />}
            {g.short_id && <span className="shrink-0 font-mono">{g.short_id}</span>}
            {g.row ? <HealthChip health={g.row.health} at={g.row.health_at} now={now} className="!text-[10.5px] min-w-0 truncate" /> : g.owner ? <span className="min-w-0 truncate" data-goal-owner={g.owner.id}>{g.owner.name}</span> : null}
            {!g.owner && <span className="shrink-0 italic" data-goal-owner="none">no owner</span>}
          </div>
        </div>
      </div>
      {metric && <MetricLine reading={metric} />}
      {g.was && <div className="mt-1 truncate text-[10.5px]" style={{ color: "var(--sol-text-dim)", height: GOALS_SIZES.wasRow - 4 }} data-goal-was>was under {g.was}</div>}
      <GhostChips chips={g.chips} focusChangeId={data.focusChangeId} onFocusChange={data.onFocusChange} wide />
    </Frame>
  );
});

export type ProjectNodeData = Lit & GhostFocus & { project: Extract<GoalsNode, { kind: "project" }>["project"] };
export const GoalProjectCard = memo(function GoalProjectCard({ data }: NodeProps<Node<ProjectNodeData>>) {
  const p = data.project;
  const ghost = proposed(p.ghost);
  // A row an `initiative_projects` change added decides on its own row; a new
  // goal's own project rows decide on the goal.
  const action = p.ghost?.kind === "initiative_projects" ? goalFocusedChange(data.focusChangeId, p.ghost) : null;
  return (
    <Frame selected={data.selected} className={cn("px-2.5 flex items-center gap-2 !rounded-lg transition-opacity", data.dim && "opacity-45")} style={ghostFrame(p.ghost)} kind={p.ghost ? "project-ghost" : "project"} accent={p.ghost ? GHOST.color : "var(--sol-cyan)"}>
      <Ports />
      {action && <GhostActions meta={action} word={CHANGE_KIND_WORD[action.kind]} data={{ onDecideChange: data.onDecideChange, onEditChange: data.onEditChange }} below />}
      <FolderClosed className="h-3.5 w-3.5 shrink-0" style={{ color: ghost ? GHOST.color : "var(--sol-text-muted)" }} />
      <span className="min-w-0 flex-1 truncate text-[12px] font-medium" style={{ color: "var(--sol-text)", opacity: ghost ? 0.85 : 1 }} title={p.ghost?.line ?? p.title} data-project-title>{p.title}</span>
      {p.ghost?.tag && <GhostTag label={p.ghost.tag} status={ghostTagStatus(p.ghost)} className="shrink-0" />}
    </Frame>
  );
});

function OwnerFace({ owner }: { owner: GoalOwner }) {
  if (owner.kind === "role") return <RoleFace role={{ handle: owner.handle, name: owner.name, avatar: owner.avatar }} size={28} />;
  if (owner.kind === "person") return <Avatar name={owner.name} image={owner.image} size="md" />;
  return <span className="inline-flex h-7 w-7 items-center justify-center rounded-full" style={{ border: CHIP_STATUS.failed.border, color: CHIP_STATUS.failed.color }}><AlertTriangle className="h-3.5 w-3.5" /></span>;
}

export type OwnerNodeData = Lit & { owner: GoalOwner; owns: number };
export const GoalOwnerCard = memo(function GoalOwnerCard({ data }: NodeProps<Node<OwnerNodeData>>) {
  const o = data.owner;
  const stub = o.kind === "role" ? o.stub : undefined;
  return (
    <Frame selected={data.selected} className={cn("px-2.5 flex items-center gap-2 transition-opacity", data.dim && "opacity-45")} style={stub && !stub.solid ? { border: GHOST.border, background: GHOST.fill } : undefined} kind={`owner-${o.kind}`} accent={o.kind === "role" ? "var(--sol-violet)" : "var(--sol-cyan)"}>
      <Ports />
      <span className="inline-flex shrink-0" style={stub && !stub.solid ? { opacity: GHOST.opacity } : undefined}><OwnerFace owner={o} /></span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[12.5px] font-semibold leading-tight" style={{ color: "var(--sol-text)" }}>{o.name}</span>
          {o.kind === "person" && o.me && <span className="shrink-0 rounded-sm px-1 text-[9.5px] font-medium" style={{ background: "color-mix(in srgb, var(--sol-cyan) 14%, transparent)", color: "var(--sol-cyan)" }}>you</span>}
        </div>
        <div className="mt-[2px] truncate text-[10.5px]" style={{ color: "var(--sol-text-dim)" }}>
          {o.kind === "role" ? `@${o.handle} · ` : o.kind === "unknown" ? "not on this chart · " : ""}{data.owns === 0 ? "owns nothing after this" : `owns ${data.owns}`}
        </div>
      </div>
    </Frame>
  );
});

export const GOALS_NODE_TYPES = { company: CompanyCard, goal: GoalCard, project: GoalProjectCard, owner: GoalOwnerCard };

// ---------------------------------------------------------------- edges
// Both edges are drawn from the cards' own rects (the layout knows them), not
// from the handles: a spine leaves the parent's left edge and enters the
// child's side; an owner edge leaves a row's right side and enters the
// owner's left.

type Rect = { x: number; y: number; w: number; h: number };
export type GoalsEdgeData = { s: Rect; t: Rect; ghost?: boolean; faded?: boolean; lit?: boolean; dim?: boolean; /** An owner edge's lane (GoalsLayout.ownerLane). */ lane?: number };

function GoalSpineEdge({ id, data }: EdgeProps<Edge<GoalsEdgeData>>) {
  const { s, t, ghost } = data!;
  const x = s.x + GOALS_SIZES.spineInset;
  const midY = t.y + t.h / 2;
  const r = Math.min(9, Math.max(0, t.x - x));
  const path = `M ${x},${s.y + s.h} L ${x},${midY - r} Q ${x},${midY} ${x + r},${midY} L ${t.x},${midY}`;
  return <BaseEdge id={id} path={path} style={ghost ? { stroke: GHOST.color, strokeWidth: 1.5, strokeDasharray: "6 4", opacity: GHOST.opacity } : { stroke: "color-mix(in srgb, var(--sol-border) 70%, transparent)", strokeWidth: 1.5 }} />;
}

function GoalOwnerEdge({ id, data }: EdgeProps<Edge<GoalsEdgeData>>) {
  const { s, t, ghost, faded, lit, dim, lane } = data!;
  const x0 = s.x + s.w, y0 = s.y + s.h / 2, x1 = t.x, y1 = t.y + t.h / 2;
  // Straight out to the lane past the deepest row, then the curve to the owner.
  const from = Math.max(x0, lane ?? x0);
  const mid = (from + x1) / 2;
  const path = `M ${x0},${y0} L ${from},${y0} C ${mid},${y0} ${mid},${y1} ${x1},${y1}`;
  const opacity = faded ? 0.2 : dim ? 0.1 : lit ? 0.95 : ghost ? 0.8 : 0.4;
  return (
    <g data-owner-edge={id} data-ghost={ghost ? "" : undefined} data-faded={faded ? "" : undefined}>
      <BaseEdge id={id} path={path} style={{ stroke: ghost ? GHOST.color : lit ? "var(--sol-cyan)" : "var(--sol-text-dim)", strokeWidth: lit ? 1.75 : 1.25, strokeDasharray: ghost ? "6 4" : faded ? "2 4" : undefined, strokeOpacity: opacity, transition: "stroke-opacity 180ms" }} />
    </g>
  );
}

export const GOALS_EDGE_TYPES = { goalSpine: GoalSpineEdge, goalOwner: GoalOwnerEdge };
