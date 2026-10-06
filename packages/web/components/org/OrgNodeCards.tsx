"use client";
// The four org cards: person, role, session, cluster. React Flow node
// renderers, painted with the app's Solarized tokens. State colours are the
// inbox's: needs input amber (THREAD_STATE_STATUS_META.blocked), working green,
// done cyan, dormant blue, idle dim.
import { memo, type ReactNode } from "react";
import { ShortId } from "../ShortId";
import { ProjectLeadMark } from "../charter/ProjectLeadChip";
import Link from "next/link";
import { Handle, Position, useStore, type NodeProps, type Node } from "@xyflow/react";
import { ChevronDown, ChevronRight, GitFork, Layers, Shield, Crown, Check, Pencil, Clock, Sparkles, AlertTriangle } from "lucide-react";
import { Avatar } from "../tasks/TaskCommentStream";
import { compactAge } from "../../lib/threadState";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { cn } from "../../lib/utils";
import { isHeadOfPeople } from "../../lib/retireRole";
import type { OrgPerson, OrgRole, OrgSession, StateCounts, OrgParentRef } from "./orgTypes";
import { ORG_STATE_ORDER } from "./orgTypes";
import { CHANGE_KIND_WORD, GHOST, ORG_STATE_META, SEVERITY_META, standingLineOf } from "./orgMeta";
import { RoleFace } from "./RoleFace";
import { useZoomLevel } from "./orgZoom";
import { GhostTag } from "./ghostChrome";
import { CHIP_STATUS, ghostFrameStyle } from "./orgMeta";
import { RoleHoverCard, SessionIdentityLine, SessionMark } from "../identity";
import type { OrgStandingState } from "./orgTypes";
import type { HealthFlag, OrgChangeStatus } from "./orgStaffingTypes";
import { isHeadOfPeopleRole, roleWords } from "./orgStaffingTypes";
import type { OrgGhostChip, OrgGhostMeta, OrgGhostMove, OrgGhostStub } from "./orgLayout";
import { ORG_SIZES, roleMetaLine, runningSessions, seatRowHeight } from "./orgLayout";
import { seatSentence } from "@codecast/shared/contracts/orgProposal";
import { FLAG_LABEL } from "./staffingModel";
import { RoleWeekBody } from "./orgFlowViz";
import type { RoleFlow } from "./orgFlow";
import type { GhostAnswers } from "./ProposalLedger";
import { AnswerControls, LEDGER_INKS, pendingAnswerWords, useAnswerField } from "./ProposalSubjectCard";

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
  /** What the role's area holds today (org.health's ledger): the close card's open work line. */
  ledger?: { open_tasks: number; in_flight: number; active_plans: number };
  // Ghosts (S5): what an open proposal draws on this card, from the layout.
  ghost?: OrgGhostStub;
  retire?: OrgGhostMeta;
  move?: OrgGhostMove;
  chips?: OrgGhostChip[];
  /** The change the chart is focused on: its action row shows on its card. */
  focusChangeId?: string | null;
  onFocusChange?: (changeId: string) => void;
  /** The pending answers of the proposal's cards, by change (useGhostAnswers), and the write into that batch. Absent: the strips draw read only. */
  answers?: GhostAnswers["byChange"];
  onAnswerChange?: GhostAnswers["onAnswer"];
  /** Edit: the graph opens the hire dialog (a role) or an inline form (the rest) at the click. */
  onEditChange?: (changeId: string, at: { x: number; y: number }) => void;
};

// ---------------------------------------------------------------- ghosts + flags

/** One dot per blocker or warning, worst first, the code and detail on hover.
 *  The severity is in the dot's shape (SEVERITY_META): a blocker is filled, a
 *  warning is a ring; an info flag draws nothing here (the pane lists it).
 *  Sits on the card's top right so it never competes with the name. */
function FlagDots({ flags }: { flags?: HealthFlag[] }) {
  const rank = { blocker: 0, warn: 1, info: 2 } as const;
  const sorted = (flags ?? []).filter((f) => SEVERITY_META[f.severity].dot !== "none").sort((a, b) => rank[a.severity] - rank[b.severity]);
  if (sorted.length === 0) return null;
  return (
    <span className="absolute -top-[5px] right-2.5 flex items-center gap-[3px]" data-flags={sorted.map((f) => f.code).join(",")}>
      {sorted.map((f, i) => {
        const m = SEVERITY_META[f.severity];
        return (
          <span
            key={`${f.code}:${i}`}
            className="w-[10px] h-[10px] rounded-full box-border"
            style={m.dot === "filled"
              ? { background: m.color, boxShadow: "0 0 0 2px var(--sol-card)" }
              : { background: "var(--sol-card)", border: `2px solid ${m.color}`, boxShadow: "0 0 0 1.5px var(--sol-card)" }}
            title={`${m.word}: ${FLAG_LABEL[f.code]}. ${f.detail}`}
            aria-label={`${m.word}: ${FLAG_LABEL[f.code]}. ${f.detail}`}
            data-severity={f.severity}
          />
        );
      })}
    </span>
  );
}

/** One mark per change on this card. Each reads the delta alone (the card
 *  already names the role); the full sentence is its title. A change whose
 *  handle nothing answers to is a warning. A click focuses the change (the
 *  pane shows its rationale, the card its actions). Framed, three share a
 *  row then "+N"; `quiet` (a goal card, any card at close) draws each as its
 *  own plain line in the change's colour, read whole, three then "+N more"
 *  (orgLayout.quietChipLines books the rows). Never dashed. */
export function GhostChips({ chips, focusChangeId, onFocusChange, quiet }: { chips?: OrgGhostChip[]; focusChangeId?: string | null; onFocusChange?: (id: string) => void; quiet?: boolean }) {
  if (!chips?.length) return null;
  const shown = chips.slice(0, quiet ? ORG_SIZES.quietChipMax : 3);
  const rest = chips.slice(shown.length);
  // One or two chips have the row to themselves; three share it.
  const cap = chips.length <= 1 ? "max-w-[200px]" : chips.length === 2 ? "max-w-[100px]" : "max-w-[66px]";
  return (
    <div className={quiet ? "min-w-0" : "mt-1.5 flex items-center gap-1 min-w-0 overflow-hidden"} data-ghost-chips={chips.length}>
      {shown.map((c) => {
        const color = (c.unresolved ? CHIP_STATUS.failed : CHIP_STATUS[c.status]).color;
        const focused = c.change_id === focusChangeId;
        const tint = (pct: number) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;
        return (
          <button
            key={c.change_id}
            type="button"
            onClick={(e) => { e.stopPropagation(); onFocusChange?.(c.change_id); }}
            onPointerDown={(e) => e.stopPropagation()}
            className={cn("nodrag items-center gap-1 truncate", quiet ? "flex w-full min-w-0 rounded-[4px] text-left text-[10.5px] hover:underline" : cn("inline-flex text-[10px] px-1.5 h-[18px] rounded-md transition-[box-shadow]", cap))}
            style={quiet
              ? { height: ORG_SIZES.quietChipRow, color, background: focused ? tint(14) : undefined }
              : { border: `1px solid ${tint(45)}`, color, background: tint(focused ? 14 : 8), boxShadow: focused ? `0 0 0 1.5px ${color}` : undefined }}
            title={c.unresolved ? `${c.line}. Nothing in this workspace answers to that handle: skip it, or edit the handle.` : c.line}
            data-ghost-chip={c.change_id}
            data-unresolved={c.unresolved ? "" : undefined}
            aria-pressed={focused}
          >
            {c.unresolved ? <AlertTriangle className="w-2.5 h-2.5 shrink-0" /> : c.kind === "routine" ? <Clock className="w-2.5 h-2.5 shrink-0" /> : null}
            <span className="truncate">{c.chip}</span>
          </button>
        );
      })}
      {rest.length > 0 && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onFocusChange?.(rest[0].change_id); }}
          onPointerDown={(e) => e.stopPropagation()}
          className={quiet ? "nodrag flex w-full items-center text-left text-[10.5px] hover:underline" : "nodrag text-[10px] shrink-0"}
          style={{ color: GHOST.color, ...(quiet ? { height: ORG_SIZES.quietChipRow, opacity: 0.8 } : {}) }}
          title={rest.map((c) => c.line).join("\n")}
          data-ghost-chips-more={rest.length}
        >
          +{rest.length}{quiet ? " more" : ""}
        </button>
      )}
    </div>
  );
}
/** The strip's height in CSS px: 34 on a pointer (the ledger's 28px controls
 *  inside a pill), 44 on touch (the class below switches on the coarse
 *  pointer media query). The goals layout books GOALS_SIZES.actionRow for it. */
const STRIP_H = 34;

/** Approve, Reject, Reply, Edit: a pill strip hanging off the bottom edge of
 *  the card, led by the kind of change it acts on ("move · Approve · Reject ·
 *  Reply · Edit"), so a card carrying several changes never leaves the person
 *  guessing. The answers are the ledger's own controls (ProposalSubjectCard)
 *  over the same batch: nothing fires on a press, the answer waits for the
 *  next message, and under the strip the ghost says so in words ("Approved,
 *  on your next message", "Rejected: too soon"). Reply opens the ledger's
 *  field under the strip. Edit (accept with edits) is the one direct verdict.
 *  The strip is scaled by the inverse of the canvas zoom (up to a limit) so
 *  its hit size does not shrink with the tree. Accepted and applied changes
 *  show their word instead; a failed one keeps its actions (it stays decidable). */
export type GhostActionHandlers = Pick<CardData, "chips" | "answers" | "onAnswerChange" | "onEditChange">;
export function GhostActions({ meta, word, data, below: belowProp }: { meta: OrgGhostMeta; word: string; data: GhostActionHandlers; /** Fully under the card (the goals lens reserves the row); default: only past a chips row. */ below?: boolean }) {
  const decided = meta.status === "accepted" || meta.status === "applied";
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  // The canvas zoom; only strips subscribe, so a zoom tick re-renders the one
  // or two cards showing a strip, never the whole tree.
  const zoom = useStore((s) => s.transform[2]);
  const scale = Math.min(1.75, Math.max(1, 1 / (zoom || 1)));
  const answer = data.answers?.[meta.change_id] ?? null;
  const { onAnswerChange } = data;
  const onAnswer = onAnswerChange ? (a: Parameters<GhostAnswers["onAnswer"]>[1]) => onAnswerChange(meta.change_id, a) : undefined;
  const { open, setOpen, field } = useAnswerField(answer, onAnswer, !decided);
  const rule = "1px solid color-mix(in srgb, var(--sol-border) 40%, transparent)";
  // Straddling the bottom edge on a plain card; fully below one that ends in
  // a chips row, so the strip never covers the chips (the level gap is 56px).
  // Anchored by its top: the words and the field grow downward from the pill.
  const below = belowProp ?? !!data.chips?.length;
  return (
    <div
      className={cn("nodrag nowheel absolute left-1/2 flex flex-col items-center gap-1", LEDGER_INKS)}
      style={{ top: `calc(100% ${below ? "+" : "-"} ${below ? 4 : STRIP_H / 2}px)`, transform: `translateX(-50%) scale(${scale})`, transformOrigin: "top center" }}
      onPointerDown={stop}
      onClick={stop}
      data-ghost-actions={meta.change_id}
      data-ghost-answer={answer?.verdict}
    >
      <div
        className="flex h-[34px] items-center overflow-hidden rounded-full border pr-1 shadow-sm [@media(pointer:coarse)]:h-[44px]"
        style={{ background: "var(--sol-card)", borderColor: `color-mix(in srgb, ${decided ? "var(--sol-cyan)" : "var(--sol-violet)"} 45%, transparent)` }}
      >
        <span className="inline-flex h-full items-center whitespace-nowrap pl-2 pr-1 text-[10px] font-medium uppercase tracking-[0.06em]" style={{ color: decided ? "var(--sol-text-dim)" : GHOST.color }} data-ghost-word={word}>{word}</span>
        {decided ? (
          <span className="inline-flex h-full items-center gap-1 pl-1 pr-1.5 text-[10.5px] font-semibold" style={{ color: meta.status === "applied" ? "var(--sol-green)" : "var(--sol-cyan)" }}>
            <Check className="w-3 h-3" /> {meta.status}
          </span>
        ) : (
          <>
            {meta.status === "failed" && <span className="inline-flex h-full items-center px-1.5 text-[10px] font-medium" style={{ color: "var(--sol-red)" }}>failed</span>}
            {onAnswer && (
              <span className="inline-flex items-center gap-0.5 whitespace-nowrap pl-1" style={{ borderLeft: rule }}>
                <AnswerControls answer={answer} retry={meta.status === "failed"} dense onAnswer={onAnswer} open={open} onOpen={setOpen} />
              </span>
            )}
            <button type="button" className="inline-flex h-7 items-center gap-1 px-1.5 text-[11px] font-normal transition-colors hover:bg-[color-mix(in_srgb,var(--sol-border)_16%,transparent)] hover:text-[color:var(--sol-text)] rounded-md" style={{ color: "var(--sol-text-muted)", marginLeft: onAnswer ? 2 : 0, ...(onAnswer ? {} : { borderLeft: rule, borderRadius: 0, height: "100%" }) }} onClick={(e) => data.onEditChange?.(meta.change_id, { x: e.clientX, y: e.clientY })} aria-label={`Edit ${word}`} title={meta.line} data-ghost-edit>
              <Pencil className="w-3 h-3" /> Edit
            </button>
          </>
        )}
      </div>
      {/* The ghost reads its answered state in words, as the card does; while the field is open the words are in it. */}
      {!decided && answer && !open && (
        <span className="max-w-[280px] truncate rounded-md px-2 py-[3px] text-[11px] leading-[16px] shadow-sm" style={{ background: "var(--sol-card)", color: answer.verdict === "reject" ? "var(--ink-red)" : "var(--sol-text-muted)", border: rule }} title={pendingAnswerWords(answer)} data-ghost-answered={answer.verdict}>{pendingAnswerWords(answer)}</span>
      )}
      {open && (
        <div className="w-[280px] rounded-lg border p-2 text-left shadow-md" style={{ background: "var(--sol-card)", borderColor: "color-mix(in srgb, var(--sol-violet) 45%, transparent)" }} data-ghost-reply>
          {field({})}
        </div>
      )}
    </div>
  );
}

/** The change whose action row this card shows, with the word the strip
 *  leads with: its own stub always, else the retire, move or chip the chart
 *  is focused on. */
function actionOf(data: CardData): { meta: OrgGhostMeta; word: string } | null {
  if (data.ghost) return { meta: data.ghost, word: CHANGE_KIND_WORD[data.ghost.kind] };
  const id = data.focusChangeId;
  if (!id) return null;
  if (data.retire?.change_id === id) return { meta: data.retire, word: CHANGE_KIND_WORD.retire };
  if (data.move?.change_id === id) return { meta: data.move, word: CHANGE_KIND_WORD.move };
  const chip = data.chips?.find((c) => c.change_id === id);
  return chip ? { meta: chip, word: CHANGE_KIND_WORD[chip.kind] ?? String(chip.kind) } : null;
}

export function Ports() {
  // Edges need handles; the cards hide them so the tree reads as plain lines.
  const hidden = { opacity: 0, width: 1, height: 1, minWidth: 1, minHeight: 1, border: 0, background: "transparent", pointerEvents: "none" as const };
  return (
    <>
      <Handle type="target" position={Position.Top} style={hidden} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} style={hidden} isConnectable={false} />
    </>
  );
}

export function Frame({
  children, selected, dropTarget, dragging, className, style, accent, kind,
}: {
  children: ReactNode; selected?: boolean; dropTarget?: boolean; dragging?: boolean; className?: string; style?: React.CSSProperties;
  /** The colour the selection ring and the drop halo take. */
  accent?: string;
  /** What the card is, for the tours to point at (data-org-node): me, person,
   *  head, role, session, ghost. */
  kind?: string;
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
      data-org-node={kind}
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
  // "+N" counts what the stack under the card does not draw; when nothing is
  // drawn under it (collapsed, the map) the meta line already says how many,
  // so the tally is the two states a person acts on.
  const total = ORG_STATE_ORDER.reduce((n, k) => n + (counts[k] ?? 0), 0);
  const parts: { text: string; color?: string }[] = overflow < total ? [{ text: `+${overflow}` }] : [];
  for (const k of ["needs_input", "working"] as const) {
    if ((counts[k] ?? 0) > 0) parts.push({ text: `${counts[k]} ${ORG_STATE_META[k].label}`, color: ORG_STATE_META[k].color });
  }
  if (parts.length === 0) return null;
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


/** The far card (orgZoom): the name, large, and one dot in the seat's colour. */
function FarBody({ name, color, hollow, dim }: { name: string; color: string; hollow?: boolean; dim?: boolean }) {
  return (
    <div className="flex h-full min-w-0 items-center gap-3" data-zoom-far>
      <span className="block h-[14px] w-[14px] shrink-0 rounded-full" style={hollow ? { border: `2px solid ${color}` } : { background: color }} aria-hidden />
      <span className="line-clamp-2 min-w-0 text-[24px] font-semibold leading-[27px] tracking-tight" style={{ fontFamily: "var(--font-serif)", color: "var(--sol-text)", opacity: dim ? GHOST.opacity : 1 }}>{name}</span>
    </div>
  );
}

/** The close card's running sessions, one line each (ORG_SIZES.runningRow). */
function RunningList({ holder }: { holder: { sessions: OrgSession[] } }) {
  const running = runningSessions(holder);
  if (running.length === 0) return null;
  return (
    <div className="mt-1.5" data-running={running.length}>
      {running.map((x) => (
        <div key={x._id} className="flex min-w-0 items-center gap-1.5 text-[10px]" style={{ height: ORG_SIZES.runningRow, color: "var(--sol-text-muted)" }}>
          <span className="h-[6px] w-[6px] shrink-0 rounded-full" style={{ background: ORG_STATE_META.working.color }} aria-hidden />
          <span className="shrink-0 font-mono" style={{ color: "var(--sol-text-dim)" }}>{x.short_id}</span>
          <span className="min-w-0 truncate">{x.title}</span>
        </div>
      ))}
    </div>
  );
}

/** The close card's line under the name, on a row of its own so it reads whole (ORG_SIZES.closeMetaRow). */
function CloseMeta({ children, dim }: { children: ReactNode; dim?: boolean }) {
  return <div className="text-[10.5px]" style={{ marginTop: ORG_SIZES.closeMetaRow - ORG_SIZES.closeMetaLine, lineHeight: `${ORG_SIZES.closeMetaLine}px`, color: "var(--sol-text-dim)", opacity: dim ? GHOST.opacity : 1 }} data-close-meta>{children}</div>;
}

/** The changes on a card: a row of chips, and at close a line each (ORG_SIZES.quietChipRow). */
function LevelChips({ data, close }: { data: CardData; close: boolean }) {
  if (!data.chips?.length) return null;
  const chips = <GhostChips chips={data.chips} focusChangeId={data.focusChangeId} onFocusChange={data.onFocusChange} quiet={close} />;
  return close ? <div className="mt-1.5">{chips}</div> : chips;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const PRESENCE: Record<NonNullable<OrgPerson["presence"]>, string> = {
  online: "var(--sol-green)",
  away: "var(--sol-yellow)",
  offline: "color-mix(in srgb, var(--sol-border) 50%, transparent)",
};

export const PersonCard = memo(function PersonCard({ id, data }: NodeProps<Node<PersonNodeData>>) {
  const { person: p, collapsed, hidden, overflow } = data;
  const action = actionOf(data);
  const level = useZoomLevel();
  if (level === "far") {
    return (
      <Frame selected={data.selected} dropTarget={data.dropTarget} accent="var(--sol-cyan)" className="px-3 py-2.5" kind={p.is_me ? "me" : "person"}>
        <Ports />
        <FarBody name={p.name} color={p.presence ? PRESENCE[p.presence] : PRESENCE.offline} />
      </Frame>
    );
  }
  const close = level === "close";
  const you = p.is_me && <span className="shrink-0 text-[9.5px] px-1 rounded-sm font-medium" style={{ background: "color-mix(in srgb, var(--sol-cyan) 14%, transparent)", color: "var(--sol-cyan)" }}>you</span>;
  const meta = (
    <>
      {p.role === "owner" ? <Crown className="w-3 h-3 shrink-0" /> : p.role === "admin" ? <Shield className="w-3 h-3 shrink-0" /> : null}
      <span className="capitalize">{p.role}</span>
      <span aria-hidden>·</span>
      <span className={cn("tabular-nums", !close && "truncate")}>{plural(p.total, "session")}</span>
    </>
  );
  return (
    <Frame selected={data.selected} dropTarget={data.dropTarget} accent="var(--sol-cyan)" className="px-3 py-2.5" kind={p.is_me ? "me" : "person"}>
      <Ports />
      <FlagDots flags={data.flags} />
      {action && <GhostActions meta={action.meta} word={action.word} data={data} />}
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
            {/* Close is for reading: the name takes a second line before it is cut. */}
            <span className={cn("text-[14px] leading-tight font-semibold tracking-tight", close ? "line-clamp-2" : "truncate")} style={{ fontFamily: "var(--font-serif)", color: "var(--sol-text)" }} title={p.name}>
              {p.name}
            </span>
            {!close && you}
          </div>
          {!close && <div className="mt-[3px] flex items-center gap-1.5 text-[10.5px] whitespace-nowrap overflow-hidden" style={{ color: "var(--sol-text-dim)" }}>{meta}</div>}
        </div>
        <CollapseToggle collapsed={collapsed} hidden={hidden} onClick={() => data.onToggleCollapse?.(id)} />
      </div>
      {close && <CloseMeta><span className="flex items-center gap-1.5">{you}{meta}</span></CloseMeta>}
      <div className="mt-2.5 flex items-center gap-2">
        <StateBar counts={p.counts} className="flex-1" />
        <OverflowTally overflow={overflow} counts={p.counts} />
      </div>
      <LevelChips data={data} close={close} />
      {close && <RunningList holder={p} />}
    </Frame>
  );
});

// ---------------------------------------------------------------- role

export type RoleNodeData = CardData & {
  role: OrgRole;
  collapsed: boolean;
  hidden: number;
  overflow: number;
  /** The tenure chip (S10), resolved by the layout where the whole tree is in
   *  hand (orgLayout.roleBranch). Absent on a standing seat, which says nothing. */
  tenure?: { short: string; full: string };
};

export const RoleCard = memo(function RoleCard({ id, data }: NodeProps<Node<RoleNodeData>>) {
  const { role: r, collapsed, hidden, overflow } = data;
  const chips = [
    ...r.scope_names.projects.map((p) => ({ key: `p:${p.id}`, id: p.id, label: p.title, kind: "project" as const })),
    ...r.scope_names.plans.map((p) => ({ key: `l:${p.id}`, id: p.id, label: p.title || p.short_id, kind: "plan" as const })),
  ];
  const noArea = r.scope.project_ids.length === 0 && r.scope.plan_ids.length === 0;
  const paused = r.status === "paused";
  // The seat's colour is its standing agent's own declared status when it has
  // one; the hand tally below stays a proportion, never the seat's colour.
  const standing = standingLineOf(r.standing);
  const plate = standing?.color ?? "var(--sol-violet)";
  // A ghost (org-staffing.md S5): a proposed role, tinted and translucent
  // until accepted, then solid until org.tree echoes the real row. A retire
  // proposal hatches the card. Neither takes a state stripe or a plate.
  const ghost = data.ghost;
  const dim = !!ghost && !ghost.solid;
  // A retire proposal fades the seat the way a pause does and hatches it:
  // removal must not read like the violet of an addition.
  const retiring = !!data.retire && data.retire.status !== "applied";
  const faded = paused || retiring;
  const action = actionOf(data);
  // The tenure chip (S10): standing is silent, a program names its end. The
  // layout resolved it against the whole tree, so the card paints a string and
  // repaints whenever the layout does.
  const tenure = data.tenure;
  const level = useZoomLevel();
  const close = level === "close";
  const frameStyle: React.CSSProperties = ghost ? ghostFrameStyle(ghost) : {
    // A seat: a double rule at the top, like a name plate on a desk.
    borderTopWidth: 3,
    borderTopColor: faded ? `color-mix(in srgb, ${plate} 40%, transparent)` : plate,
    background: "linear-gradient(180deg, color-mix(in srgb, var(--sol-violet) 7%, var(--sol-card)) 0%, var(--sol-card) 42%)",
    opacity: faded ? 0.75 : 1,
  };
  if (level === "far") {
    return (
      <Frame selected={data.selected} dropTarget={data.dropTarget && !ghost} dragging={data.dragging} accent="var(--sol-violet)" className="px-3 py-2.5" kind={ghost && !ghost.solid ? "ghost" : isHeadOfPeople(r) ? "head" : "role"} style={frameStyle}>
        <Ports />
        {data.retire && <div aria-hidden className="absolute inset-0 rounded-xl pointer-events-none" style={{ background: GHOST.hatch }} />}
        <FarBody name={roleWords(r).name} color={ghost && !ghost.solid ? GHOST.color : plate} hollow={!r.standing} dim={dim} />
      </Frame>
    );
  }
  return (
    <Frame
      selected={data.selected}
      // A stub is not a seat a card can be dropped on: nothing to reparent yet.
      dropTarget={data.dropTarget && !ghost}
      dragging={data.dragging}
      accent="var(--sol-violet)"
      className="px-3 pt-3 pb-2.5"
      kind={ghost && !ghost.solid ? "ghost" : isHeadOfPeople(r) ? "head" : "role"}
      style={frameStyle}
    >
      <Ports />
      {data.retire && <div aria-hidden className="absolute inset-0 rounded-xl pointer-events-none" style={{ background: GHOST.hatch }} data-ghost-retire={data.retire.change_id} />}
      <FlagDots flags={data.flags} />
      {action && <GhostActions meta={action.meta} word={action.word} data={data} />}
      {ghost ? (
        <span
          className="absolute -top-[11px] left-3 flex items-center gap-1 h-[18px] px-1.5 rounded-md text-[10px] font-medium"
          style={{ border: dim ? GHOST.frame : "1px solid var(--sol-cyan)", background: "var(--sol-card)", color: dim ? GHOST.color : "var(--sol-cyan)", fontFamily: "var(--font-mono)" }}
        >
          @{r.handle}
        </span>
      ) : (
        <Link
          href={`/org/${r.short_id}`}
          onClick={(e) => e.stopPropagation()}
          className="nodrag absolute -top-[11px] left-3 flex items-center gap-1 h-[18px] px-1.5 rounded-md text-[10px] font-medium hover:brightness-110"
          style={{ background: "var(--sol-violet)", color: "var(--sol-bg)", fontFamily: "var(--font-mono)" }}
          title="Open its page"
        >
          @{r.handle}
        </Link>
      )}
      {/* Only the name and the body copy take the ghost's 55%: the tags and
          the scope chips say WHAT is proposed and stay readable. */}
      <div>
      <div className="flex items-start gap-2">
        {/* What the role looks after is one hover away (org-roles-run-work.md
            R3). A proposed role has no row to describe yet, and a card must
            not open under a node that is being dragged. */}
        <RoleHoverCard role={r} side="right" disabled={!!ghost || !!data.dragging} triggerClassName="inline-flex shrink-0">
          <RoleFace role={r} size={30} className="mt-[1px]" />
        </RoleHoverCard>
        <div className="min-w-0 flex-1">
          <div className={cn("text-[14px] leading-tight font-semibold tracking-tight", close ? "line-clamp-2" : "truncate")} style={{ fontFamily: "var(--font-serif)", color: "var(--sol-text)", opacity: dim ? GHOST.opacity : 1 }}>
            <RoleHoverCard role={r} side="right" disabled={!!ghost || !!data.dragging} triggerClassName="inline">{roleWords(r).name}</RoleHoverCard>
          </div>
          {!close && <div className="mt-[3px] text-[10.5px] flex items-center gap-1.5 whitespace-nowrap overflow-hidden" style={{ color: "var(--sol-text-dim)" }}>
            {/* The role is the subtitle (S30): "Head of People", "Growth lead", "Executive Assistant, global". */}
            <span className="shrink-0 truncate max-w-[62%]" style={{ opacity: dim ? GHOST.opacity : 1 }} data-role-title>{roleWords(r).subtitle}</span>
            {paused && <span className="px-1 rounded-sm" style={{ background: "color-mix(in srgb, var(--sol-yellow) 14%, transparent)", color: "var(--sol-yellow)" }}>paused</span>}
            {ghost && <GhostTag quiet label={ghost.solid ? ghost.status : "proposed"} status={ghost.status === "failed" ? "failed" : ghost.solid ? "accepted" : "proposed"} />}
            {data.retire && <GhostTag quiet label="retire" status={data.retire.status} tone="color-mix(in srgb, var(--sol-red) 70%, var(--sol-text))" />}
            {/* The seat is the role (S16): the line says whether its standing
                agent is online, and counts only the hands under it. */}
            {/* The title keeps its room; what follows it gives way first. */}
            {!ghost && (
              <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                <span aria-hidden>·</span>
                <span data-role-seat={r.standing ? "online" : "none"}>{r.standing ? "started" : "not started"}</span>
                {r.total > 0 && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="tabular-nums">{r.total} session{r.total === 1 ? "" : "s"}</span>
                  </>
                )}
              </span>
            )}
          </div>}
        </div>
        {!ghost && <CollapseToggle collapsed={collapsed} hidden={hidden} onClick={() => data.onToggleCollapse?.(id)} />}
      </div>
      {/* Close: the same line, whole, on a row of its own (orgLayout.roleMetaLine sizes it). */}
      {close && (
        <CloseMeta>
          <span data-role-title>{roleMetaLine(r, !!ghost)}</span>
          {ghost && <> <GhostTag quiet label={ghost.solid ? ghost.status : "proposed"} status={ghost.status === "failed" ? "failed" : ghost.solid ? "accepted" : "proposed"} className="!inline" /></>}
          {data.retire && <> <GhostTag quiet label="retire" status={data.retire.status} tone="color-mix(in srgb, var(--sol-red) 70%, var(--sol-text))" className="!inline" /></>}
        </CloseMeta>
      )}
      {/* A program seat says when it ends, on its own line (S10): the meta line
          above is too narrow for it, and a truncated "p…" says nothing. A
          standing seat is silent and takes no row (ORG_SIZES.tenureRow). */}
      {tenure && (
        <div className="mt-1.5 flex items-center gap-1 min-w-0" style={{ opacity: dim ? GHOST.opacity : 1 }}>
          <Clock className="w-2.5 h-2.5 shrink-0" style={{ color: "var(--sol-violet)" }} />
          <span className="truncate text-[10px]" style={{ color: "var(--sol-violet)" }} title={tenure.full} data-tenure="">{tenure.short}</span>
        </div>
      )}
      {/* A ghost that names a session which already works as this role (R2)
          says what naming changes. It stays at full strength: it is the one
          thing on the card a person must read before they accept. */}
      {ghost?.seat && (
        <p className="mt-1.5 text-[10px] overflow-hidden" style={{ height: seatRowHeight(ghost.seat) - 6, lineHeight: `${ORG_SIZES.seatLine}px`, color: "var(--sol-text-muted)" }} title={seatSentence(ghost.seat)} data-ghost-seat={ghost.seat.existing}>
          {seatSentence(ghost.seat)}
        </p>
      )}
      <div style={{ opacity: dim ? GHOST.opacity : 1 }}><StandingLine standing={r.standing} className="mt-1.5" /></div>
      <div className="mt-2 flex items-center gap-1 min-w-0 overflow-hidden">
        {noArea ? (
          <span className="text-[10px] px-1.5 h-[18px] inline-flex items-center rounded-md border" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 40%, transparent)", color: "var(--sol-text-dim)" }}>
            {isHeadOfPeopleRole(r) ? "whole workspace" : "no area of its own"}
          </span>
        ) : (
          <>
            {chips.slice(0, 3).map((c) => (
              <span
                key={c.key}
                className="text-[10px] px-1.5 h-[18px] inline-flex items-center gap-1 rounded-md min-w-0 max-w-[120px]"
                style={{
                  background: c.kind === "project" ? "color-mix(in srgb, var(--sol-blue) 12%, transparent)" : "color-mix(in srgb, var(--sol-magenta) 12%, transparent)",
                  color: c.kind === "project" ? "var(--sol-blue)" : "var(--sol-magenta)",
                  fontFamily: c.kind === "plan" ? "var(--font-mono)" : undefined,
                }}
              >
                <span className="truncate" title={c.label}>{c.label}</span>
                {/* Who leads the project (org-roles-run-work.md R4): "lead" when
                    it is this role, the face of the role that does otherwise. A
                    ghost is not a role yet, so it leads nothing. */}
                {c.kind === "project" && !ghost && <ProjectLeadMark projectId={c.id} roleId={r._id} />}
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
      <LevelChips data={data} close={close} />
      {/* The close card (orgZoom): what the seat is for, in its own words, what its area holds, and what runs under it now. */}
      {close && r.charter?.trim() && (
        <p className="mt-1.5 line-clamp-2 text-[10px] leading-[14px]" style={{ height: ORG_SIZES.charterRows - 6, color: "var(--sol-text-muted)", opacity: dim ? GHOST.opacity : 1 }} title={r.charter} data-role-charter>{r.charter}</p>
      )}
      {close && !ghost && (
        <div className="flex min-w-0 items-center gap-1.5 text-[10px] tabular-nums whitespace-nowrap" style={{ height: ORG_SIZES.workRow, color: "var(--sol-text-muted)" }} data-role-work={data.ledger ? `${data.ledger.open_tasks}/${data.ledger.in_flight}/${data.ledger.active_plans}` : "unknown"}>
          {data.ledger && (
            <>
              <span title="Open tasks in its area">{plural(data.ledger.open_tasks, "task")}</span>
              <span aria-hidden style={{ color: "var(--sol-text-dim)" }}>·</span>
              <span title="Tasks being worked on now">{data.ledger.in_flight} in flight</span>
              <span aria-hidden style={{ color: "var(--sol-text-dim)" }}>·</span>
              <span className="min-w-0 truncate" title="Active plans in its area">{plural(data.ledger.active_plans, "plan")}</span>
            </>
          )}
        </div>
      )}
      {close && <RunningList holder={r} />}
    </Frame>
  );
});

// ---------------------------------------------------------------- session

export type SessionNodeData = CardData & { session: OrgSession; parent: OrgParentRef };

// ---------------------------------------------------------------- role, in health mode

export type HealthRoleNodeData = { role: OrgRole; selected?: boolean; flow: RoleFlow; days: string[] };

/** A role on the health map (HealthBoard): its week instead of its sessions.
 *  The top rule takes the area's status colour, so a stuck or overloaded seat
 *  reads across the whole chart before any number does. */
export const HealthRoleCard = memo(function HealthRoleCard({ data }: NodeProps<Node<HealthRoleNodeData>>) {
  const { flow: f } = data;
  return (
    <Frame selected={data.selected} accent={f.color} className="px-3 pt-3.5 pb-2.5" kind={isHeadOfPeople(data.role) ? "head" : "role"} style={{ borderTopWidth: 3, borderTopColor: f.color, opacity: data.role.status === "paused" ? 0.7 : 1 }}>
      <Ports />
      <span className="absolute -top-[11px] left-3 flex items-center h-[18px] px-1.5 rounded-md text-[10px] font-medium" style={{ background: "var(--sol-violet)", color: "var(--sol-bg)", fontFamily: "var(--font-mono)" }}>@{data.role.handle}</span>
      <RoleWeekBody f={f} days={data.days} />
    </Frame>
  );
});

export const SessionCard = memo(function SessionCard({ data }: NodeProps<Node<SessionNodeData>>) {
  const s = data.session;
  const st = ORG_STATE_META[s.state] ?? ORG_STATE_META.idle;
  const now = useCoarseNow(30_000);
  // An adopt ghost (org-staffing.md S5): the session offered as the role's
  // standing session. Dashed, no state stripe; "this session" when it is the
  // one the viewer is looking from.
  const ghost = data.ghost;
  const dim = !!ghost && !ghost.solid;
  const level = useZoomLevel();
  // Far (orgZoom): the title alone, large, on the state's stripe.
  if (level === "far" && !ghost) {
    return (
      <Frame selected={data.selected} dragging={data.dragging} accent={st.color} className="pl-3.5 pr-2.5 flex items-center overflow-hidden" style={{ borderRadius: 10 }} kind="session">
        <Ports />
        <span className="absolute left-0 top-0 bottom-0 w-[4px]" style={{ background: st.color, opacity: s.state === "idle" ? 0.4 : 1 }} aria-hidden />
        <span className="truncate text-[17px] font-medium tracking-tight" style={{ color: "var(--sol-text)" }} data-zoom-far>{s.title}</span>
      </Frame>
    );
  }
  if (ghost) {
    // An adopt stub is taller than a session row (ORG_SIZES.adoptRow): line
    // one names the session, line two the role it joins, in the ghost violet.
    const tagStatus = ghost.status === "failed" ? "failed" : ghost.solid ? "accepted" : "proposed";
    return (
      <Frame selected={data.selected} accent="var(--sol-violet)" className="pl-3 pr-2.5 py-1.5 flex items-center gap-2" style={{ borderRadius: 10, ...ghostFrameStyle(ghost), borderTopWidth: 1.5 }} kind={ghost.solid ? "session" : "ghost"}>
        <Ports />
        <GhostActions meta={ghost} word={CHANGE_KIND_WORD.adopt} data={data} />
        <span className="inline-flex items-center justify-center w-6 h-6 rounded-md shrink-0" style={{ background: GHOST.fill, color: GHOST.color, opacity: dim ? GHOST.opacity : 1 }}>
          <Sparkles className="w-3.5 h-3.5" />
        </span>
        <div className="min-w-0 flex-1" title={ghost.line}>
          <div className="flex items-baseline gap-1.5 whitespace-nowrap overflow-hidden">
            <span className="truncate text-[13px] leading-[1.25] font-medium" style={{ color: "var(--sol-text)", opacity: dim ? GHOST.opacity : 1 }}>{s.title}</span>
            <ShortId id={s.short_id} className="text-[9.5px]" style={{ color: "var(--sol-text-dim)" }} />
          </div>
          <div className="truncate text-[10.5px] leading-tight mt-[2px]" style={{ color: GHOST.color }} data-adopt-line>
            becomes {ghost.role_handle ? `@${ghost.role_handle}'s` : "the role's"} standing session
          </div>
        </div>
        <span className="shrink-0 flex flex-col items-end gap-[3px]">
          <GhostTag quiet label={ghost.solid ? ghost.status : "adopt"} status={tagStatus} />
          {ghost.this_session && <GhostTag quiet label="this session" status={tagStatus} />}
        </span>
      </Frame>
    );
  }
  return (
    <Frame selected={data.selected} dragging={data.dragging} accent={st.color} className="pl-3.5 pr-2.5 py-1.5 flex items-center gap-2 overflow-hidden" style={{ borderRadius: 10 }} kind="session">
      <Ports />
      <span className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: st.color, opacity: s.state === "idle" ? 0.4 : 1 }} aria-hidden />
      {s.state === "working" && (
        <span className="absolute left-0 top-0 bottom-0 w-[3px] animate-pulse" style={{ background: st.color, opacity: 0.5 }} aria-hidden />
      )}
      {/* Who the session is (session-characters.md S3), the agent brand on
          its corner; a session nobody personified keeps the brand alone. */}
      <SessionMark session={s as any} size={20} iconClassName="w-4 h-4" className="shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 text-[13px] leading-[1.25]" title={s.title}>
          <SessionIdentityLine row={s as any} title={s.title || "Untitled"} titleClassName="font-medium" />
        </div>
        <div className="flex items-center gap-1.5 text-[9.5px] leading-tight mt-[1px] whitespace-nowrap" style={{ color: "var(--sol-text-dim)", fontFamily: "var(--font-mono)" }}>
          <span className="shrink-0" style={{ color: st.color, opacity: s.state === "idle" ? 0.7 : 1 }} data-session-state={s.state}>{st.label}</span>
          <span aria-hidden>·</span>
          <ShortId id={s.short_id} />
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
      className="nodrag group relative w-full h-full rounded-[10px] border text-left px-3 py-1.5 flex items-center gap-2.5 transition-colors hover:bg-sol-bg-highlight/60"
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

