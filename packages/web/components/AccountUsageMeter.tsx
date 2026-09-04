"use client";

// Usage meters for Claude Code accounts — the compact rendering of the daemon's
// per-profile usage snapshots (session / weekly / model-scoped windows + extra
// usage credits). Shared by the header chip's popover and the Claude Accounts
// settings page so both always tell the same story.

import { useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { isWindowRolled, worstUsagePercent, type CcUsage } from "@codecast/convex/convex/ccAccountsShared";
import { formatAgo, formatCountdown } from "@codecast/shared/contracts";
import { usageTone } from "../lib/usageTone";
import { useMountEffect } from "../hooks/useMountEffect";
import { useWatchEffect } from "../hooks/useWatchEffect";

export type { CcUsage };

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
  // A window whose reset has passed reads empty, whatever the snapshot says:
  // the measurement described a window that no longer exists. The bar clears
  // and the value cell says "reset" rather than claiming a fresh 0% reading.
  const rolled = isWindowRolled({ resets_at: resetsAt }, now);
  const live = rolled ? 0 : percent;
  const tone = usageTone(live);
  const clamped = Math.min(100, Math.max(0, live));
  const resetNote = resetsAt && resetsAt > now ? `resets in ${formatCountdown(resetsAt - now)}` : null;
  const rolledNote = rolled
    ? `${label}: window reset ${formatAgo(now - (resetsAt as number))} — the last reading (${Math.round(percent)}%) is from the window before it`
    : null;
  return (
    <div
      className="flex items-center gap-2"
      title={rolledNote ?? title ?? `${label}: ${Math.round(percent)}% used${resetNote ? ` — ${resetNote}` : ""}`}
    >
      <span className="w-12 shrink-0 text-[10px] uppercase tracking-wider text-sol-text-dim">{label}</span>
      <div className="h-[5px] min-w-0 flex-1 overflow-hidden rounded-full bg-sol-bg-inset">
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{
            width: `${clamped}%`,
            background: tone,
            // A hairline sliver keeps a near-zero meter visibly "alive".
            minWidth: live > 0 ? 3 : 0,
          }}
        />
      </div>
      {rolled ? (
        <span className="w-9 shrink-0 text-right font-mono text-[10px] text-sol-text-dim">reset</span>
      ) : (
        <span
          className="w-9 shrink-0 text-right font-mono text-[11px] tabular-nums"
          style={{ color: live >= 60 ? tone : "var(--sol-text-muted)" }}
        >
          {Math.round(live)}%
        </span>
      )}
    </div>
  );
}

/** The full meter block for one account (either provider): one row per limit
 * window, followed by credits notes. A staleness note marks a snapshot that
 * is a memory rather than a live reading. */
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
    <div className="space-y-0.5">
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
      {usage.scoped?.map((s) => (
        <UsageMeterRow key={s.label} label={s.label} percent={s.percent} resetsAt={s.resets_at} now={now} />
      ))}
      {usage.extra?.enabled && (
        <UsageMeterRow
          label="Extra"
          percent={usage.extra.percent}
          now={now}
          title={`Extra usage credits: ${Math.round(usage.extra.percent)}% of the monthly budget spent`}
        />
      )}
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

/** "login expired" next to a profile whose saved login the daemon could not
 * refresh: switching there lands on a dead credential until that account
 * signs in again. Renders nothing for a live profile. */
export function LoginExpiredBadge({ profile }: { profile: { login_expired_at?: number | null } }) {
  if (!profile.login_expired_at) return null;
  return (
    <span
      className="shrink-0 rounded bg-sol-red/10 px-1.5 py-0.5 text-[10px] text-sol-red"
      title="The saved login for this account no longer works — sign into it in Claude Code once and it is re-saved"
    >
      login expired
    </span>
  );
}

// A refresh request is "in flight" until the daemon's heartbeat moves some
// profile's reading, or this long passes (the command's own TTL is 5 min;
// past this the click has visibly failed and the button should be usable).
const REFRESH_WAIT_MS = 30_000;

type RefreshableDevice = {
  device_id: string;
  online?: boolean;
  is_remote?: boolean;
  profiles: Array<{ usage?: CcUsage | null }>;
  codex_accounts?: { profiles: Array<{ usage?: CcUsage | null }> } | null;
};

function newestReading(device: RefreshableDevice): number {
  const all = [...device.profiles, ...(device.codex_accounts?.profiles ?? [])];
  return all.reduce((max, p) => Math.max(max, p.usage?.fetched_at ?? 0), 0);
}

/** Refresh every account's usage on one machine now. Shared by the header
 * chip's panel and the Claude Accounts settings page. The daemon answers by
 * heartbeating fresh readings; the spinner runs until one lands. */
export function UsageRefreshButton({ device, className }: { device: RefreshableDevice; className?: string }) {
  const requestRefresh = useMutation(api.accountSwitch.requestUsageRefresh);
  const [awaiting, setAwaiting] = useState<number | null>(null); // the newest reading at click time
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const newest = newestReading(device);
  const spinning = awaiting !== null && newest <= awaiting;
  useWatchEffect(() => {
    if (!spinning && awaiting !== null) setAwaiting(null);
  }, [spinning, awaiting]);
  useMountEffect(() => () => { if (timer.current) clearTimeout(timer.current); });
  const online = device.online !== false && device.is_remote !== true;

  const click = async () => {
    if (spinning) return;
    setAwaiting(newest);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setAwaiting(null), REFRESH_WAIT_MS);
    try {
      await requestRefresh({ device_id: device.device_id });
    } catch (err) {
      setAwaiting(null);
      toast.error(err instanceof Error ? err.message : "Refresh failed");
    }
  };

  return (
    <button
      type="button"
      onClick={click}
      disabled={!online || spinning}
      aria-label="Refresh usage for every account on this machine"
      title={
        online
          ? "Refresh usage for every account on this machine"
          : "The daemon on this machine is offline"
      }
      className={`shrink-0 rounded p-1 text-sol-text-dim transition-colors hover:bg-sol-bg-alt hover:text-sol-text disabled:opacity-50 disabled:hover:bg-transparent ${className ?? ""}`}
    >
      <RefreshCw className={`h-3 w-3 ${spinning ? "animate-spin" : ""}`} />
    </button>
  );
}
