// "While you were away" digest policy: when to email someone about unseen
// activity. Ported from codecast's emails/digest.ts, with everything the app
// owns injected — how to find candidates, load a recipient, build the digest
// body, persist state, and deliver. This module knows nothing about
// notification tables, deep links, or Convex.
//
// Suppression, in order:
//  - master switch (emailPref; absent reads as ON)
//  - presence: skip anyone with keyboard input in the last activeMs — they
//    are at the desk, the bell and toasts cover it
//  - grace: an item must sit unread for graceMs before it can trigger email,
//    giving the app and push their chance first
//  - cooldown: at most one digest per cooldownMs; items are never re-emailed
//    (the build range starts at the last send)

export interface DigestPolicy {
  /** An item must sit unread this long before it can trigger email. */
  graceMs: number;
  /** How far back one sweep looks for candidate activity. */
  windowMs: number;
  /** At most one digest per recipient per this interval. */
  cooldownMs: number;
  /** Input newer than this means the person is at the desk; no email. */
  activeMs: number;
  /** Never reach further back than this, even for a first ever digest. */
  maxLookbackMs: number;
  /** Bound one sweep's work; the next sweep picks up the rest. */
  maxUsersPerSweep: number;
  /** Entries shown per digest section; the rest become a more count. */
  maxEntriesPerSection: number;
}

export const GRACE_MS = 10 * 60 * 1000;
export const WINDOW_MS = 45 * 60 * 1000;
export const COOLDOWN_MS = 30 * 60 * 1000;
export const ACTIVE_MS = 15 * 60 * 1000;
export const MAX_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export const DEFAULT_DIGEST_POLICY: DigestPolicy = {
  graceMs: GRACE_MS,
  windowMs: WINDOW_MS,
  cooldownMs: COOLDOWN_MS,
  activeMs: ACTIVE_MS,
  maxLookbackMs: MAX_LOOKBACK_MS,
  maxUsersPerSweep: 100,
  maxEntriesPerSection: 6,
};

// ---------------------------------------------------------------------------
// Pure decisions
// ---------------------------------------------------------------------------

export function digestEligible(
  args: {
    emailPref: boolean | undefined;
    lastSentAt: number | undefined;
    lastInputAt: number | undefined;
    now: number;
  },
  policy: DigestPolicy = DEFAULT_DIGEST_POLICY,
): { send: boolean; reason: string } {
  if (args.emailPref === false) return { send: false, reason: "unsubscribed" };
  if (args.lastInputAt !== undefined && args.now - args.lastInputAt < policy.activeMs) {
    return { send: false, reason: "active" };
  }
  if (args.lastSentAt !== undefined && args.now - args.lastSentAt < policy.cooldownMs) {
    return { send: false, reason: "cooldown" };
  }
  return { send: true, reason: "ok" };
}

/** The [from, to] creation window one sweep scans for candidate activity. */
export function sweepWindow(
  now: number,
  policy: DigestPolicy = DEFAULT_DIGEST_POLICY,
): { from: number; to: number } {
  return { from: now - policy.windowMs, to: now - policy.graceMs };
}

/**
 * The (since, cutoff] range a recipient's digest body covers: everything
 * after the last digest (bounded by max lookback) that has already sat
 * through the grace period.
 */
export function digestRange(
  lastSentAt: number | undefined,
  now: number,
  policy: DigestPolicy = DEFAULT_DIGEST_POLICY,
): { since: number; cutoff: number } {
  return {
    since: Math.max(lastSentAt ?? 0, now - policy.maxLookbackMs),
    cutoff: now - policy.graceMs,
  };
}

/**
 * Per section entry cap with a running total of what was dropped, for the
 * "…and N more in the app" line. One capper per digest build.
 */
export function createEntryCapper(maxPerSection: number): {
  take<T>(items: T[]): T[];
  moreCount(): number;
} {
  let more = 0;
  return {
    take<T>(items: T[]): T[] {
      more += Math.max(0, items.length - maxPerSection);
      return items.slice(0, maxPerSection);
    },
    moreCount: () => more,
  };
}

// ---------------------------------------------------------------------------
// Unsubscribe token
// ---------------------------------------------------------------------------

const TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const TOKEN_LENGTH = 32;
const MIN_TOKEN_LENGTH = 16;

export function generateUnsubscribeToken(): string {
  const bytes = new Uint8Array(TOKEN_LENGTH);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += TOKEN_ALPHABET[b % TOKEN_ALPHABET.length];
  return out;
}

/** Rejects trivially guessable tokens before any lookup runs. */
export function isValidUnsubscribeToken(token: string): boolean {
  return token.length >= MIN_TOKEN_LENGTH;
}

/**
 * RFC 8058 one click unsubscribe headers (Gmail and Yahoo fire the POST
 * without opening a page). Pass to the transport's SendOptions.headers.
 */
export function listUnsubscribeHeaders(unsubscribeUrl: string): Record<string, string> {
  return {
    "List-Unsubscribe": `<${unsubscribeUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

/**
 * Token bearing unsubscribe, idempotent: validate the token, look the owner
 * up, apply the app's opt out write. `lookup` and `apply` are the app's.
 */
export async function unsubscribeByToken(
  token: string,
  hooks: {
    lookup(token: string): Promise<{ id: string } | null>;
    apply(id: string): Promise<void>;
  },
): Promise<{ ok: boolean }> {
  if (!isValidUnsubscribeToken(token)) return { ok: false };
  const owner = await hooks.lookup(token);
  if (!owner) return { ok: false };
  await hooks.apply(owner.id);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

/** What the sweep needs to know about one person. The app maps its user row. */
export interface DigestRecipient {
  id: string;
  email?: string;
  /** The master email switch. Absent reads as ON. */
  emailPref?: boolean;
  /** When the last digest was sent. */
  lastSentAt?: number;
  /** Freshest human input across surfaces (presence). */
  lastInputAt?: number;
  /** Existing unsubscribe token, if one was ever minted. */
  unsubToken?: string;
}

/**
 * The entity mapping the app supplies. The sweep drives these; the app owns
 * every read and write.
 */
export interface DigestSweepHooks<TDigest> {
  /** User ids with email worthy activity created inside [from, to]. */
  candidates(window: { from: number; to: number }): Promise<string[]>;
  /** Load one recipient; null skips (deleted user, no email). */
  recipient(id: string): Promise<DigestRecipient | null>;
  /**
   * Build the digest body for the (since, cutoff] range: load pending
   * notifications, build deep links, cap sections. Null means nothing to
   * send after the app's own filtering.
   */
  build(
    recipient: DigestRecipient,
    range: { since: number; cutoff: number },
  ): Promise<TDigest | null>;
  /** Persist a newly minted unsubscribe token on the recipient. */
  saveToken(id: string, token: string): Promise<void>;
  /** Record the send time (the cooldown clock and the next range's floor). */
  markSent(id: string, now: number): Promise<void>;
  /** Deliver (or schedule delivery of) the digest. */
  send(recipient: DigestRecipient, digest: TDigest, unsubToken: string): Promise<void>;
}

/**
 * One sweep tick: find candidates, filter by eligibility, build, mint the
 * unsubscribe token if missing, mark sent, deliver. markSent runs before
 * send, as in codecast: a failed delivery costs one skipped digest, never a
 * double send.
 */
export async function runDigestSweep<TDigest>(
  hooks: DigestSweepHooks<TDigest>,
  now: number,
  policy: DigestPolicy = DEFAULT_DIGEST_POLICY,
): Promise<{ candidates: number; sent: number }> {
  const ids = await hooks.candidates(sweepWindow(now, policy));
  const unique = [...new Set(ids)];

  let sent = 0;
  for (const id of unique.slice(0, policy.maxUsersPerSweep)) {
    const recipient = await hooks.recipient(id);
    if (!recipient?.email) continue;

    const eligibility = digestEligible(
      {
        emailPref: recipient.emailPref,
        lastSentAt: recipient.lastSentAt,
        lastInputAt: recipient.lastInputAt,
        now,
      },
      policy,
    );
    if (!eligibility.send) continue;

    const digest = await hooks.build(recipient, digestRange(recipient.lastSentAt, now, policy));
    if (digest === null) continue;

    let token = recipient.unsubToken;
    if (!token) {
      token = generateUnsubscribeToken();
      await hooks.saveToken(id, token);
    }
    await hooks.markSent(id, now);
    await hooks.send(recipient, digest, token);
    sent++;
  }
  return { candidates: unique.length, sent };
}
