// In-flight image uploads keyed by blob previewUrl. Module-level (not a
// component ref) because the composer remounts whenever its key flips — a new
// session getting its session_id stamped, or a stub conversation rekeying to
// its real id — and the successor instance must be able to re-attach to
// uploads the previous instance started. A send that carries an in-flight
// upload takes ownership of its entry and blob; it calls releaseUpload once
// the upload has settled and nothing paints the blob any more.
//
// A leaf module (no store import) so the store itself can await an upload.
export const pendingImageUploads = new Map<string, Promise<string | null>>();

/** The upload's storage id, or null when it failed or nothing is uploading. */
export function awaitUpload(previewUrl: string | undefined): Promise<string | null> {
  return (previewUrl && pendingImageUploads.get(previewUrl)) || Promise.resolve(null);
}

/** Forget a settled upload and free its blob. The revoke waits a beat so a
 *  surface that just swapped the preview for the stored image never loads a
 *  revoked URL on its last render. */
export function releaseUpload(previewUrl: string | undefined) {
  if (!previewUrl) return;
  pendingImageUploads.delete(previewUrl);
  if (previewUrl.startsWith("blob:")) setTimeout(() => URL.revokeObjectURL(previewUrl), 1000);
}

/** An attachment as a send carries it: `storage_id` is empty while uploading,
 *  and `preview_url` is the local blob painted meanwhile. */
type UploadingAttachment = { storage_id: string; preview_url?: string };

/** True while any attachment is still uploading (no storage id yet). */
export function hasPendingUploads(attachments: readonly UploadingAttachment[] | undefined): boolean {
  return !!attachments?.some((a) => !a.storage_id);
}

/** The attachments a send can deliver: uploaded ones, stripped of the preview. */
export function deliverableAttachments<T extends UploadingAttachment>(
  attachments: readonly T[] | undefined,
): Omit<T, "preview_url">[] | undefined {
  const done = attachments?.filter((a) => a.storage_id).map(({ preview_url: _p, ...a }) => a);
  return done?.length ? done : undefined;
}
