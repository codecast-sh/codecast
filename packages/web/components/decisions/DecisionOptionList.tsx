"use client";

import type { ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import type { DecisionOption } from "../../store/inboxStore";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";

// One option, wherever a decision renders: the queue card, the transcript
// card, the answer controls, the document page. The row carries the number
// the digit key answers, the label, and what choosing it means directly
// beneath the label. Never a pill here and its meaning somewhere else: the
// reader compares consequences in the same place they click. Cost, risk,
// evidence and a body render when the option carries them, so the same row
// serves a two line `cast decide` and a full document option.
//
// The whole row is the click target when onPick is given (single answers,
// multi toggles). A rank row passes its arrows as `trailing` and no onPick,
// since a button cannot nest buttons.
export type OptionTone = "primary" | "picked" | "plain";

export function DecisionOptionRow({
  option,
  position,
  keys = false,
  onPick,
  tone = "plain",
  leading,
  trailing,
  tags,
  compact = false,
}: {
  option: DecisionOption;
  /** Zero based position in the rendered list; the digit shown is position + 1. */
  position: number;
  /** Whether the digit keys are live on this surface (renders the number as a key cap). */
  keys?: boolean;
  onPick?: () => void;
  tone?: OptionTone;
  /** Replaces the number badge (a checkbox on a multi). */
  leading?: ReactNode;
  /** Controls at the row's end (a rank's arrows). */
  trailing?: ReactNode;
  /** Small marks after the label: recommended, the agent's default. */
  tags?: ReactNode;
  compact?: boolean;
}) {
  const label = option.label.replace(" (Recommended)", "");
  const border =
    tone === "picked"
      ? "border-sol-green/50 bg-sol-green/5"
      : tone === "primary"
        ? "border-sol-yellow/50"
        : "border-sol-border/70";
  const hover = onPick
    ? tone === "picked"
      ? "hover:bg-sol-green/10"
      : tone === "primary"
        ? "hover:bg-sol-yellow/10 hover:border-sol-yellow"
        : "hover:bg-sol-card hover:border-sol-text-dim"
    : "";
  const pad = compact ? "px-3 py-2" : "px-4 py-3";
  const number = position < 9 ? String(position + 1) : "·";
  const badge = leading ?? (
    keys ? (
      <KeyCap size={compact ? "xs" : "sm"}>{number}</KeyCap>
    ) : (
      <span className={`flex items-center justify-center rounded-full border font-mono text-sol-text-dim ${compact ? "w-5 h-5 text-[10px]" : "w-6 h-6 text-[11px]"} ${tone === "picked" ? "border-sol-green text-sol-green" : "border-sol-border"}`}>
        {number}
      </span>
    )
  );
  const extras = (option.cost || option.risk || option.evidence?.length) ? (
    <div className={`mt-1.5 flex flex-wrap gap-x-4 gap-y-1 ${compact ? "text-[11px]" : "text-[12px]"}`}>
      {option.cost && <span><span className="text-sol-text-dim">cost </span><span className="text-sol-text">{option.cost}</span></span>}
      {option.risk && <span><span className="text-sol-text-dim">risk </span><span className="text-sol-orange">{option.risk}</span></span>}
      {option.evidence?.map((e, k) => (
        <a key={k} href={e.url} target="_blank" rel="noreferrer" onClick={(ev) => ev.stopPropagation()} className="inline-flex items-center gap-1 text-sol-blue hover:underline">
          {e.label}<ExternalLink className="w-3 h-3" />
        </a>
      ))}
    </div>
  ) : null;

  const body = (
    <>
      <span className={`shrink-0 ${compact ? "mt-[3px]" : "mt-[2px]"}`}>{badge}</span>
      <span className="min-w-0 flex-1 text-left">
        <span className="flex items-center gap-2 flex-wrap">
          <span className={`${compact ? "text-[13px]" : "text-[15px]"} leading-snug text-sol-text`}>{label}</span>
          {tags}
        </span>
        {option.description && (
          <span className={`block mt-0.5 leading-snug text-sol-text-muted ${compact ? "text-[12px]" : "text-sm"}`}>{option.description}</span>
        )}
        {option.body_md && (
          <span className={`block mt-1.5 text-sol-text-muted decision-option-body ${compact ? "text-[12px]" : "text-sm"}`}><MarkdownRenderer content={option.body_md} /></span>
        )}
        {extras}
      </span>
      {trailing && <span className="shrink-0 flex items-center gap-0.5 self-center">{trailing}</span>}
    </>
  );
  const cls = `decision-option w-full flex items-start gap-3 rounded-lg border transition-colors ${pad} ${border} ${hover}`;
  return onPick ? (
    <button type="button" onClick={onPick} className={cls} data-option={position}>{body}</button>
  ) : (
    <div className={cls} data-option={position}>{body}</div>
  );
}

// The options as one column of rows. `tone` and `tags` are per position so a
// single can mark its primary, a multi its picks, a recorded answer its
// chosen. Compact rows are the queue card's; full rows the document page's.
export function DecisionOptionList({
  options,
  keys = false,
  onPick,
  tone,
  tags,
  leading,
  trailing,
  compact = false,
}: {
  options: DecisionOption[];
  keys?: boolean;
  onPick?: (position: number) => void;
  tone?: (position: number) => OptionTone;
  tags?: (position: number) => ReactNode;
  leading?: (position: number) => ReactNode;
  trailing?: (position: number) => ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "space-y-1.5" : "space-y-2"} data-option-list>
      {options.map((o, n) => (
        <DecisionOptionRow
          key={n}
          option={o}
          position={n}
          keys={keys}
          onPick={onPick ? () => onPick(n) : undefined}
          tone={tone?.(n)}
          tags={tags?.(n)}
          leading={leading?.(n)}
          trailing={trailing?.(n)}
          compact={compact}
        />
      ))}
    </div>
  );
}

// The typed answer affordance under a list: a low key line, not a fourth
// option. `keys` shows the t key that opens it.
export function TypeAnswerButton({ onOpen, keys = false }: { onOpen: () => void; keys?: boolean }) {
  return (
    <button type="button" onClick={onOpen} className="flex items-center gap-1.5 text-[12px] text-sol-text-dim hover:text-sol-text transition-colors">
      {keys && <KeyCap size="xs">t</KeyCap>}<span>or type an answer in your own words</span>
    </button>
  );
}
