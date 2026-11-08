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
import { REVIVE_BUDGET, reviveRefusal, type ReviveLifecycle } from "./midWorkRevive.js";

/** Resumes of one turn before codecast gives up on it. Codex app-server recovery shares it. */
export const MAX_TURN_RESUME_ATTEMPTS = 3;

/** A claim whose session showed no life for this long died on work nobody expects to resume now. */
export const CLAIM_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** How long a queued resume has to bring its process up and report before it counts as a failed attempt. */
export const RESUME_START_MS = 30 * 60 * 1000;

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
  /** When the session first reported anything after that resume, ms: the resumed process started. */
  heardAt?: number;
};

/**
 * What a status does to the claim. Mid-turn statuses open it (a claim already
 * open keeps its attempts: the continue a resume sends is the same turn going
 * on). A compaction neither opens nor ends one: an automatic one runs inside a
 * turn that is already claimed, and a manual /compact is no turn (it ends on a
 * boundary, with no Stop). A session coming up ("connected", "starting",
 * "resuming") or a session boundary (SessionStart landing a resume at its
 * prompt) is no turn ending either; every other status is the turn's end.
 */
export function claimTransition(status: string, sessionBoundary?: boolean): "open" | "release" | "none" {
  if (status === "compacting") return "none";
  if (MID_TURN_AGENT_STATUSES.has(status)) return "open";
  if (sessionBoundary || status === "connected" || status === "starting" || status === "resuming") return "none";
  return "release";
}

/** The ledger, one JSON file. Only the daemon writes it, and every write is atomic and synced. */
/** How long a release mark outlives its claim: the retention of an unfinished status file, which could otherwise reopen it. */
const RELEASE_MARK_TTL_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * The ledger, one JSON file. Only the daemon writes it, and every write is
 * atomic and synced. Beside the claims it keeps when each session's claim was
 * last released: a status no newer than that (a status file a kill left at
 * "working", a spool replayed late) never reopens it.
 */
export class TurnClaimLedger {
  private readonly claims = new Map<string, TurnClaim>();
  private readonly released = new Map<string, number>();
  /** A counter bumped by every status, in memory only: a pass skips a claim whose session spoke while it looked. */
  private readonly touched = new Map<string, number>();
  private seq = 0;

  constructor(private readonly file: string, private readonly clock: () => number = Date.now) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8")) as { claims?: Record<string, TurnClaim>; released?: Record<string, number> };
      for (const [id, c] of Object.entries(saved?.claims ?? {})) {
        if (c && typeof c.conversationId === "string" && typeof c.claimedAt === "number") {
          this.claims.set(id, { ...c, sessionId: id, attempts: Number(c.attempts) || 0 });
        }
      }
      for (const [id, at] of Object.entries(saved?.released ?? {})) if (typeof at === "number") this.released.set(id, at);
    } catch {}
  }

  get(sessionId: string): TurnClaim | undefined {
    return this.claims.get(sessionId);
  }

  list(): TurnClaim[] {
    return [...this.claims.values()];
  }

  /** Compare two readings: a change means the session reported a status in between. */
  touchMark(sessionId: string): number {
    return this.touched.get(sessionId) ?? 0;
  }

  /**
   * Apply one status, timed `at` (ms). Writes only when a claim opens, is
   * released, or first hears from a resumed process, so a tool call costs no disk.
   */
  apply(sessionId: string, conversationId: string, status: string, opts: { sessionBoundary?: boolean; at: number }): void {
    this.touched.set(sessionId, ++this.seq);
    // A conversation runs one session at a time: a status from another one (a
    // /clear, an SDK session that moved on) means the old session's turn is not running in it.
    let changed = false;
    for (const [id, c] of this.claims) {
      if (c.conversationId === conversationId && id !== sessionId) changed = this.drop(id, opts.at) || changed;
    }
    const c = this.claims.get(sessionId);
    // The first status after a resume: the resumed process is up. Statuses a
    // second early still count, since status times are whole seconds.
    const resumeLanded = !!c?.lastAttemptAt && !heardSince(c) && opts.at >= c.lastAttemptAt - 1000;
    if (resumeLanded) {
      this.claims.set(sessionId, { ...c!, heardAt: opts.at });
      changed = true;
    }
    const t = claimTransition(status, opts.sessionBoundary);
    // A boundary is the resume landing at its prompt only when it is that first
    // status; any other boundary idle ends what was claimed (an SDK turn whose
    // session id changed, a person's own resume at the prompt).
    if (t === "open") changed = this.put(sessionId, conversationId, opts.at) || changed;
    else if (t === "release" || (opts.sessionBoundary && status === "idle" && !resumeLanded)) changed = this.drop(sessionId, opts.at) || changed;
    if (changed) this.save();
  }

  /** Open a claim from a status file the watchdog found (a status from before the ledger). */
  open(sessionId: string, conversationId: string, at: number): void {
    this.touched.set(sessionId, ++this.seq);
    if (this.put(sessionId, conversationId, at)) this.save();
  }

  private put(sessionId: string, conversationId: string, at: number): boolean {
    const existing = this.claims.get(sessionId);
    if (existing && existing.conversationId === conversationId) return false;
    if (at <= (this.released.get(sessionId) ?? 0)) return false;
    this.claims.set(sessionId, { sessionId, conversationId, claimedAt: at, attempts: 0 });
    return true;
  }

  private drop(sessionId: string, at: number): boolean {
    if (!this.claims.delete(sessionId)) return false;
    this.released.set(sessionId, Math.max(at, this.released.get(sessionId) ?? 0));
    return true;
  }

  release(sessionId: string): boolean {
    this.touched.delete(sessionId);
    if (!this.drop(sessionId, this.clock())) return false;
    this.save();
    return true;
  }

  /** Release every claim of a conversation: it was stopped on purpose (a kill, an agent switch, a restart, a move). */
  releaseConversation(conversationId: string): void {
    let changed = false;
    const now = this.clock();
    for (const [id, c] of this.claims) if (c.conversationId === conversationId) changed = this.drop(id, now) || changed;
    if (changed) this.save();
  }

  /**
   * Count a resume BEFORE it is queued: a crash between the two, or a queue
   * call that timed out after the server stored the message, still spends it.
   */
  beginAttempt(sessionId: string, at: number): TurnClaim | undefined {
    const c = this.claims.get(sessionId);
    if (!c) return undefined;
    const next: TurnClaim = { ...c, attempts: c.attempts + 1, lastAttemptAt: at, heardAt: undefined };
    this.claims.set(sessionId, next);
    this.save();
    return next;
  }

  private save(): void {
    const now = this.clock();
    for (const [id, at] of this.released) if (now - at > RELEASE_MARK_TTL_MS) this.released.delete(id);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
      fs.writeSync(fd, JSON.stringify({ claims: Object.fromEntries(this.claims), released: Object.fromEntries(this.released) }));
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
  /** Revives of this session in the shared budget window, across turns (midWorkRevive.recentRevives). */
  recentRevives: number;
};

export type ClaimDecision =
  | { action: "keep"; reason: string }
  | { action: "release"; reason: string }
  | { action: "fail"; reason: string }
  | { action: "resume" };

function heardSince(c: TurnClaim): boolean {
  return !!c.lastAttemptAt && (c.heardAt ?? 0) >= c.lastAttemptAt - 1000;
}

/**
 * The last resume has not brought a process up yet. Its continue sits in the
 * conversation's queue, and delivery retries it on its own (through a load
 * hold, a slow server), so another continue would only stack a second message
 * behind it. The next attempt waits until the resumed process has spoken and
 * died again, or until RESUME_START_MS passed without a word: then the resume
 * itself died (before its first hook) and the attempt counts as spent.
 */
export function resumeInFlight(claim: TurnClaim, now: number): boolean {
  return !!claim.lastAttemptAt && !heardSince(claim) && now - claim.lastAttemptAt < RESUME_START_MS;
}

export function claimDecision(claim: TurnClaim, f: ClaimFacts, now: number): ClaimDecision {
  if (resumeInFlight(claim, now)) return { action: "keep", reason: "resume-in-flight" };
  if (f.ownedElsewhere) return { action: "release", reason: "moved" };
  // Alive, or we could not tell: never start a second process beside one that may be running.
  if (!authorizesTeardown(f.liveness)) return { action: "keep", reason: f.liveness };
  if (f.ownedElsewhere === null || f.lifecycle === null) return { action: "keep", reason: "lookup-failed" };
  const refusal = reviveRefusal(f);
  if (refusal) return { action: "release", reason: refusal };
  // Old: nobody expects it to resume now. After a resume that never came back, say so on the session.
  if (now - Math.max(f.lastLifeAt, claim.claimedAt, claim.lastAttemptAt ?? 0) > CLAIM_MAX_AGE_MS) return claim.attempts ? { action: "fail", reason: "attempts-spent" } : { action: "release", reason: "too-old" };
  // Per turn, and across turns: a session whose resumed turns end and whose next
  // turn kills it again resets the turn's count every time.
  if (claim.attempts >= MAX_TURN_RESUME_ATTEMPTS || f.recentRevives >= REVIVE_BUDGET) return { action: "fail", reason: "attempts-spent" };
  return { action: "resume" };
}

/** The session error a turn that could not be continued shows. */
export function resumeExhaustedMessage(attempts: number): string {
  return `Codecast restarted this session ${attempts} ${attempts === 1 ? "time" : "times"} after its agent process died, and it did not come back to finish, so it stopped trying. The conversation is intact; send a message to continue.`;
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
          log(`[turn-claims] ${tag} died mid-turn again after ${Math.max(current.attempts, facts.recentRevives)} resumes; giving up`);
          this.deps.fail(current, resumeExhaustedMessage(Math.max(current.attempts, facts.recentRevives)));
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
          // The server may have stored it before the call failed: the attempt
          // stays spent and in flight rather than risk a second continue.
          log(`[turn-claims] resume of ${tag} may not have queued (${err instanceof Error ? err.message : String(err)}); counted, retried after ${RESUME_START_MS / 60_000} min if nothing comes up`);
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
