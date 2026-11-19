import { useRef, useMemo } from "react";
import { useWatchEffect } from "./useWatchEffect";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useStorageImageUrls } from "./useStorageImageUrl";
import { extractSessionImages, mergeSessionImages, type SessionImageEntry } from "../lib/sessionImages";
import { isRemoteImageSrc } from "../lib/trustedImageOrigins";
import { shareTokenArg } from "../lib/shareTokenScope";
import { useMutation } from "convex/react";
import { api as _typedApi } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { interleaveGalleryPages, type GalleryImage, type GalleryItem } from "../lib/galleryItems";
import { useInboxStore, isConvexId } from "../store/inboxStore";
import { ownsConversationAccount } from "../lib/liveEntities";
import { useSessionPages } from "./useSessionPages";
import { usePageEmbedFeed } from "./usePageInfo";
import type { ConversationData } from "../components/conversation/types";

const api = _typedApi as any;

export function useSessionImages({ deferredQueriesEnabled, conversation }: {
  deferredQueriesEnabled: boolean;
  conversation: ConversationData | null | undefined;
}) {
  // Every image in the session, in transcript order — the header gallery's
  // source list (attachments, tool screenshots, trusted markdown images).
  //
  // The server list is the whole thread, materialized at ingest and independent
  // of how many message pages are loaded; scanning the window alone counted the
  // tail only, so a long session showed a fraction of its images. The window
  // extraction still runs and merges in: it covers inline base64 images (never
  // materialized) and any history the one-time sweep hasn't reached yet.
  const { data: serverSessionImages } = useQueryNoThrow(
    api.messages.getConversationImages,
    deferredQueriesEnabled && conversation?._id && isConvexId(conversation._id)
      ? { conversation_id: conversation._id as Id<"conversations">, ...shareTokenArg(conversation._id) }
      : "skip"
  );
  const windowImageEntries = useMemo(
    () => extractSessionImages(conversation?.messages ?? [], (src) => !isRemoteImageSrc(src)),
    [conversation?.messages]
  );
  const sessionImageEntries = useMemo(
    () => mergeSessionImages(serverSessionImages ?? [], windowImageEntries),
    [serverSessionImages, windowImageEntries]
  );
  const sessionImageStorageIds = useMemo(
    () => sessionImageEntries.map((e) => e.storage_id),
    [sessionImageEntries]
  );
  const sessionImageUrls = useStorageImageUrls(sessionImageStorageIds);
  const sessionGalleryImages = useMemo(() => {
    const images: GalleryImage[] = [];
    for (const e of sessionImageEntries) {
      const src = e.src ?? (e.storage_id ? sessionImageUrls[e.storage_id] : undefined);
      if (!src) continue;
      // An inline base64 image has no address anyone else could open.
      const href = src.startsWith("data:") ? undefined : src;
      images.push({ src, href, messageId: e.message_id, storageId: e.storage_id, timestamp: e.timestamp });
    }
    return images;
    // sessionImageUrls is rebuilt per render; its content only grows as the
    // batched resolution fills in, so keying on its size is exact.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionImageEntries, Object.keys(sessionImageUrls).length]);

  // The pages this session published, slotted in beside its images.
  const conversationId = conversation?._id && isConvexId(conversation._id) ? String(conversation._id) : null;
  const sessionPages = useSessionPages(conversationId, deferredQueriesEnabled);
  usePageEmbedFeed(useMemo(() => sessionPages.map((p) => ({ slug: p.page })), [sessionPages]));
  const sessionGalleryItems = useMemo<GalleryItem[]>(
    () => interleaveGalleryPages(sessionGalleryImages, sessionPages),
    [sessionGalleryImages, sessionPages]
  );

  // Older sessions predate the image_preview_url denormalization (the inbox
  // row thumbnail): when the loaded transcript visibly has images but the row
  // doesn't know it, ask the server to recompute — server-side, idempotent,
  // owner-only, once per opened conversation.
  // Both backfills are owner-only on the server: a teammate's session is skipped, not refused.
  const myId = useInboxStore((s) => s.currentUser?._id?.toString() ?? null);
  const backfillImagePreview = useMutation(api.conversations.backfillImagePreview);
  const imagePreviewBackfilledRef = useRef<string | null>(null);
  useWatchEffect(() => {
    const cid = conversation?._id?.toString();
    if (!cid || !isConvexId(cid) || sessionImageEntries.length === 0) return;
    if (!ownsConversationAccount(conversation, myId)) return;
    if (useInboxStore.getState().sessions[cid]?.image_preview_url) return;
    if (imagePreviewBackfilledRef.current === cid) return;
    imagePreviewBackfilledRef.current = cid;
    backfillImagePreview({ conversation_id: cid as Id<"conversations"> }).catch(() => {});
  }, [conversation?._id, conversation?.is_own, conversation?.user_id, myId, sessionImageEntries.length, backfillImagePreview]);

  // Sessions whose images predate conversation_images have nothing to read back,
  // so ask the server to sweep the history once per opened conversation. The
  // server owns the decision — it stamps images_backfilled_at and no-ops on
  // every later call — so this only has to fire when the thread PLAUSIBLY has
  // images the sweep hasn't seen.
  //
  // The evidence is the row's own image_preview_url, not the loaded window. A
  // long thread keeps its images in the history, not the last 200 messages, so
  // "the window shows an image the server list lacks" never fires on exactly
  // the sessions that need the sweep most (verified: a 2354-message thread with
  // images, zero of them in its window). image_preview_url is stamped whenever
  // any image lands and is never cleared, so it means "this session has images".
  // The window check stays as a second trigger for rows that predate it.
  const backfillConversationImages = useMutation(api.messages.backfillConversationImages);
  const imagesBackfilledRef = useRef<string | null>(null);
  useWatchEffect(() => {
    const cid = conversation?._id?.toString();
    if (!cid || !isConvexId(cid) || !serverSessionImages) return;
    if (!ownsConversationAccount(conversation, myId)) return;
    if (imagesBackfilledRef.current === cid) return;
    const known = new Set(serverSessionImages.map((e: SessionImageEntry) => e.key));
    // data: entries are never materialized — comparing them would re-trigger forever.
    const windowHasUnknown = windowImageEntries.some(
      (e) => !e.src?.startsWith("data:") && !known.has(e.key)
    );
    const rowHasImages = !!useInboxStore.getState().sessions[cid]?.image_preview_url;
    if (!windowHasUnknown && !rowHasImages) return;
    imagesBackfilledRef.current = cid;
    backfillConversationImages({ conversation_id: cid as Id<"conversations"> }).catch(() => {});
  }, [conversation?._id, conversation?.is_own, conversation?.user_id, myId, serverSessionImages, windowImageEntries, backfillConversationImages]);

  return { sessionGalleryItems };
}
