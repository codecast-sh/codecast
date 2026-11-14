/**
 * The image size cap and the one way to get under it, in a module with no
 * imports beyond node. Screenshot writers (browser and computer) reach this on
 * every capture, and through imageCommand.ts or syncService.ts they used to
 * load the sync client, the redaction tables and convex with it.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "./proc.js";

/** The largest image the conversation accepts; anything bigger is dropped on its way to the thread. */
export const MAX_IMAGE_SIZE = 5_000_000;

// Formats sips can safely re-encode when a file is over the size cap. GIFs are
// excluded (resampling flattens animation), webp/avif are already compressed.
const DOWNSCALABLE_TYPES = new Set(["image/png", "image/jpeg", "image/tiff", "image/bmp"]);

// Oversized screenshot rescue: Retina PNG captures routinely exceed the 5MB
// upload cap. On macOS, sips (built-in) re-encodes to a bounded JPEG; two
// passes, progressively smaller, before giving up.
/** Exported so screenshot capture can shrink an oversized frame with the same
 *  ladder the upload path uses, instead of growing a second one. */
export function downscaleWithSips(bytes: Buffer, mediaType: string): Buffer | null {
  if (process.platform !== "darwin" || !DOWNSCALABLE_TYPES.has(mediaType)) return null;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cast-image-"));
  const src = path.join(scratch, "in");
  fs.writeFileSync(src, new Uint8Array(bytes));
  try {
    for (const [maxDim, quality] of [[2400, 80], [1600, 65]] as const) {
      const out = path.join(scratch, `out-${maxDim}.jpg`);
      const result = spawnSync(
        "sips",
        ["-Z", String(maxDim), "-s", "format", "jpeg", "-s", "formatOptions", String(quality), src, "--out", out],
        { stdio: "ignore" },
      );
      if (result.status !== 0 || !fs.existsSync(out)) return null;
      const scaled = fs.readFileSync(out);
      if (scaled.length <= MAX_IMAGE_SIZE) return scaled;
    }
    return null;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
