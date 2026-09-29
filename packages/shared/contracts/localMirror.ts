/**
 * A cloud session's working tree mirrored live into a worktree on one of the
 * owner's laptops (conversations.local_mirror). The laptop that runs the
 * mirror writes the state; the web renders it and asks for start and stop.
 * Pure data; no runtime imports.
 */

export const LOCAL_MIRROR_STATUSES = ["starting", "live", "paused", "conflict", "local_edit", "error", "stopping"] as const;
export type LocalMirrorStatus = (typeof LOCAL_MIRROR_STATUSES)[number];

/** two_way: edits travel both ways. from_cloud: the laptop copy only watches the cloud. */
export const LOCAL_MIRROR_MODES = ["two_way", "from_cloud"] as const;
export type LocalMirrorMode = (typeof LOCAL_MIRROR_MODES)[number];

/** Why a file stayed on its own machine (cloud/syncSide.ts names each in words). */
export const SYNC_SKIP_REASONS = ["rebuilt", "large", "total", "live", "repo", "special", "never"] as const;
export type SyncSkipReason = (typeof SYNC_SKIP_REASONS)[number];
export interface SyncSkipped { path: string; reason: SyncSkipReason; bytes?: number; side: "laptop" | "cloud" }

/** Each reason in words, the same in `cast sync status` and the app. */
export const SYNC_SKIP_WORDS: Record<SyncSkipReason, string> = {
  rebuilt: "rebuilt on each machine",
  large: "over the per-file limit",
  total: "over the total limit",
  live: "owned by a running process",
  repo: "a nested repository",
  special: "not a regular file",
  never: "a never-sync pattern",
};

/** "big.mov (300 MB): over the per-file limit". */
export function describeSyncSkipped(s: { path: string; reason: SyncSkipReason; bytes?: number }): string {
  const size = s.bytes ? ` (${s.bytes >= 1048576 ? `${Math.round(s.bytes / 1048576)} MB` : `${Math.round(s.bytes / 1024)} KB`})` : "";
  return `${s.path}${size}: ${SYNC_SKIP_WORDS[s.reason]}`;
}

/** A person's pick for files changed on both sides. */
export interface MirrorResolve { keep: "laptop" | "cloud"; paths?: string[] }

export interface LocalMirror {
  /** The laptop running the mirror. */
  device_id: string;
  status: LocalMirrorStatus;
  /** The mirror folder on that laptop. */
  path?: string;
  /** The host snapshot last landed there, and when. */
  last_sha?: string;
  last_landed_at?: number;
  mode?: LocalMirrorMode;
  /** Files the last landing changed, in all and each way. */
  changed?: number;
  to_laptop?: number;
  to_host?: number;
  /** local_edit: the files edited in the mirror since it last landed. */
  files?: string[];
  /** conflict: files changed on both sides, holding until a person picks one. */
  conflicts?: string[];
  /** What stayed on its own machine, and why (the first few of each side). */
  skipped?: SyncSkipped[];
  skipped_count?: number;
  error?: string;
  at: number;
}

export interface MirrorDevice {
  device_id: string;
  is_remote?: boolean;
  last_seen: number;
  local_project_roots?: string[];
}

/** The repository's name: the last path segment of a git remote url or of a checkout path. */
export function repoNameOf(remoteUrl?: string | null, path?: string | null): string | null {
  const fromUrl = remoteUrl?.replace(/\.git$/, "").split(/[/:]/).filter(Boolean).pop();
  if (fromUrl) return fromUrl;
  // A cloud worktree path: ~/work/<repo>/.codecast/worktrees/<name>, or the host checkout ~/work/<repo>.
  const m = path?.match(/\/work\/([^/]+)(?:\/|$)/);
  return m?.[1] ?? path?.split("/").filter(Boolean).pop() ?? null;
}

/**
 * The laptops that can mirror a session, best first, each with its checkout
 * of the repo: online before offline, the laptop that seeded the session
 * first among equals, then the most recently seen. A laptop qualifies when
 * one of its project roots is a checkout of the same repository (by name).
 * The server's choice and the web's menu label both come from here.
 */
export function mirrorLaptops(
  devices: readonly MirrorDevice[],
  conv: { git_remote_url?: string | null; project_path?: string | null; cloud_seed?: { device_id?: string | null; laptop_root?: string | null } | null },
  now: number,
  onlineMs: number,
): Array<{ device_id: string; root: string; online: boolean }> {
  const name = repoNameOf(conv.git_remote_url, conv.project_path);
  if (!name) return [];
  const out: Array<{ device_id: string; root: string; online: boolean; seen: number; seeded: boolean }> = [];
  for (const d of devices) {
    if (d.is_remote) continue;
    const seeded = !!conv.cloud_seed?.device_id && conv.cloud_seed.device_id === d.device_id;
    const root = (seeded && conv.cloud_seed?.laptop_root && (d.local_project_roots ?? []).includes(conv.cloud_seed.laptop_root))
      ? conv.cloud_seed.laptop_root
      : (d.local_project_roots ?? []).filter((r) => r.split("/").filter(Boolean).pop() === name && !r.includes("/.codecast/")).sort((a, b) => a.length - b.length)[0];
    if (!root) continue;
    out.push({ device_id: d.device_id, root, online: now - d.last_seen < onlineMs, seen: d.last_seen, seeded });
  }
  out.sort((a, b) => Number(b.online) - Number(a.online) || Number(b.seeded) - Number(a.seeded) || b.seen - a.seen);
  return out.map(({ device_id, root, online }) => ({ device_id, root, online }));
}
