// LiveKit room and screenshare options for huddles.
//
// A share of UI has to stay sharp. The SDK defaults do not: capture is 1080p
// at 15 fps / 2.5 Mbps, and adaptiveStream sizes the subscribed layer to the
// CSS box. On a Retina display that box is half the pixels the eye sees, so a
// 900px huddle window pulls the 540p simulcast layer and text turns to mush.
//
// `pixelDensity: "screen"` asks for device pixels. Capture is 1440p with a
// `detail` content hint so the encoder keeps edges; encoding is ~6 Mbps so a
// native Retina surface (Electron often ignores the 1440p cap) still has bits.
//
// Text needs pixels, not motion: 15 fps gives each frame twice the bits of
// 30 at the same bitrate, and a scrolled page settles sharp in half the time.
// The share publishes one layer (no simulcast): the SDK's default half-size
// copy is what small tiles and short downlinks fell to, and at half size text
// is unreadable. A short link now drops frames at full resolution instead.
import type { JoinPrefs } from "./joinPrefs";
import { micConstraints } from "./joinPrefs";
import type { RoomOptions, ScreenShareCaptureOptions, TrackPublishOptions, VideoEncoding } from "livekit-client";

export const SCREEN_SHARE_ENCODING: VideoEncoding = {
  maxBitrate: 6_000_000,
  maxFramerate: 15,
  priority: "high",
};

export const SCREEN_SHARE_CAPTURE: ScreenShareCaptureOptions = {
  audio: false,
  resolution: { width: 2560, height: 1440, frameRate: 15 },
  contentHint: "detail",
};

// Passed at publish time, not only as Room defaults, so a huddle that joined
// before these existed still publishes a sharp share. Simulcast stays out of
// publishDefaults, which would strip it from cameras too.
export const SCREEN_SHARE_PUBLISH: TrackPublishOptions = {
  screenShareEncoding: SCREEN_SHARE_ENCODING,
  degradationPreference: "maintain-resolution",
  simulcast: false,
};

export function huddleRoomOptions(prefs: Pick<JoinPrefs, "micDeviceId" | "cameraDeviceId" | "speakerDeviceId">): RoomOptions {
  return {
    adaptiveStream: { pixelDensity: "screen" },
    dynacast: true,
    audioCaptureDefaults: micConstraints(prefs.micDeviceId),
    videoCaptureDefaults: prefs.cameraDeviceId
      ? { deviceId: { ideal: prefs.cameraDeviceId } }
      : {},
    ...(prefs.speakerDeviceId ? { audioOutput: { deviceId: prefs.speakerDeviceId } } : {}),
    publishDefaults: {
      screenShareEncoding: SCREEN_SHARE_PUBLISH.screenShareEncoding,
      degradationPreference: SCREEN_SHARE_PUBLISH.degradationPreference,
    },
  };
}
