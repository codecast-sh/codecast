// A conversation's transcript in the lane: the person's words on the right,
// the assistant's words as plain prose, and each run of tool steps folded
// into a short list of plain lines between them.
import { memo, useState } from "react";
import { MarkdownBlocks } from "../tools/MarkdownRenderer";
import type { Step, TranscriptItem } from "./lane";

const STEPS_SHOWN = 4;

function StepList({ steps }: { steps: Step[] }) {
  const [open, setOpen] = useState(false);
  const hidden = steps.length - STEPS_SHOWN;
  const shown = open || hidden <= 1 ? steps : steps.slice(0, STEPS_SHOWN - 1);
  return (
    <ul className="sl-steps" aria-label="What the assistant did">
      {shown.map((s) => (
        <li key={s.id} className={`sl-step is-${s.state}`}>
          {s.text}
          {s.state === "failed" ? <span className="sl-step-why"> (didn't work)</span> : null}
        </li>
      ))}
      {!open && hidden > 1 ? (
        <li>
          <button type="button" className="sl-steps-more" onClick={() => setOpen(true)}>
            {`${steps.length - shown.length} more steps`}
          </button>
        </li>
      ) : null}
    </ul>
  );
}

export const Transcript = memo(function Transcript({
  items,
  onRetry,
}: {
  items: TranscriptItem[];
  onRetry: (item: Extract<TranscriptItem, { kind: "you" }>) => void;
}) {
  return (
    <>
      {items.map((item) => {
        switch (item.kind) {
          case "you":
            return (
              <div key={item.id} style={{ display: "contents" }}>
                <div className={`sl-you${item.pending ? " is-pending" : ""}${item.failed ? " is-failed" : ""}`}>{item.text}</div>
                {item.failed ? (
                  <div className="sl-you-meta">
                    {"Didn't send. "}
                    <button type="button" className="sl-steps-more" onClick={() => onRetry(item)}>
                      Try again
                    </button>
                  </div>
                ) : item.pending ? (
                  <div className="sl-you-meta">Sending</div>
                ) : null}
              </div>
            );
          case "said":
            return (
              <div key={item.id} className="sl-said sl-prose">
                <MarkdownBlocks content={item.text} />
              </div>
            );
          case "steps":
            return <StepList key={item.id} steps={item.steps} />;
          case "answer":
          case "note":
            return (
              <div key={item.id} className="sl-note">
                {item.text}
              </div>
            );
        }
      })}
    </>
  );
});
