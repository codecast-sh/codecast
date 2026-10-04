// Centralizes the store choreography for the quote/comment review feature so the
// selection toolbar, the per-block review UI, and the review bar all drive the
// same state transitions (DRY). These touch only the ephemeral review state in
// inboxStore plus the composer-injection callback passed in by the caller.

import { useInboxStore } from "../store/inboxStore";
import { toBlockquote, formatPendingComments, sortPendingComments, pinNumbers, type PendingComment, type QuotedImage, type QuotedPage } from "./quoteFormat";
import type { ImageMarker } from "./markedImage";

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
// Pass `firstImageNumber` when the send attaches the quoted images (from
// quotedImages, after the composer's own, each with its pins drawn on it):
// each such image quote then names its attachment as `[Image N]`, numbered
// from there, and its point as the marker number drawn on it.
export function takeReviewBatch(conversationId: string, messageId?: string, firstImageNumber?: number): string {
  const s = useInboxStore.getState();
  const taken = sortPendingComments(s
    .getReviewComments(conversationId)
    .filter((c) => (c.body.trim() || c.quote.trim() || c.image) && (!messageId || c.messageId === messageId)));
  const attached = firstImageNumber ? attachedImageIds(taken) : [];
  const numbers = new Map(taken.flatMap((c) => {
    const i = c.image?.storageId ? attached.indexOf(c.image.storageId) : -1;
    return i >= 0 ? [[c.id, firstImageNumber! + i] as const] : [];
  }));
  const text = formatPendingComments(taken, numbers, pinNumbers(s.getReviewComments(conversationId)));
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
