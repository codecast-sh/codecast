/**
 * Writing a screenshot to disk the way the conversation can accept it.
 *
 * A retina full-page capture runs to several megabytes, and anything over the
 * sync cap is dropped on its way to the thread — silently, so the screenshot
 * would simply never appear. Shrink it here with the same ladder the upload
 * path uses rather than let that happen. Shared by every command that produces
 * a picture, on every engine, so the report line and the size rule agree.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { downscaleWithSips } from "../imageCommand.js";
import { MAX_IMAGE_SIZE } from "../syncService.js";
import { agentTempPath, secureTempFile, TEMP_FILE_MODE } from "../tempFiles.js";
import { formatBytes } from "./profile.js";
import { fmt, icons } from "../colors.js";

export interface WriteShotOptions {
  jpeg?: boolean;
  /** `--no-inline`: still write the file, but do not offer it to the thread. */
  inline?: boolean;
  /** `--json`: the caller prints one object, so print nothing here. */
  quiet?: boolean;
}

/** The kind of scratch file a screenshot is, in the shared temp policy. */
export const SHOT_TEMP_KIND = "shots";

/**
 * Where a screenshot goes when the caller named no path: a 0700 directory of
 * ours, not the world-readable /tmp a page's contents used to land in
 * (tempFiles.ts, ct-49556).
 */
export function defaultShotPath(ext: "png" | "jpg" = "png"): string {
  return agentTempPath(SHOT_TEMP_KIND, `cast-shot-${Date.now()}-${process.pid}.${ext}`);
}

/**
 * The pixel size of an encoded image, read from its header.
 *
 * Local and exact, so `shot --json` can report what it captured without a
 * second round trip to the browser. Returns null for a format we cannot read
 * rather than guessing.
 */
export function imageSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    // Walk the JPEG segment chain to the frame header, which is the only
    // segment that carries the size.
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      // SOF0..SOF15, minus the four markers in that range that are not frames.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc, 0xd8].includes(marker)) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}

/**
 * Write `buf` to `out` (downscaled if it must be), print the report line, and
 * return the absolute path to hand to the conversation — or null when the
 * caller opted out or the picture is still too large to show.
 */
export function writeShotFile(buf: Buffer, out: string, o: WriteShotOptions): string | null {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  let bytes = buf;
  let shrunk = false;
  if (bytes.length > MAX_IMAGE_SIZE) {
    const smaller = downscaleWithSips(bytes, o.jpeg ? "image/jpeg" : "image/png");
    if (smaller && smaller.length < bytes.length) {
      bytes = smaller;
      shrunk = true;
    }
  }
  // Owner-only: a screenshot carries whatever the page was showing, and the
  // mode argument only applies when the file is new, so chmod the rest.
  fs.writeFileSync(out, bytes, { mode: TEMP_FILE_MODE });
  secureTempFile(out);
  if (!o.quiet) {
    console.log(
      `${fmt.success(icons.check)} ${out} (${formatBytes(bytes.length)}${shrunk ? `, downscaled from ${formatBytes(buf.length)}` : ""})`,
    );
  }
  return o.inline !== false && bytes.length <= MAX_IMAGE_SIZE ? path.resolve(out) : null;
}

// ---------------------------------------------------------------------------
// The machine-readable shape
// ---------------------------------------------------------------------------

/**
 * `shot --json`: where the picture is and how big it is, never the picture.
 *
 * Base64 in a command's output costs thousands of tokens to say what a path
 * says in one line, and the conversation renders the image from the file
 * either way. A width or height we could not read is null, never a guess.
 */
export interface ShotJson {
  path: string;
  width: number | null;
  height: number | null;
  scale: number | null;
  bytes: number;
  /** `--annotate`: the [N] → ref legend, which is text, not pixels. */
  annotations?: unknown;
  /** `--share`: the uploaded URL, for a reader who is not on this machine. */
  url?: string;
}

/** Assemble the answer from what the file and the page each know. Shared by
 *  both drivers so `shot --json` reads the same however it was captured. */
export function shotJson(o: {
  file: string;
  bytes: number;
  size: { width: number; height: number } | null;
  scale: number | null;
  annotations?: unknown;
  url?: string;
}): ShotJson {
  return {
    path: path.resolve(o.file),
    width: o.size?.width ?? null,
    height: o.size?.height ?? null,
    scale: o.scale,
    bytes: o.bytes,
    ...(o.annotations ? { annotations: o.annotations } : {}),
    ...(o.url ? { url: o.url } : {}),
  };
}
