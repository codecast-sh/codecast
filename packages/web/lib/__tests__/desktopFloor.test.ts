import { describe, expect, it } from "bun:test";
import { FLOOR_REQUEST_INTERVAL_MS, floorRequestDue, isBelowFloor, parseShellVersion } from "../desktopFloor";

const SHELL_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Codecast/1.1.100 Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36";
const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

describe("parseShellVersion", () => {
  it("reads the app version Electron stamps into the user agent", () => {
    expect(parseShellVersion(SHELL_UA)).toBe("1.1.100");
  });

  it("is null in a browser", () => {
    expect(parseShellVersion(CHROME_UA)).toBeNull();
    expect(parseShellVersion(null)).toBeNull();
  });
});

describe("isBelowFloor", () => {
  it("is true only when the floor is numerically above the shell", () => {
    expect(isBelowFloor("1.1.100", "1.1.111")).toBe(true);
    expect(isBelowFloor("1.1.111", "1.1.111")).toBe(false);
    expect(isBelowFloor("1.1.112", "1.1.111")).toBe(false);
    expect(isBelowFloor("1.1.9", "1.1.10")).toBe(true);
  });

  it("is false with no shell or no floor", () => {
    expect(isBelowFloor(null, "1.1.111")).toBe(false);
    expect(isBelowFloor("1.1.100", null)).toBe(false);
    expect(isBelowFloor("1.1.100", undefined)).toBe(false);
  });
});

describe("floorRequestDue", () => {
  it("asks at once when this window never asked", () => {
    expect(floorRequestDue(1_000, null)).toBe(true);
  });

  it("does not ask again inside the interval, so a failed swap cannot loop the app", () => {
    expect(floorRequestDue(10_000, 5_000)).toBe(false);
    expect(floorRequestDue(5_000 + FLOOR_REQUEST_INTERVAL_MS, 5_000)).toBe(true);
  });
});
