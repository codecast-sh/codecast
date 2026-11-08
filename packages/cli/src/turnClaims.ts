// Turn claims: which sessions on this machine are mid-turn, recorded when the
// turn starts and released when it ends, so a restart knows exactly which
// sessions to continue (docs/architecture/turn-claims.md).
//
// A claim opens on the first mid-turn status of a turn (UserPromptSubmit, a
// tool call, a compaction, a permission prompt) and is released by the turn's
// end: the Stop hook's settle, an SDK result, an interrupt. Nothing else
// releases it: a daemon that exits, a host that dies and a machine that
// reboots all leave it in place, which is the point. A recovery pass then
// looks at every claim whose process is gone, bumps its attempt count on disk,
// and only then queues the continue, so a session that kills its process
// every time it resumes is tried MAX_TURN_RESUME_ATTEMPTS times and then
// stopped with a visible reason, never restarted forever.
//
// No daemon import: the daemon passes in how to probe a process, read the
// lifecycle and queue the message, so the tests drive the real pass.

import fs from "node:fs";
import path from "node:path";
import { MID_TURN_AGENT_STATUSES, authorizesTeardown, type LivenessVerdict } from "@codecast/shared/contracts";
import type { ReviveLifecycle } from "./midWorkRevive.js";

/** Resumes of one turn before codecast gives up on it. Codex app-server recovery shares it. */
export const MAX_TURN_RESUME_ATTEMPTS = 3;

/** How long a resume has to bring the process back before the pass may try again. */
export const RESUME_SETTLE_MS = 10 * 60 * 1000;

/** A claim whose session showed no life for this long died on work nobody expects to resume now. */
export const CLAIM_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** Resumes per pass: each one sends a whole context, and a reboot ends every claim at once. */
export const CLAIM_RESUMES_PER_PASS = 3;

export type TurnClaim = {
  sessionId: string;
  conversationId: string;
  /** When the turn started, ms. */
  claimedAt: number;
  /** Resumes already made for this turn. */
  attempts: number;
  /** When the last resume was queued, ms. */
  lastAttemptAt?: number;
};

/**
 * What a status does to the claim. Mid-turn statuses open it (a claim already
 * open keeps its attempts: the continue a resume sends is the same turn going
 * on). A session coming up ("connected", "starting", "resuming") or a session
 * boundary (SessionStart landing a resume at its prompt) is no turn ending, so
 * it leaves the claim alone; every other status is the turn's end.
 */
export function claimTransition(status: string, sessionBoundary?: boolean): "open" | "release" | "none" {
  if (MID_TURN_AGENT_STATUSES.has(status)) return "open";
  if (sessionBoundary || status === "connected" || status === "starting" || status === "resuming") return "none";
  return "release";
}

/** The ledger, one JSON file. Only the daemon writes it, and every write is atomic and synced. */
export class TurnClaimLedger {
  private readonly claims = new Map<string, TurnClaim>();
  /** A counter bumped by every mid-turn status, in memory only: a pass skips a claim that spoke while it looked. */
  private readonly touched = new Map<string, number>();
  private seq = 0;

  constructor(private readonly file: string) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, TurnClaim>;
      for (const [id, c] of Object.entries(saved ?? {})) {
        if (c && typeof c.conversationId === "string" && typeof c.claimedAt === "number") {
          this.claims.set(id, { ...c, sessionId: id, attempts: Number(c.attempts) || 0 });
        }
      }
    } catch {}
  }

  get(sessionId: string): TurnClaim | undefined {
    return this.claims.get(sessionId);
  }

  list(): TurnClaim[] {
    return [...this.claims.values()];
  }

  /** Compare two readings: a larger one means the session reported a mid-turn status in between. */
  touchMark(sessionId: string): number {
    return this.touched.get(sessionId) ?? 0;
  }

  /** Apply one status. Writes only when the claim opens or is released, so a tool call costs no disk. */
  apply(sessionId: string, conversationId: string, status: string, opts: { sessionBoundary?: boolean; at: number }): void {
    const t = claimTransition(status, opts.sessionBoundary);
    if (t === "open") this.open(sessionId, conversationId, opts.at);
    else if (t === "release") this.release(sessionId);
  }

  open(sessionId: string, conversationId: string, at: number): void {
    this.touched.set(sessionId, ++this.seq);
    const existing = this.claims.get(sessionId);
    if (existing && existing.conversationId === conversationId) return;
    this.claims.set(sessionId, { sessionId, conversationId, claimedAt: at, attempts: 0 });
    this.save();
  }

  release(sessionId: string): boolean {
    this.touched.delete(sessionId);
    if (!this.claims.delete(sessionId)) return false;
    this.save();
    return true;
  }

  /** Release every claim of a conversation: its session was stopped on purpose (a kill, an agent switch). */
  releaseConversation(conversationId: string): void {
    let changed = false;
    for (const [id, c] of this.claims) if (c.conversationId === conversationId) { this.claims.delete(id); changed = true; }
    if (changed) this.save();
  }

  /** Count a resume BEFORE it is queued: a crash between the two must still spend the attempt. */
  beginAttempt(sessionId: string, at: number): TurnClaim | undefined {
    const c = this.claims.get(sessionId);
    if (!c) return undefined;
    const next = { ...c, attempts: c.attempts + 1, lastAttemptAt: at };
    this.claims.set(sessionId, next);
    this.save();
    return next;
  }

  /** Put back a claim whose resume was never queued (the queue write failed). */
  restore(claim: TurnClaim): void {
    if (!this.claims.has(claim.sessionId)) return;
    this.claims.set(claim.sessionId, claim);
    this.save();
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(Object.fromEntries(this.claims)));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
  }
}

/** What the daemon found out about a claimed session. */
export type ClaimFacts = {
  /** Is the agent process (pane or SDK host) still there? */
  liveness: LivenessVerdict;
  /** The conversation now runs on another machine (a move); null when the owner lookup failed. */
  ownedElsewhere: boolean | null;
  /** null when the lookup failed: wait for the next pass. */
  lifecycle: ReviveLifecycle;
  /** The person stopped the turn (Escape, Ctrl+C), read from the transcript's tail. */
  interruptedByUser: boolean;
  /** The turn ended on a usage limit; the account recovery chain owns it. */
  limitParked: boolean;
  /** When the session last showed life (status, transcript, an agent it hosted), ms. */
  lastLifeAt: number;
};

export type ClaimDecision =
  | { action: "keep"; reason: string }
  | { action: "release"; reason: string }
  | { action: "fail"; reason: string }
  | { action: "resume" };

/** A resume was queued recently and may still be bringing the process back. */
export function resumeInFlight(claim: TurnClaim, now: number): boolean {
  return !!claim.lastAttemptAt && now - claim.lastAttemptAt < RESUME_SETTLE_MS;
}

export function claimDecision(claim: TurnClaim, f: ClaimFacts, now: number): ClaimDecision {
  if (resumeInFlight(claim, now)) return { action: "keep", reason: "resume-in-flight" };
  if (f.ownedElsewhere) return { action: "release", reason: "moved" };
  // Alive, or we could not tell: never start a second process beside one that may be running.
  if (!authorizesTeardown(f.liveness)) return { action: "keep", reason: f.liveness };
  if (f.ownedElsewhere === null || f.lifecycle === null) return { action: "keep", reason: "lookup-failed" };
  if (!f.lifecycle?.hideStateKnown) return { action: "release", reason: "lifecycle-unknown" };
  if (f.lifecycle.inboxKilledAt || f.lifecycle.inboxDismissedAt) return { action: "release", reason: "retired" };
  if (f.interruptedByUser) return { action: "release", reason: "interrupted" };
  if (f.limitParked) return { action: "release", reason: "limit-parked" };
  if (now - Math.max(f.lastLifeAt, claim.claimedAt, claim.lastAttemptAt ?? 0) > CLAIM_MAX_AGE_MS) return { action: "release", reason: "too-old" };
  if (claim.attempts >= MAX_TURN_RESUME_ATTEMPTS) return { action: "fail", reason: "attempts-spent" };
  return { action: "resume" };
}

/** The session error a turn that could not be continued shows. */
export function resumeExhaustedMessage(attempts: number): string {
  return `Codecast restarted this session ${attempts} times after its agent process died mid-turn, and it died again each time, so it stopped trying. The conversation is intact; send a message to continue.`;
}

export interface TurnClaimRecoveryDeps {
  ledger: TurnClaimLedger;
  now: () => number;
  inspect: (claim: TurnClaim) => Promise<ClaimFacts>;
  /** Queue the continue. False: this machine's recovery is off. Throws: try again next pass. */
  resume: (claim: TurnClaim) => Promise<boolean>;
  /** The claim was released without a resume. */
  settle: (claim: TurnClaim, reason: string) => void;
  /** Every attempt is spent: say so on the session. */
  fail: (claim: TurnClaim, message: string) => void;
  /** The machine's load governor; false holds the resume to a later pass. */
  admit?: (claim: TurnClaim) => boolean;
  /** Which claims a pass works first (a workflow station's hand before interactive sessions). */
  order?: (claims: TurnClaim[]) => Promise<TurnClaim[]>;
  log: (line: string) => void;
  perPass?: number;
}

/** Runs recovery passes one at a time; a request during a pass runs one more after it. */
export class TurnClaimRecovery {
  private running: Promise<void> | null = null;
  private again = false;

  constructor(private readonly deps: TurnClaimRecoveryDeps) {}

  request(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.pass().catch((err) => this.deps.log(`[turn-claims] pass failed: ${err instanceof Error ? err.message : String(err)}`));
      } while (this.again);
    })().finally(() => { this.running = null; });
    return this.running;
  }

  private async pass(): Promise<void> {
    const { ledger, log } = this.deps;
    const claims = this.deps.order ? await this.deps.order(ledger.list()) : ledger.list();
    let resumed = 0;
    for (const claim of claims) {
      const tag = `${claim.sessionId.slice(0, 8)} conv=${claim.conversationId.slice(0, 12)}`;
      try {
        if (resumeInFlight(claim, this.deps.now())) continue;
        const mark = ledger.touchMark(claim.sessionId);
        const facts = await this.deps.inspect(claim);
        // A status that landed while we looked (the session is alive and spoke), or a release.
        const current = ledger.get(claim.sessionId);
        if (!current || current.claimedAt !== claim.claimedAt || current.attempts !== claim.attempts) continue;
        if (ledger.touchMark(claim.sessionId) !== mark) continue;
        const now = this.deps.now();
        const d = claimDecision(current, facts, now);
        if (d.action === "keep") continue;
        if (d.action === "release") {
          ledger.release(claim.sessionId);
          log(`[turn-claims] released ${tag} without a resume: ${d.reason}`);
          this.deps.settle(current, d.reason);
          continue;
        }
        if (d.action === "fail") {
          ledger.release(claim.sessionId);
          log(`[turn-claims] ${tag} died mid-turn again after ${current.attempts} resumes; giving up`);
          this.deps.fail(current, resumeExhaustedMessage(current.attempts));
          continue;
        }
        if (resumed >= (this.deps.perPass ?? CLAIM_RESUMES_PER_PASS)) {
          log(`[turn-claims] resume of ${tag} deferred to the next pass`);
          continue;
        }
        if (this.deps.admit && !this.deps.admit(current)) continue;
        const attempt = ledger.beginAttempt(claim.sessionId, now)!;
        let queued: boolean;
        try {
          queued = await this.deps.resume(attempt);
        } catch (err) {
          ledger.restore(current);
          log(`[turn-claims] resume of ${tag} failed to queue (${err instanceof Error ? err.message : String(err)}); retrying next pass`);
          continue;
        }
        if (!queued) {
          ledger.release(claim.sessionId);
          log(`[turn-claims] released ${tag} without a resume: recovery is off on this machine`);
          this.deps.settle(current, "recovery-off");
          continue;
        }
        resumed++;
        log(`[turn-claims] ${tag} died mid-turn; resumed (attempt ${attempt.attempts} of ${MAX_TURN_RESUME_ATTEMPTS})`);
      } catch (err) {
        log(`[turn-claims] ${tag}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
