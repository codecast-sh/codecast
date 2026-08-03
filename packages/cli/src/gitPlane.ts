/**
 * Git-plane health: keep every repo with live sessions anchored to a REAL origin,
 * continuously, on every machine.
 *
 * The failure class this kills (measured on m1, 2026-08-02): a machine whose
 * repo was bootstrapped from a transport artifact — a git bundle under /tmp —
 * keeps that artifact as `origin` forever. The file dies, and from then on the
 * machine lives in a frozen fiction: origin/main is weeks stale, `git status`
 * reports hundreds of phantom "ahead" commits, ancestry-gated deploys reason
 * against dead history, and the wip-snapshot loop reads the dead path as a
 * permanent push failure and silently retires work sync for every session in
 * the repo. Nothing alerts, because nothing was watching the git plane itself.
 *
 * Three duties per repo, in one bounded sweep:
 *
 *   1. REPAIR — an origin that is a local path or file:// URL is a transport
 *      leftover, never a rendezvous. When any of the repo's conversations
 *      knows the real remote URL (the server records it at session start),
 *      point origin there. Idempotent; logged; reported upstream so retired
 *      wip pushes resurrect.
 *   2. FRESHNESS — fetch origin on a cadence, so origin/<branch> is a fact
 *      about the world rather than about the last time someone ran fetch.
 *      Recovery from a failing fetch is reported upstream (same resurrect).
 *   3. MEASURE — ahead/behind vs upstream, published with the device
 *      heartbeat so drift is visible in the UI instead of discovered during
 *      an incident.
 *
 * Everything is best-effort and async: this runs inside the daemon's flush
 * loop, where a blocking git call once froze the daemon past the watchdog's
 * stale-heartbeat threshold (see wipSnapshot.ts).
 */

import { execFile } from "./proc.js";
import { promisify } from "node:util";
import {
  deviceKeyEnv,
  gitEnvFor,
  identityFor,
  isGitAuthError,
  isSshRemote,
  recordIdentity,
} from "./gitIdentity.js";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 30_000;
/** Fetch each repo at most this often — freshness, not load. */
const FETCH_INTERVAL_MS = 10 * 60_000;
/** Concurrent repos per sweep; fetches are network-bound and gentle. */
const SWEEP_CONCURRENCY = 3;
/** Heartbeat payload cap — a device with more repos reports the busiest ones. */
export const GIT_PLANE_REPORT_CAP = 20;

/** One repo's git-plane state, as published with the device heartbeat. */
export interface RepoPlaneState {
  root: string;
  origin?: string;
  /** False when origin is missing or is a local-path/file:// transport leftover. */
  origin_ok: boolean;
  /** Whether the last fetch within the cadence window succeeded; absent = not yet tried. */
  fetch_ok?: boolean;
  ahead?: number;
  behind?: number;
  branch?: string;
  fetched_at?: number;
  /** Previous origin value when this sweep rewrote it. */
  repaired_from?: string;
  /** True when fetch fails with an AUTH error even after trying the device
   * key: the machine needs to be granted access to the remote. The web
   * devices page turns this into a guided grant card. */
  needs_access?: boolean;
  /** "device" when the per-device fallback key is the identity that works
   * for this repo (gitIdentity.ts); absent = the user's own credentials. */
  identity?: "device";
  error?: string;
}

export interface GitPlaneRepo {
  root: string;
  /** Conversations running in this repo — the repair source and resurrect scope. */
  conversationIds: string[];
}

export interface GitPlaneDeps {
  /** Server-recorded remote URL for a conversation (conversations.git_remote_url). */
  resolveCanonical: (conversationId: string) => Promise<string | undefined>;
  /** Origin was repaired, or a failing fetch recovered: the repo's remote is
   * usable again, so retired per-conversation push state should be dropped. */
  onRemoteUsable: (root: string, conversationIds: string[]) => void;
  /** Mint (or return) the device's fallback git key when a fetch hits an auth
   * wall (gitIdentity.ensureDeviceGitKey bound to the device label). Absent =
   * no fallback identity; auth failures surface as needs_access directly. */
  mintDeviceKey?: () => Promise<string | undefined>;
  log: (line: string) => void;
}

/** A URL usable as a rendezvous: reachable from other machines, not a file on this one. */
export function isRendezvousUrl(url: string | undefined): url is string {
  if (!url) return false;
  return !url.startsWith("/") && !url.startsWith("file://") && !url.startsWith(".");
}

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    ...(env ? { env } : {}),
  });
  return stdout.trim();
}

async function gitTry(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    return await git(cwd, args);
  } catch {
    return undefined;
  }
}

function stderrOf(e: unknown): string {
  const err = e as { stderr?: string | Buffer; message?: string };
  return (err.stderr?.toString() || err.message || String(e)).slice(0, 300);
}

/** cwd -> repo toplevel (or null for non-repos). Session cwds are stable, so
 * one git call per cwd for the daemon's lifetime. */
const repoRootCache = new Map<string, string | null>();

/** The repo toplevel containing `cwd`, or null when it isn't inside a git repo. */
export async function repoRootFor(cwd: string): Promise<string | null> {
  const cached = repoRootCache.get(cwd);
  if (cached !== undefined) return cached;
  const root = (await gitTry(cwd, ["rev-parse", "--show-toplevel"])) || null;
  repoRootCache.set(cwd, root);
  return root;
}

/** root -> last successful fetch time (cadence gate). */
const lastFetchAt = new Map<string, number>();
/** root -> whether the last attempted fetch succeeded (recovery detection). */
const lastFetchOk = new Map<string, boolean>();
/** root -> last known needs_access, so cadence-skipped passes keep reporting it. */
const needsAccess = new Map<string, boolean>();

/** Test hook: forget cadence/recovery/root-cache state. */
export function resetGitPlaneState(): void {
  lastFetchAt.clear();
  lastFetchOk.clear();
  needsAccess.clear();
  repoRootCache.clear();
}

async function sweepRepo(repo: GitPlaneRepo, deps: GitPlaneDeps, now: number): Promise<RepoPlaneState> {
  const state: RepoPlaneState = { root: repo.root, origin_ok: false };

  let origin = await gitTry(repo.root, ["remote", "get-url", "origin"]);
  state.origin = origin || undefined;

  // REPAIR: transport leftovers (and missing origins) get the real URL when any
  // conversation in the repo knows it. First usable answer wins — they all name
  // the same repo or the sessions wouldn't share a checkout.
  if (!isRendezvousUrl(origin)) {
    for (const conversationId of repo.conversationIds) {
      const canonical = await deps.resolveCanonical(conversationId).catch(() => undefined);
      if (!isRendezvousUrl(canonical)) continue;
      const setOk = origin
        ? await gitTry(repo.root, ["remote", "set-url", "origin", canonical])
        : await gitTry(repo.root, ["remote", "add", "origin", canonical]);
      if (setOk === undefined && (await gitTry(repo.root, ["remote", "get-url", "origin"])) !== canonical) continue;
      deps.log(`[GITPLANE] repaired origin in ${repo.root}: ${origin || "(none)"} -> ${canonical}`);
      state.repaired_from = origin || "(none)";
      origin = canonical;
      state.origin = canonical;
      deps.onRemoteUsable(repo.root, repo.conversationIds);
      break;
    }
  }
  state.origin_ok = isRendezvousUrl(origin);
  if (!state.origin_ok) return state;

  // FRESHNESS: fetch on the cadence (or immediately after a repair, whose
  // lastFetchAt entry is necessarily stale or absent). Identity ladder: the
  // user's own credentials first (or whichever identity already proved itself
  // for this repo), then — only on an AUTH wall, and only for SSH remotes —
  // the device fallback key. A device-key success is remembered so pushes ride
  // the same identity; a device-key failure means the machine simply hasn't
  // been granted access yet, which is the web card's job, not an error loop's.
  if (identityFor(repo.root) === "device") state.identity = "device";
  const last = lastFetchAt.get(repo.root) ?? 0;
  if (now - last >= FETCH_INTERVAL_MS) {
    const fetchOk = () => {
      lastFetchAt.set(repo.root, now);
      state.fetched_at = now;
      state.fetch_ok = true;
      state.needs_access = undefined;
      if (lastFetchOk.get(repo.root) === false) {
        deps.log(`[GITPLANE] fetch recovered for ${repo.root}`);
        deps.onRemoteUsable(repo.root, repo.conversationIds);
      }
      lastFetchOk.set(repo.root, true);
    };
    try {
      await git(repo.root, ["fetch", "origin", "--quiet", "--prune"], gitEnvFor(repo.root));
      fetchOk();
    } catch (e) {
      const stderr = stderrOf(e);
      state.fetch_ok = false;
      state.error = stderr.slice(0, 200);
      lastFetchOk.set(repo.root, false);
      if (isGitAuthError(stderr)) {
        // Mint the key even when it can't help this remote (https): the web
        // card needs a pubkey to offer, and the user may switch the remote.
        const pubkey = deps.mintDeviceKey ? await deps.mintDeviceKey() : undefined;
        if (pubkey && isSshRemote(origin) && identityFor(repo.root) !== "device") {
          try {
            await git(repo.root, ["fetch", "origin", "--quiet", "--prune"], deviceKeyEnv());
            recordIdentity(repo.root, "device");
            state.identity = "device";
            state.error = undefined;
            deps.log(`[GITPLANE] device key is the working identity for ${repo.root}`);
            fetchOk();
          } catch (retryErr) {
            state.needs_access = true;
            state.error = stderrOf(retryErr).slice(0, 200);
          }
        } else {
          state.needs_access = true;
        }
      }
    }
  } else {
    state.fetched_at = last;
    state.fetch_ok = lastFetchOk.get(repo.root);
    state.needs_access = needsAccess.get(repo.root) || undefined;
  }
  needsAccess.set(repo.root, state.needs_access === true);

  // MEASURE: ahead/behind vs the branch's upstream, falling back to the
  // remote's default branch. Absent counts mean "not measurable", not zero.
  state.branch = await gitTry(repo.root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  let base = await gitTry(repo.root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  if (!base) {
    const head = await gitTry(repo.root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    base = head || undefined;
  }
  if (base) {
    const counts = await gitTry(repo.root, ["rev-list", "--left-right", "--count", `HEAD...${base}`]);
    const m = counts?.match(/^(\d+)\s+(\d+)$/);
    if (m) {
      state.ahead = Number(m[1]);
      state.behind = Number(m[2]);
    }
  }
  return state;
}

/**
 * One pass over every repo that currently hosts sessions. Never throws; a repo
 * whose git calls all fail simply reports origin_ok=false with the error.
 */
export async function sweepGitPlane(
  repos: GitPlaneRepo[],
  deps: GitPlaneDeps,
  now: number = Date.now(),
): Promise<RepoPlaneState[]> {
  const results: RepoPlaneState[] = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(SWEEP_CONCURRENCY, repos.length) }, async () => {
    while (i < repos.length) {
      const repo = repos[i++];
      try {
        results.push(await sweepRepo(repo, deps, now));
      } catch (e) {
        results.push({ root: repo.root, origin_ok: false, error: (e as Error)?.message?.slice(0, 200) });
      }
    }
  });
  await Promise.all(workers);
  return results;
}
