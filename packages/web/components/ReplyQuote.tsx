import { Fragment, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { useOverflows } from "../hooks/useOverflows";
import { splitQuoteRuns } from "../lib/quoteFormat";

// A quote inside a user's message (what the quote tool drops into the reply).
// The quoted words are context, the reply is the point, so a long quote folds
// to its first lines and opens on click.
//
// The cap applies whenever the quote is closed, measured or not, so the
// quote's height never waits on a measurement: a message holding many quotes
// mounts at its final height, and the conversation virtualizer has no resize
// to answer with a scroll jump. The measurement only decides the fade, the
// chevron and the click.
const FOLDED_PX = 48;

// `compact` is one truncated line, for a preview that is itself clamped.
export function ReplyQuote({ children, compact }: { children: ReactNode; compact?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const folds = useOverflows(ref, FOLDED_PX) && !compact;
  const folded = folds && !open;
  const capped = !open && !compact;
  return (
    <blockquote
      className={`cc-quote not-prose ${compact ? "cc-quote-compact" : ""} ${folds ? "cc-quote-folds" : ""} ${folded ? "cc-quote-folded" : ""}`}
      onClick={folds ? (e) => { e.stopPropagation(); if (!window.getSelection()?.toString()) setOpen((v) => !v); } : undefined}
      title={folds ? (open ? "Fold quote" : "Show the whole quote") : undefined}
    >
      <div ref={ref} className="cc-quote-body" style={capped ? { maxHeight: FOLDED_PX, overflow: "hidden" } : undefined}>{children}</div>
      {folds && <ChevronDown className="cc-quote-toggle" aria-hidden />}
    </blockquote>
  );
}

// A plain-text body (the sticky prompt, a pasted body too big for markdown)
// with its `> ` lines drawn as quotes and everything else left as text.
export function QuotedText({ text, compact }: { text: string; compact?: boolean }) {
  const runs = splitQuoteRuns(text);
  if (!runs.some((r) => r.quote)) return <>{text}</>;
  return (
    <>
      {runs.map((r, i) => r.quote
        ? <ReplyQuote key={i} compact={compact}><div className="whitespace-pre-wrap">{r.text}</div></ReplyQuote>
        : <Fragment key={i}>{r.text}</Fragment>)}
    </>
  );
}

export function MarkdownReplyQuote({ node: _node, children }: { node?: unknown; children?: ReactNode }) {
  return <ReplyQuote>{children}</ReplyQuote>;
}
