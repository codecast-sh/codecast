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
import { formatBytes } from "./profile.js";
import { fmt, icons } from "../colors.js";

export interface WriteShotOptions {
  jpeg?: boolean;
  /** `--no-inline`: still write the file, but do not offer it to the thread. */
  inline?: boolean;
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
  fs.writeFileSync(out, bytes);
  console.log(
    `${fmt.success(icons.check)} ${out} (${formatBytes(bytes.length)}${shrunk ? `, downscaled from ${formatBytes(buf.length)}` : ""})`,
  );
  return o.inline !== false && bytes.length <= MAX_IMAGE_SIZE ? path.resolve(out) : null;
}
