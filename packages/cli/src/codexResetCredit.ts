// Spending a Codex rate-limit reset credit (ct-49529).
//
// A ChatGPT account occasionally earns a "reset credit": redeem one and the
// account's rate-limit windows go back to zero immediately. codexUsage.ts has
// been reading the balance into `reset_credits` since the multi-account work,
// but nothing could ever spend it. Two endpoints do:
//
//   GET  /backend-api/wham/rate-limit-reset-credits          → the balance
//   POST /backend-api/wham/rate-limit-reset-credits/consume  → spend one
//
// The POST body carries a `redeem_request_id`, which is the whole reason this
// file is more than two fetches. That id is the provider's idempotency key: the
// same id twice spends one credit, two different ids spend two. So a crash, a
// timeout, or a retry between the request and its answer must NOT mint a second
// key — it must replay the first. That needs a record that outlives the process,
// hence the ledger below.
//
// The second hazard is staler than that. A human confirms "spend a credit" while
// looking at a balance and a set of windows; by the time they hit enter the
// account may have earned, lost, or already spent one, and the windows may have
// rolled on their own — spending then buys nothing. So every authorization
// carries an OFFER REVISION: a hash of the credit rows and the usage windows it
// was granted against. The redeem re-reads the offer and refuses before the
// provider call if the revision moved. Same idea as a compare-and-swap token.
//
// Modelled on Orca's codex-reset-credit-client.ts / codex-reset-credit-ledger.ts
// / codex-reset-credit-scope.ts, collapsed to what a CLI with one machine-local
// account store needs (no runtime targets, no WSL distros, no mutation queue).

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import { atomicWriteFile } from "./atomicWrite.js";
import { codexBackendAuthHeaders, CodexUsageHttpError } from "./codexBackendUsage.js";
import type { CodexUsageWindow } from "./codexUsage.js";

export const CODEX_RESET_CREDITS_URL =
  "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
export const CODEX_RESET_CREDITS_CONSUME_URL = `${CODEX_RESET_CREDITS_URL}/consume`;

const FETCH_TIMEOUT_MS = 15_000;
// The redeem mutates the account, so it gets a longer leash than a read: a
// client-side abort here leaves an attempt whose outcome nobody knows, and the
// only cure for that is replaying the same key later.
const REDEEM_TIMEOUT_MS = 30_000;

/** What the provider says a redeem did. `reset` is the only one that spent a
 *  credit; the other three are all "nothing happened, and here is why". */
export type ResetCreditOutcome = "reset" | "nothing_to_reset" | "no_credit" | "already_redeemed";

const OUTCOMES: readonly string[] = ["reset", "nothing_to_reset", "no_credit", "already_redeemed"];

export interface ResetCreditRow {
  status: string; // "available", "redeemed", "expired", …
  expires_at: number | null; // epoch ms
  granted_at: number | null; // epoch ms
}

export interface ResetCreditOffer {
  available: number;
  total_earned?: number;
  next_expires_at: number | null; // soonest expiry among the available credits
  credits: ResetCreditRow[];
}

// ---------------------------------------------------------------------------
// Reading the offer
// ---------------------------------------------------------------------------

/** Credit timestamps arrive as ISO strings, epoch seconds, or epoch ms
 * depending on the field. Normalize to epoch ms; null when unreadable. */
function creditTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Parse a rate-limit-reset-credits body. Null when the body is not a credits
 * reading at all — a redirect to a sign-in page, or a shape we don't know. */
export function parseResetCreditsResponse(body: any): ResetCreditOffer | null {
  if (!body || typeof body !== "object") return null;
  const credits: ResetCreditRow[] = Array.isArray(body.credits)
    ? body.credits.map((row: any) => ({
        status: typeof row?.status === "string" ? row.status.toLowerCase() : "unknown",
        expires_at: creditTimestamp(row?.expires_at),
        granted_at: creditTimestamp(row?.granted_at),
      }))
    : [];
  // The count is authoritative when the endpoint sends it; counting the rows is
  // the fallback. Neither present means this wasn't a credits body.
  const counted = Array.isArray(body.credits)
    ? credits.filter((row) => row.status === "available").length
    : null;
  const available =
    typeof body.available_count === "number" && Number.isFinite(body.available_count)
      ? Math.max(0, Math.floor(body.available_count))
      : counted;
  if (available === null) return null;
  const expiries = credits
    .filter((row) => row.status === "available" && row.expires_at !== null)
    .map((row) => row.expires_at as number)
    .sort((a, b) => a - b);
  return {
    available,
    ...(typeof body.total_earned_count === "number" && Number.isFinite(body.total_earned_count)
      ? { total_earned: Math.max(0, Math.floor(body.total_earned_count)) }
      : {}),
    next_expires_at: expiries[0] ?? null,
    credits,
  };
}

/**
 * The account's current credit balance, read through the auth.json in
 * `codexHomeDir` — the real ~/.codex for the active login, a profile's snapshot
 * dir for a dormant one, exactly like every other per-account probe.
 *
 * Null when that home holds no usable token. Throws CodexUsageHttpError when the
 * endpoint refused, so a caller can tell "no credits" from "couldn't ask".
 */
export async function fetchCodexResetCredits(
  codexHomeDir: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<ResetCreditOffer | null> {
  const headers = codexBackendAuthHeaders(codexHomeDir);
  if (!headers) return null;
  const resp = await (opts.fetchImpl ?? fetch)(CODEX_RESET_CREDITS_URL, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new CodexUsageHttpError(resp.status);
  return parseResetCreditsResponse(await resp.json());
}

// ---------------------------------------------------------------------------
// The offer revision
// ---------------------------------------------------------------------------

export interface OfferWindows {
  session?: CodexUsageWindow;
  weekly?: CodexUsageWindow;
}

function windowRevision(window: CodexUsageWindow | undefined): unknown {
  return window ? [window.percent, window.resets_at ?? null] : null;
}

/**
 * An opaque token for "the state of this account that made spending a credit
 * look worthwhile": the balance, every credit row, and the usage windows the
 * credit would reset. Any of those moving invalidates an authorization granted
 * against the old reading, which is what stops a confirmation the human gave
 * ten minutes ago from spending a credit the account no longer has spare.
 *
 * Hashed rather than stored raw so the ledger stays small and fixed-width no
 * matter how many credit rows an account accumulates.
 */
export function offerRevision(offer: ResetCreditOffer, windows: OfferWindows = {}): string {
  const rows = offer.credits
    .map((row) => [row.status, row.expires_at, row.granted_at] as const)
    .map((row) => JSON.stringify(row))
    .sort();
  const canonical = JSON.stringify([
    offer.available,
    offer.total_earned ?? null,
    offer.next_expires_at,
    rows,
    windowRevision(windows.session),
    windowRevision(windows.weekly),
  ]);
  return `v1:${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

// ---------------------------------------------------------------------------
// The durable attempt ledger
// ---------------------------------------------------------------------------

export interface ResetCreditAttempt {
  /** The `redeem_request_id` sent to the provider. Replayed, never reminted. */
  key: string;
  /** Account identity — account_id, email fallback. NOT the profile name: a
   *  machine-local alias can be renamed, and the credit belongs to the account. */
  account: string;
  offer_revision: string;
  /** `pending` means the provider was called and the answer is unknown. Only
   *  the original key may resolve it. */
  state: "pending" | "settled";
  outcome?: ResetCreditOutcome;
  at: number;
}

export interface ResetCreditLedger {
  version: 1;
  attempts: ResetCreditAttempt[];
}

// Enough history that every offer an account could plausibly re-present is still
// remembered, small enough that the file stays a few KB.
const MAX_ATTEMPTS = 200;

export function resetCreditLedgerPath(): string {
  const dir = process.env.CODECAST_DIR || path.join(process.env.HOME || os.homedir(), ".codecast");
  return path.join(dir, "codex-reset-credits.json");
}

export function readResetCreditLedger(): ResetCreditLedger {
  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(resetCreditLedgerPath(), "utf-8"));
  } catch {
    return { version: 1, attempts: [] };
  }
  // Why: a corrupt ledger must fail CLOSED, not silently reset to empty — an
  // empty ledger would remint keys for attempts whose outcome is unknown and
  // spend a second credit (ct-49529).
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.attempts)) {
    throw new Error(`Codex reset-credit ledger is corrupt: ${resetCreditLedgerPath()}`);
  }
  const attempts: ResetCreditAttempt[] = parsed.attempts.filter(
    (a: any) =>
      a &&
      typeof a.key === "string" &&
      typeof a.account === "string" &&
      typeof a.offer_revision === "string" &&
      (a.state === "pending" || a.state === "settled") &&
      (a.outcome === undefined || OUTCOMES.includes(a.outcome)),
  );
  if (attempts.length !== parsed.attempts.length) {
    throw new Error(`Codex reset-credit ledger is corrupt: ${resetCreditLedgerPath()}`);
  }
  return { version: 1, attempts };
}

export function writeResetCreditLedger(ledger: ResetCreditLedger): void {
  const attempts = ledger.attempts.slice(-MAX_ATTEMPTS);
  atomicWriteFile(resetCreditLedgerPath(), JSON.stringify({ version: 1, attempts }, null, 2), {
    mode: 0o600,
  });
}

/** The attempt whose outcome this account never learned. It may only be
 *  resolved by replaying its own key, so it blocks every new authorization. */
export function pendingAttempt(
  ledger: ResetCreditLedger,
  account: string,
): ResetCreditAttempt | undefined {
  return ledger.attempts.find((a) => a.account === account && a.state === "pending");
}

/** A settled attempt against this exact offer — proof the offer was already
 *  spent, and the reason a repeat confirmation is refused before the call. */
export function settledAttempt(
  ledger: ResetCreditLedger,
  account: string,
  revision: string,
): ResetCreditAttempt | undefined {
  return ledger.attempts.find(
    (a) => a.account === account && a.offer_revision === revision && a.state === "settled",
  );
}

function upsert(ledger: ResetCreditLedger, attempt: ResetCreditAttempt): ResetCreditLedger {
  const attempts = [...ledger.attempts];
  const index = attempts.findIndex((a) => a.key === attempt.key);
  if (index === -1) attempts.push(attempt);
  else attempts[index] = attempt;
  return { version: 1, attempts };
}

// ---------------------------------------------------------------------------
// Redeeming
// ---------------------------------------------------------------------------

/**
 * The provider call itself. Throws on a refusal or an unrecognized outcome code
 * — an unknown code must never be reported as "nothing happened", because the
 * credit may well be gone.
 */
export async function consumeCodexResetCredit(
  codexHomeDir: string,
  redeemRequestId: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<ResetCreditOutcome> {
  if (!redeemRequestId.trim()) throw new Error("redeem_request_id is required");
  const headers = codexBackendAuthHeaders(codexHomeDir);
  if (!headers) throw new Error("Codex is not signed in on this home");
  const resp = await (opts.fetchImpl ?? fetch)(CODEX_RESET_CREDITS_CONSUME_URL, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ redeem_request_id: redeemRequestId }),
    signal: AbortSignal.timeout(REDEEM_TIMEOUT_MS),
  });
  if (!resp.ok) throw new CodexUsageHttpError(resp.status);
  const code = (await resp.json())?.code;
  if (typeof code !== "string" || !OUTCOMES.includes(code)) {
    throw new Error(`Unknown Codex reset outcome: ${code ?? "missing"}`);
  }
  return code as ResetCreditOutcome;
}

export type RedeemRefusal = "signed_out" | "no_offer" | "stale_offer" | "offer_spent";

export type RedeemResult =
  | {
      status: "redeemed";
      outcome: ResetCreditOutcome;
      key: string;
      revision: string;
      offer: ResetCreditOffer;
      /** The attempt replayed a pending key rather than minting one. */
      replayed: boolean;
    }
  | { status: "refused"; reason: RedeemRefusal; message: string; offer?: ResetCreditOffer };

const REFUSALS: Record<RedeemRefusal, string> = {
  signed_out: "that Codex home holds no usable login",
  no_offer: "the account has no reset credit to spend",
  stale_offer: "the account's credits or usage moved since you were shown them",
  offer_spent: "that reset-credit offer was already redeemed",
};

// Why: the ledger is a file, so two redeems started in the same process would
// both read "no pending attempt", mint two ids, and spend two credits before
// either write landed. The file protects across restarts; this map protects
// within one run (ct-49529).
const inFlight = new Map<string, Promise<RedeemResult>>();

/**
 * Spend one credit for `account`, or say why it refused to.
 *
 * The order matters and is the whole safety argument:
 *  1. read the live offer — never redeem against a cached balance;
 *  2. refuse if the revision moved from what the caller authorized;
 *  3. replay a pending key if one exists (its outcome is unknown, and only its
 *     own id can learn it without spending a second credit);
 *  4. refuse if this exact offer already settled;
 *  5. write the key to disk BEFORE the POST, so a crash mid-flight leaves a
 *     replayable record rather than an invisible spend;
 *  6. POST, then record the outcome.
 *
 * A throw from the POST leaves the attempt `pending` on purpose: the next call
 * replays it. Nothing here clears a pending attempt without an answer.
 */
export function redeemCodexResetCredit(opts: {
  account: string;
  codexHomeDir: string;
  /** Re-read at redeem time, not passed as a value: the whole point of hashing
   *  the windows is to notice one that rolled while the human was deciding, and
   *  a value captured before the prompt can never show that. */
  readWindows?: () => OfferWindows;
  expectedRevision?: string;
  fetchImpl?: typeof fetch;
  now?: number;
  newKey?: () => string;
}): Promise<RedeemResult> {
  const running = inFlight.get(opts.account);
  if (running) return running;
  const promise = redeemOnce(opts).finally(() => {
    if (inFlight.get(opts.account) === promise) inFlight.delete(opts.account);
  });
  inFlight.set(opts.account, promise);
  return promise;
}

async function redeemOnce(opts: {
  account: string;
  codexHomeDir: string;
  readWindows?: () => OfferWindows;
  /** The revision the caller's confirmation was granted against. Omit to accept
   *  whatever the live read says (the unattended path has nothing to go stale). */
  expectedRevision?: string;
  fetchImpl?: typeof fetch;
  now?: number;
  newKey?: () => string;
}): Promise<RedeemResult> {
  const refuse = (reason: RedeemRefusal, offer?: ResetCreditOffer): RedeemResult => ({
    status: "refused",
    reason,
    message: REFUSALS[reason],
    ...(offer ? { offer } : {}),
  });

  const offer = await fetchCodexResetCredits(opts.codexHomeDir, { fetchImpl: opts.fetchImpl });
  if (!offer) return refuse("signed_out");
  const revision = offerRevision(offer, opts.readWindows?.());
  if (opts.expectedRevision && opts.expectedRevision !== revision) {
    return refuse("stale_offer", offer);
  }

  const ledger = readResetCreditLedger();
  const pending = pendingAttempt(ledger, opts.account);
  if (!pending) {
    if (offer.available <= 0) return refuse("no_offer", offer);
    if (settledAttempt(ledger, opts.account, revision)) return refuse("offer_spent", offer);
  }

  const now = opts.now ?? Date.now();
  const attempt: ResetCreditAttempt = pending ?? {
    key: (opts.newKey ?? randomUUID)(),
    account: opts.account,
    offer_revision: revision,
    state: "pending",
    at: now,
  };
  if (!pending) writeResetCreditLedger(upsert(ledger, attempt));

  const outcome = await consumeCodexResetCredit(opts.codexHomeDir, attempt.key, {
    fetchImpl: opts.fetchImpl,
  });
  writeResetCreditLedger(
    upsert(readResetCreditLedger(), { ...attempt, state: "settled", outcome, at: now }),
  );
  return {
    status: "redeemed",
    outcome,
    key: attempt.key,
    revision: attempt.offer_revision,
    offer,
    replayed: !!pending,
  };
}
