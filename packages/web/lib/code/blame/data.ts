// Where blame comes from and whether it can come at all. One fetch per file
// version: the key is the vault, the path, the etag disk last served (which
// moves with mtime) and HEAD, so a save, an outside write or a commit asks
// again and everything else reads the cache. No CodeMirror here.

import type { CodeBlameResponse } from "@codecast/shared/contracts";
import { requestEndpointOf, useVaultStore } from "../../../store/vaultStore";
import { fetchBlame } from "../daemonClient";
import { gitStatusOf, type VaultGitStatus } from "../git/status";

export const NOT_CONNECTED = "Files are not connected";

export type BlameAvailability = { ok: true } | { ok: false; reason: string } | { ok: "pending" };

/** Whether this file can be blamed now, and why not in a few words. */
export function blameAvailability(vaultId: string, status: VaultGitStatus | undefined = gitStatusOf(vaultId)): BlameAvailability {
  const vault = useVaultStore.getState();
  if (!vault.endpoint) return { ok: false, reason: NOT_CONNECTED };
  if (vault.isRemote) return { ok: false, reason: "Blame reads git on the machine that holds the files" };
  if (vault.activeVaultId !== vaultId) return { ok: false, reason: "Not the open folder" };
  if (!status) return { ok: "pending" };
  if (!status.repo) return { ok: false, reason: "Not a git repository" };
  return { ok: true };
}

/** Why a fetch failed, in the words the toggle shows, and whether asking
 *  again later can help (a timeout, the daemon away) or not (not a repo). */
export function blameFailure(e: unknown): { reason: string; transient: boolean } {
  const reason = blameErrorReason(e);
  return { reason, transient: TRANSIENT_REASONS.has(reason) };
}

const TRANSIENT_REASONS = new Set([NOT_CONNECTED, "Blame timed out", "Blame unavailable"]);

export function blameErrorReason(e: unknown): string {
  const status = (e as { status?: number })?.status;
  const message = e instanceof Error ? e.message : String(e);
  if (status === 413 || /too large/i.test(message)) return "File too large to blame";
  if (/not a repo/i.test(message)) return "Not a git repository";
  if (status === 404) return "Not in git";
  if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) return "Blame timed out";
  if (status === undefined) return NOT_CONNECTED;
  return "Blame unavailable";
}

const CACHE_MAX = 64;
/** The daemon keeps an answer that may still gain sessions (uncommitted
 *  lines, or no session resolved yet) for 30s; so does this cache. */
const PROVISIONAL_MS = 30_000;
const cache = new Map<string, Promise<CodeBlameResponse>>();

export function blameKey(vaultId: string, path: string, etag: string, head: string | null): string {
  return `${vaultId}\u0000${path}\u0000${etag}\u0000${head ?? ""}`;
}

/** Whether an answer may still change for the same file version. */
export function isProvisional(res: CodeBlameResponse): boolean {
  return res.hunks.some((h) => h.uncommitted) || !res.hunks.some((h) => h.session);
}

/** The blame for a key, fetched once. A failure is never remembered: the
 *  daemon may come back, the file may be committed. A provisional answer is
 *  kept for PROVISIONAL_MS, so a later open asks again. */
export function loadBlame(key: string, vaultId: string, path: string): Promise<CodeBlameResponse> {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const endpoint = requestEndpointOf(useVaultStore.getState());
  const p = endpoint ? fetchBlame(endpoint, vaultId, path) : Promise.reject(new Error("files not connected"));
  p.then(
    (res) => {
      if (isProvisional(res)) setTimeout(() => cache.get(key) === p && cache.delete(key), PROVISIONAL_MS);
    },
    () => {
      if (cache.get(key) === p) cache.delete(key);
    },
  );
  cache.set(key, p);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return p;
}

/** Ask again for a key: the daemon holds uncommitted attribution only
 *  briefly, so a refetch after a save must not read the old answer here. */
export function forgetBlame(key: string): void {
  cache.delete(key);
}

/** Tests only. */
export function _clearBlameCache(): void {
  cache.clear();
}
