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

/**
 * Upload a blob and return its storage id, or null if the upload failed.
 * Never throws: a caller decides what a missing id means (a voice note without
 * audio is still its transcript; an image without bytes is nothing).
 */
export async function uploadBlobToStorage(
  convex: UploadHandle,
  blob: Blob,
  contentType?: string,
): Promise<string | null> {
  try {
    const uploadUrl = await convex.mutation(api.images.generateUploadUrl, {});
    const res = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": contentType || blob.type || "application/octet-stream" },
      body: blob,
    });
    if (!res.ok) return null;
    const { storageId } = await res.json();
    return storageId ?? null;
  } catch {
    return null;
  }
}
