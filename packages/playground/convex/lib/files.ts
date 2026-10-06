// The files of an app version: which paths are allowed, how they are served,
// which need transpiling, and the size rules a version must pass. The builder
// validates a draft with these before it commits, and the version writer
// enforces them again, so a bad version cannot exist.
import { MAX_FILE_BYTES, MAX_FILES_PER_VERSION, MAX_PATH_DEPTH, MAX_PATH_LENGTH, MAX_VERSION_BYTES } from "./limits";
import { sha256Hex } from "./identity";

export type FileDraft = { path: string; text: string };

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  jsx: "text/javascript; charset=utf-8",
  ts: "text/javascript; charset=utf-8",
  tsx: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
};

const TRANSPILED = new Set(["jsx", "ts", "tsx"]);

export const ENTRY_PATH = "index.html";

export function fileExtension(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot > path.lastIndexOf("/") ? path.slice(dot + 1).toLowerCase() : "";
}

/** The canonical form of a path an agent or person wrote ("./src/App.jsx" ->
 *  "src/App.jsx"), or null when it is not one a version may hold: absolute
 *  escapes, dot segments, hidden files, odd characters, unknown types. */
export function normalizeFilePath(raw: string): string | null {
  const path = raw.trim().replace(/^\.?\/+/, "");
  if (!path || path.length > MAX_PATH_LENGTH) return null;
  const segments = path.split("/");
  if (segments.length > MAX_PATH_DEPTH) return null;
  if (!segments.every((s) => /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(s) && !/^\.+$/.test(s))) return null;
  return fileExtension(path) in CONTENT_TYPES ? path : null;
}

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[fileExtension(path)] ?? "application/octet-stream";
}

/** Whether a file is served transpiled (JSX/TS to plain ES modules). */
export function needsTranspile(path: string): boolean {
  return TRANSPILED.has(fileExtension(path));
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

const kb = (n: number) => `${Math.ceil(n / 1000)} KB`;

/** Every reason this set of files cannot be a version, in words an agent can
 *  act on. Empty when it can. Paths must already be normalized. */
export function fileSetProblems(files: readonly FileDraft[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const f of files) {
    if (normalizeFilePath(f.path) !== f.path) problems.push(`"${f.path}" is not an allowed path`);
    if (seen.has(f.path)) problems.push(`"${f.path}" appears twice`);
    seen.add(f.path);
    const size = byteLength(f.text);
    total += size;
    if (size > MAX_FILE_BYTES) problems.push(`${f.path} is ${kb(size)}; a file may be at most ${kb(MAX_FILE_BYTES)}`);
  }
  if (!seen.has(ENTRY_PATH)) problems.push(`${ENTRY_PATH} is missing`);
  if (files.length > MAX_FILES_PER_VERSION) problems.push(`${files.length} files; a version may have at most ${MAX_FILES_PER_VERSION}`);
  if (total > MAX_VERSION_BYTES) problems.push(`the files total ${kb(total)}; a version may total at most ${kb(MAX_VERSION_BYTES)}`);
  return problems;
}

/** One hash for a whole file set, independent of order: equal hashes mean
 *  two versions serve identical files. */
export async function manifestHash(entries: readonly { path: string; hash: string }[]): Promise<string> {
  const lines = entries.map((e) => `${e.path}\0${e.hash}`).sort();
  return sha256Hex(lines.join("\n"));
}
