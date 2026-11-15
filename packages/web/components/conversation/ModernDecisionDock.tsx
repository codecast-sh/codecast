import { useState, type ReactNode } from "react";
import { ChevronRight, Maximize2 } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ModernAskCard } from "./ModernAsk";

// A decision docked above the composer, in the Modern style (the folded
// SessionDecisionCard branches here). Classic folds an advisory ask to a pill
// whose question is a tooltip; Modern docks the ask itself: the loud card
// (ModernAsk) with the question, its options as 32px Buttons (the agent's
// default, else the first, primary), a field for an answer in the person's
// own words, and Open for the whole sheet with its reasoning and keys. An ask
// the card cannot answer in place (a multi or ranked form, a change card, a
// permission prompt, a harness dialog) shows its question and Open.
//
// A thread can hold several open asks. The card answers one and lists the
// rest under it, each a row with its place in the thread's order and its
// question; pressing a row brings that ask up in the card. A few show; the
// rest open in place, so the card never scrolls inside itself. The option the
// agent is going ahead with says so on its face, in the words the sheet uses
// ("proceeding with this"): a filled button with no word on it read as the
// person's own answer, already given. Where the options are not drawn here,
// the same words name the option beside Open.
//
// What is typed is the caller's to hold: it outlives the card, which is
// drawn again for each ask.

/** How many of the thread's other asks show before the rest fold behind a row. */
const OTHERS_SHOWN = 3;

/** Another open ask of the same thread, as the card lists it. */
export type DockedAsk = { key: string; position: number; question: string };

export function ModernDecisionDock({ question, kicker, aside, options, recommended, proceedingWith, proceedingLabel, held, onAnswer, text, onText, onAnswerText, onOpen, answerable, others = [], othersOpen, onOthersOpen, onPick }: {
  question: string;
  kicker?: ReactNode;
  aside?: ReactNode;
  options: Array<{ label: string; description?: string; index: number }>;
  /** The option index drawn primary. */
  recommended?: number;
  /** The option the agent goes ahead with unless the person picks another. */
  proceedingWith?: number;
  /** That option's label, said beside Open when the options are not drawn here. */
  proceedingLabel?: string;
  held: (index: number) => boolean;
  onAnswer: (index: number) => void;
  /** The answer being typed, and each change to it. */
  text: string;
  onText: (text: string) => void;
  /** Absent when the ask takes no typed answer. */
  onAnswerText?: (text: string) => void;
  onOpen: () => void;
  /** Its options can be pressed from here. */
  answerable: boolean;
  /** The thread's other open asks, in the thread's order. */
  others?: DockedAsk[];
  /** Every row shows, not the first few; the caller holds it so it lasts from one ask to the next. */
  othersOpen?: boolean;
  onOthersOpen?: () => void;
  onPick?: (key: string) => void;
}) {
  const [openedHere, setOpenedHere] = useState(false);
  const allOthers = othersOpen ?? openedHere;
  const drawn = answerable && options.length > 0;
  const rows = allOthers ? others : others.slice(0, OTHERS_SHOWN);
  return (
    <ModernAskCard kicker={kicker} aside={aside} question={question || "Waiting on your decision"} data-decision-dock className="!my-1">
      {drawn && (
        <div className="flex flex-wrap items-center gap-2" data-decision-options>
          {options.map((o) => (
            <Button
              key={o.index}
              type="button"
              size="md"
              variant={o.index === recommended ? "primary" : "outline"}
              disabled={held(o.index)}
              title={o.description}
              onClick={() => onAnswer(o.index)}
              className="max-w-full"
            >
              <span className="truncate">{o.label.replace(" (Recommended)", "")}</span>
              {o.index === proceedingWith && <span className="shrink-0 text-meta font-normal opacity-80" data-decision-proceeding>proceeding with this</span>}
            </Button>
          ))}
        </div>
      )}
      <div className={`flex min-w-0 items-center gap-2 ${drawn ? "mt-2" : ""}`}>
        {onAnswerText ? (
          <form className="flex min-w-0 flex-1 items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (text.trim()) onAnswerText(text.trim()); }}>
            <Input
              value={text}
              onChange={(e) => onText(e.target.value)}
              placeholder="Answer in your own words"
              aria-label="Answer in your own words"
              className="h-control-md min-w-0 flex-1 text-ui"
            />
            <Button type="submit" size="md" variant="outline" disabled={!text.trim()}>Send</Button>
          </form>
        ) : (
          <span className="min-w-0 flex-1 truncate text-meta text-sol-text-dim" data-decision-proceeding={!drawn && proceedingLabel ? "" : undefined}>
            {!drawn && proceedingLabel ? `proceeding with ${proceedingLabel}` : null}
          </span>
        )}
        <Button type="button" size="md" variant="ghost" onClick={onOpen} title="Open the whole question, its reasoning and its keys" data-decision-open>
          <Maximize2 aria-hidden />Open
        </Button>
      </div>
      {others.length > 0 && onPick && (
        <ul className="-mx-2 mt-3 border-t border-sol-border pt-1.5" data-decision-others>
          {rows.map((a) => (
            <li key={a.key}>
              <button
                type="button"
                onClick={() => onPick(a.key)}
                title={a.question}
                data-decision-other={a.key}
                className="flex h-control-sm w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-ui text-sol-text-muted transition-colors hover:bg-sol-bg-alt hover:text-sol-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring/60"
              >
                <span className="w-4 shrink-0 text-center tabular-nums text-sol-text-dim">{a.position}</span>
                <span className="min-w-0 flex-1 truncate">{a.question}</span>
                <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-sol-text-dim" />
              </button>
            </li>
          ))}
          {rows.length < others.length && (
            <li>
              <button
                type="button"
                onClick={() => (onOthersOpen ? onOthersOpen() : setOpenedHere(true))}
                aria-expanded={false}
                data-decision-others-more={others.length - rows.length}
                className="flex h-control-sm w-full items-center gap-2 rounded-md px-2 text-left text-ui text-sol-text-dim transition-colors hover:bg-sol-bg-alt hover:text-sol-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring/60"
              >
                <span className="w-4 shrink-0" />
                {others.length - rows.length} more
              </button>
            </li>
          )}
        </ul>
      )}
    </ModernAskCard>
  );
}
