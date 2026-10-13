import { describe, test, expect } from "bun:test";
import { cursorWatcherDecision, isTccDeniedError } from "./cursorWatcher.js";

describe("cursorWatcherDecision", () => {
  test("explicit off wins on every platform", () => {
    expect(cursorWatcherDecision({ platform: "darwin", pref: "off" })).toBe("skip");
    expect(cursorWatcherDecision({ platform: "linux", pref: "off", recordedAccess: "granted" })).toBe("skip");
  });

  test("non-darwin starts by default (no TCC gate)", () => {
    expect(cursorWatcherDecision({ platform: "linux" })).toBe("start");
    expect(cursorWatcherDecision({ platform: "win32" })).toBe("start");
  });

  test("darwin: explicit on starts (the consent flow's probe runs)", () => {
    expect(cursorWatcherDecision({ platform: "darwin", pref: "on" })).toBe("start");
    expect(cursorWatcherDecision({ platform: "darwin", pref: "on", recordedAccess: "denied" })).toBe("start");
  });

  test("darwin: a recorded grant starts without re-consent", () => {
    expect(cursorWatcherDecision({ platform: "darwin", recordedAccess: "granted" })).toBe("start");
  });

  test("darwin: undecided or denied without opt-in never touches TCC", () => {
    expect(cursorWatcherDecision({ platform: "darwin" })).toBe("needs-consent");
    expect(cursorWatcherDecision({ platform: "darwin", recordedAccess: "denied" })).toBe("needs-consent");
  });
});

describe("isTccDeniedError", () => {
  const errWithCode = (code: string) => Object.assign(new Error(code), { code });

  test("EPERM and EACCES are TCC denials", () => {
    expect(isTccDeniedError(errWithCode("EPERM"))).toBe(true);
    expect(isTccDeniedError(errWithCode("EACCES"))).toBe(true);
  });

  test("other fs errors are not", () => {
    expect(isTccDeniedError(errWithCode("ENOENT"))).toBe(false);
    expect(isTccDeniedError(new Error("plain"))).toBe(false);
    expect(isTccDeniedError(null)).toBe(false);
  });
});
