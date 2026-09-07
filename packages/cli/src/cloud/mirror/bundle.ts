/**
 * The wire format of a home mirror push — one bundle over ssh stdin:
 *
 *   CASTMIRROR1\n  u32be(header length)  <JSON header>  <bodies, header order>
 *
 * The content hash covers the header minus everything host-derived or
 * informational (cast_version, take_over, skipped, scrubbed,
 * excludes_applied) plus the bodies, with files sorted by path — so file
 * order, mtimes and reporting never move it, and a laptop can compare its
 * hash with a host stamp to skip a redundant push.
 *
 * The parser rejects a truncated stream, a bad magic, another version, an
 * unsafe path, a size or sha mismatch — before a single byte is applied.
 */

import { createHash } from "node:crypto";
import { MIRROR_KINDS, type MirrorKind } from "./transform.js";

export const MIRROR_MAGIC = "CASTMIRROR1\n";
export const MIRROR_VERSION = 1;
const MAX_HEADER_BYTES = 16 * 1024 * 1024;
export const MAX_MIRROR_BODY_BYTES = 256 * 1024 * 1024;

export interface BundleFileMeta {
  path: string;
  kind: MirrorKind;
  mode: "0600" | "0700";
  size: number;
  sha256: string;
}

export interface BundleSource {
  device_id: string;
  user_id: string;
  home: string;
  platform: string;
  cast_version: string;
}

export interface BundleHeader {
  version: 1;
  source: BundleSource;
  target_home: string;
  files: BundleFileMeta[];
  managed_roots: string[];
  take_over: boolean;
  skipped: Array<{ path: string; reason: string }>;
  scrubbed: string[];
  excludes_applied: string[];
  project_roots?: string[];
  unmanaged_roots?: string[];
}

export interface BundleInput {
  path: string;
  kind: MirrorKind;
  mode: "0600" | "0700";
  bytes: Buffer;
}

export interface BuildMeta {
  source: BundleSource;
  target_home: string;
  managed_roots: string[];
  take_over?: boolean;
  skipped?: Array<{ path: string; reason: string }>;
  scrubbed?: string[];
  excludes_applied?: string[];
  project_roots?: string[];
  unmanaged_roots?: string[];
}

export interface BuiltBundle {
  bytes: Buffer;
  hash: string;
  header: BundleHeader;
}

export interface ParsedFile extends BundleFileMeta {
  bytes: Buffer;
}

export interface ParsedBundle {
  header: BundleHeader;
  files: ParsedFile[];
  hash: string;
}

export function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sortByPath<T extends { path: string }>(list: T[]): T[] {
  return [...list].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The content hash of a header + bodies (bodies in sorted-path order). */
export function bundleHash(header: BundleHeader, bodies: Map<string, Buffer>): string {
  const h = createHash("sha256");
  const files = sortByPath(header.files);
  h.update(JSON.stringify({
    version: header.version,
    source: { device_id: header.source.device_id, user_id: header.source.user_id, home: header.source.home, platform: header.source.platform },
    target_home: header.target_home,
    files: files.map((f) => ({ path: f.path, kind: f.kind, mode: f.mode, size: f.size, sha256: f.sha256 })),
    managed_roots: [...header.managed_roots].sort(),
    ...(header.project_roots?.length ? { project_roots: [...header.project_roots].sort() } : {}),
    ...(header.unmanaged_roots?.length ? { unmanaged_roots: [...header.unmanaged_roots].sort() } : {}),
  }));
  for (const f of files) {
    h.update("\0");
    h.update(bodies.get(f.path) ?? Buffer.alloc(0));
  }
  return h.digest("hex");
}

export function buildMirrorBundle(entries: BundleInput[], meta: BuildMeta): BuiltBundle {
  if (entries.reduce((n, e) => n + e.bytes.length, 0) > MAX_MIRROR_BODY_BYTES) throw new Error("mirror bundle exceeds 256 MiB body limit");
  const sorted = sortByPath(entries);
  const seen = new Set<string>();
  for (const e of sorted) {
    assertSafePath(e.path);
    if (seen.has(e.path)) throw new Error(`duplicate mirror path ${e.path}`);
    seen.add(e.path);
  }
  const header: BundleHeader = {
    version: MIRROR_VERSION,
    source: meta.source,
    target_home: meta.target_home,
    files: sorted.map((e) => ({ path: e.path, kind: e.kind, mode: e.mode, size: e.bytes.length, sha256: sha256(e.bytes) })),
    managed_roots: [...meta.managed_roots],
    take_over: meta.take_over ?? false,
    skipped: meta.skipped ?? [],
    scrubbed: meta.scrubbed ?? [],
    excludes_applied: meta.excludes_applied ?? [],
    ...(meta.project_roots?.length ? { project_roots: meta.project_roots } : {}),
    ...(meta.unmanaged_roots?.length ? { unmanaged_roots: meta.unmanaged_roots } : {}),
  };
  const headerBytes = Buffer.from(JSON.stringify(header), "utf-8");
  if (headerBytes.length > MAX_HEADER_BYTES) throw new Error("mirror bundle header length out of range");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(headerBytes.length, 0);
  const bytes = Buffer.concat([Buffer.from(MIRROR_MAGIC), len, headerBytes, ...sorted.map((e) => e.bytes)]);
  const bodies = new Map(sorted.map((e) => [e.path, e.bytes]));
  return { bytes, hash: bundleHash(header, bodies), header };
}

/** A relative posix path with no `.`/`..`/`.git` segment, no control chars, no backslash. */
export function assertSafePath(p: string): void {
  if (typeof p !== "string" || !p || p.startsWith("/") || /[\\:\x00-\x1f\x7f]/.test(p)
    || p.split("/").some((seg) => !seg || seg === "." || seg === ".." || seg.toLowerCase() === ".git")) {
    throw new Error(`unsafe mirror path: ${JSON.stringify(String(p).slice(0, 80))}`);
  }
}

async function readAll(input: Buffer | AsyncIterable<Buffer | string>): Promise<Buffer> {
  const max = MAX_HEADER_BYTES + MAX_MIRROR_BODY_BYTES + Buffer.byteLength(MIRROR_MAGIC) + 4;
  if (Buffer.isBuffer(input)) {
    if (input.length > max) throw new Error("mirror bundle exceeds receive limit");
    return input;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += bytes.length;
    if (size > max) throw new Error("mirror bundle exceeds receive limit");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

/** Parse and validate a bundle. Throws on anything malformed; applies nothing. */
export async function parseMirrorBundle(input: Buffer | AsyncIterable<Buffer | string>): Promise<ParsedBundle> {
  const bytes = await readAll(input);
  const magic = Buffer.from(MIRROR_MAGIC);
  if (bytes.length < magic.length + 4 || !bytes.subarray(0, magic.length).equals(magic)) {
    throw new Error("not a mirror bundle (bad magic)");
  }
  const headerLen = bytes.readUInt32BE(magic.length);
  if (headerLen <= 0 || headerLen > MAX_HEADER_BYTES) throw new Error("mirror bundle header length out of range");
  const headerStart = magic.length + 4;
  if (bytes.length < headerStart + headerLen) throw new Error("truncated mirror bundle (header)");
  let header: BundleHeader;
  try {
    header = JSON.parse(bytes.subarray(headerStart, headerStart + headerLen).toString("utf-8"));
  } catch {
    throw new Error("mirror bundle header is not JSON");
  }
  if (!header || typeof header !== "object" || header.version !== MIRROR_VERSION) {
    throw new Error(`unsupported mirror bundle version ${(header as { version?: unknown })?.version ?? "?"}`);
  }
  if (!header.source || typeof header.source !== "object" || typeof header.target_home !== "string" || !Array.isArray(header.files)) {
    throw new Error("mirror bundle header is malformed");
  }
  header.managed_roots = Array.isArray(header.managed_roots) ? header.managed_roots.filter((r) => typeof r === "string") : [];
  header.take_over = header.take_over === true;
  header.skipped = Array.isArray(header.skipped) ? header.skipped : [];
  header.scrubbed = Array.isArray(header.scrubbed) ? header.scrubbed : [];
  header.excludes_applied = Array.isArray(header.excludes_applied) ? header.excludes_applied : [];
  for (const root of header.managed_roots) assertSafePath(root);
  if (header.project_roots !== undefined) {
    if (!Array.isArray(header.project_roots)) throw new Error("invalid project roots");
    for (const root of header.project_roots) assertSafePath(root);
  }
  if (header.unmanaged_roots !== undefined) {
    if (!Array.isArray(header.unmanaged_roots)) throw new Error("invalid unmanaged roots");
    for (const root of header.unmanaged_roots) assertSafePath(root);
  }
  if (bytes.length - headerStart - headerLen > MAX_MIRROR_BODY_BYTES) throw new Error("mirror bundle exceeds 256 MiB body limit");

  const seen = new Set<string>();
  let offset = headerStart + headerLen;
  const files: ParsedFile[] = [];
  for (const f of header.files) {
    if (!f || typeof f !== "object") throw new Error("mirror bundle file entry is malformed");
    assertSafePath(f.path);
    if (seen.has(f.path)) throw new Error(`duplicate mirror path ${f.path}`);
    seen.add(f.path);
    if (!MIRROR_KINDS.includes(f.kind)) throw new Error(`unknown mirror kind ${JSON.stringify(f.kind)} for ${f.path}`);
    if (f.mode !== "0600" && f.mode !== "0700") throw new Error(`bad mode for ${f.path}`);
    if (!Number.isInteger(f.size) || f.size < 0) throw new Error(`bad size for ${f.path}`);
    if (typeof f.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(f.sha256)) throw new Error(`bad sha256 for ${f.path}`);
    if (offset + f.size > bytes.length) throw new Error(`truncated mirror bundle (${f.path})`);
    const body = bytes.subarray(offset, offset + f.size);
    offset += f.size;
    if (sha256(body) !== f.sha256) throw new Error(`sha256 mismatch for ${f.path}`);
    files.push({ ...f, bytes: Buffer.from(body) });
  }
  if (offset !== bytes.length) throw new Error("mirror bundle has trailing bytes");
  const hash = bundleHash(header, new Map(files.map((f) => [f.path, f.bytes])));
  return { header, files, hash };
}
