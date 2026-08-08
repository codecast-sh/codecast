// Scan a conversation's messages for every image the transcript can display —
// the source list for the header gallery on web AND mobile (mobile imports this
// via @codecast/web). Three channels, in message order:
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
};

type MessageLike = {
  content?: string;
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
    if (msg.images) {
      for (const img of msg.images) {
        if (img.storage_id) {
          push({ key: img.storage_id, storage_id: img.storage_id });
        } else if (img.data) {
          const src = `data:${img.media_type};base64,${img.data}`;
          push({ key: src, src });
        }
      }
    }
    if (msg.content && msg.content.includes("![")) {
      for (const match of msg.content.matchAll(MD_IMAGE_SRC_RE)) {
        const src = match[1];
        if (isTrustedSrc(src)) push({ key: src, src });
      }
    }
  }
  return out;
}
