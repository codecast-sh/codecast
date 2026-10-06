"use client";

import { Route } from "lucide-react";
import type { ChangeGuide } from "@codecast/shared/contracts/changeGuide";
import { stepLocation } from "@codecast/shared/contracts/changeGuide";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { FilePatchDiff, getFileExtension } from "../FileDiffLayout";
import { cn } from "../../lib/utils";

// The author's tour of a change (ct-57527): the steps in the order the session
// that wrote the code chose to explain it, each with its reason and the hunk
// captured at handoff. Read at the review station (TaskEvidence) and above the
// verdict on the line's change card.

// The author's prose: inline code as a quiet chip, not backtick glyphs.
const PROSE = "prose-sm prose-invert max-w-none prose-p:my-1 prose-code:rounded prose-code:bg-sol-bg-alt prose-code:px-1 prose-code:py-px prose-code:text-[12px] prose-code:font-normal prose-code:text-sol-text prose-code:before:content-none prose-code:after:content-none";

function StepLocation({ step }: { step: ChangeGuide["steps"][number] }) {
  const parts = step.file.split("/");
  const name = parts.pop();
  const dir = parts.join("/");
  const range = stepLocation(step).slice(step.file.length);
  return (
    <span className="inline-flex items-baseline min-w-0 max-w-full font-mono text-[11px] leading-5" title={stepLocation(step)}>
      {dir && <span className="text-sol-text-dim truncate">{dir}/</span>}
      <span className="text-sol-text-muted shrink-0">{name}</span>
      {range && <span className="text-sol-cyan shrink-0">{range}</span>}
    </span>
  );
}

export function ChangeGuideWalkthrough({ guide, className, compact = false }: { guide: ChangeGuide; className?: string; compact?: boolean }) {
  const steps = guide.steps;
  return (
    <section className={cn("min-w-0", className)} data-change-guide={steps.length}>
      <div className="flex items-center gap-1.5 text-xs font-medium text-sol-text-dim mb-2">
        <Route className="w-3.5 h-3.5" />
        Change guide
        <span className="text-sol-text-dim/60 font-normal">· {steps.length} {steps.length === 1 ? "step" : "steps"}, in the author's order</span>
      </div>
      {guide.summary && (
        <MarkdownRenderer content={guide.summary} className={cn("text-sm text-sol-text mb-3", PROSE)} />
      )}
      <ol className="relative">
        {steps.map((step, i) => {
          const last = i === steps.length - 1;
          return (
            <li key={`${i}:${step.file}`} className="relative grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3" data-guide-step={i + 1}>
              {/* The rail: a numbered stop per step, joined to the next. */}
              <div className="relative flex justify-center">
                {!last && <span className="absolute top-6 bottom-0 w-px bg-sol-border/60" aria-hidden />}
                <span className="relative z-[1] mt-0.5 flex h-5 w-5 items-center justify-center rounded-full border border-sol-cyan/50 bg-sol-bg text-[10px] font-semibold tabular-nums text-sol-cyan">
                  {i + 1}
                </span>
              </div>
              <div className={cn("min-w-0", last ? "pb-1" : "pb-5")}>
                <h3 className="text-sm font-medium text-sol-text leading-6">{step.title}</h3>
                <StepLocation step={step} />
                {step.why && (
                  <MarkdownRenderer content={step.why} className={cn("mt-1.5 text-sm text-sol-text-muted", PROSE)} />
                )}
                {step.hunk ? (
                  <div className="mt-2 rounded-md border border-sol-border/40 bg-sol-bg/60 overflow-hidden">
                    <FilePatchDiff patch={step.hunk} language={getFileExtension(step.file)} showLineNumbers wrap maxLines={compact ? 24 : 60} />
                    {step.truncated && (
                      <div className="px-2 py-1 text-[10px] text-sol-text-dim border-t border-sol-border/30">Cut to fit; the full change is in the diff.</div>
                    )}
                  </div>
                ) : (
                  <div className="mt-1.5 text-[11px] text-sol-text-dim">No diff for this range at handoff.</div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
