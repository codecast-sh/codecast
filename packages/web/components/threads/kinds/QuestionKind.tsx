import { useCallback, useState } from "react";
import { CornerDownRight, X } from "lucide-react";
import { useInboxStore, type SessionDecisionItem } from "../../../store/inboxStore";
import { sessionLabel } from "../../../lib/notificationTypes";
import { summaryCount, type CardPreview, type ThreadCardModel } from "../../../lib/threadCards";
import { AgentIcon } from "../../ConversationList";
import { MarkdownRenderer } from "../../tools/MarkdownRenderer";
import { PublishedPageEmbed } from "../../PublishedPageEmbed";

// The question kind: a pending decision (cast decide / AskUserQuestion),
// answerable in place. The row is the question itself; open, the context,
// the report when one was attached, and the options — the same answer flow
// the Questions page drives (store answerDecision: the row resolves, the
// chosen option enters the session as a message, and the card drops off,
// because only pending rows become cards).

function decisionOf(card: ThreadCardModel): SessionDecisionItem {
  return card.source as SessionDecisionItem;
}

/** The label leads with the asking session's agent mark, like the comment
 *  kind; the kind tile keeps the kind's own icon. */
export function QuestionLabel({ card }: { card: ThreadCardModel }) {
  const d = decisionOf(card);
  const agentType = useInboxStore(
    (s) => ((s.conversations[d.conversation_id] ?? s.sessions[d.conversation_id]) as { agent_type?: string } | undefined)?.agent_type ?? "claude_code",
  );
  const label = useInboxStore((s) => sessionLabel(s.conversations[d.conversation_id] ?? s.sessions[d.conversation_id]));
  return (
    <>
      <AgentIcon agentType={agentType} className="w-3 h-3" />
      {label ?? "A session"} asks
    </>
  );
}

/** The question, and what happens if nobody answers. */
export function useQuestionPreview(card: ThreadCardModel): CardPreview | null {
  const d = decisionOf(card);
  const tail = d.blocking
    ? "The session is parked on your answer."
    : d.default_option !== undefined && d.options[d.default_option]
      ? `Proceeding with “${d.options[d.default_option].label}” unless you say otherwise.`
      : summaryCount(d.options.length, "option");
  return { who: d.question, text: tail };
}

export function QuestionExpanded({ card, focusComposer }: { card: ThreadCardModel; present: boolean; seen: boolean; frozenReadAt: number; focusComposer: boolean }) {
  const d = decisionOf(card);
  const [text, setText] = useState("");
  const answer = useCallback(
    (index: number) => useInboxStore.getState().answerDecision(d._id, { index }),
    [d._id],
  );
  const answerText = useCallback(() => {
    const t = text.trim();
    if (t) useInboxStore.getState().answerDecision(d._id, { text: t });
  }, [d._id, text]);
  const dismiss = useCallback(
    () => useInboxStore.getState().answerDecision(d._id, { dismiss: true }),
    [d._id],
  );

  return (
    <div className="th-card-open th-card-open-question">
      <div className="th-card-question">{d.question}</div>
      {d.context_md && (
        <div className="th-question-context">
          <MarkdownRenderer content={d.context_md} />
        </div>
      )}
      {d.report_slug && <PublishedPageEmbed slug={d.report_slug} />}
      <div className="th-question-options" role="group" aria-label="Answer options">
        {d.options.map((o, i) => (
          <button key={i} type="button" className="th-question-option" onClick={() => answer(i)}>
            <span className="th-question-option-label">
              {o.label}
              {d.default_option === i && <span className="th-question-default"> · default</span>}
            </span>
            {o.description && <span className="th-question-option-desc">{o.description}</span>}
          </button>
        ))}
      </div>
      <div className="th-question-free">
        <input
          type="text"
          className="th-question-input"
          placeholder="Answer in your own words…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") answerText(); }}
          // The `r` key's focus request; the mount itself never grabs focus.
          ref={(el) => { if (el && focusComposer) el.focus(); }}
        />
        <button type="button" className="th-question-send" onClick={answerText} disabled={!text.trim()} title="Send answer">
          <CornerDownRight className="w-3.5 h-3.5" />
        </button>
        <button type="button" className="th-question-dismiss" onClick={dismiss}>
          <X className="w-3 h-3" /> Dismiss
        </button>
      </div>
    </div>
  );
}
