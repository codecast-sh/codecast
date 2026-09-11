"use client";
// The five org cards: person, role, anchor, session, cluster. React Flow node
// renderers, painted with the app's Solarized tokens. State colours are the
// inbox's: needs input amber (THREAD_STATE_STATUS_META.blocked), working green,
// done cyan, dormant blue, idle dim.
import { memo, type ReactNode } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { ChevronDown, ChevronRight, GitFork, Layers, Anchor as AnchorGlyph, Shield, Crown } from "lucide-react";
import type { WorkState } from "@codecast/shared/contracts";
import { THREAD_STATE_STATUS_META } from "../../lib/threadState";
import { AgentIcon } from "../ConversationList";
import { Avatar } from "../tasks/TaskCommentStream";
import { compactAge } from "../../lib/threadState";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { cn } from "../../lib/utils";
import type { OrgAnchor, OrgPerson, OrgRole, OrgSession, StateCounts, OrgParentRef } from "./orgTypes";
import { ORG_STATE_ORDER } from "./orgTypes";

// ---------------------------------------------------------------- state meta

export const ORG_STATE_META: Record<WorkState, { label: string; color: string; chip: string }> = {
  needs_input: { label: "needs input", color: "var(--sol-yellow)", chip: THREAD_STATE_STATUS_META.blocked.chip },
  working: { label: "working", color: "var(--sol-green)", chip: THREAD_STATE_STATUS_META.working.chip },
  dormant: { label: "dormant", color: "var(--sol-blue)", chip: THREAD_STATE_STATUS_META.dormant.chip },
  done: { label: "done", color: "var(--sol-cyan)", chip: THREAD_STATE_STATUS_META.done.chip },
  idle: { label: "idle", color: "var(--sol-text-dim)", chip: "bg-sol-bg-highlight text-sol-text-dim border-sol-border/30" },
};

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

/** The five number tally: "3 · 2 · 0 · 4 · 1", each number in its state colour. */
export function StateTally({ counts, dim }: { counts: StateCounts; dim?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 tabular-nums text-[10.5px] font-medium">
      {ORG_STATE_ORDER.map((k) => (
        <span key={k} className="inline-flex items-center gap-[3px]" title={ORG_STATE_META[k].label}>
          <span className="w-[6px] h-[6px] rounded-full" style={{ background: ORG_STATE_META[k].color, opacity: (counts[k] ?? 0) === 0 ? 0.25 : 1 }} />
          <span style={{ color: (counts[k] ?? 0) === 0 || dim ? "var(--sol-text-dim)" : "var(--sol-text-secondary)" }}>{counts[k] ?? 0}</span>
        </span>
      ))}
    </span>
  );
}

function sumCounts(c: StateCounts): number {
  return ORG_STATE_ORDER.reduce((n, k) => n + (c[k] ?? 0), 0);
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
};

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

// ---------------------------------------------------------------- person

export type PersonNodeData = CardData & { person: OrgPerson; collapsed: boolean; hidden: number };

const PRESENCE: Record<NonNullable<OrgPerson["presence"]>, string> = {
  online: "var(--sol-green)",
  away: "var(--sol-yellow)",
  offline: "color-mix(in srgb, var(--sol-border) 50%, transparent)",
};

export const PersonCard = memo(function PersonCard({ id, data }: NodeProps<Node<PersonNodeData>>) {
  const { person: p, collapsed, hidden } = data;
  const total = sumCounts(p.counts);
  return (
    <Frame selected={data.selected} dropTarget={data.dropTarget} accent="var(--sol-cyan)" className="px-3 py-2.5">
      <Ports />
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
          <div className="mt-[3px] flex items-center gap-1.5 text-[10.5px]" style={{ color: "var(--sol-text-dim)" }}>
            {p.role === "owner" ? <Crown className="w-3 h-3" /> : p.role === "admin" ? <Shield className="w-3 h-3" /> : null}
            <span className="capitalize">{p.role}</span>
            <span aria-hidden>·</span>
            <span className="tabular-nums">{p.total} session{p.total === 1 ? "" : "s"}</span>
          </div>
        </div>
        <CollapseToggle collapsed={collapsed} hidden={hidden} onClick={() => data.onToggleCollapse?.(id)} />
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <StateBar counts={p.counts} className="flex-1" />
        {total > 0 && (
          <span className="shrink-0 text-[10px] tabular-nums font-medium" style={{ color: (p.counts.needs_input ?? 0) > 0 ? "var(--sol-yellow)" : "var(--sol-text-dim)" }}>
            {(p.counts.needs_input ?? 0) > 0 ? `${p.counts.needs_input} waiting` : `${p.counts.working ?? 0} live`}
          </span>
        )}
      </div>
    </Frame>
  );
});

// ---------------------------------------------------------------- role

export type RoleNodeData = CardData & { role: OrgRole; collapsed: boolean; hidden: number };

export const RoleCard = memo(function RoleCard({ id, data }: NodeProps<Node<RoleNodeData>>) {
  const { role: r, collapsed, hidden } = data;
  const chips = [
    ...r.scope_names.projects.map((p) => ({ key: `p:${p.id}`, label: p.title, kind: "project" as const })),
    ...r.scope_names.plans.map((p) => ({ key: `l:${p.id}`, label: p.short_id || p.title, kind: "plan" as const })),
  ];
  const wholeWorkspace = r.scope.project_ids.length === 0 && r.scope.plan_ids.length === 0;
  const paused = r.status === "paused";
  return (
    <Frame
      selected={data.selected}
      dropTarget={data.dropTarget}
      dragging={data.dragging}
      accent="var(--sol-violet)"
      className="px-3 pt-3 pb-2.5"
      style={{
        // A seat: a double rule at the top, like a name plate on a desk.
        borderTopWidth: 3,
        borderTopColor: paused ? "color-mix(in srgb, var(--sol-violet) 40%, transparent)" : "var(--sol-violet)",
        background: "linear-gradient(180deg, color-mix(in srgb, var(--sol-violet) 7%, var(--sol-card)) 0%, var(--sol-card) 42%)",
        opacity: paused ? 0.75 : 1,
      }}
    >
      <Ports />
      <div className="absolute -top-[11px] left-3 flex items-center gap-1 h-[18px] px-1.5 rounded-md text-[10px] font-medium" style={{ background: "var(--sol-violet)", color: "var(--sol-bg)", fontFamily: "var(--font-mono)" }}>
        @{r.handle}
      </div>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] leading-tight font-semibold tracking-tight" style={{ fontFamily: "var(--font-serif)", color: "var(--sol-text)" }}>
            {r.name}
          </div>
          <div className="mt-[3px] text-[10.5px] flex items-center gap-1.5" style={{ color: "var(--sol-text-dim)" }}>
            <span>role</span>
            {paused && <span className="px-1 rounded-sm" style={{ background: "color-mix(in srgb, var(--sol-yellow) 14%, transparent)", color: "var(--sol-yellow)" }}>paused</span>}
            <span aria-hidden>·</span>
            <span className="tabular-nums">{r.total} session{r.total === 1 ? "" : "s"}</span>
          </div>
        </div>
        <CollapseToggle collapsed={collapsed} hidden={hidden} onClick={() => data.onToggleCollapse?.(id)} />
      </div>
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
      <StateBar counts={r.counts} className="mt-2" />
    </Frame>
  );
});

// ---------------------------------------------------------------- anchor

export type AnchorNodeData = CardData & { anchor: OrgAnchor };

export const AnchorCard = memo(function AnchorCard({ data }: NodeProps<Node<AnchorNodeData>>) {
  const a = data.anchor;
  const st = a.work_state ? ORG_STATE_META[a.work_state] : null;
  const live = a.work_state === "working";
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
      </div>
    </Frame>
  );
});

// ---------------------------------------------------------------- session

export type SessionNodeData = CardData & { session: OrgSession; parent: OrgParentRef };

export const SessionCard = memo(function SessionCard({ data }: NodeProps<Node<SessionNodeData>>) {
  const s = data.session;
  const st = ORG_STATE_META[s.work_state] ?? ORG_STATE_META.idle;
  const now = useCoarseNow(30_000);
  return (
    <Frame selected={data.selected} dragging={data.dragging} accent={st.color} className="pl-3.5 pr-2.5 py-1.5 flex items-center gap-2 overflow-hidden" style={{ borderRadius: 10 }}>
      <Ports />
      <span className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: st.color, opacity: s.work_state === "idle" ? 0.4 : 1 }} aria-hidden />
      {s.work_state === "working" && (
        <span className="absolute left-0 top-0 bottom-0 w-[3px] animate-pulse" style={{ background: st.color, opacity: 0.5 }} aria-hidden />
      )}
      <AgentIcon agentType={s.agent_type} className="w-4 h-4" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] leading-[1.25] font-medium" style={{ color: "var(--sol-text)" }} title={s.title}>
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

export const ORG_NODE_TYPES = {
  person: PersonCard,
  role: RoleCard,
  anchor: AnchorCard,
  session: SessionCard,
  cluster: ClusterCard,
};
