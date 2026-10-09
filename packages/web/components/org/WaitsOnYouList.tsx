"use client";
// Waits on you (essence spec 6.1): the list at the top of the Org canvas,
// drawn only when something waits. Each row is the asking role's face, one
// line of "<who> <verb>: <words>", its age and one action. A decision that
// answers in place shows its options under the line; a press answers it
// through the store, so the row leaves in the same frame. There is no
// dismiss: a row clears by doing what it asks.
//
// `folded` draws the one-line form the canvas uses while the panel is open:
// "2 wait on you", the faces, and Show, which unfolds it until the panel
// closes. Orange here is the one orange on the screen.
//
// Named WaitsOnYouList, not WaitsOnYou: on a case-insensitive disk bun
// resolves "./waitsOnYou" (the model) to a WaitsOnYou.tsx beside it.
import { memo, useEffect, useState } from "react";
import { useInboxStore } from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { compactAge } from "../../lib/threadState";
import { cn } from "../../lib/utils";
import { RoleFace } from "./RoleFace";
import { useWaitsOnYou } from "./useNeedsYou";
import type { WaitFace, WaitItem, WaitTarget } from "./waitsOnYou";

const BORDER = "color-mix(in srgb, var(--sol-orange) 30%, color-mix(in srgb, var(--sol-border) 32%, transparent))";
const ROW_RULE = "color-mix(in srgb, var(--sol-border) 18%, transparent)";
const BUTTON = "inline-flex h-[26px] shrink-0 items-center rounded-md border px-2.5 text-[12px] leading-none whitespace-nowrap transition-colors hover:bg-sol-bg-highlight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sol-blue/60";
const BUTTON_STYLE = { borderColor: "color-mix(in srgb, var(--sol-border) 32%, transparent)", background: "var(--sol-card)", color: "var(--sol-text-secondary)" } as const;

export type WaitsOnYouProps = {
  /** Open a row's target in the Org panel. */
  onOpen: (target: WaitTarget) => void;
  /** The one-line form, while the panel is open. */
  folded?: boolean;
  /** The rows, when the caller already holds them (the canvas reads the
   *  same hook for its cards); else the list reads them itself. */
  items?: readonly WaitItem[];
};

export function WaitsOnYou({ items, ...rest }: WaitsOnYouProps) {
  return items ? <WaitsList items={items} {...rest} /> : <WaitsFromStore {...rest} />;
}

function WaitsFromStore(props: Omit<WaitsOnYouProps, "items">) {
  return <WaitsList items={useWaitsOnYou()} {...props} />;
}

const WaitsList = memo(function WaitsList({ items, onOpen, folded = false }: Omit<WaitsOnYouProps, "items"> & { items: readonly WaitItem[] }) {
  const now = useCoarseNow(60_000);
  const [shown, setShown] = useState(false);
  // Show unfolds the list for this opening of the panel only.
  useEffect(() => { if (!folded) setShown(false); }, [folded]);
  if (items.length === 0) return null;

  if (folded && !shown) {
    const n = items.length;
    return (
      <section
        className="mb-6 flex items-center gap-2.5 rounded-xl border px-4 py-[9px] text-[12px] font-semibold"
        style={{ background: "var(--sol-card)", borderColor: BORDER, color: "var(--sol-orange)" }}
        data-waits-on-you={n}
        data-waits-folded
      >
        <Dot />
        <span className="tabular-nums">{n} wait{n === 1 ? "s" : ""} on you</span>
        <span className="flex pl-1.5">
          {items.slice(0, 5).map((i) => <Face key={i.key} face={i.who.face} name={i.who.name} size={20} className="-ml-[5px] ring-2 ring-[var(--sol-card)]" />)}
        </span>
        <button type="button" onClick={() => setShown(true)} className="ml-auto rounded px-1 font-normal hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sol-blue/60" style={{ color: "var(--sol-text-muted)" }} data-waits-show>
          Show
        </button>
      </section>
    );
  }

  return (
    <section className="mb-6 overflow-hidden rounded-xl border" style={{ background: "var(--sol-card)", borderColor: BORDER }} data-waits-on-you={items.length}>
      <div className="flex items-center gap-2 px-4 pb-0.5 pt-2.5 text-[12px] font-semibold" style={{ color: "var(--sol-orange)" }}>
        <Dot />
        Waits on you
      </div>
      {items.map((item, i) => <WaitRow key={item.key} item={item} first={i === 0} now={now} onOpen={onOpen} />)}
    </section>
  );
});

function WaitRow({ item, first, now, onOpen }: { item: WaitItem; first: boolean; now: number; onOpen: (t: WaitTarget) => void }) {
  const open = () => onOpen(item.target);
  const answer = item.answer;
  return (
    <div className={cn("px-4 pb-[9px] pt-2", !first && "border-t")} style={first ? undefined : { borderColor: ROW_RULE }} data-wait-row={item.key} data-wait-kind={item.kind}>
      <div className="flex min-w-0 items-center gap-3">
        <Face face={item.who.face} name={item.who.name} size={24} />
        <button type="button" onClick={open} className="min-w-0 flex-1 truncate rounded text-left text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sol-blue/60" title={`${item.who.name} ${item.verb}: ${item.words}`}>
          <b className="font-semibold" style={{ color: "var(--sol-text)" }}>{item.who.name} {item.verb}:</b>{" "}
          <span style={{ color: "var(--sol-text-secondary)" }}>{item.words}</span>
        </button>
        <span className="shrink-0 text-[11px] tabular-nums" style={{ color: "var(--sol-text-dim)" }}>{compactAge(Math.max(0, now - item.at))}</span>
        <button type="button" onClick={open} className={BUTTON} style={BUTTON_STYLE} data-wait-action={item.kind === "decision" ? "answer" : "review"}>
          {item.kind === "decision" ? "Answer" : "Review"}
        </button>
      </div>
      {answer && (
        <div className="mt-1.5 flex flex-wrap gap-1.5 pl-9" data-wait-options>
          {answer.options.map((label, index) => (
            <button
              key={index}
              type="button"
              onClick={() => void useInboxStore.getState().answerDecision(answer.decisionId, { index })}
              className={cn(BUTTON, "max-w-full truncate")}
              style={BUTTON_STYLE}
              title={label}
              data-wait-option={index}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Dot() {
  return <span aria-hidden className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: "var(--sol-orange)" }} />;
}

/** A role's face, or the initials of whoever proposed without one. */
function Face({ face, name, size, className }: { face: WaitFace; name: string; size: number; className?: string }) {
  if (face) return <RoleFace role={face} size={size} className={cn("shrink-0 rounded-full", className)} title={name} />;
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
  return (
    <span
      aria-hidden
      title={name}
      className={cn("inline-flex shrink-0 items-center justify-center rounded-full text-[10px] font-semibold", className)}
      style={{ width: size, height: size, background: "var(--sol-bg-alt)", color: "var(--sol-text-muted)" }}
    >
      {initials}
    </span>
  );
}
