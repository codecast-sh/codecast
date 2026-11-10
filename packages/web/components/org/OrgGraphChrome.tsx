// The org canvas's overlays (OrgGraph.tsx): the marked-cards bar and the
// edge cues that pan to hidden root cards.
import { ChevronLeft, ChevronRight } from "lucide-react";
import { OrgButton } from "./OrgButton";
import { KeyCap } from "../KeyboardShortcutsHelp";
import type { CueCard } from "./orgFlowElements";

/** What is marked, and what to do with it: the count, Move to…, and Clear. */
export function SelectionBar({ count, right, onMove, onClear }: { count: number; right: number; onMove?: () => void; onClear: () => void }) {
  return (
    <div className="pointer-events-none absolute bottom-4 left-0 z-20 flex justify-center" style={{ right }} data-org-selection={count}>
      <div className="pointer-events-auto flex items-center gap-1 rounded-xl border p-1 pl-3 shadow-lg" style={{ background: "var(--sol-card)", borderColor: "color-mix(in srgb, var(--sol-border) 45%, transparent)" }}>
        <span className="mr-1.5 text-[12.5px] font-medium tabular-nums" style={{ color: "var(--sol-text)" }}>{count} selected</span>
        {onMove && <OrgButton primary size="sm" onClick={onMove} data-org-move-marked>Move to…</OrgButton>}
        <button type="button" onClick={onClear} className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] hover:bg-sol-bg-highlight" style={{ color: "var(--sol-text-muted)" }} data-org-clear-marked>
          Clear <KeyCap>Esc</KeyCap>
        </button>
      </div>
    </div>
  );
}

/** React Flow's panel margin and the zoom controls' column at the bottom left:
 *  the left pill sits just past them, on the same baseline. */
const PANEL_MARGIN = 15;
const CONTROLS_W = 28;

/** A soft fade at one edge of the canvas plus a pill that pans the next hidden
 *  root card into view. Nothing when every root is on screen. The pill sits at
 *  the bottom, clear of the root row at the top. Against an open sheet the
 *  sheet's border and shadow already mark the edge, so there is no fade. */
const cuePerson = (n: CueCard): string | null => (n.kind === "person" ? n.person.name : n.kind === "owner" && n.owner.kind === "person" ? n.owner.name : null);
const cueName = (n: CueCard): string | null => cuePerson(n) ?? (n.kind === "owner" ? n.owner.name : n.kind === "role" ? n.role.name : null);

export function EdgeCue({ side, hidden, onPan, offset }: { side: "left" | "right"; hidden: CueCard[]; onPan: (n: CueCard, side: "left" | "right") => void; offset: number }) {
  if (hidden.length === 0) return null;
  const people = hidden.filter((n) => cuePerson(n) !== null).length;
  const label = people === hidden.length
    ? `${hidden.length} more ${hidden.length === 1 ? "person" : "people"}`
    : `${hidden.length} more`;
  const Icon = side === "right" ? ChevronRight : ChevronLeft;
  return (
    <>
      {offset === 0 && (
        <div
          aria-hidden
          className="pointer-events-none absolute top-0 bottom-0 w-20 z-10"
          style={{
            [side]: 0,
            background: `linear-gradient(to ${side === "right" ? "right" : "left"}, transparent, color-mix(in srgb, var(--sol-bg) 85%, transparent))`,
          }}
        />
      )}
      <button
        type="button"
        data-edge-cue={side}
        onClick={() => onPan(hidden[0], side)}
        className="absolute z-10 inline-flex items-center gap-1 h-7 pl-2.5 pr-2 rounded-full border text-meta font-medium transition-colors hover:bg-sol-bg-highlight backdrop-blur"
        style={{
          [side]: side === "left" ? offset + PANEL_MARGIN + CONTROLS_W + 8 : offset + PANEL_MARGIN,
          bottom: PANEL_MARGIN,
          background: "color-mix(in srgb, var(--sol-card) 92%, transparent)",
          borderColor: "color-mix(in srgb, var(--sol-border) 45%, transparent)",
          color: "var(--sol-text-muted)",
        }}
        title={`Pan to ${cueName(hidden[0]) ?? "the next card"}`}
      >
        {side === "left" && <Icon className="w-3.5 h-3.5" />}
        <span>{label}</span>
        {side === "right" && <Icon className="w-3.5 h-3.5" />}
      </button>
    </>
  );
}
