/**
 * Grok's first-launch folder-trust store (`~/.grok/trusted_folders.toml`).
 *
 * A managed grok pane in a directory grok has never seen parks on
 * "Do you trust the contents of this directory?" and never writes a
 * transcript, so the daemon cannot bind the session (jx702ea, 2026-09-16).
 * Writing the cwd here before launch is the same grant a human `y` would
 * make, and is what skips the dialog.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { atomicWriteFile } from "./atomicWrite.js";

export function grokTrustedFoldersPath(grokHome?: string): string {
  return path.join(
    grokHome || process.env.GROK_HOME || path.join(os.homedir(), ".grok"),
    "trusted_folders.toml",
  );
}

export function normalizeGrokFolderPath(cwd: string): string {
  const resolved = path.resolve(cwd);
  if (resolved === "/") return resolved;
  return resolved.replace(/\/+$/, "");
}

const FOLDER_HEADER = /^\[folders\."([^"]+)"\]\s*$/;
const TRUSTED_LINE = /^\s*trusted\s*=\s*(true|false)\s*$/i;

export function grokFolderIsTrusted(toml: string, cwd: string): boolean {
  const folder = normalizeGrokFolderPath(cwd);
  let current: string | null = null;
  let trusted: boolean | null = null;
  let result: boolean | null = null;
  for (const raw of toml.split("\n")) {
    const header = raw.match(FOLDER_HEADER);
    if (header) {
      if (current === folder) result = trusted;
      current = header[1]!;
      trusted = null;
      continue;
    }
    const line = raw.match(TRUSTED_LINE);
    if (line && current) trusted = line[1]!.toLowerCase() === "true";
  }
  if (current === folder) result = trusted;
  return result === true;
}

export function upsertGrokTrustedFolder(
  toml: string,
  cwd: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): { text: string; changed: boolean } {
  const folder = normalizeGrokFolderPath(cwd);
  if (grokFolderIsTrusted(toml, folder)) return { text: toml, changed: false };
  const block = `[folders.${JSON.stringify(folder)}]\ntrusted = true\ndecided_at = ${nowSec}\n`;
  const trimmed = toml.replace(/[ \t]+$/gm, "").replace(/\s+$/, "");
  return { text: trimmed ? `${trimmed}\n\n${block}` : block, changed: true };
}

/** Returns true when the file was written. Failures are swallowed so a
 *  toml problem cannot block a grok launch — the pane classifier still
 *  answers the dialog if it appears. */
export function ensureGrokFolderTrusted(cwd: string, grokHome?: string): boolean {
  try {
    if (!cwd) return false;
    const file = grokTrustedFoldersPath(grokHome);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    let current = "";
    try {
      current = fs.readFileSync(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const { text, changed } = upsertGrokTrustedFolder(current, cwd);
    if (!changed) return false;
    atomicWriteFile(file, text);
    return true;
  } catch {
    return false;
  }
}
