// Which Codex account each pane is running on (ct-49528).
//
// A Codex session reads ~/.codex/auth.json when it starts and holds that grant
// for its whole life. Nothing tells a running pane that the machine has since
// signed into a different ChatGPT account: it keeps spending the old account's
// windows, its meters point at the wrong card, and the only cure is a restart.
// So every pane records the account it launched under, and comparing that
// record against the machine's current login names EXACTLY the panes a switch
// left behind — no guessing, no restarting sessions that were already right.
//
// Two copies of the same fact, on purpose:
//   - the tmux session option `@codecast_codex_account`, beside the
//     `@codecast_cc_account` stamp the Claude gate writes (ct-49526), so a pane
//     started by an older daemon build (or by a daemon that has since died)
//     still answers for itself;
//   - this file, so the daemon comes back from a restart already knowing its
//     fleet instead of waiting for the first reconcile.
// The tmux list is the truth whenever we can obtain one: reconcile adopts what
// it says and drops what it omits.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** One live Codex pane: its tmux session name, the saved profile it launched
 *  under, and the conversation it belongs to (absent for panes started outside
 *  a conversation). An unknown account is left undefined rather than guessed —
 *  a pane we cannot attribute is never named stale. */
export interface CodexPane {
  id: string;
  account?: string;
  conversationId?: string;
}

const panes = new Map<string, CodexPane>();

// Read-modify-write of one file from marks that can arrive together (two
// sessions starting at once): without a chain the second write would race the
// first and one mark would be lost across a restart.
let writeChain: Promise<void> = Promise.resolve();

function registryPath(): string {
  const dir = process.env.CODECAST_DIR || path.join(process.env.HOME || os.homedir(), ".codecast");
  return path.join(dir, "codex-panes.json");
}

function entry(pane: CodexPane): CodexPane {
  return {
    id: pane.id,
    ...(pane.account ? { account: pane.account } : {}),
    ...(pane.conversationId ? { conversationId: pane.conversationId } : {}),
  };
}

/** Every pane the registry believes is live. */
export function codexPanes(): CodexPane[] {
  return [...panes.values()].map(entry);
}

/** A Codex pane just started (or was resumed, which is the same thing: a new
 *  process reading auth.json afresh). */
export function markCodexPaneLive(id: string, pane: Omit<CodexPane, "id"> = {}): void {
  panes.set(id, entry({ id, ...pane }));
  void persist();
}

/** A Codex pane went away (killed, reaped, or replaced). */
export function markCodexPaneEnded(id: string): void {
  if (!panes.delete(id)) return;
  void persist();
}

/**
 * Adopt the live tmux list as the truth.
 *
 * Panes the list omits are dropped — that is what clears a pane which died
 * while the daemon was down. Panes the registry never knew are adopted: one
 * started by a previous daemon build, or by hand, spends the same account's
 * windows. Attribution is refreshed from the list, so a pane is judged on its
 * own stamp rather than on what this file remembered.
 *
 * Callers must pass a list they actually obtained. A tmux call that failed is
 * not evidence of an empty machine, and reconciling on it would forget every
 * live pane and report a clean switch that never happened.
 */
export function reconcileCodexPanes(alive: readonly CodexPane[]): void {
  const seen = new Set<string>();
  for (const pane of alive) {
    seen.add(pane.id);
    // The account comes from the stamp alone: remembering one the pane no
    // longer carries would resurrect an attribution we cannot see. The
    // conversation is the opposite — a resumed pane carries no conversation
    // stamp, so forgetting it would lose the only link back to the row.
    const known = panes.get(pane.id);
    panes.set(pane.id, entry({ ...pane, conversationId: pane.conversationId ?? known?.conversationId }));
  }
  for (const id of [...panes.keys()]) if (!seen.has(id)) panes.delete(id);
  void persist();
}

/**
 * The panes still running an account other than `current`.
 *
 * `current` is the profile name covering the machine's login right now;
 * undefined means we could not name it, and then nothing is stale — a switch we
 * cannot describe must not order restarts. Panes with no recorded account are
 * left alone for the same reason.
 */
export function staleCodexPanes(current: string | undefined): CodexPane[] {
  if (!current) return [];
  return codexPanes().filter((pane) => !!pane.account && pane.account !== current);
}

/** Restore the registry from disk at daemon start. */
export async function seedCodexPanes(): Promise<CodexPane[]> {
  let parsed: { panes?: CodexPane[] } | null = null;
  try {
    parsed = JSON.parse(await fs.promises.readFile(registryPath(), "utf-8"));
  } catch {
    return [];
  }
  const restored: CodexPane[] = [];
  for (const pane of Array.isArray(parsed?.panes) ? parsed.panes : []) {
    if (!pane || typeof pane.id !== "string" || !pane.id) continue;
    const row = entry({
      id: pane.id,
      account: typeof pane.account === "string" ? pane.account : undefined,
      conversationId: typeof pane.conversationId === "string" ? pane.conversationId : undefined,
    });
    panes.set(row.id, row);
    restored.push(row);
  }
  return restored;
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
  const snapshot = { panes: codexPanes() };
  writeChain = writeChain.then(async () => {
    const file = registryPath();
    const temp = `${file}.${process.pid}.tmp`;
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(temp, JSON.stringify(snapshot, null, 2), { mode: 0o644 });
      await fs.promises.rename(temp, file);
    } catch {
      // The registry still holds in memory; the next mark retries the write.
    }
  });
  return writeChain;
}

/** Await whatever persist() has queued — tests assert on the file. */
export async function flushCodexPaneRegistry(): Promise<void> {
  await writeChain;
}

/** Drop all state, in memory and on disk. Tests only. */
export async function resetCodexPaneRegistry(): Promise<void> {
  panes.clear();
  await persist();
}

/**
 * Parse `tmux list-sessions -F <codexPaneListFormat(sep)>` into the codex panes.
 *
 * A tmux too old to expand `#{@opt}` hands the placeholder back verbatim and an
 * unset option expands to nothing; both read as "not stamped", so such a field
 * is dropped rather than believed. The session name is joined back from the
 * leading fields because it is the only one that may contain the separator.
 */
export function parseCodexPaneRows(stdout: string, sep: string): CodexPane[] {
  const out: CodexPane[] = [];
  for (const row of stdout.split("\n")) {
    const parts = row.split(sep);
    if (parts.length < 4) continue;
    const expanded = (v: string) => (v.includes("#{") ? "" : v.trim());
    const conversationId = expanded(parts.pop()!);
    const account = expanded(parts.pop()!);
    const agentType = expanded(parts.pop()!);
    const id = parts.join(sep).trim();
    if (!id || agentType !== "codex") continue;
    out.push(entry({ id, account: account || undefined, conversationId: conversationId || undefined }));
  }
  return out;
}

/** The tmux format the reconcile reads: session name, agent type, the account
 *  stamp, and the conversation the pane serves. */
export function codexPaneListFormat(sep: string): string {
  return `#{session_name}${sep}#{@codecast_agent_type}${sep}#{@codecast_codex_account}${sep}#{@codecast_conversation_id}`;
}
