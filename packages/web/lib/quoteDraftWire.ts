// The composer's quote batch and its server record (convex quoteDrafts.ts).
//
// The batch (`reviewComments`, lib/reviewActions) is where a quote is written
// while it waits for the next send, and it stays the composer's only source.
// Each batch write also hands the touched quotes to the server (store
// saveQuoteDrafts / removeQuoteDrafts), so a quote has a record once its
// message goes: sent, then answered. A person whose `quote_drafts` preference
// is false keeps the batch purely local.
//
// Pure: no store import, so the store's own writers can use it.

import { isConvexId } from "./entityLinks";
import type { PendingComment } from "./quoteFormat";

/** The server's shape for one quote (convex quoteDrafts.quoteDraftValidator). */
export type QuoteDraftWire = {
  client_id: string;
  message_id?: string;
  block_index: number;
  quote: string;
  body: string;
  verdict?: "approve" | "cut";
  created_at: number;
};

type UiState = { clientState?: { ui?: { quote_drafts?: boolean } | null } | null };

/** On for everyone unless the person set clientState.ui.quote_drafts to false. */
export function quoteDraftsOn(state: UiState): boolean {
  return state.clientState?.ui?.quote_drafts !== false;
}

/**
 * Does this batch item have a server twin? A quote of a block of a real
 * message in a conversation's batch. Doc and plan batches, pictures, page pins
 * and proposal answers stay local.
 */
export function isRecordedQuote(batchKey: string, item: PendingComment): boolean {
  return isConvexId(batchKey) && isConvexId(item.messageId) && !item.image && !item.page && !item.proposal;
}

export function toQuoteDraftWire(item: PendingComment): QuoteDraftWire {
  return {
    client_id: item.id,
    message_id: item.messageId,
    block_index: item.blockIndex,
    quote: item.quote,
    body: item.body,
    ...(item.verdict ? { verdict: item.verdict } : {}),
    created_at: item.createdAt,
  };
}

type MirrorState = UiState & {
  reviewComments: Record<string, PendingComment[] | undefined>;
  saveQuoteDrafts: (conversationId: string, drafts: QuoteDraftWire[]) => void;
  removeQuoteDrafts: (clientIds: string[]) => void;
};

/**
 * After a batch write: save the recorded quotes among `ids` that are still in
 * the batch, and drop the ones in `removed`. Nothing happens with the
 * preference off.
 */
export function mirrorQuoteBatch(state: MirrorState, batchKey: string, ids: string[], removed: string[] = []): void {
  if (!quoteDraftsOn(state)) return;
  const wanted = new Set(ids);
  const drafts = (state.reviewComments[batchKey] ?? [])
    .filter((c) => wanted.has(c.id) && isRecordedQuote(batchKey, c))
    .map(toQuoteDraftWire);
  if (drafts.length) state.saveQuoteDrafts(batchKey, drafts);
  if (removed.length) state.removeQuoteDrafts(removed);
}

/** Every recorded quote in every batch, saved once: the first load with the preference on. */
export function uploadQuoteBatches(state: MirrorState): number {
  if (!quoteDraftsOn(state)) return 0;
  let n = 0;
  for (const [key, items] of Object.entries(state.reviewComments)) {
    const drafts = (items ?? []).filter((c) => isRecordedQuote(key, c)).map(toQuoteDraftWire);
    for (let i = 0; i < drafts.length; i += 100) state.saveQuoteDrafts(key, drafts.slice(i, i + 100));
    n += drafts.length;
  }
  return n;
}
