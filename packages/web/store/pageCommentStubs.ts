// The optimistic page comment: its client id, and the stubs a pageThreads push
// carries forward until the server echoes them.
import type { PageThreadRow } from "./threadTypes";

/** Client id for an optimistic page comment (the server dedupes on it). */
export function newPageCommentClientId(): string {
  return `pagecmt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A push of pageThreads rows with this window's unsent reply stubs carried
 *  forward: a push racing the server's write would otherwise clobber the reply
 *  for a beat. A stub retires when the echoed row carries its client_id, or
 *  after a minute (the send failed or the outbox is retrying). */
export function withPageCommentStubs(pages: PageThreadRow[], local: Record<string, PageThreadRow | undefined>): PageThreadRow[] {
  return pages.map((p) => {
    const prev = local[String(p._id)];
    if (!prev) return p;
    const echoed = new Set((p.comments ?? []).map((c) => c.client_id).filter(Boolean));
    const stubs = (prev.comments ?? []).filter(
      (c) => c._id.startsWith("pagecmtstub-") && !echoed.has(c.client_id) && c.created_at > Date.now() - 60_000,
    );
    return stubs.length ? { ...p, comments: [...(p.comments ?? []), ...stubs] } : p;
  });
}
