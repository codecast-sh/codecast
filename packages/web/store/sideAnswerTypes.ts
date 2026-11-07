// Side answers' optimistic row (lib/sideAnswers holds the rest). A leaf with
// no store import, so inboxStore can build the stub without a cycle.
import type { SideAnswerRow } from "@codecast/shared/contracts";

export const sideAnswerStubId = (clientId: string) => `btwstub-${clientId}`;
export const isSideAnswerStub = (row: { _id: string }) => row._id.startsWith("btwstub-");

/** The row a question paints as before the server has it. */
export function sideAnswerStub(o: { conversationId: string; question: string; clientId: string; now?: number }): SideAnswerRow {
  return {
    _id: sideAnswerStubId(o.clientId),
    conversation_id: o.conversationId,
    client_id: o.clientId,
    question: o.question.trim(),
    status: "pending",
    created_at: o.now ?? Date.now(),
  };
}
