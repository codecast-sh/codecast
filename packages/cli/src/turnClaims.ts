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
import type { PendingMessageOutcome } from "./tmuxDeliveryJournal.js";
import { REVIVE_BUDGET, REVIVE_BUDGET_WINDOW_MS, retiredByPerson, reviveRefusal, turnEndedRefusal, type ReviveLifecycle } from "./midWorkRevive.js";
import { writeFileAtomic } from "./fsAtomic.js";

/** Resumes of one turn before codecast gives up on it. Codex app-server recovery shares it. */
export const MAX_TURN_RESUME_ATTEMPTS = 3;

/**
 * A claim whose session showed no life for this long died on work nobody
 * expects to resume now. A day, so a machine that died overnight still
 * continues its turns in the morning.
 */
export const CLAIM_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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
  /** The queued continue's message id, so a pass can ask whether it was delivered yet. */
  continueId?: string;
  /** When the resumed session took its continue (its first prompt after the resume), ms. */
  continuedAt?: number;
};

/**
 * What a status does to the claim. Mid-turn statuses open it (a claim already
 * open keeps its attempts: the continue a resume sends is the same turn going
 * on). A compaction neither opens nor ends one: an automatic one runs inside a
 * turn that is already claimed, and a manual /compact is no turn (it ends on a
 * boundary, with no Stop). A session coming up ("connected", "starting",
 * "resuming"), a session boundary (handled by the ledger), and a bare idle
 * with no turn stamp (Claude's idle_prompt, a resumed session waiting at its
 * prompt for the continue) end nothing. Every other status is the turn's end:
 * the Stop's settle (idle, waiting, a verdict), stamped `turnEnded`.
 */
export function claimTransition(status: string, opts: { sessionBoundary?: boolean; turnEnded?: boolean } = {}): "open" | "release" | "none" {
  if (status === "compacting") return "none";
  if (MID_TURN_AGENT_STATUSES.has(status)) return "open";
  if (opts.sessionBoundary || status === "connected" || status === "starting" || status === "resuming") return "none";
  if (status === "idle" && !opts.turnEnded) return "none";
  return "release";
}

/** How long a release mark outlives its claim: the retention of an unfinished status file, which could otherwise reopen it. */
const RELEASE_MARK_TTL_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * The ledger, one JSON file. Only the daemon writes it, and every write is
 * atomic. Beside the claims it keeps when each session's claim was
 * last released: a status no newer than that (a status file a kill left at
 * "working", a spool replayed late) never reopens it.
 */
export class TurnClaimLedger {
  private readonly claims = new Map<string, TurnClaim>();
  private readonly released = new Map<string, number>();
  /** A counter bumped by every status, in memory only: a pass skips a claim whose session spoke while it looked. */
  private readonly touched = new Map<string, number>();
  private seq = 0;

  /**
   * `withdraw` cancels a claim's queued continue whenever the claim ends or a
   * newer attempt supersedes it. The server puts a stalled one (failed,
   * undeliverable) back once the session is up, where it would arrive as a
   * restart notice in a session with nothing to continue. Cancelling one
   * already delivered changes nothing.
   */
  constructor(private readonly file: string, private readonly clock: () => number = Date.now, private readonly withdraw: (continueId: string) => void = () => {}) {
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
  apply(sessionId: string, conversationId: string, status: string, opts: { sessionBoundary?: boolean; turnEnded?: boolean; at: number }): void {
    this.touched.set(sessionId, ++this.seq);
    // A conversation runs one session at a time: a status from another one (a
    // /clear, an SDK session that moved on) means the old session's turn is not running in it.
    let changed = false;
    // Only a newer status: a file replayed at boot from before the switch is not news.
    for (const [id, c] of this.claims) {
      if (c.conversationId !== conversationId || id === sessionId || opts.at < c.claimedAt) continue;
      // A resume in flight that came up under a new session id (an SDK
      // session that moved on, a delivery restart) is the same turn: its
      // attempts go with it, or a process that dies on every resume would
      // leave no claim behind once it first spoke.
      const carried = awaitingResume(c) && !this.claims.has(sessionId);
      if (carried) this.claims.set(sessionId, { ...c, sessionId });
      changed = this.drop(id, opts.at, { carried }) || changed;
    }
    const c = this.claims.get(sessionId);
    // The first status after a resume: the resumed process is up. Statuses a
    // second early still count, since status times are whole seconds.
    const resumeLanded = !!c?.lastAttemptAt && !heardSince(c) && opts.at >= c.lastAttemptAt - 1000;
    if (resumeLanded) {
      this.claims.set(sessionId, { ...c!, heardAt: opts.at });
      changed = true;
    }
    // A prompt on an open claim: the first one after a resume is its continue,
    // the same turn going on. Any other is a new turn (after an Escape left the
    // claim open), which starts with its own attempts.
    if (status === "thinking") {
      const cur = this.claims.get(sessionId);
      if (cur?.lastAttemptAt && heardSince(cur) && !cur.continuedAt) {
        this.claims.set(sessionId, { ...cur, continuedAt: opts.at });
        changed = true;
      } else if (cur && cur.conversationId === conversationId && !awaitingResume(cur)) {
        if (cur.continueId) this.withdraw(cur.continueId);
        this.claims.set(sessionId, { sessionId, conversationId, claimedAt: opts.at, attempts: 0 });
        changed = true;
      }
    }
    const t = claimTransition(status, opts);
    // A boundary is the resume landing at its prompt only when it is that first
    // status; any other boundary idle ends what was claimed (an SDK turn whose
    // session id changed, a person's own resume at the prompt).
    if (t === "open") changed = this.put(sessionId, conversationId, opts.at) || changed;
    else if (t === "release" || (opts.sessionBoundary && status === "idle" && !resumeLanded)) changed = this.drop(sessionId, opts.at) || changed;
    if (changed) this.save();
  }

  /**
   * Open a claim from a status file the watchdog found (a status from before
   * the ledger). True when the session holds a claim afterwards; false when a
   * later release refuses the status.
   */
  open(sessionId: string, conversationId: string, at: number): boolean {
    // No touch: a file re-read is not the session speaking.
    // A file is stale evidence: it must be strictly newer than a release.
    if (this.put(sessionId, conversationId, at, { stale: true })) this.save();
    return this.claims.has(sessionId);
  }

  private put(sessionId: string, conversationId: string, at: number, opts: { stale?: boolean } = {}): boolean {
    const existing = this.claims.get(sessionId);
    if (existing && existing.conversationId === conversationId) return false;
    const releasedAt = this.released.get(sessionId);
    // A live status in the same second as a release is the next turn starting;
    // a status file from that second is the dying process's last word.
    if (releasedAt !== undefined && (opts.stale ? at <= releasedAt : at < releasedAt)) return false;
    // A status older than the age bound (a status file left from days ago)
    // could only open a claim that is already too old to continue.
    if (this.clock() - at > CLAIM_MAX_AGE_MS) return false;
    this.claims.set(sessionId, { sessionId, conversationId, claimedAt: at, attempts: 0 });
    return true;
  }

  private drop(sessionId: string, at: number, opts: { carried?: boolean } = {}): boolean {
    const c = this.claims.get(sessionId);
    if (!c || !this.claims.delete(sessionId)) return false;
    if (c.continueId && !opts.carried) this.withdraw(c.continueId);
    this.released.set(sessionId, Math.max(at, this.released.get(sessionId) ?? 0));
    return true;
  }

  /** A release that is not a status, timed in the whole seconds statuses carry, so the next status of the same second still opens. */
  private nowMark(): number {
    return Math.floor(this.clock() / 1000) * 1000;
  }

  release(sessionId: string): boolean {
    this.touched.delete(sessionId);
    if (!this.drop(sessionId, this.nowMark())) return false;
    this.save();
    return true;
  }

  /** Release every claim of a conversation: it was stopped on purpose (a kill, an agent switch, a restart, a move). */
  releaseConversation(conversationId: string): void {
    let changed = false;
    const now = this.nowMark();
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
    if (c.continueId) this.withdraw(c.continueId);
    const next: TurnClaim = { ...c, attempts: c.attempts + 1, lastAttemptAt: at, heardAt: undefined, continueId: undefined, continuedAt: undefined };
    this.claims.set(sessionId, next);
    // The one write the cap rests on, so it reaches the disk before the continue is queued.
    this.save({ sync: true });
    return next;
  }

  /** The id of the continue an attempt queued. */
  setContinue(sessionId: string, continueId: string): void {
    const c = this.claims.get(sessionId);
    if (!c) return;
    this.claims.set(sessionId, { ...c, continueId });
    this.save();
  }

  /**
   * Atomic always. Synced only when asked: opens and releases run on the
   * daemon's loop twice a turn per session, and a claim lost to a power cut
   * costs one resume, while a lost attempt count could loop.
   */
  private save(opts: { sync?: boolean } = {}): void {
    const now = this.clock();
    for (const [id, at] of this.released) if (now - at > RELEASE_MARK_TTL_MS) this.released.delete(id);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, JSON.stringify({ claims: Object.fromEntries(this.claims), released: Object.fromEntries(this.released) }), opts);
  }
}

/** What the daemon found out about a claimed session. */
export type ClaimFacts = {
  /** Is the agent process (pane or SDK host) still there? */
  liveness: LivenessVerdict;
  /** The conversation now runs on another machine (a move); null when the owner lookup failed. */
  ownedElsewhere: boolean | null;
  /** null: no such conversation. undefined, or hide state unknown: the lookup failed, wait for the next pass. */
  lifecycle: ReviveLifecycle | undefined;
  /** The person stopped the turn (Escape, Ctrl+C), read from the transcript's tail. */
  interruptedByUser: boolean;
  /** The turn ended on a usage limit; the account recovery chain owns it. */
  limitParked: boolean;
  /** The turn ended on another API error: it did end (StopFailure, no Stop), and a continue would fail the same way. */
  turnFailed?: boolean;
  /** The transcript's last turn ended normally: a Stop the ledger never saw. */
  turnFinished?: boolean;
  /** When the session last showed life (status, transcript, an agent it hosted), ms. */
  lastLifeAt: number;
  /** Revives of this session in the shared budget window, across turns (midWorkRevive.recentRevives). */
  recentRevives: number;
  /**
   * Where the last continue stands on the server: still queued, landed
   * (delivered, or ended undeliverable), cancelled by a person, or unknown (no
   * id, a failed lookup, or not asked because the process already spoke).
   */
  continueState: PendingMessageOutcome | "unknown";
  /** A message already waits for the session (a person's, or this claim's own continue): delivery brings it back. */
  messagePending?: boolean;
};

export type ClaimDecision =
  | { action: "keep"; reason: string }
  | { action: "release"; reason: string }
  | { action: "fail"; reason: string }
  | { action: "resume" };

function heardSince(c: TurnClaim): boolean {
  return !!c.lastAttemptAt && (c.heardAt ?? 0) >= c.lastAttemptAt - 1000;
}

/** A resume was queued and its process has not reported anything since. */
export function awaitingResume(claim: TurnClaim): boolean {
  return !!claim.lastAttemptAt && !heardSince(claim);
}

/**
 * The last resume may still bring its process up. A continue the server still
 * holds is in flight however long delivery takes (a load hold, a slow server):
 * another would only stack a second message behind it. Once it landed, or
 * when nobody can say, the process gets RESUME_START_MS to report; silence
 * past that means the resume died before its first hook, and the attempt is spent.
 */
export function continueInFlight(claim: TurnClaim, now: number, continueState: ClaimFacts["continueState"] = "unknown"): boolean {
  if (!awaitingResume(claim) || continueState === "cancelled") return false;
  return continueState === "open" || now - claim.lastAttemptAt! < RESUME_START_MS;
}

export function claimDecision(claim: TurnClaim, f: ClaimFacts, now: number): ClaimDecision {
  // Moved first: the destination continues it, and the ledger withdraws this machine's continue.
  if (f.ownedElsewhere) return { action: "release", reason: "moved" };
  if (continueInFlight(claim, now, f.continueState) && now - claim.lastAttemptAt! < CLAIM_MAX_AGE_MS) return { action: "keep", reason: "resume-in-flight" };
  // Alive, or we could not tell: never start a second process beside one that
  // may be running, and never end its claim (a pane idle at its prompt after
  // an Escape, a permission prompt left open over a weekend).
  if (!authorizesTeardown(f.liveness)) return { action: "keep", reason: f.liveness };
  // The transcript says the turn already ended (an Escape, an API error): no
  // turn to continue, at any age. Read locally, so it comes before the age check.
  const ended = turnEndedRefusal(f) ?? (f.turnFinished ? "turn-finished" : null);
  if (ended) return { action: "release", reason: ended };
  // A lookup that did answer settles it quietly at any age: the conversation
  // is gone, or a person killed or dismissed it.
  if (f.lifecycle === null) return { action: "release", reason: "conversation-gone" };
  if (retiredByPerson(f.lifecycle)) return { action: "release", reason: "retired" };
  // Gone, and old: nobody expects it to resume now. Ahead of the remaining
  // lookups, so a claim whose lookups keep failing still ends, and visibly:
  // the turn did not finish and nothing will continue it.
  if (now - Math.max(f.lastLifeAt, claim.claimedAt, claim.lastAttemptAt ?? 0) > CLAIM_MAX_AGE_MS) return { action: "fail", reason: claim.attempts >= MAX_TURN_RESUME_ATTEMPTS || claim.continuedAt ? "attempts-spent" : "too-old" };
  // A message already waiting brings the session back through delivery:
  // another continue would stack behind it. After the age bound, so a message
  // stuck in the queue cannot hold the claim forever.
  if (f.messagePending) return { action: "keep", reason: "message-pending" };
  // A person cancelled the continue: they do not want the turn back.
  if (f.continueState === "cancelled") return { action: "release", reason: "continue-cancelled" };
  // A blip is not a decision: the legacy fallback answers without hide state.
  if (f.ownedElsewhere === null || f.lifecycle === undefined || !f.lifecycle.hideStateKnown) return { action: "keep", reason: "lookup-failed" };
  const refusal = reviveRefusal(f);
  if (refusal) return { action: "release", reason: refusal };
  // Per turn, and across turns: a session whose resumed turns end and whose next
  // turn kills it again resets the turn's count every time.
  if (claim.attempts >= MAX_TURN_RESUME_ATTEMPTS) return { action: "fail", reason: "attempts-spent" };
  if (f.recentRevives >= REVIVE_BUDGET) return { action: "fail", reason: "budget-spent" };
  return { action: "resume" };
}

/** The session error when the conversation's resumes in the budget window ran out, across turns. */
export function resumeBudgetSpentMessage(revives: number, windowHours: number): string {
  return `Codecast restarted this session's agent ${revives} times in the last ${windowHours} hours after it died, so it did not restart it again. The conversation is intact; send a message to continue.`;
}

/** The session error a turn left too long to continue shows. */
export function resumeTooOldMessage(): string {
  return `This session's agent process died mid-turn more than ${CLAIM_MAX_AGE_MS / 3_600_000} hours ago, so codecast did not restart it. The conversation is intact; send a message to continue.`;
}

/** The session error a turn that could not be continued shows. */
export function resumeExhaustedMessage(attempts: number): string {
  return `Codecast restarted this session ${attempts} ${attempts === 1 ? "time" : "times"} after its agent process died, and it did not come back to finish, so it stopped trying. The conversation is intact; send a message to continue.`;
}

export interface TurnClaimRecoveryDeps {
  ledger: TurnClaimLedger;
  now: () => number;
  inspect: (claim: TurnClaim) => Promise<ClaimFacts>;
  /** Queue the continue; its message id. Null: this machine's recovery is off. Throws: retried after RESUME_START_MS. */
  resume: (claim: TurnClaim) => Promise<string | null>;
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
        if (continueInFlight(claim, this.deps.now())) continue;
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
          log(`[turn-claims] ${tag} died mid-turn; giving up (${d.reason}, ${current.attempts} resumes this turn, ${facts.recentRevives} in the window)`);
          this.deps.fail(current, d.reason === "too-old" ? resumeTooOldMessage()
            : d.reason === "budget-spent" ? resumeBudgetSpentMessage(facts.recentRevives, REVIVE_BUDGET_WINDOW_MS / 3_600_000)
            : resumeExhaustedMessage(current.attempts));
          continue;
        }
        if (resumed >= (this.deps.perPass ?? CLAIM_RESUMES_PER_PASS)) {
          log(`[turn-claims] resume of ${tag} deferred to the next pass`);
          continue;
        }
        if (this.deps.admit && !this.deps.admit(current)) continue;
        const attempt = ledger.beginAttempt(claim.sessionId, now)!;
        let queued: string | null;
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
        ledger.setContinue(claim.sessionId, queued);
        resumed++;
        log(`[turn-claims] ${tag} died mid-turn; resumed (attempt ${attempt.attempts} of ${MAX_TURN_RESUME_ATTEMPTS})`);
      } catch (err) {
        log(`[turn-claims] ${tag}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
