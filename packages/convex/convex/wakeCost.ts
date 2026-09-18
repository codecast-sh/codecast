// What waking a session costs. Claude Code writes its prompt cache with a one
// hour lifetime, and a cache belongs to one account. A session whose last
// model call is older than that (or that comes back on a different account)
// pays for its whole context again, at twice the input price, before it reads
// a word of the new turn. Measured on 2026-09-14: messages into sessions idle
// past the lifetime were 28% of session messages, 59% of their cost, and drew
// no replies. Shared by the send path (server), the restart bar (web) and the
// CLI, so every surface names the same cost the same way.

import { contextWindowTokens } from "@codecast/shared/contracts";

export const PROMPT_CACHE_LIFETIME_MS = 60 * 60 * 1000;

export type WakeFields = {
  // Input + cache read + cache write of the latest model call: the context the
  // next call carries.
  context_tokens?: number | null;
  // When the latest model call's usage landed. The cache was last refreshed then.
  last_model_call_at?: number | null;
  // Last-known model stamp and agent, which say how big a window those tokens
  // fill. A bare "487k" means nothing until you know whether the model holds
  // 200k or a million.
  model?: string | null;
  agent_type?: string | null;
};

type WakeRow = WakeFields & {
  updated_at?: number;
  status?: string;
  inbox_killed_at?: number | null;
};

// The inbox projection and the server checks read a conversation doc through
// this, so the two flat fields have one source: usage_totals (messages.rollUpUsage).
// Deliberately only those two: the model and agent stamps already sit on the
// conversation row, so a caller that spreads the doc into a WakeRow carries them
// without this function adding a second writer for fields it does not own.
export function wakeFieldsOf(conv: {
  usage_totals?: { updated_at: number; context_tokens?: number } | null;
}): { context_tokens: number | null; last_model_call_at: number | null } {
  return {
    context_tokens: conv.usage_totals?.context_tokens ?? null,
    last_model_call_at: conv.usage_totals?.updated_at ?? null,
  };
}

export function wakeCost(row: WakeRow, now: number): {
  idleMs: number;
  contextTokens: number | null;
  /** Fraction of the model's window those tokens fill, null when unknown. */
  contextShare: number | null;
  cacheCold: boolean;
  killed: boolean;
} {
  const lastCall = row.last_model_call_at ?? row.updated_at ?? 0;
  const idleMs = Math.max(0, now - lastCall);
  return {
    idleMs,
    contextTokens: row.context_tokens ?? null,
    contextShare: contextShareOf(row),
    cacheCold: idleMs > PROMPT_CACHE_LIFETIME_MS,
    killed: row.inbox_killed_at != null || row.status === "completed",
  };
}

// How full the session's context is, as a fraction of what its model holds.
// Null whenever either half is missing: an unmeasured window is not a reason to
// print a share against a number nobody checked.
export function contextShareOf(row: WakeFields): number | null {
  const window = contextWindowTokens(row.model, row.agent_type ?? undefined);
  if (!window || !row.context_tokens) return null;
  return row.context_tokens / window;
}

// One share, rendered. Under a tenth of a percent still reads as "<1%" rather
// than "0%", because a session that carries something is not a session that
// carries nothing.
export function formatShare(share: number | null): string | null {
  if (share === null || !Number.isFinite(share) || share <= 0) return null;
  const pct = share * 100;
  return pct < 1 ? "<1%" : `${Math.round(pct)}%`;
}

// Whether restarting a parked session reloads its whole context: the continue
// runs on a different account than its last call did (an explicit switch, or a
// login that took over the machine after that call), or its cache has expired.
export function restartReloadsContext(
  row: WakeRow,
  now: number,
  opts: { switchingAccount: boolean; activeSince?: number | null },
): boolean {
  if (opts.switchingAccount) return true;
  const lastCall = row.last_model_call_at ?? row.updated_at ?? 0;
  if (opts.activeSince != null && lastCall < opts.activeSince) return true;
  return wakeCost(row, now).cacheCold;
}

export function formatTokens(n: number, underBound?: boolean): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  // Round before choosing the bucket, not after. Rounding inside the small
  // branch is how 999.6 prints as "1000" — a four-digit number in a column whose
  // whole point is that everything past three digits reads as k.
  const v = Math.round(n);
  // Past a million the k column stops reading as a size — "1000k" is a figure a
  // person has to convert before it means anything. The M cut sits at 999.5k for
  // the same reason the k cut rounds first: nothing may round INTO "1000k".
  const body =
    v === 0
      ? "0"
      : v < 1000
        ? String(v)
        : v < 999_500
          ? `${v / 1000 < 10 ? (v / 1000).toFixed(1).replace(/\.0$/, "") : Math.round(v / 1000)}k`
          : `${(v / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  return underBound ? `<${body}` : body;
}

export function formatIdle(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

// The restart bar's arithmetic, kept out of the component so it can be tested:
// which parked sessions are ticked by default, and what restarting the ticked
// ones reloads. Parks inside `windowMs` are ticked; an older park already sat
// through a reset nobody came back for.
export function restartPlan<T extends { _id: string }>(
  acted: T[],
  opts: {
    now: number;
    windowMs: number;
    parkedAt: (row: T) => number;
    picked?: Set<string> | null;
    switchingAccount: boolean;
    rowFor: (row: T) => WakeRow & { context_tokens?: number | null };
    activeSinceFor: (row: T) => number | null | undefined;
  },
): {
  chosenIds: Set<string>;
  chosen: T[];
  scoped: boolean;
  reloadTokens: number;
  /** How full the reloading sessions are, across their combined windows. Covers
   *  only the ones whose model window is known; null when none of them is. */
  reloadShare: number | null;
  leftUnticked: number;
} {
  const chosenIds = opts.picked
    ?? new Set(acted.filter((row) => opts.now - opts.parkedAt(row) < opts.windowMs).map((row) => row._id));
  const chosen = acted.filter((row) => chosenIds.has(row._id));
  let reloadTokens = 0;
  // The share is computed over the sessions whose window we know, BOTH halves of
  // the fraction. Counting a model with no published window in the tokens but
  // not in the windows is how a total prints 140% of itself.
  let knownTokens = 0;
  let knownWindow = 0;
  for (const row of chosen) {
    const fields = opts.rowFor(row);
    const reloads = restartReloadsContext(fields, opts.now, {
      switchingAccount: opts.switchingAccount,
      activeSince: opts.activeSinceFor(row),
    });
    if (!reloads) continue;
    const tokens = fields.context_tokens ?? 0;
    reloadTokens += tokens;
    const window = contextWindowTokens(fields.model, fields.agent_type ?? undefined);
    if (window && tokens) {
      knownTokens += tokens;
      knownWindow += window;
    }
  }
  return {
    chosenIds,
    chosen,
    scoped: chosen.length !== acted.length,
    reloadTokens,
    reloadShare: knownWindow > 0 ? knownTokens / knownWindow : null,
    leftUnticked: opts.picked ? 0 : acted.length - chosen.length,
  };
}
