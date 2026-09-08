/**
 * Launch tokens: which PROCESS a pane's hook posts are coming from (ct-49532).
 *
 * Pane identity today answers "where did this session run" — a registry claim,
 * the `@codecast_session_id` tmux option, a cached pid. None of it can tell a
 * live agent apart from the one that ran in the same pane a minute ago: a dead
 * process is rejected only because its pid is gone, and an orphan that is still
 * alive keeps posting status the daemon believes. Replaying those posts once
 * made clients auto-type a second `--resume` onto a transcript the orphan was
 * still writing.
 *
 * The fence: every spawn and every resume mints a token, stamps it into the
 * pane env as CODECAST_LAUNCH_TOKEN, and records it here. The hook scripts read
 * it out of their own environment and forward it with every post, so a post
 * proves which launch produced it. The rules (Orca server-status-disposition.ts
 * and retired-pane-surfaces.ts, revalidated against tmux panes):
 *
 *   - a post whose token is the pane's current token is admitted;
 *   - a post carrying an older token of that pane is an orphan — dropped;
 *   - a retired pane (killed, closed, relocated) admits nothing, except a new
 *     turn event from a token it has never seen, which proves a new process
 *     owns the pane and re-fences it;
 *   - a post with no token at all is a hook script from before this shipped:
 *     admitted for one release, logged once.
 *
 * The ledger is persisted, so a daemon restart keeps fencing the panes it
 * launched instead of trusting every orphan again.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { isLaunchToken, mintLaunchToken } from "./agentEnv.js";
import { atomicWriteFile } from "./atomicWrite.js";
import { defaultConfigDir } from "./config/configDir.js";

export type LaunchEntry = {
  token: string;
  /** tmux session name the launch owns. */
  pane: string;
  /** Agent session id, once a post or a caller has named it. */
  sessionId?: string;
  /** Epoch ms the token was issued (or adopted). */
  issuedAt: number;
};

export type LaunchVerdict = {
  decision: "accept" | "drop";
  /** Short cause, for the [IDENTITY] log line. */
  reason: "current" | "unmanaged" | "legacy" | "restart" | "stale-token" | "retired-pane";
  /** True when the daemon should log this one (drops, and a legacy post once per pane). */
  notable: boolean;
};

/** Bounded so a long-lived daemon cannot accumulate one entry per launch ever made. */
const MAX_ENTRIES = 512;

type Persisted = {
  v: 1;
  entries: LaunchEntry[];
  retired: Array<[string, number]>;
};

export type LaunchTokenLedgerOptions = {
  /** Directory the ledger file lives in (the daemon's CONFIG_DIR). */
  dir: string;
  now?: () => number;
};

// One ledger per process, so every writer (the spawn paths, the hook fence, the
// task scheduler) fences against the same file instead of keeping its own view.
// Keyed by directory: a test that points CODECAST_DIR at a scratch dir gets its
// own ledger without a reset hook.
let sharedLedger: { dir: string; ledger: LaunchTokenLedger } | null = null;

export function launchTokenDir(): string {
  return defaultConfigDir();
}

export function launchTokenLedger(): LaunchTokenLedger {
  const dir = launchTokenDir();
  if (!sharedLedger || sharedLedger.dir !== dir) sharedLedger = { dir, ledger: new LaunchTokenLedger({ dir }) };
  return sharedLedger.ledger;
}

export class LaunchTokenLedger {
  private readonly file: string;
  private readonly now: () => number;
  /** Every launch we know of, oldest first (insertion order is age). */
  private entries = new Map<string, LaunchEntry>();
  /** Pane -> token of its current launch. */
  private paneHead = new Map<string, string>();
  /** Pane -> when its surface was retired (kill, close, relocate). */
  private paneRetiredAt = new Map<string, number>();
  /**
   * Session id -> token of its current launch. A resume often lands in a
   * DIFFERENT pane (cc-resume-…) and leaves the process in the old pane alive,
   * where it is still that pane's current launch — so the pane rules alone
   * would keep believing it. The session's own head is what supersedes it.
   */
  private sessionHead = new Map<string, string>();
  /** Panes whose legacy (tokenless) posts have already been logged once. */
  private legacyLogged = new Set<string>();

  constructor(opts: LaunchTokenLedgerOptions) {
    this.file = path.join(opts.dir, "launch-tokens.json");
    this.now = opts.now ?? (() => Date.now());
    this.load();
  }

  /** Mint and record the token for a launch about to happen in `pane`. */
  issue(pane: string, sessionId?: string): string {
    const token = mintLaunchToken();
    this.record(pane, token, sessionId);
    this.persist();
    return token;
  }

  /** The token of the pane's current launch, if any. */
  currentToken(pane: string): string | undefined {
    return this.paneHead.get(pane);
  }

  entryFor(token: string): LaunchEntry | undefined {
    return this.entries.get(token);
  }

  /**
   * The pane's client surface is gone (killed, closed, or relocated out from
   * under whatever still runs there). Nothing that was launched into it before
   * now speaks for it again.
   */
  retirePane(pane: string): void {
    if (!pane) return;
    // Only panes this ledger knows: the daemon tears down panes it never
    // launched (a login flow, an editor), and recording those would write the
    // file on every sweep to fence nothing.
    if (!this.paneHead.has(pane) && !this.paneRetiredAt.has(pane)) return;
    this.paneRetiredAt.delete(pane);
    this.paneRetiredAt.set(pane, this.now());
    while (this.paneRetiredAt.size > MAX_ENTRIES) {
      const oldest = this.paneRetiredAt.keys().next().value;
      if (oldest === undefined) break;
      this.paneRetiredAt.delete(oldest);
    }
    this.persist();
  }

  /**
   * A live agent's pane was renamed out of a name that is about to be reused
   * (relocateForeignOccupant). Its launch follows the rename — dropping it here
   * would silence a session that is merely somewhere else — and the name it
   * left is retired.
   */
  relocatePane(from: string, to: string): void {
    if (!from || !to || from === to) return;
    const now = this.now();
    for (const entry of this.entries.values()) {
      if (entry.pane !== from) continue;
      entry.pane = to;
      // Re-stamped: the retirement of `to` recorded before the move describes
      // the occupant that was killed there, not this one.
      entry.issuedAt = now;
      this.paneHead.set(to, entry.token);
    }
    this.paneHead.delete(from);
    this.paneRetiredAt.set(from, now);
    this.persist();
  }

  /**
   * True when `token` no longer speaks for its pane: a newer launch replaced it,
   * or the pane was retired after it was issued. An unknown token is not stale —
   * we have no evidence about it either way.
   */
  isStaleToken(token: string | undefined): boolean {
    if (!isLaunchToken(token)) return false;
    const entry = this.entries.get(token);
    if (!entry) return false;
    if (entry.sessionId && this.sessionHead.get(entry.sessionId) !== token) return true;
    if (this.paneHead.get(entry.pane) !== token) return true;
    return (this.paneRetiredAt.get(entry.pane) ?? -1) >= entry.issuedAt;
  }

  /**
   * Should this hook post be believed? See the module comment for the rules.
   *
   * `newTurn` marks a post that BEGINS a turn (the daemon reads it off the
   * status: only UserPromptSubmit reports "thinking"). It is the one event a
   * new process emits before it does anything, so it is the only proof that a
   * retired pane is owned again rather than being written to by whatever
   * survived the kill.
   */
  admit(evt: { sessionId?: string; token?: string; newTurn?: boolean }): LaunchVerdict {
    const token = isLaunchToken(evt.token) ? evt.token : undefined;
    const entry = token ? this.entries.get(token) : undefined;
    const sessionHead = evt.sessionId ? this.sessionHead.get(evt.sessionId) : undefined;
    const pane = entry?.pane ?? (sessionHead ? this.entries.get(sessionHead)?.pane : undefined);
    // Nothing this daemon launched: a claude the user opened in their own
    // terminal reports status the same way, and it is not ours to fence.
    if (!pane) return { decision: "accept", reason: "unmanaged", notable: false };

    if (!token) {
      // A hook script installed before launch tokens shipped. Accepted for one
      // release; the install refreshes the script, so this drains on its own.
      const notable = !this.legacyLogged.has(pane);
      if (notable) this.legacyLogged.add(pane);
      return { decision: "accept", reason: "legacy", notable };
    }

    // A launch of this session that a later launch replaced, wherever it runs.
    if (entry && sessionHead && sessionHead !== token) {
      return { decision: "drop", reason: "stale-token", notable: true };
    }

    const isCurrent = this.paneHead.get(pane) === token;
    const retiredAt = this.paneRetiredAt.get(pane);
    // ">=", not ">": a kill lands in the same millisecond as the launch it ends
    // often enough to matter, and a retirement that ties with its launch is
    // still about that launch.
    const retired = retiredAt !== undefined && retiredAt >= (entry?.issuedAt ?? 0);

    if (retired || !isCurrent) {
      // A token we never issued, on a turn-starting event, is a new process
      // announcing itself in a pane we thought was finished. Fencing it out
      // would leave a live session with no status at all, and it re-fences the
      // pane against everything older, so adopt it.
      if (!entry && evt.newTurn) {
        this.record(pane, token, evt.sessionId);
        this.persist();
        return { decision: "accept", reason: "restart", notable: true };
      }
      return { decision: "drop", reason: retired ? "retired-pane" : "stale-token", notable: true };
    }

    if (evt.sessionId && entry!.sessionId !== evt.sessionId) {
      entry!.sessionId = evt.sessionId;
      this.sessionHead.set(evt.sessionId, token);
      this.persist();
    }
    return { decision: "accept", reason: "current", notable: false };
  }

  private record(pane: string, token: string, sessionId?: string): void {
    const entry: LaunchEntry = { token, pane, issuedAt: this.now(), ...(sessionId ? { sessionId } : {}) };
    this.entries.delete(token);
    this.entries.set(token, entry);
    this.paneHead.set(pane, token);
    // A pane being launched into is a pane that exists again.
    this.paneRetiredAt.delete(pane);
    this.legacyLogged.delete(pane);
    if (sessionId) this.sessionHead.set(sessionId, token);
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  private load(): void {
    let parsed: Persisted;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, "utf-8"));
    } catch {
      return;
    }
    if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.entries)) return;
    for (const e of parsed.entries) {
      if (!isLaunchToken(e?.token) || typeof e.pane !== "string" || !e.pane) continue;
      if (typeof e.issuedAt !== "number") continue;
      this.entries.set(e.token, { token: e.token, pane: e.pane, issuedAt: e.issuedAt, ...(e.sessionId ? { sessionId: e.sessionId } : {}) });
    }
    // Head per pane is the newest issue, not the last line written: a relocate
    // rewrites entries in place and the file keeps its original order.
    for (const e of this.entries.values()) {
      const paneHead = this.paneHead.get(e.pane);
      if (!paneHead || (this.entries.get(paneHead)?.issuedAt ?? 0) <= e.issuedAt) this.paneHead.set(e.pane, e.token);
      if (!e.sessionId) continue;
      const sessionHead = this.sessionHead.get(e.sessionId);
      if (!sessionHead || (this.entries.get(sessionHead)?.issuedAt ?? 0) <= e.issuedAt) this.sessionHead.set(e.sessionId, e.token);
    }
    for (const [pane, ts] of Array.isArray(parsed.retired) ? parsed.retired : []) {
      if (typeof pane === "string" && pane && typeof ts === "number") this.paneRetiredAt.set(pane, ts);
    }
  }

  private persist(): void {
    const data: Persisted = {
      v: 1,
      entries: [...this.entries.values()],
      retired: [...this.paneRetiredAt.entries()],
    };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      atomicWriteFile(this.file, JSON.stringify(data));
    } catch {
      // A ledger we cannot write still fences correctly in memory; only a
      // restart loses the fence, which is where this started.
    }
  }
}
