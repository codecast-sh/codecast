"use client";
// One line of the company (cohesive build spec §6): a goal, a project, a role
// or a person on the one grid every line shares, so the columns hold still
// when a filter swaps one kind for another.
//
//   [chev][glyph][title][owner][state][measure][date]
//
// The title opens the object (a sheet inside the Org screen, its address
// anywhere else); a click on the row's background or its chevron opens the
// line in place. Enter opens, Space and the arrows expand and fold. The
// owner and state cells hold the same pickers the sheet uses, and a click in
// them stays in them. A proposal's line is violet and says where it is
// answered instead of filling columns it cannot fill yet.
import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { objectHref } from "@codecast/shared/entities";
import { cn } from "../../../lib/utils";
import type { ProposalRef } from "../../company/companyModel";
import { lightChanges, useChangeLit } from "./changeLight";
import { proposalChangeHref, useLineOpen, useProposalOpen, type LineTarget } from "./lineOpen";
import "./lines.css";

/** How far one level of depth indents a line's chevron. */
const INDENT = 18;

export type LineKind = "goal" | "project" | "role" | "person";

export type LineGhost = {
  /** Where it is answered; absent while the proposal's row has not arrived. */
  proposal?: ProposalRef;
  /** The changes the line draws: hovering it lights their cards in the conversation. */
  changeIds: readonly string[];
  /** The line above it already says where this proposal is answered: its
   *  answer cell stays empty instead of repeating the same words. */
  quiet?: boolean;
};

export type ObjectLineProps = {
  kind: LineKind;
  /** The row's key in the document (its expansion key). */
  id: string;
  /** What the title opens; absent for a line that names nothing openable yet (a proposed goal). */
  target?: LineTarget;
  glyph: ReactNode;
  title: string;
  /** A quiet word after the title: "you", "new role", "moves here from Make revenue". */
  sub?: ReactNode;
  owner?: ReactNode;
  /** The line sits under the sheet of the one who would fill its owner
   *  cell: the cell and the face are left out and the title takes their room. */
  hideOwner?: boolean;
  /** Who answers for it as a face alone, shown after the title when the
   *  pane is too narrow for the owner column. */
  face?: ReactNode;
  state?: ReactNode;
  measure?: ReactNode;
  date?: ReactNode;
  depth?: number;
  /** Present when the line opens in place. */
  expanded?: boolean;
  onToggle?: () => void;
  ghost?: LineGhost;
  selected?: boolean;
  className?: string;
} & Record<`data-${string}`, string | number | undefined>;

/** Clicks inside a control, or inside a popover a control opened (a portal
 *  is outside the row in the DOM but inside it in React), are the control's. */
function ownClick(e: React.SyntheticEvent): boolean {
  const target = e.target as Element;
  if (!e.currentTarget.contains(target)) return true;
  return !!target.closest?.("a, button, input, textarea, select, [role='menuitem'], [data-line-stop]");
}

const NO_CHANGES: readonly string[] = [];

export function ObjectLine({ kind, id, target, glyph, title, sub, owner: ownerCell, hideOwner, face: faceCell, state, measure, date, depth = 0, expanded, onToggle, ghost, selected, className, ...data }: ObjectLineProps) {
  const { open, onLinkClick } = useLineOpen();
  const owner = hideOwner ? null : ownerCell;
  const face = hideOwner ? null : faceCell;
  const answer = useProposalOpen();
  const expandable = !!onToggle;
  const style = { "--ol-indent": `${depth * INDENT}px` } as CSSProperties;

  const onClick = (e: React.MouseEvent) => {
    if (ownClick(e)) return;
    if (expandable) onToggle!();
    else if (target) open(target);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" && target) { e.preventDefault(); open(target); }
    else if (expandable && (e.key === " " || (e.key === "ArrowRight" && !expanded) || (e.key === "ArrowLeft" && expanded))) { e.preventDefault(); onToggle!(); }
  };
  // The light runs both ways: pointing at this line lights its cards in the
  // conversation, and pointing at one of those cards lights this line.
  const lit = useChangeLit(ghost?.changeIds ?? NO_CHANGES) && !!ghost;
  const light = ghost ? { onMouseEnter: () => lightChanges(ghost.changeIds), onMouseLeave: () => lightChanges(null), onFocus: () => lightChanges(ghost.changeIds), onBlur: () => lightChanges(null) } : {};

  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={expandable ? !!expanded : undefined}
      aria-selected={selected || undefined}
      tabIndex={0}
      className={cn("ol-line", className)}
      style={style}
      onClick={onClick}
      onKeyDown={onKeyDown}
      {...light}
      data-line={kind}
      data-line-id={id}
      data-expandable={expandable || undefined}
      data-ghost={ghost ? "" : undefined}
      data-owned={owner != null ? "" : undefined}
      data-no-owner={hideOwner || undefined}
      data-lit={lit || undefined}
      data-selected={selected || undefined}
      {...data}
    >
      {expandable
        ? <button type="button" className="ol-chev" aria-label={expanded ? `Fold ${title}` : `Open ${title} here`} tabIndex={-1} onClick={(e) => { e.stopPropagation(); onToggle!(); }} data-line-chev><ChevronRight className="h-3 w-3" /></button>
        : <span className="ol-chev" aria-hidden style={{ cursor: "default" }} />}
      <span className="ol-glyph" aria-hidden>{glyph}</span>
      <span className="ol-title">
        {target
          ? <Link href={objectHref(target.kind, target.ref)} className="ol-name" title={title} onClick={onLinkClick(target)} tabIndex={-1} data-line-title>{title}</Link>
          : <span className="ol-name" title={title} data-line-title>{title}</span>}
        {sub != null && sub !== false && <span className="ol-sub" title={typeof sub === "string" ? sub : undefined} data-line-sub>{sub}</span>}
        {face != null && <span className="ol-face" aria-hidden>{face}</span>}
      </span>
      {owner != null && <span className="ol-owner" data-line-owner>{owner}</span>}
      {ghost ? (
        ghost.quiet
          ? <span className="ol-answer" aria-hidden data-line-answer="" />
          : ghost.proposal
          ? <Link href={proposalChangeHref(ghost.proposal)} className="ol-answer" onClick={answer(ghost.proposal)} data-line-answer={ghost.proposal.short_id} title="Answer in the conversation">{ghost.proposal.short_id}<span className="ol-answer-words"> · answer in the conversation</span></Link>
          : <span className="ol-answer" data-line-answer="">answer in the conversation</span>
      ) : (
        <>
          {state != null && <span className="ol-state" data-line-state>{state}</span>}
          {measure != null && <span className="ol-measure" data-line-measure>{measure}</span>}
          {date != null && <span className="ol-date" data-line-date>{date}</span>}
        </>
      )}
    </div>
  );
}

/** What a line opens to in place: the prose under its title, indented to it. */
export function LineBody({ depth = 0, children, ...data }: { depth?: number; children: ReactNode } & Record<`data-${string}`, string | number | undefined>) {
  return <div className="ol-body" style={{ "--ol-indent": `${depth * INDENT}px` } as CSSProperties} {...data}>{children}</div>;
}
