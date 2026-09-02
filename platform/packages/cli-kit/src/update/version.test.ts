import { describe, expect, it } from "bun:test";
import {
  STABLE_CHANNEL,
  assetName,
  compareVersions,
  decideUpdate,
  isBelowMinimum,
  manifestUrl,
  platformKey,
  resolveChannel,
} from "./version";

describe("compareVersions", () => {
  it("compares numerically, segment by segment", () => {
    expect(compareVersions("1.2.10", "1.2.9")).toBe(1);
    expect(compareVersions("1.2.9", "1.2.10")).toBe(-1);
    expect(compareVersions("1.2.0", "1.2")).toBe(0);
    expect(compareVersions("2.0.0", "1.99.99")).toBe(1);
  });
  it("treats junk segments as zero", () => {
    expect(compareVersions("1.x.0", "1.0.0")).toBe(0);
  });
});

describe("isBelowMinimum", () => {
  it("is false without a minimum", () => {
    expect(isBelowMinimum("1.0.0", null)).toBe(false);
    expect(isBelowMinimum("1.0.0", undefined)).toBe(false);
  });
  it("is true only below the minimum", () => {
    expect(isBelowMinimum("1.0.0", "1.0.1")).toBe(true);
    expect(isBelowMinimum("1.0.1", "1.0.1")).toBe(false);
  });
});

describe("decideUpdate", () => {
  it("none when nothing newer", () => {
    expect(decideUpdate({ current: "1.1.0", latest: "1.1.0" })).toEqual({ kind: "none" });
    expect(decideUpdate({ current: "1.1.0", latest: null })).toEqual({ kind: "none" });
  });
  it("available when latest is newer", () => {
    expect(decideUpdate({ current: "1.1.0", latest: "1.2.0" })).toEqual({ kind: "available", version: "1.2.0" });
  });
  it("forced when below the minimum, targeting latest", () => {
    expect(decideUpdate({ current: "1.0.0", latest: "1.2.0", minimum: "1.1.0" })).toEqual({
      kind: "forced",
      version: "1.2.0",
      minimum: "1.1.0",
    });
  });
  it("not forced once at or above the minimum", () => {
    expect(decideUpdate({ current: "1.1.0", latest: "1.2.0", minimum: "1.1.0" }).kind).toBe("available");
  });
});

describe("channels", () => {
  const channels = [STABLE_CHANNEL, { name: "beta", manifestPath: "latest-beta.json" }];
  it("defaults to the first channel", () => {
    expect(resolveChannel(channels).name).toBe("stable");
    expect(resolveChannel([]).name).toBe("stable");
  });
  it("prefers explicit over persisted over default", () => {
    expect(resolveChannel(channels, "beta", "stable").name).toBe("beta");
    expect(resolveChannel(channels, null, "beta").name).toBe("beta");
  });
  it("falls back when the name is unknown", () => {
    expect(resolveChannel(channels, "nightly", "gone").name).toBe("stable");
  });
  it("builds the manifest url without double slashes", () => {
    expect(manifestUrl("https://dl.example.com/", channels[1])).toBe("https://dl.example.com/latest-beta.json");
  });
});

describe("platformKey / assetName", () => {
  it("maps node names to release keys", () => {
    expect(platformKey("darwin", "arm64")).toBe("darwin-arm64");
    expect(platformKey("linux", "x64")).toBe("linux-x64");
    expect(platformKey("win32", "x64")).toBe("windows-x64");
  });
  it("windows on arm uses the x64 build", () => {
    expect(platformKey("win32", "arm64")).toBe("windows-x64");
  });
  it("appends .exe only on windows", () => {
    expect(assetName("acme", "windows-x64")).toBe("acme-windows-x64.exe");
    expect(assetName("acme", "darwin-arm64")).toBe("acme-darwin-arm64");
  });
});
