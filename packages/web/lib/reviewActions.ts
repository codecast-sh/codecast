// Centralizes the store choreography for the quote/comment review feature so the
// selection toolbar, the per-block review UI, and the review bar all drive the
// same state transitions (DRY). These touch only the ephemeral review state in
// inboxStore plus the composer-injection callback passed in by the caller.

import { useInboxStore } from "../store/inboxStore";
import { toBlockquote, formatPendingComments, sortPendingComments, type PendingComment, type QuotedImage } from "./quoteFormat";

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
  // The quote is committed at once — it shows up as a chip in the rail and a
  // row in the batch tray — and the note editor opens on it right away, since a
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
// to the outgoing message — so the user never has to remember a separate "add to
// message" step; a plain send carries the quotes. Returns "" when nothing pending.
//
// Pass `messageId` to take only the comments anchored to one review target (e.g.
// a plan rendered under its own namespaced key) and clear just those, leaving any
// other pending comments untouched.
//
// Pass `firstImageNumber` when the send attaches the quoted images (the ids
// from quotedImageStorageIds, after the composer's own): each such image quote
// then names its attachment as `[Image N]`, numbered from there.
export function takeReviewBatch(conversationId: string, messageId?: string, firstImageNumber?: number): string {
  const s = useInboxStore.getState();
  const taken = sortPendingComments(s
    .getReviewComments(conversationId)
    .filter((c) => (c.body.trim() || c.quote.trim() || c.image) && (!messageId || c.messageId === messageId)));
  const numbers = firstImageNumber
    ? new Map(attachableImageQuotes(taken).map((c, i) => [c.id, firstImageNumber + i]))
    : undefined;
  const text = formatPendingComments(taken, numbers);
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

// Image quotes whose bytes live in storage can ride along on the send as real
// attachments, so the agent receives the picture itself. Batch order, which is
// the order takeReviewBatch numbers them in.
function attachableImageQuotes(comments: PendingComment[]): PendingComment[] {
  return comments.filter((c) => c.image?.storageId);
}

export function quotedImageStorageIds(conversationId: string): string[] {
  const comments = sortPendingComments(useInboxStore.getState().getReviewComments(conversationId));
  return attachableImageQuotes(comments).map((c) => c.image!.storageId!);
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

// Quote a gallery image into the batch, or take it back out when it is already
// quoted. Keyed by the image's src, so the gallery can show which are in.
// Returns whether the image is quoted afterwards.
export function toggleImageQuote(
  conversationId: string,
  image: QuotedImage & { messageId?: string; timestamp?: number },
): boolean {
  const s = useInboxStore.getState();
  const existing = s.getReviewComments(conversationId).find((c) => c.image?.src === image.src);
  if (existing) {
    s.removeReviewComment(conversationId, existing.id);
    return false;
  }
  s.addReviewComment(conversationId, {
    id: genCommentId(),
    messageId: image.messageId ?? "",
    blockIndex: 0,
    quote: describeImageSource(conversationId, image),
    body: "",
    createdAt: Date.now(),
    image: { src: image.src, ...(image.href ? { href: image.href } : {}), ...(image.storageId ? { storageId: image.storageId } : {}) },
  });
  return true;
}

// Compile the whole batch into the composer (so it can be edited inline) and clear
// review state. The OPTIONAL "edit in input" action — sending already attaches the
// batch via takeReviewBatch, this just materializes it as editable text first.
export function submitReview(conversationId: string, populate: PopulateFn): boolean {
  const s = useInboxStore.getState();
  const comments = s.getReviewComments(conversationId).filter((c) => c.body.trim() || c.quote.trim() || c.image);
  const text = formatPendingComments(sortPendingComments(comments));
  if (!text) return false;
  populate(text, { append: true });
  s.clearReviewComments(conversationId);
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
