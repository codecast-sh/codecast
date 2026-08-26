// Put a local file in Convex storage and get its id back.
//
// The phone always has a `file://` uri rather than bytes — the image picker
// hands one back, and so does the audio recorder — so every upload here is the
// same three steps: ask the server for a one-shot URL, read the file into a
// blob, POST it. It lived inline in the chat composer until the recorder
// needed the identical three steps for an m4a.

import { api } from '@codecast/convex/convex/_generated/api';
import type { ConvexReactClient } from 'convex/react';

/**
 * Upload the file at `uri`, resolving to its storage id.
 *
 * Never throws: it resolves to null instead. Every caller so far treats a
 * failed upload as a thing that cost the attachment and nothing else — the
 * message still sends, the recording still keeps its transcript — and a
 * rejection would make each of them write the same catch.
 */
export async function uploadUriToStorage(
  convex: ConvexReactClient,
  uri: string,
  mime: string,
): Promise<string | null> {
  try {
    const uploadUrl = await convex.mutation(api.images.generateUploadUrl, {});
    const blob = await (await fetch(uri)).blob();
    const res = await fetch(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': mime },
      body: blob,
    });
    if (!res.ok) throw new Error(`upload ${res.status}`);
    const { storageId } = await res.json();
    return (storageId as string) ?? null;
  } catch {
    return null;
  }
}
