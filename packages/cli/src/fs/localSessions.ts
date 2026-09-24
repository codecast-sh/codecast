/**
 * What this machine holds, per folder, before anything syncs: how many Claude
 * and Codex sessions ran there, when, and how many of them the sync scope lets
 * through. The Sync settings page reads it over the loopback server
 * (GET /fs/sessions) so a person can choose what to sync and share with the
 * numbers in view. It never leaves the machine: the list of folders that did
 * not sync is exactly what a cautious person does not want uploaded.
 *
 * Each session's working folder folds into its checkout root the way the
 * server keys rows (git_root, the common dir's parent), so a local row lines
 * up with the synced row for the same repository. The work is cheap: one
 * directory walk per agent, the first line of each transcript, and a few
 * `.git` reads per distinct folder, never a git subprocess.
 */

import * as fs from "fs";
import * as path from "path";
import { walkFiles } from "../fsWalk.js";
import { isPathExcluded, isProjectAllowedToSync, watchDirFilter } from "../syncScope.js";
import { extractCodexCwd } from "../parser.js";
import { repositoryKeyOfRemote } from "@codecast/shared/contracts";
import { checkoutRootOf } from "./checkoutOf.js";
import type { Config } from "../config/types.js";

export interface LocalFolder {
  /** The checkout root, or the folder itself when it is not in a repository. */
  path: string;
  /** owner/name of the checkout's origin, when it has one. */
  repository?: string;
  sessions: number;
  claude: number;
  codex: number;
  /** Sessions the current sync scope uploads. */
  synced: number;
  /** Oldest and newest last activity among its sessions. */
  first: number;
  last: number;
  /** Each session's last activity, newest first: what a share start keeps private. */
  times: number[];
  /** A git checkout, with or without an origin. */
  git: boolean;
  /** The folder is still on disk. */
  exists: boolean;
}

export interface LocalSessionsSummary {
  home: string;
  scanned_at: number;
  folders: LocalFolder[];
}

type Checkout = { root: string; repository?: string; exists: boolean; git: boolean };

/** The origin url in a checkout's `.git/config`, read without git. */
function originOf(gitDir: string): string | undefined {
  try {
    const text = fs.readFileSync(path.join(gitDir, "config"), "utf8");
    const block = text.split(/^\[/m).find((b) => /^remote "origin"\]/.test(b));
    return block?.match(/^\s*url\s*=\s*(.+)$/m)?.[1]?.trim();
  } catch {
    return undefined;
  }
}

/** The checkout a session's folder folds into, with its repository key. */
export function checkoutOf(folder: string, cache: Map<string, Checkout> = new Map()): Checkout {
  const hit = cache.get(folder);
  if (hit) return hit;
  const found = checkoutRootOf(folder);
  const exists = fs.existsSync(folder);
  const out: Checkout = found
    ? { root: found.root, ...(repositoryKeyOfRemote(originOf(found.gitDir)) ? { repository: repositoryKeyOfRemote(originOf(found.gitDir))! } : {}), exists, git: true }
    : { root: folder, exists, git: false };
  cache.set(folder, out);
  return out;
}

/** The first line of a Codex rollout, which carries session_meta and its cwd.
 *  That line can hold the whole base instructions, so read until its newline. */
async function codexCwd(file: string): Promise<string | null> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(file, "r");
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < 4 * 1024 * 1024; ) {
      const buf = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
      if (bytesRead <= 0) break;
      const got = buf.subarray(0, bytesRead);
      chunks.push(got);
      offset += bytesRead;
      if (got.includes(0x0a)) break;
    }
    return extractCodexCwd(Buffer.concat(chunks).toString("utf8").split("\n")[0] ?? "") ?? null;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

export async function summarizeLocalSessions(config: Config | null, home: string): Promise<LocalSessionsSummary> {
  const byFolder = new Map<string, LocalFolder>();
  const checkouts = new Map<string, Checkout>();
  const add = (cwd: string | null | undefined, agent: "claude" | "codex", mtime: number) => {
    if (!cwd) return;
    const checkout = checkoutOf(cwd, checkouts);
    const row = byFolder.get(checkout.root) ?? {
      path: checkout.root, repository: checkout.repository, sessions: 0, claude: 0, codex: 0, synced: 0,
      first: mtime, last: mtime, times: [] as number[], git: checkout.git, exists: checkout.exists,
    };
    row.times.push(mtime);
    row.sessions++;
    row[agent]++;
    if (!config || (isProjectAllowedToSync(cwd, config) && !isPathExcluded(cwd, config.excluded_paths))) row.synced++;
    row.first = Math.min(row.first, mtime);
    row.last = Math.max(row.last, mtime);
    row.exists = row.exists || checkout.exists;
    byFolder.set(checkout.root, row);
  };

  const claudeRoot = path.join(home, ".claude", "projects");
  if (fs.existsSync(claudeRoot)) {
    await walkFiles(
      claudeRoot,
      { observeCwd: true, policy: { dirs: "claudeWatch", files: "reconciliation" }, dirFilter: watchDirFilter, fileFilter: (rel) => { const name = path.basename(rel); return name.endsWith(".jsonl") && !name.startsWith("agent-"); } },
      (f) => add(f.cwd, "claude", f.stat.mtimeMs),
    );
  }

  const codexRoot = path.join(home, ".codex", "sessions");
  if (fs.existsSync(codexRoot)) {
    const files: { path: string; mtime: number }[] = [];
    await walkFiles(codexRoot, { policy: { files: "jsonl" }, excludeCodexAppServer: true }, (f) => files.push({ path: f.path, mtime: f.stat.mtimeMs }));
    for (let i = 0; i < files.length; i += 32) {
      const batch = files.slice(i, i + 32);
      const cwds = await Promise.all(batch.map((f) => codexCwd(f.path)));
      batch.forEach((f, j) => add(cwds[j], "codex", f.mtime));
    }
  }

  const folders = [...byFolder.values()].sort((a, b) => b.last - a.last);
  for (const f of folders) f.times.sort((a, b) => b - a);
  return { home, scanned_at: Date.now(), folders };
}
