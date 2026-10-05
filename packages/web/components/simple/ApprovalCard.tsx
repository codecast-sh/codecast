// One approval as the lane shows it: the question, the actual draft (the
// email, the event, whatever the assistant wants to do), and its answers.
// The answer goes through the store's decision action, so the card leaves
// the moment it is tapped and the conversation wakes with the answer.
import { useState } from "react";
import { Link } from "react-router";
import { Hand } from "lucide-react";
import { MarkdownBlocks } from "../tools/MarkdownRenderer";
import { useInboxStore, type SessionDecisionItem } from "../../store/inboxStore";
import { answerTone, conversationPath } from "./lane";

const FOLD_CHARS = 420;

export function ApprovalCard({
  decision,
  from,
  index = 0,
}: {
  decision: SessionDecisionItem;
  /** The conversation's name, shown as a link to it (home and approvals). */
  from?: string;
  index?: number;
}) {
  const draft = decision.context_md?.trim() ?? "";
  const long = draft.length > FOLD_CHARS || draft.split("\n").length > 9;
  const [open, setOpen] = useState(false);
  const answer = (i: number) => useInboxStore.getState().answerDecision(decision._id, { index: i });

  return (
    <article className="sl-approval sl-rise" style={{ ["--i" as any]: index }} aria-label={decision.question}>
      <div className="sl-approval-head">
        <Hand size={14} strokeWidth={2.2} />
        <span>Needs your OK</span>
        {from ? <Link to={conversationPath(String(decision.conversation_id))}>{from}</Link> : null}
      </div>
      <h3 className="sl-approval-q">{decision.question}</h3>
      {draft ? (
        <>
          <div className={`sl-draft sl-prose${long && !open ? " is-folded" : ""}`}>
            <MarkdownBlocks content={draft} />
          </div>
          {long ? (
            <button type="button" className="sl-draft-more" onClick={() => setOpen((v) => !v)}>
              {open ? "Show less" : "Show all of it"}
            </button>
          ) : null}
        </>
      ) : null}
      <div className="sl-answers">
        {decision.options.map((o, i) => (
          <button
            key={`${i}-${o.label}`}
            type="button"
            className={`sl-btn is-${answerTone(o.label, i)}`}
            title={o.description}
            onClick={() => answer(i)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </article>
  );
}
