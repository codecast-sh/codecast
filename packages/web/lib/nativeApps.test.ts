import { describe, expect, test } from "bun:test";
import { nativeAppFor, NATIVE_APP_DISMISS_KEY, NATIVE_APP_LINKS } from "./nativeApps";

const facts = (userAgent: string, platform: string, maxTouchPoints = 0) => ({ userAgent, platform, maxTouchPoints });

describe("nativeAppFor", () => {
  test("an iPhone is offered the iOS app", () => {
    expect(nativeAppFor(facts("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15", "iPhone", 5), false)).toBe("ios");
  });

  test("an iPad that calls itself a Mac is offered the iOS app", () => {
    // iPadOS 13+ reports a Macintosh user agent and platform MacIntel; touch points give it away.
    expect(nativeAppFor(facts("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15", "MacIntel", 5), false)).toBe("ios");
  });

  test("a Mac browser is offered the desktop app", () => {
    expect(nativeAppFor(facts("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36", "MacIntel", 0), false)).toBe("mac");
  });

  test("Windows, Linux and Android get no offer", () => {
    expect(nativeAppFor(facts("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140", "Win32", 0), false)).toBeNull();
    expect(nativeAppFor(facts("Mozilla/5.0 (X11; Linux x86_64) Chrome/140", "Linux x86_64", 0), false)).toBeNull();
    expect(nativeAppFor(facts("Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/140 Mobile", "Linux armv8l", 5), false)).toBeNull();
  });

  test("inside the desktop shell nothing is offered", () => {
    expect(nativeAppFor(facts("Mozilla/5.0 (Macintosh) Codecast/1.2.0 Chrome/140 Electron/38.0.0", "MacIntel", 0), true)).toBeNull();
  });

  test("no navigator means no offer", () => {
    expect(nativeAppFor(null, false)).toBeNull();
  });
});

test("every app has a link and a dismissal key", () => {
  for (const app of ["mac", "ios"] as const) {
    expect(NATIVE_APP_LINKS[app]).toMatch(/^https:\/\//);
    expect(NATIVE_APP_DISMISS_KEY[app]).toBeTruthy();
  }
});
