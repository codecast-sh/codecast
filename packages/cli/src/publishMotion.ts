// `cast publish <dir> --render`: a HyperFrames composition rendered to MP4.
//
// The render lands inside the composition's directory (cast-render/motion.mp4
// beside a small manifest), so it rides every later publish of the directory as
// ordinary media and the page offers it for download. The manifest records a
// hash of the composition's files at render time; a publish whose files no
// longer match says the MP4 is behind instead of quietly offering an old cut.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "./proc.js";
import {
  HYPERFRAMES_RUNTIME,
  MOTION_POSTER_TIME_JS,
  MOTION_RENDER_DIR,
  MOTION_RENDER_MANIFEST,
  MOTION_RENDER_MP4,
  pageIsMotion,
  type MotionRenderManifest,
} from "@codecast/shared/contracts";
import { pickBundleEntry } from "./publishCommand.js";
import { captureThumb } from "./publish.js";

/** What HyperFrames' own commands write into a project (render and snapshot
 * output). A composition's page never serves them; the MP4 the page offers is
 * the one --render keeps in cast-render/. */
export const MOTION_OUTPUT_DIRS = ["renders", "snapshots"] as const;

/** A composition directory's files without its tool output, and a count of
 * what was left out per directory so the publisher can be told. */
export function splitMotionOutputs(dir: string, relPaths: string[]): { keep: string[]; skipped: Array<{ dir: string; files: number; bytes: number }> } {
  const keep: string[] = [];
  const skipped = new Map<string, { dir: string; files: number; bytes: number }>();
  for (const rel of relPaths) {
    const top = rel.split("/")[0];
    if (!rel.includes("/") || !(MOTION_OUTPUT_DIRS as readonly string[]).includes(top)) {
      keep.push(rel);
      continue;
    }
    const row = skipped.get(top) ?? { dir: `${top}/`, files: 0, bytes: 0 };
    row.files += 1;
    row.bytes += fs.statSync(path.join(dir, rel)).size;
    skipped.set(top, row);
  }
  return { keep, skipped: [...skipped.values()] };
}

/** sha256 over the directory's publishable files, the render itself excluded. */
export function motionSourceHash(dir: string, relPaths: string[]): string {
  const hash = crypto.createHash("sha256");
  for (const rel of splitMotionOutputs(dir, relPaths).keep) {
    if (rel === MOTION_RENDER_DIR || rel.startsWith(`${MOTION_RENDER_DIR}/`)) continue;
    hash.update(rel).update("\0").update(fs.readFileSync(path.join(dir, rel))).update("\0");
  }
  return hash.digest("hex");
}

/** The entry document of a directory when it is a HyperFrames composition. */
export function motionEntry(dir: string, relPaths: string[]): string | null {
  const { entry } = pickBundleEntry(relPaths);
  if (!entry) return null;
  return pageIsMotion(fs.readFileSync(path.join(dir, entry), "utf-8")) ? entry : null;
}

/** The render command line: the same HyperFrames release the page plays on. */
export function motionRenderArgs(dir: string, entry: string, outFile: string): string[] {
  return [
    "--yes",
    `hyperframes@${HYPERFRAMES_RUNTIME.version}`,
    "render",
    dir,
    ...(entry === "index.html" ? [] : ["--composition", entry]),
    "--output",
    outFile,
    "--quiet",
  ];
}

/** Render the composition in dir to cast-render/motion.mp4 and write its
 * manifest. Progress goes to stderr so --json output stays clean. Throws with
 * the reason when the directory is not a composition or the render fails. */
export function renderMotion(dir: string, relPaths: string[]): MotionRenderManifest {
  const entry = motionEntry(dir, relPaths);
  if (!entry) {
    throw new Error(
      "--render needs a HyperFrames composition: an index.html whose root element carries data-composition-id, data-width and data-height (cast skill cast-motion)",
    );
  }
  const outDir = path.join(dir, MOTION_RENDER_DIR);
  fs.mkdirSync(outDir, { recursive: true });
  const tmp = path.join(outDir, `.motion-${process.pid}.mp4`);
  const run = spawnSync("npx", motionRenderArgs(dir, entry, tmp), { stdio: ["ignore", 2, 2] });
  if (run.status !== 0 || !fs.existsSync(tmp)) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`hyperframes render failed (exit ${run.status ?? run.signal}); run \`npx hyperframes@${HYPERFRAMES_RUNTIME.version} check ${dir}\` for the findings`);
  }
  fs.renameSync(tmp, path.join(dir, MOTION_RENDER_MP4));
  const manifest: MotionRenderManifest = {
    mp4: MOTION_RENDER_MP4,
    rendered_at: Date.now(),
    source_sha256: motionSourceHash(dir, relPaths),
    bytes: fs.statSync(path.join(dir, MOTION_RENDER_MP4)).size,
  };
  fs.writeFileSync(path.join(dir, MOTION_RENDER_MANIFEST), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

/** A line for the publisher when the directory's MP4 no longer matches its
 * composition, else null. */
export function staleRenderNote(dir: string, relPaths: string[]): string | null {
  const file = path.join(dir, MOTION_RENDER_MANIFEST);
  if (!fs.existsSync(file)) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(file, "utf-8")) as MotionRenderManifest;
    if (manifest.source_sha256 === motionSourceHash(dir, relPaths)) return null;
  } catch {
    // An unreadable manifest is as good as a stale one.
  }
  return "the page's MP4 is from an earlier version of the composition; add --render to refresh it";
}

/** The page a motion thumbnail is shot from: the composition with the pinned
 * runtime, held at its poster still and fitted to the 1200x630 card. Written
 * beside the entry (a dotfile, so no bundle carries it) so relative assets
 * resolve; the caller removes it. */
export function motionThumbHtml(entryHtml: string): string {
  const runtime = `<script src="${HYPERFRAMES_RUNTIME.url}" integrity="${HYPERFRAMES_RUNTIME.integrity}" crossorigin="anonymous"></script>`;
  const hold = `<script>(function () {
  var posterTime = ${MOTION_POSTER_TIME_JS};
  function go() {
    if (!window.__player || !window.__playerReady) return setTimeout(go, 50);
    var root = document.querySelector("[data-composition-id][data-width][data-height]");
    var W = parseFloat(root.getAttribute("data-width")), H = parseFloat(root.getAttribute("data-height"));
    var m = window.__timelines || {}, tl = m[root.getAttribute("data-composition-id")] || null;
    window.__player.seek(posterTime(root, tl));
    var s = Math.max(1200 / W, 630 / H), box = document.createElement("div");
    box.style.cssText = "position:fixed;left:" + (1200 - W * s) / 2 + "px;top:" + (630 - H * s) / 2 + "px;width:" + W + "px;height:" + H + "px;transform:scale(" + s + ");transform-origin:0 0";
    root.parentNode.insertBefore(box, root);
    box.appendChild(root);
    document.documentElement.style.overflow = "hidden";
  }
  window.addEventListener("load", go);
})();</script>`;
  const withRuntime = /<head[^>]*>/i.test(entryHtml) ? entryHtml.replace(/<head[^>]*>/i, (h) => h + runtime) : runtime + entryHtml;
  return /<\/body>/i.test(withRuntime) ? withRuntime.replace(/<\/body>/i, hold + "</body>") : withRuntime + hold;
}

/** A thumbnail of a composition at its poster still, or null on any failure. */
export async function captureMotionThumb(entryPath: string): Promise<string | null> {
  const page = path.join(path.dirname(entryPath), `.cast-thumb-${process.pid}.html`);
  try {
    fs.writeFileSync(page, motionThumbHtml(fs.readFileSync(entryPath, "utf-8")));
    // Virtual time lets the runtime load, fonts settle and the seek land
    // before Chrome takes the shot.
    return await captureThumb(page, { extraArgs: ["--virtual-time-budget=8000", "--allow-file-access-from-files"], timeoutMs: 25_000 });
  } catch {
    return null;
  } finally {
    fs.rmSync(page, { force: true });
  }
}
