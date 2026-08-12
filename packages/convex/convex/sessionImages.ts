// Scan messages for every image the transcript can display — the source list for
// the header gallery on web AND mobile, and the same scan that materializes
// conversation_images rows at ingest (materializeConversationImages in
// messages.ts). Lives here, next to the other shared extractors, so the server
// list and the client window extraction can never drift apart.
//
// Three channels, in message order:
//   • msg.images without tool_use_id — user attachments (pasted/uploaded)
//   • msg.images with tool_use_id — tool-result screenshots
//   • markdown ![](url) images embedded in prose — only when the caller's
//     trust gate passes (the same origin policy the renderers enforce; an
//     untrusted URL never auto-loads there, so it must not appear here either)
//
// Storage-backed entries carry storage_id and resolve to a URL by the caller
// (web: useStorageImageUrls; mobile: getImageUrl); data/markdown entries carry
// a ready src. Deduped by identity so an image echoed in two channels (e.g. an
// injected attachment also referenced in prose) appears once.

export type SessionImageEntry = {
  // Stable identity for dedupe + React keys: the storage id or the src itself.
  key: string;
  storage_id?: string;
  src?: string;
  // Transcript position, so a server list and a client window list merge back
  // into one correctly-ordered gallery. Absent on entries from callers that
  // don't carry message timestamps.
  timestamp?: number;
  seq?: number;
};

type MessageLike = {
  content?: string;
  timestamp?: number;
  images?: Array<{ media_type: string; data?: string; storage_id?: string }>;
};

const MD_IMAGE_SRC_RE = /!\[[^\]]*\]\(([^)\s]+?)(?:\s+"[^"]*")?\)/g;

export function extractSessionImages(
  messages: readonly MessageLike[],
  isTrustedSrc: (src: string) => boolean,
): SessionImageEntry[] {
  const seen = new Set<string>();
  const out: SessionImageEntry[] = [];
  const push = (entry: SessionImageEntry) => {
    if (seen.has(entry.key)) return;
    seen.add(entry.key);
    out.push(entry);
  };
  for (const msg of messages) {
    // Per-message ordinal: two images in one message keep their order once the
    // merge re-sorts by (timestamp, seq).
    let seq = 0;
    const at = () => ({ timestamp: msg.timestamp, seq: seq++ });
    if (msg.images) {
      for (const img of msg.images) {
        if (img.storage_id) {
          push({ key: img.storage_id, storage_id: img.storage_id, ...at() });
        } else if (img.data) {
          const src = `data:${img.media_type};base64,${img.data}`;
          push({ key: src, src, ...at() });
        }
      }
    }
    if (msg.content && msg.content.includes("![")) {
      for (const match of msg.content.matchAll(MD_IMAGE_SRC_RE)) {
        const src = match[1];
        if (isTrustedSrc(src)) push({ key: src, src, ...at() });
      }
    }
  }
  return out;
}

/**
 * Merge the server's complete, pagination-independent list with the client's
 * extraction from the loaded message window. The server set is authoritative
 * and covers the whole thread; the client set backfills conversations whose
 * images predate materialization, and inline data: images, which are never
 * materialized (a base64 payload doesn't belong in an index table).
 *
 * Deduped by key, ordered by (timestamp, in-message seq). Entries with no
 * timestamp sort last in their original order — the pre-timestamp shape.
 */
export function mergeSessionImages(
  serverEntries: readonly SessionImageEntry[],
  clientEntries: readonly SessionImageEntry[],
): SessionImageEntry[] {
  const byKey = new Map<string, SessionImageEntry>();
  // Client first so the server entry wins on conflict: it carries the true
  // transcript position even when the window shows the image out of context.
  for (const e of clientEntries) byKey.set(e.key, e);
  for (const e of serverEntries) byKey.set(e.key, e);
  const order = new Map<string, number>();
  let i = 0;
  for (const key of byKey.keys()) order.set(key, i++);
  return Array.from(byKey.values()).sort((a, b) => {
    if (a.timestamp === undefined || b.timestamp === undefined) {
      if (a.timestamp !== b.timestamp) return a.timestamp === undefined ? 1 : -1;
      return order.get(a.key)! - order.get(b.key)!;
    }
    return a.timestamp - b.timestamp || (a.seq ?? 0) - (b.seq ?? 0);
  });
}
