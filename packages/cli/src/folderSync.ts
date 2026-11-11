/**
 * Carrying a session's folder from another of the owner's machines.
 *
 * A session moved to this machine resumes in the folder it recorded. When that
 * folder exists only on the machine it came from and has no git remote to
 * clone, every resume used to refuse with "no checkout here", and the only way
 * forward was to copy the folder by hand. Now the destination asks the owner's
 * other online machines for it: the one that holds the folder packs it
 * (export_folder), puts the archive in Convex storage, and the destination
 * unpacks it at the same place and resumes there.
 *
 * What travels. In a git checkout, exactly what git would carry plus .git
 * itself: tracked and untracked files minus .gitignore'd ones, so a gitignored
 * .env stays behind the same way it does for wipSnapshot. Outside git, every
 * file except regenerable caches (node_modules, virtualenvs, build caches) and
 * .env files. A folder past MAX_FOLDER_BYTES is refused before anything is
 * packed: storage is a relay for a working folder, not a backup channel.
 */

import { execFile } from "./proc.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);

export const MAX_FOLDER_BYTES = 300 * 1024 * 1024;
export const FOLDER_BUNDLE_MEDIA_TYPE = "application/gzip";
export const SKIPPED_DIRS: ReadonlySet<string> = new Set([
  "node_modules", ".venv", "venv", "__pycache__", ".next", ".turbo", ".cache", ".pytest_cache", ".mypy_cache",
]);

const SECRET_NAMES = /^(\.env(\..*)?|\.netrc|\.npmrc|\.pypirc|\.pgpass|id_[a-z0-9_]+(\.pub)?|credentials.*|.*\.(pem|key|p12|pfx|keystore|jks))$/i;

/** Files that look like keys or credentials never travel, whatever the folder's .gitignore says. */
export function isSecretFile(name: string): boolean {
  return SECRET_NAMES.test(name);
}

/**
 * Where a session folder may be carried from or to: inside home, not in a
 * dot-folder at the top of home (~/.ssh, ~/.aws, ~/.config...), not under
 * ~/Library, and never home itself. Null when allowed, else the reason.
 */
export function refusedFolder(dir: string, home: string): string | null {
  const abs = path.resolve(dir);
  const h = path.resolve(home);
  if (!home || abs === h || abs === "/") return `${dir} is a home or root folder`;
  const rel = path.relative(h, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return `${dir} is outside your home folder`;
  const top = rel.split(path.sep)[0];
  if (top.startsWith(".") || top === "Library") return `${dir} is a private folder`;
  return null;
}

/** The recorded path as it would sit on this machine: another user's home
 *  prefix (/Users/m1, /home/m1) becomes this one's. */
export function localFolderFor(recorded: string, home: string): string {
  const m = recorded.match(/^\/(?:Users|home)\/[^/]+(\/.*)?$/);
  if (!m || !home) return recorded;
  return m[1] ? path.join(home, m[1]) : home;
}

export type FolderPlan =
  | { ok: true; dir: string; entries: string[]; bytes: number; files: number }
  | { ok: false; reason: string; missing?: boolean };

async function gitOut(dir: string, args: string[]): Promise<string> {
  const out: unknown = await execFileAsync("git", ["-C", dir, ...args], { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });
  return typeof out === "string" ? out : String((out as { stdout: string }).stdout);
}

async function gitFiles(dir: string): Promise<string[] | null> {
  try {
    const top = await gitOut(dir, ["rev-parse", "--show-toplevel"]);
    if (fs.realpathSync(top.trim()) !== fs.realpathSync(dir)) return null;
    const split = (out: string) => out.split("\0").filter(Boolean);
    const tracked = split(await gitOut(dir, ["ls-files", "-c", "-z"]));
    const untracked = split(await gitOut(dir, ["ls-files", "-o", "--exclude-standard", "-z"]))
      .filter((rel) => !isSecretFile(path.basename(rel)));
    return [...new Set([...tracked, ...untracked])];
  } catch {
    return null;
  }
}

async function walk(root: string, rel: string, out: { entries: string[]; bytes: number }, cap: number): Promise<boolean> {
  const here = path.join(root, rel);
  let items: fs.Dirent[];
  try {
    items = await fs.promises.readdir(here, { withFileTypes: true });
  } catch {
    return true;
  }
  for (const item of items) {
    const childRel = rel ? path.join(rel, item.name) : item.name;
    if (item.isDirectory()) {
      if (SKIPPED_DIRS.has(item.name)) continue;
      if (!(await walk(root, childRel, out, cap))) return false;
      continue;
    }
    if (isSecretFile(item.name) || item.name === ".DS_Store") continue;
    if (!item.isFile() && !item.isSymbolicLink()) continue;
    const st = await fs.promises.lstat(path.join(root, childRel)).catch(() => null);
    if (!st) continue;
    out.bytes += st.size;
    out.entries.push(childRel);
    if (out.bytes > cap) return false;
  }
  return true;
}

async function dirBytes(dir: string, cap: number): Promise<number> {
  const out = { entries: [] as string[], bytes: 0 };
  await walk(dir, "", out, cap);
  return out.bytes;
}

/** Decide what to pack, or why not. Never reads past the cap. */
export async function planFolderExport(dir: string, cap = MAX_FOLDER_BYTES): Promise<FolderPlan> {
  const st = await fs.promises.stat(dir).catch(() => null);
  if (!st?.isDirectory()) return { ok: false, missing: true, reason: `${dir} is not on this machine` };
  const tracked = await gitFiles(dir);
  const tooBig = { ok: false as const, reason: `${dir} is over ${Math.round(cap / (1024 * 1024))} MB, too large to carry` };
  if (tracked) {
    let bytes = await dirBytes(path.join(dir, ".git"), cap);
    const entries: string[] = [".git"];
    for (const rel of tracked) {
      const fst = await fs.promises.lstat(path.join(dir, rel)).catch(() => null);
      if (!fst || fst.isDirectory()) continue;
      bytes += fst.size;
      entries.push(rel);
      if (bytes > cap) return tooBig;
    }
    if (bytes > cap) return tooBig;
    return { ok: true, dir, entries, bytes, files: entries.length - 1 };
  }
  const out = { entries: [] as string[], bytes: 0 };
  if (!(await walk(dir, "", out, cap))) return tooBig;
  return { ok: true, dir, entries: out.entries, bytes: out.bytes, files: out.entries.length };
}

/** Pack a plan into a gzipped tar held in memory. */
export async function packFolder(plan: Extract<FolderPlan, { ok: true }>): Promise<Uint8Array> {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codecast-folder-"));
  try {
    const list = path.join(tmp, "files");
    const out = path.join(tmp, "bundle.tgz");
    await fs.promises.writeFile(list, plan.entries.join("\0") + "\0");
    await execFileAsync("tar", ["-czf", out, "-C", plan.dir, "--null", "-T", list], { maxBuffer: 16 * 1024 * 1024 });
    return new Uint8Array(await fs.promises.readFile(out));
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/** Unpack an archive into `dest`, which must not exist yet. Extracts beside it
 *  and renames into place, so a failed unpack never leaves a half folder that
 *  the next resume would take for the real one. */
export async function unpackFolder(bytes: Uint8Array, dest: string): Promise<void> {
  const parent = path.dirname(dest);
  await fs.promises.mkdir(parent, { recursive: true });
  const staging = path.join(parent, `.${path.basename(dest)}.codecast-sync-${randomUUID().slice(0, 8)}`);
  const archive = `${staging}.tgz`;
  await fs.promises.mkdir(staging);
  try {
    await fs.promises.writeFile(archive, bytes);
    await execFileAsync("tar", ["-xzf", archive, "-C", staging], { maxBuffer: 16 * 1024 * 1024 });
    if (fs.existsSync(dest)) return;
    await fs.promises.rename(staging, dest);
  } finally {
    await fs.promises.rm(archive, { force: true }).catch(() => {});
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

export type ExportFolderResult =
  | { ok: true; storage_id: string; bytes: number; files: number; path: string }
  | { ok: false; missing?: boolean; reason: string };

/** The source side of export_folder: find the folder here, pack it, upload it. */
export async function exportFolder(
  args: { path?: unknown },
  deps: { home: string; upload: (bytes: Uint8Array) => Promise<string | null>; log?: (m: string) => void },
): Promise<ExportFolderResult> {
  const recorded = typeof args.path === "string" && path.isAbsolute(args.path) ? args.path : null;
  if (!recorded) return { ok: false, reason: "export_folder: missing or relative path" };
  const dir = [recorded, localFolderFor(recorded, deps.home)].find((p) => fs.existsSync(p)) ?? recorded;
  const refused = refusedFolder(dir, deps.home);
  if (refused) return { ok: false, reason: `${refused}; refusing to carry it` };
  const plan = await planFolderExport(dir);
  if (!plan.ok) return { ok: false, missing: plan.missing, reason: plan.reason };
  const bytes = await packFolder(plan);
  deps.log?.(`[FOLDER] packed ${dir}: ${plan.files} files, ${plan.bytes} bytes -> ${bytes.length} bytes`);
  const storageId = await deps.upload(bytes);
  if (!storageId) return { ok: false, reason: `upload of ${dir} failed` };
  return { ok: true, storage_id: storageId, bytes: bytes.length, files: plan.files, path: dir };
}

export interface PeerRequest {
  command_ids: string[];
  labels: Record<string, string>;
}

export interface PeerOutcome {
  command_id: string;
  executed_at: number | null;
  result: string | null;
  error: string | null;
  label: string | null;
}

export interface SyncFromPeerDeps {
  request: () => Promise<PeerRequest>;
  outcomes: (ids: string[]) => Promise<PeerOutcome[]>;
  download: (storageId: string) => Promise<Uint8Array | null>;
  discard: (commandId: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (m: string) => void;
}

export type SyncFromPeerResult =
  | { ok: true; path: string; from: string; files: number }
  | { ok: false; reason: string };

export const PEER_WAIT_MS = 120_000;
const POLL_MS = 1_500;

/** The destination side: ask every other online machine, take the first that
 *  has the folder, unpack it at `dest`. */
export async function syncFolderFromPeer(dest: string, deps: SyncFromPeerDeps, waitMs = PEER_WAIT_MS): Promise<SyncFromPeerResult> {
  let ids: string[] = [];
  try {
    return await askPeers(dest, deps, waitMs, (asked) => { ids = asked; });
  } finally {
    for (const id of ids) await deps.discard(id).catch(() => {});
  }
}

async function askPeers(dest: string, deps: SyncFromPeerDeps, waitMs: number, onAsked: (ids: string[]) => void): Promise<SyncFromPeerResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  let asked: PeerRequest;
  try {
    asked = await deps.request();
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  onAsked(asked.command_ids);
  if (asked.command_ids.length === 0) return { ok: false, reason: "none of your other machines is online to send it" };
  const deadline = now() + waitMs;
  const reasons = new Map<string, string>();
  while (now() < deadline) {
    const rows = await deps.outcomes(asked.command_ids).catch(() => [] as PeerOutcome[]);
    for (const row of rows) {
      if (!row.executed_at || reasons.has(row.command_id)) continue;
      const label = row.label ?? asked.labels[row.command_id] ?? "another machine";
      let parsed: ExportFolderResult | null = null;
      try { parsed = row.result ? JSON.parse(row.result) : null; } catch {}
      if (parsed?.ok) {
        try {
          const bytes = await deps.download(parsed.storage_id);
          if (!bytes) { reasons.set(row.command_id, `${label}: download failed`); continue; }
          await unpackFolder(bytes, dest);
          deps.log?.(`[FOLDER] synced ${dest} from ${label}: ${parsed.files} files`);
          return { ok: true, path: dest, from: label, files: parsed.files };
        } catch (e) {
          reasons.set(row.command_id, `${label}: ${e instanceof Error ? e.message : String(e)}`);
        }
        continue;
      }
      const why = parsed && !parsed.ok ? parsed : null;
      reasons.set(row.command_id, why?.missing ? "" : `${label}: ${why?.reason ?? row.error ?? "no answer"}`);
    }
    if (reasons.size === asked.command_ids.length) break;
    await sleep(POLL_MS);
  }
  const said = [...reasons.values()].filter(Boolean);
  if (said.length) return { ok: false, reason: said.join("; ") };
  if (reasons.size === asked.command_ids.length) return { ok: false, reason: "none of your other machines has it" };
  return { ok: false, reason: `no answer from ${Object.values(asked.labels).join(", ")} in ${Math.round(waitMs / 1000)}s` };
}
