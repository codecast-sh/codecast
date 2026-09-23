import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SHELL_CHANGES_DIR_NAME, MAX_SHELL_CHANGE_CONTENT } from "./shellChangesHook.js";

export type ShellChangeType = "write" | "edit" | "delete";

export interface WireFileChange {
  tool_call_id: string;
  seq: number;
  file_path: string;
  change_type: ShellChangeType;
  old_content?: string;
  new_content: string;
}

export { MAX_SHELL_CHANGE_CONTENT };

// $HOME first: it is the home the hook script wrote under, and Bun's
// os.homedir() is fixed at process start.
export function shellChangesDir(home = process.env.HOME || os.homedir()): string {
  return path.join(home, ".codecast", SHELL_CHANGES_DIR_NAME);
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const BLOB_HASH = /^[0-9a-f]{40,64}$/;

interface ParsedSidecar {
  root: string;
  version: number;
  entries: Array<{ old: string; next: string; path: string }>;
}

export function parseShellChangesFile(text: string): ParsedSidecar | null {
  const lines = text.split("\n").filter((line) => line.length > 0);
  const header = lines.shift()?.split("\t");
  if (!header || header[0] !== "root" || !header[1]) return null;
  const entries: ParsedSidecar["entries"] = [];
  for (const line of lines) {
    const [old, next, ...rest] = line.split("\t");
    const filePath = rest.join("\t");
    if (!old || !next || !filePath) continue;
    if ((old !== "0" && !BLOB_HASH.test(old)) || (next !== "0" && !BLOB_HASH.test(next))) continue;
    if (old === next) continue;
    entries.push({ old, next, path: filePath });
  }
  // The hook writes paths in hash-table order; sort so seq is by path.
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { root: header[1], version: Number(header[2] ?? 1), entries };
}

export const SHELL_CHANGE_BATCH_BYTES = 800_000;
export const SHELL_CHANGE_BATCH_FILES = 8;

async function gitBatch(root: string, args: string[], hashes: string[], maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", root, "cat-file", ...args], { stdio: ["pipe", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Shell diff git read timed out"));
    }, 5_000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        child.kill("SIGKILL");
        reject(new Error("Shell diff git read exceeded byte budget"));
      } else chunks.push(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Shell diff git read exited ${code}`));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.on("error", reject);
    child.stdin.end(hashes.join("\n") + "\n");
  });
}

export async function readBlobs(root: string, hashes: string[]): Promise<Map<string, string | undefined>> {
  const out = new Map<string, string | undefined>();
  const wanted = Array.from(new Set(hashes.filter((h) => h !== "0")));
  if (wanted.length === 0) return out;
  const sizes = await gitBatch(root, ["--batch-check"], wanted, 64_000);
  const small = sizes.toString("utf8").trim().split("\n").flatMap((line) => {
    const [hash, type, size] = line.split(" ");
    return type === "blob" && Number(size) <= MAX_SHELL_CHANGE_CONTENT ? [hash] : [];
  });
  if (!small.length) return out;
  const raw = await gitBatch(root, ["--batch"], small, small.length * (MAX_SHELL_CHANGE_CONTENT + 128));
  let offset = 0;
  while (offset < raw.length) {
    const eol = raw.indexOf(0x0a, offset);
    if (eol === -1) break;
    const header = raw.subarray(offset, eol).toString("utf-8").split(" ");
    offset = eol + 1;
    if (header[1] !== "blob") continue;
    const size = Number(header[2]);
    const body = raw.subarray(offset, offset + size);
    offset += size + 1;
    out.set(header[0], body.includes(0) ? undefined : body.toString("utf-8"));
  }
  return out;
}

export async function readShellChangeBatch(toolUseId: string, offset = 0, dir = shellChangesDir()): Promise<{
  changes: WireFileChange[]; next: number; done: boolean; quarantined?: boolean;
}> {
  const empty = { changes: [], next: offset, done: true };
  if (!SAFE_ID.test(toolUseId)) return empty;
  const file = path.join(dir, toolUseId);
  const text = await fs.promises.readFile(file, "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!text) return empty;
  const parsed = parseShellChangesFile(text);
  if (!parsed) return empty;
  if (parsed.version < 2 && parsed.entries.length > 100) {
    await fs.promises.mkdir(path.join(dir, "quarantine"), { recursive: true });
    await fs.promises.rename(file, path.join(dir, "quarantine", toolUseId));
    return { ...empty, quarantined: true };
  }
  const entries = parsed.entries.slice(offset, offset + SHELL_CHANGE_BATCH_FILES);
  const blobs = await readBlobs(parsed.root, entries.flatMap((e) => [e.old, e.next]));
  const changes: WireFileChange[] = [];
  let bytes = 2;
  let next = offset;
  for (const entry of entries) {
    const oldContent = entry.old === "0" ? undefined : blobs.get(entry.old);
    const newContent = entry.next === "0" ? "" : blobs.get(entry.next);
    if ((entry.old !== "0" && oldContent === undefined) || newContent === undefined) { next++; continue; }
    const change: WireFileChange = {
      tool_call_id: toolUseId, seq: next, file_path: path.join(parsed.root, entry.path),
      change_type: entry.next === "0" ? "delete" : "write", old_content: oldContent, new_content: newContent,
    };
    const size = Buffer.byteLength(JSON.stringify(change)) + 1;
    if (size > SHELL_CHANGE_BATCH_BYTES) throw new Error(`Shell diff file exceeds wire budget: ${entry.path}`);
    if (bytes + size > SHELL_CHANGE_BATCH_BYTES) break;
    changes.push(change);
    bytes += size;
    next++;
  }
  return { changes, next, done: next >= parsed.entries.length };
}

export async function readShellChanges(toolUseId: string, dir = shellChangesDir()): Promise<WireFileChange[] | null> {
  const changes: WireFileChange[] = [];
  let offset = 0;
  for (;;) {
    const batch = await readShellChangeBatch(toolUseId, offset, dir);
    changes.push(...batch.changes);
    if (batch.done) return changes.length ? changes : null;
    offset = batch.next;
  }
}

export function discardShellChanges(toolUseIds: Iterable<string>, dir = shellChangesDir()): void {
  for (const id of toolUseIds) {
    if (!SAFE_ID.test(id)) continue;
    try {
      fs.unlinkSync(path.join(dir, id));
    } catch {}
  }
}
