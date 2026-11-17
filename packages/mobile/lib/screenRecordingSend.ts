// Sending a screen recording to a session from the phone.
//
// The person records their screen with the system's recorder (Control
// Center, microphone on), then picks the video from the composer's +. The
// pick opens the recording call on the server at once (screenRecordings.begin:
// a `cl-N` and a presigned PUT into the call-recordings bucket) and starts the
// upload, so by the time the caption is typed the bytes are usually on their
// way. The send itself is an ordinary message carrying the recording's tag
// (shared/contracts/screenRecording); the agent's daemon waits for the words
// and cuts the frames when it delivers.
//
// The upload is a module singleton keyed by the local file, like the photo
// uploads: leaving the screen mid-upload does not stop it.

import type { ConvexReactClient } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import type { Id } from '@codecast/convex/convex/_generated/dataModel';
import { formatScreenRecordingMessage } from '@codecast/shared/contracts';
import { optionalNative } from '@/lib/optionalNative';
import { appAlert } from '@/lib/popups';

// Lazy-required, never statically imported (lib/optionalNative).
const ImagePicker: typeof import('expo-image-picker') | null = optionalNative(
  'ExponentImagePicker',
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  () => require('expo-image-picker'),
);

export type PickedRecording = { uri: string; mime: string; durationMs: number; width?: number; height?: number };

export type BegunRecording = { transcriptId: string; call: string };

/** Pick one video from the library: a screen recording. Null when
 *  cancelled. The file comes from the system picker's own copy, so iOS asks
 *  for no Photos access, re-encoded at full resolution as H.264, which every
 *  browser plays. */
export async function pickScreenRecording(): Promise<PickedRecording | null> {
  if (!ImagePicker) {
    appAlert('Not available', 'Sending a recording needs a build with expo-image-picker.');
    return null;
  }
  try {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['videos'],
      allowsMultipleSelection: false,
      preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
      // Not passthrough: in passthrough the picker fetches the original from
      // the library by its identifier (expo-image-picker MediaHandler), and
      // that read is what makes iOS ask for full Photos access. Any other
      // preset takes the picker's own copy; this one keeps full resolution.
      videoExportPreset: ImagePicker.VideoExportPreset.HighestQuality,
    });
    if (result.canceled || !result.assets[0]) return null;
    const a = result.assets[0];
    return {
      uri: a.uri,
      mime: a.mimeType ?? (a.uri.toLowerCase().endsWith('.mov') ? 'video/quicktime' : 'video/mp4'),
      durationMs: Math.max(0, Math.round(a.duration ?? 0)),
      width: a.width || undefined,
      height: a.height || undefined,
    };
  } catch (err) {
    appAlert('Photo library unavailable', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** Uploads in flight or done, by local file. */
const uploads = new Map<string, Promise<boolean>>();

/** Open the recording on the server and start its upload. Resolves once the
 *  server has named it (the upload goes on); null when it could not. */
export async function beginScreenRecording(convex: ConvexReactClient, picked: PickedRecording, conversationId: string): Promise<BegunRecording | null> {
  let begun: { transcript_id: Id<'transcripts'>; call: string; upload_url: string };
  let blob: Blob;
  try {
    // Read first: the upload URL is signed for the file's exact length.
    blob = await (await fetch(picked.uri)).blob();
    begun = await convex.mutation(api.screenRecordings.begin, {
      conversation_id: conversationId,
      size_bytes: blob.size,
      mime: picked.mime,
      duration_ms: picked.durationMs,
      ...(picked.width ? { width: picked.width } : {}),
      ...(picked.height ? { height: picked.height } : {}),
    });
  } catch (err) {
    appAlert('Could not attach the recording', err instanceof Error ? err.message : String(err));
    return null;
  }
  uploads.set(picked.uri, upload(convex, blob, begun));
  return { transcriptId: String(begun.transcript_id), call: begun.call };
}

async function upload(convex: ConvexReactClient, blob: Blob, begun: { transcript_id: Id<'transcripts'>; upload_url: string }): Promise<boolean> {
  try {
    // Stored as MP4 whatever the picker called it: a QuickTime file is the
    // same container family, and browsers refuse to play `video/quicktime`.
    const res = await fetch(begun.upload_url, { method: 'PUT', headers: { 'Content-Type': 'video/mp4' }, body: blob });
    if (!res.ok) throw new Error(`upload ${res.status}`);
    await convex.mutation(api.screenRecordings.uploaded, { transcript_id: begun.transcript_id });
    return true;
  } catch (err) {
    appAlert('Recording upload failed', err instanceof Error ? err.message : String(err));
    return false;
  }
}

/** The upload for a picked file: true once the server has the bytes. */
export function recordingUpload(uri: string): Promise<boolean> | null {
  return uploads.get(uri) ?? null;
}

/** The message a send carries for a recording and the person's words. */
export function screenRecordingContent(begun: BegunRecording, picked: PickedRecording, text: string): string {
  return formatScreenRecordingMessage({ call: begun.call, transcriptId: begun.transcriptId, durationMs: picked.durationMs }, text);
}

/** Take back a recording picked for a turn that was not sent: the server
 *  removes it (and refuses if it went out after all). Best effort; the
 *  unsent sweep removes it later otherwise. */
export function discardScreenRecording(convex: ConvexReactClient, begun: BegunRecording): void {
  void convex.mutation(api.screenRecordings.discard, { transcript_id: begun.transcriptId as Id<'transcripts'> }).catch(() => {});
}
