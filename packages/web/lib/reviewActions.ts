// Centralizes the store choreography for the quote/comment review feature so the
// selection toolbar, the per-block review UI, and the review bar all drive the
// same state transitions (DRY). These touch only the ephemeral review state in
// inboxStore plus the composer-injection callback passed in by the caller.

import { useInboxStore } from "../store/inboxStore";
import { toBlockquote, formatPendingComments, sortPendingComments, pinNumbers, isProposalAnswer, type PendingComment, type PendingProposalAnswer, type QuotedImage, type QuotedPage } from "./quoteFormat";
import type { ImageMarker } from "./markedImage";
import { proposalRepliesText, type OrgProposalReply, type OrgReplyItem, type OrgReplyVerdict } from "@codecast/shared/contracts/orgProposal";
import { humanizeConvexError } from "@codecast/shared/contracts";
import { proposalSeen } from "../components/org/proposalHooks";
import { orgVerdictRevisedNotice, type OrgReplyInput, type OrgReplyOpts } from "../store/orgSlice";

export type PopulateFn = (text: string, opts?: { append?: boolean }) => void;

export function genCommentId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `pc_${Date.now()}_${Math.round(Math.random() * 1e6)}`;
  }
}

// Create a pending comment anchored to a block (quote = full block) or a
// sub-selection (quote = highlighted text), make its message the review target,
// and open its note editor focused. Returns the new comment id.
export function createReviewComment(
  conversationId: string,
  messageId: string,
  blockIndex: number,
  quote: string,
): string {
  const s = useInboxStore.getState();
  const id = genCommentId();
  // The quote is committed at once (it shows up as a chip in the rail and a
  // row in the batch tray) and the note editor opens on it right away, since a
  // quote is nearly always the start of a remark. Leaving the note blank (Esc)
  // keeps it a bare quote. setReviewTarget keeps keyboard nav anchored to it.
  s.addReviewComment(conversationId, { id, messageId, blockIndex, quote, body: "", createdAt: Date.now() });
  s.setReviewTarget(messageId, blockIndex);
  s.setReviewEditingId(id);
  return id;
}

// Append a blockquote of `text` straight into the composer (no batch).
export function quoteToComposer(text: string, populate: PopulateFn): void {
  const q = toBlockquote(text);
  if (q) populate(q, { append: true });
}

// Compile the pending batch into markdown without touching the composer, and
// clear the batch. The composer's send path calls this to AUTO-ATTACH the quotes
// to the outgoing message, so the user never has to remember a separate "add to
// message" step; a plain send carries the quotes. Returns "" when nothing pending.
//
// Pass `messageId` to take only the comments anchored to one review target (e.g.
// a plan rendered under its own namespaced key) and clear just those, leaving any
// other pending comments untouched. A partial take never takes proposal answers.
//
// Pass `firstImageNumber` when the send attaches the quoted images (from
// quotedImages, after the composer's own, each with its pins drawn on it):
// each such image quote then names its attachment as `[Image N]`, numbered
// from there, and its point as the marker number drawn on it.
//
// A whole take is the send: the proposal answers in the batch are applied
// (takeProposalAnswers) and their words lead the message, then the quotes.
export function takeReviewBatch(conversationId: string, messageId?: string, firstImageNumber?: number): string {
  const s = useInboxStore.getState();
  const answers = messageId ? "" : takeProposalAnswers(conversationId, { sentIn: conversationId });
  const taken = sortPendingComments(s
    .getReviewComments(conversationId)
    .filter((c) => !isProposalAnswer(c) && (c.body.trim() || c.quote.trim() || c.image) && (!messageId || c.messageId === messageId)));
  const attached = firstImageNumber ? attachedImageIds(taken) : [];
  const numbers = new Map(taken.flatMap((c) => {
    const i = c.image?.storageId ? attached.indexOf(c.image.storageId) : -1;
    return i >= 0 ? [[c.id, firstImageNumber! + i] as const] : [];
  }));
  const quotes = formatPendingComments(taken, numbers, pinNumbers(s.getReviewComments(conversationId)));
  const text = [answers, quotes].filter(Boolean).join("\n\n");
  if (!text) return "";
  if (messageId) {
    taken.forEach((c) => s.removeReviewComment(conversationId, c.id));
  } else {
    s.clearReviewComments(conversationId);
    s.setReviewTarget(null);
    s.setReviewEditingId(null);
  }
  return text;
}

// Build the outgoing message: the pending batch (if any) prepended to the typed
// reply, clearing the batch. The composer's send path calls this so a plain send
// carries the quotes. With nothing pending it returns `typed` untouched.
export function attachReviewToMessage(conversationId: string, typed: string, firstImageNumber?: number): string {
  const batch = takeReviewBatch(conversationId, undefined, firstImageNumber);
  if (!batch) return typed;
  const reply = (typed || "").trim();
  return reply ? `${batch}\n\n${reply}` : batch;
}

// ── A card answers the agent (org-staffing.md S39) ──────────────────────────
// A person's answer to one card of an org proposal joins the same batch as
// the quotes: one item per card, replaced when the card is answered again,
// withdrawn when the answer is null. The batch key is the conversation whose
// composer is in reach, or the key a surface with no composer uses.

export type ProposalCardRef = {
  proposal: { id: string; short_id: string; title: string };
  /** SubjectCard.key; "" for the whole proposal (a note only). */
  key: string;
  change_ids: string[];
  seqs: number[];
  sentence: string;
  ordinal?: number;
  /** The card's or the group's title, which names the row in the tray. */
  subject?: string;
};

/** A note with nothing said: no answer. Blank words are kept while the
 *  field is open mid thought; the card withdraws them on close, and the take
 *  drops them. */
const blankNote = (c: { verdict: OrgReplyVerdict; text?: string }) => c.verdict === "note" && !(c.text ?? "").trim();

/** Put, replace or withdraw this card's answer in the batch. One answer
 *  stands for a change: putting one withdraws every other card's answer
 *  over the same changes (the panel's ask over a card inside it, the
 *  chart's ghost over the ledger's card), so no two ever wait together. A
 *  note on the whole proposal (key "") overlaps nothing. */
export function answerProposalCard(batchKey: string, card: ProposalCardRef, answer: { verdict: OrgReplyVerdict; text?: string; leave_sessions?: boolean } | null): void {
  const s = useInboxStore.getState();
  const have = pendingAnswerOf(s.reviewComments[batchKey], card.proposal.id, card.key);
  // No answer, or a note with no words at all, is no answer.
  if (!answer || (answer.verdict === "note" && !answer.text)) {
    if (have) s.removeReviewComment(batchKey, have.id);
    return;
  }
  withdrawOverlapping(batchKey, card);
  const body = answer.text ?? "";
  const leave = answer.verdict === "approve" && !!answer.leave_sessions;
  const proposal: PendingProposalAnswer = {
    id: card.proposal.id, short_id: card.proposal.short_id, title: card.proposal.title, card: card.key,
    change_ids: card.change_ids, seqs: card.seqs, verdict: answer.verdict, ...(card.ordinal !== undefined ? { ordinal: card.ordinal } : {}), ...(leave ? { leave_sessions: true } : {}), ...(card.subject ? { subject: card.subject } : {}),
  };
  // Same verdict: only the words moved, so the item keeps its place and id.
  if (have && have.proposal.verdict === answer.verdict && sameSeqs(have.proposal.seqs, card.seqs) && !!have.proposal.leave_sessions === leave) {
    s.commitReviewComment(batchKey, have.id, body);
    return;
  }
  if (have) s.removeReviewComment(batchKey, have.id);
  s.addReviewComment(batchKey, { id: genCommentId(), messageId: "", blockIndex: 0, quote: card.sentence, body, createdAt: Date.now(), proposal });
}

function withdrawOverlapping(batchKey: string, of: ProposalCardRef): void {
  const s = useInboxStore.getState();
  const seqs = new Set(of.seqs);
  const ids = new Set(of.change_ids);
  for (const item of proposalAnswersOf(s.reviewComments[batchKey], of.proposal.id)) {
    if (item.proposal.card === of.key || item.proposal.card === "") continue;
    if (item.proposal.seqs.some((n) => seqs.has(n)) || item.proposal.change_ids.some((id) => ids.has(id))) s.removeReviewComment(batchKey, item.id);
  }
}

const sameSeqs = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((n, i) => n === b[i]);

/** This card's pending answer, if any (a selector for the card to subscribe to). */
export function pendingAnswerOf(comments: readonly PendingComment[] | undefined, proposalId: string, cardKey: string): (PendingComment & { proposal: PendingProposalAnswer }) | undefined {
  return comments?.find((c): c is PendingComment & { proposal: PendingProposalAnswer } => isProposalAnswer(c) && c.proposal.id === proposalId && c.proposal.card === cardKey);
}

/** Every pending answer of one proposal, in the order given. */
export function proposalAnswersOf(comments: readonly PendingComment[] | undefined, proposalId: string): (PendingComment & { proposal: PendingProposalAnswer })[] {
  return (comments ?? []).filter((c): c is PendingComment & { proposal: PendingProposalAnswer } => isProposalAnswer(c) && c.proposal.id === proposalId);
}

/** The answers of one proposal as the store action takes them; a note with nothing said is not one. */
export function replyItemsOf(comments: readonly PendingComment[] | undefined, proposalId: string): OrgReplyInput[] {
  return proposalAnswersOf(comments, proposalId).filter((c) => !blankNote({ verdict: c.proposal.verdict, text: c.body })).map((c) => ({
    verdict: c.proposal.verdict, change_ids: c.proposal.change_ids, seqs: c.proposal.seqs, ...(c.body.trim() ? { text: c.body.trim() } : {}),
  }));
}

export type BatchSendWords = {
  /** Changes the send applies: the change ids over the approve items. */
  applies: number;
  /** Rejections and notes with words: the answers the send carries. */
  answers: number;
  /** Items that quote a message. */
  quotes: number;
  /** The tray's head sentence; null with nothing to say. */
  head: string | null;
  /** The composer button's words; null when the icon stands. */
  button: string | null;
  /** The composer's placeholder while answers wait; null otherwise. */
  placeholder: string | null;
};

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** The one home for counting a batch: what the tray's head, the composer's
 *  button and its placeholder say about the next send. Pure. */
export function batchSendWords(comments: readonly PendingComment[]): BatchSendWords {
  let applies = 0;
  let answers = 0;
  let quotes = 0;
  for (const c of comments) {
    if (!isProposalAnswer(c)) quotes += 1;
    else if (c.proposal.verdict === "approve") applies += c.proposal.change_ids.length;
    else if (!blankNote({ verdict: c.proposal.verdict, text: c.body })) answers += 1;
  }
  const applyWords = `${plural(applies, "change")} will apply when you send`;
  const answerWords = (lead: string) => `${plural(answers, "answer")} ${answers === 1 ? "goes" : "go"} ${lead}`;
  const quoteWords = plural(quotes, "quote");
  const head = applies && answers ? `${applyWords}, and ${answerWords("with them")}`
    : applies ? applyWords
    : answers ? answerWords("when you send")
    : quotes ? `${quoteWords} on your next message`
    : null;
  return {
    applies, answers, quotes,
    head: head && quotes && (applies || answers) ? `${head} · ${quoteWords}` : head,
    button: applies ? `Send and apply ${applies}` : answers ? `Send ${plural(answers, "answer")}` : null,
    placeholder: answers ? "Add a word if you like, or just send." : null,
  };
}

/** The words a proposal's answers read as (proposalReplyText), from the batch. */
function replyOf(answers: readonly (PendingComment & { proposal: PendingProposalAnswer })[]): OrgProposalReply {
  const first = answers[0].proposal;
  const items: OrgReplyItem[] = answers.map((c) => ({ verdict: c.proposal.verdict, seqs: c.proposal.seqs, ...(c.body.trim() ? { text: c.body.trim() } : {}), line: c.quote }));
  return { proposal: first.short_id, title: first.title, items };
}

/**
 * Take the proposal answers out of the batch: apply them (one
 * replyOnOrgProposal per proposal, `seen` from the store's rows of that
 * proposal) and return the words for the message, one block per proposal.
 * With `proposalId` only that proposal's answers are taken; `say` rides to
 * the server for a surface with no composer, which then sends the words
 * into the proposal's thread itself. A send from a conversation (`sentIn`)
 * adds `say` on its own for a proposal whose thread is another
 * conversation, with no body: the typed words stay here and the server
 * writes the reply into the author's thread. A proposal's approvals leave
 * the sessions where they are when any of them asks to (`leave_sessions`,
 * per proposal on the server), or when the caller does. A note left blank
 * is dropped, not sent. Returns "" when nothing was pending.
 */
export function takeProposalAnswers(batchKey: string, opts?: { proposalId?: string; say?: OrgReplyOpts["say"]; leave_sessions?: boolean; sentIn?: string }): string {
  const s = useInboxStore.getState();
  const taken = (s.reviewComments[batchKey] ?? []).filter(isProposalAnswer).filter((c) => !opts?.proposalId || c.proposal.id === opts.proposalId);
  const all = taken.filter((c) => !blankNote({ verdict: c.proposal.verdict, text: c.body }));
  const byProposal = new Map<string, typeof all>();
  for (const c of all) (byProposal.get(c.proposal.id) ?? byProposal.set(c.proposal.id, []).get(c.proposal.id)!).push(c);
  const replies: OrgProposalReply[] = [];
  for (const [proposalId, answers] of byProposal) {
    const rows = Object.values(s.orgProposalChanges).filter((c) => c.proposal_id === proposalId);
    const items = replyItemsOf(answers, proposalId);
    const leave = !!opts?.leave_sessions || answers.some((c) => c.proposal.leave_sessions);
    if (opts?.sentIn) noteReplySent(proposalId, answers[0].proposal.short_id, opts.sentIn);
    const thread = s.orgProposals[proposalId]?.thread?.conversation_id;
    const say = opts?.say ?? (opts?.sentIn && thread && thread !== opts.sentIn ? { thread, client_id: `optimistic_${Date.now()}_${Math.random().toString(36).slice(2)}` } : undefined);
    s.replyOnOrgProposal(proposalId, items, proposalSeen(rows), { ...(leave ? { leave_sessions: true } : {}), ...(say ? { say } : {}) });
    replies.push(replyOf(answers));
  }
  for (const c of taken) s.removeReviewComment(batchKey, c.id);
  return replies.length ? proposalRepliesText(replies) : "";
}

// ── The words went out before the verdicts landed ───────────────────────────
// On the conversation path the message says "Approved, and applied" in the
// same tick the reply is dispatched. When the server refuses that dispatch
// for good (the author revised under the reader, an admin check, a rider's
// dependency), the rows revert while the agent has read "applied", and the
// batch is already cleared. The store's refusal mark (applyDispatchFailure
// writes `lastDispatchFailure`; the org intents revert through the same
// call) is the one signal, so a correction line follows the message into
// the same conversation through the composer's own path: an optimistic
// bubble, then the send. A `say` take needs none: there the server sends
// the words itself, and a refusal sends nothing.

/** Where a proposal's reply words went, by proposal id, for as long as a refusal could still arrive. */
const replySentIn = new Map<string, { conversationId: string; short_id: string; at: number }>();
const REPLY_SENT_TTL_MS = 10 * 60_000;
let watchingRefusals = false;

function noteReplySent(proposalId: string, short_id: string, conversationId: string): void {
  const now = Date.now();
  for (const [id, sent] of replySentIn) if (now - sent.at > REPLY_SENT_TTL_MS) replySentIn.delete(id);
  replySentIn.set(proposalId, { conversationId, short_id, at: now });
  if (watchingRefusals) return;
  watchingRefusals = true;
  useInboxStore.subscribe((st, prev) => {
    const failure = st.lastDispatchFailure;
    if (!failure || failure === prev.lastDispatchFailure) return;
    correctRefusedReply(failure);
  });
}

/** The refusal of one reply dispatch: the correction into its conversation, once. */
export function correctRefusedReply(failure: { action: string; args: unknown; message: string; at: number }): void {
  if (failure.action !== "replyOnOrgProposal" || !Array.isArray(failure.args) || typeof failure.args[0] !== "string") return;
  const sent = replySentIn.get(failure.args[0]);
  if (!sent || failure.at < sent.at) return;
  replySentIn.delete(failure.args[0]);
  // The revised refusal in the server's own words (the first sentence; the
  // rest addresses the person); any other, humanized.
  const why = orgVerdictRevisedNotice(failure.message)?.split(". ")[0] ?? humanizeConvexError(failure.message, "");
  const line = `Correction: my answers on ${sent.short_id} above were refused and nothing was applied${why ? ` (${why})` : ""}. Treat them as not given.`;
  const s = useInboxStore.getState();
  const clientId = s.addOptimisticMessage(sent.conversationId, line);
  s.sendMessageWhenReady(sent.conversationId, line, undefined, clientId);
}

// Pictures whose bytes live in storage ride along on the send as real
// attachments, once each however many notes pin them, so the agent receives
// the picture itself, with every note's point on it as a numbered marker.
// Batch order, which is the order takeReviewBatch numbers them in.
function attachedImageIds(comments: PendingComment[]): string[] {
  return [...new Set(comments.flatMap((c) => (c.image?.storageId ? [c.image.storageId] : [])))];
}

export type QuotedAttachment = { storageId: string; src: string; markers: ImageMarker[] };

export function quotedImages(conversationId: string): QuotedAttachment[] {
  const comments = useInboxStore.getState().getReviewComments(conversationId);
  const numbers = pinNumbers(comments);
  const sorted = sortPendingComments(comments);
  return attachedImageIds(sorted).map((storageId) => {
    const pins = comments.filter((c) => c.image?.storageId === storageId);
    return {
      storageId,
      src: pins[0].image!.src,
      markers: pins.flatMap((c) => (c.image!.point && numbers.has(c.id) ? [{ ...c.image!.point, number: numbers.get(c.id)! }] : [])),
    };
  });
}

// Where a gallery image came from, in words the agent can match against its
// own transcript: the tool call that produced it (with the call's main input,
// e.g. the file it read) for a tool result, else whose message it was in and
// how that message opens; and when.
export function describeImageSource(conversationId: string, image: { messageId?: string; timestamp?: number; storageId?: string }): string {
  const messages = useInboxStore.getState().messages[conversationId] ?? [];
  const msg = image.messageId ? messages.find((m) => m._id === image.messageId) : undefined;
  const ts = msg?.timestamp ?? image.timestamp;
  const when = ts ? ` at ${new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : "";
  const images = (msg?.images ?? []) as { storage_id?: string; tool_use_id?: string }[];
  const toolUseId = (images.find((i) => i.storage_id && i.storage_id === image.storageId) ?? images[0])?.tool_use_id;
  const call = toolUseId ? messages.flatMap((m) => m.tool_calls ?? []).find((c) => c?.id === toolUseId) : undefined;
  if (call) {
    const input = toolCallGist(call.input);
    return `Image returned by your ${call.name} call${when}${input ? `: \`${input}\`` : ""}`;
  }
  const who = !msg ? " the conversation" : msg.role === "user" ? " my message" : " your message";
  // Drop the message's own image markup and [Image N] tokens: they would read
  // as pointers to this send's attachments.
  const text = clip((msg?.content ?? "").replace(/!\[[^\]]*\]\([^)]*\)|\[Image \d+\]/g, ""), 100);
  return `Image from${who}${when}${text ? `: "${text}"` : ""}`;
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

// The one input that says what a tool call did: the file, url or command.
function toolCallGist(input: unknown): string {
  let args: Record<string, unknown> | null = null;
  try {
    args = typeof input === "string" ? JSON.parse(input) : (input as Record<string, unknown>);
  } catch {
    return clip(String(input ?? ""), 80);
  }
  const value = args && ["file_path", "path", "url", "command", "description"].map((k) => args![k]).find((v) => typeof v === "string");
  return value ? clip((value as string).split("\n")[0], 80) : "";
}

// Pin a note to a point of a gallery image: it joins the same batch as the
// paragraph quotes and opens its note editor. Returns the new comment id.
export function addImagePin(
  conversationId: string,
  image: Omit<QuotedImage, "point"> & { messageId?: string; timestamp?: number },
  point: { x: number; y: number },
): string {
  const s = useInboxStore.getState();
  const id = genCommentId();
  const { messageId, timestamp, ...picture } = image;
  s.addReviewComment(conversationId, {
    id,
    messageId: messageId ?? "",
    blockIndex: 0,
    quote: describeImageSource(conversationId, image),
    body: "",
    createdAt: Date.now(),
    image: { ...(Object.fromEntries(Object.entries(picture).filter(([, v]) => v !== undefined)) as typeof picture), point },
  });
  s.setReviewEditingId(id);
  return id;
}

// Pin a note to a spot of a published page framed in the thread: it joins the
// same batch as paragraph quotes and image pins. The quote names the page by
// its address and the spot by the words there (what the agent can find in the
// page's source), falling back to how far down the page it sits.
export function addPageNote(
  conversationId: string,
  messageId: string,
  page: QuotedPage & { title: string; url: string },
): string {
  const s = useInboxStore.getState();
  const id = genCommentId();
  const { title, url, ...anchor } = page;
  const where = anchor.snippet
    ? `, at "${clip(anchor.snippet, 160)}"`
    : anchor.point ? `, ${Math.round(anchor.point.y * 100)}% down the page` : "";
  s.addReviewComment(conversationId, {
    id,
    messageId,
    blockIndex: 0,
    quote: `Published page "${title}" (${url})${where}`,
    body: "",
    createdAt: Date.now(),
    page: anchor,
  });
  s.setReviewEditingId(id);
  return id;
}

// Compile the quotes of the batch into the composer (so they can be edited
// inline) and clear review state. The OPTIONAL "edit in input" action: sending
// already attaches the batch via takeReviewBatch, this just materializes it as
// editable text first. Proposal answers stay in the batch: turned into text
// they would send words and apply nothing.
export function submitReview(conversationId: string, populate: PopulateFn): boolean {
  const s = useInboxStore.getState();
  const comments = s.getReviewComments(conversationId).filter((c) => !isProposalAnswer(c) && (c.body.trim() || c.quote.trim() || c.image));
  const text = formatPendingComments(sortPendingComments(comments));
  if (!text) return false;
  populate(text, { append: true });
  for (const c of s.getReviewComments(conversationId)) if (!isProposalAnswer(c)) s.removeReviewComment(conversationId, c.id);
  s.setReviewTarget(null);
  s.setReviewEditingId(null);
  return true;
}

// Discard the whole batch and leave review mode.
export function cancelReview(conversationId: string): void {
  const s = useInboxStore.getState();
  s.clearReviewComments(conversationId);
  s.setReviewTarget(null);
  s.setReviewEditingId(null);
}

// Leave keyboard/inline review mode but KEEP the pending comments (they stay
// visible as chips and in the review bar).
export function exitReviewMode(): void {
  const s = useInboxStore.getState();
  s.setReviewTarget(null);
  s.setReviewEditingId(null);
}
