// One approval as the lane shows it: the question, the actual draft (the
// email, the event, whatever the assistant wants to do), and its answers.
// The answer goes through the store's decision action, so the card leaves
// the moment it is tapped and the conversation wakes with the answer.
import { useState } from "react";
import { Link } from "react-router";
import { Hand } from "lucide-react";
import { MarkdownBlocks } from "../tools/MarkdownRenderer";
import { DecisionAnswerControls } from "../decisions/DecisionAnswerControls";
import { useInboxStore, type SessionDecisionItem } from "../../store/inboxStore";
import { APPROVAL_LABEL, answerNotes, answerTone, answersInline, approvalAsk, conversationPath } from "./lane";

const FOLD_CHARS = 420;

export function ApprovalCard({
  decision,
  from,
  index = 0,
  here = false,
}: {
  decision: SessionDecisionItem;
  /** The conversation's name, shown as a link to it (home and approvals). */
  from?: string;
  index?: number;
  /** The card sits in its own conversation, so every kind answers in place. */
  here?: boolean;
}) {
  const draft = decision.context_md?.trim() ?? "";
  const long = draft.length > FOLD_CHARS || draft.split("\n").length > 9;
  const [open, setOpen] = useState(false);
  const answer = (i: number) => useInboxStore.getState().answerDecision(decision._id, { index: i });
  const inline = answersInline(decision);
  const notes = inline ? answerNotes(decision.options) : [];

  return (
    <article className="sl-approval sl-rise" style={{ ["--i" as any]: index }} aria-label={decision.question}>
      <div className="sl-approval-head">
        <Hand size={14} strokeWidth={2.2} />
        <span>{APPROVAL_LABEL[approvalAsk(decision)]}</span>
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
        {inline ? (
          decision.options.map((o, i) => (
            <button
              key={`${i}-${o.label}`}
              type="button"
              className={`sl-btn is-${answerTone(o.label, i)}`}
              title={o.description}
              onClick={() => answer(i)}
            >
              {o.label}
            </button>
          ))
        ) : here ? (
          // A pick-several, a ranking or a form: the app's own answer controls.
          <div style={{ flex: "1 1 100%" }}>
            <DecisionAnswerControls decision={decision} size="compact" onAnswer={(input) => useInboxStore.getState().answerDecision(decision._id, input)} />
          </div>
        ) : (
          // A pick-several, a ranking or a form is answered in the
          // conversation, where there is room to say it.
          <Link className="sl-btn is-yes" to={conversationPath(String(decision.conversation_id))}>
            Answer in the conversation
          </Link>
        )}
      </div>
      {notes.length > 0 ? (
        <ul className="sl-answer-notes">
          {notes.map((n) => <li key={n.label}><b>{n.label}</b>{`: ${n.note}`}</li>)}
        </ul>
      ) : null}
    </article>
  );
}
