// The upload half of a publish: media files go to R2 by content hash, and the
// biggest bundle files go up as raw uploads when the inline body would pass
// what the server can decode. publish.ts runs both before the publish request.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fmt } from "./colors.js";
import { formatBytes } from "./publishCommand.js";
import { apiPost, apiUpload, type PublishDeps } from "./castApi.js";
import type { PublishPayload } from "./publish.js";

// Media already uploaded this run, so --watch republishes don't rehash big files.
const uploadedMedia = new Map<string, string>();

/** Upload one video or audio file to media hosting (R2, keyed by its content
 * hash) and return its public URL; the same bytes already there upload nothing.
 * `label` names the file in progress lines and errors. */
export async function uploadMediaFile(deps: PublishDeps, abs: string, label: string): Promise<{ url: string; bytes: number; existed: boolean }> {
  const size = fs.statSync(abs).size;
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(abs)) hash.update(chunk as Buffer);
  const ext = path.extname(abs).slice(1).toLowerCase();
  const signed = await apiPost(deps, "/cli/media/sign", { sha256: hash.digest("hex"), size, ext }, { exitOnError: false });
  if (!signed.exists) {
    process.stderr.write(fmt.muted(`uploading ${label} (${formatBytes(size)})\n`));
    const put = await fetch(signed.upload_url, {
      method: "PUT",
      headers: { "Content-Type": signed.content_type ?? "application/octet-stream", "Cache-Control": "public, max-age=31536000, immutable" },
      body: await fs.openAsBlob(abs),
    });
    if (!put.ok) throw new Error(`Upload of ${label} failed (${put.status}): ${(await put.text()).slice(0, 200)}`);
  }
  return { url: signed.url as string, bytes: size, existed: !!signed.exists };
}

/** Upload each media file to R2 (skipped when the same bytes are already there)
 * and add it to the bundle as a path that the server redirects to the upload. */
export async function uploadMedia(deps: PublishDeps, payload: PublishPayload): Promise<void> {
  for (const m of payload.media ?? []) {
    const stat = fs.statSync(m.abs);
    const cacheKey = `${m.abs}:${stat.size}:${stat.mtimeMs}`;
    let url = uploadedMedia.get(cacheKey);
    if (!url) {
      url = (await uploadMediaFile(deps, m.abs, m.path)).url;
      uploadedMedia.set(cacheKey, url);
    }
    payload.files!.push({ path: m.path, media_url: url, size: stat.size });
  }
}

/** File bytes the publish body carries inline. The server decodes them inside a
 * 64 MB heap, so past this the biggest files go up first as raw uploads. */
export const INLINE_BUDGET_BYTES = 4 * 1024 * 1024;

/** Paths to upload ahead of the publish, biggest first, until the inline rest fits the budget. The entry page always stays inline. */
export function pathsToUpload(files: Array<{ path: string; size: number }>, entryPath: string | null, budget = INLINE_BUDGET_BYTES): string[] {
  let inline = files.reduce((sum, f) => sum + f.size, 0);
  const out: string[] = [];
  for (const f of [...files].sort((a, b) => b.size - a.size)) {
    if (inline <= budget) break;
    if (f.path === entryPath) continue;
    out.push(f.path);
    inline -= f.size;
  }
  return out;
}

export async function uploadLargeFiles(deps: PublishDeps, payload: PublishPayload): Promise<void> {
  if (payload.kind !== "bundle" || !payload.files) return;
  const inline = payload.files.filter((f) => f.content_b64 !== undefined);
  const bytes = new Map(inline.map((f) => [f.path, Buffer.from(f.content_b64!, "base64")]));
  const entry = payload.entryHtmlPath ? path.relative(payload.source_path, payload.entryHtmlPath).split(path.sep).join("/") : null;
  const chosen = new Set(pathsToUpload(inline.map((f) => ({ path: f.path, size: bytes.get(f.path)!.byteLength })), entry));
  for (const f of payload.files) {
    if (!chosen.has(f.path)) continue;
    const b = bytes.get(f.path)!;
    process.stderr.write(fmt.muted(`uploading ${f.path} (${formatBytes(b.byteLength)})\n`));
    const { upload_id } = await apiUpload(deps, `/cli/artifacts/upload?path=${encodeURIComponent(f.path)}`, new Blob([b]), { exitOnError: false });
    delete f.content_b64;
    f.upload_id = upload_id;
  }
}
