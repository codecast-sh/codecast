"use client";
// The head facts line every sheet and summary says (cohesive build spec §5.1,
// D13): owner · state · measure · date, on one line that never wraps. Owner,
// state and date keep their width; only the measure gives way, truncated with
// its full words on hover, so a separator never strands at a line's end.
import { Fragment, type ReactNode } from "react";
import { cn } from "../../../lib/utils";
import type { LineFacts } from "./lineFacts";

const SLOTS = ["owner", "state", "measure", "date"] as const;
const present = (c: ReactNode) => c != null && c !== false;

/** True when the facts have anything to say. */
export const hasFacts = (facts: Partial<LineFacts> | null | undefined): boolean => !!facts && SLOTS.some((k) => present(facts[k]));

export function FactsLine({ facts, className, ...data }: { facts: Partial<LineFacts>; className?: string } & Record<`data-${string}`, string>) {
  const slots = SLOTS.filter((k) => present(facts[k]));
  if (slots.length === 0) return null;
  return (
    <div className={cn("flex min-w-0 flex-nowrap items-center gap-x-1.5 overflow-hidden whitespace-nowrap", className)} style={{ color: "var(--sol-text-muted)" }} data-facts-line {...data}>
      {slots.map((k, i) => (
        <Fragment key={k}>
          {i > 0 && <span aria-hidden className="shrink-0" style={{ color: "var(--sol-text-dim)" }}>·</span>}
          <span
            className={k === "measure" ? "min-w-0 truncate" : cn("inline-flex shrink-0 items-center gap-1.5", k === "owner" && "max-w-[45%] [&>*]:min-w-0")}
            title={k === "measure" && typeof facts.measure === "string" ? facts.measure : undefined}
            data-fact={k}
          >
            {facts[k]}
          </span>
        </Fragment>
      ))}
    </div>
  );
}
