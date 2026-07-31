"use client";

// Usage meters for Claude Code accounts — the compact rendering of the daemon's
// per-profile usage snapshots (session / weekly / model-scoped windows + extra
// usage credits). Shared by the header chip's popover and the Claude Accounts
// settings page so both always tell the same story.

import {
  worstUsagePercent,
  worstCodexPercent,
  type CcUsage,
  type CodexUsage,
} from "@codecast/convex/convex/ccAccountsShared";

export { worstUsagePercent, worstCodexPercent };
export type { CcUsage, CodexUsage };

// Status tone for a utilization percent: quiet while there's headroom, loud as
// the window pegs. Values are shown alongside — color never carries alone.
export function usageTone(pct: number): string {
  if (pct >= 100) return "var(--sol-red)";
  if (pct >= 85) return "var(--sol-orange)";
  if (pct >= 60) return "var(--sol-yellow)";
  return "var(--sol-blue)";
}

export function formatCountdown(msFromNow: number): string {
  const mins = Math.max(1, Math.round(msFromNow / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ${mins % 60 > 0 && hours < 10 ? `${mins % 60}m` : ""}`.trim();
  return `${Math.round(hours / 24)}d`;
}

export function formatAgo(msAgo: number): string {
  const mins = Math.round(msAgo / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// Data older than this gets an explicit "as of" note: dormant profiles keep
// their last reading once their token expires (~8h), and the reader must be
// able to tell a live meter from a memory.
const STALE_AFTER_MS = 20 * 60 * 1000;

export function UsageMeterRow({
  label,
  percent,
  resetsAt,
  now,
  title,
}: {
  label: string;
  percent: number;
  resetsAt?: number;
  now: number;
  title?: string;
}) {
  const tone = usageTone(percent);
  const clamped = Math.min(100, Math.max(0, percent));
  const resetNote = resetsAt && resetsAt > now ? `resets in ${formatCountdown(resetsAt - now)}` : null;
  return (
    <div
      className="flex items-center gap-2"
      title={title ?? `${label}: ${Math.round(percent)}% used${resetNote ? ` — ${resetNote}` : ""}`}
    >
      <span className="w-12 shrink-0 text-[10px] uppercase tracking-wider text-sol-text-dim">{label}</span>
      <div className="h-[5px] min-w-0 flex-1 overflow-hidden rounded-full bg-sol-bg-inset">
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{
            width: `${clamped}%`,
            background: tone,
            // A hairline sliver keeps a near-zero meter visibly "alive".
            minWidth: percent > 0 ? 3 : 0,
          }}
        />
      </div>
      <span
        className="w-9 shrink-0 text-right font-mono text-[11px] tabular-nums"
        style={{ color: percent >= 60 ? tone : "var(--sol-text-muted)" }}
      >
        {Math.round(percent)}%
      </span>
    </div>
  );
}

/** The full meter block for one account: one row per limit window, an extra
 * usage credits row when enabled, and a staleness note when the snapshot is a
 * memory rather than a live reading. */
export function AccountUsageBars({ usage, now }: { usage?: CcUsage | null; now: number }) {
  if (!usage) {
    return (
      <div className="text-[11px] italic text-sol-text-dim">
        No usage data yet — reported by the daemon within a few minutes.
      </div>
    );
  }
  const stale = now - usage.fetched_at > STALE_AFTER_MS;
  return (
    <div className="space-y-1">
      {usage.session && (
        <UsageMeterRow label="Session" percent={usage.session.percent} resetsAt={usage.session.resets_at} now={now} />
      )}
      {usage.weekly && (
        <UsageMeterRow label="Week" percent={usage.weekly.percent} resetsAt={usage.weekly.resets_at} now={now} />
      )}
      {usage.weekly_scoped && (
        <UsageMeterRow
          label={usage.weekly_scoped.label ?? "Model"}
          percent={usage.weekly_scoped.percent}
          resetsAt={usage.weekly_scoped.resets_at}
          now={now}
        />
      )}
      {usage.extra?.enabled && (
        <UsageMeterRow
          label="Extra"
          percent={usage.extra.percent}
          now={now}
          title={`Extra usage credits: ${Math.round(usage.extra.percent)}% of the monthly budget spent`}
        />
      )}
      {stale && <div className="pt-0.5 text-[10px] text-sol-text-dim">as of {formatAgo(now - usage.fetched_at)}</div>}
    </div>
  );
}

/** One model's share of the week's Codex tokens. Share ≠ limit utilization, so
 * this renders in a fixed accent instead of the danger ramp — a high share of
 * your own usage is a fact, not a warning. The top model (the user's frontier
 * daily driver, e.g. Sol) gets the emphasized treatment. */
function ModelShareRow({
  label,
  share,
  emphasized,
}: {
  label: string;
  share: number;
  emphasized: boolean;
}) {
  const tone = emphasized ? "var(--sol-violet)" : "var(--sol-text-dim)";
  return (
    <div
      className="flex items-center gap-2"
      title={`${label}: ${share}% of this week's Codex tokens`}
    >
      <span
        className={`w-12 shrink-0 text-[10px] uppercase tracking-wider ${emphasized ? "font-bold" : ""}`}
        style={{ color: emphasized ? "var(--sol-violet)" : "var(--sol-text-dim)" }}
      >
        {label}
      </span>
      <div className="h-[5px] min-w-0 flex-1 overflow-hidden rounded-full bg-sol-bg-inset">
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${Math.min(100, share)}%`, background: tone, minWidth: share > 0 ? 3 : 0 }}
        />
      </div>
      <span
        className="w-9 shrink-0 text-right font-mono text-[11px] tabular-nums"
        style={{ color: emphasized ? "var(--sol-violet)" : "var(--sol-text-muted)" }}
      >
        {share}%
      </span>
    </div>
  );
}

/** The meter block for the machine's Codex (ChatGPT) login: official limit
 * windows first, then the week's model mix with the frontier model on top. */
export function CodexUsageBars({ usage, now }: { usage?: CodexUsage | null; now: number }) {
  if (!usage) {
    return (
      <div className="text-[11px] italic text-sol-text-dim">
        No Codex usage data yet — reported by the daemon within a few minutes.
      </div>
    );
  }
  const stale = now - usage.fetched_at > 20 * 60 * 1000;
  const models = (usage.models ?? []).filter((m) => m.share >= 1).slice(0, 3);
  return (
    <div className="space-y-1">
      {usage.session && (
        <UsageMeterRow label="Session" percent={usage.session.percent} resetsAt={usage.session.resets_at} now={now} />
      )}
      {usage.weekly && (
        <UsageMeterRow label="Week" percent={usage.weekly.percent} resetsAt={usage.weekly.resets_at} now={now} />
      )}
      {usage.scoped?.map((s) => (
        <UsageMeterRow key={s.label} label={s.label} percent={s.percent} resetsAt={s.resets_at} now={now} />
      ))}
      {models.map((m, i) => (
        <ModelShareRow key={m.model} label={m.label} share={m.share} emphasized={i === 0} />
      ))}
      {usage.credits && (usage.credits.has_credits || usage.credits.unlimited) && (
        <div className="pt-0.5 text-[10px] text-sol-text-dim">
          Credits: {usage.credits.unlimited ? "unlimited" : usage.credits.balance ?? "available"}
        </div>
      )}
      {usage.reset_credits && usage.reset_credits.available > 0 && (
        <div
          className="pt-0.5 text-[10px] text-sol-cyan"
          title="Codex has granted a free rate-limit reset — redeemable from the Codex CLI when a window pegs"
        >
          {usage.reset_credits.available} rate-limit reset credit
          {usage.reset_credits.available > 1 ? "s" : ""} available
        </div>
      )}
      {stale && <div className="pt-0.5 text-[10px] text-sol-text-dim">as of {formatAgo(now - usage.fetched_at)}</div>}
    </div>
  );
}
