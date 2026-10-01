// Screenshare of UI has to stay sharp. These pin the LiveKit knobs that do
// that, so a later Room constructor cannot silently fall back to the SDK
// defaults (1080p15 / 2.5 Mbps, CSS-pixel adaptive stream).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { huddleRoomOptions, SCREEN_SHARE_CAPTURE, SCREEN_SHARE_ENCODING, SCREEN_SHARE_PUBLISH } from "../calls/livekitMedia";

describe("huddle LiveKit media", () => {
  test("adaptive stream asks for device pixels, not CSS pixels", () => {
    const adaptive = huddleRoomOptions({}).adaptiveStream;
    expect(adaptive).toEqual({ pixelDensity: "screen" });
  });

  test("screenshare encoding is 1440-class, not the SDK 1080p15 default", () => {
    const pub = huddleRoomOptions({}).publishDefaults;
    expect(pub?.screenShareEncoding).toEqual(SCREEN_SHARE_ENCODING);
    expect(SCREEN_SHARE_ENCODING.maxBitrate).toBeGreaterThanOrEqual(5_000_000);
    expect(SCREEN_SHARE_ENCODING.maxFramerate).toBe(15);
    expect(pub?.degradationPreference).toBe("maintain-resolution");
  });

  test("capture is 1440p15 with a detail hint so the encoder keeps text", () => {
    expect(SCREEN_SHARE_CAPTURE.resolution).toEqual({ width: 2560, height: 1440, frameRate: 15 });
    expect(SCREEN_SHARE_CAPTURE.contentHint).toBe("detail");
    expect(SCREEN_SHARE_CAPTURE.audio).toBe(false);
  });

  test("the person's last mic, camera and speaker ride into the room options", () => {
    const opts = huddleRoomOptions({ micDeviceId: "mic-1", cameraDeviceId: "cam-2", speakerDeviceId: "out-3" });
    expect(opts.audioCaptureDefaults).toMatchObject({ deviceId: { ideal: "mic-1" } });
    expect(opts.videoCaptureDefaults).toEqual({ deviceId: { ideal: "cam-2" } });
    expect(opts.audioOutput).toEqual({ deviceId: "out-3" });
    expect(huddleRoomOptions({}).audioOutput).toBeUndefined();
  });

  test("join and prewarm both build the room through huddleRoomOptions", () => {
    for (const file of ["callManager.ts", "roomPrewarm.ts"] as const) {
      const src = readFileSync(join(import.meta.dir, "..", "calls", file), "utf8");
      expect(src, file).toContain("huddleRoomOptions(");
      expect(src, file).not.toMatch(/adaptiveStream:\s*true/);
    }
  });

  test("the share publishes one full-size layer; cameras keep simulcast", () => {
    expect(SCREEN_SHARE_PUBLISH.simulcast).toBe(false);
    expect(SCREEN_SHARE_PUBLISH.screenShareEncoding).toEqual(SCREEN_SHARE_ENCODING);
    expect(huddleRoomOptions({}).publishDefaults?.simulcast).toBeUndefined();
  });

  test("starting a share passes capture and publish options, not only the Room defaults", () => {
    const src = readFileSync(join(import.meta.dir, "..", "calls", "callManager.ts"), "utf8");
    expect(src).toContain("SCREEN_SHARE_CAPTURE");
    expect(src).toContain("SCREEN_SHARE_PUBLISH");
    expect(src).toContain("setScreenShareEnabled(");
  });
});
