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
  MOTION_RENDER_DIR,
  MOTION_RENDER_MANIFEST,
  MOTION_RENDER_MP4,
  pageIsMotion,
  type MotionRenderManifest,
} from "@codecast/shared/contracts";
import { pickBundleEntry } from "./publishCommand.js";

/** sha256 over the directory's publishable files, the render itself excluded. */
export function motionSourceHash(dir: string, relPaths: string[]): string {
  const hash = crypto.createHash("sha256");
  for (const rel of relPaths) {
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
