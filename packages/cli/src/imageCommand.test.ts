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

describe("shareCallFrame", () => {
  test("sends the frame's own bytes with the recording, never a storage id, and builds the markdown from the URL returned", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { shareCallFrame } = await import("./imageCommand.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "share-frame-"));
    const file = path.join(dir, "cl-42_2m11s_screen.png");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    fs.writeFileSync(file, png);
    const posts: Array<[string, any]> = [];
    const out = await shareCallFrame(async (route, body) => (posts.push([route, body]), { url: "https://img/x" }), file, "rec1", "cl-42@2:11, Ana's screen");
    expect(posts).toEqual([["/cli/calls/frame-share", { recording_id: "rec1", image_base64: png.toString("base64") }]]);
    expect(out).toEqual({ url: "https://img/x", markdown: "![cl-42@2:11, Ana's screen](https://img/x)" });
    await expect(shareCallFrame(async () => ({}), file, "rec1", "a")).rejects.toThrow(/no image URL/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
