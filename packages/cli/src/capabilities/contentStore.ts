// The content store: ~/.codecast/capabilities/store/<folder_hash>/.
//
// Once a version's bytes are here, that machine never needs the network for it
// again, and materializing is a copy out of the store. The directory NAME is
// the folder hash, so a directory that exists is a verified one: bytes enter
// only through `fetchIntoStore`, which unpacks the archive in memory, hashes
// what it would write, and refuses the whole archive on a mismatch before a
// single file touches the disk.
//
// folder_hash, precisely (the server and the web compute the same thing):
//   for each regular file, sorted by its relative path ("/"-separated):
//     "<mode> <sha256 hex of the file's bytes> <path>\n"
//   mode is "755" when any executable bit is set, else "644" (no other mode
//   bit counts); the bytes of a text file (no NUL byte) have CRLF folded to
//   LF first, so the same tree checked out on Windows hashes the same as on a
//   Mac. folder_hash = sha256 hex of the concatenated lines.
//
// The lock rule is lock.ts's: never hold it across a network call. Fetch and
// verify first, then lock, write into a temp dir, rename into place, release.

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { withLock } from "./lock.js";

export interface StoreFile {
  /** Relative, "/"-separated, never absolute, never containing "..". */
  path: string;
  bytes: Buffer;
  executable: boolean;
}

/** A kit item is a skill folder or one markdown file, not a repository. */
export const MAX_STORE_FILES = 500;
export const MAX_STORE_BYTES = 8 * 1024 * 1024;

/** Names never packed: VCS metadata and OS litter that differs per machine. */
const SKIPPED_NAMES = new Set([".git", ".DS_Store", "node_modules", "Thumbs.db"]);

export function storeRoot(home: string): string {
  return path.join(home, ".codecast", "capabilities", "store");
}

export function storeDir(home: string, hash: string): string {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`not a folder hash: ${hash}`);
  return path.join(storeRoot(home), hash);
}

function isText(bytes: Buffer): boolean {
  return !bytes.includes(0);
}

function hashBytes(bytes: Buffer): string {
  const normalized = isText(bytes) ? Buffer.from(bytes.toString("latin1").replace(/\r\n/g, "\n"), "latin1") : bytes;
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

export function folderHash(files: readonly StoreFile[]): string {
  const lines = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => `${f.executable ? "755" : "644"} ${hashBytes(f.bytes)} ${f.path}\n`);
  return crypto.createHash("sha256").update(lines.join("")).digest("hex");
}

/** A relative path we would write: no root, no "..", no backslash, no NUL. */
export function safeRelPath(p: string): boolean {
  if (!p || p.startsWith("/") || p.includes("\\") || p.includes("\0")) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/**
 * Every regular file under `root` (or `root` itself when it is a file), as
 * store files. Symlinks inside the tree are skipped: a link is a path on the
 * publisher's disk, and following it could pack a file from outside the item.
 */
export function readTree(root: string): StoreFile[] {
  const stat = fs.statSync(root);
  if (stat.isFile()) {
    return [{ path: path.basename(root), bytes: fs.readFileSync(root), executable: (stat.mode & 0o111) !== 0 }];
  }
  const out: StoreFile[] = [];
  let total = 0;
  const walk = (dir: string, rel: string) => {
    for (const name of fs.readdirSync(dir).sort()) {
      if (SKIPPED_NAMES.has(name)) continue;
      const abs = path.join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        walk(abs, relPath);
        continue;
      }
      if (!st.isFile()) continue;
      total += st.size;
      if (out.length >= MAX_STORE_FILES || total > MAX_STORE_BYTES) {
        throw new Error(`${root} is too large to share (over ${MAX_STORE_FILES} files or ${MAX_STORE_BYTES / 1024 / 1024} MB)`);
      }
      out.push({ path: relPath, bytes: fs.readFileSync(abs), executable: (st.mode & 0o111) !== 0 });
    }
  };
  walk(root, "");
  return out;
}

/* ==========================================================================
 * The archive: a deterministic ustar, gzipped
 * ========================================================================== */

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, "0") + "\0";
}

function header(file: StoreFile): Buffer {
  const h = Buffer.alloc(512);
  let name = file.path;
  let prefix = "";
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf("/", 155);
    if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100) throw new Error(`path too long to archive: ${file.path}`);
    prefix = name.slice(0, cut);
    name = name.slice(cut + 1);
  }
  h.write(name, 0, 100, "utf-8");
  h.write(octal(file.executable ? 0o755 : 0o644, 8), 100, "ascii");
  h.write(octal(0, 8), 108, "ascii");
  h.write(octal(0, 8), 116, "ascii");
  h.write(octal(file.bytes.length, 12), 124, "ascii");
  h.write(octal(0, 12), 136, "ascii"); // mtime 0: same tree, same bytes
  h.write("        ", 148, "ascii");
  h.write("0", 156, "ascii");
  h.write("ustar\0", 257, "ascii");
  h.write("00", 263, "ascii");
  h.write(prefix, 345, 155, "utf-8");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(octal(sum, 7) + " ", 148, "ascii");
  return h;
}

export function packArchive(files: readonly StoreFile[]): Buffer {
  const parts: Buffer[] = [];
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    if (!safeRelPath(f.path)) throw new Error(`refusing to archive path ${f.path}`);
    parts.push(header(f), f.bytes, Buffer.alloc((512 - (f.bytes.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts), { level: 9 });
}

function field(h: Buffer, start: number, len: number): string {
  const raw = h.subarray(start, start + len);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? len : end).toString("utf-8");
}

/** Parse an archive into files, in memory. Throws on anything but regular
 *  files and directories (links, devices, pax headers) and on unsafe paths:
 *  this runs over bytes from the network, before any of them are trusted. */
export function unpackArchive(archive: Buffer): StoreFile[] {
  const tar = zlib.gunzipSync(archive, { maxOutputLength: MAX_STORE_BYTES + 1024 * 1024 });
  const out: StoreFile[] = [];
  let off = 0;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const name = field(h, 0, 100);
    const prefix = field(h, 345, 155);
    const rel = prefix ? `${prefix}/${name}` : name;
    const size = parseInt(field(h, 124, 12).trim() || "0", 8);
    const mode = parseInt(field(h, 100, 8).trim() || "0", 8);
    const type = String.fromCharCode(h[156] || 48);
    if (!Number.isFinite(size) || size < 0) throw new Error(`bad size for ${rel}`);
    off += 512;
    if (type === "5") {
      off += Math.ceil(size / 512) * 512;
      continue;
    }
    if (type !== "0") throw new Error(`archive entry ${rel} is not a regular file (type ${type})`);
    const clean = rel.replace(/\/+$/, "");
    if (!safeRelPath(clean)) throw new Error(`archive entry has an unsafe path: ${rel}`);
    if (off + size > tar.length) throw new Error(`archive truncated at ${rel}`);
    out.push({ path: clean, bytes: Buffer.from(tar.subarray(off, off + size)), executable: (mode & 0o111) !== 0 });
    if (out.length > MAX_STORE_FILES) throw new Error("archive has too many files");
    off += Math.ceil(size / 512) * 512;
  }
  return out;
}

/* ==========================================================================
 * The store
 * ========================================================================== */

export function hasStored(home: string, hash: string): boolean {
  try {
    return fs.statSync(storeDir(home, hash)).isDirectory();
  } catch {
    return false;
  }
}

/** The files of a stored version, or null when it is not in the store. A
 *  stored tree that no longer hashes to its name (edited in place, half
 *  deleted) is dropped and reads as absent, so the next pass refetches it. */
export function readStored(home: string, hash: string): StoreFile[] | null {
  if (!hasStored(home, hash)) return null;
  const files = readTree(storeDir(home, hash));
  if (folderHash(files) === hash) return files;
  fs.rmSync(storeDir(home, hash), { recursive: true, force: true });
  return null;
}

export type StoreResult =
  | { ok: true; files: StoreFile[]; fetched: boolean }
  | { ok: false; reason: "fetch_failed" | "bad_archive" | "hash_mismatch" | "lock_busy"; detail: string };

/**
 * Put the version named by `hash` in the store, fetching `url` only when it
 * is not there yet. Verification happens on the in-memory archive, so a
 * mismatch leaves nothing on disk; the lock covers only the final write.
 */
export async function fetchIntoStore(opts: {
  home: string;
  hash: string;
  url: string;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}): Promise<StoreResult> {
  const stored = readStored(opts.home, opts.hash);
  if (stored) return { ok: true, files: stored, fetched: false };

  let archive: Buffer;
  try {
    const res = await (opts.fetchImpl ?? fetch)(opts.url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return { ok: false, reason: "fetch_failed", detail: `HTTP ${res.status}` };
    archive = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    return { ok: false, reason: "fetch_failed", detail: String(err).slice(0, 200) };
  }
  return storeArchive(opts.home, opts.hash, archive, opts.log);
}

/** Verify an archive against its hash and write it into the store. */
export function storeArchive(home: string, hash: string, archive: Buffer, log?: (line: string) => void): StoreResult {
  let files: StoreFile[];
  try {
    files = unpackArchive(archive);
  } catch (err) {
    return { ok: false, reason: "bad_archive", detail: String(err).slice(0, 200) };
  }
  const actual = folderHash(files);
  if (actual !== hash) {
    return { ok: false, reason: "hash_mismatch", detail: `archive hashes to ${actual.slice(0, 12)}, expected ${hash.slice(0, 12)}` };
  }

  const root = storeRoot(home);
  const locked = withLock(root, () => {
    const final = storeDir(home, hash);
    if (fs.existsSync(final)) return;
    const tmp = fs.mkdtempSync(path.join(root, `.tmp-${hash.slice(0, 8)}-`));
    try {
      for (const f of files) {
        const abs = path.join(tmp, ...f.path.split("/"));
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, f.bytes, { mode: f.executable ? 0o755 : 0o644 });
      }
      fs.renameSync(tmp, final);
    } catch (err) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw err;
    }
  }, log);
  if (!locked.ok) return { ok: false, reason: "lock_busy", detail: `store locked by pid ${locked.heldBy?.pid ?? "?"}` };
  return { ok: true, files, fetched: true };
}
