import React from "react";

// Labels that summary text uses as inline section headers ("Goal:", "Next:",
// etc.). Shared by FormattedSummary (bolds them) and ConversationView (detects
// whether a teammate message is a structured summary). Module-level `g` regex:
// callers that use `.test()` must reset `.lastIndex` themselves.
export const SUMMARY_LABELS = /\b(Goal|Status|Next|Blocked|Plan|Result|Outcome|Context|Progress):/g;

// Renders summary text with its "Goal:/Next:/…" section labels bolded and each
// label starting on a new line. Plain text (no labels) renders verbatim.
export function FormattedSummary({ text }: { text: string }) {
  const parts = text.split(SUMMARY_LABELS);
  if (parts.length <= 1) return <>{text}</>;
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} className="font-semibold text-sol-text-primary">{i > 1 ? '\n' : ''}{part}: </span>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}
