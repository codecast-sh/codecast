import { useState, type ReactNode } from "react";
import { Maximize2 } from "lucide-react";
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

export function ModernDecisionDock({ question, kicker, aside, options, recommended, held, onAnswer, onAnswerText, onOpen, answerable }: {
  question: string;
  kicker?: ReactNode;
  aside?: ReactNode;
  options: Array<{ label: string; description?: string; index: number }>;
  /** The option index drawn primary. */
  recommended?: number;
  held: (index: number) => boolean;
  onAnswer: (index: number) => void;
  /** Absent when the ask takes no typed answer. */
  onAnswerText?: (text: string) => void;
  onOpen: () => void;
  /** Its options can be pressed from here. */
  answerable: boolean;
}) {
  const [text, setText] = useState("");
  return (
    <ModernAskCard kicker={kicker} aside={aside} question={question || "Waiting on your decision"} data-decision-dock className="!my-1">
      {answerable && options.length > 0 && (
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
            </Button>
          ))}
        </div>
      )}
      <div className={`flex min-w-0 items-center gap-2 ${answerable && options.length > 0 ? "mt-2" : ""}`}>
        {onAnswerText ? (
          <form className="flex min-w-0 flex-1 items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (text.trim()) onAnswerText(text.trim()); }}>
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Answer in your own words"
              aria-label="Answer in your own words"
              className="h-control-md min-w-0 flex-1 text-ui"
            />
            <Button type="submit" size="md" variant="outline" disabled={!text.trim()}>Send</Button>
          </form>
        ) : <span className="flex-1" />}
        <Button type="button" size="md" variant="ghost" onClick={onOpen} title="Open the whole question, its reasoning and its keys" data-decision-open>
          <Maximize2 aria-hidden />Open
        </Button>
      </div>
    </ModernAskCard>
  );
}
