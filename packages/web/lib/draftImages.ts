import { useInboxStore } from "../store/inboxStore";

// A pasted image as held in composer state. `file` carries the real bytes for
// the upload; serialized draft rows survive without them.
export type PastedImage = {
  file: File;
  previewUrl: string;
  storageId?: string;
  uploading: boolean;
};

// One image row as stored on a draft's draft_image_storage_ids.
export type DraftImageRow = {
  storageId?: string;
  previewUrl?: string;
  name?: string;
  type?: string;
  uploading?: boolean;
};

import { awaitUpload, pendingImageUploads, releaseUpload } from "./pendingUploads";

export { pendingImageUploads };

/** Image row handed out of MessageInput's onGateSend. */
export type ComposerGateImage = {
  storageId?: string;
  previewUrl: string;
  mime: string;
  uploading?: boolean;
};

/** Settled chat/huddle attachment: a storage id the send path can store. */
export type ComposerAttachment = {
  storage_id: string;
  mime?: string;
};

/** Wait out in-flight uploads and drop the ones that failed. The huddle and
 *  palette composers share this so a remount cannot lose a paste; it owns the
 *  in-flight uploads it was handed and releases each once settled. */
export async function settleComposerAttachments(
  images: ComposerGateImage[] | undefined | null,
): Promise<ComposerAttachment[]> {
  const list = images ?? [];
  const settled = await Promise.all(
    list.map(async (img) => ({
      storageId: img.storageId ?? (await awaitUpload(img.previewUrl)),
      mime: img.mime,
    })),
  );
  for (const img of list) if (!img.storageId) releaseUpload(img.previewUrl);
  return settled
    .filter((img): img is { storageId: string; mime: string } => !!img.storageId)
    .map((img) => ({ storage_id: img.storageId, mime: img.mime }));
}

export function serializeDraftImages(images: PastedImage[]): DraftImageRow[] {
  return images.map(i => ({
    storageId: i.storageId,
    previewUrl: i.previewUrl,
    name: i.file.name,
    type: i.file.type || undefined,
    uploading: i.uploading || undefined,
  }));
}

// Pasted images are sacred input: they reach the store draft synchronously at
// paste time (uploading rows included, with their blob preview), not after the
// upload finishes. The draft is what survives a composer remount — it is
// rekeyed along with the conversation (rekeyId) and local-wins against sync.
export function persistDraftImages(conversationId: string, text: string, images: PastedImage[]) {
  const store = useInboxStore.getState();
  const rows = serializeDraftImages(images);
  if (!text && rows.length === 0) {
    store.clearDraft(conversationId);
  } else {
    store.setDraft(conversationId, {
      draft_message: text || null,
      draft_image_storage_ids: rows.length > 0 ? rows : null,
    });
  }
}

// Land a finished upload on whichever draft currently holds the image — found
// by previewUrl, not conversation id, because rekeyId may have moved the draft
// since paste time. Runs from the upload promise itself, so the result lands
// even when no composer instance is mounted. null (failed upload) removes the
// row.
export function settleDraftImageUpload(previewUrl: string, storageId: string | null) {
  const store = useInboxStore.getState();
  for (const [id, draft] of Object.entries(store.drafts)) {
    const rows = draft?.draft_image_storage_ids as DraftImageRow[] | null | undefined;
    if (!rows?.some(r => r.previewUrl === previewUrl)) continue;
    const next = storageId
      ? rows.map(r => (r.previewUrl === previewUrl ? { ...r, storageId, uploading: undefined } : r))
      : rows.filter(r => r.previewUrl !== previewUrl);
    if (!draft.draft_message && next.length === 0) {
      store.clearDraft(id);
    } else {
      store.setDraft(id, { ...draft, draft_image_storage_ids: next.length > 0 ? next : null });
    }
    return;
  }
}

// Rebuild composer image state from a stored draft. Uploaded rows come back
// ready; rows still uploading come back uploading:true so the composer can
// re-attach to their pending upload (or drop them if it's gone, e.g. a reload
// killed it). Falls back to the legacy single-image draft fields.
export function restoreDraftImages(draft: Record<string, any> | undefined): PastedImage[] {
  if (draft?.draft_image_storage_ids) {
    return (draft.draft_image_storage_ids as DraftImageRow[]).map(img => ({
      file: new File([], img.name || "image", img.type ? { type: img.type } : undefined),
      previewUrl: img.previewUrl || "",
      storageId: img.storageId,
      uploading: !!img.uploading && !img.storageId,
    }));
  }
  if (draft?.draft_image_storage_id) {
    return [{
      file: new File([], draft.draft_image_name || "image"),
      previewUrl: draft.draft_image_preview || "",
      storageId: draft.draft_image_storage_id,
      uploading: false,
    }];
  }
  return [];
}
