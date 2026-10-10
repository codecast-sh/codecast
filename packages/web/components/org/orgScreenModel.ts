// The pure helpers an embedded proposal conversation reads: a host's
// scroll-to request, and the message a proposal's card sits in. No React, so
// the rules test without a DOM.

/** A host's scroll-to request for an embedded conversation: the message to
 *  land on, or the time to centre on while the message is not loaded, with
 *  `find` naming the proposal whose card the embed then looks for in the
 *  window that lands (findProposalCardMessage). A new nonce is a new request.
 *  `onSettled` runs once the thread has settled on the message's row, once
 *  per nonce: the host then lands on what it wanted inside that row (a card,
 *  the focused entry), and the thread's own settle yields to that scroll. */
export type JumpRequest = { messageId?: string; timestamp?: number; find?: string; nonce: number; onSettled?: () => void };

/** The message that draws a proposal's card: the first one from the START
 *  whose text has `op-N` alone on a line (the same line CARD_RE in
 *  orgChartPointer.ts reads, which also takes `#seq`) and that a person did
 *  not write. The author posts the card once; later turns write `op-N#3` in
 *  sentences and the person's reply block writes `op-N#seq` followed by
 *  words, so neither matches. */
export function findProposalCardMessage(messages: readonly { _id: string; role?: string; content?: string }[] | undefined, shortId: string): string | null {
  const re = new RegExp(`^[ \\t]*${shortId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*$`, "im");
  return messages?.find((m) => m.role !== "user" && typeof m.content === "string" && re.test(m.content))?._id ?? null;
}
