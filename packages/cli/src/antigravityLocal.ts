/**
 * The daemon's local reads and writes of Antigravity CLI (`agy`) state, beside
 * the pure path helpers in antigravityPaths.ts.
 *
 * Folder trust. A managed agy pane in a folder agy has not seen parks on "Do
 * you trust the contents of this project?" before it writes any transcript, so
 * the daemon could not bind the session. agy records the answer in its
 * settings.json as `trustedWorkspaces`, an array of exact paths (a parent in the
 * list does not cover a child: ~/scratch was asked about with ~ trusted;
 * agy 1.5.14). Adding the cwd there before launch is the grant a person's
 * "Yes, I trust this folder" makes, and is what skips the dialog. The pane
 * classifier still answers the dialog if it appears anyway.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Database } from "bun:sqlite";
import { atomicWriteFile } from "./atomicWrite.js";
import { antigravityCwdFromWorkspaceUris, antigravityDataDirFromTranscript } from "./antigravityPaths.js";

export function antigravityDataDir(home: string = os.homedir()): string {
  return path.join(home, ".gemini", "antigravity-cli");
}

function normalizeFolder(cwd: string): string {
  const resolved = path.resolve(cwd);
  return resolved === "/" ? resolved : resolved.replace(/\/+$/, "");
}

/** The settings text with `cwd` added to trustedWorkspaces, or null when it is
 *  already there or the text is not a JSON object (never rewrite what we cannot
 *  read: agy owns the file). */
export function upsertAntigravityTrustedWorkspace(settingsText: string, cwd: string): string | null {
  const folder = normalizeFolder(cwd);
  let settings: Record<string, unknown>;
  if (!settingsText.trim()) settings = {};
  else {
    try {
      const parsed = JSON.parse(settingsText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      settings = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  const current = settings.trustedWorkspaces;
  if (current !== undefined && !Array.isArray(current)) return null;
  const list = (current ?? []) as unknown[];
  if (list.some((entry) => typeof entry === "string" && normalizeFolder(entry) === folder)) return null;
  return `${JSON.stringify({ ...settings, trustedWorkspaces: [...list, folder] }, null, 2)}\n`;
}

/** Returns true when settings.json was written. Failures are swallowed so a
 *  settings problem cannot block a launch. */
export function ensureAntigravityFolderTrusted(cwd: string, home?: string): boolean {
  try {
    if (!cwd) return false;
    const file = path.join(antigravityDataDir(home), "settings.json");
    let current = "";
    try {
      current = fs.readFileSync(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const next = upsertAntigravityTrustedWorkspace(current, cwd);
    if (next === null) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    atomicWriteFile(file, next);
    return true;
  } catch {
    return false;
  }
}

function workspaceRow(file: string, sessionId: string, writable: boolean): unknown {
  const db = new Database(file, writable ? {} : { readonly: true });
  try {
    const row = db
      .query("SELECT workspace_uris FROM conversation_summaries WHERE conversation_id = ?")
      .get(sessionId) as { workspace_uris?: unknown } | null;
    return row?.workspace_uris;
  } finally {
    db.close();
  }
}

/** The working directory agy recorded for the conversation a transcript
 *  belongs to (conversation_summaries.db, workspace_uris), or undefined.
 *  While an agy runs its WAL database has no -shm file and refuses read-only
 *  opens, so the read falls back to a writable copy, as
 *  readAntigravitySummary does in the ingest worker. */
export function antigravitySessionCwd(transcriptPath: string, sessionId: string): string | undefined {
  const dataDir = antigravityDataDirFromTranscript(transcriptPath);
  if (!dataDir) return undefined;
  const file = path.join(dataDir, "conversation_summaries.db");
  if (!fs.existsSync(file)) return undefined;
  try {
    return antigravityCwdFromWorkspaceUris(workspaceRow(file, sessionId, false));
  } catch {}
  let dir: string | undefined;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-summaries-"));
    const copy = path.join(dir, "conversation_summaries.db");
    fs.copyFileSync(file, copy);
    if (fs.existsSync(`${file}-wal`)) fs.copyFileSync(`${file}-wal`, `${copy}-wal`);
    return antigravityCwdFromWorkspaceUris(workspaceRow(copy, sessionId, true));
  } catch {
    return undefined;
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}
