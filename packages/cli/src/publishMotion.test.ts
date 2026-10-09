import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HYPERFRAMES_RUNTIME, MOTION_RENDER_MANIFEST } from "@codecast/shared/contracts";
import { motionEntry, motionRenderArgs, motionSourceHash, motionThumbHtml, staleRenderNote } from "./publishMotion";
import { buildPublishPayload, walkBundleDir } from "./publish";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function project(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-motion-"));
  dirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}
const COMP = `<div data-composition-id="main" data-width="1920" data-height="1080"></div>`;

test("a directory is a motion project when its entry declares a composition", () => {
  const motion = project({ "index.html": COMP, "intro.html": "<template></template>" });
  expect(motionEntry(motion, walkBundleDir(motion))).toBe("index.html");
  const page = project({ "index.html": "<h1>Report</h1>" });
  expect(motionEntry(page, walkBundleDir(page))).toBe(null);
});

test("the render runs the HyperFrames release the page plays on", () => {
  expect(motionRenderArgs("/p", "index.html", "/p/out.mp4")).toEqual([
    "--yes", `hyperframes@${HYPERFRAMES_RUNTIME.version}`, "render", "/p", "--output", "/p/out.mp4", "--quiet",
  ]);
  expect(motionRenderArgs("/p", "film.html", "/o.mp4")).toContain("--composition");
});

test("a render goes stale when the composition changes, not when the render itself does", () => {
  const dir = project({ "index.html": COMP });
  expect(staleRenderNote(dir, walkBundleDir(dir))).toBe(null);
  const hash = motionSourceHash(dir, walkBundleDir(dir));
  fs.mkdirSync(path.join(dir, "cast-render"));
  fs.writeFileSync(path.join(dir, "cast-render/motion.mp4"), "mp4 bytes");
  fs.writeFileSync(path.join(dir, MOTION_RENDER_MANIFEST), JSON.stringify({ mp4: "cast-render/motion.mp4", rendered_at: 1, source_sha256: hash, bytes: 9 }));
  expect(staleRenderNote(dir, walkBundleDir(dir))).toBe(null);
  fs.writeFileSync(path.join(dir, "index.html"), COMP + "<p>new beat</p>");
  expect(staleRenderNote(dir, walkBundleDir(dir))).toMatch(/--render/);
});

test("a composition's bundle leaves HyperFrames output out and says what it left", () => {
  const dir = project({
    "index.html": COMP,
    "fonts/a.woff2": "f",
    "renders/week.mp4": "x".repeat(2048),
    "renders/week-2.mp4": "y",
    "snapshots/frame-00.png": "png",
    "cast-render/motion.mp4": "keep",
  });
  const payload = buildPublishPayload(dir);
  const paths = [...(payload.files ?? []).map((f) => f.path), ...(payload.media ?? []).map((m) => m.path)].sort();
  expect(paths).toEqual(["cast-render/motion.mp4", "fonts/a.woff2", "index.html"]);
  expect(payload.skipped).toEqual([{ dir: "renders/", files: 2, bytes: 2049 }, { dir: "snapshots/", files: 1, bytes: 3 }]);
  // An ordinary site keeps a folder that happens to share the name.
  const site = project({ "index.html": "<h1>Site</h1>", "renders/a.png": "p" });
  expect(buildPublishPayload(site).files!.map((f) => f.path)).toContain("renders/a.png");
  // Snapshots do not make a render stale.
  const hash = motionSourceHash(dir, walkBundleDir(dir));
  fs.writeFileSync(path.join(dir, "snapshots/frame-01.png"), "more");
  expect(motionSourceHash(dir, walkBundleDir(dir))).toBe(hash);
});

test("the thumbnail page loads the pinned runtime before the composition and holds the poster", () => {
  const html = motionThumbHtml(`<html><head><script src="gsap.js"></script></head><body>${COMP}<script>window.__timelines.main = tl;</script></body></html>`);
  expect(html.indexOf(HYPERFRAMES_RUNTIME.url)).toBeLessThan(html.indexOf("gsap.js"));
  expect(html).toContain('getAttribute("data-poster")');
  expect(html.indexOf("__player.seek")).toBeGreaterThan(html.indexOf("window.__timelines.main"));
  expect(() => new Function(html.match(/<script>(\(function \(\) \{[\s\S]*?)<\/script><\/body>/)![1])).not.toThrow();
});
