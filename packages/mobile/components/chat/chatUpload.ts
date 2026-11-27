// Image attach for mobile chat: pick from the library (or camera), upload to
// Convex storage, hand back the attachment record chat.sendMessage takes. A
// session's composer also picks any file here (pickFiles).
//
// The upload starts the moment the image is picked — by the time the person
// finishes typing the caption, the bytes are usually up. In-flight uploads live
// in web's own pendingImageUploads map, keyed by the local file uri: a screen
// remount never loses an upload it started, and a send that goes out before
// the bytes land hands the uri to the store as the attachment's preview_url,
// which paints the row now and delivers when the upload settles (chatSlice
// sendChatMessage, the same path the web composer takes).

import { Linking } from 'react-native';
import type { ConvexReactClient } from 'convex/react';
import { uploadUriToStorage } from '@/lib/uploadToStorage';
import { optionalNative } from '@/lib/optionalNative';
import { pendingImageUploads } from '@codecast/web/lib/pendingUploads';
import { appAlert, showActionSheet } from '@/lib/popups';
import type { ComposerImage } from '@/components/session/MessageComposer';

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

export type ImageSource = 'camera' | 'camera-burst' | 'library' | 'screen-recording' | 'file';

// expo-document-picker came after binaries already in the field: on those,
// Files says the app needs an update (pickFiles).
const DocumentPicker: typeof import('expo-document-picker') | null = optionalNative(
  'ExpoDocumentPicker',
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  () => require('expo-document-picker'),
);

export type PickedFile = { uri: string; name: string; mime: string };

/** The most images one pick attaches, from the library or a run of camera shots. */
const PICK_LIMIT = 6;

/** Ask where an attachment comes from: a new photo or the library, in a
 *  session's composer a screen recording (lib/screenRecordingSend), and where
 *  an agent gets the turn, any file (web's paperclip). Null when dismissed. */
export function chooseImageSource(opts: { screenRecording?: boolean; files?: boolean } = {}): Promise<ImageSource | null> {
  return new Promise((resolve) => {
    showActionSheet(undefined, [
      { label: 'Take photo', icon: 'camera', onPress: () => resolve('camera') },
      { label: 'Take several photos', icon: 'copy', onPress: () => resolve('camera-burst') },
      { label: 'Photo library', icon: 'image', onPress: () => resolve('library') },
      ...(opts.screenRecording ? [{ label: 'Screen recording', icon: 'video' as const, onPress: () => resolve('screen-recording' as const) }] : []),
      ...(opts.files ? [{ label: 'Files', icon: 'paperclip' as const, onPress: () => resolve('file' as const) }] : []),
    ], { onCancel: () => resolve(null) });
  });
}

/** Take a photo (or a run of them) or pick from the library. Returns the
 *  images or [] when cancelled. Quality 0.8 keeps a phone photo near ~1MB. A
 *  library photo comes back as JPEG: iPhone photos are HEIC, which the picker
 *  otherwise hands over untouched (whatever the quality), and which a browser
 *  and an agent's image reader cannot open. The library is the system picker,
 *  which needs no permission; the camera asks once. 'camera-burst' reopens
 *  the camera after each shot until the person cancels it or hits the limit. */
export async function pickImages(source: ImageSource = 'library'): Promise<PickedImage[]> {
  if (!ImagePicker) {
    appAlert('Not available', 'Image uploads need a build with expo-image-picker.');
    return [];
  }
  const camera = source !== 'library';
  const picked: PickedImage[] = [];
  try {
    if (camera) {
      const { granted } = await ImagePicker.requestCameraPermissionsAsync();
      if (!granted) {
        appAlert('Camera access is off', 'Turn on camera access for Codecast in Settings to take a photo.', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open Settings', onPress: () => { void Linking.openSettings(); } },
        ]);
        return [];
      }
    }
    do {
      const result = camera
        ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.8 })
        : await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'],
          allowsMultipleSelection: true,
          selectionLimit: PICK_LIMIT,
          quality: 0.8,
          preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
        });
      if (result.canceled) break;
      picked.push(...result.assets.map((a) => ({
        uri: a.uri,
        width: a.width,
        height: a.height,
        mime: a.mimeType ?? 'image/jpeg',
      })));
    } while (source === 'camera-burst' && picked.length < PICK_LIMIT);
  } catch (err) {
    // The simulator has no camera, and a picker can fail to present. Shots
    // already taken in a burst still attach.
    appAlert(camera ? 'Camera unavailable' : 'Photo library unavailable', err instanceof Error ? err.message : String(err));
  }
  return picked;
}

/** Any files, from the phone or its cloud drives, copied to the app's cache so
 *  the upload can read them. [] when cancelled; on a binary without the picker,
 *  says the app needs an update. */
export async function pickFiles(): Promise<PickedFile[]> {
  if (!DocumentPicker) {
    appAlert('Update Codecast', 'Attaching files needs the newest version of the app.');
    return [];
  }
  try {
    const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
    if (result.canceled) return [];
    return result.assets.map((a) => ({ uri: a.uri, name: a.name, mime: a.mimeType ?? 'application/octet-stream' }));
  } catch (err) {
    appAlert('Files unavailable', err instanceof Error ? err.message : String(err));
    return [];
  }
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

/** The composer's images as a send's attachments, without waiting: an upload
 *  still in flight rides as its preview and the store finishes it. (A failed
 *  upload has already left the strip.) */
export function composerAttachments(images: ComposerImage[]): ChatAttachmentArg[] {
  return images.map((img) => ({
    storage_id: img.storageId ?? '',
    ...(img.storageId ? {} : { preview_url: img.uri }),
    mime: img.mime,
    width: img.width,
    height: img.height,
  }));
}
