// The device ranking: a pick outranks what was there to be picked, and only
// that, so "headphones when they are on, the display otherwise" holds after
// the person picks the display while the headphones are off.
import { describe, expect, test } from "bun:test";
import { noteDevices, rankAfterPick, resolveDevice, trackOnDevice } from "../calls/deviceRank";

const d = (deviceId: string, label: string) => ({ deviceId, label });
const DEFAULT = d("default", "Default - MacBook Pro Microphone");
const MBP = d("mbp", "MacBook Pro Microphone");
const STUDIO = d("studio", "Studio Display Microphone");
const XM6 = d("xm6", "WH-1000XM6");

describe("device rank", () => {
  test("nothing ranked opens the system default", () => {
    expect(resolveDevice(undefined, [MBP, DEFAULT, STUDIO])).toBe("default");
    expect(resolveDevice([], [])).toBe("");
  });

  test("a device absent at pick time keeps its place above the pick", () => {
    let rank = rankAfterPick([], XM6, [DEFAULT, MBP, STUDIO, XM6]);
    expect(rank).toEqual(["WH-1000XM6"]);
    // Headphones off; the person picks the display.
    rank = rankAfterPick(rank, STUDIO, [DEFAULT, MBP, STUDIO]);
    expect(rank).toEqual(["WH-1000XM6", "Studio Display Microphone"]);
    expect(resolveDevice(rank, [DEFAULT, MBP, STUDIO])).toBe("studio");
    // Headphones back on: they win again.
    expect(resolveDevice(rank, [DEFAULT, MBP, STUDIO, XM6])).toBe("xm6");
  });

  test("picking a present device over another reorders them", () => {
    let rank = ["WH-1000XM6", "Studio Display Microphone"];
    rank = rankAfterPick(rank, STUDIO, [DEFAULT, STUDIO, XM6]);
    expect(rank).toEqual(["Studio Display Microphone", "WH-1000XM6"]);
  });

  test("system default is its own entry and follows the OS", () => {
    const rank = rankAfterPick(["WH-1000XM6"], DEFAULT, [DEFAULT, MBP, XM6]);
    expect(rank).toEqual(["default", "WH-1000XM6"]);
    expect(resolveDevice(rank, [d("default", "Default - WH-1000XM6"), MBP, XM6])).toBe("default");
  });

  test("an unranked fallback id is used only while plugged in", () => {
    expect(resolveDevice(["Gone Mic"], [DEFAULT, MBP], "mbp")).toBe("mbp");
    expect(resolveDevice([], [DEFAULT, MBP], "gone")).toBe("default");
  });
});

describe("trackOnDevice", () => {
  const track = (deviceId: string, label: string) => ({ getSettings: () => ({ deviceId }), label }) as unknown as MediaStreamTrack;

  test("a capture is on a device by its id", () => {
    expect(trackOnDevice(track("studio", "Studio Display Microphone"), "audioinput", "studio")).toBe(true);
    expect(trackOnDevice(track("mbp", "MacBook Pro Microphone"), "audioinput", "studio")).toBe(false);
  });

  test("or by the listed device's label, where the browser reports the id another way", () => {
    noteDevices("audioinput", [STUDIO, MBP]);
    expect(trackOnDevice(track("", "Studio Display Microphone"), "audioinput", "studio")).toBe(true);
    expect(trackOnDevice(track("", "MacBook Pro Microphone"), "audioinput", "studio")).toBe(false);
  });
});
