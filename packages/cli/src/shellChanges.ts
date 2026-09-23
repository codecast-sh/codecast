// The daemon's half of the Bash file-change capture (shellChangesHook.ts).
//
// The hook leaves ~/.codecast/shell-changes/<tool_use_id> holding the repository
// root and one "old<TAB>new<TAB>path" line per file the call changed, where old
// and new are git blob hashes ("0" for a side where the file did not exist).
// When the sync service uploads the message carrying that call's tool result,
// it reads the file here, resolves the blobs with `git cat-file --batch`, and
// sends the contents along as the message's file_changes so the server
// materializes them next to the Edit/Write changes it extracts on its own.
//
// The file is removed only after the upload lands (discardShellChanges): a
// retried batch reads it again, and a daemon that died in between finds it on
// the next pass. The hook sweeps anything older than a week.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SHELL_CHANGES_DIR_NAME } from "./shellChangesHook.js";

export type ShellChangeType = "write" | "edit" | "delete";

/** One file change on the wire, as messages:addMessage(s) accept it. */
export interface WireFileChange {
  tool_call_id: string;
  seq: number;
  file_path: string;
  change_type: ShellChangeType;
  old_content?: string;
  new_content: string;
}

/** Largest side of a change carried to the server; bigger files are skipped
 *  rather than truncated, because a truncated file makes a diff that lies. */
export const MAX_SHELL_CHANGE_CONTENT = 200_000;

export function shellChangesDir(home = os.homedir()): string {
  return path.join(home, ".codecast", SHELL_CHANGES_DIR_NAME);
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const BLOB_HASH = /^[0-9a-f]{40,64}$/;

interface ParsedSidecar {
  root: string;
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
  return { root: header[1], entries };
}

/** Blob contents by hash from one `git cat-file --batch` run. A hash git no
 *  longer holds (pruned) or a binary blob maps to undefined. */
export async function readBlobs(root: string, hashes: string[]): Promise<Map<string, string | undefined>> {
  const out = new Map<string, string | undefined>();
  const wanted = Array.from(new Set(hashes.filter((h) => h !== "0")));
  if (wanted.length === 0) return out;
  const raw = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn("git", ["-C", root, "cat-file", "--batch"], { stdio: ["pipe", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", () => resolve(Buffer.concat(chunks)));
    child.stdin.on("error", () => {});
    child.stdin.end(wanted.join("\n") + "\n");
  });
  let offset = 0;
  while (offset < raw.length) {
    const eol = raw.indexOf(0x0a, offset);
    if (eol === -1) break;
    const header = raw.subarray(offset, eol).toString("utf-8").split(" ");
    offset = eol + 1;
    const hash = header[0];
    if (header[1] !== "blob") {
      // "<hash> missing" (or a non-blob object): nothing follows.
      if (hash) out.set(hash, undefined);
      continue;
    }
    const size = Number(header[2]);
    const body = raw.subarray(offset, offset + size);
    offset += size + 1; // the trailing newline git appends after each object
    out.set(hash, body.includes(0) ? undefined : body.toString("utf-8"));
  }
  return out;
}

/**
 * The file changes recorded for one Bash call, ready for the wire, or null when
 * the hook recorded none (the ordinary case: most Bash calls read). Entries
 * whose content cannot be carried (binary, too large, blob gone) are dropped
 * one by one; the rest still ship.
 */
export async function readShellChanges(
  toolUseId: string,
  dir = shellChangesDir(),
): Promise<WireFileChange[] | null> {
  if (!SAFE_ID.test(toolUseId)) return null;
  const file = path.join(dir, toolUseId);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
  const parsed = parseShellChangesFile(text);
  if (!parsed || parsed.entries.length === 0) return null;
  const blobs = await readBlobs(parsed.root, parsed.entries.flatMap((e) => [e.old, e.next]));
  const changes: WireFileChange[] = [];
  for (const entry of parsed.entries) {
    const oldContent = entry.old === "0" ? undefined : blobs.get(entry.old);
    const newContent = entry.next === "0" ? "" : blobs.get(entry.next);
    if (entry.old !== "0" && oldContent === undefined) continue;
    if (newContent === undefined) continue;
    if ((oldContent?.length ?? 0) > MAX_SHELL_CHANGE_CONTENT || newContent.length > MAX_SHELL_CHANGE_CONTENT) continue;
    const change_type: ShellChangeType = entry.next === "0" ? "delete" : "write";
    changes.push({
      tool_call_id: toolUseId,
      seq: changes.length,
      file_path: path.join(parsed.root, entry.path),
      change_type,
      old_content: oldContent,
      new_content: newContent,
    });
  }
  return changes.length > 0 ? changes : null;
}

/** Forget recorded calls once their message has landed on the server. */
export function discardShellChanges(toolUseIds: Iterable<string>, dir = shellChangesDir()): void {
  for (const id of toolUseIds) {
    if (!SAFE_ID.test(id)) continue;
    try {
      fs.unlinkSync(path.join(dir, id));
    } catch {}
  }
}
