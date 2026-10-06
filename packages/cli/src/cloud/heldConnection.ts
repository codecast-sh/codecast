/**
 * Long-lived ssh connections the laptop daemon holds open to cloud hosts: the
 * SSH agent bridge (cloud/agentBridge.ts) and reached folders (cloud/reach.ts).
 *
 * Each connection is keyed (a host, or a host and a folder) and has the same
 * lifecycle: open it when the host answers, close it when the human turns it
 * off or the host moves, and when it dies on its own, wait before reopening
 * (nextBridgeBackoff), so a broken connection cannot keep a box awake (its
 * idle watchdog counts inbound ssh as activity). An exit code the remote
 * side reserves for "this cannot work until something changes" (no forwarded
 * agent, no sshfs) parks the key as refused until the caller forgets it.
 */

import type { ChildProcess } from "../proc.js";
import { nextBridgeBackoff, type BridgeBackoff } from "./agentBridge.js";

export interface HeldConnection { child: ChildProcess; address: string; startedAt: number; label: string }

export interface HeldConnectionsOptions {
  /** Log tag, e.g. "[AGENT-BRIDGE]". */
  tag: string;
  log: (message: string, level?: "warn") => void;
  /** The refusal sentence for an exit code, or null when the exit is an ordinary failure to retry. */
  refusal: (code: number | null, key: string) => string | null;
  /** Ends a connection on purpose (the bridge closes stdin first; a reach kills its process group). */
  stop: (child: ChildProcess) => void;
  /** Called on every exit, after bookkeeping, with the tail of stderr. */
  onExit?: (key: string, info: { code: number | null; signal: NodeJS.Signals | null; stderr: string; closedOnPurpose: boolean; refused: string | null }) => void;
  now?: () => number;
}

export class HeldConnections {
  private readonly live = new Map<string, HeldConnection>();
  private readonly backoff = new Map<string, BridgeBackoff>();
  private readonly refused = new Map<string, string>();
  constructor(private readonly o: HeldConnectionsOptions) {}

  private now(): number { return (this.o.now ?? Date.now)(); }

  entries(): IterableIterator<[string, HeldConnection]> { return this.live.entries(); }
  get(key: string): HeldConnection | undefined { return this.live.get(key); }
  refusedReason(key: string): string | undefined { return this.refused.get(key); }
  backoffUntil(key: string): number | undefined { return this.backoff.get(key)?.notBefore; }

  /** Not live, not refused, and past its backoff. */
  canOpen(key: string): boolean {
    if (this.live.has(key) || this.refused.has(key)) return false;
    const b = this.backoff.get(key);
    return !b || this.now() >= b.notBefore;
  }

  /** Drop what the key's failures taught us (the human toggled it, or it was removed). */
  forget(key: string): void {
    this.refused.delete(key);
    this.backoff.delete(key);
  }

  close(key: string, why: string): void {
    const c = this.live.get(key);
    if (!c) return;
    this.live.delete(key);
    this.o.log(`${this.o.tag} closing ${c.label} (${why})`);
    this.o.stop(c.child);
  }

  /** Track a freshly spawned connection: its exit is classified and backed off here. */
  hold(key: string, label: string, address: string, child: ChildProcess): HeldConnection {
    const held: HeldConnection = { child, address, startedAt: this.now(), label };
    this.live.set(key, held);
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => { stderr = (stderr + d.toString()).slice(-2000); });
    child.on("error", (err) => this.o.log(`${this.o.tag} ${label} could not start: ${err.message}`, "warn"));
    child.on("exit", (code, signal) => {
      const mine = this.live.get(key) === held;
      if (mine) this.live.delete(key);
      const refusal = this.o.refusal(code, key);
      const tail = stderr.trim().split("\n").pop() ?? "";
      if (refusal) {
        this.refused.set(key, refusal);
        this.o.log(`${this.o.tag} ${label}: ${refusal}`, "warn");
      } else if (mine) {
        // The count is only reset by a connection that lived (nextBridgeBackoff),
        // never at spawn: a reset there made every failure the first one.
        const next = nextBridgeBackoff(this.backoff.get(key), this.now() - held.startedAt, this.now());
        this.backoff.set(key, next);
        const wait = next.notBefore - this.now();
        this.o.log(`${this.o.tag} ${label} exited (${signal ?? `exit ${code}`})${tail ? `: ${tail}` : ""} — retrying in ${Math.round(wait / 1000)}s (failure ${next.failures})`);
      }
      this.o.onExit?.(key, { code, signal, stderr, closedOnPurpose: !mine, refused: refusal });
    });
    return held;
  }
}
