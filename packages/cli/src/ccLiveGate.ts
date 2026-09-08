// The live process gate on the machine-global Claude OAuth refresh (ct-49526).
//
// A refresh token is single use: the token endpoint mints a new pair and spends
// the one it was handed. The daemon and a running `claude` read the SAME
// credential store, so whichever refreshes second presents a token the endpoint
// has already spent and gets invalid_grant — one of the two copies is stranded.
// While a live claude holds the active credential the daemon therefore defers
// its own refresh and reads back whatever the CLI rotated instead
// (resnapshotIfActiveFresher in ccAccounts.ts).
//
// Only a session on the KEYCHAIN login holds that credential. A session pinned
// to a saved profile runs on that profile's setup-token, exported as
// CLAUDE_CODE_OAUTH_TOKEN by accountSourcePrefix: a static year-long token with
// no refresh half, so it can neither rotate the active credential nor be
// stranded when the daemon does.
//
// The set is persisted, because a daemon restart with live panes must come back
// with the gate still CLOSED — an empty in-memory set would let the first
// maintenance tick rotate the token out from under a claude that outlived the
// daemon. Persisted ids are seeded as unconfirmed and released by the first
// reconcile against the live tmux list, so a pane that died while the daemon
// was down cannot hold the gate shut forever.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** One live claude pane: the tmux session name, and the saved profile it was
 *  launched under (absent = the machine's keychain login). */
export interface LiveClaudeSession {
  id: string;
  account?: string;
}

interface GateEntry {
  account?: string;
  /** Restored from disk and not yet seen in a live tmux list. Holds the gate
   *  closed until a reconcile either confirms or releases it. */
  unconfirmed?: boolean;
}

interface GateFile {
  sessions: LiveClaudeSession[];
}

const live = new Map<string, GateEntry>();
const drainListeners = new Set<() => void>();

// Read-modify-write of one file from marks that can arrive together (two
// sessions starting at once): without a chain the second write would race the
// first and one mark would be lost across a restart.
let writeChain: Promise<void> = Promise.resolve();

function gateStatePath(): string {
  const dir = process.env.CODECAST_DIR || path.join(process.env.HOME || os.homedir(), ".codecast");
  return path.join(dir, "cc-live-gate.json");
}

/** A pinned session runs on a setup-token, so only an unpinned one contends for
 *  the credential the daemon would rotate. */
function holdsActiveCredential(entry: GateEntry): boolean {
  return !entry.account;
}

function holderCount(): number {
  let n = 0;
  for (const entry of live.values()) if (holdsActiveCredential(entry)) n++;
  return n;
}

/** True while at least one live claude runs on the machine's keychain login.
 *  Synchronous by design: the maintenance tick asks on every pass and the
 *  answer must not cost it a file read. */
export function hasLiveClaudeOnActiveCredential(): boolean {
  return holderCount() > 0;
}

/** Every pane the gate believes is live, newest state first for logging. */
export function liveClaudeSessions(): LiveClaudeSession[] {
  return [...live.entries()].map(([id, entry]) => ({ id, ...(entry.account ? { account: entry.account } : {}) }));
}

/** Called when the last live claude on the keychain login goes away. The
 *  deferred refresh can run again, and the usage windows that session was
 *  spending are worth re-reading now rather than up to five minutes later. */
export function onLiveClaudeDrained(listener: () => void): () => void {
  drainListeners.add(listener);
  return () => drainListeners.delete(listener);
}

function notifyIfDrained(hadHolders: boolean): void {
  if (!hadHolders || holderCount() > 0) return;
  for (const listener of [...drainListeners]) listener();
}

/** A claude pane just started. `account` is the saved profile it was launched
 *  under, the same value accountSourcePrefix exports as CODECAST_CC_ACCOUNT. */
export function markClaudeSessionLive(id: string, account?: string): void {
  live.set(id, account ? { account } : {});
  void persist();
}

/** A claude pane went away (killed, reaped, or replaced). */
export function markClaudeSessionEnded(id: string): void {
  const hadHolders = holderCount() > 0;
  if (!live.delete(id)) return;
  void persist();
  notifyIfDrained(hadHolders);
}

/**
 * Adopt the live tmux list as the truth.
 *
 * Ids the list no longer carries are released — that is what frees a seeded id
 * whose pane died while the daemon was down. Ids the gate never knew are
 * adopted: a pane started by a previous daemon build, or by hand in tmux, holds
 * the credential just as firmly as one this process launched. The account
 * attribution is refreshed from the list too, so a pane re-read after a restart
 * is judged on its own stamp rather than on what the gate file remembered.
 *
 * Callers must pass a list they actually obtained. A tmux call that failed is
 * not evidence of an empty machine, and reconciling on it would open the gate
 * while claude is running.
 */
export function reconcileLiveClaudeSessions(alive: readonly LiveClaudeSession[]): void {
  const hadHolders = holderCount() > 0;
  const seen = new Set<string>();
  for (const session of alive) {
    seen.add(session.id);
    live.set(session.id, session.account ? { account: session.account } : {});
  }
  for (const id of [...live.keys()]) if (!seen.has(id)) live.delete(id);
  void persist();
  notifyIfDrained(hadHolders);
}

/** Restore the gate from disk at daemon start. Every restored id is unconfirmed
 *  — the gate is closed on it until a reconcile proves the pane is gone. */
export async function seedLiveClaudeSessions(): Promise<LiveClaudeSession[]> {
  let parsed: GateFile | null = null;
  try {
    parsed = JSON.parse(await fs.promises.readFile(gateStatePath(), "utf-8")) as GateFile;
  } catch {
    return [];
  }
  const restored: LiveClaudeSession[] = [];
  for (const session of Array.isArray(parsed?.sessions) ? parsed.sessions : []) {
    if (!session || typeof session.id !== "string" || !session.id) continue;
    const account = typeof session.account === "string" && session.account ? session.account : undefined;
    live.set(session.id, { ...(account ? { account } : {}), unconfirmed: true });
    restored.push({ id: session.id, ...(account ? { account } : {}) });
  }
  return restored;
}

/** True while any restored id is still waiting for its first reconcile. */
export function hasUnconfirmedClaudeSessions(): boolean {
  for (const entry of live.values()) if (entry.unconfirmed) return true;
  return false;
}

/**
 * Persist the current set.
 *
 * Async throughout: this runs on the daemon's loop, where one synchronous write
 * stalls delivery, injection and the heartbeat alike
 * (daemon.loopBudget.guard.test.ts). Temp file plus rename, without the fsyncs
 * atomicWriteFile does — the reconcile rebuilds this from tmux, so durability
 * across a power cut buys nothing.
 */
async function persist(): Promise<void> {
  const snapshot: GateFile = { sessions: liveClaudeSessions() };
  writeChain = writeChain.then(async () => {
    const file = gateStatePath();
    const temp = `${file}.${process.pid}.tmp`;
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(temp, JSON.stringify(snapshot, null, 2), { mode: 0o644 });
      await fs.promises.rename(temp, file);
    } catch {
      // The gate still holds in memory; the next mark retries the write.
    }
  });
  return writeChain;
}

/** Await whatever persist() has queued — tests assert on the file. */
export async function flushLiveClaudeGate(): Promise<void> {
  await writeChain;
}

/** Drop all state, in memory and on disk. Tests only. */
export async function resetLiveClaudeGate(): Promise<void> {
  live.clear();
  drainListeners.clear();
  await persist();
}
