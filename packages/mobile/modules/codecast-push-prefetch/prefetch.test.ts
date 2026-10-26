import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PushPrefetchStore.swift exists twice on purpose (the app's native module and
// the notification service extension cannot share a pod). Both sides read and
// write the same keychain item and files by these names, so the copies must
// stay one file, and their identifiers must match the entitlements.

const here = import.meta.dir;
const mobile = join(here, "../..");
const appCopy = readFileSync(join(here, "ios/PushPrefetchStore.swift"), "utf8");
const extensionCopy = readFileSync(join(mobile, "targets/notification-service/PushPrefetchStore.swift"), "utf8");
const app = JSON.parse(readFileSync(join(mobile, "app.json"), "utf8")).expo.ios;
const target = require(join(mobile, "targets/notification-service/expo-target.config.js"));

describe("PushPrefetchStore", () => {
  test("the extension's copy is byte-identical to the app module's", () => {
    expect(extensionCopy).toBe(appCopy);
  });

  test("the app group is one both sides are entitled to", () => {
    const group = /appGroup = "([^"]+)"/.exec(appCopy)?.[1];
    expect(app.entitlements["com.apple.security.application-groups"]).toContain(group);
    expect(target.entitlements["com.apple.security.application-groups"]).toContain(group);
  });

  test("the keychain group is one both sides are entitled to", () => {
    const group = /keychainGroup = "([^"]+)"/.exec(appCopy)?.[1] ?? "";
    const [team, ...rest] = group.split(".");
    expect(team).toBe(app.appleTeamId);
    const suffix = `$(AppIdentifierPrefix)${rest.join(".")}`;
    expect(app.entitlements["keychain-access-groups"]).toContain(suffix);
    expect(target.entitlements["keychain-access-groups"]).toContain(suffix);
  });

  test("the app keeps its own keychain group first, so existing items keep their default group", () => {
    expect(app.entitlements["keychain-access-groups"][0]).toBe(`$(AppIdentifierPrefix)${app.bundleIdentifier}`);
  });
});
