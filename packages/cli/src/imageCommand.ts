// `cast image` — upload a screenshot (local file or remote image URL) to
// codecast storage and print a stable URL that renders inline for the human.
//
// Why this exists: agents kept "sharing" screenshots as links to local temp
// paths (/var/folders/...), which are dead in the web UI — the viewer's browser
// can't reach files on the agent's machine. Storage URLs are on the web app's
// trusted-image-origin list, so `![alt](url)` renders immediately in message
// markdown, and the canvas sanitizer allows the same origin for `<img>`.
//
// Same deps pattern as publish.ts: index.ts hands in config access, this module
// stays importable by tests.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Command } from "commander";
import { apiPost, type PublishDeps } from "./publish.js";
import { detectImageMediaType, withTimeout, MAX_IMAGE_SIZE } from "./syncService.js";
import { hashImageBytes, lookupByHash, storeUpload } from "./imageCache.js";
import { spawnSync } from "./proc.js";
import { fmt, icons } from "./colors.js";

const FETCH_TIMEOUT_MS = 20_000;

// Raster formats only. SVG is deliberately excluded: served from our storage
// origin it would execute script on direct navigation, and the inline-image
// pipeline has no reason to carry documents.
const UPLOADABLE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
]);

// Formats sips can safely re-encode when a file is over the size cap. GIFs are
// excluded (resampling flattens animation), webp/avif are already compressed.
const DOWNSCALABLE_TYPES = new Set(["image/png", "image/jpeg", "image/tiff", "image/bmp"]);

export function isRemoteTarget(target: string): boolean {
  return /^https?:\/\//i.test(target);
}

export function altTextFor(target: string): string {
  if (isRemoteTarget(target)) {
    try {
      const base = new URL(target).pathname.split("/").pop() ?? "";
      const cleaned = decodeURIComponent(base).replace(/\.[a-z0-9]+$/i, "");
      return cleaned || "image";
    } catch {
      return "image";
    }
  }
  return path.basename(target).replace(/\.[a-z0-9]+$/i, "") || "image";
}

export function markdownFor(img: { source: string; url: string; alt?: string }): string {
  return `![${img.alt ?? altTextFor(img.source)}](${img.url})`;
}

export interface SharedImage {
  source: string;
  url: string;
  storageId: string;
  mediaType: string;
  bytes: number;
  markdown: string;
  deduped?: boolean;
  downscaledFrom?: number;
}

async function loadTargetBytes(target: string): Promise<Buffer> {
  if (isRemoteTarget(target)) {
    const response = await withTimeout(fetch(target), FETCH_TIMEOUT_MS, "image fetch");
    if (!response.ok) throw new Error(`fetch failed: HTTP ${response.status}`);
    return Buffer.from(await withTimeout(response.arrayBuffer(), FETCH_TIMEOUT_MS, "image download"));
  }
  const absPath = path.resolve(target);
  if (!fs.existsSync(absPath)) throw new Error(`no such file: ${target}`);
  return fs.readFileSync(absPath);
}

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

/** Exported so `cast browser shot --share` reuses the whole pipeline — hash
 *  dedupe, downscaling, upload, markdown — instead of growing a second one. */
export async function uploadOne(deps: PublishDeps, target: string, alt?: string): Promise<SharedImage> {
  let bytes = await loadTargetBytes(target);
  let mediaType = detectImageMediaType(bytes);
  let downscaledFrom: number | undefined;
  if (bytes.length > MAX_IMAGE_SIZE && mediaType) {
    const scaled = downscaleWithSips(bytes, mediaType);
    if (scaled) {
      downscaledFrom = bytes.length;
      bytes = scaled;
      mediaType = detectImageMediaType(bytes);
    }
  }
  if (bytes.length > MAX_IMAGE_SIZE) {
    throw new Error(`too large: ${(bytes.length / 1e6).toFixed(1)}MB > ${MAX_IMAGE_SIZE / 1e6}MB — downscale or re-encode as jpg/webp first`);
  }
  if (!mediaType || !UPLOADABLE_TYPES.has(mediaType)) {
    throw new Error(`not an uploadable image (${mediaType ?? "unrecognized bytes"}) — png, jpg, gif, webp, avif, or bmp`);
  }

  const absPath = isRemoteTarget(target) ? undefined : path.resolve(target);
  const hash = hashImageBytes(bytes);
  const base = { source: target, mediaType, bytes: bytes.length, downscaledFrom };
  const cached = lookupByHash(hash);
  if (cached) {
    return { ...base, url: cached.url, storageId: cached.storageId, markdown: markdownFor({ source: target, url: cached.url, alt }), deduped: true };
  }

  const uploadUrl = await apiPost(deps, "/cli/images/upload-url", {}, { exitOnError: false });
  if (typeof uploadUrl !== "string") throw new Error("upload-url response malformed");
  const uploadResponse = await withTimeout(
    fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": mediaType },
      body: new Uint8Array(bytes),
    }),
    FETCH_TIMEOUT_MS,
    "image upload",
  );
  if (!uploadResponse.ok) throw new Error(`upload failed: HTTP ${uploadResponse.status}`);
  const { storageId } = await uploadResponse.json();
  if (!storageId) throw new Error("upload returned no storage id");
  const resolved = await apiPost(deps, "/cli/images/url", { storageId }, { exitOnError: false });
  if (!resolved?.url) throw new Error("could not resolve image URL");
  storeUpload({ hash, absPath, storageId, url: resolved.url });
  return { ...base, url: resolved.url, storageId, markdown: markdownFor({ source: target, url: resolved.url, alt }) };
}

export function registerImageCommand(program: Command, deps: PublishDeps): void {
  program
    .command("image <target...>")
    .description("Upload images (files or URLs) and print stable links that render inline in messages and canvas")
    .option("--alt <text>", "Alt text for the printed markdown (defaults to the file name)")
    .option("--json", "Machine-readable output")
    .action(async (targets: string[], options: { alt?: string; json?: boolean }) => {
      const shared: SharedImage[] = [];
      const failures: { source: string; error: string }[] = [];
      for (const target of targets) {
        try {
          shared.push(await uploadOne(deps, target, options.alt));
        } catch (err) {
          failures.push({ source: target, error: err instanceof Error ? err.message : String(err) });
        }
      }
      if (options.json) {
        console.log(JSON.stringify({ images: shared, failures }, null, 2));
      } else {
        for (const img of shared) {
          const notes = [
            `${img.mediaType}, ${(img.bytes / 1000).toFixed(0)}KB`,
            ...(img.downscaledFrom ? [`downscaled from ${(img.downscaledFrom / 1e6).toFixed(1)}MB`] : []),
            ...(img.deduped ? ["already uploaded — same link"] : []),
          ];
          console.log(`${fmt.success(icons.check)} ${fmt.highlight(img.source)} ${fmt.muted(`(${notes.join(", ")})`)}`);
          console.log(`  ${img.url}`);
          console.log(`  ${fmt.muted("markdown:")} ${img.markdown}`);
        }
        for (const failure of failures) {
          console.error(`${fmt.error(icons.cross)} ${failure.source} — ${failure.error}`);
        }
      }
      if (failures.length > 0) process.exit(1);
    });
}
