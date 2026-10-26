// The row the daemon writes into a conversation when it stops delivering a
// message (TMUX_PASTE_WRITE_CAP in cli/tmuxDeliveryJournal). It carries the
// whole message, so the person reading the session can see what never landed
// and send it again, and whether any write was submitted, which decides what
// the row may claim: a write the daemon never pressed Enter on cannot have
// reached the agent, while a submitted one may have run without echoing.
//
// The first line is a plain sentence, so an agent reading the transcript and a
// client that predates this format both read the outcome before the payload.

export const DELIVERY_FAILED_SUBTYPE = "delivery_failed";

export type DeliveryFailedNotice = {
  writes: number;
  /** Whether any write got an Enter. Null on rows written before this was recorded. */
  submitted: boolean | null;
  message: string;
  /** False when the row kept only a prefix of the message (rows before this format). */
  complete: boolean;
};

export function deliveryFailedSentence(n: Pick<DeliveryFailedNotice, "writes" | "submitted">): string {
  if (n.submitted === false) {
    return `This message never reached the agent: it was written into the terminal ${n.writes} times, never appeared at the prompt, and was never submitted. Delivery stopped.`;
  }
  if (n.submitted) {
    return `This message was submitted into the terminal but the transcript never echoed it, after ${n.writes} writes. Delivery stopped; the agent may have run it more than once.`;
  }
  return `This message was written into the terminal ${n.writes} times and the transcript never echoed it. Delivery stopped; the agent may have taken it.`;
}

export function formatDeliveryFailedNotice(n: { writes: number; submitted: boolean; message: string }): string {
  return `${deliveryFailedSentence(n)}\n\n<delivery-failed writes="${n.writes}" submitted="${n.submitted}">\n${n.message}\n</delivery-failed>`;
}

// The prose rows the daemon wrote before this format: a 200 character,
// whitespace-flattened prefix of the message after "Message: ".
const LEGACY_RE = /^A message to this session was written into its terminal (\d+) times and its transcript never echoed it exactly[^]*?Message: ([^]*)$/;

export function parseDeliveryFailedNotice(content: string | null | undefined): DeliveryFailedNotice | null {
  if (!content) return null;
  const open = content.match(/<delivery-failed writes="(\d+)" submitted="(true|false)">\n/);
  if (open && open.index !== undefined) {
    const start = open.index + open[0].length;
    const end = content.lastIndexOf("\n</delivery-failed>");
    if (end < start) return null;
    return { writes: Number(open[1]), submitted: open[2] === "true", message: content.slice(start, end), complete: true };
  }
  const legacy = content.match(LEGACY_RE);
  if (!legacy) return null;
  const message = legacy[2].replace(/…$/, "");
  return { writes: Number(legacy[1]), submitted: null, message, complete: message.length === legacy[2].length };
}
