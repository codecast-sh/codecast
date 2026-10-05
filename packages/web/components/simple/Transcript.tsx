// A conversation's transcript in the lane: the person's words on the right,
// the assistant's words as plain prose, and each run of tool steps folded
// into a short list of plain lines between them.
import { memo, useState } from "react";
import { MarkdownBlocks } from "../tools/MarkdownRenderer";
import { LANE_COPY, visibleSteps, type Step, type TranscriptItem } from "./lane";

const WORDS = LANE_COPY.transcript;

function StepList({ steps }: { steps: Step[] }) {
  const [open, setOpen] = useState(false);
  const { shown, more } = visibleSteps(steps, open);
  return (
    <ul className="sl-steps" aria-label={WORDS.steps}>
      {shown.map((s) => (
        <li key={s.id} className={`sl-step is-${s.state}`}>
          {s.text}
          {s.state === "failed" ? <span className="sl-step-why">{WORDS.failed}</span> : null}
        </li>
      ))}
      {more > 0 ? (
        <li>
          <button type="button" className="sl-steps-more" onClick={() => setOpen(true)}>
            {WORDS.moreSteps(more)}
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
                    {WORDS.didntSend}
                    <button type="button" className="sl-steps-more" onClick={() => onRetry(item)}>
                      {WORDS.retry}
                    </button>
                  </div>
                ) : item.pending ? (
                  <div className="sl-you-meta">{WORDS.sending}</div>
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
