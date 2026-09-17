// One way to put bytes in convex storage.
//
// `images.generateUploadUrl` is the generic authenticated upload grant despite
// its name (the CLI's vault route already leans on that), and the dance after
// it is always the same three lines: mint the URL, POST the bytes, read back
// the storage id. Anything that then references those bytes — a chat
// attachment, a walkie recording — carries that id.
import { api as _api } from "@codecast/convex/convex/_generated/api";

const api = _api as any;

type UploadHandle = { mutation: (fn: any, args: any) => Promise<any> };

// A transient failure (a dropped connection, a busy backend answering 5xx)
// gets a few more tries with a short backoff; a refusal (4xx) does not, since
// the same bytes would be refused again.
const UPLOAD_ATTEMPTS = 3;
const UPLOAD_BACKOFF_MS = 1000;
const retryable = (status: number) => status >= 500 || status === 408 || status === 429;

/**
 * Upload a blob and return its storage id, or null if the upload failed.
 * Never throws: a caller decides what a missing id means (a voice note without
 * audio is still its transcript; an image without bytes is nothing).
 */
export async function uploadBlobToStorage(
  convex: UploadHandle,
  blob: Blob,
  contentType?: string,
  attempts: number = UPLOAD_ATTEMPTS,
): Promise<string | null> {
  for (let attempt = 1; ; attempt++) {
    try {
      const uploadUrl = await convex.mutation(api.images.generateUploadUrl, {});
      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": contentType || blob.type || "application/octet-stream" },
        body: blob,
      });
      if (res.ok) {
        const { storageId } = await res.json();
        return storageId ?? null;
      }
      if (!retryable(res.status)) return null;
    } catch {
      // network failure: retry below
    }
    if (attempt >= attempts) return null;
    await new Promise((r) => setTimeout(r, UPLOAD_BACKOFF_MS * attempt));
  }
}
