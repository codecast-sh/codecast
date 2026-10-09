import { describe, expect, test } from "bun:test";
import {
  REPLAY_HOST_SOURCE,
  REPLAY_PLAYER_ORIGIN,
  isReplayPlayerMessage,
  parseReplayHostMessage,
  parseReplayPlayerUrl,
  parseReplayRef,
  replayFrameSeenRef,
  replayFrameSeenText,
  replayFrameTimes,
  replayPlayerUrl,
  replayRefId,
} from "./replayPlayer";

describe("the player URL", () => {
  test("carries the capability in the path and reads back", () => {
    const url = replayPlayerUrl({ cap: "abc_-.0f", t_ms: 83_400.6, mode: "frame" });
    expect(url).toBe(`${REPLAY_PLAYER_ORIGIN}/p/abc_-.0f?t=83401&mode=frame`);
    expect(parseReplayPlayerUrl(url)).toEqual({ cap: "abc_-.0f", t_ms: 83_401, mode: "frame", controls: true, autoplay: false, remote_assets: false });
    expect(parseReplayPlayerUrl(replayPlayerUrl({ cap: "c", controls: false, autoplay: true }))).toEqual({ cap: "c", t_ms: null, mode: "interactive", controls: false, autoplay: true, remote_assets: false });
    expect(parseReplayPlayerUrl("https://replay.codecast.sh/frame")).toBeNull();
  });

  test("remote assets are a per-view opt-in, and never in frame mode", () => {
    const url = replayPlayerUrl({ cap: "c", remote_assets: true });
    expect(url).toBe(`${REPLAY_PLAYER_ORIGIN}/p/c?assets=remote`);
    expect(parseReplayPlayerUrl(url)?.remote_assets).toBe(true);
    expect(replayPlayerUrl({ cap: "c", mode: "frame", remote_assets: true })).not.toContain("assets");
    expect(parseReplayPlayerUrl(`${REPLAY_PLAYER_ORIGIN}/p/c?mode=frame&assets=remote`)?.remote_assets).toBe(false);
  });
});

describe("messages", () => {
  test("a host message is checked field by field", () => {
    expect(parseReplayHostMessage({ source: REPLAY_HOST_SOURCE, type: "seek", t_ms: -5, play: true })).toEqual({ source: REPLAY_HOST_SOURCE, type: "seek", t_ms: 0, play: true });
    expect(parseReplayHostMessage({ source: REPLAY_HOST_SOURCE, type: "seek", t_ms: "1" })).toBeNull();
    expect(parseReplayHostMessage({ source: REPLAY_HOST_SOURCE, type: "speed", speed: 3 })).toBeNull();
    expect(parseReplayHostMessage({ source: REPLAY_HOST_SOURCE, type: "speed", speed: 2 })).toMatchObject({ speed: 2 });
    expect(parseReplayHostMessage({ source: "other", type: "play" })).toBeNull();
    expect(parseReplayHostMessage({ source: REPLAY_HOST_SOURCE, type: "hello", extra: 1 })).toEqual({ source: REPLAY_HOST_SOURCE, type: "hello" });
    expect(isReplayPlayerMessage({ source: "codecast-replay-player", type: "time", t_ms: 1, playing: true })).toBe(true);
    expect(isReplayPlayerMessage("time")).toBe(false);
  });
});

describe("references", () => {
  test("a replay, a moment, a stretch", () => {
    expect(parseReplayRef("rp-12")).toEqual({ replay: "rp-12" });
    expect(parseReplayRef("RP-12@1:23")).toEqual({ replay: "rp-12", at_ms: 83_000 });
    expect(parseReplayRef("rp-12@83s")).toEqual({ replay: "rp-12", at_ms: 83_000 });
    expect(parseReplayRef("rp-12@2:30-1:00")).toEqual({ replay: "rp-12", range: { from_ms: 60_000, to_ms: 150_000 } });
    expect(parseReplayRef("rp-12@soon")).toBeNull();
    expect(parseReplayRef("cl-12@1:23")).toBeNull();
    expect(replayRefId("rp-12", 83_900)).toBe("rp-12@1:23");
  });

  test("a frame an agent saw becomes a line naming it", () => {
    expect(replayFrameSeenRef(`Read 1 file\n${replayFrameSeenText("rp-3@1:02:03")}`)).toBe("rp-3@1:02:03");
    expect(replayFrameSeenRef("Frame of the call: cl-1@0:10")).toBeNull();
  });

  test("a stretch is sampled at its start, every step, and its end", () => {
    expect(replayFrameTimes({ from_ms: 0, to_ms: 25_000 }, 10_000)).toEqual([0, 10_000, 20_000, 25_000]);
    expect(replayFrameTimes({ from_ms: 0, to_ms: 100_000 }, 10, 3)).toEqual([0, 1_000, 2_000]);
  });
});
