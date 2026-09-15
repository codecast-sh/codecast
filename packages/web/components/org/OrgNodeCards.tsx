"use client";
// The five org cards: person, role, anchor, session, cluster. React Flow node
// renderers, painted with the app's Solarized tokens. State colours are the
// inbox's: needs input amber (THREAD_STATE_STATUS_META.blocked), working green,
// done cyan, dormant blue, idle dim.
import { memo, type ReactNode } from "react";
import Link from "next/link";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { ChevronDown, ChevronRight, GitFork, Layers, Anchor as AnchorGlyph, Shield, Crown, Check, Pencil, X, Clock, Sparkles } from "lucide-react";
import { AgentIcon } from "../ConversationList";
import { Avatar } from "../tasks/TaskCommentStream";
import { compactAge } from "../../lib/threadState";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { cn } from "../../lib/utils";
import type { OrgAnchor, OrgPerson, OrgRole, OrgSession, StateCounts, OrgParentRef } from "./orgTypes";
import { ORG_STATE_ORDER } from "./orgTypes";
import { GHOST, ORG_STATE_META, SEVERITY_COLOR, standingLineOf } from "./orgMeta";
import type { OrgStandingState } from "./orgTypes";
import type { HealthFlag, OrgChangeStatus } from "./orgStaffingTypes";
import type { OrgGhostChip, OrgGhostMeta, OrgGhostMove, OrgGhostStub } from "./orgLayout";
import { FLAG_LABEL } from "./staffingModel";

/** Five proportional segments in state order; an empty parent draws a hairline. */
export function StateBar({ counts, className }: { counts: StateCounts; className?: string }) {
  const total = ORG_STATE_ORDER.reduce((n, k) => n + (counts[k] ?? 0), 0);
  return (
    <div className={cn("flex h-[5px] w-full gap-[2px] rounded-full overflow-hidden", className)} aria-hidden>
      {total === 0 ? (
        <div className="flex-1 rounded-full" style={{ background: "color-mix(in srgb, var(--sol-border) 35%, transparent)" }} />
      ) : (
        ORG_STATE_ORDER.filter((k) => (counts[k] ?? 0) > 0).map((k) => (
          <div
            key={k}
            className="rounded-full"
            style={{ flex: counts[k], background: ORG_STATE_META[k].color, opacity: k === "idle" ? 0.45 : 0.9 }}
            title={`${counts[k]} ${ORG_STATE_META[k].label}`}
          />
        ))
      )}
    </div>
  );
}

/**
 * The state tally. With `labels` each count carries its word ("231 needs
 * input · 2 working"): the form for the one place per surface that teaches
 * the colours (the org header, the scope board line). Without, dots only, for
 * a cluster card sitting under its parent's StateBar; zero counts are then
 * dropped rather than faded, so nothing is drawn that cannot be read.
 */
export function StateTally({ counts, dim, labels }: { counts: StateCounts; dim?: boolean; labels?: boolean }) {
  const shown = labels ? ORG_STATE_ORDER : ORG_STATE_ORDER.filter((k) => (counts[k] ?? 0) > 0);
  return (
    <span className="inline-flex items-center gap-1.5 tabular-nums text-[10.5px] font-medium whitespace-nowrap">
      {shown.map((k) => (
        <span key={k} className="inline-flex items-center gap-[3px]" title={ORG_STATE_META[k].label}>
          <span className="w-[6px] h-[6px] rounded-full" style={{ background: ORG_STATE_META[k].color, opacity: (counts[k] ?? 0) === 0 ? 0.3 : 1 }} />
          <span style={{ color: (counts[k] ?? 0) === 0 || dim ? "var(--sol-text-dim)" : "var(--sol-text-secondary)" }}>{counts[k] ?? 0}</span>
          {labels && <span className="font-normal" style={{ color: (counts[k] ?? 0) === 0 ? "var(--sol-text-dim)" : "var(--sol-text-muted)" }}>{ORG_STATE_META[k].label}</span>}
        </span>
      ))}
      {shown.length === 0 && <span style={{ color: "var(--sol-text-dim)" }}>none</span>}
    </span>
  );
}

// ---------------------------------------------------------------- shared chrome

type CardData = {
  selected?: boolean;
  dropTarget?: boolean;
  dragging?: boolean;
  onToggleCollapse?: (id: string) => void;
  onExpandCluster?: (parentId: string) => void;
  onCollapseCluster?: (parentId: string) => void;
  loadingCluster?: boolean;
  /** org.health's flags on this node (org-staffing.md S3): a dot each. */
  flags?: HealthFlag[];
  // Ghosts (S5): what an open proposal draws on this card, from the layout.
  ghost?: OrgGhostStub;
  retire?: OrgGhostMeta;
  move?: OrgGhostMove;
  chips?: OrgGhostChip[];
  /** The change the chart is focused on: its action row shows on its card. */
  focusChangeId?: string | null;
  onFocusChange?: (changeId: string) => void;
  onDecideChange?: (changeId: string, verdict: "accept" | "skip") => void;
  /** Edit: the graph opens the hire dialog (a role) or an inline form (the rest) at the click. */
  onEditChange?: (changeId: string, at: { x: number; y: number }) => void;
};

// ---------------------------------------------------------------- ghosts + flags

/** One dot per flag, worst first, the code and detail on hover. Sits on the
 *  card's top right so it never competes with the name. */
function FlagDots({ flags }: { flags?: HealthFlag[] }) {
  if (!flags?.length) return null;
  const rank = { blocker: 0, warn: 1, info: 2 } as const;
  const sorted = [...flags].sort((a, b) => rank[a.severity] - rank[b.severity]);
  return (
    <span className="absolute -top-[5px] right-2.5 flex items-center gap-[3px]" data-flags={sorted.map((f) => f.code).join(",")}>
      {sorted.map((f, i) => (
        <span
          key={`${f.code}:${i}`}
          className="w-[9px] h-[9px] rounded-full border-2"
          style={{ background: SEVERITY_COLOR[f.severity], borderColor: "var(--sol-card)" }}
          title={`${FLAG_LABEL[f.code]} (${f.severity}): ${f.detail}`}
          aria-label={`${FLAG_LABEL[f.code]}: ${f.detail}`}
        />
      ))}
    </span>
  );
}

const CHIP_STATUS: Record<OrgChangeStatus, { border: string; color: string }> = {
  proposed: { border: GHOST.border, color: GHOST.color },
  accepted: { border: "1.5px solid color-mix(in srgb, var(--sol-cyan) 60%, transparent)", color: "var(--sol-cyan)" },
  applied: { border: "1.5px solid color-mix(in srgb, var(--sol-green) 60%, transparent)", color: "var(--sol-green)" },
  skipped: { border: "1.5px dashed color-mix(in srgb, var(--sol-border) 60%, transparent)", color: "var(--sol-text-dim)" },
  failed: { border: "1.5px dashed color-mix(in srgb, var(--sol-red) 70%, transparent)", color: "var(--sol-red)" },
};

/** A small dashed tag: "proposed", "retire", "this session", "accepted". */
function GhostTag({ label, status = "proposed", className }: { label: string; status?: OrgChangeStatus; className?: string }) {
  const m = CHIP_STATUS[status];
  return (
    <span className={cn("inline-flex items-center h-[16px] px-1 rounded-sm text-[9.5px] font-medium uppercase tracking-[0.06em] whitespace-nowrap", className)} style={{ border: m.border, color: m.color }} data-ghost-tag={label}>
      {label}
    </span>
  );
}

/** Dashed chips, one per change on this card, three shown then "+N". A click
 *  focuses the change (the pane shows its rationale, the card its actions). */
function GhostChips({ chips, focusChangeId, onFocusChange }: { chips?: OrgGhostChip[]; focusChangeId?: string | null; onFocusChange?: (id: string) => void }) {
  if (!chips?.length) return null;
  const shown = chips.slice(0, 3);
  const rest = chips.slice(3);
  return (
    <div className="mt-1.5 flex items-center gap-1 min-w-0 overflow-hidden" data-ghost-chips={chips.length}>
      {shown.map((c) => {
        const m = CHIP_STATUS[c.status];
        const focused = c.change_id === focusChangeId;
        return (
          <button
            key={c.change_id}
            type="button"
            onClick={(e) => { e.stopPropagation(); onFocusChange?.(c.change_id); }}
            onPointerDown={(e) => e.stopPropagation()}
            className="nodrag inline-flex items-center gap-1 text-[10px] px-1.5 h-[18px] rounded-md truncate max-w-[120px] transition-[box-shadow]"
            style={{ border: m.border, color: m.color, background: focused ? `color-mix(in srgb, ${m.color} 14%, transparent)` : GHOST.fill, boxShadow: focused ? `0 0 0 1.5px ${m.color}` : undefined }}
            title={c.line}
            data-ghost-chip={c.change_id}
            aria-pressed={focused}
          >
            {c.kind === "routine" && <Clock className="w-2.5 h-2.5 shrink-0" />}
            <span className="truncate">{c.line}</span>
          </button>
        );
      })}
      {rest.length > 0 && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onFocusChange?.(rest[0].change_id); }}
          onPointerDown={(e) => e.stopPropagation()}
          className="nodrag text-[10px] shrink-0"
          style={{ color: GHOST.color }}
          title={rest.map((c) => c.line).join("\n")}
        >
          +{rest.length}
        </button>
      )}
    </div>
  );
}

/** Accept, Edit, Skip: a pill strip hanging off the bottom edge of the card.
 *  Accepted and applied changes show their word instead; a failed one keeps
 *  its actions (it stays decidable). */
function GhostActions({ meta, data }: { meta: OrgGhostMeta; data: CardData }) {
  const decided = meta.status === "accepted" || meta.status === "applied";
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const btn = "nodrag inline-flex items-center gap-1 h-[22px] px-2 text-[10.5px] font-semibold transition-colors hover:brightness-110";
  return (
    <div
      className="absolute left-1/2 -translate-x-1/2 -bottom-[13px] flex items-center rounded-full border overflow-hidden shadow-sm"
      style={{ background: "var(--sol-card)", borderColor: `color-mix(in srgb, ${decided ? "var(--sol-cyan)" : "var(--sol-violet)"} 45%, transparent)` }}
      onPointerDown={stop}
      onClick={stop}
      data-ghost-actions={meta.change_id}
    >
      {decided ? (
        <span className="inline-flex items-center gap-1 h-[22px] px-2.5 text-[10.5px] font-semibold" style={{ color: meta.status === "applied" ? "var(--sol-green)" : "var(--sol-cyan)" }}>
          <Check className="w-3 h-3" /> {meta.status}
        </span>
      ) : (
        <>
          {meta.status === "failed" && <span className="h-[22px] px-2 inline-flex items-center text-[10px] font-medium" style={{ color: "var(--sol-red)" }}>failed</span>}
          <button type="button" className={btn} style={{ color: "var(--sol-cyan)" }} onClick={() => data.onDecideChange?.(meta.change_id, "accept")} aria-label="Accept" title={meta.line}>
            <Check className="w-3 h-3" /> Accept
          </button>
          <button type="button" className={btn} style={{ color: "var(--sol-text-muted)", borderLeft: "1px solid color-mix(in srgb, var(--sol-border) 40%, transparent)" }} onClick={(e) => data.onEditChange?.(meta.change_id, { x: e.clientX, y: e.clientY })} aria-label="Edit">
            <Pencil className="w-3 h-3" /> Edit
          </button>
          <button type="button" className={btn} style={{ color: "var(--sol-text-dim)", borderLeft: "1px solid color-mix(in srgb, var(--sol-border) 40%, transparent)" }} onClick={() => data.onDecideChange?.(meta.change_id, "skip")} aria-label="Skip">
            <X className="w-3 h-3" /> Skip
          </button>
        </>
      )}
    </div>
  );
}

/** The change whose action row this card shows: its own stub always, else
 *  the retire, move or chip the chart is focused on. */
function actionMetaOf(data: CardData): OrgGhostMeta | null {
  if (data.ghost) return data.ghost;
  const id = data.focusChangeId;
  if (!id) return null;
  if (data.retire?.change_id === id) return data.retire;
  if (data.move?.change_id === id) return data.move;
  return data.chips?.find((c) => c.change_id === id) ?? null;
}

/** The frame styling of a ghost stub: dashed violet, no plate, 55% content. */
function ghostFrameStyle(stub: OrgGhostStub): React.CSSProperties {
  return stub.solid
    ? { borderTopWidth: 3, borderTopColor: "var(--sol-cyan)", background: "var(--sol-card)" }
    : { border: GHOST.border, borderTopWidth: 1.5, background: GHOST.fill };
}

function Ports() {
  // Edges need handles; the cards hide them so the tree reads as plain lines.
  const hidden = { opacity: 0, width: 1, height: 1, minWidth: 1, minHeight: 1, border: 0, background: "transparent", pointerEvents: "none" as const };
  return (
    <>
      <Handle type="target" position={Position.Top} style={hidden} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} style={hidden} isConnectable={false} />
    </>
  );
}

function Frame({
  children, selected, dropTarget, dragging, className, style, accent,
}: {
  children: ReactNode; selected?: boolean; dropTarget?: boolean; dragging?: boolean; className?: string; style?: React.CSSProperties;
  /** The colour the selection ring and the drop halo take. */
  accent?: string;
}) {
  const ring = dropTarget
    ? `0 0 0 2px var(--sol-bg), 0 0 0 4px ${accent ?? "var(--sol-cyan)"}, 0 12px 28px -12px ${accent ?? "var(--sol-cyan)"}`
    : selected
      ? `0 0 0 2px var(--sol-bg), 0 0 0 3.5px ${accent ?? "var(--sol-cyan)"}`
      : dragging
        ? "0 18px 40px -14px rgba(0,0,0,0.45)"
        : "0 1px 0 rgba(0,0,0,0.04), 0 6px 18px -14px rgba(0,0,0,0.25)";
  return (
    <div
      className={cn("relative w-full h-full rounded-xl border transition-[box-shadow,transform] duration-150", className)}
      style={{
        background: "var(--sol-card)",
        borderColor: dropTarget ? (accent ?? "var(--sol-cyan)") : "color-mix(in srgb, var(--sol-border) 38%, transparent)",
        boxShadow: ring,
        transform: dropTarget ? "scale(1.02)" : undefined,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function CollapseToggle({ collapsed, hidden, onClick }: { collapsed: boolean; hidden: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      onPointerDown={(e) => e.stopPropagation()}
      className="nodrag inline-flex items-center gap-1 h-[22px] px-1.5 rounded-md text-[10.5px] font-medium tabular-nums border transition-colors hover:bg-sol-bg-highlight"
      style={{ borderColor: "color-mix(in srgb, var(--sol-border) 40%, transparent)", color: "var(--sol-text-muted)" }}
      title={collapsed ? `Expand (${hidden} hidden)` : "Collapse"}
      aria-label={collapsed ? "Expand" : "Collapse"}
    >
      {collapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
      {collapsed && <span>{hidden}</span>}
    </button>
  );
}

/** One line for a standing agent: a dot and word in its declared colour, then
 *  its pinned line. The role card, the anchor card and the panels share it. */
export function StandingLine({ standing, className, size = "sm" }: { standing: OrgStandingState | null | undefined; className?: string; size?: "sm" | "md" }) {
  const line = standingLineOf(standing);
  if (!line) return null;
  return (
    <div className={cn("flex items-center gap-1.5 min-w-0", size === "sm" ? "text-[10.5px]" : "text-[11.5px]", className)} title={line.text ?? undefined}>
      <span className="shrink-0 w-[7px] h-[7px] rounded-full" style={{ background: line.color }} aria-hidden />
      <span className="shrink-0 font-medium" style={{ color: line.color }}>{line.label}</span>
      {line.text && (
        <>
          <span aria-hidden style={{ color: "var(--sol-text-dim)" }}>·</span>
          <span className="truncate" style={{ color: "var(--sol-text-muted)" }}>{line.text}</span>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- person

export type PersonNodeData = CardData & { person: OrgPerson; collapsed: boolean; hidden: number; overflow: number };

/** "+174 · 60 needs input · 4 working": what the stack does not draw, and
 *  what in the whole set needs a human or is live. The state words come from
 *  ORG_STATE_META so this card, the anchor card, the panel chip and the inbox
 *  never name one state two ways. Nothing when everything is drawn. */
export function OverflowTally({ overflow, counts }: { overflow: number; counts: StateCounts }) {
  if (overflow <= 0) return null;
  const parts: { text: string; color?: string }[] = [{ text: `+${overflow}` }];
  for (const k of ["needs_input", "working"] as const) {
    if ((counts[k] ?? 0) > 0) parts.push({ text: `${counts[k]} ${ORG_STATE_META[k].label}`, color: ORG_STATE_META[k].color });
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10.5px] tabular-nums whitespace-nowrap" style={{ color: "var(--sol-text-dim)" }}>
      {parts.map((p, i) => (
        <span key={p.text} className="inline-flex items-center gap-1">
          {i > 0 && <span aria-hidden>·</span>}
          <span style={{ color: p.color }}>{p.text}</span>
        </span>
      ))}
    </span>
  );
}

const PRESENCE: Record<NonNullable<OrgPerson["presence"]>, string> = {
  online: "var(--sol-green)",
  away: "var(--sol-yellow)",
  offline: "color-mix(in srgb, var(--sol-border) 50%, transparent)",
};

export const PersonCard = memo(function PersonCard({ id, data }: NodeProps<Node<PersonNodeData>>) {
  const { person: p, collapsed, hidden, overflow } = data;
  const action = actionMetaOf(data);
  return (
    <Frame selected={data.selected} dropTarget={data.dropTarget} accent="var(--sol-cyan)" className="px-3 py-2.5">
      <Ports />
      <FlagDots flags={data.flags} />
      {action && <GhostActions meta={action} data={data} />}
      <div className="flex items-center gap-2.5">
        <div className="relative shrink-0">
          <div className="rounded-full p-[2px]" style={{ background: p.is_me ? "linear-gradient(135deg, var(--sol-cyan), var(--sol-blue))" : "color-mix(in srgb, var(--sol-border) 45%, transparent)" }}>
            <div className="rounded-full p-[2px]" style={{ background: "var(--sol-card)" }}>
              <Avatar name={p.name} image={p.image} size="md" />
            </div>
          </div>
          {p.presence && (
            <span className="absolute -bottom-[1px] -right-[1px] w-[9px] h-[9px] rounded-full border-2" style={{ background: PRESENCE[p.presence], borderColor: "var(--sol-card)" }} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="truncate text-[14px] leading-tight font-semibold tracking-tight" style={{ fontFamily: "var(--font-serif)", color: "var(--sol-text)" }}>
              {p.name}
            </span>
            {p.is_me && <span className="shrink-0 text-[9.5px] px-1 rounded-sm font-medium" style={{ background: "color-mix(in srgb, var(--sol-cyan) 14%, transparent)", color: "var(--sol-cyan)" }}>you</span>}
          </div>
          <div className="mt-[3px] flex items-center gap-1.5 text-[10.5px] whitespace-nowrap overflow-hidden" style={{ color: "var(--sol-text-dim)" }}>
            {p.role === "owner" ? <Crown className="w-3 h-3 shrink-0" /> : p.role === "admin" ? <Shield className="w-3 h-3 shrink-0" /> : null}
            <span className="capitalize">{p.role}</span>
            <span aria-hidden>·</span>
            <span className="tabular-nums truncate">{p.total} session{p.total === 1 ? "" : "s"}</span>
          </div>
        </div>
        <CollapseToggle collapsed={collapsed} hidden={hidden} onClick={() => data.onToggleCollapse?.(id)} />
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <StateBar counts={p.counts} className="flex-1" />
        <OverflowTally overflow={overflow} counts={p.counts} />
      </div>
      <GhostChips chips={data.chips} focusChangeId={data.focusChangeId} onFocusChange={data.onFocusChange} />
    </Frame>
  );
});

// ---------------------------------------------------------------- role

export type RoleNodeData = CardData & { role: OrgRole; collapsed: boolean; hidden: number; overflow: number };

export const RoleCard = memo(function RoleCard({ id, data }: NodeProps<Node<RoleNodeData>>) {
  const { role: r, collapsed, hidden, overflow } = data;
  const chips = [
    ...r.scope_names.projects.map((p) => ({ key: `p:${p.id}`, label: p.title, kind: "project" as const })),
    ...r.scope_names.plans.map((p) => ({ key: `l:${p.id}`, label: p.short_id || p.title, kind: "plan" as const })),
  ];
  const wholeWorkspace = r.scope.project_ids.length === 0 && r.scope.plan_ids.length === 0;
  const paused = r.status === "paused";
  // The seat's colour is its standing agent's own declared status when it has
  // one; the hand tally below stays a proportion, never the seat's colour.
  const standing = standingLineOf(r.standing);
  const plate = standing?.color ?? "var(--sol-violet)";
  // A ghost (org-staffing.md S5): a proposed role, dashed and translucent
  // until accepted, then solid until org.tree echoes the real row. A retire
  // proposal hatches the card. Neither takes a state stripe or a plate.
  const ghost = data.ghost;
  const dim = !!ghost && !ghost.solid;
  const action = actionMetaOf(data);
  return (
    <Frame
      selected={data.selected}
      dropTarget={data.dropTarget}
      dragging={data.dragging}
      accent="var(--sol-violet)"
      className="px-3 pt-3 pb-2.5"
      style={ghost ? ghostFrameStyle(ghost) : {
        // A seat: a double rule at the top, like a name plate on a desk.
        borderTopWidth: 3,
        borderTopColor: paused ? `color-mix(in srgb, ${plate} 40%, transparent)` : plate,
        background: "linear-gradient(180deg, color-mix(in srgb, var(--sol-violet) 7%, var(--sol-card)) 0%, var(--sol-card) 42%)",
        opacity: paused ? 0.75 : 1,
      }}
    >
      <Ports />
      {data.retire && <div aria-hidden className="absolute inset-0 rounded-xl pointer-events-none" style={{ background: GHOST.hatch }} data-ghost-retire={data.retire.change_id} />}
      <FlagDots flags={data.flags} />
      {action && <GhostActions meta={action} data={data} />}
      {ghost ? (
        <span
          className="absolute -top-[11px] left-3 flex items-center gap-1 h-[18px] px-1.5 rounded-md text-[10px] font-medium"
          style={{ border: dim ? GHOST.border : "1.5px solid var(--sol-cyan)", background: "var(--sol-card)", color: dim ? GHOST.color : "var(--sol-cyan)", fontFamily: "var(--font-mono)", opacity: dim ? GHOST.opacity : 1 }}
        >
          @{r.handle}
        </span>
      ) : (
        <Link
          href={`/org/${r.short_id}`}
          onClick={(e) => e.stopPropagation()}
          className="nodrag absolute -top-[11px] left-3 flex items-center gap-1 h-[18px] px-1.5 rounded-md text-[10px] font-medium hover:brightness-110"
          style={{ background: "var(--sol-violet)", color: "var(--sol-bg)", fontFamily: "var(--font-mono)" }}
          title="Open the scope page"
        >
          @{r.handle}
        </Link>
      )}
      <div style={{ opacity: dim ? GHOST.opacity : 1 }}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] leading-tight font-semibold tracking-tight" style={{ fontFamily: "var(--font-serif)", color: "var(--sol-text)" }}>
            {r.name}
          </div>
          <div className="mt-[3px] text-[10.5px] flex items-center gap-1.5 whitespace-nowrap overflow-hidden" style={{ color: "var(--sol-text-dim)" }}>
            <span>role</span>
            {paused && <span className="px-1 rounded-sm" style={{ background: "color-mix(in srgb, var(--sol-yellow) 14%, transparent)", color: "var(--sol-yellow)" }}>paused</span>}
            {ghost && <GhostTag label={ghost.solid ? ghost.status : "proposed"} status={ghost.status === "failed" ? "failed" : ghost.solid ? "accepted" : "proposed"} />}
            {data.retire && <GhostTag label="retire" status={data.retire.status} />}
            {!ghost && (
              <>
                <span aria-hidden>·</span>
                <span className="tabular-nums">{r.total} session{r.total === 1 ? "" : "s"}</span>
              </>
            )}
          </div>
        </div>
        {!ghost && <CollapseToggle collapsed={collapsed} hidden={hidden} onClick={() => data.onToggleCollapse?.(id)} />}
      </div>
      <StandingLine standing={r.standing} className="mt-1.5" />
      <div className="mt-2 flex items-center gap-1 min-w-0 overflow-hidden">
        {wholeWorkspace ? (
          <span className="text-[10px] px-1.5 h-[18px] inline-flex items-center rounded-md border" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 40%, transparent)", color: "var(--sol-text-dim)" }}>
            whole workspace
          </span>
        ) : (
          <>
            {chips.slice(0, 3).map((c) => (
              <span
                key={c.key}
                className="text-[10px] px-1.5 h-[18px] inline-flex items-center rounded-md truncate max-w-[96px]"
                style={{
                  background: c.kind === "project" ? "color-mix(in srgb, var(--sol-blue) 12%, transparent)" : "color-mix(in srgb, var(--sol-magenta) 12%, transparent)",
                  color: c.kind === "project" ? "var(--sol-blue)" : "var(--sol-magenta)",
                  fontFamily: c.kind === "plan" ? "var(--font-mono)" : undefined,
                }}
                title={c.label}
              >
                {c.label}
              </span>
            ))}
            {chips.length > 3 && <span className="text-[10px]" style={{ color: "var(--sol-text-dim)" }}>+{chips.length - 3}</span>}
          </>
        )}
      </div>
      {!ghost && (
        <div className="mt-2 flex items-center gap-2">
          <StateBar counts={r.counts} className="flex-1" />
          <OverflowTally overflow={overflow} counts={r.counts} />
        </div>
      )}
      </div>
      <GhostChips chips={data.chips} focusChangeId={data.focusChangeId} onFocusChange={data.onFocusChange} />
    </Frame>
  );
});

// ---------------------------------------------------------------- anchor

export type AnchorNodeData = CardData & { anchor: OrgAnchor };

export const AnchorCard = memo(function AnchorCard({ data }: NodeProps<Node<AnchorNodeData>>) {
  const a = data.anchor;
  const st = a.state ? ORG_STATE_META[a.state] : null;
  const live = a.state === "working";
  return (
    <Frame
      selected={data.selected}
      accent="var(--sol-orange)"
      className="px-3 py-2 flex items-center gap-2.5"
      style={{ borderRadius: 999, background: "color-mix(in srgb, var(--sol-orange) 6%, var(--sol-card))" }}
    >
      <Ports />
      <span className="relative shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-full" style={{ background: "color-mix(in srgb, var(--sol-orange) 16%, transparent)", color: "var(--sol-orange)" }}>
        <AnchorGlyph className="w-3.5 h-3.5" strokeWidth={1.75} />
        {live && <span className="absolute inset-0 rounded-full animate-ping" style={{ background: "color-mix(in srgb, var(--sol-green) 30%, transparent)" }} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-semibold leading-tight" style={{ color: "var(--sol-text)" }}>{a.name}</div>
        <div className="text-[10px] leading-tight mt-[2px] flex items-center gap-1.5" style={{ color: "var(--sol-text-dim)" }}>
          <span>standing agent</span>
          {st && (
            <>
              <span aria-hidden>·</span>
              <span style={{ color: st.color }}>{st.label}</span>
            </>
          )}
        </div>
        <StandingLine standing={a} className="mt-[3px]" />
      </div>
    </Frame>
  );
});

// ---------------------------------------------------------------- session

export type SessionNodeData = CardData & { session: OrgSession; parent: OrgParentRef };

export const SessionCard = memo(function SessionCard({ data }: NodeProps<Node<SessionNodeData>>) {
  const s = data.session;
  const st = ORG_STATE_META[s.state] ?? ORG_STATE_META.idle;
  const now = useCoarseNow(30_000);
  // An adopt ghost (org-staffing.md S5): the session offered as the role's
  // standing session. Dashed, no state stripe; "this session" when it is the
  // one the viewer is looking from.
  const ghost = data.ghost;
  const dim = !!ghost && !ghost.solid;
  if (ghost) {
    return (
      <Frame selected={data.selected} accent="var(--sol-violet)" className="pl-3 pr-2.5 py-1.5 flex items-center gap-2" style={{ borderRadius: 10, ...ghostFrameStyle(ghost), borderTopWidth: 1.5 }}>
        <Ports />
        <GhostActions meta={ghost} data={data} />
        <div className="flex items-center gap-2 min-w-0 flex-1" style={{ opacity: dim ? GHOST.opacity : 1 }}>
          <span className="inline-flex items-center justify-center w-6 h-6 rounded-md shrink-0" style={{ background: GHOST.fill, color: GHOST.color }}>
            <Sparkles className="w-3.5 h-3.5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] leading-[1.25] font-medium" style={{ color: "var(--sol-text)" }} title={ghost.line}>{s.title}</div>
            <div className="flex items-center gap-1.5 text-[9.5px] leading-tight mt-[1px]" style={{ color: "var(--sol-text-dim)", fontFamily: "var(--font-mono)" }}>
              <span>{s.short_id}</span>
              <span aria-hidden>·</span>
              <span>becomes the standing session</span>
            </div>
          </div>
          <GhostTag label={ghost.this_session ? "this session" : ghost.solid ? ghost.status : "proposed"} status={ghost.status === "failed" ? "failed" : ghost.solid ? "accepted" : "proposed"} />
        </div>
      </Frame>
    );
  }
  return (
    <Frame selected={data.selected} dragging={data.dragging} accent={st.color} className="pl-3.5 pr-2.5 py-1.5 flex items-center gap-2 overflow-hidden" style={{ borderRadius: 10 }}>
      <Ports />
      <span className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: st.color, opacity: s.state === "idle" ? 0.4 : 1 }} aria-hidden />
      {s.state === "working" && (
        <span className="absolute left-0 top-0 bottom-0 w-[3px] animate-pulse" style={{ background: st.color, opacity: 0.5 }} aria-hidden />
      )}
      <AgentIcon agentType={s.agent_type} className="w-4 h-4" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] leading-[1.25] font-medium" style={{ color: "var(--sol-text)" }} title={s.title}>
          {s.title || "Untitled"}
        </div>
        <div className="flex items-center gap-1.5 text-[9.5px] leading-tight mt-[1px]" style={{ color: "var(--sol-text-dim)", fontFamily: "var(--font-mono)" }}>
          <span>{s.short_id}</span>
          {s.git_branch && (
            <>
              <span aria-hidden>·</span>
              <span className="truncate max-w-[80px]">{s.git_branch}</span>
            </>
          )}
        </div>
      </div>
      <div className="shrink-0 flex items-center gap-1.5">
        {s.subagent_count > 0 && (
          <span
            className="inline-flex items-center gap-[3px] h-[16px] px-1 rounded-[5px] text-[9.5px] font-semibold tabular-nums"
            style={{ background: "color-mix(in srgb, var(--sol-violet) 14%, transparent)", color: "var(--sol-violet)" }}
            title={`${s.subagent_count} subagent${s.subagent_count === 1 ? "" : "s"}`}
          >
            <GitFork className="w-2.5 h-2.5" />
            {s.subagent_count}
          </span>
        )}
        <span className="text-[10px] tabular-nums" style={{ color: "var(--sol-text-dim)" }}>{compactAge(now - s.updated_at)}</span>
      </div>
    </Frame>
  );
});

// ---------------------------------------------------------------- cluster

export type ClusterNodeData = CardData & { parent: OrgParentRef; remaining: number; loaded: number; total: number; counts: StateCounts; fullyLoaded: boolean; parentId: string };

export const ClusterCard = memo(function ClusterCard({ data }: NodeProps<Node<ClusterNodeData>>) {
  const more = data.remaining > 0;
  return (
    <button
      type="button"
      className="nodrag group relative w-full h-full rounded-[10px] border border-dashed text-left px-3 py-1.5 flex items-center gap-2.5 transition-colors hover:bg-sol-bg-highlight/60"
      style={{
        borderColor: "color-mix(in srgb, var(--sol-border) 55%, transparent)",
        background: "color-mix(in srgb, var(--sol-bg-alt) 55%, transparent)",
        boxShadow: data.selected ? "0 0 0 2px var(--sol-bg), 0 0 0 3.5px var(--sol-cyan)" : undefined,
      }}
      onClick={(e) => { e.stopPropagation(); more ? data.onExpandCluster?.(data.parentId) : data.onCollapseCluster?.(data.parentId); }}
      onPointerDown={(e) => e.stopPropagation()}
      disabled={data.loadingCluster}
      title={more ? `Show ${Math.min(8, data.remaining)} more` : "Show fewer"}
    >
      <Ports />
      <span className="inline-flex items-center justify-center w-6 h-6 rounded-md shrink-0" style={{ background: "color-mix(in srgb, var(--sol-border) 22%, transparent)", color: "var(--sol-text-muted)" }}>
        <Layers className="w-3.5 h-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-semibold leading-tight tabular-nums" style={{ color: "var(--sol-text-secondary)" }}>
          {data.loadingCluster ? "Loading…" : more ? `+${data.remaining} more` : "Show fewer"}
        </div>
        <div className="mt-[3px]"><StateTally counts={data.counts} dim /></div>
      </div>
      <ChevronDown className={cn("w-3.5 h-3.5 shrink-0 transition-transform", !more && "rotate-180")} style={{ color: "var(--sol-text-dim)" }} />
    </button>
  );
});

