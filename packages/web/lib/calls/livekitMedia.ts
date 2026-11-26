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
// A leaf: no store, no call manager. The guest page (app/meet) builds its
// room from these same options without either.
import type { JoinPrefs } from "./joinPrefs";
import {
  Track,
  type AudioCaptureOptions,
  type AudioPreset,
  type RoomOptions,
  type ScreenShareCaptureOptions,
  type TrackPublishOptions,
  type VideoEncoding,
} from "livekit-client";

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

// Full-band Opus headroom. LiveKit defaults to 48 kbps (`AudioPresets.music`)
// with `red: true` and `dtx: true`: in libwebrtc `maxBitrate` caps the gross
// RTP stream (payload + RED packet duplication + Opus in-band FEC), which
// crushes the primary voice payload to ~20 kbps and forces Opus into narrowband
// SILK with a steep high-frequency roll-off ("muffled" speech). 96 kbps keeps
// Opus in full-band 20 kHz audio alongside RED+FEC at <2% of a share's budget,
// and `dtx: false` avoids comfort-noise ramp-up clipping the start of turns.
export const HUDDLE_AUDIO_PRESET: AudioPreset = {
  maxBitrate: 96_000,
  priority: "high",
};

export const AUDIO_PUBLISH_DEFAULTS = {
  audioPreset: HUDDLE_AUDIO_PRESET,
  dtx: false,
  red: true,
} as const;

export const MIC_PUBLISH_OPTIONS: TrackPublishOptions = {
  source: Track.Source.Microphone,
  ...AUDIO_PUBLISH_DEFAULTS,
};

/**
 * The capture constraints every join hands to the media plane.
 *
 * `echoCancellation` is the one that is not a preference. The burst coming out
 * of a listener's speakers is arriving at their own microphone the moment they
 * step in — without cancellation that is a loop, and the sender hears
 * themselves a beat late.
 *
 * `voiceIsolation` is explicitly off: `livekit-client` sets `voiceIsolation: true`
 * in `audioDefaults`, which `new Room()` shallow-merges when omitted here —
 * stacking OS CoreAudio isolation on top of WebRTC/Krisp noise suppression and
 * muffling speech on macOS.
 */
export function micConstraints(
  deviceId?: string,
  opts?: { noiseSuppression?: boolean },
): AudioCaptureOptions & MediaTrackConstraints {
  return {
    echoCancellation: true,
    noiseSuppression: opts?.noiseSuppression ?? true,
    voiceIsolation: false,
    autoGainControl: true,
    sampleRate: { ideal: 48_000 },
    channelCount: { ideal: 1 },
    ...(deviceId ? { deviceId: { ideal: deviceId } } : {}),
  };
}

export function huddleRoomOptions(prefs: Pick<JoinPrefs, "micDeviceId" | "cameraDeviceId" | "speakerDeviceId">): RoomOptions {
  // Omit "default" so LiveKit leaves <audio> elements on the system sink rather
  // than calling setSinkId("default"), which can trip Chromium's macOS AEC tap.
  const speakerDeviceId =
    prefs.speakerDeviceId && prefs.speakerDeviceId !== "default" ? prefs.speakerDeviceId : undefined;
  return {
    adaptiveStream: { pixelDensity: "screen" },
    dynacast: true,
    audioCaptureDefaults: micConstraints(prefs.micDeviceId),
    videoCaptureDefaults: prefs.cameraDeviceId
      ? { deviceId: { ideal: prefs.cameraDeviceId } }
      : {},
    ...(speakerDeviceId ? { audioOutput: { deviceId: speakerDeviceId } } : {}),
    publishDefaults: {
      ...AUDIO_PUBLISH_DEFAULTS,
      screenShareEncoding: SCREEN_SHARE_PUBLISH.screenShareEncoding,
      degradationPreference: SCREEN_SHARE_PUBLISH.degradationPreference,
    },
  };
}
