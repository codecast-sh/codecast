/**
 * Local git activity, read off the reflog.
 *
 * Every git command that moves HEAD appends one line to the checkout's
 * `logs/HEAD` — commit, checkout, merge, pull, rebase, reset, cherry-pick,
 * revert — and every push appends "update by push" to the remote-tracking
 * branch's log under `logs/refs/remotes/origin/`. That file is the local
 * equivalent of a GitHub webhook: it names the old and new sha, the actor, the
 * time and the command, and it is written the moment the command finishes,
 * whoever ran it — an agent through Bash, a person in a terminal, an editor.
 *
 * The tailer remembers how far into each log it has read and hands back only
 * new lines, classified. It starts at the end of the log, so a checkout with a
 * year of history costs nothing to adopt. The daemon posts what it finds as
 * activity events (convex gitActivity.recordLocal), where a commit also
 * becomes a commits row and both link back to the session that made it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describeCommit, runGit, type GitRunner, type MirrorCommit } from "./repoMirror.js";

export interface ReflogEntry {
  old_sha: string;
  new_sha: string;
  actor_name: string;
  actor_email: string;
  /** Milliseconds since the epoch. */
  at: number;
  /** The word before the first ": " — commit, checkout, merge origin/main, pull, rebase (finish), reset … */
  action: string;
  /** Everything after it: the commit subject, "moving from a to b", "Fast-forward" … */
  message: string;
}

export type GitActivityKind =
  | "commit"
  | "amend"
  | "checkout"
  | "merge"
  | "pull"
  | "rebase"
  | "reset"
  | "cherry_pick"
  | "revert"
  | "push";

export interface GitActivityEvent {
  kind: GitActivityKind;
  old_sha: string;
  new_sha: string;
  at: number;
  actor_name: string;
  actor_email: string;
  /** The branch the event concerns: the branch pushed, merged from, or checked out onto. */
  ref?: string;
  from_ref?: string;
  to_ref?: string;
  message: string;
  /** For a commit, amend, cherry-pick or revert: the commits-table row for new_sha. */
  commit?: MirrorCommit;
}

const NULL_SHA = "0".repeat(40);

/** `<old> <new> <name> <email> <unix> <tz>\t<action>: <message>` */
export function parseReflogLine(line: string): ReflogEntry | null {
  const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.*?) <([^>]*)> (\d+) [+-]\d{4}\t(.*)$/.exec(line);
  if (!m) return null;
  const tail = m[6];
  const colon = tail.indexOf(": ");
  return {
    old_sha: m[1],
    new_sha: m[2],
    actor_name: m[3],
    actor_email: m[4],
    at: Number(m[5]) * 1000,
    action: colon === -1 ? tail.trim() : tail.slice(0, colon).trim(),
    message: colon === -1 ? "" : tail.slice(colon + 2).trim(),
  };
}

type Classified = Omit<GitActivityEvent, "commit"> | null;

/** What a HEAD reflog line means, or null for the housekeeping lines a reader never wants (fetch, clone, rebase steps). */
export function classifyHeadEntry(entry: ReflogEntry): Classified {
  const base = { old_sha: entry.old_sha, new_sha: entry.new_sha, at: entry.at, actor_name: entry.actor_name, actor_email: entry.actor_email, message: entry.message };
  const action = entry.action;
  if (action.startsWith("commit (amend)")) return { ...base, kind: "amend" };
  if (action.startsWith("commit")) return { ...base, kind: "commit" };
  if (action === "checkout") {
    const moving = /^moving from (\S+) to (\S+)$/.exec(entry.message);
    return { ...base, kind: "checkout", from_ref: moving?.[1], to_ref: moving?.[2], ref: moving?.[2] };
  }
  if (action.startsWith("merge ")) return { ...base, kind: "merge", ref: action.slice("merge ".length).trim() };
  if (action === "pull" || action.startsWith("pull ")) return { ...base, kind: "pull" };
  if (/^rebase( -i)? \(finish\)$/.test(action) || action === "rebase finished") return { ...base, kind: "rebase" };
  if (action === "reset") return { ...base, kind: "reset", ref: /^moving to (\S+)$/.exec(entry.message)?.[1] };
  if (action === "cherry-pick") return { ...base, kind: "cherry_pick" };
  if (action === "revert") return { ...base, kind: "revert" };
  return null;
}

/** What a remote-tracking log line means: only a push counts, a fetch is not activity. */
export function classifyRemoteEntry(entry: ReflogEntry, branch: string): Classified {
  if (entry.action !== "update by push") return null;
  return { kind: "push", old_sha: entry.old_sha, new_sha: entry.new_sha, at: entry.at, actor_name: entry.actor_name, actor_email: entry.actor_email, ref: branch, message: entry.message };
}

/** Kinds whose new sha is a commit worth a row of its own. */
export function producesCommit(kind: GitActivityKind): boolean {
  return kind === "commit" || kind === "amend" || kind === "cherry_pick" || kind === "revert";
}

async function gitPath(run: GitRunner, root: string, name: string): Promise<string | null> {
  try {
    const out = (await run(root, ["rev-parse", "--path-format=absolute", "--git-path", name])).trim();
    return out ? path.resolve(root, out) : null;
  } catch {
    return null;
  }
}

/**
 * One checkout's reflogs, read incrementally. `init` seats every offset at the
 * current end so only what happens from now on is reported; `poll` returns the
 * events since the last call. A log that shrank (gc rewrote it) is re-seated
 * at its new end rather than replayed.
 */
export class GitActivityTailer {
  private headLog: string | null = null;
  private remoteDir: string | null = null;
  private offsets = new Map<string, number>();

  constructor(
    readonly root: string,
    private readonly run: GitRunner = runGit,
  ) {}

  /** The files worth watching, for a filesystem watcher; empty until init. */
  watchPaths(): string[] {
    return [this.headLog, this.remoteDir].filter((p): p is string => !!p);
  }

  async init(): Promise<boolean> {
    this.headLog = await gitPath(this.run, this.root, "logs/HEAD");
    this.remoteDir = await gitPath(this.run, this.root, "logs/refs/remotes/origin");
    if (!this.headLog) return false;
    for (const file of this.files()) this.offsets.set(file, sizeOf(file));
    return true;
  }

  private files(): string[] {
    const out: string[] = [];
    if (this.headLog && fs.existsSync(this.headLog)) out.push(this.headLog);
    if (this.remoteDir && fs.existsSync(this.remoteDir)) {
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.isFile()) out.push(full);
        }
      };
      walk(this.remoteDir);
    }
    return out;
  }

  /** New lines in one file since the last poll, and the offset moved past them. */
  private readNew(file: string): string[] {
    const size = sizeOf(file);
    const seen = this.offsets.get(file);
    // A file this tailer has never seen (a remote branch pushed for the first
    // time) starts at zero: its whole content is new. A file that shrank was
    // rewritten by gc; nothing in it is news.
    const from = seen === undefined ? 0 : size < seen ? size : seen;
    this.offsets.set(file, size);
    if (size <= from) return [];
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      return buf.toString("utf-8").split("\n").filter(Boolean);
    } finally {
      fs.closeSync(fd);
    }
  }

  async poll(): Promise<GitActivityEvent[]> {
    if (!this.headLog) return [];
    const events: GitActivityEvent[] = [];
    for (const file of this.files()) {
      const lines = this.readNew(file);
      if (!lines.length) continue;
      const isHead = file === this.headLog;
      const branch = isHead ? "" : path.relative(this.remoteDir!, file).split(path.sep).join("/");
      for (const line of lines) {
        const entry = parseReflogLine(line);
        if (!entry || entry.new_sha === NULL_SHA) continue;
        const classified = isHead ? classifyHeadEntry(entry) : classifyRemoteEntry(entry, branch);
        if (!classified) continue;
        const commit = producesCommit(classified.kind) ? (await describeCommit(this.run, this.root, classified.new_sha)) ?? undefined : undefined;
        events.push({ ...classified, ...(commit ? { commit } : {}) });
      }
    }
    return events;
  }
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}
