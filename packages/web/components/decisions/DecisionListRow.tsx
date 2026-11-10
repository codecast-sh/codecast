"use client";
// One decision in the Decisions list: what it asks, then its facts at a
// glance (escalated, blocking, unread comments, kind, where it came from, its area, the people
// its problem reached, its findings and how bad the worst is, how long it has
// waited) and its owner, whose
// face opens the assign step for this row. A fact the row's group already
// names is left off the row.
import { memo, type ReactNode } from "react";
import { ArrowUpRight, CircleDot, SquareStack, UserRoundPlus, Users } from "lucide-react";
import type { SessionDecisionItem } from "../../store/inboxStore";
import type { ItemRowState } from "../ListRowShell";
import { ShortId } from "../ShortId";
import { ageShort } from "../../lib/lineFlow";
import { severityBand } from "../../lib/line/decisionFacts";
import { DecisionThreadUnread } from "./DecisionThreadUnread";
import { decisionKindOf, decisionOwner, decisionSourceOf, isEscalated, ownerKey, DECISION_KIND_LABEL, SESSION_SOURCE, type DecisionAxis } from "../../lib/decisions/decisionRows";

export type DecisionRowCtx = {
  now: number;
  /** The axes the list groups by: their facts are the group's name. */
  grouped: ReadonlySet<DecisionAxis>;
  areaName: (projectId: string) => string;
  owner: (key: string) => { label: string; face: ReactNode } | null;
  /** A narrow column (the list beside a reader): the question, its problem's numbers, its age and its owner's face. */
  compact?: boolean;
};

const SEV_CLASS: Record<string, string> = { high: "text-sol-red", mid: "text-sol-orange", low: "text-sol-text-dim" };

export const DecisionListRow = memo(function DecisionListRow({ d, state, ctx }: { d: SessionDecisionItem; state: ItemRowState; ctx: DecisionRowCtx }) {
  const owner = decisionOwner(d);
  const who = owner ? ctx.owner(ownerKey(owner)) : null;
  const source = decisionSourceOf(d);
  const band = severityBand(d.problem_severity ?? null);
  const open = d.status === "pending";
  return (
    <div className="flex-1 min-w-0 flex items-center gap-3" data-decision-row={d.short_id ?? d._id} data-decision-owner={ownerKey(owner)}>
      <span className="w-3.5 flex-shrink-0 flex items-center justify-center">
        {isEscalated(d) ? <ArrowUpRight className="w-3.5 h-3.5 text-sol-red" aria-label="Escalated" />
          : open && d.blocking ? <CircleDot className="w-3 h-3 text-sol-yellow" aria-label="Blocking" />
          : null}
      </span>
      {d.short_id && !ctx.compact && <ShortId id={d.short_id} className="text-xs text-sol-text-dim w-14 flex-shrink-0 cq-hide-compact" />}
      <span className={`flex-1 text-sm truncate ${open ? "text-sol-text" : "text-sol-text-muted"}`}>{d.question}</span>
      <span className="flex items-center gap-2 flex-shrink-0 text-[11px] text-sol-text-dim">
        <DecisionThreadUnread decisionId={d._id} />
        {!open && <span className="text-sol-green">{d.status === "dismissed" ? "Dismissed" : d.answer_text ?? (d.answer_index != null ? d.options[d.answer_index]?.label : "Answered")}</span>}
        {!!d.problem_reach && <span className="flex items-center gap-0.5 tabular-nums" title={`${d.problem_reach} ${d.problem_reach === 1 ? "person" : "people"} reached`} data-decision-reach><Users className="w-3 h-3" aria-hidden />{d.problem_reach}</span>}
        {!!d.problem_findings && <span className="flex items-center gap-0.5 tabular-nums" title={`${d.problem_findings} ${d.problem_findings === 1 ? "finding" : "findings"}`} data-decision-findings><SquareStack className="w-3 h-3" aria-hidden />{d.problem_findings}</span>}
        {band && <span className={`tabular-nums ${SEV_CLASS[band] ?? ""}`} title={`Worst finding: severity ${d.problem_severity} of 10`}>{d.problem_severity}</span>}
        {!ctx.compact && !ctx.grouped.has("kind") && <span className="px-1.5 rounded border border-sol-border/40">{DECISION_KIND_LABEL[decisionKindOf(d)]}</span>}
        {!ctx.compact && !ctx.grouped.has("source") && source !== SESSION_SOURCE && <span className="max-w-[9rem] truncate cq-hide-compact">{source}</span>}
        {!ctx.compact && !ctx.grouped.has("area") && d.area_project_id && <span className="max-w-[9rem] truncate cq-hide-compact">{ctx.areaName(d.area_project_id)}</span>}
        <span className="tabular-nums w-8 text-right" title={new Date(d.created_at).toLocaleString()}>{ageShort(ctx.now - d.created_at)}</span>
        <button type="button" onClick={(e) => { e.stopPropagation(); if (open) state.onOpenPalette("assign"); }}
          className="flex items-center gap-1.5 min-w-0 max-w-[9rem] hover:text-sol-text" title={who ? `Owner: ${who.label}` : "Assign"} aria-label={who ? `Owner ${who.label}; reassign` : "Assign"} data-decision-assign>
          {who ? <span className="w-4 h-4 flex items-center justify-center flex-shrink-0">{who.face}</span> : <UserRoundPlus className="w-3.5 h-3.5 flex-shrink-0" />}
          {who && !ctx.compact && !ctx.grouped.has("owner") && <span className="truncate cq-hide-compact">{who.label}</span>}
        </button>
      </span>
    </div>
  );
});
