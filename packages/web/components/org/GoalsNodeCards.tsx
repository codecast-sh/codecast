"use client";
// The Goals lens' cards and edges (docs/architecture/org-staffing.md S36):
// the company, a goal, a project, and an owner. React Flow renderers in the
// chart's own frame (OrgNodeCards.Frame), at three zoom levels (orgZoom), each
// filling the node the layout sized for that level (goalsLayout):
//   far    the title and a health dot, read with the whole company on screen
//   mid    the owner's face, the first metric against its target, the health
//          word and date, how many projects carry it
//   close  the description, every metric with its latest value, trend and
//          date, the next milestone, the latest update, the sessions working
//          under it now; a project adds its number, status and lead
// A proposed goal wears one quiet mark: a violet flag over a soft violet
// tint and a thin outline, the word the proposal card uses ("new", "moves
// here") in plain text. Nothing on the chart is dashed. A column card wears
// the reporting chart's marks for a role change: the stub tint, the retire
// hatch, "was under X" for a move, a quiet line per chip.
import { memo } from "react";
import { BaseEdge, type Edge, type EdgeProps, type Node, type NodeProps } from "@xyflow/react";
import { AlertTriangle, Building2, Compass, Flag, FolderClosed, FolderOpen } from "lucide-react";
import { metricTrends, milestoneCounts, nextMilestone } from "@codecast/shared/contracts/initiative";
import { cn } from "../../lib/utils";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useInitiativeUpdates } from "../../hooks/useInitiatives";
import { Avatar } from "../tasks/TaskCommentStream";
import { HealthChip, MetricReadingLine, MetricTile, NextMilestoneChip, UpdateLine } from "../initiatives/InitiativeAtoms";
import { useZoomLevel } from "./orgZoom";
import { Frame, GhostChips, Ports, StateBar, StateWords } from "./OrgNodeCards";
import { GhostTag } from "./ghostChrome";
import { RoleFace } from "./RoleFace";
import { CHIP_STATUS, GHOST, ORG_STATE_META, changeFrameStyle, ghostFrameStyle } from "./orgMeta";
import { GOALS_SIZES, type GoalGhost, type GoalOwner, type GoalsNode } from "./goalsLayout";

type Lit = { selected?: boolean; dim?: boolean };
type GhostFocus = { focusChangeId?: string | null; onFocusChange?: (id: string) => void };

/** A card's frame under a change: the violet tint while proposed, the
 *  accepted outline once accepted, a warning when nothing answers to what it names. */
const ghostFrame = (ghost: GoalGhost | undefined): React.CSSProperties | undefined => (ghost ? changeFrameStyle(ghost.status, ghost.unresolved) : undefined);
const ghostTagStatus = (g: GoalGhost) => (g.unresolved ? "failed" : g.status);
const proposed = (g: GoalGhost | undefined) => !!g && !g.solid;
const DIM = "var(--sol-text-dim)";

export type CompanyNodeData = Lit & { name: string; goals: number; projects: number; mission: boolean };
export const CompanyCard = memo(function CompanyCard({ data }: NodeProps<Node<CompanyNodeData>>) {
  const far = useZoomLevel() === "far";
  return (
    <Frame selected={data.selected} className="px-3 flex items-center gap-2.5" kind="company" accent="var(--sol-cyan)">
      <Ports />
      <span className={cn("inline-flex shrink-0 items-center justify-center rounded-lg", far ? "h-9 w-9" : "h-8 w-8")} style={{ background: "color-mix(in srgb, var(--sol-cyan) 14%, transparent)", color: "var(--sol-cyan)" }}><Building2 className={far ? "h-5 w-5" : "h-4 w-4"} /></span>
      <div className="min-w-0">
        <div className={cn("truncate font-semibold leading-tight tracking-tight", far ? "text-[20px]" : "text-[14px]")} style={{ fontFamily: "var(--font-serif)", color: "var(--sol-text)" }}>{data.name}</div>
        <div className={cn("mt-[2px] tabular-nums", far ? "text-[12px]" : "text-[10.5px]")} style={{ color: DIM }} data-company-tally>
          {data.goals === 0 ? "No goals yet" : `${data.mission ? (far ? "mission · " : "the mission · ") : ""}${data.goals} ${data.goals === 1 ? "goal" : "goals"} · ${data.projects} ${data.projects === 1 ? "project" : "projects"}`}
        </div>
      </div>
    </Frame>
  );
});

/** The quiet header over the projects no goal carries. */
export type LooseNodeData = Lit & { projects: number };
export const LooseCard = memo(function LooseCard({ data }: NodeProps<Node<LooseNodeData>>) {
  const far = useZoomLevel() === "far";
  return (
    <Frame selected={data.selected} className="px-3 flex items-center gap-2" kind="loose" accent="var(--sol-text-dim)" style={{ background: "color-mix(in srgb, var(--sol-bg-alt) 60%, transparent)", borderColor: "color-mix(in srgb, var(--sol-border) 55%, transparent)", boxShadow: "none" }}>
      <Ports />
      <FolderOpen className={cn("shrink-0", far ? "h-4 w-4" : "h-3.5 w-3.5")} style={{ color: DIM }} />
      <span className={cn("min-w-0 truncate font-medium", far ? "text-[15px] tracking-tight" : "text-[12px]")} style={{ color: "var(--sol-text-muted)" }} data-loose-count={data.projects}>
        {far ? "No goal yet" : `${data.projects} ${data.projects === 1 ? "project" : "projects"} under no goal`}
      </span>
    </Frame>
  );
});

function OwnerFace({ owner, size = 28 }: { owner: GoalOwner; size?: number }) {
  if (owner.kind === "role") return <RoleFace role={{ handle: owner.handle, name: owner.name, avatar: owner.avatar }} size={size} />;
  if (owner.kind === "person") return <Avatar name={owner.name} image={owner.image} size={size > 22 ? "md" : "sm"} />;
  return <span className="inline-flex items-center justify-center rounded-full" style={{ width: size, height: size, border: `1px solid ${CHIP_STATUS.failed.color}`, color: CHIP_STATUS.failed.color }}><AlertTriangle className="h-3.5 w-3.5" /></span>;
}

type GoalRow = NonNullable<Extract<GoalsNode, { kind: "goal" }>["goal"]["row"]>;
const CLOSE_LINE = "!text-[10.5px] !gap-1.5 w-full";

/** The goal's latest update, from the store when it holds it; else the health word and its date alone. */
function LatestUpdate({ goal, now }: { goal: GoalRow; now: number }) {
  const updates = useInitiativeUpdates(goal._id);
  const latest = updates.find((u) => u._id === goal.latest_update_id) ?? updates[0];
  return (
    <div className="flex min-w-0 items-center" style={{ height: GOALS_SIZES.updateRow }} data-goal-update={latest?._id ?? ""}>
      {latest ? <UpdateLine update={latest} now={now} className={CLOSE_LINE} /> : <HealthChip health={goal.health} at={goal.health_at} now={now} className="!text-[10.5px]" />}
    </div>
  );
}

/** The sessions working under the goal's projects now, newest first. */
function Running({ sessions }: { sessions: Extract<GoalsNode, { kind: "goal" }>["running"] }) {
  if (sessions.length === 0) return null;
  const color = ORG_STATE_META.working.color;
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-[10.5px]" style={{ height: GOALS_SIZES.runningRow, color: "var(--sol-text-muted)" }} data-goal-running={sessions.length}>
      <span className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: color }} aria-hidden />
      <span className="shrink-0" style={{ color: "var(--sol-text-secondary)" }}>{sessions.length} working</span>
      <span className="min-w-0 truncate" title={sessions.map((s) => `${s.short_id} ${s.title}`).join("\n")}>
        {sessions.map((s, i) => <span key={s._id}>{i > 0 && <span aria-hidden> · </span>}<span className="font-mono" style={{ color: DIM }}>{s.short_id}</span> {s.title}</span>)}
      </span>
    </div>
  );
}

/** The projects a goal carries that are drawn under another goal, in one
 *  quiet line: through the goals below it when it has any, else "also X, Y". */
function ProjectRefs({ refs, hasChildren }: { refs: Extract<GoalsNode, { kind: "goal" }>["refs"]; hasChildren: boolean }) {
  if (refs.length === 0) return null;
  const names = refs.map((r) => r.project.title);
  const text = hasChildren ? `${refs.length} ${refs.length === 1 ? "project" : "projects"} through the goals below` : `also ${names.join(", ")}`;
  return (
    <div className="mt-1 flex min-w-0 items-center gap-1 truncate text-[10.5px]" style={{ height: GOALS_SIZES.refRow - 4, color: DIM }} title={refs.map((r) => `${r.project.title}, drawn under ${r.under}`).join("\n")} data-project-refs={refs.length}>
      <FolderClosed className="h-2.5 w-2.5 shrink-0" />
      <span className="truncate">{text}</span>
    </div>
  );
}

/** The word over a mission's title, in the goal's own colour; the root mission leads with the company's name. */
function MissionKicker({ ghost, company }: { ghost: boolean; company?: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1 text-[9.5px] font-semibold uppercase tracking-[0.08em]" style={{ height: GOALS_SIZES.missionRow, color: ghost ? GHOST.color : "var(--sol-cyan)" }} data-goal-mission={company ? "root" : ""}>
      {company && <><span className="truncate" style={{ color: "var(--sol-text-muted)", fontFamily: "var(--font-serif)", textTransform: "none", letterSpacing: 0, fontSize: 12 }} data-root-company>{company}</span><span aria-hidden style={{ color: DIM }}>·</span></>}
      <Compass className="h-[10px] w-[10px] shrink-0" /> mission
    </div>
  );
}

export type GoalNodeData = Lit & GhostFocus & Pick<Extract<GoalsNode, { kind: "goal" }>, "goal" | "metrics" | "rows" | "refs" | "running" | "mission" | "root" | "hasChildren">;
export const GoalCard = memo(function GoalCard({ data }: NodeProps<Node<GoalNodeData>>) {
  const { goal: g, metrics, rows, refs, running, mission, root, hasChildren } = data;
  const now = useCoarseNow(60_000);
  const level = useZoomLevel();
  const ghost = proposed(g.ghost);
  const frame = { selected: data.selected, kind: g.ghost ? "goal-ghost" : "goal", accent: g.ghost ? GHOST.color : "var(--sol-cyan)" };
  const carried = rows.length + refs.length;
  // Far: the title and the health dot, large enough to read with the whole company on screen.
  if (level === "far") {
    return (
      <Frame {...frame} className={cn("px-3 flex items-start gap-2.5 overflow-hidden transition-opacity", data.dim && "opacity-45")} style={{ ...ghostFrame(g.ghost), paddingTop: GOALS_SIZES.farPad / 2 }}>
        <Ports />
        <span className="shrink-0" style={{ marginTop: 6 + (mission ? GOALS_SIZES.missionRow : 0) }}>{g.row ? <HealthChip health={g.row.health} now={now} bare className="[&>span]:!h-[13px] [&>span]:!w-[13px]" /> : <span className="block h-[13px] w-[13px] rounded-full" style={{ background: GHOST.color, opacity: 0.8 }} title="Proposed" aria-hidden />}</span>
        <div className="min-w-0">
          {mission && <MissionKicker ghost={ghost} company={root?.name} />}
          <div className="line-clamp-3 min-w-0 text-[21px] font-semibold tracking-tight" style={{ lineHeight: `${GOALS_SIZES.farRow}px`, color: "var(--sol-text)", opacity: ghost ? 0.9 : 1 }} title={g.title} data-goal-title>{g.title}</div>
        </div>
      </Frame>
    );
  }
  const close = level === "close";
  const milestone = g.row ? nextMilestone(g.row) : null;
  const closeRows = !!g.description?.trim() || metrics.length > 1 || !!milestone || (!!g.row && g.row.health !== "none") || running.length > 0;
  const trends = close && g.row ? metricTrends(g.row) : {};
  // Middle: the first metric against its target, with its bar. Close: each with its trend and the day it was read.
  const metricRow = (m: (typeof metrics)[number]) => (
    <div key={m.key} className="flex min-w-0 items-center" style={{ height: GOALS_SIZES.metricRow - 4, marginTop: close && closeRows ? 0 : 4, marginBottom: close && closeRows ? 4 : 0 }} data-goal-metric={m.key}>
      {close ? <MetricTile size="line" reading={m} trend={trends[m.key]} now={now} className={cn(CLOSE_LINE, "[&>span:last-child]:!text-[10px]")} /> : <MetricReadingLine reading={m} now={now} className="!gap-1.5 !text-[10.5px] [&>span:last-child]:!text-[10px]" />}
    </div>
  );
  return (
    <Frame {...frame} className={cn("px-2.5 py-2 transition-opacity", data.dim && "opacity-45")} style={ghostFrame(g.ghost)}>
      <Ports />
      {mission && <MissionKicker ghost={ghost} company={root?.name} />}
      <div className="flex min-w-0 items-start gap-2" title={g.ghost?.line}>
        <span className="mt-[1px] inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md" style={{ background: ghost ? "color-mix(in srgb, var(--sol-violet) 16%, transparent)" : "color-mix(in srgb, var(--sol-cyan) 14%, transparent)", color: ghost ? GHOST.color : "var(--sol-cyan)" }}><Flag className="h-3 w-3" /></span>
        <div className="min-w-0 flex-1">
          <div className="line-clamp-3 text-[13px] font-semibold leading-[16px]" style={{ color: "var(--sol-text)", opacity: ghost ? 0.9 : 1 }} title={g.title} data-goal-title>{g.title}</div>
          {/* Middle: the health word (the owner is the face). Close: the short id and the owner's name; the health moves to the update line below. */}
          <div className="mt-[3px] flex min-w-0 items-center gap-1.5 overflow-hidden text-[10.5px] whitespace-nowrap" style={{ color: DIM }}>
            {g.ghost?.tag && <GhostTag quiet label={g.ghost.tag} status={ghostTagStatus(g.ghost)} className="shrink-0" />}
            {close && g.short_id && <span className="shrink-0 font-mono">{g.short_id}</span>}
            {g.row && !(close && g.row.health !== "none") && <HealthChip health={g.row.health} now={now} className="!text-[10.5px] shrink-0" />}
            {g.owner && (close || !g.row) && <span className="min-w-0 truncate" data-goal-owner={g.owner.id}>{g.owner.name}</span>}
            {!g.owner && <span className="shrink-0 italic" data-goal-owner="none">no owner</span>}
            {/* The root mission carries the company's totals; any other goal how many projects carry it. */}
            {root ? <span className="shrink-0 tabular-nums" data-company-tally>· {root.goals} {root.goals === 1 ? "goal" : "goals"} · {root.projects} {root.projects === 1 ? "project" : "projects"}</span>
              : !close && carried > 0 && <span className="shrink-0 tabular-nums" data-goal-projects={carried}>· {carried} {carried === 1 ? "project" : "projects"}</span>}
          </div>
        </div>
        {g.owner && <span className="mt-[1px] inline-flex shrink-0" style={g.ownerGhost && !g.ownerGhost.solid ? { opacity: 0.8 } : undefined} title={`Owner: ${g.owner.name}`} data-goal-face={g.owner.id}><OwnerFace owner={g.owner} size={20} /></span>}
      </div>
      {!(close && closeRows) && metrics.slice(0, 1).map(metricRow)}
      {g.was && <div className="mt-1 truncate text-[10.5px]" style={{ color: DIM, height: GOALS_SIZES.wasRow - 4 }} data-goal-was>was under {g.was}</div>}
      <GhostChips chips={g.chips} focusChangeId={data.focusChangeId} onFocusChange={data.onFocusChange} quiet />
      <ProjectRefs refs={refs} hasChildren={hasChildren} />
      {/* Close: under a rule, what the goal means, every number it is read by, what its owner last said, and what is running under it. */}
      {close && closeRows && (
        <div className="border-t" style={{ marginTop: 4, paddingTop: GOALS_SIZES.closeRule - 5, borderColor: "color-mix(in srgb, var(--sol-border) 30%, transparent)" }} data-goal-close>
          {g.description?.trim() && <p className="line-clamp-2 text-[10.5px] leading-[15px]" style={{ color: "var(--sol-text-muted)", height: 30, marginBottom: GOALS_SIZES.descRow - 30 }} title={g.description} data-goal-description>{g.description}</p>}
          {metrics.map(metricRow)}
          {milestone && <div className="flex min-w-0 items-center" style={{ height: GOALS_SIZES.milestoneRow }} data-goal-milestone><NextMilestoneChip milestone={milestone} counts={milestoneCounts(g.row!)} now={now} className={CLOSE_LINE} /></div>}
          {g.row && g.row.health !== "none" && <LatestUpdate goal={g.row} now={now} />}
          <Running sessions={running} />
        </div>
      )}
    </Frame>
  );
});

export type ProjectNodeData = Lit & GhostFocus & Pick<Extract<GoalsNode, { kind: "project" }>, "project" | "counts">;
export const GoalProjectCard = memo(function GoalProjectCard({ data }: NodeProps<Node<ProjectNodeData>>) {
  const p = data.project;
  const counts = data.counts;
  const level = useZoomLevel();
  const ghost = proposed(p.ghost);
  // A row an `initiative_projects` change added decides on its own row; a new
  // goal's own project rows decide on the goal.
  const far = level === "far";
  return (
    <Frame selected={data.selected} className={cn("px-2.5 flex flex-col justify-center !rounded-lg transition-opacity", data.dim && "opacity-45")} style={ghostFrame(p.ghost)} kind={p.ghost ? "project-ghost" : "project"} accent={p.ghost ? GHOST.color : "var(--sol-cyan)"}>
      <Ports />
      <div className="flex min-w-0 items-center gap-2">
        <FolderClosed className={cn("shrink-0", far ? "h-4 w-4" : "h-3.5 w-3.5")} style={{ color: ghost ? GHOST.color : "var(--sol-text-muted)" }} />
        <span className={cn("min-w-0 flex-1 truncate font-medium", far ? "text-[15px] tracking-tight" : "text-[12px]")} style={{ color: "var(--sol-text)", opacity: ghost ? 0.9 : 1 }} title={p.ghost?.line ?? p.title} data-project-title>{p.title}</span>
        {!far && p.ghost?.tag && <GhostTag quiet label={p.ghost.tag} status={ghostTagStatus(p.ghost)} className="shrink-0" />}
        {/* The sessions under the roles whose area holds the project, in words, never a stack of cards. */}
        {!far && counts && <span className="inline-flex shrink-0" data-project-counts><StateWords counts={counts} max={1} /></span>}
        {!far && p.lead && <span className="inline-flex shrink-0" title={`Led by ${p.lead.name}`} data-project-lead-face={p.lead.id}><OwnerFace owner={p.lead} size={16} /></span>}
      </div>
      {/* Close: its number, where it stands and who leads it. */}
      {level === "close" && (
        <div className="mt-[2px] flex min-w-0 items-center gap-1.5 pl-[22px] text-[10px] whitespace-nowrap" style={{ color: DIM }} data-project-close>
          {p.short_id && <span className="shrink-0 font-mono">{p.short_id}</span>}
          {p.status && <span className="shrink-0" style={{ color: p.status === "active" ? "var(--sol-text-muted)" : DIM }}>{p.status}</span>}
          <span className="min-w-0 truncate" data-project-lead={p.lead ? p.lead.id : "none"}>· {p.lead ? `led by ${p.lead.name}` : "no lead"}</span>
        </div>
      )}
    </Frame>
  );
});

export type OwnerNodeData = Lit & GhostFocus & Pick<Extract<GoalsNode, { kind: "owner" }>, "owner" | "owns" | "line" | "counts" | "reportsTo" | "ghost" | "retire" | "move" | "was" | "chips">;
export const GoalOwnerCard = memo(function GoalOwnerCard({ data }: NodeProps<Node<OwnerNodeData>>) {
  const o = data.owner;
  const level = useZoomLevel();
  // A proposed role: the stub the layout put in the column, else the one the proposal's row carries on the face.
  const stub = data.ghost ?? (o.kind === "role" ? o.stub : undefined);
  const retiring = !!data.retire && data.retire.status !== "applied";
  const far = level === "far";
  const frame = stub ? (data.ghost ? ghostFrameStyle(data.ghost) : !stub.solid ? changeFrameStyle(stub.status) : undefined) : retiring ? { opacity: 0.75 } : undefined;
  return (
    <Frame selected={data.selected} className={cn("px-2.5 flex items-center gap-2 transition-opacity", data.dim && "opacity-45")} style={frame} kind={stub && !stub.solid ? "ghost" : `owner-${o.kind}`} accent={o.kind === "role" ? "var(--sol-violet)" : "var(--sol-cyan)"}>
      <Ports />
      {retiring && <div aria-hidden className="pointer-events-none absolute inset-0 rounded-xl" style={{ background: GHOST.hatch }} />}
      <span className="inline-flex shrink-0" style={stub && !stub.solid ? { opacity: 0.8 } : undefined}><OwnerFace owner={o} size={28} /></span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className={cn("truncate font-semibold leading-tight", far ? "text-[15px] tracking-tight" : "text-[12.5px]")} style={{ color: "var(--sol-text)" }}>{o.name}</span>
          {!far && o.kind === "person" && o.me && <span className="shrink-0 rounded-sm px-1 text-[9.5px] font-medium" style={{ background: "color-mix(in srgb, var(--sol-cyan) 14%, transparent)", color: "var(--sol-cyan)" }}>you</span>}
          {!far && data.ghost && <GhostTag quiet label={data.ghost.solid ? data.ghost.status : "new role"} status={data.ghost.status === "failed" ? "failed" : data.ghost.solid ? "accepted" : "proposed"} className="shrink-0" />}
          {!far && data.retire && <GhostTag quiet label="retire" status={data.retire.status} tone="color-mix(in srgb, var(--sol-red) 70%, var(--sol-text))" className="shrink-0" />}
        </div>
        {!far && (
          <div className="mt-[2px] truncate text-[10.5px]" style={{ color: DIM }} title={[o.kind === "role" ? `@${o.handle}` : "", data.reportsTo ? `reports to ${data.reportsTo}` : ""].filter(Boolean).join(" · ") || undefined} data-owner-meta>
            {/* The column card: the handle rides the title (the face and the name say who); what it owns and, on the map, who it is under. */}
            {!data.counts && o.kind === "role" ? `@${o.handle} · ` : o.kind === "unknown" ? "not on this chart · " : ""}{data.owns === 0 ? (data.counts ? "owns nothing" : "owns nothing after this") : `owns ${data.owns}`}{data.reportsTo ? ` · under ${data.reportsTo}` : ""}
          </div>
        )}
        {/* The map's Everything: the card's sessions by state, the bar for the proportion and words for what a person acts on. */}
        {data.counts && (
          <div className={cn("flex min-w-0 items-center gap-2", far ? "mt-[5px]" : "mt-[4px]")} style={{ height: GOALS_SIZES.ownerStateRow - 4 }} data-owner-counts>
            <StateBar counts={data.counts} className="min-w-0 flex-1" />
            {!far && <StateWords counts={data.counts} />}
          </div>
        )}
        {data.was && !far && <div className="truncate text-[10.5px]" style={{ color: DIM, height: GOALS_SIZES.ownerWasRow - 2, marginTop: 2 }} title={data.move?.line} data-owner-was>was under {data.was}</div>}
        {!far && <GhostChips chips={data.chips} focusChangeId={data.focusChangeId} onFocusChange={data.onFocusChange} quiet />}
        {level === "close" && data.line && <div className="mt-[2px] truncate text-[10.5px]" style={{ color: "var(--sol-text-muted)" }} title={data.line} data-owner-line>{data.line}</div>}
      </div>
    </Frame>
  );
});

export const GOALS_NODE_TYPES = { company: CompanyCard, goal: GoalCard, project: GoalProjectCard, owner: GoalOwnerCard, loose: LooseCard };

// ---------------------------------------------------------------- edges
// Both edges are drawn from the cards' own rects (the layout knows them), not
// from the handles: a spine drops from inside the parent card (which covers
// its start: every card is opaque and drawn over the edges) down the gutter
// left of its children and turns into each child's side; an owner edge
// leaves a row's right side and enters the owner's left.

/** `a` is where the edge meets the card, from its top (goalsAnchor): inside the card at every zoom level. */
type Rect = { x: number; y: number; w: number; h: number; a: number };
export type GoalsEdgeData = { s: Rect; t: Rect; ghost?: boolean; faded?: boolean; lit?: boolean; dim?: boolean; /** An owner edge's lane (GoalsLayout.ownerLane). */ lane?: number };

function GoalSpineEdge({ id, data }: EdgeProps<Edge<GoalsEdgeData>>) {
  const { s, t, ghost, faded } = data!;
  // The trunk runs down the gutter between the parent's left edge and its
  // children's (GOALS_SIZES.spineInset of indent), never through a card.
  const x = s.x + GOALS_SIZES.spineInset;
  const midY = t.y + t.a;
  const r = Math.min(9, Math.max(0, t.x - x));
  const path = `M ${x},${s.y + s.a} L ${x},${midY - r} Q ${x},${midY} ${x + r},${midY} L ${t.x},${midY}`;
  // A moved goal's old place: a faint line, so the move reads as a move.
  if (faded) return <g data-spine-was={id}><BaseEdge id={id} path={path} style={{ stroke: "var(--sol-text-dim)", strokeWidth: 1, strokeOpacity: 0.35 }} /></g>;
  return <BaseEdge id={id} path={path} style={ghost ? { stroke: GHOST.color, strokeWidth: 1.5, strokeOpacity: 0.55 } : { stroke: "color-mix(in srgb, var(--sol-border) 70%, transparent)", strokeWidth: 1.5 }} />;
}

/** Drawn only for the card under the pointer or selected (OrgGraph.goalsFlowEdges). */
function GoalOwnerEdge({ id, data }: EdgeProps<Edge<GoalsEdgeData>>) {
  const { s, t, ghost, faded, lane } = data!;
  const x0 = s.x + s.w, y0 = s.y + s.a, x1 = t.x, y1 = t.y + t.a;
  // Straight out to the lane past the deepest row, then the curve to the owner.
  const from = Math.max(x0, lane ?? x0);
  const mid = (from + x1) / 2;
  const path = `M ${x0},${y0} L ${from},${y0} C ${mid},${y0} ${mid},${y1} ${x1},${y1}`;
  return (
    <g data-owner-edge={id} data-ghost={ghost ? "" : undefined} data-faded={faded ? "" : undefined}>
      <BaseEdge id={id} path={path} style={{ stroke: ghost ? GHOST.color : faded ? "var(--sol-text-dim)" : "var(--sol-cyan)", strokeWidth: faded ? 1 : 1.75, strokeOpacity: faded ? 0.35 : 0.95 }} />
    </g>
  );
}

export const GOALS_EDGE_TYPES = { goalSpine: GoalSpineEdge, goalOwner: GoalOwnerEdge };
