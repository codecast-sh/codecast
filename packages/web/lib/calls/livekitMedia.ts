// LiveKit room and screenshare options for huddles.
//
// A share of UI has to stay sharp. The SDK defaults do not: capture is 1080p
// at 15 fps / 2.5 Mbps, and adaptiveStream sizes the subscribed layer to the
// CSS box. On a Retina display that box is half the pixels the eye sees, so a
// 900px huddle window pulls the 540p simulcast layer and text turns to mush.
//
// `pixelDensity: "screen"` asks for device pixels. Capture is 1440p30 with a
// `detail` content hint so the encoder keeps edges; encoding is ~6 Mbps so a
// native Retina surface (Electron often ignores the 1440p cap) still has bits.
import type { JoinPrefs } from "./joinPrefs";
import { micConstraints } from "./joinPrefs";
import type { RoomOptions, ScreenShareCaptureOptions, VideoEncoding } from "livekit-client";

export const SCREEN_SHARE_ENCODING: VideoEncoding = {
  maxBitrate: 6_000_000,
  maxFramerate: 30,
  priority: "high",
};

export const SCREEN_SHARE_CAPTURE: ScreenShareCaptureOptions = {
  audio: false,
  resolution: { width: 2560, height: 1440, frameRate: 30 },
  contentHint: "detail",
};

export function huddleRoomOptions(prefs: Pick<JoinPrefs, "micDeviceId" | "cameraDeviceId">): RoomOptions {
  return {
    adaptiveStream: { pixelDensity: "screen" },
    dynacast: true,
    audioCaptureDefaults: micConstraints(prefs.micDeviceId),
    videoCaptureDefaults: prefs.cameraDeviceId
      ? { deviceId: { ideal: prefs.cameraDeviceId } }
      : {},
    publishDefaults: {
      screenShareEncoding: SCREEN_SHARE_ENCODING,
      degradationPreference: "maintain-resolution",
    },
  };
}
