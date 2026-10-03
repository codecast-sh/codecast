// Image attach for mobile chat: pick from the library (or camera), upload to
// Convex storage, hand back the attachment record chat.sendMessage takes.
//
// The upload starts the moment the image is picked — by the time the person
// finishes typing the caption, the bytes are usually up. In-flight uploads live
// in web's own pendingImageUploads map, keyed by the local file uri: a screen
// remount never loses an upload it started, and a send that goes out before
// the bytes land hands the uri to the store as the attachment's preview_url,
// which paints the row now and delivers when the upload settles (chatSlice
// sendChatMessage, the same path the web composer takes).

import { Alert } from 'react-native';
import type { ConvexReactClient } from 'convex/react';
import { uploadUriToStorage } from '@/lib/uploadToStorage';
import { optionalNative } from '@/lib/optionalNative';
import { pendingImageUploads } from '@codecast/web/lib/pendingUploads';

// Lazy-required, NEVER statically imported: a native module missing from the
// installed binary throws during initial JS eval — before expo-updates marks
// the OTA launched — and silently rolls the update back (lib/gestureHandler.tsx
// documents the saga). Same guard the session screen uses.
const ImagePicker: typeof import('expo-image-picker') | null = optionalNative(
  'ExponentImagePicker',
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  () => require('expo-image-picker'),
);

export type PickedImage = {
  /** Local identity + the thumbnail the composer strip renders. */
  uri: string;
  width?: number;
  height?: number;
  mime: string;
  /** Set when the upload lands; absent, a send hands the store the local uri. */
  storageId?: string;
  failed?: boolean;
};

/** An attachment as a send carries it: `storage_id` is empty while the bytes
 *  are still going up, and `preview_url` (the local file) paints meanwhile. */
export type ChatAttachmentArg = {
  storage_id: string;
  preview_url?: string;
  mime?: string;
  width?: number;
  height?: number;
};

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
 *  Registers itself in pendingImageUploads under the local uri, where it stays
 *  until the send that carries it settles (releaseUpload) or the tile is
 *  removed: a send pressed the instant the bytes land still finds the id. */
export function startUpload(convex: ConvexReactClient, img: PickedImage): Promise<string | null> {
  const existing = pendingImageUploads.get(img.uri);
  if (existing) return existing;
  const task = uploadUriToStorage(convex, img.uri, img.mime);
  pendingImageUploads.set(img.uri, task);
  return task;
}

/** A removed tile's upload is nobody's any more. */
export function forgetUpload(uri: string): void {
  pendingImageUploads.delete(uri);
}

/** The picked images as a send's attachments, without waiting: an upload still
 *  in flight rides as its preview and the store finishes it. Failed uploads
 *  drop out (the tile already said so). */
export function sendableAttachments(images: PickedImage[]): ChatAttachmentArg[] {
  return images
    .filter((img) => !img.failed)
    .map((img) => ({
      storage_id: img.storageId ?? '',
      ...(img.storageId ? {} : { preview_url: img.uri }),
      mime: img.mime,
      width: img.width,
      height: img.height,
    }));
}
