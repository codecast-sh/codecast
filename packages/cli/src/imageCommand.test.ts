import { describe, test, expect } from "bun:test";
import { isRemoteTarget, altTextFor } from "./imageCommand.js";

describe("isRemoteTarget", () => {
  test("http(s) URLs are remote, paths are not", () => {
    expect(isRemoteTarget("https://example.com/a.png")).toBe(true);
    expect(isRemoteTarget("HTTP://example.com/a.png")).toBe(true);
    expect(isRemoteTarget("/tmp/shot.png")).toBe(false);
    expect(isRemoteTarget("shot.png")).toBe(false);
    expect(isRemoteTarget("file:///tmp/shot.png")).toBe(false);
  });
});

describe("altTextFor", () => {
  test("uses the basename without extension", () => {
    expect(altTextFor("/tmp/screens/login-page.png")).toBe("login-page");
    expect(altTextFor("shot.JPG")).toBe("shot");
  });
  test("derives from URL path, falling back to 'image'", () => {
    expect(altTextFor("https://example.com/img/chart%20one.png")).toBe("chart one");
    expect(altTextFor("https://example.com/")).toBe("image");
  });
});
