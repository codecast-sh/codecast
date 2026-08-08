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
import * as path from "node:path";
import type { Command } from "commander";
import { apiPost, type PublishDeps } from "./publish.js";
import { detectImageMediaType, withTimeout, MAX_IMAGE_SIZE } from "./syncService.js";
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

export interface SharedImage {
  source: string;
  url: string;
  storageId: string;
  mediaType: string;
  bytes: number;
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

async function uploadOne(deps: PublishDeps, target: string): Promise<SharedImage> {
  const bytes = await loadTargetBytes(target);
  if (bytes.length > MAX_IMAGE_SIZE) {
    throw new Error(`too large: ${(bytes.length / 1e6).toFixed(1)}MB > ${MAX_IMAGE_SIZE / 1e6}MB — downscale or re-encode as jpg/webp first`);
  }
  const mediaType = detectImageMediaType(bytes);
  if (!mediaType || !UPLOADABLE_TYPES.has(mediaType)) {
    throw new Error(`not an uploadable image (${mediaType ?? "unrecognized bytes"}) — png, jpg, gif, webp, avif, or bmp`);
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
  return { source: target, url: resolved.url, storageId, mediaType, bytes: bytes.length };
}

export function registerImageCommand(program: Command, deps: PublishDeps): void {
  program
    .command("image <target...>")
    .description("Upload images (files or URLs) and print stable links that render inline in messages and canvas")
    .option("--json", "Machine-readable output")
    .action(async (targets: string[], options: { json?: boolean }) => {
      const shared: SharedImage[] = [];
      const failures: { source: string; error: string }[] = [];
      for (const target of targets) {
        try {
          shared.push(await uploadOne(deps, target));
        } catch (err) {
          failures.push({ source: target, error: err instanceof Error ? err.message : String(err) });
        }
      }
      if (options.json) {
        console.log(JSON.stringify({ images: shared, failures }, null, 2));
      } else {
        for (const img of shared) {
          console.log(`${fmt.success(icons.check)} ${fmt.highlight(img.source)} ${fmt.muted(`(${img.mediaType}, ${(img.bytes / 1000).toFixed(0)}KB)`)}`);
          console.log(`  ${img.url}`);
          console.log(`  ${fmt.muted("markdown:")} ![${altTextFor(img.source)}](${img.url})`);
        }
        for (const failure of failures) {
          console.error(`${fmt.error(icons.cross)} ${failure.source} — ${failure.error}`);
        }
      }
      if (failures.length > 0) process.exit(1);
    });
}
