import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HYPERFRAMES_RUNTIME, MOTION_RENDER_MANIFEST } from "@codecast/shared/contracts";
import { motionEntry, motionRenderArgs, motionSourceHash, staleRenderNote } from "./publishMotion";
import { walkBundleDir } from "./publish";

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
