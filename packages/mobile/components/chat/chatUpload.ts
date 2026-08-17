// Image attach for mobile chat: pick from the library (or camera), upload to
// Convex storage, hand back the attachment record chat.sendMessage takes.
//
// The upload starts the moment the image is picked — by the time the person
// finishes typing the caption, the bytes are usually up. In-flight uploads live
// in a module-level map (same rule as the web composer's pendingImageUploads):
// a screen remount must never lose an upload it already started.

import { Alert } from 'react-native';
import { api } from '@codecast/convex/convex/_generated/api';
import type { ConvexReactClient } from 'convex/react';

// Lazy-required, NEVER statically imported: a native module missing from the
// installed binary throws during initial JS eval — before expo-updates marks
// the OTA launched — and silently rolls the update back (lib/gestureHandler.tsx
// documents the saga). Same guard the session screen uses.
let ImagePicker: typeof import('expo-image-picker') | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  ImagePicker = require('expo-image-picker');
} catch {}

export type PickedImage = {
  /** Local identity + the thumbnail the composer strip renders. */
  uri: string;
  width?: number;
  height?: number;
  mime: string;
  /** Set when the upload lands; a send awaits the promise below when absent. */
  storageId?: string;
  failed?: boolean;
};

export type ChatAttachmentArg = {
  storage_id: string;
  mime?: string;
  width?: number;
  height?: number;
};

/** In-flight uploads by local uri. Module-level so they survive remounts. */
export const pendingChatUploads = new Map<string, Promise<string | null>>();

/** Open the system photo picker. Returns the picked images (multiple allowed)
 *  or [] when cancelled. Quality 0.8 keeps a phone photo near ~1MB. */
export async function pickImages(): Promise<PickedImage[]> {
  if (!ImagePicker) {
    Alert.alert('Not available', 'Image uploads need a build with expo-image-picker.');
    return [];
  }
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: true,
    selectionLimit: 6,
    quality: 0.8,
  });
  if (result.canceled) return [];
  return result.assets.map((a) => ({
    uri: a.uri,
    width: a.width,
    height: a.height,
    mime: a.mimeType ?? 'image/jpeg',
  }));
}

/** Upload one picked image; resolves to its storage id (null on failure).
 *  Registers itself in pendingChatUploads under the local uri. */
export function startUpload(convex: ConvexReactClient, img: PickedImage): Promise<string | null> {
  const existing = pendingChatUploads.get(img.uri);
  if (existing) return existing;
  const task = (async (): Promise<string | null> => {
    try {
      const uploadUrl = await convex.mutation(api.images.generateUploadUrl, {});
      const blob = await (await fetch(img.uri)).blob();
      const res = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': img.mime },
        body: blob,
      });
      if (!res.ok) throw new Error(`upload ${res.status}`);
      const { storageId } = await res.json();
      return storageId as string;
    } catch {
      return null;
    } finally {
      // The map holds only IN-FLIGHT work; the resolved id lives in state.
      setTimeout(() => pendingChatUploads.delete(img.uri), 0);
    }
  })();
  pendingChatUploads.set(img.uri, task);
  return task;
}

/** Settle every picked image to an attachment record, awaiting stragglers.
 *  Failed uploads drop out (the caller already showed the failure on the tile). */
export async function settleAttachments(images: PickedImage[]): Promise<ChatAttachmentArg[]> {
  const settled = await Promise.all(
    images.map(async (img) => {
      const id = img.storageId ?? (await (pendingChatUploads.get(img.uri) ?? Promise.resolve(null)));
      return id
        ? { storage_id: id, mime: img.mime, width: img.width, height: img.height }
        : null;
    }),
  );
  return settled.filter(Boolean) as ChatAttachmentArg[];
}
