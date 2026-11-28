import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, ChevronUp, Maximize2 } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ModernAskCard } from "./ModernAsk";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { isMac } from "../../shortcuts";
import type { OwnWordsKeys } from "../decisions/OwnWordsBox";

const WORDS_PLACEHOLDER: Record<OwnWordsKeys, string> = {
  "send": "Answer in your own words",
  "ask": "Ask the session that asked",
  "ask-or-answer": "Ask the session, or answer in your own words",
};

// A decision docked above the composer, in the Modern style (the folded
// SessionDecisionCard branches here). Classic folds an advisory ask to a pill
// whose question is a tooltip; Modern docks the ask itself: the loud card
// (ModernAsk) with the question, its options as 32px Buttons (the agent's
// default, else the first, primary), a field for an answer in the person's
// own words, and the first lines of its reasoning under the question, since a
// question alone rarely carries enough to answer it. Expand, at the card's top
// right beside its place in the queue, opens the whole sheet with all of the
// reasoning and its keys; so does pressing the excerpt. An ask the card cannot
// answer in place (a multi or ranked form, a change card, a permission prompt,
// a harness dialog) shows its question, its excerpt and Expand.
//
// A thread can hold several open asks. The card answers one and lists the
// rest under it, each a row with its place in the thread's order and its
// question; pressing a row brings that ask up in the card. A few show; the
// rest open in place, so the card never scrolls inside itself. The option the
// agent is going ahead with says so on its face, in the words the sheet uses
// ("proceeding with this"): a filled button with no word on it read as the
// person's own answer, already given. Where the options are not drawn here,
// the same words name the option under the question.
//
// What is typed is the caller's to hold: it outlives the card, which is
// drawn again for each ask.
//
// The question is the way to the whole ask: pressing it, folded or open,
// opens the sheet (onOpen), the same as Open. The card folds to one row (the
// Needs you mark, the question, its place) under the chevron at its top
// right, for a person who wants the thread room; only the chevron unfolds it
// in place. A folded row that merely unfolded read as the panel having no
// way to the decision at all. The caller holds the fold so it lasts from one
// ask to the next.

/** How many of the thread's other asks show before the rest fold behind a row. */
const OTHERS_SHOWN = 3;

/** Another open ask of the same thread, as the card lists it. */
export type DockedAsk = { key: string; position: number; question: string };

export function ModernDecisionDock({ question, excerpt, kicker, aside, options, recommended, proceedingWith, proceedingLabel, held, onAnswer, text, onText, onAnswerText, textKeys = "send", thread, onOpen, answerable, others = [], othersOpen, onOthersOpen, onPick, collapsed = false, onCollapsed }: {
  question: string;
  /** The ask's reasoning as plain text; its first lines show under the question. */
  excerpt?: string;
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
  onAnswerText?: (text: string, mode: "ask" | "answer") => void;
  /** What Return does with the words: ask the session (⌘Return answers), only ask, or send them as the answer. */
  textKeys?: OwnWordsKeys;
  /** The ask's thread, where words asked from here and the session's reply show. */
  thread?: ReactNode;
  onOpen: () => void;
  /** Its options can be pressed from here. */
  answerable: boolean;
  /** The thread's other open asks, in the thread's order. */
  others?: DockedAsk[];
  /** Every row shows, not the first few; the caller holds it so it lasts from one ask to the next. */
  othersOpen?: boolean;
  onOthersOpen?: () => void;
  onPick?: (key: string) => void;
  /** Folded to one row. */
  collapsed?: boolean;
  /** Absent when the card cannot fold. */
  onCollapsed?: (collapsed: boolean) => void;
}) {
  const [openedHere, setOpenedHere] = useState(false);
  const allOthers = othersOpen ?? openedHere;
  const drawn = answerable && options.length > 0;
  const rows = allOthers ? others : others.slice(0, OTHERS_SHOWN);
  const shownQuestion = question || "Waiting on your decision";
  const fold = onCollapsed && (
    <button
      type="button"
      onClick={() => onCollapsed(!collapsed)}
      aria-expanded={!collapsed}
      aria-label={collapsed ? "Expand the decision" : "Collapse the decision"}
      data-decision-collapse
      className="-my-1 -mr-1.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-sol-text-dim transition-colors hover:bg-sol-bg-alt hover:text-sol-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring/60"
    >
      {collapsed ? <ChevronUp aria-hidden className="h-4 w-4" /> : <ChevronDown aria-hidden className="h-4 w-4" />}
    </button>
  );
  const expand = (
    <Button type="button" size="sm" variant="outline" onClick={onOpen} title="The whole question, its reasoning and its keys" data-decision-open className="-my-1">
      <Maximize2 aria-hidden />Expand
    </Button>
  );
  const corner = <span className="inline-flex items-center gap-2">{aside}{!collapsed && expand}{fold}</span>;
  const proceeding = !drawn && proceedingLabel ? `proceeding with ${proceedingLabel}` : null;
  if (collapsed && onCollapsed) return (
    <ModernAskCard
      kicker={
        <button type="button" onClick={onOpen} title={`Open: ${shownQuestion}`} data-decision-collapsed-question className="group/q flex min-w-0 items-center gap-2 text-left">
          {kicker && <span className="shrink-0">{kicker}</span>}
          <span className="truncate text-ui font-medium text-sol-text group-hover/q:underline">{shownQuestion}</span>
          <Maximize2 aria-hidden className="h-3.5 w-3.5 shrink-0 text-sol-text-dim opacity-0 transition-opacity group-hover/q:opacity-100" />
        </button>
      }
      aside={corner}
      data-decision-dock
      data-decision-collapsed
      className="!my-1 !py-2"
    />
  );
  return (
    <ModernAskCard
      kicker={kicker}
      aside={corner}
      question={
        <button type="button" onClick={onOpen} title="Open the whole question, its reasoning and its keys" data-decision-question-open className="text-left hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring/60">
          {shownQuestion}
        </button>
      }
      data-decision-dock
      className="!my-1"
    >
      {excerpt && (
        <button
          type="button"
          onClick={onOpen}
          data-decision-excerpt
          className="-mt-1.5 mb-3 block w-full min-w-0 text-left text-ui leading-5 text-sol-text-muted [overflow-wrap:anywhere] transition-colors hover:text-sol-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring/60"
        >
          <span className="line-clamp-3 whitespace-pre-wrap">{excerpt}</span>
        </button>
      )}
      {proceeding && <div className="-mt-1.5 mb-3 text-meta text-sol-text-dim" data-decision-proceeding="">{proceeding}</div>}
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
      {thread}
      {onAnswerText && (
        <>
          <form className={`flex min-w-0 items-center gap-2 ${drawn ? "mt-2" : ""}`} onSubmit={(e) => { e.preventDefault(); if (text.trim()) onAnswerText(text.trim(), textKeys === "send" ? "answer" : "ask"); }}>
            <Input
              value={text}
              onKeyDown={(e) => { if (textKeys === "ask-or-answer" && e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) { e.preventDefault(); onAnswerText(text.trim(), "answer"); } }}
              onChange={(e) => onText(e.target.value)}
              placeholder={WORDS_PLACEHOLDER[textKeys]}
              aria-label={WORDS_PLACEHOLDER[textKeys]}
              data-decision-words={textKeys}
              className="h-control-md min-w-0 flex-1 text-ui"
            />
            <Button type="submit" size="md" variant="outline" disabled={!text.trim()}>{textKeys === "send" ? "Send" : "Ask"}</Button>
          </form>
          {textKeys === "ask-or-answer" && text.trim() && (
            <div className="mt-1 flex items-center gap-1.5 text-meta text-sol-text-dim" data-decision-words-keys>
              <KeyCap size="xs">return</KeyCap><span>ask</span>
              <KeyCap size="xs">{isMac ? "⌘" : "ctrl"}</KeyCap><KeyCap size="xs">return</KeyCap><span>answer with this</span>
            </div>
          )}
        </>
      )}
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
