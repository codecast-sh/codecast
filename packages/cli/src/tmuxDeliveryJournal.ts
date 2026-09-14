import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultConfigDir } from "./config/configDir.js";

export type TmuxDeliveryIdentity = { messageId: string; conversationId: string };
export type TmuxPasteReceipt = TmuxDeliveryIdentity & {
  generation: string;
  payloadHash: string;
  phase: "paste" | "submit" | "verified";
  pasteAt: number;
  terminalExited?: number;
};

export class TmuxDeliveryUncertainError extends Error {
  constructor(reason: string) {
    super(`INJECT_UNVERIFIED: ${reason}; preserving the original terminal write`);
  }
}

export class TmuxDeliveryJournal {
  private readonly db: Database;

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new Database(file, { create: true, strict: true });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tmux_pastes (
        messageId TEXT PRIMARY KEY, conversationId TEXT NOT NULL,
        generation TEXT NOT NULL, payloadHash TEXT NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('paste','submit','verified')), pasteAt INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS tmux_paste_pending ON tmux_pastes(generation) WHERE phase != 'verified';
      CREATE TABLE IF NOT EXISTS tmux_paste_failures (messageId TEXT PRIMARY KEY);`);
  }

  get(messageId: string): TmuxPasteReceipt | null {
    return this.db.query<TmuxPasteReceipt, [string]>("SELECT *, EXISTS(SELECT 1 FROM tmux_paste_failures f WHERE f.messageId = p.messageId) AS terminalExited FROM tmux_pastes p WHERE messageId = ?").get(messageId);
  }

  pending(generation: string): TmuxPasteReceipt | null {
    return this.db.query<TmuxPasteReceipt, [string]>("SELECT * FROM tmux_pastes WHERE generation = ? AND phase != 'verified'").get(generation);
  }

  begin(identity: TmuxDeliveryIdentity, generation: string, payload: string): { receipt: TmuxPasteReceipt; fresh: boolean } {
    const payloadHash = createHash("sha256").update(payload).digest("hex");
    return this.db.transaction(() => {
      const prior = this.get(identity.messageId);
      if (prior) {
        if (prior.payloadHash !== payloadHash || prior.conversationId !== identity.conversationId) {
          throw new TmuxDeliveryUncertainError("delivery identity changed after a paste");
        }
        if (prior.generation !== generation && prior.phase !== "verified") {
          throw new TmuxDeliveryUncertainError("the prior terminal write has not been reconciled");
        }
        if (prior.terminalExited && prior.phase !== "verified") throw new TmuxDeliveryUncertainError("the exited terminal must be replaced before retrying");
        return { receipt: prior, fresh: false };
      }
      if (this.pending(generation)) throw new TmuxDeliveryUncertainError("an earlier message still owns the terminal input");
      const receipt: TmuxPasteReceipt = { ...identity, generation, payloadHash, phase: "paste", pasteAt: Date.now() };
      this.db.query("INSERT INTO tmux_pastes VALUES (?, ?, ?, ?, ?, ?)")
        .run(receipt.messageId, receipt.conversationId, generation, payloadHash, receipt.phase, receipt.pasteAt);
      return { receipt, fresh: true };
    }).immediate();
  }

  advance(messageId: string, phase: "submit" | "verified"): void {
    this.db.query("UPDATE tmux_pastes SET phase = ? WHERE messageId = ? AND phase != 'verified'").run(phase, messageId);
  }

  abandonUnsubmitted(messageId: string): void {
    this.abandonWhere(messageId, "phase = 'paste' OR messageId IN (SELECT messageId FROM tmux_paste_failures)");
  }

  // The receipt settled and its payload provably never reached the agent: not
  // at the prompt, and no echo acknowledged it. Whatever phase it recorded,
  // including a verification the server never confirmed, a new write cannot
  // double it.
  release(messageId: string): void {
    this.abandonWhere(messageId, "1 = 1");
  }

  private abandonWhere(messageId: string, clause: string): void {
    this.db.transaction(() => {
      const result = this.db.query(`DELETE FROM tmux_pastes WHERE messageId = ? AND (${clause})`).run(messageId);
      if (result.changes) this.db.query("DELETE FROM tmux_paste_failures WHERE messageId = ?").run(messageId);
    }).immediate();
  }

  recordTerminalExit(messageId: string): void {
    this.db.query("INSERT OR IGNORE INTO tmux_paste_failures VALUES (?)").run(messageId);
  }

  close(): void { this.db.close(); }
}

let journal: TmuxDeliveryJournal | undefined;
export function tmuxDeliveryJournal(): TmuxDeliveryJournal {
  return journal ??= new TmuxDeliveryJournal(join(defaultConfigDir(), "tmux-delivery.sqlite"));
}

type TmuxQuery = (args: string[]) => Promise<{ stdout: string }>;

export type TmuxDeliveryPreparation = {
  journal: TmuxDeliveryJournal;
  generation: string;
  prior: TmuxPasteReceipt | null;
  // A verified receipt the server never acknowledged within the settle window.
  unacknowledged: boolean;
};

// How long a receipt waits for its message's transcript echo before the
// absence of that echo counts as evidence. A submitted message is acknowledged
// within seconds of reaching the agent; two minutes covers a loaded machine.
// Without this bound a paste lost to the terminal held its pane forever.
export const TMUX_RECEIPT_SETTLE_MS = 120_000;

export function receiptSettled(receipt: TmuxPasteReceipt, settleMs = TMUX_RECEIPT_SETTLE_MS, now = Date.now()): boolean {
  return now - receipt.pasteAt >= settleMs;
}

// A receipt stops guarding its pane once nobody will ever deliver its message
// again: delivered, cancelled by a person, or deleted along with its session.
// A cancelled owner never retries, so treating only delivery as final left
// every later message refused the pane.
export async function pendingMessageFinished(
  lookup: { getPendingMessageStatus(messageId: string): Promise<string> },
  messageId: string,
): Promise<boolean> {
  try {
    const status = await lookup.getPendingMessageStatus(messageId);
    return status === "delivered" || status === "cancelled";
  } catch (error) {
    if (/Message not found/.test(String(error))) return true;
    throw error;
  }
}

async function generationFor(target: string, exec: TmuxQuery): Promise<string> {
  const { stdout } = await exec(["display-message", "-p", "-t", target, "#{pid}|#{socket_path}|#{pane_id}|#{pane_pid}|#{session_created}"]);
  const parts = stdout.trim().split("|");
  if (parts.length !== 5 || !parts.every(Boolean) || !/^%\d+$/.test(parts[2])) {
    throw new TmuxDeliveryUncertainError("terminal identity could not be verified");
  }
  return JSON.stringify(parts);
}

export async function prepareTmuxDelivery(
  target: string,
  identity: TmuxDeliveryIdentity,
  exec: TmuxQuery,
  isDelivered: (messageId: string) => Promise<boolean>,
  journal?: TmuxDeliveryJournal,
  opts?: { settleMs?: number },
): Promise<TmuxDeliveryPreparation> {
  try {
    return await prepareDelivery(target, identity, exec, isDelivered, journal ?? tmuxDeliveryJournal(), opts?.settleMs);
  } catch (error) {
    if (error instanceof TmuxDeliveryUncertainError) throw error;
    throw new TmuxDeliveryUncertainError(`receipt reconciliation failed: ${String(error)}`);
  }
}

async function prepareDelivery(
  target: string,
  identity: TmuxDeliveryIdentity,
  exec: TmuxQuery,
  isDelivered: (messageId: string) => Promise<boolean>,
  journal: TmuxDeliveryJournal,
  settleMs?: number,
): Promise<TmuxDeliveryPreparation> {
  const generation = await generationFor(target, exec);
  const pending = journal.pending(generation);
  if (pending && pending.messageId !== identity.messageId) {
    if (await isDelivered(pending.messageId)) journal.advance(pending.messageId, "verified");
    // A paste that settled unacknowledged never had Enter pressed on it, so
    // nothing of it can still submit. Its own message may have stopped
    // retrying, and holding the pane for it refused every later message
    // (2026-09-14). The next write drains whatever residue it left.
    else if (pending.phase === "paste" && receiptSettled(pending, settleMs)) journal.release(pending.messageId);
    else throw new TmuxDeliveryUncertainError("an earlier message still owns the terminal input");
  }
  let prior = journal.get(identity.messageId);
  let unacknowledged = false;
  if (prior && prior.phase !== "verified" && await isDelivered(identity.messageId)) {
    journal.advance(identity.messageId, "verified");
    prior = journal.get(identity.messageId);
  } else if (prior?.phase === "verified" && receiptSettled(prior, settleMs)) {
    // The local verifier saw evidence of a turn, but an agent that took the
    // message would have echoed it by now. The caller decides from the pane.
    unacknowledged = !(await isDelivered(identity.messageId));
  }
  // A submit into a pane that is gone replays only after the echo window: the
  // agent that took it would have written it to its transcript by then.
  const settled = !!prior && receiptSettled(prior, settleMs);
  if (prior && prior.generation !== generation && (prior.phase === "paste" || prior.terminalExited || settled)) {
    const oldParts: string[] = JSON.parse(prior.generation);
    const newParts: string[] = JSON.parse(generation);
    let oldPaneGone = !!prior.terminalExited || (oldParts[1] === newParts[1] && oldParts[0] !== newParts[0]);
    if (!oldPaneGone && oldParts[1] === newParts[1]) {
      const { stdout } = await exec(["list-panes", "-a", "-F", "#{pane_id}"]);
      const panes = stdout.trim().split("\n");
      if (!panes.includes(newParts[2])) throw new TmuxDeliveryUncertainError("terminal inventory could not be verified");
      oldPaneGone = !panes.includes(oldParts[2]) || await generationFor(oldParts[2], exec) !== prior.generation;
    }
    if (oldPaneGone) {
      if (settled) journal.release(identity.messageId);
      else journal.abandonUnsubmitted(identity.messageId);
      prior = null;
    }
  }
  return { journal, generation, prior, unacknowledged };
}
