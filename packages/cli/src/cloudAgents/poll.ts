/**
 * What every cloud poller shares (the cloud agent watcher here and
 * ClaudeCloudWatcher): how far back a first sight reaches, how many list
 * pages one pass reads, where a cloud session is placed locally, and the
 * self-scheduling cadence that polls fast while work runs or a reply is due.
 */
import { CLOUD_AGENT_BACKFILL_DAYS } from "@codecast/shared/contracts";
import type { GitInfo } from "../syncService.js";

/** How far back the first sight of a cloud agent or session reaches. */
export const CLOUD_BACKFILL_MS = CLOUD_AGENT_BACKFILL_DAYS * 24 * 3600_000;

/** How many pages of a provider's list one pass reads. */
export const CLOUD_MAX_LIST_PAGES = 5;

/**
 * A provider's paged list: `fetchPage` reads one page from a cursor and says
 * where the next starts (undefined at the end), for up to `maxPages`.
 */
export async function collectPages<T>(fetchPage: (cursor: string | undefined) => Promise<{ items: T[]; next?: string }>, maxPages = CLOUD_MAX_LIST_PAGES): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const { items, next } = await fetchPage(cursor);
    out.push(...items);
    if (!next) break;
    cursor = next;
  }
  return out;
}

/** A provider's time in seconds (Codex Cloud, the Agents API) as ms; undefined when it names none. */
export function secondsToMs(s: number | null | undefined): number | undefined {
  return typeof s === "number" && Number.isFinite(s) && s > 0 ? Math.round(s * 1000) : undefined;
}

/** The folder a cloud session is placed under when this machine has no checkout of its repo. */
function cloudMirrorPlaceholderRoot(dirName: string): string {
  return `/${dirName}`;
}

/**
 * Where a cloud session belongs locally: the checkout of its GitHub repo,
 * else a stable placeholder under cloudMirrorPlaceholderRoot (per repo when it
 * names one), so every session of one repo shares a project.
 */
export async function cloudMirrorPlacement(
  dirName: string,
  repo: { owner: string; name: string } | null | undefined,
  resolveRepoDir: (repo: { owner: string; name: string }) => Promise<string | null>,
): Promise<string> {
  const local = repo ? await resolveRepoDir(repo).catch(() => null) : null;
  if (local) return local;
  const root = cloudMirrorPlaceholderRoot(dirName);
  return repo ? `${root}/${repo.owner}/${repo.name}` : root;
}

/** Whether a session's folder is a placeholder cloudMirrorPlacement made (no checkout of its repo on that machine). */
export function isCloudMirrorPlaceholder(cwd: string, dirNames: readonly string[]): boolean {
  return dirNames.map(cloudMirrorPlaceholderRoot).some((root) => cwd === root || cwd.startsWith(`${root}/`));
}

/**
 * What a local checkout may say about a cloud session placed in it: which
 * repository it is (root and remote, for placement and sharing), never its
 * branch, HEAD or changes. Those are this machine's work, not the agent's;
 * the agent's own branch comes from its provider (the watcher's git event).
 */
export function cloudMirrorRepoFacts(info: GitInfo | undefined): GitInfo | undefined {
  if (!info) return undefined;
  const { root, repoRoot, remoteUrl } = info;
  return { ...(root ? { root } : {}), ...(repoRoot ? { repoRoot } : {}), ...(remoteUrl ? { remoteUrl } : {}) };
}

/**
 * The git facts a cloud session never takes from a local checkout, cleared
 * whenever its provider reports the agent's branch (git_branch too, when it
 * pushed none): what cloudMirrorRepoFacts leaves out.
 */
export const CLOUD_MIRROR_LOCAL_GIT_FIELDS = ["git_commit_hash", "git_ahead", "git_behind", "git_dirty"] as const;

/** `owner/name` as the placement takes it; undefined when either half is missing. */
export function repoOwnerName(repo: string | undefined): { owner: string; name: string } | undefined {
  const [owner, name] = repo?.split("/") ?? [];
  return owner && name ? { owner, name } : undefined;
}

export interface PollCadenceOptions {
  /** Between passes while nothing runs. */
  pollMs: number;
  /** Between passes while work runs (`busy`) or a reply is due (`hurry`). */
  fastPollMs: number;
  now?: () => number;
}

/**
 * A poll that schedules itself after each pass, so the interval follows the
 * work: fast while something runs or a reply is due, slow otherwise. One pass
 * at a time; a pass that throws is the caller's to catch.
 */
export class PollCadence {
  private timer: NodeJS.Timeout | null = null;
  private dueAt: number | undefined;
  private fastUntil = 0;
  private active = false;
  /** Work was running at the last pass: poll fast until it settles. */
  busy = false;
  private readonly now: () => number;

  constructor(private readonly pass: () => Promise<void>, private readonly opts: PollCadenceOptions) {
    this.now = opts.now ?? Date.now;
  }

  get running(): boolean {
    return this.active;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.schedule(0);
  }

  stop(): void {
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.dueAt = undefined;
  }

  /** Poll fast for the next `ms` (a message just went out, or something just moved), starting with the next pass. */
  hurry(ms: number): void {
    this.fastUntil = Math.max(this.fastUntil, this.now() + ms);
    // A pass in flight schedules the next one fast when it ends; a pass
    // already due sooner keeps its time.
    if (this.dueAt !== undefined && this.dueAt - this.now() > this.opts.fastPollMs) this.schedule(this.opts.fastPollMs);
  }

  private schedule(delayMs: number): void {
    if (!this.active) return;
    if (this.timer) clearTimeout(this.timer);
    this.dueAt = this.now() + delayMs;
    this.timer = setTimeout(async () => {
      this.timer = null;
      this.dueAt = undefined;
      try {
        await this.pass();
      } finally {
        this.schedule(this.busy || this.now() < this.fastUntil ? this.opts.fastPollMs : this.opts.pollMs);
      }
    }, delayMs);
  }
}
