const { test, expect } = require("bun:test");
const {
  cmpVersions, feedFileName, feedUrlFor, parseFeed, shouldDownload, mustApplyNow, decideUpdate, swapScript,
} = require("./updaterLogic");

test("cmpVersions compares numerically, segment by segment", () => {
  expect(cmpVersions("1.1.10", "1.1.9")).toBe(1);
  expect(cmpVersions("1.1.9", "1.1.10")).toBe(-1);
  expect(cmpVersions("1.2", "1.2.0")).toBe(0);
  expect(cmpVersions("2", "1.9.9")).toBe(1);
  expect(cmpVersions("1.1.94", "1.1.94")).toBe(0);
});

test("channels map to electron-builder feed files", () => {
  expect(feedFileName()).toBe("latest-mac.yml");
  expect(feedFileName("beta")).toBe("beta-mac.yml");
  expect(feedFileName("Alpha ")).toBe("alpha-mac.yml");
  expect(feedFileName("")).toBe("latest-mac.yml");
  expect(feedUrlFor("https://dl.codecast.sh/desktop/", "latest")).toBe("https://dl.codecast.sh/desktop/latest-mac.yml");
  expect(feedUrlFor("https://dl.codecast.sh/desktop", "beta")).toBe("https://dl.codecast.sh/desktop/beta-mac.yml");
});

const FEED = `version: 1.1.94
files:
  - url: Codecast-1.1.94-arm64-mac.zip
    sha512: AbC123==
    size: 98765
    blockMapSize: 1234
  - url: Codecast-1.1.94-arm64.dmg
    sha512: Dmg==
    size: 99999
path: Codecast-1.1.94-arm64-mac.zip
sha512: AbC123==
releaseDate: '2026-08-20T00:00:00.000Z'
`;

test("parseFeed reads version, zip and its sha512 without a YAML parser", () => {
  expect(parseFeed(FEED)).toEqual({ version: "1.1.94", zip: "Codecast-1.1.94-arm64-mac.zip", sha512: "AbC123==" });
  expect(parseFeed("garbage")).toEqual({ version: undefined, zip: undefined, sha512: undefined });
  expect(parseFeed(FEED.replace(/\n/g, "\r\n")).sha512).toBe("AbC123==");
});

test("shouldDownload wants strictly newer, or anything when forced", () => {
  expect(shouldDownload({ feedVersion: "1.1.95", installedVersion: "1.1.94" })).toBe(true);
  expect(shouldDownload({ feedVersion: "1.1.94", installedVersion: "1.1.94" })).toBe(false);
  expect(shouldDownload({ feedVersion: "1.1.90", installedVersion: "1.1.94" })).toBe(false);
  expect(shouldDownload({ feedVersion: "1.1.94", installedVersion: "1.1.94", force: true })).toBe(true);
  expect(shouldDownload({ feedVersion: undefined, installedVersion: "1.1.94", force: true })).toBe(false);
});

test("the kill switch only fires below a well formed floor", () => {
  expect(mustApplyNow({ installedVersion: "1.1.90", minVersion: "1.1.94" })).toBe(true);
  expect(mustApplyNow({ installedVersion: "1.1.94", minVersion: "1.1.94" })).toBe(false);
  expect(mustApplyNow({ installedVersion: "1.2.0", minVersion: "1.1.94" })).toBe(false);
  expect(mustApplyNow({ installedVersion: "1.1.90", minVersion: null })).toBe(false);
  expect(mustApplyNow({ installedVersion: "1.1.90", minVersion: "" })).toBe(false);
  expect(mustApplyNow({ installedVersion: "1.1.90", minVersion: "latest" })).toBe(false);
  expect(mustApplyNow({ installedVersion: "1.1.90", minVersion: " 1.1.91 " })).toBe(true);
});

test("decideUpdate refuses outside a packaged mac app and on a bad feed", () => {
  const feed = parseFeed(FEED);
  expect(decideUpdate({ feed, installedVersion: "1.1.90", platform: "win32" })).toEqual({ action: "skip", reason: "unsupported" });
  expect(decideUpdate({ feed, installedVersion: "1.1.90", packaged: false })).toEqual({ action: "skip", reason: "unsupported" });
  expect(decideUpdate({ feed: parseFeed("x"), installedVersion: "1.1.90" })).toEqual({ action: "skip", reason: "bad-feed" });
  expect(decideUpdate({ feed, installedVersion: "1.1.94" })).toEqual({ action: "skip", reason: "up-to-date" });
  expect(decideUpdate({ feed, installedVersion: "1.1.90" })).toEqual({ action: "download", reason: "newer" });
  expect(decideUpdate({ feed, installedVersion: "1.1.94", force: true })).toEqual({ action: "download", reason: "forced" });
});

test("swapScript waits for the pid, swaps with rollback, and reopens", () => {
  const s = swapScript({
    pid: 4242,
    bundlePath: "/Applications/My App.app",
    incomingPath: "/Applications/.My App.app.incoming",
    oldPath: "/Applications/.My App.app.old",
  });
  const lines = s.split("\n");
  expect(lines[0]).toBe("while kill -0 4242 2>/dev/null; do sleep 0.2; done");
  expect(lines[2]).toContain("mv '/Applications/My App.app' '/Applications/.My App.app.old' && mv '/Applications/.My App.app.incoming' '/Applications/My App.app' || { mv '/Applications/.My App.app.old' '/Applications/My App.app' 2>/dev/null; exit 1; }");
  expect(lines[3]).toContain("xattr -dr com.apple.quarantine");
  expect(lines[5]).toBe("/usr/bin/open '/Applications/My App.app'");
  // A single quote inside a path is escaped for /bin/sh.
  expect(swapScript({ pid: 1, bundlePath: "/a/it's.app", incomingPath: "/i", oldPath: "/o" })).toContain(`'/a/it'\\''s.app'`);
});
