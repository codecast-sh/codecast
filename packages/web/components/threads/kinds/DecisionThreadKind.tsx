import { useInboxStore, type SessionDecisionItem } from "../../../store/inboxStore";
import type { ThreadInboxRow } from "../../../store/threadTypes";
import type { ThreadCardModel } from "../../../lib/threadCards";
import { DecisionDiscussion } from "../../decisions/DecisionDiscussion";
import { QuestionExpanded } from "./QuestionKind";

// The decision kind: a decision's team thread (convex decisionThread.ts). The
// row is the question; open, the answer controls while it waits on the
// viewer, then the thread with its composer. The thread is read once the
// card is on screen.

const rowOf = (card: ThreadCardModel) => card.source as ThreadInboxRow;

export function DecisionThreadLabel({ card }: { card: ThreadCardModel }) {
  return <span className="truncate">{rowOf(card).title ?? "A decision"}</span>;
}

export function DecisionThreadExpanded({ card, seen, present, frozenReadAt, focusComposer }: { card: ThreadCardModel; present: boolean; seen: boolean; frozenReadAt: number; focusComposer: boolean }) {
  const decisionId = String(rowOf(card).decision_id ?? "");
  const pending = useInboxStore((s) => {
    const d = s.sessionDecisions[decisionId] as SessionDecisionItem | undefined;
    return d && d.status === "pending" && d.in_queue !== false ? d : undefined;
  });
  return (
    <div className="th-card-open" data-thread-decision={decisionId}>
      {pending && <QuestionExpanded card={{ ...card, kind: "question", source: pending }} present={present} seen={seen} frozenReadAt={frozenReadAt} focusComposer={false} />}
      <DecisionDiscussion decisionId={decisionId} compact={!seen} open={focusComposer || undefined} className="mt-2" />
    </div>
  );
}
