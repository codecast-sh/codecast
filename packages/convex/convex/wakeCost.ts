// What waking a session costs. Claude Code writes its prompt cache with a one
// hour lifetime, and a cache belongs to one account. A session whose last
// model call is older than that (or that comes back on a different account)
// pays for its whole context again, at twice the input price, before it reads
// a word of the new turn. Measured on 2026-09-14: messages into sessions idle
// past the lifetime were 28% of session messages, 59% of their cost, and drew
// no replies. Shared by the send path (server), the restart bar (web) and the
// CLI, so every surface names the same cost the same way.

export const PROMPT_CACHE_LIFETIME_MS = 60 * 60 * 1000;

export type WakeFields = {
  // Input + cache read + cache write of the latest model call: the context the
  // next call carries.
  context_tokens?: number | null;
  // When the latest model call's usage landed. The cache was last refreshed then.
  last_model_call_at?: number | null;
};

type WakeRow = WakeFields & {
  updated_at?: number;
  status?: string;
  inbox_killed_at?: number | null;
};

// The inbox projection and the server checks read a conversation doc through
// this, so the two flat fields have one source: usage_totals (messages.rollUpUsage).
export function wakeFieldsOf(conv: {
  usage_totals?: { updated_at: number; context_tokens?: number } | null;
}): Required<WakeFields> {
  return {
    context_tokens: conv.usage_totals?.context_tokens ?? null,
    last_model_call_at: conv.usage_totals?.updated_at ?? null,
  };
}

export function wakeCost(row: WakeRow, now: number): {
  idleMs: number;
  contextTokens: number | null;
  cacheCold: boolean;
  killed: boolean;
} {
  const lastCall = row.last_model_call_at ?? row.updated_at ?? 0;
  const idleMs = Math.max(0, now - lastCall);
  return {
    idleMs,
    contextTokens: row.context_tokens ?? null,
    cacheCold: idleMs > PROMPT_CACHE_LIFETIME_MS,
    killed: row.inbox_killed_at != null || row.status === "completed",
  };
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
  const body =
    v === 0
      ? "0"
      : v < 1000
        ? String(v)
        : `${v / 1000 < 10 ? (v / 1000).toFixed(1).replace(/\.0$/, "") : Math.round(v / 1000)}k`;
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
): { chosenIds: Set<string>; chosen: T[]; scoped: boolean; reloadTokens: number; leftUnticked: number } {
  const chosenIds = opts.picked
    ?? new Set(acted.filter((row) => opts.now - opts.parkedAt(row) < opts.windowMs).map((row) => row._id));
  const chosen = acted.filter((row) => chosenIds.has(row._id));
  const reloadTokens = chosen.reduce((sum, row) => {
    const fields = opts.rowFor(row);
    const reloads = restartReloadsContext(fields, opts.now, {
      switchingAccount: opts.switchingAccount,
      activeSince: opts.activeSinceFor(row),
    });
    return sum + (reloads ? fields.context_tokens ?? 0 : 0);
  }, 0);
  return {
    chosenIds,
    chosen,
    scoped: chosen.length !== acted.length,
    reloadTokens,
    leftUnticked: opts.picked ? 0 : acted.length - chosen.length,
  };
}
