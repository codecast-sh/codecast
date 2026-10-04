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
import { HealthChip, MetricReadingLine } from "../initiatives/InitiativeAtoms";
import { useZoomLevel, type ZoomLevel } from "./orgZoom";
import { Frame, GhostActions, GhostChips, Ports, type GhostActionHandlers } from "./OrgNodeCards";
import { GhostTag } from "./ghostChrome";
import { RoleFace } from "./RoleFace";
import { CHANGE_KIND_WORD, CHIP_STATUS, GHOST } from "./orgMeta";
import { GOALS_SIZES, goalFocusedChange, type GoalGhost, type GoalOwner, type GoalsNode } from "./goalsLayout";

type Lit = { selected?: boolean; dim?: boolean; /** The middle card's height inside the node's box (GoalsNode.mid). */ mid: number };
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
/** The far and close cards fill the node's box; the middle one keeps its own height at the box's top. */
const levelHeight = (level: ZoomLevel, mid: number): React.CSSProperties => (level === "mid" ? { height: mid } : {});

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

function OwnerFace({ owner, size = 28 }: { owner: GoalOwner; size?: number }) {
  if (owner.kind === "role") return <RoleFace role={{ handle: owner.handle, name: owner.name, avatar: owner.avatar }} size={size} />;
  if (owner.kind === "person") return <Avatar name={owner.name} image={owner.image} size={size > 22 ? "md" : "sm"} />;
  return <span className="inline-flex items-center justify-center rounded-full" style={{ width: size, height: size, border: CHIP_STATUS.failed.border, color: CHIP_STATUS.failed.color }}><AlertTriangle className="h-3.5 w-3.5" /></span>;
}

export type GoalNodeData = Lit & GhostFocus & Pick<Extract<GoalsNode, { kind: "goal" }>, "goal" | "metrics">;
export const GoalCard = memo(function GoalCard({ data }: NodeProps<Node<GoalNodeData>>) {
  const { goal: g, metrics } = data;
  const now = useCoarseNow(60_000);
  const level = useZoomLevel();
  const ghost = proposed(g.ghost);
  // The Accept, Edit, Skip strip role ghosts wear, on the change in focus.
  const action = goalFocusedChange(data.focusChangeId, g.ghost, g.chips);
  const frame = { selected: data.selected, kind: g.ghost ? "goal-ghost" : "goal", accent: g.ghost ? GHOST.color : "var(--sol-cyan)" };
  // Far: the title and the health dot, large enough to read with the whole company on screen.
  if (level === "far") {
    return (
      <Frame {...frame} className={cn("px-3 py-2.5 flex items-start gap-2.5 transition-opacity", data.dim && "opacity-45")} style={ghostFrame(g.ghost)}>
        <Ports />
        <span className="mt-[9px] shrink-0">{g.row ? <HealthChip health={g.row.health} now={now} bare className="[&>span]:!h-[13px] [&>span]:!w-[13px]" /> : <span className="block h-[13px] w-[13px] rounded-full" style={{ border: `2px dashed ${GHOST.color}` }} aria-hidden />}</span>
        <div className="line-clamp-3 min-w-0 text-[22px] font-semibold leading-[27px] tracking-tight" style={{ color: "var(--sol-text)", opacity: ghost ? 0.9 : 1 }} title={g.title} data-goal-title>{g.title}</div>
      </Frame>
    );
  }
  const close = level === "close";
  return (
    <Frame {...frame} className={cn("px-2.5 py-2 transition-opacity", data.dim && "opacity-45")} style={{ ...ghostFrame(g.ghost), ...levelHeight(level, data.mid) }}>
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
        {g.owner && <span className="mt-[1px] inline-flex shrink-0" style={g.ownerGhost && !g.ownerGhost.solid ? { opacity: 0.75 } : undefined} title={`Owner: ${g.owner.name}`} data-goal-face={g.owner.id}><OwnerFace owner={g.owner} size={20} /></span>}
      </div>
      {(close ? metrics : metrics.slice(0, 1)).map((m) => (
        <div key={m.key} className="mt-1 flex min-w-0 items-center" style={{ height: GOALS_SIZES.metricRow - 4 }} data-goal-metric={m.key}>
          <MetricReadingLine reading={m} now={now} className="!gap-1.5 !text-[10.5px] [&>span:last-child]:!text-[10px]" />
        </div>
      ))}
      {g.was && <div className="mt-1 truncate text-[10.5px]" style={{ color: "var(--sol-text-dim)", height: GOALS_SIZES.wasRow - 4 }} data-goal-was>was under {g.was}</div>}
      <GhostChips chips={g.chips} focusChangeId={data.focusChangeId} onFocusChange={data.onFocusChange} wide />
      {close && g.description?.trim() && (
        <p className="mt-1.5 line-clamp-2 text-[10.5px] leading-[15px]" style={{ color: "var(--sol-text-muted)", height: GOALS_SIZES.descRow - 6 }} title={g.description} data-goal-description>{g.description}</p>
      )}
    </Frame>
  );
});

export type ProjectNodeData = Lit & GhostFocus & { project: Extract<GoalsNode, { kind: "project" }>["project"] };
export const GoalProjectCard = memo(function GoalProjectCard({ data }: NodeProps<Node<ProjectNodeData>>) {
  const p = data.project;
  const level = useZoomLevel();
  const ghost = proposed(p.ghost);
  // A row an `initiative_projects` change added decides on its own row; a new
  // goal's own project rows decide on the goal.
  const action = p.ghost?.kind === "initiative_projects" ? goalFocusedChange(data.focusChangeId, p.ghost) : null;
  const far = level === "far";
  return (
    <Frame selected={data.selected} className={cn("px-2.5 flex flex-col justify-center !rounded-lg transition-opacity", data.dim && "opacity-45")} style={{ ...ghostFrame(p.ghost), ...levelHeight(level, data.mid) }} kind={p.ghost ? "project-ghost" : "project"} accent={p.ghost ? GHOST.color : "var(--sol-cyan)"}>
      <Ports />
      {action && <GhostActions meta={action} word={CHANGE_KIND_WORD[action.kind]} data={{ onDecideChange: data.onDecideChange, onEditChange: data.onEditChange }} below />}
      <div className="flex min-w-0 items-center gap-2">
        <FolderClosed className={cn("shrink-0", far ? "h-5 w-5" : "h-3.5 w-3.5")} style={{ color: ghost ? GHOST.color : "var(--sol-text-muted)" }} />
        <span className={cn("min-w-0 flex-1 truncate font-medium", far ? "text-[19px] tracking-tight" : "text-[12px]")} style={{ color: "var(--sol-text)", opacity: ghost ? 0.85 : 1 }} title={p.ghost?.line ?? p.title} data-project-title>{p.title}</span>
        {!far && p.ghost?.tag && <GhostTag label={p.ghost.tag} status={ghostTagStatus(p.ghost)} className="shrink-0" />}
      </div>
      {level === "close" && (
        <div className="mt-[2px] flex min-w-0 items-center gap-1.5 pl-[22px] text-[10px]" style={{ color: "var(--sol-text-dim)" }} data-project-close>
          {p.short_id && <span className="shrink-0 font-mono">{p.short_id}</span>}
          {p.status && <span className="shrink-0">{p.status}</span>}
          <span className="min-w-0 truncate" data-project-lead={p.lead ? p.lead.id : "none"}>{p.lead ? `led by ${p.lead.name}` : "no lead"}</span>
        </div>
      )}
    </Frame>
  );
});

export type OwnerNodeData = Lit & { owner: GoalOwner; owns: number; line?: string };
export const GoalOwnerCard = memo(function GoalOwnerCard({ data }: NodeProps<Node<OwnerNodeData>>) {
  const o = data.owner;
  const level = useZoomLevel();
  const stub = o.kind === "role" ? o.stub : undefined;
  const far = level === "far";
  return (
    <Frame selected={data.selected} className={cn("px-2.5 flex items-center gap-2 transition-opacity", data.dim && "opacity-45")} style={{ ...(stub && !stub.solid ? { border: GHOST.border, background: GHOST.fill } : {}), ...levelHeight(level, data.mid) }} kind={`owner-${o.kind}`} accent={o.kind === "role" ? "var(--sol-violet)" : "var(--sol-cyan)"}>
      <Ports />
      <span className="inline-flex shrink-0" style={stub && !stub.solid ? { opacity: GHOST.opacity } : undefined}><OwnerFace owner={o} size={far ? 32 : 28} /></span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className={cn("truncate font-semibold leading-tight", far ? "text-[18px] tracking-tight" : "text-[12.5px]")} style={{ color: "var(--sol-text)" }}>{o.name}</span>
          {!far && o.kind === "person" && o.me && <span className="shrink-0 rounded-sm px-1 text-[9.5px] font-medium" style={{ background: "color-mix(in srgb, var(--sol-cyan) 14%, transparent)", color: "var(--sol-cyan)" }}>you</span>}
        </div>
        {!far && (
          <div className="mt-[2px] truncate text-[10.5px]" style={{ color: "var(--sol-text-dim)" }}>
            {o.kind === "role" ? `@${o.handle} · ` : o.kind === "unknown" ? "not on this chart · " : ""}{data.owns === 0 ? "owns nothing after this" : `owns ${data.owns}`}
          </div>
        )}
        {level === "close" && data.line && <div className="mt-[2px] truncate text-[10.5px]" style={{ color: "var(--sol-text-muted)" }} title={data.line} data-owner-line>{data.line}</div>}
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

/** `a` is where the edge meets the card, from its top (goalsAnchor): inside the card at every zoom level. */
type Rect = { x: number; y: number; w: number; h: number; a: number };
export type GoalsEdgeData = { s: Rect; t: Rect; ghost?: boolean; faded?: boolean; lit?: boolean; dim?: boolean; /** An owner edge's lane (GoalsLayout.ownerLane). */ lane?: number };

function GoalSpineEdge({ id, data }: EdgeProps<Edge<GoalsEdgeData>>) {
  const { s, t, ghost } = data!;
  const x = s.x + GOALS_SIZES.spineInset;
  const midY = t.y + t.a;
  const r = Math.min(9, Math.max(0, t.x - x));
  // From inside the parent (the card covers the start) down to the child's first row.
  const path = `M ${x},${s.y + s.a} L ${x},${midY - r} Q ${x},${midY} ${x + r},${midY} L ${t.x},${midY}`;
  return <BaseEdge id={id} path={path} style={ghost ? { stroke: GHOST.color, strokeWidth: 1.5, strokeDasharray: "6 4", opacity: GHOST.opacity } : { stroke: "color-mix(in srgb, var(--sol-border) 70%, transparent)", strokeWidth: 1.5 }} />;
}

function GoalOwnerEdge({ id, data }: EdgeProps<Edge<GoalsEdgeData>>) {
  const { s, t, ghost, faded, lit, dim, lane } = data!;
  const x0 = s.x + s.w, y0 = s.y + s.a, x1 = t.x, y1 = t.y + t.a;
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
