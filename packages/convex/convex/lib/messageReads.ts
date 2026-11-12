// Two reads conversations.ts takes from a session's messages: the newest
// image preview URL, and the file changes a fold reads. Leaf module, so
// conversations.ts does not import messages.ts, which reaches the big import
// cycle (ct-92432).
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../functions";
import type { FileChange } from "../fileChanges/extractor";
import { readFoldChanges } from "../fileChangeBodies";

/**
 * The changes a fold of the whole conversation reads, with their text, under
 * a byte budget (fileChangeBodies.readFoldChanges). `cast diff` draws its tree
 * from this; the web reads the index and bodies separately (messages.ts).
 */
export async function listConversationFileChanges(
  ctx: QueryCtx,
  conversationId: Id<"conversations">,
): Promise<{ changes: FileChange[]; truncated: boolean }> {
  return readFoldChanges(ctx, conversationId);
}

// Newest displayable image in a message batch → the conversation's inbox
// thumbnail (conversations.image_preview_url). Storage-backed images (pasted
// attachments, tool screenshots) resolve via ctx.storage.getUrl; markdown
// images embedded in prose (`cast image` output) count only when they point at
// our own storage origin — mirroring the web's trusted-origin gate, so a
// third-party URL an agent emits can never become a team-visible thumbnail.
// Scans newest-first and returns the first hit; undefined when the batch
// carries no image.
export const MD_IMAGE_URL_RE = /!\[[^\]]*\]\((https?:\/\/[^)\s]+?)(?:\s+"[^"]*")?\)/g;
export function trustedImageOrigin(): string | null {
  const base = process.env.CONVEX_CLOUD_ORIGIN || process.env.CONVEX_CLOUD_URL || process.env.VITE_CONVEX_URL || "";
  try { return base ? new URL(base).origin : null; } catch { return null; }
}

export async function latestImagePreviewUrl(
  ctx: { storage: { getUrl: (id: any) => Promise<string | null> } },
  msgs: Array<{ content?: string; images?: Array<{ storage_id?: string }> }>,
): Promise<string | undefined> {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.images) {
      for (let j = m.images.length - 1; j >= 0; j--) {
        const sid = m.images[j].storage_id;
        if (!sid) continue;
        const url = await ctx.storage.getUrl(sid as any);
        if (url) return url;
      }
    }
    if (m.content && m.content.includes("![")) {
      const origin = trustedImageOrigin();
      if (origin) {
        let last: string | undefined;
        for (const match of m.content.matchAll(MD_IMAGE_URL_RE)) {
          try {
            if (new URL(match[1]).origin === origin) last = match[1];
          } catch {}
        }
        if (last) return last;
      }
    }
  }
  return undefined;
}
