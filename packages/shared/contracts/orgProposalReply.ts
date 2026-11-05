// A person's answers to a proposal's cards, as the agent reads them
// (org-staffing.md S39). Re-exported from orgProposal.ts.

import { proposalChangeRefId } from "../entities";

/** "a, b and c" */
export const andList = (xs: string[]) => xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

// ── A card answers the agent (org-staffing.md S39) ──────────────────────────

/** What a person says to the changes of one card: apply them, do not, or
 *  words about them with no verdict. */
export type OrgReplyVerdict = "approve" | "reject" | "note";
/** One answer to the changes of one card. `seqs` empty = about the whole
 *  proposal (a note only). `line` is the card's sentence. */
export type OrgReplyItem = { verdict: OrgReplyVerdict; seqs: number[]; text?: string; line: string };
/** A person's answers to one proposal, sent together. `proposal` is its short
 *  id (`op-55`). `applied` is whether every approval had landed when the
 *  words were written (absent means yes): the server's send knows, and says
 *  "Approved" alone when a continuation or a failure leaves some to read on
 *  the rows. */
export type OrgProposalReply = { proposal: string; title: string; items: OrgReplyItem[]; applied?: boolean };
/** What a change row keeps of the person's answer, so a card says it after a reload and on another device. */
export type OrgChangeReply = { verdict: OrgReplyVerdict; text?: string; at: number; by?: string };
/** The author's answer to a question on a change (`cast org revise --answer`). */
export type OrgChangeAnswer = { text: string; at: number };

/** The word a surface shows for a verdict: `act` on the control before the
 *  send, `done` on the card after it. */
export const ORG_REPLY_WORDS: Record<OrgReplyVerdict, { act: string; done: string }> = {
  approve: { act: "Accept", done: "Accepted" },
  reject: { act: "Reject", done: "Rejected" },
  note: { act: "Adjust", done: "Noted" },
};

/**
 * The words the agent reads, one block per proposal. Used by the web (a
 * conversation's send) and the server (the thread send), so both write a
 * person's answers the same way:
 *
 *   On op-55 ("Rank Union's projects by the goals they carry"):
 *   - Approved, and applied: op-55#1, op-55#3 and op-55#4.
 *   - Rejected op-55#2 (make Matching Engine & Funnel a high priority): P1 is too high, make it P2.
 *   - On op-55#6 (make Callers & Call Management a medium priority): Cameron owns this, not Samvit.
 *   - On the whole proposal: do the same for the plans next.
 *
 * Approvals with no words fold into the first line. Every answer that carries
 * words or a rejection follows in the order of its first change, whatever
 * order the person gave them in, and words about the whole proposal come
 * last. Each change is written as its reference (`op-55#3`), which the agent
 * can act on and a person's bubble draws as a pill. Empty when the reply says
 * nothing (no items, or only a note with no words). With `applied: false`
 * the approvals read "Approved: op-55#1." and the agent reads the rows for
 * what has landed.
 */
export function proposalReplyText(reply: OrgProposalReply): string {
  const applied = reply.applied !== false;
  const refs = (seqs: number[]) => andList([...new Set(seqs)].sort((a, b) => a - b).map((seq) => proposalChangeRefId(reply.proposal, seq)));
  // A card's sentence inside a line: no capital, no full stop ("make Growth a high priority").
  const named = (item: OrgReplyItem) => {
    const line = item.line.trim().replace(/\.$/, "");
    return `${refs(item.seqs)}${line ? ` (${line.charAt(0).toLowerCase()}${line.slice(1)})` : ""}`;
  };
  // A person's words stay inside their bullet: a new line is indented, a blank one is dropped.
  const wordsOf = (item: OrgReplyItem) => (item.text ?? "").trim().replace(/\s*\n\s*/g, "\n  ");
  const said = (lead: string, words: string) => (words ? `${lead}: ${words}` : `${lead}.`);

  const folded: number[] = [];
  const about: OrgReplyItem[] = [];
  const whole: string[] = [];
  for (const item of reply.items) {
    const words = wordsOf(item);
    if (!item.seqs.length) { if (words) whole.push(`On the whole proposal: ${words}`); }
    else if (item.verdict === "approve" && !words) folded.push(...item.seqs);
    else if (item.verdict !== "note" || words) about.push(item);
  }
  const lines = [
    ...(folded.length ? [`Approved${applied ? ", and applied" : ""}: ${refs(folded)}.`] : []),
    ...about.sort((a, b) => Math.min(...a.seqs) - Math.min(...b.seqs)).map((item) => {
      const words = wordsOf(item);
      if (item.verdict === "approve") return `Approved ${refs(item.seqs)}${applied ? ", and applied" : ""}: ${words}`;
      return said(item.verdict === "reject" ? `Rejected ${named(item)}` : `On ${named(item)}`, words);
    }),
    ...whole,
  ];
  if (!lines.length) return "";
  // The ref alone: it renders as the proposal's titled pill, and the agent wrote the proposal.
  return [`On ${reply.proposal}:`, ...lines.map((l) => `- ${l}`)].join("\n");
}

/** Several proposals answered in one send: one block each, a blank line between. */
export function proposalRepliesText(replies: OrgProposalReply[]): string {
  return replies.map(proposalReplyText).filter(Boolean).join("\n\n");
}
