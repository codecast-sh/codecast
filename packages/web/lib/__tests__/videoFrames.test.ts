import { describe, expect, test } from "bun:test";
import { applyVoiceFrames, clearVideoFrames, getVideoFrame, subscribeVideoFrames } from "../calls/videoFrames";

describe("the host's relayed frames", () => {
  test("keep the latest per person, drop on null, and wake only on a change", () => {
    clearVideoFrames();
    let wakes = 0;
    const off = subscribeVideoFrames(() => wakes++);
    applyVoiceFrames({ "u-ann": "data:a" });
    expect(getVideoFrame("u-ann")).toBe("data:a");
    expect(wakes).toBe(1);
    // The same frame again is no news.
    applyVoiceFrames({ "u-ann": "data:a" });
    expect(wakes).toBe(1);
    applyVoiceFrames({ "u-ann": "data:b", "u-bo": "data:c" });
    expect(getVideoFrame("u-ann")).toBe("data:b");
    expect(getVideoFrame("u-bo")).toBe("data:c");
    expect(wakes).toBe(2);
    applyVoiceFrames({ "u-ann": null });
    expect(getVideoFrame("u-ann")).toBeNull();
    expect(wakes).toBe(3);
    // Dropping what is not there is not a change.
    applyVoiceFrames({ "u-ann": null });
    expect(wakes).toBe(3);
    off();
    clearVideoFrames();
    expect(getVideoFrame("u-bo")).toBeNull();
  });
});
