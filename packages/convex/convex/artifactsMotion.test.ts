// Motion pages on the serve path: which documents get the HyperFrames runtime
// and the motion player, in what order, and how a media asset downloads.
import { expect, test } from "bun:test";
import { HYPERFRAMES_RUNTIME } from "@codecast/shared/contracts";
import { injectMotion, mediaDownloadName } from "./artifactsHttp";

const API = "https://api.test";
const COMP = `<!doctype html><html><head><base href="./"><script src="gsap.js"></script></head><body><div data-composition-id="main" data-width="1920" data-height="1080"></div><script>window.__timelines.main = tl;</script></body></html>`;

test("a composition gets the pinned runtime first in head, then the deferred motion player", () => {
  const out = injectMotion(COMP, API);
  const runtime = `<script src="${HYPERFRAMES_RUNTIME.url}" integrity="${HYPERFRAMES_RUNTIME.integrity}" crossorigin="anonymous"></script>`;
  expect(out).toContain(`<head>${runtime}<script src="${API}/cli/motion.js" defer></script><base href="./">`);
  // Before the composition's own scripts register into window.__timelines.
  expect(out.indexOf(runtime)).toBeLessThan(out.indexOf("gsap.js"));
  expect(injectMotion(out, API)).toBe(out);
});

test("a page carrying its own runtime only gets the player; ordinary pages get nothing", () => {
  const own = COMP.replace("gsap.js", "https://cdn.jsdelivr.net/npm/@hyperframes/core@0.8.1/dist/hyperframe.runtime.iife.js");
  const out = injectMotion(own, API);
  expect(out).not.toContain(HYPERFRAMES_RUNTIME.integrity);
  expect(out).toContain(`${API}/cli/motion.js`);
  const page = "<html><head></head><body><video controls src=a.mp4></video></body></html>";
  expect(injectMotion(page, API)).toBe(page);
});

test("download names are safe for a quoted Content-Disposition and keep the asset's extension", () => {
  expect(mediaDownloadName(null, "cast-render/motion.mp4")).toBe(null);
  expect(mediaDownloadName("Hill docks.mp4", "cast-render/motion.mp4")).toBe("Hill-docks.mp4");
  expect(mediaDownloadName('a"; filename=evil.exe', "cast-render/motion.mp4")).toBe("a-filename-evil.mp4");
  expect(mediaDownloadName("", "cast-render/motion.mp4")).toBe("motion.mp4");
  expect(mediaDownloadName("../../x", "clip.webm")).toBe("x.webm");
});
