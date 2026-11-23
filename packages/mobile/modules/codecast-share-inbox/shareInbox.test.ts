import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ShareInbox.swift exists twice on purpose (the app's native module and the
// share extension cannot share a pod). The extension writes the files the app
// reads, so the copies must stay one file, and its app group must be one both
// sides are entitled to.

const here = import.meta.dir;
const mobile = join(here, "../..");
const appCopy = readFileSync(join(here, "ios/ShareInbox.swift"), "utf8");
const extensionCopy = readFileSync(join(mobile, "targets/share/ShareInbox.swift"), "utf8");
const app = JSON.parse(readFileSync(join(mobile, "app.json"), "utf8")).expo.ios;
const target = require(join(mobile, "targets/share/expo-target.config.js"));

describe("ShareInbox", () => {
  test("the extension's copy is byte-identical to the app module's", () => {
    expect(extensionCopy).toBe(appCopy);
  });

  test("the app group is one both sides are entitled to", () => {
    const group = /appGroup = "([^"]+)"/.exec(appCopy)?.[1];
    expect(app.entitlements["com.apple.security.application-groups"]).toContain(group);
    expect(target.entitlements["com.apple.security.application-groups"]).toContain(group);
  });

  test("the extension opens a URL the app's scheme routes", () => {
    const url = /URL\(string: "([^"]+)"\)/.exec(readFileSync(join(mobile, "targets/share/ShareViewController.swift"), "utf8"))?.[1] ?? "";
    const { mobileRouteForUrl } = require(join(mobile, "lib/linkRoutes.ts"));
    expect(url.startsWith(`${JSON.parse(readFileSync(join(mobile, "app.json"), "utf8")).expo.scheme}://`)).toBe(true);
    expect(mobileRouteForUrl(url.replace(/^codecast:\/\//, "/"))).toBe("/(tabs)/inbox");
  });
});
